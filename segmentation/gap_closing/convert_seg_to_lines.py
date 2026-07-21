import os
import argparse
import glob
from pathlib import Path
from collections import defaultdict

import cv2
import numpy as np
from tqdm import tqdm

from segmentation.gap_closing.file import find_seg_images
from colorize.common.frame import SegImageFrame


def seg_to_lines(seg_image: np.ndarray, line_thickness: int = 1) -> np.ndarray:
    """Convert a segmentation image to line drawing by detecting region borders.
    
    Args:
        seg_image: Segmentation image (int32/uint32) where each value represents a region ID
        line_thickness: Thickness of the boundary lines (default 1)
        
    Returns:
        Binary line image where 255 = line, 0 = background
    """
    # Use morphological gradient to detect boundaries
    # This finds pixels where the region ID changes
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    gradient = cv2.morphologyEx(seg_image.astype(np.uint16), cv2.MORPH_GRADIENT, kernel)
    
    # Any non-zero value in gradient indicates a boundary
    boundaries = (gradient == 0).astype(np.uint8) * 255
    
    # Optional: thicken lines if requested
    if line_thickness > 1:
        kernel_thick = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, 
            (line_thickness, line_thickness)
        )
        boundaries = cv2.dilate(boundaries, kernel_thick)
    
    return boundaries


def convert_seg_file(
    input_path: str, 
    output_path: str, 
    line_thickness: int = 1,
) -> None:
    """Convert a single segmentation file to line drawing.
    
    Args:
        input_path: Path to input segmentation image (RGBA format)
        output_path: Path to save output line image
        line_thickness: Thickness of boundary lines
        visualize: If True, create a side-by-side visualization
    """
    # Read segmentation image using SegImageFrame (handles RGBA properly)
    seg_frame = SegImageFrame.from_file(input_path)
    
    if seg_frame.is_corrupt or seg_frame.image_data is None:
        print(f"Warning: Failed to load or corrupt image: {input_path}")
        return
    
    # Get the segmentation data (int32 segment IDs)
    seg_image = seg_frame.image_data.astype(np.uint32)
    
    # Convert to lines
    line_image = seg_to_lines(seg_image, line_thickness=line_thickness)
    
    # Create output directory if needed
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Save line image
    cv2.imwrite(output_path, line_image)


def process_default_structure(args):
    """Process segmentation images using find_seg_images()."""
    # Find all segmentation images
    print("Finding segmentation images...")
    seg_files = find_seg_images()
    
    if not seg_files:
        print("No segmentation images found!")
        return
    
    # Limit if requested
    if args.limit:
        seg_files = seg_files[:args.limit]
    
    print(f"Found {len(seg_files)} segmentation images")
    print(f"Converting to line drawings...")
    print(f"Output directory: {args.output_dir}")
    print(f"Line thickness: {args.line_thickness}")
    
    # Process each file
    for seg_path in tqdm(seg_files, desc="Converting"):
        # Preserve directory structure
        seg_path_obj = Path(seg_path)
        
        # Try to find a data directory marker
        parts = seg_path_obj.parts
        if "data" in parts:
            data_idx = parts.index("data")
            rel_path = Path(*parts[data_idx+1:])
        else:
            rel_path = seg_path_obj.name
        
        # Replace seg directory with line directory
        rel_path_str = str(rel_path)
        rel_path_str = rel_path_str.replace("/tb_seg/", "/seg_canny/")
        rel_path_str = rel_path_str.replace("/tb_seg_threshold_240/", "/seg_canny_threshold_240/")
        
        output_path = os.path.join(args.output_dir, rel_path_str)
        
        # Convert the file
        convert_seg_file(
            seg_path,
            output_path,
            line_thickness=args.line_thickness,
        )
    
    print(f"\n✅ Successfully converted {len(seg_files)} segmentation images")
    print(f"   Output saved to: {args.output_dir}")


def process_cadmium_structure(args):
    """Process cadmium datasets with {hash}/{number}/{date}/seg_*.png structure."""
    # Find all seg images in the cadmium structure
    seg_pattern = os.path.join(args.data_path, args.glob_pattern, '*', '*', 'seg_*.png')
    seg_files = glob.glob(seg_pattern)
    
    print(f"Found {len(seg_files)} seg images matching pattern: {seg_pattern}")
    
    if not seg_files:
        print("No seg images found!")
        return
    
    # Limit if requested
    if args.limit:
        seg_files = seg_files[:args.limit]
    
    # Group seg images by their parent directory (date folder)
    grouped = defaultdict(list)
    for seg_path in seg_files:
        parent_dir = os.path.dirname(seg_path)
        grouped[parent_dir].append(seg_path)
    
    print(f"Found {len(grouped)} unique folders to process")
    print(f"Line thickness: {args.line_thickness}")
    
    converted_count = 0
    for parent_dir, paths in tqdm(grouped.items(), desc="Processing folders"):
        # Output to gap_close_lines_v1 subdirectory
        output_dir = os.path.join(parent_dir, args.output_subdir)
        os.makedirs(output_dir, exist_ok=True)
        
        for seg_path in paths:
            # Output filename: seg_0.png -> seg_0.png (keep same name)
            basename = os.path.basename(seg_path)
            output_path = os.path.join(output_dir, basename)
            
            convert_seg_file(
                seg_path,
                output_path,
                line_thickness=args.line_thickness,
            )
            converted_count += 1
    
    print(f"\n✅ Successfully converted {converted_count} segmentation images")


def main():
    parser = argparse.ArgumentParser(
        description="Convert segmentation images to line drawings by detecting region borders"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="data/converted_lines",
        help="Output directory for line images (default: data/converted_lines)"
    )
    parser.add_argument(
        "--line-thickness",
        type=int,
        default=1,
        help="Thickness of boundary lines in pixels (default: 1)"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of files to process (for testing)"
    )
    parser.add_argument(
        "--structure",
        type=str,
        default="default",
        choices=["default", "cadmium"],
        help="Dataset structure type: default (uses find_seg_images) or cadmium ({hash}/{number}/{date}/seg_*.png)"
    )
    parser.add_argument(
        "--data-path",
        type=str,
        default="data/cadmium-data-2025-10_06",
        help="Path to dataset root directory (for cadmium structure)"
    )
    parser.add_argument(
        "--glob-pattern",
        type=str,
        default="*",
        help="Glob pattern to filter projects (for cadmium structure)"
    )
    parser.add_argument(
        "--output-subdir",
        type=str,
        default="gap_close_lines_v1",
        help="Name of output subdirectory (for cadmium structure)"
    )
    args = parser.parse_args()
    
    if args.structure == "default":
        process_default_structure(args)
    elif args.structure == "cadmium":
        process_cadmium_structure(args)

if __name__ == "__main__":
    main()

