/* eslint-disable */
/* eslint-disable-next-line import/no-extraneous-dependencies */
import { quit, installUpdate, sendCustomDialogResult, subscribe } from '@/platform';
import store from '@/store';

import {
  DISPATCH_ACTION,
  COMMIT_MUTATION,
} from '@/ipc-types';

import {
  SET_PEN_TOOL_MODE,
  SET_PEN_TOOL_DIAMETER,
  SET_ERASER_TOOL_DIAMETER,
  SET_PEN_DRAW_MODE,
  SET_PEN_DRAW_MODE_PREVIOUS,
  SET_PRESSURE_ENABLED,
  SET_FILL_TOOL_MODE,
  SET_FILL_TOOL_RANGE,
  SET_SELECTED_COLOR,
  SET_RESERVED_COLOR,
  SET_UPDATE_IN_PROGRESS,
  SET_UPDATE_PERCENTAGE,
  SET_BACKGROUND_COLOR,
  SET_TEMP_FILE_PATHS,
} from '@/store/mutation-types';

import {
  UNSAVED_CHANGES,
} from '@/store/getter-types';

import {
  SAVE_FILE,
  OPEN_FILE_FROM_OS,
} from '@/store/action-types';

import { t } from './util/i18n';

// Import custom dialog utility (alternative to dialog.showMessageBox)
import showCustomDialog from '@/util/customDialog';


function handleActionDispatchRequest(event, config) {
  if (!config || !config.id) {
    console.error('Wrong parameters. Needs config.id.');
    return;
  }
  store.dispatch(config.id, config.payload);
}

function handleCommitMutationRequest(event, config) {
  if (!config || !config.id) {
    console.error('Wrong parameters. Needs config.id.');
    return;
  }
  store.commit(config.id, config.payload);
}

async function serverErrorDialog() {
  const hasUnsavedChanges = store.getters[UNSAVED_CHANGES];
  const buttons = hasUnsavedChanges ? [t('Save and Quit'), t('Quit')] : [t('Quit')];
  const serverErrorOptions = () => {
    return new Promise((resolve) => {
              showCustomDialog({
          title: t('Server Error'),
          message: t('Cadmium encountered an error while communicating with the server. Please try again or file an issue at https://github.com/latentspacelabs/cadmium-oss/issues'),
          detail: t('This may be a temporary issue. If the problem persists, please contact our support team.'),
          buttons: buttons,
          defaultId: 0,
          type: 'error'
        }).then(result => {
        resolve(result);
      });
    });
  };

  const serverErrorChoice = await serverErrorOptions();
  if (serverErrorChoice.response === 0 && hasUnsavedChanges) {
    const didCancel = await store.dispatch(SAVE_FILE);
    if (didCancel) {
      serverErrorDialog();
      return;
    }
  }
  quit();
}

