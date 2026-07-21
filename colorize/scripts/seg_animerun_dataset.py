import os
import argparse
import glob

import cv2
from tiler import Tiler, Merger

import numpy as np
from tqdm import tqdm
from PIL import Image

from segmentation.trapped_ball.serialization import int32_to_rgba
from segmentation.trapped_ball.trapped_ball import show_fill_map
from segmentation.trapped_ball.parallel import compute_seg_full

if __name__ == '__main__':
    
    argparser = argparse.ArgumentParser()
    argparser.add_argument('--data_path', type=str, default='./data/animerun-data')
    argparser.add_argument('--glob_pattern', type=str, default='*')
    args = argparser.parse_args()

    contour_path = os.path.join(args.data_path, 'contour')

    print(f"Processing data from: {args.data_path}")

    contour_pattern = os.path.join(contour_path, args.glob_pattern, "*.png")

    contour_files = sorted(glob.glob(contour_pattern))

    for contour_file in tqdm(contour_files, total=len(contour_files)):
        print(f'Processing: {contour_file}')

        if os.path.exists(contour_file.replace('contour', 'seg/tb_seg_threshold_240')):
            continue

        img = cv2.imread(contour_file, cv2.IMREAD_COLOR).astype(np.uint8)
        img_gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)

        # binary = cv2.adaptiveThreshold(img_gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 101, 2)
        binary = cv2.threshold(img_gray, 240, 255, cv2.THRESH_BINARY)[1]

        try:
            tb_sizes = [0,0,0]
            tile_shape = (512, 512)
            overlap_factor = 0.5 
            overlap = (tile_shape[0] * overlap_factor, tile_shape[1] * overlap_factor)
            tiler = Tiler(
                data_shape=binary.shape,
                tile_shape=tile_shape,
                overlap=overlap,
            )
            new_shape, padding = tiler.calculate_padding()
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
                max_iter=10,
                min_seg_size=10,
            )
        except Exception as e:
            print(f'Error: {e}')
            import pdb; pdb.set_trace()
        
        unique, thinned = np.unique(merged, return_inverse=True)
        print(f'Found {len(unique)} unique segments')
        thinned = thinned.reshape((binary.shape[0], binary.shape[1]))
        thinned_rgba = int32_to_rgba(thinned)
        thinned_color = show_fill_map(thinned)

        seg_output_path = contour_file.replace('contour', 'seg/tb_seg_threshold_240')
        os.makedirs(os.path.dirname(seg_output_path), exist_ok=True)
        Image.fromarray(thinned_rgba).save(seg_output_path)
        rainbow_path = seg_output_path.replace('.png', '-rainbow.png')
        cv2.imwrite(rainbow_path, thinned_color)

        line_output_path = contour_file.replace('contour', 'line_binary')
        os.makedirs(os.path.dirname(line_output_path), exist_ok=True)
        line_rgba = np.dstack([binary, binary, binary, np.ones_like(binary) * 255])
        Image.fromarray(line_rgba).save(line_output_path)
