# Cadmium v2 architecture — services, an exposure-sheet core, and killing the bug factories

Status: PROPOSAL (2026-07-17)

This is a ground-up rethink of the renderer architecture. It is written against the
current code (`app/src/store/actions.js` at 3,116 lines, ~95 root state keys) and the
bug history of the last few sessions, which is the best evidence we have for *where*
this codebase generates defects.

## 1. Why bugs keep happening — the five factories

Every bug we've hit recently falls into one of five structural patterns. The goal of
the redesign is to make each pattern *inexpressible*, not to patch instances of it.

### F1. Global mode flags with temporal coupling

Long-running behaviours are parameterized through root state flags set by one action
and read by another action dispatched later:

- `EXPORT_COLORS_SEPARATED` commits `exportingColorsSeparately = true`, then dispatches
  `EXPORT_DIALOG`, which reads the flag back (`actions.js:1316-1346`).
- `analyzeModeOnly` (default `true`) silently turns a `colorize` dispatch into an
  analyze-only run — the "colorize is broken" false alarm.
- Ten in-progress / canceled-by-user booleans (`colorizationInProgress`,
  `exportCanceledByUser`, …) plus `currentProcessingTask`, reset in scattered places.

**Bugs bred:** colors-separated silent no-op; analyze-only false alarm; cancellation
checks sprinkled through loops that each behave slightly differently.

### F2. Implicit image-data lifecycle

`ImageStore.imageDataById[id].dataUri` is nullable by design: ghost color frames are
created with `dataUri: null` on every line import (`actions.js:2220`), deletion nulls
the URI instead of removing the record, and nothing rehydrates from disk. Consumers
must remember to null-check; export just skips (`actions.js:1539-1540`) and writes
blank frames without comment.

**Bugs bred:** blank/line-only exports of any not-fully-hydrated project; multiple
e2e false alarms; "placeholder" semantics leaking into the timeline UI (`isPlaceholder`
= "getter returned null", conflating *no drawing* with *not loaded*).

### F3. Duplicate detection re-derived by every feature

The domain fact "these frames show the same drawing" has no home. It is recomputed
from content hashes and id equality in at least four dialects: ImageStore hash dedupe
+ refCounts, colorize's `isDupe` / `lineImageIdToColorImageIdMap` walk,
reference-matching's `framesShareImageData`, and the undo plugin's clones of all of it.
Every timeline feature pays this tax and each copy drifts independently.

**Bugs bred:** the general "constant thorn": any new timeline operation must re-invent
hold-block logic or silently do N× the work (export re-encodes identical frames today).

### F4. Orchestration blobs

`EXPORT_DIALOG`/`EXPORT_FILES` (~450 lines) interleaves: native dialogs, path planning,
per-frame canvas compositing, per-color pixel filtering, PNG/SVG/MP4 encoding, temp-file
management, progress commits, and cancellation — in one loop. `COLORIZE` (~700 lines)
does the same for ref matching, sequential propagation, server calls, palette population,
and placeholder bookkeeping. The middles are untestable, so regressions hide there.

**Bugs bred:** the R/B-swap chain took a wire-tap to find because the pipeline can't be
run headless; the empty-palette no-op lives *between* two dialogs where no test reaches.

### F5. Undo as whole-state replacement

Undo deep-clones (almost) the entire state — including the ImageStore — five levels
deep max, then `replaceState`s it back, hand-patching a `protectedStore` list of slices
that must survive (`undo-redo-plugin.js`). Any new state key is an undo bug by default
(it either gets snapshotted when it shouldn't, or clobbered when it shouldn't).

**Bugs bred:** memory ceiling (MAX_UNDO_ITEMS=5), stale in-flight fields after undo,
and a hand-maintained exclusion list that must be updated with every feature.

## 2. The core insight: Cadmium is an exposure-sheet editor

Traditional animation already solved our data-modeling problem on paper: the
**exposure sheet (x-sheet)**. Artists draw a small number of unique **drawings**; the
x-sheet maps each **frame** to the drawing it *exposes*. Holds (one drawing shown for
several frames) are not "duplicates detected by hashing" — they are the primary
structure.

