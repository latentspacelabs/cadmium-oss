// Golden tests for the pure COLORIZE planning logic. These lock the exact
// reference-frame pick, sequential sort order, reuse map, sequential in-between
// hop and segmap-dilation parse that the COLORIZE action produced inline, so
// the extraction is provably behaviour-preserving. Expected values are
// hand-derived from the current action code.
import {
  pickReferenceFrameNr,
  sequentialFrameSort,
  buildRefLineToColorImageIdMap,
  pickInBetweenRefFrame,
  parseSegMapDilation,
} from '@/services/colorize-plan';

describe('pickReferenceFrameNr', () => {
  it('returns the left reference frame when present', () => {
    expect(pickReferenceFrameNr({ refFrameLeftNr: 3, refFrameRightNr: 7 })).toBe(3);
  });

  it('falls back to the right reference frame when left is absent', () => {
    expect(pickReferenceFrameNr({ refFrameRightNr: 7 })).toBe(7);
    expect(pickReferenceFrameNr({ refFrameLeftNr: null, refFrameRightNr: 7 })).toBe(7);
  });

  it('returns undefined when neither reference frame is set', () => {
    expect(pickReferenceFrameNr({})).toBeUndefined();
    expect(pickReferenceFrameNr({ refFrameLeftNr: null, refFrameRightNr: null })).toBeNull();
  });

  it('treats a falsy left reference (0) as absent and uses the right', () => {
    // truthiness check, not existence — preserved quirk
    expect(pickReferenceFrameNr({ refFrameLeftNr: 0, refFrameRightNr: 9 })).toBe(9);
  });
});

describe('sequentialFrameSort', () => {
  it('sorts a missing frame to the left; two missing are equal', () => {
    const f = { frameNr: 2, refFrameLeftNr: 1 };
    expect(sequentialFrameSort(null, f)).toBe(-1);
    expect(sequentialFrameSort(f, null)).toBe(1);
    expect(sequentialFrameSort(null, null)).toBe(0);
    expect(sequentialFrameSort(undefined, undefined)).toBe(0);
  });

  it('orders different reference-frame groups by reference frame number', () => {
    const a = { frameNr: 5, refFrameLeftNr: 2 }; // ref 2
    const b = { frameNr: 5, refFrameLeftNr: 8 }; // ref 8
    expect(sequentialFrameSort(a, b)).toBe(2 - 8); // -6
    expect(sequentialFrameSort(b, a)).toBe(8 - 2); // 6
  });

  it('within a group, sorts left-of-ref before right-of-ref', () => {
    const ref = 5;
    const left = { frameNr: 3, refFrameLeftNr: ref }; // dist -2 (left)
    const right = { frameNr: 7, refFrameLeftNr: ref }; // dist +2 (right)
    expect(sequentialFrameSort(left, right)).toBe(-1);
    expect(sequentialFrameSort(right, left)).toBe(1);
  });

  it('on the same side, sorts by distance to the reference frame', () => {
    const ref = 5;
    const near = { frameNr: 6, refFrameLeftNr: ref }; // dist +1
    const far = { frameNr: 9, refFrameLeftNr: ref }; // dist +4
    expect(sequentialFrameSort(near, far)).toBe(Math.abs(1) - Math.abs(4)); // -3
    expect(sequentialFrameSort(far, near)).toBe(Math.abs(4) - Math.abs(1)); // 3
  });

  it('produces the expected full ordering for a mixed set (golden)', () => {
    // group ref=2: frames 1 (left, dist -1), 3 (right, dist +1), 4 (right +2)
    // group ref=8: frame 6 (left, dist -2)
    const frames = [
      { frameNr: 4, refFrameLeftNr: 2 },
      { frameNr: 6, refFrameLeftNr: 8 },
      { frameNr: 1, refFrameLeftNr: 2 },
      { frameNr: 3, refFrameLeftNr: 2 },
    ];
    const sorted = frames.slice().sort(sequentialFrameSort).map(f => f.frameNr);
    // ref-2 group first (leftmost ref). Within it: left side (1) before right
    // side; right side ordered by distance (3 then 4). Then ref-8 group (6).
    expect(sorted).toEqual([1, 3, 4, 6]);
  });
});

