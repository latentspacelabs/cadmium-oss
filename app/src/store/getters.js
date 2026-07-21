/* eslint-disable linebreak-style */
/* eslint-disable */
import { logError } from '@/util/error-util';

import {
  COLOR_IMAGE_FOR_SELECTED_FRAME,
  FRAME_COUNT,
  FRAMES_BY_LAYER_ID,
  FRAME_IS_SELECTED,
  FRAME_IS_ORIGINAL,
  // FRAME_IS_PLACEHOLDER,
  LAYER_HAS_FRAMES,
  LAYER_TYPE,
  LINKED_LAYER_ID,
  LINE_HASH_FOR_SELECTED_FRAME,
  LINE_IMAGE_FOR_SELECTED_FRAME,
  IMAGE_DATA_OF_FRAME,
  IMAGE_DATA_OBJECT_OF_FRAME,
  SELECTED_FRAME_NR,
  SELECTED_FRAMES_ON_LAYER,
  LAYER_BY_ID,
  TIMELINE_HAS_FRAMES,
  TIMELINE_HAS_FRAMES_WITH_IMAGE_DATA,
  PLAYER_IS_PLAYING,
  PLAYER_FPS,
  FRAME_NRS_IN_LAYER,
  REFERENCE_FRAME_NRS_FOR_LAYER_WITH_ID,
  REFERENCE_FRAMES_IN_USE_FOR_SELECTION,
  LAYER_IS_VISIBLE,
  LAYER_IS_DRAWABLE,
  FILE_DRAG_N_DROP_IN_PROGRESS,
  LAST_IMAGE_IS_TOO_BIG,
  NUMBER_OF_IMAGES_TO_LOAD,
  NUMBER_OF_IMAGES_LOADED_IN_LAST_IMPORT,
  FRAME_BY_FRAME_NR,
  SELECTED_FRAME_NRS_ON_ALL_LAYERS,
  LAYER_ID_OF_LAST_CLICKED_FRAME,
  LAST_SEGMENTATION_MAP_GENERATION_TIME,
  FILE_IMPORT_CANCELED_BY_USER,
  LAYER_TYPE_OF_FILES_TO_IMPORT,
  COLORIZATION_IN_PROGRESS,
  UPDATE_COLORS_IN_PROGRESS,
  EXPORT_IN_PROGRESS,
  ANALYZE_MODE_ONLY,
  AI_GAP_CLOSER_ENABLED,
  MAX_AI_DILATION_SIZE,
  MAX_TB_DILATION_SIZE,
  MIN_SEG_SIZE,
  LINE_THRESHOLD,
  MAX_ITER,
  COLORIZATION_CANCELED_BY_USER,
  UPDATE_COLORS_CANCELED_BY_USER,
  EXPORT_CANCELED_BY_USER,
  EXPORTING_COLORS_SEPARATELY,
  ESTIMATED_COLORIZATION_AND_SEGMENTATION_TIME_IN_SEC,
  ESTIMATED_EXPORT_TIME_IN_SEC,
  COLORIZATION_PROGRESS,
  UPDATED_COLORS_PROGRESS,
  EXPORT_PROGRESS,
  // NUMBER_OF_IMAGES_EXPORTING,
  CURRENT_PROCESSING_TASK,
  COLOR_IMAGE_ID_FOR_SELECTED_FRAME,
  LINE_IMAGE_ID_FOR_SELECTED_FRAME,
  IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS,
  FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID,
  // FRAME_ID_OF_FIRST_FRAME_IN_BLOCK,
  FRAMES_HAVE_SAME_IMAGE_DATA_ID,
  IMAGE_HAS_SEGMENTATION_MAP,
  CANVAS_SIZE,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  LAST_IMAGE_DIFFERENT_TO_CANVAS_SIZE,
  AVAILABLE_SPACE_FOR_CANVAS,
  CANVAS_SCALE,
  CANVAS_TOOL_ACTIVE,
  BACKGROUND_COLOR,
  TIMELINE_SCROLL_VALUE_X,
  TIMELINE_VISIBILITY,
  COLOR_PALETTE,
  COLOR_COLLAPSE,
  FILL_COLLAPSE,
  PEN_COLLAPSE,
  ERASER_COLLAPSE,
  ACTIVE_LAYER_ID,
  UPDATE_IN_PROGRESS,
  UPDATE_PERCENTAGE,
  SAVE_STATE,
  CURRENT_FILE,
  UNSAVED_CHANGES,
  PALETTE_EVENT_OCCURRED,
  CANVAS_REDRAW_TRIGGER,
  COLOR_PREVIEW_MODE,
  EST_TIME_REMAINING,
  ANALYZE_CANCELED_BY_USER,
  REFERENCE_COLLAPSE,
  REFERENCE_IMAGES,
  REF_CANVAS_SIZE,
  REF_WIN_HEIGHT,
  REF_WIN_WIDTH,
  REF_CAN_POS,
  REF_CAN_SCALE,
  SEG_OPTIONS_COLLAPSE,
  SEG_PANEL_HIGHLIGHT,
  RAINBOW_MODE,
  PROJECT_ID,
  IS_IMAGEDATAID_UNIQUE,
  IS_AUTO_ALPHA,
  SERVER_BACKEND,
} from '@/store/getter-types';

