import store from '@/store';

import { ENABLE_FAKE_COLORIZATION } from '@/store/mutation-types';

/**
 * Enable / disable fake colorization and set the time
 * @param {boolean} enabled
 * @param {number} delayInSec
 */
function useFakeColorization(enabled, delayInSec) {
  store.commit(ENABLE_FAKE_COLORIZATION, {
    enabled,
    delayInMs: delayInSec * 1000,
  });
}

/* eslint-disable import/prefer-default-export */
export function initDevToolsInterface() {
  window.useFakeColorization = useFakeColorization;
  // here you can define more functions to be available on the chromium dev tools
}