async function noInternetDialog() {
  const { default: connectivityChecker } = await import('./util/connectivity-checker.js');
  
  const hasUnsavedChanges = store.getters[UNSAVED_CHANGES];
  const quitButtons = hasUnsavedChanges ? [t('Save and Quit'), t('Quit')] : [t('Quit')];
  const retryButtons = hasUnsavedChanges ? [t('Retry'), t('Save and Quit'), t('Quit')] : [t('Retry'), t('Quit')];
  
  let dialogInstance = null;
  let dialogResolve = null;

  const noInternetOptions = () => {
    return new Promise((resolve) => {
      dialogResolve = resolve; // Store resolve function for auto-close
      showCustomDialog({
        title: t('No Internet Connection'),
        message: t('Cadmium requires an internet connection to function. Please check your internet connection and try again.'),
        detail: t('For licensing reasons, Cadmium requires a live connection to the internet. Please reconnect to the internet and the dialog will close automatically, or click Retry to check manually.'),
        buttons: retryButtons,
        defaultId: 0,
        type: 'warning',
        instanceCallback: (instance) => {
          dialogInstance = instance;
        },
        onButtonClick: async (result, instance) => {
          const buttonIndex = result.response;
          console.log('Button clicked:', buttonIndex, 'retryButtons:', retryButtons);
          
          // Handle retry button (always index 0)
          if (buttonIndex === 0) {
            console.log('Retry button clicked, checking connectivity...');
            // Set retry button to loading state
            instance.setButtonLoading(0, true);
            
            try {
              // Check connectivity
              const isConnected = await connectivityChecker.checkOnce();
              console.log('Connectivity check result:', isConnected);
              
              if (isConnected) {
                // Internet is back, close dialog and stop auto-checking
                console.log('Internet restored via retry, closing dialog');
                connectivityChecker.stopAutoCheck();
                dialogResolve = null; // Clear resolve to prevent auto-close conflicts
                instance.closeDialog();
                resolve({ response: -1, connected: true });
                return;
              } else {
                console.log('Still no internet connection');
                // Still no internet, remove loading state
                instance.setButtonLoading(0, false);
                return; // Don't close dialog, let user try again
              }
            } catch (error) {
              console.error('Error during connectivity check:', error);
              instance.setButtonLoading(0, false);
              return;
            }
          }
          
          // Handle other buttons (save/quit)
          connectivityChecker.stopAutoCheck();
          dialogResolve = null; // Clear resolve to prevent auto-close conflicts
          resolve(result);
        }
      });
    });
  };

  // Start automatic connectivity checking
  connectivityChecker.startAutoCheck(
    1000, // Check every 1 seconds
    () => {
      // On connected callback - close the dialog
      console.log('Internet connection restored, auto-closing dialog');
      if (dialogInstance && dialogResolve) {
        connectivityChecker.stopAutoCheck();
        dialogInstance.closeDialog();
        dialogResolve({ response: -1, connected: true });
        dialogResolve = null; // Clear the resolve function
      }
    }
  );

  const noInternetChoice = await noInternetOptions();
  
  // If connectivity was restored automatically, don't quit
  if (noInternetChoice.connected) {
    return;
  }

  // Handle quit/save operations
  const hasRetryButton = retryButtons.length > quitButtons.length;
  const saveButtonIndex = hasRetryButton ? 1 : 0;
  const quitButtonIndex = hasRetryButton ? 2 : 1;

  if (noInternetChoice.response === saveButtonIndex && hasUnsavedChanges) {
    const didCancel = await store.dispatch(SAVE_FILE);
    console.log("didCancel", didCancel);
    if (didCancel) {
      noInternetDialog();
      return;
    }
  }
  
  if (noInternetChoice.response === saveButtonIndex || noInternetChoice.response === quitButtonIndex) {
    quit();
  }
}

async function suspendedDialog() {
  const hasUnsavedChanges = store.getters[UNSAVED_CHANGES];
  const buttons = hasUnsavedChanges ? [t('Save and Quit'), t('Quit')] : [t('Quit')];
  const suspendedOptions = () => {
    return new Promise((resolve) => {
        showCustomDialog({
          title: t('Suspended'),
          message: t('Cadmium has been suspended. Please file an issue at https://github.com/latentspacelabs/cadmium-oss/issues'),
          detail: t('Your account has been temporarily suspended. Please contact support to resolve this issue.'),
          buttons: buttons,
          defaultId: 0,
          type: 'error'
        }).then(result => {
        resolve(result);
      });
    });
  };

  const suspendedChoice = await suspendedOptions();
  if (suspendedChoice.response === 0 && hasUnsavedChanges) {
    const didCancel = await store.dispatch(SAVE_FILE);
    if (didCancel) {
      suspendedDialog();
      return;
    }
  }
  quit();
}

async function saveBeforeQuit() {
  const saveOptions = () => {
    return new Promise((resolve) => {
      showCustomDialog({
        title: t('Save Before Quit'),
        message: t('You have unsaved changes in your project. \n Would you like to save it before quitting?'),
        detail: t('Your work will be lost if you don\'t save it.'),
        buttons: [t('Yes'), t('No'), t('Cancel')],
        defaultId: 0,
        cancelId: 2,
        type: 'warning'
      }).then(result => {
        resolve(result);
      });
    });
  };

  if (store.getters[UNSAVED_CHANGES]) {
    const saveChoice = await saveOptions();
    const saveChoiceNum = saveChoice.response;
    if (saveChoiceNum === 0) {
      const didCancel = await store.dispatch(SAVE_FILE);
      if (!didCancel) {
        quit();
      } else {
        saveBeforeQuit();
      }
    }
    if (saveChoiceNum === 1) {
      quit();
    }
  } else {
    quit();
  }
}

