# cadmium-oss

Reference-guided **flat-fill colorization for line art**. Given a colored
reference frame and an uncolored target frame, the model propagates the
reference's per-segment colors onto the target — the core building block for
assisted/automatic anime in-between colorization.

This repo contains two model generations:

- **AnT v1** — the original reference-matching colorizer.
- **AnT v2** — improved model + tokenizer (the recommended one; used by the
  inference and Modal paths below). The v2 pipeline reuses v1 components, so
  both are included.

> ⚠️ **Status / license.** This is research code released for reproducibility.
> A license has **not** been finalized yet — until one is added, no usage
> rights are granted. Don't rely on it for production until that's resolved.

---

## How it works (high level)

Each frame is represented as three aligned images:

| Image | Meaning |
|-------|---------|
| **line** | the line art |
| **seg**  | an integer-labeled segmentation map (one label per fillable region) |
| **color** | the flat-filled colors (reference only) |

The reference's colors are reduced to a **per-segment color list**, the model
matches target segments to reference segments, and each target segment is
assigned a color. See `colorize/ant_v2/` for the model, tokenizer, and pipeline.

---

## Repository layout

```
app/              # the Cadmium desktop app (Electron + Vue) — see app/README.md
colorize/         # inference-only model code (training lives outside this repo)
  ant_v1/         # AnT v1 model, tokenizer, pipeline
  ant_v2/         # AnT v2 model, tokenizer, pipeline (recommended)
  common/         # frames, sequences, image ops, color extraction
  nn/             # encoders / embeddings used by the models
  vectorization/  # SVG vectorization helpers (vtracer)
  scripts/        # local inference entry point
segmentation/
  trapped_ball/   # trapped-ball segmentation + serialization utils
  gap_closing/    # ML gap-closing model (GapCloser), inference only
serving/
  handlers/       # framework-agnostic request handlers (shared by all servers)
  local/          # single FastAPI process serving all endpoints
  modal/          # Modal deployments: colorize / seg / preprocess
  onnx/           # ONNX export + cross-backend parity infrastructure
  sidecar/        # Rust, python-free server: same HTTP contract, ONNX Runtime
                  # (CPU / CoreML / DirectML), byte-exact classical ports
  tools/          # golden-dump tools gating the sidecar's verify bins
third_party/      # vendored vtracer + visioncortex forks (submodules)
docs/             # per-component docs (design, quirks, TODOs) — start there
```

Per-component deep dives live in [docs/](docs/README.md).

---

## Installation

Requires **Python 3.10** and an **NVIDIA GPU with CUDA 12.x** (the model and
segmentation code depend on `torch_scatter`, `cupy`, and `cucim`, which are
GPU-only). CPU-only execution is not currently supported.

```bash
git clone <this-repo> cadmium-oss
cd cadmium-oss
python -m venv .venv && source .venv/bin/activate

# Core dependencies (PyPI-installable; pinned to the production serving env —
# torch 2.6.0, Pillow 11, scipy 1.12, numpy 1.26, opencv 4.11. The Rust
# sidecar's byte-exact parity goldens encode these versions' semantics).
pip install -e .

# CUDA-specific dependencies.
pip install -r requirements-cuda.txt
```

### Secrets / environment

Secrets (e.g. Modal deploy credentials) are read from a local `.env` file —
nothing is hardcoded.

```bash
cp .env.example .env
```

---

## Checkpoints & models

This repo ships **inference code only** — training code and data pipelines
are not part of it. Pretrained artifacts come in two forms:

- **ONNX models** (what the desktop app uses): downloaded automatically from
  the `models-v1` GitHub release into the app's models directory, with
  size + sha256 verification (`app/src/util/model-manifest.js`).
- **Torch checkpoints** (for the Python servers and the ONNX export/parity
  tooling): Hugging Face–style directories loadable via
  `AnTV2Model.from_pretrained(<checkpoint_dir>)`; place them under
  `checkpoints/` (gitignored). Distribution instructions are provided
  separately.

---

## Running locally

### Inference (single reference → target)

Colorize one target frame from one colored reference frame, using raw image
files (no preprocessing required):

```bash
python colorize/scripts/infer_local.py \
    --checkpoint  checkpoints/ant_v2 \
    --ref-seg     examples/ref_seg.png \
    --ref-line    examples/ref_line.png \
    --ref-color   examples/ref_color.png \
    --target-seg  examples/target_seg.png \
    --target-line examples/target_line.png \
    --output      examples/target_colorized.png
```

