import cv2
import numpy as np


def binarize(img, type='adaptive_mean', threshold=None, neighborhood=51, constant=2, blur=None):
    if len(img.shape) == 3:
        im = 255 - img[:, :, 3]
    else:
        im = 255 - img
    if type == 'manual':
        assert threshold is not None
        assert threshold >= 0 and threshold < 255, 'line_threshold_param must be between 0 and 254'
        ret, binary = cv2.threshold(im, threshold, 255, cv2.THRESH_BINARY)
    elif type == 'adaptive_mean' or type == 'adaptive_gaussian':
        adaptive_thresh_type = cv2.ADAPTIVE_THRESH_MEAN_C if type == 'adaptive_mean' else cv2.ADAPTIVE_THRESH_GAUSSIAN_C
        binary = cv2.adaptiveThreshold(im, 255, adaptive_thresh_type, cv2.THRESH_BINARY, neighborhood, constant)
    elif type == 'otsu':
        _im = im.copy()
        if blur is not None:
            _im = cv2.GaussianBlur(_im, (blur, blur), 0)
        ret, binary = cv2.threshold(_im, 0, 255, cv2.THRESH_BINARY+cv2.THRESH_OTSU)
    return binary


def merge_bounding_boxes(bounding_boxes):

    def do_boxes_overlap(box1, box2):
        overlap_x = (box1[1] <= box2[3]) and (box1[3] >= box2[1])
        overlap_y = (box1[0] <= box2[2]) and (box1[2] >= box2[0])

        return overlap_x and overlap_y

    def merge_two_boxes(box1, box2):
        print('MERGE:', box1, box2)
        return (
            min(box1[0], box2[0]),
            min(box1[1], box2[1]),
            max(box1[2], box2[2]),
            max(box1[3], box2[3])
        )

    # Initially, consider all bounding boxes as candidates for merging
    remaining_boxes = bounding_boxes.copy()
    num_iters = 0

    while num_iters < 100:
        current_box = remaining_boxes.pop(0)

        # Find all nearby boxes to merge with
        nearby_boxes = [box for box in remaining_boxes if do_boxes_overlap(current_box, box)]
        print('NEARBY BOXES', nearby_boxes)

        # Merge current box with nearby boxes
        for box in nearby_boxes:
            current_box = merge_two_boxes(current_box, box)
            print('NEW BOX', current_box)

            # Mark the nearby box as merged
            del remaining_boxes[0]

        # Add the merged box to the result
        remaining_boxes.append(current_box)
        num_iters += 1

    print('REM', remaining_boxes)
    return remaining_boxes

def find_diff_regions_line(image1, image2, min_distance=64):
    differing_pixels = image1 != image2
    
    if np.sum(differing_pixels) == 0:
        # No differences found
        return []

    # Find bounding boxes for each initial region
    # initial_regions = find_objects(1 - differing_pixels.astype(np.uint8))
    # initial_boxes = [
    #     (slice1.start, slice2.start, slice1.stop, slice2.stop)
    #     for (slice1, slice2) in initial_regions
    # ]
    
    contours, _ = cv2.findContours(differing_pixels.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    initial_boxes = []
    for contour in contours:
        rect = cv2.boundingRect(contour)
        bounding_box = (
            max(rect[1] - min_distance, 0),
            max(rect[0] - min_distance, 0),
            min(rect[1] + rect[3] + min_distance, image1.shape[0]),
            min(rect[0] + rect[2] + min_distance, image1.shape[1])
        )
        initial_boxes.append(bounding_box)
        
    

    # Merge overlapping regions
    merged_bounding_boxes = merge_bounding_boxes(initial_boxes)

    # Convert to bounding boxes
    bounding_boxes = [
        {
            'min_row': min_row,
            'min_col': min_col,
            'max_row': max_row,
            'max_col': max_col
        }
        for (min_row, min_col, max_row, max_col) in merged_bounding_boxes
    ]

    return bounding_boxes
