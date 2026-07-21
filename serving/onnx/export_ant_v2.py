"""Export the AnT v2 colorize model to ONNX and verify parity against torch.

The exported graph is `AnTV2ExportWrapper`: the full AnT v2 forward pass with
the three export blockers restructured exactly as validated by
`spike_scatter_export.py`:

  1. torch_scatter -> native scatter-mean (scatter_add sums + counts);
  2. the SDF becomes a graph INPUT (computed by pre-processing with the same
     math as `compute_sdf_cupy`, on CPU);
  3. the seg map arrives ALREADY at the UNet's low-res output size (the
     NEAREST_EXACT downscale happens in pre-processing).

plus one inference-shape restructuring:

  4. `_pack_inputs`' data-dependent boolean packing becomes a single
     `index_select` over the concatenated [ref slots..., target slots...]
     axis with a gather index + attention mask computed by pre-processing
     (N=1 at inference; layout [ref_valid..., target_valid..., pads...]).
     Bucket pads sit at the END and are masked False, so RoPE positions of
     real tokens match production exactly even when dims are padded to fixed
     bucket sizes for CoreML static-shape compiles (`pad_feed_to_bucket`).

  5. The SVG encoder's boolean-mask filtering/unpacking (`[nopad_pack_mask]`,
     `unpack_sequences`) becomes: pre-processing passes ONLY the valid packed
     rows plus three index tensors (valid-command positions in the flat R*C
     packed layout, destination slot per command, valid-command count per
     slot); the graph gathers per-COMMAND features and scatter-adds them into
     slots. NOTE a packed row holds MULTIPLE segments (pack_sequences greedily
     fills rows; block-diagonal attention isolates them) — the robot.cdm
     golden corpus caught the earlier one-row-one-segment assumption, which
     the tiny fixtures had satisfied by coincidence.

The graph outputs the PACKED color logits (1 x (R+T) x max_palette); slicing
off the R reference rows and argmaxing is post-processing (the caller knows R
— it computed the gather indices).

Parity is checked in three stages, each against the previous:
  torch production model  ->  eager wrapper  ->  ORT (CPU, then CUDA)

Run on a machine with the checkpoint (CPU is enough for export + parity):

    python -m serving.onnx.export_ant_v2 \\
        --checkpoint ~/dev/cadmium-vision/checkpoints/colorizer/v2-encoder-pretrained-large-tb-aug-7750 \\
        --out-dir /tmp/ant_v2_onnx [--fp16]
"""
import argparse
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms.functional as TF
from scipy.ndimage import distance_transform_edt

from colorize.common.ops import make_4d_bidirectional_attention_mask


# ---------------------------------------------------------------------------
# Export-safe building blocks (validated in spike_scatter_export.py)
# ---------------------------------------------------------------------------

def native_scatter_mean(src, index, dim_size):
    """Drop-in for torch_scatter.scatter(reduce='mean') along dim=-1 with the
    index broadcast over channels — bit-identical (see the spike)."""
    n, c, length = src.shape
    idx = index.expand(n, c, length)
    sums = torch.zeros(n, c, dim_size, dtype=src.dtype, device=src.device)
    sums = sums.scatter_add(2, idx, src)
    counts = torch.zeros(n, 1, dim_size, dtype=src.dtype, device=src.device)
    counts = counts.scatter_add(2, index, torch.ones_like(index, dtype=src.dtype))
    return sums / counts.clamp(min=1)


