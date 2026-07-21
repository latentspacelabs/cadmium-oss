from __future__ import annotations
from typing import *
import re
from xml.dom import minidom

import torch
import numpy as np

from colorize.vectorization.lib.geom import union_bbox, Point, Bbox
from colorize.vectorization.lib.svg_command import SVGCommand, SVGCommandMove, SVGCommandBezier, SVGCommandType
from colorize.vectorization.lib.utils import contains_only_fp


COMMANDS = "MZC"
COMMAND_RE = re.compile(r"([MZC])")
FLOAT_RE = re.compile(r"[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?")


class SVGPath:
    
    def __init__(self, path_commands: List[SVGCommand]):
        self.path_commands = path_commands
        self.stroke_color = None

    @property
    def start_pos(self) -> Point:
        return self.path_commands[0].end_pos

    @property
    def end_pos(self) -> Point:
        return self.path_commands[-1].end_pos
    
    @property
    def bbox(self) -> Bbox:
        return union_bbox([cmd.bbox for cmd in self.path_commands])

    def copy(self) -> SVGPath:
        return SVGPath(path_commands=[path_command.copy() for path_command in self.path_commands])

    @staticmethod
    def from_xml(x: minidom.Element) -> SVGPath:
        s = x.getAttribute('d')
        if s == "":
            return SVGPath([])
        transform = x.getAttribute('transform')
        path = SVGPath.from_str(s)
        if transform != "":
            translate = SVGPath._parse_transform(transform)
            path.translate(translate)
        return path

    @staticmethod
    def from_str(s: str) -> SVGPath:
        path_commands = []
        pos = Point(0.)
        for cmd, args in SVGPath.split_path_str(s):
            cmd_parsed, pos = SVGCommand.from_str(cmd, args, pos)
            path_commands.extend(cmd_parsed)
        assert path_commands[0].command == SVGCommandType.MOVE_TO
        return SVGPath(path_commands)

    @staticmethod
    def _parse_transform(transform: str) -> Tuple[str, List[float]]:
        if transform.startswith("translate"):
            points = transform.strip().replace("translate(", "").replace(")", "").split(",")
            if len(points) == 2:
                number1 = float(points[0])
                number2 = float(points[1])
                return Point(number1, number2)
            else:
                raise ValueError(f"Invalid translate: {transform}")
        else:
            raise NotImplementedError(f"Transform {transform} not supported")

    @staticmethod
    def split_path_str(path_str):
        cmd = None
        for x in COMMAND_RE.split(path_str):
            if x == "":
                continue
            elif x and x in COMMANDS:
                cmd = x
            elif not contains_only_fp(x):
                raise ValueError(f"Invalid path command: {x}")
            else:
                coords = FLOAT_RE.findall(x)
                if cmd is not None and len(coords) > 0:
                    yield cmd, list(map(float, coords))
    
    def to_str(self, fill: bool = True) -> str:
        cmds = " ".join(command.to_str() for command in self.path_commands)
        if fill:
            return f'<path d="{cmds}"/>'
        else:
            return f'<path d="{cmds}" fill="none" stroke="{self.stroke_color}" stroke-width="2"/>'
    
    def to_tensor(self) -> torch.Tensor:
        if len(self.path_commands) == 0:
            return torch.zeros([0, 3, 2])
        cmd_tensors = []
        for command in self.path_commands:
            cmd_tensor = command.to_tensor()
            if cmd_tensor.shape[0] < 3:
                cmd_tensor = torch.cat([cmd_tensor, torch.zeros([3-cmd_tensor.shape[0], 2], dtype=cmd_tensor.dtype)])
            elif cmd_tensor.shape[0] > 3:
                raise AssertionError
            cmd_tensors.append(cmd_tensor)
        return torch.stack(cmd_tensors)  # cmds x control points x x/y
    
    @staticmethod
    def from_tensor(path_tensor: torch.Tensor) -> SVGPath:
        # path tensor is cmds x control points x x/y
        cmds = []
        start_point = np.expand_dims(Point(0, 0).pos, axis=0)
        move_to = SVGCommandMove.from_coords_array(
            arr=np.concatenate([start_point, path_tensor[:1, 0, :].numpy()])
        )
        cmds.append(move_to)
        start_pos = path_tensor[:1, 0, :]
        for i in range(1, len(path_tensor)):
            cmd_coords = path_tensor[i].numpy()
            arr_with_start = np.concatenate([start_pos, cmd_coords])
            cmds.append(SVGCommandBezier.from_coords_array(arr_with_start))
            start_pos = cmd_coords[-1:]
        return SVGPath(cmds)

    # TODO: can we move this and just make sure things are unique to start with?
    def _get_unique_points(self) -> List[Point]:
        geoms = []
        for command in self.path_commands:
            geoms.extend(command.points)
        return list(set(geoms))

    def translate(self, vec: Point) -> SVGPath:
        for geom in self._get_unique_points():
            geom.translate(vec)
        return self

    def rotate(self, angle: float) -> SVGPath:
        for geom in self._get_unique_points():
            geom.rotate_(angle)
        return self

    def scale(self, factor: float) -> SVGPath:
        for geom in self._get_unique_points():
            geom.scale(factor)
        return self

    @property
    def is_closed(self) -> bool:
        if not self.start_pos.isclose(self.end_pos):
            return False
        return True

    def _get_topleftmost_command(self) -> SVGPath:
        topleftmost_cmd = None
        topleftmost_idx = 0

        for i, cmd in enumerate(self.path_commands):
            if topleftmost_cmd is None or cmd.is_left_to(topleftmost_cmd):
                topleftmost_cmd = cmd
                topleftmost_idx = i

        return topleftmost_cmd, topleftmost_idx

    def reorder(self) -> SVGPath:
        topleftmost_cmd, topleftmost_idx = self._get_topleftmost_command()
        self.path_commands = [
            *self.path_commands[topleftmost_idx:],
            *self.path_commands[:topleftmost_idx]
        ]
        return self

    def numericalize(self, n: int = 256):
        for command in self.path_commands:
            command.numericalize(n)

    def set_stroke_color_rgba(self, rgba: List[int]):
        rgba_str = f"rgba({rgba[0]}, {rgba[1]}, {rgba[2]}, {rgba[3]})"
        self.stroke_color = rgba_str
        
