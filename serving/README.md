# serving/

Everything that serves the ML pipeline, in both implementations:

```
handlers/   framework-free request handlers — the HTTP contract's single
            source of truth (/segment, /preprocess, /colorize)
local/      FastAPI server wrapping handlers/ (the hosted/self-hosted backend)
modal/      Modal deployment stubs wrapping the same handlers
onnx/       ONNX export + parity infrastructure:
              export_ant_v2.py / export_gap_closer.py  — model export
              parity_corpus.py  — production-reference bundles (CUDA box)
              parity_replay.py  — replay bundles on any EP (CPU/CoreML/DML)
sidecar/    the Rust, python-free implementation of the same contract
            (axum + ONNX Runtime + byte-exact ports of every classical stage)
tools/      golden-dump tools (run on the production box) that gate the
            sidecar's verify_* bins, corpus extraction helpers, and
            upload_models_release.sh (publishes the ONNX artifacts to the
            models-v1 GitHub Release, verified against the app's manifest)
```

## Run the hosted server

```bash
PYTHONPATH=. python -m serving.local.server \
  --checkpoint <colorizer-checkpoint-dir> \
  --gap-close-checkpoint <gap_closer.ckpt>   # optional; enables AI gap closing
```

## Run the sidecar

```bash
cd serving/sidecar
cargo run --release -- \
  --ant-model ant_v2_fp32.onnx --gap-model gap_closer_fp32.onnx \
  --ep auto                       # + --ant-model-bucket <pinned.onnx> for CoreML
```

Verification: `cargo test` plus the six `verify_*` bins (segment, gapclose,
tokenize, imageprep, postprocess, http) — each replays production-derived
goldens byte-exactly. See `sidecar/README.md` for flags and
`docs/colorizer-serving.md` / `docs/gap-closer-serving.md` /
`docs/segmentation.md` for design, parity methodology, and EP results.
