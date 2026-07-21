from typing import *

import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision.transforms.functional as TF
from torch_scatter import scatter as super_pixel_pooling

from colorize.nn.unet import UNet
from colorize.common.image import compute_sdf, compute_sdf_cupy
from colorize.common.ops import rgba_to_rgb_torch


class PooledImageEncoder(torch.nn.Module):

    def __init__(
        self,
        out_channels: int,
        max_segments: int,
    ):
        super().__init__()

        self.unet = UNet(
            out_channels=out_channels,
        )

        self.final_out_proj = nn.Sequential(
            nn.Linear(out_channels, out_channels),
            nn.GELU(),
            nn.Linear(out_channels, out_channels),
            nn.LayerNorm(out_channels, eps=1e-5),
        )

    def forward(
        self,
        seg: torch.Tensor,
        line: torch.Tensor,
        padding_mask: torch.Tensor,
    ):
        with torch.no_grad():
            sdf = compute_sdf_cupy(rgba_to_rgb_torch(line), binarize=True)

        # cpu version
        # sdf = compute_sdf(line.cpu().numpy(), binarize=True)
        # sdf = torch.from_numpy(sdf).to(line.device).to(color.dtype)

        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            h, w = line.size()[-2:]

            x_lowres, mid_feats = self.unet(
                line=line,
                sdf=sdf,
            )

            # convert padding elements to one greater than the largest number of segs in the batch
            # we can't simply take the max value in the seg map because sometimes the last seg
            # can get removed in resizing
            pooled_pad_idx = padding_mask.shape[1]
            seg = torch.where(seg != -100, seg, pooled_pad_idx)
        
        pooled_out = self.pool(x_lowres, seg, pooled_pad_idx)

        assert pooled_out.shape[2] == padding_mask.shape[1]

        if self.training:
            dropout_mask = torch.rand(pooled_out.size(0), pooled_out.size(1), device=pooled_out.device) < 0.1
            pooled_out = pooled_out * (~dropout_mask).unsqueeze(-1).float()

        final_out = self.final_out_proj(pooled_out.permute(0, 2, 1))

        return final_out, mid_feats
    
    def pool(
        self,
        x: torch.Tensor,
        seg: torch.Tensor,
        pooled_pad_idx: int,
    ):
        # mean pooling is much slower with float16
        # max is around the same time with float16 but no reduction in memory
        x = x.float()
        seg_resized = TF.resize(seg, (x.shape[2], x.shape[3]), interpolation=TF.InterpolationMode.NEAREST_EXACT) 
        n, c, nh, nw = x.size()

        pooled = super_pixel_pooling(
            src=x.view(n, c, -1),
            index=seg_resized.view(n, 1, -1).long(),
            reduce="mean",
            dim_size=pooled_pad_idx + 1
        )[:, :, :-1]
        return pooled

