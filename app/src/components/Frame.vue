<template>
<div
    class="framewrapper"
    :style="{
      transform: translateCss,
    }"
>

  <div
    class="frame"
    :class="{
      'frame--is-original-color-frame': isOriginalColorFrame,
      'frame--is-selected': isSelected,
      'frame--is-placeholder': isPlaceholder,
      'frame--is-loading': isLoading,
      'frame--is-line-frame': isLineFrame,
      'frame--is-left-frame': isFirstFrameInBlock,
      'frame--is-middle-frame': isMiddleFrame,
      'frame--is-right-frame': nextFrameIsNotDupe,
    }"
    @contextmenu.prevent="showContextMenu"
    @mousedown="onFrameClick"
  >
    <!--
      TODO: When segmentation / colorization is none blocking uncomment
      to re-show ciercle animation
    -->
    <!-- <div
      class="ripple-loader"
      v-if="isLoading"
    >
      <div class="ripple-loader__helper1"></div>
      <div class="ripple-loader__helper2"></div>
    </div> -->
    <div
      v-if="nextFrameIsDupe"
      class="frame__next-frame-dupe-indicator"
    ></div>
    <div
      class="frame__original-circle"
      v-if="isOriginalColorFrame && !isDuplicateOfLeftNeighborFrame"
    ></div>
    <div
      v-if="isSelectedColorFrame && !isDuplicateOfLeftNeighborFrame"
      class="frame__connection frame__connection--top"
    ></div>
    <div
      v-if="isSelectedColorFrame && !isDuplicateOfLeftNeighborFrame"
      class="frame__connection frame__connection--bottom"
    ></div>
    <div
      v-if="isReferenceFrameUsedInSelection && !isDuplicateOfLeftNeighborFrame"
      class="frame__connection frame__connection--bottom-ref"
    ></div>
    <div
      v-if="isSelectedColorFrame && !isDuplicateOfLeftNeighborFrame"
      class="frame__connection frame__connection--left"
      :style="{
        width: leftFrameNrConnectionWidthCss,
        visibility: leftFrameNrConnectionWidthCss ? 'visible' : 'hidden',
      }"
    ></div>
    <div
      v-if="isSelectedColorFrame"
      class="frame__connection frame__connection--right"
      :style="{
        width: rightFrameNrConnectionWidthCss,
        visibility: rightFrameNrConnectionWidthCss ? 'visible' : 'hidden',
      }"
    ></div>
    <!-- <div
      v-for="frameNr in surroundingReferenceFramesForLineLayer({
        frameNr: frame ? frame.frameNr : -1,
        layerId,
      })"
      :key="frameNr"
      class="frame__connection--refs"
      :data-frame-nr="frameNr"
    ></div> -->
  </div>
</div>
</template>

<script>
/* eslint-disable import/no-extraneous-dependencies */
import { popupMenu } from '@/platform';
import { frameContextMenu, setContextMenuContext } from '@/context-menu';
/* eslint-disable import/no-extraneous-dependencies */

import {
  REFERENCE_FRAMES_IN_USE_FOR_SELECTION,
  FRAMES_HAVE_SAME_IMAGE_DATA_ID,
} from '@/store/getter-types';

import {
  TOGGLE_FRAME_SELECTION,
  FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES,
} from '@/store/action-types';

import {
  SET_ACTIVE_LAYER_ID,
} from '@/store/mutation-types';

import store from '@/store';

