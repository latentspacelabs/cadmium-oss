// Headless tests for the colorize/analyze executor (colorize-run.js). Every
// dependency is a fake — a recording store, a canned server, fake assets and io
// — so the dupe-reuse loop, the sequential in-between reference hop, the
// /preprocess palette merge (and its idempotence), cancellation, the segmap
// cache, and every typed error are asserted without Vuex / Electron / a canvas.
// This is the class of test the old ~670-line COLORIZE blob could not support.
import {
  runColorize,
  runAnalyze,
  analyzeRef,
  COLORIZE_RUN_ERROR,
} from '@/services/colorize-run';
import { COLORIZE_STATUS } from '@/services/colorize-service';
import { JobCanceledError } from '@/services/job-runner';

import {
  LINKED_LAYER_ID,
  AI_GAP_CLOSER_ENABLED,
  MAX_AI_DILATION_SIZE,
  MAX_TB_DILATION_SIZE,
  MIN_SEG_SIZE,
  LINE_THRESHOLD,
  IS_AUTO_ALPHA,
  CANVAS_SIZE,
  PROJECT_ID,
  RAINBOW_MODE,
  COLOR_PALETTE,
  FRAMES_BY_LAYER_ID,
  FRAME_BY_FRAME_NR,
  IMAGE_DATA_OF_FRAME,
  SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID,
  IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  SELECTED_FRAMES_ON_LAYER,
} from '@/store/getter-types';
import {
  SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  ADD_COLOR_TO_PALETTE,
  REPLACE_IMAGE_DATA_URI,
  DESELECT_FRAMES,
} from '@/store/mutation-types';
import { INITIAL_COLOR_LAYER_ID } from '@/store/general-types';

// ── fakes ─────────────────────────────────────────────────────────────────────

// A recording store: getters return canned data (method-style getters are
// functions), commits are logged, and ADD_COLOR_TO_PALETTE pushes into the live
// palette array so mergePaletteRgba's dedupe sees prior adds (idempotence).
function makeStore({
  lineIdFor = n => `L${n}`,
  palette = [],
  rainbow = 'off',
  framesByLayer = () => [],
  imageDataUriFor = id => `data:line;base64,uri-${id}`,
} = {}) {
  const commits = [];
  const paletteArr = palette.slice();
  const colorRefCalls = []; // frameNrs IMAGE_DATA_OF_FRAME was asked for on the color layer
  const getters = {
    [LINKED_LAYER_ID]: () => 'lineLayer',
    [AI_GAP_CLOSER_ENABLED]: false,
    [MAX_AI_DILATION_SIZE]: 0,
    [MAX_TB_DILATION_SIZE]: 4,
    [MIN_SEG_SIZE]: 2,
    [LINE_THRESHOLD]: 'auto',
    [IS_AUTO_ALPHA]: true,
    [CANVAS_SIZE]: { width: 10, height: 10 },
    [PROJECT_ID]: 'proj',
    [RAINBOW_MODE]: rainbow,
    [COLOR_PALETTE]: paletteArr,
    [FRAMES_BY_LAYER_ID]: framesByLayer,
    [FRAME_BY_FRAME_NR]: ({ frameNr }) => ({ frameNr, imageDataId: lineIdFor(frameNr) }),
    [IMAGE_DATA_OF_FRAME]: ({ layerId, frameNr }) => {
      if (layerId === INITIAL_COLOR_LAYER_ID) { colorRefCalls.push(frameNr); }
      return `img(${layerId},${frameNr})`;
    },
    [SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID]: () => null,
    [IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID]: id => ({ hash: `hash-${id}` }),
    [IMAGE_DATA_URI_BY_IMAGE_DATA_ID]: id => imageDataUriFor(id),
    [SELECTED_FRAMES_ON_LAYER]: () => [],
  };
  return {
    getters,
    commit: jest.fn((type, payload) => {
      commits.push({ type, payload });
      if (type === ADD_COLOR_TO_PALETTE) { paletteArr.push(payload); }
    }),
    dispatch: jest.fn(async () => {}),
    _commits: commits,
    _palette: paletteArr,
    _colorRefCalls: colorRefCalls,
  };
}

