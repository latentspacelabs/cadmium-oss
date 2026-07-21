// Golden tests for the pure .cdm serializer/parser. These lock the exact
// on-disk format (the two literal markers, the JSON layout) and the fragile
// marker-offset parse the LOAD_FILE action produced inline, so the extraction
// is provably behaviour-preserving.
import {
  MIN_SUPPORTED_VERSION,
  SAVE_FORMAT_VERSION,
  serializeProject,
  parseProject,
  isProjectTooOld,
  deriveDocument,
  validateDocument,
} from '@/services/cdm-format';
import { LINE_LAYER_ID, COLOR_LAYER_ID } from '@/services/xsheet';

// A realistic project: nested ImageStore with a segmentationMapPath, a
// tempFilePaths array, and tempImages carrying base64 data URIs.
const realisticParts = {
  metadata: [{ version: '1.5.0' }],
  saveState: {
    ImageStore: {
      imageDataById: {
        img1: { segmentationMapPath: '/tmp/cadmium/seg_img1.png', width: 800 },
        img2: { segmentationMapPath: '/tmp/cadmium/seg_img2.png', width: 800 },
      },
    },
    tempFilePaths: [
      '/tmp/cadmium/frame_001.png',
      '/tmp/cadmium/frame_002.png',
    ],
    someScalar: 42,
  },
  tempImages: [
    { filename: '/tmp/cadmium/frame_001.png', data: 'data:image/png;base64,AAAA' },
    { filename: '/tmp/cadmium/frame_002.png', data: 'data:image/png;base64,BBBB' },
  ],
};

describe('serializeProject / parseProject round-trip', () => {
  it('parse(serialize(x)) recovers every part', () => {
    const str = serializeProject(realisticParts);
    const parsed = parseProject(str);
    expect(parsed.metadata).toEqual(realisticParts.metadata);
    expect(parsed.version).toBe('1.5.0');
    expect(parsed.saveState).toEqual(realisticParts.saveState);
    expect(parsed.tempImages).toEqual(realisticParts.tempImages);
  });

  it('round-trips an empty tempImages array', () => {
    const parts = {
      metadata: [{ version: '0.3.0' }],
      saveState: { ImageStore: { imageDataById: {} }, tempFilePaths: [] },
      tempImages: [],
    };
    const parsed = parseProject(serializeProject(parts));
    expect(parsed.saveState).toEqual(parts.saveState);
    expect(parsed.tempImages).toEqual([]);
  });
});

describe('serializeProject golden layout', () => {
  it('emits <metadata>BEGINSAVESTATE<state>BEGINTEMPIMAGES<tempImages>', () => {
    const str = serializeProject({
      metadata: [{ version: '1.0.0' }],
      saveState: { a: 1 },
      tempImages: [{ filename: 'f.png', data: 'data:x' }],
    });
    expect(str).toBe(
      '[{"version":"1.0.0"}]BEGINSAVESTATE{"a":1}BEGINTEMPIMAGES[{"filename":"f.png","data":"data:x"}]',
    );
  });
});

describe('parseProject robustness (matches original offset semantics)', () => {
  it('takes metadata from the first "[" to the first "]"', () => {
    // The state section also contains brackets, but metadata extraction must
    // stop at the first "]" — the closing bracket of the metadata array.
    const str = serializeProject({
      metadata: [{ version: '2.0.0' }],
      saveState: { list: [1, 2, 3] },
      tempImages: [],
    });
    expect(parseProject(str).metadata).toEqual([{ version: '2.0.0' }]);
    expect(parseProject(str).version).toBe('2.0.0');
  });

  it('slices the state strictly between the two markers', () => {
    const str = serializeProject({
      metadata: [{ version: '1.2.3' }],
      saveState: { nested: { deep: true }, n: 0 },
      tempImages: [{ filename: 'x', data: 'y' }],
    });
    expect(parseProject(str).saveState).toEqual({ nested: { deep: true }, n: 0 });
  });
});

// ── .cdm v2: derived document, roundtrip, v1 compat, validation seam ──────────

