"""Framework-agnostic request handler for the segmentation API.

Shared by the Modal endpoint (`serving/modal/seg/gap_close_v1_stub.py`) and the
local FastAPI server (`serving/local/server.py`) so the request/response contract
cannot drift.

This is the ML gap-closing pipeline: a `GapCloser` model predicts a closed line
boundary, then trapped-ball segmentation labels the enclosed regions. Pass the
loaded `GapCloser` model in; everything else is base64 PNG (de)serialization.
"""
from typing import *

import numpy as np

from segmentation.trapped_ball.trapped_ball import show_fill_map
from segmentation.trapped_ball.serialization import (
    img_to_base64_png_uri,
    base64_png_uri_to_img,
)
from segmentation.gap_closing.inference import process_image


def run_segment(
    model,
    line_image_uri: str,
    return_colorized: bool = False,
    gap_closer_strength: float = 1.0,
    gap_closer_batch_size: int = 24,  # GPU batch size - only applies to gap closer
    min_seg_size: int = 10,           # only applies to trapped ball segmentation
    **kwargs,
) -> Dict:
    """Run gap closing + trapped-ball segmentation on a base64-PNG line image.

    `gap_closer_strength` maps to the model's UDF binarization threshold. When it
    is <= 0 the ML gap closer is skipped (trapped ball only) — preserved from the
    original Modal behavior.
    """
    img = base64_png_uri_to_img(line_image_uri)

    # check empty
    if img[:, :, 3].sum() == 0:
        thinned = np.zeros(img.shape[:2], dtype=np.uint8)
        dense_uri = img_to_base64_png_uri(thinned)

        color_uri = img_to_base64_png_uri(show_fill_map(thinned)) if return_colorized else None

        return {
            "seg_map_uri": dense_uri,
            "colorized_seg_map_uri": color_uri,
            "num_segments": 1,
        }

    if gap_closer_strength > 0.0 and model is not None:
        model.hparams.udf_threshold = gap_closer_strength
        seg_model = model
    else:
        seg_model = None

    num_segments, labeled_regions, boundary_binary = process_image(
        image=img,
        model=seg_model,
        batch_size=gap_closer_batch_size,
        output_dir=None,
        min_seg_size=min_seg_size,
    )

    dense_seg_uri = img_to_base64_png_uri(labeled_regions)
    dense_boundary_uri = img_to_base64_png_uri(boundary_binary)

    color_uri = (
        img_to_base64_png_uri(show_fill_map(labeled_regions).astype(np.uint8))
        if return_colorized
        else None
    )

    return {
        "seg_map_uri": dense_seg_uri,
        "colorized_seg_map_uri": color_uri,
        "boundary_binary_uri": dense_boundary_uri,
        "num_segments": num_segments,
    }
