import argparse
import os
from typing import *
import time

import cv2
import numpy as np
import matplotlib.pyplot as plt
from tiler import Tiler, Merger

from segmentation.trapped_ball.color import detect_edges, get_eroded_edges
from segmentation.trapped_ball.trapped_ball import show_fill_map
from segmentation.trapped_ball.parallel import compute_seg_full
from segmentation.trapped_ball.line import binarize
from segmentation.trapped_ball.serialization import save_borders_cache, int32_to_rgba
from segmentation.trapped_ball.cropping import crop_image, uncrop


def make_debug_plots(binary, merger, dense_seg, padded_image, out_path):
    fig, ax = plt.subplots(3, 2)
    ax[0, 0].set_title("Binary line")
    ax[0, 0].imshow(binary)
    ax[0, 1].set_title("Final dense seg")
    ax[0, 1].imshow(dense_seg)

    ax[1, 0].set_title("Padded binary line")
    ax[1, 0].imshow(padded_image)
    ax[1, 1].set_title("Overlap-tile window")
    ax[1, 1].imshow(merger.window)

    ax[2, 0].set_title("Weights sum")
    ax[2, 0].imshow(merger.weights_sum[:, :], vmin=0, vmax=merger.weights_sum.max())
    ax[2, 1].set_title("Pixel visits")
    ax[2, 1].imshow(merger.data_visits[:, :], vmin=0, vmax=merger.data_visits.max())

    plt.savefig(out_path)
    

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--line_image_path', type=str)
    parser.add_argument('--output_path', default='./segmentation_cpu/out', type=str)
    parser.add_argument('--max_iter', type=int, default=10)
    parser.add_argument('--min_seg_size', type=int, default=4)
    parser.add_argument('--tile_size', type=int, default=512)
    parser.add_argument('--overlap_factor', type=int, default=1)
    parser.add_argument('--color_image_path', type=str, default=None)
    args = parser.parse_args()
    
    img = cv2.imread(args.line_image_path, cv2.IMREAD_UNCHANGED)
    tb_sizes = [3,2,1]
    
    # crop
    start = time.time()
    img, vert_pad_dims, horiz_pad_dims = crop_image(img, padding=max(tb_sizes) * 2)
    print(f'Cropping time: {time.time() - start} sec')

    binary = binarize(img, 'adaptive_mean')
    print('Binary shape:', binary.shape)

    if args.color_image_path is not None:
        color_image = cv2.imread(args.color_image_path, cv2.IMREAD_UNCHANGED)
        color_image_cropped, _, _ = crop_image(color_image, bbox_pad_dims=(vert_pad_dims, horiz_pad_dims))
        binary_line_mask = (binary != 0).astype(np.uint8)

        color_edges = 255 - detect_edges(color_image_cropped)
        binary, _ = get_eroded_edges(binary, color_edges, binary_line_mask)
        
    tile_shape = (args.tile_size, args.tile_size)
    print(f'Tile shape: {tile_shape}')
    overlap_factor = 0.5 ** args.overlap_factor
    overlap = (tile_shape[0] * overlap_factor, tile_shape[1] * overlap_factor)
    tiler = Tiler(
        data_shape=binary.shape,
        tile_shape=tile_shape,
        overlap=overlap,
        # mode='constant',
        # constant_value=0,
    )
    new_shape, padding = tiler.calculate_padding()
    print(f'Padding: {padding}')
    tiler.recalculate(data_shape=new_shape)
    padded_image = np.pad(binary, padding, mode="constant", constant_values=0)
    merger = Merger(tiler=tiler, window="overlap-tile") 
    
    merged, unmerged, borders_cache = compute_seg_full(
        binary=padded_image,
        tiler=tiler,
        merger=merger,
        padding=padding,
        overlap_factor=overlap_factor,
        tb_sizes=tb_sizes,
        max_iter=args.max_iter,
        min_seg_size=args.min_seg_size,
    )
    
    output_path = os.path.join(args.output_path, os.path.splitext(os.path.basename(args.line_image_path))[0])
    os.makedirs(output_path, exist_ok=True)
    
    # save images
    unique, thinned, counts = np.unique(merged, return_inverse=True, return_counts=True)
    print(f'Found {len(unique)} unique segments')
    thinned = thinned.reshape((binary.shape[0], binary.shape[1])).astype(np.uint8)
    thinned = uncrop(thinned, vert_pad_dims, horiz_pad_dims)
    cv2.imwrite(os.path.join(output_path, 'parallel_thinned.png'), thinned)
    
    thinned_color = show_fill_map(thinned)
    cv2.imwrite(os.path.join(output_path, 'parallel_thinned_color.png'), thinned_color)
    
    new_shape, padding = tiler.calculate_padding()
    padded_image = np.pad(binary, padding, mode="constant", constant_values=0)
    debug_plots = make_debug_plots(binary, merger, thinned, padded_image, os.path.join(output_path, 'parallel_debug_plots.png'))
    
    cv2.imwrite(os.path.join(output_path, 'binary_line.png'), binary)
    
    # save stuff for re-seg
    start = time.time()
    save_borders_cache(borders_cache, os.path.join(output_path, 'tile_data.png'))
    rgba_unmerged = int32_to_rgba(unmerged)
    cv2.imwrite(os.path.join(output_path, 'rgba_unmerged.png'), rgba_unmerged)
    print('Time taken for saving re-seg data: {} sec'.format(time.time() - start))

    # do non-parallel seg 
    # start = time.time()
    # thinned_seg = compute_seg_fast(binary, tb_sizes, args.max_iter, args.min_seg_size)
    # thinned_color = show_fill_map(thinned)
    # cv2.imwrite(os.path.join(output_path, 'serial_thinned.png'), thinned_seg)
    # cv2.imwrite(os.path.join(output_path, 'serial_thinned_color.png'), thinned_color)
    # print('Time taken for serial seg: {} sec'.format(time.time() - start))
