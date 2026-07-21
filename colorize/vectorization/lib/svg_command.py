from __future__ import annotations
from typing import *
from enum import Enum
import numpy as np

import torch

from colorize.vectorization.lib.geom import Geom, Point, Bbox, get_roots


Num = Union[int, float]


class SVGCommandType(Enum):
    
    MOVE_TO = "M"
    CUBIC_BEZIER = "C"
    
    @property 
    def num_args(self) -> int:
        if self.value == "M":
            return 1
        elif self.value == "C":
            return 3


class SVGCommand:
    
    def __init__(self, command: SVGCommandType, args: List[Geom], start_pos: Point, end_pos: Point):
        self.command = command
        self.args = args
        self.start_pos = start_pos
        self.end_pos = end_pos

    def copy(self):
        raise NotImplementedError

    @staticmethod
    def from_str(cmd_str: str, args_str: List[Num], pos: Point) -> Tuple[List[SVGCommand], Point]:
        cmd = SVGCommandType(cmd_str)

        nb_args = len(args_str)
        expected_num_args = cmd.num_args  * 2
        assert nb_args == expected_num_args, f"Expected {expected_num_args} arguments for command {cmd_str}: {nb_args} given"

        i = 0
        args = []
        for _ in range(cmd.num_args):
            arg = Point(*args_str[i:i+2])
            args.append(arg)
            i += 2

        if cmd is SVGCommandType.MOVE_TO:
            cmd_parsed = SVGCommandMove(pos, *args)
        elif cmd is SVGCommandType.CUBIC_BEZIER:
            cmd_parsed = SVGCommandBezier(pos, *args)

        pos = cmd_parsed.end_pos

        return [cmd_parsed], pos

    def to_str(self):
        cmd = self.command.value.upper()
        return f"{cmd}{' '.join([arg.to_str() for arg in self.args])}"

    def to_tensor(self) -> torch.Tensor:
        raise NotImplementedError
     
    @staticmethod 
    def from_coords_array(arr: np.ndarray) -> SVGCommand:
        raise NotImplementedError
    
    def draw(self, *args, **kwargs):
        from .svg_path import SVGPath
        return SVGPath([self]).draw(*args, **kwargs)

    def is_left_to(self, other: SVGCommand):
        p1, p2 = self.start_pos, other.start_pos

        if p1.y == p2.y:
            return p1.x < p2.x

        return p1.y < p2.y or (np.isclose(p1.norm(), p2.norm()) and p1.x < p2.x)

    def numericalize(self, n: int =256):
        raise NotImplementedError

    @property
    def points(self):
        return [self.start_pos, self.end_pos]

    @property
    def bbox(self):
        raise NotImplementedError


class SVGCommandMove(SVGCommand):
    
    def __init__(self, start_pos: Point, end_pos: Point):
        super().__init__(SVGCommandType.MOVE_TO, [end_pos], start_pos, end_pos)
        
    def numericalize(self, n: int = 200):
        self.start_pos.numericalize(n)
        self.end_pos.numericalize(n)

    def copy(self):
        return self.__class__(self.start_pos.copy(), self.end_pos.copy())

    @property
    def bbox(self):
        return Bbox(self.end_pos, self.end_pos)

    def to_tensor(self) -> torch.Tensor:
        return torch.FloatTensor(self.end_pos.to_tensor().unsqueeze(0)) # seq, x/y dim
    
    @staticmethod 
    def from_coords_array(arr: np.ndarray) -> SVGCommand:
        return SVGCommandMove(Point(x=arr[0][0], y=arr[0][1]), Point(x=arr[1][0], y=arr[1][1]))


class SVGCommandBezier(SVGCommand):
    def __init__(self, start_pos: Point, control1: Point, control2: Point, end_pos: Point):
        super().__init__(SVGCommandType.CUBIC_BEZIER, [control1, control2, end_pos], start_pos, end_pos)
        self.control1 = control1
        self.control2 = control2

    def copy(self):
        return SVGCommandBezier(self.start_pos.copy(), self.control1.copy(), self.control2.copy(), self.end_pos.copy())

    def to_tensor(self) -> torch.Tensor:
        return torch.FloatTensor(np.stack(
            [self.control1.to_tensor(), self.control2.to_tensor(), self.end_pos.to_tensor()]
        )) # seq, x/y dim
        
    @staticmethod 
    def from_coords_array(arr: np.ndarray) -> SVGCommand:
        return SVGCommandBezier(
            start_pos=Point(x=arr[0][0], y=arr[0][1]),
            control1=Point(x=arr[1][0], y=arr[1][1]),
            control2=Point(x=arr[2][0], y=arr[2][1]),
            end_pos=Point(x=arr[3][0], y=arr[3][1])
        )

    def numericalize(self, n=256):
        self.start_pos.numericalize(n)
        self.control1.numericalize(n)
        self.control2.numericalize(n)
        self.end_pos.numericalize(n)

    @property
    def points(self):
        return [self.start_pos, self.control1, self.control2, self.end_pos]

    @property
    def bbox(self):
        return Bbox.from_points(self.find_extrema())
    
    def eval(self, t):
        return (1 - t)**3 * self.start_pos + 3 * (1 - t)**2 * t * self.control1 + 3 * (1 - t) * t**2 * self.control2 + t**3 * self.end_pos

    def find_roots(self):
        a = 3 * (-self.p1 + 3 * self.q1 - 3 * self.q2 + self.p2)
        b = 6 * (self.p1 - 2 * self.q1 + self.q2)
        c = 3 * (self.q1 - self.p1)

        x_roots, y_roots = get_roots(a.x, b.x, c.x), get_roots(a.y, b.y, c.y)
        roots_cat = [*x_roots, *y_roots]
        roots = [root for root in roots_cat if 0 <= root <= 1]
        return roots

    def find_extrema(self):
        points = [self.start_pos, self.end_pos]
        points.extend([self.eval(root) for root in self.find_roots()])
        return points
