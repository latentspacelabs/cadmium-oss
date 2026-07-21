"""Pre-featurize raw Sequence pickles for AnT V3 training.

For each scene in `--input_path/sequences/*.pkl`, runs `--num_variants` full
augmentation passes. Each pass:
  1. materialize() the scene
  2. prepare_images_for_training(augment=True) — vectorize + augment per frame
  3. forward each frame through the frozen image + SVG encoders
  4. write a `FeaturizedSequence` pickle to:
       `<output_path>/featurized/v{k:02d}/<scene_id>.pkl`

V3's `FeaturizedSequenceDatamodule` then samples (refs, target) tuples directly
from these pickles, skipping vectorization and the encoder forward at train
time.

Encoder weights are loaded from a V2 checkpoint (`--checkpoint`); the
checkpoint path is recorded in each pickle's metadata for reproducibility.
"""
from typing import *
import argparse
import gc
import glob
import json
import os
import pickle
import random
import subprocess
import time
import tracemalloc

import numpy as np
import torch
from tqdm import tqdm

try:
    import psutil
    _PROC = psutil.Process()
except Exception:
    _PROC = None


def _rss_gb() -> float:
    if _PROC is None:
        return -1.0
    return _PROC.memory_info().rss / (1024 ** 3)


# glibc malloc keeps freed pages in its arenas rather than returning them to
# the kernel — without this our RSS climbs ~4 MB per processed frame even
# after Python/numpy have released the underlying objects. Calling
# malloc_trim(0) tells glibc to release whatever's currently free in the
# main arena back to the OS.
try:
    import ctypes
    _LIBC = ctypes.CDLL("libc.so.6")
    _LIBC.malloc_trim.argtypes = [ctypes.c_size_t]
    _LIBC.malloc_trim.restype = ctypes.c_int
except Exception:
    _LIBC = None


def _malloc_trim() -> None:
    if _LIBC is not None:
        _LIBC.malloc_trim(0)

from colorize.ant_v1.model_ant_v1 import AnTV1Model
from colorize.ant_v2.model_ant_v2 import AnTV2Model
from colorize.common.featurized_sequence import FeaturizedFrame, FeaturizedSequence
from colorize.common.frame import MaterializedKeyFrame
from colorize.common.image import ImageArgs, prepare_image
from colorize.common.packing import pack_sequences
from colorize.common.sequence import Sequence
from colorize.vectorization.vtrace import VecArgs, unpad_seg_image


class _LegacyUnpickler(pickle.Unpickler):
    """Loads old pickles whose class paths still reference the pre-rename
    `modeling_torch.*` package as the current `colorize.*` package."""

    def find_class(self, module: str, name: str):
        if module == 'modeling_torch':
            module = 'colorize'
        elif module.startswith('modeling_torch.'):
            module = 'colorize.' + module[len('modeling_torch.'):]
        return super().find_class(module, name)


def _load_sequence(path: str) -> Sequence:
    with open(path, 'rb') as f:
        return _LegacyUnpickler(f).load()


MAX_VEC_SEQ_LENGTH = 256  # must match SVGEncoder's Llama max_position_embeddings


