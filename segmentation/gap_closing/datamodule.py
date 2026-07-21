import pytorch_lightning as pl
from torch.utils.data import DataLoader
from typing import Optional
import torch

from dataset import GapLineDataset


def collate_fn(batch):
    """
    Custom collate function to handle dictionary returns with variable-length junction_points.
    
    Args:
        batch: List of dictionaries from RealLineDataset
    
    Returns:
        Dictionary with batched tensors and list of junction_points dicts
    """
    # Stack all tensor fields
    batched = {
        'lines': torch.stack([item['lines'] for item in batch]),
        'gap_lines_raw': torch.stack([item['gap_lines_raw'] for item in batch]),
        'gap_lines_brush': torch.stack([item['gap_lines_brush'] for item in batch]),
        'udf': torch.stack([item['udf'] for item in batch]),
        'gap_focal_mask': torch.stack([item['gap_focal_mask'] for item in batch]),
        'gap_weights': torch.stack([item['gap_weights'] for item in batch]),
        'skeleton_focal_mask': torch.stack([item['skeleton_focal_mask'] for item in batch]),
        'skeleton_weights': torch.stack([item['skeleton_weights'] for item in batch]),
        # Keep junction_points as list, don't try to batch
        'junction_points': [item['junction_points'] for item in batch],
    }
    
    return batched


class GapLineDataModule(pl.LightningDataModule):
    """PyTorch Lightning data module for real line image dataset."""
    
    def __init__(
        self,
        batch_size: int = 16,
        num_workers: int = 4,
        pin_memory: bool = True,
        crop_size: int = 512,
        train_ratio: float = 1.0,
        augment_prob: float = 0.5,
        junction_gap_min: float = 0.1,
        junction_gap_max: float = 0.5,
        junction_gap_cap: int = 10,
        corner_gap_min: float = 0.1,
        corner_gap_max: float = 0.3,
        corner_gap_cap: int = 10,
        random_gap_min: int = 0,
        random_gap_max: int = 5,
        deduplicate_points: bool = True,
        min_point_distance: int = 3,
        gap_length_min: int = 1,
        gap_length_max: int = 24,
        gap_width: int = 2,
        min_gap_distance: int = 0,
        brush_augment_prob: float = 0.5,
        speckle_prob: float = 0.3,
        line_focal_distance_threshold: float = 4.5,
        udf_max_dist: float = 50.0,
        **kwargs
    ):
        super().__init__()
        self.save_hyperparameters()
        
        self.batch_size = batch_size
        self.num_workers = num_workers
        self.pin_memory = pin_memory
        self.crop_size = crop_size
        self.train_ratio = train_ratio
        self.augment_prob = augment_prob
        self.junction_gap_min = junction_gap_min
        self.junction_gap_max = junction_gap_max
        self.junction_gap_cap = junction_gap_cap
        self.corner_gap_min = corner_gap_min
        self.corner_gap_max = corner_gap_max
        self.corner_gap_cap = corner_gap_cap
        self.random_gap_min = random_gap_min
        self.random_gap_max = random_gap_max
        self.deduplicate_points = deduplicate_points
        self.min_point_distance = min_point_distance
        self.gap_length_min = gap_length_min
        self.gap_length_max = gap_length_max
        self.gap_width = gap_width
        self.min_gap_distance = min_gap_distance
        self.brush_augment_prob = brush_augment_prob
        self.speckle_prob = speckle_prob
        self.line_focal_distance_threshold = line_focal_distance_threshold
        self.udf_max_dist = udf_max_dist
        # Dataset placeholders
        self.train_dataset = None
        self.val_dataset = None
    
    def setup(self, stage: Optional[str] = None):
        """Setup datasets for each stage."""
        # Create full dataset
        full_dataset = GapLineDataset(
            crop_size=self.crop_size,
            augment_prob=self.augment_prob,
            junction_gap_min=self.junction_gap_min,
            junction_gap_max=self.junction_gap_max,
            junction_gap_cap=self.junction_gap_cap,
            corner_gap_min=self.corner_gap_min,
            corner_gap_max=self.corner_gap_max,
            corner_gap_cap=self.corner_gap_cap,
            random_gap_min=self.random_gap_min,
            random_gap_max=self.random_gap_max,
            deduplicate_points=self.deduplicate_points,
            min_point_distance=self.min_point_distance,
            gap_length_min=self.gap_length_min,
            gap_length_max=self.gap_length_max,
            gap_width=self.gap_width,
            min_gap_distance=self.min_gap_distance,
            brush_augment_prob=self.brush_augment_prob,
            speckle_prob=self.speckle_prob,
            line_focal_distance_threshold=self.line_focal_distance_threshold,
            udf_max_dist=self.udf_max_dist,
        )
        
        # Split into train and val
        import torch
        dataset_size = len(full_dataset)
        train_size = dataset_size - 1000
        val_size = 1000
        
        print(f"Dataset size: {dataset_size} images")
        print(f"  Training: {train_size} images")
        print(f"  Validation: {val_size} images")
        
        # Use random split with fixed seed for reproducibility
        train_dataset, val_dataset = torch.utils.data.random_split(
            full_dataset, 
            [train_size, val_size],
            generator=torch.Generator().manual_seed(42)
        )
        
        self.train_dataset = train_dataset
        self.val_dataset = val_dataset
        # Disable augmentation for validation but keep gaps enabled
        self.val_dataset.dataset.augment_prob = 0.0
        # Keep gap generation enabled for validation to evaluate gap-closing performance
    
    def train_dataloader(self):
        """Create training dataloader."""
        return DataLoader(
            self.train_dataset,
            batch_size=self.batch_size,
            shuffle=True,
            num_workers=self.num_workers,
            pin_memory=self.pin_memory,
            persistent_workers=self.num_workers > 0,
            drop_last=True,  # Drop last incomplete batch for consistent batch sizes
            collate_fn=collate_fn  # Custom collate for junction_points
        )
    
    def val_dataloader(self):
        """Create validation dataloader."""
        return DataLoader(
            self.val_dataset,
            batch_size=self.batch_size,
            shuffle=False,
            num_workers=self.num_workers,
            pin_memory=self.pin_memory,
            persistent_workers=self.num_workers > 0,
            collate_fn=collate_fn  # Custom collate for junction_points
        )
    
    def test_dataloader(self):
        """Create test dataloader (uses validation set)."""
        return self.val_dataloader()


