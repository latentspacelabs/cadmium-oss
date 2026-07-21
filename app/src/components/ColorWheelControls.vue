<!-- eslint-disable linebreak-style -->
<template>
  <div class="color-wheel-controls">
    <el-collapse v-model="activeColorPanes" @change="handleCollapse()">
      <el-collapse-item :title="colorSectionTitle" name="color" >
        <template slot="title">
          {{ colorTitle }} <div class="handle tool-handle"></div>
       </template>
    <el-form
      size="mini"
      label-position="top"
      label-width="100px"
      class="colorsection"
      @submit.native.prevent
      onSubmit="return false;"
    >
      <el-form-item
        :style="{
          margin: '0px',
        }"
      >
        <color-picker
          :startColor="pickedColor"
          v-model="pickedColor"
          :width="160"
          :height="160"
          @color-change="onSelectedColorChange"
        ></color-picker>
      </el-form-item>
      <!--label="Hex"-->
      <div
        :style="{
          marginTop: '10px',
          marginBottom: '0px',
        }"
      >
        <input
          class="color-wheel-controls__input"
          v-model="pickedColor"
          :style="{
            backgroundColor: pickedColor,
            color: getContrastingColor(pickedColor),
            //margin: '0px',
          }"
          type="text"
          pattern="^#+([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$"
          :title="hexColorTooltip"
        >
      </div>
      <div
        :content="toggleActiveColorTippy"
        v-tippy="{ placement : 'right' }"
        class="reserved-color"
        @click="toggleSelectedColor"
        :style="{ backgroundColor: this.reservedColor }"
      >
      </div>
      <el-form-item
        :style="{
          margin: '0px',
          // opacity: '.4',
        }"
      >
        <round-button
          text="set background"
          @click="setBackgroundClick"
          color="white-outline"
          :disabled="greyBackgroundButton"
          :style="{
            // position: 'absolute',
            marginTop: '10px',
            height: '24px',
            width: '160px',
            fontSize: '12px',
            textTransform: 'lowercase',
            opacity: .4,
          }"
        ></round-button>
        <div
          class="current-bg-color"
          @click="setBackgroundClick"
          v-bind:class="{ bgDeactive: greyBackgroundButton }"
          :style="{ backgroundColor: this.backgroundColor }"
        >
        </div>
      </el-form-item>
    </el-form>
  </el-collapse-item>
      <!-- INSERT COLOR PALETTE HERE-->
    <el-collapse-item :title="paletteTitle" name="palette">
      <template slot="title">
        {{ paletteTitle }} <div class="handle tool-handle"></div>
     </template>
      <div
        class="color-palette"
      >
        <div
          id="color-palette-list"
        >
        <draggable
          id="swatches-wrapper"
          @start="drag=true"
          @end="drag=false"
          :sort="true"
          v-bind="dragOptions"
          draggable=".color-swatch-square"
          :list="colorPalette"
        >
          <div
            class="color-swatch-square"
            :key="index"
            :id="color.hex"
            v-for="(color, index) in colorPalette"
            v-bind:class="{ swatchSelected: color.selected, flashStyle: color.flash}"
            v-on:click.exact="setColor(color.hex)"
            v-on:dblclick="setSwatchSelected(index)"
            v-on:click.shift.exact="setSwatchesSelected(index)"
          >
            <swatch-contrast
              :color="color.hex"
              :flash="color.flash"
            >
            </swatch-contrast>
          </div>
          <div
            class="addSwatchButtonWrapper"
            slot="header"
          >
            <div
              class="addSwatchButton color-swatches"
              v-on:click="addNewPaletteSwatch()"
              :content="addSwatchTippy"
              v-tippy="{ placement : 'right' }"
            >
              <svg class="svg-circleplus" viewBox="20 20 60 60" >
                <line x1="32.5" y1="50" x2="67.5" y2="50" stroke-width="5"></line>
                <line x1="50" y1="32.5" x2="50" y2="67.5" stroke-width="5"></line>
              </svg>
            </div>
          </div>
        </draggable>
        </div>
      </div>
    <div
      class="paletteButtons"
      :style="{
        // position: 'absolute',
        marginTop: '10px',
      }"
    >
      <round-button
        :content="deleteTippy"
        v-tippy="{ placement : 'right' }"
        class="swatchButtons"
        text="Delete Color"
        size="s"
        @click="showHideSelectedSwatches"
        color="white-outline"
        :style="{
          // position: 'absolute',
          marginTop: '5px',
          height: '24px',
          width: '90px',
          fontSize: '12px',
          textTransform: 'lowercase',
          marginLeft: '7px',
          marginBottom: '10px',
          opacity: .4,
        }"
      ></round-button>
      <round-button
        class="swatchButtons"
        text="Select All"
        size="s"
        @click="selectAllSwatches"
        color="white-outline"
        :style="{
          // position: 'absolute',
          marginTop: '5px',
          height: '24px',
          width: '90px',
          fontSize: '12px',
          textTransform: 'lowercase',
          marginLeft: '5px',
          marginBottom: '10px',
          opacity: .4,
        }"
      ></round-button>
      <round-button
        :content="changeColorTippy"
        v-tippy="{ placement : 'right' }"
        class="swatchButtons"
        text="Change Color"
        size="s"
        @click="changeColor"
        color="white-outline"
        :style="{
          height: '24px',
          width: '180px',
          fontSize: '12px',
          textTransform: 'lowercase',
          marginLeft: '7px',
          marginBottom: '10px',
          opacity: .4,
        }"
      ></round-button>
      <round-button
        :content="simplifyPaletteTippy"
        v-tippy="{ placement : 'right' }"
        class="swatchButtons"
        text="simplify palette"
        size="s"
        @click="simplifyPalette"
        color="white-outline"
        :style="{
          height: '24px',
          width: '180px',
          fontSize: '12px',
          textTransform: 'lowercase',
          marginLeft: '7px',
          marginBottom: '10px',
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
import { mapGetters, mapMutations, mapActions } from 'vuex';
import draggable from 'vuedraggable';
import { swatchMenu, setSwatchMenuContext } from '@/swatch-menu';
import { t } from '@/util/i18n';
import showCustomDialog from '@/util/customDialog';

