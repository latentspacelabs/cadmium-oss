"""Framework-agnostic request handler for the colorizer API.

This holds the request/response contract shared by both the Modal endpoint
(`serving/modal/colorize/colorize_v2_stub.py`) and the local FastAPI server
(`serving/local/server.py`), so the two cannot drift apart.

It has no web-framework or Modal dependencies — just the pipeline object and
the base64 PNG serialization helpers.
"""
from typing import *

import numpy as np

from segmentation.trapped_ball.serialization import (
    img_to_base64_png_uri,
    base64_png_uri_to_img,
)


def run_colorize(
    pipeline,
    target_seg_map_uri: str,
    target_line_image_uri: str,
    references: Optional[List[Dict]] = None,
    # Legacy single-reference fields — still accepted so older clients and the
    # Modal stubs keep working. Prefer `references` (an ordered list).
    ref_seg_map_uri: Optional[str] = None,
    ref_line_image_uri: Optional[str] = None,
    ref_colors_rgba: Optional[List[Tuple[int, int, int, int]]] = None,
    return_colorized: bool = False,
    unique_color_ids: bool = False,
    verbose: bool = True,
    **kwargs,
) -> Dict:
    """Run the AnT v2 pipeline on base64-PNG-encoded inputs.

    Mirrors the Modal endpoint contract exactly: base64 PNG URIs in, predicted
    per-segment colors out (plus optional rendered colorized images).

    References are supplied as an ordered `references` list of
    ``{seg_map_uri, line_image_uri, colors_rgba}`` dicts. A length-1 list is the
    current shape (and the two-reference seam); the legacy flat ``ref_*`` fields
    remain accepted for back-compat. The AnT v2 tokenizer consumes exactly one
    reference frame today, so if more than one is supplied the first is used.
    """
    if references:
        ref = references[0]
        ref_seg_map_uri = ref["seg_map_uri"]
        ref_line_image_uri = ref["line_image_uri"]
        ref_colors_rgba = ref["colors_rgba"]
        if len(references) > 1:
            print(
                f"run_colorize: {len(references)} references supplied; using the "
                "first (multi-reference inference not yet supported)."
            )
    if ref_seg_map_uri is None or ref_line_image_uri is None or ref_colors_rgba is None:
        raise ValueError(
            "run_colorize: no reference provided — expected a `references` list "
            "or the legacy ref_seg_map_uri/ref_line_image_uri/ref_colors_rgba fields."
        )

    ref_seg_image = base64_png_uri_to_img(ref_seg_map_uri, is_url_safe=False)
    ref_line_image = base64_png_uri_to_img(ref_line_image_uri, is_url_safe=False)
    target_seg_image = base64_png_uri_to_img(target_seg_map_uri, is_url_safe=False)
    target_line_image = base64_png_uri_to_img(target_line_image_uri, is_url_safe=False)

    out = pipeline(
        inputs={
            "ref_seg_image": ref_seg_image,
            "ref_line_image": ref_line_image,
            "target_seg_image": target_seg_image,
            "target_line_image": target_line_image,
            "ref_colors_rgba": ref_colors_rgba,
        },
        return_colorized=return_colorized,
        verbose=verbose,
    )

    output = {
        "target_colors_rgba": out.target_colors_rgba,
        "target_color_ids": out.target_color_ids,
    }

    if return_colorized:
        output.update({
            "target_color_image_uri": img_to_base64_png_uri(np.array(out.target_color_image)),
            "ref_color_image_uri": img_to_base64_png_uri(np.array(out.ref_color_image)),
        })

    return output
