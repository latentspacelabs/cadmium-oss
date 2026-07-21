import torch
import torch.nn.functional as F
import matplotlib.pyplot as plt
import matplotlib.cm as cm
import io
from PIL import Image
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


def udf_to_heatmap(
    udf: np.ndarray,
    colormap: str = 'viridis',
    percentile_max: float = 95.0,
    invert: bool = True,
    add_annotation: bool = False
) -> np.ndarray:
    """Convert UDF (Unsigned Distance Field) to RGB heatmap image.
    
    This function provides consistent UDF visualization across training and inference.
    
    Args:
        udf: 2D numpy array with distance values
        colormap: Matplotlib colormap name (default: 'viridis')
        percentile_max: Percentile for max normalization to avoid outliers (default: 95.0)
        invert: If True, low UDF values appear as hot colors (default: True)
        add_annotation: If True, add text showing UDF range (default: False)
        
    Returns:
        RGB image (H, W, 3) as uint8 in range [0, 255]
    """
    # Use percentile-based normalization for better dynamic range
    udf_min = np.min(udf)
    udf_max = np.percentile(udf, percentile_max)
    
    # Ensure valid range
    if udf_max - udf_min < 0.1:
        udf_max = udf_min + 10.0
    
    # Normalize to [0, 1]
    udf_normalized = np.clip((udf - udf_min) / (udf_max - udf_min), 0, 1)
    
    # Invert so lines (low UDF) appear as hot colors
    if invert:
        udf_normalized = 1.0 - udf_normalized
    
    # Apply matplotlib colormap
    cmap = cm.get_cmap(colormap)
    udf_rgb = cmap(udf_normalized)[:, :, :3]  # Drop alpha channel
    udf_rgb = (udf_rgb * 255).astype(np.uint8)
    
    # Add text annotation if requested
    if add_annotation:
        udf_rgb = udf_rgb.copy()
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.5
        font_thickness = 1
        text = f"UDF: 0 (lines) -> {udf_max:.1f} (background)"
        text_size = cv2.getTextSize(text, font, font_scale, font_thickness)[0]
        
        # Draw background for text
        padding = 5
        cv2.rectangle(udf_rgb, 
                     (padding, padding), 
                     (text_size[0] + padding * 2, text_size[1] + padding * 3),
                     (255, 255, 255), -1)
        
        # Draw text
        cv2.putText(udf_rgb, text, 
                   (padding * 2, text_size[1] + padding * 2),
                   font, font_scale, (0, 0, 0), font_thickness, cv2.LINE_AA)
    
    return udf_rgb


def plot_input_image(ax, gap_lines, sample_idx):
    """Plot input image with gaps."""
    ax.imshow(gap_lines[sample_idx, 0], cmap='gray')
    ax.set_title('Input (with gaps)')
    ax.axis('off')


def compute_udf_metrics(pred_udfs, target_udfs, udf_mask, sample_idx):
    """Compute UDF metrics for a single sample."""
    # MSE over entire sample
    udf_mse = F.mse_loss(pred_udfs[sample_idx:sample_idx+1], target_udfs[sample_idx:sample_idx+1]).item()
    
    # Masked MAE in focal region
    masked_udf_l1 = torch.abs(pred_udfs[sample_idx:sample_idx+1] - target_udfs[sample_idx:sample_idx+1])
    masked_udf_mae = (masked_udf_l1 * udf_mask.unsqueeze(0)).sum() / (udf_mask.sum() + 1e-8)
    
    return udf_mse, masked_udf_mae.item()


def plot_predicted_udf_heatmap(ax, pred_udfs, sample_idx, skeleton_focal_mask=None, gap_focal_mask=None):
    """Plot predicted UDF as heatmap with focal mask borders."""
    # Convert UDF to numpy and create heatmap visualization
    udf_np = pred_udfs[sample_idx, 0].cpu().numpy()
    udf_heatmap_rgb = udf_to_heatmap(udf_np, colormap='viridis', percentile_max=95.0, invert=True, add_annotation=False)
    
    ax.imshow(udf_heatmap_rgb)
    
    # Overlay skeleton focal mask border (blue)
    if skeleton_focal_mask is not None:
        ax.contour(skeleton_focal_mask[sample_idx, 0], levels=[0.5], colors='cyan', linewidths=1, alpha=0.8)
    
    # Overlay gap focal mask border (red)
    if gap_focal_mask is not None:
        ax.contour(gap_focal_mask[sample_idx, 0], levels=[0.5], colors='red', linewidths=1, alpha=0.8)
    
    ax.set_title('Predicted UDF\n(cyan=skeleton, red=gap)')
    ax.axis('off')


def compute_iou(pred_binary, target):
    """Compute IoU between predicted and target binary masks."""
    intersection = (pred_binary * target).sum()
    union = (pred_binary + target).clamp(0, 1).sum()
    return (intersection / (union + 1e-8)).item()


