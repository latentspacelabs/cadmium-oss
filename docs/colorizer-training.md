# Training the colorizer (AnT v1 / AnT v2)

This document covers how the reference-guided flat-fill colorizer is trained:
data preparation, the model and loss, the training loop, and evaluation.
Serving/inference is documented separately in `docs/colorizer-serving.md` —
this doc only touches inference where the training code shares it.

Entry points:

| What | Script |
|---|---|
| Train AnT v2 (recommended) | `colorize/scripts/train_ant_v2.py` |
| Train AnT v1 (lineage) | `colorize/scripts/train_ant_v1.py` |
| Dataset cleaning (per source) | `colorize/scripts/clean_*_dataset.py` |
| Segmentation-map generation (per source) | `colorize/scripts/seg_*_dataset.py` |
| Pre-featurization (forward-looking, "AnT v3") | `colorize/scripts/featurize_sequences.py` |
| Eval over a dataset | `colorize/scripts/eval_pipeline_ant_v2.py` |
| Single-pair inference | `colorize/scripts/infer_local.py` |

> **Read the Quirks section before attempting a retrain.** The most important
> one: the `colorize/datasets/` package (dataset readers + the
> `FramePairDatamodule` that both train scripts import) is **not present in
> this repo**, so `train_ant_v2.py` does not run as checked in. Everything
> else in the pipeline is here.

---

## 1. Motivation

The task: given a *reference* frame (line art + segmentation map + flat-fill
colors) and a *target* frame (line art + segmentation map only), assign each
target segment a color. This is the core of assisted in-between colorization —
an animator colors keyframes, the model propagates colors to the rest.

Two model generations live side by side:

- **AnT v1** (`colorize/ant_v1/model_ant_v1.py`) frames it as *segment
  correspondence*: encode each segment (image + SVG features), cross-attend
  ref↔target with a SuperGlue-style GNN, build a similarity matrix, and
  propagate colors through a softmax over reference segments. Colors are never
  "understood" — they ride along the matching.
- **AnT v2** (`colorize/ant_v2/model_ant_v2.py`) reframes it as *palette-index
  classification*: reuse v1's (frozen) per-segment encoders, embed known
  colors and palette indices, concatenate all ref + target segment tokens into
  one sequence, run a bidirectional Llama decoder over it, and classify each
  target segment into one of `max_palette_size` (512) palette slots. This lets
  the model condition on the actual colors shown in the prompt, and makes
  multi-reference / partial-coloring setups natural (everything is just tokens
  in the sequence).

V2 is what serving uses; v1 exists both as lineage and because v2 physically
contains a v1 model as its encoder backbone.

---

## 2. Data

### 2.1 Frame representation

Every training frame is three aligned images (`colorize/common/frame.py`):

| Image | Type | Meaning |
|---|---|---|
| `line` | RGBA | the line art |
| `seg` | int32 map | one integer label per fillable region (label = segment id) |
| `color` | RGBA | flat-filled colors (used to derive per-segment labels) |

A scene is a pickled `Sequence` (`colorize/common/sequence.py`): a list of
`KeyFrame`s plus a `Palette` — the deduplicated list of scene colors, with a
per-frame mapping `frame_idx -> [color_id per segment]`. The training label
for a segment is its **palette color id**, not its RGBA value.

### 2.2 Dataset sources

Both train scripts take seven dataset paths (`train_ant_v2.py:22-28`), each a
directory containing `sequences/*.pkl`:

| Flag | Source | What it contributes |
|---|---|---|
| `--real_dataset_path` | production anime scenes (e.g. `teentitan` shots seen in `colorize/scripts/render_preprocess.py`) | in-domain hand-drawn line art with real color scripts; also the held-out test scenes (`REAL_TEST_SEQUENCES`) |
| `--cadmium_dataset_path` | Cadmium app user data (`cadmium-data-*` exports) | real end-user drawing styles |
| `--pbc_dataset_path` | PaintBucket-Character-style dataset | academic character colorization data |
| `--synth_dataset_path` | Mixamo-rendered 3D characters | perfectly consistent segments across large motion |
| `--shapes_dataset_path` | synthetic shapes (+ Mixamo variants) | easy, high-volume geometric matching |
| `--handdrawn_dataset_path` | hand-drawn line collections | line-style diversity |
| `--anita_dataset_path` | AnitA dataset (sketch/color pairs) | paired sketch+color animation frames |

