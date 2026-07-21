"""Spike: de-risk the torch_scatter -> ONNX path for AnT v2's super-pixel pooling.

1. Native scatter-mean (scatter_add sums + counts) vs torch_scatter.scatter(reduce='mean'):
   exact-behavior check incl. the padding index and empty segments.
2. Export the native version to ONNX; run under onnxruntime (CUDA if available);
   compare against torch.
3. Export a UNet+pool module shaped like the real PooledImageEncoder.pool
   (resize seg -> scatter-mean -> drop pad slot) with dynamic H/W and segment count.

Run from the repo root on a torch+onnxruntime machine:

    python -m serving.onnx.spike_scatter_export
"""
import sys
import tempfile

import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms.functional as TF
from torch_scatter import scatter as torch_scatter_scatter

OPSET = 18


def native_scatter_mean(src, index, dim_size):
    """Drop-in for torch_scatter.scatter(src, index, reduce='mean', dim_size=...)
    along dim=-1, with index broadcast over the channel dim (the exact call
    shape used in PooledImageEncoder.pool: src (n,c,L), index (n,1,L))."""
    n, c, L = src.shape
    idx = index.expand(n, c, L)
    sums = torch.zeros(n, c, dim_size, dtype=src.dtype, device=src.device)
    sums = sums.scatter_add(2, idx, src)
    counts = torch.zeros(n, 1, dim_size, dtype=src.dtype, device=src.device)
    counts = counts.scatter_add(2, index, torch.ones_like(index, dtype=src.dtype))
    return sums / counts.clamp(min=1)


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        sys.exit(1)


print("== 1. native scatter-mean vs torch_scatter ==")
torch.manual_seed(0)
for trial, (n, c, L, P) in enumerate([(1, 8, 400, 7), (2, 32, 4096, 129), (1, 256, 128 * 128, 513)]):
    src = torch.randn(n, c, L)
    # segment labels incl. the padding slot P (as in the real call: seg==-100 -> P)
    index = torch.randint(0, P + 1, (n, 1, L))
    # guarantee at least one EMPTY segment id to test the counts.clamp path
    index[index == 3] = 4
    ref = torch_scatter_scatter(src=src, index=index.long(), reduce="mean", dim_size=P + 1)
    got = native_scatter_mean(src, index.long(), P + 1)
    # torch_scatter leaves empty segments at 0; ours divides 0/1 -> 0. Same.
    check(f"trial {trial}: shapes {tuple(ref.shape)} == {tuple(got.shape)}", ref.shape == got.shape)
    check(f"trial {trial}: allclose (max diff {(ref - got).abs().max().item():.2e})",
          torch.allclose(ref, got, atol=1e-5))


print("== 2. ONNX export of the pooling itself ==")


class PoolOnly(nn.Module):
    def forward(self, src, index):
        # dim_size fixed at export time (max_segments+1 is a config constant in
        # the real model, so this matches production).
        return native_scatter_mean(src, index, 130)


pool = PoolOnly().eval()
src = torch.randn(2, 32, 4096)
index = torch.randint(0, 130, (2, 1, 4096))
with tempfile.NamedTemporaryFile(suffix=".onnx") as f:
    torch.onnx.export(
        pool, (src, index), f.name, opset_version=OPSET,
        input_names=["src", "index"], output_names=["pooled"],
        dynamic_axes={"src": {0: "n", 2: "L"}, "index": {0: "n", 2: "L"}},
    )
    import onnxruntime as ort
    providers = [p for p in ort.get_available_providers() if p != "TensorrtExecutionProvider"]
    print(f"  ORT providers: {providers}")
    sess = ort.InferenceSession(f.name, providers=providers)
    out = sess.run(None, {"src": src.numpy(), "index": index.numpy()})[0]
    ref = pool(src, index).numpy()
    check(f"ORT == torch (max diff {np.abs(out - ref).max():.2e})",
          np.allclose(out, ref, atol=1e-4))
    # dynamic axes actually dynamic?
    src2 = torch.randn(1, 32, 900)
    index2 = torch.randint(0, 130, (1, 1, 900))
    out2 = sess.run(None, {"src": src2.numpy(), "index": index2.numpy()})[0]
    ref2 = pool(src2, index2).numpy()
    check("dynamic shape run", np.allclose(out2, ref2, atol=1e-4))


print("== 3. UNet + resize + pool, shaped like PooledImageEncoder ==")
from colorize.nn.unet import UNet  # the real UNet


