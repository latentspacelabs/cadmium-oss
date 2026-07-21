<!-- eslint-disable linebreak-style -->
<template>
  <!-- eslint-disable max-len -->
  <div
    class="layer-controls step-16"
    v-bind:class="{
      'layer-controls--visible': isTimelineVisible,
      activeLayerId: this.layerId === activeLayerId
      }"
  >
    <div
      class="layer-controls__background-image"
      v-if="backgroundImage"
      :style="{
        backgroundImage: `url(${backgroundImage})`,
      }"
    ></div>
    <div
        class="layerShadow"
        v-bind:class="{ darkenLayerBg: this.layerId === activeLayerId }"
    ></div>
    <div
      class="layer-click-area"
      @click="layerClicked"
    >
    </div>
    <div
      class="selected-layer-dot"
      v-bind:class="{ showDot: this.layerId === activeLayerId }"
    >
      •
    </div>
    <div
      @click="layerClicked"
      class="layer-name"
      :content="layerTippy"
      v-tippy="{ placement : 'top' }"
    >
    {{ layerTitle }}
    </div>
    <button
      class="layer-visibility-toggle layer-visibility-toggle--is-visible"
      @mousedown="eyeIconClicked"
      :content="layerVisibilityTippy"
      v-tippy="{ placement : 'top' }"
    >
      <img
        class="layer-visibility-toggle__icon"
        :src="visibilityIcon"
        draggable="false"
      >
    </button>
    <div class="step-10" style="
    position: absolute;
    left: 176px;
    top: 80px;">
    </div>
    <button
      class="reference-control"
      v-bind:class="showRefControl(title)"
      @mousedown="toggleRefFrame"
      :content="refControlTippy"
      v-tippy="{ placement : 'right' }"
    >
      <img
        id="fullDiamond"
        :src="refDiamond"
        draggable="false"
        v-bind:class="refControlColor()"
      >
      <img
        id="halfDiamond"
        :src="halfDiamond"
        draggable="false"
        v-bind:class="refControlColor()"
      >
    </button>
  </div>
</template> <!-- eslint-disable linebreak-style -->

