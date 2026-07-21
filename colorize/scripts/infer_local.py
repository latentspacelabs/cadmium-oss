"""Local (non-Modal) inference for the AnT v2 reference-guided colorizer.

Given a colored *reference* frame and an uncolored *target* frame (both as
line-art + segmentation-map image files), this propagates the reference's
flat-fill colors onto the target and writes a colorized PNG.

The reference palette (one color per segment) is derived automatically from
the reference color image + segmentation map via `KeyFrame.compute_color_list`,
so you only need raw image files — no preprocessed dataset.

Requires a CUDA GPU (the model image encoder imports `torch_scatter`, and
segmentation uses `cupy`/`cucim`). See requirements-cuda.txt.

Example:

    python colorize/scripts/infer_local.py \\
        --checkpoint /path/to/ant_v2_checkpoint \\
        --ref-seg    examples/ref_seg.png \\
        --ref-line   examples/ref_line.png \\
        --ref-color  examples/ref_color.png \\
        --target-seg  examples/target_seg.png \\
        --target-line examples/target_line.png \\
        --output     examples/target_colorized.png
"""
import argparse

from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline
from colorize.common.frame import (
    SegImageFrame,
    ColorImageFrame,
    LineImageFrame,
    KeyFrame,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True,
                        help="Path to a trained AnT v2 checkpoint directory.")
    parser.add_argument("--ref-seg", required=True,
                        help="Reference segmentation map (integer-labeled PNG).")
    parser.add_argument("--ref-line", required=True,
                        help="Reference line-art image.")
    parser.add_argument("--ref-color", required=True,
                        help="Reference colored image (the colors to propagate).")
    parser.add_argument("--target-seg", required=True,
                        help="Target segmentation map (integer-labeled PNG).")
    parser.add_argument("--target-line", required=True,
                        help="Target line-art image.")
    parser.add_argument("--output", required=True,
                        help="Where to write the colorized target PNG.")
    parser.add_argument("--device", default="cuda",
                        help="Torch device (default: cuda).")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    pipeline = AnTV2Pipeline.from_pretrained(
        checkpoint=args.checkpoint,
        verbose=args.verbose,
        device=args.device,
    )
    pipeline.model.to(args.device)

    # Reference frame: derive the per-segment color list from the colored
    # reference + its segmentation map.
    ref_seg_frame = SegImageFrame.from_file(args.ref_seg)
    ref_color_frame = ColorImageFrame.from_file(args.ref_color)
    ref_line_frame = LineImageFrame.from_file(args.ref_line)
    ref_color_list, _ = KeyFrame.compute_color_list(
        seg_frame=ref_seg_frame,
        color_frame=ref_color_frame,
        line_frame=ref_line_frame,
    )

    # Target frame (no colors yet).
    target_seg_frame = SegImageFrame.from_file(args.target_seg)
    target_line_frame = LineImageFrame.from_file(args.target_line)

    output = pipeline(
        inputs={
            "ref_seg_image": ref_seg_frame.image_data,
            "ref_line_image": ref_line_frame.image_data,
            "target_seg_image": target_seg_frame.image_data,
            "target_line_image": target_line_frame.image_data,
            "ref_color_list": ref_color_list,
        },
        return_colorized=True,
        verbose=args.verbose,
    )

    output.target_color_image.save(args.output)
    print(f"Wrote colorized target to {args.output}")


if __name__ == "__main__":
    main()
