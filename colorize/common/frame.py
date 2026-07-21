from __future__ import annotations
from typing import *
from dataclasses import dataclass

import numpy as np
import PIL
from PIL import Image
import torch

from segmentation.trapped_ball.serialization import rgba_to_int32
from segmentation.trapped_ball.line import binarize

from colorize.common.file import path_to_idx
from colorize.common.ops import rgba_to_dense_flat, dense_to_rgba, rgba_to_dense, dense_to_rgba_flat
from colorize.common.misc import color_list_to_colored_text, color_counts_to_colored_text, peakiness_score
from colorize.common.color_extraction import compute_color_list_serial, compute_color_list_parallel


@dataclass
class Frame:

    path: str
    idx: int
    

class ImageFrame(Frame):
    
    def __init__(
        self,
        path: str,
        idx: int,
        image: Optional[Union[Image.Image, np.ndarray]],
        is_corrupt: bool = False
    ) -> ImageFrame:
        self.path = path
        self.idx = idx
        if image is not None:
            self.image_data = np.array(image)
        else:
            self.image_data = None
        self.is_corrupt = is_corrupt

    @staticmethod
    def _read_img(path: str) -> Tuple[Optional[Union[Image.Image, np.ndarray]], bool]:
        is_corrupt = False
        image = None
        try:
            image = Image.open(path)
            if np.array(image).sum() == 0 or len(np.array(image).shape) == 0:
                is_corrupt = True
        except PIL.UnidentifiedImageError as e:
            print(e)
            is_corrupt = True
        return image, is_corrupt

    @staticmethod 
    def _maybe_convert_to_rgba(input_img: np.ndarray) -> np.ndarray:
        num_dims = len(input_img.shape)
        if num_dims == 3:
            if input_img.shape[-1] == 4:
                return input_img
            elif input_img.shape[-1] == 3:
                alpha_channel = np.ones((input_img.shape[0], input_img.shape[1]), dtype=np.uint8) * 255
                # Add the alpha channel to the RGB image
                return np.dstack((input_img, alpha_channel))
            else:
                raise ValueError(f'Image has {input_img.shape[-1]} channels')
        else:
            raise ValueError(f'Image has {num_dims} dimensions')
        
    @classmethod    
    def from_file(cls, path: str) -> ImageFrame:
        image, is_corrupt = cls._read_img(path)
        idx = path_to_idx(path)
        return cls(path, idx, image, is_corrupt)
    
    @classmethod
    def from_image(cls, image: Optional[Union[Image.Image, np.ndarray]], idx: int) -> ImageFrame:
        return cls(None, idx, image, False)


