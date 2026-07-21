/* eslint-disable import/no-extraneous-dependencies */
import {
  ERASER_TOOL_DIAMETER,
} from '@/store/getter-types';

import {
  SET_ERASER_TOOL_DIAMETER,
} from '@/store/mutation-types';

import {
  DEFAULT_DIAMETER,
  MIN_DIAMETER,
  MAX_DIAMETER,
} from '@/store/modules/PenTool';

import { logError } from '@/util/error-util';
/*
export const PEN_TOOL_MODE_DRAW = 'draw';
export const PEN_TOOL_MODE_ERASE = 'erase';
export const PEN_DRAW_MODE_OVER = 'source-over';
export const PEN_DRAW_MODE_UNDER = 'destination-over';
export const PEN_DRAW_MODE_WITHIN = 'source-atop';

const modes = [
  PEN_TOOL_MODE_DRAW,
  PEN_TOOL_MODE_ERASE,
];

export const DEFAULT_DIAMETER = 10;
// min diameter of 1 is not visible
// with the current pen diameter calculations
export const MIN_DIAMETER = 1;
export const MAX_DIAMETER = 500;
*/
import { setPref } from '@/platform';

export default {
  state: {
    eraserToolDiameter: DEFAULT_DIAMETER,
    // mode: PEN_TOOL_MODE_DRAW,
    // pen tool draw mode
    // drawMode: PEN_DRAW_MODE_OVER,
  },
  getters: {
    [ERASER_TOOL_DIAMETER](state) {
      return state.eraserToolDiameter;
    },
    /*
    [PEN_TOOL_MODE](state) {
      return state.mode;
    },
    [PEN_DRAW_MODE](state) {
      return state.drawMode;
    },
    */
  },
  /* eslint-disable no-param-reassign */
  mutations: {
    [SET_ERASER_TOOL_DIAMETER](state, diameter) {
      if (typeof diameter === 'undefined' || Number.isNaN(diameter)) {
        logError(`Could not set eraser tool diameter. Diameter: ${diameter} `);
        return;
      }
      const rangeDiameter = Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, diameter));
      state.eraserToolDiameter = rangeDiameter;
      setPref('eraserSize', rangeDiameter);
    },
    /*
    [SET_PEN_TOOL_MODE](state, mode) {
      if (!modes.includes(mode)) {
        console.error('Invlaid pen tool mode: ', mode);
        return;
      }
      state.mode = mode;
      setPref('penToolMode', mode);
    },
    [SET_PEN_DRAW_MODE]: (state, drawMode) => {
      state.drawMode = drawMode;
      setPref('drawMode', drawMode);
    },
    */
  },
  actions: {},
};
