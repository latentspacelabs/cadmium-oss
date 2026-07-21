from __future__ import annotations
from typing import *
import os
import io
import random
from xml.dom import expatbuilder
import tempfile

import cairosvg
import torch
from PIL import Image
import numpy as np

from colorize.vectorization.lib.svg_path import SVGPath
from colorize.vectorization.lib.geom import union_bbox, Bbox, Point, Angle


class SVG:
    """
    Represents an SVG created by vtracer, which is a collection of SVG paths.
    
    Limitations: 
    - only paths (no circles, rectangles, etc)
    - path commands: only move to and curve
        - assumes all paths closed
        - every path must start with move to
        - does not support the combined move to and line to command
        - does not support repeated syntax (eg. omitting the command between repeated sequences)
    - no svg groups (i.e. <g>)
    - no viewbox (uses width/height instead)
    - the SVG "Transform" tag is supported on import but we immediately apply it to the path
    
    Core methods:
    - to/from string
    - to/from points (combine x,y along channels)
    - draw
    - transforms (rotate, scale, etc)
    - sorting
    """
    
    def __init__(self, paths: List[SVGPath], viewbox: Bbox):
        self.paths = paths
        self.viewbox = viewbox
        self.id_map = None

    def copy(self) -> SVG:
        return SVG([path.copy() for path in self.paths], self.viewbox.copy())

    @staticmethod
    def load_svg(file_path: str) -> SVG:
        with open(file_path, "r") as f:
            return SVG.from_str(f.read())

    @staticmethod
    def from_str(svg_str: str) -> SVG:
        svg_dom = expatbuilder.parseString(svg_str, False)
        svg_nodes = svg_dom.getElementsByTagName('svg')
        
        if len(svg_nodes) > 1:
            raise ValueError('Too many <svg> tags found')
        
        svg_root_node = svg_nodes[0] 
        path_nodes = svg_root_node.getElementsByTagName("path")

        width = int(float(svg_root_node.getAttribute("width")))
        height = int(float(svg_root_node.getAttribute("height")))
        viewbox_list = [0, 0, width, height]
        view_box = Bbox(*viewbox_list)

        paths = []
        for p in path_nodes:
            paths.append(SVGPath.from_xml(p))
            
        svg = SVG(paths, view_box)
        # assert svg.all_paths_closed, 'Not all paths are closed'
        # if not svg.all_paths_closed:
        #     print(f'Found unclosed path')

        return svg
    
    def to_tensor(
        self,
        pad_val: int = -100,
        normalize: bool = True,
        return_point_dim: bool = True,
    ) -> torch.Tensor:
        if self.id_map is None:
            path_tensors = [p.to_tensor() for p in self.paths]
            return self._to_tensor(path_tensors, pad_val, normalize, return_point_dim)
        else:
            return self._to_tensor_with_id_map(pad_val, normalize, return_point_dim)
    
    def _to_tensor(
        self,
        path_tensors: List[torch.Tensor],
        pad_val: int = -100,
        normalize: bool = True,
        return_point_dim: bool = True,
    ) -> torch.Tensor:
        target_shape = max([t.shape[0] if t is not None else 0 for t in path_tensors])
        padded_path_tensors = []
        for i, t in enumerate(path_tensors):
            if t is None:
                print(f"SVG: Inserting null path at index {i}")
                t = torch.LongTensor([[[pad_val, pad_val]] * 3] * target_shape)
            else:
                if normalize:
                    t = torch.stack([
                        t[:, :, 0] / self.viewbox.wh.x,
                        t[:, :, 1] / self.viewbox.wh.y
                    ], axis=-1)
                t = torch.cat([t, torch.LongTensor([[[pad_val, pad_val]] * 3] * (target_shape - t.shape[0]))])
            padded_path_tensors.append(t)
        # [commands, control points, 2]
        if not return_point_dim:
            # [commands, control points x 2]
            padded_path_tensors = [t.view(t.shape[0], -1) for t in padded_path_tensors]
        return torch.stack(padded_path_tensors) 

    def _to_tensor_with_id_map(
        self,
        pad_val: int = -100,
        normalize: bool = True,
        return_point_dim: bool = True,
    ) -> torch.Tensor:
        path_tensors = []
        original_ids = sorted(self.id_map.keys())
        offset = 0
        for original_id in original_ids:
            new_id = self.id_map[original_id]  # contiguous
            if new_id is None:
                path_tensors.append(None)
                offset += 1
            else:
                path_tensor = self.paths[new_id].to_tensor()
                path_tensors.append(path_tensor)
        return self._to_tensor(path_tensors, pad_val, normalize, return_point_dim)
        
    @staticmethod
    def from_tensor(
        svg_tensor: torch.Tensor,
        viewbox: Bbox
    ) -> SVG:
        # TODO: handle normalized case
        assert len(svg_tensor.shape) == 4  # path, commands, control points, x/y dim
        svg = SVG([SVGPath.from_tensor(t) for t in svg_tensor], viewbox)
        return svg

    def save_svg(self, file_path: str):
        with open(file_path, "w") as f:
            f.write(self.to_str())

    def draw(self, random_colors: bool = False) -> Image:
        if random_colors:
            self.set_color("random")
        png_data = cairosvg.svg2png(bytestring=self.to_str(fill=False))
        return Image.open(io.BytesIO(png_data))

    def to_str(self, fill: bool = True) -> str:
        newline = "\n"
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.viewbox.wh.x}" height="{self.viewbox.wh.y}">'
            f'{newline.join(path.to_str(fill=fill) for path in [*self.paths])}'
            '</svg>')

    def _apply_to_paths(self, method, *args, **kwargs) -> SVG:
        for path in self.paths:
            getattr(path, method)(*args, **kwargs)
        return self

    def translate(self, vec: Point) -> SVG:
        return self._apply_to_paths("translate", vec)

    def rotate(self, angle: Angle, center: Point = None) -> SVG:
        if center is None:
            center = self.viewbox.center
        self.translate(-self.viewbox.center)
        self._apply_to_paths("rotate", angle)
        self.translate(center)
        return self

    def zoom(self, factor, center: Point = None) -> SVG:
        if center is None:
            center = self.viewbox.center
        self.translate(-self.viewbox.center)
        self._apply_to_paths("scale", factor)
        self.translate(center)
        return self
    
    def vflip(self) -> SVG:
        self.translate(-self.viewbox.center)
        return self

    def normalize(self, viewbox: Bbox = None) -> SVG:
        size = self.viewbox.size
        scale_factor = viewbox.size.min() / size.max()
        self.zoom(scale_factor, viewbox.center)
        self.viewbox = viewbox
        return self

    def reorder(self) -> SVG:
        return self._apply_to_paths("reorder")

    def numericalize(self, n: int = 100) -> SVG:
        self.normalize(viewbox=Bbox(n))
        return self._apply_to_paths("numericalize", n)

    @property
    def bbox(self) -> Bbox:
        return union_bbox([path.bbox for path in self.paths])
    
    @property 
    def all_paths_closed(self) -> bool:
        all_closed = True
        for path in self.paths:
            if not path.is_closed:
                all_closed = False
        return all_closed

    def permute(self, indices: List[int]) -> SVG:
        self.paths = [self.paths[i] for i in indices]
        return self

    def canonicalize(self, normalize: bool = False) -> SVG:
        if normalize:
            self.normalize()
        # for each path, reorder so the first command is the top-leftmost
        self._apply_to_paths("reorder")
        # now sort commands based on position of the first command
        self.svg_paths = sorted(self.paths, key=lambda x: x.start_pos.tolist()[::-1])
        self.numericalize(100)
        return self

    def set_color(self, color: Union[str, List[str]]) -> SVG:
        colors = ["deepskyblue", "lime", "deeppink", "gold", "coral", "darkviolet", "royalblue", "darkmagenta", "teal",
                  "gold", "green", "maroon", "aqua", "grey", "steelblue", "lime", "orange"]

        if color == "random_random":
            random.shuffle(colors)

        if isinstance(color, list):
            colors = color

        for i, path in enumerate(self.paths):
            if color == "random" or color == "random_random" or isinstance(color, list):
                c = colors[i % len(colors)]
            else:
                c = color
            path.stroke_color = c
        return self
