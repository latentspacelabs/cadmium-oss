/* eslint-disable */
/* global __static */

// Electron imports
import {
  app, protocol, BrowserWindow, Menu, ipcMain, Notification,
} from 'electron';
// Using custom createProtocol with font MIME type support instead of the one from
// vue-cli-plugin-electron-builder, which doesn't set MIME types for .woff, .woff2, .ttf, .eot
import createProtocol from './customProtocol';
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer';
import { autoUpdater } from "electron-updater";
import { initialize as initializeRemote, enable as enableRemote } from '@electron/remote/main';

// Utility imports
import path from 'path';
import fs from 'fs';
const createTextVersion = require("textversionjs");
const { clipboard } = require('electron');

// Sentry error tracking
import * as Sentry from '@sentry/electron';
import { init } from '@sentry/electron/dist/main';

// Local utility imports
import { t, menuSetLocale } from './util/i18n';
import { logError } from './util/error-util';
import { mainMenuFactory, rebuildMenu } from './menu';
import { getInstance } from './util/TempFileManager';
import { showDialogFromMain, initializeDialogHandler } from './util/mainProcessDialog.js';

import { isProduction } from './util/app-util';
import { legacyServerUrlToBackend, SERVER_BACKEND_PREF_KEY } from './util/server-config';
import { createSidecarManager } from './sidecar-manager';
import {
  LEDGER_FILE, manifestHash, decideLaunch, stampUpdatingTo,
  filesNeedingVerification, recordVerification,
} from './util/setup-ledger-core';
import { MODEL_FILES } from './util/model-manifest';
import { resolveServingProfile } from './util/serving-profile';
import { planQuarantine, ORPHAN_DIR } from './util/model-hygiene-core';

// Local storage
const LocalPreferences = require('./util/local-preferences.js');

// Global variables
let stashFilePaths = [];
let isReady = false;
const tempFileManager = getInstance();
const isDevelopment = process.env.NODE_ENV !== 'production';
autoUpdater.autoDownload = false;

// initialize @electron/remote
initializeRemote();

// if mac
if (process.platform == 'darwin') {
  // DISABLE DEFAULT MAC-OSX MENU ITEMS
  const { systemPreferences } = require('electron');
  systemPreferences.setUserDefault('NSDisabledDictationMenuItem', 'boolean', true);
  systemPreferences.setUserDefault('NSDisabledCharacterPaletteMenuItem', 'boolean', true);
}

if (process.platform == 'win32') {
  console.log('windows OS');
}

// OSS: error-reporting telemetry (Sentry) disabled.

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on('second-instance', (event, commandLine) => {
    // Someone tried to run a second instance. Focus our window and open the
    // file they passed — but only if the window already exists (this can fire
    // before createWindow() during startup, where `win` is still undefined).
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send('openFile', commandLine[3]);
    }
  })
}
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win;

const localprefs = new LocalPreferences({
  // We'll call our data file 'user-preferences'
  configName: 'user-preferences',
  defaults: {
    // 1400x1024 is the default size of our window
    windowBounds: { width: 1400, height: 1024 },
    // ML serving backend descriptor { kind, baseUrl } (null => fall back to
    // build-time env / localhost:8000). Set at runtime via the in-app Server
    // Settings dialog. See util/server-config.js.
    serverBackend: null,
    // Legacy string form of the above, kept for migration of old installs.
    serverUrl: '',
    selectedColor: '#9834d3',
    reservedColor: '#000000',
    penToolMode: 'draw',
    brushSize: 10,
    eraserSize: 10,
    drawMode: 'source-over',
    drawModePrevious: 'destination-over',
    pressure: true,
    fillMode: 'fill',
    fillMethod: true,
    fillToolRange: '140',
    backgroundColor: '#ffffff',
  }
});

// One-time migration: fold the legacy `serverUrl` string pref into the
// backend descriptor pref (see util/server-config.js).
if (!localprefs.get('serverBackend')) {
  const migrated = legacyServerUrlToBackend(localprefs.get('serverUrl'));
  if (migrated) {
    localprefs.set('serverBackend', migrated);
  }
}

// --- Setup ledger: install identity (docs/serving-setup-design.md, Ph. 3) --
// Pure decisions in util/setup-ledger-core.js; this is the fs/pref shell.

function ledgerPath() {
  return path.join(app.getPath('userData'), LEDGER_FILE);
}

