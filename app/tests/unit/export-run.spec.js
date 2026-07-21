// Headless tests for the export executor (export-run.js). Every dependency is a
// fake, so the loop, memoization, cancellation, the missing-asset fallback, and
// the encoder contract are all asserted without Vuex / Electron / a canvas —
// exactly the class of test the old EXPORT_FILES blob could not support.
import {
  runExport,
  createPngEncoder,
  createSvgEncoder,
  createMp4Encoder,
} from '@/services/export-run';
import { AssetMissingError } from '@/services/asset-store';
import { JobCanceledError } from '@/services/job-runner';

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeRender() {
  return {
    backgroundImage: jest.fn(() => 'BG'),
    blankImage: jest.fn(() => 'BLANK'),
    filterColor: jest.fn(() => 'FILTERED'),
    merge: jest.fn(images => `MERGED(${images.join(',')})`),
  };
}

// assets.getAsset(store, id) -> `img-${id}`, unless `missing` contains the id.
function makeAssets(missing = new Set()) {
  return {
    getAsset: jest.fn(async (store, id) => {
      if (missing.has(id)) { throw new AssetMissingError(id, 'never-existed'); }
      return `img-${id}`;
    }),
  };
}

function makeRecordingEncoder(log) {
  return {
    async open(pass) {
      log.push({ op: 'open', pass: pass.index });
      return {
        async write(frame, image) { log.push({ op: 'write', frame: frame.frameNr, image }); },
        async close() { log.push({ op: 'close', pass: pass.index }); },
      };
    },
  };
}

function makeCtx({ throwOnCall } = {}) {
  const progress = [];
  let calls = 0;
  return {
    progress: jest.fn((done, total) => progress.push([done, total])),
    progressLog: progress,
    throwIfAborted: jest.fn(() => {
      calls += 1;
      if (throwOnCall && calls === throwOnCall) { throw new JobCanceledError('export'); }
    }),
  };
}

const basePlan = (overrides = {}) => ({
  ext: 'png',
  frameCount: 10,
  canvasSize: { width: 4, height: 4 },
  backgroundColor: '#ffffff',
  palette: [{ hex: '#ff0000' }, { hex: '#00ff00' }],
  layersVisible: { line: true, color: true },
  alphaChannel: true,
  fps: 24,
  passes: [{
    index: null, subFolder: null, filePathNoExt: '/out/proj', filePathMp4: '/out/proj.png',
  }],
  frames: [
    { frameNr: 1, lineImageId: 'A', colorImageId: null },
    { frameNr: 2, lineImageId: 'A', colorImageId: null },
    { frameNr: 3, lineImageId: 'A', colorImageId: null },
    { frameNr: 4, lineImageId: 'B', colorImageId: null },
    { frameNr: 5, lineImageId: 'B', colorImageId: null },
    { frameNr: 6, lineImageId: 'B', colorImageId: null },
  ],
  ...overrides,
});

function makeDeps({ log = [], render = makeRender(), assets = makeAssets(), io = {} } = {}) {
  return {
    assets,
    store: { commit: jest.fn() }, // runExport reports measured throughput via SET_LAST_EXPORT_TIME
    render,
    io: { mkdir: jest.fn(async () => {}), ...io },
    encoders: { png: makeRecordingEncoder(log), svg: makeRecordingEncoder(log), mp4: makeRecordingEncoder(log) },
    _log: log,
  };
}

// ── runExport ─────────────────────────────────────────────────────────────────

describe('runExport memoization', () => {
  it('renders once per unique cel per pass but writes one file per frame', async () => {
    const log = [];
    const render = makeRender();
    const deps = makeDeps({ log, render });
    const ctx = makeCtx();

    const result = await runExport(basePlan(), deps, ctx);

    // 6 frames / 2 unique cels -> 2 composites, 6 writes.
    expect(render.merge).toHaveBeenCalledTimes(2);
    expect(log.filter(e => e.op === 'write')).toHaveLength(6);
    expect(result).toEqual({ files: 6, passes: 1 });

    // Measured throughput reported once per item, as seconds-per-item (the
    // waiting screen's `remaining × lastExportTime` estimate feeds off this).
    const timeCommits = deps.store.commit.mock.calls
      .filter(([type]) => type === 'set_last_export_time');
    expect(timeCommits).toHaveLength(6);
    timeCommits.forEach(([, secondsPerItem]) => {
      expect(secondsPerItem).toBeGreaterThanOrEqual(0);
      expect(secondsPerItem).toBeLessThan(10);
    });
  });

  it('memoizes per pass across a colors-separated export (2 cels x 2 passes = 4 renders, 12 writes)', async () => {
    const log = [];
    const render = makeRender();
    const deps = makeDeps({ log, render });
    const ctx = makeCtx();
    const plan = basePlan({
      // color present so each pass actually composites the color layer
      frames: [
        { frameNr: 1, lineImageId: 'A', colorImageId: 'CA' },
        { frameNr: 2, lineImageId: 'A', colorImageId: 'CA' },
        { frameNr: 3, lineImageId: 'B', colorImageId: 'CB' },
      ],
      passes: [
        { index: 0, subFolder: '/out/color01', filePathNoExt: '/out/color01/proj_color01' },
        { index: 1, subFolder: '/out/color02', filePathNoExt: '/out/color02/proj_color02' },
      ],
    });

    await runExport(plan, deps, ctx);

    // 2 unique cels x 2 passes = 4 renders; 3 frames x 2 passes = 6 writes.
    expect(render.merge).toHaveBeenCalledTimes(4);
    expect(log.filter(e => e.op === 'write')).toHaveLength(6);
  });
});

