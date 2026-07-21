/* eslint-disable */
const { app, Menu, webContents } = require('electron');

import { t } from './util/i18n';

import { getWebContents, showSupportDialog } from './background';
import {
  SAVE_FILE,
  OPEN_FILE_DIALOG,
  SAVE_FILE_AS,
  EXPORT_DIALOG,
  EXPORT_COLORS_SEPARATED,
  IMPORT_FILES_LINES,
  IMPORT_FILES_COLOR,
  COLORIZE,
  PLAYER_PLAY_PAUSE,
  SELECT_ALL_LINE_FRAMES_FROM_MENU,
  SELECT_ALL_COLOR_FRAMES_FROM_MENU,
  DESELECT_ALL_FRAMES_FROM_MENU,
  HANDLE_NEXT_UNIQUE_IMAGE,
  HANDLE_PREVIOUS_UNIQUE_IMAGE,
  HANDLE_DELETE_PRESS,
  UNDO_ACTION,
  REDO_ACTION,
  NEW_PROJECT,
} from './store/action-types';

import {
  SET_ANALYZE_MODE_ONLY,
  SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME,
  SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME,
  SET_FRAMES_SELECTED_ON_WHOLE_LAYER,
  TOGGLE_TIMELINE_VISIBILITY,
} from './store/mutation-types'

import {
  INITIAL_COLOR_LAYER_ID,
  COLORIZATION_IN_PROGRESS,
} from './store/getter-types'

import {
  DISPATCH_ACTION,
  COMMIT_MUTATION,
} from './ipc-types';

const isMac = process.platform === 'darwin';
const { ipcMain } = require('electron');

let template = [];

