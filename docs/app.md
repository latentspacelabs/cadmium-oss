# Cadmium app — Electron/Vue frontend architecture

The desktop app under `app/`. This document covers the frontend only; the ML
serving side (the HTTP contract, the remote server, the local Rust sidecar) is
documented in `docs/colorizer-serving.md` — here it appears only as "the
backend the app sends requests to".

## 1. Motivation

Cadmium is a line-art colorization tool for animators. The workflow: import a
numbered sequence of line-art frames onto a timeline, color one (or a few)
frames by hand or by importing already-colored art — these become *reference
frames* — then press **Colorize** and let the ML backend propagate the
reference's flat-fill colors onto every other frame, segment by segment.
Around that core sit hand-fix tools (pen, eraser, server-backed paint bucket,
eyedropper), a document-level palette with global recolor, playback, and
export to PNG / SVG / MP4. Projects persist as single-file `.cdm` documents.

Stack: Electron 39, Vue 2.7 + Vuex 3 (options API, no Pinia/Vue 3), built by
`@vue/cli-service` 5 with `vue-cli-plugin-electron-builder`.

## 2. Architecture & key design decisions

### 2.1 Process model

**Main process** — `app/src/background.js`. Creates the single
`BrowserWindow`, holds the single-instance lock, owns:

- **User preferences** (`app/src/util/local-preferences.js`, a JSON file in
  `userData/user-preferences.json`). The main process is the *single writer*;
  the renderer reads/writes via the `get-pref` / `add-pref` IPC channels.
- **Temp files** (`app/src/util/TempFileManager.js`):
  `userData/tempBucketDir`, tracked centrally so it can be wiped on project
  switch and app quit.
- The application menu (`app/src/menu.js`), auto-updates (`electron-updater`),
  and native-dialog relaying (`app/src/util/mainProcessDialog.js`).

The renderer runs with `nodeIntegration: true`, `contextIsolation: false`,
`webSecurity: false`, plus `@electron/remote` (`background.js:133-150`). That
is a deliberate legacy posture: the renderer has full Node/fs access (the
store actions read and write files directly), and it is what makes the
CDP-based e2e harness possible. Don't tighten it casually — half of
`app/src/store/actions.js` assumes `require('fs')` works.

**Renderer entry** — `app/src/main.js` mounts `App.vue` → `app/src/router.js`
(`Home` is the whole app; `About` is vestigial). `app/src/views/Home.vue`
composes `NavBar` + `MainPane` + `ServerSettingsModal` and owns the first-run
logic (welcome modal, server-settings prompt).

**The platform seam** — `app/src/platform/index.js` is the *only* sanctioned
path from renderer code to Electron/IPC. Services and actions call named
functions (`setPref`, `clearTempFiles`, `showSaveDialog`, …) so jest can mock
`@/platform` instead of `electron`. Migration is incomplete: some components
still touch `@electron/remote` directly. Main→renderer channels are
subscribed in `app/src/ipc-renderer-handlers.js` (openFile, saveBeforeQuit,
pref loads, update progress, dialog requests).

A custom `app://` protocol (`app/src/customProtocol.js`) replaces the plugin's
default to serve correct font MIME types in production builds.

### 2.2 The store, and the service layer growing around it

`app/src/store.js` assembles root `state/getters/mutations/actions` plus
modules `ToolControls`, `FillTool`, `PenTool`, `EraserTool`, `ZoomTool`,
`Pressure` (tool/viewport prefs — small and unremarkable) and `ImageStore`
(the image-byte store, below), plus the undo/redo plugin.

Root state (`app/src/store/state.js`, ~95 keys) mixes three kinds of state:

- **Document state**: `layers`, `layerGroups`, `colorPalette`,
  `canvasWidth/Height`, `firstRealFrameNumber`/`lastRealFrameNumber`,
  `referenceImages`. This is what a `.cdm` is.
- **Session/UI state**: `selectedFrame` (misnamed — it is the *playhead*, not
  selection), `player*`, `timeline*`, panel-collapse keys.