describe('runExport cancellation', () => {
  it('stops writing when the ctx aborts mid-run and does not write partial garbage', async () => {
    const log = [];
    const deps = makeDeps({ log });
    // calls: pass-open(1), frame1(2), frame2(3), frame3(4)<-throw
    const ctx = makeCtx({ throwOnCall: 4 });

    await expect(runExport(basePlan(), deps, ctx)).rejects.toBeInstanceOf(JobCanceledError);

    const writes = log.filter(e => e.op === 'write');
    expect(writes).toHaveLength(2); // only the two frames before the abort
    expect(writes.map(w => w.frame)).toEqual([1, 2]);
  });
});

describe('runExport missing assets', () => {
  it('falls back to a blank frame when every layer read is a missing asset', async () => {
    const log = [];
    const render = makeRender();
    const assets = makeAssets(new Set(['X']));
    const deps = makeDeps({ log, render, assets });
    const plan = basePlan({
      layersVisible: { line: true, color: false },
      frames: [{ frameNr: 1, lineImageId: 'X', colorImageId: null }],
    });

    await runExport(plan, deps, makeCtx());

    expect(render.blankImage).toHaveBeenCalledTimes(1);
    expect(render.merge).toHaveBeenCalledWith(['BLANK']);
  });
});

describe('runExport per-pass mkdir', () => {
  it('mkdirs each colors-separated subfolder and skips the flat pass', async () => {
    const log = [];
    const mkdir = jest.fn(async () => {});
    const deps = makeDeps({ log, io: { mkdir } });
    const separatedPlan = basePlan({
      passes: [
        { index: 0, subFolder: '/out/color01', filePathNoExt: '/out/color01/p' },
        { index: 1, subFolder: '/out/color02', filePathNoExt: '/out/color02/p' },
      ],
      frames: [{ frameNr: 1, lineImageId: 'A', colorImageId: 'CA' }],
    });

    await runExport(separatedPlan, deps, makeCtx());
    expect(mkdir.mock.calls.map(c => c[0])).toEqual(['/out/color01', '/out/color02']);

    // flat pass -> no mkdir
    const flatDeps = makeDeps({ io: { mkdir: jest.fn(async () => {}) } });
    await runExport(basePlan(), flatDeps, makeCtx());
    expect(flatDeps.io.mkdir).not.toHaveBeenCalled();
  });
});

describe('runExport encoder contract', () => {
  it('opens, writes every frame, then closes — in order, per pass', async () => {
    const log = [];
    const deps = makeDeps({ log });
    const plan = basePlan({
      passes: [
        { index: 0, subFolder: '/o/c1', filePathNoExt: '/o/c1/p' },
        { index: 1, subFolder: '/o/c2', filePathNoExt: '/o/c2/p' },
      ],
      frames: [
        { frameNr: 1, lineImageId: 'A', colorImageId: 'CA' },
        { frameNr: 2, lineImageId: 'B', colorImageId: 'CB' },
      ],
    });

    await runExport(plan, deps, makeCtx());

    expect(log.map(e => e.op)).toEqual([
      'open', 'write', 'write', 'close',
      'open', 'write', 'write', 'close',
    ]);
  });
});

describe('runExport progress', () => {
  it('reports a monotonic done against a constant passes x frames total', async () => {
    const deps = makeDeps({});
    const ctx = makeCtx();
    const plan = basePlan({
      passes: [
        { index: 0, subFolder: '/o/c1', filePathNoExt: '/o/c1/p' },
        { index: 1, subFolder: '/o/c2', filePathNoExt: '/o/c2/p' },
      ],
      frames: [
        { frameNr: 1, lineImageId: 'A', colorImageId: 'CA' },
        { frameNr: 2, lineImageId: 'B', colorImageId: 'CB' },
      ],
    });

    await runExport(plan, deps, ctx);

    // total = 2 passes x 2 frames = 4, done climbs 1..4 without reset.
    expect(ctx.progressLog).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });
});

