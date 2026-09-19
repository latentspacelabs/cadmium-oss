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

const PARTITION_DIR_RE = /_mlprogram$/;

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
 * 'loading' vs 'compiling', latched for the building episode: only the FIRST
 * observation decides (a compile reaching done===total must not flip the
 * label to 'loading' at the finish line).
 */
export function resolveOptimizePhase(prevPhase, { done, total }) {
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