// A save-state with a 3-frame timeline: line frames 1,2 hold the same drawing
// (L1), frame 3 is a new drawing (L2). Color is attached (imported/reference)
// at frames 1,2 (C1); frame 3 has no color cel.
const v2SaveState = {
  layers: {
    [LINE_LAYER_ID]: {
      frames: [
        null,
        { frameNr: 1, imageDataId: 'L1' },
        { frameNr: 2, imageDataId: 'L1' },
        { frameNr: 3, imageDataId: 'L2' },
      ],
    },
    [COLOR_LAYER_ID]: {
      frames: [
        null,
        { frameNr: 1, imageDataId: 'C1', isOriginal: true },
        { frameNr: 2, imageDataId: 'C1', isOriginal: false },
        null,
      ],
    },
  },
  firstRealFrameNumber: 1,
  lastRealFrameNumber: 3,
  canvasWidth: 800,
  canvasHeight: 600,
  colorPalette: [{ hex: '#ff0000' }],
  tempFilePaths: [],
  // Real drawings carry bytes; ids without a byte-carrying record are ghosts
  // and must not surface in the derived document.
  ImageStore: {
    imageDataById: {
      L1: { dataUri: 'data:image/png;base64,AAA1' },
      L2: { dataUri: 'data:image/png;base64,AAA2' },
      C1: { dataUri: 'data:image/png;base64,BBB1' },
    },
  },
};

const expectedDocument = {
  canvasSize: { width: 800, height: 600 },
  palette: [{ hex: '#ff0000' }],
  cels: [
    {
      id: 'c1', lineImageId: 'L1', colorImageId: 'C1', colorProvenance: 'reference',
    },
    {
      id: 'c2', lineImageId: 'L2', colorImageId: null, colorProvenance: 'none',
    },
  ],
  exposures: {
    line: { 1: 'c1', 2: 'c1', 3: 'c2' },
    color: { 1: 'c1', 2: 'c1' },
  },
  firstReal: 1,
  lastReal: 3,
};

describe('deriveDocument', () => {
  it('derives cels (holds deduped), exposures, palette and canvas from state', () => {
    expect(deriveDocument(v2SaveState)).toEqual(expectedDocument);
  });

  it('is empty (no cels/exposures) for a state with no real frames', () => {
    const doc = deriveDocument({
      layers: {}, firstRealFrameNumber: -1, lastRealFrameNumber: -1, canvasWidth: 0, canvasHeight: 0, colorPalette: [],
    });
    expect(doc.cels).toEqual([]);
    expect(doc.exposures).toEqual({ line: {}, color: {} });
  });

  it('marks a colorized (non-original) color cel as provenance "colorized"', () => {
    const state = {
      ...v2SaveState,
      layers: {
        [LINE_LAYER_ID]: { frames: [null, { frameNr: 1, imageDataId: 'L1' }] },
        [COLOR_LAYER_ID]: { frames: [null, { frameNr: 1, imageDataId: 'C1', isOriginal: false }] },
      },
      firstRealFrameNumber: 1,
      lastRealFrameNumber: 1,
    };
    expect(deriveDocument(state).cels[0].colorProvenance).toBe('colorized');
  });

  it('treats a byte-less ghost `<lineId>_color` record as NO color (provenance none)', () => {
    const state = {
      ...v2SaveState,
      layers: {
        [LINE_LAYER_ID]: { frames: [null, { frameNr: 1, imageDataId: 'L1' }] },
        // The line-import ghost: a color frame pointing at a blank record.
        [COLOR_LAYER_ID]: { frames: [null, { frameNr: 1, imageDataId: 'L1_color', isOriginal: false }] },
      },
      ImageStore: {
        imageDataById: {
          L1: { dataUri: 'data:image/png;base64,AAA1' },
          L1_color: { dataUri: null, hash: null }, // ghost — no bytes
        },
      },
      firstRealFrameNumber: 1,
      lastRealFrameNumber: 1,
    };
    const doc = deriveDocument(state);
    expect(doc.cels).toEqual([
      {
        id: 'c1', lineImageId: 'L1', colorImageId: null, colorProvenance: 'none',
      },
    ]);
    expect(doc.exposures.color).toEqual({});
    expect(doc.exposures.line).toEqual({ 1: 'c1' });
  });
});

