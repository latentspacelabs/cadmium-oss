from typing import *
import vtracer
import tempfile
from dataclasses import dataclass

from PIL import Image
from PIL.Image import Resampling as ResizeMethod
import numpy as np

from colorize.vectorization.lib.svg import SVG
from segmentation.trapped_ball.serialization import int32_to_rgba_with_padding, int32_to_rgba

@dataclass
class VecArgs:
    
    corner_threshold: int = 60
    max_iterations: int = 10
    length_threshold: float = 4.0
    splice_threshold: int = 10
    path_precision: int = 0
    max_error_simp: float = 2.0 


def vectorize(
    image: np.ndarray,
    vec_args: VecArgs,
    id_map: Dict[int, int],
) -> SVG:
    if id_map is not None:
        image = unpad_seg_image(image, id_map)

    # TODO: version of vtrace in serving does not support padding
    rgba_image = int32_to_rgba_with_padding(image)

    input_path = tempfile.NamedTemporaryFile(suffix=".png")
    Image.fromarray(rgba_image).save(input_path.name)
    output_path = tempfile.NamedTemporaryFile()
    try:
        vtracer.convert_image_to_svg_py(
            image_path=input_path.name,
            out_path=output_path.name,
            colormode='seg',
            hierarchical='cutout',
            mode='spline',
            filter_speckle=0,
            corner_threshold=vec_args.corner_threshold, # path smoothing, default 60
            max_iterations=vec_args.max_iterations, # path smoothing, default 10
            length_threshold=vec_args.length_threshold, # curve splitting length, default 4.0
            splice_threshold=vec_args.splice_threshold, # curve splitting angle, default 45
            path_precision=vec_args.path_precision, # num decimal places in path strings
            max_error_simp=vec_args.max_error_simp, # how much to simplify paths
        )
    except Exception as e:
        print(f"Error vectorizing image: {e}")
        raise e
    svg = SVG.load_svg(output_path.name)

    if id_map is not None:
        svg.id_map = id_map

    return svg


def prepare_resized_seg_for_vtrace(
    seg_original: np.ndarray,
    seg_resized: np.ndarray,
    verbose: bool = False,
) -> Tuple[np.ndarray, Optional[Dict[int, int]]]:
    # if we removed any segments, we need to restore them.
    unique_ids = np.unique(seg_original)
    resized_unique_ids = np.unique(seg_resized)
    # augmentation adds -100 padding to the seg image, so we need to remove that first
    resized_unique_ids = resized_unique_ids[resized_unique_ids != -100]

    if set(unique_ids) > set(resized_unique_ids):
        diff = [int(x) for x in set(unique_ids) - set(resized_unique_ids)]
        if verbose:
            print(f"Prepare image: Attempting to preserve missing segments after resize/augmentation for {diff}")
        seg_resized = preserve_small_segments(unique_ids, resized_unique_ids, seg_original, seg_resized)
        resized_unique_ids = np.unique(seg_resized)
        resized_unique_ids = resized_unique_ids[resized_unique_ids != -100]
    
    if set(unique_ids) > set(resized_unique_ids):
        diff = [int(x) for x in set(unique_ids) - set(resized_unique_ids)]
        if verbose:
            print(f"Prepare image: Segment preservation failed, creating id offset for {diff}")
        id_map = create_id_offset_map(unique_ids, resized_unique_ids)
    else:
        id_map = None

    return seg_resized, id_map


def preserve_small_segments(
    unique_ids: np.ndarray,
    resized_unique_ids: np.ndarray,
    original_seg_image: np.ndarray,
    resized_seg_image: np.ndarray,
) -> np.ndarray:
    output = resized_seg_image.copy()

    for unique_id in unique_ids:
        if unique_id not in resized_unique_ids:
            # Find center of mass of the segment in original image
            y_coords, x_coords = np.where(original_seg_image == unique_id)
            if len(y_coords) > 0:  # Ensure segment exists
                center_y = int(np.mean(y_coords) * resized_seg_image.shape[0] / original_seg_image.shape[0])
                center_x = int(np.mean(x_coords) * resized_seg_image.shape[1] / original_seg_image.shape[1])
                
                # Place the segment id at the calculated center position
                output[center_y, center_x] = unique_id
        
    return output


def create_id_offset_map(
    unique_ids: np.ndarray,
    resized_unique_ids: np.ndarray,
) -> Dict[int, int]:
    id_map = {}
    offset = 0
    for i, unique_id in enumerate(unique_ids):
        if i - offset < len(resized_unique_ids):
            resized_unique_id = int(resized_unique_ids[i - offset])
        else:
            resized_unique_id = None

        if resized_unique_id is not None and unique_id == resized_unique_id:
            id_map[int(unique_id)] = i - offset
        else:
            offset += 1
            id_map[int(unique_id)] = None
    return id_map


def unpad_seg_image(
    seg_image: np.ndarray,
    id_map: Dict[int, int],
) -> np.ndarray:
    new_seg = np.full_like(seg_image, -100)
    for old_id, new_id in id_map.items():
        if new_id is not None:
            new_seg[seg_image == old_id] = new_id

    return new_seg
