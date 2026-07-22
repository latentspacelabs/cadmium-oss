import {
  manifestHash, stampUpdatingTo, decideLaunch, LEDGER_FILE,
  filesNeedingVerification, recordVerification,
} from '@/util/setup-ledger-core';
import { MODEL_FILES } from '@/util/model-manifest';

// Install identity (docs/serving-setup-design.md, Phase 3): any install that
// didn't arrive via the in-app updater is a new user — emulated at launch on
// macOS via the setup ledger, literal on Windows via NSIS uninstall.

const HASH = manifestHash(MODEL_FILES);
const BASE = {
  appVersion: '1.6.0',
  isPackaged: true,
  hasBackendPref: true,
  currentManifestHash: HASH,
};

describe('manifestHash', () => {
  it('is stable across ordering and changes when any sha changes', () => {
    expect(manifestHash([...MODEL_FILES].reverse())).toBe(HASH);
    const bumped = MODEL_FILES.map((m, i) => (i === 0 ? { ...m, sha256: 'x' } : m));
    expect(manifestHash(bumped)).not.toBe(HASH);
  });
});

describe('decideLaunch', () => {
  it('dev builds never touch anything', () => {
    const d = decideLaunch({ ...BASE, isPackaged: false, ledger: null });
    expect(d.action).toBe('dev-noop');
    expect(d.writeLedger).toBeNull();
    expect(d.resetFirstRun).toBe(false);
  });

  it('fresh machine (no ledger, no backend pref) starts first-run without a reset', () => {
    const d = decideLaunch({ ...BASE, hasBackendPref: false, ledger: null });
    expect(d.action).toBe('fresh');
    expect(d.writeLedger).toEqual({
      appVersion: '1.6.0', installedVia: 'first-run', manifestHash: HASH,
    });
    expect(d.resetFirstRun).toBe(false);
  });

  it('pre-ledger install (backend pref exists) is adopted, never nuked', () => {
    const d = decideLaunch({ ...BASE, ledger: null });
    expect(d.action).toBe('adopt');
    expect(d.writeLedger.installedVia).toBe('adopted');
    expect(d.resetFirstRun).toBe(false);
  });

  it('a matching updatingTo stamp completes an in-app update seamlessly', () => {
    const ledger = { appVersion: '1.5.4', installedVia: 'updater', manifestHash: HASH, updatingTo: '1.6.0' };
    const d = decideLaunch({ ...BASE, ledger });
    expect(d.action).toBe('complete-update');
    expect(d.writeLedger).toEqual({
      appVersion: '1.6.0', installedVia: 'updater', manifestHash: HASH,
    });
    expect(d.resetFirstRun).toBe(false);
    expect(d.manifestChanged).toBe(false);
  });

  it('an in-app update whose manifest changed flags manifestChanged (the toast)', () => {
    const ledger = { appVersion: '1.5.4', installedVia: 'updater', manifestHash: 'old', updatingTo: '1.6.0' };
    const d = decideLaunch({ ...BASE, ledger });
    expect(d.action).toBe('complete-update');
    expect(d.manifestChanged).toBe(true);
  });

  it('same-version relaunch is a noop', () => {
    const ledger = { appVersion: '1.6.0', installedVia: 'updater', manifestHash: HASH };
    const d = decideLaunch({ ...BASE, ledger });
    expect(d.action).toBe('noop');
    expect(d.writeLedger).toBeNull();
  });

  it('version change with NO stamp = out-of-band install → first-run reset', () => {
    const ledger = { appVersion: '1.5.3', installedVia: 'updater', manifestHash: HASH };
    const d = decideLaunch({ ...BASE, ledger });
    expect(d.action).toBe('out-of-band');
    expect(d.resetFirstRun).toBe(true);
    expect(d.writeLedger.installedVia).toBe('out-of-band');
  });

  it('a downgrade (older binary over newer ledger) is also out-of-band', () => {
    const ledger = { appVersion: '1.7.0', installedVia: 'updater', manifestHash: HASH };
    const d = decideLaunch({ ...BASE, ledger });
    expect(d.action).toBe('out-of-band');
    expect(d.resetFirstRun).toBe(true);
  });

  it('a stale stamp for a DIFFERENT version does not rescue an out-of-band install', () => {
    const ledger = { appVersion: '1.5.3', installedVia: 'updater', manifestHash: HASH, updatingTo: '1.5.4' };
    const d = decideLaunch({ ...BASE, ledger }); // running 1.6.0
    expect(d.action).toBe('out-of-band');
    expect(d.resetFirstRun).toBe(true);
  });
});

describe('stampUpdatingTo', () => {
  it('adds the intent without losing the rest of the ledger', () => {
    const ledger = { appVersion: '1.5.4', installedVia: 'updater', manifestHash: HASH };
    expect(stampUpdatingTo(ledger, '1.6.0')).toEqual({ ...ledger, updatingTo: '1.6.0' });
  });
  it('tolerates a missing ledger', () => {
    expect(stampUpdatingTo(null, '1.6.0')).toEqual({ updatingTo: '1.6.0' });
  });
});

it('LEDGER_FILE is the userData basename', () => {
  expect(LEDGER_FILE).toBe('setup-ledger.json');
});

// ---------------------------------------------------------------------------
// sha-verify-on-reuse memoization (Phase 5)
// ---------------------------------------------------------------------------

describe('filesNeedingVerification', () => {
  const PROFILE = [
    { file: 'a.onnx', bytes: 100, sha256: 'sha-a' },
    { file: 'b.onnx', bytes: 50, sha256: 'sha-b' },
  ];
  const disk = (file, over = {}) => ({
    file, size: 100, mtimeMs: 111, isSymlink: false, ...over,
  });

  it('hashes profile files with no memo, carrying the expected sha', () => {
    const todo = filesNeedingVerification({
      diskFiles: [disk('a.onnx')], profileModels: PROFILE, verified: {},
    });
    expect(todo).toEqual([disk('a.onnx', { sha256: 'sha-a' })]);
  });

  it('skips files whose memo matches (size + mtime), re-hashes when either moved', () => {
    const verified = { 'a.onnx': { size: 100, mtimeMs: 111 } };
    expect(filesNeedingVerification({
      diskFiles: [disk('a.onnx')], profileModels: PROFILE, verified,
    })).toEqual([]);
    expect(filesNeedingVerification({
      diskFiles: [disk('a.onnx', { mtimeMs: 222 })], profileModels: PROFILE, verified,
    })).toHaveLength(1);
  });

  it('ignores unknown names, symlinks, and wrong-size files', () => {
    const todo = filesNeedingVerification({
      diskFiles: [
        disk('junk.bin'),                       // not in the profile
        disk('a.onnx', { isSymlink: true }),    // dev override — trusted
        disk('b.onnx', { size: 49 }),           // wrong size — downloader's job
      ],
      profileModels: PROFILE,
      verified: {},
    });
    expect(todo).toEqual([]);
  });
});

describe('recordVerification', () => {
  it('memoizes (size, mtime) per file without clobbering others', () => {
    const memo = recordVerification({ 'a.onnx': { size: 1, mtimeMs: 2 } }, 'b.onnx', { size: 50, mtimeMs: 333 });
    expect(memo).toEqual({
      'a.onnx': { size: 1, mtimeMs: 2 },
      'b.onnx': { size: 50, mtimeMs: 333 },
    });
    expect(recordVerification(null, 'a.onnx', { size: 1, mtimeMs: 2 }))
      .toEqual({ 'a.onnx': { size: 1, mtimeMs: 2 } });
  });
});