The mix intentionally spans "trivially consistent synthetic" to "messy real
production" so the matcher doesn't overfit to clean segment topology.

### 2.3 Segmentation-map generation (`seg_*_dataset.py`)

Raw sources ship line + color images but no segment maps. The
`colorize/scripts/seg_*_dataset.py` scripts create them by running **tiled
trapped-ball segmentation** (`segmentation/trapped_ball/parallel.py
compute_seg_full`, 512×512 tiles, 0.5 overlap, `overlap-tile` merging) over
each line image. Per-source differences that matter:

- `seg_real_dataset.py` — binarizes with adaptive-mean thresholding
  (neighborhood 51), then *augments the binary with color-edge lines*
  (`segmentation/trapped_ball/color.py detect_edges` + `get_eroded_edges`) so
  regions separated only by a color change (no drawn line) still split.
  Trapped-ball radii `[5, 4, 2]`. Output dir:
  `tb_seg_neigborhood_51_color_lines_5_4_2` (note the committed misspelling
  "neigborhood" — it is load-bearing in glob patterns everywhere).
- `seg_anita_dataset.py` — same color-line trick, radii `[8, 5, 3]`, pairs
  `sketch/` with `color/` scene dirs.
- `seg_pbc_handdrawn_dataset.py` / `seg_synth_shapes_mixamo_dataset.py` —
  adaptive-mean binarize only; radii `[8, 5, 3]` and `[3, 2, 1]` respectively.
- `seg_animerun_dataset.py` — AnimeRun `contour/` images, hard threshold at
  240, radii `[0, 0, 0]` (pure flood fill; the contours are already closed).
- `make_mixamo_dataset.py` — the inverse direction: Mixamo renders come as
  *unique-color* region images; this script derives boundary `line` images
  from them (per-region morphological dilate−erode), writing
  `color-unique/... -> line/..._line.png`.

Each script writes an int32 seg map serialized as RGBA PNG
(`segmentation/trapped_ball/serialization.py int32_to_rgba`) plus a
`-rainbow.png` visualization.

### 2.4 Cleaning into `Sequence` pickles (`clean_*_dataset.py`)

The `clean_*` scripts are thin wrappers that instantiate a per-source
`FileReader` (`RealFileReader`, `CadmiumFileReader`, `PBCFileReader`,
`AnitaFileReader`, `AnimerunFileReader`, `SynthFileReader`) from
`colorize.datasets.file_readers` and call `.run(output_path=
'./datasets/<basename>-<glob>')`. **That module is missing from the repo**
(see Quirks), but the shared machinery it drives is here, in
`Sequence.from_full_scene_files` (`colorize/common/sequence.py:150`):

1. Load seg/color/line frames, dropping empty/corrupt files
   (`filter_empty_frames`).
2. Align the three streams by frame number (`colorize/common/file.py
   align_frames`) and drop frames whose line image is byte-identical to the
   previous one (`filter_duplicate_frames` — animation holds).
3. **Quantize colors scene-globally**: all color frames are concatenated and
   quantized to ≤256 colors with PIL `MAXCOVERAGE`
   (`Sequence.quantize_color_frames`) so near-duplicate fills collapse to one
   palette entry.
4. Build the `Palette` from per-frame dominant colors per segment
   (`KeyFrame.compute_color_list` via `colorize/common/color_extraction.py`).

Result: `datasets/<name>/sequences/*.pkl`, the format both training and eval
consume.

### 2.5 Per-frame image preparation and vectorization

At tokenization time (train) or ingest time (featurization), each frame goes
through `prepare_image` (`colorize/common/image.py:32`):

