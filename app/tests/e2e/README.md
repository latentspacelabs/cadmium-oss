# Cadmium live e2e suite

Drives the **running** Cadmium app over CDP and asserts on real store state,
real synthesized clicks, and real exported files. No app instrumentation, no
GUI-automation framework.

```
npm run test:e2e              # everything runnable right now
node tests/e2e/run.js --list  # what exists
node tests/e2e/run.js --only=07
node tests/e2e/run.js --skip-ml
```

## Preconditions

1. **App running** via `npm run electron:serve` (with `ELECTRON_RUN_AS_NODE`
   unset) and the node inspector open:
   `kill -USR1 $(pgrep -f "Electron.*background" | head -1)` → :9229.
   The runner checks and explains if it can't connect.
2. **ML server** (only for `[ml]` specs — paint bucket, analyze, colorize):
   the wallace tunnel on :8000 —
   `ssh -f -N -L 8000:localhost:8000 -o ServerAliveInterval=30 wallace.tail587cf.ts.net`.
   Unreachable ⇒ ML specs are skipped, the rest still run.

The runner **backs up the currently open project** to
`.artifacts/pre-suite-backup-<stamp>.cdm` before the first reset (specs wipe
the timeline). Restore with the app's File → Open on that path. `--no-backup`
skips this.

## How it works

- `harness/cdp.js` — inspector WebSocket; main-process eval, renderer eval
  (via `webContents.executeJavaScript`), synthesized clicks
  (`sendInputEvent`).
- `harness/driver.js` — store access (`storeEval` with `s`/`g` in scope),
  dialog-free entry points, polling (`waitUntil`, `idle` on
  `currentProcessingTask`), staged numbered imports, dialog detect/dismiss.
- `harness/fixtures.js` — all PNGs generated from code (square/circle/
  triangle line art + color counterparts); byte-identical copies for dupe
  specs. Nothing binary in git.
- `run.js` — sequential runner; `resetProject()` between specs; state
  snapshot to `.artifacts/failure-*.json` on failure.

## Hard-won rules (violate these and tests hang or silently no-op)

- **Never let a native dialog open.** `@electron/remote` is bundled, so
  dialogs cannot be stubbed. Use `export_dialog({kind, filePath})`,
  `create_saved_file`, `load_file`; clear `unsavedChanges` before
  `new_project`.
- **In-page dialogs eat clicks.** The app raises its Vue `CustomDialog`
  ("No Internet Connection", import errors, …) on its own schedule; an open
  overlay swallows synthesized clicks *silently*. `clickElement` dismisses
  dialogs and verifies the hit with `elementFromPoint` first — do the same in
  new helpers.
- **Line imports need transparent pixels**; filenames need trailing frame
  numbers, which the importer **+1's** (`_000` → frame 1). `importImages`
  stages numbered copies for you.
- **Selection is dupe-linked** (`toggle_frame_selection` propagates across
  frames sharing a drawing). For precise selections use the
  `set_frame_selected` **commit**.
- **`analyzeModeOnly` is sticky and defaults to true.** Every real colorize
  must `commit('set_analyze_mode_only', false)` first.
- **The paint bucket is server-backed** (segmentation-map fill; the local
  floodFill5 result is discarded) — fill-dependent specs are `[ml]`.
- Long dispatches: `fire: true` + poll. Never await a dispatch that might
  open a dialog or run for minutes.
