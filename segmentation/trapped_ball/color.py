import cv2
import numpy as np


def canny_edge_color(rgba_image, low_threshold, high_threshold):
    # Split the image into its BGR channels
    if rgba_image.shape[-1] == 4:
        b, g, r, a = cv2.split(rgba_image)
    else:
        b, g, r = cv2.split(rgba_image)
    
    # Apply Canny edge detection to each channel
    edges_b = cv2.Canny(b, low_threshold, high_threshold)
    edges_g = cv2.Canny(g, low_threshold, high_threshold)
    edges_r = cv2.Canny(r, low_threshold, high_threshold)
    
    # Combine the edge maps
    edges = cv2.max(cv2.max(edges_b, edges_g), edges_r)
    
    return edges


def detect_edges(color_image):
    # gray = cv2.cvtColor(color_image, cv2.COLOR_BGR2GRAY)
    edges = canny_edge_color(color_image, 100, 200)
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (2, 2))
    dilated_edges = cv2.dilate(edges, kernel, iterations=1)
    return dilated_edges
    # return edges
    

def get_eroded_edges(binary_line_image, color_edges, line_mask_image):
    
    # Create a slightly smaller mask to avoid edge detection on the border
    kernel = np.ones((3,3), np.uint8)
    eroded_mask = cv2.erode(line_mask_image, kernel, iterations=1)

    # Apply the eroded mask to the edge image
    masked_edges = cv2.bitwise_and(color_edges, color_edges, mask=eroded_mask)
    
    # Combine the original image with the edges
    result = cv2.addWeighted(binary_line_image, 0.8, color_edges, 1, 0)
    
    # Apply the original mask to the result
    final_result = cv2.bitwise_and(result, result, mask=line_mask_image)

    final_result_masked = 255 * (final_result == 255).astype(np.uint8)
    
    return final_result_masked, masked_edges
