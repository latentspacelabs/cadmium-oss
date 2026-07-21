from typing import *
import argparse
from typing import Dict
from pathlib import Path
import cv2
from PIL import Image
import numpy as np
import time

from segmentation.gap_closing.gap_closer import GapCloser
from segmentation.gap_closing.visualization import draw_endpoints_on_image
from segmentation.gap_closing.line import detect_endpoints

from segmentation.trapped_ball.trapped_ball import show_fill_map, compute_seg_fast
from segmentation.trapped_ball.line import binarize


def process_image(
    image: Union[Path, np.ndarray],
    model: GapCloser,
    batch_size: int = 24,
    output_dir: Optional[Path] = None,
    tb_sizes: List[int] = [2,1,0],
    min_seg_size: int = 10,
) -> Tuple[int, np.ndarray, np.ndarray]:
    """Process an image with gap closing and trapped ball segmentation.
    
    Args:
        image: Input RGBA image path or array
        model: GapCloser model
        batch_size: Batch size for ML inference
        output_dir: Optional directory to save results
        tb_sizes: Trapped ball sizes for segmentation
        min_seg_size: Minimum segment size
        
    Returns:
        Tuple of (num_regions, labeled_regions, combined_boundary_binary)
    """
    input_image = load_image(image)

    if output_dir is not None:
        save_inputs(input_image, output_dir)

    if model is None:
        # Trapped-ball-only segmentation (no ML gap closing). This is the
        # documented `model=None` path from run_segment (and the original Modal
        # behavior) used when the app disables "AI Gap Closing" — which is the
        # default. Binarize the line image and run trapped ball directly.
        print("Running trapped ball segmentation (no gap closing)...")
        print(f"Image size: {input_image.shape[0]}x{input_image.shape[1]}")
        time_start = time.time()
        # binarize() returns lines=0 / background=255, the same boundary
        # convention compute_seg_fast / model.predict expect.
        boundary_binary = binarize(input_image, type='adaptive_mean')
        labeled_regions = compute_seg_fast(
            boundary_binary,
            tb_sizes=tb_sizes,
            max_iter=10,
            min_seg_size=min_seg_size,
        ).astype(np.uint8)
        unique = np.unique(labeled_regions)
        num_regions = len(unique) - 1 if 0 in unique else len(unique)
        print(f"Time taken: {time.time() - time_start:.2f} seconds")
        print(f"Found {num_regions} enclosed regions")
        if output_dir is not None:
            save_segmentation_results(labeled_regions, output_dir)
        return num_regions, labeled_regions, boundary_binary

    print("Running gap closing + trapped ball segmentation...")
    print(f"Image size: {input_image.shape[0]}x{input_image.shape[1]}")

    time_start = time.time()
    merged_boundary, labeled_regions, num_regions = model.predict(
        input_image,
        batch_size=batch_size,
        tb_sizes=tb_sizes,
        tb_min_seg_size=min_seg_size,
    )
    time_end = time.time()
    print(f"Time taken: {time_end - time_start:.2f} seconds")
    print(f"Found {num_regions} enclosed regions")
    print(f"Output image size: {labeled_regions.shape}")

    if output_dir is not None:
        save_gap_closing_results(merged_boundary, output_dir)
        save_segmentation_results(labeled_regions, output_dir)
    
    return num_regions, labeled_regions, merged_boundary


def load_image(image: Union[Path, np.ndarray]) -> np.ndarray:
    # Check if input is a numpy array or a path
    if isinstance(image, np.ndarray):
        input_image = image
    else:
        input_image = cv2.imread(str(image), cv2.IMREAD_UNCHANGED)
        
        if input_image is None:
            print(f"ERROR: Failed to load image {image}")
            raise ValueError(f"Failed to load image {image}")
    
    print(f"Input image shape: {input_image.shape}")
    
    if input_image.ndim != 3 or input_image.shape[-1] != 4:
        print(f"WARNING: Skipping {image} - Expected RGBA image (H, W, 4), got shape {input_image.shape}")
        raise ValueError(f"Expected RGBA image (H, W, 4), got shape {input_image.shape}")
    
    return input_image


def save_inputs(
    input_image: np.ndarray,
    output_dir: Path,
):
    # Save input binary
    print("Saving input binary...")
    input_binary = 255 - binarize(input_image, type='adaptive_mean')
    input_binary_path = output_dir / f"input_binary.png"
    Image.fromarray(input_binary).save(input_binary_path)

    # Detect and save output endpoints
    print("Detecting output endpoints...")
    output_endpoints_skeletonized = detect_endpoints(input_binary, do_skeletonize=True)
    if len(output_endpoints_skeletonized) > 0:
        output_with_endpoints = draw_endpoints_on_image(input_binary, output_endpoints_skeletonized, color=(255, 0, 0))
        endpoints_path = output_dir / f"input_endpoints_skeletonized.png"
        Image.fromarray(cv2.cvtColor(output_with_endpoints, cv2.COLOR_BGR2RGB)).save(endpoints_path)
        print(f"Found {len(output_endpoints_skeletonized)} output endpoints")


