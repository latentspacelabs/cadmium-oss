import { ipcMain } from 'electron';

// Store callbacks by ID
const callbacks = new Map();
let callbackIdCounter = 0;

/**
 * Shows a custom dialog from the main process and returns a promise
 * @param {Object} win - BrowserWindow instance
 * @param {Object} dialogOptions - Dialog options (title, message, detail, buttons, etc.)
 * @returns {Promise} Promise that resolves with the dialog result
 */
export function showDialogFromMain(win, dialogOptions) {
  return new Promise((resolve) => {
    const callbackId = `dialog_${callbackIdCounter += 1}`;

    // Store the callback
    callbacks.set(callbackId, resolve);

    // Send dialog request to renderer
    win.webContents.send('showCustomDialogWithCallback', {
      ...dialogOptions,
      callbackId,
    });
  });
}

/**
 * Initialize the dialog result handler
 * This should be called once during app initialization
 */
export function initializeDialogHandler() {
  ipcMain.on('customDialogResult', (event, result) => {
    const { callbackId, response } = result;

    // Get and execute the callback
    const callback = callbacks.get(callbackId);
    if (callback) {
      callback({ response });
      callbacks.delete(callbackId);
    }
  });
}