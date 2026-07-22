# Cadmium — centralized TODO

The single index of outstanding work across the repo. It pulls together the
inline `TODO`/`FIXME` markers scattered through the source and the "Remaining
TODOs" roadmap sections in the docs, plus the open findings from the latest
serving-backend code review that were deferred rather than fixed.

**Split by module, ordered by priority within each:**

- **P1 — correctness / potential bug.** Wrong output, crash, or data loss under some input.
- **P2 — performance / resource.** Works, but wastes memory/CPU or a hot path.
- **P3 — cleanup / refactor / rename.** Maintainability; no behavior change.
- **P4 — future / aspirational.** New capability, not a defect.

Each item links to the authoritative location (`file:line`). For the doc
roadmap sections, the detail lives in the linked doc — this file is the index,
not a copy. When you close an item, delete its line here **and** the marker it
points at.

---

## Release / cross-cutting

- **P1 — Rotate two leaked credentials.** A Comet API key and an Apple
  app-specific password were committed in history and must be rotated at the
  provider, then scrubbed. Tracked out-of-band; see the maintainer's notes.
- **P1 — Add a `LICENSE` file.** `Cargo.toml` declares `license = "MIT"` and the
  READMEs say MIT, but there is no top-level `LICENSE`.
- **P2 — First-run CI shakedown never executed.** Repo not yet public; Windows
  `cargo test` under MSVC and the mac notarization staple have never run for
  real. → [docs/build-and-release.md:226](docs/build-and-release.md#L226)
- **P2 — Model-bootstrap end-to-end test** needs the `models-v1` release to
  exist and the repo public; EP runtime checks (CoreML/DirectML) need real
  hardware (CI runners are CPU-only). → [docs/build-and-release.md:226](docs/build-and-release.md#L226)
- **P2 — Windows DirectML e2e shakedown on real GPU hardware** still pending
  (the tiled-scatter AnT path + fp16 boundary parity).

---

## app (Electron / Vue renderer + main)

### P1 — correctness
- Possible out-of-bounds layer index. → [store/getters.js:140](app/src/store/getters.js#L140), [store/getters.js:158](app/src/store/getters.js#L158)
- Missing validation when color images are added before line images. → [store/actions.js:1144](app/src/store/actions.js#L1144)
- Small bugs catalogued in the app doc: `background.js` undeclared `choseToUpdate`; loadcdm backfill defaults disagree with `state.js` (`maxAiDilationSize` 30 vs 8, `maxTbDilationSize` 30 vs 1, `minSegSize` 1 vs 10, `autoAlpha` missing); `validateFrameNumber` accepts 1000 vs copy's 999. → [docs/app.md:339](docs/app.md#L339)

### P2 — performance
- Segmentation map recomputed unconditionally; add a checksum cache. → [util/segmentation.js:32](app/src/util/segmentation.js#L32)
- RadialGradient re-created every render loop; build once and re-use. → [components/MainPane.vue:1165](app/src/components/MainPane.vue#L1165)
- `playerInterval` lives in reactive Vuex state; move it out. → [store/state.js:69](app/src/store/state.js#L69)

### P3 — cleanup / rename
- The big storage flip: v2 `.cdm` Document is derived-only; `state.layers` + ghosts + `saveState` are still the source of truth (~100+ read-site churn, deferred). → [docs/app.md:339](docs/app.md#L339), [docs/temp/architecture.md:283](docs/temp/architecture.md#L283)
- Dead code to remove: `app/src/server.js`, most of `binaries.js`, `SET_TMP_IMAGE_ROOT_PATH`, the Cypress scaffold. → [store/mutation-types.js:15](app/src/store/mutation-types.js#L15), [store/mutations.js:448](app/src/store/mutations.js#L448)
- Rename `selectedFrame`/`SELECTED_FRAME_NR` → playhead (it is the playhead, not a selection). → [store/state.js:35](app/src/store/state.js#L35), [store/getter-types.js:5](app/src/store/getter-types.js#L5)
- Layer choice hard-coded where it should follow the last-active layer. → [components/MainPane.vue:1349](app/src/components/MainPane.vue#L1349), [util/KeyHandler.js:219](app/src/util/KeyHandler.js#L219)
- Duplicated mouse-move block. → [components/MainPane.vue:990](app/src/components/MainPane.vue#L990)
- Sidebar height hack (flexbox). → [components/Sidebar.vue:191](app/src/components/Sidebar.vue#L191)
- Colour-wheel timer hack. → [components/ColorWheelControls.vue:624](app/src/components/ColorWheelControls.vue#L624)
- First-run model-download visibility: `save()` now starts the download, but the modal then closes and there is no global progress surface — progress is only visible on reopening Server Settings. Consider a persistent download indicator. → [components/ServerSettingsModal.vue:574](app/src/components/ServerSettingsModal.vue#L574)
- `evaluateEmbeddedCapability` always reserves +5 GB CoreML cache on macOS even when the compiled cache already exists on disk (conservative double-count; current behavior is codified by a test). Probe the existing cache size to avoid a false disk-blocker on a near-full volume. → [util/embedded-capability.js:76](app/src/util/embedded-capability.js#L76)

### P4 — future
- Handle app-update failure via popup. → [background.js:585](app/src/background.js#L585)
- Drawing-tablet input support. → [components/MainPane.vue:1852](app/src/components/MainPane.vue#L1852)

---

## colorize (inference-only model package)

### P1 — correctness / model-parity
- vtracer in serving does not support padding (Python↔serving parity gap). → [vectorization/vtrace.py:32](colorize/vectorization/vtrace.py#L32)
- AnT v2 pad value for the packed output tensor is unverified. → [ant_v2/model_ant_v2.py:336](colorize/ant_v2/model_ant_v2.py#L336)
- Quantization questions: remove line pixels before quantizing? quantize the ref frame too? → [common/sequence.py:305](colorize/common/sequence.py#L305), [common/sequence.py:491](colorize/common/sequence.py#L491)
- Resize should possibly be bilinear for line/color (currently nearest). → [common/image.py:97](colorize/common/image.py#L97)

### P3 — cleanup / architecture questions
- `to_dense_batch` instead of the manual batch build. → [common/ops.py:178](colorize/common/ops.py#L178)
- SVG-encoder / SuperGlue architecture questions (siamese vs separate; aggregation). → [nn/superglue.py:97](colorize/nn/superglue.py#L97), [nn/svg_encoder.py:104](colorize/nn/svg_encoder.py#L104)
- Preserve small segments in `prepare_image`? → [common/image.py:55](colorize/common/image.py#L55)
- SVG-path uniqueness / normalized-case handling. → [vectorization/lib/svg_path.py:127](colorize/vectorization/lib/svg_path.py#L127), [vectorization/lib/svg.py:144](colorize/vectorization/lib/svg.py#L144)

---

## segmentation (classical trapped-ball + GapCloser inference)

### P1 — correctness
- Check for `> 256` segments in `compute_seg` (potential label overflow). → [trapped_ball/parallel.py:19](segmentation/trapped_ball/parallel.py#L19)

### P3 — cleanup
- Combine the two neighbouring helpers in `parallel.py`. → [trapped_ball/parallel.py:16](segmentation/trapped_ball/parallel.py#L16)
- Mark the Python impl training/data-prep-only once the sidecar is the sole inference path; golden sets need a durable home; fp16 GapCloser DirectML boundary parity lacks the 0-flip check. → [docs/segmentation.md:96](docs/segmentation.md#L96)

---

## serving/sidecar (Rust ONNX sidecar)

No inline markers in the Rust/Python serving source. The items below are open
code-review findings (deferred) plus the doc roadmap.

### P2 — performance / resource
- **Segment gap path holds all tiles + all UDF planes in memory at once**
  (~2 MB/tile → ~650 MB transient for a ~256-tile 4K drawing) instead of
  streaming per-tile as the old path did. The fix is entangled with the CoreML
  batch-of-24 forward, so it's a refactor, not a one-liner. → [src/serve/segment_impl.rs:106](serving/sidecar/src/serve/segment_impl.rs#L106)
- **Gap-closer onto GPU EPs** was CPU-only in the docs; a CoreML batch path now
  exists (`--gap-model-bucket`). Remaining: DirectML/fp16 gap path + the 0-flip
  boundary check before shipping fp16 as the Windows default. → [docs/gap-closer-serving.md:78](docs/gap-closer-serving.md#L78)

### P3 — cleanup / robustness
- **Gap bucket artifact carries no `CACHE_KEY` metadata**, so a weight-only
  update to `gap_closer_fp32_bucket.onnx` won't invalidate the CoreML model
  cache (the AnT bucket is stamped; the gap bucket is not). Also: nothing prunes
  the ~4.4 GB CoreML cache. Do both at the next `models-v1` re-export. → [src/serve/engine.rs](serving/sidecar/src/serve/engine.rs)
- **Bucket-only gap config has no CPU fallback.** If only `--gap-model-bucket`
  is supplied (no dynamic `--gap-model`) and the CoreML build fails, the CPU
  fallback finds no dynamic model and silently degrades to trapped-ball-only.
  The app always ships both models, so this is a misconfig edge — add a startup
  warning when `GapEp::CoreMl` is resolved without a dynamic gap model. → [src/serve/engine.rs](serving/sidecar/src/serve/engine.rs)
- **`CORPUS_BUCKET` dims (256/64/256/8192/512) are hand-synced in four places**
  — [src/tokenize/bucket.rs](serving/sidecar/src/tokenize/bucket.rs), `serving/onnx/parity_corpus.py`,
  the `model-manifest.js` comment, and the serving docs. A drift would break
  parity silently. Consider a single generated source of truth.
- **ORT dylib version `1.27.0` is triplicated** across
  `serving/sidecar/scripts/fetch-ort-dylib.sh`, `app/vue.config.js`
  (extraResources), and `.github/workflows/ci.yml`. Centralize the version so a
  bump touches one place.

### P4 — future
- `compute_seg_partial` (incremental re-seg of edited tiles) exists in Python
  but has no Rust port / serving route — decide if wanted. → [docs/gap-closer-serving.md:78](docs/gap-closer-serving.md#L78)
- Modal backend client wiring (per-op URLs + auth) remains unbuilt; fp16 AnT
  evaluation needs the ScatterElements block-list export path re-validated. → [docs/colorizer-serving.md:140](docs/colorizer-serving.md#L140)

---

## Recently resolved (2026-07 serving-backend review pass)

Fixed in the review pass that produced this file — listed so they aren't re-filed:

- Prewarm gate race (inline ~107 s block + double CoreML compile): the AnT
  bucket gate is now claimed synchronously before the server accepts requests.
- AnT bucket build/forward failure now falls back to the dynamic CPU session
  instead of failing the `/colorize` request.
- CoreML gap-closer build failure is latched so `/segment` stops retrying a
  compile that can't succeed (was a per-request retry-storm).
- `ort_dylib::init` uses `ort::init_from` instead of mutating `ORT_DYLIB_PATH`
  (unsound once tokio's worker threads exist); dylib pick is now deterministic
  (newest version wins, not directory-iteration order).
- `getGPUInfo('complete')` is capped at 3 s so a wedged GPU process can't hang
  the capabilities probe.
- First-run "Get started" now starts the one-time model download instead of
  warming a sidecar that has no models.
