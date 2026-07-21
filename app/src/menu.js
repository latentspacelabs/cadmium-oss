/* eslint-disable */
const { app, Menu, webContents } = require('electron');

import { i18n } from './util/i18n';

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
    label: i18n.__('File'),
    submenu: [
      {
        label: i18n.__('New Project'),
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
        label: i18n.__('Open'),
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
        label: i18n.__('Open Recent'),
        role: 'recentdocuments',
        submenu: [
          {
            label: 'Clear Recent',
            role: 'clearrecentdocuments',
          },
        ],
      },
      {
        label: i18n.__('Save'),
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
        label: i18n.__('Save As'),
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
        label: i18n.__('Import'),
        submenu: [
          {
            label: i18n.__('Import Line Frames'),
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
            label: i18n.__('Import Color Frames'),
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
        label: i18n.__('Export'),
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
        label: i18n.__('Export Colors Separated'),
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
    label: i18n.__('Edit'),
    submenu: [
      {
        label: i18n.__('Undo'),
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
        label: i18n.__('Redo'),
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
        label: i18n.__('Select Frames'),
        submenu: [
          {
            label: i18n.__('All Line Frames'),
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
            label: i18n.__('All Color Frames'),
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
        label: i18n.__('Deselect All Frames'),
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
        label: i18n.__('Delete Selected Frames'),
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
        label: i18n.__('Text'),
        submenu: [
          {
            role: 'undo',
            accelerator: '',
            label: i18n.__('Undo Text'),
          },
          { role: 'redo',
            accelerator: '',
            label: i18n.__('Redo Text'),
          },
          { type: 'separator' },
          { role: 'selectAll',
            label: i18n.__('Select All Text'),
          },
          { role: 'cut',
            label: i18n.__('Cut Text'),
          },
          { role: 'copy',
            label: i18n.__('Copy Text'),
          },
          { role: 'paste',
            label: i18n.__('Paste Text'),
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
    label: i18n.__('Timeline'),
    submenu: [
      {
        label: i18n.__('Play/Pause'),
        click: () => {
          const webContents = getWebContents();
          // console.log(webContents)
          webContents.send(DISPATCH_ACTION, {
            id: PLAYER_PLAY_PAUSE,
          });
        },
      },
      {
        label: i18n.__('Toggle Loop'),
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
        label: i18n.__('Previous Unique Frame'),
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
        label: i18n.__('Next Unique Frame'),
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
    label: i18n.__('Process'),
    submenu: [
      {
        label: i18n.__('Analyze Frames'),
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
        label: i18n.__('Colorize Frames'),
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
    label: i18n.__('View'),
    submenu: [
      {
        role: 'resetzoom',
        label: i18n.__('Actual Size'),
      },
      {
        label: i18n.__('Zoom In'),
        accelerator: 'CommandOrControl+=',
        click: () => {
          const webContents = getWebContents();
          webContents.send('zoom-canvas-from-menu', 'in');
        },
      },
      {
        label: i18n.__('Zoom Out'),
        accelerator: 'CommandOrControl+-',
        click: () => {
          const webContents = getWebContents();
          webContents.send('zoom-canvas-from-menu', 'out');
        },
      },
      {
        label: i18n.__('Show/Hide Timeline'),
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
        label: i18n.__('Reset Canvas View'),
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
    label: i18n.__('Help'),
    submenu: [
      {
        label: i18n.__('Learn More'),
        click: async () => {
          /* eslint-disable import/no-extraneous-dependencies */
          /* eslint-disable global-require */
          const { shell } = require('electron');
          await shell.openExternal('https://github.com/latentspacelabs/cadmium-oss');
        },
      },
      {
        label: i18n.__('Terms of Agreement'),
        click: async () => {
          /* eslint-disable import/no-extraneous-dependencies */
          /* eslint-disable global-require */
          const { shell } = require('electron');
          await shell.openExternal('https://github.com/latentspacelabs/cadmium-oss/blob/main/LICENSE');
        },
      },
      {
        label: i18n.__('Launch Tour'),
        click: () => {
          const webContents = getWebContents();
          webContents.send('relaunch-tour', true);
        },
      },
      {
        label: i18n.__('Show Welcome Modal'),
        click: () => {
          const webContents = getWebContents();
          webContents.send('show-welcome-modal', true);
        },
      },
      {
        label: i18n.__('Support'),
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
    label: i18n.__('Settings'),
    submenu: [
      {
        label: i18n.__('Server Settings…'),
        click: () => {
          getWebContents().send('show-server-settings', true);
        },
      },
    ],
  };

  // Mac App Menu
  const macAppMenu = {
    label: i18n.__('Cadmium'),
    submenu: [
      { role: 'about', label: i18n.__('About Cadmium') },
      { type: 'separator' },
      {
        label: i18n.__('Server Settings…'),
        accelerator: 'CommandOrControl+,',
        click: () => {
          getWebContents().send('show-server-settings', true);
        },
      },
      { type: 'separator' },
      { role: 'hide', label: i18n.__('Hide Cadmium') },
      { role: 'hideothers', label: i18n.__('Hide Others') },
      { role: 'unhide', label: i18n.__('Show All') },
      { type: 'separator' },
      { role: 'quit', label: i18n.__('Quit Cadmium') },
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
