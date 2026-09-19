/* eslint-disable */
/**
 * SidecarManager — main-process supervisor for the embedded Rust serving
 * backend (serving/sidecar). MAIN PROCESS ONLY: no renderer imports, no
 * dialogs; failures are reported as status ('sidecar:status') and the UI
 * decides what to surface.
 *
 * Lifecycle / state machine (states in util/sidecar-core.js):
 *
 *   stopped --ensure, files missing--> failed        (missing list in status)
 *   stopped --ensure--> starting --/health 200--> ready
 *                       starting --timeout or startup exit--> failed
 *   ready --unexpected exit--> starting (auto-restart, capped backoff,
 *                              new port) ... up to maxRestarts, then failed
 *   any --stop()--> stopped
 *   failed --ensure--> starting  only when the missing files have appeared
 *                      or the caller passes { retry: true } (Test button);
 *                      implicit ensures (the per-request connectivity gate)
 *                      never respawn a runtime-failed sidecar in a loop.
 *
 * Invariants:
 *  - Nothing spawns at app launch: only ensureStarted() spawns, and it is
 *    called from renderer 'first use' paths (a serving request via the
 *    connectivity gate, or the Server Settings modal).
 *  - The port is allocated fresh (OS-assigned free port) for every spawn and
 *    lives only in memory — never in prefs, never in .cdm files.
 *  - The child never outlives the app: stop() runs on quit (background.js
 *    cleanUp), and a process 'exit' hook SIGKILLs as a last resort (covers
 *    app.exit(0), which skips Electron's quit events).
 *
 * Logs: <userData>/sidecar/logs/sidecar.log (stdout+stderr appended; rotated
 * to sidecar.log.1 when it exceeds 5 MB at spawn time).
 */

import {
  SIDECAR_STATES,
  resolveSidecarPaths,
  missingSidecarFiles,
  buildSidecarArgs,
  restartDelayMs,
  describeMissing,
  missingAccelFiles,
} from './util/sidecar-core';
import { embeddedBaseUrl } from './util/server-config';
import {
  healthReportsBuilding,
  healthCapabilityBuilding,
  computeOptimizeProgress,
  resolveOptimizePhase,
} from './util/optimize-progress-core';

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const STDERR_TAIL_LINES = 12;

// --- Default effectful deps (each injectable for tests) ---------------------

function defaultSpawn(binPath, args, options) {
  return require('child_process').spawn(binPath, args, options);
}

function defaultExists(p) {
  try {
    return require('fs').existsSync(p);
  } catch (e) {
    return false;
  }
}

