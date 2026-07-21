<!-- eslint-disable linebreak-style -->
<!-- eslint-disable max-len -->

<template>
    <div class="seg-options-container">
      <div
        id="segOptionsHighlightFlasher"
        v-bind:class="{ showSegHighlight: shouldShowSegHighlight }"
      ></div>
      <el-collapse v-model="activeSegOptionsPanes" @change="handleCollapse()">
        <el-collapse-item :title="segOptionsTitle" name="segoptions"
            style="height:100%">
          <template slot="title">
            {{ segOptionsTitle }} <div class="handle tool-handle"></div>
          </template>
          <div class="seg-options">
            <!-- AI Gap Closer Toggle -->
            <div class="segsetting">
              <div
                :content="aiGapCloserToggleTippy"
                v-tippy="{ placement : 'top' }"
                class="settingLabel"
              >{{ aiGapCloserLabel }}</div>
              <el-switch
                :content="aiGapCloserToggleTippy"
                v-tippy="{ placement : 'left' }"
                :value="aiGapCloserEnabled"
                active-color="#A241FD"
                inactive-color="#272727"
                :inactive-text="heuristicText"
                :active-text="aiModeText"
                @change="toggleAiGapCloser"
                class="aiGapCloserSwitch"
              ></el-switch>
            </div>
            <!-- When AI Gap Closer is OFF: Threshold with Auto toggle -->
            <div class="alphaSettings" v-if="!aiGapCloserEnabled">
              <div
                :content="LineThresholdTippy"
                v-tippy="{ placement : 'top' }"
                class="settingLabel"
                style="margin-top: 4px;"
              >{{ LineThresholdLabel }}</div>
              <el-form
                size="mini"
                label-position="top"
                label-width="100px"
                onSubmit="return false;"
                class="thresholdAutoForm"
              >
                <el-form-item>
                  <el-switch
                    :content="toggleAutoAlphaTippy"
                    v-tippy="{ placement : 'left' }"
                    :value="isAutoAlpha"
                    active-color="#A241FD"
                    inactive-color="#272727"
                    :inactive-text="disabledText"
                    :active-text="enabledText"
                    @change="toggleAutoAlpha"
                    class="toggleAutoAlphaSwitch"
                  ></el-switch>
                </el-form-item>
              </el-form>
              <!-- When Threshold Auto is OFF, show slider -->
              <div v-if="!isAutoAlpha">
                <input
                  type="number"
                  id="line-threshold-slider-value"
                  :min="minLineThreshold"
                  :max="maxLineThreshold"
                  class="no-glo sliderTextInput" :value="lineThreshold"
                  @input="onSetLineThresholdText"
                >
                <vue-slider
                    :value="lineThreshold"
                    :drag-on-click="true"
                    @dragging="onSetLineThreshold"
                    @change="onSetLineThreshold"
                    :lazy="true"
                    class="gap-closer-slider line-threshold-slider"
                    tooltip="none"
                    :min="minLineThreshold"
                    :max="maxLineThreshold"
                  ></vue-slider>
              </div>
            </div>

            <!-- When AI Gap Closer is OFF: Trapped Ball Size -->
            <div class="segsetting" v-if="!aiGapCloserEnabled">
              <div
                :content="tbGapCloserTippy"
                v-tippy="{ placement : 'top' }"
                class="settingLabel"
              >{{ tbGapCloserLabel }}</div>
              <div class="gapCloserTextInputs">
                <input
                  type="number"
                  id="tb-gap-close-max-slider-value"
                  :min="minTbGapClose"
                  :max="maxTbGapClose"
                  class="no-glo sliderTextInput" :value="maxTbDilationSize"
                  @input="onSetMaxTbDilationSizeText"
                >
                <vue-slider
                    :value="maxTbDilationSize"
                    :drag-on-click="true"
                    @dragging="onSetMaxTbDilationSize"
                    @change="onSetMaxTbDilationSize"
                    :lazy="true"
                    class="gap-closer-slider line-threshold-slider"
                    tooltip="none"
                    :min="minTbGapClose"
                    :max="maxTbGapClose"
                  ></vue-slider>
              </div>
            </div>


            <!-- When AI Gap Closer is ON: Gap Closing Strength -->
            <div class="segsetting" v-if="aiGapCloserEnabled">
              <div
                :content="aiGapCloserTippy"
                v-tippy="{ placement : 'top' }"
                class="settingLabel"
              >{{ gapClosingStrengthLabel }}</div>
              <div class="gapCloserTextInputs">
                <input
                  type="number"
                  id="ai-gap-close-max-slider-value"
                  :min="minAiGapClose"
                  :max="maxAiGapClose"
                  class="no-glo sliderTextInput" :value="maxAiDilationSize"
                  @input="onSetMaxAiDilationSizeText"
                >
                <vue-slider
                    :value="maxAiDilationSize"
                    :drag-on-click="true"
                    @dragging="onSetMaxAiDilationSize"
                    @change="onSetMaxAiDilationSize"
                    :lazy="true"
                    class="gap-closer-slider line-threshold-slider"
                    tooltip="none"
                    :min="minAiGapClose"
                    :max="maxAiGapClose"
                  ></vue-slider>
              </div>
            </div>

            <!-- Always shown: Minimum Segment Size -->
            <div class="segsetting">
              <div
                :content="minSegSizeTippy"
                v-tippy="{ placement : 'top' }"
                class="settingLabel"
              >{{ MinSegSizeLabel }}</div>
              <div class="minSegSizeTextInputs">
                <input
                type="number"
                id="min-seg-size-slider-value"
                :min="minSegSizeValue"
                :max="maxSegSizeValue"
                class="no-glo sliderTextInput" :value="minSegSize"
                @input="onSetMinSegSizeText"
                >
                <vue-slider
                    :value="minSegSize"
                    :drag-on-click="true"
                    @dragging="onSetMinSegSize"
                    @change="onSetMinSegSize"
                    :lazy="true"
                    class="gap-closer-slider line-threshold-slider"
                    tooltip="none"
                    :min="minSegSizeValue"
                    :max="maxSegSizeValue"
                  ></vue-slider>
              </div>
            </div>

            <!-- Rainbow Return -->
            <div class="segsetting" style="margin-bottom: 15px;">
              <div
                :content="rainbowReturnTippy"
                v-tippy="{ placement : 'top' }"
                class="settingLabel"
              >{{ rainbowLabel }}</div>
              <el-switch
                :content="rainbowReturnTippy"
                v-tippy="{ placement : 'left' }"
                :value="isRainbowEnabled"
                active-color="#A241FD"
                inactive-color="#272727"
                :inactive-text="heuristicText"
                :active-text="aiModeText"
                @change="toggleRainbowMode"
                class="rainbowSwitch"
              ></el-switch>
            </div>
          </div>
        </el-collapse-item>
     </el-collapse>
    </div>

