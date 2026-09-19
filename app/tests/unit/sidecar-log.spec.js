/* eslint-disable */
// The renderer-side debug-log cache: live-batch ingest with seq dedup, the
// one-shot history merge (racing live pushes), the ring cap, and listener
// fan-out. The platform seam is mocked; module state is reset per test.

jest.mock('@/platform', () => ({
  getSidecarLogHistory: jest.fn(),
}));

const entry = (seq, line = `line ${seq}`) => ({
  seq, ts: 1000 + seq, source: 'sidecar', line,
});

describe('util/sidecar-log', () => {
  let mod;
  let platform;

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line global-require
    platform = require('@/platform');
    platform.getSidecarLogHistory.mockReset();
    // eslint-disable-next-line global-require
    mod = require('@/util/sidecar-log');
  });

  it('ingests live batches in order and dedups by seq', () => {
    mod.ingestSidecarLogEntries([entry(0), entry(1)]);
    mod.ingestSidecarLogEntries([entry(1), entry(2)]); // overlap re-delivery
    expect(mod.getSidecarLogEntries().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('merges history under live batches that arrived first', async () => {
    // Live push lands before the history invoke resolves.
    mod.ingestSidecarLogEntries([entry(3), entry(4)]);
    platform.getSidecarLogHistory.mockResolvedValue([entry(0), entry(1), entry(2), entry(3)]);
    await mod.ensureSidecarLogHistory();
    expect(mod.getSidecarLogEntries().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // Memoized: a second call does not re-invoke.
    await mod.ensureSidecarLogHistory();
    expect(platform.getSidecarLogHistory).toHaveBeenCalledTimes(1);
  });

  it('a failed history fetch un-memoizes so a later open can retry', async () => {
    platform.getSidecarLogHistory.mockRejectedValueOnce(new Error('ipc down'));
    await mod.ensureSidecarLogHistory();
    platform.getSidecarLogHistory.mockResolvedValue([entry(0)]);
    await mod.ensureSidecarLogHistory();
    expect(platform.getSidecarLogHistory).toHaveBeenCalledTimes(2);
    expect(mod.getSidecarLogEntries().map((e) => e.seq)).toEqual([0]);
  });

  it('caps the cache at 2000 entries', () => {
    const big = [];
    for (let i = 0; i < 2100; i += 1) big.push(entry(i));
    mod.ingestSidecarLogEntries(big);
    const entries = mod.getSidecarLogEntries();
    expect(entries.length).toBe(2000);
    expect(entries[0].seq).toBe(100);
    expect(entries[entries.length - 1].seq).toBe(2099);
  });

  it('notifies listeners on ingest, supports unsubscribe, tolerates throwers', () => {
    let calls = 0;
    const unsubscribe = mod.onSidecarLog(() => { calls += 1; });
    mod.onSidecarLog(() => { throw new Error('broken listener'); });
    mod.ingestSidecarLogEntries([entry(0)]);
    expect(calls).toBe(1);
    mod.ingestSidecarLogEntries([entry(0)]); // pure duplicate: no notify
    expect(calls).toBe(1);
    unsubscribe();
    mod.ingestSidecarLogEntries([entry(1)]);
    expect(calls).toBe(1);
  });

  it('ignores malformed batches', () => {
    mod.ingestSidecarLogEntries(null);
    mod.ingestSidecarLogEntries('nope');
    mod.ingestSidecarLogEntries([null, { line: 'no seq' }]);
    expect(mod.getSidecarLogEntries()).toEqual([]);
  });
});
