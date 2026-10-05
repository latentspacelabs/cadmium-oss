import { describeExit, isUnsupportedCpuExit, formatHostInfo } from '@/util/sidecar-core';

describe('describeExit', () => {
  it('leaves non-Windows exits untouched', () => {
    expect(describeExit({ code: 1, signal: null }, 'darwin')).toBe('code 1, signal null');
    expect(describeExit({ code: null, signal: 'SIGKILL' }, 'linux')).toBe('code null, signal SIGKILL');
  });

  it('decodes the illegal-instruction status (as reported in the field)', () => {
    expect(describeExit({ code: 3221225501, signal: null }, 'win32'))
      .toMatch(/^code 3221225501, signal null = 0xC000001D STATUS_ILLEGAL_INSTRUCTION: .*AVX/);
  });

  it('accepts the signed form of the same status', () => {
    expect(describeExit({ code: -1073741795, signal: null }, 'win32')).toMatch(/0xC000001D/);
  });

  it('decodes missing-DLL crashes', () => {
    expect(describeExit({ code: 0xC0000135, signal: null }, 'win32')).toMatch(/STATUS_DLL_NOT_FOUND.*DirectML/);
  });

  it('flags unknown NTSTATUS crashes with their hex', () => {
    expect(describeExit({ code: 0xC0001234, signal: null }, 'win32')).toMatch(/0xC0001234 \(Windows crash status\)$/);
  });

  it('leaves ordinary Windows exit codes alone', () => {
    expect(describeExit({ code: 1, signal: null }, 'win32')).toBe('code 1, signal null');
  });
});

describe('isUnsupportedCpuExit', () => {
  it('is true only for illegal instruction on Windows', () => {
    expect(isUnsupportedCpuExit({ code: 3221225501 }, 'win32')).toBe(true);
    expect(isUnsupportedCpuExit({ code: 3221225501 }, 'darwin')).toBe(false);
    expect(isUnsupportedCpuExit({ code: 3221225477 }, 'win32')).toBe(false);
    expect(isUnsupportedCpuExit({ code: null }, 'win32')).toBe(false);
  });
});

describe('formatHostInfo', () => {
  it('summarizes os, cpu and memory on one line', () => {
    const line = formatHostInfo({
      platform: 'win32',
      release: '10.0.22631',
      arch: 'x64',
      cpus: Array(4).fill({ model: ' Intel(R) Celeron(R) N4020 CPU @ 1.10GHz ', speed: 1100 }),
      totalmem: 4 * 2 ** 30,
      freemem: 1.5 * 2 ** 30,
    });
    expect(line).toBe(
      'host: win32 10.0.22631 x64 | cpu: Intel(R) Celeron(R) N4020 CPU @ 1.10GHz (4 logical, 1100 MHz)'
      + ' | ram: 4.0 GiB total, 1.5 GiB free',
    );
  });

  it('tolerates missing cpu info', () => {
    expect(formatHostInfo({ platform: 'win32', release: 'x', arch: 'x64', cpus: [] }))
      .toMatch(/cpu: \? \(0 logical\).*ram: \? total, \? free/);
  });
});
