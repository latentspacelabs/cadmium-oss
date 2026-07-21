<!-- eslint-disable linebreak-style -->
<template>
  <div class="pen-controls-container">
    <el-collapse v-model="activePenPane" @change="handleCollapse">
        <el-collapse-item title="PEN" name="pen">
          <template slot="title">
            {{ PenLabel }} <div class="handle tool-handle"></div>
          </template>
        <div class="pen-controls">
          <el-form
            size="mini"
            label-position="top"
            label-width="100px"
            onSubmit="return false;"
          >
          <el-form-item>
            <div class="el-form-item__label">{{ ModeLabel }}</div>
            <two-state-toggle
              :content="modeTippy"
              v-tippy="{ placement : 'top' }"
              optionOneLabel="Draw"
              optionTwoLabel="Erase"
              :optionOneId="drawModeId"
              :optionTwoId="eraseModeId"
              :selectedOptionId="mode"
              @click="onModeOptionClick"
            ></two-state-toggle>
          </el-form-item>
          <el-form-item>
            <div class="el-form-item__label">{{ SizeLabel }}</div>
          </el-form-item>
          <div
            class="diameter-slider-wrapper"
          >
              <input
                type="number"
                id="size-slider-value"
                :min="minDiam"
                :max="maxDiam"
                class="diameter-slider-value" :value="penDiameter"
                @input="onSliderInputText"
               >
                <vue-slider
                  :value="penDiameter"
                  ref="diameterSliderObject"
                  :min="minDiam"
                  :max="maxDiam"
                  :drag-on-click="true"
                  @dragging="onSliderInput"
                  @change="onSliderInput"
                  :lazy="true"
                  class="fill-slider"
                  tooltip="none"
                ></vue-slider>
          </div>

            <el-form-item>
              <div class="el-form-item__label">{{ DrawOptionsLabel }}</div>
              <three-state-toggle
                :content="optionsTippy"
                v-tippy="{ placement : 'right' }"
                optionOneLabel="over"
                optionTwoLabel="under"
                optionThreeLabel="within"
                :optionOneId="drawOver"
                :optionTwoId="drawUnder"
                :optionThreeId="drawWithin"
                :selectedOptionId="penDrawMode"
                @click="toggleDrawOver"
                class="draw-options toggle-three toggle__option-three"
                :disabled="penDrawModeDisabled"
              ></three-state-toggle>
            </el-form-item>
            <el-form-item>
              <div class="el-form-item__label">{{ PressureLabel }}</div><br>
              <el-switch
                class="pressureSwitch"
                :value="usePressure"
                active-color="#A241FD"
                inactive-color="#272727"
                @change="pressureToggleChanged"
              ></el-switch>
            </el-form-item>
          </el-form>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template> <!-- eslint-disable linebreak-style -->
<!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';

import { t } from '@/util/i18n';

// import InputRange from '@/components/InputRange.vue';
import TwoStateToggle from '@/components/TwoStateToggle.vue';
import ThreeStateToggle from '@/components/ThreeStateToggle.vue';

import {
  // DEFAULT_DIAMETER,
  MIN_DIAMETER,
  MAX_DIAMETER,
  PEN_TOOL_MODE_DRAW,
  PEN_TOOL_MODE_ERASE,
  PEN_DRAW_MODE_OVER,
  PEN_DRAW_MODE_UNDER,
  PEN_DRAW_MODE_WITHIN,
} from '@/store/modules/PenTool';

import {
  PEN_TOOL_DIAMETER,
  PEN_TOOL_MODE,
  IS_PRESSURE_ENABLED,
  PEN_COLLAPSE,
  PEN_DRAW_MODE,
} from '@/store/getter-types';

import {
  SET_PEN_TOOL_DIAMETER,
  SET_PRESSURE_ENABLED,
  SET_PEN_TOOL_MODE,
  SET_PEN_DRAW_MODE,
  SET_PEN_DRAW_MODE_PREVIOUS,
  SET_PEN_COLLAPSE,
} from '@/store/mutation-types';

