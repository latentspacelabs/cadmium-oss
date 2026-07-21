import {
  normalisePaletteEntry,
  paletteEntryParticipates,
  paletteEntryChanged,
  resolveNewOpacity,
  buildSwatchMapping,
  planPaletteRecolor,
  planRecolorTargets,
} from '@/services/palette-recolor';
import { hexToRgbArray, rgbaArrayToUint32 } from '@/util/color-util';
import { COLOR_LAYER_ID } from '@/services/xsheet';

// Helper: a fully-specified palette entry with all new* fields matching the
// old ones (i.e. an unchanged swatch) unless overridden.
function entry(overrides = {}) {
  return {
    hex: '#ff0000',
    newHex: '#ff0000',
    opacity: 255,
    newOpacity: 255,
    visible: true,
    newVisible: true,
    selected: false,
    ...overrides,
  };
}

describe('normalisePaletteEntry', () => {
  it('fills legacy null fields with defaults, in order', () => {
    const e = normalisePaletteEntry({
      hex: '#123456',
      newHex: null,
      visible: null,
      opacity: null,
      newOpacity: null,
      newVisible: null,
    });
    expect(e.newHex).toBe('#123456'); // <- hex
    expect(e.visible).toBe(true);
    expect(e.opacity).toBe(255);
    expect(e.newOpacity).toBe(255); // <- post-default opacity
    expect(e.newVisible).toBe(true); // <- post-default visible
  });

  it('mutates the entry in place and returns the same object', () => {
    const e = { hex: '#000000', newHex: null, visible: true, opacity: 255, newOpacity: 255, newVisible: true };
    const ret = normalisePaletteEntry(e);
    expect(ret).toBe(e);
    expect(e.newHex).toBe('#000000');
  });

  it('leaves undefined fields untouched (=== null, not == null)', () => {
    const e = normalisePaletteEntry({ hex: '#abcdef' /* newHex undefined */ });
    expect(e.newHex).toBeUndefined();
  });

  it('does not overwrite already-set fields', () => {
    const e = normalisePaletteEntry(entry({ hex: '#ff0000', newHex: '#00ff00', opacity: 128, newOpacity: 64, visible: false, newVisible: false }));
    expect(e.newHex).toBe('#00ff00');
    expect(e.opacity).toBe(128);
    expect(e.newOpacity).toBe(64);
    expect(e.visible).toBe(false);
    expect(e.newVisible).toBe(false);
  });
});

describe('paletteEntryParticipates', () => {
  it('all entries participate when committing all frames', () => {
    expect(paletteEntryParticipates(entry({ selected: false }), true)).toBe(true);
    expect(paletteEntryParticipates(entry({ selected: true }), true)).toBe(true);
  });

  it('only selected entries participate in preview mode', () => {
    expect(paletteEntryParticipates(entry({ selected: true }), false)).toBe(true);
    expect(paletteEntryParticipates(entry({ selected: false }), false)).toBe(false);
  });
});

describe('paletteEntryChanged', () => {
  it('is false when hex, opacity and visibility all match', () => {
    expect(paletteEntryChanged(entry())).toBe(false);
  });

  it('detects a hex change', () => {
    expect(paletteEntryChanged(entry({ newHex: '#00ff00' }))).toBe(true);
  });

  it('detects an opacity change', () => {
    expect(paletteEntryChanged(entry({ newOpacity: 128 }))).toBe(true);
  });

  it('detects a visibility change', () => {
    expect(paletteEntryChanged(entry({ newVisible: false }))).toBe(true);
  });
});

describe('resolveNewOpacity', () => {
  it('returns newOpacity when the entry stays visible', () => {
    expect(resolveNewOpacity(entry({ newOpacity: 200, newVisible: true }))).toBe(200);
  });

  it('forces opacity 0 when the entry is turned invisible', () => {
    expect(resolveNewOpacity(entry({ newOpacity: 200, newVisible: false }))).toBe(0);
  });
});

