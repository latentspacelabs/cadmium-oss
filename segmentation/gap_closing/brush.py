"""Brush augmentation utilities for simulating various drawing tools and line thickness."""

import random
import time
from typing import Dict, Tuple

import numpy as np
import cv2

from segmentation.gap_closing.line import (
    skeletonize, 
    crop_around_lines_binary_with_retry
)


def generate_brush_stamp(size: int, brush_type: str = 'random') -> np.ndarray:
    """Generate various brush stamp patterns to simulate different brush types.
    
    Args:
        size: Size of the stamp (odd number preferred)
        brush_type: Type of brush ('circular', 'rough', 'textured', 'splatter', 'dry', 
                   'marker', 'charcoal', 'ink', 'thick_marker', 'calligraphy', 'feathered', 'random')
        
    Returns:
        2D float array [0, 1] representing brush stamp opacity
    """
    if brush_type == 'random':
        brush_type = random.choice([
            'circular', 'rough', 'textured', 'splatter', 'dry',
            'marker', 'charcoal', 'ink',
            'thick_marker', 'calligraphy', 'feathered'
        ])

    center = size // 2
    stamp = np.zeros((size, size), dtype=np.float32)
    
    if brush_type == 'circular':
        # Smooth circular brush with soft edges (more variation)
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / random.uniform(2.3, 2.8)  # Variable radius
        stamp = np.clip(1.0 - (dist / radius), 0, 1)
        stamp = stamp ** random.uniform(1.3, 1.8)  # Variable softness
        
    elif brush_type == 'rough':
        # Rough brush with irregular edges (more wild)
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / random.uniform(2.2, 2.7)
        
        # Add more aggressive noise to radius
        noise = np.random.randn(size, size) * random.uniform(0.4, 0.6)
        effective_radius = radius + noise * radius * random.uniform(0.3, 0.5)
        stamp = np.clip(1.0 - (dist / effective_radius), 0, 1)
        stamp = stamp ** random.uniform(1.0, 1.4)
        
    elif brush_type == 'textured':
        # Textured brush with varying opacity
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 2.3
        base = np.clip(1.0 - (dist / radius), 0, 1)
        
        # Add texture with multiple frequency components
        texture = np.random.randn(size, size) * 0.2
        texture += np.sin(x * 0.5) * np.cos(y * 0.5) * 0.15
        stamp = np.clip(base + texture, 0, 1)
        
    elif brush_type == 'splatter':
        # Splatter brush with dots and irregularities
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 2.2
        base = np.clip(1.0 - (dist / radius), 0, 1) ** 0.8
        
        # Add random splatter dots
        splatter = np.random.random((size, size))
        splatter = (splatter > 0.7).astype(np.float32) * np.random.random((size, size))
        stamp = np.clip(base + splatter * 0.6, 0, 1)
        
    elif brush_type == 'dry':
        # Dry brush with gaps (like dry paint)
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 2.4
        base = np.clip(1.0 - (dist / radius), 0, 1)
        
        # Create gaps in coverage
        coverage = np.random.random((size, size))
        coverage = (coverage > 0.3).astype(np.float32)
        
        # Apply morphology to create streaks
        kernel = np.ones((2, 1), np.uint8)
        coverage = cv2.dilate(coverage, kernel, iterations=1)
        
        stamp = base * coverage
        
    elif brush_type == 'marker':
        # Marker with solid center and feathered edges
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 2.8
        
        # Solid core
        core = (dist < radius * 0.6).astype(np.float32)
        # Feathered edge
        edge = np.clip(1.0 - ((dist - radius * 0.6) / (radius * 0.4)), 0, 1)
        
        stamp = np.maximum(core, edge * 0.8)
        
    elif brush_type == 'charcoal':
        # Charcoal with grainy, smudged appearance
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 2.2
        base = np.clip(1.0 - (dist / radius), 0, 1) ** 0.6
        
        # Large grain texture
        grain_size = max(2, size // 8)
        grain = np.random.random((size // grain_size + 1, size // grain_size + 1))
        grain = cv2.resize(grain, (size, size), interpolation=cv2.INTER_LINEAR)
        
        stamp = base * (0.4 + grain * 0.6)
        stamp = np.clip(stamp, 0, 1)
        
    elif brush_type == 'ink':
        # Ink pen with hard edges and occasional bleeds
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 3.0
        base = (dist < radius).astype(np.float32)
        
        # Add occasional ink bleeds
        if random.random() > 0.5:
            bleed = np.random.random((size, size))
            bleed = (bleed > 0.85).astype(np.float32)
            bleed_dist = cv2.distanceTransform((1 - bleed).astype(np.uint8), cv2.DIST_L2, 3)
            bleed_effect = np.clip(1.0 - (bleed_dist / (size * 0.2)), 0, 1)
            base = np.maximum(base, bleed_effect * 0.3)
        
        stamp = base
        
    elif brush_type == 'thick_marker':
        # Very thick marker with soft edges (wilder)
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / random.uniform(1.6, 2.0)  # Variable thick radius
        stamp = np.clip(1.0 - (dist / radius), 0, 1) ** random.uniform(0.5, 0.9)
        
    elif brush_type == 'calligraphy':
        # Calligraphy pen with directional variation
        y, x = np.ogrid[:size, :size]
        
        # Elliptical shape with random orientation
        angle = random.random() * np.pi
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        x_rot = (x - center) * cos_a - (y - center) * sin_a
        y_rot = (x - center) * sin_a + (y - center) * cos_a
        
        # Different radii for major/minor axes
        a, b = size / 2.5, size / 4.5
        dist = np.sqrt((x_rot / a)**2 + (y_rot / b)**2)
        stamp = np.clip(1.0 - dist, 0, 1) ** 1.2
        
    elif brush_type == 'feathered':
        # Feathered brush with directional strokes
        y, x = np.ogrid[:size, :size]
        dist = np.sqrt((x - center)**2 + (y - center)**2)
        radius = size / 2.3
        base = np.clip(1.0 - (dist / radius), 0, 1)
        
        # Add directional streaks
        angle = random.random() * np.pi
        direction = np.cos(angle) * (x - center) + np.sin(angle) * (y - center)
        streaks = np.clip(1.0 - np.abs(direction) / (size * 0.3), 0, 1)
        
        stamp = base * (0.5 + streaks * 0.5)
        stamp = np.clip(stamp, 0, 1)
    
    return stamp


def apply_random_thickness_variation(
    image: np.ndarray,
    binary_kernel: np.ndarray,
    thickness: int
) -> np.ndarray:
    """Apply subtle random thickness variation through selective dilation.
    
    Args:
        image: Skeleton image (float32, [0, 1])
        binary_kernel: Kernel for morphological operations
        thickness: Base thickness
        
    Returns:
        Image with varied thickness
    """
    h, w = image.shape
    result = (image * 255).astype(np.uint8)
    
    # Apply base dilation
    result = cv2.dilate(result, binary_kernel, iterations=1)
    
    # Only apply extra variation 50% of the time for more randomness
    if random.random() > 0.5:
        return result.astype(np.float32) / 255.0
    
    # Apply very subtle additional dilation in random regions
    num_regions = random.randint(1, 3)  # Even fewer regions (1-3 instead of 2-4)
    
    for _ in range(num_regions):
        # Create random region mask (smaller, more varied sizes)
        region_size = random.randint(h // 8, h // 4)  # Smaller regions (was h//6 to h//3)
        
        # Ensure center doesn't go out of bounds
        if region_size // 2 >= h - region_size // 2 or region_size // 2 >= w - region_size // 2:
            continue
            
        center_y = random.randint(region_size // 2, h - region_size // 2)
        center_x = random.randint(region_size // 2, w - region_size // 2)
        
        # Random shape: sometimes circular, sometimes elliptical
        y_grid, x_grid = np.ogrid[:h, :w]
        
        if random.random() < 0.5:
            # Circular
            dist_sq = (y_grid - center_y)**2 + (x_grid - center_x)**2
            region_mask = (dist_sq <= (region_size // 2)**2).astype(np.uint8)
        else:
            # Elliptical (more variation)
            aspect = random.uniform(0.5, 2.0)
            dist_sq = ((y_grid - center_y) / aspect)**2 + (x_grid - center_x)**2
            region_mask = (dist_sq <= (region_size // 2)**2).astype(np.uint8)
        
        # Use very small kernel for subtle effect (1 pixel smaller than base)
        small_kernel_size = max(3, binary_kernel.shape[0] - 1)
        if small_kernel_size % 2 == 0:
            small_kernel_size -= 1
        small_kernel = np.ones((small_kernel_size, small_kernel_size), np.uint8)
        
        # Only dilate in this region (no erosion)
        extra_dilated = cv2.dilate(result, small_kernel, iterations=1)
        
        # Apply only where mask is active
        result = np.where(region_mask > 0, extra_dilated, result).astype(np.uint8)
    
    return result.astype(np.float32) / 255.0


def apply_brush_augmentation(
    image: np.ndarray,
    brush_type: str = None,
    apply_variation: bool = True,
    apply_blur: bool = False,
    verbose: bool = False,
) -> Tuple[np.ndarray, Dict]:
    """Apply brush augmentation to THICKEN lines.
    
    Applies morphological dilation with optional random thickness variation.
    
    Args:
        image: Skeleton image with thin lines (float32, [0, 1])
        brush_type: Type of brush to use. If None, randomly selects one. Options:
                   'circular', 'rough', 'textured', 'splatter', 'dry',
                   'marker', 'charcoal', 'ink', 'thick_marker', 'calligraphy', 
                   'feathered'
        apply_variation: If True, apply random thickness variation (dilate/erode in random regions).
                        If False, use uniform dilation.
        apply_blur: If True, apply blur for edge-only anti-aliasing. Randomly selects from:
                   - Gaussian (smooth, natural)
                   - Bilateral (edge-preserving, excellent for anti-aliasing)
                   - Box (uniform averaging, simpler look)
                   Blur size is also randomized (3, 5, or 7 pixels).
        verbose: If True, print timing and brush information
        
    Returns:
        Tuple of (augmented_image, info_dict) where info_dict contains:
            - brush_type: str
            - stamp_size: int
            - thickness_amount: float
            - timing_ms: float
    """
    start_time = time.time()
    
    result = image.copy()
    h, w = image.shape
    
    # Get all line pixels
    line_mask = image > 0.01
    
    if not line_mask.any():
        return result, {'brush_type': 'none', 'stamp_size': 0, 'thickness_amount': 0.0, 'timing_ms': 0.0}
    
    # Choose a brush type (random if not specified)
    if brush_type is None:
        brush_type = random.choice([
            'circular', 'rough', 'textured', 'splatter', 'dry',
            'marker', 'charcoal', 'ink',
            'thick_marker', 'calligraphy', 'feathered'
        ])
    
    # Choose thickness based on brush type (reduced max values)
    if 'thick' in brush_type:
        thickness = random.randint(1, 3)  # Thick marker (stamp: 3-7px)
    elif brush_type in ['textured', 'splatter', 'dry']:
        thickness = random.randint(1, 2)  # Textured/splatter/dry (stamp: 3-5px)
    elif 'ink' in brush_type:
        thickness = random.randint(1, 2)  # Ink (stamp: 3-5px)
    else:
        thickness = random.randint(1, 3)  # Medium (stamp: 3-7px)
    
    # Generate stamp for morphological operation
    stamp_size = thickness * 2 + 1
    stamp = generate_brush_stamp(stamp_size, brush_type)
    
    # Convert stamp to binary kernel (threshold for dilation)
    # Use different thresholds for different effects
    if 'splatter' in brush_type or 'dry' in brush_type:
        threshold = random.uniform(0.3, 0.6)  # Sparse, irregular
    elif 'rough' in brush_type or 'textured' in brush_type:
        threshold = random.uniform(0.4, 0.7)  # Moderately irregular
    else:
        threshold = random.uniform(0.5, 0.8)  # Smooth
    
    binary_kernel = (stamp > threshold).astype(np.uint8)
    
    # Apply augmentation: with or without random thickness variation
    if apply_variation:
        # Apply random thickness variation (dilate/erode in random regions)
        result = apply_random_thickness_variation(result, binary_kernel, thickness)
    else:
        # Use simple uniform dilation
        image_uint8 = (result * 255).astype(np.uint8)
        dilated = cv2.dilate(image_uint8, binary_kernel, iterations=1)
        result = dilated.astype(np.float32) / 255.0
    
    # Add texture/noise to the thickened lines for more non-uniformity
    if 'charcoal' in brush_type:
        # Add grainy texture by randomly removing pixels
        removal_rate = 0.15 if thickness >= 5 else 0.12
        noise_mask = np.random.random((h, w)) > removal_rate
        result = result * noise_mask
    elif 'dry' in brush_type or 'splatter' in brush_type:
        # Add splattery gaps
        removal_rate = 0.12 if thickness >= 5 else 0.08
        noise_mask = np.random.random((h, w)) > removal_rate
        result = result * noise_mask
    elif 'rough' in brush_type and thickness >= 5:
        # Add gaps to thick rough brushes
        noise_mask = np.random.random((h, w)) > 0.10
        result = result * noise_mask
    
    # Apply edge-only anti-aliasing (if requested)
    if apply_blur:
        # Randomize blur size (3, 5, or 7)
        blur_size = random.choice([3, 5, 7])
        
        # Randomize blur type for variety
        blur_type = random.choice(['gaussian', 'bilateral', 'box'])
        
        # Apply selected blur type
        result_uint8 = (result * 255).astype(np.uint8)
        
        if blur_type == 'gaussian':
            # Standard Gaussian blur - smooth and natural
            result_blurred = cv2.GaussianBlur(result_uint8, (blur_size, blur_size), 0)
        
        elif blur_type == 'bilateral':
            # Bilateral filter - edge-preserving blur (excellent for anti-aliasing)
            # Parameters: diameter, sigmaColor, sigmaSpace
            d = blur_size
            sigma_color = 50  # Color similarity
            sigma_space = 50  # Spatial similarity
            result_blurred = cv2.bilateralFilter(result_uint8, d, sigma_color, sigma_space)
        
        elif blur_type == 'box':
            # Box filter - uniform averaging (faster, different look)
            result_blurred = cv2.boxFilter(result_uint8, -1, (blur_size, blur_size))
        
        result_blurred_float = result_blurred.astype(np.float32) / 255.0
        
        # Use the original skeleton as core pixels (centerline of strokes)
        # The skeleton should remain at full intensity, only edges get blur
        skeleton_mask = (image > 0.01).astype(np.float32)
        
        # Keep skeleton pixels at full intensity, use blurred values for edges
        # This creates anti-aliasing only at thickened edges, not along the centerline
        result = result_blurred_float * (1.0 - skeleton_mask) + result * skeleton_mask
    
    # Calculate timing
    elapsed_time = (time.time() - start_time) * 1000  # Convert to milliseconds
    
    # Prepare info dictionary
    info_dict = {
        'brush_type': brush_type,
        'stamp_size': stamp_size,
        'thickness_amount': float(thickness),
        'timing_ms': elapsed_time,
    }
    
    if verbose:
        print(f"  Brush augmentation applied: {brush_type}")
        print(f"    - Stamp size: {stamp_size}px")
        print(f"    - Thickness: {thickness}px")
        print(f"    - Time: {elapsed_time:.2f}ms")
    
    return result, info_dict


def create_sample_grid(
    images: list,
    title: str = "",
    label_first: str = "Original"
) -> np.ndarray:
    """Create a 3x3 grid from a list of images.
    
    Args:
        images: List of grayscale images (uint8). Should have 9 images for 3x3 grid.
        title: Title text to display at the top of the grid
        label_first: Label for the first (top-left) image
        
    Returns:
        Grid image as BGR uint8 array
    """
    if len(images) != 9:
        raise ValueError(f"Expected 9 images for 3x3 grid, got {len(images)}")
    
    grid_size = 3
    h, w = images[0].shape
    
    # Create grid image
    grid = np.zeros((h * grid_size, w * grid_size), dtype=np.uint8)
    
    for grid_idx in range(grid_size * grid_size):
        row = grid_idx // grid_size
        col = grid_idx % grid_size
        
        y_start = row * h
        y_end = (row + 1) * h
        x_start = col * w
        x_end = (col + 1) * w
        
        grid[y_start:y_end, x_start:x_end] = images[grid_idx]
    
    # Convert to BGR for text overlay
    grid_bgr = cv2.cvtColor(grid, cv2.COLOR_GRAY2BGR)
    
    # Add title text at top
    if title:
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 1.0
        font_thickness = 2
        text_color = (0, 0, 255)  # Red
        
        # Get text size
        (text_width, text_height), baseline = cv2.getTextSize(title, font, font_scale, font_thickness)
        
        # Draw white background for text
        padding = 10
        cv2.rectangle(grid_bgr, (5, 5), (text_width + padding * 2, text_height + baseline + padding * 2), 
                     (255, 255, 255), -1)
        
        # Draw text
        cv2.putText(grid_bgr, title, (padding, text_height + padding), 
                   font, font_scale, text_color, font_thickness, cv2.LINE_AA)
    
    # Add label for first image (top-left)
    if label_first:
        padding = 10
        cv2.putText(grid_bgr, label_first, (padding, h - 20), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 1, cv2.LINE_AA)
    
    return grid_bgr


if __name__ == "__main__":
    """Test brush augmentation with various brush types on a line image."""
    import os
    import argparse
    
    parser = argparse.ArgumentParser(description='Test brush augmentation on a line image')
    parser.add_argument('--line_image_path', type=str, required=True,
                        help='Path to input line image (grayscale or binary)')
    parser.add_argument('--output_dir', type=str, default='brush_test_output',
                        help='Directory to save output images (default: brush_test_output)')
    parser.add_argument('--samples_per_brush', type=int, default=8,
                        help='Number of samples per brush type (default: 8)')
    parser.add_argument('--crop_size', type=int, default=512,
                        help='Size of crop around lines (default: 512)')
    parser.add_argument('--no_variation', action='store_true',
                        help='Disable random thickness variation (use uniform dilation)')
    parser.add_argument('--apply_blur', action='store_true',
                        help='Apply blur for edge-only anti-aliasing (randomized blur type and size)')
    args = parser.parse_args()
    
    # Load the input image
    print(f"Loading line image from: {args.line_image_path}")
    line_image = cv2.imread(args.line_image_path, cv2.IMREAD_GRAYSCALE)
    
    if line_image is None:
        print(f"Error: Could not load image from {args.line_image_path}")
        exit(1)
    
    print(f"Original image shape: {line_image.shape}")
    
    # Crop around lines
    print(f"Cropping to {args.crop_size}x{args.crop_size} around lines...")
    line_image_float = line_image.astype(np.float32) / 255.0
    cropped = crop_around_lines_binary_with_retry(line_image_float, args.crop_size)
    
    if cropped is None:
        print("Error: Could not crop image (no content or cropping failed)")
        exit(1)
    
    print(f"Cropped image shape: {cropped.shape}")
    
    
    # Skeletonize
    print("Skeletonizing...")
    line_image_uint8 = (cropped * 255).astype(np.uint8)
    skeleton = skeletonize(line_image_uint8).astype(np.float32) / 255.0
    print(f"Skeleton created, line pixel ratio: {(skeleton > 0.01).sum() / skeleton.size:.3f}")
    
    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)
    
    # List of all brush types to test
    brush_types = [
        'circular', 'rough', 'textured', 'splatter', 'dry',
        'marker', 'charcoal', 'ink',
        'thick_marker', 'calligraphy', 'feathered'
    ]
    
    use_variation = not args.no_variation
    
    print(f"\nTesting {len(brush_types)} brush types with {args.samples_per_brush} samples each...")
    
    # Convert skeleton to uint8 for grid
    skeleton_uint8 = (skeleton * 255).astype(np.uint8)
    
    # Test each brush type
    for idx, brush_type in enumerate(brush_types, 1):
        print(f"\n{idx}/{len(brush_types)}. Testing {brush_type} brush...")
        
        # Collect samples for this brush type
        samples = []
        
        # Add skeleton as first image
        samples.append(skeleton_uint8)
        
        # Generate samples using the specified brush type
        for sample_idx in range(args.samples_per_brush):
            # Apply brush augmentation with specific brush type
            augmented, info = apply_brush_augmentation(
                skeleton, 
                brush_type=brush_type, 
                apply_variation=use_variation,
                apply_blur=args.apply_blur,
                verbose=False
            )
            
            # Convert to uint8
            augmented_uint8 = (augmented * 255).astype(np.uint8)
            samples.append(augmented_uint8)
        
        # Create 3x3 grid using helper function
        grid_bgr = create_sample_grid(
            images=samples,
            title=brush_type.upper(),
            label_first="Skeleton"
        )
        
        # Save grid
        grid_path = os.path.join(args.output_dir, f"{brush_type}_grid.png")
        cv2.imwrite(grid_path, grid_bgr)
        print(f"   Saved grid to {grid_path}")
    
    print(f"\n✅ Complete! Results saved to {args.output_dir}/")
    print(f"\nBrush types tested:")
    for i, bt in enumerate(brush_types, 1):
        print(f"  {i:2d}. {bt}")