import {
  SELECTED_COLOR,
  RESERVED_COLOR,
  BACKGROUND_COLOR,
  TIMELINE_HAS_FRAMES,
  COLOR_PALETTE,
  COLOR_COLLAPSE,
} from '@/store/getter-types';

import {
  TOGGLE_ACTIVE_COLOR,
  URI_CHANGE_COLOR,
  CANVAS_ACTION,
} from '@/store/action-types';

import {
  SET_SELECTED_COLOR,
  SET_RESERVED_COLOR,
  SET_BACKGROUND_COLOR,
  ADD_COLOR_TO_PALETTE,
  CLEAR_COLOR_PALETTE,
  SET_COLOR_COLLAPSE,
  SET_PALETTE_EVENT_OCCURRED,
} from '@/store/mutation-types';

import {
  getContrastBWColor,
  hexToRgbArray,
} from '@/util/color-util';

// import ColorPicker from 'vue-color-picker-wheel';
// Modified version of 'vue-color-picker-wheel',
// to be found in /src/components/ColorPicker.vue
// Currently producing wrong results.
import ColorPicker from '@/components/ColorPicker.vue';
import RoundButton from '@/components/RoundButton.vue';
import SwatchContrast from '@/components/SwatchContrast.vue';

import { setPref, subscribe, popupMenu } from '@/platform';