def plot_predicted_lines_from_udf(ax, pred_udfs, target_udfs, sample_idx, udf_threshold=1.0, udf_max_dist=50.0):
    """Plot binary lines from UDF threshold with IoU metric."""
    # Denormalize UDFs before comparing to threshold
    pred_udf_denormalized = pred_udfs[sample_idx, 0] * udf_max_dist
    target_udf_denormalized = target_udfs[sample_idx, 0] * udf_max_dist
    
    # Binarize UDF to get lines (UDF < threshold = line)
    lines_binary = (pred_udf_denormalized < udf_threshold).float()
    target_binary = (target_udf_denormalized < udf_threshold).float()
    
    ax.imshow(lines_binary, cmap='gray')
    
    # Calculate IoU
    iou = compute_iou(lines_binary, target_binary)
    
    ax.set_title(f'Predicted Lines (UDF<{udf_threshold})\nIoU: {iou:.3f}')
    ax.axis('off')
    
    return lines_binary


def identify_gap_pixels(gap_lines, target_lines, sample_idx):
    """Identify gap pixels (parts of lines that are missing in input).
    
    Note: target_lines is expected to be already sliced to a single sample."""
    # Convert gap_lines to grayscale if needed
    if gap_lines.shape[1] == 1:
        input_mask = gap_lines[sample_idx:sample_idx+1, 0:1]
    else:
        input_mask = (0.299 * gap_lines[sample_idx:sample_idx+1, 0:1] + 
                     0.587 * gap_lines[sample_idx:sample_idx+1, 1:2] + 
                     0.114 * gap_lines[sample_idx:sample_idx+1, 2:3])
    
    # Gap pixels are where target has lines but input doesn't
    # target_lines is already sliced, so use index 0
    gap_pixels = (target_lines[0, 0] > 0.5) & (input_mask[0, 0] < 0.5)
    
    # Also identify non-gap line pixels for context
    all_line_pixels = target_lines[0, 0] > 0.5
    non_gap_line_pixels = all_line_pixels & ~gap_pixels
    
    return gap_pixels, non_gap_line_pixels


def create_gap_accuracy_visualization(lines_binary, target_lines, gap_pixels, non_gap_line_pixels, sample_idx):
    """Create RGB visualization showing gap prediction accuracy.
    
    Note: target_lines is expected to be already sliced to a single sample."""
    # target_lines is already sliced, so use index 0
    gap_viz = torch.zeros(3, *target_lines[0, 0].shape)
    
    if gap_pixels.sum() > 0:
        # Compute correctness of predictions on gap pixels
        correct = (lines_binary == target_lines[0, 0]).float()
        gap_accuracy = correct[gap_pixels].mean().item()
        
        # Create masks for correct and incorrect gap predictions
        gap_correct_mask = torch.zeros_like(gap_pixels)
        gap_incorrect_mask = torch.zeros_like(gap_pixels)
        gap_correct_mask[gap_pixels] = correct[gap_pixels].bool()
        gap_incorrect_mask[gap_pixels] = ~correct[gap_pixels].bool()
        
        # Green for correctly predicted gap pixels
        gap_viz[0][gap_correct_mask] = 0.0
        gap_viz[1][gap_correct_mask] = 1.0
        gap_viz[2][gap_correct_mask] = 0.0
        
        # Red for incorrectly predicted gap pixels
        gap_viz[0][gap_incorrect_mask] = 1.0
        gap_viz[1][gap_incorrect_mask] = 0.0
        gap_viz[2][gap_incorrect_mask] = 0.0
        
        title_text = f'Gap Predictions\nAcc: {gap_accuracy:.3f} (green=correct, red=incorrect)'
    else:
        title_text = 'Gap Predictions\n(no gaps)'
    
    # White for non-gap line pixels (existing lines in input)
    gap_viz[0][non_gap_line_pixels] = 1.0
    gap_viz[1][non_gap_line_pixels] = 1.0
    gap_viz[2][non_gap_line_pixels] = 1.0
    
    return gap_viz, title_text


def plot_gap_accuracy_from_udf(ax, gap_lines, pred_udfs, target_udfs, sample_idx, udf_threshold=1.0, udf_max_dist=50.0):
    """Plot gap prediction accuracy visualization from UDF predictions."""
    # Denormalize UDFs before comparing to threshold
    target_udf_denormalized = target_udfs[sample_idx:sample_idx+1, :] * udf_max_dist
    pred_udf_denormalized = pred_udfs[sample_idx, 0] * udf_max_dist
    
    # Convert target UDF to binary lines for gap pixel identification
    target_lines_binary = (target_udf_denormalized < udf_threshold).float()
    
    gap_pixels, non_gap_line_pixels = identify_gap_pixels(gap_lines, target_lines_binary, sample_idx)
    
    # Binarize predicted UDF to get lines
    lines_binary = (pred_udf_denormalized < udf_threshold).float()
    
    gap_viz, title_text = create_gap_accuracy_visualization(
        lines_binary, target_lines_binary, gap_pixels, non_gap_line_pixels, sample_idx
    )
    
    ax.imshow(gap_viz.permute(1, 2, 0))
    ax.set_title(title_text)
    ax.axis('off')


