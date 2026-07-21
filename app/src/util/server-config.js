/* eslint-disable */
/**
 * ML serving backend resolution for the OSS build.
 *
 * Where the app sends /colorize /segment /preprocess requests is described by
 * a "backend descriptor" persisted in local preferences:
 *
 *   serverBackend: { kind: 'hosted' | 'embedded', baseUrl: 'http://…' }
 *
 *   - 'hosted'   — a server the user runs or can reach.
 *   - 'embedded' — the app-managed local sidecar (see src/sidecar-manager.js).
 *                  Its descriptor NEVER carries a URL: the main process
 *                  allocates a free port at spawn time and the renderer learns
 *                  it over IPC ('sidecar:status' pushes / 'sidecar:ensure').
 *                  The runtime port is machine- and session-local — it is not
 *                  persisted in prefs and never reaches a .cdm file.
 *
 * The base URL is resolved at RUNTIME so pre-built binaries can be pointed at
 * any server without rebuilding. Resolution order (first wins):
 *
 *   1. `serverBackend` pref  — set via the in-app Server Settings dialog.
 *   2. Legacy `serverUrl` pref — pre-descriptor builds stored a bare string;
 *      it reads as { kind: 'hosted', baseUrl } (the main process also folds it
 *      into `serverBackend` once at startup, see background.js).
 *   3. Build-time env — `VUE_APP_SERVER_URL` (Vue inlines `VUE_APP_*` vars).
 *   4. Default — http://localhost:8000
 *
 * All three ops live on one server (`serving/local/server.py` exposes
 * /colorize /segment /preprocess). To target a remote Modal deployment where
 * each op is a separate web endpoint, set these build-time vars instead:
 *
 *   VUE_APP_COLORIZE_URL=https://<...>-colorize.modal.run/predict
 *   VUE_APP_SEGMENT_URL=https://<...>-gap-close.modal.run/segment
 *   VUE_APP_PREPROCESS_URL=https://<...>-preprocess.modal.run/preprocess
 *
 * There is no licensing proxy in OSS — the app calls the server directly.
 */

export const DEFAULT_SERVER_URL = 'http://localhost:8000';

export const BACKEND_HOSTED = 'hosted';
export const BACKEND_EMBEDDED = 'embedded';

// The preferences key the Server Settings dialog writes the descriptor to.
export const SERVER_BACKEND_PREF_KEY = 'serverBackend';
// The legacy string pref written by pre-descriptor builds.
export const SERVER_URL_PREF_KEY = 'serverUrl';

/** Trim whitespace and strip any trailing slashes so route joining is clean. */
export function normalizeServerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Coerce an arbitrary persisted value into a valid descriptor, or null. */
export function coerceServerBackend(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== BACKEND_HOSTED && raw.kind !== BACKEND_EMBEDDED) return null;
  // The embedded backend's URL exists only at runtime (the main process owns
  // the sidecar port at spawn time). Force baseUrl to '' so a stale port can
  // never be persisted or resurrected from an old pref / foreign file.
  if (raw.kind === BACKEND_EMBEDDED) return { kind: BACKEND_EMBEDDED, baseUrl: '' };
  const baseUrl = normalizeServerUrl(raw.baseUrl);
  // A hosted backend without a URL is meaningless.
  if (!baseUrl) return null;
  return { kind: raw.kind, baseUrl };
}

/** A legacy `serverUrl` string as a hosted descriptor, or null when unset. */
export function legacyServerUrlToBackend(serverUrl) {
  const baseUrl = normalizeServerUrl(serverUrl);
  return baseUrl ? { kind: BACKEND_HOSTED, baseUrl } : null;
}

/**
 * Pure resolution: descriptor pref → legacy pref → build env → default.
 * Always returns a valid descriptor.
 */
export function resolveServerBackend(
  backendPref,
  legacyServerUrlPref,
  envServerUrl = process.env.VUE_APP_SERVER_URL,
) {
  return (
    coerceServerBackend(backendPref)
    || legacyServerUrlToBackend(legacyServerUrlPref)
    || legacyServerUrlToBackend(envServerUrl)
    || { kind: BACKEND_HOSTED, baseUrl: DEFAULT_SERVER_URL }
  );
}

// Lazily-constructed, read-only preferences accessor. `get()` re-reads from
// disk on every call, so it always reflects the latest value the user saved
// (the main process is the single writer, via the `add-pref` IPC channel).
let _prefs = null;
function readPref(key) {
  try {
    // Required lazily: LocalPreferences needs @electron/remote to be ready,
    // which it is by the time any request is made from the renderer. Relative
    // path (not `@/`) because this module is also bundled into the main
    // process via background.js.
    /* eslint-disable global-require */
    const LocalPreferences = require('./local-preferences');
    if (!_prefs) {
      _prefs = new LocalPreferences({ configName: 'user-preferences', defaults: {} });
    }
    return _prefs.get(key);
  } catch (e) {
    // Preferences unavailable (e.g. not in an Electron renderer) — fall back.
    return null;
  }
}

/** The active backend descriptor (never null). */
export function getServerBackend() {
  return resolveServerBackend(
    readPref(SERVER_BACKEND_PREF_KEY),
    readPref(SERVER_URL_PREF_KEY),
  );
}

// ---------------------------------------------------------------------------
// Embedded backend runtime URL.
//
// The sidecar's port exists only while the main process runs it. The renderer
// hears about it on the 'sidecar:status' IPC push (see ipc-renderer-handlers)
// and from 'sidecar:ensure' results (see util/connectivity-checker.js, which
// gates every serving request and sets the port before any URL is built).
// Module-level, process-local, deliberately NOT persisted anywhere.

// Guaranteed-unroutable placeholder returned while the embedded backend has no
// live port yet: requests fail fast instead of silently hitting the hosted
// default on localhost:8000.
export const EMBEDDED_UNAVAILABLE_URL = 'http://127.0.0.1:0';

/** The loopback base URL for a sidecar listening on `port`. */
export function embeddedBaseUrl(port) {
  return port ? `http://127.0.0.1:${port}` : EMBEDDED_UNAVAILABLE_URL;
}

let _embeddedRuntimePort = null;

/** Record (or clear, with null) the sidecar's live port for this process. */
export function setEmbeddedRuntimePort(port) {
  _embeddedRuntimePort = port || null;
}

export function getEmbeddedRuntimePort() {
  return _embeddedRuntimePort;
}

/**
 * Pure base-URL resolution for a descriptor: hosted uses its own baseUrl,
 * embedded uses the runtime port (placeholder when the sidecar isn't up).
 */
export function resolveBackendBaseUrl(backend, embeddedPort) {
  if (backend && backend.kind === BACKEND_EMBEDDED) {
    return embeddedBaseUrl(embeddedPort);
  }
  return (backend && backend.baseUrl) || DEFAULT_SERVER_URL;
}

/** The resolved base URL all serving requests go to. */
export function getServerBaseUrl() {
  return resolveBackendBaseUrl(getServerBackend(), _embeddedRuntimePort);
}

export function getColorizeUrl() {
  return process.env.VUE_APP_COLORIZE_URL || `${getServerBaseUrl()}/colorize`;
}
export function getSegmentUrl() {
  return process.env.VUE_APP_SEGMENT_URL || `${getServerBaseUrl()}/segment`;
}
export function getPreprocessUrl() {
  return process.env.VUE_APP_PREPROCESS_URL || `${getServerBaseUrl()}/preprocess`;
}
export function getHealthUrl() {
  return `${getServerBaseUrl()}/health`;
}
