"""Framework-agnostic request handler for the preprocessing API (v2).

Shared by the Modal endpoint (`serving/modal/preprocess/preprocess_v2_stub.py`)
and the local FastAPI server (`serving/local/server.py`).

Reference-assisted preprocessing: given a reference segmentation map and color
image, compute the per-segment color palette and (optionally) a re-rendered
"filled" reference image with anti-aliasing removed. Pure numpy/PIL — reuses the
already-ported `colorize.common` frame utilities (no TensorFlow).

Image inputs are URL-safe base64 (the app encodes them with `url-safe-base64`).
"""
from typing import *
import time

import numpy as np

from colorize.common.frame import (
    SegImageFrame,
    ColorImageFrame,
    LineImageFrame,
    KeyFrame,
)
from colorize.common.ops import dense_to_rgba_flat
from segmentation.trapped_ball.serialization import (
    base64_png_uri_to_img,
    base64_png_uri_to_img_pil,
    img_to_base64_png_uri,
    img_to_base64_png_uri_pil,
)


def run_preprocess(
    references: Optional[List[Dict]] = None,
    # Legacy single-reference fields — still accepted (Modal stubs / older
    # clients). Prefer `references` (an ordered list).
    ref_seg_map_uri: Optional[str] = None,
    ref_color_image_uri: Optional[str] = None,
    ref_line_image_uri: Optional[str] = None,
    return_filled: bool = True,
    **kwargs,
) -> Dict:
    start = time.time()

    # References arrive as an ordered `references` list of
    # ``{seg_map_uri, color_image_uri, line_image_uri}`` dicts (length-1 today,
    # the two-reference seam). Preprocessing is inherently per-reference, so we
    # process the first; legacy flat ref_* fields remain accepted.
    if references:
        ref = references[0]
        ref_seg_map_uri = ref["seg_map_uri"]
        ref_color_image_uri = ref["color_image_uri"]
        ref_line_image_uri = ref.get("line_image_uri")
        if len(references) > 1:
            print(
                f"run_preprocess: {len(references)} references supplied; "
                "preprocessing the first."
            )
    if ref_seg_map_uri is None or ref_color_image_uri is None:
        raise ValueError(
            "run_preprocess: no reference provided — expected a `references` list "
            "or the legacy ref_seg_map_uri/ref_color_image_uri fields."
        )

    # Decode images (url-safe base64, matching the app's encoding). Use the PIL
    # decoder for all of them so channels stay in RGBA order: cv2.imdecode would
    # return BGRA, which silently swaps the R/B channels of the color image and
    # makes the extracted palette (and every colorized frame) mis-colored.
    seg_arr = base64_png_uri_to_img_pil(ref_seg_map_uri, is_url_safe=True)
    color_arr = base64_png_uri_to_img_pil(ref_color_image_uri, is_url_safe=True)
    seg_frame = SegImageFrame.from_image(seg_arr, idx=0)
    color_frame = ColorImageFrame.from_image(color_arr, idx=0)

    if ref_line_image_uri is not None:
        line_arr = base64_png_uri_to_img_pil(ref_line_image_uri, is_url_safe=True)
        line_frame = LineImageFrame.from_image(line_arr, idx=0)
    else:
        line_frame = None

    # Compute color list using KeyFrame (parallel for speed)
    color_list, stats = KeyFrame.compute_color_list(
        seg_frame=seg_frame,
        color_frame=color_frame,
        line_frame=line_frame,
        parallel=True,
        max_workers=16,
    )

    # Convert to RGBA format for response, make null color transparent
    null_color_rgba = (0, 0, 0, 0)
    palette_rgba = [
        list(dense_to_rgba_flat(int(c))) if c != -100 else list(null_color_rgba)
        for c in color_list
    ]

    if return_filled:
        # Render filled image using SegImageFrame. The render is RGBA-ordered,
        # so it must go through the PIL encoder — the cv2 one (img_to_base64_
        # png_uri) writes BGR(A) and would R/B-swap the reference image the app
        # stores and re-analyzes (mis-coloring every subsequent colorize).
        filled_image = seg_frame.render_as_image(color_list, null_color_rgba=null_color_rgba)
        uri = img_to_base64_png_uri_pil(filled_image)

        print(f"Preprocess total time: {time.time() - start:.3f}s, {stats}")

        return {
            "palette_rgba": palette_rgba,
            "preprocessed_uri": uri,
        }
    else:
        print(f"Preprocess total time: {time.time() - start:.3f}s, {stats}")

        return {
            "palette_rgba": palette_rgba,
        }
