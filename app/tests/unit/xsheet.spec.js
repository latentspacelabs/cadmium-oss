// Golden tests for the pure xsheet read-model. These lock the current
// drawing-identity / hold-block semantics so the F3 (duplicate-detection)
// extraction is provably behaviour-preserving. framesShareDrawing is an exact
// port of the FRAMES_HAVE_SAME_IMAGE_DATA_ID getter; QUIRK-prefixed tests
// document behaviour that looks like a bug but is preserved on purpose.
import {
  framesShareDrawing,
  holdBlocks,
  uniqueDrawings,
  celAt,
  LINE_LAYER_ID,
  COLOR_LAYER_ID,
} from '@/services/xsheet';

// Build a layer from a sparse list of imageDataIds. `null`/undefined entries
// become holes (missing frames); a value of '' becomes a frame with no id.
const layer = (ids, extra = {}) => ({
  visible: true,
  type: 'LAYER_TYPE_LINE',
  linkedLayerId: null,
  ...extra,
  frames: ids.map((id, i) => (id === null || id === undefined
    ? null
    : { frameNr: i, imageDataId: id === '' ? null : id })),
});

describe('framesShareDrawing — guard paths', () => {
  it('missing layer -> false', () => {
    expect(framesShareDrawing({}, LINE_LAYER_ID, [0, 1])).toBe(false);
  });

  it('layer without frames array -> false', () => {
    const layers = { [LINE_LAYER_ID]: { visible: true } };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1])).toBe(false);
  });

  it('frameNrs not an array -> false', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'a']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, null)).toBe(false);
  });

  it('empty frameNrs -> false', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'a']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [])).toBe(false);
  });
});

describe('framesShareDrawing — normal id-equality path', () => {
  it('all equal -> true', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'a', 'a']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1, 2])).toBe(true);
  });

  it('one differs -> false', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'b', 'a']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1, 2])).toBe(false);
  });

  it('single-frame array -> true', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'b']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0])).toBe(true);
  });

  it('a requested frame is missing -> false', () => {
    // frames[1] is a hole; the normal path maps it to `false`, breaking equality.
    const layers = { [LINE_LAYER_ID]: layer(['a', null, 'a']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1, 2])).toBe(false);
  });

  it('QUIRK: first frame has an id but a later requested frame has none -> false', () => {
    // The ghost fallback only triggers off the FIRST frame; here it does not,
    // so a later id-less frame contributes `false` and equality fails even
    // though every frame with an id agrees.
    const layers = { [LINE_LAYER_ID]: layer(['a', '', 'a']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1, 2])).toBe(false);
  });
});

describe('framesShareDrawing — ghost-frame fallback', () => {
  it('line ghosts compared via colorLayer1 (all same) -> true', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['', '']),
      [COLOR_LAYER_ID]: layer(['c', 'c']),
    };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1])).toBe(true);
  });

  it('line ghosts compared via colorLayer1 (differ) -> false', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['', '']),
      [COLOR_LAYER_ID]: layer(['c', 'd']),
    };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1])).toBe(false);
  });

  it('color ghosts compared via lineLayer1 (all same) -> true (both directions)', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['x', 'x']),
      [COLOR_LAYER_ID]: layer(['', '']),
    };
    expect(framesShareDrawing(layers, COLOR_LAYER_ID, [0, 1])).toBe(true);
  });

  it('ghost path with missing linked layer -> false', () => {
    const layers = { [LINE_LAYER_ID]: layer(['', '']) };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1])).toBe(false);
  });

  it('ghost path where linked frame has no id -> false', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['', '']),
      [COLOR_LAYER_ID]: layer(['c', '']),
    };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1])).toBe(false);
  });

  it('QUIRK: ghost fallback discards any non-ghost frame in the request', () => {
    // First frame is a ghost so the fallback runs; the second frame HAS an id
    // (frame.imageDataId truthy) and is mapped to `false` ("only consider ghost
    // frames"), so a genuinely-held pair can never register as "same" once one
    // side has an id. Preserved to match the getter exactly.
    const layers = {
      [LINE_LAYER_ID]: layer(['', 'a']),
      [COLOR_LAYER_ID]: layer(['c', 'c']),
    };
    expect(framesShareDrawing(layers, LINE_LAYER_ID, [0, 1])).toBe(false);
  });
});

