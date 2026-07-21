/**
 * colorize-plan — the pure planning core of the COLORIZE action.
 *
 * COLORIZE is the app's core feature and by far its most interconnected action:
 * it drives frame selection, segmentation-map generation/reuse, the
 * reference-guided ColorizeService calls, canvas rendering, temp-file IPC,
 * cancel-flag polling and a long chain of ordered store mutations. Almost all
 * of that MUST stay in the action — extracting it would reorder mutations or
 * pull in Vuex/fs/canvas/IPC.
 *
 * Tangled inside that orchestration, though, are a few genuinely PURE decisions
 * that are just arithmetic and lookups over plain frame objects and arrays:
 *
 *  - which reference frame a target frame points at (left- or right-neighbour),
 *  - the order selected frames are colorized in (the sequential sort),
 *  - the "line image id -> original color image id" reuse map,
 *  - during sequential colorization, which already-colorized in-between frame
 *    to hop to as the reference,
 *  - parsing the two-digit dilation suffix back out of a segmap filename.
 *
 * Those live here, free of Vuex/Electron/fs/DOM, locked down by golden tests.
 * The action keeps every getter/commit/dispatch, all I/O and all dialogs; it
 * just asks these functions what to do.
 *
 * This is a behaviour-preserving extraction. One quirk is reproduced on
 * purpose: parseSegMapDilation feeds values the action computes but never reads
 * (previousLineDilation / previousRefDilation are dead) — see the note there
 * and the report.
 *
 * Most functions here are pure (no Electron, filesystem, DOM or Vuex access).
 * The one store-boundary helper is `colorizeSnapshot`, which — like
 * export-plan's `exportSnapshot` — reads getters to produce the plain-data
 * snapshot `planColorize` then plans over without side effects.
 */

import {
  LINKED_LAYER_ID,
  SELECTED_FRAMES_ON_LAYER,
  FRAMES_BY_LAYER_ID,
} from '@/store/getter-types';
import { INITIAL_COLOR_LAYER_ID } from '@/store/general-types';

/**
 * Pick the reference frame number a frame points at: the left reference frame
 * if it has one, otherwise the right. Mirrors the action's inline
 * `frame.refFrameLeftNr ? frame.refFrameLeftNr : frame.refFrameRightNr` (and
 * the identical expression inside sequentialFrameSort).
 *
 * Returns undefined when the frame has neither (a falsy refFrameLeftNr AND a
 * falsy refFrameRightNr) — the action treats that as "no reference frame".
 *
 * NOTE: the check is truthiness, not existence, so a refFrameLeftNr of 0 falls
 * through to the right reference. Frame numbers are 1-based (frame 0 is a
 * placeholder), so 0 never occurs as a real reference in practice. Preserved
 * as-is.
 *
 * @param {object} frame
 * @returns {number|undefined}
 */
export function pickReferenceFrameNr(frame) {
  return frame.refFrameLeftNr ? frame.refFrameLeftNr : frame.refFrameRightNr;
}

/**
 * Comparator deciding which of two frames should be colorized first, so that
 * colorization proceeds outward from each reference frame. Moved verbatim from
 * the action (formerly the module-level `sequentialFrameSort`).
 *
 * Ordering rules, in order:
 *  - a missing frame (falsy) sorts to the left; two missing frames are equal;
 *  - frames grouped under different reference frames sort by reference frame
 *    number (leftmost reference first);
 *  - within one reference-frame group, frames to the LEFT of the reference sort
 *    before frames to the right;
 *  - on the same side, the frame closer to the reference sorts first.
 *
 * Return value < 0 => f1 before f2; > 0 => f2 before f1; 0 => equal.
 *
 * @param {object} f1
 * @param {object} f2
 * @returns {number}
 */
export function sequentialFrameSort(f1, f2) {
  // if both do not exist, they should be sorted the same way
  if (!f1 && !f2) { return 0; }
  // if f1 does not exist, sort left
  if (!f1) { return -1; }
  // if f2 does not exist, sort left
  if (!f2) { return 1; }
  const f1RefFrameNr = pickReferenceFrameNr(f1);
  const f2RefFrameNr = pickReferenceFrameNr(f2);
  // if both use separate ref frames, the one should be sorted
  // first with the leftmost ref frame
  if (f1RefFrameNr !== f2RefFrameNr) { return f1RefFrameNr - f2RefFrameNr; }
  // both ref frames are the same —> calculate distance to ref frame

  // calculate distance to reference frame:
  // negative when ref frame is on the left, positive when reference frame is on the right
  const f1RefFrameDist = f1RefFrameNr - f1.frameNr;
  const f2RefFrameDist = f2RefFrameNr - f2.frameNr;
  // make sure frame groups stay together and frames left to a
  // ref frame are sorted earlier than frames to the right
  if (f1RefFrameDist < 0 && f2RefFrameDist > 0) { return 1; }
  if (f1RefFrameDist > 0 && f2RefFrameDist < 0) { return -1; }
  // if both are on the same side of a ref frame,
  // just compare the distance to the ref frame
  return Math.abs(f1RefFrameDist) - Math.abs(f2RefFrameDist);
}

