import cv2
import time
import numpy as np
from typing import *


def compute_seg_fast(binary, tb_sizes=[3,2,1], max_iter=10, min_seg_size=20):
    start = time.time()

    fills = []
    result = binary

    fill = trapped_ball_fill_multi(result, tb_sizes[0], method='max')
    fills += fill
    result = mark_fill(result, fill)

    fill = trapped_ball_fill_multi(result, tb_sizes[1], method=None)
    fills += fill
    result = mark_fill(result, fill)

    fill = trapped_ball_fill_multi(result, tb_sizes[2], method=None)
    fills += fill
    result = mark_fill(result, fill)

    fill = flood_fill_multi(result)
    fills += fill

    fillmap = build_fill_map(result, fills)
    # color_fillmap = show_fill_map(fillmap)
        
    merged_fillmap = merge_fill(fillmap, max_iter, min_seg_size)
    # color_merged_fillmap = show_fill_map(merged_fillmap)

    # save_as_masks(fillmap, output_path)

    thinned = thinning(merged_fillmap)
    # color_thinned = show_fill_map(thinned)

    unique, thinned = np.unique(thinned, return_inverse=True)
    num_segs = unique.shape[0]
    # print('num_seg', int(num_segs))

    # print('Number of unique segments {}'.format(len(unique)))

    # print('Time taken for image: {} sec'.format(time.time() - start))

    thinned = thinned.reshape((binary.shape[0], binary.shape[1])).astype(np.int32)
    # return fillmap, color_fillmap, merged_fillmap, color_merged_fillmap, thinned, color_thinned, len(unique)
    return thinned


def compute_seg_debug(binary, tb_sizes=[3,2,1], max_iter=10, min_seg_size=20): 
    start = time.time()

    fills = []
    result = binary

    fill = trapped_ball_fill_multi(result, tb_sizes[0], method='max')
    fills += fill
    result = mark_fill(result, fill)

    fill = trapped_ball_fill_multi(result, tb_sizes[1], method=None)
    fills += fill
    result = mark_fill(result, fill)

    fill = trapped_ball_fill_multi(result, tb_sizes[2], method=None)
    fills += fill
    result = mark_fill(result, fill)

    fill = flood_fill_multi(result)
    fills += fill

    fillmap = build_fill_map(result, fills)
    color_fillmap = show_fill_map(fillmap, set_line_to_black=True)
        
    merged_fillmap = merge_fill(fillmap, max_iter, min_seg_size)
    color_merged_fillmap = show_fill_map(merged_fillmap, set_line_to_black=True)

    # save_as_masks(fillmap, output_path)


    thinned = thinning(merged_fillmap)
    color_thinned = show_fill_map(thinned)

    unique, unique_counts = np.unique(thinned, return_counts=True)
    num_segs = unique.shape[0]
    print('num_seg', int(num_segs))

    print('Number of unique segments {}'.format(len(unique)))

    print('Time taken for image: {} sec'.format(time.time() - start))
    
    return fillmap, color_fillmap, merged_fillmap, color_merged_fillmap, thinned, color_thinned, len(unique)


def thinning(fillmap, max_iter=100):
    """Fill area of line with surrounding fill color.

    # Arguments
        fillmap: an image.
        max_iter: max iteration number.

    # Returns
        an image.
    """
    line_id = 0
    h, w = fillmap.shape[:2]
    result = fillmap.copy()

    for iterNum in range(max_iter):
        # Get points of line. if there is not point, stop.
        line_points = np.where(result == line_id)
        if not len(line_points[0]) > 0:
            break

        # Get points between lines and fills.
        line_mask = np.full((h, w), 255, np.uint8)
        line_mask[line_points] = 0
        line_border_mask = cv2.morphologyEx(line_mask, cv2.MORPH_DILATE,
                                            cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3)), anchor=(-1, -1),
                                            iterations=1) - line_mask
        line_border_points = np.where(line_border_mask == 255)

        result_tmp = result.copy()
        # Iterate over points, fill each point with nearest fill's id.
        for i, _ in enumerate(line_border_points[0]):
            x, y = line_border_points[1][i], line_border_points[0][i]

            if x - 1 > 0 and result[y][x - 1] != line_id:
                result_tmp[y][x] = result[y][x - 1]
                continue

            if x - 1 > 0 and y - 1 > 0 and result[y - 1][x - 1] != line_id:
                result_tmp[y][x] = result[y - 1][x - 1]
                continue

            if y - 1 > 0 and result[y - 1][x] != line_id:
                result_tmp[y][x] = result[y - 1][x]
                continue

            if y - 1 > 0 and x + 1 < w and result[y - 1][x + 1] != line_id:
                result_tmp[y][x] = result[y - 1][x + 1]
                continue

            if x + 1 < w and result[y][x + 1] != line_id:
                result_tmp[y][x] = result[y][x + 1]
                continue

            if x + 1 < w and y + 1 < h and result[y + 1][x + 1] != line_id:
                result_tmp[y][x] = result[y + 1][x + 1]
                continue

            if y + 1 < h and result[y + 1][x] != line_id:
                result_tmp[y][x] = result[y + 1][x]
                continue

            if y + 1 < h and x - 1 > 0 and result[y + 1][x - 1] != line_id:
                result_tmp[y][x] = result[y + 1][x - 1]
                continue

        result = result_tmp.copy()

    return result


