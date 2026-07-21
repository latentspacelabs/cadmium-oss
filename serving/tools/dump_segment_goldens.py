"""Dump per-stage goldens for the /segment classical path (R2 port gate).

Replays `compute_seg_fast`'s exact call sequence with a dump after every
stage, so the Rust port (sidecar/src/segment) can be verified byte-exact
stage by stage — a divergence localizes to one cv2 op instead of "the seg
map is different". The replay is asserted equal to the real
`run_segment`-path output at the end, so the goldens cannot drift from
production.

Run with PRODUCTION's cv2 (wallace, the server env):

    python serving/serving/tools/dump_segment_goldens.py /tmp/robot_corpus /tmp/segment_goldens

Layout per drawing (all .npy, C-order, little-endian):
    <out>/<name>/line.png          the RGBA input, verbatim copy
    <out>/<name>/01_binary.npy     u8   binarize(_, 'adaptive_mean')
    <out>/<name>/02_tb_r2.npy      u8   marked result after trapped-ball r=2 (method='max')
    <out>/<name>/03_tb_r1.npy      u8   after trapped-ball r=1 (method=None)
    <out>/<name>/04_tb_r0.npy      u8   after trapped-ball r=0 (method=None)
    <out>/<name>/05_fillmap.npy    i32  build_fill_map after flood_fill_multi
    <out>/<name>/06_merged.npy     i32  merge_fill(fillmap, 10, min_seg_size)
    <out>/<name>/07_thinned.npy    i32  thinning(merged)
    <out>/<name>/08_final.npy      i32  relabeled (np.unique return_inverse)
    <out>/<name>/meta.json         fill counts per stage, num_regions, params
"""
import glob
import json
import os
import shutil
import sys

import numpy as np

from segmentation.trapped_ball.line import binarize
from segmentation.trapped_ball.trapped_ball import (
    build_fill_map,
    compute_seg_fast,
    flood_fill_multi,
    mark_fill,
    merge_fill,
    thinning,
    trapped_ball_fill_multi,
)

TB_SIZES = [2, 1, 0]      # process_image defaults (the production /segment path)
MAX_ITER = 10
MIN_SEG_SIZE = 10


def dump_one(png_path: str, out_dir: str):
    import cv2

    os.makedirs(out_dir, exist_ok=True)
    img = cv2.imread(png_path, cv2.IMREAD_UNCHANGED)
    assert img is not None and img.ndim == 3 and img.shape[2] == 4, png_path
    shutil.copyfile(png_path, os.path.join(out_dir, "line.png"))

    def save(stem, arr):
        np.save(os.path.join(out_dir, stem + ".npy"), np.ascontiguousarray(arr))

    meta = {"tb_sizes": TB_SIZES, "max_iter": MAX_ITER, "min_seg_size": MIN_SEG_SIZE,
            "fills_per_stage": []}

    binary = binarize(img, type="adaptive_mean")
    save("01_binary", binary)

    # compute_seg_fast's exact sequence, dumped stage by stage
    fills = []
    result = binary
    for stem, (radius, method) in zip(
        ["02_tb_r2", "03_tb_r1", "04_tb_r0"],
        [(TB_SIZES[0], "max"), (TB_SIZES[1], None), (TB_SIZES[2], None)],
    ):
        fill = trapped_ball_fill_multi(result, radius, method=method)
        fills += fill
        result = mark_fill(result, fill)
        save(stem, result)
        meta["fills_per_stage"].append(len(fill))

    fill = flood_fill_multi(result)
    fills += fill
    meta["fills_per_stage"].append(len(fill))

    fillmap = build_fill_map(result, fills)
    save("05_fillmap", fillmap)

    merged = merge_fill(fillmap, MAX_ITER, MIN_SEG_SIZE)
    save("06_merged", merged)

    thinned = thinning(merged)
    save("07_thinned", thinned)

    unique, final = np.unique(thinned, return_inverse=True)
    final = final.reshape(binary.shape).astype(np.int32)
    save("08_final", final)
    meta["num_labels"] = int(unique.shape[0])

    # the goldens must be production, not a paraphrase of it
    reference = compute_seg_fast(
        binarize(img, type="adaptive_mean"),
        tb_sizes=TB_SIZES, max_iter=MAX_ITER, min_seg_size=MIN_SEG_SIZE,
    )
    assert np.array_equal(final, reference), f"replay drifted from compute_seg_fast: {png_path}"

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return meta["num_labels"]


def main():
    corpus_dir, out_root = sys.argv[1], sys.argv[2]
    pngs = sorted(glob.glob(os.path.join(corpus_dir, "lineLayer*_f*.png")))
    assert pngs, f"no line PNGs in {corpus_dir}"
    for p in pngs:
        name = os.path.basename(p).split("_")[1]  # fNNN
        n = dump_one(p, os.path.join(out_root, name))
        print(f"{name}: {n} labels")
    print("all goldens dumped + replay-verified against compute_seg_fast")


if __name__ == "__main__":
    main()