def sdf_like_cupy(line_scaled: torch.Tensor) -> torch.Tensor:
    """CPU replica of `compute_sdf_cupy(rgba_to_rgb_torch(line), binarize=True)`
    including its quirks: transparent pixels become WHITE=255 (although the
    line is already /255-scaled), then binary = rgb.min > 0, EDT of the binary
    mask, and a GLOBAL min-max normalization.

    Degenerate all-True binary (REAL drawings hit this: canvas PNGs keep white
    rgb under transparent alpha, so the tokenizer resize lifts every stroke
    pixel above 0): cucim's PBA measures distance to a sentinel row above the
    image and returns 32768 + y — after normalization, a vertical ramp. scipy
    returns different junk there, so the ramp is replicated explicitly
    (verified vs cucim on wallace; non-degenerate masks match scipy to 1.5e-6)."""
    rgb = line_scaled[:, :3]
    alpha = line_scaled[:, 3:]
    rgb = torch.where(alpha == 0, torch.ones_like(rgb) * 255, rgb)
    binary = (rgb.min(dim=1).values > 0).numpy()
    dists = []
    for b in binary:
        if b.all():
            h, w = b.shape
            dists.append(np.tile(2.0**15 + np.arange(h, dtype=np.float64)[:, None], (1, w)))
        else:
            dists.append(distance_transform_edt(b))
    sdf = torch.from_numpy(np.stack(dists)).unsqueeze(1).float()
    return (sdf - sdf.min()) / (sdf.max() - sdf.min())


def lowres_seg(seg_full: torch.Tensor, lowres_hw) -> torch.Tensor:
    """Pre-processing replica of the in-forward NEAREST_EXACT downscale."""
    return TF.resize(seg_full, list(lowres_hw), interpolation=TF.InterpolationMode.NEAREST_EXACT)