function readSetupLedger() {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  } catch (e) {
    return null; // absent or unreadable — decideLaunch treats both as "no ledger"
  }
}

function writeSetupLedger(ledger) {
  try {
    const stamped = { ...ledger, updatedAt: new Date().toISOString() };
    fs.writeFileSync(ledgerPath(), `${JSON.stringify(stamped, null, 2)}\n`);
  } catch (e) {
    console.error('[setup-ledger] write failed:', e);
  }
}

// An in-place update brought a manifest that wants new/changed model files —
// say so (never silent, never a surprise download); click opens Server
// Settings, whose download button + missingAccel hints carry the remediation.
function notifyModelsChanged() {
  try {
    const n = new Notification({
      title: t('Cadmium update'),
      // eslint-disable-next-line max-len
      body: t('This update includes new model files. Open Server Settings to download them.'),
    });
    n.on('click', () => {
      if (win && win.webContents) win.webContents.send('show-server-settings', true);
    });
    n.show();
  } catch (e) {
    console.error('[setup-ledger] notification failed:', e);
  }
}

/**
 * Reconcile install identity at launch (called from 'ready', BEFORE the
 * window exists, so a first-run reset lands before the renderer asks for its
 * prefs). Out-of-band installs — a version change with no updater stamp —
 * reset the first-run decisions (backend choice, welcome flag) and rerun
 * onboarding; model files stay (content-addressed cache, re-verified by the
 * download plan). In-app updates ('updatingTo' stamped by 'update-cadmium')
 * stay seamless.
 */
