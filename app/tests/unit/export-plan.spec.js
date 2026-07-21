// Golden tests for the pure export planning logic. These lock the exact
// filenames, format flags, numbering and presets the EXPORT actions produced
// inline, so the extraction is provably behaviour-preserving.
import {
  EXPORT_FORMAT,
  parseExportTarget,
  planExportFormat,
  colorPassPaths,
  frameExportStem,
  exportFrameRange,
  normalizeExportFps,
  svgTracerOptions,
  makeRgbPalette,
  exportSnapshot,
  planExport,
  resolveExportTarget,
} from '@/services/export-plan';
import { LINE_LAYER_ID, COLOR_LAYER_ID } from '@/services/xsheet';
import {
  FRAME_COUNT,
  CANVAS_SIZE,
  BACKGROUND_COLOR,
  COLOR_PALETTE,
} from '@/store/getter-types';

describe('parseExportTarget', () => {
  it('splits folder, prefix, ext and the ext-stripped base', () => {
    expect(parseExportTarget('/Users/me/out/cadmium_export.png')).toEqual({
      folder: '/Users/me/out',
      prefix: 'cadmium_export',
      ext: 'png',
      filePathNoExtBase: '/Users/me/out/cadmium_export',
    });
  });

  it('handles svg and mp4 the same way (4-char extensions)', () => {
    expect(parseExportTarget('/a/b/proj.svg').filePathNoExtBase).toBe('/a/b/proj');
    expect(parseExportTarget('/a/b/proj.mp4').ext).toBe('mp4');
  });

  it('takes the prefix from before the first dot', () => {
    expect(parseExportTarget('/a/my.export.v2.png').prefix).toBe('my');
  });
});

describe('planExportFormat', () => {
  it('png writes straight through with alpha', () => {
    expect(planExportFormat(EXPORT_FORMAT.PNG)).toEqual({ requiresTmpExport: false, alphaChannel: true });
  });
  it('svg goes via temp PNGs, keeps alpha', () => {
    expect(planExportFormat(EXPORT_FORMAT.SVG)).toEqual({ requiresTmpExport: true, alphaChannel: true });
  });
  it('mp4 goes via temp PNGs, flattens alpha', () => {
    expect(planExportFormat(EXPORT_FORMAT.MP4)).toEqual({ requiresTmpExport: true, alphaChannel: false });
  });
  it('defaults unknown extensions to png behaviour', () => {
    expect(planExportFormat('gif')).toEqual({ requiresTmpExport: false, alphaChannel: true });
  });
});

describe('colorPassPaths', () => {
  it('names the first color pass color01 in its own subfolder', () => {
    expect(colorPassPaths('/out', 'proj', 0)).toEqual({
      colorNumber: 'color01',
      subFolder: '/out/color01',
      filePathNoExt: '/out/color01/proj_color01',
      filePathMp4: '/out/color01/proj_color01.mp4',
    });
  });

  it('is 1-based and zero-pads to two digits', () => {
    expect(colorPassPaths('/out', 'p', 11).colorNumber).toBe('color12');
  });
});

describe('frameExportStem', () => {
  it('subtracts the frame-0 hack and pads to (frameCount digits - 1)', () => {
    // frameCount 100 -> 3 digits -> pad width 2; frame 5 -> exportNr 4 -> "04"
    expect(frameExportStem('/out/proj', 5, 100)).toEqual({
      paddedFrameNr: '04',
      stem: '/out/proj_04',
    });
  });

  it('widens padding for larger sequences', () => {
    // frameCount 1000 -> 4 digits -> pad width 3; frame 42 -> exportNr 41 -> "041"
    expect(frameExportStem('/out/proj', 42, 1000).paddedFrameNr).toBe('041');
  });

  it('uses no padding for single-digit frame counts', () => {
    // frameCount 5 -> 1 digit -> pad width 0
    expect(frameExportStem('/out/proj', 3, 5).paddedFrameNr).toBe('2');
  });
});

