// Golden tests for the pure reference-frame matching logic. These lock the
// exact left/right/closest selection, the distance tiebreak (ties -> left), the
// same-image walk-back, and the pre-walk-vs-post-walk distance asymmetry the
// FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES action produced inline, so the
// extraction is provably behaviour-preserving.
import { computeReferenceFrames } from '@/services/reference-matching';

// Default predicate: no two frames ever share image data, so walk-back never
// runs. Individual tests override with a set of adjacent pairs that do share.
const noSharedBlocks = () => false;

// Build a framesShareImageData predicate from a list of [a, b] adjacent pairs
// that share image data. Matches the getter's [refNrLeft, refNrLeft - 1] call.
const sharedBlocks = (pairs) => (a, b) => pairs.some(([pa, pb]) => pa === a && pb === b);

describe('computeReferenceFrames — both sides present', () => {
  it('left closer -> closest is left, right nulled', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [2, 15],
      selectedFrameNrs: [5],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 5, refFrameLeftNr: 2, refFrameRightNr: null, refFrameClosestNr: 2,
      },
    ]);
  });

  it('right closer -> closest is right, left nulled', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [2, 7],
      selectedFrameNrs: [6],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 6, refFrameLeftNr: null, refFrameRightNr: 7, refFrameClosestNr: 7,
      },
    ]);
  });

  it('exact tie -> left wins (distanceLeft <= distanceRight)', () => {
    // selected 5, left 3 (dist 2), right 7 (dist 2) => left wins
    const result = computeReferenceFrames({
      referenceFrameNrs: [3, 7],
      selectedFrameNrs: [5],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 5, refFrameLeftNr: 3, refFrameRightNr: null, refFrameClosestNr: 3,
      },
    ]);
  });
});

describe('computeReferenceFrames — one side only', () => {
  it('only-left -> left kept as closest, right null', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [2, 4],
      selectedFrameNrs: [10],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 10, refFrameLeftNr: 4, refFrameRightNr: null, refFrameClosestNr: 4,
      },
    ]);
  });

  it('only-right -> right kept as closest, left null', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [12, 20],
      selectedFrameNrs: [5],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 5, refFrameLeftNr: null, refFrameRightNr: 12, refFrameClosestNr: 12,
      },
    ]);
  });

  it('no refs at all -> all-null result for that frame', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [],
      selectedFrameNrs: [5],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 5, refFrameLeftNr: null, refFrameRightNr: null, refFrameClosestNr: null,
      },
    ]);
  });
});

describe('computeReferenceFrames — walk-back to block start', () => {
  it('walks the left ref back to the start of its same-image block', () => {
    // left ref 8 belongs to a block 6-7-8; walk back to 6. Only-left case so
    // no tiebreak; committed left/closest is the block start (6).
    const result = computeReferenceFrames({
      referenceFrameNrs: [8],
      selectedFrameNrs: [20],
      framesShareImageData: sharedBlocks([[8, 7], [7, 6]]),
    });
    expect(result).toEqual([
      {
        frameNr: 20, refFrameLeftNr: 6, refFrameRightNr: null, refFrameClosestNr: 6,
      },
    ]);
  });

  it('tiebreak uses the PRE-walk distance, commits the POST-walk number', () => {
    // selected 10; right ref 13 (dist 3); left ref 8 in block 6-7-8.
    // PRE-walk left distance = |8 - 10| = 2, beats right's 3 -> left wins.
    // POST-walk left = 6; if distance were measured post-walk (|6-10|=4) the
    // RIGHT would have won. Current behaviour: closest = walked-back 6.
    const result = computeReferenceFrames({
      referenceFrameNrs: [8, 13],
      selectedFrameNrs: [10],
      framesShareImageData: sharedBlocks([[8, 7], [7, 6]]),
    });
    expect(result).toEqual([
      {
        frameNr: 10, refFrameLeftNr: 6, refFrameRightNr: null, refFrameClosestNr: 6,
      },
    ]);
  });
});

describe('computeReferenceFrames — selected frame is a reference frame', () => {
  it('matches both <= and >= so left and right start equal; left wins tie', () => {
    // selected 7 is itself a ref frame. left = 7 (dist 0), right = 7 (dist 0).
    // No block walk-back. Tie -> left wins, right nulled.
    const result = computeReferenceFrames({
      referenceFrameNrs: [3, 7, 12],
      selectedFrameNrs: [7],
      framesShareImageData: noSharedBlocks,
    });
    expect(result).toEqual([
      {
        frameNr: 7, refFrameLeftNr: 7, refFrameRightNr: null, refFrameClosestNr: 7,
      },
    ]);
  });
});

describe('computeReferenceFrames — input handling', () => {
  it('sorts unsorted reference and selected arrays internally', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [15, 2, 7],
      selectedFrameNrs: [6, 1],
      framesShareImageData: noSharedBlocks,
    });
    // Results come back in ascending selected-frame order.
    expect(result.map((r) => r.frameNr)).toEqual([1, 6]);
    // frame 1: only-right (2). frame 6: left 7? no -> left 2, right 7, dist 4 vs 1 -> right.
    expect(result).toEqual([
      {
        frameNr: 1, refFrameLeftNr: null, refFrameRightNr: 2, refFrameClosestNr: 2,
      },
      {
        frameNr: 6, refFrameLeftNr: null, refFrameRightNr: 7, refFrameClosestNr: 7,
      },
    ]);
  });

  it('does not mutate the caller arrays', () => {
    const refs = [15, 2, 7];
    const sel = [6, 1];
    computeReferenceFrames({
      referenceFrameNrs: refs,
      selectedFrameNrs: sel,
      framesShareImageData: noSharedBlocks,
    });
    expect(refs).toEqual([15, 2, 7]);
    expect(sel).toEqual([6, 1]);
  });

  it('returns one entry per selected frame, in order', () => {
    const result = computeReferenceFrames({
      referenceFrameNrs: [5, 10],
      selectedFrameNrs: [3, 8, 12],
      framesShareImageData: noSharedBlocks,
    });
    expect(result.map((r) => r.frameNr)).toEqual([3, 8, 12]);
  });
});