describe('holdBlocks', () => {
  it('consecutive holds form one block, distinct ids split', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'a', 'a', 'b', 'b']) };
    expect(holdBlocks(layers, LINE_LAYER_ID)).toEqual([
      { imageDataId: 'a', frameNrs: [0, 1, 2] },
      { imageDataId: 'b', frameNrs: [3, 4] },
    ]);
  });

  it('non-consecutive reuse of the same drawing yields separate blocks', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'b', 'a']) };
    expect(holdBlocks(layers, LINE_LAYER_ID)).toEqual([
      { imageDataId: 'a', frameNrs: [0] },
      { imageDataId: 'b', frameNrs: [1] },
      { imageDataId: 'a', frameNrs: [2] },
    ]);
  });

  it('null / no-id gaps break a run and are excluded', () => {
    // frame 2 is a hole, frame 3 has no id: both break the a-run, and the
    // trailing a starts a fresh block (non-consecutive with frame 1).
    const layers = { [LINE_LAYER_ID]: layer(['a', 'a', null, '', 'a']) };
    expect(holdBlocks(layers, LINE_LAYER_ID)).toEqual([
      { imageDataId: 'a', frameNrs: [0, 1] },
      { imageDataId: 'a', frameNrs: [4] },
    ]);
  });

  it('same id but a gap in explicit frameNrs order is not consecutive', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', 'a', 'a']) };
    expect(holdBlocks(layers, LINE_LAYER_ID, [0, 2])).toEqual([
      { imageDataId: 'a', frameNrs: [0] },
      { imageDataId: 'a', frameNrs: [2] },
    ]);
  });

  it('missing layer -> []', () => {
    expect(holdBlocks({}, LINE_LAYER_ID)).toEqual([]);
  });
});

describe('uniqueDrawings', () => {
  it('inserts by first occurrence, groups all frameNrs', () => {
    const layers = { [LINE_LAYER_ID]: layer(['b', 'a', 'b', 'a']) };
    const result = uniqueDrawings(layers, LINE_LAYER_ID, [0, 1, 2, 3]);
    expect([...result.keys()]).toEqual(['b', 'a']);
    expect(result.get('b')).toEqual([0, 2]);
    expect(result.get('a')).toEqual([1, 3]);
  });

  it('skips null frames and frames without an id', () => {
    const layers = { [LINE_LAYER_ID]: layer(['a', null, '', 'a']) };
    const result = uniqueDrawings(layers, LINE_LAYER_ID, [0, 1, 2, 3]);
    expect([...result.keys()]).toEqual(['a']);
    expect(result.get('a')).toEqual([0, 3]);
  });

  it('missing layer -> empty map', () => {
    expect(uniqueDrawings({}, LINE_LAYER_ID, [0, 1]).size).toBe(0);
  });
});

describe('celAt', () => {
  it('both line and color present', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['L0', 'L1']),
      [COLOR_LAYER_ID]: layer(['C0', 'C1']),
    };
    expect(celAt(layers, 1)).toEqual({ frameNr: 1, lineImageId: 'L1', colorImageId: 'C1' });
  });

  it('line only -> color null', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['L0']),
      [COLOR_LAYER_ID]: layer(['']),
    };
    expect(celAt(layers, 0)).toEqual({ frameNr: 0, lineImageId: 'L0', colorImageId: null });
  });

  it('color only -> line null', () => {
    const layers = {
      [LINE_LAYER_ID]: layer([null]),
      [COLOR_LAYER_ID]: layer(['C0']),
    };
    expect(celAt(layers, 0)).toEqual({ frameNr: 0, lineImageId: null, colorImageId: 'C0' });
  });

  it('neither -> null', () => {
    const layers = {
      [LINE_LAYER_ID]: layer(['', null]),
      [COLOR_LAYER_ID]: layer([null, '']),
    };
    expect(celAt(layers, 0)).toBe(null);
    expect(celAt(layers, 1)).toBe(null);
  });

  it('missing layers entirely -> null', () => {
    expect(celAt({}, 0)).toBe(null);
  });
});
