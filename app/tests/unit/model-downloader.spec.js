import { createHash } from 'crypto';
import path from 'path';

import {
  wantedModelFiles,
  planModelDownloads,
  totalPlanBytes,
  formatGB,
  progressSnapshot,
} from '@/util/model-download-core';
import { MODEL_FILES, modelUrl } from '@/util/model-manifest';
import { ModelDownloader } from '@/model-downloader';

// The model bootstrap: pure planning in util/model-download-core.js, the
// streaming/verify/rename machine in src/model-downloader.js — exercised here
// with every effect injected (no network, no filesystem).

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('wantedModelFiles', () => {
  it('darwin wants everything including the optional bucket model', () => {
    expect(wantedModelFiles('darwin').map((m) => m.file))
      .toEqual(MODEL_FILES.map((m) => m.file));
  });

  it('win32 wants only the required models', () => {
    const files = wantedModelFiles('win32');
    expect(files.every((m) => m.required)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
});

describe('planModelDownloads', () => {
  const modelsDir = '/ud/models';

  it('skips files already present at the manifest size', () => {
    const sizes = {};
    MODEL_FILES.forEach((m) => { sizes[path.join(modelsDir, m.file)] = m.bytes; });
    const plan = planModelDownloads({
      modelsDir, platform: 'darwin', sizeFn: (p) => sizes[p],
    });
    expect(plan).toEqual([]);
  });

  it('refetches missing and wrong-size files, with part paths and manifest URLs', () => {
    const first = MODEL_FILES[0];
    const sizes = {};
    MODEL_FILES.forEach((m) => { sizes[path.join(modelsDir, m.file)] = m.bytes; });
    sizes[path.join(modelsDir, first.file)] = 123; // truncated artifact
    const plan = planModelDownloads({
      modelsDir, platform: 'darwin', sizeFn: (p) => sizes[p],
    });
    expect(plan.map((p) => p.file)).toEqual([first.file]);
    expect(plan[0].destPath).toBe(path.join(modelsDir, first.file));
    expect(plan[0].partPath).toBe(path.join(modelsDir, `${first.file}.part`));
    expect(plan[0].url).toBe(modelUrl(first.file));
    expect(plan[0].sha256).toBe(first.sha256);
  });

  it('totalPlanBytes sums the plan; formatGB renders decimal GB', () => {
    const plan = planModelDownloads({
      modelsDir, platform: 'win32', sizeFn: () => null,
    });
    expect(totalPlanBytes(plan))
      .toBe(MODEL_FILES.filter((m) => m.required).reduce((s, m) => s + m.bytes, 0));
    expect(formatGB(1_388_610_539)).toBe('1.4 GB');
    expect(formatGB(497_500_380)).toBe('0.5 GB');
  });
});

describe('progressSnapshot', () => {
  const plan = [
    { file: 'a', bytes: 100 },
    { file: 'b', bytes: 300 },
  ];

  it('accumulates completed files plus the current stream position', () => {
    const snap = progressSnapshot({
      state: 'downloading', plan, planIndex: 1, currentReceived: 50,
    });
    expect(snap).toMatchObject({
      state: 'downloading',
      file: 'b',
      fileIndex: 1,
      fileCount: 2,
      receivedBytes: 150,
      totalBytes: 400,
      error: null,
    });
  });

  it('clamps the terminal snapshot to the last file', () => {
    const snap = progressSnapshot({ state: 'done', plan, planIndex: 2 });
    expect(snap.receivedBytes).toBe(400);
    expect(snap.fileIndex).toBe(1);
    expect(snap.file).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The downloader, all effects injected
// ---------------------------------------------------------------------------

function sha256Hex(buffers) {
  const h = createHash('sha256');
  buffers.forEach((b) => h.update(b));
  return h.digest('hex');
}

// Minimal fs.createWriteStream stand-in: collects chunks, remembers renames.
function makeFakeFs() {
  const writes = {};
  const renames = [];
  const removed = [];
  return {
    writes,
    renames,
    removed,
    mkdirSync: jest.fn(),
    renameSync: (from, to) => renames.push([from, to]),
    rmSync: (p) => removed.push(p),
    createWriteStream: (p) => {
      const chunks = [];
      writes[p] = chunks;
      return {
        write: (c) => chunks.push(c),
        end: (cb) => cb && cb(),
        destroy: () => {},
        on: () => {},
      };
    },
  };
}

// Manual-drive request: the test pumps handlers itself.
function makeFakeRequest() {
  const calls = [];
  const fn = (url, handlers) => {
    const call = { url, handlers, aborted: false };
    calls.push(call);
    return { abort: () => { call.aborted = true; } };
  };
  return { fn, calls };
}

function makeDownloader({ plan, fs = makeFakeFs(), request = makeFakeRequest() }) {
  const progress = [];
  const dl = new ModelDownloader({
    modelsDir: '/ud/models',
    platform: 'darwin',
    streamRequestFn: request.fn,
    fsLib: fs,
    sizeFn: () => null,
    nowFn: () => 0,
    logFn: () => {},
    onProgress: (p) => progress.push(p),
  });
  dl.plan = () => plan; // decouple from the real multi-GB manifest
  return { dl, fs, request, progress };
}

const CHUNKS = [Buffer.from('hello '), Buffer.from('world')];
const ITEM = {
  file: 'm.onnx',
  url: 'https://example.test/m.onnx',
  bytes: 11,
  sha256: sha256Hex(CHUNKS),
  destPath: '/ud/models/m.onnx',
  partPath: '/ud/models/m.onnx.part',
};

describe('ModelDownloader', () => {
  it('streams, verifies size+sha256, renames onto the final name', async () => {
    const { dl, fs, request, progress } = makeDownloader({ plan: [ITEM] });
    const run = dl.start();
    const { handlers } = request.calls[0];
    handlers.onResponse(200);
    CHUNKS.forEach((c) => handlers.onData(c));
    handlers.onEnd();
    const result = await run;

    expect(result.state).toBe('done');
    expect(result.receivedBytes).toBe(11);
    expect(Buffer.concat(fs.writes[ITEM.partPath]).toString()).toBe('hello world');
    expect(fs.renames).toEqual([[ITEM.partPath, ITEM.destPath]]);
    expect(progress.map((p) => p.state)).toEqual(
      expect.arrayContaining(['downloading', 'verifying', 'done']),
    );
  });

  it('rejects a sha256 mismatch and deletes the part file', async () => {
    const bad = { ...ITEM, sha256: '0'.repeat(64) };
    const { dl, fs, request } = makeDownloader({ plan: [bad] });
    const run = dl.start();
    const { handlers } = request.calls[0];
    handlers.onResponse(200);
    CHUNKS.forEach((c) => handlers.onData(c));
    handlers.onEnd();
    const result = await run;

    expect(result.state).toBe('failed');
    expect(result.error).toContain('sha256 mismatch');
    expect(fs.removed).toContain(bad.partPath);
    expect(fs.renames).toEqual([]);
  });

  it('rejects a short stream on byte count', async () => {
    const { dl, request } = makeDownloader({ plan: [ITEM] });
    const run = dl.start();
    const { handlers } = request.calls[0];
    handlers.onResponse(200);
    handlers.onData(CHUNKS[0]); // 6 of 11 bytes
    handlers.onEnd();
    const result = await run;

    expect(result.state).toBe('failed');
    expect(result.error).toContain('size mismatch');
  });

  it('fails on a non-200 response', async () => {
    const { dl, request } = makeDownloader({ plan: [ITEM] });
    const run = dl.start();
    request.calls[0].handlers.onResponse(404);
    const result = await run;

    expect(result.state).toBe('failed');
    expect(result.error).toContain('HTTP 404');
  });

  it('cancel aborts the request and resolves cancelled with the part removed', async () => {
    const { dl, fs, request } = makeDownloader({ plan: [ITEM] });
    const run = dl.start();
    const call = request.calls[0];
    call.handlers.onResponse(200);
    call.handlers.onData(CHUNKS[0]);
    dl.cancel();
    call.handlers.onError(new Error('aborted'));
    const result = await run;

    expect(call.aborted).toBe(true);
    expect(result.state).toBe('cancelled');
    expect(fs.removed).toContain(ITEM.partPath);
  });

  it('downloads files sequentially and reports plan-wide byte progress', async () => {
    const chunks2 = [Buffer.from('abc')];
    const item2 = {
      file: 'n.onnx',
      url: 'https://example.test/n.onnx',
      bytes: 3,
      sha256: sha256Hex(chunks2),
      destPath: '/ud/models/n.onnx',
      partPath: '/ud/models/n.onnx.part',
    };
    const { dl, fs, request, progress } = makeDownloader({ plan: [ITEM, item2] });
    const run = dl.start();

    expect(request.calls.length).toBe(1); // second not started yet
    request.calls[0].handlers.onResponse(200);
    CHUNKS.forEach((c) => request.calls[0].handlers.onData(c));
    request.calls[0].handlers.onEnd();
    await Promise.resolve(); // let the first finish() settle
    await Promise.resolve();

    expect(request.calls.length).toBe(2);
    request.calls[1].handlers.onResponse(200);
    chunks2.forEach((c) => request.calls[1].handlers.onData(c));
    request.calls[1].handlers.onEnd();
    const result = await run;

    expect(result.state).toBe('done');
    expect(result.totalBytes).toBe(14);
    expect(result.receivedBytes).toBe(14);
    expect(fs.renames.length).toBe(2);
    const during = progress.find((p) => p.file === 'n.onnx' && p.state === 'downloading');
    expect(during.receivedBytes).toBeGreaterThanOrEqual(11);
  });

  it('resolves done immediately on an empty plan', async () => {
    const { dl, request } = makeDownloader({ plan: [] });
    const result = await dl.start();
    expect(result.state).toBe('done');
    expect(request.calls.length).toBe(0);
  });

  it('start() coalesces concurrent callers into one run', async () => {
    const { dl, request } = makeDownloader({ plan: [ITEM] });
    const a = dl.start();
    const b = dl.start();
    expect(b).toBe(a);
    const { handlers } = request.calls[0];
    handlers.onResponse(200);
    CHUNKS.forEach((c) => handlers.onData(c));
    handlers.onEnd();
    await a;
    expect(request.calls.length).toBe(1);
  });
});
