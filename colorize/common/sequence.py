from __future__ import annotations
import itertools
from typing import *
from dataclasses import dataclass
import os
import random
import copy

import numpy as np
from PIL import Image
from PIL.Image import Quantize

from colorize.vectorization.vtrace import VecArgs
from colorize.common.image import ImageArgs, prepare_image
from colorize.common.file import align_frames
from colorize.common.ops import rgba_to_dense
from colorize.common.frame import (
    Frame,
    ImageFrame,
    SegImageFrame,
    ColorImageFrame,
    LineImageFrame,
    KeyFrame,
    MaterializedKeyFrame,
    Palette,
    SequenceStats,
)


@dataclass
class Sequence:
    
    frames: List[Union[KeyFrame, MaterializedKeyFrame]]
    palette: Palette
    stats: SequenceStats = None # only used if we're reading from files

    def reverse(self) -> Sequence:
        return Sequence.from_keyframes(self.frames[::-1])

    def take(
        self,
        indices: List[int],
    ) -> Sequence:
        keyframes = [self.frames[idx] for idx in indices]
        return Sequence.from_keyframes(keyframes)

    def chunk(
        self,
        chunk_size: int,
        overlap_size: int = 0,
    ) -> List[Sequence]:
        indices = list(range(len(self.frames)))
        chunks = []
        start = 0
        end = chunk_size
        
        while start < len(indices):
            chunk = indices[start:end]
            chunks.append(chunk)
            start += chunk_size - overlap_size
            end = start + chunk_size

        return [self.take(chunk) for chunk in chunks]

    def sample_subsequences(
        self,
        length: int, 
        max_dist: int,
        max_subseqs: Optional[int] = None,
        min_subseqs: Optional[int] = None,
    ) -> List[Sequence]:
        num_frames = len(self.frames)
        if num_frames < length:
            print(f'Skipping sequence of length {num_frames} with too few frames')
            return []
        
        if len(self.frames) < 5:
            max_dist = 10000
        
        valid_subseq_frames = self._get_valid_combos_up_to(length, max_dist, allow_shorter_combos=True)

        if len(valid_subseq_frames) == 0:
            return []

        # randomly downsample
        if max_subseqs is not None:
            if len(valid_subseq_frames) > max_subseqs:
                valid_subseq_frames = random.sample(valid_subseq_frames, max_subseqs)

        # randomly duplicate
        if min_subseqs is not None:
            if len(valid_subseq_frames) < min_subseqs:
                num_elems_to_add = min_subseqs - len(valid_subseq_frames)
                indices_to_duplicate = np.random.choice(
                    range(len(valid_subseq_frames)),
                    size=num_elems_to_add,
                    replace=True
                )
                valid_subseq_frames += [valid_subseq_frames[i] for i in indices_to_duplicate]
            
        subseqs = []
        for subseq_frames in valid_subseq_frames:
            subseq = Sequence.from_keyframes(subseq_frames)
            subseqs.append(subseq)
        return subseqs
    
    @classmethod
    def from_keyframes(
        cls,
        keyframes: List[KeyFrame]
    ):
        subseq_palette = Palette()
        for keyframe in keyframes:
            subseq_palette.add_frame_colors(keyframe)
        subseq = Sequence(
            frames=keyframes,
            palette=subseq_palette,
        )
        return subseq
    
    def _get_valid_combos_up_to(
        self,
        length: int,
        max_dist: int,
        allow_shorter_combos: bool = True,
    ) -> List[List[Union[KeyFrame, MaterializedKeyFrame]]]:
        assert length >= 2
        if not allow_shorter_combos or length == 2:
            valid_combos = self._get_valid_combos(length, max_dist)
        else:
            valid_combos = []
            for length in range(1, length + 1):
                valid_combos += self._get_valid_combos(length, max_dist)
        return valid_combos
    
    def _get_valid_combos(
        self,
        length: int,
        max_dist: int,
    ) -> List[List[Union[KeyFrame, MaterializedKeyFrame]]]:
        all_combinations = list(itertools.permutations(self.frames, length))
        valid_combinations = [
            list(comb) for comb in all_combinations
            if all(abs(comb[i].idx - comb[j].idx) <= max_dist \
                for i in range(length) for j in range(i+1, length))
        ]
        return valid_combinations
        
    @classmethod 
    def from_full_scene_files(
        cls,
        seg_paths: List[str],
        color_paths: List[str],
        line_paths: List[str],
        quantized_num_colors: int = 256,
    ) -> Sequence:
        seg_frames = [SegImageFrame.from_file(p) for p in seg_paths if os.path.exists(p)]
        color_frames = [ColorImageFrame.from_file(p) for p in color_paths if os.path.exists(p)]
        line_frames = [LineImageFrame.from_file(p) for p in line_paths if os.path.exists(p)]

        sequence_stats = SequenceStats()
        aligned_seg, aligned_color, aligned_line = Sequence._filter_and_align_frames(
            stats=sequence_stats,
            seg_frames=seg_frames,
            color_frames=color_frames,
            line_frames=line_frames,
        )
        preproc_frames, palette = Sequence.preprocess(
            seg_frames=aligned_seg,
            color_frames=aligned_color,
            line_frames=aligned_line,
            quantized_num_colors=quantized_num_colors,
        )
        return Sequence(frames=preproc_frames, palette=palette, stats=sequence_stats)
    
    @staticmethod
    def _filter_and_align_frames(
        stats: SequenceStats,
        seg_frames: List[SegImageFrame],
        color_frames: List[ColorImageFrame],
        line_frames: Optional[List[LineImageFrame]] = None,
    ) -> Tuple[List[ImageFrame], ...]:
        print(f'Number of frames to align: {len(color_frames)}, {len(seg_frames)}, {len(line_frames)}')
        
        seg_frames, color_frames, line_frames = Sequence.filter_empty_frames(stats, seg_frames, color_frames, line_frames)
        
        seg_path_frame_nums = [frame.idx for frame in seg_frames]
        color_path_frame_nums = [frame.idx for frame in color_frames]
        line_path_frame_nums = [frame.idx for frame in line_frames]

        seg_indices, color_indices, line_indices = align_frames(
            seg_path_frame_nums=seg_path_frame_nums,
            color_path_frame_nums=color_path_frame_nums,
            line_path_frame_nums=line_path_frame_nums,
        )

        aligned_seg = [seg_frames[idx] for idx in seg_indices]
        aligned_color = [color_frames[idx] for idx in color_indices]
        aligned_line = [line_frames[idx] for idx in line_indices]

        num_frames = len(aligned_seg)

        aligned_seg, aligned_color, aligned_line = Sequence.filter_duplicate_frames(
            seg_frames=aligned_seg,
            color_frames=aligned_color,
            line_frames=aligned_line,
        )

        if len(aligned_color) != len(aligned_seg):
            raise ValueError(f'Frame alignment error')

        if len(aligned_color) != num_frames:
            print(f"Removed {num_frames - len(aligned_color)} duplicate frames")

        stats.valid_frame_indices = len(aligned_seg)
            
        return aligned_seg, aligned_color, aligned_line
    
    @staticmethod 
    def filter_empty_frames(
        stats: SequenceStats,
        seg_frames: List[SegImageFrame],
        color_frames: List[ColorImageFrame],
        line_frames: Optional[List[LineImageFrame]] = None
    ) -> Tuple[List[SegImageFrame], List[ColorImageFrame], List[LineImageFrame]]:
        _seg_frames = []
        for frame in seg_frames:
            if frame.image_data is not None:
                _seg_frames.append(frame)
            else:
                print(f'WARNING: empty seg frame found: {frame.path}')
                stats.num_empty_seg_frames += 1
                if frame.is_corrupt:
                    stats.num_corrupt_seg_frames += 1
        _color_frames = []
        for frame in color_frames:
            if frame.image_data is not None:
                _color_frames.append(frame)
            else:
                print(f'WARNING: empty color frame found: {frame.path}')
                stats.num_empty_color_frames += 1
                if frame.is_corrupt:
                    stats.num_corrupt_color_frames += 1
        _line_frames = [] 
        if line_frames is not None:
            for frame in line_frames:
                if frame.image_data is not None:
                    _line_frames.append(frame)
                else:
                    print(f'WARNING: empty line frame found: {frame.path}')
                    stats.num_empty_line_frames += 1
                    if frame.is_corrupt:
                        stats.num_corrupt_line_frames += 1
        return _seg_frames, _color_frames, _line_frames

    @staticmethod
    def filter_duplicate_frames(
        seg_frames: List[SegImageFrame],
        color_frames: List[ColorImageFrame],
        line_frames: List[LineImageFrame],
    ) -> Tuple[List[SegImageFrame], List[ColorImageFrame], List[LineImageFrame]]:
        filtered_seg_frames = []
        filtered_color_frames = []
        filtered_line_frames = []

        for i in range(len(line_frames)):
            # Always keep first frame
            if i == 0:
                filtered_seg_frames.append(seg_frames[i])
                filtered_color_frames.append(color_frames[i])
                filtered_line_frames.append(line_frames[i])
                continue

            # Compare current line frame with previous
            curr_line = line_frames[i].image_data
            prev_line = line_frames[i-1].image_data
            
            # Only filter if line frames are exactly equal
            if not np.array_equal(curr_line, prev_line):
                filtered_seg_frames.append(seg_frames[i])
                filtered_color_frames.append(color_frames[i]) 
                filtered_line_frames.append(line_frames[i])

        return filtered_seg_frames, filtered_color_frames, filtered_line_frames
    
    @staticmethod
    def preprocess(
        seg_frames: List[SegImageFrame],
        color_frames: List[ColorImageFrame],
        line_frames: List[LineImageFrame],
        quantized_num_colors: int = 256,
    ) -> Tuple[List[KeyFrame], Palette]:
        quantized_color_frames = Sequence.quantize_color_frames(color_frames, quantized_num_colors)
        
        pre_proc_frames = []
        palette = Palette()
        for seg_frame, color_frame, line_frame in zip(seg_frames, quantized_color_frames, line_frames):
            assert seg_frame.idx == color_frame.idx
            assert seg_frame.idx == line_frame.idx
            full_frame = KeyFrame.from_frames(seg_frame, line_frame, color_frame)
            palette.add_frame_colors(full_frame)
            pre_proc_frames.append(full_frame)
        return pre_proc_frames, palette

    # TODO: should we remove line pixels before quantizing?
    @staticmethod 
    def quantize_color_frames(
        color_frames: List[ColorImageFrame],
        quantized_num_colors: int = 256,
    ) -> List[ColorImageFrame]:
        big_image = np.concatenate([
            color_frame.image_data for color_frame in color_frames
        ])

        # quantization only works on RGB, so we need to remove the alpha channel
        color_rgb = big_image[:, :, :3]

        color_rgb = np.array(Image.fromarray(color_rgb).quantize(
            colors=quantized_num_colors,
            method=Quantize.MAXCOVERAGE,
        ).convert("RGB")).astype(np.uint8)

        color_images = np.split(color_rgb, len(color_frames))
        quantized_color_frames = []
        for quantized, frame in zip(color_images, color_frames):
            color_frame = copy.deepcopy(frame)
            color_frame.image_data = np.concatenate(
                [
                    quantized,
                    frame.image_data[:,:,3:4]
                ],
                axis=-1
            )
            quantized_color_frames.append(color_frame)
        return quantized_color_frames

    def materialize(
        self,
        color_source: Literal['file', 'color_list', 'empty'] = 'color_list',
    ) -> None:
        for frame_idx in range(len(self.frames)):
            self.frames[frame_idx] = MaterializedKeyFrame.from_keyframe(
                keyframe=self.frames[frame_idx],
                color_source=color_source,
            )

    def prepare_images_for_training(
        self,
        augment: bool,
        image_args: ImageArgs,
        vec_args: VecArgs,
        verbose: bool = False,
    ) -> None:
        # this should only be called on materialized keyframes
        assert isinstance(self.frames[0], MaterializedKeyFrame)
        for frame in self.frames:
            seg_image, line_image, color_image, vectorized_seg = prepare_image(
                seg_image=frame.seg_frame.image_data,
                line_image=frame.line_frame.image_data,
                image_args=image_args,
                vec_args=vec_args,
                augment=augment,
                color_image=frame.color_frame.image_data if frame.color_frame is not None else None,
                verbose=verbose,
            )
            frame.seg_frame.image_data = seg_image
            frame.line_frame.image_data = line_image
            frame.seg_frame.svg = vectorized_seg
            if frame.color_frame is not None:
                frame.color_frame.image_data = color_image

    @staticmethod 
    def from_dict(data: Dict[str, Any], is_materialized: bool = False) -> Sequence:
        if is_materialized:
            frames = [MaterializedKeyFrame.from_dict(data) for data in data['frames']]
        else:
            frames = [KeyFrame.from_dict(data) for data in data['frames']]
        palette = Palette(**data['palette'])
        return Sequence(frames=frames, palette=palette)
        
    def to_dict(self) -> Dict[str, Any]:
        frames_as_dicts = [frame.to_dict() for frame in self.frames]
        return {
            'frames': frames_as_dicts,
            'palette': self.palette.__dict__,
        }
    
    def drop_empty_keyframes(self) -> None:
        valid_keyframes = []
        for keyframe in self.frames:
            if keyframe.stats['num_total_segs'] > 1:
                valid_keyframes.append(keyframe)
            else:
                print(f'Dropping empty keyframe: {keyframe.path}')
            # elif keyframe.stats['num_multi_color_segs'] > 10:
            #     seq.keyframes.remove(keyframe)
        self.frames = valid_keyframes

    def is_empty(self) -> bool:
        return len(self.frames) == 0
    
    def map_to_random_color_palette(self) -> None:
        random_color_list = []
        for _ in self.palette.color_list:
            random_color = np.array([
                random.randint(0, 255), 
                random.randint(0, 255), 
                random.randint(0, 255),
                255,
            ])
            random_color_list.append(random_color)

        random_color_list = np.array(random_color_list)
        random_color_list = rgba_to_dense(np.expand_dims(random_color_list, axis=0)).reshape(-1)

        randomized_palette = Palette(
            color_list=random_color_list,
            frame_idx_to_color_ids=self.palette.frame_idx_to_color_ids,
        )
        self.palette = randomized_palette
        for frame in self.frames:
            frame.color_list = self.palette.color_ids_to_dense_colors(
                color_ids=randomized_palette.frame_idx_to_color_ids[str(frame.idx)]
            )
    
    def render_color_key_frames(
        self,
        null_color_rgba: Tuple[int, int, int, int] = (0, 0, 0, 0)
    ) -> Generator[Image.Image, None, None]:
        for frame in self.frames:
            assert isinstance(frame, MaterializedKeyFrame)
            yield frame.render_color_image(null_color_rgba)
        
 
