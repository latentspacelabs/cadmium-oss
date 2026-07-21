/**
 * xsheet — the pure read-model over the animation timeline.
 *
 * The domain fact "these frames show the same drawing" is currently
 * re-derived in several dialects across the store, components, and the undo
 * plugin (the architecture doc calls this bug factory F3). This module is the
 * one place that answers drawing-identity / hold-block questions, as pure
 * functions over the plain `state.layers` dict shape:
 *
 *   layers = { [layerId]: { frames, type, linkedLayerId, visible } }
 *   frames is an array indexed by frame number; frames[frameNr] is
 *     { imageDataId, isOriginal, isSelected, isLoading, ... } | null
 *
 * Everything here takes that plain data (never the Vuex store) and returns
 * plain data, so the semantics can be locked down by golden tests. The store
 * getters keep their signatures and delegate their bodies here.
 *
 * Per docs/architecture.md §2.1 the single line+color pair
 * (lineLayer1/colorLayer1) is a permanent assumption, so `celAt` and the
 * ghost-frame fallback address the two layers by their fixed ids rather than
 * carrying track plumbing.
 *
 * This is a behaviour-preserving extraction. `framesShareDrawing` is an exact
 * port of the FRAMES_HAVE_SAME_IMAGE_DATA_ID getter, quirks included:
 *  - the guard paths that console.warn and return false;
 *  - the ghost-frame fallback: if the FIRST requested frame exists but has no
 *    imageDataId, identity is decided from the LINKED layer's imageDataIds,
 *    and every requested frame that is missing or DOES have an imageDataId
 *    contributes `false` to that comparison (so a mix of ghost and non-ghost
 *    frames can never be "same");
 *  - the normal path: all requested frames' imageDataId strictly equal.
 */

import {
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
} from '@/store/general-types';

export const LINE_LAYER_ID = INITIAL_LINE_LAYER_ID;
export const COLOR_LAYER_ID = INITIAL_COLOR_LAYER_ID;

/**
 * Exact port of the FRAMES_HAVE_SAME_IMAGE_DATA_ID getter. Returns true iff all
 * of `frameNrs` on `layerId` show the same drawing. See the module header for
 * the ghost-frame fallback semantics preserved here.
 *
 * @param {Object} layers - the state.layers dict
 * @param {string} layerId
 * @param {Array<number>} frameNrs
 * @returns {boolean}
 */
export function framesShareDrawing(layers, layerId, frameNrs) {
  const layer = layers[layerId];
  if (!layer) { console.warn(`Could not find a layer with ID ${layerId}`); return false; }
  const { frames } = layer;
  if (!frames) { console.warn('Layer has no frames'); return false; }
  if (!Array.isArray(frameNrs) || frameNrs.length === 0) { console.warn(`Param frameNrs is not an Array, or an empty Array: ${frameNrs}`); return false; }

  // Check if we're dealing with ghost frames (frames with no imageDataId)
  const firstFrame = frames[frameNrs[0]];
  if (firstFrame && !firstFrame.imageDataId) {
    // For ghost frames, check if their linked frames have the same imageDataId
    const linkedLayerId = layerId === LINE_LAYER_ID ? COLOR_LAYER_ID : LINE_LAYER_ID;
    const linkedLayer = layers[linkedLayerId];
    if (!linkedLayer || !linkedLayer.frames) { return false; }

    const linkedImageIds = frameNrs.map((frameNr) => {
      const frame = frames[frameNr];
      if (!frame || frame.imageDataId) { return false; } // Only consider ghost frames
      const linkedFrame = linkedLayer.frames[frameNr];
      if (!linkedFrame || !linkedFrame.imageDataId) { return false; }
      return linkedFrame.imageDataId;
    });

    const linkedImageIdsUniq = [...new Set(linkedImageIds)];
    if (linkedImageIdsUniq.length === 0 || !linkedImageIdsUniq[0]) { return false; }
    return linkedImageIdsUniq.length === 1;
  }

  // Original logic for frames with imageDataId
  const imageIds = frameNrs.map((frameNr) => {
    const frame = frames[frameNr];
    if (!frame) { return false; } // frame does not exist
    if (!frame.imageDataId) { return false; }
    return frame.imageDataId;
  });
  const imageIdsUniq = [...new Set(imageIds)];
  if (imageIdsUniq.length === 0 || !imageIdsUniq[0]) { return false; }
  return imageIdsUniq.length === 1;
}

