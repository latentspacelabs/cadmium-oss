/* eslint-disable linebreak-style */
/* eslint-disable */
/*
 * Vuex undo / redo — Phase 6a (docs/architecture.md, kills bug factory F5).
 *
 * OLD model: on every undoable action `before`-hook, deep-clone (almost) the
 * whole state minus a hand-maintained `protectedStore` exclusion list, cap at
 * 5 for memory, and `replaceState` the clone back on undo while re-patching ~17
 * "protected" slices by hand. Every new state key was an undo bug by default.
 *
 * NEW model: store inverse PATCHES from a structural diff of a small, EXPLICIT
 * INCLUDE list of document slices (DIFF_SCOPE_KEYS). Anything outside that list
 * is, by definition, not undoable — so new state keys are safe by default
 * (the F5 fix is flipping the exclusion list into an inclusion list). Job /
 * progress / tool / session state lives outside the scope and therefore can
 * never be clobbered by an undo. No replaceState; patches apply mutation-style
 * via the APPLY_STATE_PATCH mutation (Vue.set/Vue.delete), so reactivity holds.
 *
 * BOUNDARIES: the diff scope is snapshotted at each undoable action's `before`
 * hook and finalized at the action's own settle (`after`/`error` hooks) — NOT
 * at the next undoable action, which would sweep unrelated later writes from
 * non-undoable paths (swatch-menu palette deletes, reference-image adds) into
 * the previous item. The one exception is CANVAS_ACTION: it is dispatched on
 * mouse-DOWN but its drawing reaches the store on mouse-UP
 * (MainPane.updateImageStore), long after the action settles, so MainPane
 * closes that boundary explicitly via `closeUndoBoundary()` after committing
 * the stroke. The next `before` hook and `undo()` remain backstops.
 */

import { cloneDeep } from 'lodash';

import {
  COLORIZE,
  ADD_IMAGES_TO_TIMELINE,
  HANDLE_DELETE_PRESS,
  CANVAS_ACTION,
  URI_CHANGE_COLOR,
  TOGGLE_FRAME_SELECTION,
  SELECT_ALL_LINE_FRAMES_FROM_MENU,
  SELECT_ALL_COLOR_FRAMES_FROM_MENU,
  DESELECT_ALL_FRAMES_FROM_MENU,
  REMOVE_MULTIPLE_COLOR_SWATCHES,
  SOLO_COLOR_IN_PALETTE,
  LOAD_REFERENCE_FILE,
  DELETE_SELECTED_REFERENCE_IMAGES,
  TOGGLE_FRAME_ORIGINALITY,
} from '@/store/action-types';

import { APPLY_STATE_PATCH } from '@/store/mutation-types';

import { diff } from '@/services/state-patch';

import UndoRedoStack from './UndoRedoStack';

import UndoRedoItem from './UndoRedoItem';
// The fresh-project defaults. Legacy .cdm files missing a field should adopt
// today's default, so the backfill reads from here rather than duplicating the
// literals (which is how they silently drifted: maxAiDilationSize 30 vs 8, etc.).
import defaultState from './state';

// Patches are cheap (only touched values are retained), so we can afford a much
// deeper history than the old whole-clone model allowed.
const MAX_UNDO_ITEMS = 20;

// Selection actions are undoable too, with two twists (see the hooks below):
// consecutive selection actions COALESCE into one undo item (a click-spree on
// the timeline — dupe-linked, so one click can flip dozens of frames — walks
// back with one ⌘Z, and the 20-item history isn't flooded), and a selection
// item's patches are FILTERED to `isSelected` ops only, so nothing else can be
// swept into the item while its boundary sits open across the run.
const selectionActions = [
  TOGGLE_FRAME_SELECTION,
  SELECT_ALL_LINE_FRAMES_FROM_MENU,
  SELECT_ALL_COLOR_FRAMES_FROM_MENU,
  DESELECT_ALL_FRAMES_FROM_MENU,
];

