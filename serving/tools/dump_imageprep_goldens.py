"""Dump per-stage goldens for AnT v2 preprocess image prep (R2e port gate).

Replays `colorize/common/image.py::prepare_image`'s exact body (inference
path: augment=False) stage by stage for every robot-corpus drawing, dumping
each intermediate, then asserts the replay's outputs equal a real
`prepare_image` call — so the goldens cannot drift from production. The
seg input is the production trapped-ball map (`seg_map_for`, the same
source parity_corpus used). f035 is additionally processed ref-style with
its color layer.

Runs on wallace (production env; CPU):

    PYTHONPATH=. python serving/tools/dump_imageprep_goldens.py /tmp/robot_corpus /tmp/imageprep_goldens

Layout per drawing (<out>/<fNNN>[_ref]/):
    01_seg_input.npy      i32  seg_map_for output (the prepare_image input)
    02_seg_cropped.npy    i32  crop_image(seg, 10, bbox_pad_dims)
    03_line_cropped.npy   u8   crop_image(line rgba, 10, bbox_pad_dims)
    04_seg_resized.npy    f64  resize_proportionally (skimage order=0 nearest)
    05_line_resized.npy   f64
    06_seg_for_vtrace.npy f64  after prepare_resized_seg_for_vtrace (id_map in meta)
    07_vtrace_input.png        the exact RGBA png bytes handed to vtracer
    08_vtrace_output.svg       the exact SVG string vtracer returned
    09_seg_padded.npy     f64  pad_sides_equally(seg, -100)   [final]
    10_line_padded.npy    f64  pad_sides_equally(line, 0)     [final]
    (ref-style adds 03c/05c/11_color_padded.npy for the color layer)
    meta.json             bbox pad dims, shapes, id_map, image_args
"""
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from serving.onnx.export_ant_v2 import seg_map_for
from serving.onnx.parity_corpus import find_corpus, load_rgba

from colorize.common.image import (
    ImageArgs,
    pad_sides_equally,
    prepare_image,
    resize_proportionally,
)
from segmentation.trapped_ball.cropping import get_bbox_pad_dims
from colorize.vectorization.vtrace import VecArgs, prepare_resized_seg_for_vtrace, vectorize
from colorize.vectorization.lib.svg import SVG
from segmentation.trapped_ball.cropping import crop_image
from segmentation.trapped_ball.serialization import int32_to_rgba_with_padding

SVG_STRINGS = []


def install_recorder():
    orig = SVG.load_svg

    def rec(file_path):
        with open(file_path, "r") as f:
            SVG_STRINGS.append(f.read())
        return orig(file_path)

    SVG.load_svg = staticmethod(rec)


