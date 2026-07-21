# Training the GapCloser (UDF line-gap model)

This document covers training the ML gap-closing model in
`segmentation/gap_closing/`. Serving/inference is documented separately in
`docs/gap-closer-serving.md`; inference internals appear here only where the
training code shares them.

Entry points:

| What | File |
|---|---|
| Training CLI (Lightning) | `segmentation/gap_closing/train.py` + `config_512_real.yaml` |
| LightningModule | `segmentation/gap_closing/gap_closer.py` (`GapCloser`) |
| DataModule / Dataset | `segmentation/gap_closing/datamodule.py`, `dataset.py` (`GapLineDataset`) |
| Model | `segmentation/gap_closing/unet.py` (`ClassicUNet`) |
| Loss | `segmentation/gap_closing/loss.py` (`JointLoss`) |
| Val visualizations | `segmentation/gap_closing/visualization.py` |
| Corpus prep helpers | `convert_seg_to_lines.py`, `skeletonize_real_dataset.py` |
| CLI inference / eval-by-eye | `segmentation/gap_closing/inference.py` |

---

## 1. Motivation

Segmentation of line art is done with classical **trapped-ball flood fill**
(`segmentation/trapped_ball/`). Trapped-ball fails exactly where artists'
lines fail: a 1–20 px gap in a stroke lets the fill leak, merging regions
that should be separate. Classical morphological closing either misses long
gaps or destroys detail.

The GapCloser is a UNet that, given a binary line crop, predicts a
**normalized unsigned distance field (UDF)** to where the *closed* line work
should be. Thresholding the UDF (`udf < udf_threshold`) yields synthesized
line pixels that bridge gaps; these are OR-ed with the binarized input and
handed to trapped-ball. Predicting a distance field instead of a binary mask
gives sub-pixel-smooth supervision, a tunable closing strength at inference
(the serving parameter `gap_closer_strength` maps to the UDF threshold), and
a well-behaved regression target in regions where "is this pixel a line?" is
ambiguous.

---

## 2. Data

### 2.1 Self-supervision: gaps are synthesized, not annotated

There are **no human gap labels**. `GapLineDataset`
(`segmentation/gap_closing/dataset.py`) starts from real *closed* line
images, erases pieces of them, and asks the model to restore the distance
field of the original. One `__getitem__`:

1. **Load** an RGBA line image (`load_rgba`). Per-source conventions:
   `handdrawn-data` files are already RGBA; `gap_close_lines_v1` files are
   used as-is; everything else is assumed inverted grayscale and gets
   `255 - image` before being stacked into 4 channels.
2. **Geometric augmentation** (p=`augment_prob`, default 0.5) on the RGBA
   image *before* binarization (`_augment_geometric_rgba`, albumentations):
   H/V flips + rot90 (p=0.5 each), zoom-in-only affine scale 1.0–1.3
   (p=0.3), ±15° rotation (p=0.3), thin-plate-spline warp (p=0.1).
3. **Binarize** via adaptive-mean threshold on the (inverted) alpha channel,
   block size 51 (`binarize_rgba`) → float mask, 1 = line.
4. **Crop** a `crop_size` (512) window around actual line content, with
   retry (`line.py crop_around_lines_binary_with_retry`); unusable images
   fall through to the next index (`_handle_invalid_image`).
5. **Skeletonize** (`line.py skeletonize`, skimage) → the clean 1-px
   skeleton. This is the ground truth.
6. **Erase gaps** (`line.py add_junction_gaps`): skeleton keypoints are
   detected by 8-neighbor counts — **junctions** (≥3 neighbors), **corners**
   (high-curvature points), **endpoints** — plus random points. Per sample, a
   probability is drawn between `{junction,corner}_gap_min/max` (capped at
   `*_gap_cap`), and up to `random_gap_max` random gaps are added. Each gap
   erases `gap_length_min..gap_length_max` px along the skeleton with an
   eraser of radius `gap_width`, respecting `min_gap_distance` between gaps
   and `min_endpoint_distance` from pre-existing endpoints (so it doesn't
   just shorten strokes that were already open). Endpoints are re-detected
   afterwards (topology changed) and the sample carries both lists.
