"""cv2 drawing helpers used by the inference CLI (the matplotlib
training-visualization suite lived here and left with the training code)."""

import numpy as np
import cv2


def draw_endpoints_on_image(image: np.ndarray, endpoints: list, color=(255, 0, 0), radius=3) -> np.ndarray:
    """Draw endpoints on image.
    
    Args:
        image: Grayscale image (H, W) or RGB image (H, W, 3)
        endpoints: List of (y, x) tuples
        color: BGR color tuple (default: red in BGR)
        radius: Circle radius (default: 3)
    
    Returns:
        RGB image with endpoints drawn
    """
    # Convert to RGB if grayscale
    if image.ndim == 2:
        image_rgb = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        image_rgb = image.copy()
    
    # Draw endpoints
    for y, x in endpoints:
        cv2.circle(image_rgb, (x, y), radius=radius, color=color, thickness=-1)
    
    return image_rgb