def _build_encoder_inputs_for_frame(
    seg_image_np: np.ndarray,        # H x W
    line_image_np: np.ndarray,       # H x W x 4
    svg,                             # SVG, has .to_tensor() and .paths
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """Build batch-of-1 inputs for the frozen image + SVG encoders.

    When augmentation drops a segment, prepare_resized_seg_for_vtrace produces
    an id_map that vtracer uses to renumber paths 0..N-1, but the seg image
    pixels still carry the original (now non-contiguous) IDs. Feeding that
    directly to the encoder's scatter-based pool blows up with a CUDA
    out-of-bounds assert (idx_dim < index_size fails). Remap the seg pixel
    values via the same id_map so seg values and svg.paths indices agree.
    """
    # image encoder inputs
    if svg.id_map is not None:
        seg_image_np = unpad_seg_image(seg_image_np, svg.id_map)

    seg = torch.from_numpy(seg_image_np).unsqueeze(0).unsqueeze(0).to(torch.int32)   # [1, 1, H, W]
    line = torch.from_numpy(line_image_np).permute(2, 0, 1).unsqueeze(0).float()     # [1, 4, H, W]

    num_segments = len(svg.paths)
    seg_padding_mask = torch.zeros((1, num_segments), dtype=torch.bool)              # [1, S]

    # svg encoder inputs. With id_map set, SVG.to_tensor() would insert null
    # placeholders for dropped IDs and return [M, C, 6] — but we've already
    # remapped the seg pixels to N contiguous IDs, so we want [N, C, 6] from
    # the surviving paths only. Bypass the id_map path by clearing/restoring
    # the attribute around the call.
    saved_id_map = svg.id_map
    try:
        svg.id_map = None
        svg_tensor = svg.to_tensor(return_point_dim=False)                           # [S, C, 6]
    finally:
        svg.id_map = saved_id_map

    # Match AnTV1Tokenizer.get_vec_tokens behavior: if any segment has more
    # path commands than the SVG encoder's positional capacity, subsample
    # MAX_VEC_SEQ_LENGTH indices (with replacement, sorted) and slice. Without
    # this we'd feed an out-of-range sequence to SVGEncoder's Llama and trash
    # the resulting features.
    num_commands = svg_tensor.shape[1]
    if num_commands > MAX_VEC_SEQ_LENGTH:
        print(f"Truncating: {num_commands} commands -> {MAX_VEC_SEQ_LENGTH}")
        truncated_indices = np.sort(np.random.randint(0, num_commands, MAX_VEC_SEQ_LENGTH))
        svg_tensor = svg_tensor[:, truncated_indices]

    svg_tensor = svg_tensor.unsqueeze(0)                                             # [1, S, C, 6]
    svg_packed, _, svg_attn_mask = pack_sequences(svg_tensor.squeeze(0))             # [P, C, 6], [P, C, C]
    # pack_sequences expects [B, S, F]; we squeezed the batch dim. Re-add it
    # to match the encoder's expected shape: packed inputs are themselves
    # batched in the encoder ([N, P, C, 6] when N>1, or [P, C, 6] for N=1).
    # We pass batch=1 and expand dims accordingly:
    svg_packed = svg_packed.unsqueeze(0)            # [1, P, C, 6]
    svg_attn_mask = svg_attn_mask.unsqueeze(0)      # [1, P, C, C]

    return seg, line, seg_padding_mask, svg_tensor, svg_packed, svg_attn_mask


@torch.inference_mode()
def featurize_frame(
    img_feat_extractor,
    svg_feat_extractor,
    seg: torch.Tensor,
    line: torch.Tensor,
    seg_padding_mask: torch.Tensor,
    svg_tensor: torch.Tensor,
    svg_packed: torch.Tensor,
    svg_attn_mask: torch.Tensor,
    device: torch.device,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Forward through image + SVG encoders. Returns ([S, F_img], [S, F_svg]) on CPU bf16."""
    seg = seg.to(device)
    line = line.to(device)
    seg_padding_mask = seg_padding_mask.to(device)
    svg_tensor = svg_tensor.to(device)
    svg_packed = svg_packed.to(device)
    svg_attn_mask = svg_attn_mask.to(device)

    with torch.autocast(device_type=device.type, dtype=torch.bfloat16):
        image_feats, _ = img_feat_extractor(
            seg=seg,
            line=line / 255,
            padding_mask=seg_padding_mask,
        )  # [1, S, F]
        svg_feats = svg_feat_extractor(
            seg_cmd_points=svg_tensor,
            seg_cmd_points_packed=svg_packed,
            seg_cmd_attn_mask_packed=svg_attn_mask,
        )  # [1, S, F]

    image_feats = image_feats.squeeze(0).to(torch.bfloat16).cpu()
    svg_feats = svg_feats.squeeze(0).to(torch.bfloat16).cpu()
    return image_feats, svg_feats


def featurize_one_variant(
    seq_path: str,
    img_feat_extractor,
    svg_feat_extractor,
    image_args: ImageArgs,
    vec_args: VecArgs,
    device: torch.device,
    variant_idx: int,
    metadata: Dict[str, Any],
    aug_seed: int,
    augment: bool,
) -> Optional[FeaturizedSequence]:
    """One pass over one scene. variant_idx=0 is the clean (unaugmented) pass.

    Frames are materialized → augmented → vectorized → encoded → freed one at
    a time. The previous all-at-once approach (seq.materialize() then
    seq.prepare_images_for_training()) kept all N frames' seg/line/color
    arrays resident simultaneously, which made the per-scene HWM scale with
    frame count and pushed RSS past 14 GB on 100-frame scenes. Per-frame
    processing bounds the HWM to ~one frame's working set (~700 MB on top of
    the encoder), regardless of scene size.

    RNG consumption is identical to the old flow: seed once at the start,
    iterate frames in order. materialize doesn't draw from random state, so
    the augmentation outputs are byte-identical to the previous flow.
    """
    # set RNGs so this variant is reproducible
    random.seed(aug_seed)
    np.random.seed(aug_seed)
    torch.manual_seed(aug_seed)

    seq: Sequence = _load_sequence(seq_path)
    palette = seq.palette
    keyframes = seq.frames
    # release the Sequence object early; we keep our own references.
    del seq

    featurized_frames: List[FeaturizedFrame] = []
    for keyframe in keyframes:
        # materialize THIS frame only (reads its seg/line/color PNGs)
        mkf = MaterializedKeyFrame.from_keyframe(keyframe, color_source="color_list")

        # augment + vectorize THIS frame
        seg_img, line_img, color_img, svg = prepare_image(
            seg_image=mkf.seg_frame.image_data,
            line_image=mkf.line_frame.image_data,
            image_args=image_args,
            vec_args=vec_args,
            augment=augment,
            color_image=mkf.color_frame.image_data if mkf.color_frame is not None else None,
            verbose=False,
        )

        num_segments = len(svg.paths)
        if num_segments == 0:
            del mkf, seg_img, line_img, color_img, svg
            continue

        # encode
        seg_t, line_t, seg_pad, svg_t, svg_p, svg_attn = _build_encoder_inputs_for_frame(
            seg_image_np=seg_img,
            line_image_np=line_img,
            svg=svg,
        )
        image_feats, svg_feats = featurize_frame(
            img_feat_extractor=img_feat_extractor,
            svg_feat_extractor=svg_feat_extractor,
            seg=seg_t, line=line_t, seg_padding_mask=seg_pad,
            svg_tensor=svg_t, svg_packed=svg_p, svg_attn_mask=svg_attn,
            device=device,
        )

        # Palette stores color_ids in *original* segment-ID order (length = M).
        # If id_map renumbered surviving segments to 0..N-1, take only the
        # surviving slots in their new order so color_ids aligns with the
        # encoder features (also length N).
        original_color_ids = palette.get_color_id_list_for_frame(keyframe.idx)
        id_map = svg.id_map
        if id_map is not None:
            new_to_old = {new: old for old, new in id_map.items() if new is not None}
            ordered = [original_color_ids[new_to_old[i]] for i in range(num_segments)]
        else:
            ordered = original_color_ids
        color_ids = torch.tensor(ordered, dtype=torch.int32)

        featurized_frames.append(FeaturizedFrame(
            idx=keyframe.idx,
            num_segments=num_segments,
            image_feats=image_feats,
            svg_feats=svg_feats,
            color_ids=color_ids,
        ))

        # Drop the per-frame raw data so the next iteration's materialize
        # doesn't stack on top of it. malloc_trim() at the end of the scene
        # then returns those pages to the OS.
        del mkf, seg_img, line_img, color_img, svg
        del seg_t, line_t, seg_pad, svg_t, svg_p, svg_attn

    if len(featurized_frames) < 2:
        return None

    return FeaturizedSequence(
        frames=featurized_frames,
        palette=palette,
        variant_idx=variant_idx,
        metadata={**metadata, 'aug_seed': aug_seed},
    )


def _git_sha() -> str:
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'],
            cwd=os.path.dirname(os.path.abspath(__file__)),
        ).decode().strip()
    except Exception:
        return 'unknown'


def _scene_id_from_path(seq_path: str) -> str:
    return os.path.splitext(os.path.basename(seq_path))[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input_path", type=str, required=True,
                        help="Dataset root containing sequences/*.pkl")
    parser.add_argument("--output_path", type=str, required=True,
                        help="Where to write featurized_sequences/v{kk}/*.pkl. "
                             "If unset, defaults to --input_path.")
    parser.add_argument("--num_variants", type=int, default=4)
    parser.add_argument("--checkpoint", type=str, required=True,
                        help="V2 or V1 checkpoint to source frozen encoder weights from.")
    parser.add_argument("--device", type=str, default="cuda")
    parser.add_argument("--seed_base", type=int, default=0,
                        help="Per-(scene, variant) aug seed = seed_base + variant_idx * num_scenes + scene_idx")
    parser.add_argument("--skip_existing", action="store_true",
                        help="Skip (scene, variant) pairs whose pickle already exists")
    parser.add_argument("--shard_idx", type=int, default=0,
                        help="Index of this shard (for multi-process ingest)")
    parser.add_argument("--num_shards", type=int, default=1,
                        help="Total number of shards. Each shard handles scenes where "
                             "scene_idx %% num_shards == shard_idx.")
    parser.add_argument("--max_scenes", type=int, default=None,
                        help="If set, only process this many scenes (after sharding). Useful for smoke tests.")
    parser.add_argument("--profile_mem", action="store_true",
                        help="Enable tracemalloc + RSS logging. Every --profile_every scenes, gc.collect() "
                             "+ dump top allocators and the diff vs the previous snapshot.")
    parser.add_argument("--profile_every", type=int, default=5,
                        help="With --profile_mem, take a snapshot every N processed scenes.")
    args = parser.parse_args()
    assert 0 <= args.shard_idx < args.num_shards, "shard_idx must be in [0, num_shards)"

    if args.profile_mem:
        tracemalloc.start(25)
        print(f"[mem] tracemalloc started; initial RSS = {_rss_gb():.2f} GB", flush=True)

    output_path = args.output_path or args.input_path
    device = torch.device(args.device)

    # load encoders from the checkpoint — dispatch on the config.json model_type
    # rather than the path, since checkpoint names don't follow a strict convention.
    config_path = os.path.join(args.checkpoint, 'config.json')
    with open(config_path) as f:
        ckpt_config = json.load(f)
    model_type = ckpt_config.get('model_type', '')
    print(f"Checkpoint model_type: {model_type!r}")
    if model_type == 'AnT-v2':
        v2 = AnTV2Model.from_pretrained(args.checkpoint)
        ant_v1 = v2.ant_v1
    elif model_type == 'AnT-v1' or 'ant_v1' in model_type.lower():
        ant_v1 = AnTV1Model.from_pretrained(args.checkpoint)
    else:
        raise ValueError(
            f"Unrecognized checkpoint model_type {model_type!r} at {args.checkpoint}. "
            f"Expected 'AnT-v2' or 'AnT-v1'."
        )

    img_feat_extractor = ant_v1.img_feat_extractor.to(device).eval()
    svg_feat_extractor = ant_v1.svg_feat_extractor.to(device).eval()
    img_feat_extractor.requires_grad_(False)
    svg_feat_extractor.requires_grad_(False)

    image_args = ImageArgs()
    vec_args = VecArgs()

    metadata = {
        'encoder_checkpoint': args.checkpoint,
        'image_args': image_args.__dict__,
        'vec_args': vec_args.__dict__,
        'ingest_git_sha': _git_sha(),
    }

    all_seq_paths = sorted(glob.glob(os.path.join(args.input_path, 'sequences/*.pkl')))
    # carve out this shard's slice; preserve global scene_idx so aug seeds and
    # filenames stay stable across different --num_shards configurations.
    sharded = [(i, p) for i, p in enumerate(all_seq_paths) if i % args.num_shards == args.shard_idx]
    if args.max_scenes is not None:
        sharded = sharded[:args.max_scenes]
    print(f"Found {len(all_seq_paths)} scenes in {args.input_path}/sequences; "
          f"this shard ({args.shard_idx}/{args.num_shards}) will process {len(sharded)}")

    prev_snapshot = None
    processed_count = 0

    for variant_idx in range(args.num_variants):
        out_dir = os.path.join(output_path, f'featurized/v{variant_idx:02d}')
        os.makedirs(out_dir, exist_ok=True)
        print(f"\n=== Variant {variant_idx} -> {out_dir} ===")

        for scene_idx, seq_path in tqdm(sharded, desc=f"v{variant_idx:02d}"):
            scene_id = _scene_id_from_path(seq_path)
            out_path = os.path.join(out_dir, f'{scene_id}.pkl')
            if args.skip_existing and os.path.exists(out_path):
                continue

            aug_seed = args.seed_base + variant_idx * len(all_seq_paths) + scene_idx
            try:
                start = time.time()
                fseq = featurize_one_variant(
                    seq_path=seq_path,
                    img_feat_extractor=img_feat_extractor,
                    svg_feat_extractor=svg_feat_extractor,
                    image_args=image_args,
                    vec_args=vec_args,
                    device=device,
                    variant_idx=variant_idx,
                    metadata=metadata,
                    aug_seed=aug_seed,
                    augment=(variant_idx != 0),
                )
                if fseq is None:
                    print(f"Skipping {scene_id} (no valid frames)")
                    continue
                fseq.save(out_path)
                print(f"Wrote {out_path} ({len(fseq.frames)} frames) in {time.time() - start:.1f}s")
                # Drop the scene's references before trimming so freed memory is
                # actually returnable.
                del fseq
                gc.collect()
                _malloc_trim()

                processed_count += 1
                if args.profile_mem and processed_count % args.profile_every == 0:
                    gc.collect()
                    snap = tracemalloc.take_snapshot()
                    rss = _rss_gb()
                    print(f"\n[mem] after {processed_count} processed scenes  RSS={rss:.2f} GB", flush=True)
                    if prev_snapshot is not None:
                        top_growers = snap.compare_to(prev_snapshot, 'lineno')
                        print(f"[mem] top 15 growers since previous snapshot:")
                        for stat in top_growers[:15]:
                            print(f"  {stat}")
                    print(f"[mem] top 10 by current total size:")
                    for stat in snap.statistics('lineno')[:10]:
                        print(f"  {stat}")
                    print("", flush=True)
                    prev_snapshot = snap
            except Exception as e:
                print(f"FAILED {seq_path}: {e}")
                import traceback
                traceback.print_exc()


if __name__ == "__main__":
    main()
