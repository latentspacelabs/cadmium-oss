/* eslint-disable linebreak-style */
/* eslint-disable */
import Vue from 'vue';

import {
  SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
  SET_SELECTED_FRAME_NUMBER,
  SET_SELECTED_FRAME_TO_PREVIOUS_FRAME,
  SET_SELECTED_FRAME_TO_NEXT_FRAME,
  SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME,
  SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME,
  SET_FRAME_SELECTED,
  SET_FRAMES_SELECTED,
  SET_FRAME_ORIGINAL,
  SET_FRAMES_TO_LOADING,
  DESELECT_FRAMES,
  CREATE_PLAYER_INTERVAL,
  DESTROY_PLAYER_INTERVAL,
  SET_REF_FRAMES_FOR_FRAME,
  TOGGLE_LAYER_VISIBILITY,
  TOGGLE_TIMELINE_VISIBILITY,
  DELETE_SELECTED_FRAMES,
  SET_FILE_DRAG_N_DROP_IN_PROGRESS,
  SET_LAST_IMPORTED_IMAGE_TOO_BIG,
  SET_COLORIZATION_PROGRESS,
  SET_UPDATED_COLORS_PROGRESS,
  SET_EXPORT_PROGRESS,
  SET_EXPORT_IN_PROGRESS,
  SET_EXPORT_CANCELED_BY_USER,
  SET_EXPORTING_COLORS_SEPARATELY,
  SET_ANALYZE_MODE_ONLY,
  SET_AI_GAP_CLOSER_ENABLED,
  SET_MAX_AI_DILATION_SIZE,
  SET_MAX_TB_DILATION_SIZE,  
  SET_MIN_SEG_SIZE,
  SET_LINE_THRESHOLD,
  SET_MAX_ITER,
  SET_FRAMES_SELECTED_ON_WHOLE_LAYER,
  SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION,
  SET_LAST_EXPORT_TIME,
  SET_TIME_FOR_LAST_COLORIZATION,
  SET_FILE_IMPORT_CANCELED_BY_USER,
  SET_LAYER_TYPE_OF_FILES_TO_IMPORT,
  SET_COLORIZATION_IN_PROGRESS,
  SET_UPDATE_COLORS_IN_PROGRESS,
  SET_COLORIZATION_CANCELED_BY_USER,
  SET_UPDATE_COLORS_CANCELED_BY_USER,
  SET_CURRENT_PROCESSING_TASK,
  ENABLE_FAKE_COLORIZATION,
  DETACH_SELECTED_FRAMES_FROM_THEIR_IMAGE_DATA,
  SET_LAST_IMPORTED_IMAGE_HAS_DIFFERENT_DIMS_THAN_CANVAS,
  SET_CANVAS_SIZE,
  SET_AVAILABLE_SPACE_FOR_CANVAS,
  SET_CANVAS_SCALE,
  SET_CANVAS_TOOL_ACTIVE,
  SET_BACKGROUND_COLOR,
  SET_TIMELINE_SCROLL_VALUE_X,
  ADD_COLOR_TO_PALETTE,
  CLEAR_COLOR_PALETTE,
  DELETE_COLOR_FROM_PALETTE,
  SET_PALETTE_EVENT_OCCURRED,
  SET_CANVAS_REDRAW_TRIGGER,
  CREATE_PLAYER_RAF,
  DESTROY_PLAYER_RAF,
  SET_PLAYER_FPS,
  SET_PLAYER_LOOP_ENABLED,
  SET_PLAYER_LOOP_IN,
  SET_PLAYER_LOOP_OUT,
  SET_COLOR_COLLAPSE,
  SET_FILL_COLLAPSE,
  SET_ACTIVE_LAYER_ID,
  SET_PEN_COLLAPSE,
  SET_ERASER_COLLAPSE,
  SET_UPDATE_IN_PROGRESS,
  SET_UPDATE_PERCENTAGE,
  SET_TEMP_FILE_PATHS,
  SET_CURRENT_FILE,
  SET_UNSAVED_CHANGES,
  SET_NEW_PROJECT,
  TOGGLE_SWATCH_VISIBILITY,
  SET_ANALYZE_CANCELED_BY_USER,
  SET_REFERENCE_COLLAPSE,
  ADD_FILE_TO_REFERENCE_FILES,
  DELETE_FILE_FROM_REFERENCE_FILES,
  SET_SELECTED_REFERENCE_FILE,
  SET_REF_CANVAS_SIZE,
  SET_REF_WIN_HEIGHT,
  SET_REF_WIN_WIDTH,
  SET_REF_CAN_POS,
  SET_REF_CAN_SCALE,
  SET_SEG_OPTIONS_COLLAPSE,
  SET_SEG_PANEL_HIGHLIGHT,
  SET_RAINBOW_MODE,
  SET_PROJECT_ID,
  TOGGLE_AUTO_ALPHA,
  APPLY_STATE_PATCH,
  SET_SERVER_BACKEND,
} from '@/store/mutation-types';

import { applyPatch } from '@/services/state-patch';

