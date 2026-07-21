"""Visualize a featurized sequence pickle.

Featurized pickles only store encoder features (not images), but every pickle
records its `aug_seed`, variant_idx, and the encoder checkpoint, so we can
fully reproduce the augmented seg/line/color frames by replaying the ingest
pipeline on the source Sequence pickle.

For each frame we render three panels: colorized seg, line art, filled color.
Output is one PNG per featurized pickle, plus a side-by-side comparison if
multiple pickles are passed.

Usage:
    python -m colorize.scripts.visualize_featurized_sequence \\
        --featurized_path datasets/real-data-/featurized/v01/<scene>.pkl \\
        --output_path /tmp/vis.png

    # Compare clean vs augmented:
    python -m colorize.scripts.visualize_featurized_sequence \\
        --featurized_path datasets/real-data-/featurized/v00/<scene>.pkl \\
                          datasets/real-data-/featurized/v01/<scene>.pkl \\
        --output_path /tmp/compare.png
"""
from typing import *
import argparse
import os
import random

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from colorize.common.featurized_sequence import FeaturizedSequence
from colorize.common.image import ImageArgs
from colorize.common.sequence import Sequence
from colorize.scripts.featurize_sequences import _load_sequence
from colorize.vectorization.vtrace import VecArgs
from segmentation.trapped_ball.trapped_ball import show_fill_map


PANEL_SIZE = 1024  # one side length per panel; matches ImageArgs.width


def _scene_id_from_featurized_path(p: str) -> str:
    return os.path.splitext(os.path.basename(p))[0]


def _source_path_for(featurized_path: str, input_path: str) -> str:
    scene_id = _scene_id_from_featurized_path(featurized_path)
    return os.path.join(input_path, 'sequences', f'{scene_id}.pkl')


def reproduce_frames(
    featurized_path: str,
    input_path: str,
) -> Tuple[Sequence, FeaturizedSequence]:
    """Replay the ingest pipeline to materialize the augmented seg/line/color
    images that produced this featurized pickle."""
    import time
    fs = FeaturizedSequence.load(featurized_path)
    src_path = _source_path_for(featurized_path, input_path)
    aug_seed = fs.metadata['aug_seed']
    augment = fs.variant_idx != 0  # v00 is clean by convention
    print(f"  [variant={fs.variant_idx} augment={augment} aug_seed={aug_seed}]")

    random.seed(aug_seed)
    np.random.seed(aug_seed)
    torch.manual_seed(aug_seed)

    t0 = time.time(); seq = _load_sequence(src_path); print(f"  load_sequence: {time.time()-t0:.2f}s")
    t0 = time.time(); seq.materialize(color_source='color_list'); print(f"  materialize: {time.time()-t0:.2f}s")
    t0 = time.time()
    seq.prepare_images_for_training(
        augment=augment,
        image_args=ImageArgs(**fs.metadata['image_args']),
        vec_args=VecArgs(**fs.metadata['vec_args']),
        verbose=False,
    )
    print(f"  prepare_images_for_training: {time.time()-t0:.2f}s")
    return seq, fs


def _panel_from_array(arr: np.ndarray, mode: Optional[str] = None) -> Image.Image:
    if mode is None:
        if arr.ndim == 2:
            mode = 'L'
        elif arr.shape[2] == 4:
            mode = 'RGBA'
        else:
            mode = 'RGB'
    if mode == 'L':
        arr = arr.astype(np.uint8)
    return Image.fromarray(arr, mode=mode).convert('RGB')


def _render_filled_safe(seg_image: np.ndarray, color_list: List[int]) -> np.ndarray:
    """Same as SegImageFrame.render_as_image, but doesn't crash when seg has -100 padding.

    Pre-existing bug in render_as_image: it does `lookup[seg]` before applying the
    null_mask, so negative IDs go out of bounds. We replace -100 with 0 for the
    lookup and apply the null color afterward.
    """
    from colorize.common.ops import rgba_to_dense_flat, dense_to_rgba
    lookup = np.array(color_list)
    null_mask = seg_image == -100
    safe_seg = np.where(null_mask, 0, seg_image)
    color_image_int32 = lookup[safe_seg]
    color_image_int32[null_mask] = rgba_to_dense_flat(np.array((0, 0, 0, 0)))
    return dense_to_rgba(color_image_int32).astype(np.uint8)