describe('buildRefLineToColorImageIdMap', () => {
  it('maps line image id -> color image id for original color frames only', () => {
    const lineFramesByNr = [];
    lineFramesByNr[1] = { imageDataId: 'line1' };
    lineFramesByNr[2] = { imageDataId: 'line2' };
    lineFramesByNr[3] = { imageDataId: 'line3' };
    const colorFrames = [
      null,
      { frameNr: 1, isOriginal: true, imageDataId: 'color1' },
      { frameNr: 2, isOriginal: false, imageDataId: 'color2' }, // not original -> skip
      { frameNr: 3, isOriginal: true, imageDataId: 'color3' },
    ];
    expect(buildRefLineToColorImageIdMap(lineFramesByNr, colorFrames)).toEqual({
      line1: 'color1',
      line3: 'color3',
    });
  });

  it('skips color frames without an imageDataId, and holes in the array', () => {
    const lineFramesByNr = [];
    lineFramesByNr[1] = { imageDataId: 'line1' };
    const colorFrames = [
      undefined,
      { frameNr: 1, isOriginal: true }, // no imageDataId -> skip
    ];
    expect(buildRefLineToColorImageIdMap(lineFramesByNr, colorFrames)).toEqual({});
  });

  it('skips when the matching line frame is missing or lacks an imageDataId', () => {
    const lineFramesByNr = [];
    lineFramesByNr[2] = {}; // exists but no imageDataId
    const colorFrames = [
      { frameNr: 1, isOriginal: true, imageDataId: 'color1' }, // no line frame at 1
      { frameNr: 2, isOriginal: true, imageDataId: 'color2' }, // line frame lacks id
    ];
    expect(buildRefLineToColorImageIdMap(lineFramesByNr, colorFrames)).toEqual({});
  });

  it('returns an empty map for empty inputs', () => {
    expect(buildRefLineToColorImageIdMap([], [])).toEqual({});
  });
});

describe('pickInBetweenRefFrame', () => {
  it('returns null when no colorized frame lies in the inclusive range', () => {
    expect(pickInBetweenRefFrame({
      frameNr: 5, refFrameNr: 1, colorizedFrameNrs: [8, 9],
    })).toBeNull();
  });

  it('picks the in-between colorized frame farthest from the reference', () => {
    // range [1..5]; colorized in range: 2, 4. distances to ref 1: 1, 3 -> pick 4
    expect(pickInBetweenRefFrame({
      frameNr: 5, refFrameNr: 1, colorizedFrameNrs: [2, 4, 8],
    })).toBe(4);
  });

  it('works when the reference is to the right of the target', () => {
    // range [3..9]; colorized in range: 5, 7. distances to ref 9: 4, 2 -> pick 5
    expect(pickInBetweenRefFrame({
      frameNr: 3, refFrameNr: 9, colorizedFrameNrs: [5, 7],
    })).toBe(5);
  });

  it('includes the range endpoints (inclusive) when colorized', () => {
    // range [2..6]; colorized: 2, 6. distances to ref 6: 4, 0 -> pick 2
    expect(pickInBetweenRefFrame({
      frameNr: 2, refFrameNr: 6, colorizedFrameNrs: [2, 6],
    })).toBe(2);
  });

  it('ignores colorized frames outside the inclusive range', () => {
    // range [3..5]; colorized 3, 5, and 7 -> only 3 and 5 are in range.
    // distances to ref 5: [2, 0]; farthest is 3.
    expect(pickInBetweenRefFrame({
      frameNr: 3, refFrameNr: 5, colorizedFrameNrs: [3, 5, 7],
    })).toBe(3);
  });
});

describe('parseSegMapDilation', () => {
  it('returns undefined for a falsy path', () => {
    expect(parseSegMapDilation(undefined)).toBeUndefined();
    expect(parseSegMapDilation('')).toBeUndefined();
    expect(parseSegMapDilation(null)).toBeUndefined();
  });

  it('reads the two chars before the first dot as a base-10 int', () => {
    // pre-dot part "...dilate_04"; last two chars "04" -> 4
    expect(parseSegMapDilation('/tmp/cadm_x_dilate_04.png')).toBe(4);
  });

  it('reproduces the current segmap filename quirk (parses minSegSize, not dilation)', () => {
    // current format ends "_minSegSize_2.png"; pre-dot ".._minSegSize_2",
    // last two chars "_2" -> parseInt('_2', 10) is NaN
    expect(parseSegMapDilation('cadm_segMap_h_line_threshold_auto_tbDilate_04_aiDilate_00_minSegSize_2.png'))
      .toBeNaN();
    // with a two-digit minSegSize the two chars are digits, e.g. "12" -> 12
    expect(parseSegMapDilation('cadm_segMap_h_minSegSize_12.png')).toBe(12);
  });

  it('splits on the FIRST dot (matches split(".")[0])', () => {
    // "a.b.c" -> pre-dot "a"; slice(-2) of "a" is "a" -> NaN
    expect(parseSegMapDilation('a.b.c')).toBeNaN();
    // "xx99.b.png" -> pre-dot "xx99"; last two "99" -> 99
    expect(parseSegMapDilation('xx99.b.png')).toBe(99);
  });
});