import {
  INVALID_LAYER_ID,
  INVALID_FRAME_NR,
  LAYER_TYPE_LINE,
  LAYER_TYPE_COLOR,
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
} from '@/store/general-types';

import { defaultState } from '@/util/default-state';
import triggerMenuRebuildWithColorizationState from '@/util/menu';
/* eslint no-shadow: ["error", { "allow": ["state"] }] */
// eslint-disable-next-line
const state = defaultState();

// The frame player's setInterval / requestAnimationFrame handle. Deliberately
// NOT in Vuex state: CREATE_PLAYER_RAF reassigns it every animation frame during
// playback, so a reactive write per frame would thrash Vue's dependency
// tracking, and a timer handle is meaningless to persist into a .cdm. Nothing
// reads it reactively — only the player mutations below touch it.
let playerHandle = null;

/**
 * Helper function to generate an empty frame
 */
function getEmptyFrame() {
  return {
    imageDataId: null, // ID of the ImageData object, which stores the base64 data URI
    isSelected: false,
    isOriginal: false, // true sets to a reference frame
    isLoading: false,
    refFrameLeftNr: null, // not correct all the time, updated on selection
    refFrameRightNr: null, // ...
    refFrameClosestNr: null, // the closest reference frame (left or right)
    frameNr: INVALID_FRAME_NR,
    // isGhost: true,
    // when the frame was ML-colorized, this holds an ID of the colorization session
    // (i.e. session is renewed once the user pressed the colorize button)
    // colorizationSessionId: null,
    // segmentationMapPath: null, // only for line frames
  };
}

