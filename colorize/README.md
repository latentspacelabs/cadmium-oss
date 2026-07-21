# colorize/

Reference-guided flat-fill colorization for line art (AnT v1 / AnT v2).
Given a colored reference frame and an uncolored target frame (each as
line art + integer segmentation map), the model assigns every target
segment a color from the reference's palette.

## Package layout

```
ant_v1/         AnT v1: correspondence-matching colorizer
                (model, config, tokenizer, pipeline, HF-Trainer metrics)
ant_v2/         AnT v2 (recommended): palette-classification colorizer built
                on v1's frozen encoders (model, config, tokenizer, pipeline)
common/         Frame/Sequence/Palette data model, image prep + augmentation,
                sequence packing, featurized-sequence format, misc ops
nn/             Shared modules: PooledImageEncoder (UNet + torch_scatter
                pooling), SVGEncoder, SuperGlue-style GNN, color/palette
                embeddings
vectorization/  vtracer-based seg-map → SVG vectorization + SVG tensor lib
scripts/        Entry points: training, eval, inference, dataset prep
tests/          Unit tests (sequence packing, SVG lib)
```

Note: the training scripts import a `colorize.datasets` package
(`FramePairDatamodule`, per-source `FileReader`s) that is **not currently in
the tree** — see the gotchas in `docs/colorizer-training.md`.

## Entry points

All scripts assume a CUDA GPU (torch_scatter / cupy / cucim) and are run
from the repo root:

```bash
# Train AnT v2 (v1 takes the same arguments via train_ant_v1.py)
python colorize/scripts/train_ant_v2.py \
    --real_dataset_path datasets/real ... --anita_dataset_path datasets/anita \
    --checkpoint <ant_v1_out or ant_v2_out checkpoint dir>

# Evaluate a checkpoint over a dataset (seg + pixel accuracy, optional grids)
python colorize/scripts/eval_pipeline_ant_v2.py \
    --dataset_path datasets/<name> --checkpoint checkpoints/ant_v2 --save_colorized

# Colorize one target from one reference (raw PNGs, no dataset needed)
python colorize/scripts/infer_local.py --checkpoint checkpoints/ant_v2 \
    --ref-seg ... --ref-line ... --ref-color ... --target-seg ... --target-line ... --output out.png

# Pre-featurize Sequence pickles through the frozen encoders (v3 prep)
python -m colorize.scripts.featurize_sequences \
    --input_path datasets/<name> --output_path datasets/<name> --checkpoint checkpoints/ant_v2
```

Dataset prep lives in `scripts/seg_*_dataset.py` (trapped-ball segmentation
maps per source) and `scripts/clean_*_dataset.py` (pickled `Sequence`
datasets). Comet logging activates when `COMET_API_KEY` is set in `.env`.

## Docs

- `docs/colorizer-training.md` — data pipeline, model & loss, training loop,
  eval, quirks. Read this before retraining.
- `docs/colorizer-serving.md` — inference/serving (local FastAPI + Modal).
