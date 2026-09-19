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
    <div
      v-if="optimizeChip"
      class="optimize-chip"
      :content="serverSettingsTippy"
      v-tippy="{ placement : 'bottom' }"
      @click="$emit('open-server-settings')"
    >
      <span class="optimize-chip__label">{{ optimizeChipText }}</span>
      <div class="optimize-chip__bar">
        <div
          class="optimize-chip__fill"
          :style="{ width: `${optimizeChip.percent}%` }"
        ></div>
      </div>
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
    <sidebar-item
      :content="serverSettingsTippy"
      v-tippy="{ placement : 'bottom' }"
      :iconUrl="icons.serverSettings"
      @click="$emit('open-server-settings')"
      style="margin-top:0px"
    ></sidebar-item>
  </div>
</template> <!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';
import { t } from '@/util/i18n';
import SidebarItem from '@/components/SidebarItem.vue';
import { getLastSidecarStatus, onSidecarStatus } from '@/util/sidecar-status';
import { compilingProgress } from '@/util/optimize-progress-core';
import { BACKEND_HOSTED } from '@/util/server-config';

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
  SERVER_BACKEND,
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
        serverSettings: require('../assets/icons/server-settings.svg'),
      },
      refIconUrl: require('../assets/icons/referenceFolder.svg'),
      referenceToolId: TOOL_CONTROLS_ID_REFERENCE,
      sidecarStatus: getLastSidecarStatus(),
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
    segTippy() { return t('Analyze settings. In here you can adjust how Cadmium detects gaps and color areas.'); },
    refPanelTippy() { return t('Reference Panel. Import reference images to pick colors from.'); },
    serverSettingsTippy() { return t('Server settings. Manage the backend, models, and hardware acceleration.'); },
    // The one-time CoreML compile only — never the routine ~20s startup
    // reload (phase 'loading'), which would flash the chip on every launch.
    // Suppressed on a hosted backend: the embedded sidecar can be compiling
    // in the background (e.g. after a Test connection) while the user's
    // runs never touch it.
    optimizeChip() {
      if (this.serverBackend && this.serverBackend.kind === BACKEND_HOSTED) return null;
      return compilingProgress(this.sidecarStatus);
    },
    optimizeChipText() {
      return t('Optimizing {{pct}}%', { pct: String(this.optimizeChip.percent) });
    },
    ...mapGetters({
      updateInProgress: UPDATE_IN_PROGRESS,
      updatePercentage: UPDATE_PERCENTAGE,
      sidebarItemVisibleById: TOOL_CONTROL_ITEM_IS_VISIBLE,
      toolItemVisibleById: TOOL_CONTROL_ITEM_IS_VISIBLE,
      serverBackend: SERVER_BACKEND,
    }),
  },
  mounted() {
    this.unsubscribeSidecar = onSidecarStatus((status) => {
      this.sidecarStatus = status;
    });
  },
  beforeDestroy() {
    if (this.unsubscribeSidecar) this.unsubscribeSidecar();
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

// One-time model-optimization chip: label + tiny bar, click opens Server
// Settings. Plain divs (not el-progress) so the unscoped .el-progress-bar__*
// overrides above don't fight its styling.
.optimize-chip {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  margin-right: 8px;
  padding: 0 6px;
  cursor: pointer;

  &:hover {
    opacity: 0.85;
  }
}

.optimize-chip__label {
  color: #c5c5c5;
  font-size: 12px;
  white-space: nowrap;
}

.optimize-chip__bar {
  width: 90px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.15);
  overflow: hidden;
}

.optimize-chip__fill {
  height: 100%;
  border-radius: 2px;
  background: #4a90d9;
  transition: width 0.3s ease;
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
