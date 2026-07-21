import numpy as np
from scipy import ndimage
import time

from segmentation.trapped_ball.trapped_ball import show_fill_map, thinning

def merge_small_regions(label_img, min_pixels):
    label_img = label_img.copy()
    struct = np.ones((3, 3), dtype=bool)
    changed = True

    while changed:
        changed = False
        counts = np.bincount(label_img.ravel())
        small_labels = np.where((counts > 0) & (counts < min_pixels))[0]
        small_labels = small_labels[small_labels != 0]  # exclude background

        if len(small_labels) == 0:
            break

        for lbl in small_labels:
            mask = label_img == lbl

            # dilate region and look at neighbors
            dilated = ndimage.binary_dilation(mask, structure=struct)
            neighbors = label_img[dilated & ~mask]

            # exclude background and self
            neighbors = neighbors[(neighbors != 0) & (neighbors != lbl)]
            if len(neighbors) == 0:
                continue

            # assign to most frequent neighboring label
            new_lbl = np.bincount(neighbors).argmax()
            label_img[mask] = new_lbl
            changed = True  # indicate that a merge was performed

    return label_img


def connected_components(combined_boundary_binary_normalized):

    # close 1px gaps
    # structure = np.ones((3, 3), dtype=bool)
    # closed = ndimage.binary_closing(
    #     combined_boundary_binary_normalized,
    #     structure=structure,
    #     iterations=1
    # )

    # Treat image borders as boundary lines
    closed = combined_boundary_binary_normalized.copy()
    closed[:2, :] = 1    # top 2 rows
    closed[-2:, :] = 1   # bottom 2 rows
    closed[:, :2] = 1    # left 2 columns
    closed[:, -2:] = 1   # right 2 columns

    closed_inverted = 1 - closed

    # detect connected components
    time_start = time.time()
    labeled_regions, num_regions = ndimage.label(closed_inverted)
    time_end = time.time()
    print(f"Time taken for connected components: {time_end - time_start} seconds")

    # remove small regions
    time_start = time.time()
    labeled_regions = merge_small_regions(labeled_regions, min_pixels=10)
    time_end = time.time()
    print(f"Time taken for merge small regions: {time_end - time_start} seconds")

    time_start = time.time()
    labeled_regions = thinning(labeled_regions)
    time_end = time.time()
    print(f"Time taken for thinning: {time_end - time_start} seconds")

    return labeled_regions, num_regions