// Actions whose document-state changes are undoable. Their before-hook opens an
// undo boundary; the diff is finalized at the next boundary (see file header).
// The 2026-07-19 audit closed the component-initiated gaps: swatch-menu color
// removal, the frame context menu's originality toggle, and reference-panel
// add/delete now route through the actions below instead of raw commits.
const undoableActions = [
  COLORIZE,
  ADD_IMAGES_TO_TIMELINE,
  HANDLE_DELETE_PRESS,
  CANVAS_ACTION,
  URI_CHANGE_COLOR,
  REMOVE_MULTIPLE_COLOR_SWATCHES,
  SOLO_COLOR_IN_PALETTE,
  LOAD_REFERENCE_FILE,
  DELETE_SELECTED_REFERENCE_IMAGES,
  TOGGLE_FRAME_ORIGINALITY,
  ...selectionActions,
];

/*
 * DIFF_SCOPE_KEYS — the INCLUDE list. Only these top-level state slices are
 * diffed; everything else is intentionally never undone. Each entry is
 * justified by the mutation(s) the five undoable actions (and their sub-
 * dispatches) commit against it:
 *
 *  - layers              frame objects & sparse `frames` arrays:
 *                        SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
 *                        CREATE_EMPTY_FRAME_IF_NONE_EXISTS, DELETE_SELECTED_FRAMES,
 *                        SET_FRAME_ORIGINAL, SET_FRAME(S)_SELECTED,
 *                        SET_REF_FRAMES_FOR_FRAME (imageDataId / isOriginal /
 *                        isSelected / isLoading / refFrame* fields).
 *  - layerGroups         line<->reference layer pairing (document structure).
 *                        Rarely touched by these five, included for parity with
 *                        the old model (empty diff when unchanged; tiny).
 *  - colorPalette        ADD_COLOR_TO_PALETTE / CLEAR_COLOR_PALETTE /
 *                        DELETE_COLOR_FROM_PALETTE / swatch visibility — COLORIZE
 *                        populates it, URI_CHANGE_COLOR prunes invisible colors.
 *  - firstRealFrameNumber / lastRealFrameNumber
 *                        set while importing frames (SET_IMAGE_DATA_FOR_FRAME_WITH_ID
 *                        and the frame-range recompute).
 *  - tempFilePaths       SET_TEMP_FILE_PATHS (segmentation/colorize temp files).
 *  - referenceImages     reference library; included for parity (old restored it).
 *  - ImageStore          the module state -> imageDataById dict:
 *                        ADD_NEW_IMAGE_TO_IMAGE_STORE (new entry),
 *                        REPLACE_IMAGE_DATA_URI (in-place dataUri/hash edit),
 *                        REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID (null-out/decrement),
 *                        SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID, usage counts.
 *
 * Deliberately OUT of scope (the F5 fix): every job/progress/in-flight flag
 * (colorizationInProgress, *Progress, currentProcessingTask, numberOfImages*,
 * *CanceledByUser, exportInProgress, ...), tool modules (FillTool/PenTool/...),
 * UI/session keys (selectedFrame, activeLayerId, *Collapse, timeline*,
 * player*), and persistence flags (unsavedChanges, currentFile,
 * canvasRedrawTrigger). The old model RESTORED many of these on undo, which is
 * exactly what produced stale in-flight fields after an undo.
 *
 * canvasWidth/canvasHeight/canvasScale ARE in scope: ADD_IMAGES_TO_TIMELINE
 * resizes the canvas on first import, and the canvas size is document state
 * (persisted in the .cdm) — undoing that import must restore it.
 */
export const DIFF_SCOPE_KEYS = [
  'layers',
  'layerGroups',
  'colorPalette',
  'firstRealFrameNumber',
  'lastRealFrameNumber',
  'tempFilePaths',
  'referenceImages',
  'ImageStore',
  'canvasWidth',
  'canvasHeight',
  'canvasScale',
];