class AnTV2ExportWrapper(nn.Module):
    """The production AnTV2Model forward, restructured per the module header.
    Reuses the loaded model's submodules/weights directly — no re-training, no
    weight copies."""

    def __init__(self, v2_model):
        super().__init__()
        self.v2 = v2_model

    def _svg_feats(self, packed_nopad, attn_nopad, flat_idx, cmd_slot_idx, slot_counts, num_slots):
        """Export-safe SVGEncoder.forward (inference). Production packs
        MULTIPLE segments' command runs into shared rows (block-diagonal
        attention keeps them independent) and `unpack_sequences` redistributes
        per-command features back to slots BY ORDER — a packed row is not one
        segment (the original fixture just happened to land that way). The
        order is precomputed as index tensors: flat_idx (V) = positions of
        valid commands in the flattened R*C packed layout; cmd_slot_idx (V) =
        destination slot per command; slot_counts (S) = valid commands per
        slot (0 for pad slots, whose LayerNorm-of-zeros matches production)."""
        svg = self.v2.ant_v1.svg_feat_extractor
        feats = packed_nopad
        for layer in svg.layers:
            feats = layer(feats)
        inverted = torch.where(
            attn_nopad,
            torch.tensor(1.0, dtype=feats.dtype),
            torch.tensor(torch.finfo(torch.float32).min, dtype=feats.dtype),
        )
        out = svg.llama_model(
            inputs_embeds=feats, attention_mask=inverted.unsqueeze(1),
        ).last_hidden_state  # R x C x F
        f = out.shape[-1]
        sel = out.reshape(-1, f).index_select(0, flat_idx)      # V x F
        sums = torch.zeros(num_slots, f, dtype=out.dtype, device=out.device)
        sums = sums.scatter_add(0, cmd_slot_idx.unsqueeze(-1).expand(-1, f), sel)
        mean = sums / (slot_counts.unsqueeze(-1) + 1e-6)        # S x F
        return svg.norm_out(mean.unsqueeze(0))

    def _image_feats(self, line_raw, sdf, seg_lowres, max_slots):
        # Production: _encode_image_features divides by 255, PooledImageEncoder
        # pools UNet features per segment then projects. autocast(bf16) is
        # dropped (fp32 graph; fp16 happens at conversion time).
        enc = self.v2.ant_v1.img_feat_extractor
        x_lowres, _mid = enc.unet(line=line_raw / 255, sdf=sdf)
        seg = torch.where(
            seg_lowres != -100, seg_lowres, torch.full_like(seg_lowres, max_slots),
        )
        n, c = x_lowres.shape[0], x_lowres.shape[1]
        pooled = native_scatter_mean(
            x_lowres.reshape(n, c, -1).float(), seg.reshape(n, 1, -1).long(), max_slots + 1,
        )[:, :, :-1]
        return enc.final_out_proj(pooled.permute(0, 2, 1))

    def forward(
        self,
        ref_line_image,        # 1 x 4 x H x W float (raw 0..255, as tokenized)
        ref_sdf,               # 1 x 1 x H x W float
        ref_seg_lowres,        # 1 x 1 x h x w long (labels incl. -100)
        target_line_image,
        target_sdf,
        target_seg_lowres,
        ref_svg_packed_nopad,           # R x C x 6 float (valid rows only)
        ref_svg_attn_nopad,             # R x C x C bool
        ref_svg_flat_idx,               # V long (valid cmd positions in flat R*C)
        ref_svg_cmd_slot_idx,           # V long (destination slot per command)
        ref_svg_slot_counts,            # S float (valid commands per slot)
        target_svg_packed_nopad,
        target_svg_attn_nopad,
        target_svg_flat_idx,
        target_svg_cmd_slot_idx,
        target_svg_slot_counts,
        ref_colors,            # 1 x S x 4 long
        ref_color_ids,         # 1 x S long
        target_colors,
        target_color_ids,
        packed_gather_idx,     # L long — slots to pack, over the CONCATENATED
                               #   [ref slots..., target slots...] axis; real
                               #   entries first, bucket-pad entries (any
                               #   valid index) last so RoPE positions of real
                               #   tokens match production exactly
        packed_attn_mask,      # 1 x L bool — False on bucket-pad entries
    ):
        v2 = self.v2
        num_ref_slots = ref_colors.shape[1]
        num_tgt_slots = target_colors.shape[1]

        img_ref = self._image_feats(ref_line_image, ref_sdf, ref_seg_lowres, num_ref_slots)
        img_tgt = self._image_feats(target_line_image, target_sdf, target_seg_lowres, num_tgt_slots)

        svg_ref = self._svg_feats(
            ref_svg_packed_nopad, ref_svg_attn_nopad, ref_svg_flat_idx,
            ref_svg_cmd_slot_idx, ref_svg_slot_counts, num_ref_slots,
        )
        svg_tgt = self._svg_feats(
            target_svg_packed_nopad, target_svg_attn_nopad, target_svg_flat_idx,
            target_svg_cmd_slot_idx, target_svg_slot_counts, num_tgt_slots,
        )

        fused_ref = v2._combine_color_frame_palette_embeds(
            color_ids=ref_color_ids, image_embeds=img_ref, svg_embeds=svg_ref,
            colors=ref_colors, frame_idx=0, is_ref=True,
        )
        fused_tgt = v2._combine_color_frame_palette_embeds(
            color_ids=target_color_ids, image_embeds=img_tgt, svg_embeds=svg_tgt,
            colors=target_colors, frame_idx=1, is_ref=False,
        )

        packed_all = torch.cat([fused_ref, fused_tgt], dim=1)   # 1 x (S_r+S_t) x F
        packed = packed_all.index_select(1, packed_gather_idx)  # 1 x L x F
        mask4d = make_4d_bidirectional_attention_mask(
            inputs_embeds=packed, inputs_attention_mask=packed_attn_mask,
        )
        decoder_out = v2.decoder(inputs_embeds=packed, attention_mask=mask4d)[0]
        return v2.lm_head(decoder_out).float()  # 1 x (R+T) x max_palette


# ---------------------------------------------------------------------------
# Fixture inputs (self-contained: simple closed shapes, trapped-ball seg maps)
# ---------------------------------------------------------------------------