fill_single_index = 0


def get_ball_structuring_element(radius):
    """Get a ball shape structuring element with specific radius for morphology operation.
    The radius of ball usually equals to (leaking_gap_size / 2).
    
    # Arguments
        radius: radius of ball shape.
             
    # Returns
        an array of ball structuring element.
    """
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))


def get_unfilled_point(image):
    """Get points belong to unfilled(value==255) area.

    # Arguments
        image: an image.

    # Returns
        an array of points.
    """
    y, x = np.where(image == 255)

    return np.stack((x.astype(int), y.astype(int)), axis=-1)


def exclude_area(image, radius):
    """Perform erosion on image to exclude points near the boundary.
    We want to pick part using floodfill from the seed point after dilation. 
    When the seed point is near boundary, it might not stay in the fill, and would
    not be a valid point for next floodfill operation. So we ignore these points with erosion.

    # Arguments
        image: an image.
        radius: radius of ball shape.

    # Returns
        an image after dilation.
    """
    return cv2.morphologyEx(image, cv2.MORPH_ERODE, get_ball_structuring_element(radius), anchor=(-1, -1), iterations=1)


def trapped_ball_fill_single(image, seed_point, radius):
    
    """Perform a single trapped ball fill operation.

    # Arguments
        image: an image. the image should consist of white background, black lines and black fills.
               the white area is unfilled area, and the black area is filled area.
        seed_point: seed point for trapped-ball fill, a tuple (integer, integer).
        radius: radius of ball shape.
    # Returns
        an image after filling.
    """
    global fill_single_index
    ball = get_ball_structuring_element(radius)

    pass1 = np.full(image.shape, 255, np.uint8)
    pass2 = np.full(image.shape, 255, np.uint8)

    im_inv = cv2.bitwise_not(image)

    # Floodfill the image
    mask1 = cv2.copyMakeBorder(im_inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, 0)
    _, pass1, _, _ = cv2.floodFill(pass1, mask1, seed_point, 0, 0, 0, 4)
    # cv2.imwrite( "single_fill_pass1_" + str(fill_single_index)+".png", pass1)
    # cv2.imwrite( "single_fill_mask1_" + str(fill_single_index)+".png", mask1)

    # Perform dilation on image. The fill areas between gaps became disconnected.
    pass1 = cv2.morphologyEx(pass1, cv2.MORPH_DILATE, ball, anchor=(-1, -1), iterations=1)
    mask2 = cv2.copyMakeBorder(pass1, 1, 1, 1, 1, cv2.BORDER_CONSTANT, 0)
    # cv2.imwrite( "single_fill_mask2_" + str(fill_single_index)+".png", mask2)

    # Floodfill with seed point again to select one fill area.
    _, pass2, _, rect = cv2.floodFill(pass2, mask2, seed_point, 0, 0, 0, 4)
    # Perform erosion on the fill result leaking-proof fill.
    pass2 = cv2.morphologyEx(pass2, cv2.MORPH_ERODE, ball, anchor=(-1, -1), iterations=1)
    # cv2.imwrite( "single_fill_pass2_" + str(fill_single_index)+".png", pass2)

    fill_single_index += 1
    return pass2


