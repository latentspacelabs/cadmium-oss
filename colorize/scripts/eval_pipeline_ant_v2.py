from typing import *
import os
import argparse
import glob
import pickle
import copy
from dataclasses import dataclass

import matplotlib.pyplot as plt
from sklearn.metrics import accuracy_score
import numpy as np

from colorize.datasets.frame_pair_datamodule import REAL_TEST_SEQUENCES
from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline, AnTV2PipelineOutput
from colorize.common.sequence import Sequence
from colorize.common.frame import SegImageFrame
from colorize.common.ops import rgba_to_dense_flat, matte_rgba, rgba_to_dense, rgb_to_rgba
from colorize.common.image import image_grid
from segmentation.trapped_ball.trapped_ball import show_fill_map


@dataclass
class AnTV2EvalOutput:

    seg_acc: float
    pixel_acc: int

    active_target_colors: List[int]
    active_pred_target_colors: List[int]

    correct_mask: List[bool]
    unknown_segment_mask: List[bool]
    new_color_segment_mask: List[bool]

    def __str__(self):
        return f"seg_acc={self.seg_acc:.2f}_pixel_acc={self.pixel_acc:.2f}"

    
def run(
    pipeline: AnTV2Pipeline,
    dataset_name: str,
    sequence_paths: List[str],
    save_colorized: bool = False,
):
    all_seg_accs = []
    all_pixel_accs = []
    
    for sequence_path in sequence_paths:
        print(f"{'-' * 100}\nRunning eval for {sequence_path}\n{'-' * 100}")

        # if "kyo" not in sequence_path:
        #     continue

        seq: Sequence = pickle.load(open(sequence_path, "rb"))
        seq.materialize(color_source='color_list')

        directions = [
            # (start_idx, end_idx, step)
            (0, len(seq.frames) - 1, 1),  # forward
            (len(seq.frames) - 1, 0, -1)  # backward
        ]
        
        for start_idx, end_idx, step in directions:
            for seq_idx in range(start_idx, end_idx, step):
                next_idx = seq_idx + step
                
                ref_seg_image = seq.frames[seq_idx].seg_frame.image_data
                ref_line_image = seq.frames[seq_idx].line_frame.image_data
                target_seg_image = seq.frames[next_idx].seg_frame.image_data
                target_line_image = seq.frames[next_idx].line_frame.image_data
                
                ref_color_list = seq.frames[seq_idx].color_list
                
                pipeline_output = pipeline(
                    inputs={
                        "ref_seg_image": ref_seg_image,
                        "ref_line_image": ref_line_image,
                        "target_seg_image": target_seg_image,
                        "target_line_image": target_line_image,
                        "ref_color_list": ref_color_list,
                    },
                    return_colorized=save_colorized,
                )
                
                eval_output = compute_eval_output(
                    pred_output=pipeline_output,
                    seq=seq,
                    seq_indices=(seq_idx, next_idx),
                )
                
                all_seg_accs.append(eval_output.seg_acc)
                all_pixel_accs.append(eval_output.pixel_acc)
                
                if save_colorized:
                    save_colorized_images(
                        seq=seq,
                        seq_indices=(seq_idx, next_idx),
                        seq_path=sequence_path,
                        pred_output=pipeline_output,
                        dataset_name=dataset_name,
                        eval_output=eval_output,
                    )
        
    dataset_seg_acc = np.mean(all_seg_accs) if all_seg_accs else 0.0
    dataset_pixel_acc = np.mean(all_pixel_accs) if all_pixel_accs else 0.0
    
    print(f"{'-' * 100}")
    print(f"Dataset-wide metrics for {dataset_name}:")
    print(f"Average Segmentation Accuracy: {dataset_seg_acc:.4f}")
    print(f"Average Pixel Accuracy: {dataset_pixel_acc:.4f}")
    print(f"{'-' * 100}")


