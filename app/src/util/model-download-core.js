/* eslint-disable */
/**
 * Pure logic for the model download/bootstrap flow — no Electron, no fs, no
 * network, so every decision is unit-testable. The effectful shell is
 * src/model-downloader.js (main process only).
 *
 * Policy:
 *  - Required models download everywhere. An optional model with a `platform`
 *    field downloads only on that platform: the bucket-pinned AnT export on
 *    macOS (the CoreML fast path) and the tiled-scatter AnT export on Windows
 *    (the DirectML fast path). Each is dead weight on the other OS.
 *  - A file is "present" only at the manifest's exact byte size; any other
 *    size is a truncated/stale artifact and gets re-fetched. Full sha256
 *    verification happens in the downloader on the bytes it streams.
 */

import path from 'path';
import { resolveServingProfile } from './serving-profile';

/**
 * Manifest entries this platform wants, in download order — the Serving
 * Profile's model list (each entry carries its `role`).
 */
export function wantedModelFiles(platform) {
  return resolveServingProfile(platform).models;
}

/**
 * The download plan: wanted files not already present at their manifest
 * size. `sizeFn(path)` returns the on-disk byte size or null/undefined.
 */
export function planModelDownloads({ modelsDir, platform, sizeFn }) {
  return wantedModelFiles(platform)
    .filter((m) => sizeFn(path.join(modelsDir, m.file)) !== m.bytes)
    .map((m) => ({
      file: m.file,
      url: m.url,
      bytes: m.bytes,
      sha256: m.sha256,
      // 'required' | 'accelerator' — the downloader fails the run on a
      // required failure but only warns (and continues) on an accelerator.
      role: m.role,
      destPath: path.join(modelsDir, m.file),
      // Streamed here first; renamed onto destPath only after size+sha256
      // verify, so a half-written file can never satisfy the sidecar's
      // missing-files probe.
      partPath: path.join(modelsDir, `${m.file}.part`),
    }));
}

export function totalPlanBytes(plan) {
  return plan.reduce((sum, item) => sum + item.bytes, 0);
}

/** '3.3 GB' — decimal GB, one decimal place (matches how we talk about them). */
export function formatGB(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * One progress snapshot, the shape pushed over 'sidecar:models-progress'.
 * `state`: idle | downloading | verifying | done | failed | cancelled.
 * Byte counts span the whole plan, not the current file. `warnings` lists
 * accelerator files that failed while the run carried on ([{file, error}]) —
 * a `done` with warnings means "usable, but not at full speed".
 */
export function progressSnapshot({
  state, plan, planIndex = 0, currentReceived = 0, error = null, warnings = [],
}) {
  const doneBytes = plan.slice(0, planIndex).reduce((s, i) => s + i.bytes, 0);
  const current = plan[planIndex] || null;
  return {
    state,
    file: current ? current.file : null,
    fileIndex: Math.min(planIndex, Math.max(plan.length - 1, 0)),
    fileCount: plan.length,
    receivedBytes: doneBytes + currentReceived,
    totalBytes: totalPlanBytes(plan),
    error,
    warnings,
  };
}
