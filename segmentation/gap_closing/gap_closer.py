from typing import *
import time

import torch
import torch.nn.functional as F
import pytorch_lightning as pl
import numpy as np
from tiler import Tiler, Merger

from segmentation.trapped_ball.cropping import crop_image, uncrop
from segmentation.trapped_ball.parallel import compute_seg_full
from segmentation.trapped_ball.line import binarize

from segmentation.gap_closing.unet import ClassicUNet, count_parameters


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