describe('.cdm v2 round-trip', () => {
  it('serialize(document) -> parse recovers the document deep-equal', () => {
    const document = deriveDocument(v2SaveState);
    const str = serializeProject({
      metadata: [{ version: '2.0.0' }],
      saveState: v2SaveState,
      tempImages: [{ filename: 'f.png', data: 'data:image/png;base64,AAAA' }],
      document,
    });
    const parsed = parseProject(str);
    expect(parsed.document).toEqual(document);
    // legacy sections survive unchanged alongside the new section
    expect(parsed.saveState).toEqual(v2SaveState);
    expect(parsed.tempImages).toEqual([{ filename: 'f.png', data: 'data:image/png;base64,AAAA' }]);
    expect(parsed.version).toBe('2.0.0');
  });

  it('appends the BEGINDOCUMENT section to the v1 container', () => {
    const str = serializeProject({
      metadata: [{ version: '2.0.0' }],
      saveState: { a: 1 },
      tempImages: [],
      document: { d: 1 },
    });
    expect(str).toBe(
      '[{"version":"2.0.0"}]BEGINSAVESTATE{"a":1}BEGINTEMPIMAGES[]BEGINDOCUMENT{"d":1}',
    );
  });

  it('declares the payload format version', () => {
    expect(SAVE_FORMAT_VERSION).toBe(2);
  });
});

describe('.cdm v1 compatibility (no document section)', () => {
  it('parses a v1 file (no BEGINDOCUMENT) with document:null, legacy fields intact', () => {
    // Byte-for-byte the old layout: serializeProject with no document.
    const str = serializeProject(realisticParts);
    expect(str).not.toContain('BEGINDOCUMENT');
    const parsed = parseProject(str);
    expect(parsed.document).toBeNull();
    expect(parsed.saveState).toEqual(realisticParts.saveState);
    expect(parsed.tempImages).toEqual(realisticParts.tempImages);
    expect(parsed.version).toBe('1.5.0');
  });

  it('a falsy document argument yields the exact v1 string (unchanged)', () => {
    const withUndef = serializeProject({ ...realisticParts });
    const withNull = serializeProject({ ...realisticParts, document: null });
    const v1 = serializeProject({
      metadata: realisticParts.metadata,
      saveState: realisticParts.saveState,
      tempImages: realisticParts.tempImages,
    });
    expect(withUndef).toBe(v1);
    expect(withNull).toBe(v1);
  });
});

describe('validateDocument (the flip seam)', () => {
  it('confirms a faithfully round-tripped document (ok, no mismatches)', () => {
    const document = deriveDocument(v2SaveState);
    const { saveState, document: loaded } = parseProject(serializeProject({
      metadata: [{ version: '2.0.0' }], saveState: v2SaveState, tempImages: [], document,
    }));
    expect(validateDocument(saveState, loaded)).toEqual({ ok: true, mismatches: [] });
  });

  it('names the drifting fields when the saved document disagrees with the state', () => {
    const document = deriveDocument(v2SaveState);
    const tampered = { ...document, palette: [{ hex: '#000000' }], lastReal: 99 };
    const { ok, mismatches } = validateDocument(v2SaveState, tampered);
    expect(ok).toBe(false);
    expect(mismatches.sort()).toEqual(['lastReal', 'palette']);
  });
});

describe('BEGINDOCUMENT marker-collision QUIRK (parity with the other markers)', () => {
  it('mis-splits when a section literally contains "BEGINDOCUMENT"', () => {
    // Like BEGINSAVESTATE/BEGINTEMPIMAGES, the document marker is found by a
    // first-occurrence search — a literal "BEGINDOCUMENT" inside tempImages
    // truncates the tempImages slice and corrupts the parse. Locked, not fixed.
    const str = serializeProject({
      metadata: [{ version: '2.0.0' }],
      saveState: { a: 1 },
      tempImages: [{ filename: 'x', data: 'BEGINDOCUMENT{"z":1}' }],
    });
    expect(() => parseProject(str)).toThrow();
  });
});

describe('isProjectTooOld version gate', () => {
  it('exposes the minimum supported version', () => {
    expect(MIN_SUPPORTED_VERSION).toBe('0.3.0');
  });

  it.each([
    ['0.2.9', true],
    ['0.0.1', true],
    ['0.3.0', false],
    ['1.0.0', false],
    ['1.5.0', false],
  ])('isProjectTooOld(%p) -> %p', (version, expected) => {
    expect(isProjectTooOld(version)).toBe(expected);
  });
});
