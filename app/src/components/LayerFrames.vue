<template>
  <section
    v-if="layerHasFrames"
    class="layer-frames"
    :style="{
      backgroundColor: backgroundColorCss,
    }"
  >
    <div class="layer-frames__frames">
      <frame
        v-for="frame in framesByThisLayer"
        :key="frame.frameNr"
        :is-color="isColorFrame(frame)"
        :is-original="isOriginalFrame(frame)"
        :is-placeholder="isPlaceholder(frame)"
        :is-loading="isLoading(frame)"
        :next-frame-is-dupe="isNextFrameDupe(frame)"
        :is-selected="isSelectedFrame(frame)"
        :leftRefFrameNr="frame ? frame.refFrameLeftNr : null"
        :rightRefFrameNr="frame ? frame.refFrameRightNr : null"
        :frame-nr="frame.frameNr"
        :layer-id="layerId"
        :frame="frame"
      ></frame>
    </div>
  </section>
</template>

<script>
import { mapGetters } from 'vuex';
import Frame from '@/components/Frame.vue';

import {
  LAYER_TYPE_COLOR,
} from '@/store/general-types';

import {
  LAYER_TYPE,
  FRAMES_BY_LAYER_ID,
  // SURROUNDING_REFERENCE_FRAME_NRS_FOR_LINE_FRAME,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
} from '@/store/getter-types';

export default {
  props: {
    layerId: {
      type: String,
      required: true,
    },
  },
  data() {
    return {};
  },
  computed: {
    ...mapGetters({
      framesByLayerId: FRAMES_BY_LAYER_ID,
      layerType: LAYER_TYPE,
      imageDataUriByImageDataId: IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
      // surroundingReferenceFramesForLineLayer: SURROUNDING_REFERENCE_FRAME_NRS_FOR_LINE_FRAME,
    }),
    backgroundColorCss() {
      return this.isColorLayer ? 'transparent' : '#393939';
    },
    isColorLayer() {
      return this.layerType(this.layerId) === LAYER_TYPE_COLOR;
    },
    // ...mapActions({
    //   toggleFrameSelection: TOGGLE_FRAME_SELECTION,
    // }),
    framesByThisLayer() {
      // return only existing frames
      // eslint-disable-next-line
      return this.framesByLayerId(this.layerId).filter(frame => frame);
    },
    layerHasFrames() {
      return this.framesByThisLayer && this.framesByThisLayer.length > 0;
    },
  },
  methods: {
    isOriginalColorFrame(frame) {
      return frame && frame.isOriginal && this.isColorLayer;
    },
    isOriginalFrame(frame) {
      return frame && frame.isOriginal;
    },
    isNextFrameDupe(frame) {
      // If this frame has no imageDataId (ghost frame), check the linked layer for duplicates
      if (!frame || !frame.imageDataId) {
        // For ghost frames, check if the linked layer has duplicate content
        const linkedLayerId = this.layerId === 'lineLayer1' ? 'colorLayer1' : 'lineLayer1';
        const linkedFrames = this.framesByLayerId(linkedLayerId);
        const nextFrameNr = frame.frameNr + 1;

        if (nextFrameNr >= linkedFrames.length) { return false; }

        const currentLinkedFrame = linkedFrames[frame.frameNr];
        const nextLinkedFrame = linkedFrames[nextFrameNr];

        // Check if both frames exist and have the same imageDataId
        if (currentLinkedFrame && nextLinkedFrame
            && currentLinkedFrame.imageDataId && nextLinkedFrame.imageDataId
            && currentLinkedFrame.imageDataId === nextLinkedFrame.imageDataId) {
          return true;
        }
        return false;
      }

      // Original logic for frames with imageDataId
      const nextFrameNr = frame.frameNr + 1;
      const frames = this.framesByLayerId(this.layerId);
      if (nextFrameNr > frames.length) { return false; }
      const nextFrame = frames[nextFrameNr];
      if (!nextFrame || !nextFrame.imageDataId || nextFrame.imageDataId !== frame.imageDataId) {
        return false;
      }
      return true;
    },
    isColorFrame() {
      return this.isColorLayer;
    },
    isSelectedColorFrame(frame) {
      return frame && this.isColorLayer && frame.isSelected;
    },
    isSelectedFrame(frame) {
      return frame && frame.isSelected;
    },
    isPlaceholder(frame) {
      return !frame || !frame.imageDataId || !this.imageDataUriByImageDataId(frame.imageDataId);
    },
    isLoading(frame) {
      return frame && frame.isLoading;
    },
  },
  components: {
    Frame,
  },
};
</script>

<style lang="scss">
.layer-frames {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 60px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: flex-start;
}
.layer-frames__frames {
  width: 100%;
  height: 16px;
  position: relative;
  z-index: 5;
}
</style>
