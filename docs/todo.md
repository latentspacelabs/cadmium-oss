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

### Serving setup & acceleration — [serving-setup-design.md](serving-setup-design.md)

All five phases shipped 2026-07-22: explicit acceleration status in `/health`
+ Server Settings; Serving Profile (roles, resilient downloads,
`missingAccel`); setup ledger + reconciler + GitHub auto-update feed + NSIS
uninstall wipe; the nav-bar Server Settings button (acceleration status lives
in the Settings modal's per-capability rows); reset button + orphan
quarantine + cache wipe on manifest change + memoized sha-verify-on-reuse.
Remaining from the design:

- **P3 — gap-bucket `CACHE_KEY` metadata** (needs a model re-export at the
  next models-v1 asset update; until then a manifest change wipes the whole
  CoreML cache as the blunt-but-correct fallback).

---

## app (Electron / Vue renderer + main)

### P2 — performance
_All clear (2026-07-27 sweep). `playerInterval` moved out of reactive Vuex; the
segmentation-checksum and RadialGradient items were stale (segmap caching already
lives at the callers via content-addressed filenames; the RadialGradient path is
commented out, superseded by `stampBrushDraw`). See "Recently resolved"._

### P3 — cleanup / rename

The 2026-07-27 sweep cleared the dead-code removal, the `modal.js` →
`server-client.js` rename, and the CoreML-cache double-count (see "Recently
resolved"). The rest below are **deferred with cause**: large refactors with no
live bug paying for them, a persisted-key rename that needs a migration, and
UI / hot-drawing-path changes that need interactive testing a code sweep can't do.

- The big storage flip (deliberately deferred): the v2 `.cdm` document section is derived-and-validated only; `state.layers` + ghosts + `saveState` remain the source of truth. Flipping (Document primary, `saveState` dropped, ghost color records → real Cels) is ~100+ read-site churn with no live bug paying for it. Entry point when it happens: the seam + validation warning in `LOAD_FILE` ([actions.js:703](../app/src/store/actions.js#L703)). → [docs/temp/architecture.md:283](temp/architecture.md#L283)
- Legacy job flags: the `*InProgress` / `*CanceledByUser` / progress keys still exist as JobRunner-maintained mirrors, and cancellation still bridges through `SET_*_CANCELED_BY_USER` commits ([actions.js:496](../app/src/store/actions.js#L496)). Deleting the mirrors means porting every reader (waiting screens, cancel buttons, menu state) to observe the runner — pure refactor, no live bug.
- Rename `selectedFrame`/`SELECTED_FRAME_NR` → playhead (it is the playhead, not a selection). **Deferred:** ~74 refs across 10 files, and `selectedFrame` *is* the persisted `.cdm` key — the rename needs a `loadcdm` migration (`playhead = selectedFrame`) or old files silently lose the saved playhead position, plus word-boundary care to avoid colliding with the real multi-select concept (`selectedFrames`, `*_FOR_SELECTED_FRAME`). Its own PR, not a sweep. → [store/state.js:35](../app/src/store/state.js#L35), [store/getter-types.js:5](../app/src/store/getter-types.js#L5)
- Layer choice hard-coded where it should follow the last-active layer. **Deferred:** a drawing-behavior change in the hot canvas path; needs interactive testing. → [components/MainPane.vue:1349](../app/src/components/MainPane.vue#L1349), [util/KeyHandler.js:219](../app/src/util/KeyHandler.js#L219)
- Duplicated mouse-move block. **Deferred:** extracting shared setup from the live drawing path; same interactive-test gap. → [components/MainPane.vue:990](../app/src/components/MainPane.vue#L990)
- Sidebar height hack (flexbox). **Deferred:** CSS hack, needs visual verification. → [components/Sidebar.vue:191](../app/src/components/Sidebar.vue#L191)
- Colour-wheel timer hack. **Deferred:** timing hack, needs interactive verification. → [components/ColorWheelControls.vue:624](../app/src/components/ColorWheelControls.vue#L624)

### P4 — future
- Handle app-update failure via popup. → [background.js:585](../app/src/background.js#L585)
- Drawing-tablet input support. → [components/MainPane.vue:1852](../app/src/components/MainPane.vue#L1852)

---

## segmentation (classical trapped-ball + GapCloser inference)

### P3 — cleanup
- Combine the two neighbouring helpers in `parallel.py`. → [trapped_ball/parallel.py:16](../segmentation/trapped_ball/parallel.py#L16)
- Both the Python and Rust segmentation implementations are live; once the sidecar is the only shipped inference path, mark the Python one as data-prep/reference-only.
- Golden sets live outside the repo (machine-local scratch) — same durable-home need as the CI goldens item above.

---

## serving/sidecar (Rust ONNX sidecar)

No inline markers in the Rust/Python serving source. The items below are open
code-review findings (deferred) plus the doc roadmap.

### P3 — cleanup / robustness
- **Gap bucket artifact carries no `CACHE_KEY` metadata + no CoreML-cache
  prune** — both genuinely gated on the next `models-v1` re-export, not
  code-fixable here now:
  - *CACHE_KEY stamp:* `CACHE_KEY` is a `metadata_props` entry baked into the
    `.onnx` bytes (ORT's CoreML EP reads it; the sidecar only sets
    `ModelCacheDirectory`). Stamping the gap bucket means re-exporting +
    republishing the asset and bumping its `sha256`/`bytes` in
    `model-manifest.js`. Already functionally mitigated: a weight-only republish
    changes the model sha → `manifestHash` changes → `wipeCoremlCache()` on the
    next launch, so no stale-cache correctness bug — CACHE_KEY would only make
    the invalidation *surgical* (recompile just the gap bucket, skip the ~107 s
    AnT rebuild) instead of the current full wipe.
  - *Cache prune:* the sidecar never sees ORT's per-model cache subdir names, so
    the only pure-Rust prune is recency-based — which can evict a still-valid
    subdir (a cache-hit reload may not bump mtime) and force a spurious ~107 s
    recompile, worse than the disk it frees. The full `wipeCoremlCache()` on
    manifest change already bounds growth. Do a *surgical* prune together with
    CACHE_KEY at the re-export (then subdir identity is known). → [src/serve/engine.rs](../serving/sidecar/src/serve/engine.rs)

---

## Recently resolved (2026-07)

Closed since this file was created — listed so they aren't re-filed:

- **app P2/P3 sweep** — 2026-07-27. Cleared all three P2s and three P3s:
  - *`playerInterval` in reactive Vuex (P2):* it was a setInterval/RAF handle
    reassigned every animation frame during playback, with no reactive readers.
    Moved to a module-local `playerHandle` in `mutations.js`; dropped from
    `state.js` + `default-state.js` (no longer serialized into a `.cdm`).
  - *Segmentation recompute (P2):* stale — both callers (`ANALYZE_CURRENT_FRAME`,
    `ensureSegMap`) already skip the call when a content-addressed segmap file
    exists. Replaced the TODO with a note pointing at that cache.
  - *RadialGradient re-created per render (P2):* stale — all of it is commented
    out, superseded by `stampBrushDraw`; no live perf issue.
  - *Dead code (P3):* deleted `src/server.js` (the old spawn-a-bundled-server
    path) + its three now-orphaned `binaries.js` exports; removed
    `SET_TMP_IMAGE_ROOT_PATH` (mutation only wrote a never-read field) as a
    6-site set; deleted the stock Cypress scaffold (the real e2e suite is the
    CDP harness `tests/e2e/run.js`).
  - *`util/modal.js` → `server-client.js` (P3):* it's the ML-server HTTP client,
    not a UI modal; renamed the file + 5 importers + the jest.mock (symbols keep
    the `modal*` prefix — a separate wider rename).
  - *CoreML-cache disk double-count (P2/P3):* the capability probe now measures
    the existing coreml-cache size and the evaluator reserves only the
    not-yet-compiled remainder, so a near-full volume with a built cache is no
    longer falsely blocked. Backward-compatible (absent → full reservation).
- **serving/sidecar cleanup sweep** — 2026-07-27. Three of the four P3 items:
  - *Bucket-only gap config had no CPU fallback:* `Engine::new` now warns at
    startup when the gap EP is an accelerator (CoreML/DirectML) but no dynamic
    `--gap-model` is configured — a failed accelerator build would otherwise
    silently drop gap-closing to trapped-ball-only with no signal.
  - *`CORPUS_BUCKET` dims duplicated:* added a `cargo test`
    (`bucket.rs::corpus_bucket_matches_python_parity_source`) that `include_str!`s
    `parity_corpus.py` and asserts the five dims match the Rust const — the one
    guard that actually catches Rust↔Python drift (the golden harnesses that
    would are out-of-CI). The `model-manifest.js` comment (which had already
    dropped `cmds`) and `colorizer-serving.md` now point at the const instead of
    restating numbers.
  - *ORT dylib version `1.27.0` duplicated:* it lived in `fetch-ort-dylib.sh`,
    `vue.config.js`, and `build-and-release.md` (ci.yml only calls the script;
    Windows ships no dylib — the crate statically links pyke 1.24). `vue.config.js`
    now globs `libonnxruntime.*.dylib` from `vendor/` (runtime finds it by the
    same glob, so the filename is irrelevant), and the fetch script prunes stale
    dylibs so exactly one ships. A bump now touches only `fetch-ort-dylib.sh`.
    Also corrected the `ort_dylib.rs` doc that wrongly claimed the app sets
    `ORT_DYLIB_PATH` (nothing does; packaged builds use the sibling glob).
- **app P1 sweep** — 2026-07-27. Cleared the five app P1 items:
  - *Out-of-bounds layer index* (`getters.js`): both sites were already guarded
    by `if (!layer)` (an OOB index returns `undefined`) — removed the stale
    `// TODO: … out of bounds` comments; no behavior change.
  - *Missing color-before-line validation*: already implemented —
    `ANALYZE_CURRENT_FRAME`'s import path warns via `colorImportedFirst()` and
    aborts on decline. Was misfiled as open.
  - *>255-segment analyze returns a phantom segmap path*: `ANALYZE_CURRENT_FRAME`
    now reads `numSegments` from `generateSegmentationMap` and bails with the
    shared `TOO_MANY_SEGMENTS` dialog (as COLORIZE does) instead of handing
    `analyzeRef` a file that was never written.
  - *`loadcdm` backfill defaults drifted from `state.js`* (30/30/1 vs 8/1/10;
    `autoAlpha` absent→false vs default true): the backfill now reads the fresh
    defaults straight from `state.js` (single source of truth, so it can't drift
    again) and only overrides `autoAlpha` when it isn't already a boolean, so an
    explicit `false` survives.
  - *`validateFrameNumber` 1000 vs "999"*: not a bug — frame numbers are
    filename+1, so the `> 1000` bound accepts filenames up to 999, matching the
    copy. Left as-is (already documented in the file's header).
- **DirectML gap-closer (Windows GPU gap closing)** — 2026-07-27. Diagnosed
  from a field report ("gap closer in CPU mode on Windows"): the sidecar's
  `GapEp` had no DirectML variant, so Windows gap closing was CPU-only on
  every machine (the AMD GPU was a red herring). Added `GapEp::Dml` sharing
  the batched forward with CoreML (`run_gap_accel`); ships the fp16 export
  (fp32 batches OOM a 16 GB WDDM card) as a win32 `models-v1` accelerator;
  `serving-profile` win32 `segment: 'dml'`. fp16 boundary parity vs the fp32
  anchor: 10 flips / 10.5 M px (CPU proxy), 18 flips on the actual DirectML EP
  on a T4 — both ~99.9998%. Standalone DML bench on the T4: batch-24 ~0.7 s vs
  the 4-vCPU CPU path's multi-second gap close. CI (push 2026-07-27) has since
  compiled the `cfg(windows)` DirectML path and passed the win-gated
  `accel_report_windows_gap_dml_selection` test + packaged the win installer;
  the remaining sidecar-level `/health segment=dml` integration e2e folds into
  the v1.5.7 Windows shakedown.
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
- **Color-import-without-line hang** (2026-07-22): Electron ≥32 removed
  `File.path`, so the canny fallback read `undefined` from disk and the
  failure was swallowed into a `new Promise(async ...)` executor that never
  settled — analyze overlay up forever. Fixed three-deep: canny now takes the
  frame's data URI directly, `generateSegmentationMap` is a plain async fn
  (throws reject), `ANALYZE_CURRENT_FRAME` clears the overlay in a `finally`,
  and import queues re-attach real paths via `webUtils.getPathForFile`.

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
