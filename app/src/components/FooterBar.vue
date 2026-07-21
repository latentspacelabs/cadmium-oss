<!-- eslint-disable linebreak-style -->
<template>
  <!-- eslint-disable max-len -->
  <div class="footer-bar"
  :class="{ 'footer-bar--visible': isTimelineVisible }"
  >
    <round-button
      :text="analyzeButtonText"
      @click="onAnalyzeButtonClick"
      color="white-outline"
      :disabled="greyOutAnalyzeButton"
      :style="{
        position: 'absolute',
        left: '20px',
      }"
      :content="analyzeTippy"
      v-tippy="{ placement : 'top' }"
      class="no-glo step-16a"
    ></round-button>
    <round-button
      :text="colorizeButtonText"
      @click="onColorizeButtonClick"
      :disabled="greyOutColorizeButton"
      :content="colorizeTippy"
      v-tippy="{ placement : 'top' }"
      class="no-glo step-11"
    ></round-button>
    <el-dropdown
      class="exportButton step-14"
      split-button
      type="primary"
      @click="onExportButtonClick"
      v-bind:class="{ exportDisabled: greyOutExportButton }"
      :style="{
        position: 'absolute',
        right: '20px',
      }"
    >
      {{ ExportLabel }}
      <el-dropdown-menu slot="dropdown">
        <el-dropdown-item>
        <span
          class="dropdown-fullclick"
          @click="onExportSeparateColorsClick"
        >
          {{ ExportSeparatedLabel }}
        </span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </el-dropdown>
    <input type="file" id="import-from-menu-button"
    multiple accept=".png" style="visible: hidden; width:0px; height:0px;">

  </div>
</template> <!-- eslint-disable linebreak-style -->

<script>
/* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';

import { t } from '@/util/i18n';
import showCustomDialog from '@/util/customDialog';

import {
  LAYER_HAS_FRAMES,
  SELECTED_FRAME_NRS_ON_ALL_LAYERS,
  COLORIZATION_IN_PROGRESS,
  TIMELINE_HAS_FRAMES,
  ANALYZE_MODE_ONLY,
  TIMELINE_VISIBILITY,
} from '@/store/getter-types';

import {
  SET_ANALYZE_MODE_ONLY,
} from '@/store/mutation-types';

import {
  COLORIZE,
  // CANCEL_COLORIZATION,
  EXPORT_DIALOG,
  EXPORT_COLORS_SEPARATED,
  // IMPORT_FILES_LINES,
} from '@/store/action-types';

import {
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
} from '@/store/general-types';

import RoundButton from '@/components/RoundButton.vue';

const colorizeButtonActions = {
  COLORIZE_SELECTION: 'COLORIZE_SELECTION',
  COLORIZE_ALL: 'COLORIZE_ALL',
  // CANCEL_COLORIZATION: 'CANCEL_COLORIZATION',
  COLORIZING: 'COLORIZING...',
};
Object.freeze(colorizeButtonActions);

const analyzeButtonActions = {
  ANALYZE_SELECTION: 'ANALYZE_SELECTION',
  ANALYZE_ALL: 'ANALYZE_ALL',
  // CANCEL_COLORIZATION: 'CANCEL_COLORIZATION',
  ANALYZING: 'ANALYZING...',
};
Object.freeze(analyzeButtonActions);

export default {
  data() {
    return {
    };
  },
  computed: {
    ExportLabel() { return t('EXPORT'); },
    ExportSeparatedLabel() { return t('Export Colors Separated'); },
    analyzeTippy() { return t('This button will analyze the different regions of the selected frames, and return random colors to show you which areas are separated by lines.'); },
    gapCloserTippy() { return t('The higher the number, the more Cadmium will automatically close gaps in your linework.'); },
    colorizeTippy() { return t('AI Magic'); },
    ...mapGetters({
      timelineHasFrames: TIMELINE_HAS_FRAMES,
      selectedFrameNrsOnAllLayers: SELECTED_FRAME_NRS_ON_ALL_LAYERS,
      colorizationInProgress: COLORIZATION_IN_PROGRESS,
      layerHasFrames: LAYER_HAS_FRAMES,
      analyzeModeOnly: ANALYZE_MODE_ONLY,
      isTimelineVisible: TIMELINE_VISIBILITY,
    }),
    greyOutExportButton() {
      // return !this.timelineHasFrames;
      return !this.layerHasFrames(INITIAL_LINE_LAYER_ID)
        || !this.layerHasFrames(INITIAL_COLOR_LAYER_ID);
    },
    greyOutColorizeButton() {
      return !this.layerHasFrames(INITIAL_LINE_LAYER_ID)
        || !this.layerHasFrames(INITIAL_COLOR_LAYER_ID);
    },
    colorizeButtonAction() {
      if (this.colorizationInProgress) {
        return colorizeButtonActions.COLORIZING;
      } if (this.selectedFrameNrsOnAllLayers.length > 0) {
        return colorizeButtonActions.COLORIZE_SELECTION;
      }
      return colorizeButtonActions.COLORIZE_ALL;
    },
    colorizeButtonText() {
      switch (this.colorizeButtonAction) {
        case colorizeButtonActions.COLORIZE_ALL:
          return t('Colorize');
        case colorizeButtonActions.COLORIZE_SELECTION:
          return t('Colorize Selection');
        // case colorizeButtonActions.CANCEL_COLORIZATION:
          // return 'Cancel Colorization';
        case colorizeButtonActions.COLORIZING:
          if (!this.analyzeModeOnly) {
            return t('Colorizing');
          }
          /* falls through */
        default:
          return t('Colorize');
      }
    },
    greyOutAnalyzeButton() {
      return !this.layerHasFrames(INITIAL_LINE_LAYER_ID)
        || !this.layerHasFrames(INITIAL_COLOR_LAYER_ID);
    },
    analyzeButtonAction() {
      if (this.colorizationInProgress) {
        return analyzeButtonActions.ANALYZING;
      } if (this.selectedFrameNrsOnAllLayers.length > 0) {
        return analyzeButtonActions.ANALYZE_SELECTION;
      }
      return analyzeButtonActions.ANALYZE_ALL;
    },
    analyzeButtonText() {
      switch (this.analyzeButtonAction) {
        case analyzeButtonActions.ANALYZE_ALL:
          return t('Analyze');
        case analyzeButtonActions.ANALYZE_SELECTION:
          return t('Analyze Selection');
        case analyzeButtonActions.CANCEL_ANALYZATION:
          return t('Cancel Analyzation');
        case analyzeButtonActions.ANALYZING:
          if (this.analyzeModeOnly) {
            return t('Analyzing');
          }
          /* falls through */
        default:
          return t('Analyze');
      }
    },

  },
  methods: {
    ...mapMutations({
      setAnalyzeModeOnly: SET_ANALYZE_MODE_ONLY,
    }),
    onColorizeButtonClick() {
      this.setAnalyzeModeOnly(false);
      switch (this.colorizeButtonAction) {
        case colorizeButtonActions.COLORIZE_ALL:
        case colorizeButtonActions.COLORIZE_SELECTION:
          console.log('colorizing...');
          this.$store.dispatch(COLORIZE);
          break;
        default:
          console.warn(`colorizeButtonActions is in bad state: ${this.colorizeButtonAction}`);
          break;
      }
    },
    onAnalyzeButtonClick() {
      this.setAnalyzeModeOnly(true);
      switch (this.analyzeButtonAction) {
        case analyzeButtonActions.ANALYZE_ALL:
        case analyzeButtonActions.ANALYZE_SELECTION:
          console.log('analyzing...');
          this.$store.dispatch(COLORIZE);
          break;
        default:
          console.warn(`analyzeButtonActions is in bad state: ${this.analyzeButtonAction}`);
          break;
      }
    },

    onExportButtonClick() {
      this.$store.dispatch(EXPORT_DIALOG);
    },
    async onExportSeparateColorsClick() {
      this.$store.dispatch(EXPORT_COLORS_SEPARATED);
    },
  },
  components: {
    RoundButton,
  },
};

