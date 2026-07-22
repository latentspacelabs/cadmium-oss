# Cadmium — centralized TODO

The **single home** for outstanding work across the repo: inline `TODO`/
`FIXME` markers in the source, the roadmap items that used to live in
per-component "Remaining TODOs" doc sections (folded in here 2026-07-22; the
component docs no longer carry TODO sections), and open findings from the
2026-07 serving-backend code review that were deferred rather than fixed.

**Split by module, ordered by priority within each:**

- **P1 — correctness / potential bug.** Wrong output, crash, or data loss under some input.
- **P2 — performance / resource.** Works, but wastes memory/CPU or a hot path.
- **P3 — cleanup / refactor / rename.** Maintainability; no behavior change.
- **P4 — future / aspirational.** New capability, not a defect.

Where an item has an inline marker, it links to the authoritative location
(`file:line`). When you close an item, delete its line here **and** the marker
it points at.

---

## Release / cross-cutting

- **P1 — Rotate two leaked credentials.** A Comet API key and an Apple
  app-specific password were committed in history and must be rotated at the
  provider, then scrubbed. Tracked out-of-band; see the maintainer's notes.
- **P2 — Windows e2e shakedown on real hardware.** Install and run the CI-built
  `Cadmium.Setup.exe` on a real DirectX-12 machine: DirectML tiled-scatter AnT
  path, fp16 GapCloser 0-flip boundary check (only fp32/CPU has it today —
  prerequisite for shipping fp16 as the Windows default), and one real
  eSigner-CKA signed-build validation. (Mac side is validated: signed+notarized
  v1.5.4 installed and serving via CoreML.)
- **P2 — Model-bootstrap end-to-end test on a fresh machine.** The downloader
  is unit-tested and the `models-v1` release exists, but a clean-machine
  install→download→colorize pass hasn't been run; anonymous download URLs also
  need the repo public. **Resume support for interrupted GB-scale downloads is
  a known gap** (a failed file refetches whole).
- **P2 — Verify goldens in CI.** The `verify_*` bins + a Windows CPU
  `parity_replay` need a durable home for the multi-GB golden dirs (a
  dedicated release tag like the models, or S3); until then CI runs only
  `cargo test` + jest. EP runtime checks (CoreML/DirectML) additionally need
  real hardware — GitHub runners are CPU-only.

### Serving setup & acceleration — [serving-setup-design.md](serving-setup-design.md)

All five phases shipped 2026-07-22: explicit acceleration status in `/health`
+ Server Settings; Serving Profile (roles, resilient downloads,
`missingAccel`); setup ledger + reconciler + GitHub auto-update feed + NSIS
uninstall wipe; the nav-bar acceleration chip; reset button + orphan
quarantine + cache wipe on manifest change + memoized sha-verify-on-reuse.
Remaining from the design:

- **P3 — gap-bucket `CACHE_KEY` metadata** (needs a model re-export at the
  next models-v1 asset update; until then a manifest change wipes the whole
  CoreML cache as the blunt-but-correct fallback).

---

## app (Electron / Vue renderer + main)

