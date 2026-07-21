import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import Dict


# class MaskedLineLoss(nn.Module):
    
#     def forward(
#         self,
#         pred_line: torch.Tensor,
#         target_line: torch.Tensor,
#         gap_distance_weights: torch.Tensor,
#         line_distance_weights: torch.Tensor,
#     ) -> tuple[torch.Tensor, torch.Tensor]:
#         """Compute masked line loss using pre-computed focal masks from dataset.
        
#         Args:
#             pred_line: Predicted line probabilities
#             target_line: Ground truth lines
#             gap_distance_weights: Pre-computed distance weights for gap focal region
#             line_distance_weights: Pre-computed distance weights for line focal region
            
#         Returns:
#             tuple of (focal_loss, line_loss)
#         """

#         with torch.amp.autocast(device_type='cuda', enabled=False):
#             pred = pred_line.float()
#             target = target_line.float()
            
#             # gap loss - weighted by distance
#             # Compute per-pixel BCE
#             gap_bce = F.binary_cross_entropy(pred, target, reduction='none')
#             # Apply distance-based weighting within focal region
#             weighted_gap_loss = gap_bce * gap_distance_weights
#             # Average over pixels with non-zero weight
#             num_weighted_pixels = (gap_distance_weights > 0).sum()
#             if num_weighted_pixels > 0:
#                 focal_loss = weighted_gap_loss.sum() / num_weighted_pixels
#             else:
#                 focal_loss = torch.tensor(0.0, device=pred.device)

#             # line skeleton loss - weighted by distance
#             # Compute per-pixel BCE
#             line_bce = F.binary_cross_entropy(pred, target, reduction='none')
#             # Apply distance-based weighting within focal region
#             weighted_line_loss = line_bce * line_distance_weights
#             # Average over pixels with non-zero weight
#             num_weighted_line_pixels = (line_distance_weights > 0).sum()
#             if num_weighted_line_pixels > 0:
#                 line_loss = weighted_line_loss.sum() / num_weighted_line_pixels
#             else:
#                 line_loss = torch.tensor(0.0, device=pred.device)
        
#         return focal_loss, line_loss


