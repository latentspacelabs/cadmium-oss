/* eslint-disable */
/**
 * The Serving Profile — the single declared source of truth for "what models
 * and hardware acceleration THIS machine wants" (docs/serving-setup-design.md,
 * Phase 2). Pure: a function of (platform, manifest), no fs, no Electron.
 *
 * Everything that used to imply this decision (manifest `platform` filters,
 * existsFn gates, per-OS conditionals) now derives from one object, so the
 * downloader, the missing-file probes, and the UI can all compare *the same
 * expectation* against reality:
 *
 *  - `models`: the exact files to download/validate here, each with a role —
 *    `required` (the sidecar refuses to start without it) or `accelerator`
 *    (optional fast-path export; missing one silently degrades to CPU, which
 *    is exactly the failure mode this module exists to make loud).
 *  - `expected`: the EPs the sidecar should reach when everything is present
 *    and healthy — compared against /health's `acceleration.{...}.active`.
 *
 * Arch support gating (Intel mac, win-arm → no embedded at all) stays in
 * embedded-capability.js; the profile describes what a *supported* machine of
 * this platform wants.
 */

import { MODEL_FILES, modelUrl } from './model-manifest';

/** The profile for one platform ('darwin' | 'win32' | anything else). */
export function resolveServingProfile(platform) {
  const models = MODEL_FILES
    .filter((m) => m.required || m.platform === platform)
    .map((m) => ({
      file: m.file,
      bytes: m.bytes,
      sha256: m.sha256,
      url: modelUrl(m.file),
      role: m.required ? 'required' : 'accelerator',
    }));

  let name = 'cpu-only';
  let expected = { colorize: 'cpu', segment: 'cpu' };
  if (platform === 'darwin') {
    name = 'mac-coreml';
    expected = { colorize: 'coreml', segment: 'coreml' };
  } else if (platform === 'win32') {
    name = 'win-dml';
    // Both capabilities on DirectML: colorize via the tiled-scatter export,
    // gap closing via the fp16 export (fp32 batches OOM a 16 GB WDDM card).
    expected = { colorize: 'dml', segment: 'dml' };
  }

  return { name, platform, models, expected };
}

/** The profile's accelerator entries (optional fast-path models). */
export function acceleratorModels(platform) {
  return resolveServingProfile(platform).models.filter((m) => m.role === 'accelerator');
}