def draw_fixture_frames(w=512, h=384):
    """Two line frames (transparent bg, black strokes) + a colored reference
    for frame 1 — same spirit as the app's e2e fixtures."""
    def blank_rgba():
        return np.zeros((h, w, 4), dtype=np.uint8)

    def rect(img, x0, y0, x1, y1, t=5):
        img[y0:y1, x0:x0 + t] = [0, 0, 0, 255]
        img[y0:y1, x1 - t:x1] = [0, 0, 0, 255]
        img[y0:y0 + t, x0:x1] = [0, 0, 0, 255]
        img[y1 - t:y1, x0:x1] = [0, 0, 0, 255]

    line_ref = blank_rgba()
    rect(line_ref, 60, 50, 260, 220)
    rect(line_ref, 300, 120, 460, 330)

    line_tgt = blank_rgba()
    rect(line_tgt, 80, 70, 280, 240)   # same shapes, shifted
    rect(line_tgt, 290, 100, 450, 310)

    color_ref = np.zeros((h, w, 4), dtype=np.uint8)
    color_ref[55:215, 65:255] = [220, 40, 40, 255]    # red box interior
    color_ref[125:325, 305:455] = [40, 80, 220, 255]  # blue box interior

    return line_ref, line_tgt, color_ref


def seg_map_for(line_rgba: np.ndarray) -> np.ndarray:
    """Trapped-ball-only segmentation (no ML gap closer needed for parity)."""
    from serving.handlers.segment import run_segment
    from segmentation.trapped_ball.serialization import (
        img_to_base64_png_uri, base64_png_uri_to_img,
    )

    uri = img_to_base64_png_uri(line_rgba)
    resp = run_segment(None, line_image_uri=uri, gap_closer_strength=0.0)
    return base64_png_uri_to_img(resp["seg_map_uri"])


# ---------------------------------------------------------------------------
# Feed building (shared with parity_corpus.py)
# ---------------------------------------------------------------------------

def probe_lowres_hw(model, tok):
    """The UNet's output resolution for this input size (runs wherever the
    model lives; shapes only)."""
    enc = model.ant_v1.img_feat_extractor
    dev = next(enc.unet.parameters()).device
    line = tok["ref_line_image"].float().to(dev)
    with torch.no_grad():
        probe = enc.unet(line=line / 255, sdf=torch.zeros_like(line[:, :1]))[0]
    return (probe.shape[2], probe.shape[3])


def svg_pre(seg_svg, packed, attn_packed):
    """Pre-processing for the export-safe SVG path. The packed layout holds
    MULTIPLE segments per row (production pack_sequences greedily fills rows),
    and production unpacks per-COMMAND features back to slots by order. That
    order-preserving correspondence — valid commands row-major in the packed
    layout == valid commands slot-major in the per-slot grid — is exactly what
    production's unpack_sequences relies on, so these index tensors are exact
    by construction."""
    keep = torch.all(packed != -100.0, dim=-1).any(dim=-1)           # P
    packed_nopad = packed[keep].float()                              # R x C x 6
    attn_nopad = attn_packed[keep].bool()                            # R x C x C
    valid_packed = torch.all(packed_nopad != -100.0, dim=-1)         # R x C
    flat_idx = torch.nonzero(valid_packed.reshape(-1)).flatten()     # V
    valid_slot = torch.all(seg_svg[0] != -100.0, dim=-1)             # S x C
    cmd_slot_idx = torch.nonzero(valid_slot)[:, 0]                   # V
    slot_counts = valid_slot.sum(-1).float()                         # S
    assert flat_idx.numel() == cmd_slot_idx.numel(), (
        f"valid commands in packed layout {flat_idx.numel()} != "
        f"valid commands in slot grid {cmd_slot_idx.numel()}")
    return packed_nopad, attn_nopad, flat_idx, cmd_slot_idx, slot_counts


