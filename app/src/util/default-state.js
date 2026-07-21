import {
  EXPORT_DIALOG,
} from '@/store/action-types';

import {
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
  LAYER_TYPE_LINE,
  LAYER_TYPE_COLOR,
  INVALID_LAYER_ID,
  INVALID_FRAME_NR,
  TASK_NONE,
} from '@/store/general-types';

const NON_HARDWARE_SPECIFIC_ESTIMATED_COLORIZATION_TIME_IN_SEC = 10;
const NON_HARDWARE_SPECIFIC_ESTIMATED_SEGMENTATION_TIME_IN_SEC = 5;
// First-run guess only — runExport measures real throughput and overwrites
// this after the first exported item (SET_LAST_EXPORT_TIME).
const NON_HARDWARE_SPECIFIC_ESTIMATED_EXPORT_TIME_IN_SEC = 1;
// eslint-disable-next-line
export function defaultState() {
  // const localPrefs = getLocalPrefs();
  // console.log('Local Prefs: ', localPrefs);
  return {
    commands: [
      {
        title: 'Export',
        id: 'export_dialog',
        action: EXPORT_DIALOG,
      },
    ],
    selectedFrame: 1,
    firstRealFrameNumber: INVALID_FRAME_NR,
    lastRealFrameNumber: INVALID_FRAME_NR,
    lastSelectedFrameNr: INVALID_FRAME_NR,
    lastSelectedLayerId: INVALID_LAYER_ID,
    canvasWidth: 0,
    canvasHeight: 0,
    canvasWrapperWidth: 0,
    canvasWrapperHeight: 0,
    canvasScale: 1,
    canvasBackgroundColor: '#ffffff',
    canvasToolActive: false,
    fileDragNDropInProgress: false,
    playerIsPlaying: false,
    playerFps: 24,
    playerInterval: null,
    playerLoopEnabled: false,
    playerLoopIn: null,
    playerLoopOut: null,
    timelineZoomLevel: 1,
    timelineFrames: 1000,
    defaultFrameWidth: 16,
    defaultFrameHeight: 16,
    lastImportedImageTooBig: false,
    lastImportedImageHasDifferentDimensionsThanCanvas: false,
    fileImportCanceledByUser: false,
    fileImportLayerType: null,
    numberOfImagesToColorize: 0,
    numberOfImagesColorized: 0,
    numberOfImagesToExport: 0,
    numberOfImagesExported: 0,
    currentProcessingTask: TASK_NONE,
    useFakeColorization: false,
    fakeColorizationTimeInMs: 4000,
    colorizationInProgress: false,
    exportInProgress: false,
    analyzeModeOnly: true,
    aiGapCloserEnabled: true,
    aiDilationSize: 1,
    tbDilationSize: 1,
    colorizationCanceledByUser: false,
    exportCanceledByUser: false,
    lastColorizationTime: NON_HARDWARE_SPECIFIC_ESTIMATED_COLORIZATION_TIME_IN_SEC,
    lastSegmentationMapGenerationTime: NON_HARDWARE_SPECIFIC_ESTIMATED_SEGMENTATION_TIME_IN_SEC,
    lastExportTime: NON_HARDWARE_SPECIFIC_ESTIMATED_EXPORT_TIME_IN_SEC,
    layerGroups: [{
      id: '',
      lineLayerId: INITIAL_LINE_LAYER_ID,
      referenceLayerId: INITIAL_COLOR_LAYER_ID,
    }],
    layers: {
      [INITIAL_LINE_LAYER_ID]: {
        id: INITIAL_LINE_LAYER_ID,
        visible: true,
        frames: [],
        type: LAYER_TYPE_LINE,
        linkedLayerId: INITIAL_COLOR_LAYER_ID,
      },
      [INITIAL_COLOR_LAYER_ID]: {
        id: INITIAL_COLOR_LAYER_ID,
        visible: true,
        frames: [],
        type: LAYER_TYPE_COLOR,
        linkedLayerId: INITIAL_LINE_LAYER_ID,
      },
    },
    colorPalette: [],
    colorCollapse: ['color', 'palette'],
    fillCollapse: ['fill'],
    penCollapse: ['pen'],
    eraserCollapse: ['eraser'],
    referenceCollapse: ['reference', 'library'],
    tmpImageRootPath: '',
    timelineScrollValueX: 0,
    activeLayerId: null,
    updateInProgress: false,
    updatePercentage: 0,
    canvasUndo: [],
    canvasRedo: [],
    tempFilePaths: [],
    currentFile: null,
    unsavedChanges: false,
    ImageStore: {
      imageDataById: {
      },
    },
    referenceImages: [],
    refCanvasWidth: 0,
    refCanvasHeight: 0,
    refWinHeight: 200,
    refWinWidth: 200,
    refCanPos: {
      top: 0,
      left: 0,
    },
    refCanScale: 0.75,
    // eslint-disable-next-line
  }
}
