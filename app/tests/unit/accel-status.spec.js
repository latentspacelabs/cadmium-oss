import { summarizeAcceleration } from '@/util/accel-status';

// The nav-bar acceleration chip's pure brain (Phase 4): one glanceable level
// from backend kind + sidecar status (health/acceleration, missingAccel) +
// download progress.

const FULL_HEALTH = {
  acceleration: {
    colorize: { planned: 'coreml', active: 'coreml', reason: null },
    segment: { planned: 'coreml', active: 'coreml', reason: null },
  },
};

function status(overrides = {}) {
  return {
    state: 'ready', missingAccel: [], health: FULL_HEALTH, ...overrides,
  };
}

describe('summarizeAcceleration', () => {
  it('hidden for hosted backends and for embedded with no signal', () => {
    expect(summarizeAcceleration({ backendKind: 'hosted' }).level).toBe('hidden');
    expect(summarizeAcceleration({ backendKind: 'embedded' }).level).toBe('hidden');
    expect(summarizeAcceleration({}).level).toBe('hidden');
  });

  it('downloading wins over everything, with plan-wide percent', () => {
    const r = summarizeAcceleration({
      backendKind: 'embedded',
      sidecarStatus: status({ state: 'failed' }),
      downloadProgress: { state: 'downloading', receivedBytes: 500, totalBytes: 2000 },
    });
    expect(r).toEqual({ level: 'downloading', percent: 25 });
  });

  it('failed sidecar reports failed with the last error', () => {
    const r = summarizeAcceleration({
      backendKind: 'embedded',
      sidecarStatus: status({ state: 'failed', lastError: 'spawn ENOENT' }),
    });
    expect(r).toEqual({ level: 'failed', reason: 'spawn ENOENT' });
  });

  it('building while any capability compiles', () => {
    const h = {
      acceleration: {
        colorize: { planned: 'coreml', active: 'building', reason: null },
        segment: { planned: 'coreml', active: 'coreml', reason: null },
      },
    };
    const r = summarizeAcceleration({
      backendKind: 'embedded', sidecarStatus: status({ health: h }),
    });
    expect(r.level).toBe('building');
  });

  it('reduced when a capability is CPU with a reason', () => {
    const h = {
      acceleration: {
        colorize: { planned: 'coreml', active: 'coreml', reason: null },
        segment: { planned: 'cpu', active: 'cpu', reason: 'accelerator model not configured' },
      },
    };
    const r = summarizeAcceleration({
      backendKind: 'embedded', sidecarStatus: status({ health: h }),
    });
    expect(r.level).toBe('reduced');
    expect(r.reason).toBe('accelerator model not configured');
  });

  it('reduced when accelerator files are missing, even without health', () => {
    const r = summarizeAcceleration({
      backendKind: 'embedded',
      sidecarStatus: {
        state: 'stopped',
        missingAccel: [{ file: 'gap_closer_fp32_bucket.onnx' }],
      },
    });
    expect(r.level).toBe('reduced');
    expect(r.missingFiles).toEqual(['gap_closer_fp32_bucket.onnx']);
  });

  it('CPU-by-design (no reason) is full speed, not reduced', () => {
    const h = {
      acceleration: {
        colorize: { planned: 'coreml', active: 'coreml', reason: null },
        segment: { planned: 'cpu', active: 'cpu', reason: null },
      },
    };
    const r = summarizeAcceleration({
      backendKind: 'embedded', sidecarStatus: status({ health: h }),
    });
    expect(r.level).toBe('full');
  });

  it('everything accelerated → full', () => {
    const r = summarizeAcceleration({
      backendKind: 'embedded', sidecarStatus: status(),
    });
    expect(r.level).toBe('full');
  });
});