export default {
  props: {
    isColor: {
      type: Boolean,
      default: false,
    },
    isOriginal: {
      type: Boolean,
      default: false,
    },
    isSelected: {
      type: Boolean,
      default: false,
    },
    isPlaceholder: {
      type: Boolean,
      default: false,
    },
    nextFrameIsDupe: {
      type: Boolean,
      required: true,
      // default: false,
    },
    isLoading: {
      type: Boolean,
      default: false,
    },
    frameNr: {
      type: Number,
      required: true,
    },
    leftRefFrameNr: { // only for non-original color frames
      type: Number,
      required: false,
    },
    rightRefFrameNr: { // only for non-original color frames
      type: Number,
      required: false,
    },
    frame: { // the frame object as stored in the store
      type: Object,
      required: true,
    },
    layerId: {
      type: String,
      required: true,
    },
    // index: {
    //   type: Number,
    //   required: true,
    // },
  },
  computed: {
    isMiddleFrame() {
      if (this.nextFrameIsDupe && !this.isFirstFrameInBlock) {
        return true;
      } return false;
    },
    nextFrameIsNotDupe() {
      return !this.nextFrameIsDupe;
    },
    isLineFrame() {
      return !this.isColor;
    },
    isFirstFrameInBlock() {
      return !this.isDuplicateOfLeftNeighborFrame;
    },
    isSelectedColorFrame() {
      return this.isSelected && this.isColor;
    },
    isOriginalColorFrame() {
      return this.isOriginal && this.isColor;
    },
    isDuplicateOfLeftNeighborFrame() {
      return this.$store.getters[FRAMES_HAVE_SAME_IMAGE_DATA_ID]({
        layerId: this.layerId,
        frameNrs: [this.frameNr, this.frameNr - 1],
      });
    },
    isFirstOriginalFrameInBlock() {
      if (!this.isOriginalColorFrame) { return false; }
      return !this.isDuplicateOfLeftNeighborFrame;
    },
    isReferenceFrameUsedInSelection() {
      if (!this.isOriginal || !this.isColor) { return false; }
      /* eslint-disable max-len */
      return this.$store.getters[REFERENCE_FRAMES_IN_USE_FOR_SELECTION](this.layerId).includes(this.frameNr);
    },
    translateCss() {
      return `translateX(${this.frameNr * (16 + 1) - 16}px)`; // the rectangle is 16px, the gap 1px. Index starts at 1
    },
    leftFrameNrConnectionWidthCss() {
      if (typeof this.leftRefFrameNr === 'undefined' || this.leftRefFrameNr === null
        || this.frameNr <= this.leftRefFrameNr
      ) { return 0; }
      // if this is a duplicate reference frame,
      // it should have no connection line
      if (this.$store.getters[FRAMES_HAVE_SAME_IMAGE_DATA_ID]({
        layerId: this.layerId,
        frameNrs: [this.frameNr, this.leftRefFrameNr],
      })) { return 0; }
      return `${(this.frameNr - this.leftRefFrameNr) * (16 + 1) + 2}px`;
    },
    rightFrameNrConnectionWidthCss() {
      if (typeof this.rightRefFrameNr === 'undefined' || this.rightRefFrameNr === null
        || this.frameNr >= this.rightRefFrameNr || this.isDuplicateOfLeftNeighborFrame
      ) { return 0; }
      return `${(this.rightRefFrameNr - this.frameNr) * (16 + 1) + 2}px`;
    },
  },
  methods: {
    // onFrameMouseEnter(ev) {
    //   if (!this.frame) { return; }
    //   this.$store.dispatch(FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES, {
    //     layerId: this.layerId,
    //   });
    // },
    onFrameClick(ev) {
      // For some reason this fails:
      // this.toggleFrameSelection({
      //   layerId: this.layerId,
      //   frameNr: this.frameNr,
      // });
      // Only react on left mouse button.
      // See https://javascript.info/mouse-events-basics#getting-the-button-which
      if (ev.which !== 1) { return; }
      if (!this.frame) {
        console.error('Not existing frame clicked: ', this.frame);
      }
      /* eslint-disable max-len */
      // console.log(`this.isColor: ${this.isColor}`)
      // if (this.isColor) {
      //   const linkedLayerId = this.$store.getters[LINKED_LAYER_ID];
      //   const refFrameNrs = this.$store.getters[REFERENCE_FRAME_NRS_FOR_LAYER_WITH_ID](this.layerId);
      //   console.log(refFrameNrs);
      // }

      this.$store.dispatch(TOGGLE_FRAME_SELECTION, {
        layerId: this.layerId,
        frameNr: this.frameNr,
        event: ev,
      });
      this.$store.dispatch(FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES, {
        layerId: this.layerId,
      });
      store.commit(SET_ACTIVE_LAYER_ID, this.layerId);
      //console.log(this.frame);
    },

    showContextMenu() {
      if (!this.isColor) { return; }
      if (this.isPlaceholder) { return; }
      setContextMenuContext({
        name: 'frame',
        layerId: this.layerId,
        frameNr: this.frameNr,
        isOriginal: this.isOriginal,
        isColor: this.isColor,
      });
      popupMenu(frameContextMenu);
    },
  },
};
</script>