function reconcileInstallState() {
  const decision = decideLaunch({
    ledger: readSetupLedger(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    hasBackendPref: !!localprefs.get(SERVER_BACKEND_PREF_KEY),
    currentManifestHash: manifestHash(MODEL_FILES),
  });
  console.log(`[setup-ledger] launch decision: ${decision.action}`);
  if (decision.resetFirstRun) {
    console.log('[setup-ledger] out-of-band install — resetting first-run state');
    localprefs.set(SERVER_BACKEND_PREF_KEY, null);
    localprefs.set('welcomeModalShown', false);
  }
  if (decision.writeLedger) writeSetupLedger(decision.writeLedger);
  if (decision.manifestChanged) {
    // Compiled-model caches are keyed to model bytes we can't fully trust
    // (the gap bucket has no CACHE_KEY yet) — wipe on manifest change. Cost:
    // one background recompile behind the "Optimizing…" chip.
    wipeCoremlCache();
    notifyModelsChanged();
  }
  // Models-dir hygiene: quarantine junk now; the deep sha verification runs
  // async after the window is up (verifyModelShasOnce).
  if (app.isPackaged) quarantineModelOrphans();
}

// --- Models-dir hygiene (docs/serving-setup-design.md, Phase 5) -----------

// Move unknown/wrong-size files out of the models dir into .orphaned/
// (recoverable; the download plan re-fetches anything the profile wants).
// Packaged only — dev model dirs are hand-managed.
function quarantineModelOrphans() {
  const { modelsDir } = getSidecarManager().paths;
  let entries = [];
  try {
    entries = fs.readdirSync(modelsDir, { withFileTypes: true }).map((d) => {
      let size = null;
      if (d.isFile()) {
        try { size = fs.statSync(path.join(modelsDir, d.name)).size; } catch (e) { size = null; }
      }
      return {
        name: d.name,
        isDirectory: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
        size,
      };
    });
  } catch (e) {
    return; // no models dir yet — nothing to clean
  }
  const doomed = planQuarantine({
    entries,
    profileModels: resolveServingProfile(process.platform).models,
  });
  if (!doomed.length) return;
  const orphanDir = path.join(modelsDir, ORPHAN_DIR);
  try { fs.mkdirSync(orphanDir, { recursive: true }); } catch (e) { return; }
  doomed.forEach((name) => {
    try {
      fs.renameSync(path.join(modelsDir, name), path.join(orphanDir, `${Date.now()}-${name}`));
      console.log(`[model-hygiene] quarantined ${name}`);
    } catch (e) {
      console.error('[model-hygiene] quarantine failed:', e);
    }
  });
}

function wipeCoremlCache() {
  const { coremlCacheDir } = getSidecarManager().paths;
  try {
    fs.rmSync(coremlCacheDir, { recursive: true, force: true });
    console.log('[model-hygiene] CoreML cache cleared (model manifest changed)');
  } catch (e) {
    console.error('[model-hygiene] cache wipe failed:', e);
  }
}

function sha256FileMatches(p, expected) {
  return new Promise((resolve) => {
    try {
      const hash = require('crypto').createHash('sha256');
      const stream = fs.createReadStream(p);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex') === expected));
      stream.on('error', () => resolve(false));
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * sha-verify-on-reuse (async, after the window exists — never blocks
 * startup): fully hash any profile model on disk with no memoized pass for
 * its current (size, mtime) — i.e. files that appeared outside the
 * downloader, which verifies its own streams. Pass → memoized in the setup
 * ledger; fail → quarantined (the download plan re-fetches). ~5s/GB, once.
 */
async function verifyModelShasOnce() {
  if (!app.isPackaged) return;
  const { modelsDir } = getSidecarManager().paths;
  let diskFiles = [];
  try {
    diskFiles = fs.readdirSync(modelsDir, { withFileTypes: true })
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => {
        try {
          const st = fs.statSync(path.join(modelsDir, d.name)); // follows links
          return {
            file: d.name, size: st.size, mtimeMs: st.mtimeMs, isSymlink: d.isSymbolicLink(),
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return;
  }
  const todo = filesNeedingVerification({
    diskFiles,
    profileModels: resolveServingProfile(process.platform).models,
    verified: (readSetupLedger() || {}).verified,
  });
  for (const item of todo) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await sha256FileMatches(path.join(modelsDir, item.file), item.sha256);
    const ledger = readSetupLedger() || {};
    if (ok) {
      writeSetupLedger({
        ...ledger,
        verified: recordVerification(ledger.verified, item.file, item),
      });
      console.log(`[model-hygiene] sha256 verified ${item.file}`);
    } else {
      try {
        const orphanDir = path.join(modelsDir, ORPHAN_DIR);
        fs.mkdirSync(orphanDir, { recursive: true });
        fs.renameSync(path.join(modelsDir, item.file), path.join(orphanDir, `badsha-${item.file}`));
        console.error(`[model-hygiene] sha256 MISMATCH — quarantined ${item.file}`);
      } catch (e) {
        console.error('[model-hygiene] quarantine failed:', e);
      }
    }
  }
}

// Initialize the dialog handler
initializeDialogHandler();

// Scheme must be registered before the app is ready
// Register the 'app' scheme with all privileges needed for asset loading
// supportFetchAPI and corsEnabled are important for font loading via @font-face
protocol.registerSchemesAsPrivileged([{ 
  scheme: 'app', 
  privileges: { 
    secure: true, 
    standard: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  } 
}]);

function createWindow() {
  // Create the browser window.
  let { width, height } = localprefs.get('windowBounds');
  win = new BrowserWindow({
    width,
    height,
    minWidth: 875,
    minHeight:700,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false, // Needed to load model files. Maybe there is a better wat? See https://stackoverflow.com/questions/41130993/electron-not-allowed-to-load-local-resource/51734364
      // devTools: false,
    },
    icon: path.join(__static, 'icon.png'),
  });
  // enable @electron/remote on this window
  enableRemote(win.webContents);
  win.webContents.once('dom-ready', () => {
    if (localprefs.get('backgroundColor')){
      win.webContents.send('loadBackgroundColor', localprefs.get('backgroundColor'));
    }
    if (localprefs.get('selectedColor')){
      win.webContents.send('loadSelectedColor', localprefs.get('selectedColor'));
    }
    if (localprefs.get('reservedColor')){
      win.webContents.send('loadReservedColor', localprefs.get('reservedColor'));
    }
    if (localprefs.get('penToolMode')){
      win.webContents.send('loadPenToolMode', localprefs.get('penToolMode'));
    }
    if (localprefs.get('brushSize')){
      win.webContents.send('loadBrushSize', localprefs.get('brushSize'));
    }
    if (localprefs.get('eraserSize')){
      win.webContents.send('loadEraserSize', localprefs.get('eraserSize'));
    }
    if (localprefs.get('drawMode')){
      win.webContents.send('loadDrawMode', localprefs.get('drawMode'));
    }
    if (localprefs.get('drawModePrevious')){
      win.webContents.send('loadDrawModePrevious', localprefs.get('drawModePrevious'));
    }
    if (localprefs.get('pressure')){
      win.webContents.send('loadPressure', localprefs.get('pressure'));
    }
    if (localprefs.get('fillMode')){
      win.webContents.send('loadFillMode', localprefs.get('fillMode'));
    }
    if (localprefs.get('fillMethod')){
      win.webContents.send('loadFillMethod', localprefs.get('fillMethod'));
    }
    if (localprefs.get('fillToolRange')){
      win.webContents.send('loadFillToolRange', localprefs.get('fillToolRange'));
    }
  });

  if (process.env.WEBPACK_DEV_SERVER_URL) {
    // Load the url of the dev server if in development mode
    win.loadURL(process.env.WEBPACK_DEV_SERVER_URL);
    if (!process.env.IS_TEST) {
      // win.webContents.openDevTools()
      /*
       * vue-cli-plugin-electron-builder has a bug which prevents the vue dev tools from working
       * unless the dev tools are opened and closed again.
       * The following (hacky) fix makes this a bit less annoying.
       * Adapted from https://github.com/nklayman/vue-cli-plugin-electron-builder/issues/268#issuecomment-518201848
      */
      const openVueDevTools = () => {
        win.webContents.devToolsWebContents.executeJavaScript(
          'DevToolsAPI.showPanel("chrome-extension://vue-js-devtoolsVue")',
        );
      };
      win.webContents.once('dom-ready', () => {
        win.webContents.openDevTools();
      });
    }
  } else {
    createProtocol('app');
    // Load the index.html when not in development
    win.loadURL('app://./index.html');
  }

  win.on('closed', async () => {
    console.log('CLOSED');
    win = null;
    isReady = false;
  });

  win.on('resize', () => {
    let { width, height } = win.getBounds();
    localprefs.set('windowBounds', { width, height });
  });

  win.webContents.on("did-finish-load", () => {
    if (process.argv.length >= 1 && process.argv[1] != 'dist_electron') {
      // console.log('LAUNCH ARGUMENTS', process.argv);
      win.webContents.send("openFile", process.argv[1]);
    }
    while (stashFilePaths.length) {
      const pathToOpen = stashFilePaths.pop();
      win.webContents.send("openFile", pathToOpen);
    }
  });

isReady = true;
}

// --- Embedded serving backend (the Rust sidecar) ---------------------------
//
// Created lazily and SPAWNED only via ensureStarted() — first use of the
// embedded backend, never app launch. The renderer reaches it through the
// sidecar:* IPC channels below; status transitions are pushed to the window.
let sidecarManager = null;
function getSidecarManager() {
  if (!sidecarManager) {
    sidecarManager = createSidecarManager({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      onStatus: (status) => {
        if (win && win.webContents) win.webContents.send('sidecar:status', status);
      },
    });
  }
  return sidecarManager;
}

// Spawn if needed and resolve with the outcome (ready or failed).
ipcMain.handle('sidecar:ensure', (event, opts) => {
  return getSidecarManager().ensureStarted(opts || {});
});

// Status snapshot — never spawns. Also kicks a background /health re-poll so
// the acceleration report stays live (a change pushes 'sidecar:status').
ipcMain.handle('sidecar:status', () => {
  const manager = getSidecarManager();
  manager.refreshHealth().catch(() => {});
  return manager.getStatus();
});

ipcMain.handle('sidecar:stop', () => {
  // Don't lazily create a manager just to stop nothing.
  return sidecarManager ? sidecarManager.stop() : null;
});

// "Reset embedded backend…" (docs/serving-setup-design.md, Phase 5): wipe
// the embedded backend's local state — models, CoreML cache, setup ledger,
// first-run decisions — then relaunch so the reconciler + first-run flow
// rebuild from scratch. The recoverable escape hatch for any weird state.
ipcMain.handle('sidecar:reset-embedded', async () => {
  console.log('[reset-embedded] wiping embedded backend state');
  try {
    if (sidecarManager) await sidecarManager.stop();
  } catch (e) {
    console.error(e);
  }
  const { paths } = getSidecarManager();
  // Only ever delete dirs under our own userData — a dev CADMIUM_MODELS_DIR
  // override points at hand-managed files and must never be rm'd.
  const userData = app.getPath('userData');
  [paths.modelsDir, paths.coremlCacheDir]
    .filter((dir) => dir && dir.startsWith(userData))
    .forEach((dir) => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error(e); }
    });
  try { fs.rmSync(ledgerPath(), { force: true }); } catch (e) { console.error(e); }
  localprefs.set(SERVER_BACKEND_PREF_KEY, null);
  localprefs.set('welcomeModalShown', false);
  app.relaunch();
  app.exit(0);
  return null;
});

// --- Model download/bootstrap (fills <userData>/models from the manifest) --
let modelDownloader = null;
function getModelDownloader() {
  if (!modelDownloader) {
    // eslint-disable-next-line global-require
    const { createModelDownloader } = require('./model-downloader');
    modelDownloader = createModelDownloader({
      modelsDir: getSidecarManager().paths.modelsDir,
      onProgress: (progress) => {
        if (win && win.webContents) win.webContents.send('sidecar:models-progress', progress);
      },
    });
  }
  return modelDownloader;
}

// What a download would fetch right now (files + total bytes) — never starts.
ipcMain.handle('sidecar:download-plan', () => {
  const plan = getModelDownloader().plan();
  return {
    files: plan.map((p) => ({ file: p.file, bytes: p.bytes })),
    totalBytes: plan.reduce((sum, p) => sum + p.bytes, 0),
  };
});

// Start (or join) a download run; resolves with the terminal snapshot. On
// success, poke the supervisor — its failed-missing state self-clears once
// the files exist, so the sidecar comes up without further user action.
ipcMain.handle('sidecar:download-models', async () => {
  const result = await getModelDownloader().start();
  if (result.state === 'done') {
    try { await getSidecarManager().ensureStarted(); } catch (e) { console.error(e); }
  }
  return result;
});

ipcMain.handle('sidecar:cancel-download', () => {
  if (modelDownloader) modelDownloader.cancel();
  return null;
});

// Snapshot for late subscribers (modal reopened mid-download).
ipcMain.handle('sidecar:models-progress', () => {
  return modelDownloader ? modelDownloader.getProgress() : { state: 'idle' };
});

// Machine capabilities for the "can this computer run the embedded backend?"
// check in the Server Settings modal. Everything is best-effort — any probe
// that throws just comes back null/undefined and the pure evaluator
// (util/embedded-capability.js) treats it as "unknown", never a blocker.
ipcMain.handle('system:capabilities', async () => {
  // eslint-disable-next-line global-require
  const os = require('os');
  let freeDiskBytes = null;
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // statfs the userData volume (always exists; the models dir is a child of
    // it, same filesystem, and may not exist yet on first run). Node 18+.
    const stat = fs.statfsSync(app.getPath('userData'));
    freeDiskBytes = stat.bsize * stat.bavail;
  } catch (e) {
    freeDiskBytes = null;
  }
  let gpu = null;
  try {
    // 'complete' includes auxAttributes.glRenderer, which distinguishes a real
    // GPU from a software rasterizer (SwiftShader/llvmpipe). It can hang on a
    // wedged GPU process, so cap it — a null result is treated as "unknown"
    // (never a blocker), so a slow probe must never stall the whole check.
    const gpuInfo = app.getGPUInfo('complete');
    const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), 3000); });
    gpu = await Promise.race([gpuInfo, timeout]);
  } catch (e) {
    gpu = null;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    cpuCount: (os.cpus() || []).length,
    freeDiskBytes,
    gpu,
  };
});

