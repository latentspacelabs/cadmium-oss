/* eslint-disable */
/**
 * Models-dir hygiene — pure decisions (docs/serving-setup-design.md, Phase 5):
 * the models dir is a managed cache, not an interface. Unknown or wrong-size
 * files get quarantined to `models/.orphaned/` (recoverable, and the download
 * plan re-fetches anything the profile wants); symlinks on profile names are
 * dev overrides — honored, never touched. The effectful shell (readdir/stat/
 * rename) lives in background.js.
 */

/** Directory name orphans are moved into (inside the models dir). */
export const ORPHAN_DIR = '.orphaned';

/**
 * Which entries to quarantine. `entries`: [{ name, size, isDirectory,
 * isSymlink }] from a models-dir listing; `profileModels`: the Serving
 * Profile's model list for this platform.
 */
export function planQuarantine({ entries, profileModels }) {
  const wanted = new Map(profileModels.map((m) => [m.file, m.bytes]));
  return (entries || [])
    .filter((e) => !e.isDirectory) // .orphaned/ itself, or any stray dir
    .filter((e) => !e.name.startsWith('.')) // .DS_Store and friends: harmless
    .filter((e) => {
      if (!wanted.has(e.name)) return true; // unknown junk (incl. stale .part)
      if (e.isSymlink) return false; // dev override on a profile name — honored
      return e.size !== wanted.get(e.name); // truncated/stale artifact
    })
    .map((e) => e.name);
}