The reference palette is derived automatically from `--ref-color` + `--ref-seg`.

### Local API server (mimics the Modal endpoints)

Run the same HTTP API as the Modal deployments, but as a single local process.
Models load once at startup, and any client written against the Modal endpoints
works unchanged against this server. It serves all three operations the desktop
app needs:

| Endpoint | Operation | App call it replaces |
|----------|-----------|----------------------|
| `POST /colorize` | reference-guided colorization (AnT v2) | `/api/colorize` |
| `POST /segment`  | gap-closing + trapped-ball segmentation | `/api/segment` |
| `POST /preprocess` | reference-assisted palette extraction (v2) | `/api/preprocess` |
| `POST /predict`  | alias of `/colorize` (back-compat) | — |
| `GET /health`    | liveness check | — |

```bash
pip install -e ".[serve]"
python -m serving.local.server \
    --checkpoint checkpoints/ant_v2 \
    --gap-close-checkpoint checkpoints/gap_close_v1_1229.ckpt \
    --host 0.0.0.0 --port 8000
```

`--gap-close-checkpoint` is optional; without it `/segment` runs trapped-ball
only (no ML gap closing). Each endpoint takes a JSON body of base64-encoded PNG
URIs, identical to the Modal contract — e.g. colorization:

```bash
curl -X POST http://localhost:8000/colorize \
  -H 'Content-Type: application/json' \
  -d '{
        "ref_seg_map_uri": "<base64 png>",
        "ref_line_image_uri": "<base64 png>",
        "target_seg_map_uri": "<base64 png>",
        "target_line_image_uri": "<base64 png>",
        "ref_colors_rgba": [[255,0,0,255]],
        "return_colorized": true
      }'

# segmentation (gap_closer_strength maps to the model's UDF threshold)
curl -X POST http://localhost:8000/segment \
  -H 'Content-Type: application/json' \
  -d '{
        "line_image_uri": "<base64 png>",
        "line_threshold_params": {"type": "adaptive_mean"},
        "return_colorized": true,
        "min_seg_size": 10,
        "gap_closer_strength": 1.0
      }'
```

Request/response handling is shared with the Modal stubs via
`serving/handlers/`, so the two stay in lockstep. These contracts mirror the
calls the desktop app makes (see `app/src/util/modal.js`); the licensing/proxy
fields the app sends (`user_id`, `license_key`, …) are simply ignored here.

### Python-free local serving (the Rust sidecar)

The same three endpoints are also served by a single Rust binary with **no
Python runtime** — classical stages are byte-exact Rust ports, the nets run
under ONNX Runtime (CPU everywhere; CoreML on Apple silicon; DirectML on
Windows), and responses are verified field-identical to the Python server on
a recorded production corpus:

```bash
cd serving/sidecar
cargo run --release -- \
    --ant-model ant_v2_fp32.onnx --gap-model gap_closer_fp32.onnx --ep auto
```

See `serving/README.md` and `docs/colorizer-serving.md`.

## Running on Modal

Each operation deploys to [Modal](https://modal.com) as its own web endpoint.
The colorizer and gap-closing segmenter are GPU (A10G) endpoints with weights
mounted from a Modal Volume; preprocessing is CPU-only.

```bash
pip install -e ".[modal]"
modal token new                       # one-time auth

# Colorizer weights volume.
modal volume create cadmium-colorizer-weights
modal volume put cadmium-colorizer-weights ./checkpoints/ant_v2 /v2-checkpoint

# Gap-closing weights volume (expects gap_close_v1_1229.ckpt at the root).
modal volume create cadmium-gap-close-weights
modal volume put cadmium-gap-close-weights ./checkpoints/gap_close_v1_1229.ckpt /

# Serve the endpoints (each is a separate Modal app).
modal serve serving/modal/colorize/colorize_v2_stub.py
modal serve serving/modal/seg/gap_close_v1_stub.py
modal serve serving/modal/preprocess/preprocess_v2_stub.py
```

Every endpoint accepts/returns base64-encoded PNG URIs. The request/response
logic lives in `serving/handlers/` and is reused by both the Modal stubs and the
local server, so they cannot drift. See `serving/modal/<op>/image.py` for each
container image definition.

> Note: the checkpoint names passed inside the stubs (`MODEL_DIR/...`) must match
> the paths you uploaded into the volumes.

---

## License

Not yet finalized. See the status note at the top of this file.
