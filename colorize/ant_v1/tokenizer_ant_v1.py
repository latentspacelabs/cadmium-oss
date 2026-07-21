from typing import *
from io import BytesIO
import time

from PIL import Image
import numpy as np
import torch
import torchvision.transforms.functional as TF
import torch.nn.functional as F

from colorize.common.packing import pack_sequences
from colorize.common.sequence import Sequence, PartialSequence
from colorize.vectorization.lib.svg import SVG
from colorize.vectorization.vtrace import VecArgs
from colorize.common.image import ImageArgs


class AnTV1Tokenizer:

    PAD_VALUE = -100

    def __init__(
        self,
        image_args: ImageArgs,
        vec_args: VecArgs,
        max_segments: int = 512,
        max_vec_seq_length: int = 256,
        mask_new_target_colors: bool = True,
        verbose: bool = False,
    ):
        self.image_args = image_args
        self.vec_args = vec_args
        self.max_segments = max_segments
        self.max_vec_seq_length = max_vec_seq_length
        self.mask_new_target_colors = mask_new_target_colors
        self.verbose = verbose

    def get_vec_tokens(
        self,
        ref_seg_svg: SVG,
        target_seg_svg: SVG,
        add_batch_dim: bool = False,
        convert_to_list: bool = False,
    ) -> Dict[str, Any]:
        ref_seg_svg_tensor = ref_seg_svg.to_tensor(return_point_dim=False)
        target_seg_svg_tensor = target_seg_svg.to_tensor(return_point_dim=False)

        num_ref_commands = ref_seg_svg_tensor.shape[1]
        if num_ref_commands > self.max_vec_seq_length:
            print(f'Truncating ref_seg_svg_tensor with {num_ref_commands} commands')
            truncated_indices = np.sort(np.random.randint(0, num_ref_commands, self.max_vec_seq_length))
            ref_seg_svg_tensor = ref_seg_svg_tensor[:, truncated_indices]

        num_target_commands = target_seg_svg_tensor.shape[1]
        if num_target_commands > self.max_vec_seq_length:
            print(f'Truncating target_seg_svg_tensor with {num_target_commands} commands')
            truncated_indices = np.sort(np.random.randint(0, num_target_commands, self.max_vec_seq_length))
            target_seg_svg_tensor = target_seg_svg_tensor[:, truncated_indices]

        ref_seg_svg_tensor_packed, _, ref_attn_mask = pack_sequences(ref_seg_svg_tensor)
        target_seg_svg_tensor_packed, _, target_attn_mask = pack_sequences(target_seg_svg_tensor)

        if add_batch_dim:
            ref_seg_svg_tensor = torch.unsqueeze(ref_seg_svg_tensor, dim=0)
            target_seg_svg_tensor = torch.unsqueeze(target_seg_svg_tensor, dim=0)
            ref_seg_svg_tensor_packed = torch.unsqueeze(ref_seg_svg_tensor_packed, dim=0)
            target_seg_svg_tensor_packed = torch.unsqueeze(target_seg_svg_tensor_packed, dim=0)
            ref_attn_mask = torch.unsqueeze(ref_attn_mask, dim=0)
            target_attn_mask = torch.unsqueeze(target_attn_mask, dim=0)

        if convert_to_list:
            ref_seg_svg_tensor = ref_seg_svg_tensor.tolist()
            target_seg_svg_tensor = target_seg_svg_tensor.tolist()
            ref_seg_svg_tensor_packed = ref_seg_svg_tensor_packed.tolist()
            target_seg_svg_tensor_packed = target_seg_svg_tensor_packed.tolist()
            ref_attn_mask = ref_attn_mask.tolist()
            target_attn_mask = target_attn_mask.tolist()
            

        return {
            'ref_seg_svg': ref_seg_svg_tensor,
            'target_seg_svg': target_seg_svg_tensor,
            'ref_seg_svg_packed': ref_seg_svg_tensor_packed,
            'target_seg_svg_packed': target_seg_svg_tensor_packed,
            'ref_seg_svg_attn_mask_packed': ref_attn_mask,
            'target_seg_svg_attn_mask_packed': target_attn_mask,
        }
        
    def get_image_tokens(
        self,
        ref_seg_image: np.ndarray,  # H x W 
        ref_line_image: np.ndarray,  # H x W x 4
        target_seg_image: np.ndarray,  # x H x W
        target_line_image: np.ndarray,  # H x W x 4
        ref_color_image: Optional[np.ndarray] = None,  # H x W x 4
        target_color_image: Optional[np.ndarray] = None,  # H x W x 4
        add_batch_dim: bool = False,
        convert_to_torch: bool = False,
    ) -> Dict[str, Any]:

        if convert_to_torch:
            # if using with pipeline, we need to store it as a torch.Tensor
            ref_seg_image = torch.from_numpy(ref_seg_image).unsqueeze(-1).permute(2, 0, 1).to(torch.int32)
            ref_line_image = torch.from_numpy(ref_line_image).permute(2, 0, 1)
            target_seg_image = torch.from_numpy(target_seg_image).unsqueeze(-1).permute(2, 0, 1).to(torch.int32)
            target_line_image = torch.from_numpy(target_line_image).permute(2, 0, 1)
            ref_color_image = torch.from_numpy(ref_color_image).permute(2, 0, 1) if ref_color_image is not None else None
            target_color_image = torch.from_numpy(target_color_image).permute(2, 0, 1) if target_color_image is not None else None
            if add_batch_dim:
                ref_seg_image = ref_seg_image.unsqueeze(0)
                ref_line_image = ref_line_image.unsqueeze(0)
                target_seg_image = target_seg_image.unsqueeze(0)
                target_line_image = target_line_image.unsqueeze(0)
                ref_color_image = ref_color_image.unsqueeze(0) if ref_color_image is not None else None
                target_color_image = target_color_image.unsqueeze(0) if target_color_image is not None else None
        else:
            # if using with datasets, we need to store it as a PIL.Image and batch dim gets added in collate
            ref_seg_image = Image.fromarray(ref_seg_image, mode="I")
            ref_line_image = Image.fromarray(ref_line_image, mode="RGBA")
            target_seg_image = Image.fromarray(target_seg_image, mode="I")
            target_line_image = Image.fromarray(target_line_image, mode="RGBA")
            ref_color_image = Image.fromarray(ref_color_image, mode="RGBA") if ref_color_image is not None else None
            target_color_image = Image.fromarray(target_color_image, mode="RGBA") if target_color_image is not None else None

        output =  {
            'ref_seg_image': ref_seg_image,
            'ref_line_image': ref_line_image,
            'target_seg_image': target_seg_image,
            'target_line_image': target_line_image,
        }
        if ref_color_image is not None:
            output['ref_color_image'] = ref_color_image
        if target_color_image is not None:
            output['target_color_image'] = target_color_image
        return output
    
    def mask_null_color_ids(
        self,
        seg_image: np.ndarray,
        color_ids: torch.LongTensor,
        debug_path: str,
    ) -> torch.LongTensor:
        # non existent segs
        seg_exists_mask = torch.zeros(len(color_ids), dtype=torch.bool)
        flat_seg = seg_image.flatten()
        seg_no_padding = flat_seg[flat_seg != -100]
        seg_exists_mask[seg_no_padding] = True
        if torch.sum(~seg_exists_mask) > 0:
            print(f'Tokenizing: {torch.sum(~seg_exists_mask)} nonexistent segments found for {debug_path}')

        # segs with null color
        not_null_color_mask = color_ids != -100
        masked_color_ids = torch.where(
            not_null_color_mask & seg_exists_mask,
            color_ids,
            torch.tensor(-100, dtype=torch.long)
        )
        if torch.sum(~not_null_color_mask) > 0:
            print(f'Tokenizing: {torch.sum(~not_null_color_mask)} unknown color segs found for {debug_path}')
        return masked_color_ids

    # train/eval
    def mask_new_target_color_ids(
        self,
        target_color_ids: torch.LongTensor,
        ref_color_ids: torch.LongTensor,
        seq: Sequence,
    ) -> torch.LongTensor:
        _target_color_ids = target_color_ids.tolist()
        _ref_color_ids = ref_color_ids.tolist()
        new_color_ids = list((set(_target_color_ids) - set(_ref_color_ids)) - {-100})
        if len(new_color_ids) > 0:
            debug_path = seq.frames[1].seg_frame.path
            print(f"Tokenizing: {len(new_color_ids)} out of {len(_target_color_ids)} segments with new color found for {debug_path}")
            target_color_ids = torch.tensor(
                [
                    target_color_id if target_color_id not in new_color_ids else -100
                    for target_color_id in _target_color_ids
                ],
                dtype=torch.long,
                device=target_color_ids.device,
            )
        return target_color_ids

    # training/eval 
    def from_full_seq(self, seq: Sequence) -> Dict[str, Any]:
        assert len(seq.frames) == 2

        if len(seq.frames[0].seg_frame.svg.paths) > self.max_segments or \
            len(seq.frames[1].seg_frame.svg.paths) > self.max_segments:
            print("Tokenizing: Too many segments found in SVG")
            return None
        
        frame_indices = [frame.idx for frame in seq.frames]

        ref_color_ids = torch.LongTensor(seq.palette.get_color_id_list_for_frame(frame_indices[0]))
        target_color_ids = torch.LongTensor(seq.palette.get_color_id_list_for_frame(frame_indices[1]))

        # mask colors for non-existent or unknown segs
        ref_color_ids = self.mask_null_color_ids(
            seg_image=seq.frames[0].seg_frame.image_data,
            color_ids=ref_color_ids,
            debug_path=seq.frames[0].seg_frame.path,
        )
        target_color_ids = self.mask_null_color_ids(
            seg_image=seq.frames[1].seg_frame.image_data,
            color_ids=target_color_ids,
            debug_path=seq.frames[1].seg_frame.path,
        )

        # mask colors in target that don't exist in reference
        if self.mask_new_target_colors:
            target_color_ids = self.mask_new_target_color_ids(
                target_color_ids=target_color_ids,
                ref_color_ids=ref_color_ids,
                seq=seq,
            )

        tokenized = {
            'ref_color_ids': ref_color_ids.to(torch.int32),
            'target_color_ids': target_color_ids.to(torch.int32),
        }

        svg_data = self.get_vec_tokens(
            ref_seg_svg=seq.frames[0].seg_frame.svg,
            target_seg_svg=seq.frames[1].seg_frame.svg,
            add_batch_dim=False,
            convert_to_list=True
        )
        assert len(svg_data['ref_seg_svg']) == len(ref_color_ids)
        assert len(svg_data['target_seg_svg']) == len(target_color_ids)
        tokenized.update(svg_data)

        ref_color_frame = seq.frames[0].color_frame
        target_color_frame = seq.frames[1].color_frame
            
        image_data = self.get_image_tokens(
            ref_seg_image=seq.frames[0].seg_frame.image_data,
            ref_line_image=seq.frames[0].line_frame.image_data,
            target_seg_image=seq.frames[1].seg_frame.image_data,
            target_line_image=seq.frames[1].line_frame.image_data,
            ref_color_image=ref_color_frame.image_data if ref_color_frame is not None else None,
            target_color_image=target_color_frame.image_data if target_color_frame is not None else None,
            add_batch_dim=False,
            convert_to_torch=False,
        )
        tokenized.update(image_data)
        
        return tokenized 

    # inference
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
        
        # no collate in inference
        tokenized = {
            'ref_color_ids': ref_color_ids.to(torch.int32).unsqueeze(0),
        }
        
        svg_data = self.get_vec_tokens(
            ref_seg_svg=ref_frame.seg_frame.svg,
            target_seg_svg=target_seg.svg,
            add_batch_dim=True,
            convert_to_list=False,
        )
        assert svg_data['ref_seg_svg'].shape[1] == len(ref_color_ids)
        tokenized.update(svg_data)
            
        image_data = self.get_image_tokens(
            ref_seg_image=ref_frame.seg_frame.image_data,
            ref_line_image=ref_frame.line_frame.image_data,
            target_seg_image=target_seg.image_data,
            target_line_image=target_line.image_data,
            convert_to_torch=True,
            add_batch_dim=True
        )
        tokenized.update(image_data)
    
        return tokenized 

    def _to_torch(self, feature: Dict[str, Any]) -> Dict[str, Any]:
        for key, value in feature.items():
            if isinstance(value, np.ndarray):
                feature[key] = torch.from_numpy(value)
            elif isinstance(value, list):
                feature[key] = torch.tensor(value)
            elif isinstance(value, Image.Image):
                feature[key] = TF.pil_to_tensor(value)
            elif isinstance(value, dict) and "bytes" in value:
                image = Image.open(BytesIO(value["bytes"]))
                feature[key] = TF.pil_to_tensor(image)
        return feature

    def collate(self, features: List[Dict[str, Any]]) -> Dict[str, Any]:
        features = [self._to_torch(feature) for feature in features if feature is not None]
        collated = self._collate(features)
        return collated

    def _collate(self, features: List[Dict[str, torch.Tensor]]) -> Dict[str, Any]:
        ref_max_num_segs = max([seq['ref_color_ids'].shape[0] for seq in features])
        target_max_num_segs = max([seq['target_color_ids'].shape[0] for seq in features])
        
        if 'ref_seg_svg' in features[0]:
            ref_svg_max_seq_len = max([seq['ref_seg_svg'].shape[1] for seq in features])
            target_svg_max_seq_len = max([seq['target_seg_svg'].shape[1] for seq in features])
            ref_svg_max_packed_len = max([seq['ref_seg_svg_packed'].shape[0] for seq in features])
            target_svg_max_packed_len = max([seq['target_seg_svg_packed'].shape[0] for seq in features])

        # padding 
        for feature in features:
            ref_color_ids_len = feature['ref_color_ids'].shape[0]
            feature['ref_color_ids'] = F.pad(
                input=feature['ref_color_ids'],
                pad=(0, ref_max_num_segs - ref_color_ids_len),
                value=self.PAD_VALUE
            )
            
            target_color_ids_len = feature['target_color_ids'].shape[0] 
            feature['target_color_ids'] = F.pad(
                input=feature['target_color_ids'],
                pad=(0, target_max_num_segs - target_color_ids_len),
                value=self.PAD_VALUE
            )
            
            if 'ref_seg_svg' in feature:
                ref_svg_seq_len = feature['ref_seg_svg'].shape[1]
                feature['ref_seg_svg'] = F.pad(
                    input=feature['ref_seg_svg'],
                    pad=(
                        0, 0,
                        0, ref_svg_max_seq_len - ref_svg_seq_len,
                        0, ref_max_num_segs - ref_color_ids_len,
                    ),
                    value=self.PAD_VALUE
                )
                target_svg_seq_len = feature['target_seg_svg'].shape[1]
                feature['target_seg_svg'] = F.pad(
                    input=feature['target_seg_svg'],
                    pad=(
                        0, 0,
                        0, target_svg_max_seq_len - target_svg_seq_len,
                        0, target_max_num_segs - target_color_ids_len,
                    ),
                    value=self.PAD_VALUE
                )
            
                ref_svg_packed_len = feature['ref_seg_svg_packed'].shape[0]
                feature['ref_seg_svg_packed'] = F.pad(
                    input=feature['ref_seg_svg_packed'],
                    pad=(
                        0, 0,
                        0, ref_svg_max_seq_len - ref_svg_seq_len,
                        0, ref_svg_max_packed_len - ref_svg_packed_len
                    ),
                    value=self.PAD_VALUE
                )
                feature['ref_seg_svg_attn_mask_packed'] = F.pad(
                    input=feature['ref_seg_svg_attn_mask_packed'],
                    pad=(
                        0, ref_svg_max_seq_len - ref_svg_seq_len,
                        0, ref_svg_max_seq_len - ref_svg_seq_len,
                        0, ref_svg_max_packed_len - ref_svg_packed_len
                    ),
                )

                target_svg_packed_len = feature['target_seg_svg_packed'].shape[0]
                feature['target_seg_svg_packed'] = F.pad(
                    input=feature['target_seg_svg_packed'],
                    pad=(
                        0, 0,
                        0, target_svg_max_seq_len - target_svg_seq_len,
                        0, target_svg_max_packed_len - target_svg_packed_len
                    ),
                    value=self.PAD_VALUE
                )
                feature['target_seg_svg_attn_mask_packed'] = F.pad(
                    input=feature['target_seg_svg_attn_mask_packed'],
                    pad=(
                        0, target_svg_max_seq_len - target_svg_seq_len,
                        0, target_svg_max_seq_len - target_svg_seq_len,
                        0, target_svg_max_packed_len - target_svg_packed_len
                    ),
                )

        out = {
            'ref_color_ids': torch.stack([feat['ref_color_ids'] for feat in features]),
            'target_color_ids': torch.stack([feat['target_color_ids'] for feat in features])
        }

        # svg 
        out['ref_seg_svg'] = torch.stack([feat['ref_seg_svg'] for feat in features])
        out['target_seg_svg'] = torch.stack([feat['target_seg_svg'] for feat in features])
        out['ref_seg_svg_packed'] = torch.stack([feat['ref_seg_svg_packed'] for feat in features])
        out['target_seg_svg_packed'] = torch.stack([feat['target_seg_svg_packed'] for feat in features])
        out['ref_seg_svg_attn_mask_packed'] = torch.stack([feat['ref_seg_svg_attn_mask_packed'] for feat in features])
        out['target_seg_svg_attn_mask_packed'] = torch.stack([feat['target_seg_svg_attn_mask_packed'] for feat in features])

        # image
        out['ref_seg_image'] = torch.stack([feat['ref_seg_image'] for feat in features]).long()
        out['target_seg_image'] = torch.stack([feat['target_seg_image'] for feat in features]).long()
        out['ref_line_image'] = torch.stack([feat['ref_line_image'] for feat in features])
        out['target_line_image'] = torch.stack([feat['target_line_image'] for feat in features])

        if 'ref_color_image' in features[0]:
            out['ref_color_image'] = torch.stack([feat['ref_color_image'] for feat in features])
        if 'target_color_image' in features[0]:
            out['target_color_image'] = torch.stack([feat['target_color_image'] for feat in features])

        return out