def trapped_ball_fill_multi(image, radius, method='mean', max_iter=1000):
    """Perform multi trapped ball fill operations until all valid areas are filled.

    # Arguments
        image: an image. The image should consist of white background, black lines and black fills.
               the white area is unfilled area, and the black area is filled area.
        radius: radius of ball shape.
        method: method for filtering the fills. 
               'max' is usually with large radius for select large area such as background.
        max_iter: max iteration number.
    # Returns
        an array of fills' points.
    """
    # print('trapped-ball ' + str(radius))

    unfill_area = image
    filled_area, filled_area_size, result = [], [], []

    for _ in range(max_iter):
        points = get_unfilled_point(exclude_area(unfill_area, radius))

        if not len(points) > 0:
            break

        fill = trapped_ball_fill_single(unfill_area, (points[0][0], points[0][1]), radius)
        unfill_area = cv2.bitwise_and(unfill_area, fill)

        filled_area.append(np.where(fill == 0))
        filled_area_size.append(len(np.where(fill == 0)[0]))

    if len(filled_area_size) == 0:
        return []
    else:
        filled_area_size = np.asarray(filled_area_size)
        if method == 'max':
            area_size_filter = np.max(filled_area_size)
        elif method == 'median':
            area_size_filter = np.median(filled_area_size)
        elif method == 'mean':
            area_size_filter = np.mean(filled_area_size)
        else:
            area_size_filter = 0

    result_idx = np.where(filled_area_size >= area_size_filter)[0]

    for i in result_idx:
        result.append(filled_area[i])

    return result


def flood_fill_single(im, seed_point):
    """Perform a single flood fill operation.

    # Arguments
        image: an image. the image should consist of white background, black lines and black fills.
               the white area is unfilled area, and the black area is filled area.
        seed_point: seed point for trapped-ball fill, a tuple (integer, integer).
    # Returns
        an image after filling.
    """
    pass1 = np.full(im.shape, 255, np.uint8)

    im_inv = cv2.bitwise_not(im)

    mask1 = cv2.copyMakeBorder(im_inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, 0)
    _, pass1, _, _ = cv2.floodFill(pass1, mask1, seed_point, 0, 0, 0, 4)

    return pass1


def flood_fill_multi(image, max_iter=20000):
    """Perform multi flood fill operations until all valid areas are filled.
    This operation will fill all rest areas, which may result large amount of fills.

    # Arguments
        image: an image. the image should contain white background, black lines and black fills.
               the white area is unfilled area, and the black area is filled area.
        max_iter: max iteration number.
    # Returns
        an array of fills' points.
    """
    # print('floodfill')

    unfill_area = image
    filled_area = []

    for _ in range(max_iter):
        points = get_unfilled_point(unfill_area)

        if not len(points) > 0:
            break

        fill = flood_fill_single(unfill_area, (points[0][0], points[0][1]))
        unfill_area = cv2.bitwise_and(unfill_area, fill)

        filled_area.append(np.where(fill == 0))

    return filled_area


def mark_fill(image, fills):
    """Mark filled areas with 0.

    # Arguments
        image: an image.
        fills: an array of fills' points.
    # Returns
        an image.
    """
    result = image.copy()

    for fill in fills:
        result[fill] = 0

    return result


def build_fill_map(image, fills):
    """Make an image(array) with each pixel(element) marked with fills' id. id of line is 0.

    # Arguments
        image: an image.
        fills: an array of fills' points.
    # Returns
        an array.
    """
    result = np.zeros(image.shape[:2], np.int32)

    for index, fill in enumerate(fills):
        result[fill] = index + 1

    return result


def show_fill_map(fillmap, set_line_to_black = False, set_padding_to_black = False):
    """Mark filled areas with colors. It is useful for visualization.

    # Arguments
        image: an image.
        fills: an array of fills' points.
    # Returns
        an image.
    """
    # Generate color for each fill randomly.
    colors = np.random.randint(0, 255, (np.max(fillmap) + 1, 3), dtype=np.uint8)

    if set_line_to_black:
        # Id of line is 0, and its color is black.
        colors[0] = [0, 0, 0]
    
    if set_padding_to_black:
        colors[0] = [0, 0, 0]
        fillmap[fillmap == -100] = 0

    return colors[fillmap]


def get_bounding_rect(points):
    """Get a bounding rect of points.

    # Arguments
        points: array of points.
    # Returns
        rect coord
    """
    x1, y1, x2, y2 = np.min(points[1]), np.min(points[0]), np.max(points[1]), np.max(points[0])
    return x1, y1, x2, y2