export default {
  data() {
    return {
      // currentDiam: 1,
      minDiam: MIN_DIAMETER,
      maxDiam: MAX_DIAMETER,
      drawModeId: PEN_TOOL_MODE_DRAW,
      eraseModeId: PEN_TOOL_MODE_ERASE,
      drawOver: PEN_DRAW_MODE_OVER,
      drawUnder: PEN_DRAW_MODE_UNDER,
      drawWithin: PEN_DRAW_MODE_WITHIN,
      activePenPane: [],
    };
  },
  computed: {
    penDrawModeDisabled() {
      return false;
    },
    ModeLabel() { return t('Mode'); },
    SizeLabel() { return t('Size'); },
    PenLabel() { return t('PEN'); },
    modeTippy() { return t('Pen (B) or Erase (E)'); },
    optionsTippy() {
      return t('draw over/under/within existing pixels');
    },
    DrawOptionsLabel() { return t('Draw Options:'); },
    PressureLabel() { return t('Pressure'); },
    ...mapGetters({
      penDiameter: PEN_TOOL_DIAMETER,
      usePressure: IS_PRESSURE_ENABLED,
      penDrawMode: PEN_DRAW_MODE,
      mode: PEN_TOOL_MODE,
      penCollapse: PEN_COLLAPSE,
    }),
  },
  methods: {
    ...mapMutations({
      setPenToolDiameter: SET_PEN_TOOL_DIAMETER,
      setPenCollapse: SET_PEN_COLLAPSE,
      setPenDrawMode: SET_PEN_DRAW_MODE,
    }),
    onSliderInput(val) {
      this.setPenToolDiameter(val);
      // console.log('pen val: ', val);
      // console.log('diameter: ', this.diameter);
    },
    pressureToggleChanged(b) {
      this.$store.commit(SET_PRESSURE_ENABLED, b);
    },
    onModeOptionClick(modeId) {
      console.log('modeId: ', modeId);
      this.$store.commit(SET_PEN_TOOL_MODE, modeId);
    },
    toggleDrawOver(drawingModeId) {
      console.log('toggle drawmode: ', drawingModeId);
      this.$store.commit(SET_PEN_DRAW_MODE_PREVIOUS);
      this.$store.commit(SET_PEN_DRAW_MODE, drawingModeId);
    },
    onSliderInputText() {
      const val = document.getElementById('size-slider-value').value;
      const num = Number(val);
      // console.log('INPUT TEXT: ', num);
      this.setPenToolDiameter(num);
    },
    handleCollapse() {
      const penPane = this.activePenPane;
      this.setPenCollapse(penPane);
      // console.log('PANE COLLAPSE', penPane);
    },
    loadCollapse() {
      this.activePenPane = this.penCollapse;
    },
  },
  components: {
    TwoStateToggle,
    ThreeStateToggle,
  },
  created() {
    this.loadCollapse();
  },
};
</script>

<style lang="scss">

.pen-controls{
  padding-left: var(--space-md);
  padding-right: var(--space-md);
  margin-bottom: 14px;
  margin-top: 4px;
}

.pen-controls-container{
  margin-top:-26px;
}

.el-form-item.el-form-item--mini {
  margin-bottom: 8px;
  .el-form-item__label {
    padding-bottom: 2px;
  }
}

.pressureSwitch {
  width:40px;
}

.toggle-three {
  // background-color: transparent;
  // border-style: solid;
  border-width: 1px;
  border-color: #858585;
  font-size: 13px;
  text-transform: lowercase;
  // opacity: .4;
  .three-state-toggle__option {
    // height: inherit;
    // border-style: solid;
    // border-width: 2px;
    &--selected {
      // opacity: 1;
      // color: #a000ff;
      // border-color: #9834d3;
      // background-color: transparent;
    }
  }
}

.diameter-slider-value{
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

.diameter-slider-wrapper{
  margin-bottom:8px;
}

</style>
