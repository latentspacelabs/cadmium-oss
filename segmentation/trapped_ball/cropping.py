from typing import *
import copy

from PIL import Image
import numpy as np


def get_bbox_pad_dims(
    line_image: Union[np.ndarray, Image.Image],
    padding: int = 10,
) -> Tuple[Tuple[int, int], Tuple[int, int]]:
    if isinstance(line_image, np.ndarray):
        line_image = Image.fromarray(line_image)

    w, h = line_image.size
    black = Image.new('RGBA', line_image.size)
    compedImage = Image.composite(line_image, black, line_image)
    
    # get bounding box anywhere the alpha is zero
    bbox = compedImage.getbbox()
    if bbox is None:
        print('No bounding box found for line image, returning bbox for full image')
        return (0, 0), (0, 0)
    
    padded_bbox = list(copy.deepcopy(bbox))

    # get the width and height of the image, if the bounding box doesn't 
    # go all the way to the edge, add a one pixel pad to the bounding box
    if (bbox[0] > (0 + padding)):
        padded_bbox[0] = bbox[0] - (1 + padding)
    if (bbox[1] > (0 + padding)):
        padded_bbox[1] = bbox[1] - (1 + padding)
    if (bbox[2] < (w - padding)):
        padded_bbox[2] = bbox[2] + (1 + padding)
    if (bbox[3] < (h - padding)):
        padded_bbox[3] = bbox[3] + (1 + padding)

    vert_pad_dims = (padded_bbox[1], h - padded_bbox[3])
    horiz_pad_dims = (padded_bbox[0], w - padded_bbox[2])

    return vert_pad_dims, horiz_pad_dims

def crop_image(
    image: np.ndarray,
    padding: int = 10,
    bbox_pad_dims: Optional[Tuple[Tuple[int, int], Tuple[int, int]]] = None
) -> Tuple[np.ndarray, Tuple[int, int], Tuple[int, int]]:
    image_dtype = image.dtype
    image = Image.fromarray(image)
    w, h = image.size
    
    if bbox_pad_dims is None: 
        (top, bottompad), (left, rightpad) = get_bbox_pad_dims(image, padding=padding)
        print(f'Bounding box: {top}, {bottompad}, {left}, {rightpad}')
    else:
        top, bottompad = bbox_pad_dims[0]
        left, rightpad = bbox_pad_dims[1]
    
    # convert from pad dims to crop dims
    bottom = h - bottompad
    right = w - rightpad
    cropbox = (left, top, right, bottom)
    
    image = image.crop(cropbox)
    
    return np.array(image, dtype=image_dtype), (top, bottompad), (left, rightpad)


def uncrop(
    cropped_image: np.array,
    vert_pad_dims: tuple,
    horiz_pad_dims: tuple,
):
    return np.pad(cropped_image,(vert_pad_dims, horiz_pad_dims), mode='edge')

