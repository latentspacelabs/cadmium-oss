import os
import argparse
import glob
from pathlib import Path
import numpy as np
from tqdm import tqdm


from segmentation.gap_closing.gap_closer import GapCloser
from segmentation.gap_closing.inference import load_image, save_gap_closing_results


def process_sketch_structure(args, model):
    """Process datasets with {project}/sketch/{scene}/*.png structure."""
    path = os.path.join(args.data_path, args.glob_pattern)
    projects = glob.glob(path)
    
    print(f"Found {len(projects)} projects matching pattern: {args.glob_pattern}")
    
    for project_path in projects:
        print(f"\n{'='*80}")
        print(f"Processing project: {project_path}")
        print(f"{'='*80}")

        scenes = glob.glob(os.path.join(project_path, '*'))
        
        for scene_path in scenes:
            if not os.path.isdir(scene_path):
                continue

            print(f"\nScene: {scene_path}")
            line_paths = glob.glob(os.path.join(scene_path, 'line', '*.png'))
            
            if not line_paths:
                print(f"  No line images found in {scene_path}/line/")
                continue

            scene_name = os.path.basename(scene_path)
            
            output_path = os.path.join(project_path, scene_name, args.output_subdir)
            if not os.path.exists(output_path):
                print(f"\nCreating output directory: {output_path}")
                print(f"  Found {len(line_paths)} line images")

                os.makedirs(output_path, exist_ok=True)
            
                process_line_images(line_paths, output_path, model, args)


def process_cadmium_structure(args, model):
    """Process cadmium datasets with {hash}/{number}/{date}/line_*.png structure."""
    # Find all line images in the cadmium structure
    line_pattern = os.path.join(args.data_path, args.glob_pattern, '*', '*', 'line_*.png')
    line_paths = glob.glob(line_pattern)
    
    print(f"Found {len(line_paths)} line images matching pattern: {line_pattern}")
    
    if not line_paths:
        print("No line images found!")
        return
    
    # Group line images by their parent directory (date folder)
    from collections import defaultdict
    grouped = defaultdict(list)
    for line_path in line_paths:
        parent_dir = os.path.dirname(line_path)
        grouped[parent_dir].append(line_path)
    
    print(f"Found {len(grouped)} unique folders to process")
    
    for parent_dir, paths in tqdm(grouped.items(), desc="Processing folders"):
        # Output to gap_close_lines_v1 subdirectory
        output_path = os.path.join(parent_dir, args.output_subdir)
        os.makedirs(output_path, exist_ok=True)
        
        process_line_images(paths, output_path, model, args, show_progress=False)


def process_line_images(line_paths, output_path, model, args, show_progress=True):
    """Process a list of line images and save results."""
    iterator = tqdm(line_paths, desc="  Processing") if show_progress else line_paths
    
    for line_path in iterator:
        basename = os.path.basename(line_path).replace('.png', '')
        input_image = load_image(Path(line_path))
        boundary_binary = model.generate_tiles(
            image=input_image,
            overlap_factor=0.1,
            batch_size=args.gap_close_batch_size,
            crop_to_content=True,
        )
        
        save_endpoints = not args.no_vis
        save_gap_closing_results(
            boundary_binary=boundary_binary,
            output_dir=Path(output_path),
            output_prefix=basename,
            save_endpoints=save_endpoints
        )


if __name__ == '__main__':
    
    argparser = argparse.ArgumentParser(
        description="Apply UDF prediction to real dataset"
    )
    argparser.add_argument('--data_path', type=str, required=True,
                          help='Path to dataset root directory')
    argparser.add_argument('--glob_pattern', type=str, default='*',
                          help='Glob pattern to filter projects')
    argparser.add_argument('--checkpoint', type=str, 
                          default='checkpoints/gap_closer/gap_close_v1_1124.ckpt',
                          help='Path to UDF model checkpoint')
    argparser.add_argument('--device', type=str, default='cuda',
                          choices=['cuda', 'cpu'],
                          help='Device to run inference on')
    argparser.add_argument('--udf_binary_threshold', type=float, default=1.0,
                           help='Threshold for binary prediction')
    argparser.add_argument('--gap_close_batch_size', type=int, default=4,
                           help='Batch size for gap closing')
    argparser.add_argument('--output_subdir', type=str, default='gap_close_lines_v1',
                          help='Name of output subdirectory')
    argparser.add_argument('--no_vis', action='store_true',
                          help='Skip saving visualizations')
    argparser.add_argument('--structure', type=str, default='sketch',
                          choices=['sketch', 'cadmium'],
                          help='Dataset structure type: sketch ({project}/sketch/{scene}/*.png) or cadmium ({hash}/{number}/{date}/line_*.png)')
    args = argparser.parse_args()

    # Load model
    print(f"Loading model from {args.checkpoint}...")
    model = GapCloser.load_from_checkpoint(args.checkpoint, map_location=args.device)
    model.eval()
    model = model.to(args.device)
    model.hparams.udf_threshold = args.udf_binary_threshold
    print(f"Model loaded successfully")
    
    if args.structure == 'sketch':
        process_sketch_structure(args, model)
    elif args.structure == 'cadmium':
        process_cadmium_structure(args, model)


    print(f"\n{'='*80}")
    print("Processing complete!")
    print(f"{'='*80}")