import {
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
  // INVALID_FRAME_NR,
} from '@/store/general-types';

import { framesShareDrawing } from '@/services/xsheet';

export default {
  /**
   * @returns {Object|null} the layer with ID `layerId` or null if it does not exist.
   */
  /* eslint-disable no-prototype-builtins */
  [LAYER_BY_ID]: state => (layerId) => {
    if (!layerId) { return null; }
    if (!state.layers.hasOwnProperty(layerId)) { return null; }
    return state.layers[layerId];
  },
  /*
   * Number of frames the timeline can currenlty hold (maximum)
   */
  [FRAME_COUNT]: state => state.timelineFrames,
  /**
   * @returns {boolean} - true if layer has at least one frame
   */

  /**
   * Returns true if at least one frame has image data
   */
  [LAYER_HAS_FRAMES]: state => (layerId) => {
    const layer = state.layers[layerId]; // TODO: Is this save? Index might be out of bounds.
    if (!layer) { return false; }
    return layer.frames.length > 0 && layer.frames.some(f => f && f.imageDataId);
  },

  [LAYER_TYPE]: state => (layerId) => {
    const layer = state.layers[layerId];
    if (!layer) { return null; }
    return layer.type;
  },

  [LINKED_LAYER_ID]: state => (layerId) => {
    const layer = state.layers[layerId];
    if (!layer) { return null; }
    return layer.linkedLayerId;
  },

  [FRAMES_BY_LAYER_ID]: state => (layerId) => {
    const layer = state.layers[layerId]; // TODO: Is this save? Index might be out of bounds.
    if (!layer) {
      console.error('Layer ID does not exist');
      return [];
    }
    return layer.frames;
  },

  [FRAME_IS_SELECTED]: state => ({ layerId, frameNr }) => {
    const layer = state.layers[layerId];
    if (!layer) { return false; }
    if (!layer.frames || !layer.frames[frameNr]) {
      console.error(`Layer has no frames, or no frame at position: ${frameNr}`);
      return false;
    }
    return layer.frames[frameNr].isSelected;
  },

  [FRAME_IS_ORIGINAL]: state => ({ layerId, frameNr }) => {
    const layer = state.layers[layerId];
    if (!layer) { return false; }
    if (!layer.frames || !layer.frames[frameNr]) {
      console.log(`Layer has no frames, or no frame at position: ${frameNr}`);
      return false;
    }
    return layer.frames[frameNr].isOriginal;
  },
  /*
  [FRAME_IS_PLACEHOLDER]: state => ({ layerId, frameNr }) => {
    const layer = state.layers[layerId];
    if (!layer) {
      console.log('no layer ', layer);
      return false;
    }
    if (!layer.frames || !layer.frames[frameNr]) {
      console.error(`Layer has no frames, or no frame at position: ${frameNr}`);
      return false;
    }
    return layer.frames[frameNr].isPlaceholder;
  },
  */
  [SELECTED_FRAME_NR]: state => state.selectedFrame,

  /**
   * @returns {Array} - Selected frames of the initial color layer,
   *   so this currently ignores a selection on the line layer.
   * @TODO This needs to get a parameter for layerId.
   *   All calls must be changed accordingly
   */
  // [SELECTED_FRAMES]: (state) => {
  //   const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
  //   if (!colorLayer || !colorLayer.frames) { return []; }
  //   return colorLayer.frames.filter(f => f && f.isSelected);
  // },

  /**
   * @returns {Array} - An array including all selected frames on the layer
   */
  [SELECTED_FRAMES_ON_LAYER]: (state, getters) => (layerId) => {
    const layer = getters[LAYER_BY_ID](layerId);
    if (!layer || !layer.frames) { return []; }
    return layer.frames.filter(f => f && f.isSelected);
  },

  [LINE_HASH_FOR_SELECTED_FRAME](state) {
    const lineLayer = state.layers[INITIAL_LINE_LAYER_ID];
    if (!lineLayer) { console.error('Initial line layer not found'); return null; }
    if (
      lineLayer.frames[state.selectedFrame]
      && lineLayer.frames[state.selectedFrame].imageDataId
    ) {
      const { imageDataId } = lineLayer.frames[state.selectedFrame];
      //console.log('line data uri: ', state.ImageStore.imageDataById[imageDataId].dataUri);
      return state.ImageStore.imageDataById[imageDataId].hash;
      // return lineLayer.frames[state.selectedFrame].imageData;
    }
    return null;
  },

  [LINE_IMAGE_FOR_SELECTED_FRAME](state) {
    const lineLayer = state.layers[INITIAL_LINE_LAYER_ID];
    if (!lineLayer) { console.error('Initial line layer not found'); return null; }
    if (
      lineLayer.frames[state.selectedFrame]
      && lineLayer.frames[state.selectedFrame].imageDataId
    ) {
      const { imageDataId } = lineLayer.frames[state.selectedFrame];
      //console.log('line data uri: ', state.ImageStore.imageDataById[imageDataId].dataUri);
      return state.ImageStore.imageDataById[imageDataId].dataUri;
      // return lineLayer.frames[state.selectedFrame].imageData;
    }
    
    // If line frame is deleted/ghost, fallback to color frame for display
    const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
    if (colorLayer && colorLayer.frames[state.selectedFrame] 
        && colorLayer.frames[state.selectedFrame].imageDataId) {
      const { imageDataId } = colorLayer.frames[state.selectedFrame];
      return state.ImageStore.imageDataById[imageDataId].dataUri;
    }
    
    return null;
  },

  [COLOR_IMAGE_FOR_SELECTED_FRAME](state) {
    const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
    if (!colorLayer) { console.error('Initial color layer not found'); return null; }
    if (
      colorLayer.frames[state.selectedFrame]
      && colorLayer.frames[state.selectedFrame].imageDataId
    ) {
      const { imageDataId } = colorLayer.frames[state.selectedFrame];
      return state.ImageStore.imageDataById[imageDataId].dataUri;
      // return colorLayer.frames[state.selectedFrame].imageData;
    }

    // No line-frame fallback: returning the LINE image here would hand the
    // paint/fill flows the line art as their base (and its id as their write
    // target — see COLOR_IMAGE_ID_FOR_SELECTED_FRAME). Callers already handle
    // null with a blank canvas (reDrawCanvas, floodFill).
    return null;
  },

  [COLOR_IMAGE_ID_FOR_SELECTED_FRAME](state) {
    const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
    if (!colorLayer) { console.error('Initial color layer not found'); return null; }
    if (
      colorLayer.frames[state.selectedFrame]
      && colorLayer.frames[state.selectedFrame].imageDataId
    ) {
      const { imageDataId } = colorLayer.frames[state.selectedFrame];
      return imageDataId;
    }

    // No line-frame fallback: this id is the WRITE TARGET for paint/fill
    // (MainPane replaceImageDataUri) — falling back to the line frame's id
    // would make painting on an id-less color frame overwrite the line art.
    // Callers handle null by storing a fresh image (their !imageId branches).
    return null;
  },

  [LINE_IMAGE_ID_FOR_SELECTED_FRAME](state) {
    const layer = state.layers[INITIAL_LINE_LAYER_ID];
    if (!layer) { console.error('Initial line layer not found'); return null; }
    if (
      layer.frames[state.selectedFrame]
      && layer.frames[state.selectedFrame].imageDataId
    ) {
      const { imageDataId } = layer.frames[state.selectedFrame];
      return imageDataId;
    }
    
    // If line frame is deleted/ghost, fallback to color frame for display
    const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
    if (colorLayer && colorLayer.frames[state.selectedFrame] 
        && colorLayer.frames[state.selectedFrame].imageDataId) {
      return colorLayer.frames[state.selectedFrame].imageDataId;
    }
    
    return null;
  },

  [FRAME_BY_FRAME_NR]: state => ({ layerId, frameNr }) => {
    if (!layerId || typeof frameNr === 'undefined') {
      logError(new Error(`Could not return frame. layerId: ${layerId}, frameNr: ${frameNr}`));
      return null;
    }
    const layer = state.layers[layerId];
    if (!layer) {
      logError(new Error(`Could not return frame. Layer is null. layerId: ${layerId}, frameNr: ${frameNr}`));
      return null;
    }
    return layer.frames[frameNr];
  },

  /**
   * @param {Object} options
   * @param {string} options.layerId
   * @param {number} options.frameNr
   * @returns {string} - Image data as data URI (base 64 encoded string with decoration)
   */
  [IMAGE_DATA_OF_FRAME]: state => ({ layerId, frameNr }) => {
    if (!layerId || typeof frameNr === 'undefined') {
      logError(new Error(`Could not return image data for frame. layerId: ${layerId}, frameNr: ${frameNr}`));
      return null;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer not found'); return null; }
    const frame = layer.frames[frameNr];
    if (!frame || !frame.imageDataId) { return null; }
    return state.ImageStore.imageDataById[frame.imageDataId].dataUri;
    // return frame.imageData;
  },

  /**
   * @param {Object} options
   * @param {string} options.layerId
   * @param {number} options.frameNr
   * @returns {string} - Image data object
   */
  [IMAGE_DATA_OBJECT_OF_FRAME]: state => ({ layerId, frameNr }) => {
    if (!layerId || typeof frameNr === 'undefined') {
      logError(new Error(`Could not return image data for frame. layerId: ${layerId}, frameNr: ${frameNr}`));
      return null;
    }
    const layer = state.layers[layerId];
    if (!layer) { console.error('Layer not found'); return null; }
    const frame = layer.frames[frameNr];
    if (!frame || !frame.imageDataId) { return null; }
    return state.ImageStore.imageDataById[frame.imageDataId];
  },

  /* eslint-disable arrow-body-style */
  [TIMELINE_HAS_FRAMES]: (state) => {
    return Object.values(state.layers).some(layer => layer.frames && layer.frames.length > 0);
  },

  /**
   * Checks if there is at least one frame on any layer with an associated image,
   * i.e. is linked to an image data URI.
   */
TIMELINE_HAS_FRAMES_WITH_IMAGE_DATA: (state) => {
  // example safe implementation — guard frame existence before accessing imageDataId
  const lineLayer = state.layers[INITIAL_LINE_LAYER_ID];
  const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
  const first = state.firstRealFrameNumber;
  const last = state.lastRealFrameNumber;
  if (!lineLayer || !Array.isArray(lineLayer.frames) || !colorLayer || !Array.isArray(colorLayer.frames)) return false;
  for (let i = first; i <= last; i += 1) {
    const lf = lineLayer.frames[i];
    const cf = colorLayer.frames[i];
    if ((lf && lf.imageDataId) || (cf && cf.imageDataId)) return true;
  }
  return false;
},

  [PLAYER_IS_PLAYING]: state => state.playerIsPlaying,

  [PLAYER_FPS]: state => state.playerFps,

  // [LEFT_MOST_LINKED_LINE_FRAME_NR]: state => ({ layerId, frameNr }) => {
  //   const layer = state.layers[layerId];
  //   if (!layer) { return false; }
  //   if (!layer.frames || !layer.frames[frameNr]) {
  //     console.error(`Layer has no frames, or no frame at position: ${frameNr}`);
  //     return false;
  //   }
  //   return layer.frames[frameNr].isSelected;
  // },

  [FRAME_NRS_IN_LAYER]: state => (layerId) => {
    const layer = state.layers[layerId];
    if (!layer) { return []; }
    if (!layer.frames) {
      console.error(`Layer with ID ${layerId} has no frames.`);
      return [];
    }
    return Object.values(layer.frames)
      .filter(frame => frame)
      .map(frame => frame.frameNr); // not checked
  },

  /**
   * @param {string} layerId - The layer containing the frames, most likely a color layer
   * @returns {Array} - Array of frame nrs, original frames on this layer,
   *   basically a filter of the frames filtering out non existend frames
   *   and non original frames.
   */
  [REFERENCE_FRAME_NRS_FOR_LAYER_WITH_ID]: state => (layerId) => {
    const layer = state.layers[layerId];
    if (!layer) { return []; }
    if (!layer.frames) {
      console.error(`Layer with ID ${layerId} has no frames.`);
      return [];
    }
    return Object.values(layer.frames)
      .filter(frame => frame && frame.isOriginal)
      .map(frame => frame.frameNr); // not checked
  },

  /**
   * Right now this just returns one reference frame (nr) in an array,
   * later on this might be two (or more).
   * The strategy for finding the (single) reference frame is:
   *   - Use direct match (color frame with same frame nr as line frame)
   *   - Use closest reference frame to the left
   *   - Use closest reference frame to the right
   * @returns {Array} - Array containing the frame numbers to be used for
   * colorization for the selected frame.
   */
  // [SURROUNDING_REFERENCE_FRAME_NRS_FOR_LINE_FRAME]: state => ({ layerId, frameNr }) => {
  //   const layer = state.layers[layerId];
  //   if (!layer) { return []; }
  //   if (!layer.frames || !layer.frames[frameNr]) {
  //     console.error(`Layer has no frames, or no frame at position: ${frameNr}`);
  //     return [];
  //   }
  //   const linkedLayer = state.layers[layer.linkedLayerId];
  //   if (!linkedLayer) { return []; }
  //   const frameNrsInLayer = Object.values().map(frame => frame.frameNr);
  //   // Direct match. A color frame is available for the line frame with the same frame nr.
  //   if (frameNrsInLayer.some(colorFrameNr => colorFrameNr === frameNr)) {
  //     return [frameNr];
  //   }
  //   const leftMostReducer = (leftMostFrameNr, colorFrameNr) => {
  //     if (colorFrameNr !== INVALID_FRAME_NR) {
  //       if (
  //         colorFrameNr < leftMostFrameNr
  //         || leftMostFrameNr === INVALID_FRAME_NR
  //       ) {
  //         return colorFrameNr;
  //       }
  //     }
  //     return leftMostFrameNr;
  //   };
  //   const leftMostFrameNr = frameNrsInLayer.reduce(leftMostReducer, INVALID_FRAME_NR);
  //   if (leftMostFrameNr !== INVALID_FRAME_NR) {
  //     return [frameNr];
  //   }
  //   const rightMostReducer = (rightMostFrameNr, colorFrameNr) => {
  //     if (colorFrameNr !== INVALID_FRAME_NR) {
  //       if (
  //         colorFrameNr < rightMostFrameNr
  //         || rightMostFrameNr === INVALID_FRAME_NR
  //       ) {
  //         return colorFrameNr;
  //       }
  //     }
  //     return rightMostFrameNr;
  //   };
  //   const rightMostFrameNr = frameNrsInLayer.reduce(rightMostReducer, INVALID_FRAME_NR);
  //   if (rightMostFrameNr !== INVALID_FRAME_NR) {
  //     return [frameNr];
  //   }
  //   return [];
  // },

  [REFERENCE_FRAMES_IN_USE_FOR_SELECTION]: state => (layerId) => {
    const layer = state.layers[layerId];
    if (!layer) { console.log(`Could not find a layer with ID ${layerId}`); return []; }
    const { frames } = layer;
    if (!frames) { console.log('Layer has no frames'); }
    const refFrames = [];
    frames.forEach((frame) => {
      if (frame && frame.isSelected) {
        refFrames.push(frame.refFrameLeftNr, frame.refFrameRightNr);
      }
    });
    return [...new Set(refFrames)]; // make unique
  },

  [LAYER_IS_VISIBLE]: state => (layerId) => {
    // console.log('layers: ', state.layers);
    const layer = state.layers[layerId];
    if (!layer) { console.log(`Could not find a layer with ID ${layerId}`); return false; }
    return layer.visible;
  },

  [LAYER_IS_DRAWABLE]: (state) => (layerId) => {
    const layer = state.layers[layerId];
    if (!layer) { console.log(`Could not find a layer with ID ${layerId}`); return false; }
    return !!layer.visible;
  },

  [FILE_DRAG_N_DROP_IN_PROGRESS]: state => state.fileDragNDropInProgress,
  [LAST_IMAGE_IS_TOO_BIG]: state => state.lastImportedImageTooBig,
  /* eslint-disable max-len */
  [LAST_IMAGE_DIFFERENT_TO_CANVAS_SIZE]: state => state.lastImportedImageHasDifferentDimensionsThanCanvas,
  [NUMBER_OF_IMAGES_TO_LOAD]: state => state.numberOfImagesToLoad,
  [NUMBER_OF_IMAGES_LOADED_IN_LAST_IMPORT]: state => state.numberOfImagesLoadedInLastImport,
  /**
   * @returns {Array} - An array containing frame numbers of selected frames,
   *   regardless on which layer they are on.
   */
  [SELECTED_FRAME_NRS_ON_ALL_LAYERS]: (state) => {
    const { layers } = state;
    const selectedFrameNrs = [];
    Object.keys(layers).forEach((layerId) => {
      layers[layerId].frames.forEach((frame) => {
        if (frame && frame.isSelected) {
          selectedFrameNrs.push(frame.frameNr);
        }
      });
    });
    // Sort function helper. The deafult sort function converts everything to strings,
    // so it is not very performant.
    const sortNumber = (a, b) => a - b;
    const selectedFrameNrsUnique = [...new Set(selectedFrameNrs)].sort(sortNumber);
    return selectedFrameNrsUnique;
  },

  [LAYER_ID_OF_LAST_CLICKED_FRAME]: state => state.lastSelectedLayerId,
  [LAST_SEGMENTATION_MAP_GENERATION_TIME]: state => state.lastSegmentationMapGenerationTime,
  [FILE_IMPORT_CANCELED_BY_USER]: state => state.fileImportCanceledByUser,
  [LAYER_TYPE_OF_FILES_TO_IMPORT]: state => state.fileImportLayerType,
  [COLORIZATION_IN_PROGRESS]: state => state.colorizationInProgress,
  [UPDATE_COLORS_IN_PROGRESS]: state => state.updateColorsInProgress,
  [EXPORT_IN_PROGRESS]: state => state.exportInProgress,
  [EXPORTING_COLORS_SEPARATELY]: state => state.exportingColorsSeparately,
  [ANALYZE_MODE_ONLY]: state => state.analyzeModeOnly,
  [AI_GAP_CLOSER_ENABLED]: state => state.aiGapCloserEnabled,
  [MAX_AI_DILATION_SIZE]: state => state.maxAiDilationSize,
  [MAX_TB_DILATION_SIZE]: state => state.maxTbDilationSize,
  [MIN_SEG_SIZE]: state => state.minSegSize,
  [LINE_THRESHOLD]: state => state.lineThreshold,
  [MAX_ITER]: state => state.maxIter,
  [COLORIZATION_CANCELED_BY_USER]: state => state.colorizationCanceledByUser,
  [UPDATE_COLORS_CANCELED_BY_USER]: state => state.updateColorsCanceledByUser,
  [ANALYZE_CANCELED_BY_USER]: state => state.analyzeCanceledByUser,
  [EXPORT_CANCELED_BY_USER]: state => state.exportCanceledByUser,
  [ESTIMATED_EXPORT_TIME_IN_SEC]: (state) => {
    // const numberOfImagesExporting = getters[NUMBER_OF_IMAGES_EXPORTING];
    const numTotalExports = state.numberOfImagesToExport;
    const numFinishedExports = state.numberOfImagesExported;
    const exportTime = (numTotalExports - numFinishedExports) * state.lastExportTime;
    return exportTime;
  },

  [ESTIMATED_COLORIZATION_AND_SEGMENTATION_TIME_IN_SEC]: (state, getters) => {
    const selectedFrameNumbers = getters[SELECTED_FRAME_NRS_ON_ALL_LAYERS];
    if (!selectedFrameNumbers || selectedFrameNumbers.length === 0) { return 0; }

    const frameExists = frame => frame;
    const frameIsOriginal = frame => frame.isOriginal;
    const frameIsNotOriginal = frame => !frame || (frame && !frame.isOriginal);
    const frameIsSelected = frame => frame.isSelected;

    const lineFrames = getters[FRAMES_BY_LAYER_ID](INITIAL_LINE_LAYER_ID);
    const colorFrames = getters[FRAMES_BY_LAYER_ID](INITIAL_COLOR_LAYER_ID);

    const selectedColorFrames = colorFrames
      .filter(frameExists)
      .filter(frameIsSelected);

    // const selectedRefColorFrames = selectedColorFrames
    //   .filter(frameIsOriginal);

    const selectedNonRefColorFrames = selectedColorFrames
      .filter(frameIsNotOriginal);

    // we now need to filter out duplicate color frames
    /* eslint no-param-reassign: "error" */
    const selectedNonRefColorFramesUniq = selectedNonRefColorFrames.filter((f, i, self) => {
      if (!self.arr) { self.arr = []; }
      if (!f) { return false; } // hmm, there should always be a frame.
      if (self.arr.includes(f.imageDataId)) { return false; }
      self.arr.push(f.imageDataId);
      return true;
    });
    const numFramesToColorize = selectedNonRefColorFramesUniq.length;

    const lineFrameIsSelectedLineFrame = (frame) => {
      return frameExists(frame)
        && frameExists(colorFrames[frame.frameNr])
        && frameIsSelected(colorFrames[frame.frameNr]);
    };

    const lineFrameIsRefLineFrame = (frame) => {
      return frameExists(frame)
        && frameExists(colorFrames[frame.frameNr])
        && frameIsOriginal(colorFrames[frame.frameNr]);
    };

    const lineFrameIsNotRefLineFrame = (frame) => {
      return !lineFrameIsRefLineFrame(frame);
    };

    const imageDataIdsWoSegMap = lineFrames
      .filter(lineFrameIsSelectedLineFrame)
      .filter(lineFrameIsNotRefLineFrame)
      // filter image IDs based on if they have a segmap
      .map((f) => {
        if (getters[IMAGE_HAS_SEGMENTATION_MAP](f.imageDataId)) {
          return false;
        }
        return f.imageDataId;
      })
      .filter(iId => iId); // get rid of false entries

    const numSegMapsToGenerate = Array.from(new Set(imageDataIdsWoSegMap)).length;
    /*
    console.log('------------------------------------------------');
    console.log('segmaps to generate: ', numSegMapsToGenerate);
    console.log('frames to colorize: ', numFramesToColorize);
    console.log('colorization time: ', state.lastColorizationTime);
    console.log('segmentation time: ', state.lastSegmentationMapGenerationTime);
    console.log('------------------------------------------------');
    */
    const colTime = numFramesToColorize * state.lastColorizationTime;
    const segTime = numSegMapsToGenerate * state.lastSegmentationMapGenerationTime;

    return colTime + segTime;
  },
  [COLORIZATION_PROGRESS]: (state) => {
    return {
      numTotal: state.numberOfImagesToColorize,
      numFinished: state.numberOfImagesColorized,
      timeRemaining: state.estTimeRemaining,
    };
  },
  [UPDATED_COLORS_PROGRESS]: (state) => {
    return {
      numTotal: state.updatedColorsProgress.numTotal,
      numFinished: state.updatedColorsProgress.numFinished,
      timeRemaining: state.estTimeRemaining,
    };
  },
  [EXPORT_PROGRESS]: (state) => {
    return {
      numTotal: state.numberOfImagesToExport,
      numFinished: state.numberOfImagesExported,
    };
  },

  /*
  [NUMBER_OF_IMAGES_EXPORTING]: (state) => {
    return {
      numberOfImagesExporting: state.numberOfImagesToExport
    },
  },
  */

  /**
   * @returns {string} - The current processing task
   * @see {general-types.js}
   */
  [CURRENT_PROCESSING_TASK]: state => state.currentProcessingTask,
  [EST_TIME_REMAINING]: state => state.estTimeRemaining,

  [IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS]: (state) => {
    const imageDataIds = [];
    const layerIds = Object.keys(state.layers);
    layerIds.forEach((layerId) => {
      const layer = state.layers[layerId];
      const { frames } = layer;
      frames.forEach((frame) => {
        if (frame && frame.isSelected && frame.imageDataId) {
          imageDataIds.push(frame.imageDataId);
        }
      });
    });
    return imageDataIds;
  },

  [FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID]: state => ({ layerId, frameNr }) => {
    const layer = state.layers[layerId];
    if (!layer) { console.warn(`Could not find a layer with ID ${layerId}`); return []; }
    const { frames } = layer;
    if (!frames) { console.warn('Layer has no frames'); return []; }
    const frame = frames[frameNr];
    if (!frame) { return []; }

    // If this frame has no imageDataId (ghost frame), check the linked layer for duplicates
    if (!frame.imageDataId) {
      const linkedLayerId = layerId === 'lineLayer1' ? 'colorLayer1' : 'lineLayer1';
      const linkedLayer = state.layers[linkedLayerId];
      if (!linkedLayer || !linkedLayer.frames) { return []; }
      
      const linkedFrame = linkedLayer.frames[frameNr];
      if (!linkedFrame || !linkedFrame.imageDataId) { return []; }
      
      // Find all ghost frames whose linked frames have the same imageDataId
      const ghostFramesWithSameLinkedImage = frames
        .map((f, idx) => ({ frame: f, frameNr: idx }))
        .filter(({ frame, frameNr: fNr }) => {
          if (!frame || frame.imageDataId) { return false; } // Only consider ghost frames
          const linkedFrameForThis = linkedLayer.frames[fNr];
          return linkedFrameForThis && 
                 linkedFrameForThis.imageDataId && 
                 linkedFrameForThis.imageDataId === linkedFrame.imageDataId;
        })
        .map(({ frameNr: fNr }) => fNr);
        
      return ghostFramesWithSameLinkedImage;
    }

    // Original logic for frames with imageDataId
    const hasSameImageDataIdFilter = f => f && f.imageDataId && f.imageDataId === frame.imageDataId;
    const framesWithSameImageDataId = frames.filter(hasSameImageDataIdFilter);
    return framesWithSameImageDataId.map(f => f.frameNr);
  },
  // eslint-disable-next-line
  // currently this is just copied from the function above...
  // eslint-disable-next-line
  // trying to identify the first frame of each block. WIP
  // [FRAME_ID_OF_FIRST_FRAME_IN_BLOCK]: state => ({ layerId, frameNr }) => {
  //   const layer = state.layers[layerId];
  //   if (!layer) { console.warn(`Could not find a layer with ID ${layerId}`); return []; }
  //   const { frames } = layer;
  //   if (!frames) { console.warn('Layer has no frames'); return []; }
  //   const frame = frames[frameNr];
  //   if (!frame || !frame.imageDataId) { return []; }
  //   const hasSameImageDataIdFilter = f => f && f.imageDataId === frame.imageDataId;
  //   const framesWithSameImageDataId = frames.filter(hasSameImageDataIdFilter);
  //   return framesWithSameImageDataId.map(f => f.frameNr);
  // },

  /**
   * Checks if all specified frames have the same imageDataId.
   * @param {Object} state - vuex params
   * @param {Object} config
   * @param {Array} config.frameNrs - The frame numbers to check
   */
  [FRAMES_HAVE_SAME_IMAGE_DATA_ID]: state => ({ layerId, frameNrs }) => framesShareDrawing(state.layers, layerId, frameNrs),

  [CANVAS_SIZE]: (state) => {
    return {
      width: state.canvasWidth,
      height: state.canvasHeight,
    };
  },

  [AVAILABLE_SPACE_FOR_CANVAS]: (state) => {
    return {
      width: state.canvasWrapperWidth,
      height: state.canvasWrapperHeight,
    };
  },

  [CANVAS_SCALE]: state => state.canvasScale,
  [BACKGROUND_COLOR]: state => state.canvasBackgroundColor,
  [COLOR_PALETTE]: state => state.colorPalette,
  [PALETTE_EVENT_OCCURRED]: state => state.paletteEventOccurred,
  [CANVAS_REDRAW_TRIGGER]: state => state.canvasRedrawTrigger,
  [COLOR_COLLAPSE]: state => state.colorCollapse,
  [FILL_COLLAPSE]: state => state.fillCollapse,
  [PEN_COLLAPSE]: state => state.penCollapse,
  [ERASER_COLLAPSE]: state => state.eraserCollapse,
  [REFERENCE_COLLAPSE]: state => state.referenceCollapse,
  [SEG_OPTIONS_COLLAPSE]: state => state.segOptionsCollapse,
  [SEG_PANEL_HIGHLIGHT]: state => state.segPanelHighlight,
  [CANVAS_TOOL_ACTIVE]: state => state.canvasToolActive,
  [TIMELINE_VISIBILITY]: state => state.timelineVisibility,
  [TIMELINE_SCROLL_VALUE_X]: state => state.timelineScrollValueX,
  [ACTIVE_LAYER_ID]: state => state.activeLayerId,
  [UPDATE_IN_PROGRESS]: state => state.updateInProgress,
  [UPDATE_PERCENTAGE]: state => state.updatePercentage,
  [SAVE_STATE]: state => state,
  [CURRENT_FILE]: state => state.currentFile,
  [UNSAVED_CHANGES]: state => state.unsavedChanges,
  [COLOR_PREVIEW_MODE]: (state) => {
    let result = false;
    for (let i = 0; i < state.colorPalette.length; i += 1) {
      if (state.colorPalette[i].hex !== state.colorPalette[i].newHex
          || state.colorPalette[i].opacity !== state.colorPalette[i].newOpacity
          || state.colorPalette[i].visible !== state.colorPalette[i].newVisible) {
        result = true;
      }
    }
    // console.log('COLOR PREVIEW GETTER :', result);
    return result;
  },
  [REFERENCE_IMAGES]: state => state.referenceImages,
  [REF_CANVAS_SIZE]: (state) => {
    return {
      width: state.refCanvasWidth,
      height: state.refCanvasHeight,
    };
  },
  [REF_WIN_HEIGHT]: state => state.refWinHeight,
  [REF_WIN_WIDTH]: state => state.refWinWidth,
  [REF_CAN_POS]: state => state.refCanPos,
  [REF_CAN_SCALE]: state => state.refCanScale,
  [RAINBOW_MODE](state) {
    return state.rainbowMode;
  },
  [PROJECT_ID](state) {
    return state.projectId;
  },
  [IS_IMAGEDATAID_UNIQUE]: state => ( imageDataId ) => {
    // checking to see if there is more than one frame with the same imagedata id
    console.log(imageDataId);
    let counter = 0;
    // console.log('number of frames: ', Object.keys(state.layers.lineLayer1.frames).length);
    for (let i = 0; i < Object.keys(state.layers.lineLayer1.frames).length; i++) {
      if (state.layers.lineLayer1.frames[i]) {
        //console.log('current frame: ', state.layers.lineLayer1.frames[i].imageDataId);
        if (state.layers.lineLayer1.frames[i].imageDataId == imageDataId) {
          counter ++;
          console.log('counter: ', counter);
          if (counter > 1) {
            console.log('frame is duplicate');
            return false;
          }
        }
      }
    }
    console.log('frame is unique');
    return true;
  },
  [IS_AUTO_ALPHA](state) {
    return state.autoAlpha;
  },
  [SERVER_BACKEND](state) {
    return state.serverBackend;
  },
};
