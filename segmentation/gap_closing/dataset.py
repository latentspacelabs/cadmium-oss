from typing import Optional
import random
import os

import numpy as np
import cv2
import torch
from torch.utils.data import Dataset
import albumentations as A
from skimage.morphology import closing, disk

from segmentation.gap_closing.file import find_line_images
from segmentation.gap_closing.line import (
    skeletonize,
    detect_endpoints,
    add_junction_gaps,
    crop_around_lines_binary_with_retry,
)
from segmentation.gap_closing.brush import apply_brush_augmentation


class GapLineDataset(Dataset):
    """PyTorch Dataset for real line images with on-the-fly UDF computation and gap generation."""
    
    def __init__(
        self, 
        crop_size: int = 512,
        augment_prob: float = 0.5,
        junction_gap_min: float = 0.1,
        junction_gap_max: float = 0.5,
        junction_gap_cap: int = 10,
        corner_gap_min: float = 0.1,
        corner_gap_max: float = 0.3,
        corner_gap_cap: int = 10,
        random_gap_min: int = 0,
        random_gap_max: int = 5,
        deduplicate_points: bool = True,
        min_point_distance: int = 3,
        gap_length_min: int = 1,
        gap_length_max: int = 24,
        gap_width: int = 2,
        min_gap_distance: int = 0,
        min_endpoint_distance: int = 5,
        brush_augment_prob: float = 0.7,
        speckle_prob: float = 0.1,
        line_focal_distance_threshold: float = 4.5,
        udf_max_dist: float = 50.0,
        verbose: bool = False,
    ):
        """
        Args:
            crop_size: Size of random crops (default 512x512)
            augment_prob: Probability of applying data augmentation
            junction_gap_min: Minimum probability of gaps at junction points (0.0-1.0, default 0.1)
            junction_gap_max: Maximum probability of gaps at junction points (0.0-1.0, default 0.5)
            junction_gap_cap: Hard cap on number of junction gaps (default 10)
            corner_gap_min: Minimum probability of gaps at corner points (0.0-1.0, default 0.1)
            corner_gap_max: Maximum probability of gaps at corner points (0.0-1.0, default 0.3)
            corner_gap_cap: Hard cap on number of corner gaps (default 10)
            random_gap_min: Minimum number of gaps at random points (absolute, default 0)
            random_gap_max: Maximum number of gaps at random points (absolute, default 5)
            deduplicate_points: Whether to deduplicate nearby detected points (default True)
            min_point_distance: Minimum distance between deduplicated points (default 3)
            gap_length_min: Minimum length of gap erosion in pixels along skeleton (default 1)
            gap_length_max: Maximum length of gap erosion in pixels along skeleton (default 24)
            gap_width: Width/radius of the eraser in pixels (default 2)
            min_gap_distance: Minimum distance between selected gap points (default 0 = no constraint)
            min_endpoint_distance: Minimum distance from endpoints for gap placement (default 5)
            brush_augment_prob: Probability of applying brush augmentation to all lines (default 0.7)
            speckle_prob: Probability of applying speckle noise augmentation (default 0.1)
            line_focal_distance_threshold: Distance threshold for focal region around gap/line pixels (default 4.5)
            udf_max_dist: Maximum distance for UDF normalization (default 50.0). UDF will be clipped and normalized to [0, 1]
        """
        self.crop_size = crop_size
        self.augment_prob = augment_prob
        self.junction_gap_min = junction_gap_min
        self.junction_gap_max = junction_gap_max
        self.junction_gap_cap = junction_gap_cap
        self.corner_gap_min = corner_gap_min
        self.corner_gap_max = corner_gap_max
        self.corner_gap_cap = corner_gap_cap
        self.random_gap_min = random_gap_min
        self.random_gap_max = random_gap_max
        self.deduplicate_points = deduplicate_points
        self.min_point_distance = min_point_distance
        self.gap_length_min = gap_length_min
        self.gap_length_max = gap_length_max
        self.gap_width = gap_width
        self.min_gap_distance = min_gap_distance
        self.min_endpoint_distance = min_endpoint_distance
        self.brush_augment_prob = brush_augment_prob
        self.speckle_prob = speckle_prob
        self.line_focal_distance_threshold = line_focal_distance_threshold
        self.udf_max_dist = udf_max_dist
        self.verbose = verbose

        self.image_paths = find_line_images()
        
        print(f"Found {len(self.image_paths)} line images")
    
    def _handle_invalid_image(self, idx: int):
        """Handle invalid image by picking another index."""
        next_idx = (idx + 1) % len(self.image_paths)
        return self.__getitem__(next_idx)
    
    def __len__(self) -> int:
        return len(self.image_paths)
    
    def __getitem__(self, idx: int):
        """
        Returns:
            Dictionary with keys:
            - 'lines': Clean skeletonized line (target) [1, H, W]
            - 'gap_lines_raw': Skeleton with gaps (thin lines, no brush augmentation) [1, H, W]
            - 'gap_lines_brush': Skeleton with gaps + brush augmentation (thickened input) [1, H, W]
            - 'udf': Unsigned distance field computed from clean skeleton [1, H, W]
            - 'gap_focal_mask': Binary mask of gap focal region [1, H, W]
            - 'gap_weights': Distance weights for gap focal region [1, H, W]
            - 'skeleton_focal_mask': Binary mask of skeleton focal region [1, H, W]
            - 'skeleton_weights': Distance weights for skeleton focal region [1, H, W]
            - 'junction_points': Dictionary with keys 'junction', 'corner', 'endpoint_before_gaps', 'endpoint_after_gaps', 'random'
        """
        image_path = self.image_paths[idx]
 
        # Load the RGBA image (don't binarize yet)
        rgba_image = GapLineDataset.load_rgba(image_path)

        # Check if image is RGBA (should have 4 channels in last dimension)
        if rgba_image.ndim != 3 or rgba_image.shape[2] != 4:
            return self._handle_invalid_image(idx)

        # Apply geometric augmentation on RGBA image before binarization
        if random.random() < self.augment_prob:
            rgba_image = self._augment_geometric_rgba(rgba_image)

        # Binarize the cropped RGBA image 
        cropped_binary = GapLineDataset.binarize_rgba(rgba_image)

        # Crop to 512px around lines
        cropped_binary = crop_around_lines_binary_with_retry(cropped_binary, self.crop_size)
        if cropped_binary is None:
            return self._handle_invalid_image(idx)

        # First, skeletonize the thick binary lines to get clean skeleton (target)
        binary_uint8 = (cropped_binary > 0.01).astype(np.uint8) * 255
        skeleton = skeletonize(binary_uint8)
        skeleton_float = skeleton.astype(np.float32) / 255.0
        
        # Create gaps in the SKELETON with advanced gap generation
        # This creates thin lines with gaps that will be thickened by brush augmentation
        do_add_gaps = (self.junction_gap_max > 0 or self.corner_gap_max > 0 or self.random_gap_max > 0)
        if do_add_gaps:
            skeleton_with_gaps, junction_points, _ = add_junction_gaps(
                skeleton_float,  # Skeleton to add gaps to
                junction_gap_min=self.junction_gap_min,
                junction_gap_max=self.junction_gap_max,
                junction_gap_cap=self.junction_gap_cap,
                corner_gap_min=self.corner_gap_min,
                corner_gap_max=self.corner_gap_max,
                corner_gap_cap=self.corner_gap_cap,
                random_gap_min=self.random_gap_min,
                random_gap_max=self.random_gap_max,
                deduplicate=self.deduplicate_points,
                min_point_distance=self.min_point_distance,
                gap_length_min=self.gap_length_min,
                gap_length_max=self.gap_length_max,
                gap_width=self.gap_width,
                min_gap_distance=self.min_gap_distance,
                min_endpoint_distance=self.min_endpoint_distance,
            )
            
            # Recompute endpoints after gaps are created (topology has changed)
            # Also get distance map from new endpoints for focal masking
            endpoint_list, endpoint_distance_map = detect_endpoints(
                skeleton_with_gaps,
                deduplicate=self.deduplicate_points,
                min_point_distance=self.min_point_distance,
                return_distance_map=True,
            )
            
            # Update junction_points with recomputed endpoints
            junction_points['endpoint_before_gaps'] = junction_points.pop('endpoint')
            junction_points['endpoint_after_gaps'] = endpoint_list
        else:
            # No gaps
            skeleton_with_gaps = skeleton_float
            junction_points = {'junction': [], 'corner': [], 'endpoint_before_gaps': [], 'endpoint_after_gaps': [], 'random': []}
            endpoint_distance_map = None
        
        # Apply brush augmentation to the skeleton with gaps to thicken it
        # This creates varied line thickness from the thin skeleton
        if self.brush_augment_prob > 0 and random.random() < self.brush_augment_prob:
            apply_blur = random.random() < 0.5
            apply_motion_variation = random.random() < 0.1

            skeleton_with_gaps_augmented, _ = apply_brush_augmentation(
                skeleton_with_gaps, 
                verbose=self.verbose,
                apply_blur=apply_blur,
                apply_variation=apply_motion_variation,
            )
        else:
            # No brush augmentation - keep as thin skeleton with gaps
            skeleton_with_gaps_augmented = skeleton_with_gaps
        
        # Compute UDF from the clean skeleton (target, no gaps)
        udf = self._compute_udf(skeleton_float)
        
        # Compute focal masks for gap and line regions
        # Gap pixels: where target skeleton has lines but input doesn't
        gap_pixels = ((skeleton_float > 0.01) & (skeleton_with_gaps < 0.01)).astype(np.float32)
        gap_focal_mask, gap_distance_weights = self._compute_focal_mask(gap_pixels)
        
        # Line pixels: existing lines in the skeleton with gaps (before augmentation)
        line_pixels = (skeleton_with_gaps > 0.01).astype(np.float32)
        line_focal_mask, line_distance_weights = self._compute_focal_mask(line_pixels)
        
        # Create endpoint mask to remove regions close to any endpoint
        # Reuse the distance map computed during endpoint detection
        if endpoint_distance_map is not None:
            endpoint_focal_mask = (endpoint_distance_map <= self.line_focal_distance_threshold).astype(np.float32)
        else:
            endpoint_focal_mask = np.zeros_like(skeleton_float)
        
        # Remove pixels in the gap focal region and endpoint region from line focal mask and weights
        line_focal_mask = line_focal_mask * (1 - gap_focal_mask) * (1 - endpoint_focal_mask)
        line_distance_weights = line_distance_weights * (1 - gap_focal_mask) * (1 - endpoint_focal_mask)
        
        # Convert to tensors
        skeleton_tensor = torch.from_numpy(skeleton_float).unsqueeze(0).float()
        skeleton_with_gaps_tensor = torch.from_numpy(skeleton_with_gaps).unsqueeze(0).float()
        skeleton_with_gaps_augmented_tensor = torch.from_numpy(skeleton_with_gaps_augmented).unsqueeze(0).float()
        udf = torch.from_numpy(udf).unsqueeze(0).float()
        gap_focal_mask = torch.from_numpy(gap_focal_mask).unsqueeze(0).float()
        gap_distance_weights = torch.from_numpy(gap_distance_weights).unsqueeze(0).float()
        line_focal_mask = torch.from_numpy(line_focal_mask).unsqueeze(0).float()
        line_distance_weights = torch.from_numpy(line_distance_weights).unsqueeze(0).float()

        # Return everything in a single dictionary
        return {
            'lines': skeleton_tensor,  # Clean skeleton (target)
            'gap_lines_raw': skeleton_with_gaps_tensor,  # Skeleton with gaps (thin lines)
            'gap_lines_brush': skeleton_with_gaps_augmented_tensor,  # Skeleton with gaps + brush augmentation (input)
            'udf': udf,
            'gap_focal_mask': gap_focal_mask,
            'gap_weights': gap_distance_weights,
            'skeleton_focal_mask': line_focal_mask,
            'skeleton_weights': line_distance_weights,
            'junction_points': junction_points,
        }
    
    @staticmethod
    def load_rgba(filepath: str) -> np.ndarray:
        # already RGBA
        if "handdrawn-data" in filepath:  
            image = cv2.imread(filepath, cv2.IMREAD_UNCHANGED)
            if image is None:
                raise ValueError(f"Failed to load image: {filepath}")
            return image

        # otherwise assume the image is grayscale
        image = cv2.imread(filepath, cv2.IMREAD_UNCHANGED)
        if image is None:
            raise ValueError(f"Failed to load image: {filepath}")
        if "gap_close_lines_v1" not in filepath:
            image = 255 - image.astype(np.float32)
        image = np.stack([image, image, image, image], axis=2)

        return image
    
    @staticmethod
    def binarize_rgba(
        rgba_image: np.ndarray, 
        binarize_method: str = 'adaptive_mean',
        morphology_radius: int = 0
    ) -> np.ndarray:
        """Binarize an RGBA image to get binary line mask.
        
        Static method that can be reused in other modules (e.g., tiling.py).
        
        Args:
            rgba_image: RGBA image (H, W, 4)
            binarize_method: Binarization method ('adaptive_mean', 'threshold')
            morphology_radius: Radius of disk structuring element for closing operation (default 1)
                           
        Returns:
            Binary line image (H, W) as float32 [0, 1]
        """
        # Apply morphological closing to alpha channel before binarization
        # Extract alpha channel as grayscale
        alpha = rgba_image[:, :, 3]

        if morphology_radius > 0:
            # Apply closing directly on grayscale alpha
            selem = disk(morphology_radius)
            alpha_modified = closing(alpha, selem)
            
            # Reconstruct RGBA image with modified alpha
            rgba_image = rgba_image.copy()
            rgba_image[:, :, 3] = alpha_modified
        
        if binarize_method == 'adaptive_mean':
            # Extract alpha channel (inverted - dark lines on white background)
            alpha = 255 - rgba_image[:, :, 3]
            
            # Ensure alpha is uint8 and contiguous for OpenCV
            alpha = np.ascontiguousarray(alpha, dtype=np.uint8)
            # Adaptive mean thresholding
            binary = cv2.adaptiveThreshold(
                alpha, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY,
                blockSize=51, C=2
            )
        else:
            binary = cv2.threshold(rgba_image[:, :, 3], 240, 255, cv2.THRESH_BINARY)[1]
        
        # Convert to float [0, 1] and invert (1 = line, 0 = background)
        result = binary.astype(np.float32) / 255.0
        result = 1 - result
        return result
    
    def _augment_geometric_rgba(self, rgba_image: np.ndarray) -> tuple[np.ndarray, float]:
        """Apply geometric augmentations to RGBA image using Albumentations.
        
        This preserves more information during interpolation compared to binarized images.
        
        Returns:
            tuple: (augmented_rgba, scale_factor)
        """
        # Build Albumentations pipeline
        transforms = []
        
        # 1. Basic flips and rotations (always applied)
        transforms.extend([
            A.HorizontalFlip(p=0.5),
            A.VerticalFlip(p=0.5),
            A.RandomRotate90(p=0.5),
        ])
        
        transforms.extend([
            # Scaling (zoom in only: 1.0-1.3x)
            A.Affine(
                scale=(1.0, 1.3),
                p=0.3,
                interpolation=cv2.INTER_LINEAR,
                keep_ratio=True,
            ),
            # Small angle rotations
            A.Affine(
                rotate=(-15, 15),
                p=0.3,
                interpolation=cv2.INTER_LINEAR,
            ),
            # Thin Plate Spline warping (replaces perspective + elastic)
            A.ThinPlateSpline(
                p=0.1,
                scale_range=(0.2, 0.3),
                num_control_points=2,
                interpolation=cv2.INTER_NEAREST,
            ),
        ])
        
        # Compose all transforms
        transform = A.Compose(transforms)
        
        # Apply transforms
        augmented = transform(image=rgba_image)['image']
        
        return augmented
     
    def _compute_udf(self, image: np.ndarray) -> np.ndarray:
        """Compute normalized Unsigned Distance Field using OpenCV distance transform.
        
        Returns:
            Normalized UDF in range [0, 1] where 0 = on line, 1 = distance >= max_dist
        """
        # Convert to binary image (line pixels = 0, background = 1) - faster single comparison
        # For distance transform, we need background=1 to compute distance to lines (=0)
        binary = (image < 0.01).astype(np.uint8)
        
        # Early exit for empty images
        if cv2.countNonZero(binary) == 0:
            # No background (all lines), return zeros
            return np.zeros(image.shape, dtype=np.float32)
        
        # Compute distance transform with faster mask (5x5 instead of PRECISE)
        # DIST_MASK_5 is much faster and the accuracy difference is negligible for our use case
        dist_transform = cv2.distanceTransform(binary, cv2.DIST_L2, 5).astype(np.float32)
        
        # Normalize: clip to max_dist and scale to [0, 1]
        normalized_udf = np.clip(dist_transform / self.udf_max_dist, 0.0, 1.0)
        
        return normalized_udf
    
    def _compute_focal_mask(
        self,
        focal_pixels: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Compute focal mask and distance-based weights from focal pixels.
        
        Args:
            focal_pixels: Binary mask of focal pixels (e.g., gap pixels or line pixels)
            
        Returns:
            tuple of (focal_mask, distance_weights):
                - focal_mask: Binary mask (1 where distance <= threshold, 0 elsewhere)
                - distance_weights: Continuous weights based on distance (higher weight = closer to focal pixels)
        """
        # Check if there are any focal pixels using faster method
        if not np.any(focal_pixels > 0):
            # No focal pixels - return all zeros (no focal region)
            return np.zeros_like(focal_pixels, dtype=np.float32), np.zeros_like(focal_pixels, dtype=np.float32)
        
        # Compute distance from focal pixels using OpenCV
        # Invert because we want distance FROM the focal pixels
        # Use DIST_MASK_3 (faster) since threshold is small (~4.5 pixels)
        binary = (1 - focal_pixels).astype(np.uint8)
        dist_transform = cv2.distanceTransform(binary, cv2.DIST_L2, 3)
        
        # Compute both mask and weights from the same distance transform
        threshold = self.line_focal_distance_threshold
        # Weight = (threshold - distance) / threshold, clipped to [0, 1]
        # This gives weight=1.0 at focal pixels, and weight=0.0 at threshold distance
        dist_weights = np.maximum(0.0, (threshold - dist_transform) / threshold).astype(np.float32)
        # Focal mask is simply where weights > 0
        focal_mask = (dist_weights > 0).astype(np.float32)
        
        return focal_mask, dist_weights


if __name__ == "__main__":
    # Write out samples for inspection
    import matplotlib.pyplot as plt
    import argparse
    
    parser = argparse.ArgumentParser(description='Write out samples from real dataset for inspection')
    parser.add_argument('--data_dir', type=str, default='/home/evan/dev/cadmium-vision/data/real-data',
                        help='Path to real-data directory')
    parser.add_argument('--num_samples', type=int, default=10,
                        help='Number of samples to write out')
    parser.add_argument('--output_dir', type=str, default='real_samples_inspection',
                        help='Directory to save sample visualizations')
    parser.add_argument('--crop_size', type=int, default=512,
                        help='Crop size for samples')
    parser.add_argument('--augment_prob', type=float, default=0.5,
                        help='Whether to apply data augmentation')
    parser.add_argument('--junction_gap_min', type=float, default=0.1,
                        help='Minimum probability of gaps at junction points (0.0-1.0)')
    parser.add_argument('--junction_gap_max', type=float, default=0.5,
                        help='Maximum probability of gaps at junction points (0.0-1.0)')
    parser.add_argument('--junction_gap_cap', type=int, default=10,
                        help='Hard cap on number of junction gaps')
    parser.add_argument('--corner_gap_min', type=float, default=0.1,
                        help='Minimum probability of gaps at corner points (0.0-1.0)')
    parser.add_argument('--corner_gap_max', type=float, default=0.3,
                        help='Maximum probability of gaps at corner points (0.0-1.0)')
    parser.add_argument('--corner_gap_cap', type=int, default=10,
                        help='Hard cap on number of corner gaps')
    parser.add_argument('--random_gap_min', type=int, default=0,
                        help='Minimum number of gaps at random points (absolute)')
    parser.add_argument('--random_gap_max', type=int, default=5,
                        help='Maximum number of gaps at random points (absolute)')
    parser.add_argument('--deduplicate', action='store_true',
                        help='Whether to deduplicate nearby detected points (recommended: True)')
    parser.add_argument('--min_point_distance', type=int, default=3,
                        help='Minimum distance between deduplicated points')
    parser.add_argument('--gap_length_min', type=int, default=1,
                        help='Minimum length of gap erosion in pixels along skeleton')
    parser.add_argument('--gap_length_max', type=int, default=24,
                        help='Maximum length of gap erosion in pixels along skeleton')
    parser.add_argument('--gap_width', type=int, default=2,
                        help='Width/radius of the eraser in pixels')
    parser.add_argument('--min_gap_distance', type=int, default=0,
                        help='Minimum distance between selected gap points (0 = no constraint)')
    parser.add_argument('--min_endpoint_distance', type=int, default=5,
                        help='Minimum distance from endpoints for gap placement (0 = no constraint)')
    parser.add_argument('--brush_augment_prob', type=float, default=0.7,
                        help='Probability of applying brush augmentation to all lines')
    parser.add_argument('--speckle_prob', type=float, default=0.1,
                        help='Probability of applying speckle noise augmentation')
    parser.add_argument('--line_focal_distance_threshold', type=float, default=4.5,
                        help='Distance threshold for focal region around gap/line pixels')
    parser.add_argument('--udf_max_dist', type=float, default=50.0,
                        help='Maximum distance for UDF normalization')
    parser.add_argument('--verbose', action='store_true',
                        help='Verbose output')
    args = parser.parse_args()
    
    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)
    
    print("Creating dataset...")
    dataset = GapLineDataset(
        crop_size=args.crop_size,
        augment_prob=args.augment_prob,
        junction_gap_min=args.junction_gap_min,
        junction_gap_max=args.junction_gap_max,
        junction_gap_cap=args.junction_gap_cap,
        corner_gap_min=args.corner_gap_min,
        corner_gap_max=args.corner_gap_max,
        corner_gap_cap=args.corner_gap_cap,
        random_gap_min=args.random_gap_min,
        random_gap_max=args.random_gap_max,
        deduplicate_points=args.deduplicate,
        min_point_distance=args.min_point_distance,
        gap_length_min=args.gap_length_min,
        gap_length_max=args.gap_length_max,
        gap_width=args.gap_width,
        min_gap_distance=args.min_gap_distance,
        min_endpoint_distance=args.min_endpoint_distance,
        brush_augment_prob=args.brush_augment_prob,
        speckle_prob=args.speckle_prob,
        line_focal_distance_threshold=args.line_focal_distance_threshold,
        udf_max_dist=args.udf_max_dist,
        verbose=args.verbose,
    )
    print(f"Dataset size: {len(dataset)}")
    
    num_samples = min(args.num_samples, len(dataset))
    indices = np.linspace(0, len(dataset) - 1, num_samples, dtype=int)

    print(f"\nWriting out {num_samples} samples with 2x3 grid visualization for inspection...")

    for idx, i in enumerate(indices):
        print(f"\nSample {idx} (dataset index {i}):")
        print(f"  Source: {dataset.image_paths[i]}")

        sample = dataset[i]
        junction_points = sample['junction_points']

        print(f"  Junction points found:")
        print(f"    - Junctions: {len(junction_points['junction'])}")
        print(f"    - Corners: {len(junction_points['corner'])}")
        print(f"    - Endpoints before gaps: {len(junction_points['endpoint_before_gaps'])}")
        print(f"    - Endpoints after gaps: {len(junction_points['endpoint_after_gaps'])}")
        
        # Prepare line images
        lines_img = (sample['lines'].squeeze().cpu().numpy() * 255).astype('uint8')
        gaps_img = (sample['gap_lines_raw'].squeeze().cpu().numpy() * 255).astype('uint8')
        gaps_aug_img = (sample['gap_lines_brush'].squeeze().cpu().numpy() * 255).astype('uint8')
        
        # Prepare focal masks
        gap_mask_img = (sample['gap_focal_mask'].squeeze().cpu().numpy() * 255).astype('uint8')
        skeleton_mask_img = (sample['skeleton_focal_mask'].squeeze().cpu().numpy() * 255).astype('uint8')

        # Ensure images are 2D
        if lines_img.ndim == 3:
            lines_img = lines_img[0]
        if gaps_img.ndim == 3:
            gaps_img = gaps_img[0]
        if gaps_aug_img.ndim == 3:
            gaps_aug_img = gaps_aug_img[0]
        if gap_mask_img.ndim == 3:
            gap_mask_img = gap_mask_img[0]
        if skeleton_mask_img.ndim == 3:
            skeleton_mask_img = skeleton_mask_img[0]

        # Create visualization with endpoints on GT lines
        lines_with_endpoints = cv2.cvtColor(lines_img, cv2.COLOR_GRAY2BGR)
        
        # Draw endpoints on GT lines: Blue
        for y, x in junction_points['endpoint_before_gaps']:
            cv2.circle(lines_with_endpoints, (x, y), radius=3, color=(255, 0, 0), thickness=-1)
        
        # Add legend to the GT+endpoints visualization
        cv2.putText(lines_with_endpoints, "Endpoints before gaps: Blue", (5, 20), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 0, 0), 1, cv2.LINE_AA)
        
        # Create visualization with endpoints on gap lines (skeleton with gaps)
        gaps_with_endpoints = cv2.cvtColor(gaps_img, cv2.COLOR_GRAY2BGR)
        
        # Draw endpoints on gap lines: Blue
        for y, x in junction_points['endpoint_after_gaps']:
            cv2.circle(gaps_with_endpoints, (x, y), radius=3, color=(255, 0, 0), thickness=-1)
        
        # Add legend to the gaps+endpoints visualization
        cv2.putText(gaps_with_endpoints, "Endpoints after gaps: Blue", (5, 20), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 0, 0), 1, cv2.LINE_AA)
        
        # Create visualization with junction points
        lines_with_junctions = cv2.cvtColor(lines_img, cv2.COLOR_GRAY2BGR)
        
        # Draw junction points with different colors
        # Junctions: Red
        for y, x in junction_points['junction']:
            cv2.circle(lines_with_junctions, (x, y), radius=3, color=(0, 0, 255), thickness=-1)
        
        # Corners: Green
        for y, x in junction_points['corner']:
            cv2.circle(lines_with_junctions, (x, y), radius=3, color=(0, 255, 0), thickness=-1)
        
        # Endpoints: Blue
        for y, x in junction_points['endpoint_before_gaps']:
            cv2.circle(lines_with_junctions, (x, y), radius=3, color=(255, 0, 0), thickness=-1)
        
        # Add legend to the junction visualization
        legend_y = 30
        cv2.putText(lines_with_junctions, "Junctions: Red", (5, legend_y), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (0, 0, 255), 1, cv2.LINE_AA)
        cv2.putText(lines_with_junctions, "Corners: Green", (5, legend_y + 12), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (0, 255, 0), 1, cv2.LINE_AA)
        cv2.putText(lines_with_junctions, "Endpoints before gaps: Blue", (5, legend_y + 24), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 0, 0), 1, cv2.LINE_AA)

        # Create gap mask overlay with blue outline on lines
        gap_mask_overlay = cv2.cvtColor(lines_img, cv2.COLOR_GRAY2BGR)
        gap_contours, _ = cv2.findContours(gap_mask_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(gap_mask_overlay, gap_contours, -1, (255, 0, 0), 1)  # Blue outline
        
        # Create skeleton mask overlay with blue outline on lines
        skeleton_mask_overlay = cv2.cvtColor(gaps_img, cv2.COLOR_GRAY2BGR)
        skeleton_contours, _ = cv2.findContours(skeleton_mask_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(skeleton_mask_overlay, skeleton_contours, -1, (255, 0, 0), 1)  # Blue outline

        # Create 2x3 grid: Top row = line processing, Bottom row = focal masks
        top_row = np.concatenate([
            lines_with_endpoints,
            lines_with_junctions,
            gaps_with_endpoints,
        ], axis=1)
        
        bottom_row = np.concatenate([
            cv2.cvtColor(gaps_aug_img, cv2.COLOR_GRAY2BGR),
            gap_mask_overlay,
            skeleton_mask_overlay,
        ], axis=1)
        
        grid_img = np.concatenate([top_row, bottom_row], axis=0)
        
        # grid_img_bgr is already in BGR format
        grid_img_bgr = grid_img
        
        # Add image path as text on top
        image_path = dataset.image_paths[i]
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.4
        font_thickness = 1
        text_color = (0, 0, 255)  # Red in BGR
        text_bg_color = (255, 255, 255)  # White background
        
        # Get text size to create background rectangle
        (text_width, text_height), baseline = cv2.getTextSize(image_path, font, font_scale, font_thickness)
        
        # Draw white background for text
        cv2.rectangle(grid_img_bgr, (5, 5), (text_width + 15, text_height + baseline + 10), 
                        text_bg_color, -1)
        
        # Draw text on top
        cv2.putText(grid_img_bgr, image_path, (10, text_height + 10), 
                    font, font_scale, text_color, font_thickness, cv2.LINE_AA)

        # Save the grid image
        grid_path = os.path.join(args.output_dir, f'sample_{idx:03d}_grid.png')
        cv2.imwrite(grid_path, grid_img_bgr)
        print(f"  Saved 2x3 grid to: {grid_path}")

    print(f"\n✅ Wrote {num_samples} samples to {args.output_dir}/")
    print(f"Grid layout (2x3):")
    print(f"  Top row:    Clean Skeleton (Target) | Skeleton+Junctions | Skeleton w/ Gaps (Thin)")
    print(f"  Bottom row: Skeleton w/ Gaps + Brush (Input) | Gap Mask | Skeleton Mask")
    print(f"\nTo view samples, run:")
    print(f"  ls {args.output_dir}/")
