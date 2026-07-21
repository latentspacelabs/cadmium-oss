/* eslint-disable linebreak-style */
/* eslint-disable */
/* eslint-disable import/no-extraneous-dependencies */
// import shortid from 'shortid';
import { logError } from '@/util/error-util';

import {
  undo,
  redo,
  loadcdm,
} from '@/store/undo-redo-plugin';

import {
  base64Encode,
  base64EncodeInBrowser,
  stripMetaData,
  hasSupportedImageFileExtension,
  getDirectoryEntriesAll,
  getFileEntriesFromMenu,
  getFileFromFileSystemEntry,
  sortByName,
  getRawDataFromDataUri,
  // convertBase64ToBinary,
  getSupportedImageFileExtensions,
  writeBase64DataToFile,
  exportSVGOptions,
  saveOptions,
  defineTempDir,
} from '@/util/file-util';

import {
  getImageDimensions,
  loadImage,
  checkForAlphaPixels,
  // getUint32ArrayFromImageUri,
} from '@/util/image-util';

import {
  createCanvas,
} from '@/util/canvas-util';

import {
  generateSegmentationMap,
  generateCannyLine,
} from '@/util/segmentation';

import { buildSegMapFileName } from '@/util/segmap-path';
import {
  colorizeSnapshot,
  planColorize,
  COLORIZE_PLAN_ERROR,
} from '@/services/colorize-plan';
import {
  runColorize,
  runAnalyze,
  analyzeRef,
  createColorizeDeps,
  COLORIZE_RUN_ERROR,
} from '@/services/colorize-run';

import { i18n } from '@/util/i18nVue';

import {
} from '@/util/flood-fill-array';

import {
} from '@/util/flood-fill6';

import {
  colorImportedFirst
} from '@/util/warnings'

import showCustomDialog from '@/util/customDialog';

import {
  LAYER_TYPE,
  LINKED_LAYER_ID,
  FRAME_IS_SELECTED,
  // FRAME_IS_PLACEHOLDER,
  FRAME_IS_ORIGINAL,
  SELECTED_FRAMES_ON_LAYER,
  PLAYER_IS_PLAYING,
  REFERENCE_FRAME_NRS_FOR_LAYER_WITH_ID,
  IMAGE_DATA_OBJECT_OF_FRAME,
  FRAME_BY_FRAME_NR,
  ANALYZE_MODE_ONLY,
  AI_GAP_CLOSER_ENABLED,
  MAX_AI_DILATION_SIZE,
  MAX_TB_DILATION_SIZE,
  MIN_SEG_SIZE,
  UPDATE_COLORS_CANCELED_BY_USER,
  ANALYZE_CANCELED_BY_USER,
  UPDATE_COLORS_IN_PROGRESS,
  // EXPORTING_COLORS_SEPARATELY,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID,
  IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS,
  FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID,
  // FRAME_ID_OF_FIRST_FRAME_IN_BLOCK,
  FRAMES_HAVE_SAME_IMAGE_DATA_ID,
  TIMELINE_HAS_FRAMES_WITH_IMAGE_DATA,
  CANVAS_SIZE,
  AVAILABLE_SPACE_FOR_CANVAS,
  ACTIVE_LAYER_ID,
  COLOR_PALETTE,
  SELECTED_COLOR,
  RESERVED_COLOR,
  SELECTED_FRAME_NR,
  SAVE_STATE,
  CURRENT_FILE,
  UNSAVED_CHANGES,
  // COLOR_PREVIEW_MODE,
  COLOR_IMAGE_ID_FOR_SELECTED_FRAME,
  COLOR_IMAGE_FOR_SELECTED_FRAME,
  IMAGE_HAS_SEGMENTATION_MAP,
  // FRAME_ADDED_OR_REMOVED,
  // UNDO_REDO_EVENT_OCCURRED,
  LINE_THRESHOLD,
  COLORIZATION_IN_PROGRESS,
  PROJECT_ID,
  IS_AUTO_ALPHA,
} from '@/store/getter-types';

import {
  SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  SET_FRAME_SELECTED,
  SET_FRAMES_SELECTED,
  CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
  SET_TMP_IMAGE_ROOT_PATH,
  DESELECT_FRAMES,
  CREATE_PLAYER_INTERVAL,
  DESTROY_PLAYER_INTERVAL,
  SET_REF_FRAMES_FOR_FRAME,
  DELETE_SELECTED_FRAMES,
  SET_LAST_IMPORTED_IMAGE_TOO_BIG,
  SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID,
  SET_FRAME_ORIGINAL,
  SET_FRAMES_SELECTED_ON_WHOLE_LAYER,
  SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION,
  SET_FILE_IMPORT_CANCELED_BY_USER,
  SET_LAYER_TYPE_OF_FILES_TO_IMPORT,
  SET_COLORIZATION_IN_PROGRESS,
  SET_UPDATE_COLORS_IN_PROGRESS,
  SET_UPDATE_COLORS_CANCELED_BY_USER,
  SET_COLORIZATION_PROGRESS,
  SET_UPDATED_COLORS_PROGRESS,
  SET_COLORIZATION_CANCELED_BY_USER,
  SET_ANALYZE_CANCELED_BY_USER,
  SET_EXPORT_CANCELED_BY_USER,
  SET_EXPORTING_COLORS_SEPARATELY,
  SET_CURRENT_PROCESSING_TASK,
  REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID,
  SET_LAST_IMPORTED_IMAGE_HAS_DIFFERENT_DIMS_THAN_CANVAS,
  SET_CANVAS_SIZE,
  SET_CANVAS_SCALE,
  SET_SELECTED_FRAME_NUMBER,
  SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME,
  SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME,
  // SET_TIMELINE_SCROLL_VALUE_X,
  SET_ACTIVE_LAYER_ID,
  SET_SELECTED_COLOR,
  SET_RESERVED_COLOR,
  SET_CURRENT_FILE,
  SET_UNSAVED_CHANGES,
  SET_NEW_PROJECT,
  DELETE_COLOR_FROM_PALETTE,
  SET_PALETTE_EVENT_OCCURRED,
  SET_CANVAS_REDRAW_TRIGGER,
  // CLEAR_COLOR_PALETTE,
  TOGGLE_SWATCH_VISIBILITY,
  // SET_TEMP_FILE_DIR,
  ADD_FILE_TO_REFERENCE_FILES,
  DELETE_FILE_FROM_REFERENCE_FILES,
  SET_PROJECT_ID,
} from '@/store/mutation-types';
import {
  CREATE_PLAYER_RAF,
  DESTROY_PLAYER_RAF,
} from '@/store/mutation-types';

import {
  NEW_PROJECT,
  SAVE_FILE,
  OPEN_FILE_DIALOG,
  OPEN_FILE_FROM_OS,
  ASK_TO_SAVE,
  LOAD_FILE,
  SAVE_FILE_AS,
  CREATE_SAVED_FILE,
  EXPORT_DIALOG,
  EXPORT_COLORS_SEPARATED,
  CANCEL_EXPORT,
  COLORIZE,
  CANCEL_COLORIZATION,
  SHOW_HELP,
  OPEN_FEEDBACK_DIALOG,
  HANDLE_IMAGE_DROP,
  ADD_IMAGES_TO_TIMELINE,
  IMPORT_FILES_LINES,
  IMPORT_FILES_COLOR,
  IMPORT_FILES_FROM_MENU,
  TOGGLE_FRAME_SELECTION,
  PLAYER_PLAY_PAUSE,
  FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES,
  HANDLE_DELETE_PRESS,
  HANDLE_FRAME_DELETE,
  STORE_IMAGE_IN_IMAGE_STORE,
  STORE_BLANK_IMAGE_IN_IMAGE_STORE,
  OVERWRITE_IMAGE_IN_IMAGE_STORE,
  CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER,
  SELECT_ALL_LINE_FRAMES_FROM_MENU,
  SELECT_ALL_COLOR_FRAMES_FROM_MENU,
  DESELECT_ALL_FRAMES_FROM_MENU,
  HANDLE_NEXT_UNIQUE_IMAGE,
  HANDLE_PREVIOUS_UNIQUE_IMAGE,
  ANALYZE_CURRENT_FRAME,
  CANVAS_ACTION,
  UNDO_ACTION,
  REDO_ACTION,
  TOGGLE_ACTIVE_COLOR,
  URI_CHANGE_COLOR,
  REMOVE_MULTIPLE_COLOR_SWATCHES,
  SOLO_COLOR_IN_PALETTE,
  POPULATE_PALETTE,
  ADD_NEW_REFERENCE_IMAGE,
  LOAD_REFERENCE_FILE,
  DELETE_SELECTED_REFERENCE_IMAGES,
  TOGGLE_FRAME_ORIGINALITY,
  CYCLE_SWATCH,
} from '@/store/action-types';

import {
  LAYER_TYPE_COLOR,
  // LAYER_TYPE_LINE,
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
  TASK_IMPORT_COLOR_NO_LINE,
  TASK_NONE,
} from '@/store/general-types';

import {
  extractFrameNumberFromFilename,
} from '@/util/filename-util';

import {
  parseExportTarget,
  planExport,
  exportSnapshot,
  resolveExportTarget,
} from '@/services/export-plan';
import { runExport, createExportDeps } from '@/services/export-run';
import {
  serializeProject,
  parseProject,
  isProjectTooOld,
  deriveDocument,
  validateDocument,
} from '@/services/cdm-format';
import {
  exposeLineDrawing,
  attachColorToCel,
  mergePalette,
  recolorPalette,
} from '@/services/document';
import { computeReferenceFrames } from '@/services/reference-matching';
import {
  IMPORT_QUEUE_VERDICT,
  FRAME_NUMBER_VERDICT,
  NUM_SUPPORTED_FRAMES,
  planImportQueue,
  validateFrameNumber,
  planCanvasFit,
  estimateImportTimeRemaining,
} from '@/services/import-plan';
import {
  planPaletteRecolor,
  planRecolorTargets,
  extractPaletteRgba,
} from '@/services/palette-recolor';
import {
  putAsset,
  replaceAsset,
} from '@/services/asset-store';
import { runJob, isJobRunning, JobAlreadyRunningError } from '@/services/job-runner';
import {
  clearTempFiles,
  getTempDir,
  addTempFile,
  requestTempFiles,
  loadUserPrefs,
  scrollToFrame,
  notifyFileTooOld,
  setPref,
  cycleColorSwatch,
  addRecentDocument,
  showSaveDialog,
  showOpenDialog,
  getAppVersion,
} from '@/platform';

