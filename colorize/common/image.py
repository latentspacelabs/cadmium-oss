from typing import *
from dataclasses import dataclass
import random
import time

from PIL import Image
import cv2
import torch
from skimage import transform
from scipy.ndimage import distance_transform_edt
import numpy as np

from segmentation.trapped_ball.cropping import get_bbox_pad_dims, crop_image

from colorize.vectorization.lib.svg import SVG
from colorize.vectorization.vtrace import VecArgs, vectorize, prepare_resized_seg_for_vtrace


@dataclass
class ImageArgs:

    width: int = 1024
    height: int = 1024
    padding: int = 10

    random_zoom_scale: float = 0.0
    random_shift_scale: float = 0.0
    random_rotate_scale_degrees: float = 0


def prepare_image(
    seg_image: np.ndarray,
    line_image: np.ndarray,
    image_args: ImageArgs,
    vec_args: VecArgs,
    color_image: Optional[np.ndarray] = None,
    verbose: bool = False,
) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray], SVG]:
    seg_image = seg_image.astype(np.int32)

    # get crop dims
    vert_pad_dims, horiz_pad_dims = get_bbox_pad_dims(line_image)
    bbox_pad_dims = (vert_pad_dims, horiz_pad_dims)

    # seg
    seg_cropped, _, _ = crop_image(seg_image, padding=10, bbox_pad_dims=bbox_pad_dims)
    seg_resized = resize_proportionally(seg_cropped, target_size=(image_args.width, image_args.height))

    # line
    line_cropped, _, _ = crop_image(line_image, padding=10, bbox_pad_dims=bbox_pad_dims)
    line_resized = resize_proportionally(line_cropped, target_size=(image_args.width, image_args.height))

    # color
    if color_image is not None:
        # TODO: should we also preserve small segments here?
        color_cropped, _, _ = crop_image(color_image, padding=10, bbox_pad_dims=bbox_pad_dims)
        color_resized = resize_proportionally(color_cropped, target_size=(image_args.width, image_args.height))
    else:
        color_resized = None

    # mutates seg_resized
    seg_resized, id_map = prepare_resized_seg_for_vtrace(
        seg_original=seg_image,
        seg_resized=seg_resized,
        verbose=verbose,
    )

    # vectorize before padding
    vectorized_seg = vectorize(
        image=seg_resized,
        vec_args=vec_args,
        id_map=id_map,
    )

    # pad
    seg_padded = pad_sides_equally(seg_resized, target_size=(image_args.width, image_args.height), pad_value=-100)
    line_padded = pad_sides_equally(line_resized, target_size=(image_args.width, image_args.height), pad_value=0)
    if color_image is not None:
        color_padded = pad_sides_equally(color_resized, target_size=(image_args.width, image_args.height), pad_value=0)
    else:
        color_padded = None

    return seg_padded, line_padded, color_padded, vectorized_seg


def resize_proportionally(image: np.ndarray, target_size: Tuple[int, int]) -> np.ndarray:
    aspect_ratio_image = image.shape[1] / image.shape[0]
    aspect_ratio_target = target_size[0] / target_size[1]
    
    if aspect_ratio_image > aspect_ratio_target:
        resize_width = target_size[0]
        resize_height = int(resize_width / aspect_ratio_image)
    else:
        resize_height = target_size[1]
        resize_width = int(resize_height * aspect_ratio_image)

    # TODO: should this be bilinear for line/color? 
    resized_image = transform.resize(
        image=image,
        output_shape=(resize_height, resize_width),
        order=0, # nearest
        preserve_range=True,
        anti_aliasing=False,
    )

    return resized_image


def pad_sides_equally(image: np.ndarray, target_size: Tuple[int, int], pad_value: int) -> np.ndarray:
    delta_w = target_size[0] - image.shape[1]
    delta_h = target_size[1] - image.shape[0]
    top, bottom = delta_h // 2, delta_h - (delta_h // 2)
    left, right = delta_w // 2, delta_w - (delta_w // 2)

    if image.ndim == 2:
        padded_image = np.pad(image, ((top, bottom), (left, right)), mode='constant', constant_values=pad_value)
    elif image.ndim == 3:
        padded_image = np.pad(image, ((top, bottom), (left, right), (0, 0)), mode='constant', constant_values=pad_value)
    else:
        raise ValueError(f'Image has {image.ndim} dimensions')

    return padded_image


def compute_sdf(image: np.ndarray, binarize: bool = False) -> np.ndarray:
    if binarize:
        binary_image = image.min(axis=1)[0] > 0
    else:
        binary_image = image

    # Compute distance transform for the line
    dist_line = distance_transform_edt(~binary_image)
    
    # Compute distance transform for the inverse (background)
    dist_background = distance_transform_edt(binary_image)
    
    # Combine the two distance transforms to get the signed distance
    sdf = dist_background - dist_line

    min_val = sdf.min()
    max_val = sdf.max()
    norm_sdf = (sdf - min_val) / (max_val - min_val)

    return np.expand_dims(norm_sdf, axis=(0, 1))


def compute_sdf_cupy(image: torch.Tensor, binarize: bool = False) -> torch.Tensor:
    import cupy as cp
    from cucim.core.operations import morphology as cumorphology

    if binarize:
        binary_image = image.min(dim=1)[0] > 0
    else:
        binary_image = image

    sdfs_cu = []
    for i in range(binary_image.shape[0]):
        image_cu = cp.from_dlpack(binary_image[i])
        sdf_cu = cumorphology.distance_transform_edt(image_cu)
        sdfs_cu.append(sdf_cu)

    sdfs_cu = cp.stack(sdfs_cu)

    sdf = torch.from_dlpack(sdfs_cu).unsqueeze(1)

    min_val = sdf.min()
    max_val = sdf.max()
    return (sdf - min_val) / (max_val - min_val)


def image_grid(images: List[List[np.ndarray]], output_path: str) -> np.ndarray:
    rows = [np.hstack(row) for row in images]
    grid = np.vstack(rows)
    
    if output_path:
        Image.fromarray(grid).save(output_path)
    