7. **Brush augmentation** (p=`brush_augment_prob`, default 0.7,
   `brush.py apply_brush_augmentation`): the gapped skeleton is *thickened*
   with one of 11 procedural brush stamps (`circular`, `rough`, `textured`,
   `splatter`, `dry`, `marker`, `charcoal`, `ink`, `thick_marker`,
   `calligraphy`, `feathered`), with optional random per-region thickness
   variation (p=0.1) and optional edge blur (p=0.5, gaussian/bilateral/box).
   This is what makes the model robust to real stroke widths while training
   targets stay skeleton-thin.
8. **Targets**:
   - `udf`: `cv2.distanceTransform(L2, mask 5)` of the *clean* skeleton,
     clipped and normalized to [0, 1] by `udf_max_dist`
     (`_compute_udf`).
   - `gap_weights` / `gap_focal_mask`: a distance-ramp weighting around the
     *erased* pixels — weight 1.0 at the gap decaying linearly to 0 at
     `line_focal_distance_threshold` (`_compute_focal_mask`).
   - `skeleton_weights` / `skeleton_focal_mask`: same ramp around the
     *surviving* line pixels, minus the gap region and minus a zone around
     endpoints (endpoints are legitimately open — the model shouldn't be
     pushed to extend them).

The returned dict: `lines` (clean skeleton), `gap_lines_raw` (thin, gapped),
`gap_lines_brush` (**the model input**), `udf`, both focal masks/weights,
and `junction_points` (kept un-batched by the custom `collate_fn` in
`datamodule.py`).

Run `python -m segmentation.gap_closing.dataset --output_dir <dir>` to dump
annotated 2×3 sample grids — the fastest way to sanity-check gap/focal
parameters before a run.

### 2.2 Where the line images come from

`file.py find_line_images()` globs **hardcoded relative paths** under
`data/`:

```
data/real-data/**/**/seg_canny_neigborhood_51_color_lines/*.png
data/anita-data/**/seg_canny_neigborhood_51_color_lines/**/*.png
data/handdrawn-data/**/line/*.png
data/pbc-data/**/seg_canny/*.png
data/synth-data/**/**/seg_canny/*.png
data/cadmium-data-2025-10_06/*/*/*/seg_canny_lines/*.png
```

(animerun is commented out; note the committed "neigborhood" misspelling —
it matches the folder names the seg scripts create.) The list is shuffled
with the global `random` module and **is the dataset** — there is no index
file. Two helper scripts produce these corpora:

- `convert_seg_to_lines.py` — renders line drawings from trapped-ball
  segmentation maps (region-boundary via morphological gradient on the seg
  ids; `find_seg_images()` currently points at `data/mixamo-data/**/tb_seg_3_2_1`).
  Since a seg map is closed by construction, these lines are guaranteed
  gap-free ground truth.
- `skeletonize_real_dataset.py` — a **bootstrap/self-distillation** pass:
  runs a *previous* GapCloser checkpoint (default
  `checkpoints/gap_closer/gap_close_v1_1124.ckpt`) over raw real/cadmium line
  scans and writes closed line images to `gap_close_lines_v1/`
  subfolders, which then feed back into training via the `gap_close_lines_v1`
  branch in `load_rgba`. (This script is currently broken — see Quirks.)

### 2.3 Split