// ── encoders ──────────────────────────────────────────────────────────────────

describe('png encoder', () => {
  it('writes the composited PNG straight to <stem>.png as base64', async () => {
    const io = { writeFile: jest.fn(async () => {}) };
    const encoder = createPngEncoder();
    const pass = { index: null, filePathNoExt: '/out/proj' };
    const plan = { frameCount: 100 };
    const sink = await encoder.open(pass, plan, { io });
    await sink.write({ frameNr: 5 }, 'data:image/png;base64,ABC');
    await sink.close();

    // frameExportStem: frameCount 100 -> pad 2, frame 5 -> exportNr 4 -> "04"
    expect(io.writeFile).toHaveBeenCalledWith('/out/proj_04.png', 'ABC', 'base64');
  });
});

describe('svg encoder', () => {
  it('temp-png -> PNGReader -> ImageTracer -> <stem>.svg, registering the temp file', async () => {
    function FakePNGReader(bytes) { this.bytes = bytes; }
    FakePNGReader.prototype.parse = function parse(cb) {
      cb(null, { width: 2, height: 1, pixels: new Uint8ClampedArray(8) });
    };
    const imagedataToSVG = jest.fn(async () => '<svg/>');
    const io = {
      writeFile: jest.fn(async () => {}),
      readFile: jest.fn(async () => Buffer.from('png-bytes')),
      addTempFile: jest.fn(),
      tmpDir: () => '/tmp',
      now: () => 111,
    };
    const encoder = createSvgEncoder({ tracer: { PNGReader: FakePNGReader, imagedataToSVG } });
    const pass = { index: null, filePathNoExt: '/out/proj' };
    const plan = { frameCount: 100, svgQualityNum: 2, rgbPalette: [{ r: 0, g: 0, b: 0, a: 0 }] };

    const sink = await encoder.open(pass, plan, { io });
    await sink.write({ frameNr: 5 }, 'data:image/png;base64,ZZZ');
    await sink.close();

    const tmpPath = '/tmp/export_111_04.png';
    expect(io.writeFile).toHaveBeenNthCalledWith(1, tmpPath, 'ZZZ', 'base64');
    expect(io.addTempFile).toHaveBeenCalledWith(tmpPath);
    expect(io.readFile).toHaveBeenCalledWith(tmpPath);
    expect(imagedataToSVG).toHaveBeenCalledTimes(1);
    expect(io.writeFile).toHaveBeenNthCalledWith(2, '/out/proj_04.svg', '<svg/>');
  });
});

describe('mp4 encoder', () => {
  it('accumulates temp pngs, then runs the ffmpeg pipe once on close', async () => {
    const converter = {
      setPath: jest.fn(),
      createInputStream: jest.fn(() => 'INPUT'),
      createOutputToFile: jest.fn(),
      run: jest.fn(),
    };
    const ffmpeg = { createConverter: () => converter, ffmpegPath: '/ff' };
    const io = {
      writeFile: jest.fn(async () => {}),
      addTempFile: jest.fn(),
      tmpDir: () => '/tmp',
      now: () => 222,
      fileExists: jest.fn(() => false),
      unlink: jest.fn(),
      pipeFramesToConverter: jest.fn(async () => {}),
    };
    const encoder = createMp4Encoder({ ffmpeg });
    const pass = { index: null, filePathNoExt: '/out/proj', filePathMp4: '/out/proj.mp4' };
    const plan = { frameCount: 100, fps: 30 };

    const sink = await encoder.open(pass, plan, { io });
    await sink.write({ frameNr: 5 }, 'data:image/png;base64,AAA');
    await sink.write({ frameNr: 6 }, 'data:image/png;base64,BBB');
    await sink.close();

    expect(io.addTempFile).toHaveBeenCalledTimes(2);
    expect(converter.setPath).toHaveBeenCalledWith('/ff');
    expect(converter.createInputStream).toHaveBeenCalledWith({ f: 'image2pipe', r: 30 });
    expect(converter.createOutputToFile).toHaveBeenCalledWith('/out/proj.mp4', {
      vcodec: 'libx264',
      pix_fmt: 'yuv420p',
      vf: 'pad = ceil(iw / 2) * 2: ceil(ih / 2) * 2',
      r: 30,
    });
    expect(io.pipeFramesToConverter).toHaveBeenCalledWith(
      ['/tmp/export_222_04.png', '/tmp/export_222_05.png'],
      'INPUT',
      converter,
    );
  });
});