<script> /* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';

import { t } from '@/util/i18n';

import {
  LAYER_IS_VISIBLE,
  ACTIVE_LAYER_ID,
  TIMELINE_VISIBILITY,
  FRAMES_BY_LAYER_ID,
  SELECTED_FRAME_NR,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  FRAMES_HAVE_SAME_IMAGE_DATA_ID,
  FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID,
} from '@/store/getter-types';

import {
  SET_ACTIVE_LAYER_ID,
  TOGGLE_LAYER_VISIBILITY,
  SET_FRAME_ORIGINAL,
} from '@/store/mutation-types';

import {
  INITIAL_COLOR_LAYER_ID,
} from '@/store/general-types';

const eyeIcon = require('../assets/icons/eye.svg');
const eyeCrossedIcon = require('../assets/icons/eye-crossed.svg');
const refDiamondIcon = require('../assets/icons/fullDiamond.svg');
const refHalfDiamondIcon = require('../assets/icons/halfDiamond.svg');

export default {
  props: {
    title: {
      type: String,
      required: true,
    },
    layerId: {
      type: String,
      required: true,
    },
    backgroundImage: {
      type: String,
      required: false,
    },
  },
  data() {
    return {};
  },
  computed: {
    layerTitle() {
      return t(this.title);
    },
    layerTippy() { return t("You can click on the layer name or press 'Shift + up/down' to change the active layer."); },
    layerVisibilityTippy() { return t('Show/Hide Layer'); },
    refControlTippy() { return t('Reference Frame Toggle: use this to set reference color frames that Cadmium will use to color the rest of your frames.'); },
    ...mapGetters({
      layerIsVisibleByLayerId: LAYER_IS_VISIBLE,
      activeLayerId: ACTIVE_LAYER_ID,
      isTimelineVisible: TIMELINE_VISIBILITY,
      framesByLayerId: FRAMES_BY_LAYER_ID,
      currentFrame: SELECTED_FRAME_NR,
      imageDataUriByImageDataId: IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
      frameIdsOfFramesWithSameId: FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID,
    }),
    layerIsVisible() {
      return this.layerIsVisibleByLayerId(this.layerId);
    },
    visibilityIcon() {
      return this.layerIsVisible ? eyeIcon : eyeCrossedIcon;
    },
    refDiamond() {
      return refDiamondIcon;
    },
    halfDiamond() {
      return refHalfDiamondIcon;
    },
  },
  methods: {
    ...mapMutations({
      toggleLayerVisibility: TOGGLE_LAYER_VISIBILITY,
      setActiveLayerId: SET_ACTIVE_LAYER_ID,
      setFrameOriginal: SET_FRAME_ORIGINAL,
    }),
    eyeIconClicked() {
      console.log('layerId of eye clicked: ', this.layerId);
      this.toggleLayerVisibility(this.layerId);
    },
    layerClicked() {
      console.log('layer clicked', this.layerId);
      this.setActiveLayerId(this.layerId);
    },
    showRefControl(title) {
      if (title === 'Outlines' || title === t('Outlines')) {
        return 'hide-ref-control';
      } return 'show-ref-control';
    },

    toggleRefFrame() {
      const frames = this.framesByLayerId(INITIAL_COLOR_LAYER_ID);
      const refsToFlip = [];
      // find all selected frames on color layer to toggle
      for (let j = 0; j < frames.length; j += 1) {
        if (frames[j]) {
          if (frames[j].isSelected && frames[j].imageDataId) {
            refsToFlip.push(j);
          }
        }
      }

      if (refsToFlip.length === 0) {
        // if no frames are selected, the current frame block is added to array to flip
        // console.log('current frame: ', this.currentFrame);
        let h = this.currentFrame;
        
        const frameIdsWithSameImage = this.frameIdsOfFramesWithSameId({ 
          layerId: INITIAL_COLOR_LAYER_ID,
          frameNr: h, 
        });
        frameIdsWithSameImage.forEach((fNr) => {
          refsToFlip.push(fNr);
        });
      }
      // console.log(refsToFlip);
      for (let k = 0; k < refsToFlip.length; k += 1) {
        const i = refsToFlip[k];
        if (frames[i] && frames[i].imageDataId) {
          const imgUri = this.imageDataUriByImageDataId(frames[i].imageDataId);
          if (imgUri) {
            // console.log('flipping ref');
            if (frames[i].isOriginal) {
              this.$store.commit(SET_FRAME_ORIGINAL, {
                layerId: INITIAL_COLOR_LAYER_ID,
                frameNr: frames[i].frameNr,
                isOriginal: false,
              });
            } else {
              this.$store.commit(SET_FRAME_ORIGINAL, {
                layerId: INITIAL_COLOR_LAYER_ID,
                frameNr: frames[i].frameNr,
                isOriginal: true,
              });
            }
          }
        }
      }
    },
    refControlColor() {
      const frames = this.framesByLayerId(INITIAL_COLOR_LAYER_ID);
      // Deduplicate by imageDataId so a frame hold (duplicate frames) counts as one
      const imageIdToOriginal = new Map();
      for (let i = 0; i < frames.length; i += 1) {
        const f = frames[i];
        if (!f || !f.isSelected || !f.imageDataId) { continue; }
        const prev = imageIdToOriginal.get(f.imageDataId);
        // If any selected frame for this image is original, treat the image as original
        const isOrig = Boolean(prev) || Boolean(f.isOriginal);
        imageIdToOriginal.set(f.imageDataId, isOrig);
      }

      const numSelectedImages = imageIdToOriginal.size;
      if (numSelectedImages === 0) { return 'ref-control-white'; }

      let numOriginal = 0;
      imageIdToOriginal.forEach((isOrig) => { if (isOrig) { numOriginal += 1; } });

      if (numOriginal === numSelectedImages) { return 'ref-control-purple'; }
      if (numOriginal > 0) { return 'ref-control-half-purple'; }
      return 'ref-control-white';
    },

    isDuplicateOfLeftNeighborFrame(i) {
      return this.$store.getters[FRAMES_HAVE_SAME_IMAGE_DATA_ID]({
        layerId: INITIAL_COLOR_LAYER_ID,
        frameNrs: [i, i - 1],
      });
    },
  },
};
</script>

<style lang="scss">
.layer-controls {
  width: 100%;
  height: 60px;
  position: relative;
  align-items: center;
  justify-content: space-between;
  background-color: #353535;
  padding-left: 30px;
  display: none;
  &--visible {
    display: flex;
  }
  & + & {
    background-color: #3c3c3c;
  }
}

.layer-controls__background-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100vw;
  height: 60px;
  background-size: cover;
  display:inherit;
}

.layer-click-area {
  position: absolute;
  top: 0;
  left: 0;
  width: 100vw;
  height: 60px;
  display: inherit;
}

.layer-visibility-toggle {
  background-color: transparent;
  border: none;
  outline: none;
  opacity: 0.6; // not visible
  position: absolute;
  top: 17px; // optically align
  left: 125px;
}
.layer-visibility-toggle__icon {
  width: 24px;

  &:hover {
    opacity: 0.8;
  }
}

.reference-control {
  background: none;
  border: none;
  outline: none;
  opacity: 0.8; // not visible
  position: absolute;
  left: 160px;
  top: 20px;

  &:hover {
    opacity: 0.6;
  }
}

.activeLayerId {
  color: #9834d3;
  -webkit-text-stroke-width: 1px;
}

.layerShadow {
  position: absolute;
  top: 0;
  left: 0;
  width: 193px;
  height: 60px;
  background-size: cover;
  display: inherit;
}

.darkenLayerBg{
  background: rgba(43, 15, 51, 0.7);
}

.selected-layer-dot{
  position: absolute;
  margin-left: -18px;
  visibility: hidden;
}

.showDot{
  visibility: visible !important;
}

.hide-ref-control{
  display:none;
}

.ref-control-white {
  filter: invert(50%);
}

#halfDiamond.ref-control-half-purple {
  display:inline;
}

#halfDiamond.ref-control-purple, #halfDiamond.ref-control-white {
  display: none;
}

#fullDiamond.ref-control-purple, #fullDiamond.ref-control-white {
  display: inline;
}

#fullDiamond.ref-control-half-purple {
  display: none;
}

.layer-name {
  width: 90px;
}

</style>