class MaskedUDFLoss(nn.Module):
    
    def __init__(self, near_zero_threshold: float = 1.0):
        """
        Args:
            near_zero_threshold: Distance threshold for "near surface" for gradient loss
        """
        super().__init__()
        self.near_zero_threshold = near_zero_threshold

    def forward(
        self,
        pred_udf: torch.Tensor,
        target_udf: torch.Tensor,
        gap_distance_weights: torch.Tensor,
        skeleton_distance_weights: torch.Tensor,
    ) -> Dict[str, torch.Tensor]:
        """Compute masked UDF losses using pre-computed focal masks from dataset.
        
        Args:
            pred_udf: Predicted UDF
            target_udf: Ground truth UDF
            gap_distance_weights: Pre-computed distance weights for gap focal region
            skeleton_distance_weights: Pre-computed distance weights for skeleton focal region
            
        Returns:
            Dictionary with keys: 'gap', 'skeleton', 'gap_grad'
        """
        losses = {}
        
        with torch.amp.autocast(device_type='cuda', enabled=False):
            pred = pred_udf.float()
            target = target_udf.float()
            
            # Gap UDF loss - weighted by distance
            gap_l1 = torch.abs(pred - target)
            weighted_gap_loss = gap_l1 * gap_distance_weights
            num_weighted_gap_pixels = (gap_distance_weights > 0).sum()
            if num_weighted_gap_pixels > 0:
                gap_loss = weighted_gap_loss.sum() / num_weighted_gap_pixels
            else:
                gap_loss = torch.tensor(0.0, device=pred.device)

            if not torch.isfinite(gap_loss):
                gap_loss = torch.tensor(100.0, device=pred.device)

            losses['gap'] = gap_loss
            
            # Skeleton UDF loss - weighted by distance
            skeleton_l1 = torch.abs(pred - target)
            weighted_skeleton_loss = skeleton_l1 * skeleton_distance_weights
            num_weighted_skeleton_pixels = (skeleton_distance_weights > 0).sum()
            if num_weighted_skeleton_pixels > 0:
                skeleton_loss = weighted_skeleton_loss.sum() / num_weighted_skeleton_pixels
            else:
                skeleton_loss = torch.tensor(0.0, device=pred.device)

            if not torch.isfinite(skeleton_loss):
                skeleton_loss = torch.tensor(100.0, device=pred.device)

            losses['skeleton'] = skeleton_loss
            
            # Gradient magnitude loss in gap regions near zero level set
            # Compute gradients using central differences
            dy = (pred[:, :, 2:, 1:-1] - pred[:, :, :-2, 1:-1]) / 2.0
            dx = (pred[:, :, 1:-1, 2:] - pred[:, :, 1:-1, :-2]) / 2.0
            grad_mag = torch.sqrt(dx**2 + dy**2 + 1e-8)
            
            # Crop weights and UDF to match gradient dimensions
            gap_weights_cropped = gap_distance_weights[:, :, 1:-1, 1:-1]
            pred_cropped = pred[:, :, 1:-1, 1:-1]
            
            # Mask for near-zero level set (where gradient should be unit)
            near_surface = (pred_cropped < self.near_zero_threshold).float()
            
            # Combine: apply in gaps AND near surface, with distance weighting
            grad_mask = gap_weights_cropped * near_surface
            
            # Compute gradient magnitude loss (target is 1.0 for proper UDF)
            grad_diff = torch.abs(grad_mag - 1.0)
            weighted_grad_loss = grad_diff * grad_mask
            num_weighted_grad_pixels = (grad_mask > 0).sum()
            if num_weighted_grad_pixels > 0:
                grad_loss = weighted_grad_loss.sum() / num_weighted_grad_pixels
            else:
                grad_loss = torch.tensor(0.0, device=pred.device)
            losses['gap_grad'] = grad_loss
        
        return losses


class JointLoss(nn.Module):
    
    def __init__(
        self,
        udf_gap_weight: float = 1.0,
        udf_gap_grad_weight: float = 1.0,
        udf_skeleton_weight: float = 0.01,
        near_zero_threshold: float = 1.0,
    ):
        super().__init__()
        
        self.udf_gap_weight = udf_gap_weight
        self.udf_gap_grad_weight = udf_gap_grad_weight
        self.udf_skeleton_weight = udf_skeleton_weight
        
        self.udf_loss_fn = MaskedUDFLoss(near_zero_threshold=near_zero_threshold)
         
    def forward(
        self, 
        pred_udf: torch.Tensor, 
        target_udf: torch.Tensor, 
        target_lines: torch.Tensor, 
        gap_distance_weights: torch.Tensor,
        line_distance_weights: torch.Tensor,
    ) -> Dict[str, torch.Tensor]:
        """Compute joint UDF losses using pre-computed focal masks from dataset.
        
        Args:
            pred_udf: Predicted UDF
            target_udf: Ground truth UDF
            target_lines: Ground truth lines (not used, kept for compatibility)
            gap_distance_weights: Pre-computed distance weights for gap focal region
            line_distance_weights: Pre-computed distance weights for skeleton focal region
            
        Returns:
            Dictionary with keys: 'gap', 'gap_grad', 'skeleton', 'total'
        """
        losses = {}
        
        # Compute UDF losses with focal masks
        udf_losses = self.udf_loss_fn(
            pred_udf=pred_udf,
            target_udf=target_udf,
            gap_distance_weights=gap_distance_weights,
            skeleton_distance_weights=line_distance_weights,
        )
        
        losses['gap'] = udf_losses['gap'] * self.udf_gap_weight
        losses['gap_grad'] = udf_losses['gap_grad'] * self.udf_gap_grad_weight
        losses['skeleton'] = udf_losses['skeleton'] * self.udf_skeleton_weight
        
        # Compute total loss
        losses['total'] = losses['gap'] + losses['gap_grad'] + losses['skeleton']
        
        return losses



