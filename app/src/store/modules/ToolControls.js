/* eslint-disable linebreak-style */
/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable */
import {
  TOOL_CONTROLS_VISIBLE,
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  SELECTED_COLOR,
  RESERVED_COLOR,
  // FILL_TOOL_ACTIVE,
  // ACTIVE_TOOLS,
  ACTIVE_CANVAS_TOOL,
  ACTIVE_CANVAS_TOOL_ID,
  TOOL_CONTROL_ITEM_BY_ID,
  PREVIOUS_CANVAS_TOOL_ID,
  BACKGROUND_COLOR,
} from '@/store/getter-types';

import {
  HIDE_ALL_TOOL_CONTROLS,
  TOGGLE_TOOL_CONTROL_WITH_ID,
  SHOW_TOOL_CONTROL_WITH_ID,
  HIDE_TOOL_CONTROL_WITH_ID,
  SET_SELECTED_COLOR,
  SET_RESERVED_COLOR,
  SET_BACKGROUND_COLOR,
  SET_PREVIOUS_CANVAS_TOOL_ID,
  SET_ACTIVE_CANVAS_TOOL_ID,
} from '@/store/mutation-types';

import {
  ACTIVATE_TOOL_BY_ID,
  ACTIVATE_PREVIOUS_TOOL,
} from '@/store/action-types';

// import {
//   FILL_TOOL_MODE_FILL,
//   FILL_TOOL_MODE_ERASE,
// } from '@/store/modules/FillTool';

// tool IDs
export const TOOL_CONTROLS_ID_COLOR = 'color';
export const TOOL_CONTROLS_ID_FILL = 'fill';
export const TOOL_CONTROLS_ID_PEN = 'pen';
export const TOOL_CONTROLS_ID_ERASER = 'eraser';
export const TOOL_CONTROLS_ID_EYEDROPPER = 'eyedropper';
export const TOOL_CONTROLS_ID_HAND = 'hand';
export const TOOL_CONTROLS_ID_ZOOM = 'zoom';
export const TOOL_CONTROLS_ID_REFERENCE = 'referencepanel';
export const TOOL_CONTROLS_SEG_OPTIONS = 'segoptions';

import { setPref } from '@/platform';

export const toolControlItemIds = [
  TOOL_CONTROLS_ID_COLOR,
  TOOL_CONTROLS_ID_FILL,
  TOOL_CONTROLS_ID_ERASER,
  TOOL_CONTROLS_ID_PEN,
  TOOL_CONTROLS_ID_EYEDROPPER,
  TOOL_CONTROLS_ID_HAND,
  TOOL_CONTROLS_ID_ZOOM,
  TOOL_CONTROLS_ID_REFERENCE,
  TOOL_CONTROLS_SEG_OPTIONS,
];