export default {
  data() {
    return {
      pickedColor: '#9834d3', // primary color
      canvasBackgroundColor: 'red',
      activeColorPanes: [],
      sliderOpacityVal: 255,
      colorsToChange: [],
      newHex: null,
      dragInputCalled: false,
    };
  },
  computed: {
    colorSectionTitle() { return t('COLOR'); },
    paletteTitle() { return t('PALETTE'); },
    hexColorTooltip() { return t('Please enter a valid hex color code in the format: #123456'); },
    deleteTippy() { return t('Deletes the selected swatch from the color palette, and removes the color from all frames.'); },
    toggleActiveColorTippy() { return t('Toggle active color (x)'); },
    addSwatchTippy() { return t('Adds the currently active color to the color palette.'); },
    changeColorTippy() { return t('First select the swatch or swatches to change, select or eyedrop a new color, then click here to update the color throughout your entire sequence.'); },
    simplifyPaletteTippy() { return t('This button will merge any colors that are very similar to eachother.'); },
    colorTitle() { return t('COLOR'); },
    ...mapGetters({
      selectedColorInStore: SELECTED_COLOR,
      timelineHasFrames: TIMELINE_HAS_FRAMES,
      backgroundColor: BACKGROUND_COLOR,
      reservedColor: RESERVED_COLOR,
      colorPalette: COLOR_PALETTE,
      colorCollapse: COLOR_COLLAPSE,
    }),
    greyBackgroundButton() {
      return !this.timelineHasFrames;
    },
    opacitySlider() {
      let sliderValue;
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].firstSelected) {
          sliderValue = this.colorPalette[i].newOpacity;
          // console.log('SETTING SLIDER VALUE TO', sliderValue);
        }
      }
      const sliderConversion = sliderValue / 2.55;
      return Math.round(sliderConversion);
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
    ...mapActions({
      toggleActiveColor: TOGGLE_ACTIVE_COLOR,
      uriChangeColor: URI_CHANGE_COLOR,
      canvasAction: CANVAS_ACTION,
    }),
    ...mapMutations({
      setSelectedColor: SET_SELECTED_COLOR,
      setBackgroundColor: SET_BACKGROUND_COLOR,
      setReservedColor: SET_RESERVED_COLOR,
      addColorToPalette: ADD_COLOR_TO_PALETTE,
      clearColorPalette: CLEAR_COLOR_PALETTE,
      setColorCollapse: SET_COLOR_COLLAPSE,
      setPaletteEventOccurred: SET_PALETTE_EVENT_OCCURRED,
    }),

    async changeSelectedSwatches() {
      // console.log('COLOR_PALETTE: ', this.colorPalette);
      // const colorsToChange = [];
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].selected) {
          // ADD COLOR SWATCH TO AND FROM ARRAY FOR PROCESSING

          // if there is a color change occurring:
          if (this.newHex) {
            this.colorPalette[i].newHex = this.newHex;
            // console.log('this.colorPalette[i].newHex: ', this.colorPalette[i].newHex);
          }
        }
      }
      if (this.colorPalette.length) {
        // console.log('COMMITTING COLOR CHANGEs');
        await this.uriChangeColor({ allFrames: true });
        // this.setPaletteEventOccurred(true);
      }
      // reset hex changer
      this.newHex = null;
    },

    onOpacitySliderDragInput(val) {
      const num = Number(val);
      this.sliderOpacityVal = Math.round(num * 2.55);
      // const colorsToChange = [];
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].selected) {
          this.colorPalette[i].newOpacity = Math.round(this.sliderOpacityVal);
        }
      }
    },
    onOpacitySliderDragInputDone() {
      const num = this.$refs.opacitySliderObject.getValue();
      this.sliderOpacityVal = Math.round(num * 2.55);
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].selected) {
          this.colorPalette[i].newOpacity = Math.round(this.sliderOpacityVal);
        }
      }
      this.changeSelectedSwatches();
      // TO DO IF no palette events occurred grab cache of whole state
    },
    onOpacitySliderInputText() {
      // TO DO IF no palette events occurred grab cache of whole state
      const val = document.getElementById('opacity-slider-value').value;
      const num = Number(val);
      this.sliderOpacityVal = Math.round(num * 2.55);
      // COMMIT THE URI_CHANGE_COLOR ACTION (ARRAY OF COLORS, false)
      console.log('INPUT TEXT');
      this.changeSelectedSwatches();
      this.setPaletteEventOccurred(true);
    },
    showSwatchMenu(index) {
      // console.log('Right clicked swatch for color: ', index);
      setSwatchMenuContext(index);
      popupMenu(swatchMenu);
    },
    setBackgroundClick() {
      const color = this.pickedColor;
      this.canvasBackgroundColor = color;
      this.setBackgroundColor(color);
      setPref('backgroundColor', color);
      console.log('canvasBackgroundColor: ', this.canvasBackgroundColor);
    },
    toggleSelectedColor() {
      this.toggleActiveColor();
    },
    disableFlash(index) {
      this.colorPalette[index].flash = false;
      this.$forceUpdate();
    },
    addNewPaletteSwatch() {
      // console.log('Add new palette swatch', this.pickedColor);
      const listOfPaletteColors = this.colorPalette;
      let isInPalette = false;
      let selectedColorInStoreLc = this.selectedColorInStore.toLowerCase();
      if (selectedColorInStoreLc.length === 6) {
        selectedColorInStoreLc = selectedColorInStoreLc.concat('#', selectedColorInStoreLc);
      }
      if (/^#[0-9A-F]{6}$/i.test(selectedColorInStoreLc)) {
        for (let i = 0; i < listOfPaletteColors.length; i += 1) {
          if (listOfPaletteColors[i].hex === selectedColorInStoreLc) {
            this.colorPalette[i].flash = true;
            const scrollTarget = document.getElementById(selectedColorInStoreLc);
            const scrollWindow = document.getElementById('color-palette-list');
            scrollWindow.scrollTop = scrollTarget.offsetTop - 328;
            isInPalette = true;
            this.$forceUpdate();
            /* eslint-disable-next-line */
            setTimeout(function () { this.disableFlash(i) }.bind(this), 1200);
          }
        }
        // console.log('Color already in palette?', isInPalette);
        if (isInPalette === false) {
          this.colorPalette.unshift({
            hex: selectedColorInStoreLc,
            newHex: selectedColorInStoreLc,
            visible: true,
            newVisible: true,
            selected: false,
            firstSelected: false,
            opacity: 255,
            newOpacity: 255,
          });
          // console.log('Adding color ', color, ' to palette');
        }
      } else {
        showCustomDialog({
          title: t('Invalid Hex Code'),
          message: t('Oops, looks like that is not a valid hex code.'),
          buttons: [t('OK')],
          defaultId: 0,
          type: 'warning',
        });
      }
    },
    /*
    changeColorFromPalette(color) {
      console.log('PICKED COLOR', color);
      this.setSelectedColor(color);
    },
    */
    setSwatchSelected(index) {
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (i === index) {
          this.colorPalette[i].selected = true;
          this.colorPalette[i].firstSelected = true;
          // console.log('SETTING COLOR AS SELECTED: ', i);
        } else {
          this.colorPalette[i].selected = false;
          this.colorPalette[i].firstSelected = false;
          // console.log('SETTING SWATCH TO FALSE:', i);
        }
      }
    },
    setColor(color) {
      this.setSelectedColor(color);
    },
    // these two functions have the same name??
    setSwatchesSelected(index) {
      const isFirstSelected = [];
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].firstSelected === true) {
          isFirstSelected.push('TRUE');
        }
      }
      if (isFirstSelected.length >= 1) {
        // console.log('THERE IS ALREADY A FIRST SELECTED');
        this.colorPalette[index].firstSelected = false;
      } else {
        // console.log('THERE IS NO FIRST SELECTED');
        this.colorPalette[index].firstSelected = true;
      }
      if (this.colorPalette[index].selected) {
        this.colorPalette[index].selected = false;
      } else {
        this.colorPalette[index].selected = true;
      }
    },
    async showHideSelectedSwatches() {
      // TO DO IF no palette events occurred grab cache of whole state
      await this.canvasAction();
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].selected) {
          this.colorPalette[i].newVisible = false;
        }
      }
      this.changeSelectedSwatches();
      this.setPaletteEventOccurred(true);
    },
    selectAllSwatches() {
      // console.log('Selecting All Swatches');
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        this.colorPalette[i].selected = true;
      }
    },
    async changeColor() {
      // console.log('Changing color');
      await this.canvasAction();
      this.newHex = this.selectedColorInStore;
      this.changeSelectedSwatches();
    },
    async simplifyPalette() {
      // console.log('Changing color');
      await this.canvasAction();
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        let anySwatchSelected = false;
        this.newHex = this.colorPalette[i].hex;
        const color1 = hexToRgbArray(this.colorPalette[i].hex);
        for (let j = 0; j < this.colorPalette.length; j += 1) {
          // if color i is close to j, select j
          if (i !== j) {
            const color2 = hexToRgbArray(this.colorPalette[j].hex);
            // console.log ('color1 r: ', color1[0]);
            const rgbCompare = 16;
            const colorDiff = (
              Math.abs(color1[0] - color2[0])
              + Math.abs(color1[1] - color2[1])
              + Math.abs(color1[2] - color2[2])
            );
            // console.log('colorDiff: ', colorDiff);
            // if (swatchContrastScore < 2) {
            if (colorDiff < rgbCompare) {
              this.colorPalette[j].selected = true;
              anySwatchSelected = true;
            } else {
              this.colorPalette[j].selected = false;
            }
          }
        }
        if (anySwatchSelected) {
          // eslint-disable-next-line
          await this.changeSelectedSwatches();
        }
        // anySwatchSelected = false;
      }
    },
    soloSelected() {
      // console.log('Soloing selected color');
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].selected) {
          this.colorPalette[i].newVisible = true;
        } else {
          this.colorPalette[i].newVisible = false;
        }
      }
      this.changeSelectedSwatches();
      // TO DO COMMIT THE URI_CHANGE_COLOR ACTION (ARRAY OF COLORS, false)
      this.setPaletteEventOccurred(true);
    },
    discardChanges() {
      // console.log('Discarding changes');
      for (let i = 0; i < this.colorPalette.length; i += 1) {
        if (this.colorPalette[i].selected) {
          this.colorPalette[i].newHex = this.colorPalette[i].hex;
          this.colorPalette[i].newOpacity = this.colorPalette[i].opacity;
          this.colorPalette[i].newVisible = this.colorPalette[i].visible;
        }
      }
    },
    commitChanges() {
      // console.log('Committing changes');
      this.uriChangeColor({ allFrames: true });
    },
    toggleColorVisible(index) {
      // TO DO IF no palette events occurred grab cache of whole state
      this.colorPalette[index].selected = true;
      if (this.colorPalette[index].newVisible) {
        this.colorPalette[index].newVisible = false;
      } else {
        this.colorPalette[index].newVisible = true;
      }
      this.changeSelectedSwatches();
      this.setPaletteEventOccurred(true);
    },
    clearPalette() {
      // console.log('CLEARING PALETTE');
      this.clearColorPalette();
    },
    handleCollapse() {
      const colorPanes = this.activeColorPanes;
      this.setColorCollapse(colorPanes);
      // console.log('PANE COLLAPSE', colorPanes);
    },
    loadCollapse() {
      // console.log('FOO', this.colorCollapse);
      this.activeColorPanes = this.colorCollapse;
      // console.log('LOAD COLLAPSE', this.activeColorPanes);
    },

    onSelectedColorChange(color) {
      // we need to wait a bit until we inform the store, otherwise it can
      // happen that the component overwrites the store color.
      // This happens when the color wheel is hidden while a color is picked
      // using the eyedropper.
      // TODO: Find better way and remove timer
      setTimeout(() => {
        if (color === this.pickedColor) {
          this.setSelectedColor(color);
        }
      }, 5);
    },
    getContrastingColor(c) {
      return getContrastBWColor(c);
    },
  },
  watch: {
    selectedColorInStore(c) {
      this.pickedColor = c;
    },
  },
  mounted() {
    this.pickedColor = this.selectedColorInStore;
    subscribe('cycle-color-swatch', () => {
      console.log('color palette length', this.colorPalette.length);
      if (this.colorPalette.length !== 0) {
        let currentSelectedSwatch = null;
        for (let i = 0; i < this.colorPalette.length; i += 1) {
          if (this.colorPalette[i].selected) {
            currentSelectedSwatch = i;
          }
        }
        if (currentSelectedSwatch === null) {
          this.setSwatchSelected(this.colorPalette[0].hex, 0);
        } else if (currentSelectedSwatch === (this.colorPalette.length - 1)) {
          this.setSwatchSelected(this.colorPalette[0].hex, 0);
        } else {
          const nextSwatch = currentSelectedSwatch + 1;
          this.setSwatchSelected(this.colorPalette[nextSwatch].hex, nextSwatch);
        }
      }
    });
  },
  created() {
    this.loadCollapse();
  },
  updated() {
  },
  components: {
    ColorPicker,
    RoundButton,
    draggable,
    SwatchContrast,
  },
};

