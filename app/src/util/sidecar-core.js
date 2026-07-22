/* eslint-disable */
/**
 * Pure logic for the embedded sidecar backend — no Electron, no fs, no
 * child_process, so every decision here is unit-testable. The effectful shell
 * around it is src/sidecar-manager.js (main process only).
 *
 * The sidecar CLI contract (serving/sidecar/src/main.rs):
 *   cadmium-sidecar --port N --host 127.0.0.1
 *                   --ant-model <ant_v2_fp32.onnx>
 *                   --gap-model <gap_closer_fp32.onnx>
 *                   [--ant-model-bucket <ant_v2_fp32_bucket.onnx>]
 *                   [--ant-model-tiled <ant_v2_fp32_tiledscatter.onnx>]
 *                   [--gap-model-bucket <gap_closer_fp32_bucket.onnx>]
 *                   [--coreml-cache-dir <dir>]
 *                   --ep auto|cpu|coreml|dml
 *   GET /health answers 200 once the server is listening (ONNX sessions are
 *   built lazily on first use, so "listening" is the readiness signal).
 */

import path from 'path';

// Lifecycle states (see sidecar-manager.js for the transitions).
export const SIDECAR_STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  FAILED: 'failed',
};

// Model filenames the app looks for in the models directory.
export const MODEL_ANT = 'ant_v2_fp32.onnx';
export const MODEL_GAP = 'gap_closer_fp32.onnx';
// Optional: the CORPUS_BUCKET-pinned export that enables the CoreML fast path.
export const MODEL_ANT_BUCKET = 'ant_v2_fp32_bucket.onnx';
// Optional: the tiled-scatter export that enables the DirectML fast path.
export const MODEL_ANT_TILED = 'ant_v2_fp32_tiledscatter.onnx';
// Optional: the batch-pinned GapCloser export that enables the CoreML gap path.
export const MODEL_GAP_BUCKET = 'gap_closer_fp32_bucket.onnx';

export const SIDECAR_BIN_BASENAME = 'cadmium-sidecar';

/**
 * Where the sidecar binary and the model files live.
 *
 *  - Packaged app: binary shipped via electron-builder extraResources at
 *    <resources>/sidecar/, models user-provided in <userData>/models/.
 *  - Dev: binary from CADMIUM_SIDECAR_BIN or the cargo release output next to
 *    the repo's app/ dir; models from CADMIUM_MODELS_DIR or <userData>/models/.
 *
 * Pure: every input is a parameter so tests can cover all four quadrants.
 */
export function resolveSidecarPaths({
  isPackaged,
  resourcesPath,
  appPath,
  userDataPath,
  env = {},
  platform = 'darwin',
}) {
  const binName = platform === 'win32'
    ? `${SIDECAR_BIN_BASENAME}.exe`
    : SIDECAR_BIN_BASENAME;

  let binPath;
  let modelsDir;
  if (isPackaged) {
    // Must line up with the extraResources mapping in app/vue.config.js.
    binPath = path.join(resourcesPath, 'sidecar', binName);
    modelsDir = path.join(userDataPath, 'models');
  } else {
    // In dev, appPath is app/dist_electron (electron:serve bundles the main
    // process there); the sidecar's cargo release output lives at
    // <repo>/serving/sidecar/target/release, i.e. above the app/ directory.
    const appDir = path.basename(appPath) === 'dist_electron'
      ? path.join(appPath, '..')
      : appPath;
    binPath = env.CADMIUM_SIDECAR_BIN
      || path.join(appDir, '..', 'serving', 'sidecar', 'target', 'release', binName);
    modelsDir = env.CADMIUM_MODELS_DIR || path.join(userDataPath, 'models');
  }

  return {
    binPath,
    modelsDir,
    antModelPath: path.join(modelsDir, MODEL_ANT),
    gapModelPath: path.join(modelsDir, MODEL_GAP),
    antBucketModelPath: path.join(modelsDir, MODEL_ANT_BUCKET),
    antTiledModelPath: path.join(modelsDir, MODEL_ANT_TILED),
    gapBucketModelPath: path.join(modelsDir, MODEL_GAP_BUCKET),
    // Where CoreML persists compiled models (macOS): the AnT bucket compiles
    // once (~107s, background) then reloads in ~20s per process start.
    coremlCacheDir: path.join(userDataPath, 'sidecar', 'coreml-cache'),
  };
}

/**
 * Which required files are absent, as [{ kind, file, path }]. The bucket
 * (CoreML) and tiled (DirectML) models are optional fast-path exports and are
 * never reported missing.
 */
export function missingSidecarFiles(paths, existsFn) {
  const missing = [];
  if (!existsFn(paths.binPath)) {
    missing.push({ kind: 'binary', file: path.basename(paths.binPath), path: paths.binPath });
  }
  if (!existsFn(paths.antModelPath)) {
    missing.push({ kind: 'model', file: MODEL_ANT, path: paths.antModelPath });
  }
  if (!existsFn(paths.gapModelPath)) {
    missing.push({ kind: 'model', file: MODEL_GAP, path: paths.gapModelPath });
  }
  return missing;
}

/**
 * The argv (after the binary path) for one sidecar spawn. `--ep auto` lets
 * the sidecar pick its fast path per OS: CoreML on macOS when the bucket model
 * is supplied, DirectML on Windows when the tiled model is supplied, else CPU.
 * On Windows with the tiled model but no DirectX-12 device, the sidecar itself
 * falls back to the stock model on the CPU EP.
 */
export function buildSidecarArgs({
  port, antModelPath, gapModelPath, antBucketModelPath = null, antTiledModelPath = null,
  gapBucketModelPath = null, coremlCacheDir = null,
}) {
  const args = [
    '--port', String(port),
    '--host', '127.0.0.1',
    '--ant-model', antModelPath,
    '--gap-model', gapModelPath,
    '--ep', 'auto',
    // stdin is spawned as a pipe: if this app dies by ANY means (including
    // SIGKILL, which fires no quit hooks) the OS closes it and the sidecar
    // exits instead of orphaning.
    '--exit-on-stdin-close',
  ];
  if (antBucketModelPath) {
    args.push('--ant-model-bucket', antBucketModelPath);
  }
  if (antTiledModelPath) {
    args.push('--ant-model-tiled', antTiledModelPath);
  }
  if (gapBucketModelPath) {
    args.push('--gap-model-bucket', gapBucketModelPath);
  }
  if (coremlCacheDir) {
    args.push('--coreml-cache-dir', coremlCacheDir);
  }
  return args;
}

// Crash restarts back off exponentially: 1s, 2s, 4s, ... capped at 15s.
export const RESTART_DELAY_BASE_MS = 1000;
export const RESTART_DELAY_CAP_MS = 15000;

export function restartDelayMs(restartCount) {
  const attempt = Math.max(0, restartCount - 1);
  return Math.min(RESTART_DELAY_BASE_MS * 2 ** attempt, RESTART_DELAY_CAP_MS);
}

/** One-line human summary of a missing-files list (used in status/lastError). */
export function describeMissing(missing) {
  if (!missing || !missing.length) return '';
  const files = missing.map((m) => m.file).join(', ');
  return `Missing: ${files}`;
}
