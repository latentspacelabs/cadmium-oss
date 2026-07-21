/**
 * document — the DocumentService command layer (architecture doc §3.1, phase 6b).
 *
 * The Document (cels / exposures / palette) still LIVES in the existing Vuex
 * `state.layers` + `ImageStore` + palette (the storage flip is deferred — see
 * docs/architecture.md §4 and the cdm-format v2 flip seam). What this module
 * adds is the missing WRITE discipline: the multi-mutation sequences that the
 * orchestrators and actions used to open-code inline become *named,
 * intention-revealing commands*, each a `(store, payload)` function that runs
 * the SAME mutation sequence its call sites ran before (behaviour-preserving).
 *
 * This is the single-writer facade the architecture calls for, minus the patch
 * machinery (undo already landed as patch-based in P6a via state-patch.js). A
 * command:
 *   - takes a Vuex store OR an action ctx (`{ getters, commit, dispatch }`);
 *   - performs only store writes (+ the pure planners it wraps);
 *   - never opens a dialog, touches fs/Electron, or renders a canvas.
 *
 * Components keep reading Vuex getters directly — that is the documented READ
 * model. Only the write side is funnelled here.
 *
 * Per docs/architecture.md §2.1 the single line+color pair
 * (lineLayer1/colorLayer1) is a permanent assumption, so the commands address
 * the two layers by their fixed ids.
 */

import { INITIAL_LINE_LAYER_ID, INITIAL_COLOR_LAYER_ID } from '@/store/general-types';
import {
  SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
  ADD_COLOR_TO_PALETTE,
  REPLACE_IMAGE_DATA_URI,
  SET_CANVAS_REDRAW_TRIGGER,
} from '@/store/mutation-types';
import { STORE_BLANK_IMAGE_IN_IMAGE_STORE } from '@/store/action-types';
import { COLOR_PALETTE } from '@/store/getter-types';
import { mergePaletteRgba } from '@/services/palette-recolor';

export const LINE_LAYER_ID = INITIAL_LINE_LAYER_ID;
export const COLOR_LAYER_ID = INITIAL_COLOR_LAYER_ID;

/**
 * Expose a line drawing at a frame: set the line-layer image, and ensure the
 * paired color cel exists. Replaces the inline SET_IMAGE_DATA_FOR_FRAME_WITH_ID
 * + ghost pair in ADD_IMAGES_TO_TIMELINE's line branch (behaviour-preserving).
 *
 * GHOST DECISION (phase-6b investigation — kept, not dropped): the paired color
 * cel is created with a blank `<lineId>_color` image record and that id, exactly
 * as before. The audit (docs/architecture.md §4 and the phase report) found the
 * document/export/save/timeline consumers all null-safe, BUT the color-selected
 * getters (`COLOR_IMAGE_ID_FOR_SELECTED_FRAME` / `COLOR_IMAGE_FOR_SELECTED_FRAME`,
 * getters.js:283-302 / 260-281) carry a LINE-layer fallback that is masked only
 * by the ghost's non-null id. Dropping the ghost would activate that fallback
 * and make paint-bucket / freehand-draw / URI_CHANGE_COLOR overwrite the LINE
 * art (MainPane.vue:894-904, 1359-1379; actions.js write paths). So the ghost is
 * load-bearing until those getters return null for an id-less color cel; the
 * xsheet `framesShareDrawing` ghost-fallback branch stays dormant until then.
 *
 * Load-path parity: existing .cdm files already contain these ghost records; the
 * loader hydrates them verbatim regardless.
 *
 * @param {Object} store - Vuex store or action ctx ({ commit, dispatch }).
 * @param {Object} payload
 * @param {number} payload.frameNr
 * @param {string} payload.imageDataId - the line image id
 * @param {boolean} [payload.isOriginal]
 * @param {boolean} [payload.isLoading]
 */
export function exposeLineDrawing(store, {
  frameNr, imageDataId, isOriginal = false, isLoading = false,
}) {
  store.commit(SET_IMAGE_DATA_FOR_FRAME_WITH_ID, {
    imageDataId,
    frameNr,
    layerId: LINE_LAYER_ID,
    isOriginal,
    isLoading,
  });
  // Paired color cel: a blank `<lineId>_color` ghost image + a color frame
  // carrying that id (see GHOST DECISION above).
  const ghostColorId = `${imageDataId}_color`;
  store.dispatch(STORE_BLANK_IMAGE_IN_IMAGE_STORE, { imageDataId: ghostColorId });
  store.commit(CREATE_EMPTY_FRAME_IF_NONE_EXISTS, {
    frameNr,
    layerId: COLOR_LAYER_ID,
    imageDataId: ghostColorId,
  });
}

/**
 * Attach a color image to the cel at a frame (the colorize / import-color
 * write). A single SET on the color layer, but the shared write of four call
 * sites (colorize colorized / dupe / rainbow branches + the import-color
 * branch), so it earns a name.
 *
 * @param {Object} store - Vuex store or action ctx ({ commit }).
 * @param {Object} payload
 * @param {number} payload.frameNr
 * @param {string} payload.imageDataId - the color image id
 * @param {boolean} [payload.isOriginal]
 * @param {boolean} [payload.force] - overwrite an existing original frame
 */
export function attachColorToCel(store, {
  frameNr, imageDataId, isOriginal = false, force = false,
}) {
  store.commit(SET_IMAGE_DATA_FOR_FRAME_WITH_ID, {
    layerId: COLOR_LAYER_ID,
    imageDataId,
    frameNr,
    isOriginal,
    force,
  });
}

/**
 * Merge a palette-rgba array into the document palette, committing one
 * ADD_COLOR_TO_PALETTE per genuinely-new swatch. Idempotent (dedupe by hex via
 * the pure `mergePaletteRgba`), so re-merging the same reference adds nothing.
 *
 * Wraps colorize-run's `mergePaletteInto` and the POPULATE_PALETTE action.
 *
 * @param {Object} store - Vuex store or action ctx ({ getters, commit }).
 * @param {Array} paletteRgba - palette-rgba entries (already extracted).
 * @returns {number} how many swatches were added.
 */
export function mergePalette(store, paletteRgba) {
  const additions = mergePaletteRgba(store.getters[COLOR_PALETTE], paletteRgba);
  additions.forEach((swatch) => store.commit(ADD_COLOR_TO_PALETTE, swatch));
  return additions.length;
}

/**
 * Write one recolored color image back to the store (the per-frame write side of
 * URI_CHANGE_COLOR). The canvas pixel rewrite stays in the action — see the
 * palette-recolor.js header — this is only the store write it repeats per frame:
 * replace the image's data URI, then trigger a redraw. The unique-image set the
 * action feeds this is derived from `planRecolorTargets` (xsheet.uniqueDrawings),
 * not the old imageDataId-equality accumulator walk.
 *
 * @param {Object} store - Vuex store or action ctx ({ commit }).
 * @param {Object} payload
 * @param {string} payload.imageDataId
 * @param {string} payload.dataUri - the recolored data URI
 */
export function recolorPalette(store, { imageDataId, dataUri }) {
  store.commit(REPLACE_IMAGE_DATA_URI, { imageDataId, dataUri });
  store.commit(SET_CANVAS_REDRAW_TRIGGER);
}

// NOTE: the color-import branch of ADD_IMAGES_TO_TIMELINE still fabricates a
// `<colorId>_line` ghost so a color-first import has a line cel to pair with.
// That shape is untouched by phase 6b (only the `<lineId>_color` ghost was
// eliminated) and is intentionally left inline rather than wrapped here.
