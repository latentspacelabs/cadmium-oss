import os
import time

import numpy as np
import torch

from colorize.common.frame import SegImageFrame
from colorize.vectorization.vtrace import VecArgs, vectorize, create_id_offset_map
from colorize.common.image import resize_proportionally
from colorize.common.packing import pack_sequences, unpack_sequences

# input_path = "/home/evan/dev/cadmium-vision/data/cadmium-data/1c0f82e3e12b332eea22c3b2db50ac1bdf94cf92839a09d0a36f936230a50196/39103217/2023_10_5_14_53_3/seg_10.png"
# input_path = "./colorize/vectorization/vtrace_input/xera_spacesuit.png"
# input_path = "./vectorization/test_images/monster.png"
input_path = "./data/cadmium-data-2024_03_28-cleaned/fd747914c3b59c6dc0c01a0a9636c34eae7986cc7c94df9f523205ef8c2419ff/90507113/2023_9_8_6_46_53/seg_35.png"

output_folder = "./colorize/vectorization/vtrace_output"

os.makedirs(output_folder, exist_ok=True)
output_path= os.path.join(output_folder, 'out.svg')

vec_args = VecArgs(
    corner_threshold=60,
    max_iterations=10,
    length_threshold=4.0,
    splice_threshold=10,
    path_precision=0,
    max_error_simp=2.0,
)


if __name__ == '__main__':

    seg_frame = SegImageFrame.from_file(input_path)
    seg_image = seg_frame.image_data.astype(np.int32)
    unique_ids = np.unique(seg_image)
    print(f'Input image has {len(unique_ids)} segments')

    resized_seg_image = resize_proportionally(seg_image, (640, 640))
    resized_unique_ids = np.unique(resized_seg_image)
    print(f'Resized image has {len(resized_unique_ids)} segments')
    
    start = time.time()
    
    if len(unique_ids) != len(resized_unique_ids):
        id_map = create_id_offset_map(unique_ids, resized_unique_ids)
    else:
        id_map = None

    svg = vectorize(resized_seg_image, vec_args, id_map)
    
    print('Vectorization time: ', time.time() - start)

    proc_svg_image = svg.draw(random_colors=True)
    proc_svg_image.save(os.path.join(output_folder, 'raw_svg.png'))

    # Prep SVG
    start = time.time()
    path_tensors = svg.to_tensor(return_point_dim=False)
    print(f"Output tensor has shape: {path_tensors.shape}")
    print(f'Prep time: {time.time() - start}')

    svg_tensor_packed, lengths, attn_mask = pack_sequences(path_tensors)
    valid_packed_tensor_mask = torch.all(svg_tensor_packed != -100, dim=-1)
    unpacked_tensor = unpack_sequences(svg_tensor_packed, valid_packed_tensor_mask, path_tensors)

    print(f'Packed tensor has shape: {svg_tensor_packed.shape}')
    print(f'Unpacked tensor has shape: {unpacked_tensor.shape}')

    # grid_image = image_grid([raster_image, raw_svg_image, prepped_svg_image], rows=1, cols=3)
    
    
