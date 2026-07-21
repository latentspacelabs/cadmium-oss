<!-- eslint-disable linebreak-style -->
<!-- eslint-disable max-len -->

<template>
  <div class="nav-bar-icons">
    <div v-if=updateInProgress class="updater-progress-bar">
      <div class="update-text">
         Downloading Update:
      </div>
      <el-progress
       :text-inside="true"
       :stroke-width="12"
       :percentage=updatePercentage
       color="#292929"
      >
      </el-progress>
    </div>
    <sidebar-item
      class="step-20 step-21"
      :content="segTippy"
      v-tippy="{ placement : 'left' }"
      :iconUrl="icons.segOptions"
      :isPressed="sidebarItemVisibleById(segOptionsToolId)"
      :isHighlighted="sidebarItemVisibleById(segOptionsToolId)"
      @click="onSidebarItemClick(segOptionsToolId)"
      style="margin-top:0px"
    ></sidebar-item>
    <div
      :content="refPanelTippy"
      v-tippy="{ placement : 'bottom' }"
      @click="onNavBarToolClick(referenceToolId)"
      class="referencePanelButton step-24"
      v-bind:class="{ 'sidebar-item--is-highlighted': toolItemVisibleById(referenceToolId) }"
    >
    <img
      class="referencePanelSVG sidebar-item__icon"
      :src="refIconUrl"
    >
    </div>
  </div>
</template> <!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';
import { i18n } from '@/util/i18nVue';
import SidebarItem from '@/components/SidebarItem.vue';

import {
  // EXPORT,
  SHOW_HELP,
  ACTIVATE_TOOL_BY_ID,
  // OPEN_FEEDBACK_DIALOG,
} from '@/store/action-types';

import {
  SET_UPDATE_PERCENTAGE,
  SET_UPDATE_IN_PROGRESS,
} from '@/store/mutation-types';

import {
  UPDATE_IN_PROGRESS,
  UPDATE_PERCENTAGE,
  TOOL_CONTROL_ITEM_IS_VISIBLE,
} from '@/store/getter-types';

import {
  TOOL_CONTROLS_ID_REFERENCE,
  TOOL_CONTROLS_SEG_OPTIONS,
} from '@/store/modules/ToolControls';

// const exportIcon = require('../assets/icons/export.svg');
const helpIcon = require('../assets/icons/help.svg');
// const feedbackIcon = require('../assets/icons/feedback.svg');

export default {
  data() {
    return {
      /* eslint-disable global-require */
      segOptionsToolId: TOOL_CONTROLS_SEG_OPTIONS,
      icons: {
        segOptions: require('../assets/icons/seg-options.svg'),
      },
      refIconUrl: require('../assets/icons/referenceFolder.svg'),
      referenceToolId: TOOL_CONTROLS_ID_REFERENCE,
      items: [
        // {
        //   title: 'Export',
        //   icon: exportIcon,
        //   action: EXPORT,
        // },
        {
          title: '',
          icon: helpIcon,
          action: SHOW_HELP,
        },
        /*
        {
          title: 'Feedback',
          icon: feedbackIcon,
          action: OPEN_FEEDBACK_DIALOG,
        },
        */
      ],
    };
  },
  computed: {
    segTippy() { return i18n.__('Analyze settings. In here you can adjust how Cadmium detects gaps and color areas.'); },
    refPanelTippy() { return i18n.__('Reference Panel. Import reference images to pick colors from.'); },
    ...mapGetters({
      updateInProgress: UPDATE_IN_PROGRESS,
      updatePercentage: UPDATE_PERCENTAGE,
      sidebarItemVisibleById: TOOL_CONTROL_ITEM_IS_VISIBLE,
      toolItemVisibleById: TOOL_CONTROL_ITEM_IS_VISIBLE,
    }),
  },
  methods: {
    onSidebarItemClick(itemType) {
      this.$store.dispatch(ACTIVATE_TOOL_BY_ID, {
        toolId: itemType,
        preventReActivation: true, // special case for color picker
      });
    },
    onItemClick(action) {
      this.$store.dispatch(action);
    },
    onNavBarToolClick(itemType) {
      this.$store.dispatch(ACTIVATE_TOOL_BY_ID, {
        toolId: itemType,
        preventReActivation: true, // special case for color picker
      });
    },
    ...mapMutations({
      setUpdateInProgress: SET_UPDATE_IN_PROGRESS,
      setUpdatePercentage: SET_UPDATE_PERCENTAGE,
    }),
    onUpdateInProgress(value) {
      this.setUpdateInProgress(value);
    },
    onUpdatePercentage(value) {
      this.setUpdatePercentage(value);
    },
  },
  components: {
    SidebarItem,
  },
};
</script>

<style lang="scss">
.nav-bar-icons {
  display: flex;
  margin-right: 12px;

  .icon-button-with-label + .icon-button-with-label {
    margin-left: 20px;
  }
  .icon-button-with-label__icon {
    margin-bottom: 0px;
  }
  .sidebar-item {
    align-items: baseline;
    margin-left: 12px;
    width:34px;
    height:34px;

    .sidebar-item__icon {
    height: 34px;
    }
  }

}

.updater-progress-bar{
  height: 28px;
  width: 340px;
  padding-right: 20px;
  margin-top: 10px;
}

.update-text{
  position: relative;
  float: left;
  margin-top: 2px;
  color: #262626;
  font-size:13px;
}

.progress-bar{
  width: 180px;
  float: right;
}

.el-progress-bar__innerText{
  display:none;
}

.el-progress-bar__outer{
  background-color: #393939;
  border-color: #262626;
  border-style: solid;
}

.el-progress-bar__inner{

}

.referencePanelButton {
  width: 34px;
  margin-left: 12px;
  cursor: pointer;
}

.referencePanelButton:hover {
  opacity: 0.8;
}

.referencePanelSVG {
  height:34px;
}
</style>
