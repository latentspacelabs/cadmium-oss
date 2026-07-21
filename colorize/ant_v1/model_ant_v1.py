from typing import *
from dataclasses import dataclass

import comet_ml
import torch
import torch.nn as nn
import torch.nn.functional as F
from einops import rearrange
from transformers.modeling_utils import PreTrainedModel
from transformers.utils import ModelOutput
from transformers import LlamaConfig, LlamaModel

from colorize.common.ops import masked_softmax
from colorize.ant_v1.config_ant_v1 import AnTV1Config
from colorize.nn.superglue import SuperGlue
from colorize.nn.svg_encoder import SVGEncoder
from colorize.nn.image_encoder import PooledImageEncoder
from colorize.common.ops import norm_features, make_4d_bidirectional_attention_mask
# from colorize.nn.dift import DistillDIFT

class AnTV1PreTrainedModel(PreTrainedModel):
    
    config_class = AnTV1Config
    base_model_prefix = "model"
    
    
@dataclass
class AnTV1Output(ModelOutput):
    
    target_color_id_predictions: torch.FloatTensor
    
    # training only 
    loss: torch.FloatTensor = None

    
class AnTV1Model(AnTV1PreTrainedModel):
    
    def __init__(self, config: AnTV1Config):
        super().__init__(config)
        self.config = config
        
        self.corr_temperature = config.corr_temperature
        self.max_segments = config.max_segments
        self.cycle_weight = config.cycle_weight
        self.dift_weight = config.dift_weight
        
        self.img_feat_extractor = PooledImageEncoder(
            out_channels=config.image_embed_output_dim,
            max_segments=config.max_segments,
        )

        self.svg_feat_extractor = SVGEncoder(
            embed_dim=config.svg_input_embed_dim,
            output_dim=config.svg_output_embed_dim,
            num_layers=config.svg_num_layers,
        )

        seg_proj_input_dim = config.image_embed_output_dim + config.svg_output_embed_dim
        self.seg_proj = nn.Sequential(
            nn.Linear(
                in_features=seg_proj_input_dim,
                out_features=config.gnn_embed_dim,
            ),
            nn.GELU(),
            nn.Linear(
                in_features=config.gnn_embed_dim,
                out_features=config.gnn_embed_dim,
            ),
            nn.LayerNorm(config.gnn_embed_dim, eps=1e-5)
        )

        fusion_llama_config = LlamaConfig(
            hidden_size=config.fusion_embed_dim,
            intermediate_size=config.fusion_embed_dim * 4,
            num_hidden_layers=config.fusion_num_layers,
            num_attention_heads=config.fusion_num_heads,
            max_position_embeddings=config.max_segments,
            torch_dtype=torch.bfloat16,
            attention_dropout=0.1,
        ) 
        self.fusion_encoder = LlamaModel(fusion_llama_config)
        self.fusion_encoder.set_input_embeddings(None)

        self.gnn = SuperGlue(
            feature_dim=config.gnn_embed_dim,
            intermediate_dim=config.gnn_embed_dim * 4,
            gnn_layer_type_list=config.gnn_layer_type_list,
            num_heads=config.gnn_num_heads,
        )

        # self.dift = PooledDistillDIFT()
        # self.seg_feats_to_dift_proj = nn.Sequential(
        #     nn.Linear(
        #         in_features=config.gnn_feature_dim,
        #         out_features=768,
        #     ),
        #     nn.GELU(),
        #     nn.Linear(
        #         in_features=768,
        #         out_features=768,
        #     ),
        #     nn.LayerNorm(768, eps=1e-5)
        # )
        # self.dift = DistillDIFT()
        # self.seg_feats_to_dift_proj = nn.Linear(
        #     in_features=768,
        #     out_features=768,
        # )

    def forward(
        self,
        ref_color_ids: torch.LongTensor,  # N x S
        ref_seg_image: torch.LongTensor,  # N x 1 x H x W
        ref_seg_svg: torch.FloatTensor,  # N x S x C x 6
        ref_seg_svg_packed: torch.FloatTensor,  # P x C x 6
        ref_seg_svg_attn_mask_packed: torch.BoolTensor,  # P x C x C
        ref_line_image: torch.FloatTensor,  # N x 4 x H x W
        target_seg_image: torch.LongTensor,  # N x 1 x H x W
        target_seg_svg: torch.FloatTensor, # N x Z x C x 6
        target_seg_svg_packed: torch.FloatTensor, # P x C x 6
        target_seg_svg_attn_mask_packed: torch.BoolTensor,  # P x C x C
        target_line_image: torch.FloatTensor,  # N x 4 x H x W
        target_color_ids: Optional[torch.LongTensor] = None,  # N x Z (train/eval only)
        ref_color_image: Optional[torch.FloatTensor] = None,  # N x H x W x 4 (train only)
        target_color_image: Optional[torch.FloatTensor] = None,  # N x H x W x 4 (train only)
        **kwargs,
    ):
        # mask for padding segments 
        ref_seg_padding_mask = torch.all(ref_seg_svg == -100, dim=(2,3))
        target_seg_padding_mask = torch.all(target_seg_svg == -100, dim=(2,3))

        # mask for unknown OR padding segments
        ref_inactive_color_mask = ref_color_ids == -100.0
        if target_color_ids is not None:
            target_inactive_color_mask = target_color_ids == -100.0  # train
        else:
            target_inactive_color_mask = target_seg_padding_mask  # eval

        image_ref_feats, mid_image_ref_feats, image_target_feats, mid_image_target_feats = self._encode_image_features(
            ref_seg_image=ref_seg_image,
            ref_line_image=ref_line_image,
            ref_seg_padding_mask=ref_seg_padding_mask,
            target_seg_image=target_seg_image,
            target_line_image=target_line_image,
            target_seg_padding_mask=target_seg_padding_mask,
        )

        svg_ref_feats, svg_target_feats = self._encode_svg_features(
            ref_seg_svg=ref_seg_svg,
            ref_seg_svg_packed=ref_seg_svg_packed,
            ref_seg_svg_attn_mask_packed=ref_seg_svg_attn_mask_packed,
            target_seg_svg=target_seg_svg,
            target_seg_svg_packed=target_seg_svg_packed,
            target_seg_svg_attn_mask_packed=target_seg_svg_attn_mask_packed,
        )

        fused_ref_feats = self._fuse_features(image_ref_feats, svg_ref_feats, ref_seg_padding_mask)
        fused_target_feats = self._fuse_features(image_target_feats, svg_target_feats, target_seg_padding_mask)

        gnn_ref_feats, gnn_target_feats = self.gnn(
            ref_feat=fused_ref_feats,
            target_feat=fused_target_feats,
            ref_mask=ref_seg_padding_mask,
            target_mask=target_seg_padding_mask,
        ) # N x S x F, N x Z x F

        final_ref_feats = norm_features(gnn_ref_feats.permute(0, 2, 1)) # N x F x S
        final_target_feats = norm_features(gnn_target_feats.permute(0, 2, 1)) # N x F x Z
        
        # fwd color propagation 
        fwd_sim_mat = torch.einsum('bcs,bcz->bsz', final_ref_feats, final_target_feats) / self.corr_temperature # B x S x Z
        fwd_sim_mat_softmax = masked_softmax(fwd_sim_mat, ref_inactive_color_mask, dim=1)  # N x S x Z  (softmax is over the reference segments)
        _ref_color_ids = torch.where(ref_color_ids == -100, 0, ref_color_ids.long()) # we can't one-hot negative values
        ref_color_selections = F.one_hot(_ref_color_ids, num_classes=self.max_segments).to(torch.float32)  # N x S 
        target_color_logits = torch.einsum('bso,bsz->bzo', ref_color_selections, fwd_sim_mat_softmax)  # N x Z x MC

        # used in inference and cycle consistency loss
        target_active_color_mask = (target_inactive_color_mask == False)
        # prevent from argmaxing over padding
        target_color_id_predictions = torch.argmax(target_color_logits * target_active_color_mask.unsqueeze(-1), dim=-1)  # B x Z

        # inference
        if target_color_ids is None:
            assert torch.is_inference_mode_enabled()
            return AnTV1Output(
                target_color_id_predictions=target_color_id_predictions,
            )
        else:
            _num_active_target_segs = target_active_color_mask.sum(dim=1)
            _fwd_loss = torch.nn.functional.nll_loss(
                input=torch.log(target_color_logits.permute(0, 2, 1) + 1e-7),
                target=target_color_ids.long(),
                reduction="none"
            ).sum(dim=1)
            fwd_loss = (_fwd_loss / _num_active_target_segs).mean()

            if not self.training:
                # eval
                return AnTV1Output(
                    target_color_id_predictions=target_color_id_predictions,
                    loss=fwd_loss,
                )
            else:
                if self.cycle_weight > 0.0:
                    _bkwd_loss, _bkwd_id_predictions, _ref_pos_ids_for_loss = self._cycle_loss(
                        ref_feats=final_ref_feats,
                        ref_color_ids=ref_color_ids,
                        ref_inactive_color_mask=ref_inactive_color_mask,
                        target_feats=final_target_feats,
                        target_color_ids=target_color_ids,
                        target_active_color_mask=target_active_color_mask,
                        target_color_id_predictions=target_color_id_predictions,
                        fwd_sim_mat_softmax=fwd_sim_mat_softmax,
                    )
                    bkwd_loss = _bkwd_loss * self.cycle_weight
                else:
                    bkwd_loss = torch.tensor(0.)

                if self.dift_weight > 0.0:
                    _dift_loss = self._dift_loss(
                        ref_image_feats=mid_image_ref_feats,
                        ref_line_image=ref_line_image,
                        ref_color_image=ref_color_image,
                        target_image_feats=mid_image_target_feats,
                        target_line_image=target_line_image,
                        target_color_image=target_color_image,
                    )
                    # _dift_loss = self._dift_pooled_loss(
                    #     ref_image_feats=mid_image_ref_feats,
                    #     ref_line_image=ref_line_image,
                    #     ref_color_image=ref_color_image,
                    #     ref_seg_image=ref_seg_image,
                    #     ref_seg_padding_mask=ref_seg_padding_mask,
                    #     target_image_feats=mid_image_target_feats,
                    #     target_line_image=target_line_image,
                    #     target_color_image=target_color_image,
                    #     target_seg_image=target_seg_image,
                    #     target_seg_padding_mask=target_seg_padding_mask,
                    # )
                    dift_loss = _dift_loss * self.dift_weight
                else:
                    dift_loss = torch.tensor(0.)

                self._log_additional_metrics(
                    fwd_loss,
                    bkwd_loss,
                    dift_loss,
                    target_color_id_predictions=target_color_id_predictions,
                    target_color_ids=target_color_ids,
                    bkwd_id_predictions=_bkwd_id_predictions,
                    bkwd_pos_ids=_ref_pos_ids_for_loss,
                )

                loss = fwd_loss + bkwd_loss + dift_loss

                return AnTV1Output(
                    target_color_id_predictions=target_color_id_predictions,
                    loss=loss,
                )
        
    def _cycle_loss(
        self,
        ref_feats: torch.FloatTensor,
        ref_color_ids: torch.LongTensor,
        ref_inactive_color_mask: torch.BoolTensor,
        target_feats: torch.FloatTensor,
        target_color_ids: torch.LongTensor,
        target_active_color_mask: torch.BoolTensor,
        target_color_id_predictions: torch.LongTensor,
        fwd_sim_mat_softmax: torch.FloatTensor,
    ):
        # forward id propagation
        ref_active_color_mask = ref_inactive_color_mask == False
        _ref_pos_ids = torch.arange(ref_color_ids.shape[-1], device=ref_color_ids.device)
        ref_pos_ids = (_ref_pos_ids * ref_active_color_mask).to(torch.int64)  # B x S
        _ref_id_selections = F.one_hot(ref_pos_ids, num_classes=self.max_segments).to(torch.float32)  # N x S x MS

        # fwd pos id propagation
        fwd_id_logits = torch.einsum('bso,bsz->bzo', _ref_id_selections, fwd_sim_mat_softmax)  # N x Z x S
        fwd_id_predictions = torch.argmax(fwd_id_logits * target_active_color_mask.unsqueeze(-1), dim=-1)  # N x S

        # do some masking so we only propagate backward the ids from segments that the fwd color prediction got right 
        correct_fwd_color_predictions_mask = torch.where(
            target_color_id_predictions == target_color_ids,
            target_active_color_mask,  # active target segs
            False,
        )
        correct_fwd_id_predictions = torch.where(
            correct_fwd_color_predictions_mask,
            fwd_id_predictions,
            torch.zeros_like(fwd_id_predictions),
        )  # N x Z x MS
        correct_fwd_id_selections = F.one_hot(correct_fwd_id_predictions, num_classes=self.max_segments).to(torch.float32)  # N x Z x MS

        # backward id propagation 
        bkwd_sim_mat = torch.einsum('bcz,bcs->bzs', target_feats, ref_feats) / self.corr_temperature # B x Z x S
        bkwd_sim_mat_softmax = masked_softmax(bkwd_sim_mat, ~correct_fwd_color_predictions_mask, dim=1)  # N x Z x S  (softmax is over the target segments)
        bkwd_id_logits = torch.einsum('bzo,bzs->bso', correct_fwd_id_selections, bkwd_sim_mat_softmax)  # N x S x MC
        bkwd_id_predictions = torch.argmax(bkwd_id_logits * ref_active_color_mask.unsqueeze(-1), dim=-1)  # B x S

        # set padding indices in ref ids to -100 so they are ignored in the loss
        ref_pos_ids_for_loss = torch.where(
            ref_active_color_mask,
            ref_pos_ids,
            -100,
        )

        _num_active_ref_segs = ref_active_color_mask.sum(dim=1)
        _bkwd_loss = torch.nn.functional.nll_loss(
            input=torch.log(bkwd_id_logits.permute(0, 2, 1) + 1e-7),
            target=ref_pos_ids_for_loss.long(),
            reduction="none"
        ).sum(dim=1)
        bkwd_loss = (_bkwd_loss / _num_active_ref_segs).mean()

        return bkwd_loss, bkwd_id_predictions, ref_pos_ids_for_loss
        
    def _dift_loss(
        self,
        ref_image_feats: torch.FloatTensor,
        ref_line_image: torch.FloatTensor,
        ref_color_image: torch.FloatTensor,
        target_image_feats: torch.FloatTensor,
        target_line_image: torch.FloatTensor,
        target_color_image: torch.FloatTensor,
    ):
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            pred_ref_image_feats_flat = rearrange(ref_image_feats, 'b c h w -> b (h w) c')
            pred_target_image_feats_flat = rearrange(target_image_feats, 'b c h w -> b (h w) c')
            ref_image_dift_feats_flat = self.seg_feats_to_dift_proj(pred_ref_image_feats_flat)
            target_image_dift_feats_flat = self.seg_feats_to_dift_proj(pred_target_image_feats_flat)

        gt_ref_dift_feats  = self.dift(
            line=ref_line_image,
            color=ref_color_image,
        )
        gt_ref_dift_feats_flat = rearrange(gt_ref_dift_feats, 'b c h w -> b (h w) c')
        gt_target_dift_feats = self.dift(
            line=target_line_image,
            color=target_color_image,
        )
        gt_target_dift_feats_flat = rearrange(gt_target_dift_feats, 'b c h w -> b (h w) c')

        ref_cosine_sim = self._cosine_similarity(
            pred_feats=ref_image_dift_feats_flat,
            gt_feats=gt_ref_dift_feats_flat,
        )
        target_cosine_sim = self._cosine_similarity(
            pred_feats=target_image_dift_feats_flat,
            gt_feats=gt_target_dift_feats_flat,
        )
        ref_loss = (1 - ref_cosine_sim).mean()
        target_loss = (1 - target_cosine_sim).mean()

        return ref_loss + target_loss

    # def _dift_pooled_loss(
    #     self,
    #     ref_image_feats: torch.FloatTensor,
    #     ref_line_image: torch.FloatTensor,
    #     ref_seg_image: torch.LongTensor,
    #     ref_color_image: torch.FloatTensor,
    #     ref_seg_padding_mask: torch.BoolTensor,
    #     target_image_feats: torch.FloatTensor,
    #     target_line_image: torch.FloatTensor,
    #     target_seg_image: torch.LongTensor,
    #     target_color_image: torch.FloatTensor,
    #     target_seg_padding_mask: torch.BoolTensor,
    # ):
    #     with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
    #         ref_image_dift_feats = self.seg_feats_to_dift_proj(ref_image_feats)
    #         target_image_dift_feats = self.seg_feats_to_dift_proj(target_image_feats)

    #     gt_ref_dift_feats, ref_dift_padding_mask = self.dift(
    #         line=ref_line_image,
    #         color=ref_color_image,
    #         seg=ref_seg_image,
    #         padding_mask=ref_seg_padding_mask,
    #     )
    #     gt_target_dift_feats, target_dift_padding_mask = self.dift(
    #         line=target_line_image,
    #         color=target_color_image,
    #         seg=target_seg_image,
    #         padding_mask=target_seg_padding_mask,
    #     )
    #     gt_ref_dift_feats  = self.dift(
    #         line=ref_line_image,
    #         color=ref_color_image,
    #         seg=ref_seg_image,
    #         padding_mask=ref_seg_padding_mask,
    #     )
    #     gt_target_dift_feats = self.dift(
    #         line=target_line_image,
    #         color=target_color_image,
    #         seg=target_seg_image,
    #         padding_mask=target_seg_padding_mask,
    #     )

    #     ref_cosine_sim = self._cosine_similarity(
    #         pred_feats=ref_image_dift_feats,
    #         gt_feats=gt_ref_dift_feats,
    #         padding_mask=ref_dift_padding_mask,
    #     )
    #     target_cosine_sim = self._cosine_similarity(
    #         pred_feats=target_image_dift_feats,
    #         gt_feats=gt_target_dift_feats,
    #         padding_mask=target_dift_padding_mask,
    #     )
    #     ref_loss = (1 - ref_cosine_sim).mean()
    #     target_loss = (1 - target_cosine_sim).mean()

    #     return ref_loss + target_loss

    def _cosine_similarity(
        self,
        pred_feats: torch.FloatTensor,
        gt_feats: torch.FloatTensor,
        padding_mask: Optional[torch.BoolTensor] = None
    ) -> torch.FloatTensor:
        # Normalize the predicted and ground truth features
        pred_norm = F.normalize(pred_feats, p=2, dim=-1)
        gt_norm = F.normalize(gt_feats, p=2, dim=-1)
        
        # Compute cosine similarity
        cosine_sim = torch.sum(pred_norm * gt_norm, dim=-1)

        if padding_mask is not None:
            cosine_sim = torch.where(padding_mask, torch.tensor(0.), cosine_sim)
            return cosine_sim.sum(dim=-1) / (~padding_mask).sum(dim=-1)
        else:
            return cosine_sim.mean()
        
    def _encode_image_features(
        self,
        ref_seg_image: torch.LongTensor,  # N x 1 x H x W
        ref_line_image: torch.FloatTensor,  # N x 4 x H x W
        ref_seg_padding_mask: torch.BoolTensor,  # N x S
        target_seg_image: torch.LongTensor,  # N x 1 x H x W
        target_line_image: torch.FloatTensor,  # N x 4 x H x W
        target_seg_padding_mask: torch.BoolTensor,  # N x Z
    ) -> Tuple[torch.FloatTensor, torch.FloatTensor]:
        ref_image_feats, ref_image_mid_feats = self.img_feat_extractor(
            seg=ref_seg_image,
            line=ref_line_image / 255,
            padding_mask=ref_seg_padding_mask,
        ) # N x S x F
        target_image_feats, target_image_mid_feats = self.img_feat_extractor(
            seg=target_seg_image,
            line=target_line_image / 255,
            padding_mask=target_seg_padding_mask,
        ) # N x Z x F

        return ref_image_feats, ref_image_mid_feats, target_image_feats, target_image_mid_feats
    
    def _encode_svg_features(
        self,
        ref_seg_svg: torch.FloatTensor,  # N x S x C x 6
        ref_seg_svg_packed: torch.FloatTensor,  # P x C x 6
        ref_seg_svg_attn_mask_packed: torch.BoolTensor,  # P x C x C
        target_seg_svg: torch.FloatTensor, # N x Z x C x 6
        target_seg_svg_packed: torch.FloatTensor, # P x C x 6
        target_seg_svg_attn_mask_packed: torch.BoolTensor ,  # P x C x C
    ) -> Tuple[torch.FloatTensor, torch.FloatTensor]:
        ref_svg_feats = self.svg_feat_extractor(
            seg_cmd_points=ref_seg_svg,
            seg_cmd_points_packed=ref_seg_svg_packed,
            seg_cmd_attn_mask_packed=ref_seg_svg_attn_mask_packed,
        ) # N x S x F
        target_svg_feats = self.svg_feat_extractor(
            seg_cmd_points=target_seg_svg,
            seg_cmd_points_packed=target_seg_svg_packed,
            seg_cmd_attn_mask_packed=target_seg_svg_attn_mask_packed,
        ) # N x Z x F

        return ref_svg_feats, target_svg_feats

    def _fuse_features(
        self,
        image_feats: torch.FloatTensor,
        svg_feats: torch.FloatTensor,
        padding_mask: torch.BoolTensor,
    ) -> torch.FloatTensor:
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            input_feats = self.seg_proj(torch.cat([image_feats, svg_feats], dim=-1))  # N x S x F
            attention_mask = make_4d_bidirectional_attention_mask(
                inputs_embeds=input_feats,
                inputs_attention_mask=~padding_mask.bool(),
            )
            llama_out = self.fusion_encoder(
                inputs_embeds=input_feats,
                attention_mask=attention_mask,
            )[0]

            return llama_out
        
    def _log_additional_metrics(
        self,
        fwd_loss: torch.Tensor,
        bkwd_loss: torch.Tensor,
        dift_loss: torch.Tensor,
        target_color_id_predictions: torch.Tensor,
        target_color_ids: torch.Tensor,
        bkwd_id_predictions: Optional[torch.Tensor] = None,
        bkwd_pos_ids: Optional[torch.Tensor] = None,
        **kwargs,
    ):
        experiment = comet_ml.get_global_experiment()

        if experiment:
            experiment.log_metric("fwd_loss", fwd_loss.item())
            experiment.log_metric("bkwd_loss", bkwd_loss.item())
            experiment.log_metric("dift_loss", dift_loss.item())

            fwd_acc = []
            bkwd_acc = []

            for idx in range(len(target_color_id_predictions)):
                fwd_target_active_mask = (target_color_ids[idx] != -100) & (target_color_id_predictions[idx] != -100)
                fwd_active_preds = target_color_id_predictions[idx][fwd_target_active_mask]
                fwd_active_targets = target_color_ids[idx][fwd_target_active_mask]

                if len(fwd_target_active_mask) == 0:
                     print("NO ACTIVE SEGMENTS")
                     continue

                _fwd_acc = torch.sum(fwd_active_preds == fwd_active_targets) / len(fwd_active_preds)
                fwd_acc.append(_fwd_acc.item())

                if bkwd_id_predictions is not None and bkwd_pos_ids is not None:
                    bkwd_target_active_mask = bkwd_pos_ids[idx] != -100
                    bkwd_active_preds = bkwd_id_predictions[idx][bkwd_target_active_mask]
                    bkwd_active_targets = bkwd_pos_ids[idx][bkwd_target_active_mask]

                    _bkwd_acc = torch.sum(bkwd_active_preds == bkwd_active_targets) / len(bkwd_active_preds)
                    bkwd_acc.append(_bkwd_acc.item())
                else:
                    bkwd_acc.append(0)

            experiment.log_metric("fwd_acc", sum(fwd_acc) / len(fwd_acc))
            experiment.log_metric("bkwd_acc", sum(bkwd_acc) / len(bkwd_acc))