- **Job state**: `colorizationInProgress`, `exportInProgress`, `*Progress`,
  `*CanceledByUser`, `currentProcessingTask` — legacy flags now written only
  by the JobRunner (below) as read-compatible mirrors.

The historical failure mode of this codebase was 3,000-line orchestration
actions reading and writing all of that freely. The current architecture
(deliberate, recent) is a strangler pattern around the Vuex store:

- **Pure planners** — `app/src/services/{colorize-plan,export-plan,
  import-plan,export-frame,reference-matching,palette-recolor,cdm-format}.js`.
  Free of Vuex/Electron/fs/DOM, golden-tested, behaviour-preserving
  extractions (quirks intentionally kept and documented in each header).
- **Executors** — `app/src/services/colorize-run.js` and `export-run.js`:
  headless-testable effect loops with injected deps; they never open dialogs
  and return typed error results.
- **JobRunner** — `app/src/services/job-runner.js`: one long-running job at a
  time, AbortSignal cancellation, progress; it is the single writer of the
  legacy job flags (see its "mirror table" header comment).
- **AssetStore** — `app/src/services/asset-store.js`: a facade over the Vuex
  `ImageStore` that adds a disk tier at `userData/assetCache`
  (deliberately *beside* `tempBucketDir`, which is wiped on every project
  load) and an async `getAsset` that hydrates from disk or throws a typed
  `AssetMissingError` — "no drawing" and "not loaded" are no longer conflated.
- **DocumentService commands** — `app/src/services/document.js`: named write
  commands (`exposeLineDrawing`, `attachColorToCel`, `mergePalette`,
  `recolorPalette`) wrapping the exact mutation sequences call sites used to
  open-code. Components still *read* Vuex getters directly; only writes are
  funneled.

So an action like `COLORIZE` (`app/src/store/actions.js:418`) is now a thin UI
wrapper: normalize selection → pure snapshot → `planColorize` → surface typed
plan errors as dialogs → `runJob(ctx => runColorize(plan, deps, ctx))`. All
colorize dialogs live in one map (`showColorizeErrorDialog`,
`actions.js:354`). `EXPORT_DIALOG` (`actions.js:757`) follows the same shape,
and validates the plan *before* the native save dialog. The rest of
`actions.js` (~2,000 lines, down from ~3,100) is import, save/load, selection
and palette orchestration that still talks to Vuex directly.

### 2.3 The Cel/XSheet data model

The domain model is a traditional animation **exposure sheet**: artists draw
a small number of unique *drawings*; the timeline maps each frame to the
drawing it exposes; a *hold* is one drawing shown for several consecutive
frames.

**Decided and permanent: exactly one line+color layer pair.** The two
singleton layers `lineLayer1` / `colorLayer1`
(`app/src/store/general-types.js`) are a baked-in 1:1 pairing — no track
plumbing, no multi-layer compositing, ever. Code addresses the two layers by
their fixed ids (`app/src/services/xsheet.js`, `document.js`).

Storage shape (what a `.cdm` actually contains):

- `state.layers[layerId].frames` — a *sparse array indexed by frame number*;
  `frames[n]` is `{ imageDataId, isOriginal, isSelected, isLoading,
  refFrameLeftNr/RightNr/ClosestNr }` or null. `isOriginal` on a color frame
  means "reference frame" (imported/painted, not machine-colorized).
- `ImageStore.imageDataById` (`app/src/store/modules/ImageStore.js`) —
  `{ dataUri, hash, referenceCount, segmentationMapPath }` records,
  deduplicated by content hash on insert. A hold is N frames pointing at the
  *same* `imageDataId`.