Cadmium's current model inverts this: frames own `imageDataId`s, and uniqueness is
reverse-engineered via content hashes wherever someone remembers to. The fix is to
make the domain model match the domain:

```
Drawing   — unique artwork, content-addressed (id = content hash)
            derived artifacts hang off it: segmap, analysis, colorize result
Cel       — the unit of art on the timeline: { lineDrawingId, colorDrawingId | null,
            colorProvenance: 'none' | 'reference' | 'colorized' | 'painted' }
XSheet    — per-track exposure map: frameNr -> celId  (tracks: today exactly
            line+color paired; the Cel already fuses them)
Palette   — document-level list derived from analyses; persisted
Document  — { xsheet, cels, drawings(meta only), palette, canvasSize, meta }
```

What this buys, concretely:

- **Hold blocks are derived, not detected.** `holdBlocks(track)` = runs of equal celId.
  Colorize's dupe-reuse stops being an optimization pass with its own map — iterating
  *cels* instead of frames is simply the natural loop. 47 frames / 12 cels means 12
  colorize operations *by construction*.
- **Ghost color frames disappear.** Today every line import fabricates a
  `<lineId>_color` image with a null URI so the color layer has "something" —
  that entire class of null-record goes away because color is a *field of the Cel*,
  not a parallel timeline of fake images.
- **Per-drawing caches get a real key.** Segmaps, analyses, rendered export
  composites — all keyed by drawing id (which *is* the content hash).
- **Export renders per cel, writes per frame.** Identical frames cost one render.
- **`isOriginal`, `isLoading`, `isSelected` leave the document.** Selection and
  load-state are UI/runtime concerns; provenance lives on the Cel.

### 2.1 The Cel decision (DECIDED 2026-07-17)

The fused Cel bakes in today's 1:1 line↔color pairing (the two singleton layers,
`lineLayer1`/`colorLayer1`). Decision: **that pairing is a permanent assumption.**
Multi-layer compositing (multiple pairs, background/overlay tracks, multi-pass
color) is explicitly out of scope, now and later; we do not carry track plumbing,
track kinds, or schema hedges for it. The XSheet has exactly one line+color pair
and the Cel is the single unit of art on the timeline.

## 3. Target service architecture

Renderer-side, five stateful services plus the pure planners we already extracted.
Rule of thumb: **services own state and talk to each other; components and actions
only talk to services; pure planners talk to nobody.**

```
┌─────────────────────────── UI (Vue components) ───────────────────────────┐
│   reads: reactive view-models (thin Vuex/Pinia mirror of services)        │
│   writes: service commands  (no business logic in components/actions)     │
└──────┬──────────────┬──────────────┬──────────────┬──────────────┬────────┘
       │              │              │              │              │
  DocumentService  JobRunner    Orchestrators   AssetStore    Platform (exists)
  (XSheet/Cels/    (progress,   (import/colorize/ (bytes by       (electron seam)
   Palette, undo)   cancel)      export executors)  hash, tiered)
       │              │              │              │
       └──────────────┴───────┬──────┴──────────────┘
                              │
                    Pure planners (exist today):
                    colorize-plan, export-plan, import-plan,
                    reference-matching, palette-recolor, cdm-format
                              │
                        ServerClient (colorize-service.js)
```

### 3.1 DocumentService — owns the Document, commands in, events out

- Single writer. All document changes go through **commands** that produce
  forward+inverse patches (small, semantic: `setExposure`, `attachColorToCel`,
  `addPaletteColor`…).
- **Undo/redo = apply inverse patches.** No whole-state clone, no protected-slice
  list, no memory ceiling at 5. Ephemeral state can't be corrupted by undo because
  it isn't in the Document.
- Emits change events; a thin store module mirrors query results for Vue reactivity.
- Queries: `exposure(track, frameNr)`, `holdBlocks(track, range)`, `celAt(frameNr)`,
  `frameRange()`, `palette()` — the *only* dupe answers in the app (kills F3).

### 3.2 AssetStore — content-addressed bytes with a real lifecycle (kills F2)

