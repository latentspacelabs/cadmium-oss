/* eslint-disable */
/**
 * Pure evaluation of whether THIS machine can run the embedded backend, and how
 * well — no Electron, no `os`, so every rule is unit-testable. The effectful
 * probe that gathers the raw numbers is the main-process `system:capabilities`
 * IPC (background.js), surfaced to the renderer as
 * `platform.getSystemCapabilities()`.
 *
 * The caller passes a plain capabilities object:
 *   { platform, arch, totalMem, freeMem, cpuCount, freeDiskBytes, gpu }
 * and the bytes a model download would still need to fetch (from the download
 * plan). We return a verdict the Server Settings modal renders as a per-check
 * list plus an overall supported/blocked decision.
 *
 * Severity model:
 *   - `blocked` → embedded is not viable; steer the user to a hosted server.
 *   - `warn`    → embedded works but will be slow / risky; let them proceed.
 *   - `info`    → purely a performance note (e.g. no GPU → CPU fallback).
 *   - `unknown` → the probe couldn't measure it; never blocks.
 */

// The embedded sidecar binary ships only for these (platform, arch) pairs.
// Anything else (Intel mac, Linux, win-arm) has no binary at all — a hard gate.
export const EMBEDDED_SUPPORTED_TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
];

const GB = 1e9;
// Headroom above the raw download so the models don't fill the volume to the brim.
export const DISK_HEADROOM_BYTES = 1 * GB;
// macOS: CoreML persists compiled models to the sidecar cache dir (~4.4 GB
// for the AnT bucket + GapCloser bucket on an M3) — counted as needed space
// so the compile doesn't fill the volume after a passing check.
export const COREML_CACHE_BYTES = 5 * GB;
// The embedded backend loads a ~1.4 GB fp32 model plus activations. Below the
// recommended figure it leans on swap and gets slow; it is a warning, never a
// blocker (a machine with little RAM can still limp along on the CPU EP).
export const RAM_RECOMMENDED_BYTES = 8 * GB;

/** Does the embedded sidecar binary exist for this (platform, arch)? */
export function isEmbeddedTargetSupported(platform, arch) {
  return EMBEDDED_SUPPORTED_TARGETS.some(
    (target) => target.platform === platform && target.arch === arch,
  );
}

/**
 * Coarse "is hardware acceleration likely" signal from Electron's getGPUInfo.
 * Only used for the perf note — never a blocker, since the sidecar falls back
 * to the CPU EP (and DirectML runs on an iGPU too). Returns { accelerated, renderer }
 * where accelerated is true | false | null (unknown).
 */
export function classifyGpu(gpu) {
  const renderer = (gpu
    && (gpu.renderer
      || (gpu.auxAttributes && gpu.auxAttributes.glRenderer))) || '';
  const r = String(renderer).toLowerCase();
  if (!r) return { accelerated: null, renderer: '' };
  const software = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(r);
  return { accelerated: !software, renderer: String(renderer) };
}

/**
 * Evaluate the machine against the embedded backend's needs.
 * @param {object} caps  { platform, arch, totalMem, freeDiskBytes, gpu, ... }
 * @param {object} opts  { neededBytes } — bytes the model download must still fetch
 * @returns verdict { supported, recommendation, checks, blockers, warnings }
 */
export function evaluateEmbeddedCapability(caps, { neededBytes = 0 } = {}) {
  const c = caps || {};
  const platform = c.platform || '';
  const arch = c.arch || '';
  // On macOS the CoreML model cache is real disk the embedded backend will
  // consume beyond the download itself.
  const cacheBytes = platform === 'darwin' ? COREML_CACHE_BYTES : 0;
  const needed = Math.max(0, Number(neededBytes) || 0) + cacheBytes;

  const checks = {};
  const blockers = [];
  const warnings = [];

  // 1. System (platform + arch) — the hard gate: no binary, no embedded.
  const systemOk = isEmbeddedTargetSupported(platform, arch);
  checks.system = { status: systemOk ? 'ok' : 'blocked', platform, arch };
  if (!systemOk) blockers.push('system');

  // 2. Storage — room for whatever still has to download (already-present
  //    models drop out of `neededBytes`, so a fully-downloaded machine passes).
  if (typeof c.freeDiskBytes === 'number' && c.freeDiskBytes >= 0) {
    const comfortable = needed + DISK_HEADROOM_BYTES;
    let status = 'ok';
    if (c.freeDiskBytes < needed) status = 'blocked';
    else if (c.freeDiskBytes < comfortable) status = 'warn';
    checks.disk = { status, freeBytes: c.freeDiskBytes, neededBytes: needed };
    if (status === 'blocked') blockers.push('disk');
    else if (status === 'warn') warnings.push('disk');
  } else {
    checks.disk = { status: 'unknown', freeBytes: null, neededBytes: needed };
  }

  // 3. Memory — soft: warn below the recommended figure, never block.
  if (typeof c.totalMem === 'number' && c.totalMem > 0) {
    const status = c.totalMem < RAM_RECOMMENDED_BYTES ? 'warn' : 'ok';
    checks.ram = {
      status,
      totalBytes: c.totalMem,
      recommendedBytes: RAM_RECOMMENDED_BYTES,
    };
    if (status === 'warn') warnings.push('ram');
  } else {
    checks.ram = { status: 'unknown', totalBytes: null, recommendedBytes: RAM_RECOMMENDED_BYTES };
  }

  // 4. Graphics — informational only (affects speed, not viability).
  const gpu = classifyGpu(c.gpu);
  checks.gpu = {
    status: gpu.accelerated === false ? 'info' : 'ok',
    accelerated: gpu.accelerated,
    renderer: gpu.renderer,
  };

  const supported = blockers.length === 0;
  return {
    supported,
    recommendation: supported ? 'embedded' : 'hosted',
    checks,
    blockers,
    warnings,
  };
}
