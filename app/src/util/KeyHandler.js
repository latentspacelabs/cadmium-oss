import store from '@/store';
import router from '@/router';

import {
  FILL_TOOL_MODE,
  PEN_TOOL_MODE,
  ACTIVE_CANVAS_TOOL_ID,
  // PREVIOUS_CANVAS_TOOL_ID,
  // ACTIVE_CANVAS_TOOL,
  ACTIVE_LAYER_ID,
  COLORIZATION_IN_PROGRESS,
} from '@/store/getter-types';

import {
  SET_SELECTED_FRAME_TO_PREVIOUS_FRAME,
  SET_SELECTED_FRAME_TO_NEXT_FRAME,
  SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME,
  SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME,
  SET_FRAMES_SELECTED_ON_WHOLE_LAYER,
  TOGGLE_TOOL_CONTROL_WITH_ID,
  SET_FILL_TOOL_MODE,
  SET_ZOOM_TOOL_MODE,
  SET_PEN_TOOL_MODE,
  SET_PREVIOUS_CANVAS_TOOL_ID,
  SET_ACTIVE_LAYER_ID,
  // TOGGLE_TIMELINE_VISIBILITY,
} from '@/store/mutation-types';

import {
  PLAYER_PLAY_PAUSE,
  HANDLE_DELETE_PRESS,
  ACTIVATE_TOOL_BY_ID,
  ACTIVATE_PREVIOUS_TOOL,
  TOGGLE_ACTIVE_COLOR,
  CYCLE_SWATCH,
} from '@/store/action-types';

import {
  INITIAL_COLOR_LAYER_ID,
  INITIAL_LINE_LAYER_ID,
} from '@/store/general-types';

import {
  TOOL_CONTROLS_ID_HAND,
  TOOL_CONTROLS_ID_FILL,
  TOOL_CONTROLS_ID_PEN,
  TOOL_CONTROLS_ID_ERASER,
  TOOL_CONTROLS_ID_COLOR,
  TOOL_CONTROLS_ID_EYEDROPPER,
  TOOL_CONTROLS_ID_ZOOM,
} from '@/store/modules/ToolControls';

import {
  FILL_TOOL_MODE_FILL,
  FILL_TOOL_MODE_ERASE,
} from '@/store/modules/FillTool';

import {
  PEN_TOOL_MODE_DRAW,
  PEN_TOOL_MODE_ERASE,
} from '@/store/modules/PenTool';

import {
  ZOOM_TOOL_MODE_IN,
  ZOOM_TOOL_MODE_OUT,
} from '@/store/modules/ZoomTool';

/*
 * Key codes in use by Cadmium.
 * You can find new keycodes by visiting this website:
 * https://keycode.info
 */
const keyCodes = {
  LEFT: 37,
  RIGHT: 39,
  UP: 38,
  DOWN: 40,
  SPACE: 32,
  ENTER: 13,
  BACKSPACE: 8,
  DELETE: 46,
  ALT: 18,
  A: 65,
  B: 66,
  C: 67,
  D: 68,
  E: 69,
  F: 70,
  I: 73,
  P: 80,
  T: 84,
  X: 88,
  Z: 90,
  SHIFT: 16,
};

/*
 * Most keys should only fire once and not multiple times
 * when the key is hold. An example for this is the "i" key,
 * which temporarily enables the eyedropper.
 * Some keys do need to fire multiple times though (based on
 * the OS setting). Put them here to be able to trigger multiple
 * times when held down.
 */
// next line used to toggle fill tool modes with D
// let fillModeId;
const retriggerableKeyCodes = [
  keyCodes.LEFT,
  keyCodes.RIGHT,
  keyCodes.UP,
  keyCodes.DOWN,
  keyCodes.Z,
  keyCodes.X,
  keyCodes.B,
  keyCodes.D,
];

export default class KeyHandler {
  constructor() {
    document.addEventListener('keydown', this.onKeyPress.bind(this), false);
    document.addEventListener('keyup', this.onKeyRelease.bind(this), false);
    this.state = {
      previousKeyPressCode: null,
    };
  }

