// ColorizeService owns the preprocess -> colorize server conversation and the
// step-2 `references: [...]` request shape. We mock its one seam
// (@/util/colorization-via-server) so the orchestration, status handling, and
// reference-array construction are tested without any network or Electron.
//
// @/util/modal is mocked only to supply the MODAL_RESPONSES sentinel constants
// that COLORIZE_STATUS is derived from (its real module pulls in axios/https/
// Electron at import time).

jest.mock('@/util/modal', () => ({
  MODAL_RESPONSES: {
    CANCELED: 'canceled',
    NO_INTERNET: 'no_internet',
    SERVER_ERROR: 'server_error',
  },
}));

jest.mock('@/util/colorization-via-server', () => ({
  raaOnServer: jest.fn(),
  colorizeOnServer: jest.fn(),
}));

import { raaOnServer, colorizeOnServer } from '@/util/colorization-via-server';
import { colorizeFrame, analyzeReference, COLORIZE_STATUS } from '@/services/colorize-service';

const REF = { colorRaw: 'refColor', segMapRaw: 'refSeg', lineRaw: 'refLine' };
const TARGET = { segMapRaw: 'tgtSeg', lineRaw: 'tgtLine' };
const PALETTE = [[1, 2, 3, 255], [4, 5, 6, 255]];

function colorizeArgs(overrides = {}) {
  return {
    projectId: 'p1',
    refs: [REF],
    target: TARGET,
    isAutoAlpha: true,
    lineThreshold: 12,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('colorizeFrame', () => {
  it('preprocesses then colorizes and normalizes the response on success', async () => {
    raaOnServer.mockResolvedValue({ ref_palette_rgba: PALETTE });
    colorizeOnServer.mockResolvedValue({
      target_colors_rgba: [[9, 9, 9, 255]],
      target_palette_rgba: PALETTE,
      ref_preprocessed: 'refpre',
      target_warped: 'warp',
    });

    const result = await colorizeFrame(colorizeArgs());

    expect(result.status).toBe(COLORIZE_STATUS.OK);
    expect(result.targetColorsRgba).toEqual([[9, 9, 9, 255]]);
    expect(result.targetPaletteRgba).toBe(PALETTE);
    expect(result.refPreprocessed).toBe('refpre');
    expect(result.targetWarped).toBe('warp');
    expect(result.raw).toBeDefined();
  });

  it('sends the preprocess request as a references[] list (no line image)', async () => {
    raaOnServer.mockResolvedValue({ ref_palette_rgba: PALETTE });
    colorizeOnServer.mockResolvedValue({ target_colors_rgba: [] });

    await colorizeFrame(colorizeArgs());

    expect(raaOnServer).toHaveBeenCalledTimes(1);
    const arg = raaOnServer.mock.calls[0][0];
    expect(arg.references).toEqual([
      { segMapUri: 'refSeg', colorImageUri: 'refColor', lineImageUri: null },
    ]);
    expect(arg.imgReturn).toBe(false);
  });

  it('sends the colorize request as a references[] list carrying the palette + target', async () => {
    raaOnServer.mockResolvedValue({ ref_palette_rgba: PALETTE });
    colorizeOnServer.mockResolvedValue({ target_colors_rgba: [] });

    await colorizeFrame(colorizeArgs());

    const arg = colorizeOnServer.mock.calls[0][0];
    expect(arg.references).toEqual([
      { segMapUri: 'refSeg', lineImageUri: 'refLine', colorsRgba: PALETTE },
    ]);
    expect(arg.targetSegMapDataUri).toBe('tgtSeg');
    expect(arg.targetLineDataUri).toBe('tgtLine');
  });

  it('stops after preprocess when it is canceled, without colorizing', async () => {
    raaOnServer.mockResolvedValue('canceled');

    const result = await colorizeFrame(colorizeArgs());

    expect(result.status).toBe(COLORIZE_STATUS.CANCELED);
    expect(colorizeOnServer).not.toHaveBeenCalled();
  });

  it('maps a falsy preprocess response to a server error', async () => {
    raaOnServer.mockResolvedValue(undefined);

    const result = await colorizeFrame(colorizeArgs());

    expect(result.status).toBe(COLORIZE_STATUS.SERVER_ERROR);
    expect(colorizeOnServer).not.toHaveBeenCalled();
  });

  it('propagates a cancel that happens during the colorize call', async () => {
    raaOnServer.mockResolvedValue({ ref_palette_rgba: PALETTE });
    colorizeOnServer.mockResolvedValue('canceled');

    const result = await colorizeFrame(colorizeArgs());

    expect(result.status).toBe(COLORIZE_STATUS.CANCELED);
    expect(result.targetColorsRgba).toBeUndefined();
  });
});

describe('analyzeReference', () => {
  it('preprocesses a single reference and normalizes the palette + image', async () => {
    raaOnServer.mockResolvedValue({ ref_palette_rgba: PALETTE, ref_preprocessed: 'pre' });

    const result = await analyzeReference({
      projectId: 'p1', ref: REF, isAutoAlpha: false, lineThreshold: 8,
    });

    expect(result.status).toBe(COLORIZE_STATUS.OK);
    expect(result.refPaletteRgba).toBe(PALETTE);
    expect(result.refPreprocessed).toBe('pre');
    const arg = raaOnServer.mock.calls[0][0];
    expect(arg.references).toEqual([
      { segMapUri: 'refSeg', colorImageUri: 'refColor', lineImageUri: 'refLine' },
    ]);
    expect(arg.imgReturn).toBe(true);
  });

  it('returns only a status when the server reports no internet', async () => {
    raaOnServer.mockResolvedValue('no_internet');

    const result = await analyzeReference({
      projectId: 'p1', ref: REF, isAutoAlpha: false, lineThreshold: 8,
    });

    expect(result.status).toBe(COLORIZE_STATUS.NO_INTERNET);
    expect(result.refPaletteRgba).toBeUndefined();
  });
});