class EncoderLike(nn.Module):
    """The real pool() data flow with the three export blockers restructured:
    - SDF comes in as an INPUT (compute_sdf_cupy moves to pipeline pre);
    - the seg map arrives ALREADY at the UNet's low-res output size (the
      NEAREST_EXACT downscale has no ONNX symbolic; its target size is
      deterministic from the UNet stride, so pipeline pre computes it — and
      parity is exact because the same pixels are selected);
    - torch_scatter is replaced by the native scatter-mean.
    """

    def __init__(self, out_channels=64, max_segments=129):
        super().__init__()
        self.unet = UNet(out_channels=out_channels)
        self.max_segments = max_segments

    def forward(self, line, sdf, seg_lowres):
        x_lowres, _mid = self.unet(line=line, sdf=sdf)
        pad = self.max_segments
        seg_lowres = torch.where(
            seg_lowres != -100, seg_lowres, torch.tensor(pad, dtype=seg_lowres.dtype),
        )
        n, c = x_lowres.shape[0], x_lowres.shape[1]
        pooled = native_scatter_mean(
            x_lowres.reshape(n, c, -1), seg_lowres.reshape(n, 1, -1).long(), pad + 1,
        )[:, :, :-1]
        return pooled


def lowres_seg(seg, unet, line, sdf):
    """What pipeline pre will do: downscale the seg map (NEAREST_EXACT) to the
    UNet's output resolution, outside the ONNX graph."""
    with torch.no_grad():
        x_lowres, _ = unet(line=line, sdf=sdf)
    return TF.resize(
        seg, (x_lowres.shape[2], x_lowres.shape[3]),
        interpolation=TF.InterpolationMode.NEAREST_EXACT,
    )


def make_seg(h, w, num_segs=129):
    # Real seg maps: valid labels in [0, num_segs) plus exactly -100 as padding.
    seg = torch.randint(0, num_segs, (1, 1, h, w))
    seg[torch.rand(1, 1, h, w) < 0.05] = -100
    return seg


enc = EncoderLike().eval()
H = W = 256
line = torch.randn(1, 4, H, W)
sdf = torch.randn(1, 1, H, W)
seg = make_seg(H, W)
seg_lr = lowres_seg(seg, enc.unet, line, sdf)
with torch.no_grad():
    ref = enc(line, sdf, seg_lr)
print(f"  eager output: {tuple(ref.shape)}")

with tempfile.NamedTemporaryFile(suffix=".onnx") as f:
    torch.onnx.export(
        enc, (line, sdf, seg_lr), f.name, opset_version=OPSET,
        input_names=["line", "sdf", "seg_lowres"], output_names=["pooled"],
        dynamic_axes={
            "line": {2: "h", 3: "w"}, "sdf": {2: "h", 3: "w"},
            "seg_lowres": {2: "lh", 3: "lw"},
        },
    )
    # Graph correctness: CPU EP vs torch CPU — both deterministic fp32.
    feed = {"line": line.numpy(), "sdf": sdf.numpy(), "seg_lowres": seg_lr.numpy()}
    cpu_sess = ort.InferenceSession(f.name, providers=["CPUExecutionProvider"])
    out_cpu = cpu_sess.run(None, feed)[0]
    check(f"encoder-like ORT-CPU == torch-CPU (max diff {np.abs(out_cpu - ref.numpy()).max():.2e})",
          np.allclose(out_cpu, ref.numpy(), atol=1e-4))
    # GPU EP: numerical variance (TF32/conv algo choice) is expected — report,
    # and assert it stays in the noise class rather than exploding.
    if "CUDAExecutionProvider" in providers:
        gpu_sess = ort.InferenceSession(f.name, providers=providers)
        out_gpu = gpu_sess.run(None, feed)[0]
        gdiff = np.abs(out_gpu - ref.numpy()).max()
        print(f"  info: CUDA EP vs torch-CPU max diff {gdiff:.2e} (TF32-class noise)")
        check("CUDA EP diff within noise budget (<2e-2)", gdiff < 2e-2)
    # different input resolution through the same graph
    line2, sdf2 = torch.randn(1, 4, 384, 384), torch.randn(1, 1, 384, 384)
    seg2 = make_seg(384, 384)
    seg2_lr = lowres_seg(seg2, enc.unet, line2, sdf2)
    with torch.no_grad():
        ref2 = enc(line2, sdf2, seg2_lr)
    out2 = cpu_sess.run(None, {
        "line": line2.numpy(), "sdf": sdf2.numpy(), "seg_lowres": seg2_lr.numpy(),
    })[0]
    check(f"dynamic-res run (max diff {np.abs(out2 - ref2.numpy()).max():.2e})",
          np.allclose(out2, ref2.numpy(), atol=1e-4))

print("ALL SPIKES PASS")
