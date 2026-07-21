from typing import *

import torch
import torch.nn as nn


class AttentionalGNN(torch.nn.Module):

    def __init__(
        self,
        feature_dim: int,
        intermediate_dim: int,
        gnn_layer_type_list: list,
        num_heads: int,
    ):
        super().__init__()
        self.feature_dim = feature_dim
        self.num_heads = num_heads
        self.gnn_layer_type_list = gnn_layer_type_list

        self.layer_list = nn.ModuleList([
            nn.TransformerDecoderLayer(
                d_model=feature_dim,
                nhead=self.num_heads,
                dim_feedforward=intermediate_dim,
                batch_first=True,
                # norm_first=True,
            )
            for _ in gnn_layer_type_list
        ])

    def forward(
        self,
        ref_feat: torch.Tensor, # N x S x F
        target_feat: torch.Tensor,  # N x Z x F
        ref_mask: torch.Tensor,
        target_mask: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        
        for layer, layer_type in zip(self.layer_list, self.gnn_layer_type_list):
            if layer_type == 'cross':
                ref_delta = layer(
                    tgt=ref_feat,
                    memory=target_feat,
                    tgt_key_padding_mask=ref_mask,
                    memory_key_padding_mask=target_mask,
                )
                target_delta = layer(
                    tgt=target_feat,
                    memory=ref_feat,
                    tgt_key_padding_mask=target_mask,
                    memory_key_padding_mask=ref_mask,
                )
            elif layer_type == 'self':
                ref_delta = layer(
                    tgt=ref_feat,
                    memory=ref_feat,
                    tgt_key_padding_mask=ref_mask,
                    memory_key_padding_mask=ref_mask,
                )
                target_delta = layer(
                    tgt=target_feat,
                    memory=target_feat,
                    tgt_key_padding_mask=target_mask,
                    memory_key_padding_mask=target_mask,
                )
            else:
                raise ValueError(
                    '`layer_type` variable should be either '
                    f'"self" or "cross" but {layer_type} was '
                    'found.')
                
            ref_feat = ref_feat + ref_delta
            target_feat = target_feat + target_delta

        return ref_feat, target_feat


class SuperGlue(torch.nn.Module):

    def __init__(
        self,
        feature_dim: int,
        intermediate_dim: int,
        gnn_layer_type_list: list,
        num_heads: int,
        **kwargs,
    ):
        super().__init__()

        self.gnn = AttentionalGNN(
            feature_dim=feature_dim,
            gnn_layer_type_list=gnn_layer_type_list,
            num_heads=num_heads,
            intermediate_dim=intermediate_dim,
        )
        # TODO: should this be siamese or separate?
        self.final_proj = nn.Sequential(
            nn.Linear(feature_dim, feature_dim),
        )

    def forward(
        self,
        ref_feat: torch.Tensor,
        target_feat: torch.Tensor,
        ref_mask: torch.Tensor,
        target_mask: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):

            # this returns float32
            ref_feat, target_feat = self.gnn(ref_feat, target_feat, ref_mask, target_mask)

            ref_feat = self.final_proj(ref_feat)
            target_feat = self.final_proj(target_feat)

        ref_feat = ref_feat.to(torch.float32)
        target_feat = target_feat.to(torch.float32)

        return ref_feat, target_feat
