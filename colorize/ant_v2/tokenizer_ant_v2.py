from typing import *

import numpy as np
import torch
import torch.nn.functional as F

from colorize.common.sequence import Sequence, PartialSequence
from colorize.vectorization.vtrace import VecArgs
from colorize.common.image import ImageArgs
from colorize.ant_v1.tokenizer_ant_v1 import AnTV1Tokenizer


class AnTV2Tokenizer(AnTV1Tokenizer):

    def __init__(
        self,
        image_args: ImageArgs,
        vec_args: VecArgs,
        max_segments: int = 512,
        max_vec_seq_length: int = 256,
        mask_new_target_colors: bool = True,
        verbose: bool = False,
    ):
        super().__init__(
            image_args=image_args,
            vec_args=vec_args,
            max_segments=max_segments,
            max_vec_seq_length=max_vec_seq_length,
            mask_new_target_colors=mask_new_target_colors,
            verbose=verbose,
        )
        
    def from_full_seq(self, seq: Sequence) -> Dict[str, Any]:
        tokenized = super().from_full_seq(seq)

        if tokenized is None:
            return None

        # palette contains unique colors in both the reference and target
        ref_colors = seq.palette.color_ids_to_colors(tokenized["ref_color_ids"].tolist())
        target_colors = seq.palette.color_ids_to_colors(tokenized["target_color_ids"].tolist())

        tokenized.update({
            # datasets cannot handle 2D arrays as torch tensors
            "ref_colors": torch.LongTensor(ref_colors).to(torch.int32).tolist(),
            "target_colors": torch.LongTensor(target_colors).to(torch.int32).tolist(),
        })
        
        return tokenized 

    def from_partial_seq(self, partial_seq: PartialSequence) -> Dict[str, Any]:
        assert len(partial_seq.ref_keyframes) == 1
        assert len(partial_seq.target_seg_frames) == 1
        
        ref_frame_indices = [frame.idx for frame in partial_seq.ref_keyframes] 
        ref_frame_idx = ref_frame_indices[0]
        ref_color_ids = partial_seq.palette.frame_idx_to_color_ids[str(ref_frame_idx)]
        
        ref_frame = partial_seq.ref_keyframes[0]
        target_seg = partial_seq.target_seg_frames[0]
        target_line = partial_seq.target_line_frames[0]

        # mask colors for non-existent or unknown segs
        ref_color_ids = torch.LongTensor(ref_color_ids)
        ref_color_ids = self.mask_null_color_ids(
            seg_image=ref_frame.seg_frame.image_data,
            color_ids=ref_color_ids,
            debug_path=ref_frame.seg_frame.path,
        )
        ref_colors = torch.FloatTensor(partial_seq.palette.color_ids_to_colors(ref_color_ids.tolist()))

        # all null colors
        target_color_ids = torch.ones(len(target_seg.svg.paths), dtype=torch.int32) * -100
        target_colors = torch.ones((len(target_seg.svg.paths), 4), dtype=torch.int32) * -100

        # no collate in inference
        tokenized = {
            "ref_colors": ref_colors.unsqueeze(0),
            "target_colors": target_colors.unsqueeze(0),
            "ref_color_ids": ref_color_ids.unsqueeze(0),
            "target_color_ids": target_color_ids.unsqueeze(0),
        }

        svg_data = self.get_vec_tokens(
            ref_seg_svg=ref_frame.seg_frame.svg,
            target_seg_svg=target_seg.svg,
            add_batch_dim=True,
            convert_to_list=False,
        )
        assert svg_data['ref_seg_svg'].shape[1] == len(ref_color_ids)
        assert svg_data['target_seg_svg'].shape[1] == len(target_color_ids)
        tokenized.update(svg_data)
            
        image_data = self.get_image_tokens(
            ref_seg_image=ref_frame.seg_frame.image_data,
            ref_line_image=ref_frame.line_frame.image_data,
            ref_color_image=ref_frame.color_frame.image_data if ref_frame.color_frame is not None else None,
            target_seg_image=target_seg.image_data,
            target_line_image=target_line.image_data,
            convert_to_torch=True,
            add_batch_dim=True
        )
        tokenized.update(image_data)
    
        return tokenized 

    def _collate(self, features: List[Dict[str, torch.Tensor]]) -> Dict[str, Any]:
        collated_features = super()._collate(features)

        ref_max_num_segs = max([seq['ref_colors'].shape[0] for seq in features])
        target_max_num_segs = max([seq['target_colors'].shape[0] for seq in features])
        
        for feature in features:
            ref_color_len = feature['ref_colors'].shape[0]
            feature['ref_colors'] = F.pad(
                input=feature['ref_colors'],
                pad=(
                    0, 0,
                    0, ref_max_num_segs - ref_color_len,
                ),
                value=self.PAD_VALUE
            )
            
            target_color_len = feature['target_colors'].shape[0] 
            feature['target_colors'] = F.pad(
                input=feature['target_colors'],
                pad=(
                    0, 0,
                    0, target_max_num_segs - target_color_len,
                ),
                value=self.PAD_VALUE
            )

        out = {
            **collated_features,
            'ref_colors': torch.stack([feat['ref_colors'] for feat in features]),
            'target_colors': torch.stack([feat['target_colors'] for feat in features]),
        }
            
        return out
