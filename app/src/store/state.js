/* eslint-disable linebreak-style */
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
  // INVALID_TIME,
  // TASK_SEGMENTATION_MAP_GENERATION,
  // TASK_COLORIZATION,
  TASK_NONE,
} from '@/store/general-types';

import { resolveServerBackend } from '@/util/server-config';

const NON_HARDWARE_SPECIFIC_ESTIMATED_COLORIZATION_TIME_IN_SEC = 10;
const NON_HARDWARE_SPECIFIC_ESTIMATED_SEGMENTATION_TIME_IN_SEC = 5;
// First-run guess only — runExport measures real throughput and overwrites
// this after the first exported item (SET_LAST_EXPORT_TIME).
const NON_HARDWARE_SPECIFIC_ESTIMATED_EXPORT_TIME_IN_SEC = 1;

export default {
  commands: [
    {
      title: 'Export',
      id: 'export_dialog',
      action: EXPORT_DIALOG,
    },
  ],
  // TODO: vvv rename!!!! This is not selection, but the playhead!!
  selectedFrame: 1, // which frame is currently selected in the timeline

  firstRealFrameNumber: INVALID_FRAME_NR, // the first number of an imported frame, e.g. 1
  lastRealFrameNumber: INVALID_FRAME_NR, // the last number of an imported frame, e.g. 32

  // For shift selecting frames we need to keep track of the previous selected frame
  lastSelectedFrameNr: INVALID_FRAME_NR,
  lastSelectedLayerId: INVALID_LAYER_ID,

  // canvas width / height is set automatically when the first frame is imported.
  canvasWidth: 0,
  canvasHeight: 0,

  // available space for the canvas / size of parent element of canvas
  // updated when app is resized / on load
  canvasWrapperWidth: 0,
  canvasWrapperHeight: 0,

  // optimum scale for the canvas to fit into the canvas wrapper
  // (so that nothing is cut)
  canvasScale: 1,
  // canvasBackgroundColor: SELECTED_COLOR,
  canvasBackgroundColor: '#ffffff',

  // is an a tool being used on canvas?
  canvasToolActive: false,

  // drag'n'drop
  fileDragNDropInProgress: false, // when the user drags files over the window

  // player states
  playerIsPlaying: false,
  playerFps: 24,
  playerInterval: null, // TODO: Maybe this should not be reactive and moved outside Vuex...
  playerLoopEnabled: false,
  playerLoopIn: null,
  playerLoopOut: null,

  timelineZoomLevel: 1, // 1 = default, < 1 = more frames can be displayed
  // the number of frames displayed in the timeline.
  // This should grow when longer animations are loaded and acts as a default value
  timelineFrames: 1000, // should be enough to fill a big screen
  defaultFrameWidth: 16, // little square displayed for each frame in the timeline
  defaultFrameHeight: 16,

  lastImportedImageTooBig: false,
  lastImportedImageHasDifferentDimensionsThanCanvas: false,
  // once the first colorization is done we will overwrite this estimate
  fileImportCanceledByUser: false, // when user clicks 'cancel' in the segmenatation waiting screen
  fileImportLayerType: null, // layer type for last import import process
  // numberOfImagesToLoad: 0, // total number of images to load in the last drop / file -> load
  // images that have been loaded since last import process was started
  // numberOfImagesLoadedInLastImport: 0,

  // when user clicks "colorize", this represents the total number of images to colorize (total)
  numberOfImagesToColorize: 0,
  // the number of images which have successfully been colorized (+ segmentation map generation)
  // in the last batch (used to show the progress)
  numberOfImagesColorized: 0,

  estTimeRemaining: 0,
  // To give more insights to the user what is happening when "colorize" was clicked,
  // it is useful to see which task is currently done,
  // can be either SEGMENTATION_MAP_GENERATION or COLORIZING
  // On a frame by frame basis this will be changed, according to the currently active step
  numberOfImagesToExport: 0,
  numberOfImagesExported: 0,

  currentProcessingTask: TASK_NONE,

  useFakeColorization: false,
  fakeColorizationTimeInMs: 4000,

  colorizationInProgress: false, // set to true while colorization is in progress
  updateColorsInProgress: false, // set to true while color update is in progress
  exportInProgress: false, // set to true during export
  exportingColorsSeparately: false, // set to true when exporting colors separately
  analyzeModeOnly: true, // set to true when analyze is pressed, and false when colorize is pressed
  aiGapCloserEnabled: true,
  maxAiDilationSize: 8,
  maxTbDilationSize: 1,
  minSegSize: 10,
  lineThreshold: 127,
  maxIter: 10,
  colorizationCanceledByUser: false,
  updateColorsCanceledByUser: false, // when user clicks 'stop' while colorization is in progress
  analyzeCanceledByUser: false, // when user clicks 'stop' while analyzing frames
  exportCanceledByUser: false, // when user clicks 'stop' while export is in progress
  // once the first colorization is done we will overwrite this estimate
  lastColorizationTime: NON_HARDWARE_SPECIFIC_ESTIMATED_COLORIZATION_TIME_IN_SEC,
  lastSegmentationMapGenerationTime: NON_HARDWARE_SPECIFIC_ESTIMATED_SEGMENTATION_TIME_IN_SEC,
  lastExportTime: NON_HARDWARE_SPECIFIC_ESTIMATED_EXPORT_TIME_IN_SEC,

  // later on we might have multiple line & reference pairs that form a layer.
  // Currently there is only one layer group consisting of a line and reference layer.
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
  // drawMode: 'source-over',
  // drawModePrevious: 'source-over',
  colorPalette: [],
  paletteEventOccurred: false,
  canvasRedrawTrigger: 0,
  colorCollapse: ['color', 'palette'],
  fillCollapse: ['fill'],
  penCollapse: ['pen'],
  eraserCollapse: ['eraser'],
  referenceCollapse: ['reference', 'library'],
  segOptionsCollapse: ['segoptions'],
  tmpImageRootPath: '',
  timelineScrollValueX: 0,
  activeLayerId: null,
  updateInProgress: false,
  updatePercentage: 0,
  canvasUndo: [],
  canvasRedo: [],
  timelineVisibility: true,
  tempFilePaths: [],
  currentFile: null,
  unsavedChanges: false,
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
  rainbowMode: 'on',
  segPanelHighlight: false,
  projectId: (Math.floor((Math.random() * (99999999 - 10000000)) + 10000000)),
  autoAlpha: true,
  // Active ML serving backend descriptor { kind, baseUrl }. Hydrated from the
  // persisted pref on app start (see Home.vue); like rainbowMode/autoAlpha it
  // is an app-level setting and survives New Project.
  serverBackend: resolveServerBackend(null, null),
  colorizationProgress: {
    numTotal: 0,
    numFinished: 0,
  },
  updatedColorsProgress: {
    numTotal: 0,
    numFinished: 0,
  },
  exportProgress: {
    numTotal: 0,
    numFinished: 0,
  },
};