// called on quit-cadmium
async function cleanUp() {
  console.log('Starting clean up ...');
  // Shut the sidecar down first (cleanUp ends in app.exit(0), which skips
  // Electron's quit events; the manager's process-exit hook is the backstop).
  if (sidecarManager) {
    console.log('Stopping sidecar:');
    try { await sidecarManager.stop(); } catch (e) { console.error(e); }
  }
  console.log('Cleaning up temp files:');
  await tempFileManager.deleteTempDirFolder();
  console.log('Clean up done.');
  app.exit(0);
}

// Quit when all windows are closed.
app.on('window-all-closed', async () => {
  console.log('WINDOW ALL CLOSED');
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on("open-file", function(event, path) {
  if (isReady) {
    win.webContents.send("openFile", path);
  } else {
    stashFilePaths.push(path);
  }
});

app.on('before-quit', (event) => {
  console.log('BEFORE QUIT')
  // Hand off to the renderer to prompt for unsaved changes; it sends back
  // 'quit-cadmium' when it's done. (Previously this also blocked on an S3
  // upload that the OSS build never performs — removed.)
  if (win && win.webContents) {
    event.preventDefault();
    win.webContents.send('saveBeforeQuit');
  }
});

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (win === null) {
    createWindow();
    tempFileManager.createTempDir();
    console.log('app activated');
  }
});