class SegImageFrame(ImageFrame):
    
    def __init__(
        self,
        path: str,
        idx: int,
        image: Optional[Union[Image.Image, np.ndarray]],
        is_corrupt: bool = False,
    ) -> SegImageFrame:
        super().__init__(path, idx, image, is_corrupt)
        if self.image_data is not None:
            self.num_segments = np.max(self.image_data) + 1
        else:
            self.num_segments = 0

        self.svg = None

    @classmethod    
    def from_file(cls, path: str) -> SegImageFrame:
        image, is_corrupt = cls._read_img(path)
        if image is not None:
            image = SegImageFrame._maybe_bitshift(np.array(image))
            if not SegImageFrame._check_contiguous(np.array(image)):
                print(f'Non-contiguous image found: {path}')
                image = None
                is_corrupt = True
        idx = path_to_idx(path)
        return cls(path, idx, image, is_corrupt) 

    @staticmethod 
    def _maybe_bitshift(input_img: np.ndarray) -> np.ndarray:
        num_dims = len(input_img.shape)
        if num_dims == 2:
            return input_img.astype(np.uint32)
        elif num_dims == 3:
            if input_img.shape[-1] == 4:
                # from cleaned
                output_np = rgba_to_int32(input_img) 
            else:
                raise ValueError(f'Image has {input_img.shape[-1]} channels')
            return output_np
        else:
            raise ValueError(f'Image has {num_dims} dimensions')
        
    @classmethod
    def from_image(cls, image: Optional[Union[Image.Image, np.ndarray]], idx: int) -> SegImageFrame:
        is_corrupt = False
        if image is not None:
            image = SegImageFrame._maybe_bitshift(np.array(image))
            if not SegImageFrame._check_contiguous(np.array(image)):
                print(f'Non-contiguous image found: {np.unique(np.array(image))}')
                image = None
                is_corrupt = True
        return cls(None, idx, image, is_corrupt)
        
    def get_num_segments(self) -> torch.Tensor:
        return np.max(self.image_data) + 1  # first index is the null seg
    
    @staticmethod 
    def _check_contiguous(arr: np.ndarray) -> bool:
        sorted_arr = np.unique(arr) # returns sorted
        return np.array_equal(sorted_arr, np.arange(sorted_arr.min(), sorted_arr.max() + 1))
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'path': self.path,
            'idx': self.idx,
            'image_data': self.image_data,
            'svg': self.svg.to_str() if self.svg is not None else None,
        }
        
    def from_dict(data: Dict[str, Any]) -> SegImageFrame:
        from colorize.vectorization.lib.svg import SVG
        return SegImageFrame(
            path=data['path'],
            idx=data['idx'],
            image_data=Image.fromarray(data['image_data']),
            svg=SVG.from_str(data['svg']) if data['svg'] is not None else None,
        )
    
    def render_as_image(
        self,
        color_list: List[int],
        null_color_rgba: Tuple[int, int, int, int] = (0, 0, 0, 0)
    ) -> np.ndarray:
        null_color_dense = rgba_to_dense_flat(np.array(null_color_rgba))
        lookup = np.array(color_list)
        null_mask = self.image_data == -100
        # -100 is the pad sentinel from prepare_image; substitute a safe
        # in-range index before the gather so numpy doesn't IndexError,
        # then overwrite those pixels with null_color_dense below.
        safe_image_data = np.where(null_mask, 0, self.image_data)
        color_image_int32 = lookup[safe_image_data]
        color_image_int32[null_mask] = null_color_dense
        return dense_to_rgba(color_image_int32).astype(np.uint8)

    def render_as_svg(self, color_list: List[int]) -> Image:
        for path, seg_color in zip(self.svg.paths, color_list):
            if seg_color == -100:
                path.set_stroke_color_rgba([0, 0, 0, 0])
            else:
                path.set_stroke_color_rgba(list(dense_to_rgba(seg_color)))
        return self.svg


class ColorImageFrame(ImageFrame):
    
    def __init__(
        self,
        path: str,
        idx: int,
        image: Optional[Union[Image.Image, np.ndarray]],
        is_corrupt: bool = False,
    ) -> ColorImageFrame:
        super().__init__(path, idx, image, is_corrupt)

    @classmethod    
    def from_file(cls, path: str) -> ColorImageFrame:
        image, is_corrupt = cls._read_img(path)
        if image is not None:
            image = ImageFrame._maybe_convert_to_rgba(np.array(image))
        idx = path_to_idx(path)
        return cls(path, idx, image, is_corrupt) 

    @staticmethod 
    def from_seg_and_color_list(seg_frame: SegImageFrame, color_list: Optional[List[int]] = None) -> ColorImageFrame:
        color_path = None
        if color_list is not None:
            color_rgba = seg_frame.render_as_image(color_list)
        else:
            color_rgba = np.concatenate(
                [
                    np.random.randint(0, 255, (np.max(seg_frame) + 1, 3), dtype=np.uint8),
                    np.ones((1, 3), dtype=np.uint8) * 255
                ],
                axis=-1
            )
        return ColorImageFrame(color_path, seg_frame.idx, color_rgba, False)

    @classmethod
    def from_image(cls, image: Optional[Union[Image.Image, np.ndarray]], idx: int) -> ColorImageFrame:
        if image is not None:
            image = ImageFrame._maybe_convert_to_rgba(np.array(image))
        return cls(None, idx, image, False)
        

