// Auto-applied Jest manual mock for the `@electron/remote` module.
//
// Jest picks this up automatically for any test that imports `@electron/remote`
// (Node-module mocks in a root-level __mocks__ dir are used without an explicit
// jest.mock() call). It lets renderer modules that reach for main-process APIs
// at import time — e.g. TempFileManager reading app.getPath('userData') — load
// under the jsdom test environment instead of throwing.
//
// Keep this a thin, side-effect-free stub. Tests that care about a specific
// return value should override it locally (jest.spyOn / mockReturnValue).
const os = require('os');
const path = require('path');

const app = {
  getPath: (name) => path.join(os.tmpdir(), `cadmium-test-${name}`),
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  getName: () => 'cadmium-test',
  getLocale: () => 'en-US',
  addRecentDocument: () => {},
  on: () => {},
};

const dialog = {
  showOpenDialog: jest.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
  showSaveDialog: jest.fn(() => Promise.resolve({ canceled: true, filePath: undefined })),
  showMessageBox: jest.fn(() => Promise.resolve({ response: 0 })),
};

const getCurrentWindow = () => ({
  webContents: { send: () => {} },
  on: () => {},
});

class Menu {
  constructor() {
    this.items = [];
  }

  append(item) {
    this.items.push(item);
  }

  getMenuItemById(id) {
    return this.items.find((i) => i.id === id) || null;
  }

  popup() {}

  static buildFromTemplate() {
    return new Menu();
  }

  static setApplicationMenu() {}
}

class MenuItem {
  constructor(options) {
    Object.assign(this, options);
  }
}

module.exports = { app, dialog, getCurrentWindow, Menu, MenuItem };
