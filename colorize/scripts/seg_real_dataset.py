import os
import argparse
import glob

import cv2
from tiler import Tiler, Merger
import numpy as np
from tqdm import tqdm
from PIL import Image

from segmentation.trapped_ball.color import detect_edges, get_eroded_edges
from segmentation.trapped_ball.serialization import int32_to_rgba
from segmentation.trapped_ball.trapped_ball import show_fill_map
from segmentation.trapped_ball.line import binarize
from segmentation.trapped_ball.parallel import compute_seg_full
from segmentation.trapped_ball.cropping import crop_image, uncrop


if __name__ == '__main__':
    
    argparser = argparse.ArgumentParser()
    argparser.add_argument('--data_path', type=str)
    argparser.add_argument('--glob_pattern', type=str, default='*')
    args = argparser.parse_args()

    path = os.path.join(args.data_path, args.glob_pattern)
    for project_path in glob.glob(path):

        print(f"Segmenting project: {project_path}")

        for scene_path in glob.glob(os.path.join(project_path, '*')):


            line_paths = glob.glob(scene_path + '/line/*.png')

            for line_path in tqdm(line_paths):
                print(f'Processing line: {line_path}')

                color_path = line_path.replace('sketch', 'color')
                if not os.path.exists(color_path):
                    continue

                img = cv2.imread(line_path, cv2.IMREAD_UNCHANGED)

                tb_sizes = [5, 4, 2]
                try:
                    img, vert_pad_dims, horiz_pad_dims = crop_image(img, padding=max(tb_sizes) * 2)
                except ValueError as e:
                    print(f'Error cropping image: {e}')
                    continue

                binary = binarize(img, 'adaptive_mean', neighborhood=51)

                # color line detection
                try:
                    color_image = cv2.imread(color_path, cv2.IMREAD_UNCHANGED).astype(np.uint8)
                    color_image_cropped, _, _ = crop_image(color_image, bbox_pad_dims=(vert_pad_dims, horiz_pad_dims))
                    binary_line_mask = (binary != 0).astype(np.uint8)

                    color_edges = 255 - detect_edges(color_image_cropped)
                    binary, _ = get_eroded_edges(binary, color_edges, binary_line_mask)
                except Exception as e:
                    print(e)
                    import pdb; pdb.set_trace()
                
                tile_shape = (512, 512)
                overlap_factor = 0.5 
                overlap = (tile_shape[0] * overlap_factor, tile_shape[1] * overlap_factor)
                tiler = Tiler(
                    data_shape=binary.shape,
                    tile_shape=tile_shape,
                    overlap=overlap,
                    # mode='constant',
                    # constant_value=0,
                )
                new_shape, padding = tiler.calculate_padding()
                tiler.recalculate(data_shape=new_shape)
                padded_image = np.pad(binary, padding, mode="constant", constant_values=0)
                merger = Merger(tiler=tiler, window="overlap-tile") 

                try: 
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
                    print(e)
                    continue
                
                unique, thinned = np.unique(merged, return_inverse=True)
                print(f'Found {len(unique)} unique segments')
                thinned = thinned.reshape((binary.shape[0], binary.shape[1]))
                thinned = uncrop(thinned, vert_pad_dims, horiz_pad_dims)
                thinned_rgba = int32_to_rgba(thinned)
                thinned_color = show_fill_map(thinned)

                output_path = os.path.join(scene_path, 'tb_seg_neigborhood_51_color_lines_5_4_2')
                os.makedirs(output_path, exist_ok=True)
                basename = os.path.basename(line_path).replace('.png', '')

                Image.fromarray(thinned_rgba).save(os.path.join(output_path, f'{basename}.png'))
                cv2.imwrite(os.path.join(output_path, f'{basename}-rainbow.png'), thinned_color)