</template> <!-- eslint-disable linebreak-style -->
<!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
/* eslint-disable-next-line */
import { mapGetters, mapMutations, mapActions } from 'vuex';
import { i18n } from '@/util/i18nVue';

import {
  SEG_OPTIONS_COLLAPSE,
  LAYER_HAS_FRAMES,
  RAINBOW_MODE,
  AI_GAP_CLOSER_ENABLED,
  MAX_AI_DILATION_SIZE,
  MAX_TB_DILATION_SIZE,
  MIN_SEG_SIZE,
  LINE_THRESHOLD,
  SEG_PANEL_HIGHLIGHT,
  IS_AUTO_ALPHA,
} from '@/store/getter-types';

import {
  INITIAL_COLOR_LAYER_ID,
  INITIAL_LINE_LAYER_ID,
} from '@/store/general-types';

import {
  SET_SEG_OPTIONS_COLLAPSE,
  SET_RAINBOW_MODE,
  SET_AI_GAP_CLOSER_ENABLED,
  SET_MAX_AI_DILATION_SIZE,
  SET_MAX_TB_DILATION_SIZE,
  SET_LINE_THRESHOLD,
  SET_MIN_SEG_SIZE,
  TOGGLE_AUTO_ALPHA,
} from '@/store/mutation-types';