/**
 * Build the "reference line image id -> original color image id" map used to
 * skip re-colorizing frames whose line art already has a hand-drawn color
 * original. The action fetches the two frame collections from getters; this is
 * the pure reduction over them.
 *
 * A colorFrame contributes an entry only when it is an ORIGINAL frame with an
 * imageDataId AND the line layer has a frame at the same frameNr with its own
 * imageDataId. The key is the LINE image id, the value is the COLOR image id.
 *
 * @param {Array<object>} lineFramesByNr  Line-layer frames indexed by frameNr
 *   (the getter returns a sparse array keyed by frame number).
 * @param {Array<object>} colorFrames     Color-layer frames (may contain holes).
 * @returns {Object<string, string>}
 */
export function buildRefLineToColorImageIdMap(lineFramesByNr, colorFrames) {
  const map = {};
  colorFrames.forEach((cf) => {
    if (cf && cf.isOriginal && cf.imageDataId) {
      const lf = lineFramesByNr[cf.frameNr];
      if (lf && lf.imageDataId) {
        map[lf.imageDataId] = cf.imageDataId;
      }
    }
  });
  return map;
}

/**
 * Sequential-colorization hop: when colorizing a run of frames outward from a
 * reference, prefer a frame already colorized THIS session that sits between
 * the target and the reference, so each new frame references its freshly
 * colorized neighbour rather than the distant original reference.
 *
 * Considers every integer frame number in the inclusive range between
 * `frameNr` and `refFrameNr` that appears in `colorizedFrameNrs`. If any exist,
 * returns the one FARTHEST from the reference (largest |nr - refFrameNr|),
 * matching the action's `indexOf(Math.max(...))` (first max on ties). If none
 * exist, returns null — the action then keeps the original reference.
 *
 * @param {object} p
 * @param {number} p.frameNr             The target frame being colorized.
 * @param {number} p.refFrameNr          The current reference frame number.
 * @param {Array<number>} p.colorizedFrameNrs  Frames colorized so far this run.
 * @returns {number|null} the frame number to use as the reference, or null.
 */
export function pickInBetweenRefFrame({ frameNr, refFrameNr, colorizedFrameNrs }) {
  const colorizedFrameNrsInBetween = [];
  const smallerFrNr = Math.min(frameNr, refFrameNr);
  const biggerFrNr = Math.max(frameNr, refFrameNr);
  for (let i = smallerFrNr; i <= biggerFrNr; i += 1) {
    if (colorizedFrameNrs.includes(i)) {
      colorizedFrameNrsInBetween.push(i);
    }
  }
  if (colorizedFrameNrsInBetween.length === 0) {
    return null;
  }
  const absDistancesToRef = colorizedFrameNrsInBetween.map((nr) => Math.abs(nr - refFrameNr));
  const iMax = absDistancesToRef.indexOf(Math.max(...absDistancesToRef));
  return colorizedFrameNrsInBetween[iMax];
}

/**
 * Parse the two-digit dilation amount back out of a segmap file path, mirroring
 * the action's `parseInt(path.split('.')[0].slice(-2), 10)`. It takes the part
 * before the first dot and reads its last two characters as a base-10 integer.
 *
 * Returns undefined for a falsy path (the action skips the assignment entirely
 * in that case).
 *
 * NOTE: this reproduces the exact original slicing. The current segmap filename
 * format ends `..._minSegSize_<n>.png`, so the two characters before `.png` are
 * the minSegSize digits, NOT the dilation — i.e. the parsed value is not what
 * the variable names (previousLineDilation / previousRefDilation) suggest. This
 * does not matter today because the action computes these values and never uses
 * them (dead code). Preserved exactly; flagged in the report, not fixed.
 *
 * @param {string} segMapPath
 * @returns {number|undefined}
 */
export function parseSegMapDilation(segMapPath) {
  if (!segMapPath) { return undefined; }
  const segMapSplit = segMapPath.split('.');
  return parseInt(segMapSplit[0].slice(-2), 10);
}

/**
 * Typed plan-time errors for COLORIZE. These reproduce the two mid-loop dialogs
 * the action used to `break` on — moved to plan time so the error surfaces ONCE,
 * before any frame runs, rather than after N frames were already colorized. Both
 * apply only in colorize mode (analyze mode tolerated a missing reference).
 */