```js
await assets.get(hash)        // Uint8Array/dataUri — hydrates from disk if evicted;
                              // THROWS AssetMissing, never returns null
await assets.put(bytes)       // -> hash (dedupe is inherent: same bytes, same hash)
assets.pin(hash) / unpin()    // e.g. current frame, ref frames
```

- Two tiers: memory LRU + temp-dir files (the existing tempBucketDir, formalized).
  Eviction writes through to disk first. `get` is async *everywhere* — consumers stop
  branching on "is it loaded"; export of a cold project just gets slower, not blank.
- Refcounting disappears (`referenceCount`, `hashDirty`, null-out-on-delete all go):
  liveness = "reachable from Document or pinned"; a mark-and-sweep GC runs off the
  Document's drawing set.

### 3.3 JobRunner — one way to run long operations (kills F1's flags)

```js
jobs.run('export', (ctx) => exportProject(plan, deps, ctx), { exclusive: true })
// ctx: { signal: AbortSignal, progress(done, total), log }
```

- Replaces `colorizationInProgress`, `exportInProgress`, `*CanceledByUser`,
  `currentProcessingTask`, `colorizationProgress`, `exportProgress`, `estTimeRemaining`
  (10+ root keys) with one observable `currentJob`.
- Cancellation = `AbortSignal`, checked at loop boundaries by the executors —
  one semantics instead of per-loop flag checks.
- UI (waiting screen, cancel button) binds to the runner, not to per-feature flags.

### 3.4 Orchestrators — plan (pure) → validate → execute (effects)

The pattern we've already proven with the planners, completed with the other half.
Each feature becomes `plan* (pure, golden-tested)` + `run* (effects, service deps
injected)` + a UI wrapper that owns *all* dialogs:

```js
// ui layer (the only place dialogs live)
async function exportFlow(kind /* 'flat' | 'colors-separated' */) {
  const plan = planExport(doc.snapshot(), { kind });       // pure
  if (plan.error) return dialogs.show(EXPORT_ERRORS[plan.error]); // e.g. EMPTY_PALETTE
  const target = await platform.showSaveDialog(…);
  if (target.canceled) return;
  await jobs.run('export', (ctx) => runExport(plan, target, { assets, doc, encoders }, ctx));
}
```

- **`runExport`**: iterates `plan.frames`, renders **per cel** via a `FrameRenderer`
  (compose background/color/line; per-color filtering is a parameter, not a state
  flag), encodes via `encoders.png|svg|mp4`, memoizes renders by
  `(celId, passIndex)`. Fully headless-testable — the e2e wire-tap archaeology of
  the last two days becomes a unit test.
- **`runColorize`**: consumes `colorize-plan`'s output per *cel*; server calls via
  ServerClient; results committed through DocumentService commands
  (`attachColorToCel`, `mergePalette(resp.palette_rgba)` — fixing the discarded
  `/preprocess` palette structurally). Sequential-ref propagation stays in the pure
  planner where it already lives.
- **`runImport`**: import-plan + AssetStore.put + `setExposure` commands. No ghost
  color images.
- Executors never open dialogs and never touch Vuex: they return typed results;
  the UI wrapper maps error codes to i18n dialogs. (The empty-palette bug becomes a
  *compile-visible* code path: `planExport` returns `{error: 'EMPTY_PALETTE'}`.)

### 3.5 State that remains outside the Document

- **Tool/viewport prefs** (pen, fill, zoom, collapse panels…): keep as today's small
  Vuex modules — they're fine.
- **Selection, playback, timeline scroll**: a `SessionState` module — *not*
  persisted. Exception (DECIDED 2026-07-19): frame selection *is* undoable —
  in this app selection is the operand of colorize/delete and one dupe-linked
  click can flip dozens of frames, so ⌘Z must walk it back. The undo plugin
  coalesces consecutive selection actions into one item and filters its
  patches to `isSelected` ops only. Playback/scroll stay non-undoable.
