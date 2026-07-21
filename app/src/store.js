import Vue from 'vue';
import Vuex from 'vuex';

import state from './store/state';
import getters from './store/getters';
import mutations from './store/mutations';
import actions from './store/actions';

import ToolControls from './store/modules/ToolControls';
import FillTool from './store/modules/FillTool';
import PenTool from './store/modules/PenTool';
import EraserTool from './store/modules/EraserTool';
import ZoomTool from './store/modules/ZoomTool';
import ImageStore from './store/modules/ImageStore';
import Pressure from './store/modules/Pressure';

import undoRedoPlugin from './store/undo-redo-plugin';

Vue.config.devtools = true;

Vue.use(Vuex);

export default new Vuex.Store({
  state,
  getters,
  mutations,
  actions,
  modules: {
    ToolControls,
    FillTool,
    PenTool,
    EraserTool,
    ZoomTool,
    ImageStore,
    Pressure,
  },
  plugins: [undoRedoPlugin],
});