async function saveBeforeUpdate() {
  const saveOptions = () => {
    return new Promise((resolve) => {
      showCustomDialog({
        title: t('Save Before Quit'),
        message: t('You have unsaved changes in your project. \n Would you like to save it before quitting?'),
        detail: t('Your work will be lost if you don\'t save it.'),
        buttons: [t('Yes'), t('No'), t('Cancel')],
        defaultId: 0,
        cancelId: 2,
        type: 'warning'
      }).then(result => {
        resolve(result);
      });
    });
  };

  if (store.getters[UNSAVED_CHANGES]) {
    const saveChoice = await saveOptions();
    const saveChoiceNum = saveChoice.response;
    if (saveChoiceNum === 0) {
      const didCancel = await store.dispatch(SAVE_FILE);
      if (!didCancel) {
        installUpdate();
      } else {
        saveBeforeUpdate();
      }
    }
    if (saveChoiceNum === 1) {
      quit();
    }
  } else { 
    installUpdate();
  }
}

function openFileFromOS(data) {
  store.dispatch(OPEN_FILE_FROM_OS, {
    filePath: data,
  });
}

function ipcRendererHandlers() {
  subscribe(DISPATCH_ACTION, handleActionDispatchRequest);
  subscribe(COMMIT_MUTATION, handleCommitMutationRequest);

  subscribe('loadPenToolMode', (event, data) => {
    store.commit(SET_PEN_TOOL_MODE, data);
  });
  subscribe('loadBrushSize', (event, data) => {
    store.commit(SET_PEN_TOOL_DIAMETER, data);
  });
  subscribe('loadEraserSize', (event, data) => {
    store.commit(SET_ERASER_TOOL_DIAMETER, data);
  });
  subscribe('loadDrawMode', (event, data) => {
    store.commit(SET_PEN_DRAW_MODE, data);
  });
  subscribe('loadDrawModePrevious', (event, data) => {
    store.commit(SET_PEN_DRAW_MODE_PREVIOUS, data);
  });
  subscribe('loadPressure', (event, data) => {
    store.commit(SET_PRESSURE_ENABLED, data);
  });
  subscribe('loadFillMode', (event, data) => {
    store.commit(SET_FILL_TOOL_MODE, data);
  });
  subscribe('loadFillToolRange', (event, data) => {
    store.commit(SET_FILL_TOOL_RANGE, data);
  });
  subscribe('loadBackgroundColor', (event, data) => {
    store.commit(SET_BACKGROUND_COLOR, data);
  });
  subscribe('loadSelectedColor', (event, data) => {
    store.commit(SET_SELECTED_COLOR, data);
  });
  subscribe('loadReservedColor', (event, data) => {
    store.commit(SET_RESERVED_COLOR, data);
  });
  subscribe('update-in-progress', (event, data) => {
    store.commit(SET_UPDATE_IN_PROGRESS, data);
  });
  subscribe('update-percentage', (event, data) => {
    if (data === 100) {
      store.commit(SET_UPDATE_IN_PROGRESS, false);
    }
    store.commit(SET_UPDATE_PERCENTAGE, data);
  });
  subscribe('storeTempFilePaths', (event, data) => {
    store.commit(SET_TEMP_FILE_PATHS, data);
  });

  // Embedded sidecar status pushes from the main-process supervisor. The
  // cache also keeps server-config's embedded runtime port current, so the
  // serving URL getters resolve to the live sidecar.
  subscribe('sidecar:status', async (event, status) => {
    const { updateSidecarStatus } = await import('./util/sidecar-status.js');
    updateSidecarStatus(status);
  });

  // Model download progress pushes (same cache pattern as sidecar:status).
  subscribe('sidecar:models-progress', async (event, progress) => {
    const { updateModelDownloadProgress } = await import('./util/model-download-status.js');
    updateModelDownloadProgress(progress);
  });

  subscribe('saveBeforeQuit', () => {
    saveBeforeQuit();
  });
  subscribe('saveBeforeUpdate', () => {
    saveBeforeUpdate();
  });
  subscribe('openFile', (event, data) => {
    // console.log('Opening File: ', data);
    openFileFromOS(data);
  });
  subscribe('suspendedDialog', (event, data) => {
    suspendedDialog();
  });
  subscribe('serverErrorDialog', (event, data) => {
    serverErrorDialog();
  });
  subscribe('noInternetDialog', (event, data) => {
    noInternetDialog();
  });

  subscribe('showCustomDialog', (event, dialogOptions) => {
    showCustomDialog(dialogOptions);
  });
  
  subscribe('showCustomDialogWithCallback', (event, dialogOptions) => {
    showCustomDialog(dialogOptions).then(result => {
      // Send the result back to the main process
      sendCustomDialogResult({
        callbackId: dialogOptions.callbackId,
        response: result.response
      });
    });
  });
}

export default ipcRendererHandlers;
