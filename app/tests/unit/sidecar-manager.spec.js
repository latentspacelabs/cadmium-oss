import { EventEmitter } from 'events';

import {
  SIDECAR_STATES,
  MODEL_ANT,
  MODEL_GAP,
  MODEL_ANT_BUCKET,
  MODEL_ANT_TILED,
  MODEL_GAP_BUCKET,
  resolveSidecarPaths,
  missingSidecarFiles,
  buildSidecarArgs,
  restartDelayMs,
  describeMissing,
  RESTART_DELAY_CAP_MS,
} from '@/util/sidecar-core';
import { SidecarManager } from '@/sidecar-manager';

// The embedded backend's supervisor. The pure decisions (paths, argv, missing
// files, backoff) live in util/sidecar-core.js; the manager's state machine is
// exercised here with every effect injected — no real processes, ports,
// filesystem or timers.

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('resolveSidecarPaths', () => {
  it('packaged: binary under resourcesPath/sidecar, models under userData/models', () => {
    const paths = resolveSidecarPaths({
      isPackaged: true,
      resourcesPath: '/App.app/Contents/Resources',
      appPath: '/App.app/Contents/Resources/app.asar',
      userDataPath: '/ud',
      env: {},
      platform: 'darwin',
    });
    // Must line up with the extraResources mapping in vue.config.js.
    expect(paths.binPath).toBe('/App.app/Contents/Resources/sidecar/cadmium-sidecar');
    expect(paths.modelsDir).toBe('/ud/models');
    expect(paths.antModelPath).toBe(`/ud/models/${MODEL_ANT}`);
    expect(paths.gapModelPath).toBe(`/ud/models/${MODEL_GAP}`);
    expect(paths.antBucketModelPath).toBe(`/ud/models/${MODEL_ANT_BUCKET}`);
    expect(paths.antTiledModelPath).toBe(`/ud/models/${MODEL_ANT_TILED}`);
    expect(paths.gapBucketModelPath).toBe(`/ud/models/${MODEL_GAP_BUCKET}`);
    expect(paths.coremlCacheDir).toBe('/ud/sidecar/coreml-cache');
  });

  it('packaged windows: binary name gains .exe', () => {
    const paths = resolveSidecarPaths({
      isPackaged: true,
      resourcesPath: 'C:\\app\\resources',
      appPath: 'C:\\app\\resources\\app.asar',
      userDataPath: 'C:\\ud',
      env: {},
      platform: 'win32',
    });
    expect(paths.binPath.endsWith('cadmium-sidecar.exe')).toBe(true);
  });

  it('dev: defaults to the cargo release output next to app/', () => {
    const paths = resolveSidecarPaths({
      isPackaged: false,
      resourcesPath: '',
      appPath: '/repo/app',
      userDataPath: '/ud',
      env: {},
      platform: 'darwin',
    });
    expect(paths.binPath).toBe('/repo/serving/sidecar/target/release/cadmium-sidecar');
    expect(paths.modelsDir).toBe('/ud/models');
  });

  it('dev: electron:serve appPath (app/dist_electron) still resolves to the repo root', () => {
    const paths = resolveSidecarPaths({
      isPackaged: false,
      resourcesPath: '',
      appPath: '/repo/app/dist_electron',
      userDataPath: '/ud',
      env: {},
      platform: 'darwin',
    });
    expect(paths.binPath).toBe('/repo/serving/sidecar/target/release/cadmium-sidecar');
  });

  it('dev: CADMIUM_SIDECAR_BIN and CADMIUM_MODELS_DIR override', () => {
    const paths = resolveSidecarPaths({
      isPackaged: false,
      resourcesPath: '',
      appPath: '/repo/app',
      userDataPath: '/ud',
      env: {
        CADMIUM_SIDECAR_BIN: '/custom/bin/cadmium-sidecar',
        CADMIUM_MODELS_DIR: '/custom/models',
      },
      platform: 'darwin',
    });
    expect(paths.binPath).toBe('/custom/bin/cadmium-sidecar');
    expect(paths.modelsDir).toBe('/custom/models');
    expect(paths.antModelPath).toBe(`/custom/models/${MODEL_ANT}`);
  });

  it('packaged: env overrides are ignored (dev-only escape hatch)', () => {
    const paths = resolveSidecarPaths({
      isPackaged: true,
      resourcesPath: '/res',
      appPath: '/res/app.asar',
      userDataPath: '/ud',
      env: { CADMIUM_SIDECAR_BIN: '/custom/bin', CADMIUM_MODELS_DIR: '/custom/models' },
      platform: 'darwin',
    });
    expect(paths.binPath).toBe('/res/sidecar/cadmium-sidecar');
    expect(paths.modelsDir).toBe('/ud/models');
  });
});

