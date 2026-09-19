/* eslint-disable */
/**
 * Pure logic for the CoreML optimization-progress signal — no Electron, no
 * fs; the probe that reads the cache directory lives in background.js and
 * the polling lives in sidecar-manager.js.
 *
 * Mechanism: while a bucket model compiles, ORT's CoreML EP fills
 * <userData>/sidecar/coreml-cache/<coremlCacheKey>/ with one
 * `N_dynamic_mlprogram` directory per compiled partition (the AnT bucket has
 * 42 — see coremlPartitions in util/model-manifest.js), alongside a
 * `model.txt` the counter must ignore. Counting them gives an honest
 * percentage; a full set at the FIRST 'building' observation means the
 * sidecar is merely reloading the compiled model (~20 s), not compiling
 * (~107 s) — a distinction the /health report itself cannot make.
 */

// Exactly ORT's `<N>_dynamic_mlprogram` partition dirs — a looser suffix
// match would count stray entries (backups, future ORT auxiliaries) and
// could mislabel a real compile as a cache reload.
const PARTITION_DIR_RE = /^\d+_dynamic_mlprogram$/;

// A genuine cache reload settles in ~20-25s. A 'loading' label older than
// this is almost certainly a mislatched real compile (e.g. all partition
// dirs existed on disk while ORT was still assembling the session when the
// episode began) — re-resolve it so the UI stops promising a fast start.
export const LOADING_PHASE_MAX_MS = 45000;

/** Compiled-partition count from a readdir listing of the key subdir. */
export function countCompiledPartitions(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.filter((name) => PARTITION_DIR_RE.test(name)).length;
}

/**
 * Percent is clamped to 0–99: completion is signaled by the acceleration
 * report flipping off 'building', never by the bar itself (the count can
 * overstate — a partition dir exists before ORT finishes writing it, and an
 * ORT upgrade can change the partitioning entirely).
 */
export function computeOptimizeProgress({ done, total }) {
  const safeDone = Number.isFinite(done) && done > 0 ? done : 0;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const percent = safeTotal > 0
    ? Math.min(99, Math.floor((safeDone / safeTotal) * 100))
    : 0;
  return { done: safeDone, total: safeTotal, percent };
}

/**
 * 'loading' vs 'compiling', latched for the building episode: the FIRST
 * observation decides (a compile reaching done===total must not flip the
 * label to 'loading' at the finish line). One escape hatch: a 'loading'
 * episode older than LOADING_PHASE_MAX_MS re-resolves to 'compiling' — a
 * real reload never takes that long, so the first observation must have
 * been fooled by a complete-looking partition set mid-compile.
 */
export function resolveOptimizePhase(prevPhase, { done, total }, sinceMs = 0) {
  if (prevPhase === 'loading' && sinceMs > LOADING_PHASE_MAX_MS) return 'compiling';
  if (prevPhase) return prevPhase;
  return total > 0 && done >= total ? 'loading' : 'compiling';
}

/** True while a /health body reports a CoreML compile still in flight. */
export function healthReportsBuilding(health) {
  const accel = health && health.acceleration;
  if (!accel) return false;
  return Object.values(accel).some((cap) => cap && cap.active === 'building');
}

/** Same, from a full sidecar status snapshot (health is null unless ready). */
export function statusReportsBuilding(status) {
  return !!(status && status.state === 'ready' && healthReportsBuilding(status.health));
}

/** Is one specific capability ('colorize' | 'segment') building? */
export function healthCapabilityBuilding(health, capName) {
  const accel = health && health.acceleration;
  const cap = accel && accel[capName];
  return !!(cap && cap.active === 'building');
}

/**
 * The optimizing signal when (and only when) a real compile is running —
 * the shared selector for UI that shows a percent (nav chip, overlay note),
 * so the 'compiling' phase string has one tested interpreter.
 */
export function compilingProgress(status) {
  const o = status && status.optimizing;
  return o && o.phase === 'compiling' ? o : null;
}