describe('buildSwatchMapping', () => {
  it('packs old and new colors via the color-util byte order', () => {
    const e = entry({ hex: '#ff0000', opacity: 255, newHex: '#0000ff', newOpacity: 128, newVisible: true });
    const mapping = buildSwatchMapping(e);
    // Derived with the same helpers to guard against drift.
    expect(mapping.uInt32).toBe(rgbaArrayToUint32([...hexToRgbArray('#ff0000'), 255]));
    expect(mapping.newUint32).toBe(rgbaArrayToUint32([...hexToRgbArray('#0000ff'), 128]));
  });

  it('locks the exact uint32 byte order (hand-computed literal)', () => {
    // #ff0000 opaque -> [255, 0, 0, 255]; rgbaArrayToUint32 prepends each
    // component's 2-hex-digit string r->a (so the string is AABBGGRR):
    // "ff"+"00"+"00"+"ff" = "ff0000ff" -> 0xff0000ff = 4278190335.
    const mapping = buildSwatchMapping(entry({ hex: '#ff0000', opacity: 255, newHex: '#ff0000', newOpacity: 255 }));
    expect(mapping.uInt32).toBe(4278190335); // 0xff0000ff
  });

  it('maps an invisible entry to a zero-alpha new color', () => {
    const mapping = buildSwatchMapping(entry({ hex: '#ff0000', opacity: 255, newHex: '#ff0000', newOpacity: 255, newVisible: false }));
    // rgbaArrayToUint32 prepends r->a, so the string is AABBGGRR. With
    // [255,0,0,0] that is "00"+"00"+"00"+"ff" = "000000ff" = 255 (alpha 0 zeroes
    // out the high byte, leaving just red in the low byte).
    expect(mapping.newUint32).toBe(255);
  });
});

describe('planPaletteRecolor', () => {
  it('returns an empty plan for an unchanged palette', () => {
    const palette = [entry(), entry({ hex: '#00ff00', newHex: '#00ff00' })];
    expect(planPaletteRecolor(palette, true)).toEqual([]);
  });

  it('plans a hex change (committing all frames)', () => {
    const palette = [entry({ hex: '#ff0000', newHex: '#0000ff' })];
    const plan = planPaletteRecolor(palette, true);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      uInt32: rgbaArrayToUint32([...hexToRgbArray('#ff0000'), 255]),
      newUint32: rgbaArrayToUint32([...hexToRgbArray('#0000ff'), 255]),
    });
  });

  it('plans an opacity change', () => {
    const palette = [entry({ newOpacity: 128 })];
    const plan = planPaletteRecolor(palette, true);
    expect(plan).toHaveLength(1);
    expect(plan[0].newUint32).toBe(rgbaArrayToUint32([...hexToRgbArray('#ff0000'), 128]));
  });

  it('plans a visibility toggle as a zero-alpha mapping', () => {
    const palette = [entry({ newVisible: false })];
    const plan = planPaletteRecolor(palette, true);
    expect(plan).toHaveLength(1);
    expect(plan[0].newUint32).toBe(rgbaArrayToUint32([...hexToRgbArray('#ff0000'), 0]));
  });

  it('plans combinations across multiple entries, preserving order', () => {
    const palette = [
      entry({ hex: '#ff0000', newHex: '#ff0000' }), // unchanged -> skipped
      entry({ hex: '#00ff00', newHex: '#0000ff' }), // hex change
      entry({ hex: '#123456', newHex: '#123456', newOpacity: 10 }), // opacity change
      entry({ hex: '#abcdef', newHex: '#abcdef', newVisible: false }), // hidden
    ];
    const plan = planPaletteRecolor(palette, true);
    expect(plan).toHaveLength(3);
    expect(plan[0].newUint32).toBe(rgbaArrayToUint32([...hexToRgbArray('#0000ff'), 255]));
    expect(plan[1].newUint32).toBe(rgbaArrayToUint32([...hexToRgbArray('#123456'), 10]));
    expect(plan[2].newUint32).toBe(rgbaArrayToUint32([...hexToRgbArray('#abcdef'), 0]));
  });

  it('in preview mode only selected entries are planned', () => {
    const palette = [
      entry({ hex: '#ff0000', newHex: '#0000ff', selected: false }), // changed but not selected
      entry({ hex: '#00ff00', newHex: '#0000ff', selected: true }), // changed and selected
    ];
    const plan = planPaletteRecolor(palette, false);
    expect(plan).toHaveLength(1);
    expect(plan[0].uInt32).toBe(rgbaArrayToUint32([...hexToRgbArray('#00ff00'), 255]));
  });

  it('normalises legacy null fields in place before diffing', () => {
    const palette = [{
      hex: '#123456',
      newHex: null, // -> #123456, so this entry is unchanged
      visible: null,
      opacity: null,
      newOpacity: null,
      newVisible: null,
      selected: true,
    }];
    const plan = planPaletteRecolor(palette, true);
    expect(plan).toEqual([]); // no change after normalisation
    // side effect: the entry now carries defaulted fields for the later reset
    expect(palette[0].newHex).toBe('#123456');
    expect(palette[0].opacity).toBe(255);
    expect(palette[0].newOpacity).toBe(255);
    expect(palette[0].visible).toBe(true);
    expect(palette[0].newVisible).toBe(true);
  });
});

