from typing import *

from kornia import color
import torch
import torch.nn as nn


def rgba_to_lab(rgba: torch.Tensor) -> torch.Tensor:
    rgb = rgba[..., :3] / 256
    alpha = rgba[..., 3]

    lab_image = color.rgb_to_lab(rgb.permute(0, 2, 1).unsqueeze(-1))  # N x 3 x S x 1
    lab = lab_image.squeeze(-1).permute(0, 2, 1)  # N x S x 3
    
    return torch.stack([
        lab[:, :, 0],
        lab[:, :, 1] + 128,
        lab[:, :, 2] + 128,
        alpha,
    ], dim=-1).long()


class ColorEmbedding(torch.nn.Module):

    def __init__(
        self,
        embed_dim: int,
    ):
        super().__init__()

        self.l_embed = nn.Embedding(102, embed_dim // 4, padding_idx=101)
        self.a_embed = nn.Embedding(257, embed_dim // 4, padding_idx=256)
        self.b_embed = nn.Embedding(257, embed_dim // 4, padding_idx=256)
        self.alpha_embed = nn.Embedding(257, embed_dim // 4, padding_idx=256)

        self.concat_proj = torch.nn.Linear(
            in_features=embed_dim,
            out_features=embed_dim,
        )

    def __call__(
        self,
        colors: torch.LongTensor, # N x S x 4
        color_prompt_mask: torch.BoolTensor,  # N x S
    ) -> torch.FloatTensor:
        color_prompt_mask = color_prompt_mask.unsqueeze(-1).expand_as(colors)

        laba_colors = rgba_to_lab(colors)
        # print("LAB MIN: ", laba_colors[color_mask].reshape(-1, 4).min(dim=0)[0])
        # print("LAB MAX: ", laba_colors[color_mask].reshape(-1, 4).max(dim=0)[0])

        null_color = torch.tensor([101, 256, 256, 256], device=colors.device).long()

        # -100 colors get the null embed, which could mean padding or masked color
        laba_colors = torch.where(
            color_prompt_mask,
            laba_colors,
            null_color.unsqueeze(0).unsqueeze(1).expand_as(laba_colors),
        )

        l_embeds = self.l_embed(laba_colors[:, :, 0])
        a_embeds = self.a_embed(laba_colors[:, :, 1])
        b_embeds = self.b_embed(laba_colors[:, :, 2])
        alpha_embeds = self.alpha_embed(laba_colors[:, :, 3])

        rgba_embeds = torch.concat([
            l_embeds,
            a_embeds,
            b_embeds,
            alpha_embeds,
        ], dim=2)
        rgba_embeds = self.concat_proj(rgba_embeds)

        return rgba_embeds  # N x S x F
 