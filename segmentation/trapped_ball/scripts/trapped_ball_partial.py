import argparse
import os
from typing import *
import time

import cv2
from matplotlib import pyplot as plt
import matplotlib.patches as patches
from tiler import Tiler, Merger
import numpy as np

from segmentation.trapped_ball.line import binarize
from segmentation.trapped_ball.trapped_ball import show_fill_map
from segmentation.trapped_ball.parallel import compute_seg_partial
from segmentation.trapped_ball.cropping import crop_image, uncrop
from segmentation.trapped_ball.serialization import int32_to_rgba, rgba_to_int32, read_borders_cache_from_path, save_borders_cache


def plot_bboxes(image1, image2, bboxes, output_path):
    
    overlay_image = image1 * .5 + image2 * .5
    # Create figure and axes
    fig, ax = plt.subplots()

    # Display the image
    ax.imshow(overlay_image)

    for bbox in bboxes:
        rect = patches.Rectangle(
            (bbox['min_col'], bbox['min_row']), # (x,y)
            bbox['max_col'] - bbox['min_col'], # width
            bbox['max_row'] - bbox['min_row'], # height
            linewidth=2, edgecolor='r', facecolor='none'
        )

        ax.add_patch(rect)

    # return image
    fig.savefig(os.path.join(output_path, 'diff_bboxes.png'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--old_line_image_path', type=str)
    parser.add_argument('--new_line_image_path', type=str)
    parser.add_argument('--old_unmerged_seg_path', type=str)
    parser.add_argument('--old_seg_tile_data_path', type=str)
    parser.add_argument('--output_path', default='./segmentation_cpu/out', type=str)
    parser.add_argument('--max_iter', type=int, default=10)
    parser.add_argument('--min_seg_size', type=int, default=20)
    parser.add_argument('--tile_size', type=int, default=512)
    parser.add_argument('--overlap_factor', type=int, default=1)
    args = parser.parse_args()

    total_start = time.time() 
    
    start = time.time() 
    tb_sizes = [2, 1, 0] 
    old_line = cv2.imread(args.old_line_image_path, cv2.IMREAD_UNCHANGED)
    new_line = cv2.imread(args.new_line_image_path, cv2.IMREAD_UNCHANGED)
    old_seg_unmerged_rgba = cv2.imread(args.old_unmerged_seg_path, cv2.IMREAD_UNCHANGED)
    old_seg_unmerged = rgba_to_int32(old_seg_unmerged_rgba, dtype=np.uint32)
    old_seg_borders = read_borders_cache_from_path(args.old_seg_tile_data_path)
    print(f'Image data reading time: {time.time() - start} sec')
    
    start = time.time()
    old_line, vert_pad_dims, horiz_pad_dims = crop_image(old_line, padding=max(tb_sizes) * 2)
    new_line, _, _ = crop_image(new_line, padding=max(tb_sizes) * 2, bbox_pad_dims=(vert_pad_dims, horiz_pad_dims))
    print(f'Cropping time: {time.time() - start} sec')
    
    start = time.time()
    old_binary = binarize(old_line, 'adaptive_mean')
    new_binary = binarize(new_line, 'adaptive_mean')
    print("Binarization time", time.time() - start)
    
    assert old_line.shape == new_line.shape, 'old and new images must be the same shape'
    
    tile_shape = (args.tile_size, args.tile_size)
    overlap_factor = 0.5 ** args.overlap_factor
    tiler = Tiler(
        data_shape=new_binary.shape,
        tile_shape=tile_shape,
        overlap=(tile_shape[0] * overlap_factor, tile_shape[1] * overlap_factor),
        # mode='constant',
        # constant_value=0,
    )
    new_shape, padding = tiler.calculate_padding()
    tiler.recalculate(data_shape=new_shape)
    old_padded_line = np.pad(old_binary, padding, mode="constant", constant_values=0)
    new_padded_line = np.pad(new_binary, padding, mode="constant", constant_values=0)
    merger = Merger(tiler=tiler, window="overlap-tile") 
    
    merged, unmerged, borders_cache = compute_seg_partial(
        old_binary=old_padded_line,
        new_binary=new_padded_line,
        old_seg_unmerged=old_seg_unmerged,
        old_seg_borders=old_seg_borders,
        tiler=tiler,
        merger=merger,
        padding=padding,
        overlap_factor=overlap_factor,
        tb_sizes=tb_sizes,
        max_iter=args.max_iter,
        min_seg_size=args.min_seg_size,
    )
    
    output_path = os.path.join(args.output_path, os.path.splitext(os.path.basename(args.new_line_image_path))[0])
    os.makedirs(output_path, exist_ok=True)
    
    # save images
    unique, thinned = np.unique(merged, return_inverse=True)
    thinned = thinned.reshape((new_binary.shape[0], new_binary.shape[1])).astype(np.uint8)
    thinned = uncrop(thinned, vert_pad_dims, horiz_pad_dims)
    cv2.imwrite(os.path.join(output_path, 'reseg_thinned.png'), thinned)
    thinned_color = show_fill_map(thinned)
    cv2.imwrite(os.path.join(output_path, 'reseg_thinned_color.png'), thinned_color)
    
    # save stuff for re-seg
    start = time.time()
    save_borders_cache(borders_cache, os.path.join(output_path, 'tile_data.png'))
    rgba_unmerged = int32_to_rgba(unmerged)
    cv2.imwrite(os.path.join(output_path, 'rgba_unmerged.png'), rgba_unmerged)
    print('Time taken for saving re-seg data: {} sec'.format(time.time() - start))

    # save border cache 
    np.save(os.path.join(output_path, 'tile_data.npy'), borders_cache)

    print(f'Total time taken: {time.time() - total_start} sec')
