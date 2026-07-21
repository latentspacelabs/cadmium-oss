from typing import *

import torch
from torch import nn

from transformers.models.llama.configuration_llama import LlamaConfig
from transformers.models.llama.modeling_llama import LlamaModel

from colorize.ant_v1.config_ant_v1 import AnTV1Config
from colorize.common.packing import unpack_sequences
from colorize.common.ops import norm_features

class SVGEncoder(nn.Module):
    
    def __init__(
        self, 
        embed_dim: int,
        output_dim: int,
        num_layers: int,
        max_vec_seq_length: int = 256,
    ):
        super().__init__()
        
        self.output_dim = output_dim
        self.max_vec_seq_length = max_vec_seq_length
        
        self.layers = nn.ModuleList()
        for k in range(num_layers):
            in_dim = 6 if k == 0 else self.output_dim 
            self.layers.append(nn.Linear(in_dim, self.output_dim, bias=False))
            if num_layers > 1:
                self.layers.append(nn.GELU())


        self.llama_config = LlamaConfig(
            hidden_size=embed_dim,
            intermediate_size=embed_dim * 4,
            num_hidden_layers=4,
            num_attention_heads=8,
            attention_dropout=0.1,
            torch_dtype=torch.bfloat16,
            max_position_embeddings=max_vec_seq_length,
        )

        self.llama_model = LlamaModel(self.llama_config)
        self.llama_model.set_input_embeddings(None)

        self.norm_out = nn.LayerNorm(self.output_dim, eps=1e-5)

    def forward(
        self,
        seg_cmd_points: torch.Tensor,  # batch, seg, cmds, 6
        seg_cmd_points_packed: torch.Tensor,  # batch, pack, cmds, 6
        seg_cmd_attn_mask_packed: torch.Tensor,  # batch, pack, cmds, cmds 
    ):
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            _, num_seg, _, _ =  seg_cmd_points.shape
            batch_size, packed_size, num_commands, num_points = seg_cmd_points_packed.shape

            if num_commands > self.max_vec_seq_length:
                print(f"WARNING: found seg with {seg_cmd_points.shape[2]} path commands")

            # remove batch dim
            seg_cmd_feats_packed = seg_cmd_points_packed.view(batch_size * packed_size, num_commands, num_points)
            seg_cmd_attn_mask_packed = seg_cmd_attn_mask_packed.view(batch_size * packed_size, num_commands, num_commands)

            # get per-command embeds
            valid_seg_cmd_mask = torch.all((seg_cmd_feats_packed != -100.0).to(torch.float32), dim=-1)
            for layer in self.layers:
                seg_cmd_feats_packed = layer(seg_cmd_feats_packed)

            # remove pad null seg elements from the pack dim
            nopad_pack_mask = torch.any(valid_seg_cmd_mask,dim=-1)
            nopad_seg_cmd_mask = valid_seg_cmd_mask[nopad_pack_mask]
            nopad_seg_cmd_feats_packed = seg_cmd_feats_packed[nopad_pack_mask]
            nopad_seg_cmd_attn_mask_packed = seg_cmd_attn_mask_packed[nopad_pack_mask]

            all_seg_cmd_feats_packed = torch.zeros_like(seg_cmd_feats_packed).float()

            inverted_nopad_seg_cmd_attn_mask_packed = torch.where(
                nopad_seg_cmd_attn_mask_packed,
                1,
                torch.finfo(nopad_seg_cmd_feats_packed.dtype).min,
            )

            # this returns float32
            seg_cmd_feats_packed = self.llama_model(
                inputs_embeds=nopad_seg_cmd_feats_packed,
                attention_mask=inverted_nopad_seg_cmd_attn_mask_packed.unsqueeze(1),
            ).last_hidden_state

            # unpad
            all_seg_cmd_feats_packed[nopad_pack_mask] = seg_cmd_feats_packed

            # unpack
            flat_seg_cmd_points = seg_cmd_points.view(-1, num_commands, num_points)
            seg_cmd_feats_unpacked = unpack_sequences(
                packed_tensor=seg_cmd_feats_packed,
                valid_packed_tensor_mask=nopad_seg_cmd_mask,
                original_tensor=flat_seg_cmd_points,
                padding_value=0
            ).view(batch_size, num_seg, num_commands, -1)

            # TODO: better way to aggregate?
            num_valid_commands_per_seg = torch.sum(torch.all(seg_cmd_points != -100, dim=-1), dim=-1, keepdim=True)
            seg_cmd_feats = seg_cmd_feats_unpacked.sum(dim=2) / (num_valid_commands_per_seg + 1e-6)

            # permute to (batch x num_segs x out_dim
            seg_cmd_feats_norm = self.norm_out(seg_cmd_feats)

        if self.training:
            dropout_mask = torch.rand(seg_cmd_feats_norm.size(0), seg_cmd_feats_norm.size(1), device=seg_cmd_feats_norm.device) < 0.1
            seg_cmd_feats_norm = seg_cmd_feats_norm * (~dropout_mask).unsqueeze(-1).float()

        return seg_cmd_feats_norm.to(torch.float32)