describe('missingSidecarFiles', () => {
  const paths = resolveSidecarPaths({
    isPackaged: false, appPath: '/repo/app', userDataPath: '/ud', env: {}, platform: 'darwin',
  });

  it('reports nothing when binary and both required models exist', () => {
    expect(missingSidecarFiles(paths, () => true)).toEqual([]);
  });

  it('reports binary and models, never the optional bucket model', () => {
    const missing = missingSidecarFiles(paths, () => false);
    expect(missing.map((m) => m.kind)).toEqual(['binary', 'model', 'model']);
    expect(missing.map((m) => m.file)).toEqual(['cadmium-sidecar', MODEL_ANT, MODEL_GAP]);
    expect(missing.some((m) => m.file === MODEL_ANT_BUCKET)).toBe(false);
  });

  it('reports only the absent files', () => {
    const missing = missingSidecarFiles(paths, (p) => p !== paths.gapModelPath);
    expect(missing).toEqual([{ kind: 'model', file: MODEL_GAP, path: paths.gapModelPath }]);
  });
});

describe('buildSidecarArgs', () => {
  it('builds the sidecar CLI contract with --ep auto on loopback', () => {
    expect(buildSidecarArgs({
      port: 4321, antModelPath: '/m/ant.onnx', gapModelPath: '/m/gap.onnx',
    })).toEqual([
      '--port', '4321',
      '--host', '127.0.0.1',
      '--ant-model', '/m/ant.onnx',
      '--gap-model', '/m/gap.onnx',
      '--ep', 'auto',
      '--exit-on-stdin-close',
    ]);
  });

  it('adds --ant-model-bucket only when a bucket model is supplied', () => {
    const args = buildSidecarArgs({
      port: 1, antModelPath: 'a', gapModelPath: 'g', antBucketModelPath: '/m/bucket.onnx',
    });
    expect(args.slice(-2)).toEqual(['--ant-model-bucket', '/m/bucket.onnx']);
  });

  it('adds --ant-model-tiled only when a tiled model is supplied', () => {
    const args = buildSidecarArgs({
      port: 1, antModelPath: 'a', gapModelPath: 'g', antTiledModelPath: '/m/tiled.onnx',
    });
    expect(args.slice(-2)).toEqual(['--ant-model-tiled', '/m/tiled.onnx']);
    expect(buildSidecarArgs({ port: 1, antModelPath: 'a', gapModelPath: 'g' }))
      .not.toContain('--ant-model-tiled');
  });

  it('adds --gap-model-bucket only when a gap bucket model is supplied', () => {
    const args = buildSidecarArgs({
      port: 1, antModelPath: 'a', gapModelPath: 'g', gapBucketModelPath: '/m/gapb.onnx',
    });
    expect(args.slice(-2)).toEqual(['--gap-model-bucket', '/m/gapb.onnx']);
    expect(buildSidecarArgs({ port: 1, antModelPath: 'a', gapModelPath: 'g' }))
      .not.toContain('--gap-model-bucket');
  });

  it('adds --coreml-cache-dir only when a cache dir is supplied', () => {
    const args = buildSidecarArgs({
      port: 1, antModelPath: 'a', gapModelPath: 'g', coremlCacheDir: '/ud/sidecar/coreml-cache',
    });
    expect(args.slice(-2)).toEqual(['--coreml-cache-dir', '/ud/sidecar/coreml-cache']);
    expect(buildSidecarArgs({ port: 1, antModelPath: 'a', gapModelPath: 'g' }))
      .not.toContain('--coreml-cache-dir');
  });
});