def get_border_bounding_rect(h, w, p1, p2, r):
    """Get a valid bounding rect in the image with border of specific size.

    # Arguments
        h: image max height.
        w: image max width.
        p1: start point of rect.
        p2: end point of rect.
        r: border radius.
    # Returns
        rect coord
    """
    x1, y1, x2, y2 = p1[0], p1[1], p2[0], p2[1]

    x1 = x1 - r if 0 < x1 - r else 0
    y1 = y1 - r if 0 < y1 - r else 0
    x2 = x2 + r + 1 if x2 + r + 1 < w else w
    y2 = y2 + r + 1 if y2 + r + 1 < h else h

    return x1, y1, x2, y2


def get_border_point(points, rect, max_height, max_width):
    """Get border points of a fill area

    # Arguments
        points: points of fill .
        rect: bounding rect of fill.
        max_height: image max height.
        max_width: image max width.
    # Returns
        points , convex shape of points
    """
    # Get a local bounding rect.
    border_rect = get_border_bounding_rect(max_height, max_width, rect[:2], rect[2:], 2)

    # Get fill in rect.
    fill = np.zeros((border_rect[3] - border_rect[1], border_rect[2] - border_rect[0]), np.uint8)
    # Move points to the rect.
    fill[(points[0] - border_rect[1], points[1] - border_rect[0])] = 255

    # Get shape.
    contours, _ = cv2.findContours(fill, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    approx_shape = cv2.approxPolyDP(contours[0], 0.02 * cv2.arcLength(contours[0], True), True)

    # Get border pixel.
    # Structuring element in cross shape is used instead of box to get 4-connected border.
    cross = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    border_pixel_mask = cv2.morphologyEx(fill, cv2.MORPH_DILATE, cross, anchor=(-1, -1), iterations=1) - fill
    border_pixel_points = np.where(border_pixel_mask == 255)

    # Transform points back to fillmap.
    border_pixel_points = (border_pixel_points[0] + border_rect[1], border_pixel_points[1] + border_rect[0])

    return border_pixel_points, approx_shape


def merge_fill(
    fillmap,
    max_iter=10,
    min_seg_size=20,
):
    max_height, max_width = fillmap.shape[:2]
    result = fillmap.copy()

    for i in range(max_iter):
        # print('merge ' + str(i + 1))

        result[np.where(fillmap == 0)] = 0

        fill_id = np.unique(result.flatten())
        fills = []

        for j in fill_id:
            point = np.where(result == j)

            fills.append({
                'id': j,
                'point': point,
                'area': len(point[0]),
                'rect': get_bounding_rect(point)
            })

        for j, f in enumerate(fills):
            # print('-------' * 3)
            
            # ignore lines
            if f['id'] == 0:
                continue
            
            # print(f'segment area: {f["area"]}')
            
            # border points are used to find the region with largest contact
            # approx shape influences the merging logic
            border_points, approx_shape = get_border_point(f['point'], f['rect'], max_height, max_width)
            border_pixels = result[border_points]
            pixel_ids, counts = np.unique(border_pixels, return_counts=True)
            
            # print(f'approx shape: {len(approx_shape)}')

            ids = pixel_ids[np.nonzero(pixel_ids)]
            
            # print(f'num border segments: {len(ids)}')
            
            if len(ids) == 0:
                if f['area'] < min_seg_size:
                    # print('found point surrounded by line')
                    # points with lines around color change to line color
                    new_id = 0
                else:
                    # print('found normal seg surrounded by line')
                    # regions surrounded by line remain the same
                    new_id = f['id']
            else:
                # new region id may be set to region with largest contact
                new_id = ids[0]

            # a point
            if len(approx_shape) == 1 or f['area'] == 1:
                # print('point merged')
                result[f['point']] = new_id

            # a non-complex shape that is also small-medium sized
            elif len(approx_shape) < 6 and f['area'] < 500:
                # print('complex shape merged')
                result[f['point']] = new_id

            # a complex shape but small and only one border segment
            elif f['area'] < 250 and len(ids) == 1:
                # print('single border segment merged')
                result[f['point']] = new_id

            # a complex shape that is very small
            elif f['area'] < (10 * min_seg_size):
                # print('small segment merged')
                result[f['point']] = new_id
            
        if len(fill_id) == len(np.unique(result.flatten())):
            break
    # print("mergefill", len(fill_id))
    return result




