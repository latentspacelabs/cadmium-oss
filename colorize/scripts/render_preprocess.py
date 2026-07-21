import glob
import copy
import os
from typing import *

import numpy as np
from PIL import Image

from colorize.common.sequence import Sequence


if __name__ == '__main__':

    os.makedirs("./output", exist_ok=True)

    _seg_paths = glob.glob("./data/real-data/teentitan/SH031/tb_seg_neigborhood_3/*.png")
    seg_paths = sorted([file for file in _seg_paths if (not file.endswith('cleaned.png') and not file.endswith('rainbow.png'))])
    color_paths = glob.glob("./data/real-data/teentitan/SH031/color/*.png") 
    line_paths = glob.glob("./data/real-data/teentitan/SH031/line/*.png") 

    sequence = Sequence.from_full_scene_files(
        seg_paths=seg_paths,
        color_paths=color_paths,
        line_paths=line_paths,
        quantized_num_colors=256,
    )
    sequence.materialize(color_source='color_list')

    orig_color_images = [
        Image.fromarray(keyframe.color_frame.image_data.astype(np.uint8))
        for keyframe in sequence.frames
    ]

    names = [
        keyframe.color_path.split('/')[-1].split('.')[0]
        for keyframe in sequence.frames
    ]

    randomized_sequence = copy.deepcopy(sequence)
    randomized_sequence.map_to_random_color_palette()

    os.makedirs("./output", exist_ok=True)
    
    for name, orig_color_image, preproc_color_image, randomized_color_image in \
        zip(
            names,
            orig_color_images,
            sequence.render_color_key_frames(),
            randomized_sequence.render_color_key_frames()
        ):
        orig_color_image.save(f"./output/{name}_original.png")
        preproc_color_image.save(f"./output/{name}_preprocessed.png")
        randomized_color_image.save(f"./output/{name}_preprocessed_randomized.png")
