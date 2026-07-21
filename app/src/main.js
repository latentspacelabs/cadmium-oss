/* eslint-disable */
/* eslint-disable import/prefer-default-export */
import Vue from 'vue';
import VueResize from 'vue-resize';
import vueDebounce from 'vue-debounce';
import * as Sentry from '@sentry/electron';
import Element from 'element-ui';
import VueSlider from 'vue-slider-component';
// apply base-styles. Although this electron app will not need cross-browser styles,
// in the future this makes it easier to port it to the web.
import 'normalize.css';
import 'vue-resize/dist/vue-resize.css';
import 'element-ui/lib/theme-chalk/index.css';
import '@/scss/vue-slider.css';
import VueTippy, { TippyComponent } from 'vue-tippy';
import VueTour from 'vue-tour';
import KeyHandler from '@/util/KeyHandler';
import { initDevToolsInterface } from '@/dev-tools-interface';
import { isProduction } from '@/util/app-util';
import '@/util/prevent-default-shortcuts';

import App from './App.vue';

import router from './router';
import store from './store';
import ipcRendererHandlers from './ipc-renderer-handlers';

// OSS: no login. Go straight to the editor.
router.push('/', function onComplete(/* in case we need to do something after */) {});

Vue.use(VueTour);

Vue.use(VueTippy, {
  flipDuration: 0,
  delay: [1000, null],
  popperOptions: {},
});

Vue.component('tippy', TippyComponent);
Vue.component('VueSlider', VueSlider);

// OSS: error-reporting telemetry (Sentry) disabled.

/* eslint-disable no-unused-vars */
const keyHandler = new KeyHandler();

Vue.config.productionTip = false;
Vue.config.devtools = process.env.NODE_ENV === 'development';

Vue.use(VueResize);
Vue.use(vueDebounce);
Vue.use(Element);

export const eventBus = new Vue();

new Vue({
  router,
  store,
  // eslint-disable-next-line
  render: h => h(App),
}).$mount('#app');

// Expose colorization-in-progress getter for Electron main process
window.__cadmiumGetColorizationInProgress = function() {
  return store.getters['colorization_in_progress'];
};

initDevToolsInterface(); // init functions to be available on the chromium dev tools
ipcRendererHandlers();
