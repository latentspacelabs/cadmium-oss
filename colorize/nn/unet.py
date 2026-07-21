from typing import *
from einops import rearrange

import torch
from torch import nn
from torch.nn import init

from colorize.common.ops import rgba_to_rgb_torch

class conv_block(nn.Module):
    def __init__(self, ch_in, ch_out):
        super(conv_block, self).__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(ch_in, ch_out, kernel_size=3, stride=1, padding=1, bias=True),
            nn.InstanceNorm2d(ch_out),
            nn.GELU(),
            nn.Conv2d(ch_out, ch_out, kernel_size=3, stride=1, padding=1, bias=True),
            nn.InstanceNorm2d(ch_out),
            nn.GELU(),
        )

    def forward(self, x):
        x = self.conv(x)
        return x


class up_conv(nn.Module):
    def __init__(self, ch_in, ch_out):
        super(up_conv, self).__init__()
        self.up = nn.Sequential(
            nn.Upsample(scale_factor=2),
            nn.Conv2d(ch_in, ch_out, kernel_size=3, stride=1, padding=1, bias=True),
            nn.InstanceNorm2d(ch_out),
            nn.GELU(),
        )

    def forward(self, x):
        x = self.up(x)
        return x


class InputFusion(nn.Module):

    def __init__(
        self, 
        out_channels: int,
        kernel_size: int = 3,
        stride: int = 1,
        padding: int = 1,
        bias: bool = False,
    ):
        super().__init__()

        self.padding = padding

        self.line_conv = nn.Conv2d(4, out_channels, kernel_size, stride, padding=self.padding, bias=bias)
        self.sdf_conv = nn.Conv2d(1, out_channels, kernel_size, stride, padding=self.padding, bias=bias)

        out_conv_in_channels = out_channels * 2

        self.out_conv = nn.Sequential(
            nn.InstanceNorm2d(out_conv_in_channels),
            nn.GELU(),
            nn.Conv2d(out_conv_in_channels, out_channels, kernel_size=3, stride=1, padding=1, bias=True),
            nn.InstanceNorm2d(out_channels),
            nn.GELU(),
        )

    def forward(
        self,
        line: torch.Tensor,
        sdf: torch.Tensor,
    ):
        line_fea = self.line_conv(line)
        sdf_fea = self.sdf_conv(sdf)
        x_out = torch.cat((line_fea, sdf_fea), dim=1)

        x_out = self.out_conv(x_out)

        return x_out
    

class TransformerBlock(nn.Module):
    def __init__(
        self,
        dim: int,
        heads: int = 8,
        mlp_ratio: float = 4.0,
    ):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.attn = nn.MultiheadAttention(embed_dim=dim, num_heads=heads, batch_first=True)
        self.norm2 = nn.LayerNorm(dim)
        self.mlp = nn.Sequential(
            nn.Linear(dim, int(dim * mlp_ratio)),
            nn.GELU(),
            nn.Linear(int(dim * mlp_ratio), dim)
        )

    def forward(self, x):
        x = x + self.attn(self.norm1(x), self.norm1(x), self.norm1(x))[0]
        x = x + self.mlp(self.norm2(x))
        return x
    

