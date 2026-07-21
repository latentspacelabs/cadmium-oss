<!-- eslint-disable linebreak-style -->
<template>
  <div class="sidebar">
    <div class="sidebar__container sidebar__container--top">
      <sidebar-item
        class="step-6 step-17 step-18"
        :content="colorWheelTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="icons.colorPallet"
        :isPressed="sidebarItemVisibleById(colorToolId)"
        :isHighlighted="false"
        :isColorWheel="true"
        @click="onSidebarItemClick(colorToolId)"
      ></sidebar-item>
      <sidebar-item
        :content="handTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="icons.hand"
        :isPressed="sidebarItemVisibleById(handToolId)"
        :isHighlighted="false"
        @click="onSidebarItemClick(handToolId)"
      ></sidebar-item>
      <sidebar-item
        :content="zoomTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="icons.zoom"
        :isPressed="sidebarItemVisibleById(zoomToolId)"
        :isHighlighted="false"
        @click="onSidebarItemClick(zoomToolId)"
      ></sidebar-item>
      <sidebar-item
        :content="eyeDropperTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="icons.eyedropper"
        :isPressed="sidebarItemVisibleById(eyedropperToolId)"
        :isHighlighted="sidebarItemVisibleById(eyedropperToolId)"
        @click="onSidebarItemClick(eyedropperToolId)"
      ></sidebar-item>
      <sidebar-item
        class="step-5"
        :content="fillTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="icons.fill"
        :isPressed="sidebarItemVisibleById(fillToolId)"
        :isHighlighted="sidebarItemVisibleById(fillToolId)"
        @click="onSidebarItemClick(fillToolId)"
      ></sidebar-item>
      <sidebar-item
        class="step-9"
        :content="penTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="penOrEraser()"
        :isPressed="sidebarItemVisibleById(penToolId)"
        :isHighlighted="sidebarItemVisibleById(penToolId)"
        @click="onSidebarItemClick(penToolId)"
      ></sidebar-item>
      <sidebar-item
        :content="eraserTippy"
        v-tippy="{ placement : 'right' }"
        :iconUrl="icons.eraser"
        :isPressed="sidebarItemVisibleById(eraserToolId)"
        :isHighlighted="sidebarItemVisibleById(eraserToolId)"
        @click="onSidebarItemClick(eraserToolId)"
      ></sidebar-item>

    </div>
    <div class="sidebar__container sidebar__container--bottom"></div>
  </div>
</template> <!-- eslint-disable linebreak-style -->

<script> /* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';

import { t } from '@/util/i18n';

import {
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  PEN_TOOL_MODE,
  // ACTIVE_CANVAS_TOOL_ID,
} from '@/store/getter-types';

import {
  TOGGLE_TOOL_CONTROL_WITH_ID,
  SHOW_TOOL_CONTROL_WITH_ID,
  HIDE_TOOL_CONTROL_WITH_ID,
} from '@/store/mutation-types';

import {
  ACTIVATE_TOOL_BY_ID,
} from '@/store/action-types';

import {
  TOOL_CONTROLS_ID_COLOR,
  TOOL_CONTROLS_ID_HAND,
  TOOL_CONTROLS_ID_ZOOM,
  TOOL_CONTROLS_ID_FILL,
  TOOL_CONTROLS_ID_PEN,
  TOOL_CONTROLS_ID_ERASER,
  TOOL_CONTROLS_ID_EYEDROPPER,
} from '@/store/modules/ToolControls';

import {
  PEN_TOOL_MODE_DRAW,
  PEN_TOOL_MODE_ERASE,
} from '@/store/modules/PenTool';

import SidebarItem from '@/components/SidebarItem.vue';

export default {
  data() {
    return {
      colorToolId: TOOL_CONTROLS_ID_COLOR,
      handToolId: TOOL_CONTROLS_ID_HAND,
      zoomToolId: TOOL_CONTROLS_ID_ZOOM,
      fillToolId: TOOL_CONTROLS_ID_FILL,
      penToolId: TOOL_CONTROLS_ID_PEN,
      eraserToolId: TOOL_CONTROLS_ID_ERASER,
      penToolModeDraw: PEN_TOOL_MODE_DRAW,
      penToolModeErase: PEN_TOOL_MODE_ERASE,
      eyedropperToolId: TOOL_CONTROLS_ID_EYEDROPPER,
      /* eslint-disable global-require */
      icons: {
        colorPallet: require('../assets/icons/color-pallet.svg'),
        hand: require('../assets/icons/hand-open-white.svg'),
        zoom: require('../assets/icons/zoom.svg'),
        fill: require('../assets/icons/fill.svg'),
        pen: require('../assets/icons/pen.svg'),
        penErase: require('../assets/icons/penErase.svg'),
        eraser: require('../assets/icons/eraser.svg'),
        eyedropper: require('../assets/icons/eyedropper.svg'),
      },
    };
  },
  computed: {
    colorWheelTippy() { return t('Color Wheel (C)'); },
    handTippy() { return t('Hand (Spacebar)'); },
    zoomTippy() { return t('Zoom (Z + option, right click + drag)'); },
    eyeDropperTippy() { return t('Eye Dropper (i)'); },
    fillTippy() { return t('Fill Tool (F)'); },
    penTippy() { return t('Pen (B)'); },
    eraserTippy() { return t('Eraser (E)'); },
    ...mapGetters({
      sidebarItemVisibleById: TOOL_CONTROL_ITEM_IS_VISIBLE,
    }),
  },
  methods: {
    ...mapMutations({
      toggleToolControlWithId: TOGGLE_TOOL_CONTROL_WITH_ID,
      showToolControlWithId: SHOW_TOOL_CONTROL_WITH_ID,
      hideToolControlWithId: HIDE_TOOL_CONTROL_WITH_ID,
    }),
    onSidebarItemClick(itemType) {
      this.$store.dispatch(ACTIVATE_TOOL_BY_ID, {
        toolId: itemType,
        preventReActivation: true, // special case for color picker
      });
    },
    penOrEraser() {
      // if (this.$store.getters[ACTIVE_CANVAS_TOOL_ID] === this.penToolId) {
      // console.log('penOrEraser');
      if (this.$store.getters[PEN_TOOL_MODE] === this.penToolModeDraw) {
        // console.log('pen icon: ', this.icons.pen);
        // console.log('pen tool mode: ', this.penToolModeDraw);
        return this.icons.pen;
      }
      if (this.$store.getters[PEN_TOOL_MODE] === this.penToolModeErase) {
        // console.log('eraser icon: ', this.icons.eraser);
        // console.log('pen tool mode: ', this.penToolModeErase);
        return this.icons.penErase;
      }
      // }
      return this.icons.pen;
    },
  },
  components: {
    SidebarItem,
  },
};
</script>

<style lang="scss">
@import '../scss/modules/general.scss';

.sidebar {
  // position: absolute;
  // top: calc(var(--nav-bar-height) + 2px);
  // top: 82px;
  // left: 0;
  background-color: #414141;
  width: 54px;
  // NOT WORKING! Because of flex box. TODO: Find better solution for height!
  // height: calc(100% - var(--nav-bar-height) - 2px);
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px;
  pointer-events: all;
}

.sidebar-item:focus{
  outline-width: 0;
}

.sidebar__container {

}

.el-slider__button-wrapper{
  z-index: 0;
}
</style>
