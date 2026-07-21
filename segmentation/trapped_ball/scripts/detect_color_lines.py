import argparse
import os

import cv2
import numpy as np

from segmentation.trapped_ball.color import detect_edges, get_eroded_edges
from segmentation.trapped_ball.line import binarize


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--line_image_path', type=str)
    parser.add_argument('--color_image_path', type=str)
    args = parser.parse_args()

    line_image = cv2.imread(args.line_image_path, cv2.IMREAD_UNCHANGED)
    color_image = cv2.imread(args.color_image_path, cv2.IMREAD_UNCHANGED)

    binary_line = binarize(line_image, neighborhood=51) 
    binary_line_mask = (binary_line != 0).astype(np.uint8)

    color_edges = 255 - detect_edges(color_image)
    result, eroded_edges = get_eroded_edges(binary_line, color_edges, binary_line_mask)


    # Display the results
    os.makedirs('./output', exist_ok=True)
    cv2.imwrite('./output/line_image.png', line_image)
    cv2.imwrite('./output/color_image.png', color_image)
    cv2.imwrite('./output/binary_image.png', binary_line)
    cv2.imwrite('./output/color_edges.png', color_edges)
    cv2.imwrite('./output/eroded_edges.png', eroded_edges)
    cv2.imwrite('./output/result.png', result)