/* eslint-disable import/prefer-default-export */
export async function mainMenuFactory(colorizationInProgress = false) {
  // File Menu
  const fileMenu = {
    label: t('File'),
    submenu: [
      {
        label: t('New Project'),
        accelerator: 'CommandOrControl+N',
        click: () => {
          console.log('New Project Menu clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: NEW_PROJECT,
          });
        },
      },
      {
        label: t('Open'),
        accelerator: 'CommandOrControl+O',
        click: () => {
          console.log('Open Menu clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: OPEN_FILE_DIALOG,
          });
        },
      },
      {
        label: t('Open Recent'),
        role: 'recentdocuments',
        submenu: [
          {
            label: 'Clear Recent',
            role: 'clearrecentdocuments',
          },
        ],
      },
      {
        label: t('Save'),
        id: SAVE_FILE,
        enabled: !colorizationInProgress,
        accelerator: 'CommandOrControl+S',
        click: () => {
          console.log('Save Menu clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: SAVE_FILE,
          });
        },
      },
      {
        label: t('Save As'),
        accelerator: 'Shift+CommandOrControl+S',
        enabled: !colorizationInProgress,
        click: () => {
          console.log('Save Menu clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: SAVE_FILE_AS,
          });
        },
      },
      { type: 'separator' },
      {
        label: t('Import'),
        submenu: [
          {
            label: t('Import Line Frames'),
            accelerator: 'CommandOrControl+I',
            click: () => {
              console.log('Import Line Menu clicked'); // logged in terminal (not dev tools)
              const webContents = getWebContents();
              //console.log(webContents)
              webContents.send(DISPATCH_ACTION, {
                id: IMPORT_FILES_LINES,
              });
            },
          },
          {
            label: t('Import Color Frames'),
            accelerator: 'CommandOrControl+Shift+I',
            click: () => {
              console.log('Import Color Menu clicked'); // logged in terminal (not dev tools)
              const webContents = getWebContents();
              //console.log(webContents)
              webContents.send(DISPATCH_ACTION, {
                id: IMPORT_FILES_COLOR,
              });
            },
          },
        ],
      },
      {
        label: t('Export'),
        accelerator: 'CommandOrControl+E',
        click: () => {
          console.log('Export Menu clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(DISPATCH_ACTION, {
            id: EXPORT_DIALOG,
          });
          // You can also pass data via the payload, e.g.:
          // webContents.send(DISPATCH_ACTION, {
          //   id: EXPORT,
          //   payload: 'some stuff...'
          // });
          //
          // ...or call a vuex mutation (can also contain a payload if needed):
          //
          // webContents.send(COMMIT_MUTATION, {
          //   id: DESELECT_FRAMES,
          // });
          // see https://electronjs.org/docs/api/web-contents#contentssendchannel-args
        },
      },
      {
        label: t('Export Colors Separated'),
        accelerator: 'CommandOrControl+Shift+E',
        click: () => {
          console.log('Export Colors Separated clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(DISPATCH_ACTION, {
            id: EXPORT_COLORS_SEPARATED,
          });
        },
      },
      { type: 'separator' },
      isMac ? { type: 'separator' } : { role: 'quit' },
    ],
  };

  // Edit Menu (find undo/redo by id)
  const editMenu = {
    label: t('Edit'),
    submenu: [
      {
        label: t('Undo'),
        id: UNDO_ACTION,
        enabled: !colorizationInProgress,
        accelerator: 'CommandOrControl+Z',
        click: () => {
          // console.log('undo clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: UNDO_ACTION,
          });
        },
      },
      {
        label: t('Redo'),
        id: REDO_ACTION,
        enabled: !colorizationInProgress,
        accelerator: 'CommandOrControl+Shift+Z',
        click: () => {
          // console.log('undo clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: REDO_ACTION,
          });
        },
      },
      {
        label: t('Select Frames'),
        submenu: [
          {
            label: t('All Line Frames'),
            accelerator: 'CommandOrControl+A',
            id: SELECT_ALL_LINE_FRAMES_FROM_MENU,
            enabled: !colorizationInProgress,
            click: () => {
              console.log('Select All Line Frames clicked'); // logged in terminal (not dev tools)
              const webContents = getWebContents();
              webContents.send(DISPATCH_ACTION, {
                id: SELECT_ALL_LINE_FRAMES_FROM_MENU,
              });
            },
          },
          {
            label: t('All Color Frames'),
            accelerator: 'CommandOrControl+A',
            id: SELECT_ALL_COLOR_FRAMES_FROM_MENU,
            enabled: !colorizationInProgress,
            click: () => {
              console.log('Select All Color Frames clicked'); // logged in terminal (not dev tools)
              const webContents = getWebContents();
              webContents.send(DISPATCH_ACTION, {
                id: SELECT_ALL_COLOR_FRAMES_FROM_MENU,
              });
            },
          },
        ],
      },
      {
        label: t('Deselect All Frames'),
        id: DESELECT_ALL_FRAMES_FROM_MENU,
        enabled: !colorizationInProgress,
        accelerator: 'CommandOrControl+D',
        click: () => {
          console.log('Deselect All Frames clicked'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: DESELECT_ALL_FRAMES_FROM_MENU,
          });
        },
      },
      {
        label: t('Delete Selected Frames'),
        enabled: !colorizationInProgress,
        accelerator: 'Delete',
        click: () => {
          console.log('Deleting Selected Frames'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          webContents.send(DISPATCH_ACTION, {
            id: HANDLE_DELETE_PRESS,
          });
        },
      },
      { type: 'separator' },
      {
        label: t('Text'),
        submenu: [
          {
            role: 'undo',
            accelerator: '',
            label: t('Undo Text'),
          },
          { role: 'redo',
            accelerator: '',
            label: t('Redo Text'),
          },
          { type: 'separator' },
          { role: 'selectAll',
            label: t('Select All Text'),
          },
          { role: 'cut',
            label: t('Cut Text'),
          },
          { role: 'copy',
            label: t('Copy Text'),
          },
          { role: 'paste',
            label: t('Paste Text'),
          },
          { role: 'delete',
            label: 'delete text',
          },
        ],
      },
      /*
      ...(
        isMac ? [
          // { role: 'pasteAndMatchStyle' },
          // { role: 'delete' },
          // { role: 'selectAll' },
          // { type: 'separator' },
          /*
          {
            label: 'Speech',
            submenu: [{ role: 'startspeaking' }, { role: 'stopspeaking' }],
          },
        ]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      */
    ],
  };

  // Timeline Menu (frame selection controls)
  const timelineMenu = {
    label: t('Timeline'),
    submenu: [
      {
        label: t('Play/Pause'),
        click: () => {
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(DISPATCH_ACTION, {
            id: PLAYER_PLAY_PAUSE,
          });
        },
      },
      {
        label: t('Toggle Loop'),
        accelerator: 'L',
        click: () => {
          const webContents = getWebContents();
          webContents.send(COMMIT_MUTATION, {
            id: 'set_player_loop_enabled',
            payload: 'toggle',
          });
        },
      },
      {
        label: t('Previous Unique Frame'),
        // accelerator: 'Left',
        click: () => {
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(DISPATCH_ACTION, {
            id: HANDLE_PREVIOUS_UNIQUE_IMAGE,
          });
        },
      },
      {
        label: t('Next Unique Frame'),
        // accelerator: 'Right',
        click: () => {
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(DISPATCH_ACTION, {
            id: HANDLE_NEXT_UNIQUE_IMAGE,
          });
        },
      },
    ],
  };

  // Process Menu
  const processMenu = {
    label: t('Process'),
    submenu: [
      {
        label: t('Analyze Frames'),
        enabled: !colorizationInProgress,
        accelerator: 'CommandOrControl+Shift+A',
        click: () => {
          console.log('Analyze Frames'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(COMMIT_MUTATION, {
            id: SET_ANALYZE_MODE_ONLY,
            payload: true,
          });
          webContents.send(DISPATCH_ACTION, {
            id: COLORIZE,
          });
        },
      },
      {
        label: t('Colorize Frames'),
        enabled: !colorizationInProgress,
        accelerator: 'CommandOrControl+Shift+C',
        click: () => {
          console.log('Colorize'); // logged in terminal (not dev tools)
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(COMMIT_MUTATION, {
            id: SET_ANALYZE_MODE_ONLY,
            payload: false,
          });
          webContents.send(DISPATCH_ACTION, {
            id: COLORIZE,
          });
        },
      },
      { type: 'separator' },
      // { role: 'forcereload' },
    ],
  };

  // View Menu
  const viewMenu = {
    label: t('View'),
    submenu: [
      {
        role: 'resetzoom',
        label: t('Actual Size'),
      },
      {
        label: t('Zoom In'),
        accelerator: 'CommandOrControl+=',
        click: () => {
          const webContents = getWebContents();
          webContents.send('zoom-canvas-from-menu', 'in');
        },
      },
      {
        label: t('Zoom Out'),
        accelerator: 'CommandOrControl+-',
        click: () => {
          const webContents = getWebContents();
          webContents.send('zoom-canvas-from-menu', 'out');
        },
      },
      {
        label: t('Show/Hide Timeline'),
        accelerator: 'T',
        click: () => {
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(COMMIT_MUTATION, {
            id: TOGGLE_TIMELINE_VISIBILITY,
          });
        },
      },
      {
        label: t('Reset Canvas View'),
        accelerator: 'Home',
        click: () => {
          const webContents = getWebContents();
          webContents.send('reset-canvas-view', true);
        },
      },
      { type: 'separator' },
    ],
  };

  // Help Menu
  const helpMenu = {
    role: 'help',
    label: t('Help'),
    submenu: [
      {
        label: t('Learn More'),
        click: async () => {
          /* eslint-disable import/no-extraneous-dependencies */
          /* eslint-disable global-require */
          const { shell } = require('electron');
          await shell.openExternal('https://github.com/latentspacelabs/cadmium-oss');
        },
      },
      {
        label: t('Terms of Agreement'),
        click: async () => {
          /* eslint-disable import/no-extraneous-dependencies */
          /* eslint-disable global-require */
          const { shell } = require('electron');
          await shell.openExternal('https://github.com/latentspacelabs/cadmium-oss/blob/main/LICENSE');
        },
      },
      {
        label: t('Launch Tour'),
        click: () => {
          const webContents = getWebContents();
          webContents.send('relaunch-tour', true);
        },
      },
      {
        label: t('Show Welcome Modal'),
        click: () => {
          const webContents = getWebContents();
          webContents.send('show-welcome-modal', true);
        },
      },
      {
        label: t('Support'),
        click: () => {
          console.log("SHOW SUPPORT DIALOG");
          showSupportDialog();
        },
      },
    ],
  };
  // Settings Menu (non-macOS). On macOS, Server Settings lives in the app menu
  // (⌘,), so this standalone menu is only added on Windows/Linux to keep it
  // reachable there. The OSS build has no accounts, so there is no Account menu.
  const settingsMenu = {
    label: t('Settings'),
    submenu: [
      {
        label: t('Server Settings…'),
        click: () => {
          getWebContents().send('show-server-settings', true);
        },
      },
    ],
  };

  // Mac App Menu
  const macAppMenu = {
    label: t('Cadmium'),
    submenu: [
      { role: 'about', label: t('About Cadmium') },
      { type: 'separator' },
      {
        label: t('Server Settings…'),
        accelerator: 'CommandOrControl+,',
        click: () => {
          getWebContents().send('show-server-settings', true);
        },
      },
      { type: 'separator' },
      { role: 'hide', label: t('Hide Cadmium') },
      { role: 'hideothers', label: t('Hide Others') },
      { role: 'unhide', label: t('Show All') },
      { type: 'separator' },
      { role: 'quit', label: t('Quit Cadmium') },
    ],
  };

  template = [
    // { role: 'appMenu' }
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    editMenu,
    timelineMenu,
    processMenu,
    viewMenu,
    ...(isMac ? [] : [settingsMenu]),
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

// Refactor rebuildMenu to accept colorizationInProgress
export async function rebuildMenu(colorizationInProgress = false) {
  const menu = await mainMenuFactory(colorizationInProgress);
  Menu.setApplicationMenu(menu);
}
