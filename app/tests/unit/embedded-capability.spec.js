import {
  evaluateEmbeddedCapability,
  isEmbeddedTargetSupported,
  classifyGpu,
  DISK_HEADROOM_BYTES,
  COREML_CACHE_BYTES,
  RAM_RECOMMENDED_BYTES,
} from '@/util/embedded-capability';

const GB = 1e9;
// A machine that passes every check, as a base to override per test.
const OK_MAC = {
  platform: 'darwin',
  arch: 'arm64',
  totalMem: 16 * GB,
  freeDiskBytes: 50 * GB,
  gpu: { auxAttributes: { glRenderer: 'Apple M2' } },
};
const NEEDED = 2 * GB; // a typical model download still to fetch

describe('isEmbeddedTargetSupported', () => {
  it('accepts arm64 mac and x64 win, rejects everything else', () => {
    expect(isEmbeddedTargetSupported('darwin', 'arm64')).toBe(true);
    expect(isEmbeddedTargetSupported('win32', 'x64')).toBe(true);
    expect(isEmbeddedTargetSupported('darwin', 'x64')).toBe(false); // Intel mac
    expect(isEmbeddedTargetSupported('win32', 'arm64')).toBe(false);
    expect(isEmbeddedTargetSupported('linux', 'x64')).toBe(false);
  });
});

describe('classifyGpu', () => {
  it('flags software rasterizers as not accelerated', () => {
    expect(classifyGpu({ auxAttributes: { glRenderer: 'Google SwiftShader' } }).accelerated).toBe(false);
    expect(classifyGpu({ renderer: 'llvmpipe (LLVM 12)' }).accelerated).toBe(false);
  });
  it('treats a real GPU as accelerated', () => {
    expect(classifyGpu({ auxAttributes: { glRenderer: 'Apple M2' } }).accelerated).toBe(true);
    expect(classifyGpu({ renderer: 'NVIDIA GeForce RTX 4090' }).accelerated).toBe(true);
  });
  it('returns null (unknown) when there is no renderer string', () => {
    expect(classifyGpu(null).accelerated).toBe(null);
    expect(classifyGpu({}).accelerated).toBe(null);
  });
});

describe('evaluateEmbeddedCapability — system gate', () => {
  it('a supported machine is supported and recommends embedded', () => {
    const v = evaluateEmbeddedCapability(OK_MAC, { neededBytes: NEEDED });
    expect(v.supported).toBe(true);
    expect(v.recommendation).toBe('embedded');
    expect(v.blockers).toEqual([]);
    expect(v.checks.system.status).toBe('ok');
  });

  it('an Intel mac is blocked on system and steered to hosted', () => {
    const v = evaluateEmbeddedCapability({ ...OK_MAC, arch: 'x64' }, { neededBytes: NEEDED });
    expect(v.supported).toBe(false);
    expect(v.recommendation).toBe('hosted');
    expect(v.blockers).toContain('system');
    expect(v.checks.system.status).toBe('blocked');
  });

  it('Linux is blocked on system', () => {
    const v = evaluateEmbeddedCapability({ ...OK_MAC, platform: 'linux', arch: 'x64' });
    expect(v.checks.system.status).toBe('blocked');
    expect(v.supported).toBe(false);
  });
});

describe('evaluateEmbeddedCapability — disk', () => {
  it('blocks when free space is below what the download needs', () => {
    const v = evaluateEmbeddedCapability(
      { ...OK_MAC, freeDiskBytes: 1 * GB }, { neededBytes: NEEDED },
    );
    expect(v.checks.disk.status).toBe('blocked');
    expect(v.blockers).toContain('disk');
    expect(v.supported).toBe(false);
  });

  it('warns when free space clears the needs (download + mac CoreML cache) but not the headroom', () => {
    const free = NEEDED + COREML_CACHE_BYTES + DISK_HEADROOM_BYTES - 1;
    const caps = { ...OK_MAC, freeDiskBytes: free };
    const v = evaluateEmbeddedCapability(caps, { neededBytes: NEEDED });
    expect(v.checks.disk.status).toBe('warn');
    expect(v.warnings).toContain('disk');
    expect(v.supported).toBe(true); // a warning never blocks
  });

  it('macOS still needs the CoreML cache allowance when the models are already present', () => {
    // neededBytes 0 (models downloaded) but the compiled-model cache is real
    // disk the sidecar will consume — a near-full volume is a blocker.
    const v = evaluateEmbeddedCapability({ ...OK_MAC, freeDiskBytes: 2 * GB }, { neededBytes: 0 });
    expect(v.checks.disk.status).toBe('blocked');
    const ok = evaluateEmbeddedCapability(
      { ...OK_MAC, freeDiskBytes: COREML_CACHE_BYTES + DISK_HEADROOM_BYTES },
      { neededBytes: 0 },
    );
    expect(ok.checks.disk.status).toBe('ok');
    expect(ok.supported).toBe(true);
  });

  it('win32 carries no CoreML cache allowance', () => {
    const win = {
      ...OK_MAC, platform: 'win32', arch: 'x64', freeDiskBytes: 2 * GB,
    };
    const v = evaluateEmbeddedCapability(win, { neededBytes: 0 });
    expect(v.checks.disk.status).toBe('ok');
  });

  it('reports unknown (and does not block) when free space could not be probed', () => {
    const caps = { ...OK_MAC, freeDiskBytes: null };
    const v = evaluateEmbeddedCapability(caps, { neededBytes: NEEDED });
    expect(v.checks.disk.status).toBe('unknown');
    expect(v.supported).toBe(true);
  });
});

describe('evaluateEmbeddedCapability — memory (soft)', () => {
  it('warns below the recommended RAM but never blocks', () => {
    const v = evaluateEmbeddedCapability(
      { ...OK_MAC, totalMem: RAM_RECOMMENDED_BYTES - 1 }, { neededBytes: NEEDED },
    );
    expect(v.checks.ram.status).toBe('warn');
    expect(v.warnings).toContain('ram');
    expect(v.supported).toBe(true);
  });

  it('is ok at or above the recommended RAM', () => {
    const v = evaluateEmbeddedCapability(
      { ...OK_MAC, totalMem: RAM_RECOMMENDED_BYTES }, { neededBytes: NEEDED },
    );
    expect(v.checks.ram.status).toBe('ok');
  });
});

describe('evaluateEmbeddedCapability — graphics (informational)', () => {
  it('marks software rendering as info, still supported', () => {
    const v = evaluateEmbeddedCapability(
      { ...OK_MAC, gpu: { auxAttributes: { glRenderer: 'SwiftShader' } } }, { neededBytes: NEEDED },
    );
    expect(v.checks.gpu.status).toBe('info');
    expect(v.checks.gpu.accelerated).toBe(false);
    expect(v.supported).toBe(true); // GPU is never a blocker
  });
});

describe('evaluateEmbeddedCapability — null/empty input', () => {
  it('does not throw and reports system blocked when nothing is known', () => {
    const v = evaluateEmbeddedCapability(null);
    expect(v.supported).toBe(false); // no platform/arch → system blocked
    expect(v.checks.disk.status).toBe('unknown');
    expect(v.checks.ram.status).toBe('unknown');
  });
});
