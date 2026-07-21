import {
  ZOOM_TOOL_MODE,
} from '@/store/getter-types';
import {
  SET_ZOOM_TOOL_MODE,
} from '@/store/mutation-types';

export const ZOOM_TOOL_MODE_IN = 'zoom-in';
export const ZOOM_TOOL_MODE_OUT = 'zoom-out';

const modes = [
  ZOOM_TOOL_MODE_IN,
  ZOOM_TOOL_MODE_OUT,
];

export default {
  state: {
    mode: ZOOM_TOOL_MODE_IN,
  },
  getters: {
    [ZOOM_TOOL_MODE](state) {
      return state.mode;
    },
  },
  /* eslint-disable no-param-reassign */
  mutations: {
    [SET_ZOOM_TOOL_MODE](state, mode) {
      if (!modes.includes(mode)) {
        console.error('Invalid zoom tool mode: ', mode);
        return;
      }
      state.mode = mode;
    },
  },
  actions: {},
};