describe('restartDelayMs', () => {
  it('backs off exponentially from 1s and caps', () => {
    expect(restartDelayMs(1)).toBe(1000);
    expect(restartDelayMs(2)).toBe(2000);
    expect(restartDelayMs(3)).toBe(4000);
    expect(restartDelayMs(10)).toBe(RESTART_DELAY_CAP_MS);
  });
});

describe('describeMissing', () => {
  it('lists the missing filenames', () => {
    expect(describeMissing([{ file: 'a.onnx' }, { file: 'b.onnx' }])).toBe('Missing: a.onnx, b.onnx');
    expect(describeMissing([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// State machine (everything injected)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  constructor(pid, { exitOnSigterm = false } = {}) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = [];
    this.exitOnSigterm = exitOnSigterm;
  }

  kill(signal) {
    this.killed.push(signal);
    if (this.exitOnSigterm && signal === 'SIGTERM') {
      this.emit('exit', null, 'SIGTERM');
    }
  }
}

function makeHarness({
  exists = () => true,
  health = () => true,
  childOptions = {},
  managerOptions = {},
} = {}) {
  const h = {
    t: 0,
    spawned: [],
    statuses: [],
    exitHooks: [],
    ports: [4300],
    health,
  };
  h.manager = new SidecarManager({
    isPackaged: false,
    appPath: '/repo/app',
    userDataPath: '/ud',
    env: {},
    platform: 'darwin',
    existsFn: (p) => exists(p),
    spawnFn: (bin, args, opts) => {
      const child = new FakeChild(100 + h.spawned.length, childOptions);
      h.spawned.push({
        bin, args, opts, child,
      });
      return child;
    },
    allocatePortFn: async () => {
      const port = h.ports[0];
      h.ports[0] += 1;
      return port;
    },
    fetchHealthFn: async (url) => h.health(url),
    delayFn: async (ms) => { h.t += ms; },
    nowFn: () => h.t,
    createLogSinkFn: () => ({ write: () => {}, end: () => {} }),
    registerExitHookFn: (fn) => h.exitHooks.push(fn),
    onStatus: (s) => h.statuses.push(s),
    readinessTimeoutMs: 2000,
    pollIntervalMs: 100,
    maxRestarts: 2,
    stopGraceMs: 300,
    logFn: () => {},
    ...managerOptions,
  });
  return h;
}

describe('SidecarManager — startup', () => {
  it('starts stopped, with missing files probed in the status', () => {
    const h = makeHarness({ exists: () => false });
    const status = h.manager.getStatus();
    expect(status.state).toBe(SIDECAR_STATES.STOPPED);
    expect(status.missing.length).toBe(3);
    expect(status.baseUrl).toBeNull();
    expect(h.spawned.length).toBe(0); // constructing never spawns
  });

  it('fails without spawning when required files are missing, and says which', async () => {
    const h = makeHarness({ exists: (p) => !p.endsWith(MODEL_GAP) });
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.FAILED);
    expect(status.missing).toEqual([
      expect.objectContaining({ kind: 'model', file: MODEL_GAP }),
    ]);
    expect(status.lastError).toContain(MODEL_GAP);
    expect(h.spawned.length).toBe(0);
  });

  it('spawns with the allocated port and reaches ready on /health 200', async () => {
    const healthUrls = [];
    const h = makeHarness({
      exists: (p) => !p.endsWith(MODEL_ANT_BUCKET),
      health: (url) => { healthUrls.push(url); return true; },
    });
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(status.port).toBe(4300);
    expect(status.baseUrl).toBe('http://127.0.0.1:4300');
    expect(healthUrls[0]).toBe('http://127.0.0.1:4300/health');
    expect(h.spawned.length).toBe(1);
    expect(h.spawned[0].args).toEqual(expect.arrayContaining(['--port', '4300', '--ep', 'auto']));
    expect(h.spawned[0].args).not.toContain('--ant-model-bucket');
    // Status transitions were pushed: starting then ready.
    expect(h.statuses.map((s) => s.state)).toEqual([
      SIDECAR_STATES.STARTING, SIDECAR_STATES.READY,
    ]);
    // Orphan protection: the process-exit kill hook is registered.
    expect(h.exitHooks.length).toBe(1);
  });

  it('passes --ant-model-bucket when the optional bucket model exists', async () => {
    const h = makeHarness();
    await h.manager.ensureStarted();
    const { args } = h.spawned[0];
    expect(args[args.indexOf('--ant-model-bucket') + 1].endsWith(MODEL_ANT_BUCKET)).toBe(true);
  });

  it('coalesces concurrent ensures into one spawn', async () => {
    const h = makeHarness();
    const [a, b] = await Promise.all([h.manager.ensureStarted(), h.manager.ensureStarted()]);
    expect(a.state).toBe(SIDECAR_STATES.READY);
    expect(b.state).toBe(SIDECAR_STATES.READY);
    expect(h.spawned.length).toBe(1);
  });

  it('is a no-op when already ready', async () => {
    const h = makeHarness();
    await h.manager.ensureStarted();
    await h.manager.ensureStarted();
    expect(h.spawned.length).toBe(1);
  });

  it('fails and kills the child when /health never answers in time', async () => {
    const h = makeHarness({ health: () => false });
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.FAILED);
    expect(status.lastError).toMatch(/health/);
    expect(h.spawned[0].child.killed).toContain('SIGKILL');
    expect(h.manager.child).toBeNull();
  });

  it('fails without restart-looping when the child dies during startup', async () => {
    const h = makeHarness();
    h.health = () => {
      // First poll: crash the child instead of answering.
      h.spawned[0].child.stderr.emit('data', 'boom: bad model\n');
      h.spawned[0].child.emit('exit', 1, null);
      return false;
    };
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.FAILED);
    expect(status.lastError).toContain('code 1');
    expect(status.lastError).toContain('boom: bad model');
    expect(h.spawned.length).toBe(1); // no auto-restart from a startup crash
  });

  it('fails cleanly when spawn itself throws', async () => {
    const h = makeHarness();
    h.manager.spawnFn = () => { throw new Error('EACCES'); };
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.FAILED);
    expect(status.lastError).toContain('EACCES');
  });
});

describe('SidecarManager — failed-state stickiness', () => {
  it('implicit ensure does not respawn after a runtime failure', async () => {
    const h = makeHarness({ health: () => false });
    await h.manager.ensureStarted(); // -> failed (readiness timeout)
    const again = await h.manager.ensureStarted();
    expect(again.state).toBe(SIDECAR_STATES.FAILED);
    expect(h.spawned.length).toBe(1);
  });

  it('ensure({ retry: true }) forces a fresh attempt out of failed', async () => {
    const h = makeHarness({ health: () => false });
    await h.manager.ensureStarted(); // -> failed
    h.health = () => true;
    const status = await h.manager.ensureStarted({ retry: true });
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(h.spawned.length).toBe(2);
  });

  it('a missing-files failure clears itself once the files appear', async () => {
    let present = false;
    const h = makeHarness({ exists: (p) => (p.endsWith(MODEL_ANT_BUCKET) ? false : present) });
    await h.manager.ensureStarted();
    expect(h.manager.state).toBe(SIDECAR_STATES.FAILED);
    // Files dropped into place (user installed the models): plain ensure recovers.
    present = true;
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(h.spawned.length).toBe(1);
  });
});

describe('SidecarManager — crash auto-restart', () => {
  async function startReady(h) {
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
  }

  it('restarts on a fresh port after an unexpected exit', async () => {
    const h = makeHarness();
    await startReady(h);
    h.spawned[0].child.emit('exit', 137, null);
    // The crash handler synchronously entered starting and scheduled respawn.
    expect(h.manager.state).toBe(SIDECAR_STATES.STARTING);
    const status = await h.manager.ensureStarted(); // awaits the in-flight restart
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(h.spawned.length).toBe(2);
    expect(status.restarts).toBe(1);
    // A fresh port was allocated; the stale one is not reused blindly.
    expect(h.spawned[1].args).toEqual(expect.arrayContaining(['--port', '4301']));
  });

  it('gives up (failed) after maxRestarts consecutive crashes', async () => {
    const h = makeHarness(); // maxRestarts: 2
    await startReady(h);
    for (let i = 0; i < 2; i += 1) {
      h.spawned[h.spawned.length - 1].child.emit('exit', 1, null);
      // eslint-disable-next-line no-await-in-loop
      const status = await h.manager.ensureStarted();
      expect(status.state).toBe(SIDECAR_STATES.READY);
    }
    h.spawned[h.spawned.length - 1].child.emit('exit', 1, null);
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.FAILED);
    expect(status.lastError).toContain('giving up');
    expect(h.spawned.length).toBe(3); // 1 original + 2 restarts, then no more
  });

  it('a long stable run resets the crash budget', async () => {
    const h = makeHarness();
    await startReady(h);
    // Exhaust all-but-one restart quickly.
    h.spawned[0].child.emit('exit', 1, null);
    await h.manager.ensureStarted();
    expect(h.manager.restarts).toBe(1);
    // Run stably past stableResetMs, then crash: budget starts over at 1.
    h.t += 61000;
    h.spawned[1].child.emit('exit', 1, null);
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(status.restarts).toBe(1);
  });
});

