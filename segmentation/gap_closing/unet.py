import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class DoubleConv(nn.Module):
    """Classic double convolution block used in U-Net."""
    
    def __init__(self, in_channels: int, out_channels: int, dropout: float = 0.0):
        super().__init__()
        layers = [
            nn.Conv2d(in_channels, out_channels, 3, padding=1),
            nn.ReLU(inplace=True),
        ]
        if dropout > 0:
            layers.append(nn.Dropout2d(dropout))
        layers.extend([
            nn.Conv2d(out_channels, out_channels, 3, padding=1),
            nn.ReLU(inplace=True),
        ])
        if dropout > 0:
            layers.append(nn.Dropout2d(dropout))
        self.double_conv = nn.Sequential(*layers)
    
    def forward(self, x):
        return self.double_conv(x)


class Down(nn.Module):
    """Downscaling with maxpool then double conv."""
    
    def __init__(self, in_channels: int, out_channels: int, dropout: float = 0.0):
        super().__init__()
        self.maxpool_conv = nn.Sequential(
            nn.MaxPool2d(2),
            DoubleConv(in_channels, out_channels, dropout)
        )
    
    def forward(self, x):
        return self.maxpool_conv(x)


class Up(nn.Module):
    """Upscaling then double conv."""
    
    def __init__(self, in_channels: int, out_channels: int, dropout: float = 0.0):
        super().__init__()
        self.up = nn.ConvTranspose2d(in_channels, in_channels // 2, 2, stride=2)
        self.conv = DoubleConv(in_channels, out_channels, dropout)
    
    def forward(self, x1, x2):
        x1 = self.up(x1)
        
        # Handle size differences
        diffY = x2.size()[2] - x1.size()[2]
        diffX = x2.size()[3] - x1.size()[3]
        
        x1 = F.pad(x1, [diffX // 2, diffX - diffX // 2,
                        diffY // 2, diffY - diffY // 2])
        
        x = torch.cat([x2, x1], dim=1)
        return self.conv(x)


class ClassicUNet(nn.Module):
    """
    Unified Classic U-Net architecture with parameterized resolution.
    
    Automatically determines the number of downsampling levels based on image size:
    - 128x128: 3 levels (128→64→32→16→8)
    - 256x256: 4 levels (256→128→64→32→16→8)  
    - 512x512: 5 levels (512→256→128→64→32→16→8)
    """
    
    def __init__(
        self,
        input_channels: int = 1,
        base_channels: int = 64,
        image_size: int = 256,
        dropout: float = 0.0,
    ):
        super().__init__()
        
        # Calculate number of downsampling levels based on image size
        # We want to downsample to approximately 4-8 pixel resolution at the bottleneck
        self.num_levels = max(3, min(5, int(math.log2(image_size)) - 2))
        
        # Store for reference
        self.image_size = image_size
        self.dropout = dropout
        
        # Initial convolution
        self.inc = DoubleConv(input_channels, base_channels, dropout)
        
        # Build encoder and track actual channel counts
        self.down_layers = nn.ModuleList()
        self.encoder_channels = [base_channels]  # Track actual channels at each level
        
        in_ch = base_channels
        for i in range(self.num_levels):
            # Calculate the target channels but cap at 32x base_channels
            target_ch = base_channels * (2 ** (i + 1))
            out_ch = min(target_ch, base_channels * 32)  # Cap at 32x base_channels
            self.down_layers.append(Down(in_ch, out_ch, dropout))
            self.encoder_channels.append(out_ch)
            in_ch = out_ch
        
        # Build decoder using actual encoder channel counts
        self.up_layers = nn.ModuleList()
        for i in range(self.num_levels):
            # Channels from deeper layer (will be halved by transpose conv)
            deeper_ch = self.encoder_channels[self.num_levels - i]
            # Skip connection channels from encoder
            skip_ch = self.encoder_channels[self.num_levels - i - 1]
            # Total input after concat: (deeper_ch // 2) + skip_ch
            in_ch = (deeper_ch // 2) + skip_ch
            out_ch = skip_ch
            self.up_layers.append(Up(in_ch, out_ch, dropout))
        
        # Output heads
        self.udf_output = nn.Conv2d(base_channels, 1, 1)
        
    def forward(self, x):
        # Store encoder features for skip connections
        encoder_features = []
        
        # Initial convolution
        x_enc = self.inc(x)
        encoder_features.append(x_enc)
        
        # Encoder path
        for down_layer in self.down_layers:
            x_enc = down_layer(x_enc)
            encoder_features.append(x_enc)
        
        # Decoder path (start from deepest feature)
        x_dec = encoder_features[-1]  # Bottleneck features
        
        # Upsampling with skip connections
        for i, up_layer in enumerate(self.up_layers):
            skip_idx = self.num_levels - i - 1  # Index for skip connection (corrected)
            skip_features = encoder_features[skip_idx]
            x_dec = up_layer(x_dec, skip_features)
        
        # UDF output (normalized distance to nearest line in [0, 1])
        udf_output = self.udf_output(x_dec)
        udf_output = F.softplus(udf_output, beta=20, threshold=20)  # Ensures non-negative output
        
        return udf_output


def count_parameters(model):
    """Count the number of trainable parameters in a model."""
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
