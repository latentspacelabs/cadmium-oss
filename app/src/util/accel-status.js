/* eslint-disable */
/**
 * Pure derivation of the main-window acceleration chip
 * (docs/serving-setup-design.md, Phase 4): one glanceable answer to "is the
 * embedded backend at full speed, and if not, why?". No Electron, no i18n —
 * returns semantic levels the component turns into copy.
 *
 * Levels (first match wins):
 *   hidden      — nothing to say: hosted backend, or embedded with no signal
 *   downloading — a model download is running (percent included)
 *   failed      — the sidecar is in the failed state (worse than degraded)
 *   building    — a CoreML session is compiling (one-time; CPU serves meanwhile)
 *   reduced     — degraded to CPU for an actionable reason (accelerator model
 *                 missing, EP build failure)
 *   full        — every capability is at its planned speed
 */

/** True when this capability runs on CPU as a degradation, not by design. */
function capDegraded(cap) {
  return !!cap && cap.active === 'cpu' && !!cap.reason;
}

export function summarizeAcceleration({ backendKind, sidecarStatus, downloadProgress } = {}) {
  if (backendKind !== 'embedded') return { level: 'hidden' };

  const dlState = downloadProgress && downloadProgress.state;
  if (dlState === 'downloading' || dlState === 'verifying') {
    const total = downloadProgress.totalBytes || 0;
    const percent = total
      ? Math.min(100, Math.floor((downloadProgress.receivedBytes / total) * 100))
      : 0;
    return { level: 'downloading', percent };
  }

  const s = sidecarStatus || {};
  if (s.state === 'failed') {
    return { level: 'failed', reason: s.lastError || '' };
  }

  const missingAccel = s.missingAccel || [];
  const accel = (s.health && s.health.acceleration) || null;

  if (accel) {
    const caps = [accel.colorize, accel.segment].filter(Boolean);
    if (caps.some((c) => c.active === 'building')) return { level: 'building' };
    const degraded = caps.find(capDegraded);
    if (degraded || missingAccel.length) {
      return {
        level: 'reduced',
        reason: (degraded && degraded.reason) || '',
        missingFiles: missingAccel.map((m) => m.file),
      };
    }
    return { level: 'full' };
  }

  // No health report (sidecar not running, or an old build). Missing
  // accelerator files are still a definitive, actionable degradation; beyond
  // that there is nothing trustworthy to claim.
  if (missingAccel.length) {
    return { level: 'reduced', reason: '', missingFiles: missingAccel.map((m) => m.file) };
  }
  return { level: 'hidden' };
}
