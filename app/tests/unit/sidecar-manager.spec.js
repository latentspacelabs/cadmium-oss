import { EventEmitter } from 'events';

import {
  SIDECAR_STATES,
  MODEL_ANT,
  MODEL_GAP,
  MODEL_ANT_BUCKET,
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
      h.spawned.push({ bin, args, opts, child });
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