describe('exportFrameRange', () => {
  it('is inclusive of both ends', () => {
    expect(exportFrameRange(1, 4)).toEqual([1, 2, 3, 4]);
  });
  it('returns a single frame when first equals last', () => {
    expect(exportFrameRange(7, 7)).toEqual([7]);
  });
});

describe('normalizeExportFps', () => {
  it.each([
    [24, 24],
    [30, 30],
    [60, 60],
    [120, 60], // clamped to max
    ['30', 30], // numeric string
    [0, 24], // junk -> default
    [-5, 24],
    [NaN, 24],
    [undefined, 24],
    ['abc', 24],
  ])('normalizeExportFps(%p) -> %p', (input, expected) => {
    expect(normalizeExportFps(input)).toBe(expected);
  });
});

describe('svgTracerOptions', () => {
  const pal = [{ r: 1, g: 2, b: 3, a: 255 }];

  it('high (0) sets the fine-detail preset and passes the palette', () => {
    expect(svgTracerOptions(0, pal)).toEqual({
      scale: 1, strokewidth: 0.5, colorsampling: 0, colorquantcycles: 1, pal,
      blurradius: 2, blurdelta: 3, ltres: 0.05, qtres: 0.05, rightangleenhance: false, pathomit: 4,
    });
  });

  it('medium (1) caps colors at 50', () => {
    const opts = svgTracerOptions(1, pal);
    expect(opts.numberofcolors).toBe(50);
    expect(opts.pathomit).toBe(10);
  });

  it('low (2) is just the base preset', () => {
    expect(svgTracerOptions(2, pal)).toEqual({
      scale: 1, strokewidth: 0.5, colorsampling: 0, colorquantcycles: 1, pal,
    });
  });
});

describe('makeRgbPalette', () => {
  it('maps each hex to {r,g,b,a:255} and appends a transparent entry', () => {
    expect(makeRgbPalette([{ hex: '#010203' }, { hex: '#ffffff' }])).toEqual([
      { r: 1, g: 2, b: 3, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 0, g: 0, b: 0, a: 0 },
    ]);
  });

  it('an empty palette is just the transparent entry', () => {
    expect(makeRgbPalette([])).toEqual([{ r: 0, g: 0, b: 0, a: 0 }]);
  });
});

// A small line+color timeline: frames 1..3 real, each with a drawing on both
// layers (frame 0 is the placeholder slot).
const makeLayers = () => ({
  [LINE_LAYER_ID]: { frames: [null, { imageDataId: 'l1' }, { imageDataId: 'l2' }, { imageDataId: 'l3' }] },
  [COLOR_LAYER_ID]: { frames: [null, { imageDataId: 'c1' }, { imageDataId: 'c2' }, { imageDataId: 'c3' }] },
});

const makeSnapshot = (overrides = {}) => ({
  firstRealFrameNumber: 1,
  lastRealFrameNumber: 3,
  frameCount: 10,
  palette: [{ hex: '#ff0000' }, { hex: '#00ff00' }],
  layersVisible: { line: true, color: true },
  canvasSize: { width: 8, height: 8 },
  backgroundColor: '#ffffff',
  fps: 24,
  layers: makeLayers(),
  ...overrides,
});

describe('planExport errors', () => {
  it('NO_VISIBLE_LAYERS when neither layer is visible', () => {
    expect(planExport(makeSnapshot({ layersVisible: { line: false, color: false } })))
      .toEqual({ error: 'NO_VISIBLE_LAYERS' });
  });

  it('NO_FRAMES when the real-frame range is empty', () => {
    expect(planExport(makeSnapshot({ firstRealFrameNumber: 5, lastRealFrameNumber: 3 })))
      .toEqual({ error: 'NO_FRAMES' });
  });

  it('EMPTY_PALETTE only for colors-separated', () => {
    const snap = makeSnapshot({ palette: [] });
    expect(planExport(snap, { kind: 'colors-separated' })).toEqual({ error: 'EMPTY_PALETTE' });
    // flat export with an empty palette is fine (one flat pass)
    expect(planExport(snap, { kind: 'flat' }).error).toBeUndefined();
  });
});