describe('SidecarManager — stop and quit', () => {
  it('stop() SIGTERMs a cooperative child and lands in stopped, no restart', async () => {
    const h = makeHarness({ childOptions: { exitOnSigterm: true } });
    await h.manager.ensureStarted();
    const status = await h.manager.stop();
    expect(status.state).toBe(SIDECAR_STATES.STOPPED);
    expect(h.spawned[0].child.killed).toEqual(['SIGTERM']);
    expect(h.spawned.length).toBe(1); // deliberate stop never auto-restarts
    expect(h.manager.child).toBeNull();
  });

  it('stop() escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const h = makeHarness(); // FakeChild ignores SIGTERM by default
    await h.manager.ensureStarted();
    const status = await h.manager.stop();
    expect(status.state).toBe(SIDECAR_STATES.STOPPED);
    expect(h.spawned[0].child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stopping while starting aborts the startup', async () => {
    const h = makeHarness({ health: () => false });
    const startPromise = h.manager.ensureStarted();
    // Let the spawn happen, then stop mid-poll.
    await Promise.resolve();
    const stopStatus = await h.manager.stop();
    expect(stopStatus.state).toBe(SIDECAR_STATES.STOPPED);
    await startPromise; // must settle, not hang
    expect(h.manager.state).toBe(SIDECAR_STATES.STOPPED);
  });

  it('the process-exit hook SIGKILLs the child synchronously (orphan protection)', async () => {
    const h = makeHarness();
    await h.manager.ensureStarted();
    expect(h.exitHooks.length).toBe(1);
    h.exitHooks[0](); // what process.on('exit') would run
    expect(h.spawned[0].child.killed).toContain('SIGKILL');
    expect(h.manager.child).toBeNull();
  });

  it('ensure after stop starts a fresh sidecar', async () => {
    const h = makeHarness({ childOptions: { exitOnSigterm: true } });
    await h.manager.ensureStarted();
    await h.manager.stop();
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(h.spawned.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// /health body & the acceleration report (docs/serving-setup-design.md, ph. 1)
// ---------------------------------------------------------------------------

describe('SidecarManager — health body / acceleration report', () => {
  const HEALTH = {
    status: 'ok',
    gap_closer: true,
    acceleration: {
      colorize: { planned: 'coreml', active: 'building', reason: null },
      segment: { planned: 'cpu', active: 'cpu', reason: 'accelerator model not configured' },
    },
  };

  it('captures the parsed /health body in the status while ready', async () => {
    const h = makeHarness({ health: () => HEALTH });
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(status.health).toEqual(HEALTH);
  });

  it('a bare-boolean health probe leaves health null (older sidecars)', async () => {
    const h = makeHarness({ health: () => true });
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
    expect(status.health).toBeNull();
  });

  it('refreshHealth pushes a status update only when the body changes', async () => {
    const h = makeHarness({ health: () => HEALTH });
    await h.manager.ensureStarted();
    const pushes = h.statuses.length;

    await h.manager.refreshHealth(); // identical body — no push
    expect(h.statuses.length).toBe(pushes);

    // The CoreML compile finishing flips colorize building -> coreml.
    h.health = () => ({
      ...HEALTH,
      acceleration: {
        ...HEALTH.acceleration,
        colorize: { planned: 'coreml', active: 'coreml', reason: null },
      },
    });
    await h.manager.refreshHealth();
    expect(h.statuses.length).toBe(pushes + 1);
    expect(h.manager.getStatus().health.acceleration.colorize.active).toBe('coreml');
  });

  it('keeps re-polling on its own while the report says building, then stops', async () => {
    // The field bug this guards: the readiness /health snapshot is taken
    // while the AnT CoreML compile is still in flight (active: 'building'),
    // and the modal is push-driven — so without the manager's building-poll
    // loop, "Optimizing for this computer" stuck forever after the compile
    // finished.
    let calls = 0;
    const h = makeHarness({
      health: () => {
        calls += 1;
        if (calls < 4) return HEALTH; // readiness + first re-polls: compiling
        return {
          ...HEALTH,
          acceleration: {
            ...HEALTH.acceleration,
            colorize: { planned: 'coreml', active: 'coreml', reason: null },
          },
        };
      },
    });
    await h.manager.ensureStarted();
    // The loop is fire-and-forget over instantly-resolving injected delays;
    // one macrotask boundary lets its microtask chain run out.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The settled report was pushed without anyone calling sidecar:status.
    expect(h.manager.getStatus().health.acceleration.colorize.active).toBe('coreml');
    expect(h.statuses.some(
      (s) => s.health && s.health.acceleration.colorize.active === 'coreml',
    )).toBe(true);

    // And the polling stopped once nothing was building.
    const settled = calls;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(settled);
  });

  it('health is nulled once the sidecar stops (no stale report)', async () => {
    const h = makeHarness({ health: () => HEALTH, childOptions: { exitOnSigterm: true } });
    await h.manager.ensureStarted();
    await h.manager.stop();
    expect(h.manager.getStatus().health).toBeNull();
  });
});

describe('SidecarManager — optimization progress', () => {
  const BUILDING_HEALTH = {
    status: 'ok',
    acceleration: {
      colorize: { planned: 'coreml', active: 'building', reason: null },
      segment: { planned: 'cpu', active: 'cpu', reason: null },
    },
  };
  const SETTLED_HEALTH = {
    status: 'ok',
    acceleration: {
      colorize: { planned: 'coreml', active: 'coreml', reason: null },
      segment: { planned: 'cpu', active: 'cpu', reason: null },
    },
  };

  // buildingPollMaxMs: 0 disables the fire-and-forget building loop so each
  // test drives refreshHealth() by hand, deterministically.
  function makeOptimizeHarness(probe, extra = {}) {
    return makeHarness({
      health: () => BUILDING_HEALTH,
      managerOptions: { buildingPollMaxMs: 0, probeOptimizeFn: probe, ...extra },
    });
  }

  it('exposes {phase, done, total, percent} while building, gated on ready', async () => {
    const h = makeOptimizeHarness(async () => ({ done: 10, total: 42 }));
    await h.manager.ensureStarted();
    expect(h.manager.getStatus().optimizing).toBeNull(); // no probe ran yet
    await h.manager.refreshHealth();
    expect(h.manager.getStatus().optimizing).toEqual({
      phase: 'compiling', done: 10, total: 42, percent: 23, sinceMs: 0,
    });
  });

  it('pushes on progress advance even when the health body is unchanged', async () => {
    let done = 10;
    const h = makeOptimizeHarness(async () => ({ done, total: 42 }));
    await h.manager.ensureStarted();
    const pushes = h.statuses.length;

    await h.manager.refreshHealth(); // first probe → push
    expect(h.statuses.length).toBe(pushes + 1);

    await h.manager.refreshHealth(); // same done, same health → no push
    expect(h.statuses.length).toBe(pushes + 1);

    done = 20;
    await h.manager.refreshHealth(); // progress advanced → push
    expect(h.statuses.length).toBe(pushes + 2);
    expect(h.statuses[h.statuses.length - 1].optimizing.percent).toBe(47);
  });

  it('one final push clears optimizing when building ends', async () => {
    const h = makeOptimizeHarness(async () => ({ done: 40, total: 42 }));
    await h.manager.ensureStarted();
    await h.manager.refreshHealth();
    expect(h.manager.getStatus().optimizing).not.toBeNull();

    h.health = () => SETTLED_HEALTH;
    await h.manager.refreshHealth();
    expect(h.manager.getStatus().optimizing).toBeNull();
    expect(h.statuses[h.statuses.length - 1].optimizing).toBeNull();
  });

  it('a full partition set at the first observation reads as loading', async () => {
    const h = makeOptimizeHarness(async () => ({ done: 42, total: 42 }));
    await h.manager.ensureStarted();
    await h.manager.refreshHealth();
    const { optimizing } = h.manager.getStatus();
    expect(optimizing.phase).toBe('loading');
    expect(optimizing.percent).toBe(99);
  });

  it('a throwing probe neither crashes nor pushes, and keeps the last value', async () => {
    let shouldThrow = false;
    const h = makeOptimizeHarness(async () => {
      if (shouldThrow) throw new Error('readdir failed');
      return { done: 10, total: 42 };
    });
    await h.manager.ensureStarted();
    await h.manager.refreshHealth();
    const before = h.manager.getStatus().optimizing;
    const pushes = h.statuses.length;

    shouldThrow = true;
    await h.manager.refreshHealth();
    expect(h.manager.getStatus().optimizing).toEqual(before);
    expect(h.statuses.length).toBe(pushes);
  });

  it('stop() clears the progress state', async () => {
    const h = makeHarness({
      health: () => BUILDING_HEALTH,
      childOptions: { exitOnSigterm: true },
      managerOptions: {
        buildingPollMaxMs: 0,
        probeOptimizeFn: async () => ({ done: 10, total: 42 }),
      },
    });
    await h.manager.ensureStarted();
    await h.manager.refreshHealth();
    await h.manager.stop();
    expect(h.manager.getStatus().optimizing).toBeNull();
    expect(h.manager.optimizeProgress).toBeNull();
  });

  it('without a probe (the default), optimizing stays null even while building', async () => {
    const h = makeHarness({
      health: () => BUILDING_HEALTH,
      managerOptions: { buildingPollMaxMs: 0 },
    });
    await h.manager.ensureStarted();
    await h.manager.refreshHealth();
    expect(h.manager.getStatus().optimizing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Accelerator-model visibility (Serving Profile, Phase 2)
// ---------------------------------------------------------------------------

describe('SidecarManager — onChildOutput tap', () => {
  it('forwards stdout and stderr chunks with stream tags', async () => {
    const output = [];
    const h = makeHarness({
      managerOptions: {
        onChildOutput: (stream, chunk) => output.push([stream, String(chunk)]),
      },
    });
    await h.manager.ensureStarted();
    const { child } = h.spawned[0];
    child.stdout.emit('data', 'listening on 4300\n');
    child.stderr.emit('data', 'warn: no bucket model\n');
    expect(output).toEqual([
      ['stdout', 'listening on 4300\n'],
      ['stderr', 'warn: no bucket model\n'],
    ]);
  });

  it('a throwing tap breaks neither the log sink, the stderr tail, nor crash handling', async () => {
    const written = [];
    const h = makeHarness({
      managerOptions: {
        createLogSinkFn: () => ({ write: (c) => written.push(String(c)), end: () => {} }),
        onChildOutput: () => { throw new Error('broken tap'); },
      },
    });
    await h.manager.ensureStarted();
    const { child } = h.spawned[0];
    child.stderr.emit('data', 'fatal: boom\n');
    // The file sink and the stderr tail both still saw the chunk.
    expect(written).toContain('fatal: boom\n');
    // And the crash path still runs, tail included.
    child.emit('exit', 1, null);
    expect(h.manager.state).toBe(SIDECAR_STATES.STARTING);
    expect(h.manager.lastError).toContain('fatal: boom');
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY);
  });
});

describe('SidecarManager — missingAccel in the status', () => {
  it('lists absent darwin accelerator models without blocking readiness', async () => {
    const h = makeHarness({
      exists: (p) => !p.endsWith(MODEL_ANT_BUCKET) && !p.endsWith(MODEL_GAP_BUCKET),
    });
    const status = await h.manager.ensureStarted();
    expect(status.state).toBe(SIDECAR_STATES.READY); // accelerators never block
    expect(status.missingAccel.map((m) => m.file).sort()).toEqual([
      MODEL_ANT_BUCKET, MODEL_GAP_BUCKET,
    ]);
    expect(status.missing).toEqual([]);
  });

  it('is empty when every accelerator is present', async () => {
    const h = makeHarness();
    const status = await h.manager.ensureStarted();
    expect(status.missingAccel).toEqual([]);
  });
});
