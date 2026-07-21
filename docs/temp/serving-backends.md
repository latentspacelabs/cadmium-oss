# Serving backends: self-hosted, Modal, embedded

*Status: PROPOSED 2026-07-19. Companion to `docs/architecture.md` (app side).*

## 1. Goal

Offer three ways to run the ML pipeline, selectable at runtime from the app:

| Backend | Who runs it | GPU | For whom |
|---|---|---|---|
| **Self-hosted** | User, on any machine they can reach (port-forward, LAN, tailnet) | Their own (CUDA) | Today's workflow; power users |
| **Modal** | Cloud, serverless | A10G (rented) | Users with no GPU who accept cloud |
| **Embedded** | The app itself, as a managed local process | User's NVIDIA GPU | Users with a gaming/workstation GPU who want zero setup |

## 2. What exists today (inventory)

**One HTTP contract, three ops.** `serving/handlers/` is the framework-free
core; both the local FastAPI server and the Modal stubs call the same
functions, so the contract cannot drift:

| Op | Route | ML content |
|---|---|---|
| `/segment` | gap closing + trapped-ball | **GapCloser UNet** (torch, batched crops) + classical cv2 (trapped-ball, morphology, flood fill) |
| `/preprocess` | palette extraction + filled render | **No model** — pure numpy/PIL |
| `/colorize` | reference-guided colorization | **AnT v2** (AnT v1 encoders + torch_scatter pooling + Llama decoder + lm_head) wrapped in heavy classical pre/post (tokenizer, `vtracer` vectorization, palette matching) |

**Client seam already exists.** `app/src/util/server-config.js` resolves a
single base URL (pref → `VUE_APP_SERVER_URL` → `localhost:8000`), and
`getColorizeUrl()/getSegmentUrl()/getPreprocessUrl()` already support
*per-endpoint* overrides — but only via build-time env vars. All HTTP goes
through `app/src/util/modal.js` (axios). The Server Settings dialog writes one
`serverUrl` pref.

**Deployment reality** (wallace): colorizer checkpoint dir 3.6 GB, GapCloser
`.ckpt` 1.4 GB (both carry training state; inference weights are a fraction of
this), served by one FastAPI process on a 3090.

## 3. Core design decision

**Every backend presents the exact same HTTP contract.** A "backend" is not an
abstraction over inference — it is an answer to two questions: *what URLs do
the three ops live at*, and *who manages the process lifecycle*. This keeps
the entire pipeline logic (client and server) backend-agnostic and means the
e2e suite runs identically against all three.

The single `serverUrl` string pref becomes a **backend descriptor**:

```js
// persisted in user preferences
serverBackend: {
  kind: 'self-hosted' | 'modal' | 'embedded',
  // self-hosted: one base URL (ops are paths on it)
  baseUrl: 'http://localhost:8000',
  // modal: per-op endpoint URLs (Modal deploys one web endpoint per op)
  urls: { colorize: '…', segment: '…', preprocess: '…' },
  // embedded: nothing — the app owns the port
}
```

`server-config.js` keeps its three getters; only their resolution changes.
Nothing else in the client pipeline is touched.

## 4. Backend profiles

### 4.1 Self-hosted (exists — formalize)

What's missing is ergonomics, not capability:
- Backend picker in Server Settings with a **health check** (`GET /health`
  already exists) and a visible connected/unreachable state — today's failure
  mode is the "No Internet Connection" dialog spam when a tunnel dies.
- Per-endpoint URL overrides move from build-time env to the descriptor
  (runtime), so one binary can point anywhere.

### 4.2 Modal (exists server-side — wire up the client)

The stubs (`serving/modal/*`) already deploy with GPU snapshots and
`scaledown_window=300`. Client work:
- The descriptor's per-op `urls` (each Modal function gets its own
  `…modal.run` hostname). No proxy — the app calls Modal directly.
