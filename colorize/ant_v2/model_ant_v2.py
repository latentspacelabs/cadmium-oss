from typing import *
from dataclasses import dataclass

import torch
import torch.nn as nn
from transformers.modeling_utils import PreTrainedModel
from transformers.modeling_outputs import ModelOutput
from transformers.models.llama.configuration_llama import LlamaConfig
from transformers.models.llama.modeling_llama import LlamaModel

from colorize.common.ops import masked_softmax_2d
from colorize.ant_v2.config_ant_v2 import AnTV2Config
from colorize.ant_v1.config_ant_v1 import AnTV1Config
from colorize.ant_v1.model_ant_v1 import AnTV1Model
from colorize.nn.color_embedding import ColorEmbedding
from colorize.nn.palette_embedding import PaletteEmbedding
from colorize.common.ops import make_4d_bidirectional_attention_mask

    
class AnTV2PreTrainedModel(PreTrainedModel):
    
    config_class = AnTV2Config
    base_model_prefix = "model"


@dataclass
class AnTV2Output(ModelOutput):

    target_color_id_predictions: Optional[torch.FloatTensor] = None
    target_color_logits: Optional[torch.FloatTensor] = None

    # training only
    loss: Optional[torch.FloatTensor] = None
    

class AnTV2Model(AnTV2PreTrainedModel):

    def __init__(
        self,
        config: AnTV2Config,
    ):
        super().__init__(config)
        self.config = config

        model_config = AnTV1Config()
        self.ant_v1: AnTV1Model = AnTV1Model(model_config)
        self.ant_v1.img_feat_extractor.requires_grad_(False)
        self.ant_v1.svg_feat_extractor.requires_grad_(False)

        # color/palette/frame embeddings
        self.color_embedding = ColorEmbedding(
            embed_dim=config.color_embeds_feature_dim
        )
        self.palette_idx_embedding = PaletteEmbedding(
            embed_dim=config.palette_idx_embedding_dim,
            max_palette_size=config.max_palette_size,
        )
        self.frame_embedding = nn.Embedding(
            num_embeddings=2,  # ref + target
            embedding_dim=config.frame_embeds_feature_dim,
        )

        # seg embed fusion proj
        seg_color_frame_proj_input_dim = (
            self.ant_v1.config.image_embed_output_dim + \
            self.ant_v1.config.svg_output_embed_dim + \
            config.frame_embeds_feature_dim + \
            config.color_embeds_feature_dim + \
            config.palette_idx_embedding_dim
        )
        self.seg_color_frame_fusion_proj = nn.Sequential(
            nn.Linear(
                in_features=seg_color_frame_proj_input_dim,
                out_features=config.decoder_embed_dim,
            ),
            nn.GELU(),
            nn.Linear(
                in_features=config.decoder_embed_dim,
                out_features=config.decoder_embed_dim,
            ),
            nn.LayerNorm(config.decoder_embed_dim, eps=1e-5),
        )

        # bert decoder
        llama_config = LlamaConfig(
            hidden_size=config.decoder_embed_dim,
            intermediate_size=config.decoder_embed_dim * 4,
            num_hidden_layers=config.decoder_num_layers,
            num_attention_heads=config.decoder_num_heads,
            max_position_embeddings=config.decoder_max_position_embeddings,
            torch_dtype=torch.bfloat16,
            attention_dropout=0.1,
        ) 
        self.decoder = LlamaModel(llama_config)

        # lm head
        self.max_palette_size = config.max_palette_size
        self.lm_head = nn.Linear(config.decoder_embed_dim, config.max_palette_size)

        self.post_init()

    def forward(
        self,
        ref_colors: torch.LongTensor,  # N x S x 4
        ref_seg_image: torch.LongTensor,  # N x 1 x H x W
        ref_seg_svg: torch.FloatTensor,  # N x S x C x 6
        ref_seg_svg_packed: torch.FloatTensor,  # P x C x 6
        ref_seg_svg_attn_mask_packed: torch.BoolTensor,  # P x C x C
        ref_line_image: torch.FloatTensor,  # N x 4 x H x W
        target_colors: torch.LongTensor,  # N x Z x 4 (in inference some things we want to predict will be -100)
        target_seg_image: torch.LongTensor,  # N x 1 x H x W
        target_seg_svg: torch.FloatTensor, # N x Z x C x 6
        target_seg_svg_packed: torch.FloatTensor, # P x C x 6
        target_seg_svg_attn_mask_packed: torch.BoolTensor ,  # P x C x C
        target_line_image: torch.FloatTensor,  # N x 4 x H x W
        ref_color_ids: torch.LongTensor,  # N x S (-100 for padding or unknown)
        target_color_ids: torch.LongTensor,  # N x Z (in inference some things we want to predict will be -100)
        **kwargs,
    ) -> AnTV2Output:
        # mask for padding segments 
        ref_seg_padding_mask = torch.all(ref_seg_svg == -100, dim=(2,3))
        target_seg_padding_mask = torch.all(target_seg_svg == -100, dim=(2,3))

        # image, svg, fusion
        ref_fused_embeds, target_fused_embeds = self._create_inputs_embeds(
            ref_seg_image=ref_seg_image,
            ref_line_image=ref_line_image,
            ref_colors=ref_colors,
            ref_color_ids=ref_color_ids,
            ref_seg_svg=ref_seg_svg,
            ref_seg_svg_packed=ref_seg_svg_packed,
            ref_seg_svg_attn_mask_packed=ref_seg_svg_attn_mask_packed,
            ref_seg_padding_mask=ref_seg_padding_mask,
            target_seg_image=target_seg_image,
            target_line_image=target_line_image,
            target_colors=target_colors,
            target_color_ids=target_color_ids,
            target_seg_svg=target_seg_svg,
            target_seg_svg_packed=target_seg_svg_packed,
            target_seg_svg_attn_mask_packed=target_seg_svg_attn_mask_packed,
            target_seg_padding_mask=target_seg_padding_mask,
        ) # N x S x F, N x Z x F

        # remove padding, pack ref/target into a single tensor
        packed_embeds, packed_attention_mask = self._pack_inputs(
            ref_inputs_embeds=ref_fused_embeds,
            ref_seg_padding_mask=ref_seg_padding_mask,
            target_inputs_embeds=target_fused_embeds,
            target_seg_padding_mask=target_seg_padding_mask,    
        ) # N x SZ x F, N x SZ x F

        # BERT decoder
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            # N x 1 x output x output
            packed_bidirectional_attention_mask = make_4d_bidirectional_attention_mask(
                inputs_embeds=packed_embeds,
                inputs_attention_mask=packed_attention_mask,
            )
            # N x output x F
            decoder_outputs = self.decoder(
                inputs_embeds=packed_embeds,
                attention_mask=packed_bidirectional_attention_mask,
            )[0]

            # N x output x U
            color_logits = self.lm_head(decoder_outputs)

        color_logits = color_logits.to(torch.float32)

        # we only care about the target color logits now
        target_color_logits, pred_target_color_ids = self._unpack_outputs(
            color_logits=color_logits,
            ref_seg_padding_mask=ref_seg_padding_mask,
            target_seg_padding_mask=target_seg_padding_mask,
        )

        # inference
        if torch.is_inference_mode_enabled():
            return AnTV2Output(
                target_color_logits=target_color_logits,
                target_color_id_predictions=pred_target_color_ids,
            )
        else: # train/eval
            flat_color_logits = target_color_logits.contiguous().reshape(-1, target_color_logits.shape[-1])
            flat_labels = target_color_ids.contiguous().reshape(-1).long()
            
            loss = torch.nn.functional.cross_entropy(
                input=flat_color_logits,
                target=flat_labels,
                label_smoothing=0.1,
                reduction="mean"
            )

            if self.training:
                return AnTV2Output(
                    loss=loss,
                )
            else:  # eval
                return AnTV2Output(
                    target_color_id_predictions=pred_target_color_ids,
                    target_color_logits=target_color_logits,
                    loss=loss,
                )

    
    def _create_inputs_embeds(
        self,
        ref_seg_image: torch.LongTensor,  # N x 1 x H x W
        ref_line_image: torch.FloatTensor,  # N x 4 x H x W
        ref_colors: torch.LongTensor,  # N x S x 4
        ref_color_ids: torch.LongTensor,  # N x S (-100 for padding or unknown)
        ref_seg_svg: torch.FloatTensor,  # N x S x C x 6
        ref_seg_svg_packed: torch.FloatTensor,  # P x C x 6
        ref_seg_svg_attn_mask_packed: torch.BoolTensor,  # P x C x C
        ref_seg_padding_mask: torch.BoolTensor,  # N x S
        target_seg_image: torch.LongTensor,  # N x 1 x H x W
        target_line_image: torch.FloatTensor,  # N x 4 x H x W
        target_colors: torch.LongTensor,  # N x Z x 4
        target_color_ids: torch.LongTensor,  # N x Z (in inference some things we want to predict will be -100)
        target_seg_svg: torch.FloatTensor, # N x Z x C x 6
        target_seg_svg_packed: torch.FloatTensor, # P x C x 6
        target_seg_svg_attn_mask_packed: torch.BoolTensor ,  # P x C x C
        target_seg_padding_mask: torch.BoolTensor,  # N x Z
    ) -> Tuple[torch.FloatTensor, torch.FloatTensor]:
        with torch.no_grad():
            image_ref_feats, _, image_target_feats, _ = self.ant_v1._encode_image_features(
                ref_seg_image=ref_seg_image,
                ref_line_image=ref_line_image,
                ref_seg_padding_mask=ref_seg_padding_mask,
                target_seg_image=target_seg_image,
                target_line_image=target_line_image,
                target_seg_padding_mask=target_seg_padding_mask,
            )

            svg_ref_feats, svg_target_feats = self.ant_v1._encode_svg_features(
                ref_seg_svg=ref_seg_svg,
                ref_seg_svg_packed=ref_seg_svg_packed,
                ref_seg_svg_attn_mask_packed=ref_seg_svg_attn_mask_packed,
                target_seg_svg=target_seg_svg,
                target_seg_svg_packed=target_seg_svg_packed,
                target_seg_svg_attn_mask_packed=target_seg_svg_attn_mask_packed,
            )

        # N x S x F
        fused_ref_feats = self._combine_color_frame_palette_embeds(
            color_ids=ref_color_ids,
            image_embeds=image_ref_feats,
            svg_embeds=svg_ref_feats,
            colors=ref_colors,
            frame_idx=0,
            is_ref=True,
        )

        # N x Z x F
        fused_target_feats = self._combine_color_frame_palette_embeds(
            color_ids=target_color_ids,
            image_embeds=image_target_feats,
            svg_embeds=svg_target_feats,
            colors=target_colors,
            frame_idx=1,
            is_ref=False,
        )

        if self.training:
            ref_dropout_mask = torch.rand_like(fused_ref_feats) < 0.1
            target_dropout_mask = torch.rand_like(fused_target_feats) < 0.1

            fused_ref_feats = fused_ref_feats.masked_fill(ref_dropout_mask, 0.0)
            fused_target_feats = fused_target_feats.masked_fill(target_dropout_mask, 0.0)

        return fused_ref_feats, fused_target_feats

    def _combine_color_frame_palette_embeds(
        self,
        color_ids: torch.LongTensor,
        image_embeds: torch.FloatTensor,  # N x S x F
        svg_embeds: torch.FloatTensor,  # N x S x F
        colors: torch.LongTensor,
        frame_idx: int,
        is_ref: bool,
    ) -> torch.FloatTensor:
        if is_ref:
            color_prompt_mask = color_ids != -100 # not unknown colors
        else:
            color_prompt_mask = torch.zeros_like(color_ids, dtype=torch.bool)

        palette_idx_embeds = self.palette_idx_embedding(
            color_ids=color_ids,
            color_prompt_mask=color_prompt_mask,
        )  # N x S x F

        # add color embeddings for indices that are True in the prompt mask
        color_embeds = self.color_embedding(
            colors=colors,
            color_prompt_mask=color_prompt_mask,
        )  # N x S x F

        frame_indices = torch.LongTensor([frame_idx] * color_embeds.shape[0]).to(color_embeds.device)
        frame_embeds = self.frame_embedding(frame_indices).unsqueeze(1).expand(-1, color_embeds.shape[1], -1) # N x S x F

        # N x S x F
        concat_seg_embeds = torch.concat([
            image_embeds,
            svg_embeds,
            color_embeds,
            frame_embeds,
            palette_idx_embeds,
        ], dim=2)

        fused_seg_embeds = self.seg_color_frame_fusion_proj(concat_seg_embeds)

        return fused_seg_embeds
    
    def _pack_inputs(
        self,
        ref_inputs_embeds: torch.FloatTensor,
        ref_seg_padding_mask: torch.BoolTensor,
        target_inputs_embeds: torch.FloatTensor,
        target_seg_padding_mask: torch.BoolTensor,
    ) -> Tuple[torch.FloatTensor, torch.BoolTensor]:
        batch_size, _, feat_dim= ref_inputs_embeds.size()

        # remove padding segs, but everything else goes in the prompt
        unpad_ref_seg_embeds = [ref_inputs_embeds[i, ~ref_seg_padding_mask[i], :] for i in range(batch_size)]
        unpad_target_seg_embeds = [target_inputs_embeds[i, ~target_seg_padding_mask[i], :] for i in range(batch_size)]

        # combine unpadded ref/target seg embeds
        embeds_combined = [
            torch.cat([ref_seg_embed, target_seg_embed], dim=0)
            for ref_seg_embed, target_seg_embed in 
            zip(unpad_ref_seg_embeds, unpad_target_seg_embeds)
        ]
        
        # pack the sequences into a single tensor (right padded)
        max_len = max(seq.shape[0] for seq in embeds_combined)
        output = torch.full((batch_size, max_len, feat_dim), 0.).to(ref_inputs_embeds.device)  # TODO: pad value?
        attention_mask = torch.zeros((batch_size, max_len), dtype=torch.long).to(ref_inputs_embeds.device)
        for i, seq in enumerate(embeds_combined):
            seq_len = seq.shape[0]
            output[i, :seq_len, :] = seq
            attention_mask[i, :seq_len] = 1
            
        return output, attention_mask.bool()
    
    # inference/eval only
    def _unpack_outputs(
        self,
        color_logits: torch.Tensor,
        ref_seg_padding_mask: torch.BoolTensor,
        target_seg_padding_mask: torch.BoolTensor,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        batch_size = color_logits.shape[0]

        color_id_predictions = torch.argmax(color_logits, dim=-1)
        
        max_num_target_segs = target_seg_padding_mask.shape[1]
        target_color_logits = torch.full((batch_size, max_num_target_segs, color_logits.shape[-1]), 0., device=color_logits.device)
        target_color_ids = torch.full((batch_size, max_num_target_segs), -100, device=color_logits.device)

        for i in range(batch_size):
            num_ref_segs = torch.sum(~ref_seg_padding_mask[i]).item()
            num_target_segs = torch.sum(~target_seg_padding_mask[i]).item()
                
            target_output_indices = torch.where(~target_seg_padding_mask[i])[0]
            target_color_logits[i, target_output_indices] = color_logits[i, num_ref_segs:num_ref_segs + num_target_segs]
            target_color_ids[i, target_output_indices] = color_id_predictions[i, num_ref_segs:num_ref_segs + num_target_segs]

        return target_color_logits, target_color_ids
    
    # train/eval only
    def _mask_softmax_logits(
        self,
        color_logits: torch.FloatTensor,
        ref_color_ids: torch.LongTensor,
    ) -> torch.FloatTensor:
        # softmax only over the colors that are shown in the prompt
        invalid_color_mask = torch.ones(color_logits.shape, device=color_logits.device)
        for i in range(color_logits.shape[0]):
            shown_ref_color_ids = ref_color_ids[i][ref_color_ids[i] != -100]
            invalid_color_mask[i, :, shown_ref_color_ids] = 0.0

        masked_color_logits_softmax = masked_softmax_2d(color_logits, invalid_color_mask, dim=-1)
        return masked_color_logits_softmax