def build_feed(tok, lowres_hw):
    """ONNX-graph inputs from CPU tokenized tensors. Returns
    (feed_t, ref_idx, tgt_idx) — the idx tensors define the packed layout."""
    ref_pad = torch.all(tok["ref_seg_svg"] == -100, dim=(2, 3))
    tgt_pad = torch.all(tok["target_seg_svg"] == -100, dim=(2, 3))
    ref_idx = torch.nonzero(~ref_pad[0]).flatten()
    tgt_idx = torch.nonzero(~tgt_pad[0]).flatten()

    ref_svg = svg_pre(tok["ref_seg_svg"], tok["ref_seg_svg_packed"], tok["ref_seg_svg_attn_mask_packed"])
    tgt_svg = svg_pre(tok["target_seg_svg"], tok["target_seg_svg_packed"], tok["target_seg_svg_attn_mask_packed"])

    feed_t = dict(
        ref_line_image=tok["ref_line_image"].float(),
        ref_sdf=sdf_like_cupy(tok["ref_line_image"].float() / 255),
        ref_seg_lowres=lowres_seg(tok["ref_seg_image"].long(), lowres_hw),
        target_line_image=tok["target_line_image"].float(),
        target_sdf=sdf_like_cupy(tok["target_line_image"].float() / 255),
        target_seg_lowres=lowres_seg(tok["target_seg_image"].long(), lowres_hw),
        ref_svg_packed_nopad=ref_svg[0],
        ref_svg_attn_nopad=ref_svg[1],
        ref_svg_flat_idx=ref_svg[2],
        ref_svg_cmd_slot_idx=ref_svg[3],
        ref_svg_slot_counts=ref_svg[4],
        target_svg_packed_nopad=tgt_svg[0],
        target_svg_attn_nopad=tgt_svg[1],
        target_svg_flat_idx=tgt_svg[2],
        target_svg_cmd_slot_idx=tgt_svg[3],
        target_svg_slot_counts=tgt_svg[4],
        ref_colors=tok["ref_colors"].long(),
        ref_color_ids=tok["ref_color_ids"].long(),
        target_colors=tok["target_colors"].long(),
        target_color_ids=tok["target_color_ids"].long(),
        packed_gather_idx=torch.cat([ref_idx, tgt_idx + tok["ref_colors"].shape[1]]),
        packed_attn_mask=torch.ones(1, len(ref_idx) + len(tgt_idx), dtype=torch.bool),
    )
    return feed_t, ref_idx, tgt_idx


