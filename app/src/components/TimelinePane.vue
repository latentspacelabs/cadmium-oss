<!-- eslint-disable linebreak-style -->
<template>
  <section class="timeline-pane step-0 step-1 step-3 step-4
    step-7 step-8 step-12 step-13 step-15 step-19">
    <div class="timeline-pane-left">
      <div class="timeline-controls">
        <div
          @click="collapseTimelineClicked"
          class="collapse-timeline-container"
        >
          <i class="collapse-timeline-btn"
            :class="{ 'collapse-timeline-btn--collapsed': !isTimelineVisible }"
          ></i>
        </div>
        <square-icon-button
          class="step-2"
          :icon="playPauseIcon"
          :content="playPauseTippy"
          @click="playButtonClicked"
        ></square-icon-button>
        <square-icon-button
          :class="['step-2', { 'square-icon-btn--active': loopEnabled } ]"
          :icon="loopIcon"
          :content="loopTippy"
          @click="toggleLoop"
        ></square-icon-button>
          <!-- TODO: display frame size based on active layer frame size -->
          <!-- eslint-disable max-len -->

          <select class="fps-select" :disabled="playerIsPlaying" @change="onFpsChange($event)">
            <option :selected="playerFps===1" value="1">1 fps</option>
            <option :selected="playerFps===2" value="2">2 fps</option>
            <option :selected="playerFps===3" value="3">3 fps</option>
            <option :selected="playerFps===4" value="4">4 fps</option>
            <option :selected="playerFps===6" value="6">6 fps</option>
            <option :selected="playerFps===8" value="8">8 fps</option>
            <option :selected="playerFps===12" value="12">12 fps</option>
            <option :selected="playerFps===15" value="15">15 fps</option>
            <option :selected="playerFps===24" value="24">24 fps</option>
            <option :selected="playerFps===25" value="25">25 fps</option>
            <option :selected="playerFps===30" value="30">30 fps</option>
          </select>
      </div>
      <layer-controls
        :title="outlinesTitle"
        :layerId="initialLineLayerId"
      ></layer-controls>
      <layer-controls
        :title="colorTitle"
        :layerId="initialColorLayerId"
        :backgroundImage="colorLayerBgImg"
      ></layer-controls>
    </div>
    <div
      class="timeline-pane-right"
      ref="timelinePaneRight"
      @scroll.passive="handleScroll"
      :style="{
        overflowX: timelineHasFrames ? 'auto' : 'hidden',
        overflowY: isTimelineVisible ? 'auto' : 'hidden',
      }"
    >
      <div class="timeline-framenumbers-wrapper" ref="frameNumbersWrapper">
        <!-- Loop range highlight -->
        <div
          v-if="loopEnabled && loopIn && loopOut"
          class="timeline-loop-range"
          :style="{
            left: `${(loopIn - 1) * frameWidth}px`,
            width: `${(loopOut - loopIn + 1) * frameWidth}px`,
          }"
        ></div>
        <div
          class="timeline-scrub-area"
          ref="timelineScrubber"

          @pointerup="onScrubberMouseUp"
          :class="{ 'timeline-scrub-area--visible': isScrubbing }"
        >
      </div>
        <div
          class="timeline-playhead"
          :style="{
            transform: `translateX(${(selectedFrameNr - 1) * this.frameWidth}px)`,
          }"
        ></div>
        <!-- Loop In/Out markers -->
        <div
          v-if="loopEnabled && loopIn"
          class="timeline-loop-marker timeline-loop-marker--in"
          :style="{
            transform: `translateX(${(loopIn - 1) * this.frameWidth}px)`,
          }"
          @pointerdown.stop.prevent="onLoopMarkerDown('in', $event)"
        ></div>
        <div
          v-if="loopEnabled && loopOut"
          class="timeline-loop-marker timeline-loop-marker--out"
          :style="{
            transform: `translateX(${(loopOut * this.frameWidth) - 1}px)`,
          }"
          @pointerdown.stop.prevent="onLoopMarkerDown('out', $event)"
        ></div>
        <!--
            :class="{
              'timeline-framenumbers__frame-label-wrapper--selected': selectedFrameNr == i,
            }"
          -->
        <div class="timeline-framenumbers" @pointerdown.stop>
          <div
            v-for="i in frameCount"
            :key="i"
            class="timeline-framenumbers__frame-label-wrapper"
            :id="'frameNr'+(i-1)"
            @pointerdown="onFrameNumberMouseDown(i, $event)"

            @pointerup="onFrameNumberMouseUp(i, $event)"
          >
            <div class="timeline-framenumbers__frame-label">{{ i - 1 }}</div>

          </div>
        </div>
      </div>
        <div class='timeline-all-layers-wrapper'
          :class="{ 'timeline-all-layers-wrapper--visible': isTimelineVisible }"
        >
          <div class='timeline-layer-wrapper timeline-layer-wrapper-top'>
            <frame-dropzone
              :hidden="layerHasAnyFrames(initialLineLayerId)"
              :text="outlineDropzoneText"
              :layer-id="initialLineLayerId"
              :layer-type="layerTypeLine"
            ></frame-dropzone>
            <layer-frames
              :layer-id="initialLineLayerId"
            ></layer-frames>
          </div>
        <div class='timeline-layer-wrapper'>
          <frame-dropzone
            :hidden="layerHasAnyFrames(initialColorLayerId)"
            :text="colorDropzoneText"
            :layer-id="initialColorLayerId"
            :layer-type="layerTypeColor"
          ></frame-dropzone>
          <layer-frames
            :layer-id="initialColorLayerId"
          ></layer-frames>
        </div>
      </div>
    </div>

  </section>