`GapLineDataModule.setup` (`datamodule.py:98`) builds **one** dataset and
`random_split`s it: `val = 1000` images (hardcoded), train = rest, generator
seeded 42. Validation keeps gap generation on (that's the task) and is
*meant* to disable geometric augmentation — but see Quirks: the line that
does this also disables it for training.

---

## 3. Model & loss

### 3.1 `ClassicUNet` (`unet.py`)

A textbook UNet: `DoubleConv` (conv-ReLU ×2, optional `Dropout2d`) blocks,
maxpool downs, transpose-conv ups with skip concat. Depth is derived from
`image_size`: `num_levels = max(3, min(5, log2(size) - 2))` → 5 levels at
512² (bottleneck 16²); channels double per level from `base_channels=64`,
capped at 32×base. Single input channel (the binarized/brushed crop), single
output head, and the output passes through `softplus(beta=20)` so the UDF is
non-negative without hard clamping. The trainable parameter count is printed
at init (`log_model_info`).

`GapCloser.forward` (`gap_closer.py:67`) returns three views:
`udf_normalized` (raw model output, ≈[0,1]), `udf_denormalized`
(× `udf_max_dist`, pixel units), and `combined_boundary_binary` — the
thresholded prediction OR-ed with the binarized input, computed **in numpy on
CPU** per batch element (used for metrics/inference only, not the loss).

### 3.2 `JointLoss` (`loss.py`)

All terms are computed on the **normalized** UDF, under
`torch.amp.autocast(enabled=False)` (fp32 even in a bf16-mixed run). Three
weighted terms, summed into `total`:

| Term | What | Weight (code default / shipped config) |
|---|---|---|
| `gap` | L1(pred, target) × `gap_weights`, normalized by the count of weighted pixels | 1.0 / 1.0 |
| `skeleton` | same, × `skeleton_weights` | 0.1 / 0.1 |
| `gap_grad` | eikonal-style: central-difference \|∇pred\| pushed toward 1.0, masked to gap regions near the zero level set (`pred < near_zero_threshold`) | 1.0 / **0.0 (disabled)** |

The focal weighting is the heart of it: gap pixels are a tiny fraction of a
512² crop, so unweighted L1 would let the model ignore them; the distance
ramps concentrate the loss where closing actually happens while the small
`skeleton` term anchors the field on existing lines. Non-finite loss values
are replaced with a constant 100.0 (`loss.py:102,116`) rather than crashing
the run. A BCE-based `MaskedLineLoss` predecessor is kept commented out at
the top of the file.

Note the `gap_grad` term is dimensionally off for the *normalized* field
(a true UDF in units of `udf_max_dist` px has |∇| = 1/`udf_max_dist`, not 1)
and `near_zero_threshold=1.0` compares against a normalized field that never
exceeds ~1 — with the shipped weight of 0.0 this is moot, but re-enable it
with care.

---

## 4. Training loop specifics

### 4.1 Invocation

`train.py` is a `LightningCLI` app wiring `GapCloser` + `GapLineDataModule`
(`seed_everything_default=42`):

```bash
cd segmentation/gap_closing        # flat imports: `from gap_closer import …`
python train.py fit --config config_512_real.yaml
```

Two CWD constraints collide: `train.py` uses flat sibling imports (must run
from `segmentation/gap_closing/`), while `find_line_images()` globs
`data/...` relative to CWD — so you need `data/` visible from the
gap_closing directory (symlink to the repo-root `data/` works). The YAML
header still says `python train_real.py fit ...`; the file was renamed to
`train.py`.

All model/data hyperparameters are `save_hyperparameters()`-captured, which
is what lets serving reconstruct the module from the checkpoint alone
(`GapCloser(**ckpt['hyper_parameters'])` in `serving/local/server.py:45` and
`serving/modal/seg/gap_close_v1_stub.py:46`).

### 4.2 Optimizer & schedule (`gap_closer.py configure_optimizers`)

- AdamW, lr 1e-4, betas (0.9, 0.999); weight decay 1e-4 in
  `config_512_real.yaml` (code default 1e-5).
- `scheduler_type: plateau` → `ReduceLROnPlateau` on `val/total_loss`
  (factor 0.5, patience 10 per the config; min_lr 1e-6). A `cosine` warm
  restarts branch exists but returns the `(optimizer, scheduler)` tuple
  shape Lightning deprecated — plateau is the tested path.
- Trainer (from the YAML): `precision: bf16-mixed`, `max_epochs: 1000`,
  `gradient_clip_val: 1.0`, batch size 20, 8 dataloader workers,
  `log_every_n_steps: 50`, validation every epoch.

### 4.3 Callbacks & checkpoints

Callbacks are defined in **two places**:

- `train.py before_fit` builds a `ModelCheckpoint` (dirpath `logs/lightning`,
  monitor `val/total_loss`, top-3 + last) + `EarlyStopping(patience=20)` +
  `LearningRateMonitor`.
- `GapCloser.configure_callbacks` returns its own set: `ModelCheckpoint`
  (filename `udf-{epoch:02d}-{val/total_loss:.4f}`, top-3 + last),
  `EarlyStopping(patience=50)`, `LearningRateMonitor`.

Lightning gives `configure_callbacks` priority for duplicate types, so in
practice the model's set wins (checkpoints land in the trainer's default
dir as `udf-EE-L.LLLL.ckpt` plus `last.ckpt`, early-stop patience 50). The
`before_fit` filename also contains doubled braces
(`'epoch-{{epoch:02d}}-…'`) that would never interpolate — harmless today
because that callback loses, but confusing.