  /* eslint-disable class-methods-use-this */
  onKeyPress(e) {
    // only handle key events on the root path
    const currentPath = router.currentRoute.path || router.currentRoute.value.path;
    if (currentPath === '/login') {
      return;
    }
    console.log('currentPath', currentPath);
    // prevent double triggering when key is being hold down.
    // this is needed to functions that are activated while the key is
    // hold down (e.g. eyedropper)
    // will be reset when the key is released.
    if (
      this.state.previousKeyPressCode === e.keyCode
      && !retriggerableKeyCodes.includes(e.keyCode)
    ) { return; }
    // check modifier keys
    // see: https://developer.mozilla.org/de/docs/Web/API/KeyboardEvent/getModifierState
    const cmdOrCtrlPressed = e.getModifierState('Meta') || e.getModifierState('Control');
    const shiftPressed = e.getModifierState('Shift');
    // const altPressed = e.getModifierState('Alt');
    const activeElement = document.activeElement.tagName;
    if (activeElement !== 'INPUT') {
      switch (e.keyCode) {
        case keyCodes.LEFT:
          if (shiftPressed || cmdOrCtrlPressed) {
            e.preventDefault();
            store.commit(SET_SELECTED_FRAME_TO_PREVIOUS_FRAME);
            break;
          } else {
            store.commit(SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME, {
              layerId: store.getters[ACTIVE_LAYER_ID] || INITIAL_COLOR_LAYER_ID,
              isSelected: true,
            });
            e.preventDefault();
            break;
          }
        case keyCodes.RIGHT:
          if (shiftPressed || cmdOrCtrlPressed) {
            e.preventDefault();
            store.commit(SET_SELECTED_FRAME_TO_NEXT_FRAME);
            break;
          } else {
            store.commit(SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME, {
              layerId: store.getters[ACTIVE_LAYER_ID] || INITIAL_COLOR_LAYER_ID,
              isSelected: true,
            });
            e.preventDefault();
            break;
          }
        case keyCodes.UP:
          if (shiftPressed || cmdOrCtrlPressed) {
            e.preventDefault();
            if (store.getters[ACTIVE_LAYER_ID] === INITIAL_LINE_LAYER_ID) {
              store.commit(SET_ACTIVE_LAYER_ID, INITIAL_COLOR_LAYER_ID);
              break;
            } else {
              store.commit(SET_ACTIVE_LAYER_ID, INITIAL_LINE_LAYER_ID);
              break;
            }
          }
          break;
        case keyCodes.DOWN:
          if (shiftPressed || cmdOrCtrlPressed) {
            e.preventDefault();
            if (store.getters[ACTIVE_LAYER_ID] === INITIAL_COLOR_LAYER_ID) {
              store.commit(SET_ACTIVE_LAYER_ID, INITIAL_LINE_LAYER_ID);
              break;
            } else {
              store.commit(SET_ACTIVE_LAYER_ID, INITIAL_COLOR_LAYER_ID);
              break;
            }
          }
          break;
        case keyCodes.ENTER:
          e.preventDefault();
          store.dispatch(PLAYER_PLAY_PAUSE);
          break;
        case keyCodes.P:
          store.dispatch(CYCLE_SWATCH);
          break;
        case keyCodes.SPACE:
          store.dispatch(ACTIVATE_TOOL_BY_ID, { toolId: TOOL_CONTROLS_ID_HAND });
          break;
        case keyCodes.BACKSPACE:
        case keyCodes.DELETE:
          if (store.getters[COLORIZATION_IN_PROGRESS]) break;
          store.dispatch(HANDLE_DELETE_PRESS);
          break;
        case keyCodes.A:
          if (cmdOrCtrlPressed && !shiftPressed) {
            if (store.getters[COLORIZATION_IN_PROGRESS]) break;
            // TODO: This should be dynamic, based on which layer was last active.
            // But the layer should be highlighted then.
            store.commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
              layerId: store.getters[ACTIVE_LAYER_ID] || INITIAL_COLOR_LAYER_ID,
              isSelected: true,
            });
            e.preventDefault();
          }
          break;
        case keyCodes.B:
          store.dispatch(ACTIVATE_TOOL_BY_ID, {
            toolId: TOOL_CONTROLS_ID_PEN,
            preventClose: true,
          });
          store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_DRAW);
          /*
          if (cmdOrCtrlPressed || shiftPressed) {
            if (store.getters[PEN_TOOL_MODE] === PEN_TOOL_MODE_DRAW) {
              store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_ERASE);
              e.preventDefault();
            } else {
              store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_DRAW);
              e.preventDefault();
            }
          }
          */
          break;
        case keyCodes.C:
          if (!cmdOrCtrlPressed) {
            store.commit(TOGGLE_TOOL_CONTROL_WITH_ID, TOOL_CONTROLS_ID_COLOR);
            e.preventDefault();
          }
          break;
        case keyCodes.D:
          if (cmdOrCtrlPressed) {
            if (store.getters[COLORIZATION_IN_PROGRESS]) break;
            // Deselect all frames on all layers
            store.commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
              layerId: INITIAL_COLOR_LAYER_ID,
              isSelected: false,
            });
            store.commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
              layerId: INITIAL_LINE_LAYER_ID,
              isSelected: false,
            });
            e.preventDefault();
          } else {
            store.dispatch(ACTIVATE_TOOL_BY_ID, {
              toolId: TOOL_CONTROLS_ID_FILL,
              preventClose: true,
            });
            e.preventDefault();
            if (store.getters[FILL_TOOL_MODE] === FILL_TOOL_MODE_FILL) {
              store.commit(SET_FILL_TOOL_MODE, FILL_TOOL_MODE_ERASE);
              // fillModeId = false;
              e.preventDefault();
            } else {
              store.commit(SET_FILL_TOOL_MODE, FILL_TOOL_MODE_FILL);
              // fillModeId = true;
              e.preventDefault();
            }
          }
          break;
        case keyCodes.E:
          if (!cmdOrCtrlPressed) {
            store.dispatch(ACTIVATE_TOOL_BY_ID, {
              toolId: TOOL_CONTROLS_ID_ERASER,
              preventClose: true,
            });
            e.preventDefault();
          }
          break;
        case keyCodes.F:
          store.dispatch(ACTIVATE_TOOL_BY_ID, {
            toolId: TOOL_CONTROLS_ID_FILL,
            preventClose: true,
          });
          e.preventDefault();
          break;
        case keyCodes.I:
          // cmd + shift + i is the chromium shortcut to toggle dev tools -> skip
          if (!cmdOrCtrlPressed
            && store.getters[ACTIVE_CANVAS_TOOL_ID] !== TOOL_CONTROLS_ID_EYEDROPPER) {
            store.dispatch(ACTIVATE_TOOL_BY_ID, { toolId: TOOL_CONTROLS_ID_EYEDROPPER });
            e.preventDefault();
          }
          break;
          /* //accelerator makes this redundant
          case keyCodes.T:
            store.commit(TOGGLE_TIMELINE_VISIBILITY);
            break;
            */
        case keyCodes.X:
          store.dispatch(TOGGLE_ACTIVE_COLOR);
          break;
        case keyCodes.Z:
          if (cmdOrCtrlPressed) {
            if (store.getters[COLORIZATION_IN_PROGRESS]) break;
            /*
            if (shiftPressed) {
              console.log('redoooo');
              redo();
            } else {
              undo();
              console.log('undodoo');
            }
            */
          } else {
            store.dispatch(ACTIVATE_TOOL_BY_ID, { toolId: TOOL_CONTROLS_ID_ZOOM });
          }
          break;
        case keyCodes.SHIFT:
          // console.log('shiftPressed');
          if (cmdOrCtrlPressed) { break; }
          // eyedropper
          if (store.getters[ACTIVE_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_EYEDROPPER) {
            // console.log('active tool is eyedropper on shiftpressed');
            store.commit(SET_PREVIOUS_CANVAS_TOOL_ID, TOOL_CONTROLS_ID_EYEDROPPER);
          } else { // toggle to eyedropper
            store.dispatch(ACTIVATE_TOOL_BY_ID, {
              toolId: TOOL_CONTROLS_ID_EYEDROPPER,
              preventClose: true,
            });
            e.preventDefault();
          }
          break;
          // This following should be right before the default case
        case keyCodes.ALT:
          // console.log("alt pressed from keyhandler");
          // pen tool
          if (store.getters[ACTIVE_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_PEN) {
            if (store.getters[PEN_TOOL_MODE] === PEN_TOOL_MODE_DRAW) {
              store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_ERASE);
              e.preventDefault();
            } else {
              store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_DRAW);
              e.preventDefault();
            }
          }
          // fill tool
          // console.log('active canvas tool down: ', store.getters[ACTIVE_CANVAS_TOOL_ID]);
          if (store.getters[ACTIVE_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_FILL) {
            console.log(store.getters[FILL_TOOL_MODE]);
            if (store.getters[FILL_TOOL_MODE] === FILL_TOOL_MODE_FILL) {
              store.commit(SET_FILL_TOOL_MODE, FILL_TOOL_MODE_ERASE);
              // fillModeId = false;
              e.preventDefault();
            } else {
              store.commit(SET_FILL_TOOL_MODE, FILL_TOOL_MODE_FILL);
              // fillModeId = true;
              e.preventDefault();
            }
          }
          // zoom tool
          store.commit(SET_ZOOM_TOOL_MODE, ZOOM_TOOL_MODE_OUT);
          e.preventDefault();
          break;

        default:
          break;
      }
    }
    this.state.previousKeyPressCode = e.keyCode;
  }

  /* eslint-disable class-methods-use-this */
  onKeyRelease(e) {
    // only handle key events on the root path
    const currentPath = router.currentRoute.path || router.currentRoute.value.path;
    if (currentPath !== '/') {
      return;
    }
    // check modifier keys
    // see: https://developer.mozilla.org/de/docs/Web/API/KeyboardEvent/getModifierState
    // const cmdOrCtrlPressed = e.getModifierState('Meta') || e.getModifierState('Control');

    switch (e.keyCode) {
      case keyCodes.SPACE:
        store.dispatch(ACTIVATE_PREVIOUS_TOOL);
        // store.dispatch(ACTIVATE_TOOL_BY_ID, { toolId: TOOL_CONTROLS_ID_HAND });
        e.preventDefault();
        break;
        /*
      case keyCodes.I:
        // cmd + shift + i is the chromium shortcut to toggle dev tools -> skip
        if (!cmdOrCtrlPressed) {
          store.dispatch(ACTIVATE_TOOL_BY_ID, { toolId: TOOL_CONTROLS_ID_EYEDROPPER });
          e.preventDefault();
        }
        break;
        */
      // This should be right before the default case
      case keyCodes.SHIFT:
        // console.log('shiftReleased');
        // eyedropper -> pen tool
        if (store.getters[ACTIVE_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_EYEDROPPER) {
          // if (store.getters[PREVIOUS_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_PEN) {
          store.dispatch(ACTIVATE_PREVIOUS_TOOL);
          e.preventDefault();
          // }
        }
        break;
      case keyCodes.ALT:
        // console.log("alt released from keyhandler");
        // fill tool
        if (store.getters[ACTIVE_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_FILL) {
          console.log(store.getters[FILL_TOOL_MODE]);
          if (store.getters[FILL_TOOL_MODE] === FILL_TOOL_MODE_FILL) {
            store.commit(SET_FILL_TOOL_MODE, FILL_TOOL_MODE_ERASE);
            // fillModeId = false;
            e.preventDefault();
          } else {
            store.commit(SET_FILL_TOOL_MODE, FILL_TOOL_MODE_FILL);
            // fillModeId = true;
            e.preventDefault();
          }
        }
        // pen tool
        if (store.getters[ACTIVE_CANVAS_TOOL_ID] === TOOL_CONTROLS_ID_PEN) {
          if (store.getters[PEN_TOOL_MODE] === PEN_TOOL_MODE_DRAW) {
            store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_ERASE);
            e.preventDefault();
          } else {
            store.commit(SET_PEN_TOOL_MODE, PEN_TOOL_MODE_DRAW);
            e.preventDefault();
          }
        }
        // zoom tool:
        store.commit(SET_ZOOM_TOOL_MODE, ZOOM_TOOL_MODE_IN);
        e.preventDefault();
        break;
      default:
        break;
    }
    this.state.previousKeyPressCode = null;
  }
}
