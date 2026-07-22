# colorize/

Reference-guided flat-fill colorization for line art (AnT v1 / AnT v2).
Given a colored reference frame and an uncolored target frame (each as
line art + integer segmentation map), the model assigns every target
segment a color from the reference's palette.

## Package layout

```
ant_v1/         AnT v1: correspondence-matching colorizer
                (model, config, tokenizer, pipeline)
ant_v2/         AnT v2 (recommended): palette-classification colorizer built
                on v1's frozen encoders (model, config, tokenizer, pipeline)
common/         Frame/Sequence/Palette data model, image prep,
                sequence packing, misc ops
nn/             Shared modules: PooledImageEncoder (UNet + torch_scatter
                pooling), SVGEncoder, SuperGlue-style GNN, color/palette
                embeddings
vectorization/  vtracer-based seg-map → SVG vectorization + SVG tensor lib
scripts/        Entry point: local single-pair inference
tests/          Unit tests (sequence packing, SVG lib)
```

This package is **inference-only**: model definitions, tokenizers, and
pipelines for serving and ONNX export. Training code, datasets, and the
data-prep pipeline live outside this repo.

## Entry points

Inference assumes a CUDA GPU (torch_scatter / cupy / cucim) and runs from
the repo root:

```bash
# Colorize one target from one reference (raw PNGs, no dataset needed)
python colorize/scripts/infer_local.py --checkpoint checkpoints/ant_v2 \
    --ref-seg ... --ref-line ... --ref-color ... --target-seg ... --target-line ... --output out.png
```

## Docs

- `docs/colorizer-serving.md` — inference/serving (local FastAPI, Modal, and
  the Rust sidecar's ONNX export + parity infrastructure).
