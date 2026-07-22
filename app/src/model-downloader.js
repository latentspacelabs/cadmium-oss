/* eslint-disable */
/**
 * ModelDownloader — main-process fetcher for the embedded backend's ONNX
 * artifacts (see util/model-manifest.js for what and util/model-download-core
 * for the policy). MAIN PROCESS ONLY, like sidecar-manager.js: no dialogs;
 * progress is pushed as data ('sidecar:models-progress') and the UI decides
 * what to surface.
 *
 * Design:
 *  - Sequential downloads (one connection; these are GB-scale files and the
 *    bottleneck is bandwidth, not concurrency).
 *  - Stream to <file>.part while hashing incrementally; after the stream
 *    ends, require exact manifest byte size AND sha256, then rename onto the
 *    final name. The sidecar's missing-file probe therefore only ever sees
 *    fully verified files, and the supervisor's failed-missing state
 *    self-clears on the next ensure.
 *  - No resume yet: a failed/cancelled file's .part is deleted and refetched
 *    whole on retry (recorded TODO in docs/build-and-release.md).
 *
 * Every effect is injectable for tests; the default request implementation
 * uses Electron's net module (follows the GitHub release 302 → CDN redirect,
 * honors system proxies).
 */

import { planModelDownloads, progressSnapshot } from './util/model-download-core';

const PROGRESS_PUSH_INTERVAL_MS = 250;

// --- Default effectful deps (each injectable for tests) ---------------------

// Streaming GET. handlers: onResponse(statusCode), onData(Buffer),
// onEnd(), onError(err). Returns { abort() }.
function defaultStreamRequest(url, handlers) {
  const { net } = require('electron');
  const req = net.request({ url, redirect: 'follow' });
  req.on('response', (res) => {
    handlers.onResponse(res.statusCode);
    res.on('data', (chunk) => handlers.onData(chunk));
    res.on('end', () => handlers.onEnd());
    res.on('error', (err) => handlers.onError(err));
  });
  req.on('error', (err) => handlers.onError(err));
  req.end();
  return { abort: () => { try { req.abort(); } catch (e) { /* already done */ } } };
}

function defaultFsLib() {
  return require('fs');
}

function defaultCreateHash() {
  return require('crypto').createHash('sha256');
}

