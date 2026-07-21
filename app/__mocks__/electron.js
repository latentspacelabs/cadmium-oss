// Auto-applied Jest manual mock for the `electron` module.
//
// Renderer code pulls `ipcRenderer`, `app`, `shell`, `webFrame`, etc. straight
// off `require('electron')` at import time. Outside the Electron runtime that
// module resolves to a path string, so destructuring yields `undefined` and any
// module touching it throws on load. This thin stub lets those modules import
// cleanly under jest. Tests that assert on IPC can spy on `ipcRenderer.send` /
// `.invoke` (both jest.fn here).
const os = require('os');
const path = require('path');

const app = {
  getPath: (name) => path.join(os.tmpdir(), `cadmium-test-${name}`),
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  getName: () => 'cadmium-test',
  addRecentDocument: () => {},
  on: () => {},
};

const ipcRenderer = {
  on: jest.fn(),
  once: jest.fn(),
  send: jest.fn(),
  invoke: jest.fn(() => Promise.resolve()),
  removeAllListeners: jest.fn(),
  removeListener: jest.fn(),
};

const ipcMain = {
  on: jest.fn(),
  once: jest.fn(),
  handle: jest.fn(),
};

const shell = { openExternal: jest.fn(() => Promise.resolve()) };
const webFrame = { executeJavaScript: jest.fn(() => Promise.resolve()) };

module.exports = { app, ipcRenderer, ipcMain, shell, webFrame };