</template> <!-- eslint-disable linebreak-style -->
<!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */

import { t } from '@/util/i18n';

import { mapGetters, mapMutations, mapActions } from 'vuex';

import SquareIconButton from '@/components/SquareIconButton.vue';
import LayerControls from '@/components/LayerControls.vue';
import FrameDropzone from '@/components/FrameDropzone.vue';
import LayerFrames from '@/components/LayerFrames.vue';

import {
  FRAME_COUNT,
  LAYER_HAS_FRAMES,
  FRAMES_BY_LAYER_ID,
  SELECTED_FRAME_NR,
  PLAYER_IS_PLAYING,
  PLAYER_FPS,
  CANVAS_SIZE,
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  CANVAS_TOOL_ACTIVE,
  TIMELINE_SCROLL_VALUE_X,
  TIMELINE_HAS_FRAMES,
  TIMELINE_VISIBILITY,
} from '@/store/getter-types';

import {
  SET_SELECTED_FRAME_NUMBER,
  SET_CANVAS_TOOL_ACTIVE,
  SET_TIMELINE_SCROLL_VALUE_X,
  TOGGLE_TIMELINE_VISIBILITY,
} from '@/store/mutation-types';

import {
  PLAYER_PLAY_PAUSE,
} from '@/store/action-types';

import {
  LEFT_MOUSE_BUTTON,
  // RIGHT_MOUSE_BUTTON,
} from '@/util/mouse-util';

import {
  LAYER_TYPE_LINE,
  LAYER_TYPE_COLOR,
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
} from '@/store/general-types';

const iconPlay = require('../assets/icons/controls-play.svg');
const iconPause = require('../assets/icons/controls-pause.svg');
const colorLayerBgImg = require('../assets/color-layer-bg.png');

let mouseMoveEventListener = null;
// let mouseDownEventListener = null;