- **Persistence**: `cdm-format` grows a v2 payload = serialized Document + drawing
  bytes from AssetStore (with v1→v2 migration on load: pair up `_color` ghosts,
  reconstruct cels from hash-equality one last time, then never hash-match again).

  **Landed (phase 6b), interim shape.** v2 is an APPENDED section, not a
  container reshape, so v1 stays byte-for-byte:
  `<metadata>BEGINSAVESTATE<saveState>BEGINTEMPIMAGES<tempImages>BEGINDOCUMENT<document>`.
  The `document` is `{ canvasSize, palette, cels:[{id,lineImageId,colorImageId,
  colorProvenance}], exposures:{line:{frameNr:celId}, color:{…}}, firstReal,
  lastReal }`, DERIVED from the legacy save-state at save time via `xsheet.celAt`
  (holds deduped into cels). The legacy `saveState` is still written in full and
  remains the LOAD source of truth; the document section is forward-looking + the
  FLIP SEAM: `LOAD_FILE` hydrates from `saveState` exactly as today, then (dev
  mode) validates the document derived from the loaded state against the saved
  section (`validateDocument`), warning on drift. A future phase flips storage —
  the document becomes the source, `saveState` is dropped. v1 files (no
  BEGINDOCUMENT) load unchanged; their migration is "derive the document on the
  next save". Marker-collision fragility has parity with the two original markers
  (locked by a QUIRK test, not defended).

- **Ghost color images (F2) — investigated, KEPT; landmine defused.** Phase 6b
  audited dropping the `<lineId>_color` blank record fabricated on every line
  import. The document / export / save / timeline consumers are all null-safe,
  and the color-selected getters' LINE-layer fallback (which would have made
  paint-bucket / freehand-draw overwrite line art on an id-less color cel) has
  since been REMOVED (they return null; callers' `!imageId` branches store a
  fresh image — locked by getters-color-image.spec.js). But the post-review
  analysis found the ghost id is genuinely load-bearing beyond that: every
  frame of a hold block points at the SAME `<lineId>_color` record, so painting
  any frame of a hold propagates to the whole block — correct exposure-sheet
  semantics implemented through the shared record. Replacing that with
  per-frame fresh images would silently break hold-paint propagation.
  **Conclusion: ghost elimination is not a cleanup, it is part of the storage
  flip** — only a real Cel entity (paint targets the cel, exposures share it)
  can carry those semantics without the fake record. Until then the ghosts
  stay, and their externals are already neutralized: the derived v2 document
  ignores byte-less records (provenance 'none'), the asset disk tier refuses
  them, and the getters no longer leak line ids.

## 4. Migration plan — strangler, each phase shippable and e2e-verifiable

The order is chosen so every phase deletes a bug factory while the app keeps working.

| Phase | What | Kills | Size |
|---|---|---|---|
| 1 | **XSheetView read-model**: pure selectors over current Vuex state exposing `holdBlocks/celAt/framesShareDrawing`; port all dupe/dedupe *queries* (colorize isDupe walk, reference-matching input prep, export loop) to it | F3 (read side) | S — no state shape change |
| 2 | **AssetStore facade** wrapping ImageStore: async `get` with temp-dir hydration; convert export + colorize reads; timeline placeholder logic distinguishes "no drawing" from "not loaded" | F2 | M |
| 3 | **JobRunner**: port export/colorize/analyze/import progress+cancel to it; delete the flag constellation (mirror `currentJob` into a tiny store module for UI) | F1 | M |
| 4 | **Export orchestrator**: `planExport` (extend existing export-plan) + `FrameRenderer` + `runExport`; `EXPORT_DIALOG`/`EXPORT_FILES` shrink to the UI wrapper; per-cel render memoization; fix empty-palette and cold-asset bugs *here, structurally* | F4 (export) | M–L |
| 5 | **Colorize orchestrator**: same treatment for COLORIZE/ANALYZE; palette merge from `/preprocess` responses; placeholder bookkeeping replaced by Cel provenance | F4 (colorize) | L |
| 6a | **Patch-based undo** (LANDED): `state-patch.js` — forward+inverse patches replace the whole-state clone plugin | F5 | M |
| 6b | **DocumentService command layer + cdm v2** (LANDED): named write commands (`document.js`) over the existing Vuex mutations; the URI_CHANGE_COLOR write-side dupe walk ported to `xsheet.uniqueDrawings` + a command; cdm v2 serializes the derived exposure-sheet document with a validation seam. **Scope note: the full storage flip (replacing `state.layers` with a Document object) is DEFERRED** — F1–F5 were already dead after P1–P6a, so the flip is 100+ read-site churn for no bug payoff. The flip seam is recorded in `cdm-format.js`: v2 files carry the derived document, `LOAD_FILE` validates it against the loaded state, and a future phase makes it the source of truth and drops `saveState`. | F3 (write side); ghosts investigated (kept — see below) | M |

