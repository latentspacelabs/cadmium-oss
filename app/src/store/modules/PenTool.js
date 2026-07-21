/* eslint-disable import/no-extraneous-dependencies */
import {
  PEN_TOOL_DIAMETER,
  PEN_TOOL_MODE,
  PEN_DRAW_MODE,
  PEN_DRAW_MODE_PREVIOUS,
  // ACTIVE_LAYER_ID,
} from '@/store/getter-types';

import {
  SET_PEN_TOOL_DIAMETER,
  SET_PEN_TOOL_MODE,
  SET_PEN_DRAW_MODE,
  SET_PEN_DRAW_MODE_PREVIOUS,
} from '@/store/mutation-types';

import { logError } from '@/util/error-util';

export const PEN_TOOL_MODE_DRAW = 'draw';
export const PEN_TOOL_MODE_ERASE = 'erase';
export const PEN_DRAW_MODE_OVER = 'source-over';
export const PEN_DRAW_MODE_UNDER = 'destination-over';
export const PEN_DRAW_MODE_WITHIN = 'source-atop';

const modes = [
  PEN_TOOL_MODE_DRAW,
  PEN_TOOL_MODE_ERASE,
];
/*
const drawModes = [
  PEN_DRAW_MODE_OVER,
  PEN_DRAW_MODE_UNDER,
  PEN_DRAW_MODE_WITHIN,
];
*/
export const DEFAULT_DIAMETER = 10;
// min diameter of 1 is not visible
// with the current pen diameter calculations
export const MIN_DIAMETER = 1;
export const MAX_DIAMETER = 500;
import { setPref } from '@/platform';

export default {
  state: {
    penDiameter: DEFAULT_DIAMETER,
    mode: PEN_TOOL_MODE_DRAW,
    // pen tool draw mode
    drawMode: PEN_DRAW_MODE_OVER,
    drawModePrevious: PEN_DRAW_MODE_OVER,
    drawModeDisabled: false,
  },
  getters: {
    [PEN_TOOL_DIAMETER](state) {
      return state.penDiameter;
    },
    [PEN_TOOL_MODE](state) {
      return state.mode;
    },
    [PEN_DRAW_MODE](state) {
      return state.drawMode;
    },
    [PEN_DRAW_MODE_PREVIOUS](state) {
      return state.drawModePrevious;
    },
  },
  /* eslint-disable no-param-reassign */
  mutations: {
    [SET_PEN_TOOL_DIAMETER](state, diameter) {
      if (typeof diameter === 'undefined' || Number.isNaN(diameter)) {
        logError(`Could not set pen tool diameter. Diameter: ${diameter} `);
        return;
      }
      // console.log('pen set');
      const rangeDiameter = Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, diameter));
      state.penDiameter = rangeDiameter;
      setPref('brushSize', rangeDiameter);
    },
    [SET_PEN_TOOL_MODE](state, mode) {
      if (!modes.includes(mode)) {
        console.error('Invlaid pen tool mode: ', mode);
        return;
      }
      state.mode = mode;
      setPref('penToolMode', mode);
    },
    [SET_PEN_DRAW_MODE]: (state, drawMode) => {
      // console.log('pen drawMode changed: ', drawMode);
      state.drawMode = drawMode;
      setPref('drawMode', drawMode);
    },
    [SET_PEN_DRAW_MODE_PREVIOUS]: (state, mode) => {
      if (mode) {
        state.drawModePrevious = mode;
        // console.log('SETTING PREVIOUS DRAW MODE 2: ', mode);
      } else {
        state.drawModePrevious = state.drawMode;
        // console.log('SETTING PREVIOUS DRAW MODE: ', state.drawModePrevious);
        setPref('drawModePrevious', state.drawModePrevious);
      }
    },
  },
  actions: {},
};