export default {
  data() {
    return {
      minAiGapClose: 0,
      maxAiGapClose: 30,
      minTbGapClose: 0,
      maxTbGapClose: 30,
      minSegSizeValue: 1,
      maxSegSizeValue: 100,
      minLineThreshold: 0,
      maxLineThreshold: 254,
      activeSegOptionsPanes: [],
    };
  },
  computed: {
    greyOutAnalyzeButton() {
      return !this.layerHasFrames(INITIAL_LINE_LAYER_ID)
        || !this.layerHasFrames(INITIAL_COLOR_LAYER_ID);
    },
    toggleAutoAlphaTippy() { return i18n.__('If enabled, the alpha threshold will be automatically determined.'); },
    aiGapCloserToggleTippy() { return i18n.__('Enable AI-powered gap closing for better results with sketchy linework.'); },
    aiModeText() { return i18n.__('ENABLED'); },
    heuristicText() { return i18n.__('DISABLED'); },
    enabledText() { return i18n.__('AUTO'); },
    disabledText() { return i18n.__('AUTO'); },
    aiGapCloserTippy() { return i18n.__('The higher the number, the more Cadmium will use ai to close gaps.'); },
    tbGapCloserTippy() { return i18n.__('The higher the number, the more Cadmium will use traditional methods close gaps in your linework.'); },
    segOptionsTitle() { return i18n.__('ANALYZE SETTINGS'); },
    LineThresholdTippy() { return i18n.__('This controls how opaque a pixel needs to be in order to be considered a boundary. A higher threshold value will include more more transparent pixels, and a lower value will exclude them.'); },
    minSegSizeTippy() { return i18n.__('This is the minimum numbers of pixels inside of a color segment. If you are getting a lot of extra small color areas inside of rough lines, try increasing this value to merge these small areas into larger ones'); },
    rainbowLabel() { return i18n.__('Rainbow Return'); },
    aiGapCloserLabel() { return i18n.__('AI Gap Closing'); },
    gapClosingStrengthLabel() { return i18n.__('Gap Closing Strength'); },
    tbGapCloserLabel() { return i18n.__('Trapped Ball Size'); },
    MinSegSizeLabel() { return i18n.__('Minimum Segment Size'); },
    LineThresholdLabel() { return i18n.__('Threshold'); },
    rainbowReturnTippy() { return i18n.__('After analyzing a frame, return a colorful image that shows the different color segments.'); },

    ...mapGetters({
      collapse: SEG_OPTIONS_COLLAPSE,
      layerHasFrames: LAYER_HAS_FRAMES,
      rainbowMode: RAINBOW_MODE,
      aiGapCloserEnabled: AI_GAP_CLOSER_ENABLED,
      maxAiDilationSize: MAX_AI_DILATION_SIZE,
      maxTbDilationSize: MAX_TB_DILATION_SIZE,
      minSegSize: MIN_SEG_SIZE,
      lineThreshold: LINE_THRESHOLD,
      segPanelHighlight: SEG_PANEL_HIGHLIGHT,
      isAutoAlpha: IS_AUTO_ALPHA,
    }),
    shouldShowSegHighlight() {
      return this.segPanelHighlight;
    },
    isRainbowEnabled() {
      return this.rainbowMode === 'on';
    },
    dragOptions() {
      return {
        animation: 200,
        group: 'description',
        disabled: false,
        ghostClass: 'ghost',
      };
    },
  },
  methods: {
    toggleAiGapCloser(value) {
      this.$store.commit(SET_AI_GAP_CLOSER_ENABLED, value);
    },
    toggleAutoAlpha() {
      this.$store.commit(TOGGLE_AUTO_ALPHA);
    },
    toggleRainbowMode(value) {
      const modeId = value ? 'on' : 'off';
      this.$store.commit(SET_RAINBOW_MODE, modeId);
    },
    onSetMaxAiDilationSizeText() {
      const val = document.getElementById('ai-gap-close-max-slider-value').value;
      const num = Number(val);
      this.setMaxAiDilationSize(num);
    },
    onSetMaxAiDilationSize(value) {
      this.setMaxAiDilationSize(value);
    },
    onSetMaxTbDilationSizeText() {
      const val = document.getElementById('tb-gap-close-max-slider-value').value;
      const num = Number(val);
      this.setMaxTbDilationSize(num);
    },
    onSetMaxTbDilationSize(value) {
      this.setMaxTbDilationSize(value);
    },
    onSetMinSegSizeText() {
      const val = document.getElementById('min-seg-size-slider-value').value;
      const num = Number(val);
      this.setMinSegSize(num);
    },
    onSetMinSegSize(value) {
      this.setMinSegSize(value);
    },
    onSetLineThreshold(value) {
      this.setLineThreshold(value);
    },
    onSetLineThresholdText() {
      const val = document.getElementById('line-threshold-slider-value').value;
      const num = Number(val);
      this.setLineThreshold(num);
    },
    handleCollapse() {
      const segOptionsPanes = this.activeSegOptionsPanes;
      console.log('Seg Options Pane', segOptionsPanes);
      this.setSegOptionsCollapse(segOptionsPanes);
    },
    loadCollapse() {
      this.activeSegOptionsPanes = this.collapse;
    },
    ...mapActions({
    }),
    ...mapMutations({
      setSegOptionsCollapse: SET_SEG_OPTIONS_COLLAPSE,
      setAiGapCloserEnabled: SET_AI_GAP_CLOSER_ENABLED,
      setMaxAiDilationSize: SET_MAX_AI_DILATION_SIZE,
      setMaxTbDilationSize: SET_MAX_TB_DILATION_SIZE,
      setLineThreshold: SET_LINE_THRESHOLD,
      setMinSegSize: SET_MIN_SEG_SIZE,
    }),
  },
  watch: {
  },
  mounted() {
  },
  created() {
    this.loadCollapse();
  },
  updated() {
  },
};

