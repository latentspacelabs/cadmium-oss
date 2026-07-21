/**
 * ColorizeService — the reference-guided colorization pipeline.
 *
 * This module owns the multi-step server conversation and shapes the raw
 * responses into a stable result the store action can act on. It is free of
 * Vuex, Electron and DOM so it can be reasoned about (and tested) in isolation;
 * the store action stays responsible for frame selection, segmentation-map
 * generation, canvas rendering and state bookkeeping.
 *
 * Reference model: references are an ordered `refs` array threaded straight
 * through to a `references: [...]` request body and on to the server handlers.
 * Exactly one reference is sent today (the AnT v2 tokenizer consumes one), but
 * the whole path — this service, the request contract, the handlers, and the
 * model's list-shaped `PartialSequence` — is already a collection, so enabling
 * two-reference colorization is a matter of populating the array, not reshaping
 * the plumbing.
 */
import { colorizeOnServer, raaOnServer } from '@/util/colorization-via-server';
import { MODAL_RESPONSES } from '@/util/modal';

// Result status. OK means the payload fields are populated; anything else is a
// terminal condition whose user-facing dialog (if any) the server layer has
// already surfaced.
export const COLORIZE_STATUS = {
  OK: 'ok',
  CANCELED: MODAL_RESPONSES.CANCELED,
  NO_INTERNET: MODAL_RESPONSES.NO_INTERNET,
  SERVER_ERROR: MODAL_RESPONSES.SERVER_ERROR,
};

const SENTINELS = new Set([
  MODAL_RESPONSES.CANCELED,
  MODAL_RESPONSES.NO_INTERNET,
  MODAL_RESPONSES.SERVER_ERROR,
]);

// The server helpers return either a data object (success) or one of the
// MODAL_RESPONSES sentinel strings on failure (and, defensively, we treat a
// falsy response as a server error).
function statusOf(resp) {
  if (!resp) return COLORIZE_STATUS.SERVER_ERROR;
  if (typeof resp === 'string' && SENTINELS.has(resp)) return resp;
  return COLORIZE_STATUS.OK;
}

/**
 * Colorize a single target frame from one or more reference frames.
 *
 * @param {object}   p
 * @param {string}   p.projectId
 * @param {object[]} p.refs    Ordered reference frames, each
 *                             { colorRaw, segMapRaw, lineRaw } (raw base64, no
 *                             `data:` prefix). Length 1 today; this array is the
 *                             two-reference seam.
 * @param {object}   p.target  Target frame: { lineRaw, segMapRaw } (raw base64).
 * @param {boolean}  p.isAutoAlpha
 * @param {number}   p.lineThreshold
 * @returns {Promise<{
 *   status: string,
 *   targetColorsRgba?: number[][],
 *   targetPaletteRgba?: number[][],
 *   preprocessPaletteRgba?: number[][],
 *   refPreprocessed?: string,
 *   targetWarped?: string,
 *   raw?: object,
 * }>}
 */
export async function colorizeFrame({
  projectId, refs, target, isAutoAlpha, lineThreshold,
}) {
  // 1. Preprocess the reference colour image(s) to build an accurate
  //    segment -> rgba palette. Today the server preprocesses the first
  //    reference; multi-reference support fans this out per reference.
  const pre = await raaOnServer({
    projectId,
    references: refs.map((r) => ({
      segMapUri: r.segMapRaw,
      colorImageUri: r.colorRaw,
      lineImageUri: null,
    })),
    imgReturn: false,
    is_auto_alpha: isAutoAlpha,
    line_threshold: lineThreshold,
  });
  const preStatus = statusOf(pre);
  if (preStatus !== COLORIZE_STATUS.OK) return { status: preStatus };

  // 2. Colorize the target using the reference palette.
  const resp = await colorizeOnServer({
    projectId,
    references: refs.map((r) => ({
      segMapUri: r.segMapRaw,
      lineImageUri: r.lineRaw,
      colorsRgba: pre.ref_palette_rgba,
    })),
    targetSegMapDataUri: target.segMapRaw,
    targetLineDataUri: target.lineRaw,
  });
  const respStatus = statusOf(resp);
  if (respStatus !== COLORIZE_STATUS.OK) return { status: respStatus };

  return {
    status: COLORIZE_STATUS.OK,
    targetColorsRgba: resp.target_colors_rgba,
    targetPaletteRgba: resp.target_palette_rgba,
    // The OSS /colorize handler never returns `target_palette_rgba`, so the
    // legacy `targetPaletteRgba` palette path is effectively dead. The palette
    // the run actually needs comes from the /preprocess step above
    // (`pre.ref_palette_rgba`, i.e. preprocess.py's `palette_rgba`). Surfacing
    // it here lets `runColorize` merge it into the document palette instead of
    // discarding it — the structural fix for the empty-palette bug.
    preprocessPaletteRgba: pre.ref_palette_rgba,
    refPreprocessed: resp.ref_preprocessed,
    targetWarped: resp.target_warped,
    raw: resp,
  };
}

/**
 * Analyze a reference frame: preprocess only, returning the extracted palette
 * and a cleaned-up ("preprocessed") reference image. Used when the user brings
 * in a colour frame to use as a reference.
 *
 * @param {object}  p
 * @param {string}  p.projectId
 * @param {object}  p.ref   Reference frame: { colorRaw, segMapRaw, lineRaw }
 *                          (raw base64).
 * @param {boolean} p.isAutoAlpha
 * @param {number}  p.lineThreshold
 * @returns {Promise<{
 *   status: string,
 *   refPaletteRgba?: number[][],
 *   refPreprocessed?: string,
 *   raw?: object,
 * }>}
 */
export async function analyzeReference({
  projectId, ref, isAutoAlpha, lineThreshold,
}) {
  const resp = await raaOnServer({
    projectId,
    references: [{
      segMapUri: ref.segMapRaw,
      colorImageUri: ref.colorRaw,
      lineImageUri: ref.lineRaw,
    }],
    imgReturn: true,
    is_auto_alpha: isAutoAlpha,
    line_threshold: lineThreshold,
  });
  const status = statusOf(resp);
  if (status !== COLORIZE_STATUS.OK) return { status };
  return {
    status: COLORIZE_STATUS.OK,
    refPaletteRgba: resp.ref_palette_rgba,
    refPreprocessed: resp.ref_preprocessed,
    raw: resp,
  };
}