1. Crop to the line-art bounding box (+10 px padding).
2. Resize proportionally to fit 1024×1024 (`ImageArgs`), **nearest-neighbor
   for everything** including line/color (there is a TODO about this at
   `colorize/common/image.py:161`).
3. Optionally augment (see §4.1).
4. `prepare_resized_seg_for_vtrace` (`colorize/vectorization/vtrace.py:64`):
   resizing/augmentation can annihilate small segments. First it re-inserts a
   single pixel at each lost segment's (scaled) center of mass
   (`preserve_small_segments`); if segments are still missing it builds an
   `id_map` renumbering the survivors to contiguous ids.
5. Vectorize the seg map with the custom `vtracer` wheel
   (`colorize/vectorization/vtrace.py vectorize`, `colormode='seg'`) into an
   `SVG` (`colorize/vectorization/lib/svg.py`) — one path per segment, later
   tensorized as `[num_segments, num_commands, 6]` (command one-hots + control
   points).
6. Pad to exactly 1024×1024 — seg padded with **-100**, line/color with 0.
   `-100` is the universal null/pad value across the whole stack.

### 2.6 Pre-featurized datasets (forward-looking)

`colorize/scripts/featurize_sequences.py` bakes the expensive part of the
pipeline (augment → vectorize → frozen encoders) offline: for each scene it
runs `--num_variants` independent augmentation passes (variant 0 is clean),
forwards every frame through the frozen v1 image+SVG encoders, and writes
`FeaturizedSequence` pickles (`colorize/common/featurized_sequence.py`,
tensors stored bf16) to `<output>/featurized/v{k:02d}/<scene>.pkl`. Seeds are
derived per `(scene, variant)` so any pickle can be reproduced;
`colorize/scripts/visualize_featurized_sequence.py` replays the ingest to
render what the encoder actually saw. This targets an "AnT v3" trained from a
`FeaturizedSequenceDatamodule` that is not in this repo; v1/v2 training
tokenizes raw `Sequence` pickles on the fly instead.

---

## 3. Model & loss

### 3.1 Shared per-segment encoders (`colorize/nn/`)

- **`PooledImageEncoder`** (`colorize/nn/image_encoder.py`): computes an SDF
  of the line art on-GPU (`compute_sdf_cupy`, cupy/cucim), fuses line+SDF
  through a UNet with 4 transformer blocks at the bottleneck
  (`colorize/nn/unet.py`), then **segment-mean-pools** the ¼-resolution
  feature map using the seg map as the scatter index
  (`torch_scatter.scatter`). Output: one 512-d vector per segment. Applies
  10% whole-segment feature dropout in training.
- **`SVGEncoder`** (`colorize/nn/svg_encoder.py`): embeds each path command
  (6-d) with a small MLP, runs a 4-layer Llama over the command sequence, and
  mean-aggregates commands per segment. To avoid padding waste, per-segment
  command sequences are **greedily bin-packed** into rows of ≤256 commands
  with block-diagonal attention masks — `pack_sequences` /
  `unpack_sequences` in `colorize/common/packing.py` (unit-tested in
  `colorize/tests/common/test_packing.py`). Also 10% segment dropout.

### 3.2 AnT v1 (`colorize/ant_v1/model_ant_v1.py`)

image feats ⊕ svg feats → `seg_proj` MLP → 4-layer bidirectional Llama
"fusion encoder" over the segment sequence → SuperGlue-style cross-attention
GNN (`colorize/nn/superglue.py`, 2 cross layers) → L2-normalized features.
Then a similarity matrix `ref×target / corr_temperature (0.1)`, softmaxed
over *reference* segments with unknown/padded refs masked
(`masked_softmax`, `colorize/common/ops.py`), and colors propagated by
one-hot matrix multiply.

Loss (config `colorize/ant_v1/config_ant_v1.py`):

- **Forward NLL** on propagated color distributions vs target color ids
  (per-sample normalized by active segment count).