</script>

<style lang="scss">
@import '../scss/modules/general.scss';

.alphaSettings {
  display: inline-block;
  width: 100%;
  margin-bottom: 10px;
  position: relative;
}

.toggleAutoAlphaSwitch {
  width: 60px;
}

.toggleAutoAlphaSwitch .el-switch__label span{
  position: absolute;
  top: 5px;
  left: -3px;
  font-size: 11px;
}

.aiGapCloserSwitch {
  width: 70%;
}

.rainbowSwitch {
  width: 70%;
}

.thresholdAutoForm {
  position: absolute;
  top: 0;
  right: 0;
  width: 82px;
}

.thresholdAutoForm .el-form-item {
  margin-bottom: 0;
}

.settingLabel {
  color: #606266;
  margin-bottom:5px;
}

.seg-options-container {
  margin-top: -26px;
  position: relative;
}

.seg-options {
  padding-left: var(--space-md);
  padding-right: var(--space-md);
  margin-top: 10px;
}

.segsetting {
  height: 60px; 
}


.sliderTextInput{
  width: 32px;
  font-size: 8pt;
  background-color: #4e4e4e;
  border: 0;
  color: #fff;
  text-align: center;
  border-radius: 10px;
  padding-right: 4px;
  padding-left: 4px;
  padding-top: 4px;
  padding-bottom: 3px;
}

.gapCloserTextInputs{
  height: 20px;
}

#ai-gap-close-min-slider-value{
  float: left;
}

#tb-gap-close-min-slider-value{
  float: left;
}

#ai-gap-close-max-slider-value{
  float: left;
}

#tb-gap-close-max-slider-value{
  float: left;
}

#min-seg-size-slider-value{
  float:left;
}

#line-threshold-slider-value{
  float: left;
}

.line-threshold-slider{
  margin-left:42px;
}

#segOptionsHighlightFlasher{
    position: absolute;
    background: purple;
    width: 100%;
    height: 100%;
    z-index: 10;
    display: none;
}

@keyframes blinker {
  0% {opacity: 0;}
  // 20% {opacity: .1;}
  40% {opacity: .4;}
  50% {opacity: .5;}
  60% {opacity: .4;}
  // 80% {opacity: .1;}
  100% {opacity: 0;}
}

.showSegHighlight{
  display: block !important;
  animation: blinker 1s linear infinite;
}
</style>