- **Cold-start UX**: after 5 min idle the first request pays a cold start
  (snapshots make it seconds, not minutes, but it's visible). The waiting
  screen should show "waking server…" when a request exceeds a threshold
  rather than looking hung. The measured-throughput estimate (2026-07-19)
  self-corrects once frames start landing.
- **Auth (decide before shipping)**: bare `fastapi_endpoint` URLs are
  public-but-unguessable. Modal proxy-auth tokens are the supported story —
  the descriptor gets an optional `{tokenId, tokenSecret}`, sent as headers.

### 4.3 Embedded (new — the meat)

**Endgame (DECIDED 2026-07-19): no Python at runtime at all.** The nets run
under ONNX Runtime; the classical surface (trapped-ball, vectorization,
tokenizer, palette matching) gets converted to libraries loadable from Node —
most plausibly Rust compiled to a native addon and/or WASM (`vtracer` is
already Rust, so vectorization is the easy one; trapped-ball's cv2 morphology
and the tokenizer are the real ports). That conversion is explicitly LATER:
the ONNX parity work is the critical path and proceeds first, with the
classical code still exercised from Python by the parity harness. Until the
ports land, the intermediate embedded shape remains a sidecar process serving
the same HTTP contract; once they land, the "backend" collapses into
in-process calls and the contract survives as an internal interface.

Two packaging variants were considered (C1 kept here for the record — see the
DECIDED note below; the spike removed its reason to exist):

| | C1: torch sidecar (dropped) | C2: ONNX sidecar (target) |
|---|---|---|
| Engine | today's torch CUDA stack | **onnxruntime-gpu** (CUDA EP) |
| Code changes | none (PyInstaller wrapper) | export nets; pipeline pre/post moves to numpy |
| Download size | ~4–5 GB (torch+CUDA+weights w/ training state) | ~1.5–2 GB (ORT+CUDA libs+fp16 weights) |
| Cold start | slow (torch import + ckpt load) | fast |
| Risk | none (it's the proven stack) | export/parity work (see §5) |

**DECIDED 2026-07-19: C2 directly; C1 is dropped.** PyInstaller-packaging the
full torch stack is its own tar pit, and the §5 spike retired C2's one real
unknown (`torch_scatter` export) same-day — so there is nothing left for C1
to de-risk that's worth its packaging pain. The sidecar lifecycle/download
plumbing gets validated with the ONNX payload instead.

Sidecar lifecycle (Electron main process):
- Spawn on first use of the embedded backend (not app launch); free-port
  allocation; kill on app quit; auto-restart with backoff on crash; ready =
  `/health` 200. Logs to `userData/serving/logs/`.
- GPU probe before first spawn (`nvidia-smi` presence/VRAM) with a clear
  "needs an NVIDIA GPU (≥ N GB VRAM)" message otherwise. CPU EP fallback is a
  later option (works, slow — maybe acceptable for `/segment` only).
- Platform matrix (same ONNX artifacts everywhere, only the EP differs):
  Windows/Linux + NVIDIA → CUDA EP; **macOS arm64 → CoreML EP** (spiked GO,
  see §5 "Apple silicon" — fp32 AnT via the Metal GPU beats the unoptimized
  3090 numbers, and the mac payload skips the CUDA libs entirely); no
  qualifying GPU → CPU EP is genuinely usable for `/colorize` (~0.7 s) but
  not `/segment` (~20 s/batch).

## 5. The ONNX plan (C2 internals)

**Spike verdict (RUN 2026-07-19, `serving/onnx/spike_scatter_export.py`, on
wallace / RTX 3090 / torch 2.6 / ORT 1.22): the `torch_scatter` op is NOT a
blocker — C2 is GO, and C1 (PyInstaller torch sidecar) is dropped from the
plan.** Findings, in blocker → resolution form:

1. `torch_scatter.scatter(reduce='mean')` → replaced by a ~10-line native
   implementation (`scatter_add` sums + counts, exact same padding/empty-
   segment semantics). **Bit-identical to torch_scatter** on all trials, and
   `scatter_add` exports as ONNX `ScatterElements(reduction='add')` (opset 18)
   with working dynamic axes. No monkey-patching of the exporter needed — the
   model code just swaps the import.
2. `compute_sdf_cupy` (CuPy, inside `forward`) → the SDF becomes a graph
   INPUT, computed by pipeline pre (the CPU numpy version already exists in
   the codebase).
3. `TF.resize(NEAREST_EXACT)` on the seg map (no ONNX symbolic in torch 2.6)
   → the seg-map downscale moves to pipeline pre too; its target size is
   deterministic from the UNet stride, so parity is exact by construction.

Full-stack proof: a UNet+pool module shaped like the real
`PooledImageEncoder` exports and matches torch on ORT-CPU to **9e-06** with
dynamic input resolutions. One tolerance-policy note: the CUDA EP differs
from CPU by ~3e-03 (TF32/conv-algorithm variance, not graph error) — golden
tests must compare **palette-id argmax** stability, with logits under a
loose (~2e-2) noise budget.

**S3 status (RUN 2026-07-19, wallace RTX 3090): both models exported and
parity-verified under onnxruntime.**

- **GapCloser** (`serving/onnx/export_gap_closer.py`): ClassicUNet (124.4M
  params) → fp32 498 MB / fp16 249 MB. ORT-CPU exact (2.6e-06, 100% boundary
  agreement); CUDA EP 99.99% boundary agreement (threshold-adjacent pixels
  under TF32 noise); 24-tile batch: 443 ms fp32 / 256 ms fp16.
- **AnT v2** (`serving/onnx/export_ant_v2.py`): the FULL model — image
  encoder + SVG encoder + embeddings + Llama decoder + lm_head — as one
  graph, 1.39 GB fp32 / 695 MB fp16. Three-stage parity on real
  trapped-ball-segmented fixtures: eager restructured wrapper reproduces the
  production GPU/bf16 forward's color-id argmax exactly (logit delta 2.4e-02
  = bf16 noise); ORT-CPU 7.9e-04 / ORT-CUDA 1.0e-03 vs the wrapper, both
  **100% argmax agreement**; CUDA forward 487 ms (unoptimized; 2 Memcpy
  nodes flagged).
- Two more restructurings joined the §5 list during the build (both
  index-tensor tricks, no weight changes): `_pack_inputs`' boolean packing →
  `index_select` with pre-computed gather indices (RoPE-position-exact), and
  the SVG encoder's mask filtering/`unpack_sequences` → valid-rows-only
  inputs + masked command-mean + scatter into the slot grid.
- **AnT v2 fp16 (naive conversion): REJECTED.** `convert_float_to_float16`
  halves the file (695 MB) and argmax held on the fixture, but the logit
  delta grows to **1.2** (vs 1e-03 fp32) AND the forward takes **238 s** —
  ~500× slower than fp32, i.e. the converted graph mostly falls off the CUDA
  EP onto emulated-fp16 CPU paths. fp16 for AnT v2 needs a real mixed-
  precision pass (op_block_list, node-assignment audit) if the ~700 MB saving
  ever matters; **fp32 (1.39 GB, 487 ms) is the shipping default.**
  GapCloser's fp16 is unaffected (plain convs: 249 MB, faster, 99.99%
  agreement — ship that one).