// ── mergePaletteRgba / extractPaletteRgba (POPULATE_PALETTE core) ───────────────
// eslint-disable-next-line import/first
import { mergePaletteRgba, extractPaletteRgba } from '@/services/palette-recolor';

describe('extractPaletteRgba', () => {
  it('picks the palette array out of each supported response shape (in precedence order)', () => {
    expect(extractPaletteRgba({ ref_palette_rgba: [[1, 2, 3, 4]] })).toEqual([[1, 2, 3, 4]]);
    expect(extractPaletteRgba({ target_palette_rgba: [[5, 6, 7, 8]] })).toEqual([[5, 6, 7, 8]]);
    expect(extractPaletteRgba({ palette_rgba: [[9, 9, 9, 9]] })).toEqual([[9, 9, 9, 9]]);
    expect(extractPaletteRgba({ colors_rgba: [[1, 1, 1, 1]] })).toEqual([[1, 1, 1, 1]]);
    // ref_palette_rgba wins over the others when several are present
    expect(extractPaletteRgba({ ref_palette_rgba: [[1]], palette_rgba: [[2]] })).toEqual([[1]]);
  });

  it('returns [] for falsy / unknown responses', () => {
    expect(extractPaletteRgba(null)).toEqual([]);
    expect(extractPaletteRgba({})).toEqual([]);
    expect(extractPaletteRgba({ nope: 1 })).toEqual([]);
  });
});

describe('mergePaletteRgba', () => {
  it('dedupes by hex against the existing palette (nothing new -> no additions)', () => {
    const existing = [{ hex: '#ff0000' }];
    // [255,0,0,255] -> hex #ff0000ff -> slice(0,-2) -> #ff0000 (already present)
    expect(mergePaletteRgba(existing, [[255, 0, 0, 255]])).toEqual([]);
  });

  it('adds new swatches with the exact ADD_COLOR_TO_PALETTE shape', () => {
    const additions = mergePaletteRgba([], [[0, 255, 0, 255]]);
    expect(additions).toEqual([{
      hex: '#00ff00',
      newHex: '#00ff00',
      visible: true,
      newVisible: true,
      selected: false,
      firstSelected: false,
      opacity: 255,
      newOpacity: 255,
    }]);
  });

  it('skips fully-transparent entries (alpha 0)', () => {
    expect(mergePaletteRgba([], [[10, 20, 30, 0]])).toEqual([]);
    // a non-zero alpha entry is kept alongside a skipped alpha-0 one
    const additions = mergePaletteRgba([], [[10, 20, 30, 0], [255, 255, 255, 255]]);
    expect(additions.map(a => a.hex)).toEqual(['#ffffff']);
  });

  it('tolerates object-shaped entries {r,g,b,a} (a defaults to 255)', () => {
    const additions = mergePaletteRgba([], [{ r: 0, g: 0, b: 255 }]);
    expect(additions.map(a => a.hex)).toEqual(['#0000ff']);
    // an object entry with a:0 is skipped like the array form
    expect(mergePaletteRgba([], [{ r: 1, g: 2, b: 3, a: 0 }])).toEqual([]);
  });

  it('dedupes WITHIN one response (a colour repeated in the array is added once)', () => {
    const additions = mergePaletteRgba([], [[1, 2, 3, 255], [1, 2, 3, 255]]);
    expect(additions).toHaveLength(1);
  });

  it('returns [] for a non-array / empty palette-rgba', () => {
    expect(mergePaletteRgba([], null)).toEqual([]);
    expect(mergePaletteRgba([], [])).toEqual([]);
  });
});

