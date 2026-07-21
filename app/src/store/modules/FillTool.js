/* eslint-disable import/no-extraneous-dependencies */
import {
  FILL_TOOL_MODE,
  FILL_TOOL_EXPAND,
  FILL_TOOL_RANGE,
  // IS_FILL_METHOD_SEGMAP,
} from '@/store/getter-types';
import {
  SET_FILL_TOOL_MODE,
  SET_FILL_TOOL_EXPAND,
  SET_FILL_TOOL_RANGE,
  // SET_FILL_METHOD_SEGMAP,
  // ADD_COLOR_TO_PALETTE,
} from '@/store/mutation-types';

import { logError } from '@/util/error-util';

export const FILL_TOOL_MODE_FILL = 'fill';
export const FILL_TOOL_MODE_ERASE = 'erase';
export const DEFAULT_EXPAND = 0;
export const DEFAULT_RANGE = 140;
export const MIN_EXPAND = -20;
export const MAX_EXPAND = 20;
export const MIN_RANGE = 1;
export const MAX_RANGE = 255;

const modes = [
  FILL_TOOL_MODE_FILL,
  FILL_TOOL_MODE_ERASE,
];

import { setPref } from '@/platform';

export default {
  state: {
    mode: FILL_TOOL_MODE_FILL,
    expand: DEFAULT_EXPAND,
    range: DEFAULT_RANGE,
    isFillMethodSegmap: true,
  },
  getters: {
    [FILL_TOOL_MODE](state) {
      return state.mode;
    },
    [FILL_TOOL_EXPAND](state) {
      return state.expand;
    },
    [FILL_TOOL_RANGE](state) {
      return state.range;
    },
    /*
    [IS_FILL_METHOD_SEGMAP](state) {
      return state.isFillMethodSegmap;
    },
    */
  },
  /* eslint-disable no-param-reassign */
  mutations: {
    [SET_FILL_TOOL_MODE](state, mode) {
      if (!modes.includes(mode)) {
        console.error('Invlaid fill tool mode: ', mode);
        return;
      }
      state.mode = mode;
      setPref('fillMode', mode);
    },
    [SET_FILL_TOOL_EXPAND](state, expand) {
      if (
        typeof expand === 'undefined'
        || Number.isNaN(expand)
        || expand < MIN_EXPAND
        || expand > MAX_EXPAND
      ) {
        logError(`Could not set fill tool expand. Expand: ${expand} `);
        return;
      }
      state.expand = expand;
      // console.log('expand value: ', expand);
    },
    [SET_FILL_TOOL_RANGE](state, range) {
      if (
        typeof range === 'undefined'
        || Number.isNaN(range)
        || range < MIN_RANGE
        || range > MAX_RANGE
      ) {
        logError(`Could not set fill tool range. Range: ${range} `);
        return;
      }
      state.range = range;
      setPref('fillToolRange', range);
      // console.log('expand value: ', expand);
    },
    /*
    [SET_FILL_METHOD_SEGMAP](state, b) {
      state.isFillMethodSegmap = b;
      setPref('fillMethod', b);
    },
    */
  },
  actions: {},
};