def save_colorized_images(
    seq: Sequence,
    seq_indices: Tuple[int, int],
    seq_path: str,
    pred_output: AnTV2PipelineOutput,
    dataset_name: str,
    eval_output: AnTV2EvalOutput,
):
    start_idx, end_idx = seq_indices
    start_frame_idx = seq.frames[start_idx].idx
    end_frame_idx = seq.frames[end_idx].idx

    seq_name = os.path.basename(seq_path).split('.')[0]
    metrics_str = str(eval_output)
    grid_output_path = f"./output/{dataset_name}/{seq_name}/{start_frame_idx}_{end_frame_idx}_{metrics_str}.png"
    os.makedirs(os.path.dirname(grid_output_path), exist_ok=True)

    ref_seg_image = seq.frames[start_idx].seg_frame.image_data
    ref_seg_rainbow_image = rgb_to_rgba(show_fill_map(ref_seg_image))
    ref_line_image = matte_rgba(seq.frames[start_idx].line_frame.image_data)

    target_seg_image = seq.frames[end_idx].seg_frame.image_data
    target_seg_rainbow_image = rgb_to_rgba(show_fill_map(target_seg_image))
    target_line_image = matte_rgba(seq.frames[end_idx].line_frame.image_data)

    pred_target_color_image = np.array(pred_output.target_color_image)

    gt_ref_color_image = seq.frames[start_idx].color_frame.image_data
    gt_target_color_image = seq.frames[end_idx].color_frame.image_data

    pred_target_color_dense = rgba_to_dense(pred_target_color_image.astype(np.uint32))
    gt_target_color_dense = rgba_to_dense(gt_target_color_image.astype(np.uint32))

    # error, unknown, new color segments
    error_mask = np.zeros_like(pred_target_color_image)
    error_mask[pred_target_color_dense != gt_target_color_dense] = [255, 0, 0, 255] # red
    for i, _ in enumerate(eval_output.unknown_segment_mask):
        if eval_output.unknown_segment_mask[i]:
            error_mask[target_seg_image == i] = [0, 0, 255, 255] # blue
    for i, _ in enumerate(eval_output.new_color_segment_mask):
        if eval_output.new_color_segment_mask[i]:
            error_mask[target_seg_image == i] = [0, 255, 0, 255] # green

    # per-segment conf scores
    (
        entropy_conf_score_heatmap,
        pred_target_color_image_high_conf,
        pred_target_color_image_low_conf,
        pred_target_color_image_thresh_error_mask,
    ) = create_conf_score_viz(
        error_mask=copy.deepcopy(error_mask),
        correct_mask=eval_output.correct_mask,
        pred_target_colors_rgba=pred_output.target_colors_rgba,
        target_seg_frame=seq.frames[end_idx].seg_frame,
        entropy_conf_scores=pred_output.entropy_conf_scores.cpu().numpy(),
    )

    empty_image = np.zeros_like(pred_target_color_image)

    image_grid(
        images=[
            [ref_seg_rainbow_image, target_seg_rainbow_image, empty_image, empty_image],
            [ref_line_image, target_line_image, empty_image, empty_image],
            [gt_ref_color_image, gt_target_color_image, pred_target_color_image, error_mask],
            [pred_target_color_image_high_conf, pred_target_color_image_low_conf, entropy_conf_score_heatmap, pred_target_color_image_thresh_error_mask],
        ],
        output_path=grid_output_path,
    )


