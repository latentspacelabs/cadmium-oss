/**
 * reference-matching — the pure core of reference-frame selection.
 *
 * When frames are colorized by reference, each selected frame needs to know
 * which reference frame(s) sit nearest to it: the closest one on the left
 * (frame nr <= it) and on the right (frame nr >= it), and which of those two is
 * ultimately "closest". This decision was buried inside the
 * FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES Vuex action, tangled with
 * getter reads and SET_REF_FRAMES_FOR_FRAME commits. The pure decision lives
 * here, free of Vuex, so its subtle tiebreak/walk-back behaviour can be locked
 * down by golden tests. The action keeps the getter reads and the commits.
 *
 * This is a behaviour-preserving extraction. Two quirks are preserved on
 * purpose (see notes on computeReferenceFrames):
 *  - the distance tiebreak measures the LEFT distance from the PRE-walk-back
 *    reference number, while the committed left/closest value is the
 *    POST-walk-back number;
 *  - when both sides tie (distanceLeft <= distanceRight) the left side wins.
 */

const compareNumbers = (a, b) => a - b;

/**
 * For each selected frame, pick its nearest reference frames.
 *
 * @param {object} p
 * @param {number[]} p.referenceFrameNrs   All reference frame numbers on the
 *   layer (unsorted is fine; sorted internally).
 * @param {number[]} p.selectedFrameNrs    The selected frame numbers to resolve
 *   (unsorted is fine; sorted internally). Results come back in ascending
 *   sorted order — the same order the original action committed them.
 * @param {(a: number, b: number) => boolean} p.framesShareImageData
 *   Predicate: do frames a and b share the same image data (i.e. belong to the
 *   same "block")? Injected to replace the FRAMES_HAVE_SAME_IMAGE_DATA_ID
 *   getter. Called as framesShareImageData(refNrLeft, refNrLeft - 1); it must
 *   return falsy when refNrLeft is null (the original getter was invoked with
 *   [null, NaN] and returned false, ending the walk-back).
 * @returns {Array<{ frameNr: number, refFrameLeftNr: (number|null),
 *   refFrameRightNr: (number|null), refFrameClosestNr: (number|null) }>}
 *   One entry per selected frame, in ascending frame-nr order.
 */
// eslint-disable-next-line import/prefer-default-export
export function computeReferenceFrames({
  referenceFrameNrs,
  selectedFrameNrs,
  framesShareImageData,
}) {
  if (!referenceFrameNrs) { return []; }

  // Note: the original called .sort() (mutating) on the getter results. We copy
  // first so callers' arrays are not mutated; the sorted output is identical.
  const sortedReferenceFrameNrs = [...referenceFrameNrs].sort(compareNumbers);
  const sortedSelectedFrameNrs = [...selectedFrameNrs].sort(compareNumbers);

  return sortedSelectedFrameNrs.map((selectedFrameNr) => {
    const refIdsSmallerEqual = sortedReferenceFrameNrs.filter(
      (refFrameNr) => refFrameNr <= selectedFrameNr,
    );
    let refNrLeft = null;
    let refNrRight = null;
    let found = false;

    if (refIdsSmallerEqual.length > 0) {
      // the biggest reference frame nr <= this frame is closest on the left
      refNrLeft = Math.max(...refIdsSmallerEqual);
      found = true;
    }

    const refIdsBiggerEqual = sortedReferenceFrameNrs.filter(
      (refFrameNr) => refFrameNr >= selectedFrameNr,
    );
    if (refIdsBiggerEqual.length > 0) {
      refNrRight = Math.min(...refIdsBiggerEqual);
      found = true;
    }

    if (!found) {
      // no reference frame on either side: everything stays null
      return {
        frameNr: selectedFrameNr,
        refFrameLeftNr: null,
        refFrameRightNr: null,
        refFrameClosestNr: null,
      };
    }

    // If the left ref frame is part of a same-image block, walk back to the
    // first frame of that block so the connection lines display correctly.
    // refNrLeftOrig keeps the pre-walk number for the distance tiebreak below.
    const refNrLeftOrig = refNrLeft;
    while (framesShareImageData(refNrLeft, refNrLeft - 1)) {
      refNrLeft -= 1;
    }

    let refFrameClosestNr = null;
    if (refNrLeft === null && refNrRight !== null) {
      // only a ref frame on the right
      refFrameClosestNr = refNrRight;
    } else if (refNrLeft !== null && refNrRight === null) {
      // only a ref frame on the left
      refFrameClosestNr = refNrLeft;
    } else {
      // ref frames on both sides: pick whichever is actually closer.
      // NOTE: the left distance uses refNrLeftOrig (PRE walk-back), so a
      // walked-back left can still "win" on a distance measured from where it
      // started. Ties go to the left.
      const distanceLeft = Math.abs(refNrLeftOrig - selectedFrameNr);
      const distanceRight = Math.abs(refNrRight - selectedFrameNr);
      if (distanceLeft <= distanceRight) {
        refFrameClosestNr = refNrLeft;
        refNrRight = null;
      } else {
        refFrameClosestNr = refNrRight;
        refNrLeft = null;
      }
    }

    return {
      frameNr: selectedFrameNr,
      refFrameLeftNr: refNrLeft,
      refFrameRightNr: refNrRight,
      refFrameClosestNr,
    };
  });
}
