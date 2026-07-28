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

> **License:** [Apache 2.0](LICENSE). Vendored `third_party/` code keeps its
> original licenses.

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

## Ways to run this

There are several entry points, and **most of them need no Python at all**.
Pick the row that matches what you want to do:

| You want to… | Entry point | What it needs |
|---|---|---|
| **Use / develop the desktop app** | `app/` in dev mode — talks to a hosted URL or the bundled Rust sidecar | Node — **no Python, no GPU** |
| **Serve the ML pipeline locally, Python-free** | the Rust sidecar (`serving/sidecar/`) | a Rust toolchain + the [ONNX models](#onnx-models) |
| **Run the reference Python server** | `serving.local.server` | Python 3.10 + NVIDIA CUDA 12.x + a torch checkpoint |
| **One-shot CLI colorize** | `colorize/scripts/infer_local.py` | Python 3.10 + NVIDIA CUDA 12.x + a checkpoint |
| **Deploy hosted GPU endpoints** | Modal (`serving/modal/`) | Python + a Modal account |
| **Export ONNX / run parity** | `serving/onnx/` | Python 3.10 + CUDA (dumps need a checkpoint) |

Only the **Python paths** (the bottom four rows) use the CUDA environment in
[Installation](#installation-python-paths) below — the desktop app and the Rust
sidecar have their own, lighter prerequisites. To just try the UI, jump to
[the desktop app](#the-desktop-app-no-python); for local ML without Python, see
[the Rust sidecar](#python-free-local-serving-the-rust-sidecar).

---

## Installation (Python paths)

The reference Python server, the CLI inference script, the Modal deployments,
and the ONNX export/parity tooling share one environment: **Python 3.10** and an
**NVIDIA GPU with CUDA 12.x** (the model and segmentation code depend on
`torch_scatter`, `cupy`, and `cucim`, which are GPU-only). CPU-only execution of
the Python stack is not currently supported. The desktop app (Node) and the Rust
sidecar have their own prerequisites — see [Ways to run this](#ways-to-run-this).

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

## ONNX models

Local processing runs two neural nets: the **AnT v2 colorizer** (`/colorize`)
and the **GapCloser** UDF net (`/segment` AI gap closing). Each ships one
**universal fp32 model** that runs under any execution provider — including
plain CPU — plus optional **per-platform fast-path variants** that carry the
*same weights* but restructure the graph for one accelerator:

| File | Size | Role | Platform | Required |
|---|---|---|---|---|
| `ant_v2_fp32.onnx` | 1.4 GB | AnT v2 colorizer, dynamic shapes — the universal workhorse (every EP, incl. CPU) | all | **yes** |
| `ant_v2_fp32_bucket.onnx` | 1.4 GB | Colorizer with bucket-pinned static shapes — the CoreML fast path | macOS | optional |
| `ant_v2_fp32_tiledscatter.onnx` | 1.4 GB | Colorizer with scatter-add rewritten as tiled MatMul — the DirectML fast path | Windows | optional |
| `gap_closer_fp32.onnx` | 498 MB | GapCloser fp32 — the parity anchor + universal CPU path | all | **yes** |
| `gap_closer_fp32_bucket.onnx` | 498 MB | GapCloser with the tile batch pinned to 24 — the CoreML fast path | macOS | optional |
| `gap_closer_fp16.onnx` | 249 MB | GapCloser fp16 (`keep_io_types`) — the DirectML fast path | Windows | optional |

Why the variants exist — each is a workaround for one accelerator, not a
different model:

- **Bucket-pinned** (`*_bucket`): CoreML compiles only static shapes, so the
  colorizer's shapes are frozen to a corpus-sized bucket and the gap-closer's
  tile batch is pinned to 24. Feeds larger than the bucket fall back to the
  dynamic model.
- **Tiled-scatter** (colorizer, Windows): DirectML has no scatter-add kernel, so
  on the stock model those ops fall back to CPU and force ~1 GB of PCIe copies
  per forward (~95% of the DML wall-clock). The tiled MatMul rewrite is fully
  DML-native and argmax-exact — ~5.7× faster.
- **fp16** (gap-closer, Windows): fp32 batch-24 OOMs a 16 GB WDDM card; the fp16
  export keeps float32 I/O (`keep_io_types`) so the sidecar feeds it identically
  to the fp32 path.

Because the variants only ever *speed up* an accelerator, the two universal
fp32 models are the only **required** downloads — the sidecar falls back to them
whenever a variant is absent or the accelerator is unavailable, so nothing
hard-depends on GPU acceleration. Same weights means argmax/boundary parity
holds across all of them; the fp16 gap-closer is the sole lossy export, and it
is boundary-safe (10 flips in 10.5 M pixels, which the trapped-ball segmentation
downstream absorbs).

The app downloads these from the `models-v1` GitHub release into its models
directory, verifying size + sha256. **`app/src/util/model-manifest.js` is the
single source of truth** for filenames, sizes, and hashes; the exports are
produced by `serving/onnx/` (`export_ant_v2.py`, `export_gap_closer.py`,
`scatter_to_tiled.py`). See [`docs/colorizer-serving.md`](docs/colorizer-serving.md)
and [`docs/gap-closer-serving.md`](docs/gap-closer-serving.md) for export
details, EP workarounds, and measured timings.

---

## Running locally

### The desktop app (no Python)

The Electron + Vue app is self-contained: drawing, timeline, and `.cdm`
save/load/export all work with **no backend and no Python**. Only the ML
features (analyze/colorize/paint-bucket) need a serving backend, and that can be
either a hosted URL or the bundled Rust sidecar — chosen at runtime in the
in-app Server Settings dialog.

```bash
cd app
npm install
env -u ELECTRON_RUN_AS_NODE npm run electron:serve
```

See [`app/README.md`](app/README.md) for the dev-serve gotchas (the
`ELECTRON_RUN_AS_NODE` unset is load-bearing) and [`docs/app.md`](docs/app.md)
for the architecture. No step below is required just to run the app.

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
calls the desktop app makes (see `app/src/util/server-client.js`); the
licensing/proxy fields the app sends (`user_id`, `license_key`, …) are simply
ignored here.

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

# optional accelerator fast paths (see "ONNX models" above); --ep auto picks
# the accelerator when its variant is supplied, else stays on CPU:
#   macOS   --ant-model-bucket ant_v2_fp32_bucket.onnx \
#           --gap-model-bucket gap_closer_fp32_bucket.onnx
#   Windows --ant-model-tiled  ant_v2_fp32_tiledscatter.onnx \
#           --gap-model-bucket gap_closer_fp16.onnx
```

See [ONNX models](#onnx-models), `serving/README.md`, and
`docs/colorizer-serving.md`.

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

[Apache License 2.0](LICENSE). Vendored code under `third_party/`
(visioncortex, vtracer forks) retains its original licenses — see the
LICENSE files in those directories.