Drawing-identity questions ("do these frames show the same drawing", "what
are the hold blocks", "which cel is at frame n") have exactly one home: the
pure read-model `app/src/services/xsheet.js` (`framesShareDrawing`,
`holdBlocks`, `uniqueDrawings`, `celAt`). Do not re-derive dupe logic from
hashes anywhere else — that was bug factory "F3" and it took a rewrite to
kill.

**Ghost color records — kept on purpose.** Every line import fabricates a
blank `<lineId>_color` ImageStore record (null `dataUri`) and points the
paired color frame at it (`document.js exposeLineDrawing`). An audit
considered deleting this; the conclusion (see the GHOST DECISION comment in
`document.js`) is that the ghost is *load-bearing*: every frame of a hold
block shares that one record, so painting any frame of a hold propagates to
the whole block. Eliminating ghosts requires a real Cel entity — i.e. the
storage flip below — not a cleanup. Consumers are null-safe; the derived v2
document records byte-less ids as `null` / provenance `'none'`.

**Undo/redo** (`app/src/store/undo-redo-plugin.js` +
`app/src/services/state-patch.js`) is patch-based: undoable actions snapshot
an explicit *include list* of document slices (`DIFF_SCOPE_KEYS`), diff at the
action's settle, and store forward+inverse patches (20 deep). New state keys
are non-undoable by default — the reverse of the old exclusion-list model.
Two boundary subtleties are documented at length in the plugin: `CANVAS_ACTION`
commits its stroke on mouse-up, so `MainPane` closes that boundary explicitly
(`closeUndoBoundary()`), and consecutive selection actions coalesce into one
item whose patches are filtered to `isSelected` ops. Loading a project clears
both stacks.

### 2.4 The .cdm file format

`app/src/services/cdm-format.js` is the pure serializer/parser; the I/O lives
in `CREATE_SAVED_FILE` / `LOAD_FILE` (`app/src/store/actions.js:545,660`).
A `.cdm` is JSON blobs glued by literal marker strings:

```
<metadataJSON>BEGINSAVESTATE<saveStateJSON>BEGINTEMPIMAGES<tempImagesJSON>[BEGINDOCUMENT<documentJSON>]
```

- `metadata` = `[{ version: <appVersion> }]`; files older than `0.3.0` are
  refused (`isProjectTooOld`).
- `saveState` = the **entire Vuex root state** (the `SAVE_STATE` getter is
  literally `state => state`, `app/src/store/getters.js:794`), including
  every ImageStore `dataUri` — this is why `.cdm` files are large and why
  save/load is stringify/parse of multi-MB JSON.
- `tempImages` = the segmentation-map temp files, base64-embedded
  (`[{ filename, data }]`); on load they are re-materialized into the fresh
  `tempBucketDir` and every `segmentationMapPath` is rewritten to point there.
- `BEGINDOCUMENT` (format v2, appended so v1 parsing stays byte-identical) =
  the exposure-sheet document *derived* at save time by `deriveDocument`
  (cels deduped via `xsheet.celAt`, exposures, palette, canvas size,
  provenance). **The flip seam:** `saveState` is still the load source of
  truth; in dev builds `LOAD_FILE` re-derives the document from the loaded
  state and warns if it drifts from the saved section (`validateDocument`).
  A future phase makes the document the source and drops `saveState`; v1
  files migrate by simply being re-saved.

Load-time normalization lives in `loadcdm`
(`app/src/store/undo-redo-plugin.js:319`): legacy-field backfills, clearing
stale `isLoading` spinners, resetting every in-progress/progress flag, loop
range clamping — then `replaceState`.

**`serverBackend` is machine-local, never document state.** Save strips it
(`CREATE_SAVED_FILE`, `actions.js:551-553` deletes it from the serialized
state) and load re-seeds it from the running app
(`loadcdm`, `undo-redo-plugin.js:619-622`) — so a `.cdm` shared from another
machine can never import that machine's server URL, and files saved before
the field existed get the current one.

### 2.5 The serving-backend descriptor and settings UI

Where `/colorize`, `/segment`, `/preprocess` requests go is described by a
descriptor persisted in preferences:

```
serverBackend: { kind: 'hosted' | 'embedded', baseUrl: 'http://…' }
```

`app/src/util/server-config.js` resolves it at *runtime* (so prebuilt
binaries can be re-pointed without rebuilding), first match wins:
`serverBackend` pref → legacy `serverUrl` string pref → build-time
`VUE_APP_SERVER_URL` → `http://localhost:8000`. Per-endpoint build-time
overrides (`VUE_APP_COLORIZE_URL` etc.) exist for split Modal deployments.
`'embedded'` (the app-managed local sidecar) is declared in the types and
shown greyed-out in the UI but not yet selectable — the sidecar itself is
covered in `docs/colorizer-serving.md`.

Wiring: `background.js` folds the legacy `serverUrl` pref into the descriptor
once at startup; `Home.vue` asks for the pref on mount, commits it into Vuex
(`SET_SERVER_BACKEND`), and if nothing is saved *and* no URL was baked in at
build time, opens `app/src/components/ServerSettingsModal.vue` in first-run
mode. The modal validates, offers a `/health` connection test, and persists
via `setPref` (through the main process, the single pref writer). The menu
(`app/src/menu.js`) reopens it via the `show-server-settings` channel.

The actual HTTP calls live in `app/src/util/modal.js` — **naming trap: "modal"
means the Modal.com cloud platform the server historically ran on, not a UI
modal**. It exposes `modalColorize` / `modalSegment` / `modalPreprocess`
(axios, AbortController, connectivity pre-check, error dialogs) and returns
either response data or a `MODAL_RESPONSES` sentinel string.
`app/src/services/colorize-service.js` shapes those raw calls into typed
results for the executor; its `refs` array is the seam for future
two-reference colorization (length 1 today).

## 3. Quirks & gotchas

**Dev serve**

- `npm run electron:serve` **fails if `ELECTRON_RUN_AS_NODE` is set** (some
  editor-hosted shells set it globally). Electron then boots as plain Node,
  `require('electron').app` is undefined, and the main process crashes at
  import time with e.g. `Cannot read properties of undefined (reading
  'getAppPath')`. Launch with `env -u ELECTRON_RUN_AS_NODE npm run
  electron:serve`. It's an environment issue — don't "fix" imports.
- **Editing `app/src/background.js` kills a running dev serve** — the plugin
  restarts the Electron main process on background changes, taking the
  in-memory project with it. Save a `.cdm` first (the dialog-free
  `create_saved_file` dispatch works).
- **Stale-bundle trap**: webpack recompiles on every save, but if the
  renderer (re)loads *while a compile is failing*, it keeps the last-good
  bundle even after the next successful compile. Hard-reload the renderer
  (`webContents.reloadIgnoringCache()`) after edits before trusting behavior.
  Any renderer reload also wipes the in-memory project.
- Vue devtools sometimes report "Vue not detected" on launch; open and close
  the devtools panel to fix (known `vue-cli-plugin-electron-builder` issue,
  see comment at `background.js:195-208`).
- `app/package.json` has a **duplicate `test:e2e` key**; JSON last-one-wins
  means `npm run test:e2e` runs the custom CDP runner
  (`node tests/e2e/run.js`), not the dead Cypress scaffold. Don't "fix" the
  duplicate by keeping the first one.
- **i18n is i18next** (`app/src/util/i18n.js`, shared by main + renderer;
  keys are natural-English sentences, ja falls back to en). The catalogs in
  `app/locales/` are bundled at build time and **never written at runtime** —
  after adding/changing `t()` strings run `npm run i18n:extract` explicitly
  to refresh them (dynamic keys like `t(action)` are invisible to the parser
  and survive via `keepRemoved`; see `app/i18next-parser.config.js`).

**Behavioral traps (the false-alarm generators)**

- **`analyzeModeOnly` defaults to `true` and is sticky**
  (`app/src/store/state.js:113`). Dispatching `colorize` without
  `commit('set_analyze_mode_only', false)` runs an analyze-only pass — no
  `/colorize` calls — which looks exactly like "colorize is broken".
- **The paint bucket is server-backed**: `MainPane` computes a local
  `floodFill5` preview but the committed fill comes from the segmentation
  map via `floodFill6` (`app/src/components/MainPane.vue:855,883`); with no
  server/segmap it silently no-ops.
- **Selection is dupe-linked**: `TOGGLE_FRAME_SELECTION` propagates across
  all frames sharing a drawing; one click can flip dozens of frames. Precise
  selection = the `set_frame_selected` *commit*. A saved `.cdm` also carries
  its selection state back in on load.
- **Imports**: `fileLoadingQueue` entries must be `{ path, name }` objects
  (bare strings silently import nothing); a trailing filename number lands at
  frame N+1 (`line_000.png` → frame 1); line art must contain transparent
  pixels or import is refused; importing color frames auto-analyzes them
  (server round-trip that populates the palette).
- **`SET_NEW_PROJECT` resets root state only.** Module state survives — most
  notably `ImageStore.imageDataById` accumulates records *across projects*
  (the hash-dedupe getter scans them all), as does `ToolControls`.
- **In-page dialogs eat clicks**: app error dialogs are Vue overlays
  (`app/src/components/CustomDialog.vue` via `util/customDialog.js`), and an
  open overlay silently swallows synthesized clicks. Native dialogs cannot be
  stubbed from outside (the `@electron/remote` client is bundled), which is
  why scripted entry points exist: `export_dialog({ kind, filePath })`,
  `create_saved_file({ saveFilePath })`, `load_file({ filePath })`.
- **Temp-dir lifecycle**: `tempBucketDir` is wiped wholesale on every project
  load/new — anything that must survive project switching goes beside it
  (`assetCache`). Segmaps are cached in the temp dir by a
  hash+settings-derived filename, so re-analyzing a frame legitimately skips
  `/segment`.

**Format/code quirks (locked by tests, not bugs to fix in passing)**

- The `.cdm` markers are found by first-occurrence `search`; a literal
  `BEGINSAVESTATE`/`BEGINTEMPIMAGES`/`BEGINDOCUMENT` inside the JSON would
  mis-split the file, and the metadata slice uses fragile
  `substr(firstOpen, firstClose + 1)` arithmetic — both documented and
  QUIRK-tested in `cdm-format.js`, deliberately not defended against.
- `paletteFilter` (`app/src/services/export-frame.js`) compares pixels
  through a `Uint32Array` view and is **little-endian only** — fine on every
  shipping platform, documented inherited behavior.
- `state.selectedFrame` is the **playhead**; frame selection lives on the
  frame objects (`isSelected`). The name predates the distinction.
- Several extracted planners intentionally reproduce legacy quirks
  (walk-back tiebreaks in `reference-matching.js`, dead dilation values in
  `colorize-plan.js`, the `slice(0, -4)` three-char-extension assumption in
  `export-plan.js parseExportTarget`). Their headers say so; keep the golden
  tests green.

**Tests**

- Unit: `npm run test:unit` — jest via the vue-cli preset
  (`app/jest.config.js`), specs in `app/tests/unit/` (mostly golden tests for
  the services layer plus store behavior like `undo-redo.spec.js`,
  `actions-load.spec.js`).
- E2E: `npm run test:e2e` — a custom harness (`app/tests/e2e/`, its README is
  required reading) that drives the *running* app over CDP: main-process eval
  through the node inspector (`kill -USR1 <electron pid>` → :9229),
  renderer eval via `webContents.executeJavaScript`, synthesized clicks.
  ML-dependent specs auto-skip when nothing answers on :8000. The runner
  backs up the currently open project to `.artifacts/` before wiping the
  timeline.

## 4. Remaining TODOs

Deliberate, tracked debt (in rough priority order):

- **The storage flip** — the biggest one. The v2 `.cdm` document section is
  derived-and-validated only; `state.layers` + ghosts + `saveState` remain
  the source of truth. Flipping (Document becomes primary, `saveState`
  dropped, ghost color records replaced by real Cels) is deferred on purpose
  (~100+ read-site churn, no live bug pays for it). The seam and the
  validation warning in `LOAD_FILE` (`actions.js:703-718`) are the entry
  point when it happens.
- ~~Wire the `embedded` backend~~ **DONE 2026-07-21**: `sidecar-manager.js`
  (main process) spawns/supervises the sidecar on first use — free port,
  /health-gated readiness, capped restart backoff, `--exit-on-stdin-close`
  plus a ppid watchdog in the sidecar so it dies with the app even on
  SIGKILL (an Electron-on-macOS quirk: a dead socketpair peer does not wake
  a blocked read, and writing to it can hang — the sidecar's death paths
  must never log to stderr). Status flows over `sidecar:*` IPC into the
  Settings modal. When the embedded backend is unreachable, `modal.js`
  shows the supervisor's actual failure (missing binary/models, crash
  loop) instead of the generic "No Internet Connection" dialog. Missing
  models are self-serve: the Settings modal offers a verified download
  from the `models-v1` release (`model-downloader.js`, progress over
  `sidecar:models-progress`; see `build-and-release.md` §6). Dev still
  overrides via `CADMIUM_MODELS_DIR`/`CADMIUM_SIDECAR_BIN`.