export default {
  state: {
    toolControlItemIds,
    toolControlItems: [
      {
        id: TOOL_CONTROLS_ID_COLOR,
        isVisible: false,
        isCanvasTool: false, // this tool is not used on the canvas (just inside the widget)
      },
      {
        id: TOOL_CONTROLS_ID_HAND,
        isVisible: false,
        isCanvasTool: true, // this tool is used on the canvas, aka active tool
      },
      {
        id: TOOL_CONTROLS_ID_ZOOM,
        isVisible: false,
        isCanvasTool: true, // this tool is used on the canvas, aka active tool
      },
      {
        id: TOOL_CONTROLS_ID_EYEDROPPER,
        isVisible: false,
        isCanvasTool: true, // this tool is used on the canvas, aka active tool
      },
      {
        id: TOOL_CONTROLS_ID_FILL,
        isVisible: false,
        isCanvasTool: true,
      },
      {
        id: TOOL_CONTROLS_ID_PEN,
        isVisible: false,
        isCanvasTool: true,
      },
      {
        id: TOOL_CONTROLS_ID_ERASER,
        isVisible: false,
        isCanvasTool: true,
      },
      {
        id: TOOL_CONTROLS_SEG_OPTIONS,
        isVisible: false,
        isCanvasTool: false,
      },
      {
        id: TOOL_CONTROLS_ID_REFERENCE,
        isVisible: false,
        isCanvasTool: false,
      },
    ],
    previousCanvasToolId: null,
    activeCanvasToolId: null,
    selectedColor: '#9834d3', // cadmium purple is first selected color
    reservedColor: '#000000',
    canvasBackgroundColor: BACKGROUND_COLOR,

  },
  getters: {
    [TOOL_CONTROLS_VISIBLE](state) {
      // if any of the tool controls are shown, the container must be visible
      return state.toolControlItems.some(a => a.isVisible);
    },
    [TOOL_CONTROL_ITEM_BY_ID]: state => itemId => state.toolControlItems.find(a => a.id === itemId),
    [TOOL_CONTROL_ITEM_IS_VISIBLE]: state => (itemId) => {
      const item = state.toolControlItems.find(a => a.id === itemId);
      if (!item) { return false; }
      return item.isVisible;
    },

    /**
     * @param {Object} state
     * @returns {Object} - the tool object, or null if no canvas tool is currently active
     */
    [ACTIVE_CANVAS_TOOL](state) {
      return state.toolControlItems.find(a => a.isVisible && a.isCanvasTool);
    },

    // [ACTIVE_TOOLS](state) {
    //   return state.toolControlItems.filter(a => a.isVisible);
    // },

    /**
     * @returns {string} - Hex color in format #RRGGBB
     */
    [SELECTED_COLOR]: state => state.selectedColor,
    [RESERVED_COLOR]: state => state.reservedColor,

    [PREVIOUS_CANVAS_TOOL_ID]: state => state.previousCanvasToolId,
    [ACTIVE_CANVAS_TOOL_ID]: state => state.activeCanvasToolId,
  },
  /* eslint-disable no-param-reassign */
  mutations: {
    [HIDE_ALL_TOOL_CONTROLS](state) {
      state.toolControlItems.forEach((item) => { item.isVisible = false; });
    },
    [TOGGLE_TOOL_CONTROL_WITH_ID](state, id) {
      const item = state.toolControlItems.find(a => a.id === id);
      if (item) {
        item.isVisible = !item.isVisible;
      }
    },
    [SHOW_TOOL_CONTROL_WITH_ID](state, id) {
      const item = state.toolControlItems.find(a => a.id === id);
      if (item) {
        item.isVisible = true;
      }
    },
    [HIDE_TOOL_CONTROL_WITH_ID](state, id) {
      const item = state.toolControlItems.find(a => a.id === id);
      if (item) {
        item.isVisible = false;
      }
    },
    [SET_PREVIOUS_CANVAS_TOOL_ID](state, id) {
      state.previousCanvasToolId = id;
    },
    [SET_ACTIVE_CANVAS_TOOL_ID](state, id) {
      state.activeCanvasToolId = id;
    },
    /**
     *
     * @param {*} state
     * @param {string} color - Hex color in format #RRGGBB
     */
    [SET_SELECTED_COLOR](state, color) {
      const isColor = c => c && c.length && c.length === 7;
      if (color && isColor(color)) {
        state.selectedColor = color;
        setPref('selectedColor', color);
      }
    },

    [SET_RESERVED_COLOR](state, color) {
      const isColor = c => c && c.length && c.length === 7;
      if (color && isColor(color)) {
        state.reservedColor = color;
        setPref('reservedColor', color);
      }
    },
    /**
     *
     * @param {*} state
     * @param {string} color - Hex color in format #RRGGBB
     */
    [SET_BACKGROUND_COLOR](state, color) {
      // const isColor = c => c && c.length && c.length === 7;
      color = state.stateselectedColor;
      state.canvasBackgroundColor = color;
    },
  },
  actions: {
    /**
     * Activates / deactivates (toggles) a toolbar item.
     * Takes into account what else needs to be done besides just
     * showing or hiding the tool.
     * @param {object} vuexParams
     * @param {object} options
     * @param {string} options.toolId - ID of the tool to activate
     * @param {boolean} [options.preventReActivation=false]
     *   Prevents re-activation of previous tools
     */
    [ACTIVATE_PREVIOUS_TOOL]({ dispatch, getters }) {
      // console.log('activating previous tool...');
      const previousCanvasToolId = getters[PREVIOUS_CANVAS_TOOL_ID];
      // console.log('previous tool id: ', previousCanvasToolId);
      if (previousCanvasToolId) {
        dispatch(ACTIVATE_TOOL_BY_ID, { toolId: previousCanvasToolId });
      }
    },

    [ACTIVATE_TOOL_BY_ID](
      { state, getters, commit },
      {
        toolId,
        preventReActivation = false,
        preventClose = false,
      } = {},
    ) {
      if (!toolId) {
        console.error(`Tool ${toolId} could not be activated because it is null.`);
        return;
      }
      if (getters[ACTIVE_CANVAS_TOOL] === getters[TOOL_CONTROL_ITEM_BY_ID](toolId)) {
        if (toolId !== TOOL_CONTROLS_ID_EYEDROPPER) {
          console.log('same tool pressed');
          commit(SET_PREVIOUS_CANVAS_TOOL_ID, toolId);
          return;
        }
      }
      const tool = getters[TOOL_CONTROL_ITEM_BY_ID](toolId);
      // console.log('tool.id: ', tool.id);
      commit(SET_ACTIVE_CANVAS_TOOL_ID, toolId);
      // console.log('tool after activate: ', toolId);
      const currentCanvasTool = getters[ACTIVE_CANVAS_TOOL];
      // const currentCanvasToolId = getters[ACTIVE_CANVAS_TOOL_ID];
      // console.log('activeCanvasToolId: ', getters[ACTIVE_CANVAS_TOOL_ID]);
      const previousCanvasToolId = getters[PREVIOUS_CANVAS_TOOL_ID];
      // console.log(currentCanvasToolId);
      // console.log('currentCanvasTool: ', currentCanvasTool);

      if (!tool) {
        console.error(`Tool control item with ID ${toolId} does not exist.`);
        return;
      }

      const itemCurrentlyVisible = getters[TOOL_CONTROL_ITEM_IS_VISIBLE](tool.id);
      // console.log('itemvisible: ', itemCurrentlyVisible);
      // NOTE: we do another check for this at 'same tool pressed',
      // so item is now never currently visible.
      if (itemCurrentlyVisible && preventClose === false) {
        commit(HIDE_TOOL_CONTROL_WITH_ID, tool.id);
        // console.log('close: ', tool.id);
        // special case: when the eyedropper is hidden.
        if (tool.id === TOOL_CONTROLS_ID_EYEDROPPER || tool.id === TOOL_CONTROLS_ID_HAND) {
          // show the previous canvas tool if any
          if (previousCanvasToolId && !preventReActivation) {
            commit(SHOW_TOOL_CONTROL_WITH_ID, previousCanvasToolId);
            // console.log('previousCanvasToolId: ', previousCanvasToolId);
          }
        }
      } else { // item is currently hidden and should be shown / activated
        // first check if a canvas tool is currently active
        // const previousCanvasTool
        // commit(SET_PREVIOUS_CANVAS_TOOL_ID, previousCanvasTool.id);
        if (currentCanvasTool) {
          // console.log('currentCanvasTool: ', currentCanvasTool);
          // console.log('currentCanvasToolId: ', currentCanvasTool.id);
          commit(SET_PREVIOUS_CANVAS_TOOL_ID, currentCanvasTool.id);
          // console.log('previousCanvasToolId is now: ', currentCanvasTool.id);
        }
        if (tool.isCanvasTool) {
          const notToolToActivate = t => t.id !== tool.id;
          const isVisible = t => t.isVisible;
          const notColorTool = t => t.id !== TOOL_CONTROLS_ID_COLOR;
          const notReferenceTool = t => t.id !== TOOL_CONTROLS_ID_REFERENCE;
          const notSegOptions = t => t.id !== TOOL_CONTROLS_SEG_OPTIONS;
          state.toolControlItems
            .filter(notToolToActivate)
            .filter(isVisible)
            .filter(notColorTool)
            .filter(notReferenceTool)
            .filter(notSegOptions)
            .forEach(t => commit(HIDE_TOOL_CONTROL_WITH_ID, t.id));
        }
        commit(SHOW_TOOL_CONTROL_WITH_ID, tool.id);
      }
    },
  },
};
