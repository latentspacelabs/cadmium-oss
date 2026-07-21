<!-- eslint-disable linebreak-style -->
<template>
  <div class="eraser-controls-container">
    <el-collapse v-model="activeEraserPane" @change="handleCollapse">
        <el-collapse-item title="ERASER" name="eraser">
          <template slot="title">
            {{ EraserLabel }} <div class="handle tool-handle"></div>
          </template>
        <div class="eraser-controls">
          <el-form
            size="mini"
            label-position="top"
            label-width="100px"
            onSubmit="return false;"
          >
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
                class="diameter-slider-value" :value="eraserToolDiameter"
                @input="onSliderInputText"
               >
                <vue-slider
                  :value="eraserToolDiameter"
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

import { t } from '@/util/i18n';

import { mapGetters, mapMutations } from 'vuex';

// import InputRange from '@/components/InputRange.vue';
// import TwoStateToggle from '@/components/TwoStateToggle.vue';
// import ThreeStateToggle from '@/components/ThreeStateToggle.vue';

import {
  DEFAULT_DIAMETER,
  MIN_DIAMETER,
  MAX_DIAMETER,
  /*
  PEN_TOOL_MODE_DRAW,
  PEN_TOOL_MODE_ERASE,
  PEN_DRAW_MODE_OVER,
  PEN_DRAW_MODE_UNDER,
  PEN_DRAW_MODE_WITHIN,
  */
} from '@/store/modules/PenTool';

import {
  ERASER_TOOL_DIAMETER,
  // PEN_TOOL_MODE,
  IS_PRESSURE_ENABLED,
  ERASER_COLLAPSE,
  // PEN_DRAW_MODE,
} from '@/store/getter-types';

import {
  SET_ERASER_TOOL_DIAMETER,
  SET_PRESSURE_ENABLED,
  SET_PEN_TOOL_MODE,
  SET_PEN_DRAW_MODE,
  SET_ERASER_COLLAPSE,
} from '@/store/mutation-types';

export default {
  data() {
    return {
      currentDiam: DEFAULT_DIAMETER,
      minDiam: MIN_DIAMETER,
      maxDiam: MAX_DIAMETER,
      // drawModeId: PEN_TOOL_MODE_DRAW,
      // eraseModeId: PEN_TOOL_MODE_ERASE,
      // drawOver: PEN_DRAW_MODE_OVER,
      // drawUnder: PEN_DRAW_MODE_UNDER,
      // drawWithin: PEN_DRAW_MODE_WITHIN,
      activeEraserPane: [],
    };
  },
  computed: {
    EraserLabel() { return t('ERASER'); },
    SizeLabel() { return t('Size'); },
    PressureLabel() { return t('Pressure'); },
    ...mapGetters({
      eraserToolDiameter: ERASER_TOOL_DIAMETER,
      usePressure: IS_PRESSURE_ENABLED,
      // penDrawMode: PEN_DRAW_MODE,
      // mode: PEN_TOOL_MODE,
      eraserCollapse: ERASER_COLLAPSE,
    }),
  },
  methods: {
    ...mapMutations({
      setEraserToolDiameter: SET_ERASER_TOOL_DIAMETER,
      setEraserCollapse: SET_ERASER_COLLAPSE,
      setPenDrawMode: SET_PEN_DRAW_MODE,
    }),
    onSliderInput(val) {
      this.setEraserToolDiameter(val);
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
      console.log('draw ', drawingModeId);
      this.$store.commit(SET_PEN_DRAW_MODE, drawingModeId);
    },
    onSliderInputText() {
      const val = document.getElementById('size-slider-value').value;
      const num = Number(val);
      this.setEraserToolDiameter(num);
    },
    handleCollapse() {
      const eraserPane = this.activeEraserPane;
      this.setEraserCollapse(eraserPane);
      console.log('PANE COLLAPSE', eraserPane);
    },
    loadCollapse() {
      this.activeEraserPane = this.eraserCollapse;
    },
  },
  components: {
    // TwoStateToggle,
    // ThreeStateToggle,
  },
  created() {
    this.loadCollapse();
  },
};
</script>

<style lang="scss">

.eraser-controls{
  padding-left: var(--space-md);
  padding-right: var(--space-md);
  margin-bottom: 14px;
  margin-top: 4px;
}

.eraser-controls-container{
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