/**
 * Indices of every real (non-null) frame on a layer, ascending.
 */
function realFrameNrs(frames) {
  const result = [];
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i]) { result.push(i); }
  }
  return result;
}

/**
 * Runs of CONSECUTIVE frame numbers (in the given order) that share the same
 * imageDataId. Non-consecutive reuse of the same drawing yields separate
 * blocks. Frames that are null/missing or have no imageDataId break a run and
 * are excluded from all blocks.
 *
 * @param {Object} layers - the state.layers dict
 * @param {string} layerId
 * @param {Array<number>} [frameNrs] - order to scan; defaults to all real
 *   frames on the layer, ascending.
 * @returns {Array<{ imageDataId: string, frameNrs: number[] }>}
 */
export function holdBlocks(layers, layerId, frameNrs) {
  const layer = layers[layerId];
  if (!layer || !layer.frames) { return []; }
  const { frames } = layer;
  const order = frameNrs || realFrameNrs(frames);

  const blocks = [];
  let current = null;
  let prevFrameNr = null;

  order.forEach((frameNr) => {
    const frame = frames[frameNr];
    const imageDataId = frame && frame.imageDataId;
    if (!imageDataId) {
      // null / missing / no imageDataId breaks the run
      current = null;
      prevFrameNr = null;
      return;
    }
    const consecutive = prevFrameNr !== null && frameNr === prevFrameNr + 1;
    if (current && current.imageDataId === imageDataId && consecutive) {
      current.frameNrs.push(frameNr);
    } else {
      current = { imageDataId, frameNrs: [frameNr] };
      blocks.push(current);
    }
    prevFrameNr = frameNr;
  });

  return blocks;
}

/**
 * Map of imageDataId -> frameNrs[], insertion-ordered by first occurrence.
 * Null/missing frames and frames without an imageDataId are skipped.
 *
 * @param {Object} layers - the state.layers dict
 * @param {string} layerId
 * @param {Array<number>} frameNrs
 * @returns {Map<string, number[]>}
 */
export function uniqueDrawings(layers, layerId, frameNrs) {
  const result = new Map();
  const layer = layers[layerId];
  if (!layer || !layer.frames || !Array.isArray(frameNrs)) { return result; }
  const { frames } = layer;

  frameNrs.forEach((frameNr) => {
    const frame = frames[frameNr];
    const imageDataId = frame && frame.imageDataId;
    if (!imageDataId) { return; }
    if (result.has(imageDataId)) {
      result.get(imageDataId).push(frameNr);
    } else {
      result.set(imageDataId, [frameNr]);
    }
  });

  return result;
}

/**
 * The cel exposed at a frame number: the line and color drawing ids for that
 * frame. Each id is the frame's imageDataId, or null when the frame is
 * absent/null/has no id. Returns null when BOTH are absent.
 *
 * @param {Object} layers - the state.layers dict
 * @param {number} frameNr
 * @returns {{ frameNr: number, lineImageId: (string|null), colorImageId: (string|null) } | null}
 */
export function celAt(layers, frameNr) {
  const idOnLayer = (layerId) => {
    const layer = layers[layerId];
    if (!layer || !layer.frames) { return null; }
    const frame = layer.frames[frameNr];
    if (!frame || !frame.imageDataId) { return null; }
    return frame.imageDataId;
  };

  const lineImageId = idOnLayer(LINE_LAYER_ID);
  const colorImageId = idOnLayer(COLOR_LAYER_ID);
  if (lineImageId === null && colorImageId === null) { return null; }
  return { frameNr, lineImageId, colorImageId };
}
