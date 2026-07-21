"""Export the GapCloser UNet to ONNX and verify parity against torch.

The ONNX surface is the neural core only: `ClassicUNet(x) -> udf_normalized`
with x = [B, 1, 512, 512] line-alpha tiles (dynamic batch). Everything around
it — tiling/merging, UDF denormalize + threshold, the binarized-input union,
trapped-ball — is classical post-processing and stays outside the graph.

Run on a machine with the checkpoint + torch + onnxruntime:

    python -m serving.onnx.export_gap_closer \\
        --checkpoint ~/dev/cadmium-vision/checkpoints/gap_closer/gap_close_v1_1229.ckpt \\
        --out /tmp/gap_closer.onnx [--fp16]

Parity policy (see docs/serving-backends.md §5): ORT-CPU vs torch-CPU must be
tight (graph correctness); CUDA EP gets a TF32-class noise budget, and what
actually matters downstream is the THRESHOLDED boundary (udf < threshold), so
we also report boundary-pixel agreement.
"""
import argparse
import os
import time

import numpy as np
import torch


def load_unet(checkpoint: str):
    from segmentation.gap_closing.gap_closer import GapCloser

    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = GapCloser(**ckpt.get("hyper_parameters", {}))
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model.model, model.hparams  # the ClassicUNet core + thresholds


def export(unet, out_path: str, fp16: bool, tile: int):
    unet = unet.eval()
    dummy = torch.randn(2, 1, tile, tile)
    torch.onnx.export(
        unet, (dummy,), out_path, opset_version=18,
        input_names=["tiles"], output_names=["udf_normalized"],
        dynamic_axes={"tiles": {0: "batch"}, "udf_normalized": {0: "batch"}},
    )
    if fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16
        import onnx

        m = onnx.load(out_path)
        m = convert_float_to_float16(m, keep_io_types=True)
        onnx.save(m, out_path)
    return os.path.getsize(out_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", default="/tmp/gap_closer.onnx")
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--batch", type=int, default=24)
    args = ap.parse_args()

    import onnxruntime as ort

    unet, hparams = load_unet(args.checkpoint)
    n_params = sum(p.numel() for p in unet.parameters())
    print(f"ClassicUNet: {n_params / 1e6:.1f}M params, udf_threshold={hparams.udf_threshold}")

    size = export(unet, args.out, args.fp16, args.tile)
    print(f"exported {'fp16' if args.fp16 else 'fp32'} -> {args.out} ({size / 1e6:.1f} MB)")

    # Realistic-ish tiles: sparse strokes on empty background, in [0,1].
    torch.manual_seed(0)
    x = (torch.rand(args.batch, 1, args.tile, args.tile) < 0.03).float()
    x += torch.randn_like(x) * 0.01
    x = x.clamp(0, 1)

    with torch.no_grad():
        ref = unet(x).numpy()

    cpu = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    out_cpu = cpu.run(None, {"tiles": x.numpy()})[0]
    diff_cpu = np.abs(out_cpu - ref).max()
    print(f"ORT-CPU vs torch-CPU: max diff {diff_cpu:.2e}")

    thr = float(hparams.udf_threshold) / float(hparams.udf_max_dist)
    b_ref = ref < thr
    b_cpu = out_cpu < thr
    print(f"boundary agreement (CPU): {(b_ref == b_cpu).mean() * 100:.4f}%")

    providers = [p for p in ort.get_available_providers() if p == "CUDAExecutionProvider"]
    if providers:
        gpu = ort.InferenceSession(args.out, providers=providers + ["CPUExecutionProvider"])
        out_gpu = gpu.run(None, {"tiles": x.numpy()})[0]
        diff_gpu = np.abs(out_gpu - ref).max()
        b_gpu = out_gpu < thr
        agree = (b_ref == b_gpu).mean() * 100
        print(f"ORT-CUDA vs torch-CPU: max diff {diff_gpu:.2e}; boundary agreement {agree:.4f}%")

        # timing: the /segment hot loop is batches of `--batch` tiles
        feed = {"tiles": x.numpy()}
        gpu.run(None, feed)  # warmup
        t0 = time.time()
        n_iter = 10
        for _ in range(n_iter):
            gpu.run(None, feed)
        dt = (time.time() - t0) / n_iter
        print(f"ORT-CUDA: {args.batch} tiles in {dt * 1000:.1f} ms/batch")

        if torch.cuda.is_available():
            unet_gpu = unet.cuda()
            xg = x.cuda()
            with torch.no_grad():
                unet_gpu(xg)  # warmup
                torch.cuda.synchronize()
                t0 = time.time()
                for _ in range(n_iter):
                    unet_gpu(xg)
                torch.cuda.synchronize()
            print(f"torch-CUDA: {args.batch} tiles in {(time.time() - t0) / n_iter * 1000:.1f} ms/batch")


if __name__ == "__main__":
    main()
