<template>
  <div
    class="dropzone"
    :class="{
      'dropzone--hidden': isHidden,
    }"
    :style="{
      backgroundColor: backgroundColorCss,
      left: functionScrollValueX,
    }"
  >
    <div
      class="dropzone__dropzone"
      :class="{
        'dropzone__dropzone--drag-over': isDragOver,
      }"
      @dragenter="onDragEnter"
      @dragleave="onDragLeave"
      @dragover="onDragOver"
      @drop="onDrop"
    >
      <div class="dropzone__inner">
        {{ text }}
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters, mapMutations, mapActions } from 'vuex';

import {
  FILE_DRAG_N_DROP_IN_PROGRESS,
  TIMELINE_SCROLL_VALUE_X,
} from '@/store/getter-types';

import { LAYER_TYPE_COLOR } from '@/store/general-types';

import {
  // SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  SET_FILE_DRAG_N_DROP_IN_PROGRESS,
} from '@/store/mutation-types';

import {
  HANDLE_IMAGE_DROP,
} from '@/store/action-types';

export default {
  props: {
    // layer type, either line, or color layer.
    // Use constants from @/store/general-types.js for safety
    layerType: {
      type: String,
      required: true,
    },
    // ID for the layer
    layerId: {
      type: String,
      required: true,
    },
    hidden: {
      type: Boolean,
      default: false,
    },
    // the text to display
    text: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      isDragOver: false,
      safeTimer: null,
    };
  },
  computed: {
    ...mapGetters({
      dndInProgress: FILE_DRAG_N_DROP_IN_PROGRESS,
      scrollValueX: TIMELINE_SCROLL_VALUE_X,
    }),
    isHidden() {
      if (this.dndInProgress) { return false; }
      return this.hidden;
    },
    backgroundColorCss() {
      if (this.layerType === LAYER_TYPE_COLOR) { return 'transparent'; }
      return 'rgba(57, 57, 57, 0)';
    },
    functionScrollValueX() {
      const dropzoneIntValue = this.scrollValueX + 20;
      const dropzoneStrValue = dropzoneIntValue.toString(10).concat('px');
      return dropzoneStrValue;
    },
  },
  methods: {
    ...mapMutations([
      // SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
      SET_FILE_DRAG_N_DROP_IN_PROGRESS,
    ]),
    ...mapActions([
      HANDLE_IMAGE_DROP,
    ]),
    async onDragEnter() {
      // console.log('frame dragenter');
      // probably not needed, because MainPane detected the dragenter
      this[SET_FILE_DRAG_N_DROP_IN_PROGRESS](true);
      this.isDragOver = true;
      await new Promise((resolve) => {
        this.safeTimer = setTimeout(resolve, 5000);
      });
      // console.log('promise met');
      clearTimeout(this.safeTimer);
      this.onDragLeave();
    },
    onDragLeave() {
      // console.log('frame dragleave');
      this[SET_FILE_DRAG_N_DROP_IN_PROGRESS](false);
      this.isDragOver = false;
    },
    onDragOver(ev) {
      // Needed for the drop event to be called. See https://stackoverflow.com/a/31085796/1052107
      // this[SET_FILE_DRAG_N_DROP_IN_PROGRESS](false);
      ev.preventDefault();
    },
    onDrop(ev) {
      // console.log('frame drop');
      this[SET_FILE_DRAG_N_DROP_IN_PROGRESS](false);
      this[HANDLE_IMAGE_DROP]({ event: ev, layerId: this.layerId });
    },
  },
};
</script>

<style lang="scss">
.dropzone {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
  height: 60px;
  width: calc( 100vw - var(--timeline-pane-left-width)) !important;
  position: relative;
  border-radius: 4px;
  // background-color: #434343;
  border-radius: 0;
  // background-color: #393939;
  // background-color: rgba(57, 57, 57, 0.9);

  &--hidden {
    display: none;

    .main-pane--drag-over & {
      display: block;
      z-index: 5;
    }
  }
}

.dropzone__dropzone {
  position: absolute;
  top: 10px;
  width: calc(100% - 40px);
  height: calc(100% - 20px);
  --dropzone-color: #898989;
  border: 1px dashed var(--dropzone-color);
  border-radius: 30px;
  display: flex;
  justify-content: center;
  align-items: center;

  &--drag-over {
    --dropzone-color: var(--highlight-color)
  }
}

.dropzone__inner {
  color: var(--dropzone-color);
  pointer-events: none;
}

.dropzone__text {
  font-size: 14px;
}
</style>