**Checkpoint layout expectation downstream:** a full Lightning `.ckpt`
containing `hyper_parameters` + `state_dict` (optimizer state included —
hence the ~1.4 GB `gap_close_v1_1229.ckpt` mentioned in
`docs/temp/serving-backends.md`; the raw weights are a fraction of that).
Serving and the ONNX exporter (`serving/onnx/export_gap_closer.py`) both
rebuild `GapCloser(**hyper_parameters)` and load the state dict, so **any
hparam rename is a serving-compat break**, and inference-time knobs
(`udf_threshold`, `udf_max_dist`) travel inside the checkpoint.

### 4.4 Logging (Comet)

`train.py create_comet_logger` creates a `CometLogger` (project
`gap-closing-udf`, `save_dir logs/comet`) and **hardcodes a Comet API key
into the source** (`train.py:20`) — see Quirks; treat that key as burned and
use `COMET_API_KEY` from `.env` like the colorizer trainers do. Logged:

- per-step train losses (`train/total_loss`, `train/gap_loss`,
  `train/gap_grad_loss`, `train/skeleton_loss`) and `lr`;
- UDF/pixel metrics every 50 train batches and on every val step
  (`compute_metrics`): global `udf_mae`, focal `udf_gap_mae` /
  `udf_skeleton_mae`, and binary accuracy/precision/recall inside the gap
  and skeleton focal regions (via `torchmetrics.functional`) — but see
  Quirk 2, this path appears broken as written;
- at each validation-epoch end (`on_validation_epoch_end` →
  `log_predictions`): 6-column figures per cached batch
  (`visualization.py create_visualization_figure`): input with focal-mask
  contours, GT lines, GT UDF heatmap, predicted UDF heatmap, thresholded
  prediction with IoU, and a green/red gap-accuracy overlay. Uploaded via
  `logger.experiment.log_figure` (TensorBoard `add_figure` fallback).

---

## 5. Eval

There is no separate offline eval harness; evaluation is:

1. **The val split** (1000 held-out crops, same synthetic-gap distribution)
   through `validation_step` — quantitative (`val/*` metrics) and the
   visualization grids above. `test_step` just aliases `validation_step`.
2. **Eye-ball inference on real images**:
   `segmentation/gap_closing/inference.py process_image` runs the full
   production path — `GapCloser.predict` (`gap_closer.py:96`): tiled 512²
   inference with overlap, edge pixels forced to line so borders close,
   thresholded UDF merged with the input binary, then tiled trapped-ball
   segmentation (`compute_seg_full`) — and saves boundary/segmentation
   results. With `model=None` it runs the trapped-ball-only baseline, which
   is the honest A/B for "did gap closing help".

When validating a new checkpoint, the metric that actually matters is
downstream: fewer leaked/merged regions in the `/segment` output at a given
`gap_closer_strength`, judged on real scans — the val loss only ranks models
within one synthetic-gap distribution.

---

## 6. Quirks & gotchas

1. **A real Comet API key is committed** at
   `segmentation/gap_closing/train.py:20`
   (`os.environ["COMET_API_KEY"] = "We3k…"`), contradicting the root
   README's "nothing is hardcoded" and `.env.example`. Rotate the key and
   read it from the environment.
2. **`compute_metrics` looks broken with the current `forward`.**
   `forward` returns `combined_boundary_binary` as a **numpy** array
   (`gap_closer.py:86-94`), but `compute_metrics` calls
   `boundary_binary.long()` and indexes it with torch masks
   (`gap_closer.py:362-387`) — an `AttributeError` on numpy, and the shapes
   ([B,H,W] vs [B,1,H,W]) wouldn't line up anyway. The metrics path clearly
   predates the numpy-based combined boundary; as written, the first
   `batch_idx % 50 == 0` train step / first val step should crash. Fix
   before training (either keep the OR-ed boundary as a torch op, or feed
   metrics the pre-OR thresholded tensor).