def save_gap_closing_results(
    boundary_binary: np.ndarray,
    output_dir: Path,
    output_prefix: str = 'output_gap_close',
    save_endpoints: bool = True,
):
    # Save predicted boundary
    print("Saving predicted boundary...")
    binary = (boundary_binary * 255).astype(np.uint8)
    binary_path = output_dir / f"{output_prefix}_binary.png"
    Image.fromarray(binary).save(binary_path)

    if save_endpoints:
        # Detect and save output endpoints
        print("Detecting output endpoints...")
        output_endpoints_skeletonized = detect_endpoints(boundary_binary, do_skeletonize=False)
        if len(output_endpoints_skeletonized) > 0:
            output_with_endpoints = draw_endpoints_on_image(binary, output_endpoints_skeletonized, color=(255, 0, 0))
            endpoints_path = output_dir / f"{output_prefix}_endpoints.png"
            Image.fromarray(cv2.cvtColor(output_with_endpoints, cv2.COLOR_BGR2RGB)).save(endpoints_path)
            print(f"Found {len(output_endpoints_skeletonized)} output endpoints")


def save_segmentation_results(
    labeled_regions: np.ndarray,
    output_dir: Path,
):
    thinned_color = show_fill_map(labeled_regions.astype(np.uint8))
    thinned_color_path = output_dir / f"output_segmentation_tb_colored.png"
    cv2.imwrite(str(thinned_color_path), thinned_color)
    print(f"Saved trapped ball colored segmentation (show_fill_map)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description='Process RGBA images with gap closer + trapped ball segmentation',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument('-c', '--checkpoint', type=str, required=True,
                        help='Path to gap closer checkpoint (.ckpt)')
    parser.add_argument('-i', '--input', type=str, required=True,
                        help='Path to input RGBA image or directory containing images')
    parser.add_argument('-o', '--output', type=str, required=True,
                        help='Output directory for all results (will be created if it does not exist)')
    parser.add_argument('--device', type=str, default='auto',
                        choices=['auto', 'cuda', 'cpu'],
                        help='Device for inference')
    parser.add_argument('--udf_binary_threshold', type=float, default=1,
                        help='Threshold for binary prediction')
    parser.add_argument('--batch_size', type=int, default=4,
                        help='Batch size for gap closing')
    parser.add_argument('--min_seg_size', type=int, default=20,
                        help='Minimum segment size for trapped ball')
    args = parser.parse_args()
    
    # Load model
    print(f"Loading model from {args.checkpoint}...")
    model = GapCloser.load_from_checkpoint(args.checkpoint, map_location=args.device)
    model.eval()
    model = model.to(args.device)
    model.hparams.udf_threshold = args.udf_binary_threshold
    print(f"Model loaded successfully")
    
    # Check if input is a file or directory
    input_path = Path(args.input)

    if input_path.is_file():
        # Setup output directory
        input_filename = input_path.stem
        output_dir = Path(args.output) / input_filename
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"Output directory: {output_dir}")

        # Process single file
        print(f"Processing single image: {input_path}")
        process_image(
            image=input_path,
            model=model,
            batch_size=args.batch_size,
            output_dir=output_dir,
            min_seg_size=args.min_seg_size,
        )
    
    elif input_path.is_dir():
        # Process all PNG files in directory
        image_files = sorted(list(input_path.glob("*.png")))
        
        if not image_files:
            print(f"ERROR: No PNG files found in {input_path}")
            exit(1)
        
        print(f"Found {len(image_files)} PNG images in {input_path}")

        for i, image_file in enumerate(image_files, 1):
            print(f"\n[{i}/{len(image_files)}]")

            input_filename = image_file.stem
            output_dir = Path(args.output) / input_filename
            output_dir.mkdir(parents=True, exist_ok=True)
            print(f"Output directory: {output_dir}")

            process_image(
                image=image_file,
                model=model,
                output_dir=output_dir,
                batch_size=args.batch_size,
                min_seg_size=args.min_seg_size,
            )
        
        print(f"\n{'='*80}")
        print(f"Batch processing complete!")
    else:
        print(f"ERROR: Input path {input_path} does not exist")
        exit(1)