class UNet(nn.Module):

    def __init__(
        self, 
        out_channels: int = 256,
    ):
        super().__init__()

        # self.distill_dift = DistillDIFT()

        self.maxpool = nn.MaxPool2d(kernel_size=2, stride=2)

        self.input_fusion = InputFusion(out_channels=32)

        # self.Conv1 = conv_block(ch_in=7, ch_out=32)
        self.conv2 = conv_block(ch_in=32, ch_out=64)
        self.conv3 = conv_block(ch_in=64, ch_out=128)
        self.conv4 = conv_block(ch_in=128, ch_out=256)
        self.conv5 = conv_block(ch_in=256, ch_out=512)
        self.conv6 = conv_block(ch_in=512, ch_out=768)

        self.middle_blocks = nn.ModuleList([
            TransformerBlock(dim=768) for _ in range(4)
        ])

        self.up6 = up_conv(ch_in=768, ch_out=512)
        self.up_conv6 = conv_block(ch_in=1024, ch_out=512)

        self.up5 = up_conv(ch_in=512, ch_out=256)
        self.up_conv5 = conv_block(ch_in=512, ch_out=256)

        self.up4 = up_conv(ch_in=256, ch_out=128)
        self.up_conv4 = conv_block(ch_in=256, ch_out=128)

        self.up3 = up_conv(ch_in=128, ch_out=64)
        self.up_conv3 = conv_block(ch_in=128, ch_out=64)

        # TODO: this embed dim could be increased 
        self.conv3_1x1 = nn.Sequential(
            nn.Conv2d(448, out_channels, kernel_size=1, stride=1, padding=0),
            nn.InstanceNorm2d(out_channels),
            nn.GELU(),
            nn.Conv2d(out_channels, out_channels, kernel_size=1, stride=1, padding=0),
            nn.InstanceNorm2d(out_channels),
        )

        self.apply(self._init_weights)

    def _init_weights(self, m):
        init_type = "normal"
        gain = 0.02
        classname = m.__class__.__name__
        if hasattr(m, "weight") and (classname.find("Conv") != -1 or classname.find("Linear") != -1):
            if init_type == "normal":
                init.normal_(m.weight.data, 0.0, gain)
            elif init_type == "xavier":
                init.xavier_normal_(m.weight.data, gain=gain)
            elif init_type == "kaiming":
                init.kaiming_normal_(m.weight.data, a=0, mode="fan_in")
            elif init_type == "orthogonal":
                init.orthogonal_(m.weight.data, gain=gain)
            else:
                raise NotImplementedError("initialization method [%s] is not implemented" % init_type)
            if hasattr(m, "bias") and m.bias is not None:
                init.constant_(m.bias.data, 0.0)
        elif classname.find("BatchNorm2d") != -1:
            init.normal_(m.weight.data, 1.0, gain)
            init.constant_(m.bias.data, 0.0)

    def forward(
        self,
        line: torch.Tensor,
        sdf: torch.Tensor,
    ):
        # To ensure the avg of the offset is 0)
        line = (line - 0.5) * 2
        sdf = (sdf - 0.5) * 2

        # encoding path
        x1 = self.input_fusion(
            line=line,
            sdf=sdf,
        )

        x2 = self.maxpool(x1)
        x2 = self.conv2(x2)   # (B, 64, 512, 512)

        x3 = self.maxpool(x2) 
        x3 = self.conv3(x3)   # (B, 128, 256, 256)

        x4 = self.maxpool(x3) 
        x4 = self.conv4(x4)   # (B, 256, 128, 128)

        x5 = self.maxpool(x4) 
        x5 = self.conv5(x5)   # (B, 512, 64, 64)

        x6 = self.maxpool(x5) 
        x6 = self.conv6(x6)   # (B, 768, 32, 32)

        h, w = x6.shape[2], x6.shape[3]
        mid_feats = rearrange(x6, 'b c h w -> b (h w) c')
        for block in self.middle_blocks:
            mid_feats = block(mid_feats)
        mid_feats = rearrange(mid_feats, 'b (h w) c -> b c h w', h=h, w=w)

        d6 = self.up6(mid_feats)  # (B, 512, 64, 64)
        d6 = torch.cat((x5, d6), dim=1)  # (B, 1024, 64, 64)
        d6 = self.up_conv6(d6)  # (B, 512, 64, 64)

        d5 = self.up5(d6)  # (B, 256, 128, 128)
        d5 = torch.cat((x4, d5), dim=1)  # (B, 512, 128, 128)
        d5 = self.up_conv5(d5)  # (B, 256, 128, 128)
        d5_big = nn.Upsample(scale_factor=4)(d5)  # (B, 256, 512, 512)

        d4 = self.up4(d5)  # (B, 128, 256, 256)
        d4 = torch.cat((x3, d4), dim=1)  # (B, 256, 256, 256)
        d4 = self.up_conv4(d4)  # (B, 128, 256, 256)
        d4_big = nn.Upsample(scale_factor=2)(d4)  # (B, 128, 512, 512)

        d3 = self.up3(d4)  # (B, 64, 512, 512)
        d3 = torch.cat((x2, d3), dim=1)  # (B, 128, 512, 512)
        d3 = self.up_conv3(d3)  # (B, 64, 512, 512)

        d345_big = torch.cat((d3, d4_big, d5_big), dim=1)  # (B, 384, 512, 512)

        d3_out = self.conv3_1x1(d345_big)

        return d3_out, mid_feats
