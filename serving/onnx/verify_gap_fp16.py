"""fp16 GapCloser DirectML-parity gate.

Exports the GapCloser UNet core to fp16 ONNX (keep_io_types, dynamic batch)
and measures the BOUNDARY flip rate vs the fp32 torch-CUDA reference on real
line-art tiles from the training dataset. The thresholded boundary
(udf_denorm < udf_threshold) is what /segment actually consumes, so boundary
agreement — not raw UDF max-diff — is the ship gate.

fp32 ONNX is the proven 0-flip anchor; this isolates the fp16 delta.

Run on wallace (checkpoint + torch + CUDA + onnxruntime-gpu):
    ~/miniconda3/bin/python verify_gap_fp16.py \
        --checkpoint ~/dev/cadmium-vision/checkpoints/gap_closer/gap_close_v1_1229.ckpt \
        --out-fp16 /tmp/gap_closer_fp16.onnx --out-fp32 /tmp/gap_closer_fp32.onnx --n 64
"""
import argparse
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.expanduser("~/dev/cadmium-vision"))


def load_core(checkpoint):
    from segmentation.gap_closing.gap_closer import GapCloser
    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
    m = GapCloser(**ckpt.get("hyper_parameters", {}))
    m.load_state_dict(ckpt["state_dict"])
    m.eval()
    return m.model.eval(), m.hparams


def export(core, path, fp16, tile=512):
    dummy = torch.randn(2, 1, tile, tile)
    torch.onnx.export(
        core, (dummy,), path, opset_version=18,
        input_names=["tiles"], output_names=["udf_normalized"],
        dynamic_axes={"tiles": {0: "batch"}, "udf_normalized": {0: "batch"}},
    )
    if fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16
        import onnx
        m = onnx.load(path)
        m = convert_float_to_float16(m, keep_io_types=True)
        onnx.save(m, path)
    return os.path.getsize(path)


def real_tiles(n, tile=512):
    """Pull n real model-input tiles (gap_lines_brush) from the dataset."""
    from segmentation.gap_closing.dataset import GapLineDataset as LineDataset  # noqa
    torch.manual_seed(0)
    np.random.seed(0)
    ds = LineDataset(crop_size=tile)
    out = []
    i = 0
    while len(out) < n and i < n * 4:
        try:
            s = ds[i]
            t = s["gap_lines_brush"]
            t = torch.as_tensor(t).float()
            if t.ndim == 2:
                t = t.unsqueeze(0)
            if t.shape[-2:] == (tile, tile):
                out.append(t)
        except Exception:
            pass
        i += 1
    if not out:
        raise RuntimeError("dataset yielded no usable tiles")
    return torch.stack(out)[:, :1, :, :]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out-fp16", default="/tmp/gap_closer_fp16.onnx")
    ap.add_argument("--out-fp32", default="/tmp/gap_closer_fp32.onnx")
    ap.add_argument("--n", type=int, default=64)
    args = ap.parse_args()

    import onnxruntime as ort

    core, hp = load_core(args.checkpoint)
    thr = float(hp.udf_threshold)
    mx = float(hp.udf_max_dist)
    thr_norm = thr / mx
    print(f"udf_threshold={thr} udf_max_dist={mx} -> normalized boundary thr={thr_norm:.6f}")

    s16 = export(core, args.out_fp16, True)
    s32 = export(core, args.out_fp32, False)
    print(f"exported fp16 {s16/1e6:.1f} MB, fp32 {s32/1e6:.1f} MB")

    tiles = real_tiles(args.n)
    print(f"real tiles: {tuple(tiles.shape)}  (nonzero frac {tiles.gt(0).float().mean():.4f})")
    x = tiles.numpy().astype(np.float32)

    # CPU everywhere: the shared 3090 has no free memory, and fp16's boundary
    # error is dominated by weight rounding (EP-independent). The true DML
    # timing/parity is measured on the rig; this isolates the fp16 numeric
    # delta vs the fp32 torch reference. Chunked to bound CPU memory.
    CH = 8
    ref_parts = []
    with torch.no_grad():
        for s in range(0, len(tiles), CH):
            ref_parts.append(core(tiles[s:s+CH]).numpy())
    ref = np.concatenate(ref_parts)

    prov = ["CPUExecutionProvider"]
    sess32 = ort.InferenceSession(args.out_fp32, providers=prov)
    sess16 = ort.InferenceSession(args.out_fp16, providers=prov)

    def run_chunked(sess):
        parts = []
        for s in range(0, len(x), CH):
            parts.append(sess.run(None, {"tiles": x[s:s+CH]})[0])
        return np.concatenate(parts)
    out32 = run_chunked(sess32)
    out16 = run_chunked(sess16)

    b_ref = ref < thr_norm
    for name, out in (("onnx-fp32", out32), ("onnx-fp16", out16)):
        b = out < thr_norm
        flips = (b != b_ref).sum()
        total = b_ref.size
        maxd = np.abs(out - ref).max()
        print(f"{name}: max|udf-diff|={maxd:.3e}  boundary flips={flips}/{total} "
              f"({100*flips/total:.6f}%)  agreement={100*(1-flips/total):.6f}%")

    # DML-relevant timing is measured on the rig; here just confirm fp16 runs.
    nb = min(8, len(x))
    sess16.run(None, {"tiles": x[:nb]})
    t0 = time.time()
    for _ in range(10):
        sess16.run(None, {"tiles": x[:nb]})
    print(f"onnx-fp16 CPU: {nb}-tile batch {(time.time()-t0)/10*1000:.1f} ms")

    import hashlib
    for p in (args.out_fp16, args.out_fp32):
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        print(f"sha256 {os.path.basename(p)} = {h}  ({os.path.getsize(p)} bytes)")


if __name__ == "__main__":
    main()