class LineImageFrame(ImageFrame):
    
    def __init__(
        self, 
        path: str, 
        idx: int, 
        image: Optional[Union[Image.Image, np.ndarray]], 
        is_corrupt: bool = False,
    ) -> LineImageFrame:
        if image is not None:
            self.image_data = np.array(image)
            binarized_image = binarize(self.image_data, type='adaptive_mean')
            self.binarized_image_data = 1 - (binarized_image / 255).astype(np.uint8)
        super().__init__(path, idx, image, is_corrupt)

    @classmethod    
    def from_file(cls, path: str) -> LineImageFrame:
        image, is_corrupt = cls._read_img(path)
        if image is not None:
            image = ImageFrame._maybe_convert_to_rgba(np.array(image))
        idx = path_to_idx(path)
        return cls(path, idx, image, is_corrupt) 
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'path': self.path,
            'idx': self.idx,
            'image_data': self.image_data,
            'binarized_image_data': self.binarized_image_data,
        }
        
    def from_dict(data: Dict[str, Any]) -> LineImageFrame:
        return LineImageFrame(data['path'], data['idx'], Image.fromarray(data['image_data']))
    

@dataclass
class KeyFrame:
    
    seg_path: str
    line_path: str
    color_path: str

    color_list: List[int]
    idx: int 
    stats: Dict[str, int]
    
    @staticmethod 
    def from_frames(
        seg_frame: SegImageFrame,
        line_frame: LineImageFrame,
        color_frame: ColorImageFrame,
    ) -> KeyFrame:
        color_list, stats = KeyFrame.compute_color_list(seg_frame, color_frame, line_frame)
        idx = seg_frame.idx
        keyframe = KeyFrame(
            seg_path=seg_frame.path, 
            line_path=line_frame.path,
            color_path=color_frame.path,
            color_list=color_list,
            idx=idx,
            stats=stats,
        )
        return keyframe
    
    @staticmethod 
    def compute_color_list(
        seg_frame: SegImageFrame,
        color_frame: ColorImageFrame,
        line_frame: Optional[LineImageFrame] = None,
        parallel: bool = False,
        max_workers: Optional[int] = None,
    ) -> Tuple[List[int], Dict[str, int]]:
        """
        Compute the dominant color for each segment.
        
        Args:
            seg_frame: Segmentation frame
            color_frame: Color frame (RGBA)
            line_frame: Optional line frame for masking
            parallel: If True, use thread pool for parallel processing
            max_workers: Max threads for parallel mode (default: min(32, num_segments))
            
        Returns:
            Tuple of (color_list, stats dict)
        """
        line_binarized_data = line_frame.binarized_image_data if line_frame is not None else None
        line_image_data = line_frame.image_data if line_frame is not None else None
        
        compute_fn = compute_color_list_parallel if parallel else compute_color_list_serial
        
        kwargs = dict(
            seg_image_data=seg_frame.image_data,
            color_image_data=color_frame.image_data,
            line_binarized_data=line_binarized_data,
            line_image_data=line_image_data,
            num_segments=seg_frame.get_num_segments(),
        )
        
        if parallel:
            kwargs['max_workers'] = max_workers
            
        return compute_fn(**kwargs)

    def to_dict(self) -> Dict[str, Any]:
        out = {
            'seg_path': self.seg_path,
            'line_path': self.line_path,
            'color_path': self.color_path,
            'color_list': self.color_list,
            'idx': self.idx,
            'stats': self.stats,
        }
        return out
    
    @staticmethod 
    def from_dict(data: Dict[str, Any]) -> KeyFrame:
        return KeyFrame(
            seg_path=data['seg_path'],
            image_path=data['image_path'],
            color_path=data['color_path'],
            color_list=data['color_list'],
            idx=data['idx'],
            stats=data['stats'],
        )