export const COLORIZE_PLAN_ERROR = {
  NO_REFERENCE: 'NO_REFERENCE',
  REF_LINE_MISSING: 'REF_LINE_MISSING',
};

/**
 * Read the plain-data snapshot `planColorize` needs from Vuex. Like
 * export-plan's `exportSnapshot`, this is the single store boundary for the
 * colorize planner: deterministic given `getters`, free of side effects.
 *
 * The caller must already have normalised the selection onto the color layer
 * and run FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES, so each selected frame
 * carries its `refFrameLeftNr` / `refFrameRightNr`.
 *
 * @param {Object} getters - the Vuex getters map.
 * @param {Object} [opts]
 * @param {boolean} [opts.analyzeMode=false]
 * @returns {Object} snapshot
 */
export function colorizeSnapshot(getters, { analyzeMode = false } = {}) {
  const colorLayerId = INITIAL_COLOR_LAYER_ID;
  const lineLayerId = getters[LINKED_LAYER_ID](colorLayerId);

  const selectedFrames = getters[SELECTED_FRAMES_ON_LAYER](colorLayerId).filter(Boolean);
  const lineFrames = getters[FRAMES_BY_LAYER_ID](lineLayerId);
  const lineFrameNrs = [];
  lineFrames.forEach((f) => { if (f) { lineFrameNrs.push(f.frameNr); } });

  return {
    analyzeMode: !!analyzeMode,
    frames: selectedFrames.map((f) => ({
      frameNr: f.frameNr,
      isOriginal: !!f.isOriginal,
      refFrameLeftNr: f.refFrameLeftNr,
      refFrameRightNr: f.refFrameRightNr,
    })),
    lineFrameNrs,
  };
}

/**
 * Pure colorize/analyze plan: `(snapshot) -> { analyzeMode, ops, error }`.
 *
 * The selected frames are ordered with `sequentialFrameSort` (colorize proceeds
 * outward from each reference). In colorize mode, the ordered non-original
 * frames are validated up front: the first one with no reference frame yields
 * `NO_REFERENCE`, and the first whose reference has no line frame yields
 * `REF_LINE_MISSING` (with `errorFrameNr` for the dialog). On error the plan is
 * empty — nothing runs, which is the deliberate improvement over the action's
 * old mid-loop `break` (which colorized the frames before the failure).
 *
 * On success `ops` is the ordered list of `{ frameNr, isOriginal, refFrameNr }`.
 * Originals are kept as ops (the run skips them but counts them as progress,
 * exactly as before). The per-run in-between reference hop (`pickInBetweenRefFrame`)
 * and the `searchNewPalette` demotion depend on run-time results and stay in the
 * executor.
 *
 * @param {Object} snapshot - from `colorizeSnapshot`.
 * @returns {{ analyzeMode: boolean, ops: object[], error: (string|null),
 *   errorFrameNr: (number|undefined) }}
 */
export function planColorize(snapshot) {
  const { analyzeMode } = snapshot;
  const sorted = snapshot.frames.filter(Boolean).sort(sequentialFrameSort);

  if (!analyzeMode) {
    // Validate the ordered non-original frames; the FIRST failure is the error.
    const targets = sorted.filter((frame) => !frame.isOriginal);
    for (let i = 0; i < targets.length; i += 1) {
      const frame = targets[i];
      const refFrameNr = pickReferenceFrameNr(frame);
      if (!refFrameNr) {
        return {
          analyzeMode,
          ops: [],
          error: COLORIZE_PLAN_ERROR.NO_REFERENCE,
          errorFrameNr: frame.frameNr,
        };
      }
      if (!snapshot.lineFrameNrs.includes(refFrameNr)) {
        return {
          analyzeMode,
          ops: [],
          error: COLORIZE_PLAN_ERROR.REF_LINE_MISSING,
          errorFrameNr: frame.frameNr,
        };
      }
    }
  }

  const ops = sorted.map((frame) => ({
    frameNr: frame.frameNr,
    isOriginal: frame.isOriginal,
    refFrameNr: pickReferenceFrameNr(frame),
  }));

  return {
    analyzeMode, ops, error: null, errorFrameNr: undefined,
  };
}

/**
 * Convenience for the analyze verb: same planner, analyze mode forced on (no
 * reference validation). Kept as its own name so the wrapper reads as two verbs.
 *
 * @param {Object} snapshot - from `colorizeSnapshot` (analyzeMode is overridden true).
 */
export function planAnalyze(snapshot) {
  return planColorize({ ...snapshot, analyzeMode: true });
}