export default {
  data() {
    return {
      iconPlay,
      isScrubbing: false,
      // scrollValue: 0,
      lastFrame: -1,
      frameWidth: 17,
      loopIcon: require('../assets/icons/loopmode.svg'),
    };
  },
  computed: {
    outlineDropzoneText() { return t('1. Drop your outline frames here'); },
    colorDropzoneText() { return t('2. Drop your color frames here'); },
    outlinesTitle() { return t('Outlines'); },
    colorTitle() { return t('Color'); },
    ...mapGetters({
      frameCount: FRAME_COUNT,
      layerHasFrames: LAYER_HAS_FRAMES,
      framesByLayerId: FRAMES_BY_LAYER_ID,
      selectedFrameNr: SELECTED_FRAME_NR,
      playerIsPlaying: PLAYER_IS_PLAYING,
      playerFps: PLAYER_FPS,
      timelineHasFrames: TIMELINE_HAS_FRAMES,
      isTimelineVisible: TIMELINE_VISIBILITY,
      canvasSize: CANVAS_SIZE,
      toolActive: TOOL_CONTROL_ITEM_IS_VISIBLE,
      canvasToolActive: CANVAS_TOOL_ACTIVE,
      scrollValue: TIMELINE_SCROLL_VALUE_X,
    }),
    layerTypeLine: () => LAYER_TYPE_LINE,
    layerTypeColor: () => LAYER_TYPE_COLOR,
    initialColorLayerId: () => INITIAL_COLOR_LAYER_ID,
    initialLineLayerId: () => INITIAL_LINE_LAYER_ID,
    // framesForLayer: () => FRAMES(this.layerId),
    playPauseIcon() {
      return this.playerIsPlaying ? iconPause : iconPlay;
    },
    playPauseTippy() { return this.playerIsPlaying ? t('Pause (Return)') : t('Play (Return)'); },
    loopTippy() { return this.loopEnabled ? t('Disable Loop (L)') : t('Enable Loop (L)'); },

    colorLayerBgImg() { return colorLayerBgImg; },
    loopEnabled() { return this.$store.state.playerLoopEnabled; },
    loopIn() { return this.$store.state.playerLoopIn; },
    loopOut() { return this.$store.state.playerLoopOut; },
    // True if any actual frame objects exist on either layer (incl. placeholders)
    anyFramesExist() {
      return this.layerHasAnyFrames(this.initialLineLayerId)
        || this.layerHasAnyFrames(this.initialColorLayerId);
    },
  },
  methods: {
    // Helper function to check if layer has any frames (including ghost frames)
    // Used for dropzone visibility to hide dropzones once any frames exist
    layerHasAnyFrames(layerId) {
      const frames = this.framesByLayerId(layerId);
      return frames && frames.length > 0 && frames.some((f) => f);
    },
    ...mapMutations([
      SET_SELECTED_FRAME_NUMBER,
      SET_CANVAS_TOOL_ACTIVE,
      SET_TIMELINE_SCROLL_VALUE_X,
      TOGGLE_TIMELINE_VISIBILITY,
    ]),
    ...mapActions({
      playerPlayPause: PLAYER_PLAY_PAUSE,
    }),

    toggleLoop() {
      const enabled = !this.$store.state.playerLoopEnabled;
      this.$store.commit('set_player_loop_enabled', enabled);
      if (enabled) {
        // If no previous loop points, set sensible defaults around current selection
        if (!this.loopIn || !this.loopOut) {
          const current = this.selectedFrameNr;
          const outDefault = Math.min(current + 12, this.frameCount);
          this.$store.commit('set_player_loop_in', current);
          this.$store.commit('set_player_loop_out', outDefault);
        }
      }
    },

    onFpsChange(ev) {
      const fps = parseInt(ev.target.value, 10) || 24;
      this.$store.commit('set_player_fps', fps);
      if (this.playerIsPlaying) {
        this.playerPlayPause();
        this.playerPlayPause();
      }
    },

    onScrubberMouseMove(ev) {
      // Compute x relative to the frame numbers wrapper to avoid hard-coded offsets
      const wrapper = this.$refs.frameNumbersWrapper;
      if (!wrapper) { return; }
      const baseLeft = wrapper.getBoundingClientRect().left;
      const x = ev.clientX - baseLeft;
      // Translate x position to frame number and clamp into valid range
      const frameNr = Math.max(1, Math.min(this.frameCount, Math.floor(x / this.frameWidth) + 1));
      this[SET_SELECTED_FRAME_NUMBER](frameNr);
      this.checkScrubberMouseEdges();
    },

    onScrubberMouseUp() {
      // console.log('scrubber mouse up');
      const { timelineScrubber } = this.$refs;
      timelineScrubber.removeEventListener('pointermove', this.onScrubberMouseMove, false);
      timelineScrubber.removeEventListener('pointerdown', this.onScrubberMouseDown, false);
      this.isScrubbing = false;
      this.lastFrame = this.selectedFrameNr;
    },

    onLoopMarkerDown(which, ev) {
      const wrapper = this.$refs.frameNumbersWrapper;
      if (!wrapper) { return; }
      const baseLeft = wrapper.getBoundingClientRect().left;
      const onMove = (e) => {
        const x = e.clientX - baseLeft;
        const frameNr = Math.max(1, Math.min(this.frameCount, Math.floor(x / this.frameWidth) + 1));
        if (which === 'in') {
          const nextIn = Math.min(frameNr, this.loopOut || frameNr);
          this.$store.commit('set_player_loop_in', nextIn);
        }
        if (which === 'out') {
          // For the out marker, clamp to >= in
          const clamped = Math.max(frameNr, this.loopIn || frameNr);
          this.$store.commit('set_player_loop_out', clamped);
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },

    onFrameNumberMouseDown(frameNr, ev) {
      // Select the clicked frame immediately
      this[SET_SELECTED_FRAME_NUMBER](frameNr);

      // If a canvas tool is active, do not enter scrubbing
      if (this.canvasToolActive) { return; }

      // Only start scrubbing for primary button
      if (ev && ev.which === LEFT_MOUSE_BUTTON) {
        this.isScrubbing = true;
      } else {
        this.isScrubbing = false;
        return;
      }

      const { timelineScrubber } = this.$refs;

      if (this.playerIsPlaying) { this.playButtonClicked(); }

      if (!mouseMoveEventListener) {
        mouseMoveEventListener = timelineScrubber.addEventListener('pointermove', this.onScrubberMouseMove, false);
      }

      // If loop set button is active (e.g., meta+click), set in/out quickly
      if (ev.getModifierState && ev.getModifierState('Shift')) {
        this.$store.commit('set_player_loop_in', frameNr);
      }
      if (ev.getModifierState && ev.getModifierState('Alt')) {
        this.$store.commit('set_player_loop_out', frameNr);
      }
    },
    /*
    onFrameNumberMouseMove(frameNr, event) {
      console.log('frameNumberMouseMove');
      if (this.canvasToolActive) { return; }
      if (this.isPrimaryMouseButtonPressed(event)) {
        this[SET_SELECTED_FRAME_NUMBER](frameNr);
      }
    },
    */
    onFrameNumberMouseUp() {
      // console.log('frameMouseUp');
      const { timelineScrubber } = this.$refs;
      timelineScrubber.removeEventListener('pointermove', this.onScrubberMouseMove, false);
      timelineScrubber.removeEventListener('pointerdown', this.onScrubberMouseDown, false);
      this.isScrubbing = false;
    },

    playButtonClicked() {
      this.playerPlayPause();
    },
    collapseTimelineClicked() {
      this[TOGGLE_TIMELINE_VISIBILITY]();
    },
    /**
     * Returns true if the primary mouse button is pressed (based on the mouseEvent param)
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons|MouseEvent.buttons}
     */
    isPrimaryMouseButtonPressed(mouseEvent) {
      // All pressed buttons are added together. The number 1 stands for the primary mouse button.
      /* eslint-disable no-bitwise */
      return (mouseEvent.buttons & 1) === 1;
    },

    handleScroll() {
      const { timelinePaneRight } = this.$refs;
      // this.scrollValue = timelinePaneRight.scrollLeft;
      this[SET_TIMELINE_SCROLL_VALUE_X](timelinePaneRight.scrollLeft);
      // console.log('scrolling: ', this.scrollValue);
    },

    checkPlayHeadAtEdges() {
      if (
        !this.timelineHasFrames
        || this.lastFrame === this.selectedFrameNr
        || this.isScrubbing
      ) { return; }
      const { timelinePaneRight } = this.$refs;
      // we need this check so things don't break on reload
      if (!timelinePaneRight) { return; }
      // console.log('checkPlayHeadAtEdges');
      const markerPosition = ((this.selectedFrameNr - 1) * this.frameWidth) - this.scrollValue;
      // if our scrubbing goes close to right edge
      if (timelinePaneRight.clientWidth - markerPosition < (1 * this.frameWidth)) {
        // console.log('close to edge right');
        timelinePaneRight.scrollBy((this.selectedFrameNr - this.lastFrame) * this.frameWidth, 0);
      }
      // if our scrubbing goes close to left edge
      if (markerPosition < (1 * this.frameWidth)) {
        if (this.lastFrame > this.selectedFrameNr) {
          // console.log('close to edge left');
          timelinePaneRight.scrollBy((this.selectedFrameNr - this.lastFrame) * this.frameWidth, 0);
        }
      }
      this.lastFrame = this.selectedFrameNr;
    },

    checkScrubberMouseEdges() {
      if (
        !this.timelineHasFrames
        || !this.isScrubbing
      ) { return; }

      // console.log('checkScrubberMouseEdges');
      const { timelinePaneRight } = this.$refs;
      // const x = (ev.ClientX);
      // const xView = timelinePaneRight.clientWidth - x;
      const markerPosition = ((this.selectedFrameNr - 1) * this.frameWidth) - this.scrollValue;
      // if our scrubbing goes close to right edge
      if (timelinePaneRight.clientWidth - markerPosition < (4 * this.frameWidth)) {
        // console.log('close to edge right');
        timelinePaneRight.scrollBy(3 * this.frameWidth, 0);
      }
      // if our scrubbing goes close to left edge
      if (markerPosition < (4 * this.frameWidth)) {
        // console.log('close to edge left');
        timelinePaneRight.scrollBy(-3 * this.frameWidth, 0);
      }
      this.lastFrame = this.selectedFrameNr;
    },
  },
  watch: {
    selectedFrameNr() {
      this.checkPlayHeadAtEdges();
    },
    // When all frames are removed, reset horizontal scroll so dropzone appears at left
    anyFramesExist(newVal, oldVal) {
      if (newVal === false) {
        this.$nextTick(() => {
          const { timelinePaneRight } = this.$refs;
          if (timelinePaneRight) { timelinePaneRight.scrollLeft = 0; }
          this[SET_TIMELINE_SCROLL_VALUE_X](0);
        });
      }
    },
  },

  components: {
    SquareIconButton,
    LayerControls,
    FrameDropzone,
    LayerFrames,
  },
};
</script>

<style lang="scss">
.timeline-pane {
  // display: none;
  // &--visible {
    // background-color: #434343;
    display: flex;
    z-index: 2; // make sure to be over canvas
    flex-shrink : 0;
    flex-direction: row;
    --timeline-pane-left-width: 200px;
    color: white;
    background-color: #353535;
  // }
}

.square-icon-btn--active {
  background-color: #2d2d2d;
}
.square-icon-btn--active .square-icon-btn__icon {
  filter: invert(53%) sepia(15%) saturate(1649%) hue-rotate(266deg) brightness(94%) contrast(88%);
}

.fps-label {
  white-space: normal;
  // text-align: center;
  color: #797474;
  outline: none;
  border: 4px;
  padding-top: 12px;
  width: 132px;
  height: 39px;
  //align-items: left;
  //justify-content: left;
  border-radius: 4px;
  line-height: 16px;
  padding-left: 12px;
  font-size: 12px;
  background-color: #3c3c3c;
  z-index: 100;
}

.timeline-controls {
  width: 100%;
  height: 39px;
  // padding-left: 5px;
  // padding-right: 5px;
  display: flex;
  align-items: center;
  justify-content: normal;
  background-color: #3c3c3c;
}

.fps-select {
  color: #ffffff;
  background-color: #363636;
  border: none;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 16px;
  margin-left: 8px;
  cursor: pointer;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background-image: none !important;
  margin-right: 15px;
  margin-left: 30px;
}

.fps-select:disabled {
  opacity: 0.6;
  cursor: default;
}

// Hide IE/Edge native dropdown arrow
select.fps-select::-ms-expand {
  display: none;
}

.square-icon-btn {
  margin-left: 5px;
}

.collapse-timeline-btn {
  border: solid #aeaeae;
  border-width: 1px;
  border-left: 0px;
  border-bottom: 0px;
  margin-left: 10px;
  margin-top: 5px;
  margin-right: 5px;
  display: flex;
  height: 12px;
  width: 12px;
  -webkit-transform: rotate(135deg);
  transform: rotate(135deg);
  cursor: pointer;
  // content: "E6E0";
  &--collapsed {
    margin-top: 8px;
    -webkit-transform: rotate(315deg);
    transform: rotate(315deg);
  }
  &:hover {
    opacity: 0.8;
  }
}

.timeline-pane-left {
  background: #393939;
  position: relative;
  width: var(--timeline-pane-left-width);
  display: flex;
  flex-direction: column;
  align-items: center;
  // background-color: #3c3c3c;
}

.timeline-pane-right {
  position: relative;
  min-width: calc( 100% - var(--timeline-pane-left-width));
  background-color: transparent;
  & > * {
    // number of frames x frame rect (with padding), TODO: Make dynamic.
    min-width: calc(1000 * 17px);
  }

  // creates a margin for the scrollbar
  // & >:last-child {
  // }

  &::-webkit-scrollbar {
    height: 11px;
    padding-top: 4px;

    &:before { margin-top: 40px; }
  }

  &::-webkit-scrollbar-thumb {
    background: #a8a8a8;
    border-radius: 6px;
  }

  &::-webkit-scrollbar-track {
    background: #474747;
    border-radius: 6px;
  }
}

.timeline__current-time {
  color: white;
  font-style: italic;
}

.timeline-framenumbers-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 17000px;
  white-space: nowrap;
  background-color: #434343;
}

.timeline-loop-range {
  position: absolute;
  top: 0;
  height: 39px; /* matches label row height */
  background: rgba(152, 52, 219, 0.25);
  z-index: 8;
  pointer-events: none; /* don't block clicks to labels or markers */
}

.timeline-scrub-area {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  opacity: 0;

  &--visible {
    width: 100vw;
    height: 100vh;
    z-index: 30;
    cursor: pointer;
  }

}

.timeline-playhead {
  position: absolute;
  top: 0;
  left: 0;
  width: 16px;
  height: 159px;
  z-index: 1;
  background-color: #262626;
}

.timeline-loop-marker {
  position: absolute;
  top: 0;
  width: 2px;
  height: 39px;
  z-index: 15; /* above labels */
  cursor: col-resize;
}
.timeline-loop-marker--in { background-color: #00c286; }
.timeline-loop-marker--out { background-color: #ae2c90; }

.timeline-framenumbers {
  white-space: nowrap;
  z-index: 10;
}

.timeline-framenumbers__frame-label-wrapper {
  width: 16px;
  height: 39px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;

  // &--selected {
  //   background-color: #353535;
  // }

  // &:hover {
  //   background-color: #353535;
  // }

  & + & {
    margin-left: 1px;
  }
}

.timeline-framenumbers__frame-label {
  // needs to be small enough, so that three digit frames to not collide
  font-size: 9px;
  user-select: none;
}
.timeline-all-layers-wrapper {
  display: none;
  &--visible {
    display: inherit;
  }
}
.timeline-layer-wrapper {
  position: relative;
  height: 60px;
  width: 17000px;
}

.timeline-layer-wrapper-top {
  background: #353535;
}

.layer-name {
  z-index: 20;
  &:hover {
    opacity: .8;
    // -webkit-text-stroke-width: 1px;
  }
}

.collapse-timeline-container {
  height: 27px;
  cursor: pointer;
}

</style>