Notes:

- Phases 1–3 are pure enablers and can be parallelized across agents; 4 and 5 each
  depend on 1–3 but not on each other; 6 comes last.
- Every phase keeps the existing golden tests green and adds its own; phases 4–6 get
  a headless pipeline test (renderer-free `runExport`/`runColorize` with fake deps) —
  the class of test we could not write until now.
- The two open export bugs (empty-palette no-op, cold-asset blank frames) are fixed
  *by* phases 2+4 rather than patched beforehand; if we want the band-aid earlier we
  can cherry-pick a guard, but the plan treats them as acceptance criteria for phase 4:
  "colors-separated export of a freshly-loaded project produces N correct passes or a
  typed error dialog — never a silent no-op, never blank frames."

## 5. Thought exercise: the big three, rewritten

Assume every component from §3 exists. What do today's monsters actually look like?
Conventions used below:

- `doc` = DocumentService, `assets` = AssetStore, `jobs` = JobRunner,
  `server` = ServerClient, `dialogs` = the one UI module allowed to open dialogs.
- Executors (`run*`) receive `ctx = { signal, progress }` from JobRunner and throw
  `ctx.signal.aborted` early-exits; they never touch dialogs, Vuex, or Electron.
- Planners (`plan*`) are pure: `(documentSnapshot, options) -> plan | { error }`.
  A `plan` is inspectable data — the tests assert on plans, not on side effects.

### 5.1 Import

Today: two interleaved loops in `ADD_IMAGES_TO_TIMELINE` (~300 lines) — file IO,
frame-number parsing, canvas-fit math, ghost color-frame fabrication, auto-analyze
of imported color frames, progress, and an error dialog per failure mode.

```js
// ui/flows/import.js — the only layer that sees dialogs and file pickers
async function importFlow(layerKind /* 'line' | 'color' */) {
  const files = await platform.showOpenDialog(IMAGE_FILTERS);
  if (files.canceled) return;

  const plan = planImport(doc.snapshot(), { files: files.entries, layerKind });
  if (plan.error) return dialogs.show(IMPORT_ERRORS[plan.error]); // BAD_FRAME_NR, TOO_BIG, …
  if (plan.canvasFit.needsResize && !(await dialogs.confirm(RESIZE_PROMPT(plan.canvasFit)))) return;

  await jobs.run('import', (ctx) => runImport(plan, { doc, assets, server }, ctx));
}

// services/import/run-import.js — effects, headless-testable
async function runImport(plan, { doc, assets, server }, ctx) {
  for (const [i, item] of plan.items.entries()) {          // {file, frameNr, transform}
    ctx.signal.throwIfAborted();
    const bytes  = await platform.readFile(item.file.path);
    const fitted = await renderToCanvasSize(bytes, plan.canvasFit, item.transform);
    const hash   = await assets.put(fitted);

    // One command per item; identical bytes -> identical hash -> identical drawing.
    // No ghost color image is created — a Cel without color is just that.
    doc.apply(
      plan.layerKind === 'line'
        ? cmd.exposeLineDrawing({ frameNr: item.frameNr, drawing: hash })
        : cmd.attachColorToCel({ frameNr: item.frameNr, drawing: hash, provenance: 'reference' }),
    );
    ctx.progress(i + 1, plan.items.length);
  }

  // Color imports become references: analyze them (palette + preprocessed render).
  if (plan.layerKind === 'color') {
    for (const celId of doc.celsWithProvenance('reference', plan.frameNrs)) {
      await analyzeCel(celId, { doc, assets, server }, ctx);   // shared with §5.2
    }
  }
  return { imported: plan.items.length };
}
```