- **Cycle-consistency loss** (`cycle_weight=0.5`, `_cycle_loss`): propagate
  *positional* ids forward, keep only target segments whose color prediction
  was correct, propagate their ids backward, and NLL against the reference's
  own positions. This punishes many-to-one collapse in the matching.
- **DIFT distillation** (`dift_weight=0.0`, disabled): cosine-distill UNet
  mid-features to a diffusion-feature teacher. The teacher module is
  commented out (`model_ant_v1.py:91-108`) — setting `dift_weight>0` crashes
  (see Quirks).

### 3.3 AnT v2 (`colorize/ant_v2/model_ant_v2.py`, config `config_ant_v2.py`)

- Instantiates a full `AnTV1Model` and freezes its `img_feat_extractor` and
  `svg_feat_extractor` (`requires_grad_(False)` plus `torch.no_grad()` in
  `_create_inputs_embeds`). Only the encoders are used; the rest of v1 rides
  along in the checkpoint (see Quirks).
- Per segment, concatenates 5 embeddings and fuses with an MLP + LayerNorm
  (`seg_color_frame_fusion_proj`):
  image (512) ⊕ svg (512) ⊕ **color** ⊕ **frame** ⊕ **palette-index**
  (256 each).
  - `ColorEmbedding` (`colorize/nn/color_embedding.py`): RGBA → quantized
    LAB+alpha, four embedding tables + projection. Only *prompted* colors get
    real embeddings; everything else gets a learned null.
  - `PaletteEmbedding` (`colorize/nn/palette_embedding.py`): embeds the color
    *id* (0..511), null id for unknown.
  - Prompting rule (`_combine_color_frame_palette_embeds`): reference
    segments with known colors are prompted; **target segments are never
    prompted** during training (their mask is all-False), so the model always
    predicts every target segment.
  - 10% element-wise dropout on fused embeddings during training.
- `_pack_inputs` strips padding segments and concatenates each sample's ref
  tokens followed by target tokens into one right-padded sequence.
- Decoder: 16-layer, 1024-d, 16-head **Llama run bidirectionally** — a custom
  4-D all-visible attention mask (`make_4d_bidirectional_attention_mask`,
  `colorize/common/ops.py`) turns the causal LM into a BERT-style encoder
  (comments in the file say "bert decoder"; the implementation is Llama +
  RoPE). Runs under `torch.autocast(bf16)`.
- `lm_head`: linear to `max_palette_size=512` logits per token;
  `_unpack_outputs` scatters target-token logits back to per-sample target
  slots.

**Loss**: plain cross-entropy over palette ids with `label_smoothing=0.1`;
padded/masked targets are `-100` and fall out via CE's default
`ignore_index`. There is no matching loss, no cycle loss — v2 relies entirely
on classification. A masked-softmax helper restricting predictions to colors
shown in the prompt exists (`_mask_softmax_logits`) but is not applied to the
loss. A MaskGIT-style iterative sampler was prototyped and is fully commented
out (`model_ant_v2.py:422-553`, scheduler kept in
`colorize/common/maskgit.py`); inference is a single forward + argmax.

### 3.4 Tokenizers

`AnTV1Tokenizer` (`colorize/ant_v1/tokenizer_ant_v1.py`) does the
`Sequence` → tensors conversion:

- `from_full_seq` (training, exactly 2 frames): builds ref/target color-id
  vectors, masks ids for segments that vanished from the raster seg
  (`mask_null_color_ids`) and — by default — **masks target colors that don't
  exist in the reference** (`mask_new_target_colors=True`), so the model is
  never trained to invent colors absent from the prompt.
- SVG truncation: segments with >256 path commands get **256 randomly sampled
  (with replacement), sorted** command indices (`get_vec_tokens`) — cheap but
  lossy; see Quirks.
- `collate` right-pads color ids, SVG tensors, packed SVG tensors and their
  block attention masks to batch maxima with `-100`, and stacks images.