function makeIo(over = {}) {
  return {
    pathJoin: (...parts) => parts.join('/'),
    tmpDir: () => '/tmp',
    now: () => 123,
    fileExists: jest.fn(() => true),
    writeBase64DataToFile: jest.fn(async () => {}),
    addTempFile: jest.fn(),
    requestTempFiles: jest.fn(),
    base64Encode: jest.fn(async filePath => `data:seg;base64,${filePath}`),
    getRaw: jest.fn(uri => `raw(${uri})`),
    generateSegmentationMap: jest.fn(async () => ({
      path: '/tmp/seg.png', processingTimeInSec: 1, numSegments: 10, canceled: false,
    })),
    renderColorizedFrame: jest.fn(async () => 'data:image/png;base64,COLORIZED'),
    getImageDimensions: jest.fn(async () => ({ width: 4, height: 4 })),
    createCanvas: jest.fn(() => ({
      canvas: { width: 4, height: 4, toDataURL: () => 'data:rainbow' },
      ctx: {
        canvas: { width: 4, height: 4 },
        drawImage() {},
        getImageData: () => ({}),
        putImageData() {},
      },
    })),
    loadImage: jest.fn(async () => ({})),
    ...over,
  };
}

function makeAssets(over = {}) {
  let putCount = 0;
  return {
    tryGetAsset: jest.fn(async (store, id) => `target(${id})`),
    putAsset: jest.fn(async () => {
      putCount += 1;
      return `color-${putCount}`;
    }),
    ...over,
  };
}

const okColorizeResp = () => ({
  status: COLORIZE_STATUS.OK,
  targetColorsRgba: [[0, 0, 0, 255]],
  preprocessPaletteRgba: [],
  raw: {},
});

function makeServer(colorizeImpl) {
  return {
    colorizeFrame: jest.fn(colorizeImpl || (async () => okColorizeResp())),
    analyzeReference: jest.fn(async () => ({ status: COLORIZE_STATUS.OK, raw: {} })),
  };
}

function makeDeps({
  store, server, io, assets,
} = {}) {
  return {
    store: store || makeStore(),
    server: server || makeServer(),
    io: io || makeIo(),
    assets: assets || makeAssets(),
  };
}

function makeCtx({ throwOnCall } = {}) {
  const progress = [];
  let calls = 0;
  return {
    progressLog: progress,
    progress: jest.fn((done, total) => progress.push([done, total])),
    throwIfAborted: jest.fn(() => {
      calls += 1;
      if (throwOnCall && calls === throwOnCall) { throw new JobCanceledError('colorize'); }
    }),
  };
}

const colorizeOps = frameNrs => ({
  analyzeMode: false,
  ops: frameNrs.map(frameNr => ({ frameNr, refFrameNr: 1, isOriginal: false })),
});

const imageCommits = store => store._commits.filter(c => c.type === SET_IMAGE_DATA_FOR_FRAME_WITH_ID);

// ── dupe reuse ─────────────────────────────────────────────────────────────────