// app.on('did-become-active', async () => {
//   console.log('App became active, sending reactivation ping to modal');
//   await modalPing();
// });

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  // Install Vue 2 legacy devtools in development
  if (isDevelopment && !process.env.IS_TEST) {
    try {
      const VUE2_LEGACY_DEVTOOLS_ID = 'iaajmlceplecbljialhhkmedjlpdblhp';
      await installExtension(VUE2_LEGACY_DEVTOOLS_ID);
      console.log('Vue 2 Devtools installed');
    } catch (e) {
      console.error('Vue 2 Devtools failed to install:', e.toString());
    }
  }
  menuSetLocale();
  // Before the window exists: a first-run reset must land before the
  // renderer asks for its prefs.
  reconcileInstallState();
  createWindow();
  // Deep model verification runs after the window is up — it hashes GBs.
  verifyModelShasOnce().catch((e) => console.error('[model-hygiene]', e));

  var mainMenuObject = await mainMenuFactory();
  Menu.setApplicationMenu(mainMenuObject);
  tempFileManager.createTempDir();

  // Removed automatic tour launching; tour starts only from Welcome modal

  win.on('close', (e) => {
    console.log('CLOSE')
    e.preventDefault()

    console.log("PLATFORM", process.platform);

    // On macOS, closing the window prompts to save but keeps the app running;
    // elsewhere, quit (which routes through before-quit).
    if (process.platform !== 'darwin') {
      app.quit();
    } else {
      win.webContents.send('saveBeforeQuit');
    }
  });

  ipcMain.on('file-too-old', (event) => {
    console.log('GOT MESSAAGE');
    win.webContents.send('showCustomDialog', {
      title: t('Cadmium File Too Old'),
      message: t('Unfortunately, project files older than v 0.3.0 are no longer compatible. Apologies, friend.'),
      buttons: [t('OK')],
      defaultId: 0,
      type: 'error'
    });
  });

  ipcMain.on('add-temp-file', (event, filePath) => {
    // console.log(`Main: added temp file: ${filePath}`);
    tempFileManager.addFilePathToBucket(filePath);
  });

  ipcMain.handle('clear-temp-files', (event) => {
    // console.log('CLEARING TEMP FILES IN BUCKET');
    const result = tempFileManager.deleteTempDirFolder();
    // const result = tempFileManager.deleteFilesInBucket();
    return result;
  });

  ipcMain.on('get-temp-files', (event) => {
    const tempFileBucket = tempFileManager.getDefaultBucket();
    console.log('Temp File Bucket: ', tempFileBucket.length, ' items');
    win.webContents.send('storeTempFilePaths', tempFileBucket);
  });

  ipcMain.handle('get-temp-dir', (event) => {
    // console.log('getting temp dir...');
    const tempFileDir = tempFileManager.createTempDir();
    // console.log('Temp File Dir: ', tempFileDir);
    // win.webContents.send('storeTempFileDir', tempFileDir);
  });

  ipcMain.on('add-pref', (event, preference, payload) => {
    console.log('Adding preference: ', preference, ' Payload: ', payload);
    localprefs.set(preference, payload);
  });

  ipcMain.on('get-pref', (event, preference) => {
    console.log('Getting preference: ', preference);
    const value = localprefs.get(preference);
    event.sender.send('pref-response', preference, value);
  });
  
  ipcMain.on('quit-cadmium', async (event) => {
    console.log("QUITTING")
    await cleanUp();
  });

  ipcMain.on('update-cadmium', (event) => {
    // Stamp the update intent so the relaunch is recognized as an in-app
    // update (seamless) rather than an out-of-band install (first-run reset).
    if (pendingUpdateVersion) {
      writeSetupLedger(stampUpdatingTo(readSetupLedger(), pendingUpdateVersion));
    }
    autoUpdater.quitAndInstall();
  });

  ipcMain.on('cycle-color-swatch-action', (event) => {
    win.webContents.send('cycle-color-swatch');
  });

  ipcMain.on('cycle-el-color-swatch-action', (event) => {
    win.webContents.send('cycle-el-color-swatch');
  });

  ipcMain.on('scroll-to-frame', (event, frameNr) => {
    const frameNrId = 'frameNr' + (frameNr - 1);
    console.log(frameNrId);
    let scrollCode =
    `
    function isInViewport(element) {
      const rect = element.getBoundingClientRect();
      return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth)
      );
    }
    var scrollTarget = document.getElementById("`+ frameNrId + `");
    var scrollWindow = document.getElementsByClassName('timeline-pane-right');
    var isFrameVisible = isInViewport(scrollTarget);
    if (!isFrameVisible) {
      scrollWindow[0].scrollLeft = scrollTarget.offsetLeft;
    }
    `;
    win.webContents.executeJavaScript(scrollCode);
  });

  ipcMain.on('load-user-prefs', (event) => {
    if (localprefs.get('backgroundColor')){
      win.webContents.send('loadBackgroundColor', localprefs.get('backgroundColor'));
    }
    if (localprefs.get('selectedColor')){
      win.webContents.send('loadSelectedColor', localprefs.get('selectedColor'));
    }
    if (localprefs.get('penToolMode')){
      win.webContents.send('loadPenToolMode', localprefs.get('penToolMode'));
    }
    if (localprefs.get('brushSize')){
      win.webContents.send('loadBrushSize', localprefs.get('brushSize'));
    }
    if (localprefs.get('eraserSize')){
      win.webContents.send('loadEraserSize', localprefs.get('eraserSize'));
    }
    if (localprefs.get('drawMode')){
      win.webContents.send('loadDrawMode', localprefs.get('drawMode'));
    }
    if (localprefs.get('drawModePrevious')){
      win.webContents.send('loadDrawModePrevious', localprefs.get('drawModePrevious'));
    }
    if (localprefs.get('pressure')){
      win.webContents.send('loadPressure', localprefs.get('pressure'));
    }
    if (localprefs.get('fillMode')){
      win.webContents.send('loadFillMode', localprefs.get('fillMode'));
    }
    if (localprefs.get('fillMethod')){
      win.webContents.send('loadFillMethod', localprefs.get('fillMethod'));
    }
    if (localprefs.get('fillToolRange')){
      win.webContents.send('loadFillToolRange', localprefs.get('fillToolRange'));
    }
  });

  autoUpdater.checkForUpdates();
});

