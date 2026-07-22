// The single seam between the renderer and the Electron host.
//
// The renderer should reach Electron/IPC ONLY through this module, so the rest
// of the app stays host-agnostic and unit-testable: a test mocks '@/platform'
// instead of reaching into 'electron' / '@electron/remote'. That indirection is
// also what lets the extracted services (e.g. ColorizeService) run under jest
// without an Electron runtime.
//
// Migration is staged. Phase 1 (this module today) covers the request/response
// IPC calls, the host version read, and shell.openExternal. The fire-and-forget
// send()/on() channels and the rest of the @electron/remote surface (dialog,
// getCurrentWindow, Menu, app paths/locale) are still called directly at their
// sites; the generic send()/on()/removeAllListeners() passthroughs below exist
// so those can be routed through here and named incrementally in later phases.
//
// Every Electron access is lazy (inside a function) so importing this module
// never touches 'electron' at load time — that keeps import ordering identical
// to the pre-seam code and avoids load-order surprises under jest.

function ipcRenderer() {
  return require('electron').ipcRenderer;
}

// --- Request/response IPC (the main process replies with a value) ---

export function clearTempFiles() {
  return ipcRenderer().invoke('clear-temp-files');
}

export function getTempDir() {
  return ipcRenderer().invoke('get-temp-dir');
}

export function rebuildMenu(colorizationInProgress) {
  return ipcRenderer().invoke('rebuild-menu', colorizationInProgress);
}

// --- Preferences (persisted in the main process) ---

export function setPref(key, value) {
  ipcRenderer().send('add-pref', key, value);
}

// Asks the main process for a stored pref; the reply arrives on the
// 'pref-response' listener (see onPrefResponse).
export function requestPref(key) {
  ipcRenderer().send('get-pref', key);
}

export function loadUserPrefs() {
  ipcRenderer().send('load-user-prefs');
}

// --- Embedded sidecar backend (supervised by the main process) ---
//
// ensureSidecar spawns on first use (or returns the current outcome) and
// resolves once the sidecar is ready or has failed; pass { retry: true } to
// force a fresh attempt out of a failed state. getSidecarStatus never spawns.
// Live transitions arrive on the 'sidecar:status' channel (see
// ipc-renderer-handlers.js / util/sidecar-status.js).

export function ensureSidecar(opts) {
  return ipcRenderer().invoke('sidecar:ensure', opts);
}

export function getSidecarStatus() {
  return ipcRenderer().invoke('sidecar:status');
}

export function stopSidecar() {
  return ipcRenderer().invoke('sidecar:stop');
}

// Wipe the embedded backend's local state (models, CoreML cache, setup
// ledger, first-run decisions) and relaunch the app as a first run.
export function resetEmbeddedBackend() {
  return ipcRenderer().invoke('sidecar:reset-embedded');
}

// Model download/bootstrap into <userData>/models. Progress pushes arrive on
// 'sidecar:models-progress' (see util/model-download-status.js); the plan
// call is a side-effect-free "what would download, how many bytes" probe.

export function getModelDownloadPlan() {
  return ipcRenderer().invoke('sidecar:download-plan');
}

export function downloadModels() {
  return ipcRenderer().invoke('sidecar:download-models');
}

export function cancelModelDownload() {
  return ipcRenderer().invoke('sidecar:cancel-download');
}

export function getModelDownloadProgress() {
  return ipcRenderer().invoke('sidecar:models-progress');
}

// Machine capabilities (arch, platform, RAM, free disk, GPU) for the embedded-
// backend hardware check. Best-effort: fields the main process couldn't probe
// come back null and the evaluator treats them as "unknown".
export function getSystemCapabilities() {
  return ipcRenderer().invoke('system:capabilities');
}

// --- Temp files (tracked in the main process for cleanup) ---

export function addTempFile(filePath) {
  ipcRenderer().send('add-temp-file', filePath);
}

// Asks the main process for the tracked temp-file list; the reply arrives on
// the 'storeTempFilePaths' listener (see onStoreTempFilePaths).
export function requestTempFiles() {
  ipcRenderer().send('get-temp-files');
}

// --- App lifecycle ---

export function quit() {
  ipcRenderer().send('quit-cadmium');
}

export function installUpdate() {
  ipcRenderer().send('update-cadmium');
}

export function notifyFileTooOld() {
  ipcRenderer().send('file-too-old');
}

// --- Timeline / canvas ---

export function scrollToFrame(frameNr) {
  ipcRenderer().send('scroll-to-frame', frameNr);
}

export function cycleColorSwatch() {
  ipcRenderer().send('cycle-color-swatch-action');
}

// --- Custom dialog result (renderer replies to a main-process dialog request) ---

export function sendCustomDialogResult(result) {
  ipcRenderer().send('customDialogResult', result);
}

// --- Main-process event listeners ---
//
// These stay channel-string based on purpose: the listener registry
// (ipc-renderer-handlers.js) and a few components subscribe to many one-off
// main->renderer events, and naming a function per channel would add surface
// without removing the channel names. Routing them through here still buys the
// goal — only this module imports 'electron'.

export function subscribe(channel, listener) {
  ipcRenderer().on(channel, listener);
}

export function removeListeners(channel) {
  ipcRenderer().removeAllListeners(channel);
}

// Generic fire-and-forget escape hatch for channels not yet given a named
// wrapper above. Prefer adding a named function when a new channel appears.
export function send(channel, ...args) {
  ipcRenderer().send(channel, ...args);
}

// --- Host / system info ---
//
// The main-process app object is reached through @electron/remote. These are
// renderer-only helpers; main-process code (background.js and the modules it
// requires) uses electron.app directly and must NOT import this module.

function remoteApp() {
  return require('@electron/remote').app;
}

export function getAppVersion() {
  return remoteApp().getVersion();
}

export function getAppPath() {
  return remoteApp().getAppPath();
}

export function getUserDataPath() {
  return remoteApp().getPath('userData');
}

export function getLocale() {
  return remoteApp().getLocale();
}

export function addRecentDocument(filePath) {
  remoteApp().addRecentDocument(filePath);
}

// --- Native dialogs (parented to the current window) ---

function currentWindow() {
  return require('@electron/remote').getCurrentWindow();
}

export function showSaveDialog(options) {
  return require('@electron/remote').dialog.showSaveDialog(currentWindow(), options);
}

export function showOpenDialog(options) {
  return require('@electron/remote').dialog.showOpenDialog(currentWindow(), options);
}

// --- Context menus ---
//
// createMenu/createMenuItem hand back native remote objects; callers use the
// object's own methods (append, getMenuItemById, .checked, etc.) directly.
// popupMenu pops the given menu over the current window.

export function createMenu() {
  const { Menu } = require('@electron/remote');
  return new Menu();
}

export function createMenuItem(options) {
  const { MenuItem } = require('@electron/remote');
  return new MenuItem(options);
}

export function popupMenu(menu) {
  menu.popup({ window: currentWindow() });
}

// --- Shell ---

export function openExternal(url) {
  return require('electron').shell.openExternal(url);
}