let undoRedoStack;
let vuexStore;

// The open boundary: a private deep clone of the diff scope taken at the last
// undoable action's `before` hook, plus its name. `null` when no boundary is
// open.
//
// WHEN a boundary closes (diffed against live state):
//  - for every undoable action except CANVAS_ACTION: at the action's own
//    settle (`after`/`error` hook) — so writes from NON-undoable paths that
//    happen later (a swatch-menu palette delete, a reference-image add) can
//    never be swept into the previous action's undo item;
//  - CANVAS_ACTION commits its drawing on mouse-UP, long after the action
//    settles, so its boundary closes when MainPane's mouse-up handler calls
//    `closeUndoBoundary()` right after committing the stroke;
//  - the next undoable action's `before` hook and `undo()` remain backstops.
let pendingBefore = null;

/**
 * Converts a mutation or action name (as used in mutation-types.js / action-types.js)
 * to a human readable name, e.g. 'colorize_foo' —> 'Colorize Foo'.
 * @param {string} name - Mutation or action name, e.g. 'colorize_foo'
 * @returns {string} - Beautified name, e.g. 'Colorize Foo'
 */
function beautifyMutationOrActionName(name) {
  if (!name) { console.warn('No name passed.'); return ''; }
  return name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Private deep clone of just the in-scope slices. cloneDeep shares the (large,
// immutable) dataUri strings, so this costs the small container objects only.
function snapshotScope(state) {
  const snapshot = {};
  for (let i = 0; i < DIFF_SCOPE_KEYS.length; i += 1) {
    const key = DIFF_SCOPE_KEYS[i];
    snapshot[key] = cloneDeep(state[key]);
  }
  return snapshot;
}

// The redoPatch's `set` values are read straight off live state, which can be
// mutated in place later (e.g. an added image object whose dataUri is replaced).
// Clone them so a stored patch is immune to later edits. undoPatch values come
// from the already-private before-snapshot, so they need no cloning.
function detachSetValues(patch) {
  for (let i = 0; i < patch.length; i += 1) {
    const op = patch[i];
    if (op.op === 'set') { op.value = cloneDeep(op.value); }
  }
}

// Close the open boundary: diff the before-snapshot against live state and, if
// anything in scope changed, push one undo item carrying both patches.
function finalizePending() {
  if (!pendingBefore) { return; }
  const before = pendingBefore.snapshot;
  const { name, readableName, isSelection } = pendingBefore;
  pendingBefore = null;

  let { undoPatch, redoPatch } = diff(before, vuexStore.state, DIFF_SCOPE_KEYS);
  if (!redoPatch) { return; } // empty diff -> push nothing

  if (isSelection) {
    // A selection boundary stays open across a click run, so unrelated writes
    // (a swatch-menu palette delete, a reference add) may land while it is
    // open. Keep only the `isSelected` ops: the item undoes selection and
    // nothing else. A net no-op run (toggle on, toggle off) pushes nothing.
    const selOnly = (op) => op.path[op.path.length - 1] === 'isSelected';
    undoPatch = undoPatch.filter(selOnly);
    redoPatch = redoPatch.filter(selOnly);
    if (redoPatch.length === 0) { return; }
  }

  detachSetValues(redoPatch);
  undoRedoStack.addUndoItem(new UndoRedoItem({
    undoPatch,
    redoPatch,
    name,
    readableName,
    type: 'action',
  }));
}

export default function undoRedoPlugin(store) {
  undoRedoStack = new UndoRedoStack(store, MAX_UNDO_ITEMS);
  vuexStore = store;
  pendingBefore = null;

  store.subscribeAction({
    before: (action) => {
      if (!undoableActions.includes(action.type)) { return; }
      const isSelection = selectionActions.includes(action.type);
      // A selection action never STEALS an open boundary:
      //  - open selection boundary → coalesce the run into it (its
      //    before-snapshot is the run's undo target; the redo stack was
      //    already cleared when the run began);
      //  - open NON-selection boundary → the selection is a programmatic
      //    sub-step of that action (COLORIZE normalizes selection via
      //    TOGGLE_FRAME_SELECTION, ANALYZE_CURRENT_FRAME — reached from the
      //    paint-bucket fill and import — leads with DESELECT_ALL). Stealing
      //    the boundary would finalize the enclosing item half-done and dump
      //    its remaining writes into a selection item whose isSelected-only
      //    filter DISCARDS them (the fill-undo regression). Absorb instead:
      //    the selection change rides along in the enclosing item, exactly
      //    like the pre-selection-undo model.
      if (isSelection && pendingBefore) { return; }
      // Finalize any previous boundary (backstop), then open a new one. A new
      // undoable action invalidates the redo history, same as the old model.
      finalizePending();
      undoRedoStack.clearRedoStack();
      pendingBefore = {
        snapshot: snapshotScope(store.state),
        name: action.type,
        readableName: isSelection ? 'Select Frames' : beautifyMutationOrActionName(action.type),
        isSelection,
      };
    },
    after: (action) => { finalizeAtSettle(action); },
    error: (action) => { finalizeAtSettle(action); },
  });
}

// Close the boundary when its own action settles — except CANVAS_ACTION, whose
// drawing only reaches the store on mouse-up (see closeUndoBoundary), and
// selection actions, whose boundary stays open so the next selection in the
// run can coalesce into it (safe because selection patches are filtered to
// `isSelected` ops at finalize — nothing else can leak in while it's open).
function finalizeAtSettle(action) {
  if (action.type === CANVAS_ACTION) { return; }
  if (selectionActions.includes(action.type)) { return; }
  if (pendingBefore && pendingBefore.name === action.type) { finalizePending(); }
}

/**
 * Close the currently open undo boundary, if any. Called by MainPane's
 * mouse-up handler after it commits the stroke to the ImageStore — the one
 * writer whose effects land after its action (CANVAS_ACTION) has settled.
 */
export function closeUndoBoundary() {
  finalizePending();
}

export function undo(ColorizationInProgress, UpdateColorsInProgress) {
  if (ColorizationInProgress || UpdateColorsInProgress) {
    console.log('cant undo while operation in progress', { ColorizationInProgress, UpdateColorsInProgress });
    return;
  }
  // Close the open boundary first so the most recent action is undoable even
  // though the next undoable action hasn't started yet.
  finalizePending();
  const item = undoRedoStack.popUndoItem();
  if (item) {
    vuexStore.commit(APPLY_STATE_PATCH, item.undoPatch);
    undoRedoStack.addRedoItem(item);
  }
}

export function redo(ColorizationInProgress, UpdateColorsInProgress) {
  if (ColorizationInProgress || UpdateColorsInProgress) {
    console.log('cant redo while operation in progress', { ColorizationInProgress, UpdateColorsInProgress });
    return;
  }
  // No finalize here: redo only follows an undo, and any new undoable action
  // since then would have cleared the redo stack in its before-hook.
  const item = undoRedoStack.popRedoItem();
  if (item) {
    vuexStore.commit(APPLY_STATE_PATCH, item.redoPatch);
    undoRedoStack.addUndoItem(item);
  }
}

export function loadcdm(stateObject) {
  const newState = stateObject;
  for (let i = 0; i < newState.colorPalette.length; i += 1) {
    if (!newState.colorPalette[i].newHex) {
      newState.colorPalette[i].newHex = newState.colorPalette[i].hex;
    }
    if (!newState.colorPalette[i].opacity) {
      newState.colorPalette[i].opacity = 255;
    }
    if (!newState.colorPalette[i].newOpacity) {
      newState.colorPalette[i].newOpacity = newState.colorPalette[i].opacity;
    }
    if (!newState.colorPalette[i].visible) {
      newState.colorPalette[i].visible = true;
    }
    if (!newState.colorPalette[i].newVisible) {
      // console.log('ADDING NEW HEX');
      newState.colorPalette[i].newVisible = newState.colorPalette[i].visible;
    }
  }
  if (!newState.canvasRedrawTrigger) {
    newState.canvasRedrawTrigger = 0;
  }
  // isLoading is session state, not document state: a project saved while a
  // colorize was in flight carries stale true flags that would render as
  // permanent spinners after load. Clear them on every frame of every layer.
  Object.keys(newState.layers || {}).forEach((layerId) => {
    const { frames } = newState.layers[layerId];
    if (!frames) { return; }
    Object.keys(frames).forEach((frameNr) => {
      if (frames[frameNr] && frames[frameNr].isLoading) {
        frames[frameNr].isLoading = false;
      }
    });
  });
  // Backward-compat for newer playback fields
  if (typeof newState.playerFps === 'undefined' || !newState.playerFps) {
    newState.playerFps = 24;
  }
  if (typeof newState.playerLoopEnabled === 'undefined') {
    newState.playerLoopEnabled = false;
  }
  if (typeof newState.playerLoopIn === 'undefined') {
    newState.playerLoopIn = null;
  }
  if (typeof newState.playerLoopOut === 'undefined') {
    newState.playerLoopOut = null;
  }

  // Normalize loop/playhead bounds for legacy files
  const toInt = (v) => (typeof v === 'string' ? parseInt(v, 10) : v);
  const isPositiveInt = v => Number.isInteger(v) && v > 0;

  

  // Compute usable index bounds by scanning layers (UI uses index-based positions)
  let foundMin = Number.POSITIVE_INFINITY;
  let foundMax = 0;
  try {
    if (newState.layers) {
      const layerList = Object.values(newState.layers);
      layerList.forEach((layer) => {
        if (!layer || !Array.isArray(layer.frames)) { return; }
        for (let i = 0; i < layer.frames.length; i += 1) {
          const f = layer.frames[i];
          if (f) {
            foundMin = Math.min(foundMin, i);
            foundMax = Math.max(foundMax, i);
          }
        }
      });
    }
  } catch (e) {
    // ignore
  }
  if (!isFinite(foundMin)) { foundMin = 1; }
  if (foundMax < foundMin) { foundMax = foundMin; }

  // UI clamps based on index domain starting at 1
  const minFrame = 1;
  const maxFrame = Math.max(1, foundMax || (Number.isInteger(newState.timelineFrames) ? newState.timelineFrames : 1));

  // Ensure timelineFrames can display all frames
  if (!Number.isInteger(newState.timelineFrames) || newState.timelineFrames < maxFrame) {
    newState.timelineFrames = Math.max(maxFrame, 1);
  }

  // Clamp/validate loop range
  newState.playerLoopIn = toInt(newState.playerLoopIn);
  newState.playerLoopOut = toInt(newState.playerLoopOut);
  const hasIn = isPositiveInt(newState.playerLoopIn);
  const hasOut = isPositiveInt(newState.playerLoopOut);
  if (hasIn && hasOut) {
    let loopIn = Math.max(minFrame, Math.min(maxFrame, newState.playerLoopIn));
    let loopOut = Math.max(minFrame, Math.min(maxFrame, newState.playerLoopOut));
    if (loopOut < loopIn) {
      // invalid range: reset
      newState.playerLoopIn = null;
      newState.playerLoopOut = null;
      newState.playerLoopEnabled = false;
    } else {
      newState.playerLoopIn = loopIn;
      newState.playerLoopOut = loopOut;
    }
  } else {
    // One or both are missing: disable loop and reset to nulls
    newState.playerLoopIn = null;
    newState.playerLoopOut = null;
    // keep enabled flag as-is if user toggles later; but ensure no invalid active loop
    if (newState.playerLoopEnabled) {
      newState.playerLoopEnabled = false;
    }
  }

  // Clamp selectedFrame playhead into valid range
  if (!isPositiveInt(toInt(newState.selectedFrame))) {
    newState.selectedFrame = minFrame;
  } else {
    newState.selectedFrame = Math.max(minFrame, Math.min(maxFrame, toInt(newState.selectedFrame)));
  }

  // Ensure we have a valid active layer to avoid null layer lookups
  try {
    const hasActive = newState.activeLayerId && newState.layers && newState.layers[newState.activeLayerId];
    if (!hasActive && newState.layers) {
      if (newState.layers.lineLayer1) {
        newState.activeLayerId = 'lineLayer1';
      } else if (newState.layers.colorLayer1) {
        newState.activeLayerId = 'colorLayer1';
      }
    }
  } catch (e) { /* noop */ }

  
  if (newState.PenTool.diameter) {
    newState.PenTool.penDiameter = newState.PenTool.diameter;
  }
  if (!newState.EraserTool) {
    newState.EraserTool = {
      eraserToolDiameter: 10,
    };
  }
  if (!newState.ToolControls.toolControlItems[6]) {
    newState.ToolControls.toolControlItems[6] = {
      id: 'eraser',
      isCanvasTool: true,
      isVisible: false,
    };
  }
  if (!newState.ToolControls.toolControlItems[7]) {
    newState.ToolControls.toolControlItems[7] = {
      id: 'referencepanel',
      isCanvasTool: false,
      isVisible: false,
    };
  }
  if (!newState.ToolControls.toolControlItemIds[6]) {
    newState.ToolControls.toolControlItemIds[6] = 'eraser';
  }
  if (!newState.ToolControls.toolControlItemIds[7]) {
    newState.ToolControls.toolControlItemIds[7] = 'referencepanel';
  }
  if (!newState.referenceImages) {
    newState.referenceImages = [];
  }
  if (!newState.refCanvasWidth) {
    newState.refCanvasWidth = 0;
  }
  if (!newState.refCanvasHeight) {
    newState.refCanvasHeight = 0;
  }
  if (!newState.refWinHeight) {
    newState.refWinHeight = 200;
  }
  if (!newState.refWinWidth) {
    newState.refWinWidth = 200
  }
  if (!newState.refCanPos) {
    newState.refCanPos = {
      top: 0,
      left: 0,
    } ;
  }
  if (!newState.refCanScale) {
    newState.refCanScale = 0.75;
  }
  if (!newState.referenceCollapse) {
    newState.referenceCollapse = ['reference', 'library'];
  }
  if (!newState.lineThreshold) {
    newState.lineThreshold = 127;
  }
  if (!newState.maxAiDilationSize) {
    newState.maxAiDilationSize = defaultState.maxAiDilationSize;
  }
  if (!newState.maxTbDilationSize) {
    newState.maxTbDilationSize = defaultState.maxTbDilationSize;
  }
  if (!newState.minSegSize) {
    newState.minSegSize = defaultState.minSegSize;
  }
  if (!newState.segPanelHighlight) {
    newState.segPanelHighlight = false;
  }

  if (!newState.projectId) {
    newState.projectId = (Math.floor((Math.random() * (99999999 - 10000000)) + 10000000));
  }
  // Absent means the field predates autoAlpha — adopt the default. Only
  // backfill when it's not already a boolean so an explicit false is preserved
  // (same guard the aiGapCloserEnabled backfill uses).
  if (typeof newState.autoAlpha !== 'boolean') {
    newState.autoAlpha = defaultState.autoAlpha;
  }
  if (typeof newState.aiGapCloserEnabled !== 'boolean') {
    // Files saved before this field existed load a state object WITHOUT the
    // key; after replaceState Vue 2 can't make an absent property reactive,
    // so the SegOptions toggle looks dead (commits write a value no watcher
    // ever sees). Backfill with the fresh-app default.
    newState.aiGapCloserEnabled = true;
  }
  
  // Initialize progress states if they don't exist in the loaded file
  if (!newState.updatedColorsProgress) {
    newState.updatedColorsProgress = { numTotal: 0, numFinished: 0 };
  }

  // Reset UI states that should not persist when loading a project
  
  // Progress/Loading states
  newState.colorizationInProgress = false;
  newState.updateColorsInProgress = false;
  newState.exportInProgress = false;
  
  // Reset progress tracking (ensure clean state regardless of loaded values)
  // Note: updatedColorsProgress is reset with other progress states at the end of the function
  newState.fileDragNDropInProgress = false;
  newState.updateInProgress = false;
  newState.exportingColorsSeparately = false;
  
  // User interaction states
  newState.canvasToolActive = false;
  newState.playerIsPlaying = false;
  newState.playerInterval = null;
  
  // Cancel/Error states
  newState.fileImportCanceledByUser = false;
  newState.colorizationCanceledByUser = false;
  newState.updateColorsCanceledByUser = false;
  newState.analyzeCanceledByUser = false;
  newState.exportCanceledByUser = false;

  // Import/process tracking
  newState.lastImportedImageTooBig = false;
  newState.lastImportedImageHasDifferentDimensionsThanCanvas = false;
  newState.fileImportLayerType = null;
  newState.updatePercentage = 0;
  newState.estTimeRemaining = 0;
  newState.currentProcessingTask = 'TASK_NONE';
  
  // Analysis mode (should be preserved from loaded file, but ensure it exists)
  if (typeof newState.analyzeModeOnly === 'undefined') {
    newState.analyzeModeOnly = true; // Default value from state.js
  }
  
  // Counters that should reset
  newState.numberOfImagesToColorize = 0;
  newState.numberOfImagesColorized = 0;
  newState.numberOfImagesToExport = 0;
  newState.numberOfImagesExported = 0;
  
  // UI triggers and highlights
  newState.paletteEventOccurred = false;
  newState.segPanelHighlight = false;
  
  // Selection states (should reset to clean state)
  newState.lastSelectedFrameNr = -1; // INVALID_FRAME_NR
  newState.lastSelectedLayerId = null; // INVALID_LAYER_ID
  // Preserve or set a valid active layer; do not null this out for legacy files
  if (!newState.activeLayerId || !(newState.layers && newState.layers[newState.activeLayerId])) {
    if (newState.layers && newState.layers.lineLayer1) {
      newState.activeLayerId = 'lineLayer1';
    } else if (newState.layers && newState.layers.colorLayer1) {
      newState.activeLayerId = 'colorLayer1';
    } else {
      newState.activeLayerId = null;
    }
  }
  
  // Canvas interaction
  newState.canvasUndo = [];
  newState.canvasRedo = [];
  
  // File state
  newState.unsavedChanges = false; // Just loaded a file, so no unsaved changes

  // Reset progress states
  newState.colorizationProgress = {
    numTotal: 0,
    numFinished: 0,
  };
  newState.updatedColorsProgress = {
    numTotal: 0,
    numFinished: 0,
  };
  newState.exportProgress = {
    numTotal: 0,
    numFinished: 0,
  };

  // serverBackend is machine-local app config, not document state: never take
  // it from the file (a .cdm saved elsewhere would import that machine's
  // server URL), and re-seed it for files saved before the field existed.
  newState.serverBackend = vuexStore.state.serverBackend;

  vuexStore.replaceState(newState);

  // Loading a project is NOT an undoable edit; it swaps out the whole document.
  // The old whole-clone model left the undo/redo stacks intact across a load
  // (a latent bug — undoing would jump back into the previous project). With
  // the new relative patches that would be actively unsafe (a patch is diffed
  // against a base that no longer exists), so we clear both stacks and any open
  // boundary here. This is a deliberate, safe divergence from the old behavior.
  if (undoRedoStack) {
    undoRedoStack.clearUndoStack();
    undoRedoStack.clearRedoStack();
  }
  pendingBefore = null;
}