def plot_sample_row(axes, data, sample_idx, udf_threshold, udf_max_dist):
    """Plot all visualizations for a single sample (UDF-based predictions).
    
    Args:
        axes: Array of matplotlib axes for plotting
        data: Dictionary with visualization data
        sample_idx: Index of sample to visualize
        udf_threshold: Threshold for converting UDF to binary lines
        udf_max_dist: Maximum distance for UDF denormalization
    """
    # Column 0: Input image (with gaps)
    plot_input_image(axes[0], data['gap_lines_brush'], sample_idx)
    
    # Overlay focal mask borders on input image
    skeleton_focal_mask = data.get('skeleton_focal_mask', None)
    gap_focal_mask = data.get('gap_focal_mask', None)
    if skeleton_focal_mask is not None:
        axes[0].contour(skeleton_focal_mask[sample_idx, 0], levels=[0.5], colors='cyan', linewidths=1, alpha=0.8)
    if gap_focal_mask is not None:
        axes[0].contour(gap_focal_mask[sample_idx, 0], levels=[0.5], colors='red', linewidths=1, alpha=0.8)
    axes[0].set_title('Input (with gaps)\n(cyan=skeleton, red=gap)')
    
    # Column 1: Ground truth lines from target UDF
    # Denormalize UDF before comparing to threshold
    target_udf_denormalized = data['target_udfs'][sample_idx, 0] * udf_max_dist
    target_lines_binary = (target_udf_denormalized < udf_threshold).float()
    axes[1].imshow(target_lines_binary, cmap='gray')
    axes[1].set_title('GT Lines (from UDF)')
    axes[1].axis('off')
    
    # Column 2: Ground truth UDF heatmap
    udf_np = data['target_udfs'][sample_idx, 0].cpu().numpy()
    udf_heatmap_rgb = udf_to_heatmap(udf_np, colormap='viridis', percentile_max=95.0, invert=True, add_annotation=False)
    axes[2].imshow(udf_heatmap_rgb)
    axes[2].set_title('GT UDF')
    axes[2].axis('off')
    
    # Column 3: Predicted UDF heatmap with focal mask borders
    plot_predicted_udf_heatmap(axes[3], data['pred_udfs'], sample_idx, skeleton_focal_mask, gap_focal_mask)
    
    # Column 4: Predicted lines from UDF (binary with IoU)
    plot_predicted_lines_from_udf(axes[4], data['pred_udfs'], data['target_udfs'], sample_idx, udf_threshold, udf_max_dist)
    
    # Column 5: Gap accuracy visualization
    plot_gap_accuracy_from_udf(axes[5], data['gap_lines_raw'], data['pred_udfs'], data['target_udfs'], sample_idx, udf_threshold, udf_max_dist)
    

def create_visualization_figure(data, batch_idx, current_epoch, udf_threshold, udf_max_dist):
    """Create a figure with all visualizations for a batch (UDF-based predictions).
    
    Args:
        data: Dictionary with visualization data
        batch_idx: Batch index
        current_epoch: Current training epoch
        udf_threshold: Threshold for converting UDF to binary lines
        udf_max_dist: Maximum distance for UDF denormalization
        
    Returns:
        matplotlib figure
    """
    num_samples = min(4, data['gap_lines_raw'].shape[0])
    num_cols = 6  # Updated to 6 columns for UDF-based visualization
    
    fig, axes = plt.subplots(num_samples, num_cols, figsize=(4*num_cols, 4*num_samples))
    if num_samples == 1:
        axes = axes.reshape(1, -1)
    
    # Plot each sample
    for i in range(num_samples):
        plot_sample_row(axes[i], data, i, udf_threshold, udf_max_dist)
    
    plt.suptitle(f'Epoch {current_epoch} - UDF Predictions (Batch {batch_idx+1})')
    plt.tight_layout()
    
    return fig


def save_and_log_figure(fig, batch_idx, current_epoch, logger=None):
    """Save figure to buffer and log to experiment tracking system."""
    # Convert to image buffer
    buf = io.BytesIO()
    plt.savefig(buf, format='png', dpi=150, bbox_inches='tight')
    buf.seek(0)
    img = Image.open(buf)
    
    # Log to appropriate logger
    if logger:
        if hasattr(logger.experiment, 'log_figure'):
            # Comet ML logger
            logger.experiment.log_figure(
                figure_name=f'predictions_batch_{batch_idx+1}',
                figure=fig,
                step=current_epoch
            )
        elif hasattr(logger.experiment, 'add_figure'):
            # TensorBoard logger
            logger.experiment.add_figure(
                f'predictions_batch_{batch_idx+1}',
                fig,
                current_epoch
            )
    
    plt.close(fig)
    buf.close()