function defaultSizeFn(p) {
  try {
    return require('fs').statSync(p).size;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------

export class ModelDownloader {
  constructor(opts = {}) {
    const {
      modelsDir,
      platform = process.platform,
      onProgress = null,
      streamRequestFn = defaultStreamRequest,
      fsLib = defaultFsLib(),
      createHashFn = defaultCreateHash,
      sizeFn = defaultSizeFn,
      nowFn = Date.now,
      logFn = (...args) => console.log('[model-download]', ...args),
    } = opts;

    this.modelsDir = modelsDir;
    this.platform = platform;
    this.onProgress = onProgress;
    this.streamRequestFn = streamRequestFn;
    this.fsLib = fsLib;
    this.createHashFn = createHashFn;
    this.sizeFn = sizeFn;
    this.nowFn = nowFn;
    this.logFn = logFn;

    this._runPromise = null;
    this._cancelled = false;
    this._activeRequest = null;
    this._lastProgress = { state: 'idle', file: null, fileIndex: 0, fileCount: 0, receivedBytes: 0, totalBytes: 0, error: null, warnings: [] };
    this._lastPushAt = 0;
    // Accelerator files that failed during the current run ([{file, error}]);
    // the run continues past them (see _run) and reports them on 'done'.
    this._warnings = [];
  }

  /** What would download right now, without starting anything. */
  plan() {
    return planModelDownloads({
      modelsDir: this.modelsDir,
      platform: this.platform,
      sizeFn: this.sizeFn,
    });
  }

  getProgress() {
    return this._lastProgress;
  }

  isActive() {
    return !!this._runPromise;
  }

  /**
   * Start (or join) a download run; resolves with the terminal progress
   * snapshot (done | failed | cancelled). Idempotent while running.
   */
  start() {
    if (this._runPromise) return this._runPromise;
    this._cancelled = false;
    this._runPromise = this._run()
      .finally(() => { this._runPromise = null; });
    return this._runPromise;
  }

  /** Abort the in-flight request; the run resolves with state 'cancelled'. */
  cancel() {
    if (!this._runPromise) return;
    this._cancelled = true;
    if (this._activeRequest) {
      try { this._activeRequest.abort(); } catch (e) { /* already done */ }
    }
  }

  // --- Run ------------------------------------------------------------------

  async _run() {
    this.fsLib.mkdirSync(this.modelsDir, { recursive: true });
    this._warnings = [];
    const plan = this.plan();
    if (!plan.length) {
      return this._push({ state: 'done', plan, planIndex: plan.length }, true);
    }
    this.logFn(`downloading ${plan.length} file(s) into ${this.modelsDir}`);

    for (let i = 0; i < plan.length; i += 1) {
      const item = plan[i];
      try {
        await this._downloadOne(item, plan, i);
      } catch (err) {
        try { this.fsLib.rmSync(item.partPath, { force: true }); } catch (e) { /* best effort */ }
        if (this._cancelled) {
          return this._push({ state: 'cancelled', plan, planIndex: i }, true);
        }
        // An accelerator (optional fast-path model) failing must not sink the
        // required files behind it — record the degradation and carry on. A
        // required failure still fails the run.
        if (item.role === 'accelerator') {
          this.logFn(`accelerator ${item.file} failed (${err.message}); continuing`);
          this._warnings.push({ file: item.file, error: err.message });
          continue;
        }
        this.logFn(`failed on ${item.file}: ${err.message}`);
        return this._push({ state: 'failed', plan, planIndex: i, error: `${item.file}: ${err.message}` }, true);
      }
    }
    return this._push({ state: 'done', plan, planIndex: plan.length }, true);
  }

  _downloadOne(item, plan, planIndex) {
    return new Promise((resolve, reject) => {
      const hash = this.createHashFn();
      let received = 0;
      let settled = false;
      const sink = this.fsLib.createWriteStream(item.partPath);
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        this._activeRequest = null;
        fn(arg);
      };
      const fail = (err) => {
        try { sink.destroy(); } catch (e) { /* already closed */ }
        finish(reject, err);
      };

      sink.on('error', (err) => fail(new Error(`write failed: ${err.message}`)));

      this._push({ state: 'downloading', plan, planIndex, currentReceived: 0 }, true);
      this._activeRequest = this.streamRequestFn(item.url, {
        onResponse: (statusCode) => {
          if (statusCode !== 200) fail(new Error(`HTTP ${statusCode}`));
        },
        onData: (chunk) => {
          if (settled) return;
          received += chunk.length;
          hash.update(chunk);
          sink.write(chunk);
          this._push({ state: 'downloading', plan, planIndex, currentReceived: received });
        },
        onEnd: () => {
          if (settled) return;
          sink.end(() => {
            try {
              if (this._cancelled) throw new Error('cancelled');
              this._push({ state: 'verifying', plan, planIndex, currentReceived: received }, true);
              if (received !== item.bytes) {
                throw new Error(`size mismatch: got ${received}, expected ${item.bytes}`);
              }
              const digest = hash.digest('hex');
              if (digest !== item.sha256) {
                throw new Error(`sha256 mismatch: got ${digest}`);
              }
              this.fsLib.renameSync(item.partPath, item.destPath);
              this.logFn(`verified ${item.file}`);
              finish(resolve);
            } catch (err) {
              finish(reject, err);
            }
          });
        },
        onError: (err) => fail(this._cancelled ? new Error('cancelled') : err),
      });
    });
  }

  // Throttled progress push; `force` for state transitions and terminals.
  _push(snapshotArgs, force = false) {
    const snap = progressSnapshot({ warnings: this._warnings, ...snapshotArgs });
    const stateChanged = snap.state !== this._lastProgress.state;
    this._lastProgress = snap;
    const now = this.nowFn();
    if (force || stateChanged || now - this._lastPushAt >= PROGRESS_PUSH_INTERVAL_MS) {
      this._lastPushAt = now;
      if (this.onProgress) {
        try { this.onProgress(snap); } catch (e) { /* listener must not break the run */ }
      }
    }
    return snap;
  }
}

export function createModelDownloader(opts) {
  return new ModelDownloader(opts);
}
