import cv2
import time
import numpy as np
from matplotlib import pyplot as plt
import argparse



if __name__ == '__main__':

    parser = argparse.ArgumentParser()
    parser.add_argument('--line_image_path', type=str, help='A single line images or directory containing line images')
    # parser.add_argument('--output_path', type=str, help='Output dest folder (created if nonexistent)')
    # parser.add_argument('--threshold_binary', type=int, default=100, help='threshold (0 - 255) for binarization of line image before segmentation')
    args = parser.parse_args()

    img = cv2.imread(args.line_image_path, cv2.IMREAD_UNCHANGED)
    img = 255 - img[:, :, 3]
    # img = cv2.medianBlur(img,5)

    ret,th1 = cv2.threshold(img,127,255,cv2.THRESH_BINARY)
    ret,th3 = cv2.threshold(img,254,255,cv2.THRESH_BINARY)
    
    start = time.time() 
    th4 = cv2.adaptiveThreshold(img,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY,3, 2)
    th5 = cv2.adaptiveThreshold(img,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 2)
    th6 = cv2.adaptiveThreshold(img,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 101, 2)
    print("Gaussian time", time.time() - start)
    
    start = time.time() 
    th7 = cv2.adaptiveThreshold(img,255,cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 3, 2)
    th8 = cv2.adaptiveThreshold(img,255,cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 51, 2)
    th9 = cv2.adaptiveThreshold(img,255,cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 101, 2)
    print("Mean time", time.time() - start)

    titles = [
        'Original Image', 'Global (v = 127)', 'Global Thresholding (v = 255)',
        'Adaptive Gaussian 3', 'Adaptive Gaussian 51', 'Adaptive Gaussian 1001',
        'Adaptive Mean 3', 'Adaptive Mean 51', 'Adaptive Mean 1001',
    ]
    images = [img, th1, th3, th4, th5, th6, th7, th8, th9]

    for i in range(9):
        plt.subplot(3, 3,i+1),plt.imshow(images[i],'gray')
        plt.title(titles[i])
        plt.xticks([]),plt.yticks([])
    plt.savefig('./thresh.png', dpi=1200)