- **Build/CI/packaging/signing/releases**: see `build-and-release.md` —
  local packaged builds, the GitHub Actions pipeline, env-driven
  signing/notarization, tag-drafted releases, and model-artifact
  distribution all live there.
- **Legacy job flags**: the `*InProgress` / `*CanceledByUser` / progress keys
  still exist as JobRunner-maintained mirrors, and cancellation still bridges
  through `SET_*_CANCELED_BY_USER` commits (`CANCEL_COLORIZATION`,
  `actions.js:496`). Deleting the mirrors means porting every reader
  (waiting screens, cancel buttons, menu state) to observe the runner.
- **Dead code to remove**: `app/src/server.js` + most of
  `app/src/binaries.js` (the old spawn-a-bundled-`cadmium-server` path —
  nothing imports `startServer`/`stopServer`; the `bin/` tree it expects is
  not in the repo); `SET_TMP_IMAGE_ROOT_PATH`
  (`app/src/store/mutation-types.js:15`, self-marked "TODO: Delete");
  the stock Cypress scaffold under `tests/e2e/` (`plugins/`, `support/`,
  `specs/test.js`).
- **Small real bugs found while reading**:
  - `background.js:564` assigns an undeclared `choseToUpdate` (implicit
    global; harmless today, dead variable).
  - `loadcdm` backfill defaults disagree with `state.js` defaults for legacy
    files: `maxAiDilationSize` 30 vs 8, `maxTbDilationSize` 30 vs 1,
    `minSegSize` 1 vs 10 (`undo-redo-plugin.js:511-519` vs
    `state.js:115-118`); and `if (!newState.autoAlpha) autoAlpha = false`
    turns an absent field into `false` while a fresh app defaults to `true`.
  - `validateFrameNumber` accepts up to 1000 while the user-facing copy says
    999 (`app/src/services/import-plan.js`, documented quirk).
- **Naming/renames the code itself asks for**: `selectedFrame` → playhead
  (`state.js:35`), `SELECTED_FRAME_NR` getter likewise
  (`getter-types.js:5`); move `playerInterval` out of reactive state
  (`state.js:69`); rename `util/modal.js` to something like
  `server-client.js` to end the Modal-vs-modal confusion.
- **Long-tail inline TODOs** (grep `TODO` under `app/src`): bounds-safety in
  `getters.js:140,158`, hard-coded layer assumptions and duplicated
  mouse-move code in `MainPane.vue:990,1349`, timeline sizing
  (`TimelinePane.vue:27,618`), segmap checksum reuse
  (`util/segmentation.js:32`), dynamic pen-layer default
  (`util/KeyHandler.js:219`).
