// Golden tests for the pure per-frame export decisions (export-frame.js).
//
// paletteFilter is the per-color pixel loop lifted verbatim from EXPORT_FILES
// (actions.js:1544-1603); these tests pin it pixel-by-pixel including the
// quirks. composeFramePlan is the interleaved layer-selection ifs; the matrix
// locks the ordering and the colors-separated visibility QUIRK.
//
// LITTLE-ENDIAN: jest runs on a little-endian host, so the Uint32Array view of
// an [R,G,B,A] byte buffer is 0xAABBGGRR — the same assumption the production
// code makes (documented in export-frame.js).
import { paletteFilter, composeFramePlan } from '@/services/export-frame';

const RED = '#ff0000';

function makeImageData(pixels /* array of [r,g,b,a] */) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => data.set(p, i * 4));
  return { width: pixels.length, height: 1, data };
}

function readPixels(imageData) {
  const out = [];
  for (let i = 0; i < imageData.data.length; i += 4) {
    out.push(Array.from(imageData.data.slice(i, i + 4)));
  }
  return out;
}

describe('paletteFilter', () => {
  it('keeps a matching pixel and sets its alpha to the entry opacity', () => {
    const img = makeImageData([[255, 0, 0, 255]]);
    paletteFilter(img, { hex: RED, opacity: 128, visible: true });
    expect(readPixels(img)).toEqual([[255, 0, 0, 128]]);
  });

  it('keeps a matching pixel at full alpha when opacity is 255', () => {
    const img = makeImageData([[255, 0, 0, 255]]);
    paletteFilter(img, { hex: RED, opacity: 255, visible: true });
    expect(readPixels(img)).toEqual([[255, 0, 0, 255]]);
  });

  it('zeroes every non-matching pixel regardless of its own alpha', () => {
    const img = makeImageData([[0, 255, 0, 255], [0, 0, 255, 90]]);
    paletteFilter(img, { hex: RED, opacity: 255, visible: true });
    expect(readPixels(img)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
  });

  it('QUIRK: zeroes a MATCHING pixel when the entry is not visible', () => {
    const img = makeImageData([[255, 0, 0, 255]]);
    paletteFilter(img, { hex: RED, opacity: 255, visible: false });
    expect(readPixels(img)).toEqual([[0, 0, 0, 0]]);
  });

  it('QUIRK: zeroes a matching pixel when opacity is 0', () => {
    const img = makeImageData([[255, 0, 0, 255]]);
    paletteFilter(img, { hex: RED, opacity: 0, visible: true });
    expect(readPixels(img)).toEqual([[0, 0, 0, 0]]);
  });

  it('QUIRK: newVisible overrides visible (pending edit wins)', () => {
    const img = makeImageData([[255, 0, 0, 255]]);
    paletteFilter(img, {
      hex: RED, opacity: 255, visible: true, newVisible: false,
    });
    expect(readPixels(img)).toEqual([[0, 0, 0, 0]]);
  });

  it('QUIRK: newOpacity overrides opacity for the kept alpha', () => {
    const img = makeImageData([[255, 0, 0, 255]]);
    paletteFilter(img, {
      hex: RED, opacity: 255, visible: true, newOpacity: 64,
    });
    expect(readPixels(img)).toEqual([[255, 0, 0, 64]]);
  });

  it('defaults opacity to 255 when the entry has none', () => {
    const img = makeImageData([[255, 0, 0, 10]]);
    paletteFilter(img, { hex: RED, visible: true });
    expect(readPixels(img)).toEqual([[255, 0, 0, 255]]);
  });

  it('mixed frame: keeps matches, zeroes the rest, in place', () => {
    const img = makeImageData([[255, 0, 0, 255], [0, 255, 0, 255], [255, 0, 0, 255]]);
    paletteFilter(img, { hex: RED, opacity: 200, visible: true });
    expect(readPixels(img)).toEqual([[255, 0, 0, 200], [0, 0, 0, 0], [255, 0, 0, 200]]);
  });
});

describe('composeFramePlan', () => {
  const flat = { index: null };
  const separated = { index: 2 };

  it('flat png: color then line, no background', () => {
    expect(composeFramePlan({
      hasColor: true,
      hasLine: true,
      pass: flat,
      layersVisible: { line: true, color: true, background: false },
    })).toEqual([{ kind: 'color', filterIndex: null }, { kind: 'line' }]);
  });

  it('flat mp4: background first, then color, then line', () => {
    expect(composeFramePlan({
      hasColor: true,
      hasLine: true,
      pass: flat,
      layersVisible: { line: true, color: true, background: true },
    })).toEqual([{ kind: 'background' }, { kind: 'color', filterIndex: null }, { kind: 'line' }]);
  });

  it('flat: an invisible color layer is dropped even when present', () => {
    expect(composeFramePlan({
      hasColor: true,
      hasLine: true,
      pass: flat,
      layersVisible: { line: true, color: false, background: false },
    })).toEqual([{ kind: 'line' }]);
  });

  it('flat: an invisible line layer is dropped even when present', () => {
    expect(composeFramePlan({
      hasColor: true,
      hasLine: true,
      pass: flat,
      layersVisible: { line: false, color: true, background: false },
    })).toEqual([{ kind: 'color', filterIndex: null }]);
  });

  it('QUIRK: colors-separated pass includes color even if color layer is hidden', () => {
    expect(composeFramePlan({
      hasColor: true,
      hasLine: true,
      pass: separated,
      layersVisible: { line: true, color: false, background: false },
    })).toEqual([{ kind: 'color', filterIndex: 2 }]);
  });

  it('colors-separated pass never includes the line layer (color-only output)', () => {
    expect(composeFramePlan({
      hasColor: true,
      hasLine: true,
      pass: separated,
      layersVisible: { line: true, color: true, background: false },
    })).toEqual([{ kind: 'color', filterIndex: 2 }]);
  });

  it('colors-separated with no color present falls back to blank', () => {
    expect(composeFramePlan({
      hasColor: false,
      hasLine: true,
      pass: separated,
      layersVisible: { line: true, color: true, background: false },
    })).toEqual([{ kind: 'blank' }]);
  });

  it('missing frame (nothing present, no background) is a blank frame', () => {
    expect(composeFramePlan({
      hasColor: false,
      hasLine: false,
      pass: flat,
      layersVisible: { line: true, color: true, background: false },
    })).toEqual([{ kind: 'blank' }]);
  });

  it('mp4 never blanks: background keeps the list non-empty', () => {
    expect(composeFramePlan({
      hasColor: false,
      hasLine: false,
      pass: flat,
      layersVisible: { line: true, color: true, background: true },
    })).toEqual([{ kind: 'background' }]);
  });
});