### P1 — correctness
- Possible out-of-bounds layer index. → [store/getters.js:140](../app/src/store/getters.js#L140), [store/getters.js:158](../app/src/store/getters.js#L158)
- Missing validation when color images are added before line images. → [store/actions.js:1144](../app/src/store/actions.js#L1144)
- `loadcdm` backfill defaults disagree with `state.js` defaults for legacy files: `maxAiDilationSize` 30 vs 8, `maxTbDilationSize` 30 vs 1, `minSegSize` 1 vs 10 ([undo-redo-plugin.js:511](../app/src/store/undo-redo-plugin.js#L511) vs [state.js:115](../app/src/store/state.js#L115)); and `if (!newState.autoAlpha)` turns an absent field into `false` while a fresh app defaults `true`.
- `validateFrameNumber` accepts up to 1000 while the user-facing copy says 999. → [services/import-plan.js](../app/src/services/import-plan.js)

### P2 — performance
- Segmentation map recomputed unconditionally; add a checksum cache. → [util/segmentation.js:32](../app/src/util/segmentation.js#L32)
- RadialGradient re-created every render loop; build once and re-use. → [components/MainPane.vue:1165](../app/src/components/MainPane.vue#L1165)
- `playerInterval` lives in reactive Vuex state; move it out. → [store/state.js:69](../app/src/store/state.js#L69)

### P3 — cleanup / rename
- The big storage flip (deliberately deferred): the v2 `.cdm` document section is derived-and-validated only; `state.layers` + ghosts + `saveState` remain the source of truth. Flipping (Document primary, `saveState` dropped, ghost color records → real Cels) is ~100+ read-site churn with no live bug paying for it. Entry point when it happens: the seam + validation warning in `LOAD_FILE` ([actions.js:703](../app/src/store/actions.js#L703)). → [docs/temp/architecture.md:283](temp/architecture.md#L283)
- Legacy job flags: the `*InProgress` / `*CanceledByUser` / progress keys still exist as JobRunner-maintained mirrors, and cancellation still bridges through `SET_*_CANCELED_BY_USER` commits ([actions.js:496](../app/src/store/actions.js#L496)). Deleting the mirrors means porting every reader (waiting screens, cancel buttons, menu state) to observe the runner.
- Dead code to remove: `app/src/server.js` + most of `binaries.js` (the old spawn-a-bundled-server path; nothing imports `startServer`/`stopServer`), `SET_TMP_IMAGE_ROOT_PATH`, the stock Cypress scaffold under `tests/e2e/`. → [store/mutation-types.js:15](../app/src/store/mutation-types.js#L15), [store/mutations.js:448](../app/src/store/mutations.js#L448)
- Rename `selectedFrame`/`SELECTED_FRAME_NR` → playhead (it is the playhead, not a selection); rename `util/modal.js` → `server-client.js` to end the Modal-vs-modal confusion. → [store/state.js:35](../app/src/store/state.js#L35), [store/getter-types.js:5](../app/src/store/getter-types.js#L5)
- Layer choice hard-coded where it should follow the last-active layer. → [components/MainPane.vue:1349](../app/src/components/MainPane.vue#L1349), [util/KeyHandler.js:219](../app/src/util/KeyHandler.js#L219)
- Duplicated mouse-move block. → [components/MainPane.vue:990](../app/src/components/MainPane.vue#L990)
- Sidebar height hack (flexbox). → [components/Sidebar.vue:191](../app/src/components/Sidebar.vue#L191)
- Colour-wheel timer hack. → [components/ColorWheelControls.vue:624](../app/src/components/ColorWheelControls.vue#L624)
- `evaluateEmbeddedCapability` always reserves +5 GB CoreML cache on macOS even when the compiled cache already exists on disk (conservative double-count; current behavior is codified by a test). Probe the existing cache size to avoid a false disk-blocker on a near-full volume. → [util/embedded-capability.js:76](../app/src/util/embedded-capability.js#L76)

### P4 — future
- Handle app-update failure via popup. → [background.js:585](../app/src/background.js#L585)
- Drawing-tablet input support. → [components/MainPane.vue:1852](../app/src/components/MainPane.vue#L1852)

---

## colorize (inference-only model package)

### P1 — correctness / model-parity
- vtracer in serving does not support padding (Python↔serving parity gap). → [vectorization/vtrace.py:32](../colorize/vectorization/vtrace.py#L32)
- AnT v2 pad value for the packed output tensor is unverified. → [ant_v2/model_ant_v2.py:336](../colorize/ant_v2/model_ant_v2.py#L336)
- Quantization questions: remove line pixels before quantizing? quantize the ref frame too? → [common/sequence.py:305](../colorize/common/sequence.py#L305), [common/sequence.py:491](../colorize/common/sequence.py#L491)
- Resize should possibly be bilinear for line/color (currently nearest). → [common/image.py:97](../colorize/common/image.py#L97)

### P3 — cleanup / architecture questions
- `to_dense_batch` instead of the manual batch build. → [common/ops.py:178](../colorize/common/ops.py#L178)
- SVG-encoder / SuperGlue architecture questions (siamese vs separate; aggregation). → [nn/superglue.py:97](../colorize/nn/superglue.py#L97), [nn/svg_encoder.py:104](../colorize/nn/svg_encoder.py#L104)
- Preserve small segments in `prepare_image`? → [common/image.py:55](../colorize/common/image.py#L55)
- SVG-path uniqueness / normalized-case handling. → [vectorization/lib/svg_path.py:127](../colorize/vectorization/lib/svg_path.py#L127), [vectorization/lib/svg.py:144](../colorize/vectorization/lib/svg.py#L144)

---

## segmentation (classical trapped-ball + GapCloser inference)

### P1 — correctness
- Check for `> 256` segments in `compute_seg` (potential label overflow). → [trapped_ball/parallel.py:19](../segmentation/trapped_ball/parallel.py#L19)

### P3 — cleanup
- Combine the two neighbouring helpers in `parallel.py`. → [trapped_ball/parallel.py:16](../segmentation/trapped_ball/parallel.py#L16)
- Both the Python and Rust segmentation implementations are live; once the sidecar is the only shipped inference path, mark the Python one as data-prep/reference-only.
- Golden sets live outside the repo (machine-local scratch) — same durable-home need as the CI goldens item above.

---

## serving/sidecar (Rust ONNX sidecar)

No inline markers in the Rust/Python serving source. The items below are open
code-review findings (deferred) plus the doc roadmap.

### P2 — performance / resource
- **Segment gap path holds all tiles + all UDF planes in memory at once**
  (~2 MB/tile → ~650 MB transient for a ~256-tile 4K drawing) instead of
  streaming per-tile as the old path did. The fix is entangled with the CoreML
  batch-of-24 forward, so it's a refactor, not a one-liner. → [src/serve/segment_impl.rs:106](../serving/sidecar/src/serve/segment_impl.rs#L106)
- **Gap-closer onto the DirectML GPU EP.** The CoreML batch path exists
  (`--gap-model-bucket`); Windows still runs the gap net on CPU (~2.6 s vs
  ~719 ms measured on DML fp16). Ship together with the fp16 0-flip boundary
  check (see the Windows shakedown item under Release).

### P3 — cleanup / robustness
- **Gap bucket artifact carries no `CACHE_KEY` metadata**, so a weight-only
  update to `gap_closer_fp32_bucket.onnx` won't invalidate the CoreML model
  cache (the AnT bucket is stamped; the gap bucket is not). Also: nothing prunes
  the ~4.4 GB CoreML cache. Do both at the next `models-v1` re-export. → [src/serve/engine.rs](../serving/sidecar/src/serve/engine.rs)
- **Bucket-only gap config has no CPU fallback.** If only `--gap-model-bucket`
  is supplied (no dynamic `--gap-model`) and the CoreML build fails, the CPU
  fallback finds no dynamic model and silently degrades to trapped-ball-only.
  The app always ships both models, so this is a misconfig edge — add a startup
  warning when `GapEp::CoreMl` is resolved without a dynamic gap model. → [src/serve/engine.rs](../serving/sidecar/src/serve/engine.rs)
- **`CORPUS_BUCKET` dims (256/64/256/8192/512) are hand-synced in four places**
  — [src/tokenize/bucket.rs](../serving/sidecar/src/tokenize/bucket.rs), `serving/onnx/parity_corpus.py`,
  the `model-manifest.js` comment, and the serving docs. A drift would break
  parity silently. Consider a single generated source of truth.
- **ORT dylib version `1.27.0` is triplicated** across
  `serving/sidecar/scripts/fetch-ort-dylib.sh`, `app/vue.config.js`
  (extraResources), and `.github/workflows/ci.yml`. Centralize the version so a
  bump touches one place.

### P4 — future
- `compute_seg_partial` (incremental re-seg of edited tiles) exists in Python
  but has no Rust port / serving route — decide if wanted.
- fp16 AnT evaluation (halves the download; needs the ScatterElements
  block-list export path re-validated end-to-end).
- Modal backend client wiring (per-op URLs + auth) remains unbuilt.

---

## Recently resolved (2026-07)

Closed since this file was created — listed so they aren't re-filed:

- **LICENSE**: Apache 2.0 added repo-wide (root LICENSE + NOTICE; Cargo.toml/
  pyproject/package.json declarations synced) — 2026-07-22.
- **First-run CI shakedown**: the full pipeline (mac+win cargo test, jest,
  packaged signed/notarized builds, tag-drafted releases) ran green for
  v1.5.3–v1.5.5; mac end-to-end validated by a real install.
- **Auto-update feed**: `publish` config was absent (packaged builds had no
  feed at all); wired 2026-07-22 with the setup-ledger install-identity flow
  around it.
- Undeclared `choseToUpdate` assignment in background.js (ReferenceError when
  declining an update) — removed.

From the serving-backend review pass:

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
