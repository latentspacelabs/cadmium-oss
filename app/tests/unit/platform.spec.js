// Verifies the @/platform seam forwards to the right Electron primitives.
// The auto-applied __mocks__/electron.js and __mocks__/@electron/remote.js
// stand in for the host, so these assertions run without an Electron runtime.
import * as platform from '@/platform';

const { ipcRenderer, shell } = require('electron');
const remote = require('@electron/remote');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('request/response IPC', () => {
  it('clearTempFiles invokes the clear-temp-files channel', () => {
    platform.clearTempFiles();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('clear-temp-files');
  });

  it('getTempDir invokes the get-temp-dir channel', () => {
    platform.getTempDir();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-temp-dir');
  });

  it('rebuildMenu invokes rebuild-menu and forwards its argument', () => {
    platform.rebuildMenu(true);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('rebuild-menu', true);
  });

  it('returns the invoke promise so callers can await a reply', () => {
    expect(platform.clearTempFiles()).toBeInstanceOf(Promise);
  });
});

describe('named fire-and-forget IPC', () => {
  it.each([
    ['setPref', () => platform.setPref('welcomeModalShown', true), 'add-pref', ['welcomeModalShown', true]],
    ['requestPref', () => platform.requestPref('serverUrl'), 'get-pref', ['serverUrl']],
    ['loadUserPrefs', () => platform.loadUserPrefs(), 'load-user-prefs', []],
    ['addTempFile', () => platform.addTempFile('/tmp/x.png'), 'add-temp-file', ['/tmp/x.png']],
    ['requestTempFiles', () => platform.requestTempFiles(), 'get-temp-files', []],
    ['quit', () => platform.quit(), 'quit-cadmium', []],
    ['installUpdate', () => platform.installUpdate(), 'update-cadmium', []],
    ['notifyFileTooOld', () => platform.notifyFileTooOld(), 'file-too-old', []],
    ['scrollToFrame', () => platform.scrollToFrame(3), 'scroll-to-frame', [3]],
    ['cycleColorSwatch', () => platform.cycleColorSwatch(), 'cycle-color-swatch-action', []],
    ['sendCustomDialogResult', () => platform.sendCustomDialogResult({ callbackId: 'a', response: 1 }), 'customDialogResult', [{ callbackId: 'a', response: 1 }]],
  ])('%s sends on the %s channel', (_name, call, channel, args) => {
    call();
    expect(ipcRenderer.send).toHaveBeenCalledWith(channel, ...args);
  });
});

describe('main-process event listeners', () => {
  it('subscribe registers a listener on the channel', () => {
    const listener = () => {};
    platform.subscribe('openFile', listener);
    expect(ipcRenderer.on).toHaveBeenCalledWith('openFile', listener);
  });

  it('removeListeners clears the channel', () => {
    platform.removeListeners('pref-response');
    expect(ipcRenderer.removeAllListeners).toHaveBeenCalledWith('pref-response');
  });

  it('send is a generic escape hatch that forwards channel and args', () => {
    platform.send('some-channel', 1, 'a');
    expect(ipcRenderer.send).toHaveBeenCalledWith('some-channel', 1, 'a');
  });
});

describe('host info and shell', () => {
  it('getAppVersion reads the host app version', () => {
    expect(platform.getAppVersion()).toBe(remote.app.getVersion());
  });

  it('getAppPath reads the host app path', () => {
    expect(platform.getAppPath()).toBe(remote.app.getAppPath());
  });

  it('getUserDataPath reads the userData path', () => {
    expect(platform.getUserDataPath()).toBe(remote.app.getPath('userData'));
  });

  it('getLocale reads the host locale', () => {
    expect(platform.getLocale()).toBe(remote.app.getLocale());
  });

  it('addRecentDocument forwards to the host app', () => {
    const spy = jest.spyOn(remote.app, 'addRecentDocument');
    platform.addRecentDocument('/tmp/proj.cdm');
    expect(spy).toHaveBeenCalledWith('/tmp/proj.cdm');
  });

  it('openExternal opens the url in the host shell', () => {
    platform.openExternal('https://example.com');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });
});

describe('native dialogs and menus', () => {
  it('showSaveDialog parents the dialog to the current window', () => {
    const opts = { title: 'Save' };
    platform.showSaveDialog(opts);
    expect(remote.dialog.showSaveDialog).toHaveBeenCalledWith(expect.anything(), opts);
  });

  it('showOpenDialog parents the dialog to the current window', () => {
    const opts = { title: 'Open' };
    platform.showOpenDialog(opts);
    expect(remote.dialog.showOpenDialog).toHaveBeenCalledWith(expect.anything(), opts);
  });

  it('popupMenu pops the given menu over the current window', () => {
    const menu = { popup: jest.fn() };
    platform.popupMenu(menu);
    expect(menu.popup).toHaveBeenCalledWith({ window: expect.anything() });
  });

  it('createMenu returns a native menu instance', () => {
    const menu = platform.createMenu();
    expect(menu).toBeInstanceOf(remote.Menu);
  });

  it('createMenuItem returns a native item carrying its options', () => {
    const item = platform.createMenuItem({ id: 'x', label: 'X' });
    expect(item).toBeInstanceOf(remote.MenuItem);
    expect(item.id).toBe('x');
  });
});
