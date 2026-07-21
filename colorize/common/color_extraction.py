"""
Color extraction utilities for computing dominant colors per segment.

Provides both serial and parallel (thread pool) implementations.
"""
from __future__ import annotations
from typing import *
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

from colorize.common.ops import rgba_to_dense_flat
from colorize.common.misc import color_list_to_colored_text, color_counts_to_colored_text, peakiness_score


# Special color values
NULL_COLOR = -100
TRANSPARENT_COLOR = rgba_to_dense_flat(np.array([0, 0, 0, 0]))
BLACK_COLOR = rgba_to_dense_flat(np.array([0, 0, 0, 255]))


@dataclass
class SegmentColorResult:
    """Result of processing a single segment."""
    seg_idx: int
    color: int
    status: str  # 'normal', 'over_thresholded', 'transparent', 'black', 'multi_color'
    num_pixels: int = 0
    peakiness_score: Optional[float] = None


@dataclass 
class ColorExtractionContext:
    """Pre-computed data needed for color extraction."""
    seg_flat: np.ndarray
    color_rgb_flat: np.ndarray
    transparent_mask_flat: np.ndarray
    line_mask_flat: np.ndarray
    black_mask_flat: np.ndarray
    num_segments: int

    @staticmethod
    def from_frames(
        seg_image_data: np.ndarray,
        color_image_data: np.ndarray,
        line_binarized_data: Optional[np.ndarray] = None,
        line_image_data: Optional[np.ndarray] = None,
        num_segments: int = None,
    ) -> ColorExtractionContext:
        """Create context from frame data."""
        seg_flat = seg_image_data.reshape(-1)
        color_rgb_flat = color_image_data[:, :, :3].reshape(-1, 3)
        transparent_mask = color_image_data[:, :, 3:4].reshape(-1) == 0
        transparent_mask_flat = transparent_mask.reshape(-1)

        if line_binarized_data is not None and line_image_data is not None:
            line_mask_flat = line_binarized_data.reshape(-1) != 0
            line_rgba_flat = line_image_data.reshape(-1, 4)
            black_mask_flat = np.all(line_rgba_flat == [0, 0, 0, 255], axis=-1)
        else:
            line_mask_flat = np.zeros_like(seg_flat, dtype=bool)
            black_mask_flat = np.zeros_like(seg_flat, dtype=bool)

        if num_segments is None:
            num_segments = int(np.max(seg_image_data) + 1)

        return ColorExtractionContext(
            seg_flat=seg_flat,
            color_rgb_flat=color_rgb_flat,
            transparent_mask_flat=transparent_mask_flat,
            line_mask_flat=line_mask_flat,
            black_mask_flat=black_mask_flat,
            num_segments=num_segments,
        )


def process_single_segment(
    seg_idx: int,
    ctx: ColorExtractionContext,
    peakiness_threshold: float = 0.49,
    verbose: bool = True,
) -> SegmentColorResult:
    """
    Process a single segment to determine its dominant color.
    
    Args:
        seg_idx: Index of the segment to process
        ctx: Pre-computed context with flattened arrays
        peakiness_threshold: Threshold for color distribution peakiness
        verbose: Whether to print warnings
        
    Returns:
        SegmentColorResult with the determined color and status
    """
    per_seg_mask = (ctx.seg_flat == seg_idx)
    num_pixels = int(np.sum(per_seg_mask))
    
    assert num_pixels > 0, f"Seg {seg_idx} has no pixels"

    per_seg_no_line_mask = per_seg_mask & ~ctx.line_mask_flat

    # Check if line mask totally covers the segment (over-thresholded)
    if np.sum(per_seg_mask * per_seg_no_line_mask) == 0:
        if verbose:
            print(f'WARNING: all {num_pixels} pixels in seg were removed by the line mask')
        return SegmentColorResult(
            seg_idx=seg_idx,
            color=NULL_COLOR,
            status='over_thresholded',
            num_pixels=num_pixels,
        )

    # Check if it's a transparent segment (background)
    if np.sum(per_seg_no_line_mask * ctx.transparent_mask_flat) > (0.5 * np.sum(per_seg_no_line_mask)):
        if verbose:
            print(f'Found background seg with {np.sum(per_seg_no_line_mask)} pixels')
        return SegmentColorResult(
            seg_idx=seg_idx,
            color=TRANSPARENT_COLOR,
            status='transparent',
            num_pixels=num_pixels,
        )

    # Check if the segment is black in the line layer
    per_seg_black = per_seg_mask & ~ctx.black_mask_flat
    if np.sum(per_seg_black) == 0:
        if verbose:
            print(f'Found black seg with {num_pixels} pixels')
        return SegmentColorResult(
            seg_idx=seg_idx,
            color=BLACK_COLOR,
            status='black',
            num_pixels=num_pixels,
        )

    # Get color distribution (excluding line and transparent pixels)
    per_seg_not_transparent_mask = per_seg_mask & ~ctx.transparent_mask_flat
    per_seg_color_rgb_flat = ctx.color_rgb_flat[per_seg_no_line_mask & per_seg_not_transparent_mask]

    unique_colors, counts = np.unique(per_seg_color_rgb_flat, axis=0, return_counts=True)
    
    # Determine dominant color based on peakiness
    score = None
    if len(unique_colors) > 1:
        score = peakiness_score(counts) / len(unique_colors)
        if verbose and score < peakiness_threshold:
            color_counts_lookup = {
                rgba_to_dense_flat(np.concatenate([unique_colors[i], [255]], axis=0)): counts[i] 
                for i in range(len(unique_colors))
            }
            color_counts_str = color_counts_to_colored_text(color_counts_lookup)
            print(f"WARNING: multiple colors found in seg: {color_counts_str}, peakiness score: {score}")

    if len(unique_colors) == 1 or (score is not None and score >= peakiness_threshold):
        rgb_dominant_color = unique_colors[np.argmax(counts)]
        dense_dominant_color = rgba_to_dense_flat(np.concatenate([rgb_dominant_color, [255]], axis=0))
        return SegmentColorResult(
            seg_idx=seg_idx,
            color=dense_dominant_color,
            status='normal',
            num_pixels=num_pixels,
            peakiness_score=score,
        )
    else:
        return SegmentColorResult(
            seg_idx=seg_idx,
            color=NULL_COLOR,
            status='multi_color',
            num_pixels=num_pixels,
            peakiness_score=score,
        )


