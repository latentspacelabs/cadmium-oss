/* eslint-disable */
/**
 * Single source of truth for the embedded backend's model artifacts: what
 * files exist, how big they are, and how to verify them.
 *
 * The artifacts are hosted as assets of the hand-managed `models-v1` GitHub
 * Release (created by serving/tools/upload_models_release.sh — which verifies
 * uploads against this manifest). The model download/bootstrap flow resolves
 * files against MODELS_BASE_URL and checks sha256 after download. Filenames
 * must match what sidecar-core.js passes to the sidecar (MODEL_ANT etc.).
 *
 * CommonJS on purpose: loaded both by the app (webpack) and by plain-node
 * tooling (the upload script).
 *
 * Bumping models = new release tag + new hashes here, in one commit, so an
 * app version always pins the exact artifacts it was validated against
 * (the parity goldens are anchored to these bytes).
 */

const MODELS_RELEASE_TAG = 'models-v1';
const MODELS_BASE_URL =
  `https://github.com/latentspacelabs/cadmium-oss/releases/download/${MODELS_RELEASE_TAG}`;

const MODEL_FILES = [
  {
    // AnT colorizer, dynamic shapes. The workhorse: every EP can run it.
    file: 'ant_v2_fp32.onnx',
    bytes: 1388610539,
    sha256: '6c8d95cbfa62408f3cbfbbc29204fac7df5a587466dbb751e7e1b0bb530ff12b',
    required: true,
  },
  {
    // AnT colorizer with bucket-pinned shapes (see CORPUS_BUCKET in
    // serving/sidecar/src/tokenize/bucket.rs — sized to cover ~150
    // average-complexity segments; bigger drawings fall back to the dynamic
    // CPU session) — the CoreML fast path
    // (--ant-model-bucket). Optional and macOS-only: without it the sidecar
    // still serves every request via the dynamic model.
    file: 'ant_v2_fp32_bucket.onnx',
    bytes: 1388609979,
    sha256: 'af4a4194362fd6ef81d6df2d8d653372da3265471aa19dfceaab5f97c443e30d',
    required: false,
    platform: 'darwin',
  },
  {
    // AnT colorizer with the pool ScatterElements(add) sites rewritten as a
    // bounded tiled one-hot MatMul (serving/onnx/scatter_to_tiled.py) — the
    // DirectML fast path (--ant-model-tiled). DirectML has no scatter-add
    // kernel, so on the stock model those scatters fall back to CPU and force
    // ~1 GB of PCIe copies per forward (~95% of the DML wall-clock); the tiled
    // rewrite is fully DML-native and argmax-exact, cutting the forward ~5.7×.
    // Optional and Windows-only: on a machine with no DirectX-12 device the
    // sidecar falls back to the stock model on the CPU EP, and it is dead
    // weight on macOS (CoreML runs the scatter natively). ~20% slower than the
    // stock model on CPU, which is why it is DML-only, not the universal
    // export.
    file: 'ant_v2_fp32_tiledscatter.onnx',
    bytes: 1389055751,
    sha256: '64a89282e0f0a18e182257718341dfc0838481ec63d1bb5fb45bad82b25814d8',
    required: false,
    platform: 'win32',
  },
  {
    // GapCloser, fp32 (fp16 exists for DirectML but fp32 is the parity
    // anchor: 0 boundary flips vs torch-CUDA on all golden drawings).
    file: 'gap_closer_fp32.onnx',
    bytes: 497500380,
    sha256: '3a9a792f72fd3451c36145a0657328e333d6e5e982f0760b5e5a6e7e9934d327',
    required: true,
  },
  {
    // GapCloser with the batch dim pinned to 24 tiles — the CoreML fast path
    // for /segment gap closing (--gap-model-bucket). Same weights as
    // gap_closer_fp32.onnx, only the input shape differs. Optional and
    // macOS-only: without it (or off macOS) gap closing runs one tile at a
    // time on the CPU EP (~20s on high-res drawings vs ~1.3s batched CoreML).
    file: 'gap_closer_fp32_bucket.onnx',
    bytes: 497519867,
    sha256: '1f1966b41c04a8b406ff8d16c54cbfa3354e5aec3d196507861f211beeb36e0d',
    required: false,
    platform: 'darwin',
  },
  {
    // GapCloser fp16 — the DirectML fast path for /segment gap closing on
    // Windows (--gap-model-bucket). fp32 is not viable on DML: batch-24 fp32
    // OOMs a 16 GB WDDM card. The fp16 export uses keep_io_types (float32
    // I/O, fp16 internals), so the sidecar feeds it exactly like the fp32
    // path. Boundary parity vs the fp32 anchor: 10 flips / 10.5M pixels
    // (99.999905%) on real line tiles — the trapped-ball segmentation
    // downstream absorbs those isolated threshold-straddling pixels.
    // Measured on a T4: batch-24 ~0.7s vs the CPU EP's multi-second path.
    // Optional and win32-only: without it, Windows gap closing runs on the
    // CPU EP one tile at a time.
    file: 'gap_closer_fp16.onnx',
    bytes: 248798392,
    sha256: '1976b93409591384b2177fab1a5b84ee9866ad1c2cfabdc1154e7835fead33d6',
    required: false,
    platform: 'win32',
  },
];

function modelUrl(file) {
  return `${MODELS_BASE_URL}/${file}`;
}

module.exports = { MODELS_RELEASE_TAG, MODELS_BASE_URL, MODEL_FILES, modelUrl };