def create_conf_score_viz(
    correct_mask: List[bool],
    error_mask: np.ndarray,
    pred_target_colors_rgba: List[int],
    target_seg_frame: SegImageFrame,
    entropy_conf_scores: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    colormap = plt.colormaps.get_cmap('viridis')

    entropy_conf_score_heatmap = np.zeros((*target_seg_frame.image_data.shape, 4), dtype=np.uint8)
    pred_target_colors_rgba_high_conf = []
    pred_target_colors_rgba_low_conf = []
    for segment_id, pred_target_color_rgba in zip(np.unique(target_seg_frame.image_data), pred_target_colors_rgba):
        segment_mask = (target_seg_frame.image_data == segment_id)
        entropy_conf_score = entropy_conf_scores[segment_id]

        color = colormap(int(entropy_conf_score * 255))  # Get the color from the colormap
        rgba_color = (np.array(color[:3]) * 255).astype(np.uint8).tolist() + [255]  # Convert to RGBA
        entropy_conf_score_heatmap[segment_mask] = rgba_color

        if entropy_conf_score >= 0.6:
            pred_target_colors_rgba_high_conf.append(rgba_to_dense_flat(pred_target_color_rgba))
            pred_target_colors_rgba_low_conf.append(rgba_to_dense_flat([0, 0, 0, 0]))
        else:
            pred_target_colors_rgba_high_conf.append(rgba_to_dense_flat([0, 0, 0, 0]))
            pred_target_colors_rgba_low_conf.append(rgba_to_dense_flat(pred_target_color_rgba))

            if correct_mask[segment_id]:
                error_mask[segment_mask] = [255, 165, 0, 255]  # RGBA for orange
            else:
                error_mask[segment_mask] = [255, 192, 203, 255]  # RGBA for pink

    pred_target_color_image_high_conf = target_seg_frame.render_as_image(pred_target_colors_rgba_high_conf)
    pred_target_color_image_low_conf = target_seg_frame.render_as_image(pred_target_colors_rgba_low_conf)

    return (
        entropy_conf_score_heatmap,
        pred_target_color_image_high_conf,
        pred_target_color_image_low_conf,
        error_mask,
    )


def compute_eval_output(
    pred_output: AnTV2PipelineOutput,
    seq: Sequence,
    seq_indices: Tuple[int, int],
) -> Tuple[float, float, float]:
    start_idx, end_idx = seq_indices
    seg_image_path = seq.frames[end_idx].seg_frame.path

    pred_target_colors_rgba = pred_output.target_colors_rgba
    pred_target_colors = [int(rgba_to_dense_flat(c)) for c in pred_target_colors_rgba]
    target_colors = [int(c) for c in seq.frames[end_idx].color_list]
    correct_mask = [t == p for t, p in zip(target_colors, pred_target_colors)]
    assert len(target_colors) == len(pred_target_colors)

    # remove unknown segments
    active_seg_mask = [int(t) != -100 or int(t) != -1 for t in target_colors]
    unknown_segment_mask = [not m for m in active_seg_mask]
    num_unknown_segments = len(target_colors) - len(active_seg_mask)
    active_target_colors = [t for t, m in zip(target_colors, active_seg_mask) if m]
    active_pred_target_colors = [t for t, m in zip(pred_target_colors, active_seg_mask) if m]
    assert len(active_target_colors) == len(active_pred_target_colors)

    # check for new color segments
    new_colors = list((set(active_target_colors) - set(active_pred_target_colors)) - {-100} - {-1})
    active_target_color_indices = [i for i, t in enumerate(active_target_colors) if t not in new_colors]
    active_target_colors = [active_target_colors[i] for i in active_target_color_indices]
    active_pred_target_colors = [active_pred_target_colors[i] for i in active_target_color_indices]
    new_color_segment_mask = [True if t in new_colors else False for t in target_colors]
    assert len(active_target_colors) == len(active_pred_target_colors)

    # segment acc 
    seg_acc = accuracy_score(active_target_colors, active_pred_target_colors)
    
    # pixel acc
    gt_target_color_image = seq.frames[end_idx].color_frame.image_data
    pred_target_color_image = np.array(pred_output.target_color_image)
    pred_target_color_dense = rgba_to_dense(pred_target_color_image.astype(np.uint32))
    gt_target_color_dense = rgba_to_dense(gt_target_color_image.astype(np.uint32))
    pixel_acc = np.sum(pred_target_color_dense == gt_target_color_dense) / pred_target_color_dense.size
    
    print(
        f"Metrics for {os.path.basename(seg_image_path)}: "
        f"Segments {len(active_target_colors)}/{len(target_colors)} active | "
        f"Pixel acc: {pixel_acc:.4f} | "
        f"Segment acc: {seg_acc:.4f} | "
        f"{len(new_colors)}/{len(active_target_colors)} new color segments found | "
        f"{num_unknown_segments}/{len(active_target_colors)} unknown segments found"
    )

    return AnTV2EvalOutput(
        seg_acc=seg_acc,
        pixel_acc=pixel_acc,
        active_target_colors=active_target_colors,
        active_pred_target_colors=active_pred_target_colors,
        correct_mask=correct_mask,
        unknown_segment_mask=unknown_segment_mask,
        new_color_segment_mask=new_color_segment_mask,
    )


if __name__ == '__main__':

    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset_path", type=str, required=True, help="Saved dataset path")
    parser.add_argument("--checkpoint", type=str, required=True, help="Checkpoint path to resume training from")
    parser.add_argument("--save_colorized", action="store_true", help="Save colorized images")
    parser.add_argument("--verbose", action="store_true", help="Verbose")
    args = parser.parse_args()

    pipeline = AnTV2Pipeline.from_pretrained(
        checkpoint=args.checkpoint,
        verbose=args.verbose,
    )

    pipeline.model.to("cuda")

    if "real" in args.dataset_path:
        sequence_paths = []
        for test_seq_name in REAL_TEST_SEQUENCES:
            sequence_paths.append(os.path.join(args.dataset_path, 'sequences', test_seq_name))
    else:
        sequence_paths = glob.glob(os.path.join(args.dataset_path, 'sequences/*.pkl'))

    dataset_name = os.path.split(args.dataset_path)[-1]


    run(
        pipeline=pipeline,
        sequence_paths=sequence_paths,
        dataset_name=dataset_name,
        save_colorized=args.save_colorized,
    )
