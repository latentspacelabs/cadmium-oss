# app/ — the Cadmium desktop app

The Electron + Vue 2.7 frontend: timeline, drawing tools, palette, `.cdm`
project files, and the client for the ML serving backend. For the full
architecture (process model, store shape, Cel/XSheet data model, `.cdm`
format, backend descriptor, quirks) read **`../docs/app.md`**. The serving
side itself is documented in `../docs/colorizer-serving.md`.

## Run in development

```bash
cd app
npm install
env -u ELECTRON_RUN_AS_NODE npm run electron:serve
```

- `ELECTRON_RUN_AS_NODE` **must be unset** — some editor-hosted shells export
  it globally, and with it set Electron boots as plain Node and the main
  process crashes at import time (`Cannot read properties of undefined
  (reading 'getAppPath')`).
- Editing `src/background.js` restarts the Electron process (the open
  project's in-memory state is lost); renderer edits hot-reload.
- The app needs a serving backend for analyze/colorize/paint-bucket. Point it
  at one via the in-app Server Settings dialog (persisted preference), or
  bake a default in with `VUE_APP_SERVER_URL` at build time; it falls back to
  `http://localhost:8000`. Drawing, timeline, save/load and export work
  offline.

## Tests

```bash
npm run test:unit     # jest — golden tests for the pure services + store logic
npm run test:e2e      # drives a RUNNING app over CDP (see tests/e2e/README.md)
```

The e2e suite requires the app already running via `electron:serve` with the
node inspector open on :9229 (`kill -USR1 <electron main pid>`); ML-dependent
specs skip automatically unless a backend answers on :8000.

## Build

```bash
npm run electron:build    # production build via electron-builder
npm run lint
```

## Layout

- `src/background.js` — Electron main process; `src/main.js` — renderer entry
- `src/store/` — Vuex root store, modules, patch-based undo/redo plugin
- `src/services/` — pure planners + executors (colorize, export, import,
  `.cdm` format, xsheet read-model, document commands, job runner, assets)
- `src/components/`, `src/views/` — UI (MainPane canvas, TimelinePane, modals)
- `src/util/` — server config/client, canvas + image helpers, i18n
- `tests/unit/`, `tests/e2e/` — jest specs; CDP-driven live suite