@dataclass
class PartialSequence:
    
    ref_keyframes: List[MaterializedKeyFrame]
    target_seg_frames: List[SegImageFrame]
    target_line_frames: List[LineImageFrame]
    palette: Palette

    def prepare_images_for_inference(
        self,
        image_args: ImageArgs,
        vec_args: VecArgs,
        verbose: bool = False,
    ) -> None:
        # this should only be called on materialized keyframes
        assert isinstance(self.ref_keyframes[0], MaterializedKeyFrame)
        for frame in self.ref_keyframes:
            seg_image, line_image, color_image, vectorized_seg = prepare_image(
                seg_image=frame.seg_frame.image_data,
                line_image=frame.line_frame.image_data,
                image_args=image_args,
                vec_args=vec_args,
                augment=False,
                color_image=frame.color_frame.image_data if frame.color_frame is not None else None,
                verbose=verbose,
            )
            frame.seg_frame.image_data = seg_image
            frame.line_frame.image_data = line_image
            frame.seg_frame.svg = vectorized_seg
            if frame.color_frame is not None:
                frame.color_frame.image_data = color_image

        for seg_frame, line_frame in zip(self.target_seg_frames, self.target_line_frames):    
            seg_image, line_image, _, vectorized_seg = prepare_image(
                seg_image=seg_frame.image_data,
                line_image=line_frame.image_data,
                image_args=image_args,
                vec_args=vec_args,
                augment=False,
                verbose=verbose,
            )
            seg_frame.image_data = seg_image
            line_frame.image_data = line_image
            seg_frame.svg = vectorized_seg
    
    @classmethod
    def from_keyframes(
        cls,
        ref_keyframes: List[KeyFrame],  # already materialized
        target_seg_frames: List[SegImageFrame],
        target_line_frames: List[LineImageFrame],
        unique_color_ids: bool = False,
    ) -> PartialSequence:
        if unique_color_ids:
            assert len(ref_keyframes) == 1, "Unique color ids are only supported for single reference frame"

        # TODO: should we quantized the ref frame here too?
        palette = Palette()
        for ref_frame in ref_keyframes:
            if unique_color_ids:
                palette.add_frame_colors_uniquely(ref_frame)
            else:
                palette.add_frame_colors(ref_frame)
        assert len(target_seg_frames) == len(target_line_frames)
        return PartialSequence(
            ref_keyframes=copy.deepcopy(ref_keyframes),
            target_seg_frames=copy.deepcopy(target_seg_frames),
            target_line_frames=copy.deepcopy(target_line_frames),
            palette=palette
        )