// planRecolorTargets — the READ side of URI_CHANGE_COLOR (replaces the old
// imageId-equality accumulator walk). Locks the exact seed-first ordering,
// uniqueDrawings-based dedupe, and null-URI (ghost) skipping the action relied
// on, so the accumulator -> plan swap is provably behaviour-preserving.
describe('planRecolorTargets', () => {
  // Color layer: frames 1,2 share C1 (a hold), frame 3 is C2, frame 4 is a
  // ghost color cel whose blank image resolves to a null URI.
  const layers = {
    [COLOR_LAYER_ID]: {
      frames: [
        null,
        { frameNr: 1, imageDataId: 'C1' },
        { frameNr: 2, imageDataId: 'C1' },
        { frameNr: 3, imageDataId: 'C2' },
        { frameNr: 4, imageDataId: 'GHOST' },
      ],
    },
  };
  const uris = {
    C1: 'uri-C1', C2: 'uri-C2', GHOST: null, SEL: 'uri-SEL',
  };
  const uriById = (id) => (id in uris ? uris[id] : null);

  it('processes the seed first, then unique color images (dupes + ghosts dropped)', () => {
    const targets = planRecolorTargets({
      layers,
      colorLayerId: COLOR_LAYER_ID,
      frameNrs: [1, 2, 3, 4],
      seed: { imageDataId: 'SEL', dataUri: 'uri-SEL' },
      uriById,
    });
    expect(targets).toEqual([
      { imageDataId: 'SEL', dataUri: 'uri-SEL' },
      { imageDataId: 'C1', dataUri: 'uri-C1' }, // frame 2 (dupe) not re-added
      { imageDataId: 'C2', dataUri: 'uri-C2' },
      // GHOST dropped: its URI is null
    ]);
  });

  it('omits the seed when its data URI is falsy (ghost-selected frame)', () => {
    const targets = planRecolorTargets({
      layers,
      colorLayerId: COLOR_LAYER_ID,
      frameNrs: [1, 2, 3, 4],
      seed: { imageDataId: 'SEL', dataUri: null },
      uriById,
    });
    expect(targets).toEqual([
      { imageDataId: 'C1', dataUri: 'uri-C1' },
      { imageDataId: 'C2', dataUri: 'uri-C2' },
    ]);
  });

  it('never adds the seed image twice when it also appears in the scan', () => {
    const targets = planRecolorTargets({
      layers,
      colorLayerId: COLOR_LAYER_ID,
      frameNrs: [1, 2, 3],
      seed: { imageDataId: 'C1', dataUri: 'uri-SEL' },
      uriById,
    });
    expect(targets).toEqual([
      { imageDataId: 'C1', dataUri: 'uri-SEL' }, // seed value wins, only once
      { imageDataId: 'C2', dataUri: 'uri-C2' },
    ]);
  });

  it('preview mode (no frame scan) processes only the seed', () => {
    const targets = planRecolorTargets({
      layers,
      colorLayerId: COLOR_LAYER_ID,
      frameNrs: [],
      seed: { imageDataId: 'SEL', dataUri: 'uri-SEL' },
      uriById,
    });
    expect(targets).toEqual([{ imageDataId: 'SEL', dataUri: 'uri-SEL' }]);
  });

  it('returns [] when there is neither a seed nor a scan', () => {
    expect(planRecolorTargets({
      layers, colorLayerId: COLOR_LAYER_ID, frameNrs: [], seed: null, uriById,
    })).toEqual([]);
  });
});