// TODO: Handle via popup
// see https://stackoverflow.com/questions/50686010/custom-error-window-handling-in-electron
app.on('gpu-process-crashed', (err) => {
  logError(err, 'GPU Process crashed.');
});

function shouldForceUpdate(availableVersion, currentVersion) {
  const availableVersionParts = availableVersion.split('.').map(Number);
  const currentVersionParts = currentVersion.split('.').map(Number);

  for (let i = 0; i < 2; i++) {
    const available = availableVersionParts[i] || 0;
    const current = currentVersionParts[i] || 0;
    
    if (available > current) return true;
    if (available < current) return false;

    // otherwise continue to next part
  }
  
  return false;
}

function decodeHtmlEntities(text) {
  if (!text) return '';
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCharCode(parseInt(code, 10)); } catch { return _; }
    });
}

function stripHtmlTags(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '');
}

function formatReleaseNotesAsBullets(releaseNotesHTML) {
  try {
    const html = Array.isArray(releaseNotesHTML)
      ? releaseNotesHTML.map(item => (typeof item === 'string' ? item : (item.note || ''))).join('\n')
      : String(releaseNotesHTML || '');

    const liMatches = html.match(/<li[\s\S]*?>[\s\S]*?<\/li>/gi);
    if (liMatches && liMatches.length) {
      const lines = liMatches
        .map(li => decodeHtmlEntities(stripHtmlTags(li)))
        .map(text => text.trim())
        .filter(text => text.length > 0)
        .map(text => `• ${text}`);
      return lines.join('\n');
    }

    // Fallback: plain text conversion
    return decodeHtmlEntities(stripHtmlTags(html)).trim() || createTextVersion(html).trim();
  } catch (e) {
    try {
      return createTextVersion(releaseNotesHTML).trim();
    } catch {
      return '';
    }
  }
}

