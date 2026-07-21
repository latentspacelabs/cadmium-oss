import os
import cv2
import argparse

from segmentation.trapped_ball.trapped_ball import compute_seg_debug
from segmentation.trapped_ball.cropping import crop_image

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--line_image_path', type=str, help='A single line images or directory containing line images')
    parser.add_argument('--output_path', type=str, help='Output dest folder (created if nonexistent)')
    parser.add_argument('--threshold_binary', type=int, default=100, help='threshold (0 - 255) for binarization of line image before segmentation')
    args = parser.parse_args()
    
    im = cv2.imread(args.line_image_path, cv2.IMREAD_UNCHANGED)
    im, vert_pad_dims, horiz_pad_dims = crop_image(im)
    
    im = 255 - im[:, :, 3]
    
    ret, binary = cv2.threshold(im, args.threshold_binary, 255, cv2.THRESH_BINARY) 
    
    unmerged_seg, unmerged_color_seg, merged_seg, merged_color_seg, thinned_seg, color_thinned_seg, num_unique = compute_seg_debug(binary) 
    

    output_path = os.path.join(args.output_path, os.path.splitext(os.path.basename(args.line_image_path))[0])
    os.makedirs(output_path, exist_ok=True)
    cv2.imwrite(os.path.join(output_path, 'unmerged_seg.png'), unmerged_seg)
    cv2.imwrite(os.path.join(output_path, 'unmerged_color_seg.png'), unmerged_color_seg)
    cv2.imwrite(os.path.join(output_path, 'merged_seg.png'), merged_seg)
    cv2.imwrite(os.path.join(output_path, 'merged_color_seg.png'), merged_color_seg)
    cv2.imwrite(os.path.join(output_path, 'thinned_seg.png'), thinned_seg)
    cv2.imwrite(os.path.join(output_path, 'color_thinned_seg.png'), color_thinned_seg)