What disappeared: the `{path, name}`-shape trap (planner validates and types the
queue), the `<lineId>_color` ghost images, the duplicated frame-number/canvas-fit
logic (already pure in import-plan), and the mid-loop dialog (`Image Import Failed`
is now the UI wrapper catching a typed `ImportError` with the failing item attached).

### 5.2 Colorize (and Analyze, which stops being a mode)

Today: `COLORIZE` is ~700 lines: the `analyzeModeOnly` flag flips its meaning; ref
selection, in-between sequential refs, and the `isDupe` walk are interleaved with
server calls, palette population, placeholder frames, cancellation checks and four
dialogs.

```js
// ui/flows/colorize.js
async function colorizeFlow() {
  const plan = planColorize(doc.snapshot(), { targets: session.selectedFrameNrs });
  if (plan.error) return dialogs.show(COLORIZE_ERRORS[plan.error]); // NO_REFERENCE, REF_LINE_MISSING, …
  await jobs.run('colorize', (ctx) => runColorize(plan, { doc, assets, server }, ctx));
}

async function analyzeFlow() {   // its own verb — no analyzeModeOnly flag anywhere
  const plan = planAnalyze(doc.snapshot(), { targets: session.selectedFrameNrs });
  if (plan.error) return dialogs.show(ANALYZE_ERRORS[plan.error]);
  await jobs.run('analyze', (ctx) => runAnalyze(plan, { doc, assets, server }, ctx));
}

// services/colorize/run-colorize.js
//
// plan.ops is per-CEL and already ordered by the pure planner
// (colorize-plan.js: ref choice, sequential propagation, in-between refs).
// Frames never appear here — a 47-frame timeline with 12 cels yields 12 ops,
// and "dupe reuse" is not a code path, it's the shape of the plan.
async function runColorize(plan, { doc, assets, server }, ctx) {
  const colorized = new Map();                      // celId -> colorDrawingHash (this run)

  for (const [i, op] of plan.ops.entries()) {       // {celId, refCelId, settings}
    ctx.signal.throwIfAborted();

    const segMap = await segMapFor(op.celId, { doc, assets, server });      // cached by
    const refSeg = await segMapFor(op.refCelId, { doc, assets, server });   // drawing hash

    const ref = doc.cel(op.refCelId);
    const refColor = colorized.get(op.refCelId) ?? ref.colorDrawingId;      // sequential chain

    const result = await server.colorize({
      targetLine:  await assets.get(doc.cel(op.celId).lineDrawingId),
      targetSeg:   segMap,
      refSeg,
      refColor:    await assets.get(refColor),
      settings:    op.settings,
    });

    const rendered = await renderColorizedFrame(segMap, result.targetColorsRgba);
    const hash = await assets.put(rendered);
    colorized.set(op.celId, hash);

    doc.apply(cmd.batch([                            // one undo step per cel, or wrap the
      cmd.attachColorToCel({ celId: op.celId, drawing: hash, provenance: 'colorized' }),
      cmd.mergePalette(result.palette),              // /preprocess palette no longer discarded
    ]));
    ctx.progress(i + 1, plan.ops.length);
  }
  return { cels: plan.ops.length };
}

// analyzeCel: segMapFor(cel) -> server.preprocess -> cmd.mergePalette
//             + cmd.attachColorToCel(preprocessed render, provenance: 'reference')
// runAnalyze is a loop of analyzeCel; runImport (§5.1) calls the same function.
```

What disappeared: `analyzeModeOnly` (analyze is a different verb calling a shared
helper), placeholder `_color` images and their `isLoading` bookkeeping (the timeline
shows "colorizing…" by observing the job + plan, not by faking document data),
`lineImageIdToColorImageIdMap` and the isDupe walk (cels), `searchNewPalette`
(palette merge is idempotent), and all four mid-loop dialogs (planner errors).
The undo story also collapses: today COLORIZE snapshots the entire state before
running; here each cel commit is a small patch, so *cancel* keeps finished cels and
*undo* is exact.