// Ask the OS for a free loopback port by binding to port 0.
function defaultAllocatePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// One GET <url>; resolves the parsed JSON body on a 200 (the sidecar's
// /health carries the acceleration report), `true` on a 200 with an
// unparseable body, `false` otherwise. Any truthy value means "healthy".
function defaultFetchHealth(url) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) || true);
        } catch (e) {
          resolve(true);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Append stream to the sidecar log, with a simple size-capped rotation.
function defaultCreateLogSink(logDir, logPath) {
  const fs = require('fs');
  fs.mkdirSync(logDir, { recursive: true });
  try {
    if (fs.statSync(logPath).size > LOG_MAX_BYTES) {
      const rotated = `${logPath}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch (e) { /* best effort */ }
      fs.renameSync(logPath, rotated);
    }
  } catch (e) {
    // No log yet (or unstatable) — fine.
  }
  return fs.createWriteStream(logPath, { flags: 'a' });
}

function defaultRegisterExitHook(fn) {
  process.on('exit', fn);
}

// ---------------------------------------------------------------------------

export class SidecarManager {
  constructor(opts = {}) {
    const {
      // Environment (background.js supplies these from Electron's app object).
      isPackaged = false,
      resourcesPath = '',
      appPath = '',
      userDataPath = '',
      env = process.env,
      platform = process.platform,
      // Effect injections.
      spawnFn = defaultSpawn,
      existsFn = defaultExists,
      allocatePortFn = defaultAllocatePort,
      fetchHealthFn = defaultFetchHealth,
      delayFn = defaultDelay,
      nowFn = Date.now,
      createLogSinkFn = null,
      registerExitHookFn = defaultRegisterExitHook,
      // Optimization-progress probe: async (coremlCacheDir) => {done,total}
      // or null (counts compiled CoreML partition dirs — wired darwin-only
      // in background.js; see util/optimize-progress-core.js).
      probeOptimizeFn = null,
      // Status push (background.js forwards to the renderer window).
      onStatus = null,
      // Raw child stdout/stderr tap ('stdout'|'stderr', chunk) — feeds the
      // Debug Log panel's live stream (background.js). Independent of the
      // file sink; a throwing tap never breaks supervision.
      onChildOutput = null,
      // Tunables.
      readinessTimeoutMs = 20000,
      pollIntervalMs = 250,
      maxRestarts = 3,
      stableResetMs = 60000,
      stopGraceMs = 3000,
      // Building re-poll (see _pollWhileBuilding). 2.5s: the loop only runs
      // while `building`, which is exactly when a progress bar is visible —
      // the AnT bucket's 42 partitions land about one per 2.5s.
      buildingPollIntervalMs = 2500,
      buildingPollMaxMs = 10 * 60 * 1000,
      logFn = (...args) => console.log('[sidecar]', ...args),
    } = opts;

    this.paths = resolveSidecarPaths({
      isPackaged, resourcesPath, appPath, userDataPath, env, platform,
    });
    this.platform = platform;

    this.spawnFn = spawnFn;
    this.existsFn = existsFn;
    this.allocatePortFn = allocatePortFn;
    this.fetchHealthFn = fetchHealthFn;
    this.delayFn = delayFn;
    this.nowFn = nowFn;
    this.createLogSinkFn = createLogSinkFn
      || (() => defaultCreateLogSink(this.paths.logDir, this.paths.logPath));
    this.registerExitHookFn = registerExitHookFn;
    this.probeOptimizeFn = probeOptimizeFn;
    this.onStatus = onStatus;
    this.onChildOutput = onChildOutput;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.maxRestarts = maxRestarts;
    this.stableResetMs = stableResetMs;
    this.stopGraceMs = stopGraceMs;
    this.buildingPollIntervalMs = buildingPollIntervalMs;
    this.buildingPollMaxMs = buildingPollMaxMs;
    // Generation whose building-poll loop is live (null: none). Generation-
    // scoped, not a boolean: a stale loop sleeping through a crash-restart
    // must not suppress the new generation's loop.
    this._buildingPollGen = null;
    this._refreshHealthPromise = null;
    this.logFn = logFn;

    this.state = SIDECAR_STATES.STOPPED;
    this.port = null;
    this.child = null;
    this.lastError = null;
    this.restarts = 0;
    // Last parsed /health body (null when the probe returned a bare 200).
    // Only meaningful while READY — getStatus gates it on state.
    this.lastHealth = null;
    // Optimization progress ({phase, done, total, percent, sinceMs} | null),
    // maintained by _updateOptimizeProgress while the report says building.
    this.optimizeProgress = null;
    this._optimizePhase = null; // latched per building episode
    this._optimizeSince = null; // null = unset (0 is a valid injected-clock time)

    this._startingPromise = null;
    this._deliberateStop = false;
    this._generation = 0; // bumped on every spawn/stop to invalidate stale async work
    this._failureKind = null; // 'missing' | 'runtime'
    this._spawnedAt = 0;
    this._exitHookRegistered = false;
    this._logSink = null;
    this._stderrTail = [];
  }

  // --- Status ---------------------------------------------------------------

  getStatus() {
    const probeFiles = this.state === SIDECAR_STATES.STOPPED
      || this.state === SIDECAR_STATES.FAILED;
    return {
      state: this.state,
      port: this.state === SIDECAR_STATES.READY ? this.port : null,
      baseUrl: this.state === SIDECAR_STATES.READY ? embeddedBaseUrl(this.port) : null,
      pid: this.child ? this.child.pid : null,
      lastError: this.lastError,
      missing: probeFiles ? missingSidecarFiles(this.paths, this.existsFn) : [],
      // Absent accelerator (fast-path) models for this platform. Never blocks
      // — probed in every state so the UI can offer the download that
      // restores full speed even while the sidecar is READY on CPU.
      missingAccel: missingAccelFiles(this.paths, this.existsFn, this.platform),
      restarts: this.restarts,
      binPath: this.paths.binPath,
      modelsDir: this.paths.modelsDir,
      // The sidecar's last /health body (acceleration report etc.); null
      // unless READY, so a stale report never outlives its process.
      health: this.state === SIDECAR_STATES.READY ? this.lastHealth : null,
      // CoreML optimization progress; same READY gating as health.
      optimizing: this.state === SIDECAR_STATES.READY ? this.optimizeProgress : null,
    };
  }

  /** End the optimization episode: one invariant, one place (see resets). */
  _resetOptimizeState() {
    this.optimizeProgress = null;
    this._optimizePhase = null;
    this._optimizeSince = null;
  }

  /**
   * Refresh optimizeProgress from the injected probe; returns whether the
   * status-visible value changed (the caller folds that into its push
   * decision). Never throws; a probe failure keeps the last value. Gated on
   * the COLORIZE capability specifically — the probe counts the AnT bucket's
   * partition dirs, and decorating a gap-only compile with that count would
   * show a frozen 0% (or a false 'loading') for the wrong model.
   */
  async _updateOptimizeProgress() {
    if (!this.probeOptimizeFn || !healthCapabilityBuilding(this.lastHealth, 'colorize')) {
      const hadValue = this.optimizeProgress !== null;
      this._resetOptimizeState();
      return hadValue; // one final push makes the bar disappear
    }
    const gen = this._generation;
    let probed = null;
    try {
      probed = await this.probeOptimizeFn(this.paths.coremlCacheDir);
    } catch (e) {
      return false;
    }
    if (!probed) return false;
    // A stop()/restart during the probe reset the episode — a stale result
    // must not resurrect it (the push guard alone can't undo the writes).
    if (gen !== this._generation || this.state !== SIDECAR_STATES.READY) return false;
    if (this._optimizeSince === null) this._optimizeSince = this.nowFn();
    const sinceMs = this.nowFn() - this._optimizeSince;
    this._optimizePhase = resolveOptimizePhase(this._optimizePhase, probed, sinceMs);
    const prev = this.optimizeProgress;
    const next = {
      phase: this._optimizePhase,
      ...computeOptimizeProgress(probed),
      sinceMs,
    };
    this.optimizeProgress = next;
    // sinceMs advances every tick — exclude it, or identical progress spams.
    return !prev || prev.done !== next.done || prev.phase !== next.phase;
  }

  /**
   * Re-poll /health while READY and push a status update if the body changed
   * (the acceleration report moves as CoreML compiles finish or fall back).
   * Fire-and-forget from the sync `sidecar:status` IPC and from the
   * building-poll loop below; never throws.
   */
  async refreshHealth() {
    // Coalesce overlapping refreshes (the building loop and the
    // 'sidecar:status' IPC both fire-and-forget): concurrent fetches can
    // otherwise commit /health bodies out of order and briefly resurrect a
    // settled 'building' report.
    if (this._refreshHealthPromise) return this._refreshHealthPromise;
    this._refreshHealthPromise = this._refreshHealthOnce()
      .finally(() => { this._refreshHealthPromise = null; });
    return this._refreshHealthPromise;
  }

  async _refreshHealthOnce() {
    if (this.state !== SIDECAR_STATES.READY) return;
    const gen = this._generation;
    let health = null;
    try {
      health = await this.fetchHealthFn(`${embeddedBaseUrl(this.port)}/health`);
    } catch (e) {
      return; // transient probe error — keep the last snapshot
    }
    if (gen !== this._generation || this.state !== SIDECAR_STATES.READY) return;
    if (!health || typeof health !== 'object') return;
    const healthChanged = JSON.stringify(health) !== JSON.stringify(this.lastHealth);
    this.lastHealth = health;
    const progressChanged = await this._updateOptimizeProgress();
    if (gen !== this._generation || this.state !== SIDECAR_STATES.READY) return;
    if ((healthChanged || progressChanged) && this.onStatus) this.onStatus(this.getStatus());
    // An IPC-triggered refresh can be the first to see a `building` report
    // (no-op while the loop below already runs).
    this._pollWhileBuilding();
  }

  /**
   * While READY and the acceleration report says `building`, keep re-polling
   * /health so subscribers see the compile settle without having to ask.
   * The readiness snapshot is taken before the AnT CoreML compile finishes
   * (prewarm flips its gate to BUILDING before the server accepts
   * connections), and the Server Settings modal is push-driven — without
   * this loop, a user watching "Optimizing…" during the one-time compile
   * saw it stick forever. Reentry-guarded; exits on any state/generation
   * change or after `buildingPollMaxMs` (a wedged compile must not be
   * polled unboundedly).
   */
  async _pollWhileBuilding() {
    // Reentry guard, scoped to the generation: a stale loop still sleeping
    // through a crash-restart must not block the new process's loop (it
    // exits on its own gen check and must only clear its own claim).
    if (this._buildingPollGen === this._generation) return;
    const gen = this._generation;
    this._buildingPollGen = gen;
    const deadline = this.nowFn() + this.buildingPollMaxMs;
    try {
      while (
        gen === this._generation
        && this.state === SIDECAR_STATES.READY
        && healthReportsBuilding(this.lastHealth)
        && this.nowFn() < deadline
      ) {
        await this.delayFn(this.buildingPollIntervalMs);
        if (gen !== this._generation || this.state !== SIDECAR_STATES.READY) break;
        await this.refreshHealth();
      }
    } finally {
      if (this._buildingPollGen === gen) this._buildingPollGen = null;
    }
  }

  _setState(state) {
    this.state = state;
    this.logFn(`state -> ${state}${this.lastError ? ` (${this.lastError})` : ''}`);
    if (this.onStatus) {
      try {
        this.onStatus(this.getStatus());
      } catch (e) {
        // A broken listener must not take the supervisor down.
      }
    }
  }

  // --- Public lifecycle -----------------------------------------------------

  /**
   * Start the sidecar if it isn't running, and resolve with a status once it
   * is ready or has failed. Idempotent and coalescing: concurrent callers
   * share one startup. `retry: true` forces a fresh attempt out of a failed
   * state (the settings UI's explicit action).
   */
  async ensureStarted({ retry = false } = {}) {
    if (this.state === SIDECAR_STATES.READY) return this.getStatus();
    if (this._startingPromise) return this._startingPromise;
    if (this.state === SIDECAR_STATES.FAILED && !retry) {
      // Implicit ensure (per-request gate): only leave failed on its own if
      // the failure was missing files and they have since appeared.
      const missing = missingSidecarFiles(this.paths, this.existsFn);
      if (this._failureKind !== 'missing' || missing.length) return this.getStatus();
    }
    this._deliberateStop = false;
    this._startingPromise = this._startFresh()
      .finally(() => { this._startingPromise = null; });
    return this._startingPromise;
  }

  /** Deliberate shutdown: SIGTERM, short grace, SIGKILL. Resets to stopped. */
  async stop() {
    this._deliberateStop = true;
    this._generation += 1;
    const child = this.child;
    this.child = null;
    this.port = null;
    this.restarts = 0;
    this._failureKind = null;
    if (child && !child.__cadmiumGone) {
      try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
      const deadline = this.nowFn() + this.stopGraceMs;
      while (!child.__cadmiumGone && this.nowFn() < deadline) {
        await this.delayFn(50);
      }
      if (!child.__cadmiumGone) {
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      }
    }
    this.lastError = null;
    this._resetOptimizeState();
    this._setState(SIDECAR_STATES.STOPPED);
    return this.getStatus();
  }

  /** Synchronous last-resort kill for the process 'exit' hook. */
  killSync() {
    this._deliberateStop = true;
    this._generation += 1;
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      this.child = null;
    }
  }

  // --- Startup --------------------------------------------------------------

  async _startFresh() {
    const missing = missingSidecarFiles(this.paths, this.existsFn);
    if (missing.length) {
      this.lastError = describeMissing(missing);
      this._failureKind = 'missing';
      this._setState(SIDECAR_STATES.FAILED);
      return this.getStatus();
    }
    this.restarts = 0;
    return this._allocateAndSpawn();
  }

  async _allocateAndSpawn() {
    try {
      this.port = await this.allocatePortFn();
    } catch (e) {
      this.lastError = `Could not allocate a local port: ${e.message}`;
      this._failureKind = 'runtime';
      this._setState(SIDECAR_STATES.FAILED);
      return this.getStatus();
    }
    return this._spawnAndAwaitReady();
  }

  async _spawnAndAwaitReady() {
    if (this._deliberateStop) {
      // A stop() raced this startup (e.g. during port allocation) — obey it.
      return this.getStatus();
    }
    const gen = ++this._generation;
    this.lastError = null;
    // Each spawn is a fresh optimization episode (the phase latch must not
    // carry a stale 'compiling'/'loading' across restarts).
    this._resetOptimizeState();
    this._setState(SIDECAR_STATES.STARTING);

    const args = buildSidecarArgs({
      port: this.port,
      antModelPath: this.paths.antModelPath,
      gapModelPath: this.paths.gapModelPath,
      antBucketModelPath: this.existsFn(this.paths.antBucketModelPath)
        ? this.paths.antBucketModelPath
        : null,
      antTiledModelPath: this.existsFn(this.paths.antTiledModelPath)
        ? this.paths.antTiledModelPath
        : null,
      gapBucketModelPath: this.existsFn(this.paths.gapBucketModelPath)
        ? this.paths.gapBucketModelPath
        : null,
      coremlCacheDir: this.paths.coremlCacheDir,
    });

    let child;
    try {
      child = this.spawnFn(this.paths.binPath, args, {
        // stdin MUST be a pipe: the sidecar runs --exit-on-stdin-close, so
        // the OS closing this pipe on our death (even SIGKILL) reaps it.
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.lastError = `Could not launch sidecar: ${e.message}`;
      this._failureKind = 'runtime';
      this._setState(SIDECAR_STATES.FAILED);
      return this.getStatus();
    }
    this.child = child;
    this._spawnedAt = this.nowFn();
    this._ensureExitHook();
    this._attachChild(child, gen);
    this.logFn(`spawned pid ${child.pid} on port ${this.port}`);

    // Readiness: poll /health until 200 or timeout. The sidecar answers
    // /health as soon as it listens (ONNX sessions are lazy), so this is a
    // "process is up and serving" check, not a model-load wait.
    const healthUrl = `${embeddedBaseUrl(this.port)}/health`;
    const deadline = this.nowFn() + this.readinessTimeoutMs;
    while (this.nowFn() < deadline) {
      if (gen !== this._generation || this.state !== SIDECAR_STATES.STARTING) {
        // Crashed during startup (exit handler moved us to failed) or a
        // stop() superseded this attempt — that transition owns the status.
        return this.getStatus();
      }
      const health = await this.fetchHealthFn(healthUrl);
      if (health) {
        if (gen !== this._generation || this.state !== SIDECAR_STATES.STARTING) {
          return this.getStatus();
        }
        this.lastHealth = typeof health === 'object' ? health : null;
        this._setState(SIDECAR_STATES.READY);
        // On macOS the report virtually always starts as `building` here
        // (prewarm claims the gate before the server listens) — track the
        // compile to completion so the pushed status settles on its own.
        this._pollWhileBuilding();
        return this.getStatus();
      }
      await this.delayFn(this.pollIntervalMs);
    }

    if (gen !== this._generation || this.state !== SIDECAR_STATES.STARTING) {
      // Superseded (stop or crash transition) while the last poll delay ran;
      // that transition owns the state — don't clobber it with a timeout.
      return this.getStatus();
    }
    this.lastError = `Sidecar did not answer /health within ${Math.round(this.readinessTimeoutMs / 1000)}s`;
    this._failureKind = 'runtime';
    this._generation += 1; // detach: the exit handler must not double-report
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    this.child = null;
    this._setState(SIDECAR_STATES.FAILED);
    return this.getStatus();
  }

  // --- Child wiring ---------------------------------------------------------

  _attachChild(child, gen) {
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        this._writeLog(chunk);
        this._tapChildOutput('stdout', chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        this._writeLog(chunk);
        this._pushStderr(chunk);
        this._tapChildOutput('stderr', chunk);
      });
    }
    child.on('error', (err) => this._onChildGone(child, gen, null, err));
    child.on('exit', (code, signal) => this._onChildGone(child, gen, { code, signal }, null));
  }

  _onChildGone(child, gen, exit, err) {
    if (child.__cadmiumGone) return; // 'error' and 'exit' can both fire
    child.__cadmiumGone = true;
    if (this.child === child) this.child = null;
    if (this._deliberateStop || gen !== this._generation) return; // stop()/timeout owns this

    const desc = err
      ? `failed to launch: ${err.message}`
      : `exited (code ${exit.code}, signal ${exit.signal})`;
    const tail = this._stderrTailString();
    this.lastError = `Sidecar ${desc}${tail ? ` — ${tail}` : ''}`;
    this.logFn(this.lastError);

    if (this.state === SIDECAR_STATES.STARTING) {
      // Died before ever answering /health: almost certainly persistent (bad
      // binary, bad model, port clash) — fail instead of crash-looping. The
      // in-flight readiness poll sees the state change and bails.
      this._failureKind = 'runtime';
      this._setState(SIDECAR_STATES.FAILED);
      return;
    }

    if (this.state === SIDECAR_STATES.READY) {
      // After a long stable run, start the crash budget over.
      if (this.nowFn() - this._spawnedAt > this.stableResetMs) this.restarts = 0;
      this.restarts += 1;
      if (this.restarts > this.maxRestarts) {
        this._failureKind = 'runtime';
        this.lastError = `Sidecar crashed ${this.restarts} times in a row; giving up. Last: ${desc}${tail ? ` — ${tail}` : ''}`;
        this._setState(SIDECAR_STATES.FAILED);
        return;
      }
      // Auto-restart with capped exponential backoff, on a fresh port.
      const wait = restartDelayMs(this.restarts);
      this.logFn(`auto-restart ${this.restarts}/${this.maxRestarts} in ${wait}ms`);
      this._setState(SIDECAR_STATES.STARTING);
      this._startingPromise = (async () => {
        await this.delayFn(wait);
        if (this._deliberateStop || this.state !== SIDECAR_STATES.STARTING) {
          return this.getStatus();
        }
        return this._allocateAndSpawn();
      })().finally(() => { this._startingPromise = null; });
    }
  }

  _ensureExitHook() {
    if (this._exitHookRegistered) return;
    this._exitHookRegistered = true;
    this.registerExitHookFn(() => this.killSync());
  }

  // --- Logging --------------------------------------------------------------

  _tapChildOutput(stream, chunk) {
    if (!this.onChildOutput) return;
    try {
      this.onChildOutput(stream, chunk);
    } catch (e) {
      // A broken tap must not take the supervisor down (same rule as onStatus).
    }
  }

  _writeLog(chunk) {
    try {
      if (!this._logSink) this._logSink = this.createLogSinkFn();
      this._logSink.write(chunk);
    } catch (e) {
      // Logging must never break supervision.
    }
  }

  _pushStderr(chunk) {
    const lines = String(chunk).split('\n').filter((l) => l.trim().length);
    this._stderrTail.push(...lines);
    if (this._stderrTail.length > STDERR_TAIL_LINES) {
      this._stderrTail.splice(0, this._stderrTail.length - STDERR_TAIL_LINES);
    }
  }

  _stderrTailString() {
    if (!this._stderrTail.length) return '';
    return this._stderrTail.slice(-3).join(' | ').slice(0, 300);
  }
}

export function createSidecarManager(opts) {
  return new SidecarManager(opts);
}