// The version an in-flight update will install — stamped into the setup
// ledger by 'update-cadmium' right before quitAndInstall.
let pendingUpdateVersion = null;

autoUpdater.on('update-available', (updateInfo) => {
  pendingUpdateVersion = updateInfo.version;
  const releaseNotesHTML = updateInfo.releaseNotes;
  var releaseNotesText = formatReleaseNotesAsBullets(releaseNotesHTML);

  if (shouldForceUpdate(updateInfo.version, app.getVersion())) {
    showDialogFromMain(win, {
      title: t('Cadmium Update Available'),
      message: `${t('Hello! Cadmium is out of date and must be updated. But good news, you can download the latest version ')}${updateInfo.version}${t(' and continue coloring!')}`,
      detail: releaseNotesText,
      buttons: [t('QUIT'), t('UPDATE')],
      defaultId: 1,
      type: 'info'
    }).then(result => {
      if (result.response === 1) {
        console.log("User chose to update");
        autoUpdater.downloadUpdate();
        win.webContents.send('update-in-progress', true);
      } else if (result.response === 0) {
        app.quit();
      }
    });
  } else {
    showDialogFromMain(win, {
      title: t('Cadmium Update Available'),
      message: `${t('Hey! A new version of Cadmium ')}${updateInfo.version}${t(' is available. Would you like to download the update?')}`,
      detail: releaseNotesText,
      buttons: [t('YES PLEASE'), t('NO I am afraid of change')],
      defaultId: 0,
      type: 'info'
    }).then(result => {
      if (result.response === 0) {
        console.log("User chose to update");
        autoUpdater.downloadUpdate();
        win.webContents.send('update-in-progress', true);
      } else if (result.response === 1) {
        // (An undeclared `choseToUpdate = false` lived here — write-only, and
        // a ReferenceError in the strict-mode bundle. Removed.)
        console.log("User opted out of update");
      }
    });
  }
})