### 5.3 Export

Today: `EXPORT_COLORS_SEPARATED` sets a flag read by `EXPORT_DIALOG`, which loops
`EXPORT_FILES` once per palette color (zero times on an empty palette — the silent
no-op), and `EXPORT_FILES` composites/encodes/writes with cancellation checks at
four depths, including a callback-pyramid SVG path.

```js
// ui/flows/export.js
async function exportFlow(kind /* 'flat' | 'colors-separated' */) {
  const plan = planExport(doc.snapshot(), { kind, session: session.viewState() });
  if (plan.error) return dialogs.show(EXPORT_ERRORS[plan.error]);
  // EMPTY_PALETTE, NO_FRAMES, NO_VISIBLE_LAYERS — surfaced BEFORE any file dialog.

  const target = await platform.showSaveDialog(EXPORT_FILTERS);
  if (target.canceled) return;
  const format = parseExportTarget(target.filePath);              // export-plan.js, as-is
  const svgOptions = format.ext === 'svg' ? await dialogs.svgQuality() : null;
  if (svgOptions?.canceled) return;

  await jobs.run('export', (ctx) =>
    runExport(plan, { ...format, svgOptions }, { doc, assets, encoders }, ctx));
}

// services/export/run-export.js
async function runExport(plan, target, { doc, assets, encoders }, ctx) {
  const encoder = encoders[target.ext];                 // png | svg | mp4, one interface
  const render  = memoize(                              // ← the whole dupe story of export
    (celId, pass) => renderCel(doc.cel(celId), pass, { assets, plan }),
    (celId, pass) => `${celId}:${pass?.index ?? 'flat'}`,
  );

  let done = 0;
  const total = plan.passes.length * plan.frames.length;
  for (const pass of plan.passes) {                     // flat: 1 pass; separated: palette.length
    await platform.mkdir(pass.folder);                  // colorPassPaths(), as-is
    const sink = await encoder.open(pass, plan);        // mp4: temp frames + ffmpeg on close
    for (const frame of plan.frames) {                  // {frameNr, celId | null, stem}
      ctx.signal.throwIfAborted();
      const image = frame.celId ? await render(frame.celId, pass)   // assets.get inside —
                                : blankFrame(plan.canvasSize);      // cold project hydrates,
      await sink.write(frame, image);                               // never exports blank
      ctx.progress(++done, total);
    }
    await sink.close();
  }
  return { files: total, folder: target.folder };
}

// renderCel: compose(background?, colorDrawing → paletteFilter(pass)?, lineDrawing?)
// paletteFilter is today's pixel loop (actions.js:1544-1580) as a pure function
// with its own golden test; passes carry the palette snapshot from the plan.
```

What disappeared: the `exportingColorsSeparately` flag and the two-action relay
(`kind` is an argument), the zero-pass silent no-op (typed plan error), blank frames
from cold assets (`assets.get` hydrates or throws), re-encoding identical frames
(`render` is memoized per cel × pass — a 47-frame/12-cel timeline does 12 composites
per pass), per-format special cases in the loop (encoder interface; the SVG callback
pyramid becomes `encoders.svg`), and four flavors of cancellation flag (one signal).

Worth noticing across all three sketches: **the same five names keep appearing**
(`plan*`, `run*`, `doc.apply(cmd.*)`, `assets.get/put`, `ctx.signal/progress`) —
that convergence, not the line counts, is the argument that these are the right
abstractions. Each flow is ~30 lines of UI wrapper + ~40 lines of executor, and
every line of tricky logic left standing is in a pure, separately-tested module.

## 6. What we explicitly do NOT do

- No framework migration (stay Vue 2.7 + Vuex; Pinia/Vue3 is orthogonal and can ride
  on the thin mirror later).
- No main-process redesign (the platform seam already isolates it).
- No server API redesign; ServerClient stays as-is (though `runColorize` stops
  discarding `palette_rgba`).
- No big-bang rewrite of actions.js: it shrinks phase by phase until what remains is
  UI glue that belongs in components/flows.