// ── planColorize (pure plan over a snapshot) ───────────────────────────────────
// eslint-disable-next-line import/first
import { planColorize, planAnalyze, COLORIZE_PLAN_ERROR } from '@/services/colorize-plan';

// A snapshot frame carrying the reference fields FIND_REFERENCE_FRAMES writes.
const snapFrame = (frameNr, over = {}) => ({
  frameNr,
  isOriginal: false,
  refFrameLeftNr: undefined,
  refFrameRightNr: undefined,
  ...over,
});

describe('planColorize', () => {
  it('orders ops with sequentialFrameSort (left-of-ref before right-of-ref, nearest first)', () => {
    // ref frame 3; frames 1,2 to the left, 4,5 to the right. Expect outward
    // order: left side nearest-first (2, then 1), then right side (4, then 5).
    const snapshot = {
      analyzeMode: false,
      lineFrameNrs: [1, 2, 3, 4, 5],
      frames: [
        snapFrame(5, { refFrameLeftNr: 3 }),
        snapFrame(1, { refFrameLeftNr: 3 }),
        snapFrame(4, { refFrameLeftNr: 3 }),
        snapFrame(2, { refFrameLeftNr: 3 }),
      ],
    };
    const plan = planColorize(snapshot);
    expect(plan.error).toBeNull();
    expect(plan.ops.map(o => o.frameNr)).toEqual([2, 1, 4, 5]);
    expect(plan.ops.every(o => o.refFrameNr === 3)).toBe(true);
  });

  it('keeps original frames as ops (the run skips them but counts them as progress)', () => {
    const snapshot = {
      analyzeMode: false,
      lineFrameNrs: [1, 2],
      frames: [
        snapFrame(1, { isOriginal: true }),
        snapFrame(2, { refFrameLeftNr: 1 }),
      ],
    };
    const plan = planColorize(snapshot);
    expect(plan.ops.map(o => ({ n: o.frameNr, o: o.isOriginal }))).toEqual([
      { n: 1, o: true },
      { n: 2, o: false },
    ]);
  });

  it('returns NO_REFERENCE for the first non-original frame with no reference (colorize mode)', () => {
    const snapshot = {
      analyzeMode: false,
      lineFrameNrs: [1, 2],
      frames: [snapFrame(2, { refFrameLeftNr: undefined, refFrameRightNr: undefined })],
    };
    const plan = planColorize(snapshot);
    expect(plan.error).toBe(COLORIZE_PLAN_ERROR.NO_REFERENCE);
    expect(plan.errorFrameNr).toBe(2);
    expect(plan.ops).toEqual([]);
  });

  it('returns REF_LINE_MISSING when the reference frame has no line frame (colorize mode)', () => {
    const snapshot = {
      analyzeMode: false,
      lineFrameNrs: [2], // frame 5 (the reference) has NO line frame
      frames: [snapFrame(2, { refFrameLeftNr: 5 })],
    };
    const plan = planColorize(snapshot);
    expect(plan.error).toBe(COLORIZE_PLAN_ERROR.REF_LINE_MISSING);
    expect(plan.errorFrameNr).toBe(2);
    expect(plan.ops).toEqual([]);
  });

  it('does NOT error on a missing reference in analyze mode', () => {
    const snapshot = {
      analyzeMode: true,
      lineFrameNrs: [],
      frames: [snapFrame(2), snapFrame(3)],
    };
    const plan = planAnalyze(snapshot);
    expect(plan.error).toBeNull();
    expect(plan.analyzeMode).toBe(true);
    expect(plan.ops.map(o => o.frameNr)).toEqual([2, 3]);
  });

  it('surfaces the FIRST failing frame in sorted order (prior ops do not run)', () => {
    // Sorted order is [2, 4]; frame 4 has no ref. The error is reported for the
    // frame reached first in that order that fails — here frame 4.
    const snapshot = {
      analyzeMode: false,
      lineFrameNrs: [1, 2, 4],
      frames: [
        snapFrame(4, { refFrameLeftNr: undefined }),
        snapFrame(2, { refFrameLeftNr: 1 }),
      ],
    };
    const plan = planColorize(snapshot);
    expect(plan.error).toBe(COLORIZE_PLAN_ERROR.NO_REFERENCE);
    expect(plan.errorFrameNr).toBe(4);
  });
});