// const spawn = require('child_process').spawn;
// const spawn = require('await-spawn');
// const execFile = require('child_process').execFile;
const fs = require('fs');
const path = require('path');
const appVersion = getAppVersion();

// const ffmpeg = require('ffmpeg-static');
// ffmpeg.setFfmpegPath(ffmpegPath)


// function afterColorizationHelper({ getters, commit, dispatch }, { lineLayer, colorLayer }) {
//   if (!lineLayer || !colorLayer) {
//     console.error('Bad arguments: lineLayer, colorLayer: ', lineLayer, colorLayer);
//     return;
//   }

//   // reset the cancel button state
//   commit(SET_COLORIZATION_CANCELED_BY_USER, false);

//   // deselect frames on both layers
//   commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
//     layerId: lineLayer.id,
//     isSelected: false,
//   });
//   commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
//     layerId: colorLayer.id,
//     isSelected: false,
//   });

//   // clean up colorization state variables
//   commit(SET_COLORIZATION_IN_PROGRESS, false);
//   commit(SET_COLORIZATION_PROGRESS, { numTotal: 0, numFinished: 0 });

//   // set all (existing) color frames to not loading
//   const allColorFrameNrs = colorLayer.frames.filter(f => f).map(f => f.frameNr);
//   commit(SET_FRAMES_TO_LOADING, {
//     layerId: colorLayer.id,
//     frameNrs: allColorFrameNrs,
//   });

//   commit(SET_CURRENT_PROCESSING_TASK, TASK_NONE);
// }

// The sequential frame-colorization comparator now lives in
// '@/services/colorize-plan' (sequentialFrameSort), alongside the rest of
// COLORIZE's pure planning logic.

/**
 * Map a typed colorize error code (plan-time or run-time) to the exact dialog
 * COLORIZE used to open mid-loop. This is the ONLY place colorize dialogs live
 * now — the planner and the executor never open any (bug factory F4).
 */
function showColorizeErrorDialog(code, frameNr) {
  const DIALOGS = {
    [COLORIZE_PLAN_ERROR.NO_REFERENCE]: {
      title: 'Reference Frame Required',
      message: i18n.__('hold up, you need to add or create a reference frame first.'),
      type: 'warning',
    },
    [COLORIZE_PLAN_ERROR.REF_LINE_MISSING]: {
      title: 'Reference Line Frame Missing',
      message: `${i18n.__('Cannot colorize frame ')}${frameNr}${i18n.__(', because reference line frame does not exist.')}`,
      type: 'error',
    },
    [COLORIZE_RUN_ERROR.LINE_DATA_MISSING]: {
      title: 'Line Frame Missing',
      message: `${i18n.__('Sorry we could not color frame ')}${frameNr - 1}${i18n.__(' because you are missing a line frame.')}`,
      type: 'error',
    },
    [COLORIZE_RUN_ERROR.ANALYZE_LINE_MISSING]: {
      title: 'Line Frame Missing',
      message: `${i18n.__('Sorry we could not analyze frame ')}${frameNr - 1}${i18n.__(' because you are missing a line frame.')}`,
      type: 'error',
    },
    [COLORIZE_RUN_ERROR.TOO_MANY_SEGMENTS]: {
      title: 'Too Many Segments',
      message: i18n.__("Sorry Cadmium can't analyze or colorize this frame, there are too many segments. Maybe try adjusting your analyze settings."),
      type: 'warning',
    },
    [COLORIZE_RUN_ERROR.COLORIZE_FAILED]: {
      title: 'Colorization Failed',
      message: `${i18n.__('Yikes! Frame ')}${frameNr}${i18n.__(' could not be colorized. We will be working on a fix as soon as possible')}`,
      type: 'error',
    },
  };
  const dialog = DIALOGS[code];
  if (!dialog) { return; }
  showCustomDialog({
    title: i18n.__(dialog.title),
    message: dialog.message,
    buttons: [i18n.__('OK')],
    defaultId: 0,
    cancelId: 0,
    type: dialog.type,
  });
}

/**
 * The JobRunner allows one job at a time; every long-op entry point checks
 * before doing anything user-visible (and catches the check-vs-start race) so
 * a busy runner surfaces as this dialog instead of a silent no-op — with no
 * selection/flag side effects already applied.
 */
function showJobBusyDialog() {
  showCustomDialog({
    title: i18n.__('Operation in Progress'),
    message: i18n.__('Another operation is still running. Wait for it to finish (or cancel it) and try again.'),
    buttons: [i18n.__('OK')],
    defaultId: 0,
    cancelId: 0,
    type: 'warning',
  });
}

