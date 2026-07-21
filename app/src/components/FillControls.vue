<!-- eslint-disable linebreak-style -->
<template>
  <div class="fill-controls-container">
    <el-collapse v-model="activeFillPane" @change="handleCollapse">
      <el-collapse-item title="FILL" name="fill">
        <template slot="title">
          {{ FillLabel }} <div class="handle tool-handle"></div>
        </template>
        <div class="fill-controls">
          <el-form
            size="mini"
            label-position="top"
            label-width="100px"
            onSubmit="return false;"
          >
            <el-form-item>
              <div class="el-form-item__label">{{ ModeLabel }}</div>
              <two-state-toggle
                :content="fillModeTippy"
                v-tippy="{ placement : 'top' }"
                optionOneLabel="Fill"
                optionTwoLabel="Erase"
                :optionOneId="fillModeId"
                :optionTwoId="eraseModeId"
                :selectedOptionId="mode"
                @click="onOptionClick"
              ></two-state-toggle>
            </el-form-item>
            <!-- Comment
            <div class="control-row__input-label">expand</div>
              <el-slider
                :value="expand"
                :step="1"
                :min="minExpand"
                :max="maxExpand"
                @input="onExpandSliderInput"
              >
              </el-slider>
              -->
          </el-form>
          <round-button
            class="swatchButtons"
            text="Adjust Settings"
            size="s"
            @click="onAdjustSettingsClick"
            color="white-outline"
            :style="{
              height: '24px',
              width: '160px',
              fontSize: '12px',
              textTransform: 'lowercase',
              marginBottom: '20px',
              marginTop: '10px',
              opacity: .4,
           }"
           ></round-button>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template> <!-- eslint-disable linebreak-style -->
<!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
// removed from el-slider:
// :show-tooltip="false"
// :show-input="true"
// :input-size="mini"

import { t } from '@/util/i18n';

import { mapGetters, mapMutations } from 'vuex';

import {
  FILL_TOOL_MODE_FILL,
  FILL_TOOL_MODE_ERASE,
  MIN_EXPAND,
  MAX_EXPAND,
  MIN_RANGE,
  MAX_RANGE,
} from '@/store/modules/FillTool';

import {
  FILL_TOOL_MODE,
  FILL_TOOL_EXPAND,
  FILL_TOOL_RANGE,
  FILL_COLLAPSE,
  // IS_FILL_METHOD_SEGMAP,
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  SEG_PANEL_HIGHLIGHT,
} from '@/store/getter-types';

import {
  SET_FILL_TOOL_MODE,
  SET_FILL_TOOL_EXPAND,
  SET_FILL_TOOL_RANGE,
  SET_FILL_COLLAPSE,
  SET_SEG_PANEL_HIGHLIGHT,
  // SET_FILL_METHOD_SEGMAP,
} from '@/store/mutation-types';

import {
  ACTIVATE_TOOL_BY_ID,
} from '@/store/action-types';

import {
  TOOL_CONTROLS_SEG_OPTIONS,
} from '@/store/modules/ToolControls';

import TwoStateToggle from '@/components/TwoStateToggle.vue';
import RoundButton from '@/components/RoundButton.vue';

