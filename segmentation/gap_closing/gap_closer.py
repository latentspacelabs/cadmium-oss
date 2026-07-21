from typing import *
import time

import torch
import torch.nn.functional as F
import pytorch_lightning as pl
from torchmetrics.functional import accuracy, precision, recall
import numpy as np
from tiler import Tiler, Merger

from segmentation.trapped_ball.cropping import crop_image, uncrop
from segmentation.trapped_ball.parallel import compute_seg_full
from segmentation.trapped_ball.line import binarize

from segmentation.gap_closing.unet import ClassicUNet, count_parameters
from segmentation.gap_closing.loss import JointLoss
from segmentation.gap_closing.visualization import  create_visualization_figure, save_and_log_figure
from segmentation.gap_closing.dataset import GapLineDataset


class GapCloser(pl.LightningModule):
    
    def __init__(
        self,
        # train params
        learning_rate: float = 1e-4,
        weight_decay: float = 1e-5,
        scheduler_type: str = 'plateau',
        scheduler_patience: int = 8,
        scheduler_factor: float = 0.7,
        scheduler_warmup_epochs: int = 10,
        scheduler_max_epochs: int = 100,
        # arch params
        base_channels: int = 64,
        dropout: float = 0.1,
        image_size: int = 512,
        # loss params
        udf_gap_weight: float = 1.0,
        udf_gap_grad_weight: float = 1.0,
        udf_skeleton_weight: float = 0.1,
        near_zero_threshold: float = 1.0,
        # inference
        udf_threshold: float = 1.0,
        udf_max_dist: float = 50.0,
        **kwargs
    ):
        super().__init__()
        self.save_hyperparameters()
        
        self.model = ClassicUNet(base_channels=base_channels, image_size=image_size, dropout=dropout)
        
        self.criterion = JointLoss(
            udf_gap_weight=udf_gap_weight,
            udf_gap_grad_weight=udf_gap_grad_weight,
            udf_skeleton_weight=udf_skeleton_weight,
            near_zero_threshold=near_zero_threshold,
        )
        
        self.validation_step_outputs = []
        
        self.log_model_info()
    
    def log_model_info(self):
        param_count = count_parameters(self.model)
        print(f"Parameters: {param_count:,}")
    
    def forward(self, x):
        """Run forward pass and return multiple UDF representations.
        
        Returns:
            tuple of (udf_normalized, udf_denormalized, boundary_binary):
                - udf_normalized: Raw UDF predictions in [0, 1] range
                - udf_denormalized: UDF in pixel units [0, max_dist]
                - boundary_binary: Binary line predictions from thresholded UDF
        """
        # Get normalized UDF from model
        udf_normalized = self.model(x)
        
        # Denormalize UDF to pixel units
        udf_denormalized = udf_normalized * self.hparams.udf_max_dist
        
        # Compute binary boundary from normalized UDF
        boundary_binary = (udf_denormalized < self.hparams.udf_threshold).float()

        # Binarized input image + pred boundary binary
        combined_boundary_binary = np.stack([
            np.maximum(
                boundary_binary[i, 0].detach().cpu().numpy(),
                1 - (binarize((img[0].detach().cpu().numpy() * 255).astype(np.uint8)) / 255.0)
            )
            for i, img in enumerate(x)
        ])
        
        return udf_normalized, udf_denormalized, combined_boundary_binary
    
    def predict(
        self,
        image: Union[np.ndarray, torch.Tensor],
        overlap_factor: float = 0.5,
        batch_size: int = 1,
        crop_to_content: bool = True,
        padding: int = 10,
        tb_sizes: List[int] = [3, 2, 1],
        tb_max_iter: int = 10,
        tb_min_seg_size: int = 20,
    ) -> Tuple[np.ndarray, np.ndarray, int]:
        """Run tiled gap closing inference with trapped ball segmentation.
        
        Args:
            image: Input RGBA image
            overlap_factor: Overlap between tiles for ML inference
            batch_size: Batch size for ML inference
            crop_to_content: Whether to crop to content before processing
            padding: Padding around content when cropping
            tb_sizes: Trapped ball sizes for segmentation
            tb_max_iter: Max iterations for trapped ball
            tb_min_seg_size: Minimum segment size
            
        Returns:
            Tuple of (merged_boundary, labeled_regions, num_regions)
        """
        # Convert to numpy and extract alpha channel
        if torch.is_tensor(image):
            image_np = image.detach().cpu().numpy()
        else:
            image_np = np.array(image)
        
        # Extract alpha channel from RGBA
        if image_np.ndim == 3 and image_np.shape[2] == 4:
            image_np = image_np[:, :, 3].astype(np.float32) / 255.0
        
        # Add channel dimension: (H, W) -> (1, H, W)
        if image_np.ndim == 2:
            image_np = image_np[np.newaxis, ...]
        
        # Crop to content if requested
        if crop_to_content:
            crop_input = (image_np[0] * 255).astype(np.uint8)
            cropped_image, vert_pad_dims, horiz_pad_dims = crop_image(crop_input, padding=padding)
            image_np = (cropped_image.astype(np.float32) / 255.0)[np.newaxis, ...]
        else:
            vert_pad_dims = (0, 0)
            horiz_pad_dims = (0, 0)
        
        _, height, width = image_np.shape
        
        # Setup tiler for ML inference
        tile_size = self.hparams.image_size
        tile_shape = (tile_size, tile_size)
        overlap = (int(tile_size * overlap_factor), int(tile_size * overlap_factor))
        
        tiler = Tiler(data_shape=(height, width), tile_shape=tile_shape, overlap=overlap)
        _, tiler_padding = tiler.calculate_padding()
        
        # Pad image for tiling
        padding_full = [(0, 0)] + list(tiler_padding)
        padded_image = np.pad(image_np, padding_full, mode="edge")
        padded_height, padded_width = padded_image.shape[1], padded_image.shape[2]
        
        # Set pixels within 2 pixels of edge to 1.0 (line) so edge regions are closed
        edge_width = 2
        padded_image[:, :edge_width, :] = 1.0
        padded_image[:, -edge_width:, :] = 1.0
        padded_image[:, :, :edge_width] = 1.0
        padded_image[:, :, -edge_width:] = 1.0
        
        tiler = Tiler(data_shape=(padded_height, padded_width), tile_shape=tile_shape, overlap=overlap)
        merger = Merger(tiler=tiler, window="overlap-tile")
        
        # Process tiles with ML gap closer
        self.model.eval()
        batch_num = 0
        with torch.no_grad():
            tiles_batch = []
            tiles_ids = []
            
            for tile_id, tile_2d in tiler.iterate(padded_image[0]):
                tile = tile_2d[np.newaxis, ...]
                tiles_batch.append(tile)
                tiles_ids.append(tile_id)
                
                if len(tiles_batch) >= batch_size:
                    batch_start = time.time()
                    batch_tensor = torch.from_numpy(np.stack(tiles_batch, axis=0)).float().to(self.device)
                    _, _, boundary_bin = self.forward(batch_tensor)
                    batch_time = time.time() - batch_start
                    print(f"GPU batch {batch_num}: {len(tiles_batch)} tiles in {batch_time:.3f}s")
                    batch_num += 1
                    
                    for i, tid in enumerate(tiles_ids):
                        boundary_tile = boundary_bin[i]
                        merger.add(tid, boundary_tile)
                    
                    tiles_batch = []
                    tiles_ids = []
            
            # Process remaining tiles
            if len(tiles_batch) > 0:
                batch_start = time.time()
                batch_tensor = torch.from_numpy(np.stack(tiles_batch, axis=0)).float().to(self.device)
                _, _, boundary_bin = self.forward(batch_tensor)
                batch_time = time.time() - batch_start
                print(f"GPU batch {batch_num}: {len(tiles_batch)} tiles in {batch_time:.3f}s")
                
                for i, tid in enumerate(tiles_ids):
                    boundary_tile = boundary_bin[i]
                    merger.add(tid, boundary_tile)
        
        # Merge boundary tiles
        merged_boundary = 255 - (merger.merge(extra_padding=tiler_padding, dtype=np.uint8) * 255)
        
        # Run parallel trapped ball segmentation on merged image
        print(f"Running parallel trapped ball segmentation on {merged_boundary.shape} image...")
        seg_start = time.time()
        
        # Setup tiler/merger for parallel segmentation
        seg_tile_size = (512, 512)
        seg_overlap_factor = 0.5
        seg_tiler = Tiler(
            data_shape=merged_boundary.shape,
            tile_shape=seg_tile_size,
            overlap=(int(seg_tile_size[0] * seg_overlap_factor), int(seg_tile_size[1] * seg_overlap_factor)),
        )
        seg_new_shape, seg_padding = seg_tiler.calculate_padding()
        seg_tiler.recalculate(data_shape=seg_new_shape)
        seg_padded_image = np.pad(merged_boundary, seg_padding, mode="constant", constant_values=0)
        seg_merger = Merger(tiler=seg_tiler, window="overlap-tile")
        
        merged_seg, _, _ = compute_seg_full(
            binary=seg_padded_image,
            tiler=seg_tiler,
            merger=seg_merger,
            padding=seg_padding,
            overlap_factor=seg_overlap_factor,
            tb_sizes=tb_sizes,
            max_iter=tb_max_iter,
            min_seg_size=tb_min_seg_size,
        )
        
        # Postprocessing: remap labels to consecutive integers
        unique, labeled_regions = np.unique(merged_seg, return_inverse=True)
        labeled_regions = labeled_regions.reshape(merged_boundary.shape).astype(np.uint8)
        
        seg_time = time.time() - seg_start
        print(f"Parallel trapped ball segmentation took {seg_time:.3f}s")
        
        # Uncrop back to original size
        if crop_to_content and (vert_pad_dims != (0, 0) or horiz_pad_dims != (0, 0)):
            merged_boundary = uncrop(merged_boundary, vert_pad_dims, horiz_pad_dims)
            labeled_regions = uncrop(labeled_regions, vert_pad_dims, horiz_pad_dims)
        
        # Count unique regions (excluding background 0)
        num_regions = len(unique) - 1 if 0 in unique else len(unique)
        
        return merged_boundary, labeled_regions, num_regions
    
    def training_step(self, batch, batch_idx):
        udf_normalized, _, boundary_binary = self.forward(batch['gap_lines_brush'])

        # Use pre-computed focal masks from dataset
        # Loss is computed on normalized UDF
        losses = self.criterion(
            pred_udf=udf_normalized,
            target_udf=batch['udf'], 
            target_lines=batch['lines'],
            gap_distance_weights=batch['gap_weights'],
            line_distance_weights=batch['skeleton_weights'],
        )
        
        self.log('train/total_loss', losses['total'], on_step=True, on_epoch=True, prog_bar=True)
        self.log('train/gap_grad_loss', losses['gap_grad'], on_step=True, on_epoch=True, prog_bar=True)
        self.log('train/gap_loss', losses['gap'], on_step=True, on_epoch=True, prog_bar=True)
        self.log('train/skeleton_loss', losses['skeleton'], on_step=True, on_epoch=True, prog_bar=True)
        
        # Log learning rate
        current_lr = self.optimizers().param_groups[0]['lr']
        self.log('lr', current_lr, on_step=True, on_epoch=False, prog_bar=True)
        
        if batch_idx % 50 == 0:
            train_metrics = self.compute_metrics(udf_normalized, boundary_binary, batch)
            for key, value in train_metrics.items():
                self.log(f'train/{key}', value, on_step=True, on_epoch=False)
        
        return losses['total']
    
    def validation_step(self, batch, batch_idx):
        self.model.eval()
        
        udf_normalized, _ , boundary_binary = self.forward(batch['gap_lines_brush'])
        
        # Use pre-computed focal masks from dataset
        # Loss is computed on normalized UDF
        losses = self.criterion(
            pred_udf=udf_normalized,
            target_udf=batch['udf'],
            target_lines=batch['lines'],
            gap_distance_weights=batch['gap_weights'],
            line_distance_weights=batch['skeleton_weights'],
        )

        self.log('val/total_loss', losses['total'], on_step=False, on_epoch=True, prog_bar=True)
        self.log('val/gap_grad_loss', losses['gap_grad'], on_step=False, on_epoch=True, prog_bar=True)
        self.log('val/skeleton_loss', losses['skeleton'], on_step=False, on_epoch=True, prog_bar=True)
        self.log('val/gap_loss', losses['gap'], on_step=False, on_epoch=True, prog_bar=True)
        
        metrics = self.compute_metrics(udf_normalized, boundary_binary, batch)
        for key, value in metrics.items():
            self.log(f'val/{key}', value, on_step=False, on_epoch=True)
        
        self.validation_step_outputs.append({
            'gap_lines_raw': batch['gap_lines_raw'][:4].cpu().float(),
            'gap_lines_brush': batch['gap_lines_brush'][:4].cpu().float(),
            'gap_focal_mask': batch['gap_focal_mask'][:4].cpu().float(),
            'skeleton_focal_mask': batch['skeleton_focal_mask'][:4].cpu().float(),
            'pred_udfs': udf_normalized[:4].cpu().float(),
            'target_udfs': batch['udf'][:4].cpu().float(),
            'target_lines': batch['lines'][:4].cpu().float(),
            'losses': {k: v.item() if torch.is_tensor(v) else v for k, v in losses.items()}
        })
  
        return losses['total']
    
    def test_step(self, batch, batch_idx):
        return self.validation_step(batch, batch_idx)
    
    def on_validation_epoch_end(self):
        self.log_predictions()

        if self.validation_step_outputs:
            self.validation_step_outputs.clear()
    
    def compute_metrics(self, pred_udfs, boundary_binary, batch):
        """Compute metrics for UDF predictions.
        
        Args:
            pred_udfs: Predicted normalized UDF [0, 1]
            boundary_binary: Pre-computed binary line predictions
            batch: Dictionary with ground truth data and pre-computed focal masks
            
        Returns:
            Dictionary of metrics
        """
        metrics = {}
        
        # Standard UDF metrics (using normalized UDF)
        mae_udf = F.l1_loss(pred_udfs, batch['udf'])
        metrics['udf_mae'] = mae_udf
        
        # Masked UDF MAE in gap focal region (using pre-computed weights)
        gap_weights = batch['gap_weights']
        masked_udf_l1 = torch.abs(pred_udfs - batch['udf'])
        weighted_gap_mae = (masked_udf_l1 * gap_weights).sum() / (gap_weights.sum() + 1e-8)
        metrics['udf_gap_mae'] = weighted_gap_mae
        
        # Masked UDF MAE in skeleton focal region
        skeleton_weights = batch['skeleton_weights']
        weighted_skeleton_mae = (masked_udf_l1 * skeleton_weights).sum() / (skeleton_weights.sum() + 1e-8)
        metrics['udf_skeleton_mae'] = weighted_skeleton_mae
        
        # Compute target binary from ground truth UDF
        target_lines_binary = (batch['lines'] > 0.01).long()
        boundary_binary_int = boundary_binary.long()

        # Gap focal metrics (accuracy, precision, recall)
        if gap_weights.sum() > 0:
            gap_mask = gap_weights > 0
            gap_pred = boundary_binary_int[gap_mask]
            gap_target = target_lines_binary[gap_mask]
            
            metrics['gap_focal_accuracy'] = accuracy(gap_pred, gap_target, task='binary')
            metrics['gap_focal_precision'] = precision(gap_pred, gap_target, task='binary')
            metrics['gap_focal_recall'] = recall(gap_pred, gap_target, task='binary')
        else:
            # No gaps to predict
            metrics['gap_focal_accuracy'] = torch.tensor(1.0, device=boundary_binary.device)
            metrics['gap_focal_precision'] = torch.tensor(1.0, device=boundary_binary.device)
            metrics['gap_focal_recall'] = torch.tensor(1.0, device=boundary_binary.device)

        # Skeleton focal metrics (accuracy, precision, recall)
        if skeleton_weights.sum() > 0:
            skeleton_mask = skeleton_weights > 0
            skeleton_pred = boundary_binary_int[skeleton_mask]
            skeleton_target = target_lines_binary[skeleton_mask]
            
            metrics['skeleton_focal_accuracy'] = accuracy(skeleton_pred, skeleton_target, task='binary')
            metrics['skeleton_focal_precision'] = precision(skeleton_pred, skeleton_target, task='binary')
            metrics['skeleton_focal_recall'] = recall(skeleton_pred, skeleton_target, task='binary')
        else:
            metrics['skeleton_focal_accuracy'] = torch.tensor(1.0, device=boundary_binary.device)
            metrics['skeleton_focal_precision'] = torch.tensor(1.0, device=boundary_binary.device)
            metrics['skeleton_focal_recall'] = torch.tensor(1.0, device=boundary_binary.device)
        
        return metrics
    
    def log_predictions(self):
        """Log validation predictions as visualizations."""
        if not self.validation_step_outputs:
            return
        
        num_batches = len(self.validation_step_outputs)
        
        for batch_idx in range(num_batches):
            outputs = self.validation_step_outputs[batch_idx]
            # Create visualization figure with UDF threshold
            fig = create_visualization_figure(
                outputs, 
                batch_idx, 
                self.current_epoch,
                self.hparams.udf_threshold,  # Use UDF threshold for binary conversion
                self.hparams.udf_max_dist,  # Use UDF max distance for denormalization
            )
            
            # Save and log the figure
            save_and_log_figure(fig, batch_idx, self.current_epoch, self.logger)
    
    def configure_optimizers(self):
        optimizer = torch.optim.AdamW(
            self.parameters(),
            lr=self.hparams.learning_rate,
            weight_decay=self.hparams.weight_decay,
            betas=(0.9, 0.999)
        )
        
        if self.hparams.scheduler_type == 'plateau':
            scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
                optimizer,
                mode='min',
                factor=self.hparams.scheduler_factor,
                patience=self.hparams.scheduler_patience,
                min_lr=1e-6,
                verbose=True
            )
            return {
                'optimizer': optimizer,
                'lr_scheduler': {
                    'scheduler': scheduler,
                    'monitor': 'val/total_loss',
                    'interval': 'epoch',
                    'frequency': 1
                }
            }
        elif self.hparams.scheduler_type == 'cosine':
            scheduler = torch.optim.lr_scheduler.CosineAnnealingWarmRestarts(
                optimizer, T_0=self.hparams.scheduler_warmup_epochs, T_mult=2, eta_min=1e-6
            )
            return optimizer, scheduler
        else:
            return optimizer
    
    def configure_callbacks(self):
        callbacks = []
        
        # Model checkpointing
        checkpoint_callback = pl.callbacks.ModelCheckpoint(
            monitor='val/total_loss',
            mode='min',
            save_top_k=3,
            save_last=True,
            filename='udf-{epoch:02d}-{val/total_loss:.4f}',
            auto_insert_metric_name=False
        )
        callbacks.append(checkpoint_callback)
        
        # Early stopping
        early_stop_callback = pl.callbacks.EarlyStopping(
            monitor='val/total_loss',
            mode='min',
            patience=50,
            verbose=True
        )
        callbacks.append(early_stop_callback)
        
        # Learning rate monitoring
        lr_monitor = pl.callbacks.LearningRateMonitor(logging_interval='epoch')
        callbacks.append(lr_monitor)
        
        return callbacks
