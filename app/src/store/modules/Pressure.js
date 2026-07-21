/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable */
import {
  IS_PRESSURE_ENABLED,
} from '@/store/getter-types';

import {
  SET_PRESSURE_ENABLED,
} from '@/store/mutation-types';

import { setPref } from '@/platform';

export default {
  state: {
    pressureEnabled: true,
  },
  getters: {
    [IS_PRESSURE_ENABLED]: state => state.pressureEnabled,
  },
  mutations: {
    [SET_PRESSURE_ENABLED]: (state, b) => {
      state.pressureEnabled = b;
      setPref('pressure', b);
    },
  },
};