export default {
  data() {
    return {
      fillModeId: FILL_TOOL_MODE_FILL,
      eraseModeId: FILL_TOOL_MODE_ERASE,
      currentExpand: 0,
      // currentRange: 253,
      minExpand: MIN_EXPAND,
      maxExpand: MAX_EXPAND,
      minRange: MIN_RANGE,
      maxRange: MAX_RANGE,
      activeFillPane: [],
      segOptionsToolId: TOOL_CONTROLS_SEG_OPTIONS,
    };
  },
  computed: {
    FillLabel() { return t('FILL'); },
    ModeLabel() { return t('Mode'); },
    fillModeTippy() { return t('Fill Tool Mode Toggle (D)'); },
    alphaBoundaryTippy() { return t('This slider adjusts how sensitive the fill tool is to transparent pixels. All the way to the right only sees completely solid color as boundaries.'); },
    ...mapGetters({
      mode: FILL_TOOL_MODE,
      expand: FILL_TOOL_EXPAND,
      range: FILL_TOOL_RANGE,
      fillCollapse: FILL_COLLAPSE,
      toolControlItemIsVisible: TOOL_CONTROL_ITEM_IS_VISIBLE,
      // isFillMethodSegmap: IS_FILL_METHOD_SEGMAP,
      segPanelHighlight: SEG_PANEL_HIGHLIGHT,
    }),
  },
  methods: {
    onAdjustSettingsClick() {
      if (this.toolControlItemIsVisible(this.segOptionsToolId)) {
        if (!this.segPanelHighlight) {
          this.setSegPanelHighlight(true);
          setTimeout(() => this.setSegPanelHighlight(false), 2000);
        }
      } else {
        this.$store.dispatch(ACTIVATE_TOOL_BY_ID, {
          toolId: this.segOptionsToolId,
          preventReActivation: true, // special case for color picker
        });
      }
    },
    ...mapMutations({
      setFillToolRange: SET_FILL_TOOL_RANGE,
      setFillCollapse: SET_FILL_COLLAPSE,
      setSegPanelHighlight: SET_SEG_PANEL_HIGHLIGHT,
    }),
    onOptionClick(modeId) {
      console.log('modeId: ', modeId);
      this.$store.commit(SET_FILL_TOOL_MODE, modeId);
    },
    onExpandSliderInput(val) {
      this.$store.commit(SET_FILL_TOOL_EXPAND, val);
    },
    onRangeSliderInput(val) {
      this.setFillToolRange(val);
      console.log('range: ', this.range);
    },
    onRangeSliderInputText() {
      const val = document.getElementById('fill-slider-value').value;
      const num = Number(val);
      // console.log('INPUT TEXT: ', num);
      this.setFillToolRange(num);
    },
    handleCollapse() {
      const fillPane = this.activeFillPane;
      this.setFillCollapse(fillPane);
      // console.log('PANE COLLAPSE', fillPane);
    },
    loadCollapse() {
      this.activeFillPane = this.fillCollapse;
    },
  },
  components: {
    TwoStateToggle,
    RoundButton,
  },
  created() {
    this.loadCollapse();
  },
};
</script>

<style lang="scss">

.control-row__input-label {
  margin-top: 2px;
  font-size: 13px;
  color: #939393;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: var(--space-xxs);
}

.el-form-item.el-form-item--mini {
  margin-bottom: 8px;
  .el-form-item__label {
    display: inline;
    padding-bottom: 2px;
  }
}

.el-switch__label.is-active {
  color: #e9e9e9;
  display:inline-block;
}
.el-switch__label--left {
  display:none;
  text-transform: uppercase;
  text-align: center;
  position: absolute;
  margin-left:25px;
  z-index: 1;
}

.el-switch__label--right {
  display:none;
  text-transform: uppercase;
  text-align: center;
  position: absolute;
  padding-left:7px;
  z-index: 1;
}

.el-switch__core {
  width: 100% !important;
}

.fillMethod {
  width: 100px;
}

.slider-value{
  width: 32px;
  float: left;
  margin-top: 10px;
  font-size: 8pt;
  background-color : #4e4e4e;
  border:0;
  color: white;
  text-align:center;
  border-radius:10px;
  padding-right:4px;
  padding-left:4px;
  padding-top:4px;
  padding-bottom:3px;

}

.slider-value:focus{
  outline-width: 0;
  box-shadow: 0 0 5px #9834d3;
}

.two-state-toggle:focus{
  outline-width: 0;
}

.elModeToggle .two-state-toggle__option--two {
  line-height: 1;
  text-align: center;
  font-size: 10px;
}

input[type=number]::-webkit-inner-spin-button,
input[type=number]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.fill-slider{
  width: 115px;
  margin-left:48px;
}

.fill-controls{
  padding-left: var(--space-md);
  padding-right: var(--space-md);
  margin-top: 10px;
}

.fill-controls-container{
  margin-top: -26px;
}

.alphaBoundary{
  display: block;
}

.deactivate{
  display: none !important;
}

.fill-slider-wrapper {
  margin-bottom:10px;
}

.fill-slider-value {
  width: 32px;
  float: left;
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

.elToggleItem {
  display: none;
}

.showElToggle {
  display: block !important;
}

</style>
