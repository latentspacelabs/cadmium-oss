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
 * @param {number} [src.maxWaitMs] - give up waiting after this long (default MAX_WAIT_MS).
 * @param {Object} ctx - JobRunner context ({ signal, throwIfAborted }).
 * @returns {Promise<boolean>} true if it actually waited.
 */
export function waitForColorizer({
  getStatus, subscribe, getBackend, maxWaitMs = MAX_WAIT_MS,
}, ctx) {
  if (!colorizeShouldWait(getStatus(), getBackend())) return Promise.resolve(false);
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
    unsubscribe = subscribe((status) => {
      if (!colorizeShouldWait(status, getBackend())) finish(() => resolve(true));
    });
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => finish(() => resolve(true)), maxWaitMs);
    // The build may have finished between the first check and subscribing.
    if (!colorizeShouldWait(getStatus(), getBackend())) finish(() => resolve(true));
  });
}