export default {

  async [COLORIZE]({
    state, getters, commit, dispatch,
  }) {
    // COLORIZE is now a thin UI wrapper (architecture doc §5.2): normalise the
    // selection, snapshot + plan (pure), surface any typed error as a dialog,
    // then run the effects executor under the JobRunner. `analyzeModeOnly` is
    // read ONCE here to choose the verb — it no longer reaches the loop.
    //
    // Busy check FIRST: everything below mutates the user's frame selection,
    // and a busy runner must not scramble it on the way to a failed start.
    if (isJobRunning()) { showJobBusyDialog(); return; }
    const analyzeMode = getters[ANALYZE_MODE_ONLY];
    const colorLayerId = INITIAL_COLOR_LAYER_ID;
    const lineLayerId = getters[LINKED_LAYER_ID](colorLayerId);

    // Move any line-layer selection onto the color layer (colorize operates on
    // the color layer), then ensure at least the current frame is selected.
    const selectedLineFrames = getters[SELECTED_FRAMES_ON_LAYER](lineLayerId);
    if (selectedLineFrames.length > 0) {
      commit(SET_FRAMES_SELECTED, {
        layerId: colorLayerId,
        frameNrs: selectedLineFrames.map(f => f.frameNr),
      });
      commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, { layerId: lineLayerId, isSelected: false });
    }
    let selectedFrames = getters[SELECTED_FRAMES_ON_LAYER](colorLayerId).filter(Boolean);
    if (selectedFrames.length === 0) {
      await dispatch(TOGGLE_FRAME_SELECTION, {
        layerId: colorLayerId,
        frameNr: getters[SELECTED_FRAME_NR],
      });
      selectedFrames = getters[SELECTED_FRAMES_ON_LAYER](colorLayerId).filter(Boolean);
    }

    // Resolve each selected frame's reference frames, then deselect the mirrored
    // line-layer frames.
    await dispatch(FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES, { layerId: colorLayerId });
    commit(DESELECT_FRAMES, {
      layerId: lineLayerId,
      frameNrs: selectedFrames.map(f => f.frameNr),
    });

    // Pure snapshot -> plan. Plan-time errors (no reference frame / missing
    // reference line) surface ONCE, before anything runs — the improvement over
    // the old mid-loop `break`, which colorized the frames before the failure.
    const plan = planColorize(colorizeSnapshot(getters, { analyzeMode }));
    if (plan.error) {
      showColorizeErrorDialog(plan.error, plan.errorFrameNr);
      return;
    }

    const deps = createColorizeDeps({ state, getters, commit, dispatch });
    const jobName = analyzeMode ? 'analyze' : 'colorize';
    const run = analyzeMode ? runAnalyze : runColorize;

    let result = null;
    try {
      result = await runJob({ commit }, { name: jobName }, ctx => run(plan, deps, ctx));
    } catch (err) {
      if (err instanceof JobAlreadyRunningError) { showJobBusyDialog(); return; }
      logError(err, 'There was a problem with colorization or segmentation');
      showColorizeErrorDialog(COLORIZE_RUN_ERROR.COLORIZE_FAILED, plan.ops[0] && plan.ops[0].frameNr);
      return;
    }

    // Run-time typed errors become dialogs here; the executor never opens any.
    if (result && result.error) {
      if (result.error === COLORIZE_RUN_ERROR.COLORIZE_FAILED) {
        logError(result.cause, `Could not colorize frame with number ${result.errorFrameNr}.`);
      }
      showColorizeErrorDialog(result.error, result.errorFrameNr);
    }

    commit(SET_UNSAVED_CHANGES, true);
    requestTempFiles();
  },


  [CANCEL_COLORIZATION]({ commit }) {
    commit(SET_COLORIZATION_CANCELED_BY_USER, true);
  },

  [CANCEL_EXPORT]({ commit }) {
    commit(SET_EXPORT_CANCELED_BY_USER, true);
  },

  async [SAVE_FILE]({ getters, dispatch }) {
    const filePath = getters[CURRENT_FILE];
    try {
      if (!fs.existsSync(filePath)) {
        const didCancel =  await dispatch(SAVE_FILE_AS);
        console.log("SAVE FILE -- cancelled: ", didCancel)
        return didCancel
      } else {
        const saveFilePath = filePath;
        await dispatch(CREATE_SAVED_FILE, { saveFilePath });
        return false;
      }
    } catch (err) {
      console.error(err);
    }
  },

  async [SAVE_FILE_AS]({ dispatch }) {
    try {
      const { canceled, filePath } = await showSaveDialog({
        title: i18n.__('Save As'), // not sure on which platform this will be shown.
        defaultPath: 'cadmium_project', // default filename, could also be default (abolute) path to export to
        showsTagField: false, // this would be problematic, because we batch export. Maybe later.
        filters: [
          { name: 'Cadmium Project', extensions: ['cdm'] },
        ],
      });
      console.log("SAVE FILE AS -- cancelled: ", canceled)
      const saveFilePath = filePath;
      // console.log('canceled? ', canceled);
      if (!canceled) {
        await dispatch(CREATE_SAVED_FILE, { saveFilePath });
        return false;
      } else {
        return true;
      }
    } catch (err) {
      console.error(err);
    }
  },

  async [CREATE_SAVED_FILE]({ getters, commit }, { saveFilePath }) {
    try {
      // requestTempFiles();
      const fullFilePath = `${saveFilePath}`;
      const saveState = getters[SAVE_STATE];
      const saveStateParsed = JSON.parse(JSON.stringify(saveState));
      // serverBackend is machine-local app config — keep it out of shareable
      // project files (loadcdm re-seeds it from the running app either way).
      delete saveStateParsed.serverBackend;
      // console.log('Saving .cdm File');
      const tempImages = [];
      const metadata = [{ version: appVersion }];
      // console.log('saveStateParsed.tempFilePaths.length: ', saveStateParsed.tempFilePaths.length);
      for (let i = 0; i < saveStateParsed.tempFilePaths.length; i += 1) {
        const tempfilepath = saveStateParsed.tempFilePaths[i];
        const encodedImage = await base64Encode(saveStateParsed.tempFilePaths[i], { asDataUri: true });
        const imageObject = { filename: tempfilepath, data: encodedImage };
        tempImages.push(imageObject);
        // console.log('imageObject: ', i, ' ', imageObject);
      }
      // .cdm v2: derive + append the exposure-sheet document (cels + exposures
      // + palette) from the same save-state. The legacy saveState is still
      // written in full and remains the LOAD source of truth; the document
      // section is forward-looking + the flip seam (see cdm-format.js header).
      const document = deriveDocument(saveState);
      const saveData = serializeProject({
        metadata, saveState, tempImages, document,
      });
      // console.log('BUFFER: ', saveData);
      fs.writeFile(fullFilePath, saveData, (err) => {
        if (err) throw err;
        console.log('The CDM file has been saved to', saveFilePath);
      });
      commit(SET_CURRENT_FILE, fullFilePath);
      addRecentDocument(fullFilePath);
      commit(SET_UNSAVED_CHANGES, false);

    } catch (err) {
      console.error(err);
    }
  },

  async [NEW_PROJECT]({ commit, dispatch }) {
    commit(SET_PROJECT_ID);
    // console.log('New Project Action Triggered');
    const saveChoiceNum = await dispatch(ASK_TO_SAVE);
    if (saveChoiceNum === 2) { return; }

    await new Promise(async (resolve) => {
      const resolver = await clearTempFiles().then((result) => {});
      resolve(resolver);
    });

    commit(SET_NEW_PROJECT);
    loadUserPrefs();
    scrollToFrame(1);
    // Ensure the default selected layer is the line layer on new project
    commit(SET_ACTIVE_LAYER_ID, INITIAL_LINE_LAYER_ID);
    await new Promise(async (resolve) => {
      const resolver = await getTempDir().then((result) => {});
      resolve(resolver);
    });

  },

  async [OPEN_FILE_DIALOG]({ dispatch }) {
    const saveChoiceNum = await dispatch(ASK_TO_SAVE);
    if (saveChoiceNum === 2) { return; }
    const { canceled, filePaths } = await showOpenDialog({
      title: i18n.__('Please select the folder and filename'), // not sure on which platform this will be shown.
      defaultPath: 'cadmium_project', // default filename, could also be default (abolute) path to export to
      properties: ['openFile', 'createDirectory'],
      filters: [
        { name: 'Cadmium Project', extensions: ['cdm'] },
      ],
    });
    // console.log('File Path: ', filePaths[0]);
    if (!canceled) {
      const filePath = filePaths[0];
      addRecentDocument(filePath);
      await dispatch(LOAD_FILE, { filePath });
    }
  },

  async [OPEN_FILE_FROM_OS]({ dispatch }, { filePath }) {
    const saveChoiceNum = await dispatch(ASK_TO_SAVE);
    if (saveChoiceNum === 2) { return; }
    await dispatch(LOAD_FILE, { filePath });
  },

  async [ASK_TO_SAVE]({ getters, dispatch }) {
    return new Promise(async (resolve) => {
      // const currentFile = getters[CURRENT_FILE];
      let saveChoiceNum;
      const unsavedChanges = getters[UNSAVED_CHANGES];
      if (unsavedChanges === true) {
        // PROMPT IF YOU WOULD LIKE TO SAVE YOUR FILE FIRST
        const saveChoice = await saveOptions();
        saveChoiceNum = saveChoice.response;
        // console.log('SAVE CHOICE: ', saveChoiceNum);
        if (saveChoiceNum === 0) {
          // console.log('YES Clicked');
          const didCancel = await dispatch(SAVE_FILE);
          if (didCancel) {
            saveChoiceNum = 2; // cancel was clicked in 'save as' dialog, return early
          }
        }
        if (saveChoiceNum === 2) {
          // console.log('CANCEL CLICKED');
        }
      }
      resolve(saveChoiceNum);
    });
  },

  [LOAD_FILE]({ getters, commit }, { filePath }) {
    // LOAD_FILE
    // console.log('File Path: ', filePath);

    new Promise((resolve) => {
      const resolveR = clearTempFiles().then((result) => {});
      resolve(resolveR);
    });

    new Promise((resolve) => {
      const resolver = getTempDir().then((result) => {});
      resolve(resolver);
    });

    const fileData = fs.readFileSync(filePath);
    const fileDataString = fileData.toString();
    const {
      version: versionNum, saveState: statedata, tempImages: tempimages, document: loadedDocument,
    } = parseProject(fileDataString);
    // console.log('version:', versionNum);

    // create version check to prevent users from opening old incompatible files
    // sorry new cadmium, who dis?
    if (isProjectTooOld(versionNum)) {
      // console.log('FILE IS TOO OLD TO OPEN')
      notifyFileTooOld();
      return;
    }

    for (let id in statedata.ImageStore.imageDataById) {
      if (statedata.ImageStore.imageDataById[id].segmentationMapPath) {
        const segFileNameOnly = statedata.ImageStore.imageDataById[id].segmentationMapPath.replace(/^.*[\\\/]/, '');
        const newSegMapPath = path.join(defineTempDir(), `${segFileNameOnly}`);
        statedata.ImageStore.imageDataById[id].segmentationMapPath = newSegMapPath;
      }
    }

    for (let i = 0; i < statedata.tempFilePaths.length; i += 1) {
      const filename = statedata.tempFilePaths[i].replace(/^.*[\\\/]/, '');
      statedata.tempFilePaths[i] = path.join(defineTempDir(), `${filename}`);
    }
    loadcdm(statedata);

    // THE FLIP SEAM (cdm v2): hydration above is unchanged — saveState is still
    // the load source of truth. For a v2 file we additionally VALIDATE that the
    // document derived from the just-loaded state matches the document section
    // that was saved. A mismatch means the derivation drifted from the legacy
    // model; a future storage flip must not proceed while they disagree. v1
    // files carry no document section (loadedDocument === null) — nothing to
    // validate; their migration is "derive the document on the next save".
    if (loadedDocument && process.env.NODE_ENV !== 'production') {
      const { ok, mismatches } = validateDocument(statedata, loadedDocument);
      if (!ok) {
        console.warn(
          '[LOAD_FILE] cdm v2 document validation mismatch on fields:',
          mismatches.join(', '),
        );
      }
    }

    // Ensure the default selected layer is the line layer when importing a project
    commit(SET_ACTIVE_LAYER_ID, INITIAL_LINE_LAYER_ID);
    for (let i = 0; i < tempimages.length; i += 1) {
      const tmpFilePath = tempimages[i].filename;
      /* eslint-disable-next-line */
      const filename = tmpFilePath.replace(/^.*[\\\/]/, '');
      const tmpTargetFilePath = path.join(defineTempDir(), `${filename}`);
      const rawImageData = getRawDataFromDataUri(tempimages[i].data);
      fs.writeFile(tmpTargetFilePath, rawImageData, 'base64', (err) => {
        if (err) throw err;
        // console.log('The temp file was saved');
      });
      addTempFile(tmpTargetFilePath);
    }
    commit(SET_CURRENT_FILE, filePath);
    commit(SET_UNSAVED_CHANGES, false);
  },

  [EXPORT_COLORS_SEPARATED]({ dispatch }) {
    // `kind` is now an argument, not a relay through the exportingColorsSeparately
    // flag (bug factory F1). EXPORT_DIALOG owns all dialogs and validation.
    dispatch(EXPORT_DIALOG, { kind: 'colors-separated' });
  },

  async [ADD_NEW_REFERENCE_IMAGE]({ dispatch }) {
    console.log('ADDING REF IMAGE');
    const electron = require('electron');
    document.getElementById('import-from-menu-button').value = null;
    const code = 'document.getElementById("import-from-menu-button").click()';
    electron.webFrame.executeJavaScript(code, true);
    const fileOutput = await getFileEntriesFromMenu();
    console.log('File Output: ', fileOutput);
    const filePaths = fileOutput[0];
    await dispatch(LOAD_REFERENCE_FILE, { fileLoadingQueue: filePaths, });

  },

  async [EXPORT_DIALOG]({
    getters, state, commit, dispatch,
  }, { kind = 'flat', filePath: filePathOverride = null } = {}) {
    // `filePath` skips the native save dialog — the dialog-free entry point for
    // programmatic/scripted exports (same pattern as CREATE_SAVED_FILE).
    //
    // Busy check FIRST — before the save dialog, so the user is not asked to
    // pick a path for an export that cannot start.
    if (isJobRunning()) { showJobBusyDialog(); return; }
    commit(DESTROY_PLAYER_INTERVAL);

    // PURE PLAN FIRST — typed errors surface BEFORE any dialog, so
    // colors-separated with an empty palette can no longer show a save dialog
    // and then silently write zero passes (bug factory F4 acceptance criterion).
    const snapshot = exportSnapshot(state, getters);
    const plan = planExport(snapshot, { kind });

    if (plan.error) {
      const EXPORT_ERROR_DIALOGS = {
        NO_FRAMES: {
          title: 'No Frames to Export',
          message: 'There are no frames to export!',
        },
        NO_VISIBLE_LAYERS: {
          title: 'No Visible Layers',
          message: 'No layer is visible. Turn something on to export.',
        },
        EMPTY_PALETTE: {
          title: 'Empty Palette',
          message: 'There are no colors in the palette to export separately.',
        },
      };
      const dialog = EXPORT_ERROR_DIALOGS[plan.error];
      showCustomDialog({
        title: i18n.__(dialog.title),
        message: i18n.__(dialog.message),
        buttons: [i18n.__('OK')],
        defaultId: 0,
        cancelId: 0,
        type: 'warning',
      });
      return;
    }

    let filePath = filePathOverride;
    if (!filePath) {
      const dialogResult = await showSaveDialog({
        title: i18n.__('Please select the export folder and filename'),
        message: i18n.__('The frame number will be appended to the filename, e.g. cadmium_export001.png'),
        defaultPath: 'cadmium_export',
        showsTagField: false,
        filters: [
          { name: 'PNG', extensions: ['png'] },
          { name: 'Vector (SVG)', extensions: ['svg'] },
          { name: 'Video (MP4)', extensions: ['mp4'] },
        ],
      });
      if (dialogResult.canceled) { return; }
      filePath = dialogResult.filePath;
    }

    const { ext } = parseExportTarget(filePath);
    let svgQualityNum = null; // high 0, medium 1, low 2, cancel 3
    if (ext === 'svg') {
      const svgQuality = await exportSVGOptions();
      svgQualityNum = svgQuality.response;
      if (svgQualityNum === 3) { return; } // dialog cancel
    }

    const finalizedPlan = resolveExportTarget(plan, filePath, { svgQualityNum });
    const deps = createExportDeps({ getters, commit, dispatch });

    // The exportingColorsSeparately flag no longer drives behaviour (`kind`
    // does); it is committed only so the waiting-screen overlay shows the right
    // label (ImageImportWaitingScreen.vue reads EXPORTING_COLORS_SEPARATELY).
    commit(SET_EXPORTING_COLORS_SEPARATELY, kind === 'colors-separated');
    try {
      await runJob({ commit }, { name: 'export' }, ctx => runExport(finalizedPlan, deps, ctx));
    } catch (err) {
      if (err instanceof JobAlreadyRunningError) { showJobBusyDialog(); return; }
      logError(err, 'Export failed');
      showCustomDialog({
        title: i18n.__('Export Failed'),
        message: `${i18n.__('Sorry, the export did not complete: ')}${err.message}`,
        buttons: [i18n.__('OK')],
        defaultId: 0,
        cancelId: 0,
        type: 'error',
      });
    } finally {
      commit(SET_EXPORTING_COLORS_SEPARATELY, false);
    }
  },

  [SHOW_HELP]() {
    // console.log('Show Help');
    window.open('https://github.com/latentspacelabs/cadmium-oss', 'We are here to help', 'nodeIntegration=no');
  },

  [OPEN_FEEDBACK_DIALOG]() {
    // console.log('Show Feedback');
    window.open('https://github.com/latentspacelabs/cadmium-oss/issues', 'We love feedback', 'nodeIntegration=no');
  },

  async [IMPORT_FILES_LINES]({ getters, dispatch }) {
    // console.log('Import Line Frames');
    const colorLayerId = INITIAL_COLOR_LAYER_ID;
    const lineLayerId = getters[LINKED_LAYER_ID](colorLayerId);
    dispatch(IMPORT_FILES_FROM_MENU, {
      layerId: lineLayerId,
    });
  },

  async [IMPORT_FILES_COLOR]({ dispatch }) {
    // console.log('Import Color Frames');
    const colorLayerId = INITIAL_COLOR_LAYER_ID;
    // const lineLayerId = getters[LINKED_LAYER_ID](colorLayerId);
    dispatch(IMPORT_FILES_FROM_MENU, {
      layerId: colorLayerId,
    });
  },

  async [IMPORT_FILES_FROM_MENU]({ commit, dispatch }, { layerId }) {
    /* eslint-disable-next-line */
    const electron = require('electron');
    document.getElementById('import-from-menu-button').value = null;
    const code = 'document.getElementById("import-from-menu-button").click()';
    electron.webFrame.executeJavaScript(code, true);
    const fileOutput = await getFileEntriesFromMenu();
    // console.log('FILE LIST: ', fileOutput);
    // now call the action that does a bunch of checks
    // and then loads the images into the the timeline
    const fileOutputArray = [].slice.call(fileOutput);
    fileOutputArray.sort((a, b) => (a.name > b.name) ? 1 : -1)
    dispatch(ADD_IMAGES_TO_TIMELINE, {
      layerId,
      fileLoadingQueue: fileOutputArray,
    });
    commit(SET_LAST_IMPORTED_IMAGE_TOO_BIG, false);
    // console.log('last image too big: ', getters[LAST_IMAGE_IS_TOO_BIG]);
  },

  async [HANDLE_IMAGE_DROP]({ commit, dispatch }, { event, layerId }) {
    // Prevent file from being opened
    event.preventDefault();
    // const layerType = getters[LAYER_TYPE](layerId);
    // commit(SET_LAYER_TYPE_OF_FILES_TO_IMPORT, layerType);

    if (event.dataTransfer.items) {
      // reset import canceled state
      commit(SET_FILE_IMPORT_CANCELED_BY_USER, false);
      // const linkedLayerId = getters[LINKED_LAYER_ID](layerId);
      const fileLoadingQueue = [];
      const filePreLoadingQueue = [];

      /**
       * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemEntry|FileSystemEntry}
       * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileEntry|FileSystemFileEntry}
       */

      for (let i = 0; i < event.dataTransfer.items.length; i += 1) {
        const entry = event.dataTransfer.items[i].webkitGetAsEntry();
        if (entry.isFile && hasSupportedImageFileExtension(entry.name)) {
          console.log(entry);
          filePreLoadingQueue.push(entry);
        } else if (entry.isDirectory) {
          const fileEntriesFromDir = await getDirectoryEntriesAll(entry);
          // console.log('Actions.js is getting :');
          // console.table(fileEntriesFromDir);
          const imageFileEntries = fileEntriesFromDir.filter(en => hasSupportedImageFileExtension(en.name));
          filePreLoadingQueue.push(...imageFileEntries);
        }
      }
      // now we have preloaded the entries,
      // we must turn the systemFileEntry objects into file objects:
      for (const fileEntry of filePreLoadingQueue) {
        const file = await getFileFromFileSystemEntry(fileEntry);
        fileLoadingQueue.push(file);
      }
      fileLoadingQueue.sort(sortByName);
      // console.log('fileLoadingQueue sorted: ', fileLoadingQueue);
      // console.log('number of images importing: ', fileLoadingQueue.length);
      // dispatch the command to add these images to timeline
      dispatch(ADD_IMAGES_TO_TIMELINE, { layerId, fileLoadingQueue });
    } // end of if statement
    commit(SET_LAST_IMPORTED_IMAGE_TOO_BIG, false);
    // console.log('last image too big: ', getters[LAST_IMAGE_IS_TOO_BIG]);
  },

  async [LOAD_REFERENCE_FILE]({ getters, commit, dispatch }, { fileLoadingQueue }) {

      const file = fileLoadingQueue;
      const b64withDecoration = await base64EncodeInBrowser(file, { asDataUri: true });
      const { width, height } = await getImageDimensions(b64withDecoration);

    const referenceFileObj = {
      name: file.name,
      width: width,
      height: height,
      b64Data: b64withDecoration,
      selected: false,
    };

    console.log("ADDING REFERENCE FILE OBJECT: ", referenceFileObj);

    commit(ADD_FILE_TO_REFERENCE_FILES, referenceFileObj);

  },

  async [ADD_IMAGES_TO_TIMELINE]({ getters, commit, dispatch }, { layerId, fileLoadingQueue }) {
    // The JobRunner coordinates import. Import has NO dedicated in-progress
    // flag: the per-frame overlay is raised by the shared ANALYZE_CURRENT_FRAME
    // sub-action (color branch only), and a line-only import must not raise it
    // at all — so the 'import' mirror sets no in-progress flag. The runner owns
    // the task label (TASK_IMPORT_COLOR_NO_LINE), the progress reset, and the
    // ANALYZE_CANCELED_BY_USER flag the color loop polls. Its settle also fixes
    // two resets the old code forgot: currentProcessingTask was never returned
    // to TASK_NONE, and the analyze cancel flag was never cleared, on completion.
    if (isJobRunning()) { showJobBusyDialog(); return; }
    try {
    await runJob({ commit }, { name: 'import' }, async () => {
    const layerType = getters[LAYER_TYPE](layerId);
    commit(SET_ACTIVE_LAYER_ID, layerId);
    commit(SET_LAYER_TYPE_OF_FILES_TO_IMPORT, layerType);
    const linkedLayerId = getters[LINKED_LAYER_ID](layerId);
    commit(SET_ANALYZE_CANCELED_BY_USER, false);
    const framesUnProcessed = [];

    const queueVerdict = planImportQueue(fileLoadingQueue.length, NUM_SUPPORTED_FRAMES);
    if (queueVerdict === IMPORT_QUEUE_VERDICT.EMPTY) {
      showCustomDialog({
        title: i18n.__('Unsupported File Type'),
        message: `${i18n.__('It looks like you tried to load an image file that we do not support. Right now we support: ')}${getSupportedImageFileExtensions().join(', ').trim()}.`,
        buttons: [i18n.__('OK')],
        defaultId: 0,
        cancelId: 0,
        type: 'error',
      });
      return;
    }

    if (queueVerdict === IMPORT_QUEUE_VERDICT.TOO_MANY) {
      showCustomDialog({
        title: i18n.__('Too Many Frames'),
        message: `${i18n.__('We currently only support up to ')}${NUM_SUPPORTED_FRAMES}${i18n.__(' frames. Please try again with fewer frames.')}`,
        buttons: [i18n.__('OK')],
        defaultId: 0,
        cancelId: 0,
        type: 'warning',
      });
      return; // maybe we should wrap this in a return constructor and reject...
    }

    // commit(SET_SEGMENTATION_MAP_GENERATION_PROGRESS, {
    //   numTotal: fileLoadingQueue.length,
    //   numFinished: 0,
    // });
    // let generatedSegmentationMaps = 0;

    /* eslint-disable no-await-in-loop */
    /* eslint-disable no-restricted-syntax */
    // see https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileEntry
    // We cannot use forEach here, otherwise await will not work. So we use for..of.
    // see https://www.coreycleary.me/why-does-async-await-in-a-foreach-not-actually-await/
    let fileLoadingCounter = 0;
    let lineFrameCheck = [];
    let colorBeforeLineWarned = false;
    for (const fileEntry of fileLoadingQueue) {
      console.log('fileLoadingQueue: ', fileEntry);
      // if (getters[FILE_IMPORT_CANCELED_BY_USER]) {
      //   // clean up
      //   commit(SET_SEGMENTATION_MAP_GENERATION_PROGRESS, {
      //     numTotal: 0,
      //     numFinished: 0,
      //   });
      //   break;
      // }
      try {
        const file = fileEntry;
        let b64withDecoration;
        let hasNoAlphaChannel = false;
        if (file && file.path) {
          // File selected from disk – strip metadata via Node fs path
          const fileWithoutMetaData = await stripMetaData(file.path);
          b64withDecoration = await base64EncodeInBrowser(fileWithoutMetaData[0], { asDataUri: true });
          hasNoAlphaChannel = fileWithoutMetaData[1];
        } else {
          // Blob/File created in-browser (no path) – skip metadata strip
          b64withDecoration = await base64EncodeInBrowser(file, { asDataUri: true });
        }
        // image dimension check (OSS: no size cap — self-hosted, user's hardware)
        const { width, height } = await getImageDimensions(b64withDecoration);
        const canvasSize = getters[CANVAS_SIZE];
        let imageHasDifferentDimensionsThanCanvas = false;
        if (getters[TIMELINE_HAS_FRAMES_WITH_IMAGE_DATA]) {
          if (width !== canvasSize.width || height !== canvasSize.height) {
            imageHasDifferentDimensionsThanCanvas = true;
          }
        }

        if (layerType === 'LAYER_TYPE_LINE') {
          // check for alpha PIXELS
          let alphaCheck = await checkForAlphaPixels(b64withDecoration, width, height);
          if (!alphaCheck || hasNoAlphaChannel) {
            showCustomDialog({
              title: i18n.__('No Transparent Pixels'),
              message: 'Your line image has no transparent pixels. Make sure your lines are on a transparent background before importing!',
              buttons: [i18n.__('OK')],
              defaultId: 0,
              cancelId: 0,
              type: 'error',
            });
            return;
          }
        }

        // we don't need to show an error here,
        // setting the flag will trigger a warning later on.
        commit(
          SET_LAST_IMPORTED_IMAGE_HAS_DIFFERENT_DIMS_THAN_CANVAS,
          imageHasDifferentDimensionsThanCanvas,
        );
        if (imageHasDifferentDimensionsThanCanvas) { return; }

        // make sure files are numbered properly
        const frameNr = extractFrameNumberFromFilename(file.name);
        // console.log('frameNr: ', frameNr);
        const frameNumberVerdict = validateFrameNumber(frameNr);
        if (frameNumberVerdict === FRAME_NUMBER_VERDICT.MISSING) {
          showCustomDialog({
            title: i18n.__('Frame Numbering Required'),
            message: i18n.__('Please add some numbers to the end of your frames, like: sharkDadLines__001.png.\n') + i18n.__('This is how cadmium knows where to place images on the timeline.'),
            buttons: [i18n.__('OK')],
            defaultId: 0,
            cancelId: 0,
            type: 'warning',
          });
          // logError(new Error('cannot import frames without number prefixes.'));
          break;
        }

        if (frameNumberVerdict === FRAME_NUMBER_VERDICT.TOO_HIGH) {
          showCustomDialog({
            title: i18n.__('Frame Number Too High'),
            message: i18n.__('Cadmium only supports frames numbered up to 999. Please renumber your frames.\n'),
            buttons: [i18n.__('OK')],
            defaultId: 0,
            cancelId: 0,
            type: 'warning',
          });
          // logError(new Error('cannot import frames without number prefixes.'));
          break;
        }

        // SET selectedFrame to this frameNr if it's the first frame in the group imported
        fileLoadingCounter = fileLoadingCounter + 1;
        if (fileLoadingCounter == 1) {
          commit(SET_SELECTED_FRAME_NUMBER, frameNr);
          scrollToFrame(frameNr);
        }

        // FIRST IMAGE IMPORT: (canvas size not set yet)
        // set canvas size
        if (width !== canvasSize.width || height !== canvasSize.height) {
          commit(SET_CANVAS_SIZE, { width, height });
          // set canvas zoom, so that the canvas fits in the available space,
          // but not bigger than 100%
          const availableCanvasSize = getters[AVAILABLE_SPACE_FOR_CANVAS];

          const scale = planCanvasFit({
            imageWidth: width,
            imageHeight: height,
            availableWidth: availableCanvasSize.width,
            availableHeight: availableCanvasSize.height,
          });

          if (scale) {
            commit(SET_CANVAS_SCALE, scale);
            // commit(SET_BACKGROUND_COLOR, color);
          }
        }

        if (file && file.path) {
          commit(SET_TMP_IMAGE_ROOT_PATH, file.path);
        }

        if (layerType === LAYER_TYPE_COLOR) {
          // TODO: We probably need to add another check in here,
          // e.g. if the frame exists and so on)i18n.__('
          // warn user when color images are added first
          if (!colorBeforeLineWarned) {
            lineFrameCheck[fileLoadingCounter] = await getters[FRAME_IS_ORIGINAL]({
              layerId: INITIAL_LINE_LAYER_ID,
              frameNr,
            });

            if (!lineFrameCheck[fileLoadingCounter]) {
              colorBeforeLineWarned = true;
              const colorImportFirstChoice = await colorImportedFirst();
              console.log('choice: ', colorImportFirstChoice.response);
              if (colorImportFirstChoice.response !== 0) {
                break;
              }
            }
          }

          const imageDataObj = getters[IMAGE_DATA_OBJECT_OF_FRAME]({ layerId, frameNr });
          let imageId;
          if (imageDataObj) {
            console.log(imageDataObj, ' exists');
            imageId = imageDataObj.id;
            dispatch(OVERWRITE_IMAGE_IN_IMAGE_STORE, {
              imageDataId: imageId,
              dataUri: b64withDecoration,
            });
          } else {
            imageId = await dispatch(STORE_IMAGE_IN_IMAGE_STORE, { dataUri: b64withDecoration });
          }

          attachColorToCel({ commit }, {
            frameNr,
            imageDataId: imageId,
            isOriginal: true,
          });

          // create a (ghost) frame on the linked line layer if necessary
          const imageDataId = `${imageId}_line`;
          await new Promise((resolve) => {
            dispatch(STORE_BLANK_IMAGE_IN_IMAGE_STORE, { imageDataId }); // storing a blank image
            resolve();
          });
          await new Promise((resolve) => {
            console.log('bout to create empty frame');
            commit(CREATE_EMPTY_FRAME_IF_NONE_EXISTS, {
              frameNr,
              layerId: linkedLayerId,
              imageDataId,
            });
            resolve();
          });
        } else { // layerType === LAYER_TYPE_LINE
          checkForAlphaPixels(b64withDecoration, width, height);
          // if text is failed, send warning, exit
          // console.log('b64withDecoration: ', b64withDecoration);
          // check if line ghost frame exists
          const lineImageDataObj = getters[IMAGE_DATA_OBJECT_OF_FRAME]({ layerId, frameNr });
          let lineImageId;
          if (lineImageDataObj) {
            lineImageId = lineImageDataObj.id;
            replaceAsset({ getters, commit, dispatch }, lineImageDataObj.id, b64withDecoration);
          } else {
            lineImageId = await putAsset({ getters, commit, dispatch }, b64withDecoration);
          }
          // Set the line image + create the paired (ghost) color cel via the
          // DocumentService command (the `<lineId>_color` blank record is kept —
          // see exposeLineDrawing's GHOST DECISION note).
          exposeLineDrawing({ commit, dispatch }, {
            frameNr,
            imageDataId: lineImageId,
            isOriginal: true,
            isLoading: false,
          });

        } // close if line frame
        // if current frame, load the image
        if (frameNr === getters[SELECTED_FRAME_NR]) {
          commit(SET_CANVAS_REDRAW_TRIGGER);
        }
        framesUnProcessed.push(frameNr);
      } catch (err) {
        logError(err, 'There was an error loading the image.');
        showCustomDialog({
          title: i18n.__('Image Import Failed'),
          message: i18n.__('Yikes, image import failed. We will start working on a fix as soon as we can.'),
          buttons: [i18n.__('OK')],
          defaultId: 0,
          cancelId: 0,
          type: 'error',
        });
        return;
      }
    } // end first for LOOP
    commit(SET_CANVAS_REDRAW_TRIGGER);
    if (layerType === LAYER_TYPE_COLOR) {
      // this second loop analyzes the color frames imported
      const colorLayerId = INITIAL_COLOR_LAYER_ID;
      // task label (TASK_IMPORT_COLOR_NO_LINE) is set by the JobRunner at start.
      const dupeList = [];
      let msPerLoop = null;
      let frameCounter = 0;
      for (const fileEntry of fileLoadingQueue) {
        // if we cancelled, stop the process and remove unprocessed frames
        if (getters[ANALYZE_CANCELED_BY_USER]) {
          console.log('ANALYZE CANCELED');
          commit(SET_COLORIZATION_IN_PROGRESS, false);
          commit(SET_COLORIZATION_PROGRESS, {
            numTotal: 0,
            numFinished: 0,
          });
          dispatch(DESELECT_ALL_FRAMES_FROM_MENU);
          // select the frames that haven't been processed
          console.log('did not process frames ', framesUnProcessed);
          commit(SET_FRAMES_SELECTED, {
            layerId: colorLayerId,
            frameNrs: framesUnProcessed,
          });
          // remove selected frames
          await dispatch(HANDLE_FRAME_DELETE);
          return;
        }
        frameCounter += 1;
        const file = fileEntry;
        const frameNr = extractFrameNumberFromFilename(file.name);
        const filePath = file.path;
        const frameIdsWithSameImage = getters[FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID]({ layerId, frameNr });
        // set the timeline marker to the current frame:
        commit(SET_SELECTED_FRAME_NUMBER, frameNr);
        const imageDataObj = getters[IMAGE_DATA_OBJECT_OF_FRAME]({ layerId, frameNr });
        const imageId = imageDataObj.id;
        console.log('imageDataObj: ', imageDataObj);
        const dupeCheck = dupeList.includes(frameNr);
        if (!dupeCheck) {
          if (!getters[IMAGE_HAS_SEGMENTATION_MAP](imageId)) {
            // now analyze the frame
            console.log('FILE LOADING THING: ', fileLoadingQueue.length, frameNr);
            const t0 = performance.now();
            const timeToSend = estimateImportTimeRemaining({
              msPerLoop,
              queueLength: fileLoadingQueue.length,
              frameNr,
            });
            commit(SET_COLORIZATION_PROGRESS, {
              numTotal: fileLoadingQueue.length,
              numFinished: frameCounter - 1,
              timeRemaining: timeToSend,
            });
            console.log(filePath);
            const colorFrameDataUriFromStore = getters[IMAGE_DATA_URI_BY_IMAGE_DATA_ID](imageId);
            await dispatch(ANALYZE_CURRENT_FRAME, {
              colorFrameFilePath: filePath,
              colorFrameDataUri: colorFrameDataUriFromStore,
              colorImageId: imageId,
              fromImport: frameNr,
            });
            const t1 = performance.now();
            msPerLoop = t1 - t0;
          }
          dupeList.push(...frameIdsWithSameImage);
          // console.log('dupeList: ', dupeList);
        }
        framesUnProcessed.shift();
      }
    }
    // after dropping color frames, color frame duplicates by now use the same
    // image data, but are still not marked as "original", because this is
    // an attribute of the frame, not the image data object. (TODO: Should be changed)
    // We need to check for each color frame if it is a (duplicate) color frame
    // and set the property accordingly.

    dispatch(CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER, { layerId });
    // Default back to line layer after import completes
    commit(SET_ACTIVE_LAYER_ID, INITIAL_LINE_LAYER_ID);
    commit(SET_UNSAVED_CHANGES, true);
    });
    } catch (err) {
      // Lost the isJobRunning race (or a real failure): surface it — the
      // dispatchers fire-and-forget, so a rethrow would be a silent no-op.
      if (err instanceof JobAlreadyRunningError) { showJobBusyDialog(); return; }
      logError(err, 'Image import failed');
      showCustomDialog({
        title: i18n.__('Image Import Failed'),
        message: i18n.__('Yikes, image import failed. We will start working on a fix as soon as we can.'),
        buttons: [i18n.__('OK')],
        defaultId: 0,
        cancelId: 0,
        type: 'error',
      });
    }
  },

  [CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER]({ state, commit }, { layerId }) {
    const layer = state.layers[layerId];
    if (!layer) { console.warn(`Could not find a layer with ID ${layerId}`); return; }
    const { frames } = layer;
    if (!frames) { console.warn('Layer has no frames'); return; }
    // first we need to collect the image data IDs of all reference frames on
    // this layer
    const originalFrames = frames.filter(f => f && f.isOriginal);
    const imageDataIdsOfOrigFrames = originalFrames.map(f => f && f.imageDataId);
    // console.log('imageDataIdsOfOrigFrames: ', imageDataIdsOfOrigFrames);
    const imageDataIdsOfOrigFramesUniq = [...new Set(imageDataIdsOfOrigFrames)];
    // console.log('imageDataIdsOfOrigFramesUniq: ', imageDataIdsOfOrigFramesUniq);
    // then we need to correct the frames that use the same image data ID,
    // but are not marked as original.
    // Later on the "isOriginal" attribute should be move to the imageData objects.
    // but for now we need to keep the frames and imageData objects in sync.
    const nonOriginalFrames = frames.filter(f => f && !f.isOriginal);
    nonOriginalFrames.forEach((f) => {
      if (imageDataIdsOfOrigFramesUniq.includes(f.imageDataId)) {
        commit(SET_FRAME_ORIGINAL, { layerId, frameNr: f.frameNr });
      }
    });
  },

  [TOGGLE_FRAME_SELECTION]({ getters, commit }, { layerId, frameNr, event }) {
    const frameIsSelected = getters[FRAME_IS_SELECTED]({ layerId, frameNr });
    let shiftKeyIsPressed = false;
    if (event) {
      shiftKeyIsPressed = event.shiftKey;
    }
    commit(SET_FRAME_SELECTED, {
      layerId,
      frameNr,
      isSelected: !frameIsSelected,
      shiftKeyIsPressed,
    });
    const frameIdsWithSameImage = getters[FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID]({ layerId, frameNr });
    frameIdsWithSameImage.forEach((fNr) => {
      commit(SET_FRAME_SELECTED, {
        layerId,
        frameNr: fNr,
        isSelected: !frameIsSelected,
        // this might be problematic, as this could potentially make clear previous shift state
        shiftKeyIsPressed: false,
      });
    });
  },

  [PLAYER_PLAY_PAUSE]({ state, getters, commit }) {
    const isPlaying = getters[PLAYER_IS_PLAYING];
    if (!isPlaying) {
      // commit(SET_TIMELINE_SCROLL_VALUE_X, (17 * state.firstRealFrameNumber));
      // console.log('firstRealFrameNumber: ', state.firstRealFrameNumber);
      // Prefer RAF-based playback; fallback to interval if window not available
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        commit(CREATE_PLAYER_RAF, state.playerFps);
      } else {
        commit(CREATE_PLAYER_INTERVAL, state.playerFps);
      }
    } else {
      if (typeof window !== 'undefined' && window.cancelAnimationFrame) {
        commit(DESTROY_PLAYER_RAF);
      }
      commit(DESTROY_PLAYER_INTERVAL);
    }
  },

  [FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES]({ getters, commit }, { layerId }) {
    if (!layerId) { console.error(`Bad arguments. Expected { layerId }, got ${layerId}`); return; }
    const referenceFrameNrs = getters[REFERENCE_FRAME_NRS_FOR_LAYER_WITH_ID](layerId);
    if (!referenceFrameNrs) { return; }
    // get the selected color frames, ignore selected line frames
    const selectedFrameNrs = getters[SELECTED_FRAMES_ON_LAYER](INITIAL_COLOR_LAYER_ID).map(f => f.frameNr);
    // predicate closure over the getter: do two frames share image data?
    const framesShareImageData = (a, b) => getters[FRAMES_HAVE_SAME_IMAGE_DATA_ID]({
      layerId,
      frameNrs: [a, b],
    });
    const refFramesForFrames = computeReferenceFrames({
      referenceFrameNrs,
      selectedFrameNrs,
      framesShareImageData,
    });
    refFramesForFrames.forEach(({
      frameNr, refFrameLeftNr, refFrameRightNr, refFrameClosestNr,
    }) => {
      commit(SET_REF_FRAMES_FOR_FRAME, {
        layerId,
        frameNr,
        refFrameLeftNr,
        refFrameRightNr,
        refFrameClosestNr,
      });
    });
  },

  async [ANALYZE_CURRENT_FRAME]({ getters, commit, dispatch }, { colorFrameFilePath, colorFrameDataUri, colorImageId, fromImport }) {
    console.log('ANALYZE CURRENT FRAME');
    console.log('COLOR IMAGE ID:', colorImageId);
    // reset canceled state so cancel button works
    commit(SET_COLORIZATION_CANCELED_BY_USER, false);
    dispatch(DESELECT_ALL_FRAMES_FROM_MENU);
    const thisFrameNr = getters[SELECTED_FRAME_NR];
    const colorLayerId = INITIAL_COLOR_LAYER_ID;
    const lineLayerId = getters[LINKED_LAYER_ID](colorLayerId);
    const aiGapCloserEnabled = getters[AI_GAP_CLOSER_ENABLED];
    const aiDilationAmount = aiGapCloserEnabled ? getters[MAX_AI_DILATION_SIZE] : 0;
    const tbDilationAmount = getters[MAX_TB_DILATION_SIZE];
    const minSegSize = getters[MIN_SEG_SIZE];
    const lineThreshold = getters[LINE_THRESHOLD];
    const isAutoAlpha = getters[IS_AUTO_ALPHA];
    const canvSize = getters[CANVAS_SIZE];
    let canceled;

    commit(SET_FRAME_SELECTED, {
      layerId: colorLayerId,
      frameNr: thisFrameNr,
      isSelected: true,
      shiftKeyIsPressed: false,
    });
    // get current frame
    // get the current target frame
    const targetLineFrame = getters[FRAME_BY_FRAME_NR]({
      layerId: lineLayerId,
      frameNr: thisFrameNr,
    });
    console.log('targetLineFrame: ', targetLineFrame);
    const currLineFrameObj = await getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](targetLineFrame.imageDataId);
    console.log(currLineFrameObj);
    let currHash;
    if (currLineFrameObj.hash) { // if a line image hash exists
      currHash = currLineFrameObj.hash;
    } else {
      const currColorFrameObj = await getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](colorImageId);
      currHash = currColorFrameObj.hash;
    }
    // create dummy seg name and check if it exists
    const currSegFileName = buildSegMapFileName({
      hash: currHash,
      lineThreshold,
      isAutoAlpha,
      tbDilationSize: tbDilationAmount,
      aiDilationSize: aiDilationAmount,
      minSegSize,
    });
    const currSegPath = path.join(defineTempDir(), currSegFileName);
    let segMapPath = '';
    let cannyLineFilePath;
    // cadm_segMap_a52ca022f66d3b4ed60ced15d620c6fe_minSegSize_2_dilate_01.png
    // set analyze mode wait screen
    commit(SET_COLORIZATION_IN_PROGRESS, true);
    console.log('CHECKING IF SEGMAP EXISTS', currSegPath);
    if (fs.existsSync(currSegPath)) {
      console.log('line image segmap already exists');
      // use that as the image...
      commit(SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID, {
        imageDataId: targetLineFrame.imageDataId,
        segmentationMapPath: currSegPath,
      });
      segMapPath = currSegPath;
    } else {
      // define path of target frame
      // const tmpTargetFileName = `cadm_tmp_trgt_${Date.now()}.png`;
      const frameNameElements = [`cadm_tmp_trgt_${Date.now()}`, '_', currHash, `.png`];
      const tmpTargetFileName = frameNameElements.join('');
      let tmpTargetFilePath = path.join(defineTempDir(), tmpTargetFileName);

      // define line frame
      const lineDataObj = getters[IMAGE_DATA_OBJECT_OF_FRAME]({
        layerId: lineLayerId,
        frameNr: thisFrameNr,
      });
      // console.log('lineDataObj: ', lineDataObj.dataUri);
      // determine whether the line frame exists, or if we need to make a new one
      let targetLineFrameDataUri;
      let rawBase64Data;
      let processingTimeInSec;
      let cannyUri;
      // if line image already exists
      if (lineDataObj.dataUri) {
        // console.log(lineDataObj.dataUri);
        // create/define line image
        if (!colorImageId) {
          commit(SET_COLORIZATION_PROGRESS, {
            numTotal: 1,
            numFinished: 0,
          });
        }
        targetLineFrameDataUri = getters[IMAGE_DATA_URI_BY_IMAGE_DATA_ID](targetLineFrame.imageDataId);
        rawBase64Data = getRawDataFromDataUri(targetLineFrameDataUri);
        await writeBase64DataToFile(tmpTargetFilePath, rawBase64Data);
      } else { // line image does not exist and we have to make one
        console.log('line image does not exist, creating one');
        const cannyLineFileName = `cadm_cannyLine_${thisFrameNr - 1}_${Date.now()}.png`;
        cannyLineFilePath = path.join(defineTempDir(), cannyLineFileName);
        console.log(cannyLineFilePath);
        cannyUri  = await generateCannyLine({
          colorPath: colorFrameFilePath,
          outPath: cannyLineFileName,
          projectId: getters[PROJECT_ID],
        });

        tmpTargetFilePath = cannyLineFilePath;
        
        addTempFile(tmpTargetFilePath);
        // create segmentation map
        // let processingTimeInSec;
        // eslint-disable-next-line
        // console.log(segMapPath);

        // add canny Line to line frame
        // console.log(cannyUri);
        console.log('overwriting line image with canny line image');
        let cannyLineImageId;
        cannyLineImageId = lineDataObj.id;
        dispatch(OVERWRITE_IMAGE_IN_IMAGE_STORE, {
          imageDataId: cannyLineImageId,
          dataUri: cannyUri,
        });

        commit(SET_IMAGE_DATA_FOR_FRAME_WITH_ID, {
          layerId: lineLayerId,
          imageDataId: cannyLineImageId,
          frameNr: thisFrameNr,
          isOriginal: false,
        });

        console.log('canny line image data obj: ', lineDataObj);
      }

      ({ path: segMapPath, processingTimeInSec, canceled } = await generateSegmentationMap({
        projectId: getters[PROJECT_ID],
        srcFilename: tmpTargetFileName,
        srcPath: tmpTargetFilePath,
        imageId: targetLineFrame.imageDataId,
        aiDilationSize: aiDilationAmount,
        tbDilationSize: tbDilationAmount,
        minSegSize: minSegSize,
        line_threshold: lineThreshold,
        is_auto_alpha: isAutoAlpha,
        minSegSize: minSegSize,
        canvSize: getters[CANVAS_SIZE],
      }));

      if (canceled) {
        commit(SET_COLORIZATION_IN_PROGRESS, false);
        return;
      }

      // console.log(`Segmentation map generated and stored at: ${segMapPath}, took ${processingTimeInSec} seconds`);
      if (processingTimeInSec){
        commit(SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION, processingTimeInSec);
      }
      // find duplicates and update
      if (lineDataObj && segMapPath) {
        commit(SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID, {
          imageDataId: targetLineFrame.imageDataId,
          segmentationMapPath: segMapPath,
        });
      }
    }
    if (canceled) {
      // dispatch(DESELECT_ALL_FRAMES_FROM_MENU);
      commit(SET_UNSAVED_CHANGES, true);
      requestTempFiles();
      console.log('THING CANCELED, FROM IMPORT FRAME NUMBER', fromImport);
      if (fromImport) {
        // if this ANALYZE_FRAME action was triggered from a color frame import and the analyzation was cancelled, delete the color frame that was imported.
        // clear all selected frames
        dispatch(DESELECT_ALL_FRAMES_FROM_MENU);
        // set the selected frame on the color layer
        const colorLayerId = [INITIAL_COLOR_LAYER_ID][0];
        commit(SET_FRAME_SELECTED, {
          layerId: colorLayerId,
          frameNr: fromImport,
          isSelected: true,
          shiftKeyIsPressed: false,
        });
        // commit delete selected frames
        console.log('ABOUT TO DELETE SELECTED FRAMES');
        await dispatch(HANDLE_FRAME_DELETE);
        commit(SET_CANVAS_REDRAW_TRIGGER);
      }
      commit(SET_COLORIZATION_IN_PROGRESS, false);
      return;
    }

    if (colorFrameFilePath || colorFrameDataUri) {

      const refSegMap64DataUri = await base64Encode(
        segMapPath,
        { asDataUri: true },
      );

      const refColor64DataUri = colorFrameDataUri
        ? colorFrameDataUri
        : await base64Encode(colorFrameFilePath, { asDataUri: true });
      let targetLineFrameDataUri;
      if ( cannyLineFilePath == null ){
        console.log('cannylinefilepath null');
        targetLineFrameDataUri = getters[IMAGE_DATA_URI_BY_IMAGE_DATA_ID](targetLineFrame.imageDataId);
      } else {
        console.log('cannylinefilepath exists');
        targetLineFrameDataUri = await base64Encode(
          cannyLineFilePath,
          { asDataUri: true },
        );
      }

      // Shared with COLORIZE's analyze path: `analyzeRef` (colorize-run.js) owns
      // the /preprocess call, the palette merge, and the REPLACE_IMAGE_DATA_URI
      // of the preprocessed render — one implementation for both entry points.
      await analyzeRef(
        {
          segMapDataUri: refSegMap64DataUri,
          refColorDataUri: refColor64DataUri,
          targetLineDataUri: targetLineFrameDataUri,
          colorImageId,
        },
        createColorizeDeps({ getters, commit, dispatch }),
      );
    }
      commit(SET_CANVAS_REDRAW_TRIGGER);
      // exit analyze mode
      commit(SET_COLORIZATION_IN_PROGRESS, false);
      dispatch(DESELECT_ALL_FRAMES_FROM_MENU);
      commit(SET_UNSAVED_CHANGES, true);
      requestTempFiles();
  },

  [HANDLE_DELETE_PRESS]({ getters, commit }) {
    // decrement the imagedata counter per image, so that we can delete
    // images that are no longer in use.
    const imageDataIds = getters[IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS];
    console.log('Image data IDs of selected frames: ', imageDataIds);
    // commit(DECREMENT_USAGE_OF_IMAGE_DATA_IDS, imageDataIds);
    // commit(DETACH_SELECTED_FRAMES_FROM_THEIR_IMAGE_DATA);
    console.log('handle_delete_press');
    commit(DELETE_SELECTED_FRAMES);
    // the following deletes images from the store that are only used once,
    // if the image is a duplicate (used 2+ times) its usage-counter
    // is decremented.
    // Process each imageDataId exactly as many times as it appears in the array
    // to ensure proper reference count handling for duplicates
    imageDataIds.forEach(id => commit(REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID, id));
    commit(SET_UNSAVED_CHANGES, true);
    commit(SET_CANVAS_REDRAW_TRIGGER);
  },

  [HANDLE_FRAME_DELETE]({ getters, commit }) {
    // this is a cloned action of HANDLE_DELETE_PRESS, the only difference
    // is that this action doesn't get added to the undo stack.
    // we are using this to remove unprocessed color frames
    const imageDataIds = getters[IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS];
    console.log('handle_frame_delete: ', imageDataIds);
    commit(DELETE_SELECTED_FRAMES);
    // Process each imageDataId exactly as many times as it appears in the array
    // to ensure proper reference count handling for duplicates
    imageDataIds.forEach(id => commit(REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID, id));
    commit(SET_UNSAVED_CHANGES, true);
  },

  [TOGGLE_ACTIVE_COLOR]({ getters, commit }) {
    const colorA = getters[SELECTED_COLOR];
    const colorB = getters[RESERVED_COLOR];
    commit(SET_SELECTED_COLOR, colorB);
    commit(SET_RESERVED_COLOR, colorA);
    // console.log(getters[SELECTED_COLOR]);
    setPref('reservedColor', colorA);
    setPref('selectedColor', colorB);
  },

  // MENU ACTIONS:

  [SELECT_ALL_LINE_FRAMES_FROM_MENU]({ commit }) {
    const isSelected = true;
    const layerId = [INITIAL_LINE_LAYER_ID];
    commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
      layerId,
      isSelected,
    });
  },

  [SELECT_ALL_COLOR_FRAMES_FROM_MENU]({ commit }) {
    const isSelected = true;
    const layerId = [INITIAL_COLOR_LAYER_ID];
    commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
      layerId,
      isSelected,
    });
  },

  [DESELECT_ALL_FRAMES_FROM_MENU]({ getters, commit }) {
    const isSelected = false;
    const layerId = getters[ACTIVE_LAYER_ID] || INITIAL_COLOR_LAYER_ID;
    commit(SET_FRAMES_SELECTED_ON_WHOLE_LAYER, {
      layerId,
      isSelected,
    });
  },

  [HANDLE_NEXT_UNIQUE_IMAGE]({ getters, commit }) {
    commit(SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME, {
      layerId: getters[ACTIVE_LAYER_ID] || INITIAL_COLOR_LAYER_ID,
      isSelected: true,
    });
  },

  [HANDLE_PREVIOUS_UNIQUE_IMAGE]({ getters, commit }) {
    commit(SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME, {
      layerId: getters[ACTIVE_LAYER_ID] || INITIAL_COLOR_LAYER_ID,
      isSelected: true,
    });
  },

  [CANVAS_ACTION]({ commit }) {
    // console.log('CANVAS ACTION TRIGGERED');
    commit(SET_UNSAVED_CHANGES, true);
    return true;
  },

  async [UNDO_ACTION]({ commit, getters }) {
    // console.log('undo action');
    await undo(getters[COLORIZATION_IN_PROGRESS], getters[UPDATE_COLORS_IN_PROGRESS]);
    commit(SET_CANVAS_REDRAW_TRIGGER);
    /* eslint-disable-next-line */
    return;
  },

  async [REDO_ACTION]({ commit, getters }) {
    await redo(getters[COLORIZATION_IN_PROGRESS], getters[UPDATE_COLORS_IN_PROGRESS]);
    commit(SET_CANVAS_REDRAW_TRIGGER);
  },
  // THIS action takes in colors (array of objects), and allFrames (boolean)
  /* eslint-disable-next-line */
  async [URI_CHANGE_COLOR]({ state, commit, getters, dispatch }, { allFrames }) {
    // The JobRunner owns the update-colors start/settle mirrors (in-progress,
    // task, progress reset, update-colors cancel-flag reset). The mid-loop
    // UPDATE_COLORS_CANCELED_BY_USER poll is left untouched.
    if (isJobRunning()) { showJobBusyDialog(); return; }
    await runJob({ commit }, { name: 'update-colors' }, async () => {
    try {
      console.log('[URI_CHANGE_COLOR] starting with waiting screen');

      // reset the cancel flag before the run
      commit(SET_UPDATE_COLORS_CANCELED_BY_USER, false);

      console.log("UPDATE_COLORS_IN_PROGRESS: ", getters[UPDATE_COLORS_IN_PROGRESS]);
      console.log("STATE.UPDATE_COLORS_IN_PROGRESS: ", state.updateColorsInProgress);

    await new Promise(async (resolve) => {
      console.log('[URI_CHANGE_COLOR] invoked. allFrames:', allFrames);
      // console.log('URI_CHANGE_COLOR');
      // console.log('allFrames:', allFrames);

      // SET VARIABLES
      const colorLayerId = INITIAL_COLOR_LAYER_ID;
      const colorPalette = getters[COLOR_PALETTE];
      const canvasSize = getters[CANVAS_SIZE];
      const { width, height } = canvasSize;
      const swatchesToChange = [];
      console.log('[URI_CHANGE_COLOR] palette length:', colorPalette.length, 'canvas:', width, 'x', height);

      // READ SIDE — the unique color images to recolor. Derived from
      // xsheet.uniqueDrawings (the one home for drawing-identity, bug factory
      // F3), replacing the old imageId-equality accumulator walk. The selected
      // frame is processed FIRST (its id may fall back to the linked line image
      // via COLOR_IMAGE_*_FOR_SELECTED_FRAME); in preview mode (allFrames ===
      // false) ONLY the selected frame is processed (no layer scan).
      const scanFrameNrs = [];
      if (allFrames) {
        for (let i = state.firstRealFrameNumber; i <= state.lastRealFrameNumber; i += 1) {
          scanFrameNrs.push(i);
        }
      }
      const recolorTargets = planRecolorTargets({
        layers: state.layers,
        colorLayerId,
        frameNrs: scanFrameNrs,
        seed: {
          imageDataId: getters[COLOR_IMAGE_ID_FOR_SELECTED_FRAME],
          dataUri: getters[COLOR_IMAGE_FOR_SELECTED_FRAME],
        },
        uriById: (id) => getters[IMAGE_DATA_URI_BY_IMAGE_DATA_ID](id),
      });
      console.log('[URI_CHANGE_COLOR] total recolorTargets:', recolorTargets.length);

      // Initialize progress for waiting screen
      commit(SET_UPDATED_COLORS_PROGRESS, {
        numTotal: recolorTargets.length,
        numFinished: 0,
      });
      
      // GET ALL PALETTE COLORS TO CHANGE
      // planPaletteRecolor normalises every entry in place (so the palette
      // reset below still sees the defaulted new* fields) and returns the
      // old->new uint32 swatch table for the changed, participating entries.
      swatchesToChange.push(...planPaletteRecolor(colorPalette, allFrames));
      console.log('[URI_CHANGE_COLOR] total swatchesToChange:', swatchesToChange.length);
      // NOW TO ACTUALLY CHANGE THE DATA:

      let timeDiff = null;
      // Process frames if we have collected any images to change
      if (recolorTargets.length > 0) {
        for (let k = 0; k < recolorTargets.length; k += 1) {
          // Support canceling color update
          if (getters[UPDATE_COLORS_CANCELED_BY_USER]) {
            commit(SET_UPDATE_COLORS_IN_PROGRESS, false);
            commit(SET_CURRENT_PROCESSING_TASK, TASK_NONE);
            commit(SET_UPDATED_COLORS_PROGRESS, { numTotal: 0, numFinished: 0 });
            resolve(true);
            return;
          }
          const colorChangeStartTime = Date.now();
          const { imageDataId, dataUri: imageData } = recolorTargets[k];
          console.log('[URI_CHANGE_COLOR] processing frameIndex', k, 'imageDataId', imageDataId, 'swatches:', swatchesToChange.length);
          // do the magic here — the canvas pixel rewrite stays in the action
          // (see palette-recolor.js header); only the store write is a command.
          const { canvas, ctx } = createCanvas({ width, height });
          const colorImgSeg = await loadImage(imageData);
          ctx.drawImage(colorImgSeg, 0, 0);

          const colorImageCanvasData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
          const pixelData = {
            width,
            height,
            data: new Uint32Array(colorImageCanvasData.data.buffer),
          };

          // LOOP THROUGH PIXELS AND CHANGE EACH COLOR
          let pixelCount = pixelData.data.length;
          let replacedForFrame = 0;
          /* eslint-disable-next-line */
          await new Promise((resolve) => {
            while (pixelCount >= 0) {
              for (let s = 0; s < swatchesToChange.length; s += 1) {
                if (pixelData.data[pixelCount] === swatchesToChange[s].uInt32) {
                  pixelData.data[pixelCount] = swatchesToChange[s].newUint32;
                  replacedForFrame += 1;
                }
              }
              pixelCount -= 1;
            }
            resolve(pixelCount);
          });
          // make temp canvas to create new URI with updated pixels
          ctx.putImageData(colorImageCanvasData, 0, 0);
          const newColorDataUri = canvas.toDataURL('image/png', 1.0);
          console.log('[URI_CHANGE_COLOR] frameIndex', k, 'replacedPixels', replacedForFrame, 'newUriLen', newColorDataUri ? newColorDataUri.length : 0);

          // WRITE SIDE — the DocumentService command replaces the image's data
          // URI and triggers a redraw (the per-frame write the loop repeats).
          recolorPalette({ commit }, { imageDataId, dataUri: newColorDataUri });
          console.log('[URI_CHANGE_COLOR] replaced image data for', imageDataId);

          // Update progress after each frame
          commit(SET_UPDATED_COLORS_PROGRESS, {
            numTotal: recolorTargets.length,
            numFinished: k + 1,
          });

          const colorChangeEndTime = Date.now();
          timeDiff = colorChangeEndTime - colorChangeStartTime;
        } // done with all image data changes
      } else {
        console.warn('[URI_CHANGE_COLOR] Skipping pixel update: no color images to recolor.');
      }
      // if we committed changes to all frames, reset the palette items
      const colorsToDelete = [];
      if (allFrames) {
        for (let c = 0; c < colorPalette.length; c += 1) {
          colorPalette[c].hex = colorPalette[c].newHex;
          colorPalette[c].opacity = colorPalette[c].newOpacity;
          colorPalette[c].visible = colorPalette[c].newVisible;
          if (colorPalette[c].newVisible === false) {
            colorsToDelete.push(c);
          }
        }
        // remove colors
        if (colorsToDelete.length) {
          console.log('[URI_CHANGE_COLOR] removing invisible colors from palette:', colorsToDelete);
          await dispatch(REMOVE_MULTIPLE_COLOR_SWATCHES, { colorsToDelete });
        }
        // and remove duplicate swatches
        /* eslint-disable-next-line */
        const reducedPalette = removeDuplicates(colorPalette);
        // console.log('reducedPalette: ', reducedPalette);
        colorPalette.length = 0;
        for (let p = 0; p < reducedPalette.length; p += 1) {
          colorPalette.push(reducedPalette[p]);
        }
        // colorPalette = reducedPalette;
      } // done resetting colorPalette to noChanges, previewMode is now False
      // commit(SET_SELECTED_FRAME_NUMBER, startFrame);
      await commit(SET_PALETTE_EVENT_OCCURRED, true);
      function removeDuplicates(array) {
        let dupColor = false;
        const reducedArray = [];
        for (let q = 0; q < array.length; q += 1) {
          for (let z = 0; z < q; z += 1) {
            if (array[q].hex === array[z].hex) {
              dupColor = true;
            }
          }
          if (!dupColor) {
            reducedArray.push(array[q]);
          }
          dupColor = false;
        }
        return reducedArray;
      }
      console.log('[URI_CHANGE_COLOR] done.');
      
      resolve(true);
    });
    
    } catch (error) {
      console.error('[URI_CHANGE_COLOR] error:', error);
    }
    // Waiting-screen state (in-progress, task, progress) is reset by the
    // JobRunner's settle.
    console.log('[URI_CHANGE_COLOR] completed, waiting screen closed');
    }).catch((err) => {
      // runJob rejects before the executor runs when another job won the
      // isJobRunning race; the awaiting component has no catch, so surface it.
      if (err instanceof JobAlreadyRunningError) { showJobBusyDialog(); return; }
      throw err;
    });
  },


  [REMOVE_MULTIPLE_COLOR_SWATCHES]({ commit }, { colorsToDelete }) {
    // do a weird backwards count to remove colors because removing a color changes the index
    // console.log('removing ', colorsToDelete.length, ' colors');
    for (let i = (colorsToDelete.length - 1); i >= 0; i -= 1) {
      commit(DELETE_COLOR_FROM_PALETTE, colorsToDelete[i]);
    }
  },


  [SOLO_COLOR_IN_PALETTE]({ getters, commit }, { i }) {
    const colorPalette = getters[COLOR_PALETTE];
    // console.log(colorPalette);
    for (let k = 0; k < colorPalette.length; k += 1) {
      if (k !== i) {
        commit(TOGGLE_SWATCH_VISIBILITY, k);
      }
      // console.log('color ', k, ' newVisible: ', getters[COLOR_PALETTE][k].newVisible);
      // console.log('color ', k, ' visible: ', getters[COLOR_PALETTE][k].visible);
    }
    return true;
  },

  [CYCLE_SWATCH]() {
    cycleColorSwatch();
  },

  // The frame context menu's "Reference Frame" toggle. An ACTION (not inline
  // commits in context-menu.js) so the undo plugin can put a boundary around
  // it — originality flips change what future colorizes use as references.
  [TOGGLE_FRAME_ORIGINALITY]({ getters, commit, dispatch }, { layerId, frameNr, isOriginal }) {
    const frameNrsWithSameImageData = getters[FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID]({
      layerId, frameNr,
    });
    frameNrsWithSameImageData.forEach((fNr) => {
      commit(SET_FRAME_ORIGINAL, { layerId, frameNr: fNr, isOriginal });
    });
    dispatch(CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER, { layerId });
    dispatch(FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES, { layerId });
  },

  // The reference panel's delete button. An ACTION for the same reason as
  // above (undo boundary); reverse loop so splicing doesn't skip entries.
  [DELETE_SELECTED_REFERENCE_IMAGES]({ state, commit }) {
    for (let i = state.referenceImages.length - 1; i >= 0; i -= 1) {
      if (state.referenceImages[i].selected === true) {
        commit(DELETE_FILE_FROM_REFERENCE_FILES, i);
      }
    }
  },

  [POPULATE_PALETTE]({ getters, commit }, { resp }) {
    // Delegates to the DocumentService `mergePalette` command: `extractPaletteRgba`
    // picks the palette array out of whatever response shape arrived; the command
    // dedupes (via the pure mergePaletteRgba core) and commits one
    // ADD_COLOR_TO_PALETTE per genuinely-new swatch.
    mergePalette({ getters, commit }, extractPaletteRgba(resp));
  },
};
