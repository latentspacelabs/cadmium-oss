import { colorizeShouldWait, waitForColorizer } from '@/services/colorizer-ready';
import { JobCanceledError } from '@/services/job-runner';

const status = (colorizeActive, state = 'ready') => ({
  state,
  health: { acceleration: { colorize: { planned: 'coreml', active: colorizeActive }, segment: { active: 'coreml' } } },
});
const EMBEDDED = { kind: 'embedded', baseUrl: '' };
const HOSTED = { kind: 'hosted', baseUrl: 'https://example.test' };

function makeSource(initial, backend = EMBEDDED) {
  let current = initial;
  const listeners = new Set();
  return {
    getStatus: () => current,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getBackend: () => backend,
    push(next) { current = next; listeners.forEach((fn) => fn(next)); },
    listenerCount: () => listeners.size,
  };
}

function makeCtx() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    throwIfAborted() { if (controller.signal.aborted) throw new JobCanceledError('colorize'); },
  };
}

describe('colorizeShouldWait', () => {
  it('waits only while the embedded colorizer reports building', () => {
    expect(colorizeShouldWait(status('building'), EMBEDDED)).toBe(true);
    expect(colorizeShouldWait(status('coreml'), EMBEDDED)).toBe(false);
    expect(colorizeShouldWait(status('cpu'), EMBEDDED)).toBe(false); // build failed -> CPU, don't wait
  });

  it('never waits on a hosted backend, a non-ready sidecar, or no status', () => {
    expect(colorizeShouldWait(status('building'), HOSTED)).toBe(false);
    expect(colorizeShouldWait(status('building', 'starting'), EMBEDDED)).toBe(false);
    expect(colorizeShouldWait(null, EMBEDDED)).toBe(false);
  });

  it('a building segment capability alone does not hold colorize', () => {
    const s = { state: 'ready', health: { acceleration: { colorize: { active: 'coreml' }, segment: { active: 'building' } } } };
    expect(colorizeShouldWait(s, EMBEDDED)).toBe(false);
  });
});

describe('waitForColorizer', () => {
  it('resolves immediately (false) when nothing is building', async () => {
    const src = makeSource(status('coreml'));
    await expect(waitForColorizer(src, makeCtx())).resolves.toBe(false);
    expect(src.listenerCount()).toBe(0);
  });

  it('resolves once the build finishes, and unsubscribes', async () => {
    const src = makeSource(status('building'));
    let done = false;
    const p = waitForColorizer(src, makeCtx()).then((v) => { done = true; return v; });
    src.push(status('building'));
    await Promise.resolve();
    expect(done).toBe(false);
    src.push(status('coreml'));
    await expect(p).resolves.toBe(true);
    expect(src.listenerCount()).toBe(0);
  });

  it('stops waiting when the build fails (CPU) or the sidecar stops', async () => {
    const a = makeSource(status('building'));
    const pa = waitForColorizer(a, makeCtx());
    a.push(status('cpu'));
    await expect(pa).resolves.toBe(true);

    const b = makeSource(status('building'));
    const pb = waitForColorizer(b, makeCtx());
    b.push({ state: 'failed', health: null });
    await expect(pb).resolves.toBe(true);
  });

  it('rejects with JobCanceledError when the run is canceled while waiting', async () => {
    const src = makeSource(status('building'));
    const ctx = makeCtx();
    const p = waitForColorizer(src, ctx);
    ctx.controller.abort();
    await expect(p).rejects.toBeInstanceOf(JobCanceledError);
    expect(src.listenerCount()).toBe(0);
  });

  it('does not hang when the build finishes between the check and the subscribe', async () => {
    const src = makeSource(status('building'));
    let calls = 0;
    const racy = {
      ...src,
      getStatus: () => {
        calls += 1;
        return calls === 1 ? status('building') : status('coreml');
      },
    };
    await expect(waitForColorizer(racy, makeCtx())).resolves.toBe(true);
  });

  it('gives up after maxWaitMs (a wedged compile never blocks colorize forever)', async () => {
    jest.useFakeTimers();
    try {
      const src = { ...makeSource(status('building')), maxWaitMs: 1000 };
      const p = waitForColorizer(src, makeCtx());
      jest.advanceTimersByTime(1000);
      await expect(p).resolves.toBe(true);
      expect(src.listenerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('first launch: a sidecar still starting is brought up first, then waited on', async () => {
    const src = makeSource(status('building', 'starting'));
    src.ensure = jest.fn(async () => {
      src.push(status('building'));
      return status('building');
    });
    let done = false;
    const p = waitForColorizer(src, makeCtx()).then((v) => { done = true; return v; });
    await Promise.resolve();
    await Promise.resolve();
    expect(src.ensure).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    src.push(status('coreml'));
    await expect(p).resolves.toBe(true);
  });

  it('a failed ensure never blocks the run', async () => {
    const src = makeSource(null);
    src.ensure = jest.fn(async () => { throw new Error('spawn failed'); });
    await expect(waitForColorizer(src, makeCtx())).resolves.toBe(false);
  });

  it('hosted backends never start or wait for the sidecar', async () => {
    const src = makeSource(null, HOSTED);
    src.ensure = jest.fn();
    await expect(waitForColorizer(src, makeCtx())).resolves.toBe(false);
    expect(src.ensure).not.toHaveBeenCalled();
  });
});
