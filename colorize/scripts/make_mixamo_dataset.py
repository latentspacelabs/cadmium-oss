import os
import argparse
import glob

import numpy as np
import cv2
from tqdm import tqdm
from skimage.measure import label

from colorize.common.ops import rgba_to_dense


def generate_boundary_lines(image: np.ndarray) -> np.ndarray:
    _, indices, indexed_image = np.unique(image, return_index=True, return_inverse=True)

    # Convert RGBA to dense color representation for easier comparison
    dense_colors = rgba_to_dense(indexed_image.astype(np.int32))

    unique_colors = np.unique(dense_colors)
    
    # Initialize output line image
    line_image = np.zeros_like(image)
    
    # For each unique color, find connected components and draw boundaries
    for color in unique_colors:
            
        # Create binary mask for this color
        color_mask = (dense_colors == color)
        
        # Find connected components
        labeled_regions, num_labels = label(color_mask, return_num=True)
        
        # For each connected component, find its boundary
        for region_id in range(0, num_labels + 1):
            region_mask = (labeled_regions == region_id)
            
            # Find boundary using morphological operations
            kernel = np.ones((3,3), np.uint8)
            dilated = cv2.dilate(region_mask.astype(np.uint8), kernel)
            eroded = cv2.erode(region_mask.astype(np.uint8), kernel)
            boundary = dilated - eroded

            # Add boundary to line image
            line_image[boundary > 0] = [0,0,0,255]
            
    return line_image



def process_image(image_path: str):
    image = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    
    boundary_lines = generate_boundary_lines(image)

    out_path = image_path.replace('color-unique', 'line')
    out_path = out_path.replace('.png', '_line.png')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cv2.imwrite(out_path, boundary_lines.astype(np.uint8))


def main():
    parser = argparse.ArgumentParser(description="Process color images to generate boundary lines and validate contiguous regions")
    parser.add_argument("--data_path", help="Input directory or glob pattern for images")
    parser.add_argument("--glob_pattern", help="Glob pattern for images")
    args = parser.parse_args()
    
    path = os.path.join(args.data_path, args.glob_pattern, '*', '*', '*.png')
    for image_path in tqdm(glob.glob(path), desc="Processing images"):
        process_image(image_path)
    

if __name__ == "__main__":
    main()
