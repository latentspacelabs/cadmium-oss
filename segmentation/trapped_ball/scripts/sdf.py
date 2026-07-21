import argparse
import time
import cv2

import numpy as np
import torch
from kornia.contrib import distance_transform

from segmentation.trapped_ball.line import binarize
from colorize.common.image import compute_sdf, compute_sdf_cupy


# Example usage
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--line_image_path', type=str, help='A single line images or directory containing line images')
    args = parser.parse_args()

    img = cv2.imread(args.line_image_path, cv2.IMREAD_UNCHANGED)

    binary_image = (binarize(img) != 0)
    binary_image_tensor = torch.from_numpy(binary_image).unsqueeze(0).cuda()

    # Compute the SDF
    for i in range(10):
        start = time.time()
        # sdf = compute_sdf(binary_image)
        # sdf = distance_transform(binary_image_tensor)
        sdf = compute_sdf_cupy(binary_image_tensor)
        print(f"SDF computation time: {time.time() - start} sec")
    
    print("Binary image shape:", binary_image.shape)
    print("SDF shape:", sdf.shape)
    print("Min SDF value:", sdf.min().item())
    print("Max SDF value:", sdf.max().item())
    
    # Visualize the results
    import matplotlib.pyplot as plt
    
    plt.figure(figsize=(12, 4))
    
    plt.subplot(121)
    plt.imshow(binary_image, cmap='binary')
    plt.title("Binary Line Image")
    plt.axis('off')
    
    plt.subplot(122)
    plt.imshow(sdf.squeeze().cpu(), cmap='RdBu_r')
    plt.colorbar(label='Distance')
    plt.title("Signed Distance Function")
    plt.axis('off')
    
    plt.tight_layout()
    plt.savefig("output_gpu.png")