def aggregate_results(
    results: List[SegmentColorResult],
    verbose: bool = True,
) -> Tuple[List[int], Dict[str, int]]:
    """
    Aggregate segment results into a color list and stats.
    
    Args:
        results: List of SegmentColorResult, must be sorted by seg_idx
        verbose: Whether to print summary
        
    Returns:
        Tuple of (color_list, stats dict)
    """
    # Sort by segment index to ensure correct order
    results = sorted(results, key=lambda r: r.seg_idx)
    
    stats = {
        "num_total_segs": len(results),
        "num_multi_color_segs": sum(1 for r in results if r.status == 'multi_color'),
        "num_over_thresholded_segs": sum(1 for r in results if r.status == 'over_thresholded'),
        "num_transparent_segs": sum(1 for r in results if r.status == 'transparent'),
        "num_black_segs": sum(1 for r in results if r.status == 'black'),
    }
    
    color_list = [r.color for r in results]
    
    if verbose:
        color_str = color_list_to_colored_text(np.unique(color_list))
        print(f'Preprocessed frame with color list: {color_str}')
    
    return color_list, stats


def compute_color_list_serial(
    seg_image_data: np.ndarray,
    color_image_data: np.ndarray,
    line_binarized_data: Optional[np.ndarray] = None,
    line_image_data: Optional[np.ndarray] = None,
    num_segments: int = None,
    peakiness_threshold: float = 0.49,
    verbose: bool = True,
) -> Tuple[List[int], Dict[str, int]]:
    """
    Compute color list for all segments (serial version).
    
    Args:
        seg_image_data: Segmentation image as numpy array
        color_image_data: Color image as numpy array (RGBA)
        line_binarized_data: Optional binarized line mask
        line_image_data: Optional line image (RGBA)
        num_segments: Number of segments (computed from seg_image_data if not provided)
        peakiness_threshold: Threshold for color distribution peakiness
        verbose: Whether to print warnings and summary
        
    Returns:
        Tuple of (color_list, stats dict)
    """
    ctx = ColorExtractionContext.from_frames(
        seg_image_data=seg_image_data,
        color_image_data=color_image_data,
        line_binarized_data=line_binarized_data,
        line_image_data=line_image_data,
        num_segments=num_segments,
    )
    
    results = []
    for seg_idx in range(ctx.num_segments):
        result = process_single_segment(
            seg_idx=seg_idx,
            ctx=ctx,
            peakiness_threshold=peakiness_threshold,
            verbose=verbose,
        )
        results.append(result)
    
    return aggregate_results(results, verbose=verbose)


def compute_color_list_parallel(
    seg_image_data: np.ndarray,
    color_image_data: np.ndarray,
    line_binarized_data: Optional[np.ndarray] = None,
    line_image_data: Optional[np.ndarray] = None,
    num_segments: int = None,
    peakiness_threshold: float = 0.49,
    verbose: bool = True,
    max_workers: Optional[int] = None,
) -> Tuple[List[int], Dict[str, int]]:
    """
    Compute color list for all segments (parallel version using thread pool).
    
    Uses ThreadPoolExecutor to process segments in parallel. This can provide
    speedups when there are many segments, as the per-segment numpy operations
    can run concurrently.
    
    Args:
        seg_image_data: Segmentation image as numpy array
        color_image_data: Color image as numpy array (RGBA)
        line_binarized_data: Optional binarized line mask
        line_image_data: Optional line image (RGBA)
        num_segments: Number of segments (computed from seg_image_data if not provided)
        peakiness_threshold: Threshold for color distribution peakiness
        verbose: Whether to print warnings and summary
        max_workers: Maximum number of threads (defaults to min(32, num_segments))
        
    Returns:
        Tuple of (color_list, stats dict)
    """
    ctx = ColorExtractionContext.from_frames(
        seg_image_data=seg_image_data,
        color_image_data=color_image_data,
        line_binarized_data=line_binarized_data,
        line_image_data=line_image_data,
        num_segments=num_segments,
    )
    
    if max_workers is None:
        max_workers = min(32, ctx.num_segments)
    
    results = []
    
    # Use ThreadPoolExecutor for parallel processing
    # Note: We disable verbose in parallel mode to avoid jumbled output
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                process_single_segment,
                seg_idx=seg_idx,
                ctx=ctx,
                peakiness_threshold=peakiness_threshold,
                verbose=False,  # Disable per-segment verbose in parallel mode
            ): seg_idx
            for seg_idx in range(ctx.num_segments)
        }
        
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
    
    return aggregate_results(results, verbose=verbose)