</script>

<style lang="scss">
@import '../scss/modules/general.scss';

  .color-wheel-controls__input {
    width: 122px;
    margin-left: 3px;
    height: 22px;
    border: none;
    padding: var(--space-xxs);
    font-size: 14px;

    // --cwc-light: 80;
    // /* the threshold at which colors are considered "light." Range: integers from 0 to 100,
    // recommended 50 - 70 */
    //--cwc-threshold: 60;
    // --switch: calc((var(--cwc-light) - var(--cwc-threshold)) * -100%);
    // color: hsl(0, 0%, var(--cwc-switch));
    color:white;
  }

  .color-wheel-controls__input-label {
    font-size: 13px;
    color: #939393;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: var(--space-xxs);
  }

  .reserved-color {
    width: 28px;
    margin-left: 129px;
    margin-top: -24px;
    height: 22px;
    border: none;
    cursor:pointer;
    // z-index: 1000;
    // padding: var(--space-xxs);
  }

  .color-palette{
    margin-top:20px;
    margin-left:8px;
    height: 100%;
    margin: 0em;
    max-height:114px;
  }

  #swatches-wrapper{
    margin-top:10px;
  }

  #color-palette-list{
    height: 100%;
    margin-left: 14px;
    max-height:114px;
    overflow-y: scroll;
  }

  #color-palette-list::-webkit-scrollbar {
    width: 12px;
  }

  #color-palette-list::-webkit-scrollbar-track {
    background-color: #333333;
  }

  #color-palette-list::-webkit-scrollbar-thumb {
    background: #424242;
  }

  .color-palette-circle{
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-right: 2px;
    margin-left: 2px;
    cursor: pointer;
  }

  .addSwatchButton {
    border-style: solid;
    border-color: rgb(78, 78, 78);
    border-radius: 50%;
    border-width: 2px;
    width: 26px;
    height: 26px;
    stroke: #4e4e4e;
  }

  .addSwatchButtonWrapper {
    width: 34px;
    height: 32px;
    display: inline-flex;
    margin-top:1px;
    justify-content: center;
    cursor: pointer;
    float:left;
  }
  .addSwatchButton:hover {
    stroke: #fff;
    border: 2px solid #fff;
    opacity: 0.4;
  }

  .color-swatch-square{
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top:-3px;
  }

  .color-palette-swatch{
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }

  el-form {
    line-height: 1px;
    margin: 0px;
    padding: 0px;
    border: 0px;
    margin: 0px;
  }

  round-button {
    border: 1px solid black;
    opacity: .4;
  }

  [role=tab] {
    width: 200px;
    overflow: hidden;
  }

  [role=button] {
    height:26px;
    background:#3a3a3a;
  }

  .el-collapse-item__header {
    border-bottom:none;
    color:#9e9e9e;
    padding-left:8px;
    letter-spacing: 1.2px;
    font-size: 13px;
  }

  .el-collapse-item__wrap {
    background-color: #333 !important;
    border-bottom:none;

  }

  .el-collapse-item__content {
    padding-bottom: 0px;
  }

  .el-collapse {
    border-bottom:none;
    border-top:none;
  }

  .colorsection{
    margin-top:20px;
    padding-left: var(--space-md);
    padding-right: var(--space-md);
    padding-bottom: 25px;
  }

  .color-wheel-controls {
    margin-top: -32px;
    padding-left:0px;
    padding-right:0px;
    padding-top: var(--space-md);
  }

  .tool-control-item__content {
    padding-bottom: 0;
    padding-left:0;
    padding-right:0;
  }

  .current-bg-color {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    position: absolute;
    margin-top: -22px;
    margin-left: 138.5px;
    cursor: pointer;
  }

  .bgDeactive {
    opacity: 0.25;
  }

  .swatchDeactive {
    background: none !important;
    border: 1px solid
  }

  .swatchSelected {
    background: #272727;
    border-radius: 6px;
    border-width: 1px;
    border-style: solid;
    border-color: #cecece;
  }

  .swatchEyeIcon {
    height: 20px;
    width: 25px;
    visibility: hidden;
    fill: none;
    stroke-width: 1.5px;
  }

  .swatchAperature {
    height: 26px;
    width: 26px;
    border-style: solid;
    border-radius: 50%;
    box-sizing: border-box;
    position: absolute;
  }

  .eyeIconShow {
    visibility: visible !important;
  }

  .opacity-slider-wrapper{
    margin-left:15px;
    height: 35px;
  }

  .opacity-slider {
    padding: 17px 0px !important;
    margin-right: 13px;
    margin-left: 45px;
  }

  .tool-handle {
    width: 100%;
    height: 25px;
    position: absolute;
    margin-left: -7px;
  }

  .swatchButtons:hover {
    border: 2px solid #fff;
  }

  .swatchButtons:active {
    background-color: #272727;
  }
</style>