describe('planExport success', () => {
  it('flat: one pass and per-frame cel ids from xsheet', () => {
    const plan = planExport(makeSnapshot(), { kind: 'flat' });
    expect(plan.passes).toEqual([{ index: null }]);
    expect(plan.frames).toEqual([
      { frameNr: 1, lineImageId: 'l1', colorImageId: 'c1' },
      { frameNr: 2, lineImageId: 'l2', colorImageId: 'c2' },
      { frameNr: 3, lineImageId: 'l3', colorImageId: 'c3' },
    ]);
    expect(plan.frameCount).toBe(10);
    expect(plan.canvasSize).toEqual({ width: 8, height: 8 });
  });

  it('colors-separated: one pass per palette swatch', () => {
    const plan = planExport(makeSnapshot(), { kind: 'colors-separated' });
    expect(plan.passes).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it('carries null cel ids for frames with no drawing on a layer', () => {
    const layers = makeLayers();
    layers[COLOR_LAYER_ID].frames[2] = null; // frame 2 has no color
    const plan = planExport(makeSnapshot({ layers }), { kind: 'flat' });
    expect(plan.frames[1]).toEqual({ frameNr: 2, lineImageId: 'l2', colorImageId: null });
  });
});

describe('resolveExportTarget', () => {
  it('flat: writes at the chosen path, one pass, no subfolder', () => {
    const plan = planExport(makeSnapshot(), { kind: 'flat' });
    const resolved = resolveExportTarget(plan, '/out/proj.png');
    expect(resolved.ext).toBe('png');
    expect(resolved.alphaChannel).toBe(true);
    expect(resolved.requiresTmpExport).toBe(false);
    expect(resolved.passes).toEqual([{
      index: null, subFolder: null, filePathNoExt: '/out/proj', filePathMp4: '/out/proj.png',
    }]);
    expect(resolved.rgbPalette).toEqual(makeRgbPalette(plan.palette));
  });

  it('colors-separated: each pass gets its color subfolder via colorPassPaths', () => {
    const plan = planExport(makeSnapshot(), { kind: 'colors-separated' });
    const resolved = resolveExportTarget(plan, '/out/proj.png');
    expect(resolved.passes[0]).toEqual({
      index: 0,
      subFolder: '/out/color01',
      filePathNoExt: '/out/color01/proj_color01',
      filePathMp4: '/out/color01/proj_color01.mp4',
    });
    expect(resolved.passes[1].subFolder).toBe('/out/color02');
  });

  it('carries the svg quality tier through', () => {
    const plan = planExport(makeSnapshot(), { kind: 'flat' });
    expect(resolveExportTarget(plan, '/out/proj.svg', { svgQualityNum: 1 }).svgQualityNum).toBe(1);
  });
});

describe('exportSnapshot', () => {
  it('extracts plain data and deep-copies the palette', () => {
    const palette = [{ hex: '#ff0000', opacity: 255 }];
    const state = {
      firstRealFrameNumber: 1,
      lastRealFrameNumber: 3,
      playerFps: 12,
      layers: {
        [LINE_LAYER_ID]: { visible: true },
        [COLOR_LAYER_ID]: { visible: false },
      },
    };
    const getters = {
      [FRAME_COUNT]: 10,
      [CANVAS_SIZE]: { width: 5, height: 6 },
      [BACKGROUND_COLOR]: '#000000',
      [COLOR_PALETTE]: palette,
    };
    const snap = exportSnapshot(state, getters);
    expect(snap.layersVisible).toEqual({ line: true, color: false });
    expect(snap.canvasSize).toEqual({ width: 5, height: 6 });
    expect(snap.fps).toBe(12);
    expect(snap.palette).toEqual(palette);
    expect(snap.palette).not.toBe(palette); // copy
    expect(snap.palette[0]).not.toBe(palette[0]); // entries copied too
    expect(snap.layers).toBe(state.layers); // by reference (read-only, for celAt)
  });
});