- Caveats an honest reading requires: fixtures are small (3 ref + 3 target
  segments) — the golden corpus needs real production drawings; Memcpy/session
  tuning not attempted. (Corpus DONE next bullet-group; tuning still open.)

**Golden corpus (RUN 2026-07-19, robot.cdm, wallace RTX 3090):
`serving/onnx/parity_corpus.py` — 11 real ref→target pairs (23 ref + 17–24
target segments each, 1024×1024 tokenized, 7-color palette), production
GPU/bf16 forward vs the exported ONNX. Final result: 100% color-id argmax on
ALL pairs, max logit delta 0.2 (mostly ≤0.06 = bf16 noise).** Getting there
caught two REAL export bugs the synthetic fixtures could not see — exactly
what the corpus was for:

1. **SVG packing is not one-segment-per-row.** Production's `pack_sequences`
   greedily packs multiple segments' command runs into shared rows
   (block-diagonal attention isolates them) and `unpack_sequences`
   redistributes per-COMMAND features back to slots by order. The original
   wrapper treated each packed row as one segment — true for the fixture by
   coincidence (3 rows / 3 segments), assert-fail on robot.cdm (12 rows / 23
   segments). Fix: three precomputed index tensors (valid-command positions
   in the flat packed layout, destination slot per command, per-slot counts)
   + gather / scatter-add in the graph. Also: the command dim is the
   tokenizer's per-input max (14 fixture, 89 robot) — now a dynamic axis.
