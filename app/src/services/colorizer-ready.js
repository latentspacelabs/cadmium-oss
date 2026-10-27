/**
 * colorizer-ready — hold a colorize run until the embedded backend's
 * accelerated colorizer is built.
 *
 * On a Mac's first launch the CoreML colorizer compiles for ~2 minutes (~20 s
 * reload on later launches). The sidecar serves /colorize from the CPU
 * meanwhile, ~3x slower, while the compile competes for the same CPU and
 * memory — users judged the app's speed by that path ("barely responsive" on
 * an M4 Mac mini). So a colorize run waits for the build instead; the overlay
 * shows the compile percent (ImageImportWaitingScreen).
 *
 * Never waits forever: the wait ends as soon as the colorize capability stops
 * reporting 'building' — built, failed (the sidecar then serves from the CPU),
 * or the sidecar left 'ready' (the run proceeds and surfaces the real error) —
 * or after MAX_WAIT_MS: sidecar-manager stops polling /health after 10 min, so
 * a wedged compile would otherwise leave the last status at 'building' forever.
 * Analyze runs never wait (they don't use the colorizer). Hosted backends
 * never wait (the run is served remotely at full speed).
 *
 * The sidecar is spawned on demand, so on a first launch the run that starts
 * it would see 'starting' and sail through: `ensure` (sidecar:ensure) first
 * brings it to 'ready' — whose first /health already reports 'building' —
 * and the decision is made on that status.
 */

import { healthCapabilityBuilding } from '@/util/optimize-progress-core';
import { BACKEND_HOSTED } from '@/util/server-config';

// A real compile is ~2 min (slower Macs a few more); past this, run on the CPU.
export const MAX_WAIT_MS = 10 * 60 * 1000;

/** Should a colorize run wait right now? Pure — status + backend snapshot. */
export function colorizeShouldWait(status, backend) {
  if (backend && backend.kind === BACKEND_HOSTED) return false;
  return !!(status && status.state === 'ready'
    && healthCapabilityBuilding(status.health, 'colorize'));
}

/**
 * Resolve once `colorizeShouldWait` is false. Rejects (via `throwIfAborted`)
 * when the run is canceled while waiting.
 *
 * @param {Object} src
 * @param {() => Object} src.getStatus - latest sidecar status snapshot.
 * @param {(fn: Function) => Function} src.subscribe - status listener; returns unsubscribe.
 * @param {() => Object} src.getBackend - the active server backend.
 * @param {() => Promise<Object>} [src.ensure] - start the embedded sidecar if
 *   needed; resolves with its status (rejects/null: don't wait).
 * @param {number} [src.maxWaitMs] - give up waiting after this long (default MAX_WAIT_MS).
 * @param {Object} ctx - JobRunner context ({ signal, throwIfAborted }).
 * @returns {Promise<boolean>} true if it actually waited.
 */
export async function waitForColorizer({
  getStatus, subscribe, getBackend, ensure, maxWaitMs = MAX_WAIT_MS,
}, ctx) {
  const backend = getBackend();
  if (backend && backend.kind === BACKEND_HOSTED) return false;
  let status = getStatus();
  if (ensure && !(status && status.state === 'ready')) {
    try {
      status = (await ensure()) || status;
    } catch (e) {
      return false; // the run's own requests surface the real error
    }
    ctx.throwIfAborted();
  }
  if (!colorizeShouldWait(status, getBackend())) return false;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let onAbort = () => {};
    let timer = null;
    const finish = (settle) => {
      unsubscribe();
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      settle();
    };
    onAbort = () => finish(() => {
      try {
        ctx.throwIfAborted();
        resolve(true);
      } catch (e) {
        reject(e);
      }
    });
    unsubscribe = subscribe((next) => {
      if (!colorizeShouldWait(next, getBackend())) finish(() => resolve(true));
    });
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => finish(() => resolve(true)), maxWaitMs);
    // The build may have finished between the first check and subscribing.
    if (!colorizeShouldWait(getStatus(), getBackend())) finish(() => resolve(true));
  });
}