3. **Disabling val augmentation disables train augmentation too.**
   `datamodule.py:144` does `self.val_dataset.dataset.augment_prob = 0.0` —
   but `random_split` returns two `Subset`s **sharing the same underlying
   `GapLineDataset`**, so this zeroes geometric augmentation for the train
   split as well. Brush augmentation and gap generation are unaffected. If
   you want augmented training, instantiate two datasets.
4. **Dead hyperparameters:** `train_ratio` (stored, never used — the split
   is hardcoded to 1000 val images) and `speckle_prob` (plumbed through
   YAML → datamodule → dataset, documented in the docstring, but no speckle
   augmentation is ever applied).
5. **`skeletonize_real_dataset.py` calls a method that no longer exists** —
   `model.generate_tiles(...)` (`skeletonize_real_dataset.py:86`); the API
   is now `GapCloser.predict` (which also runs trapped-ball and returns a
   3-tuple). The bootstrap script needs a small port before it can
   regenerate `gap_close_lines_v1` corpora.
6. **Config drift between code defaults and the shipped YAML** — notably
   `udf_max_dist`: 50.0 in code, **10** in `config_512_real.yaml`. Since the
   UDF is normalized by it, a checkpoint's threshold semantics
   (`udf_threshold=1.0` → "within 1 px") only make sense with the
   `udf_max_dist` it was trained with; both are stored in `hparams`, so
   trust the checkpoint, not the code defaults. Same for
   `line_focal_distance_threshold` (4.5 vs 9) and gap-generation ranges.
7. **The dataset is CWD-relative and glob-defined** (`file.py`) — no
   manifest, no dataset versioning. Reordering/adding files silently changes
   the train/val split membership (the split is by index into a shuffled
   list whose shuffle uses the globally-seeded `random` module).
8. **`GapLineDataset.__len__` is "one crop per image"** — an epoch sees each
   source image once at one random crop; effective dataset size is really
   images × augmentation space. Keep that in mind when interpreting
   "epochs".
9. **`scheduler_max_epochs` / `scheduler_warmup_epochs` are only used by the
   cosine branch**, which returns a deprecated tuple shape — treat plateau
   as the only supported scheduler.
10. **Duplicate callback definitions** (train.py vs `configure_callbacks`)
    with different patience values (20 vs 50) — Lightning's
    `configure_callbacks` precedence resolves it, but anyone tuning early
    stopping should edit `gap_closer.py`, not `train.py`.

---

## 7. Remaining TODOs

The gap-closing code has almost no `TODO` comments (the only nearby ones are
in `segmentation/trapped_ball/parallel.py:16,19` — merge duplicate seg
functions; guard >256 segments in `compute_seg`). Judgment-based list:

- Rotate and remove the hardcoded Comet key (Quirk 1); route through
  `.env` like `colorize/scripts/train_ant_v2.py` does.
- Repair `compute_metrics` (Quirk 2) — until then the logged focal
  accuracy/precision/recall should not be trusted (or expected to exist).
- Fix the shared-dataset augmentation mutation (Quirk 3) with separate
  train/val dataset instances.
- Implement or delete `speckle_prob` and `train_ratio`; make the val-set
  size a parameter.
- Port `skeletonize_real_dataset.py` to `GapCloser.predict` (or expose a
  boundary-only method) so the self-distillation corpus can be refreshed.
- Add a manifest-based dataset definition + fixed split to replace the
  glob-and-shuffle (Quirk 7).
- If the eikonal term is ever revived, fix its normalization (§3.2) and
  express `near_zero_threshold` in pixels via `udf_max_dist`.
- Consolidate callbacks/logger config into one place and update the YAML
  usage comment (`train_real.py` → `train.py`).
- Consider exporting a weights-only artifact for serving — the full
  Lightning `.ckpt` ships optimizer state (~1.4 GB) that inference never
  reads (`serving/onnx/export_gap_closer.py` is a start).