def render_frame_panels(
    seq: Sequence,
    frame_idx_in_seq: int,
) -> Tuple[Image.Image, Image.Image, Image.Image]:
    """Three panels for one frame: colorized-seg, line, filled-color."""
    frame = seq.frames[frame_idx_in_seq]

    # colorized seg — show_fill_map allocates `randint((max(fillmap)+1, 3))`,
    # so we MUST replace -100 padding with a valid in-range value first or
    # numpy tries to allocate a ~12GB color table.
    seg = frame.seg_frame.image_data
    seg_for_vis = np.where(seg == -100, 0, seg).astype(np.uint32)
    seg_vis = show_fill_map(seg_for_vis)
    seg_vis[seg == -100] = (0, 0, 0)
    seg_panel = _panel_from_array(seg_vis, mode='RGB' if seg_vis.shape[-1] == 3 else 'RGBA')

    line_panel = _panel_from_array(frame.line_frame.image_data)
    filled_panel = _panel_from_array(_render_filled_safe(seg, frame.color_list))

    return seg_panel, line_panel, filled_panel


def assemble_grid(
    seq: Sequence,
    fs: FeaturizedSequence,
    title: str,
) -> Image.Image:
    """Assemble a (#frames) x 3 grid for one sequence."""
    n_frames = len(seq.frames)
    cell = PANEL_SIZE
    pad = 16
    header_h = 64
    grid_w = 3 * cell + 4 * pad
    grid_h = header_h + n_frames * (cell + pad) + pad

    canvas = Image.new('RGB', (grid_w, grid_h), color=(20, 20, 20))
    draw = ImageDraw.Draw(canvas)

    label = (f"{title}  variant={fs.variant_idx}  aug_seed={fs.metadata.get('aug_seed')}  "
             f"frames={n_frames}  palette_colors={len(fs.palette.color_list)}")
    draw.text((pad, pad), label, fill=(220, 220, 220))

    headers = ['seg (colorized by id)', 'line', 'filled (seg x palette)']
    for i, h in enumerate(headers):
        x = pad + i * (cell + pad)
        draw.text((x, header_h - 18), h, fill=(140, 140, 140))

    for i in range(n_frames):
        seg_p, line_p, fill_p = render_frame_panels(seq, i)
        y = header_h + i * (cell + pad)
        canvas.paste(seg_p, (pad, y))
        canvas.paste(line_p, (pad + cell + pad, y))
        canvas.paste(fill_p, (pad + 2 * (cell + pad), y))
        draw.text((4, y + cell // 2 - 6), f"f{seq.frames[i].idx}", fill=(180, 180, 180))

    return canvas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--featurized_path', nargs='+', required=True,
                        help='One or more featurized pickle paths. Multiple paths are laid out side by side.')
    parser.add_argument('--input_path', default='datasets/real-data-',
                        help='Dataset root containing sequences/*.pkl. '
                             'Inferred from featurized_path if it lives under <input_path>/featurized/.')
    parser.add_argument('--output_path', required=True)
    args = parser.parse_args()

    grids = []
    for fp in args.featurized_path:
        # try to infer input_path if the featurized path is under it
        if '/featurized/' in fp:
            inferred_input = fp.split('/featurized/')[0]
        else:
            inferred_input = args.input_path
        print(f"Reproducing {fp}  (input root: {inferred_input})")
        seq, fs = reproduce_frames(fp, inferred_input)
        title = os.path.relpath(fp, inferred_input)
        grids.append(assemble_grid(seq, fs, title))

    # stitch side by side
    pad = 12
    total_w = sum(g.width for g in grids) + pad * (len(grids) + 1)
    total_h = max(g.height for g in grids) + 2 * pad
    canvas = Image.new('RGB', (total_w, total_h), color=(10, 10, 10))
    x = pad
    for g in grids:
        canvas.paste(g, (x, pad))
        x += g.width + pad

    canvas.save(args.output_path)
    print(f"Wrote {args.output_path}  ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main()
