"""Dump per-stage goldens for the gap-closing /segment path (R2b port gate).

Replays `GapCloser.predict`'s exact body (crop-to-content, edge-stamped
tiling, batched UDF forward, boundary merge, tiled trapped-ball via
`compute_seg_full`, CC merge, relabel, uncrop) with a dump after every
stage, so the Rust port can be verified stage by stage. The replay is
asserted equal to a real `model.predict` call at the end, so the goldens
cannot drift from production.

Run with PRODUCTION's env (wallace, miniconda python, CUDA):

    python serving/tools/dump_gapcloser_goldens.py /tmp/robot_corpus /tmp/gapcloser_goldens \
        --checkpoint ~/dev/cadmium-vision/checkpoints/gap_closer/gap_close_v1_1229.ckpt

Layout per drawing (all .npy, C-order, little-endian):
    <out>/<name>/line.png            the RGBA input, verbatim copy
    <out>/<name>/01_cropped_alpha.npy u8   crop_image(alpha, padding=10) output
    <out>/<name>/02_padded_edge.npy  f32  alpha/255, pad mode='edge', 2px edge stamp
    <out>/<name>/03_tile_boundary.npy u8  [N,512,512] combined boundary per model tile
                                          (values exactly {0,1}: thresholded-UDF
                                          max'd with the inverted tile binarize)
    <out>/<name>/04_merged_boundary.npy u8  255 - merger.merge()*255
    <out>/<name>/05_seg_padded.npy   u8   merged boundary padded (constant 0) for seg tiling
    <out>/<name>/06_tile_segs.npy    i32  [M,512,512] compute_seg_fast per tile + tile_id*256
    <out>/<name>/07_borders.npz      i32  top/bottom/left/right border samples
    <out>/<name>/08_n_labels.npy     i32  scipy connected_components labels (len = M*512)
    <out>/<name>/09_unmerged.npy     u32  seg merger.merge(dtype=uint32)
    <out>/<name>/10_merged.npy       i64  n_labels[unmerged]
    <out>/<name>/11_final.npy        u8   unique/return_inverse relabel + uncrop
    <out>/<name>/12_boundary_final.npy u8 merged boundary after uncrop (the
                                          boundary /segment actually returns)
    <out>/<name>/meta.json           geometry, params, versions
"""
import argparse
import glob
import json
import os
import shutil
import sys

import numpy as np
import torch

from tiler import Tiler, Merger

from segmentation.gap_closing.gap_closer import GapCloser
from segmentation.trapped_ball.cropping import crop_image, uncrop
from segmentation.trapped_ball.parallel import (
    _seg_worker,
    build_border_data,
    compute_cc,
)

# run_segment production defaults: strength 1.0 -> udf_threshold, batch 24,
# tb_sizes [2,1,0], min_seg_size 10 (process_image), max_iter 10 (predict default)
UDF_THRESHOLD = 1.0
BATCH_SIZE = 24
TB_SIZES = [2, 1, 0]
TB_MAX_ITER = 10
TB_MIN_SEG_SIZE = 10
OVERLAP_FACTOR = 0.5
CROP_PADDING = 10
EDGE_WIDTH = 2


def load_model(checkpoint: str, device: str) -> GapCloser:
    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = GapCloser(**ckpt.get("hyper_parameters", {}))
    model.load_state_dict(ckpt["state_dict"])
    model.hparams.udf_threshold = UDF_THRESHOLD
    model.eval()
    return model.to(device)