/* eslint-disable no-param-reassign */
export default {
  /**
   * @param {object} state
   * @param {object} options
   * @param {number} options.layerId - the layer ID
   * @param {string} options.imageDataId - ID of the image data object,
   *   can be empty (null / undefined)
   * @param {number} options.frameNr - the number of the frame
   * @param {boolean} options.isOriginal - true if the frame was imported (not generated)
   * @param {boolean} options.force - if set image even original image data will be overwritten
   */
  [SET_IMAGE_DATA_FOR_FRAME_WITH_ID](state, {
    layerId,
    imageDataId,
    frameNr,
    isOriginal = false,
    isLoading = false,
    force = false,
    // isGhost = false,
  }) {
    if (!layerId || !frameNr) {
      console.error('Could not import frame, bad arguments.');
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Could not import frame, layer does not exist.'); return; }
    let frame = getEmptyFrame();
    // if there is already a frame object at this index, re-use it
    if (layer.frames[frameNr]) {
      frame = layer.frames[frameNr];
    }
    // if there is already an original frame, do nothing
    if (frame.isOriginal && !force) { return; }

    if (frameNr < state.firstRealFrameNumber || state.lastRealFrameNumber === INVALID_FRAME_NR) {
      state.firstRealFrameNumber = frameNr;
    }
    if (frameNr > state.lastRealFrameNumber || state.lastRealFrameNumber === INVALID_FRAME_NR) {
      state.lastRealFrameNumber = frameNr;
    }

    frame.imageDataId = imageDataId;
    Vue.set(layer.frames, [frameNr], {
      ...frame,
      frameNr,
      isOriginal,
      isLoading,
    });
  },

  /**
   * Creates an emtpy frame at index layerId if none exists
   * @param {object} state
   * @param {object} options
   * @param {string} options.layerId
   * @param {number} options.frameNr
   */
  [CREATE_EMPTY_FRAME_IF_NONE_EXISTS](state, { layerId, frameNr, imageDataId }) {
    if (!layerId || !frameNr) {
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { return; }
    // if there is already a frame object at this index, don't do anything
    if (!layer.frames[frameNr]) {
      let frame = { ...getEmptyFrame(), frameNr };
      if (imageDataId) {
        frame = {
          ...frame,
          imageDataId,
        };
      }
      Vue.set(layer.frames, [frameNr], frame);
    }
  },

  [SET_SELECTED_FRAME_NUMBER](state, frameNr) {
    state.selectedFrame = frameNr;
  },

  [SET_SELECTED_FRAME_TO_NEXT_FRAME](state) {
    const curFrameNr = state.selectedFrame;
    const nextFrameNr = curFrameNr + 1;
    // only increment frame number when the frame fits on the timeline
    if (nextFrameNr <= state.timelineFrames) {
      state.selectedFrame = nextFrameNr;
    }
  },

  [SET_SELECTED_FRAME_TO_PREVIOUS_FRAME](state) {
    const curFrameNr = state.selectedFrame;
    const previousFrameNr = curFrameNr - 1;
    // only increment frame number when the frame fits on the timeline
    if (previousFrameNr > 0) {
      state.selectedFrame = previousFrameNr;
    }
  },

  [SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME](state, { layerId, isSelected = true }) {
    if (!layerId) {
      console.error(`Bad arguments: layerId: ${layerId}, isSelected (optional): ${isSelected}`);
      return;
    }
    const layer = state.layers[layerId];
    const curFrameNr = state.selectedFrame;
    
    // Helper function to check if a frame has any content (line or color)
    const frameHasContent = (frameIndex) => {
      const lineFrame = state.layers[INITIAL_LINE_LAYER_ID]?.frames[frameIndex];
      const colorFrame = state.layers[INITIAL_COLOR_LAYER_ID]?.frames[frameIndex];
      return (lineFrame && lineFrame.imageDataId) || (colorFrame && colorFrame.imageDataId);
    };
    
    // Helper function to get combined image data ID for comparison
    const getCombinedImageId = (frameIndex) => {
      const lineFrame = state.layers[INITIAL_LINE_LAYER_ID]?.frames[frameIndex];
      const colorFrame = state.layers[INITIAL_COLOR_LAYER_ID]?.frames[frameIndex];
      return (lineFrame?.imageDataId || 'line-null') + '|' + (colorFrame?.imageDataId || 'color-null');
    };
    
    let i;
    for (i = curFrameNr - 1; i > 0; i -= 1) {
      if (frameHasContent(i)) {
        // Check if this frame has different content than the previous frame
        if (!frameHasContent(i - 1) || getCombinedImageId(i - 1) !== getCombinedImageId(i)) {
          if (i > 0) {
            state.selectedFrame = i;
          }
          break;
        }
      } else if (frameHasContent(i - 1)) {
        // Found a frame with content after empty frames
        state.selectedFrame = i;
        break;
      }
    }
  },

  [SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME](state, { layerId, isSelected = true }) {
    if (!layerId) {
      console.error(`Bad arguments: layerId: ${layerId}, isSelected (optional): ${isSelected}`);
      return;
    }
    const layer = state.layers[layerId];
    const curFrameNr = state.selectedFrame;
    
    // Helper function to check if a frame has any content (line or color)
    const frameHasContent = (frameIndex) => {
      const lineFrame = state.layers[INITIAL_LINE_LAYER_ID]?.frames[frameIndex];
      const colorFrame = state.layers[INITIAL_COLOR_LAYER_ID]?.frames[frameIndex];
      return (lineFrame && lineFrame.imageDataId) || (colorFrame && colorFrame.imageDataId);
    };
    
    // Helper function to get combined image data ID for comparison
    const getCombinedImageId = (frameIndex) => {
      const lineFrame = state.layers[INITIAL_LINE_LAYER_ID]?.frames[frameIndex];
      const colorFrame = state.layers[INITIAL_COLOR_LAYER_ID]?.frames[frameIndex];
      return (lineFrame?.imageDataId || 'line-null') + '|' + (colorFrame?.imageDataId || 'color-null');
    };
    
    let i;
    for (i = curFrameNr + 1; i <= state.timelineFrames; i += 1) {
      if (frameHasContent(i)) {
        // Check if this frame has different content than the previous frame
        if (!frameHasContent(i - 1) || getCombinedImageId(i - 1) !== getCombinedImageId(i)) {
          if (i <= state.timelineFrames) {
            state.selectedFrame = i;
          }
          break;
        }
      } else if (frameHasContent(i - 1)) {
        // Found a frame with content after empty frames
        state.selectedFrame = i;
        break;
      }
    }
  },

  [SET_FRAMES_SELECTED_ON_WHOLE_LAYER](state, { layerId, isSelected = true }) {
    if (!layerId) {
      console.error(`Bad arguments: layerId: ${layerId}, isSelected (optional): ${isSelected}`);
      return;
    }
    const layer = state.layers[layerId];
    // console.log("layerId:  " + layerId);
    if (!layer) { console.error('Layer does not exist.'); return; }
    if (!layer.frames) {
      console.error('Layer has no frames');
      return;
    }
    layer.frames.forEach((frame) => {
      if (frame) {
        Vue.set(layer.frames, [frame.frameNr], { ...layer.frames[frame.frameNr], isSelected });
      }
    });
    state.lastSelectedFrameNr = INVALID_FRAME_NR;
    state.lastSelectedLayerId = INVALID_LAYER_ID;
  },

  [SET_FRAME_SELECTED](state, {
    layerId,
    frameNr,
    isSelected,
    shiftKeyIsPressed,
  }) {
    if (!layerId || !frameNr || typeof isSelected === 'undefined') {
      console.error(`Bad arguments: layerId: ${layerId}, frameNr: ${frameNr}, isSelected: ${isSelected}`);
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer does not exist.'); return; }
    if (!layer.frames || !layer.frames[frameNr]) {
      console.error('Layer has no frames');
      return;
    }
    // if user holds the shift key, make a group selection
    if (
      isSelected
      && state.lastSelectedFrameNr !== INVALID_FRAME_NR
      && state.lastSelectedLayerId === layerId
      && shiftKeyIsPressed
    ) {
      const smallerFrameNr = Math.min(state.lastSelectedFrameNr, frameNr);
      const biggerFrameNr = Math.max(state.lastSelectedFrameNr, frameNr);
      let fNr = smallerFrameNr;
      while (fNr <= biggerFrameNr) {
        if (layer.frames[fNr]) {
          Vue.set(layer.frames, [fNr], { ...layer.frames[fNr], isSelected: true });
        }
        fNr += 1;
      }
      // reset
      state.lastSelectedFrameNr = INVALID_FRAME_NR;
      state.lastSelectedLayerId = INVALID_LAYER_ID;
    } else {
      // we need to store the current selection for shift-click selections
      /* eslint-disable no-lonely-if */
      if (isSelected) {
        state.lastSelectedFrameNr = frameNr;
        state.lastSelectedLayerId = layerId;
      } else {
        state.lastSelectedFrameNr = INVALID_FRAME_NR;
        state.lastSelectedLayerId = INVALID_LAYER_ID;
      }
    }
    Vue.set(layer.frames, [frameNr], { ...layer.frames[frameNr], isSelected });
  },

  [SET_FRAMES_SELECTED](state, {
    layerId,
    frameNrs,
    isSelected = true,
  }) {
    if (!layerId || !typeof frameNrs === 'undefined') {
      console.error(`Bad arguments: layerId: ${layerId}, frameNrs: ${frameNrs}, isSelected [default=true]: ${isSelected}`);
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer does not exist.'); return; }
    if (!layer.frames) {
      console.error(`Layer with ID ${layerId} has no frames`);
      return;
    }
    frameNrs.forEach((frameNr) => {
      Vue.set(layer.frames, [frameNr], { ...layer.frames[frameNr], isSelected });
    });
    // reset selection state (used for group selections)
    state.lastSelectedFrameNr = INVALID_FRAME_NR;
    state.lastSelectedLayerId = INVALID_LAYER_ID;
  },

  [SET_FRAME_ORIGINAL](state, { frameNr, layerId, isOriginal = true }) {
    if (!layerId || !typeof frameNr === 'undefined') {
      console.error(`Bad arguments: layerId: ${layerId}, frameNr: ${frameNr}, isOriginal [default=true]: ${isOriginal}`);
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer does not exist.'); return; }
    if (!layer.frames) {
      console.error(`Layer with ID ${layerId} has no frames`);
      return;
    }
    Vue.set(layer.frames, [frameNr], { ...layer.frames[frameNr], isOriginal });
  },

  [SET_FRAMES_TO_LOADING](state, { layerId, frameNrs, isLoading = true }) {
    if (!layerId || !frameNrs || !Array.isArray(frameNrs)) {
      console.error(`Bad arguments: layerId: ${layerId}, frameNrs: ${frameNrs}`);
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Could not set frames to loading, layer does not exist.'); return; }
    if (!layer.frames) { console.error('Could not set frames to loading, layer has not frames.'); return; }
    frameNrs.forEach((frameNr) => {
      const frame = layer.frames[frameNr];
      // skip original color frames
      if (frame) {
        if (
          layer.type === LAYER_TYPE_LINE
          || (layer.type === LAYER_TYPE_COLOR && !frame.isOriginal)
        ) {
          layer.frames[frameNr].isLoading = isLoading;
        }
      }
    });
  },

  [DESELECT_FRAMES](state, { layerId, frameNrs }) {
    if (!layerId || !frameNrs || !Array.isArray(frameNrs)) {
      console.error(`Bad arguments: layerId: ${layerId}, frameNrs: ${frameNrs}`);
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Could not deselect frames, layer does not exist.'); return; }
    if (!layer.frames) { console.error('Could not deselect frames, layer has not frames.'); return; }
    frameNrs.forEach((frameNr) => {
      if (layer.frames[frameNr]) {
        layer.frames[frameNr].isSelected = false;
      }
    });
  },

  [CREATE_PLAYER_INTERVAL](state, fps) {
    if (!fps) { console.error(CREATE_PLAYER_INTERVAL, ': fps cannot be 0'); return; }
    playerHandle = setInterval(() => {
      state.selectedFrame += 1;
      // if (state.selectedFrame >= state.timelineFrames) {
      //   state.selectedFrame = 1; // set back to first frame
      // }
      if (
        state.selectedFrame > state.timelineFrames
        || state.selectedFrame > state.lastRealFrameNumber
        || state.selectedFrame < state.firstRealFrameNumber
      ) {
        state.selectedFrame = state.firstRealFrameNumber; // set back to first frame
      }
    }, 1000 / fps);
    state.playerIsPlaying = true;
  },

  [DESTROY_PLAYER_INTERVAL](state) {
    if (!playerHandle) { return; }
    clearInterval(playerHandle);
    state.playerIsPlaying = false;
  },

  // New: requestAnimationFrame-based player
  [CREATE_PLAYER_RAF](state, fps) {
    if (!fps) { console.error(CREATE_PLAYER_INTERVAL, ': fps cannot be 0'); return; }
    const frameDurationMs = 1000 / fps;
    let lastTimestamp = 0;
    const playheadStart = state.selectedFrame;

    const step = (ts) => {
      if (!state.playerIsPlaying) { return; }
      if (!lastTimestamp) { lastTimestamp = ts; }
      const elapsed = ts - lastTimestamp;
      if (elapsed >= frameDurationMs) {
        const framesToAdvance = Math.floor(elapsed / frameDurationMs) || 1;
        state.selectedFrame += framesToAdvance;
        // Loop handling
        if (state.playerLoopEnabled && state.playerLoopIn && state.playerLoopOut) {
          if (state.selectedFrame > state.playerLoopOut) {
            state.selectedFrame = state.playerLoopIn;
          }
          if (state.selectedFrame < state.playerLoopIn) {
            state.selectedFrame = state.playerLoopIn;
          }
        } else {
          if (
            state.selectedFrame > state.timelineFrames
            || state.selectedFrame > state.lastRealFrameNumber
            || state.selectedFrame < state.firstRealFrameNumber
          ) {
            state.selectedFrame = state.firstRealFrameNumber;
          }
        }
        lastTimestamp += framesToAdvance * frameDurationMs;
      }
      playerHandle = window.requestAnimationFrame(step);
    };
    state.playerIsPlaying = true;
    playerHandle = window.requestAnimationFrame(step);
  },

  [DESTROY_PLAYER_RAF](state) {
    if (!playerHandle) { return; }
    window.cancelAnimationFrame(playerHandle);
    playerHandle = null;
    state.playerIsPlaying = false;
  },

  [SET_PLAYER_FPS](state, fps) {
    if (!fps || fps <= 0) { return; }
    state.playerFps = fps;
  },

  [SET_PLAYER_LOOP_ENABLED](state, enabled) {
    if (enabled === 'toggle') {
      state.playerLoopEnabled = !state.playerLoopEnabled;
      return;
    }
    state.playerLoopEnabled = Boolean(enabled);
  },
  [SET_PLAYER_LOOP_IN](state, frameNr) {
    state.playerLoopIn = frameNr;
  },
  [SET_PLAYER_LOOP_OUT](state, frameNr) {
    state.playerLoopOut = frameNr;
  },

  [SET_REF_FRAMES_FOR_FRAME](state, {
    layerId,
    frameNr,
    refFrameLeftNr,
    refFrameRightNr,
    refFrameClosestNr,
  }) {
    if (!layerId || typeof frameNr === 'undefined') {
      console.error(`Bad arguments: layerId: ${layerId}, frameNr: ${frameNr}, `);
      return;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer does not exist.'); return; }
    if (!layer.frames) { console.error('Layer has not frames.'); return; }
    // No check for null needed. Function can be used to reset the reference frame nrs
    if (!layer.frames[frameNr]) { return; }
    layer.frames[frameNr].refFrameLeftNr = refFrameLeftNr;
    layer.frames[frameNr].refFrameRightNr = refFrameRightNr;
    if (typeof refFrameClosestNr !== 'undefined') {
      layer.frames[frameNr].refFrameClosestNr = refFrameClosestNr;
    }
  },

  [TOGGLE_LAYER_VISIBILITY](state, layerId) {
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer does not exist.'); return; }
    Vue.set(layer, 'visible', !layer.visible);
    // layer.visible = !layer.visible;
  },

  [TOGGLE_TIMELINE_VISIBILITY](state) {
    const timelineVisible = state.timelineVisibility;
    if (!timelineVisible) {
      state.timelineVisibility = true;
    } else {
      state.timelineVisibility = false;
    }
  },

  [DELETE_SELECTED_FRAMES](state) {
    const layerIds = Object.keys(state.layers);
    const selectedFrameIndices = new Set();

    const clearImageStoreDataUri = (id) => {
      if (!id || !state.ImageStore || !state.ImageStore.imageDataById) return;
      const entry = state.ImageStore.imageDataById[id];
      if (entry) entry.dataUri = null;
    };

       const clearImageStoreHash = (id) => {
      if (!id || !state.ImageStore || !state.ImageStore.imageDataById) return;
      const entry = state.ImageStore.imageDataById[id];
      if (entry) entry.hash = null;
    };

    const hasStoredData = (id) => {
      if (!id || !state.ImageStore || !state.ImageStore.imageDataById) return false;
      const entry = state.ImageStore.imageDataById[id];
      return !!(entry && entry.dataUri);
    };

    // 1) Collect selected frame indices (only frames that are selected on their layer)
    for (const lid of layerIds) {
      const layer = state.layers[lid];
      if (!layer || !Array.isArray(layer.frames)) continue;
      layer.frames.forEach((frame, fi) => {
        if (frame && frame.isSelected) selectedFrameIndices.add(fi);
      });
    }

    if (selectedFrameIndices.size === 0) return;

    // 2) First pass: clear only the selected frames on each layer according to rules
    for (const lid of layerIds) {
      const layer = state.layers[lid];
      if (!layer || !Array.isArray(layer.frames)) continue;

      layer.frames.forEach((frame, fi) => {
        if (!frame || !frame.isSelected) return;

        if (layer.type === LAYER_TYPE_LINE) {
          // Clear line frame imageDataId
          clearImageStoreDataUri(frame.imageDataId);
          clearImageStoreHash(frame.imageDataId);

        } else if (layer.type === LAYER_TYPE_COLOR) {
          // Color layer: clear only color imageDataId and unset original/reference flag
          clearImageStoreDataUri(frame.imageDataId);
          clearImageStoreHash(frame.imageDataId);
          Vue.set(layer.frames, fi, {
            ...frame,
            // imageDataId: null,
            hash: null,
            hashDirty: true,
            isOriginal: false,
          });

        } else {
          // Other layers: clear imageDataId
          clearImageStoreDataUri(frame.imageDataId);
          Vue.set(layer.frames, fi, {
            ...frame,
            imageDataId: null,
            hash: null,
          });
        }
      });
    }

    // 3) Second pass: decide removal vs keep placeholder using ImageStore.dataUri presence
    for (const fi of selectedFrameIndices) {
      let anyHasData = false;

      for (const lid of layerIds) {
        const l = state.layers[lid];
        if (!l || !Array.isArray(l.frames)) continue;
        const f = l.frames[fi];
        if (!f) continue;
        if (hasStoredData(f.imageDataId)) {
          anyHasData = true;
          break;
        }
      }

      if (!anyHasData) {
        // remove frame entry across all layers (no ghost)
        for (const lid of layerIds) {
          const l = state.layers[lid];
          if (!l || !Array.isArray(l.frames)) continue;
          Vue.set(l.frames, fi, undefined);
        }
      } else {
        // ensure color-layer placeholders are not marked original/ref
        for (const lid of layerIds) {
          const l = state.layers[lid];
          if (!l || !Array.isArray(l.frames)) continue;
          const f = l.frames[fi];
          if (!f) continue;
          if (l.type === LAYER_TYPE_COLOR && !hasStoredData(f.imageDataId) && f.isOriginal) {
            Vue.set(l.frames, fi, { ...f, isOriginal: false });
          }
        }
      }
    }

    // 4) Safety pass: cover edge-cases where ids exist but no stored data left anywhere at index
    for (const fi of selectedFrameIndices) {
      let anyStored = false;
      for (const lid of layerIds) {
        const l = state.layers[lid];
        if (!l || !Array.isArray(l.frames)) continue;
        const f = l.frames[fi];
        if (!f) continue;
        if (hasStoredData(f.imageDataId)) {
          anyStored = true;
          break;
        }
      }
      if (!anyStored) {
        for (const lid of layerIds) {
          const l = state.layers[lid];
          if (!l || !Array.isArray(l.frames)) continue;
          Vue.set(l.frames, fi, undefined);
        }
      }
    }

    // 5) Recompute bookkeeping (first/last real frame numbers based on imageDataId presence)
    let maxFrame = INVALID_FRAME_NR;
    let minFrame = state.timelineFrames;
    for (const lid of layerIds) {
      const l = state.layers[lid];
      if (!l || !Array.isArray(l.frames)) continue;
      l.frames.forEach((f, idx) => {
        if (f && f.imageDataId && idx > maxFrame) maxFrame = idx;
        if (f && f.imageDataId && idx < minFrame) minFrame = idx;
      });
    }
    state.lastRealFrameNumber = maxFrame;
    state.firstRealFrameNumber = minFrame;
    state.frameAddedOrRemoved += 1;

    // 6) Deselect any remaining selected frames
    for (const lid of layerIds) {
      const l = state.layers[lid];
      if (!l || !Array.isArray(l.frames)) continue;
      l.frames.forEach((f, idx) => {
        if (f && f.isSelected) {
          Vue.set(l.frames, idx, { ...f, isSelected: false });
        }
      });
    }
  },

  [DETACH_SELECTED_FRAMES_FROM_THEIR_IMAGE_DATA](state) {
    const layerIds = Object.keys(state.layers);
    layerIds.forEach((layerId) => {
      const layer = state.layers[layerId];
      const { frames } = layer;
      // delete frames
      frames.forEach((frame) => {
        if (frame && frame.isSelected) {
          frame.imageDataId = null;
          // Vue.set(layer.frames, i, null);
        }
      });
    });
  },

  [SET_FILE_DRAG_N_DROP_IN_PROGRESS](state, b) {
    state.fileDragNDropInProgress = b;
  },

  [SET_LAST_IMPORTED_IMAGE_TOO_BIG](state, isTooBig) {
    state.lastImportedImageTooBig = isTooBig;
  },

  /**
   * Sets the progress of the segmentation map generation (e.g. "10 of 20 have been generated").
   *
   * @param {*} state
   * @param {Object} options
   * @param {number} options.numTotal - Total number of images to import / segmentation maps
   *   to generate in current import session
   * @param {number} options.numFinished - How many of the total were already imported / generated
   * @param {number} options.dilationAmount - How much to dilate the line for segmentation
   */
  [SET_COLORIZATION_PROGRESS](state, { numTotal, numFinished, timeRemaining }) {
    if (typeof numTotal !== 'undefined') {
      state.numberOfImagesToColorize = numTotal;
      // console.log('frames to color: ', numTotal);
    }
    if (typeof numFinished !== 'undefined') {
      state.numberOfImagesColorized = numFinished;
      // console.log('frames colored: ', numFinished);
    }
    if (typeof timeRemaining !== 'undefined') {
      state.estTimeRemaining = timeRemaining;
      // console.log('EST time remaining: ', timeRemaining);
    }
  },

  [SET_UPDATED_COLORS_PROGRESS](state, { numTotal, numFinished }) {
    if (typeof numTotal !== 'undefined') {
      state.updatedColorsProgress.numTotal = numTotal;
    }
    if (typeof numFinished !== 'undefined') {
      state.updatedColorsProgress.numFinished = numFinished;
    }
  },

  [SET_EXPORT_PROGRESS](state, { numTotal, numFinished }) {
    if (typeof numTotal !== 'undefined') {
      state.numberOfImagesToExport = numTotal;
      // console.log('frames to export: ', numTotal);
    }
    if (typeof numFinished !== 'undefined') {
      state.numberOfImagesExported = numFinished;
      // console.log('frames exported: ', numFinished);
    }
  },

  [SET_ANALYZE_MODE_ONLY](state, b) {
    state.analyzeModeOnly = b;
  },
  [SET_AI_GAP_CLOSER_ENABLED](state, b) {
    state.aiGapCloserEnabled = b;
  },
  [SET_MAX_AI_DILATION_SIZE](state, dilationAmount) {
    state.maxAiDilationSize = dilationAmount;
  },
   [SET_MAX_TB_DILATION_SIZE](state, dilationAmount) {
    state.maxTbDilationSize = dilationAmount;
  },
  [SET_MIN_SEG_SIZE](state, minSegSize) {
    state.minSegSize = minSegSize;
  },
  [SET_LINE_THRESHOLD](state, lineThreshold) {
    state.lineThreshold = lineThreshold;
  },
  [SET_MAX_ITER](state, maxIter) {
    state.maxIter = maxIter;
  },
  [SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION](store, timeInSec) {
    store.lastSegmentationMapGenerationTime = timeInSec;
  },
  [SET_LAST_EXPORT_TIME](state, secondsPerItem) {
    state.lastExportTime = secondsPerItem;
  },
  [SET_TIME_FOR_LAST_COLORIZATION](state, timeInSec) {
    state.lastColorizationTime = timeInSec;
  },
  [SET_FILE_IMPORT_CANCELED_BY_USER](state, wasCanceled = true) {
    state.fileImportCanceledByUser = wasCanceled;
  },
  [SET_LAYER_TYPE_OF_FILES_TO_IMPORT](state, layerType) {
    state.fileImportLayerType = layerType;
  },
  [SET_COLORIZATION_IN_PROGRESS](state, b) {
    state.colorizationInProgress = b;
  },
  [SET_UPDATE_COLORS_IN_PROGRESS](state, b) {
    state.updateColorsInProgress = b;
  },
  [SET_COLORIZATION_CANCELED_BY_USER](state, b) {
    state.colorizationCanceledByUser = b;
  },
  [SET_UPDATE_COLORS_CANCELED_BY_USER](state, b) {
    state.updateColorsCanceledByUser = b;
  },
  [SET_ANALYZE_CANCELED_BY_USER](state, b) {
    state.analyzeCanceledByUser = b;
  },
  [SET_EXPORT_IN_PROGRESS](state, b) {
    state.exportInProgress = b;
  },
  [SET_EXPORT_CANCELED_BY_USER](state, b) {
    state.exportCanceledByUser = b;
  },
  [SET_EXPORTING_COLORS_SEPARATELY](state, b) {
    state.exportingColorsSeparately = b;
    // console.log('color separately? ', state.exportingColorsSeparately);
  },
  /**
   * @param {string} task - Pass a task listed under general-types as TASK_...
   * @see {general-types.js}
   * @todo optimally task was not a string, but would use some kind of enum,
   *   as there is only a limited set of allowed values. This would need to be changed in
   *   all functions using currentProcessingTask (either directly or using a getter / mutation).
   */
  [SET_CURRENT_PROCESSING_TASK](state, task) {
    state.currentProcessingTask = task;
  },

  [ENABLE_FAKE_COLORIZATION](state, { enabled = true, delayInMs = 4000 }) {
    console.log(`Fake colorization set to: ${enabled}, delay in ms: ${delayInMs}`);
    state.useFakeColorization = enabled;
    state.fakeColorizationTimeInMs = delayInMs;
  },

  [SET_LAST_IMPORTED_IMAGE_HAS_DIFFERENT_DIMS_THAN_CANVAS](state, b) {
    state.lastImportedImageHasDifferentDimensionsThanCanvas = b;
  },

  [SET_CANVAS_SIZE](state, { width, height }) {
    state.canvasWidth = width;
    state.canvasHeight = height;
  },

  [SET_AVAILABLE_SPACE_FOR_CANVAS](state, { width, height }) {
    state.canvasWrapperWidth = width;
    state.canvasWrapperHeight = height;
  },

  [SET_CANVAS_SCALE](state, scale) {
    state.canvasScale = scale;
  },

  [SET_BACKGROUND_COLOR](state, color) {
    state.canvasBackgroundColor = color;
  },

  [SET_CANVAS_TOOL_ACTIVE](state, b) {
    state.canvasToolActive = b;
  },

  [SET_TIMELINE_SCROLL_VALUE_X](state, scrollValue) {
    state.timelineScrollValueX = scrollValue;
  },

  [ADD_COLOR_TO_PALETTE](state, colorValueObject) {
    state.colorPalette.push(colorValueObject);
  },

  [CLEAR_COLOR_PALETTE](state) {
    state.colorPalette = [];
  },

  [SET_PALETTE_EVENT_OCCURRED](state, b) {
    state.paletteEventOccurred = b;
  },

  [SET_CANVAS_REDRAW_TRIGGER](state) {
    state.canvasRedrawTrigger = Math.random();
  },

  [DELETE_COLOR_FROM_PALETTE](state, index) {
    state.colorPalette.splice(index, 1);
  },

  [TOGGLE_SWATCH_VISIBILITY](state, index) {
    const { colorPalette } = state;
    const isVisible = colorPalette[index].visible;
    state.colorPalette[index].newVisible = !isVisible;
    // console.log(index, state.colorPalette[index].newVisible);
    // Vue.set(state.colorPalette, index, !isVisible);
  },

  [SET_COLOR_COLLAPSE](state, collapseState) {
    state.colorCollapse = collapseState;
  },

  [SET_FILL_COLLAPSE](state, collapseState) {
    state.fillCollapse = collapseState;
  },

  [SET_PEN_COLLAPSE](state, collapseState) {
    state.penCollapse = collapseState;
  },
  [SET_ERASER_COLLAPSE](state, collapseState) {
    state.eraserCollapse = collapseState;
  },
  [SET_REFERENCE_COLLAPSE](state, collapseState) {
    state.referenceCollapse = collapseState;
  },
  [SET_SEG_OPTIONS_COLLAPSE](state, collapseState) {
    state.segOptionsCollapse = collapseState;
  },
  [SET_SEG_PANEL_HIGHLIGHT](state, value) {
    state.segPanelHighlight = value;
  },
  [SET_ACTIVE_LAYER_ID](state, activeLayerId) {
    state.activeLayerId = activeLayerId;
  },

  [SET_UPDATE_IN_PROGRESS](state, inProgress) {
    state.updateInProgress = inProgress;
  },

  [SET_UPDATE_PERCENTAGE](state, updatePercentage) {
    state.updatePercentage = updatePercentage;
  },

  [SET_TEMP_FILE_PATHS](state, filePaths) {
    state.tempFilePaths = filePaths;
  },

  [SET_CURRENT_FILE](state, filename) {
    state.currentFile = filename;
  },

  [SET_UNSAVED_CHANGES](state, value) {
    state.unsavedChanges = value;
  },

  [SET_NEW_PROJECT](state) {
    Object.assign(state, defaultState());
  },

  [ADD_FILE_TO_REFERENCE_FILES](state, referenceFileObj) {
    state.referenceImages.push(referenceFileObj);
  },

  [DELETE_FILE_FROM_REFERENCE_FILES](state, index) {
    state.referenceImages.splice(index, 1);
  },

  [SET_SELECTED_REFERENCE_FILE](state, index) {
    for (let a = 0; a < state.referenceImages.length; ++a){
      if (a === index) {
        state.referenceImages[a].selected = true;
      }
      else{
        state.referenceImages[a].selected = false;
      }
    }
  },

  [SET_REF_CANVAS_SIZE](state, { width, height }) {
    state.refCanvasWidth = width;
    state.refCanvasHeight = height;
  },
  [SET_REF_WIN_HEIGHT](state, value) {
    state.refWinHeight = value;
  },
  [SET_REF_WIN_WIDTH](state, value) {
    state.refWinWidth = value;
  },
  [SET_REF_CAN_POS](state, { top, left }) {
    state.refCanPos.top = top;
    state.refCanPos.left = left;
  },
  [SET_REF_CAN_SCALE](state, value) {
    state.refCanScale = value;
  },
  [SET_RAINBOW_MODE] (state, mode) {
    state.rainbowMode = mode;
  },
  [SET_PROJECT_ID] (state) {
    const newProjectId = (Math.floor((Math.random() * (99999999 - 10000000)) + 10000000));
    state.projectId = newProjectId;
  },
  [TOGGLE_AUTO_ALPHA](state) {
    const autoAlpha = state.autoAlpha;
    if (!autoAlpha) {
      state.autoAlpha = true;
    } else {
      state.autoAlpha = false;
    }
  },
  // Undo/redo: apply an inverse patch to the (root) state in place. Module
  // slices such as ImageStore are reached through `state.ImageStore` because a
  // root mutation receives the full root state. See services/state-patch.js.
  [APPLY_STATE_PATCH](state, patch) {
    applyPatch(state, patch);
  },
  [SET_SERVER_BACKEND](state, backend) {
    state.serverBackend = backend;
  },
};
