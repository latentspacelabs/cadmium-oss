# cadmium-sidecar

Rust embedded serving backend (`docs/serving-backends.md` §4.3). It speaks the
exact HTTP contract of the Python server (`serving/local/server.py`), so the
app and the e2e ML specs can point at it with nothing but a base-URL change.
All three ML endpoints are implemented over the byte-exact classical ports
under `src/` plus ONNX Runtime sessions for the two models, and are gated by
HTTP-level goldens recorded from the production CUDA server
(`tools/dump_http_goldens.py` → `verify_http`).

## Build

Requires a Rust toolchain (rustup; tested with Rust 1.97.1 on macOS arm64).

```sh
cd sidecar
cargo build            # or --release
```

The `ort` crate (pyke ONNX Runtime bindings, pinned `2.0.0-rc.12`) downloads
prebuilt ONNX Runtime binaries for the host target at build time via its
default `download-binaries` feature — no system ONNX Runtime install needed.

## Run

```sh
cargo run --release -- --port 8001 \
    --ant-model /path/to/ant_v2_fp32.onnx \
    --gap-model /path/to/gap_closer_fp32.onnx
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `8001` | Port to listen on |
| `--host` | `127.0.0.1` | Interface to bind |
| `--ant-model <PATH.onnx>` | — | AnT v2 colorizer graph, dynamic shapes (required for `/colorize`) |
| `--ant-model-bucket <PATH.onnx>` | — | CORPUS_BUCKET-pinned AnT v2 export (all input dims static); enables the CoreML fast path |
| `--ep <auto\|cpu\|coreml\|dml>` | `auto` | Execution provider for the AnT forward (see below); `auto` → `coreml` on macOS when `--ant-model-bucket` is supplied, else `cpu` |
| `--gap-model <PATH.onnx>` | — | GapCloser UDF net (enables ML gap closing on `/segment`; without it `/segment` runs trapped-ball only, like the Python server with no `--gap-close-checkpoint`) |

Sessions are built **lazily on first use**, so `/health`, `/preprocess` and
strength-0 `/segment` work without any model files.

Logging: `RUST_LOG` (tracing env-filter syntax). Default is
`info,ort::logging=warn` — ONNX Runtime's internal logger is very chatty at
info level.

Smoke check:

```sh
curl -s http://127.0.0.1:8001/health
# {"status":"ok","engine":"sidecar-rust","version":"0.1.0","gap_closer":true}
```

## Contract status

Semantics mirror the framework-free Python handlers in `serving/handlers/`
(shared by the local FastAPI server and the Modal stubs).

| Route | Python handler | Status |
|---|---|---|
| `GET /health` | `serving/local/server.py` | Implemented (`engine: "sidecar-rust"` + crate version + `gap_closer` boolean) |
| `POST /segment` | `serving/handlers/segment.py` | Implemented — empty-alpha short-circuit, trapped-ball-only (strength ≤ 0 or no gap model), and the tiled ONNX gap-close path |
| `POST /preprocess` | `serving/handlers/preprocess.py` | Implemented — `compute_color_list` + filled render (PIL encoder) |
| `POST /colorize` | `serving/handlers/colorize.py` | Implemented — full AnT v2 chain (prepare_image → vtracer → tokenize → ONNX → postprocess with full-res renders) |
| `POST /predict` | alias of `/colorize` (back-compat, kept from the Python server) | Implemented |

Contract notes carried into the types (see `src/serve/contract.rs` for the
rest):

- All images are base64 PNG data-URI strings. `/preprocess` inputs are
  **URL-safe** base64 (accepting standard-alphabet input too, exactly like
  Python's `urlsafe_b64decode`); `/segment` and `/colorize` use standard
  base64.
- Channel order is load-bearing: `/segment` + `/colorize` decode through cv2
  semantics (color arrays are B,G,R,A end to end; response renders re-encode
  through cv2 and are therefore stored R/B-swapped), while `/preprocess`
  decodes and encodes through PIL semantics (RGBA preserved). See
  `src/serve/codec.rs`.
- Requests prefer an ordered `references` list; legacy flat `ref_*` fields are
  still accepted. Only the first reference is used today.
- The local server injects `return_colorized: true` into `/colorize` and
  `/predict` when the field is absent (the app omits it); the sidecar
  preserves that default-on behavior.
- `colorized_seg_map_uri` uses an unseeded-random colormap in production; the
  sidecar substitutes a deterministic colormap (the field is compare-skipped
  in the golden contract).
- Unknown request fields are accepted and ignored (Python `**kwargs` ≡ serde
  default).

## Verification

`verify_http` replays every golden request against the router in-process and
diffs responses field-for-field (image URIs by decoded pixels + channel
count; everything else exactly):

```sh
cargo run --release --bin verify_http -- <http_goldens_root> \
    --ant-model <ant_v2.onnx> --gap-model <gap_closer.onnx> \
    [--ep auto|cpu|coreml|dml] [--ant-model-bucket <ant_v2_bucket.onnx>]
```

`--ep`/`--ant-model-bucket` pass straight through to the engine, so the same
36-step matrix gates every execution provider — run it once with `--ep cpu`
and once with `--ep coreml` on macOS.

The per-stage verify bins (`verify_segment`, `verify_gapclose`,
`verify_imageprep`, `verify_tokenize`, `verify_postprocess`) gate the
underlying ports against the production per-stage goldens. `verify_tokenize`
additionally checks the `pad_feed_to_bucket` port when given
`--robot-feeds <dir>` (parity_corpus.py `--bucket-test` dumps with
`feed_*`/`bucket_feed_*` arrays): the `bucket` column must be byte-exact.

## Execution providers

EP selection applies to the AnT `/colorize` forward and (on macOS, when
`--gap-model-bucket` is supplied) the GapCloser `/segment` forward:

- `cpu` — dynamic models, CPU EP. The golden-gate baseline.
- `coreml` (macOS) — the CORPUS_BUCKET-pinned AnT model (`--ant-model-bucket`,
  slots 256 / rows 64 / cmds 256 / flat 8192 / length 512) on the CoreML EP,
  MLProgram format, compute units ALL. Every feed is bucket-padded
  (`src/tokenize/bucket.rs`) so ONE static shape → ONE CoreML compile serves
  the whole corpus; a feed that exceeds the bucket falls back to a
  lazily-built dynamic CPU session (logged). Padded tokens sit after the real
  prefix and are masked, so outputs are bit-comparable to the unpadded run.
- `dml` (Windows) — the dynamic model on DirectML + CPU fallback (DML handles
  dynamic shapes; no bucket model needed), mirroring
  `serving/onnx/parity_replay.py --dml`. Compiled only for Windows targets;
  other platforms get a stub error. Unverified until the Windows evaluation.
- `auto` (default) — `coreml` on macOS when `--ant-model-bucket` is supplied,
  else `cpu`; `dml` stays opt-in.

The EP registration hooks are per-target cargo features on `ort`
(`coreml` on macOS, `directml` on Windows — see `Cargo.toml`); the pyke
prebuilt ONNX Runtime binaries already contain both providers. CUDA
(win/linux) comes with the R4 packaging.