</script>

<style lang="scss">

.no-glo:focus{
  outline-width: 0;
}

.footer-bar {
  display: none;
  &--visible {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    height: 80px;
    background-color: #272727;
  }
}

.el-form-item__label{
  width:100px !important;

}

.el-input-number {
  position: absolute;
  width: 70px;
  color: white;
  text-align: center;
  margin-top:3px;

  &.is-disabled {
    opacity: 0.2;
    pointer-events: none;
  }

  &.is-controls-right {

    .el-input__inner  {
      padding-right: 30px;
      padding-left: 0px;
      border-radius: 15px;
      border: 1px solid #dcdcdc;
      background: #272727;
      color: white;
    }

    .el-input-number__increase {
      border-radius: 0 12px 0 0;
      background: #dcdcdc;
      // border: 1px solid #272727;
      color: #272727;
    }

    .el-input-number__decrease {
      border-radius: 0 0 12px 0;
      background: #dcdcdc;
      // border: 1px solid #272727;
      color: #272727;
    }

  }
}

.exportButton {
  height: 46px;
  font-size: 15px;
  letter-spacing: .05em;
  border-radius: 30px;
  padding: 0 10px;
  border: 1px solid #fff;
  font-family: "Inter";
}

.exportDisabled {
  opacity: .2;
  pointer-events: none;
}

.el-button--primary {
  background: none;
  border: none;
  padding: 15px 20px;
}

.el-button--primary:hover {
  background: none;
  border-top-left-radius: 30px;
  border-bottom-left-radius: 30px;
  opacity: .8;
}

.el-button:focus {
  background: none !important;
  border: none;
}

.el-button--primary:hover {
  background: none;
  border-top-left-radius: 30px;
  border-bottom-left-radius: 30px;
  opacity: .8;
}

.el-dropdown-menu {
  background-color: #272727;
  border: 1px solid #FFFFFF;
  color: #FFFFFF;
}

.el-button.is-active {
  background: none;
  border: none;
}

.el-dropdown-menu__item {
  color: #FFFFFF;
  padding: 0px 0px !important;
}

.el-dropdown-menu__item:hover {
  color: #FFFFFF !important;
  background-color: #9834D3 !important;
}

.dropdown-fullclick {
  display: block;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 0px 10px !important;
}

.el-button--primary:focus {
  background: none;
  border: none;
}

.el-button:focus {
  background: none;
  border: none;
}

.el-item {
  background-color: blue;
  color: white;
}

.el-button:focus {
  color: #FFFFFF;
  background-color: #414141;
}

</style>