autoUpdater.on('update-downloaded', () => {
  console.log('UPDATE DOWNLOAD COMPLETE');
  win.webContents.send('update-in-progress', false);
  
  showDialogFromMain(win, {
    title: t('Cadmium Update Download Complete'),
    message: `${t('Download Complete')}${t(' Would you like to install the update and restart?')}`,
    buttons: [t('Install and Restart'), t('Install Later')],
    defaultId: 0,
    type: 'info'
  }).then(result => {
    if (result.response === 0) {
      console.log("User chose to install now");
      if (process.platform == 'darwin') {
        showDialogFromMain(win, {
          title: t('Cadmium Update'),
          message: t('Cadmium will now quit and update. Once the update is complete, Cadmium will restart. Do not attempt to manually restart Cadmium until the update is complete. This may take a few minutes.'),
          buttons: [t('OK')],
          defaultId: 0,
          type: 'info'
        }).then(() => {
          if (win.webContents !== null) {
            win.webContents.send('saveBeforeUpdate');
          }
        });
      } else {
        if (win.webContents !== null) {
          win.webContents.send('saveBeforeUpdate');
        }
      }
    }
  });
})

autoUpdater.on('download-progress', (progressObj) => {
  console.log('DOWNLOAD PROGRESS:', progressObj.percent);
  win.webContents.send('update-percentage', progressObj.percent);
})

// Exit cleanly on request from parent process in development mode.
if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', (data) => {
      if (data === 'graceful-exit') {
        app.quit();
      }
    });
  } else {
    process.on('SIGTERM', () => {
      app.quit();
    });
  }
}

export function getWebContents() {
  return win ? win.webContents : null;
}

export function showSupportDialog() {
  showDialogFromMain(win, {
    title: t('Cadmium Support'),
    message: `${t('For help with Cadmium, please open an issue at https://github.com/latentspacelabs/cadmium-oss/issues.')}`,
    detail: '',
    buttons: [t('OK')],
    defaultId: 0,
    type: 'info'
  });   
}

ipcMain.handle('get-colorization-in-progress', async (event) => {
  // Forward the request to the renderer and wait for the response
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return false;
  // Use invoke/handle pattern for async reply
  return await win.webContents.executeJavaScript('window.__cadmiumGetColorizationInProgress && window.__cadmiumGetColorizationInProgress()');
});

// Add IPC handler for menu rebuild from renderer
ipcMain.handle('rebuild-menu', async (event, colorizationInProgress) => {
  await rebuildMenu(colorizationInProgress);
});