def dump_one(png_path: str, out_dir: str, model: GapCloser, device: str):
    import cv2

    os.makedirs(out_dir, exist_ok=True)
    img = cv2.imread(png_path, cv2.IMREAD_UNCHANGED)
    assert img is not None and img.ndim == 3 and img.shape[2] == 4, png_path
    rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
    shutil.copyfile(png_path, os.path.join(out_dir, "line.png"))

    def save(stem, arr):
        np.save(os.path.join(out_dir, stem + ".npy"), np.ascontiguousarray(arr))

    meta = {
        "udf_threshold": UDF_THRESHOLD, "batch_size": BATCH_SIZE,
        "tb_sizes": TB_SIZES, "tb_max_iter": TB_MAX_ITER,
        "tb_min_seg_size": TB_MIN_SEG_SIZE, "overlap_factor": OVERLAP_FACTOR,
        "crop_padding": CROP_PADDING, "edge_width": EDGE_WIDTH,
        "orig_shape": list(rgba.shape[:2]),
    }

    # ---- GapCloser.predict body, replayed verbatim ----
    image_np = rgba[:, :, 3].astype(np.float32) / 255.0
    image_np = image_np[np.newaxis, ...]

    crop_input = (image_np[0] * 255).astype(np.uint8)
    cropped_image, vert_pad_dims, horiz_pad_dims = crop_image(crop_input, padding=CROP_PADDING)
    image_np = (cropped_image.astype(np.float32) / 255.0)[np.newaxis, ...]
    save("01_cropped_alpha", cropped_image)
    meta["vert_pad_dims"] = [int(v) for v in vert_pad_dims]
    meta["horiz_pad_dims"] = [int(v) for v in horiz_pad_dims]

    _, height, width = image_np.shape
    tile_size = int(model.hparams.image_size)
    tile_shape = (tile_size, tile_size)
    overlap = (int(tile_size * OVERLAP_FACTOR), int(tile_size * OVERLAP_FACTOR))
    meta["tile_size"] = tile_size

    tiler = Tiler(data_shape=(height, width), tile_shape=tile_shape, overlap=overlap)
    _, tiler_padding = tiler.calculate_padding()
    meta["model_tiler_padding"] = [[int(a), int(b)] for a, b in tiler_padding]

    padding_full = [(0, 0)] + list(tiler_padding)
    padded_image = np.pad(image_np, padding_full, mode="edge")
    padded_height, padded_width = padded_image.shape[1], padded_image.shape[2]

    padded_image[:, :EDGE_WIDTH, :] = 1.0
    padded_image[:, -EDGE_WIDTH:, :] = 1.0
    padded_image[:, :, :EDGE_WIDTH] = 1.0
    padded_image[:, :, -EDGE_WIDTH:] = 1.0
    save("02_padded_edge", padded_image[0])

    tiler = Tiler(data_shape=(padded_height, padded_width), tile_shape=tile_shape, overlap=overlap)
    merger = Merger(tiler=tiler, window="overlap-tile")
    meta["num_model_tiles"] = len(list(tiler(padded_image[0])))

    tile_boundaries = []  # in tile_id order (tiler.iterate is in order)
    with torch.no_grad():
        tiles_batch, tiles_ids = [], []

        def flush():
            batch_tensor = torch.from_numpy(np.stack(tiles_batch, axis=0)).float().to(device)
            _, _, boundary_bin = model.forward(batch_tensor)
            for i, tid in enumerate(tiles_ids):
                tile_boundaries.append(boundary_bin[i])
                merger.add(tid, boundary_bin[i])
            tiles_batch.clear()
            tiles_ids.clear()

        for tile_id, tile_2d in tiler.iterate(padded_image[0]):
            tiles_batch.append(tile_2d[np.newaxis, ...])
            tiles_ids.append(tile_id)
            if len(tiles_batch) >= BATCH_SIZE:
                flush()
        if tiles_batch:
            flush()
    stacked = np.stack(tile_boundaries)
    assert set(np.unique(stacked)) <= {0.0, 1.0}, "boundary tiles not binary"
    save("03_tile_boundary", stacked.astype(np.uint8))

    merged_boundary = 255 - (merger.merge(extra_padding=tiler_padding, dtype=np.uint8) * 255)
    save("04_merged_boundary", merged_boundary)

    # ---- compute_seg_full body, replayed with sequential tile seg ----
    seg_tile_size = (512, 512)
    seg_tiler = Tiler(
        data_shape=merged_boundary.shape,
        tile_shape=seg_tile_size,
        overlap=(int(seg_tile_size[0] * OVERLAP_FACTOR), int(seg_tile_size[1] * OVERLAP_FACTOR)),
    )
    seg_new_shape, seg_padding = seg_tiler.calculate_padding()
    seg_tiler.recalculate(data_shape=seg_new_shape)
    seg_padded_image = np.pad(merged_boundary, seg_padding, mode="constant", constant_values=0)
    seg_merger = Merger(tiler=seg_tiler, window="overlap-tile")
    save("05_seg_padded", seg_padded_image)
    meta["seg_tiler_padding"] = [[int(a), int(b)] for a, b in seg_padding]

    tile_data = list(seg_tiler(seg_padded_image))
    num_tiles = len(tile_data)
    max_seg_id = num_tiles * 512
    meta["num_seg_tiles"] = num_tiles
    meta["max_seg_id"] = max_seg_id

    border_h_delta = int((seg_tiler.tile_shape[0] * OVERLAP_FACTOR) / 2)
    border_w_delta = int((seg_tiler.tile_shape[1] * OVERLAP_FACTOR) / 2)
    meta["border_deltas"] = [border_h_delta, border_w_delta]

    # compute_seg_tiles runs a ProcessPoolExecutor but executor.map preserves
    # input order, so a sequential replay through the same worker is identical
    segged_tile_data = []
    for td in tile_data:
        tile_id, seg = _seg_worker(td, TB_SIZES, TB_MAX_ITER, TB_MIN_SEG_SIZE)
        segged_tile_data.append((tile_id, seg + (tile_id * 256)))
    save("06_tile_segs", np.stack([t for _, t in segged_tile_data]).astype(np.int32))

    bottom_border, top_border, left_border, right_border = build_border_data(
        tiler=seg_tiler, merger=seg_merger, segged_tile_data=segged_tile_data,
        border_h_delta=border_h_delta, border_w_delta=border_w_delta,
    )
    np.savez(os.path.join(out_dir, "07_borders.npz"),
             top=top_border, bottom=bottom_border, left=left_border, right=right_border)

    n_labels = compute_cc(
        bottom_border=bottom_border, top_border=top_border,
        left_border=left_border, right_border=right_border,
        border_h_delta=border_h_delta, border_w_delta=border_w_delta,
        max_seg_id=max_seg_id,
    )
    save("08_n_labels", n_labels.astype(np.int32))

    unmerged = seg_merger.merge(extra_padding=seg_padding, dtype=np.uint32)
    save("09_unmerged", unmerged)
    merged_seg = n_labels[unmerged]
    save("10_merged", merged_seg)

    unique, labeled_regions = np.unique(merged_seg, return_inverse=True)
    labeled_regions = labeled_regions.reshape(merged_boundary.shape).astype(np.uint8)
    replay_boundary = merged_boundary
    if vert_pad_dims != (0, 0) or horiz_pad_dims != (0, 0):
        replay_boundary = uncrop(merged_boundary, vert_pad_dims, horiz_pad_dims)
        labeled_regions = uncrop(labeled_regions, vert_pad_dims, horiz_pad_dims)
    save("11_final", labeled_regions)
    save("12_boundary_final", replay_boundary)
    meta["num_labels"] = int(unique.shape[0])

    # the goldens must be production, not a paraphrase of it
    ref_boundary, ref_regions, ref_num = model.predict(
        rgba, batch_size=BATCH_SIZE, tb_sizes=TB_SIZES,
        tb_max_iter=TB_MAX_ITER, tb_min_seg_size=TB_MIN_SEG_SIZE,
    )
    assert np.array_equal(replay_boundary, ref_boundary), f"boundary drifted: {png_path}"
    assert np.array_equal(labeled_regions, ref_regions), f"labels drifted: {png_path}"

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return meta["num_labels"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("corpus_dir")
    ap.add_argument("out_root")
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args()

    import scipy
    import tiler as tiler_pkg
    print(f"tiler {getattr(tiler_pkg, '__version__', '?')}, scipy {scipy.__version__}, "
          f"torch {torch.__version__}")

    model = load_model(args.checkpoint, args.device)
    print(f"GapCloser loaded: image_size={model.hparams.image_size}, "
          f"udf_max_dist={model.hparams.udf_max_dist}, udf_threshold={model.hparams.udf_threshold}")

    pngs = sorted(glob.glob(os.path.join(args.corpus_dir, "lineLayer*_f*.png")))
    assert pngs, f"no line PNGs in {args.corpus_dir}"
    for p in pngs:
        name = os.path.basename(p).split("_")[1]  # fNNN
        n = dump_one(p, os.path.join(args.out_root, name), model, args.device)
        print(f"{name}: {n} labels")
    print("all goldens dumped + replay-verified against GapCloser.predict")


if __name__ == "__main__":
    main()