def pad_feed_to_bucket(feed_t, bucket):
    """Pad every dynamic dim of a build_feed() result to fixed bucket sizes so
    ONE static-shape compile (CoreML) serves many inputs. bucket = dict with
    slots (per side), rows (svg rows per side), cmds, flat (valid commands per
    side), length (decoder tokens). Real decoder tokens stay a PREFIX of the
    packed sequence (pads go last, masked False), so RoPE positions of real
    tokens are unchanged and valid outputs are bit-comparable to the unpadded
    run. Returns the padded feed; the caller keeps slicing target rows at
    [n_ref : n_ref+n_tgt] as before."""
    f = dict(feed_t)
    s_ref = f["ref_colors"].shape[1]
    s_tgt = f["target_colors"].shape[1]
    sb, rb, cb = bucket["slots"], bucket["rows"], bucket["cmds"]
    vb, lb = bucket["flat"], bucket["length"]
    assert sb >= max(s_ref, s_tgt) + 1, "bucket too small (slots)"

    def pad_to(t, shape, value):
        out = torch.full(shape, value, dtype=t.dtype)
        out[tuple(slice(0, d) for d in t.shape)] = t
        return out

    for side in ("ref", "target"):
        f[f"{side}_colors"] = pad_to(f[f"{side}_colors"], (1, sb, 4), 0)
        f[f"{side}_color_ids"] = pad_to(f[f"{side}_color_ids"], (1, sb), -100)
        f[f"{side}_svg_slot_counts"] = pad_to(f[f"{side}_svg_slot_counts"], (sb,), 0.0)
        # the command dim is per-side (each side's tokenization pads to its
        # own max commands-per-segment)
        r, c = f[f"{side}_svg_packed_nopad"].shape[:2]
        assert rb >= r and cb >= c, "bucket too small (rows/cmds)"
        f[f"{side}_svg_packed_nopad"] = pad_to(
            f[f"{side}_svg_packed_nopad"], (rb, cb, 6), -100.0)
        # pad-row attention = identity so no softmax row is fully masked
        attn = torch.eye(cb, dtype=torch.bool).expand(rb, cb, cb).clone()
        attn[:r, :c, :c] = f[f"{side}_svg_attn_nopad"]
        f[f"{side}_svg_attn_nopad"] = attn
        # flat positions are w.r.t. the flattened rows*cmds layout — remap to
        # the padded cmd stride, then pad; pad commands scatter into the LAST
        # slot, which is guaranteed padding (sb > real slots) so their sums
        # are never gathered
        flat = f[f"{side}_svg_flat_idx"]
        flat = (flat // c) * cb + (flat % c)
        v = flat.shape[0]
        assert vb >= v, "bucket too small (flat)"
        f[f"{side}_svg_flat_idx"] = pad_to(flat, (vb,), 0)
        f[f"{side}_svg_cmd_slot_idx"] = pad_to(f[f"{side}_svg_cmd_slot_idx"], (vb,), sb - 1)

    gather = f["packed_gather_idx"]
    n_real = gather.shape[0]
    assert lb >= n_real, "bucket too small (length)"
    # re-offset target entries onto the padded concat axis, pads point at 0
    gather = torch.where(gather >= s_ref, gather - s_ref + sb, gather)
    f["packed_gather_idx"] = pad_to(gather, (lb,), 0)
    f["packed_attn_mask"] = pad_to(f["packed_attn_mask"], (1, lb), False)
    return f


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out-dir", default="/tmp/ant_v2_onnx")
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--skip-export", action="store_true", help="parity on an existing export")
    ap.add_argument("--skip-cpu", action="store_true", help="skip the ORT-CPU stage (fp16 on CPU is emulated and very slow)")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    onnx_path = os.path.join(args.out_dir, "ant_v2.onnx")

    import onnxruntime as ort
    from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline

    # The production forward REQUIRES CUDA (compute_sdf_cupy), so the torch
    # reference runs on GPU under production semantics (bf16 autocast). The
    # wrapper/export then run on CPU fp32 with the same weights — stage 1
    # therefore measures restructuring + precision together, judged by argmax.
    if not torch.cuda.is_available():
        sys.exit("needs a CUDA GPU for the production reference forward")
    print("== load pipeline (CUDA, production semantics) ==")
    pipeline = AnTV2Pipeline.from_pretrained(checkpoint=args.checkpoint, verbose=False, device="cuda")
    pipeline.model.to("cuda")
    model = pipeline.model.eval()

    print("== build real tokenized inputs (trapped-ball seg maps) ==")
    line_ref, line_tgt, color_ref = draw_fixture_frames()
    seg_ref = seg_map_for(line_ref)
    seg_tgt = seg_map_for(line_tgt)
    prep = pipeline.preprocess(inputs={
        "ref_seg_image": seg_ref,
        "ref_line_image": line_ref,
        "target_seg_image": seg_tgt,
        "target_line_image": line_tgt,
        "ref_color_image": color_ref,
    })
    tok_gpu = {k: v.to("cuda") for k, v in prep["tokenized"].items()}

    print("== torch reference (production forward on GPU, inference mode) ==")
    with torch.inference_mode():
        ref_out = model(**tok_gpu)
    ref_logits = ref_out.target_color_logits.float().cpu().clone()          # 1 x T x U
    ref_ids = ref_out.target_color_id_predictions.cpu().clone()             # 1 x T
    print(f"  target segments: {ref_ids.shape[1]}, palette slots: {ref_logits.shape[-1]}")

    # Everything below runs on CPU fp32 with the same weights.
    model = model.float().cpu().eval()
    tok = {k: v.cpu() for k, v in tok_gpu.items()}
    torch.cuda.empty_cache()

    print("== derived pre-processing inputs (sdf, low-res seg, gather idx) ==")
    lowres_hw = probe_lowres_hw(model, tok)
    print(f"  unet lowres: {lowres_hw}")
    feed_t, ref_idx, tgt_idx = build_feed(tok, lowres_hw)
    print(f"  packed layout: {len(ref_idx)} ref + {len(tgt_idx)} target")

    print("== stage 1: eager wrapper vs production forward ==")
    wrapper = AnTV2ExportWrapper(model).eval()
    with torch.no_grad():
        packed_logits = wrapper(**feed_t)
    wrap_target_logits = packed_logits[:, len(ref_idx):, :]
    diff = (wrap_target_logits - ref_logits).abs().max().item()
    ids_match = (wrap_target_logits.argmax(-1) == ref_ids).all().item()
    # Logits differ by bf16-vs-fp32 noise (the reference ran under autocast);
    # the production-parity criterion is the color-id ARGMAX.
    print(f"  logits max diff {diff:.2e} (bf16 vs fp32); argmax match: {ids_match}")
    if not ids_match:
        sys.exit("stage 1 FAILED — wrapper does not reproduce production color ids")

    input_names = list(feed_t.keys())
    if not args.skip_export:
        print("== export ==")
        dyn = {}
        for k in input_names:
            t = feed_t[k]
            if "line" in k or "sdf" in k or "lowres" in k:
                dyn[k] = {2: f"{k}_h", 3: f"{k}_w"}
            elif "svg_packed" in k:
                # the command dim is the tokenizer's per-input max commands
                # per segment (14 on the fixture, 89 on robot.cdm) — dynamic
                dyn[k] = {0: f"{k}_rows", 1: f"{k}_cmds"}
            elif "svg_attn" in k:
                dyn[k] = {0: f"{k}_rows", 1: f"{k}_cmds", 2: f"{k}_cmds"}
            elif k.endswith("_idx") or k.endswith("_counts"):
                dyn[k] = {0: k}
            elif t.dim() >= 2:
                dyn[k] = {1: f"{k}_slots"}
        torch.onnx.export(
            wrapper, tuple(feed_t.values()), onnx_path, opset_version=18,
            input_names=input_names, output_names=["packed_logits"],
            dynamic_axes={**dyn, "packed_logits": {1: "packed_len"}},
        )
        size = sum(os.path.getsize(os.path.join(args.out_dir, f)) for f in os.listdir(args.out_dir))
        print(f"  exported -> {onnx_path} (total {size / 1e6:.1f} MB)")
        if args.fp16:
            from onnxruntime.transformers.float16 import convert_float_to_float16
            import onnx
            m = onnx.load(onnx_path)
            m = convert_float_to_float16(m, keep_io_types=True)
            onnx.save(m, onnx_path)
            print(f"  fp16 -> {os.path.getsize(onnx_path) / 1e6:.1f} MB")

    feed_np = {k: v.numpy() for k, v in feed_t.items()}

    if not args.skip_cpu:
        print("== stage 2: ORT-CPU vs eager wrapper ==")
        cpu = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        out_cpu = cpu.run(None, feed_np)[0][:, len(ref_idx):, :]
        diff_cpu = np.abs(out_cpu - wrap_target_logits.numpy()).max()
        ids_cpu = out_cpu.argmax(-1)
        agree_cpu = (ids_cpu == ref_ids.numpy()).mean() * 100
        print(f"  logits max diff {diff_cpu:.2e}; argmax agreement {agree_cpu:.2f}%")

    if "CUDAExecutionProvider" in ort.get_available_providers():
        print("== stage 3: ORT-CUDA ==")
        gpu = ort.InferenceSession(
            onnx_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        out_gpu = gpu.run(None, feed_np)[0][:, len(ref_idx):, :]
        diff_gpu = np.abs(out_gpu - wrap_target_logits.numpy()).max()
        ids_gpu = out_gpu.argmax(-1)
        agree_gpu = (ids_gpu == ref_ids.numpy()).mean() * 100
        print(f"  logits max diff {diff_gpu:.2e}; argmax agreement {agree_gpu:.2f}%")
        gpu.run(None, feed_np)  # warmup
        t0 = time.time()
        for _ in range(5):
            gpu.run(None, feed_np)
        print(f"  ORT-CUDA forward: {(time.time() - t0) / 5 * 1000:.1f} ms")

    print("DONE")


if __name__ == "__main__":
    main()