describe('runColorize dupe reuse', () => {
  it('colorizes once per unique line drawing but attaches a result to every frame (6 frames / 2 drawings -> 2 server calls, 6 attaches)', async () => {
    // frames 2..7 reference frame 1; line ids: 2,3,4 -> "L-A", 5,6,7 -> "L-B".
    const store = makeStore({ lineIdFor: n => (n === 1 ? 'Lref' : (n <= 4 ? 'L-A' : 'L-B')) });
    const deps = makeDeps({ store });

    const result = await runColorize(colorizeOps([2, 3, 4, 5, 6, 7]), deps, makeCtx());

    expect(deps.server.colorizeFrame).toHaveBeenCalledTimes(2); // one per unique drawing
    const attaches = imageCommits(store);
    expect(attaches).toHaveLength(6); // one per frame
    expect(attaches.map(c => c.payload.frameNr).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(result).toEqual({ colorizedFrames: 6 });
  });
});

// ── the palette-merge fix (acceptance) ─────────────────────────────────────────

describe('runColorize palette merge from /preprocess', () => {
  it('merges the preprocess palette_rgba into the store palette (fixes the empty-palette bug)', async () => {
    const store = makeStore(); // distinct line ids -> every frame colorizes
    const server = makeServer(async () => ({
      status: COLORIZE_STATUS.OK,
      targetColorsRgba: [[0, 0, 0, 255]],
      // /colorize returns only target_colors_rgba; the palette comes from
      // /preprocess (surfaced by colorize-service as preprocessPaletteRgba).
      targetPaletteRgba: undefined,
      preprocessPaletteRgba: [[255, 0, 0, 255], [0, 255, 0, 255]],
      raw: {},
    }));

    await runColorize(colorizeOps([2]), makeDeps({ store, server }), makeCtx());

    const added = store._commits.filter(c => c.type === ADD_COLOR_TO_PALETTE);
    expect(added.map(c => c.payload.hex)).toEqual(['#ff0000', '#00ff00']);
  });

  it('is idempotent — a second reference with the same colors adds nothing', async () => {
    const store = makeStore(); // frames 2 and 3 -> distinct drawings -> two colorize calls
    const server = makeServer(async () => ({
      status: COLORIZE_STATUS.OK,
      targetColorsRgba: [[0, 0, 0, 255]],
      preprocessPaletteRgba: [[255, 0, 0, 255], [0, 255, 0, 255]],
      raw: {},
    }));

    await runColorize(colorizeOps([2, 3]), makeDeps({ store, server }), makeCtx());

    // Two colorize calls, but the palette is merged exactly once.
    expect(server.colorizeFrame).toHaveBeenCalledTimes(2);
    const added = store._commits.filter(c => c.type === ADD_COLOR_TO_PALETTE);
    expect(added.map(c => c.payload.hex)).toEqual(['#ff0000', '#00ff00']);
  });
});

// ── sequential in-between reference ────────────────────────────────────────────

describe('runColorize sequential in-between reference', () => {
  it('hops to an in-between frame colorized this run as the reference', async () => {
    // frames 2 then 3, both nominally referencing frame 1. After frame 2 is
    // colorized, frame 3 should reference frame 2 (the fresh in-between neighbour).
    const store = makeStore(); // distinct line ids -> both colorize
    await runColorize(colorizeOps([2, 3]), makeDeps({ store }), makeCtx());

    // The color-layer reference fetched: frame 2 used ref 1; frame 3 used ref 2.
    expect(store._colorRefCalls).toEqual([1, 2]);
  });
});

// ── cancellation ───────────────────────────────────────────────────────────────

describe('runColorize cancellation', () => {
  it('aborts before the next op and does not colorize past the cancel point', async () => {
    const store = makeStore();
    const deps = makeDeps({ store });
    // throwIfAborted: op1 (call 1, ok), op2 (call 2, throw).
    const ctx = makeCtx({ throwOnCall: 2 });

    await expect(runColorize(colorizeOps([2, 3]), deps, ctx)).rejects.toBeInstanceOf(JobCanceledError);

    expect(deps.server.colorizeFrame).toHaveBeenCalledTimes(1); // only the first op ran
    expect(imageCommits(store).map(c => c.payload.frameNr)).toEqual([2]);
  });
});

// ── segmap cache ───────────────────────────────────────────────────────────────

describe('runColorize segmap cache', () => {
  it('does NOT call /segment when the cached segmap file already exists', async () => {
    const io = makeIo({ fileExists: jest.fn(() => true) });
    await runColorize(colorizeOps([2]), makeDeps({ io }), makeCtx());
    expect(io.generateSegmentationMap).not.toHaveBeenCalled();
  });

  it('calls /segment for the target and the reference on a cache miss', async () => {
    const io = makeIo({ fileExists: jest.fn(() => false) });
    await runColorize(colorizeOps([2]), makeDeps({ io }), makeCtx());
    expect(io.generateSegmentationMap).toHaveBeenCalledTimes(2); // target + reference
  });
});

// ── typed run-time errors (no dialogs in the executor) ─────────────────────────

describe('runColorize typed errors', () => {
  it('returns TOO_MANY_SEGMENTS and never calls /colorize when segmentation overflows', async () => {
    const io = makeIo({
      fileExists: jest.fn(() => false),
      generateSegmentationMap: jest.fn(async () => ({
        path: '/tmp/seg.png', processingTimeInSec: 1, numSegments: 300, canceled: false,
      })),
    });
    const deps = makeDeps({ io });
    const result = await runColorize(colorizeOps([2]), deps, makeCtx());
    expect(result).toEqual({ error: COLORIZE_RUN_ERROR.TOO_MANY_SEGMENTS, errorFrameNr: 2 });
    expect(deps.server.colorizeFrame).not.toHaveBeenCalled();
  });

  it('returns COLORIZE_FAILED when the /colorize call throws', async () => {
    const server = makeServer(async () => { throw new Error('boom'); });
    const result = await runColorize(colorizeOps([2]), makeDeps({ server }), makeCtx());
    expect(result.error).toBe(COLORIZE_RUN_ERROR.COLORIZE_FAILED);
    expect(result.errorFrameNr).toBe(2);
  });

  it('returns LINE_DATA_MISSING when the target line drawing is absent (colorize mode)', async () => {
    const assets = makeAssets({ tryGetAsset: jest.fn(async () => null) });
    const deps = makeDeps({ assets });
    const result = await runColorize(colorizeOps([2]), deps, makeCtx());
    expect(result).toEqual({ error: COLORIZE_RUN_ERROR.LINE_DATA_MISSING, errorFrameNr: 2 });
    expect(deps.server.colorizeFrame).not.toHaveBeenCalled();
  });

  it('stops cleanly on a non-OK server status (server already surfaced its dialog)', async () => {
    const server = makeServer(async () => ({ status: COLORIZE_STATUS.SERVER_ERROR }));
    const result = await runColorize(colorizeOps([2]), makeDeps({ server }), makeCtx());
    expect(result).toEqual({ serverStatus: COLORIZE_STATUS.SERVER_ERROR });
  });
});

// ── analyze verb ───────────────────────────────────────────────────────────────

describe('runAnalyze', () => {
  it('never calls /colorize and (rainbow off) attaches no color image', async () => {
    const store = makeStore({ rainbow: 'off' });
    const deps = makeDeps({ store });
    const result = await runAnalyze({ analyzeMode: true, ops: [{ frameNr: 2, refFrameNr: 1, isOriginal: false }] }, deps, makeCtx());

    expect(deps.server.colorizeFrame).not.toHaveBeenCalled();
    expect(imageCommits(store)).toHaveLength(0);
    // analyze deselects each processed frame
    expect(store._commits.some(c => c.type === DESELECT_FRAMES)).toBe(true);
    expect(result).toEqual({ colorizedFrames: 1 });
  });

  it('rainbow mode on renders and attaches the color-segment image (force: true)', async () => {
    const store = makeStore({ rainbow: 'on' });
    const deps = makeDeps({ store });
    await runAnalyze({ analyzeMode: true, ops: [{ frameNr: 2, refFrameNr: 1, isOriginal: false }] }, deps, makeCtx());

    const attaches = imageCommits(store);
    expect(attaches).toHaveLength(1);
    expect(attaches[0].payload.force).toBe(true);
  });
});

// ── analyzeRef (shared with ANALYZE_CURRENT_FRAME) ─────────────────────────────

describe('analyzeRef', () => {
  it('merges the reference palette and replaces the color image with the preprocessed render', async () => {
    const store = makeStore();
    const server = {
      analyzeReference: jest.fn(async () => ({
        status: COLORIZE_STATUS.OK,
        refPaletteRgba: [[255, 0, 0, 255]],
        refPreprocessed: 'data:image/png;base64,PRE',
        raw: { ref_palette_rgba: [[255, 0, 0, 255]] },
      })),
    };
    const io = makeIo();

    await analyzeRef({
      segMapDataUri: 'data:seg',
      refColorDataUri: 'data:col',
      targetLineDataUri: 'data:line',
      colorImageId: 'C1',
    }, { store, server, io });

    expect(store._commits.filter(c => c.type === ADD_COLOR_TO_PALETTE).map(c => c.payload.hex)).toEqual(['#ff0000']);
    expect(store._commits.filter(c => c.type === REPLACE_IMAGE_DATA_URI)).toEqual([
      { type: REPLACE_IMAGE_DATA_URI, payload: { imageDataId: 'C1', dataUri: 'data:image/png;base64,PRE' } },
    ]);
  });
});