if __name__ == "__main__":
    # Test the datamodule
    import argparse
    
    parser = argparse.ArgumentParser(description="Test RealLineDataModule")
    parser.add_argument("--batch_size", type=int, default=4, help="Batch size")
    parser.add_argument("--num_workers", type=int, default=2, help="Number of workers")
    args = parser.parse_args()
    
    # Create datamodule
    dm = GapLineDataModule(
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        crop_size=512
    )
    
    # Setup
    dm.prepare_data()
    dm.setup()
    
    # Test training dataloader
    train_loader = dm.train_dataloader()
    print(f"\n=== Training Dataloader ===")
    print(f"Number of batches: {len(train_loader)}")
    
    for batch_idx, batch in enumerate(train_loader):
        print(f"\nBatch {batch_idx}:")
        print(f"  Lines shape: {batch['lines'].shape}, range: [{batch['lines'].min():.3f}, {batch['lines'].max():.3f}]")
        print(f"  Gap lines (raw) shape: {batch['gap_lines_raw'].shape}, range: [{batch['gap_lines_raw'].min():.3f}, {batch['gap_lines_raw'].max():.3f}]")
        print(f"  Gap lines (brush) shape: {batch['gap_lines_brush'].shape}, range: [{batch['gap_lines_brush'].min():.3f}, {batch['gap_lines_brush'].max():.3f}]")
        print(f"  UDF shape: {batch['udf'].shape}, range: [{batch['udf'].min():.3f}, {batch['udf'].max():.3f}]")
        print(f"  Gap focal mask shape: {batch['gap_focal_mask'].shape}, sum: {batch['gap_focal_mask'].sum():.0f}")
        print(f"  Gap weights shape: {batch['gap_weights'].shape}, range: [{batch['gap_weights'].min():.3f}, {batch['gap_weights'].max():.3f}]")
        print(f"  Skeleton focal mask shape: {batch['skeleton_focal_mask'].shape}, sum: {batch['skeleton_focal_mask'].sum():.0f}")
        print(f"  Skeleton weights shape: {batch['skeleton_weights'].shape}, range: [{batch['skeleton_weights'].min():.3f}, {batch['skeleton_weights'].max():.3f}]")
        print(f"  Junction points: {len(batch['junction_points'])} samples in batch")
        if len(batch['junction_points']) > 0:
            sample_jpts = batch['junction_points'][0]
            print(f"    Sample 0: {len(sample_jpts['junction'])} junctions, {len(sample_jpts['corner'])} corners, {len(sample_jpts['endpoint'])} endpoints")
        
        if batch_idx >= 1:  # Only show first 2 batches
            break
    
    # Test validation dataloader
    val_loader = dm.val_dataloader()
    print(f"\n=== Validation Dataloader ===")
    print(f"Number of batches: {len(val_loader)}")
    
    for batch_idx, batch in enumerate(val_loader):
        print(f"\nBatch {batch_idx}:")
        print(f"  Lines shape: {batch['lines'].shape}, range: [{batch['lines'].min():.3f}, {batch['lines'].max():.3f}]")
        print(f"  Gap lines (raw) shape: {batch['gap_lines_raw'].shape}, range: [{batch['gap_lines_raw'].min():.3f}, {batch['gap_lines_raw'].max():.3f}]")
        print(f"  Gap lines (brush) shape: {batch['gap_lines_brush'].shape}, range: [{batch['gap_lines_brush'].min():.3f}, {batch['gap_lines_brush'].max():.3f}]")
        print(f"  UDF shape: {batch['udf'].shape}, range: [{batch['udf'].min():.3f}, {batch['udf'].max():.3f}]")
        print(f"  Gap focal mask shape: {batch['gap_focal_mask'].shape}, sum: {batch['gap_focal_mask'].sum():.0f}")
        print(f"  Gap weights shape: {batch['gap_weights'].shape}, range: [{batch['gap_weights'].min():.3f}, {batch['gap_weights'].max():.3f}]")
        print(f"  Skeleton focal mask shape: {batch['skeleton_focal_mask'].shape}, sum: {batch['skeleton_focal_mask'].sum():.0f}")
        print(f"  Skeleton weights shape: {batch['skeleton_weights'].shape}, range: [{batch['skeleton_weights'].min():.3f}, {batch['skeleton_weights'].max():.3f}]")
        print(f"  Junction points: {len(batch['junction_points'])} samples in batch")
        if len(batch['junction_points']) > 0:
            sample_jpts = batch['junction_points'][0]
            print(f"    Sample 0: {len(sample_jpts['junction'])} junctions, {len(sample_jpts['corner'])} corners, {len(sample_jpts['endpoint'])} endpoints")
        
        if batch_idx >= 1:  # Only show first 2 batches
            break
    
    print("\n✅ DataModule test complete!")