2. **The SDF replica missed cucim's degenerate case — which REAL drawings hit
   almost always.** Canvas-exported PNGs keep white rgb under transparent
   alpha, so the tokenizer's resize lifts every stroke pixel above 0 and the
   SDF binarization (`rgb.min > 0`) yields all-True. cucim's PBA then returns
   `32768 + y` (distance to a sentinel row above the image), i.e. after
   global min-max normalization a VERTICAL RAMP — that ramp is what the
   production model was trained on and sees in production. scipy returns
   different junk for the same input, which silently shifted logits by up to
   2.2 and flipped up to 16% of color ids per frame. Fix: replicate the ramp
   explicitly (non-degenerate masks: scipy == cucim to 1.5e-6, verified).
   The bf16-probe methodology that localized this is in parity_corpus.py
   (`--bf16-probe`: eager wrapper under autocast — when its argmax matches
   ORT but not production, the drift is in a replicated input, not precision).

`--dump` writes per-pair .npz bundles (all 20 graph inputs + production
logits/ids); `serving/onnx/parity_replay.py` re-verifies them on any machine
with no CUDA/checkpoint/pipeline — this is the parity gate for the macOS
CoreML EP and future CI. Corpus extraction from any .cdm:
`tools/extract_cdm_images.py`.

**Apple silicon (RUN 2026-07-19, M3 Max / macOS 26.5 / ORT 1.27,
`serving/onnx/spike_coreml_apple.py`): GO — the SAME ONNX artifacts run
under ORT's CoreML EP; no MLX and no re-export.** MLX was considered and is
the wrong tool for the stated goal: it targets the Metal *GPU* only — the
Neural Engine is reachable exclusively through Core ML — and it would mean
reimplementing both models by hand. Numbers (synthetic feeds; argmax parity
on real drawings is the golden corpus's job):

- **AnT v2 fp32: CoreML/GPU 127–136 ms/forward, 100% argmax vs CPU EP** —
  faster than the unoptimized 3090 CUDA figure (487 ms). Plain CPU EP is
  684 ms, a perfectly usable no-GPU fallback for `/colorize`.
- **GapCloser, 24-tile batch: CoreML fp32/GPU 1.26 s** (max diff 2e-06),
  fp16+ANE 802 ms (boundary agreement 99.6–99.9% on worst-case noise tiles;
  its UDF saturates ~0.52 but only far from the boundary), fp16/GPU 1.12 s
  (99.97%+). CPU EP is ~20 s/batch — the mac backend needs CoreML for
  `/segment`, full stop.
- The ANE is NOT the win on Max-class chips: fp32 never runs on it, the full
  AnT graph fails ANE compilation (`ANECCompile` error; "ALL" silently lands
  on the GPU), and even the forced-ANE blocked-fp16 run (191 ms, 100% argmax)
  loses to the GPU (112 ms). It may still matter on base M-chips / low-power
  — measure there before caring.
- Three mechanical workarounds, all in the spike script: (1) CoreML requires
  **static shapes** — the dynamic-dim graphs fail to compile (rank-0 squeeze
  from shape arithmetic); pinning input dims post-hoc on the .onnx suffices,
  so production needs shape buckets / pad-to-bucket, which CoreML wants
  anyway; (2) the naive fp16 AnT conversion **cannot run at all** here (fp16
  `ScatterElements` rejected by both the CoreML partitioner and the CPU EP) —
  re-convert with `op_block_list=[..., "ScatterElements"]`, after which
  CoreML/GPU runs it at 112 ms but with fp16-class logit noise (0.31; 95.8%
  argmax on the synthetic feed), so **mac ships fp32 too**; (3) ORT 1.27's
  `SimplifiedLayerNormFusion` crashes at session init on fp16 llama graphs —
  `ORT_ENABLE_BASIC` dodges it.

**Golden-corpus replay on the M3 Max (RUN 2026-07-19,
`parity_replay.py --coreml ALL` on the robot.cdm feed bundles): 11/11 pairs
at 100% color-id argmax vs the production GPU/bf16 reference — on BOTH the
CPU EP and the CoreML EP.** The macOS backend is verified end-to-end on real
drawings, same artifact as the CUDA backend. Operational findings: CPU EP at
production resolution (1024×1024) is ~3.7 s/forward — an acceptable no-GPU
fallback for `/colorize`; partial pinning of only the image dims does not
build, so production pads segment/command/row dims to fixed buckets.
UPDATE (same day, R3): with the mask-input graph FULLY pinned to one bucket
the CoreML compile is only **1.7 s** (the ~100 s seen in the first replay
was the per-pair-pinning path, not inherent) and inference is ~750 ms at
1024×1024 vs ~4 s CPU EP; bucketed replay = 11/11 pairs 100% argmax through
a single session. Bucketing is the strategy, and it is cheap.

What exports vs. what stays Python:

- **GapCloser UNet** (`segmentation/gap_closing/unet.py`, plain UNet): trivial
  export, static input crops, dynamic batch dim. The 1.4 GB `.ckpt` is
  training state; the exported fp16 graph should be tens of MB.
- **AnT v2 model** (`AnTV2Model.forward`): Llama decoder via HF's well-trodden
  export path; the custom bits are the embeddings/fusion MLP (trivial) and
  AnT v1's image encoder with **`torch_scatter` super-pixel pooling** — the
  one genuinely risky op. It maps to ONNX `ScatterElements`/segment-sum;
  verify first (it is the go/no-go spike for C2). Dynamic axes: segment
  count, vector-token sequence length. bf16 → fp16 (verify no palette-logit
  flips on goldens; fp32 fallback if needed).
- **Classical surface** (originally "stays Python in the sidecar"; superseded
  by the §4.3 endgame decision): trapped-ball, `vtracer` vectorization,
  tokenizer, palette matching, image prep, all base64/PNG plumbing —
  everything `serving/handlers/` orchestrates — gets ported to the Rust
  sidecar (§8 R-phases). `vtracer` is already Rust; the rest ports against
  per-stage goldens dumped from the Python pipeline on the robot corpus.

**Parity harness before anything ships**: golden fixtures (line frames + refs
→ recorded torch outputs: seg maps byte-exact where deterministic, palette ids
exact, logits within tolerance) run in CI against the ORT sidecar. The e2e
suite's ML specs then run against the sidecar as the third backend — same
specs, different descriptor.

## 6. Distribution

The sidecar is **not** baked into the installer (it would 10× the download for
a feature many users won't use). Instead:
- The app ships a small manifest (versioned URL + sha256 per platform).
- First selection of the embedded backend triggers a resumable download to
  `userData/serving/<version>/`, hash-checked, then unpacked. UI shows
  progress; the backend stays unselectable until ready.
- Weights version independently from the binary (a new checkpoint is a
  manifest bump, not an app release).
- Platforms: win-x64 (CUDA EP) and macOS arm64 (CoreML EP) are BOTH
  first-class targets (mac verified 2026-07-19 on the robot corpus);
  linux-x64 CUDA falls out of the win work nearly for free.

## 7. Client changes (small, mostly UI)

1. `server-config.js`: resolve from the `serverBackend` descriptor (legacy
   `serverUrl` pref migrates to `{kind:'self-hosted', baseUrl}`).
2. Server Settings dialog → backend picker: three options with per-kind
   fields (base URL / three Modal URLs + token / embedded status+download
   button), a Test button hitting `/health`, and a live status dot.
3. Main-process sidecar manager (spawn/health/kill/logs) + IPC status events.
4. e2e: the suite already drives everything through the store; add a
   `CADMIUM_E2E_BACKEND` knob that swaps the descriptor so the ML specs run
   against any backend.

## 8. Phasing → remaining work to the shipping goal

Goal (restated 2026-07-19): downloadable win/mac binaries; user picks
**hosted server URL** or **local processing** (win: CUDA via ONNX; mac:
CoreML); **no Python runtime in the app**.

Done: S2 spike, S3 exports + parity, Apple-silicon verdict, golden corpus +
replay gate (all recorded in §5). What remains, in dependency order:

| Phase | Deliverable | Notes / acceptance |
|---|---|---|
| S1 | Backend descriptor + settings UI + health checks (hosted URL now, "local" appears when R4 lands) | switch at runtime, no rebuild; e2e ML specs pass via `CADMIUM_E2E_BACKEND` |
| R1 | **Rust sidecar skeleton**: axum server speaking the EXACT existing contract + `ort` crate sessions (CUDA/CoreML/CPU EPs) | unblocks all ports; e2e ML specs are the contract test |
| R2 | **Classical ports, each gated by per-stage goldens** dumped from the Python pipeline on the robot corpus: (a) ~~trapped-ball~~ **DONE 2026-07-20**: goldens via `serving/tools/dump_segment_goldens.py` (12 drawings × 8 stages, replay-asserted against `compute_seg_fast`), Rust port in `sidecar/src/segment/` — binarize + trapped-ball + floodfill + merge + thinning with cv2-4.11 semantics ported from OpenCV source (findContours/approxPolyDP/arcLength line-by-line, Apache-2.0 attributed), `verify_segment` byte-exact 12/12 × 8/8, 0.24–0.33 s/drawing (~8× Python); (b) ~~GapCloser tiling/UDF pre+post~~ **DONE 2026-07-20**: goldens via `serving/tools/dump_gapcloser_goldens.py` (12 drawings × 13 stages incl. the tiled trapped-ball + scipy-CC merge, replay-asserted against `GapCloser.predict`), Rust port in `sidecar/src/segment/{tiler,cropping,tiled}.rs` (tiler-0.5.7 + cropping + parallel.py semantics, per-tile seg reuses (a)), `verify_gapclose` byte-exact 12/12 × 13/13, 0.12–0.26 s/drawing; **ONNX-vs-torch check: the fp32 ONNX gap closer's thresholded boundaries are pixel-identical to production torch-CUDA on all 12 drawings (0 flips)** — the classical /segment path is now fully portable, both toggle states; (c) ~~vtracer~~ **DONE 2026-07-20**: the production vectorizer is the private `latentspacelabs/vtracer` fork (+ forked `visioncortex`), now `third_party/` submodules. Its `opencv` crate dep was DEAD CODE (an import with zero call sites — it forced the whole OpenCV-from-source build); removed, `visioncortex` path dep made relative. Byte-parity vs the production python wheel on all 12 robot seg maps: 12/12 on Linux x86-64; macOS arm64 shows a ±1 quantized spline control point on 2/12 (cross-platform libm rounding in spline fitting — vectorization always runs on the SAME machine as the model, so per-platform self-consistency is what matters; keep goldens per-platform); (d) ~~tokenizer + feed building~~ **DONE 2026-07-20**: goldens via `serving/tools/dump_tokenizer_goldens.py` (11 pairs, stages anchored byte-identical to the parity bundles), Rust port in `sidecar/src/tokenize/` (SVG d-string parse incl. dropped-Z and translate quirks, pack_sequences, palette + mask_null_color_ids, svg_pre/build_feed index tensors AND the image-side build_feed transforms: line f32 cast, sdf_like_cupy EDT+ramp, NEAREST_EXACT lowres), `verify_tokenize` 11/11 × 6/6 byte-exact, all 22 ONNX feed arrays covered; (e) ~~image prep + compute_color_list~~ **DONE 2026-07-20**: goldens via `serving/tools/dump_imageprep_goldens.py` (13 dirs incl. ref-style color path), Rust port in `sidecar/src/imageprep/` — the feared resample risk evaporated (production resize is scipy-ndimage-zoom NEAREST, ported bitwise from NI_ZoomShift; no bilinear anywhere), Pillow≥10 alpha-only getbbox, id-map machinery, compute_color_list (kurtosis-peakiness gate incl. numpy pairwise summation); vectorization via the vendored vtracer crate; `verify_imageprep` **13/13 × 14 byte-exact on Linux incl. SVG strings**; macOS drifts ONLY in the vtracer SVG column (3 numeric ±1, 5 ulp-level spline-subdivision flips — platform libm, same build byte-exact on Linux; per-platform self-consistency is the contract); (f) ~~post~~ **DONE 2026-07-20**: goldens via `serving/tools/dump_postprocess_goldens.py` (production logits from the parity bundles through unmodified postprocess), Rust port in `sidecar/src/postprocess/` — id clamp, palette colors, normalized-entropy confidence reproduced **bitwise vs production torch-2.6-CPU** (scalar SLEEF exp/log ports, torch sum-kernel interleave, MKL-VML ln bits table), full-res renders pixel-exact incl. the dense −100 → (156,255,255,255) quirk; `verify_postprocess` 11/11 × 7/7. NOTE: production wallace runs torch 2.6.0+cu126, NOT the repo-pinned 2.4.1 (also Pillow ≥10 vs the 9.1.1 pin — see (e)); **(g) ASSEMBLY DONE 2026-07-20 — R2 COMPLETE**: real /segment /preprocess /colorize handlers in `sidecar/src/serve/` (lazy ort CPU-EP sessions, cv2/PIL codec fidelity incl. R/B-swapped response encoders and urlsafe-accepts-standard base64), gated by `serving/tools/dump_http_goldens.py` — 36 request/response pairs recorded from the production server, `verify_http` replays them in-process: **36/36 green, colorize ids/colors/renders EXACT on all 11 pairs** (min argmax margin 0.019). macOS CPU-EP timings: segment 0.28 s, gap-close 2.6 s, preprocess 35 ms, colorize ~4.9 s (4.6 s = AnT forward; CoreML ~0.75 s and DML are the R3/R6 speedups to wire into `engine.rs` provider selection). The sidecar now serves the full python-free pipeline | ~~the long pole~~ DONE — remaining: EP selection wiring (R3/R6), packaging (R4) |
| R3 | ~~CoreML shape bucketing~~ **DONE 2026-07-19.** Export change landed: single `packed_gather_idx` over the concatenated slot axis + real `packed_attn_mask`; bucket pads sit at the END (RoPE positions of real tokens unchanged). `pad_feed_to_bucket()` pads all dynamic dims; corpus verified 100% argmax unpadded AND padded (wallace CUDA); mac replay through ONE bucket-pinned CoreML session: 11/11 pairs 100%, **compile 1.7 s** (the earlier ~100 s was the per-pair-pinning path, not inherent), inference ~750 ms at 1024×1024 vs ~4 s CPU EP. **SIDECAR WIRING DONE 2026-07-20**: `--ep auto|cpu|coreml|dml` + `--ant-model-bucket`; Rust `pad_feed_to_bucket` byte-exact vs the 11 `bucket_feed_*` golden bundles; verify_http 36/36 on BOTH cpu and coreml, colorize steady-state 1.85–2.1 s vs 4.6–4.9 s CPU. Caveat: ort rc.12 bundles ORT 1.24.2 → 42 CoreML partitions → **~106 s one-time session compile** (1.7 s figure was ORT 1.27); follow-ups: ort bump when ≥1.27 ships, CoreML ModelCacheDirectory to persist compiles across processes | done — verify_http --ep coreml is the ongoing gate |
| R4 | **Packaging**: win CUDA payload (ORT + cudart/cublas/cudnn subset; GPU/driver probe; CPU fallback), mac (notarized, signed sidecar, hardened runtime), §6 manifest download manager, §4.3 sidecar lifecycle in main | fresh machine: pick "local", download, colorize — zero terminal; cold start < 10 s |
| R5 | CI: parity_replay (CPU EP) + classical goldens as gates; e2e ML specs vs the sidecar on both platforms | regression gate for checkpoint/export changes |
| R6 | ~~DirectML evaluation~~ **DONE 2026-07-20 — verdict: DML is the Windows EP; no CUDA EP needed.** Rig: EC2 g4dn.xlarge (Tesla T4) Windows Server 2022, us-east-1, `i-0c6e21abac2b70e2f`, tag `cadmium-dml-rig`, AWS GRID driver 596.36 (WDDM → DX12/DML), onnxruntime-directml. Restart: `aws ec2 start-instances --region us-east-1 --instance-ids i-0c6e21abac2b70e2f` (STOPPED, not terminated — standing Windows rig; models + robot_feeds + parity_replay live in C:\dml). **AnT fp32 parity_replay --dml: 11/11 pairs 100% argmax, dynamic AND bucketed** (~6.0–6.3 s/forward steady-state vs 16–18 s on the box's 4-vCPU CPU EP). **GapCloser fp16 b24 (production tile batch): 719 ms on DML vs 255 s CPU-fp32-b24** (~355×); fp32-on-DML is unreliable on a 16 GB/WDDM box (system-commit OOM) — irrelevant, fp16 is the GPU config (follow-up for R5: run the 0-flip boundary check for fp16-DML like verify_gapclose --onnx did for fp32-CPU). NOTE the fp16 export has keep_io_types — feed FLOAT32. Ops gotchas hit: long single-stream transfers to the box die from any origin (use S3 presigned URLs), Windows Update (TiWorker) can exhaust the 16 GB box mid-bench (reboot first), PowerShell mangles native python stderr (invoke benches via `cmd /c ... 2>&1`). Modal backend wiring / VRAM-aware batching remain future options | done — DML wired in sidecar behind `--ep dml` (01133d8), untested-on-Windows build gate is an R5 item |

R6 DirectML logistics (DECIDED 2026-07-19): Modal is Linux-only — DML needs
Windows/DX12. Plan: EC2 `g4dn.xlarge` Windows (T4, ~$0.90/hr) as the
on-demand Windows rig — `parity_replay.py` needs only
`pip install onnxruntime-directml` + the .onnx + the robot feed bundles, so
the parity verdict is an afternoon; keep the instance STOPPED between
sessions (disk-only cost) since R4 needs a Windows machine anyway (CUDA EP,
installer, signing, e2e). If DML passes, a second pass on Azure NVv4 (AMD
GPUs — DML's actual value-add vs the CUDA EP) decides whether DML becomes
the win default with CUDA as the fast path. CI: GitHub Actions
`windows-latest` runs parity_replay on the CPU EP as the free permanent gate.

Open decisions: sidecar process vs Node native addon (**recommend sidecar**:
same HTTP contract → zero client-code change beyond spawn/health, crash
isolation, and the e2e suite tests it for free); CUDA-only vs CUDA+DML on
win; payload bundled vs downloaded (§6 says downloaded — keep).

## 9. Non-goals (now)

- Multi-reference inference (the tokenizer consumes one reference; the
  `references` list seam is already in the contract).
- In-process JS inference, WebGPU, or porting classical CV to JS.
- A licensing/auth proxy for self-hosted (OSS talks direct).
- Streaming/batched request APIs — the per-frame request model stays.
