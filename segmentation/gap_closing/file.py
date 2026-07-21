from typing import List
import glob
import random


def find_line_images() -> List[str]:
    line_images = []
    
    glob_patterns = [
        "data/real-data/**/**/seg_canny_neigborhood_51_color_lines/*.png",
        "data/anita-data/**/seg_canny_neigborhood_51_color_lines/**/*.png",
        # "data/animerun-data/seg/seg_canny_threshold_240/**/*.png",
        "data/handdrawn-data/**/line/*.png",
        "data/pbc-data/**/seg_canny/*.png",
        "data/synth-data/**/**/seg_canny/*.png",
        "data/cadmium-data-2025-10_06/*/*/*/seg_canny_lines/*.png",
    ]

    for glob_pattern in glob_patterns:
        image_files = glob.glob(glob_pattern)
        print(f"Found {len(image_files)} images in {glob_pattern}")
        line_images.extend(image_files)

    random.shuffle(line_images)
    return line_images


def find_seg_images() -> List[str]:
    seg_images = []
    
    glob_patterns = [
        # f"data/anita-data/**/tb_seg_neigborhood_51_color_lines/**/*.png",
        # f"data/real-data/**/**/tb_seg_neigborhood_51_color_lines/*.png",
        # "data/animerun-data/seg/tb_seg_threshold_240/**/*.png",
        "data/mixamo-data/**/**/tb_seg_3_2_1/*.png",
        # "data/pbc-data/**/tb_seg/*.png",
        # "data/synth-data/**/**/tb_seg/*.png",
    ]

    for glob_pattern in glob_patterns:
        image_files = glob.glob(glob_pattern, recursive=True)
        filtered_image_files = []
        for image_file in image_files:
            # Skip rainbow/visualization files
            if "rainbow" in image_file:
                continue
            filtered_image_files.append(image_file)
        print(f"Found {len(filtered_image_files)} images in {glob_pattern}")
        seg_images.extend(filtered_image_files)

    return seg_images
