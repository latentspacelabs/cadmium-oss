/* eslint-disable */
/**
 * Setup-ledger policy — pure decisions for install identity
 * (docs/serving-setup-design.md, Phase 3). The effectful shell (fs reads/
 * writes, pref resets, the notification) lives in background.js.
 *
 * The rule: any install that didn't arrive via the in-app updater is a new
 * user. macOS has no uninstall hook (trashing a .app runs no code), so this
 * is emulated at launch: a `setup-ledger.json` in userData records every
 * legitimate version transition, and a version change WITHOUT a matching
 * `updatingTo` stamp means the binary arrived out-of-band (manual download,
 * downgrade, reinstall-after-delete) → reset the first-run decisions and
 * start over. Windows gets the literal behavior via NSIS
 * `deleteAppDataOnUninstall`.
 *
 * Model files are deliberately NOT reset here — they are a content-addressed
 * cache (name + bytes + sha), re-validated against the manifest on reuse.
 */

/** Basename of the ledger file in userData. */
export const LEDGER_FILE = 'setup-ledger.json';

/**
 * Order-independent fingerprint of the model manifest; a change means this
 * app version wants different model bytes than the recorded install did.
 */
export function manifestHash(modelFiles) {
  return modelFiles
    .map((m) => `${m.file}:${m.sha256}`)
    .sort()
    .join('|');
}

/** Stamp update intent onto a ledger (written just before quitAndInstall). */
export function stampUpdatingTo(ledger, version) {
  return { ...(ledger || {}), updatingTo: version };
}

/**
 * sha-verify-on-reuse, memoized (Phase 5): which on-disk profile models still
 * need a full sha256 pass. A file is skipped when a previous verification is
 * memoized in the ledger for the same (size, mtime); wrong-size files are the
 * download plan's job; symlinks are dev overrides and trusted as-is.
 * `diskFiles`: [{ file, size, mtimeMs, isSymlink }].
 */
export function filesNeedingVerification({ diskFiles, profileModels, verified }) {
  const memo = verified || {};
  const byName = new Map(profileModels.map((m) => [m.file, m]));
  return (diskFiles || [])
    .filter((f) => byName.has(f.file))
    .filter((f) => !f.isSymlink)
    .filter((f) => f.size === byName.get(f.file).bytes)
    .filter((f) => {
      const v = memo[f.file];
      return !(v && v.size === f.size && v.mtimeMs === f.mtimeMs);
    })
    .map((f) => ({ ...f, sha256: byName.get(f.file).sha256 }));
}

/** Memoize a passed verification for (file, size, mtime). */
export function recordVerification(verified, file, { size, mtimeMs }) {
  return { ...(verified || {}), [file]: { size, mtimeMs } };
}

/**
 * Decide what this launch is. Inputs are plain values; the result tells the
 * shell what to do:
 *   action         — 'dev-noop' | 'fresh' | 'adopt' | 'noop' |
 *                    'complete-update' | 'out-of-band'
 *   writeLedger    — ledger object to persist, or null to leave it alone
 *   resetFirstRun  — clear the backend pref + welcome flag and rerun first-run
 *   manifestChanged— an in-place update wants new/changed model files; the
 *                    shell surfaces a notification (never silent, never a
 *                    surprise download)
 */
export function decideLaunch({
  ledger, appVersion, isPackaged, hasBackendPref, currentManifestHash,
}) {
  const write = (installedVia) => ({
    appVersion,
    installedVia,
    manifestHash: currentManifestHash,
  });
  const result = (action, writeLedger, resetFirstRun = false, manifestChanged = false) => ({
    action, writeLedger, resetFirstRun, manifestChanged,
  });

  // Dev builds churn versions constantly and must never nuke local state.
  if (!isPackaged) return result('dev-noop', null);

  if (!ledger || typeof ledger !== 'object' || !ledger.appVersion) {
    // No ledger. A pre-ledger install (there's already a saved backend
    // choice) is adopted silently — resetting here would nuke every existing
    // user on their first ledger-aware update. A truly fresh machine starts
    // first-run (which the absent backend pref triggers by itself).
    if (hasBackendPref) return result('adopt', write('adopted'));
    return result('fresh', write('first-run'));
  }

  const manifestChanged = !!ledger.manifestHash
    && ledger.manifestHash !== currentManifestHash;

  if (ledger.updatingTo === appVersion) {
    // The relaunch half of an in-app update — seamless.
    return result('complete-update', write('updater'), false, manifestChanged);
  }
  if (ledger.appVersion === appVersion) {
    // Ordinary relaunch. (A same-version manifest change can't happen in a
    // packaged build — manifest edits ship with a version bump — but keep
    // the hash current anyway.)
    return result(
      'noop',
      manifestChanged ? { ...ledger, manifestHash: currentManifestHash } : null,
      false,
      manifestChanged,
    );
  }
  // Version changed with no updater stamp: the binary arrived out-of-band.
  return result('out-of-band', write('out-of-band'), true);
}
