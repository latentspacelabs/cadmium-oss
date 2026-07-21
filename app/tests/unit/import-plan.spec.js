// Golden tests for the pure import-planning logic. These lock the exact
// verdicts, canvas scale and time estimates that ADD_IMAGES_TO_TIMELINE
// produced inline, so the extraction is provably behaviour-preserving.
import {
  IMPORT_QUEUE_VERDICT,
  FRAME_NUMBER_VERDICT,
  NUM_SUPPORTED_FRAMES,
  planImportQueue,
  validateFrameNumber,
  planCanvasFit,
  estimateImportTimeRemaining,
} from '@/services/import-plan';

describe('planImportQueue', () => {
  it('flags an empty queue as EMPTY', () => {
    expect(planImportQueue(0)).toBe(IMPORT_QUEUE_VERDICT.EMPTY);
  });

  it('accepts any non-empty queue with the default (Infinity) cap', () => {
    expect(planImportQueue(1)).toBe(IMPORT_QUEUE_VERDICT.OK);
    expect(planImportQueue(1000)).toBe(IMPORT_QUEUE_VERDICT.OK);
    expect(planImportQueue(1e9)).toBe(IMPORT_QUEUE_VERDICT.OK);
  });

  it('default cap is Infinity, so TOO_MANY never triggers by default', () => {
    expect(NUM_SUPPORTED_FRAMES).toBe(Infinity);
    expect(planImportQueue(Number.MAX_SAFE_INTEGER)).toBe(IMPORT_QUEUE_VERDICT.OK);
  });

  it('honours an explicit finite cap: strictly greater than cap is TOO_MANY', () => {
    expect(planImportQueue(5, 5)).toBe(IMPORT_QUEUE_VERDICT.OK); // equal is OK
    expect(planImportQueue(6, 5)).toBe(IMPORT_QUEUE_VERDICT.TOO_MANY);
  });

  it('an empty queue is EMPTY even when a finite cap is given', () => {
    expect(planImportQueue(0, 5)).toBe(IMPORT_QUEUE_VERDICT.EMPTY);
  });
});

describe('validateFrameNumber', () => {
  it('undefined frame number is MISSING', () => {
    expect(validateFrameNumber(undefined)).toBe(FRAME_NUMBER_VERDICT.MISSING);
  });

  it('accepts normal frame numbers', () => {
    expect(validateFrameNumber(1)).toBe(FRAME_NUMBER_VERDICT.OK);
    expect(validateFrameNumber(42)).toBe(FRAME_NUMBER_VERDICT.OK);
  });

  it('boundary: exactly 1000 is OK, 1001 is TOO_HIGH (check is > 1000)', () => {
    expect(validateFrameNumber(1000)).toBe(FRAME_NUMBER_VERDICT.OK);
    expect(validateFrameNumber(1001)).toBe(FRAME_NUMBER_VERDICT.TOO_HIGH);
  });

  it('a much larger frame number is TOO_HIGH', () => {
    expect(validateFrameNumber(5000)).toBe(FRAME_NUMBER_VERDICT.TOO_HIGH);
  });

  it('note: null is NOT treated as MISSING (only strict undefined is)', () => {
    // extractFrameNumberFromFilename can return null; the original guard only
    // checked === undefined, so null falls through to the > 1000 comparison,
    // which is false, giving OK. Preserved as-is.
    expect(validateFrameNumber(null)).toBe(FRAME_NUMBER_VERDICT.OK);
  });
});

describe('planCanvasFit', () => {
  it('returns null when the image fits (no overflow on either axis)', () => {
    expect(planCanvasFit({
      imageWidth: 500, imageHeight: 400, availableWidth: 1000, availableHeight: 800,
    })).toBeNull();
  });

  it('scales down on width overflow using density 0.85', () => {
    // 2000 wide into 1000 available: 1000 * 0.85 / 2000 = 0.425
    expect(planCanvasFit({
      imageWidth: 2000, imageHeight: 400, availableWidth: 1000, availableHeight: 800,
    })).toBeCloseTo(0.425, 10);
  });

  it('QUIRK: a height-only overflow yields null (image not scaled down)', () => {
    // height overflows but width does not -> widthScale stays null -> scale null
    expect(planCanvasFit({
      imageWidth: 500, imageHeight: 2000, availableWidth: 1000, availableHeight: 800,
    })).toBeNull();
  });

  it('when both axes overflow, uses the smaller of width/height scale', () => {
    // widthScale = 1000 * 0.85 / 3400 = 0.25
    // heightScale = 800 * 0.9 / 1600 = 0.45
    // min -> 0.25
    expect(planCanvasFit({
      imageWidth: 3400, imageHeight: 1600, availableWidth: 1000, availableHeight: 800,
    })).toBeCloseTo(0.25, 10);
  });

  it('when both overflow but heightScale is smaller, heightScale wins', () => {
    // widthScale = 1000 * 0.85 / 1700 = 0.5
    // heightScale = 800 * 0.9 / 3600 = 0.2
    // min -> 0.2
    expect(planCanvasFit({
      imageWidth: 1700, imageHeight: 3600, availableWidth: 1000, availableHeight: 800,
    })).toBeCloseTo(0.2, 10);
  });

  it('width-only overflow uses widthScale directly (height ignored)', () => {
    // widthScale = 1000 * 0.85 / 1700 = 0.5, no height overflow
    expect(planCanvasFit({
      imageWidth: 1700, imageHeight: 400, availableWidth: 1000, availableHeight: 800,
    })).toBeCloseTo(0.5, 10);
  });
});

describe('estimateImportTimeRemaining', () => {
  it('before any timing (msPerLoop null) uses queueLength * 5', () => {
    expect(estimateImportTimeRemaining({ msPerLoop: null, queueLength: 10, frameNr: 1 }))
      .toBe(50);
  });

  it('extrapolates from measured per-loop time, subtracting done frames', () => {
    // perLoopSeconds = 2000/1000 = 2
    // 2 * 20 - 2 * (5 - 1) = 40 - 8 = 32
    expect(estimateImportTimeRemaining({ msPerLoop: 2000, queueLength: 20, frameNr: 5 }))
      .toBe(32);
  });

  it('rounds the extrapolated estimate', () => {
    // perLoopSeconds = 1500/1000 = 1.5
    // 1.5 * 10 - 1.5 * (3 - 1) = 15 - 3 = 12
    expect(estimateImportTimeRemaining({ msPerLoop: 1500, queueLength: 10, frameNr: 3 }))
      .toBe(12);
  });

  it('rounds a fractional result to the nearest integer', () => {
    // perLoopSeconds = 333/1000 = 0.333
    // 0.333 * 7 - 0.333 * (2 - 1) = 2.331 - 0.333 = 1.998 -> round 2
    expect(estimateImportTimeRemaining({ msPerLoop: 333, queueLength: 7, frameNr: 2 }))
      .toBe(2);
  });
});