- `from_partial_seq` (inference): single ref keyframe + uncolored target,
  batch dim added inline (no collate).

`AnTV2Tokenizer` (`colorize/ant_v2/tokenizer_ant_v2.py`) subclasses v1 and
additionally emits `ref_colors`/`target_colors` (RGBA per segment, from the
palette) for the color embedding; targets are all `-100` at inference.

---

## 4. Training loop specifics

### 4.1 Augmentation

Augmentation happens **image-side, before vectorization**, in
`augment_images` (`colorize/common/image.py:97`), applied identically to
seg/line/color via albumentations `additional_targets`:

| Transform | Params | p |
|---|---|---|
| `RandomResizedCrop` | scale (0.5, 1.0), nearest | 0.4 |
| `ShiftScaleRotate` | shift 0.3, scale 0.25, rotate ±60°, constant border filled with −100 (seg pad value), nearest | 0.4 |
| `ThinPlateSpline` | scale (0.1, 0.3), 4 control points, nearest | 0.4 |

Because ref and target are augmented *independently*, every epoch effectively
creates new correspondence problems. Nearest-neighbor interpolation everywhere
keeps seg ids valid; segments that get cropped/warped away are resurrected or
renumbered by `prepare_resized_seg_for_vtrace` (§2.5). Note the
`random_zoom_scale` / `random_shift_scale` / `random_rotate_scale_degrees`
fields on `ImageArgs` are vestigial — the actual parameters are hardcoded in
`augment_images`.

### 4.2 Optimizer / schedule (`train_ant_v2.py:96-123`)

HuggingFace `Trainer` + `TrainingArguments`:

| Setting | AnT v2 | AnT v1 |
|---|---|---|
| batch (per device × grad accum) | 4 × 8 = 32 | 2 × 16 = 32 |
| max steps | 10 000 | 100 000 |
| lr / schedule | 1e-4, cosine, 100 warmup | same |
| grad clip | **0.1** | 0.1 |
| weight decay | 1e-5 | 1e-5 |
| precision | fp32 master (`fp16=bf16=False`); model internals autocast bf16 | same |
| eval/save every | 250 steps | 500 steps |
| output dir | `ant_v2_out/` | `ant_v1_out/` |
| misc | `save_safetensors=False` (pickle `.bin`), `remove_unused_columns=False` (required — inputs aren't forward-signature-filtered), `label_names=["target_color_ids"]`, `dataloader_num_workers=4`, seeds 1 | + `dataloader_prefetch_factor=32` |

Checkpoint bootstrap (`train_ant_v2.py:59-65`): dispatch is by **substring of
the path** — a `--checkpoint` containing `ant_v2_out` resumes a v2 model;
one containing `ant_v1_out` builds a fresh v2 and grafts the v1 weights into
`model.ant_v1`. Cold-starting v2 therefore requires a trained v1 checkpoint.

### 4.3 Logging

- Comet: env vars are set at startup (`COMET_LOG_*`, project `ant_v2` or
  `ant_v2_debug` with `--debug`); the API key comes from `.env`
  (`load_dotenv()`, see `.env.example`). The explicit `CometCallback` line is
  commented out — HF Trainer auto-attaches Comet when `comet_ml` is importable
  and the key is set.
- Additionally the *model itself* logs to the global Comet experiment every
  training step (`AnTV2Model._log_additional_metrics`: loss, per-sample
  `train_acc`, a `no_active_preds` alarm). AnT v1 logs
  fwd/bkwd/dift losses and fwd/bkwd accuracy the same way.
- Eval metrics: `colorize/ant_v1/metrics_ant_v1.py compute_metrics`
  (shared by both trainers) — per-sequence accuracy / macro precision /
  recall / F1 over active segments; `preprocess_logits_for_metrics` keeps only
  the argmax id tensor so the Trainer doesn't accumulate full logits.

### 4.4 What a retrain actually requires

1. GPU with CUDA (hard requirement: `torch_scatter`, `cupy`, `cucim`,
   `device_type="cuda"` autocasts are hardcoded). Install per the root
   `README.md` (`pip install -e . && pip install -r requirements-cuda.txt`).
2. The seven `Sequence` datasets (§2.2) under `datasets/`.
3. A `FramePairDatamodule` implementation (missing, §6.1) that yields
   tokenized samples: it received the seven paths plus the tokenizer and
   exposed `get_train_ds()` / `get_val_ds()` returning HF-`datasets`-style
   map datasets of `tokenizer.from_full_seq(seq)` outputs; the collator is
   `tokenizer.collate`.
4. For v2: a v1 checkpoint (or a v2 checkpoint to resume).
5. `.env` with `COMET_API_KEY` (or leave blank to skip logging).

---

## 5. Eval

`colorize/scripts/eval_pipeline_ant_v2.py` evaluates a checkpoint through the
full inference pipeline (`AnTV2Pipeline`, `colorize/ant_v2/pipeline_ant_v2.py`
— the same code path serving uses), not through the Trainer:

- Iterates each pickled sequence **forward and backward** over adjacent frame
  pairs (frame *i* colors frame *i*±1), materializing colors from the palette.
- Metrics per pair (`compute_eval_output`): **segment accuracy** (sklearn
  `accuracy_score` over active segments, excluding "new color" segments whose
  ground-truth color doesn't exist in the reference) and **pixel accuracy**
  (exact RGBA match over the rendered frame). Dataset-wide means printed at
  the end.
- `--save_colorized` writes 4×4 diagnostic grids to
  `./output/<dataset>/<seq>/`: seg rainbows, lines, GT vs predicted color,
  an error mask (red = wrong, blue = unknown segment, green = new-color
  segment), plus entropy-confidence visualizations
  (`compute_normalized_entropy` over the palette logits; ≥0.6 counts as
  high-confidence, low-confidence correct/incorrect shown orange/pink).
- For the real dataset it evaluates only `REAL_TEST_SEQUENCES` (the held-out
  scene list defined in the missing `frame_pair_datamodule` module); other
  datasets evaluate every sequence.

Quick smoke test without a dataset: `colorize/scripts/infer_local.py`
colorizes one target from one reference given raw PNGs.

---

## 6. Quirks & gotchas

Honest inventory of things that will bite you:

1. **`colorize/datasets/` is missing.** `train_ant_v1.py`, `train_ant_v2.py`
   (`FramePairDatamodule`), every `clean_*_dataset.py` (`file_readers`),
   `vectorization_stats.py` (`constants.VEC_FIELD_NAMES`) and
   `eval_pipeline_ant_v2.py` (`REAL_TEST_SEQUENCES`) import from it, and the
   root `README.md` even lists it in the repo layout — but the package is not
   in the tree (and not in git history). To retrain you must restore or
   reimplement it (§4.4 documents its contract).
2. **`--checkpoint` is declared optional but is not.** `train_ant_v2.py:59`
   immediately does `"ant_v2_out" in args.checkpoint` — passing nothing raises
   `TypeError`. And the v1-vs-v2 dispatch is by *path substring*
   (`ant_v2_out` / `ant_v1_out`); a checkpoint dir named anything else hits
   an `UnboundLocalError`. (`featurize_sequences.py:354` does this properly,
   by reading `model_type` from the checkpoint's `config.json`.)
3. **V2 checkpoints carry a mostly-dead v1.** `AnTV2Model.__init__`
   instantiates a *full* `AnTV1Model` (fusion Llama, GNN and all) but only
   ever calls its two encoders. The unused submodules are trained-frozen,
   saved, and reloaded — a large chunk of the ~3.6 GB checkpoint is inert.
4. **"BERT decoder" is a bidirectional Llama.** Comments say BERT; the code
   builds `LlamaModel` and feeds it an all-visible 4-D attention mask. RoPE
   positions correspond to position in the packed ref+target token sequence,
   which shifts with padding removal — position is not a stable segment
   identity.
5. **SVG truncation can duplicate commands.** When a segment exceeds 256 path
   commands, indices are sampled **with replacement**
   (`np.random.randint`, then sorted) rather than subsampled uniquely
   (`tokenizer_ant_v1.py:49-58`, mirrored in `featurize_sequences.py:137`).
6. **Eval "unknown segment" filter is a tautology.**
   `eval_pipeline_ant_v2.py:242`:
   `active_seg_mask = [int(t) != -100 or int(t) != -1 for t in target_colors]`
   is always `True` (should be `and`), so unknown segments are never actually
   excluded from segment accuracy and `num_unknown_segments` is always 0.
7. **`dift_weight > 0` crashes.** The DIFT teacher and projection are
   commented out of `AnTV1Model.__init__`, but `_dift_loss` still references
   `self.dift` / `self.seg_feats_to_dift_proj`. The default (0.0) is safe.
8. **`mask_new_target_colors=True` shapes what the model can learn** — target
   segments whose color never appears in the reference are masked out of the
   loss. The model cannot learn to introduce new colors; eval separately
   discounts them. Flip the tokenizer flag deliberately if you want otherwise.
9. **Legacy pickles need the rename shim.** Old datasets were pickled when
   the package was called `modeling_torch`; only
   `featurize_sequences.py`'s `_LegacyUnpickler` remaps them.
   `eval_pipeline_ant_v2.py` uses plain `pickle.load` and will fail on
   pre-rename pickles.
10. **Trainer precision flags are off, but the model autocasts anyway** —
    fusion/decoder/GNN blocks run under hardcoded
    `torch.autocast("cuda", bf16)`. Don't be fooled by `bf16=False`; also
    nothing here runs on CPU or MPS.
11. **`compute_metrics` divides by zero** if every eval sequence has no
    active segments (`metrics_ant_v1.py:46`) — only a risk on tiny debug
    datasets.
12. **Deterministic-mode block is commented out** in both train scripts;
    `seed`/`data_seed` are set (1) but cuDNN/cublas determinism is not
    enforced.
13. **`ImageArgs.padding` is decorative** — `prepare_image` hardcodes
    `padding=10` in its `crop_image` calls.

---

## 7. Remaining TODOs

From `TODO` comments in the code:

- `colorize/nn/svg_encoder.py:104` — better per-segment aggregation than
  masked mean over command features.
- `colorize/nn/superglue.py:97` — siamese vs separate final projections for
  ref/target.
- `colorize/nn/unet.py:143` — bump the 1×1-conv output embedding dim.
- `colorize/ant_v2/model_ant_v2.py:342` — choose a real pad value for packed
  decoder inputs (currently 0.0 with attention masking).
- `colorize/ant_v2/pipeline_ant_v2.py:40` — make image dims configurable in
  `from_pretrained`.
- `colorize/vectorization/vtrace.py:32` — serving's vtracer build doesn't
  support padding; unify.
- `colorize/common/sequence.py:305,491` — should line pixels be excluded from
  color quantization; should the ref frame be quantized at inference.
- `colorize/common/image.py:57,161` — preserve small segments when cropping
  color; bilinear vs nearest resize for line/color.
- `colorize/common/ops.py:178` — use `to_dense_batch`.

Judgment calls beyond the comments:

- Restore/publish the `colorize/datasets` package — it is the single blocker
  to reproducing training (Quirk 1).
- Replace the checkpoint path-substring dispatch with the `config.json
  model_type` dispatch already used by `featurize_sequences.py`.
- Fix the eval unknown-segment tautology (Quirk 6).
- Strip the unused v1 submodules from v2 checkpoints (or construct only the
  encoders) to cut checkpoint size dramatically.
- Decide the fate of the MaskGIT sampler (commented out) — either wire
  `sample()` back up for iterative refinement or delete it and
  `colorize/common/maskgit.py`.
- Finish the pre-featurized (v3) training path: `FeaturizedSequenceDatamodule`
  and its trainer are referenced by `featurize_sequences.py` but absent.