class MaterializedKeyFrame(KeyFrame):

    def __init__(
        self,
        seg_frame: SegImageFrame,
        line_frame: LineImageFrame,
        color_frame: Optional[ColorImageFrame] = None,
        **kwargs
    ):
        super().__init__(**kwargs)
        self.seg_frame = seg_frame
        self.line_frame = line_frame
        self.color_frame = color_frame

    @staticmethod
    def from_frames(
        seg_frame: SegImageFrame,
        line_frame: LineImageFrame,
        color_frame: Optional[ColorImageFrame] = None,
        color_list: Optional[List[int]] = None,
    ) -> MaterializedKeyFrame:
        assert color_frame is not None or color_list is not None, "Must provide either color_frame or color_list"
        if color_list is None:
            color_list, _ = KeyFrame.compute_color_list(seg_frame, color_frame, line_frame)
        idx = seg_frame.idx
        return MaterializedKeyFrame(
            seg_path=seg_frame.path,
            line_path=line_frame.path,
            color_path=color_frame.path if color_frame is not None else None,
            color_list=color_list,
            stats=None,
            idx=idx,
            seg_frame=seg_frame,
            line_frame=line_frame,
            color_frame=color_frame,
        )

    @staticmethod
    def from_keyframe(
        keyframe: KeyFrame,
        color_source: Literal['file', 'color_list', 'empty'] = 'color_list',
    ) -> MaterializedKeyFrame:
        seg_frame = SegImageFrame.from_file(keyframe.seg_path)
        line_frame = LineImageFrame.from_file(keyframe.line_path)
        if color_source == 'color_list':
            color_frame = ColorImageFrame.from_seg_and_color_list(seg_frame, keyframe.color_list)
        elif color_source == 'file':
            color_frame = ColorImageFrame.from_file(keyframe.color_path)
        else:
            color_frame = None

        return MaterializedKeyFrame.from_frames(
            seg_frame=seg_frame,
            line_frame=line_frame,
            color_frame=color_frame,
            color_list=keyframe.color_list,
        )

    def render_color_image(self, null_color_rgba: Tuple[int, int, int, int] = (0, 0, 0, 0)) -> np.ndarray:
        return self.seg_frame.render_as_image(self.color_list, null_color_rgba)


class Palette:
    
    def __init__(
        self,
        color_list: List[int] = None,
        frame_idx_to_color_ids: Dict[str, List[int]] = None # frame idx -> list of indices into the color list for each seg id
    ) -> Palette:
        self.color_list = [] if color_list is None else color_list
        self.frame_idx_to_color_ids = {} if frame_idx_to_color_ids is None else frame_idx_to_color_ids
    
    def add_frame_colors(self, frame: KeyFrame) -> None:
        color_ids = []
        for color in frame.color_list:
            # palette has no duplicates but color ids are not unique
            if color not in self.color_list:
                self.color_list.append(color)

            if color != -100:
                color_ids.append(self.color_list.index(color))
            else:
                color_ids.append(-100)

        self.frame_idx_to_color_ids[str(frame.idx)] = color_ids

    def add_frame_colors_uniquely(self, frame: KeyFrame) -> None:
        color_ids = []
        for i, color in enumerate(frame.color_list):
            # palette has duplicates but color ids are unique
            self.color_list.append(color)

            if color != -100:
                color_ids.append(i)
            else:
                color_ids.append(-100)

        self.frame_idx_to_color_ids[str(frame.idx)] = color_ids

    def color_ids_to_dense_colors(self, color_ids: List[int], null_color_dense: int = -100) -> List[int]:
        return [
            int(self.color_list[color_id]) if color_id != -100 else null_color_dense
            for color_id in color_ids
        ]
    
    def color_ids_to_colors(self, color_ids: List[int]) -> List[Tuple[int, int, int, int]]:
        color_ids_dense = self.color_ids_to_dense_colors(color_ids, null_color_dense=-100)
        return [
            dense_to_rgba_flat(color_id_dense) if color_id_dense != -100 else [-100, -100, -100, -100]
            for color_id_dense in color_ids_dense
        ]
    
    def get_color_id_list_for_frame(self, frame_idx: int) -> List[int]:
        # at some point -1 was allowed into the palette, which ends means the color_ids for that index
        # get mapped to the -1 index in the palette.
        # this may create issues because the dense color will be -100 but the color_id will be valid which means
        # the model will try to predict it.
        # instead we need to make the color_ids for that index be -100
        color_ids = self.frame_idx_to_color_ids[str(frame_idx)]

        if -1 in self.color_list:
            new_color_ids = []
            null_index = self.color_list.index(-1)
            for color_id in color_ids:
                if color_id == null_index:
                    new_color_ids.append(-100)
                else:
                    new_color_ids.append(color_id)
            color_ids = new_color_ids
        
        return color_ids


@dataclass
class SequenceStats:
    
    num_empty_seg_frames: int = 0
    num_empty_color_frames: int = 0
    num_empty_line_frames: int = 0
    
    num_corrupt_seg_frames: int = 0
    num_corrupt_color_frames: int = 0
    num_corrupt_line_frames: int = 0

    valid_frame_indices: List[int] = None