<style lang="scss">

.frame {
  position: absolute;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  top: 0;
  left: 0;
  width: 15px;
  height: 15px;
  // border: 1px solid #a8a8a8;
  // border-width: 1px;
  // border-style: solid;
  // border-color: #a8a8a8;
  background-color: #a8a8a8;
  // border: 1px solid #a8a8a8;
  // border-radius: 4px;

  // &:hover {
    // outline clashes with deduplicated frames (looks weird...)
    // outline: 1px solid #B30EC3;
  // }

  // &--is-original-color-frame {}
  .frame__next-frame-dupe-indicator {
    position: relative;
    top: 0;
    right: -8px;
    width: 4px;
    height: 15px;
    background-color: #a8a8a8;
  }

  &--is-selected {
    // choose a slightly lighter color so the user can still see what was previously colored when selected.
    background-color: #e015f4;
    //mix-blend-mode: overlay;
    .frame__next-frame-dupe-indicator {
      // background-color: #a8a8a8;
      background-color: #e015f4;
    }
    .frame__original-circle {
      background-color: white;
    }
  }

  &--is-placeholder {
    background-color: #616161;
    .frame__next-frame-dupe-indicator {
      //background-color: #a8a8a8;
      background-color: #616161;
    }

    &.frame--is-selected {
      background-color: #B30EC3;
      .frame__next-frame-dupe-indicator {
        //background-color: #a8a8a8;
        background-color: #B30EC3;
      }

    }
  }

  // &--is-loading {
  //   background-color: blue !important; // TODO: Animate gradient
  // }
}

.ripple-loader {
  display: inline-block;
  position: relative;
  width: 16px;
  height: 16px;

  & div {
    position: absolute;
    border: 1px solid #fff;
    opacity: 1;
    border-radius: 50%;
    animation: ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite;
  }
  @keyframes ripple {
    0% {
      top: 8px;
      left: 8px;
      width: 0;
      height: 0;
      opacity: 1;
    }
    100% {
      top: 1px;
      left: 1px;
      width: 14px;
      height: 14px;
      opacity: 0;
    }
  }
}
.frame__original-circle {
  width: 6px;
  height: 6px;
  z-index: 1;
  position:absolute;
  border-radius: 50%;
  background-color: #B30EC3;
  pointer-events: none;
}
.frame__connection {
  position: absolute;
  border-width: 1px;
  border-color: #b30dc3;

  &--top {
    height: 22px;
    top: -44px;
    left: 7px;
    border-style: solid;
  }

  &--bottom {
    height: 20px;
    top: -21px;
    left: 7px;
    border-width: .5px;
    border-style: dashed;
    border-color: #616161;

  }

  /* only for original color frames being referenced (during selection) */
  &--bottom-ref {
    height: 21px;
    top: -21px;
    left: 7px;
    border-style: solid;
  }

  &--left {
    top: -22px;
    right: 6px;
    border-style: solid;
  }

  &--right {
    top: -22px;
    left: 7px;
    border-style: solid;
  }
}
</style>
