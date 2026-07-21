/**
 * import-plan — the pure planning core of the image-import pipeline.
 *
 * ADD_IMAGES_TO_TIMELINE is a large, I/O-heavy action: it decodes images,
 * reads/writes the image store, drives canvas redraws, dispatches per-frame
 * analysis and mutates progress state in a strict order. Almost all of that
 * MUST stay in the action, because extracting it would reorder store
 * mutations or pull in fs/canvas/Vuex.
 *
 * A handful of genuinely pure DECISIONS were tangled inside that loop, though:
 *  - whether the queue is importable at all (empty vs too-many-frames),
 *  - whether an individual file's frame number is acceptable,
 *  - the canvas zoom-to-fit scale for the first imported image,
 *  - the "time remaining" estimate shown during the color-analysis pass.
 *
 * Those live here, free of fs/Vuex/Electron/DOM, and are locked down by golden
 * tests. The action keeps the dialogs, the decoding and all the I/O; it just
 * asks these functions what to do.
 *
 * This is a behaviour-preserving extraction. Two quirks are reproduced on
 * purpose (see the notes below):
 *  - planCanvasFit only ever applies heightScale when a widthScale also exists
 *    (a height-only overflow leaves scale null);
 *  - validateFrameNumber rejects frame numbers STRICTLY greater than 1000, even
 *    though the user-facing copy says "up to 999" (frame numbers are already
 *    +1'd by extractFrameNumberFromFilename, so 1000 on disk becomes 1001 and
 *    is rejected, but a filename numbered 999/1000 imports).
 */

// The queue-length verdicts returned by planImportQueue.
export const IMPORT_QUEUE_VERDICT = {
  OK: 'ok',
  EMPTY: 'empty',
  TOO_MANY: 'tooMany',
};

// Per-file frame-number verdicts returned by validateFrameNumber.
export const FRAME_NUMBER_VERDICT = {
  OK: 'ok',
  MISSING: 'missing',
  TOO_HIGH: 'tooHigh',
};

// The action currently sets this to Infinity, so the "too many" branch is
// effectively dead. Kept as the default so behaviour is identical, but exposed
// as a param/constant so the cap can be reinstated in one place.
export const NUM_SUPPORTED_FRAMES = Infinity;

/**
 * Decide whether a file-loading queue can be imported.
 *  - length 0        -> EMPTY   (action shows the "Unsupported File Type" dialog)
 *  - length > cap    -> TOO_MANY (action shows the "Too Many Frames" dialog)
 *  - otherwise       -> OK
 * With the default cap of Infinity, TOO_MANY never triggers — matching the
 * current action.
 *
 * @param {number} queueLength
 * @param {number} [maxFrames=NUM_SUPPORTED_FRAMES]
 * @returns {string} one of IMPORT_QUEUE_VERDICT
 */
export function planImportQueue(queueLength, maxFrames = NUM_SUPPORTED_FRAMES) {
  if (queueLength === 0) { return IMPORT_QUEUE_VERDICT.EMPTY; }
  if (queueLength > maxFrames) { return IMPORT_QUEUE_VERDICT.TOO_MANY; }
  return IMPORT_QUEUE_VERDICT.OK;
}

/**
 * Decide whether an individual file's extracted frame number is acceptable.
 * Mirrors the action's two per-file guards, in order:
 *  - undefined       -> MISSING  ("Frame Numbering Required", loop breaks)
 *  - > 1000          -> TOO_HIGH ("Frame Number Too High", loop breaks)
 *  - otherwise       -> OK
 *
 * NOTE: the check is `frameNr > 1000`, so exactly 1000 is accepted. Frame
 * numbers arrive already incremented by extractFrameNumberFromFilename, so a
 * file named "..._1000.png" yields frameNr 1001 and is rejected. Preserved
 * as-is (see report).
 *
 * @param {number|undefined} frameNr
 * @returns {string} one of FRAME_NUMBER_VERDICT
 */
export function validateFrameNumber(frameNr) {
  if (frameNr === undefined) { return FRAME_NUMBER_VERDICT.MISSING; }
  if (frameNr > 1000) { return FRAME_NUMBER_VERDICT.TOO_HIGH; }
  return FRAME_NUMBER_VERDICT.OK;
}

/**
 * Compute the canvas zoom scale for the first imported image so it fits in the
 * available space, but is never enlarged past 100%.
 *
 * Reproduces the action's exact (quirky) logic:
 *  - a widthScale is computed only when the image is wider than the available
 *    width, using density 0.85 (leaves room for the sidebar);
 *  - a heightScale is computed only when the image is taller than the available
 *    height, using density 0.9;
 *  - the returned scale is null unless a widthScale exists. If BOTH exist the
 *    smaller of the two is used; if only widthScale exists it is used as-is.
 *    A height-only overflow yields scale === null (the image is NOT scaled
 *    down) — this is a faithful copy of the original branch structure, not a
 *    designed behaviour (see report).
 *
 * @param {object} p
 * @param {number} p.imageWidth
 * @param {number} p.imageHeight
 * @param {number} p.availableWidth
 * @param {number} p.availableHeight
 * @returns {number|null} the scale to apply, or null to leave the scale untouched
 */
export function planCanvasFit({
  imageWidth,
  imageHeight,
  availableWidth,
  availableHeight,
}) {
  let widthScale = null;
  let heightScale = null;

  if (imageWidth > availableWidth) {
    const density = 0.85;
    widthScale = (availableWidth * density) / imageWidth;
  }
  if (imageHeight > availableHeight) {
    const density = 0.9;
    heightScale = (availableHeight * density) / imageHeight;
  }

  let scale = null;
  if (widthScale) {
    scale = widthScale;
  }
  if (widthScale && heightScale) {
    scale = Math.min(widthScale, heightScale);
  }
  return scale;
}

/**
 * Estimate the "time remaining" (in seconds) shown while color frames are
 * analysed. Mirrors the action's arithmetic exactly:
 *  - before the first loop timing is known (msPerLoop == null), it is a rough
 *    `queueLength * 5`;
 *  - afterwards it extrapolates from the measured per-loop time, subtracting
 *    the frames already implied by `frameNr`:
 *      (msPerLoop/1000)*queueLength - (msPerLoop/1000)*(frameNr - 1), rounded.
 *
 * @param {object} p
 * @param {number|null} p.msPerLoop     Measured duration of the previous loop,
 *   or null before the first timed loop.
 * @param {number} p.queueLength        Number of files in the loading queue.
 * @param {number} p.frameNr            The current frame number being analysed.
 * @returns {number} estimated seconds remaining
 */
export function estimateImportTimeRemaining({ msPerLoop, queueLength, frameNr }) {
  if (msPerLoop === null) {
    return queueLength * 5;
  }
  const perLoopSeconds = msPerLoop / 1000;
  return Math.round((perLoopSeconds * queueLength) - (perLoopSeconds * (frameNr - 1)));
}