def dump_one(seg_input, line_image, color_image, out_dir, image_args, vec_args):
    os.makedirs(out_dir, exist_ok=True)

    def save(stem, arr):
        np.save(os.path.join(out_dir, stem + ".npy"), np.ascontiguousarray(arr))

    meta = {"width": image_args.width, "height": image_args.height,
            "vec_args": vars(vec_args)}

    # ---- prepare_image body, replayed verbatim (augment=False) ----
    seg_image = seg_input.astype(np.int32)
    save("01_seg_input", seg_image)

    vert_pad_dims, horiz_pad_dims = get_bbox_pad_dims(line_image)
    bbox_pad_dims = (vert_pad_dims, horiz_pad_dims)
    meta["vert_pad_dims"] = [int(v) for v in vert_pad_dims]
    meta["horiz_pad_dims"] = [int(v) for v in horiz_pad_dims]

    seg_cropped, _, _ = crop_image(seg_image, padding=10, bbox_pad_dims=bbox_pad_dims)
    seg_resized = resize_proportionally(seg_cropped, target_size=(image_args.width, image_args.height))
    save("02_seg_cropped", seg_cropped)
    save("04_seg_resized", seg_resized)

    line_cropped, _, _ = crop_image(line_image, padding=10, bbox_pad_dims=bbox_pad_dims)
    line_resized = resize_proportionally(line_cropped, target_size=(image_args.width, image_args.height))
    save("03_line_cropped", line_cropped)
    save("05_line_resized", line_resized)

    if color_image is not None:
        color_cropped, _, _ = crop_image(color_image, padding=10, bbox_pad_dims=bbox_pad_dims)
        color_resized = resize_proportionally(color_cropped, target_size=(image_args.width, image_args.height))
        save("03c_color_cropped", color_cropped)
        save("05c_color_resized", color_resized)
    else:
        color_resized = None

    seg_resized, id_map = prepare_resized_seg_for_vtrace(
        seg_original=seg_image, seg_resized=seg_resized, verbose=False)
    save("06_seg_for_vtrace", seg_resized)
    meta["id_map"] = ({str(k): v for k, v in id_map.items()} if id_map is not None else None)

    # the exact png bytes vectorize() writes (vtrace.py: unpad if id_map,
    # then int32_to_rgba_with_padding)
    vt_in = seg_resized
    if id_map is not None:
        from colorize.vectorization.vtrace import unpad_seg_image
        vt_in = unpad_seg_image(vt_in, id_map)
    rgba = int32_to_rgba_with_padding(vt_in)
    from PIL import Image
    Image.fromarray(rgba).save(os.path.join(out_dir, "07_vtrace_input.png"))

    SVG_STRINGS.clear()
    vectorized_seg = vectorize(image=seg_resized, vec_args=vec_args, id_map=id_map)
    assert len(SVG_STRINGS) == 1
    with open(os.path.join(out_dir, "08_vtrace_output.svg"), "w") as f:
        f.write(SVG_STRINGS[0])
    meta["num_paths"] = len(vectorized_seg.paths)

    seg_padded = pad_sides_equally(seg_resized, target_size=(image_args.width, image_args.height), pad_value=-100)
    line_padded = pad_sides_equally(line_resized, target_size=(image_args.width, image_args.height), pad_value=0)
    save("09_seg_padded", seg_padded)
    save("10_line_padded", line_padded)
    if color_resized is not None:
        color_padded = pad_sides_equally(color_resized, target_size=(image_args.width, image_args.height), pad_value=0)
        save("11_color_padded", color_padded)

    # the goldens must be production, not a paraphrase of it
    ref_seg, ref_line, ref_color, ref_svg = prepare_image(
        seg_image=seg_input, line_image=line_image, image_args=image_args,
        vec_args=vec_args, augment=False, color_image=color_image, verbose=False)
    assert np.array_equal(seg_padded, ref_seg), "seg drifted"
    assert np.array_equal(line_padded, ref_line), "line drifted"
    if color_image is not None:
        assert np.array_equal(color_padded, ref_color), "color drifted"
    assert len(ref_svg.paths) == meta["num_paths"], "svg drifted"

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return meta["num_paths"]


def main():
    corpus_dir, out_root = sys.argv[1], sys.argv[2]
    image_args, vec_args = ImageArgs(), VecArgs()
    install_recorder()

    ref_nr, ref_line_p, ref_color_p, targets = find_corpus(corpus_dir, None)
    all_lines = {ref_nr: ref_line_p, **targets}
    color_ref = load_rgba(ref_color_p)

    for nr in sorted(all_lines):
        line = load_rgba(all_lines[nr])
        seg = seg_map_for(line)
        n = dump_one(seg, line, None, os.path.join(out_root, f"f{nr:03d}"),
                     image_args, vec_args)
        print(f"f{nr:03d}: {n} paths")

    # ref-style with the color layer (the production ref-frame call shape)
    line = load_rgba(ref_line_p)
    seg = seg_map_for(line)
    n = dump_one(seg, line, color_ref, os.path.join(out_root, f"f{ref_nr:03d}_ref"),
                 image_args, vec_args)
    print(f"f{ref_nr:03d}_ref (with color): {n} paths")
    print("all image-prep goldens dumped + replay-verified against prepare_image")


if __name__ == "__main__":
    main()
