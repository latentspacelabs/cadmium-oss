import math
import re
import numpy as np
import IPython.display as ipd
# from moviepy.editor import ImageClip, concatenate_videoclips, ipython_display

from colorize.vectorization.lib.geom import Bbox, Point


def make_grid(svgs, num_cols=3, grid_width=24):
    from .svg import SVG
    nb_rows = math.ceil(len(svgs) / num_cols)
    grid = SVG([], viewbox=Bbox(grid_width * num_cols, grid_width * nb_rows))

    for i, svg in enumerate(svgs):
        row, col = i // num_cols, i % num_cols
        svg = svg.copy().translate(Point(grid_width * col, grid_width * row))

        grid.add_path_groups(svg.svg_path_groups)

    return grid


def make_grid_grid(svg_grid, grid_width=24):
    from .svg import SVG
    nb_rows = len(svg_grid)
    num_cols = len(svg_grid[0])
    grid = SVG([], viewbox=Bbox(grid_width * num_cols, grid_width * nb_rows))

    for i, row in enumerate(svg_grid):
        for j, svg in enumerate(row):
            svg = svg.copy().translate(Point(grid_width * j, grid_width * i))

            grid.add_path_groups(svg.svg_path_groups)

    return grid


def make_grid_lines(svg_grid, grid_width=24):
    from .svg import SVG
    nb_rows = len(svg_grid)
    num_cols = max(len(r) for r in svg_grid)
    grid = SVG([], viewbox=Bbox(grid_width * num_cols, grid_width * nb_rows))

    for i, row in enumerate(svg_grid):
        for j, svg in enumerate(row):
            j_shift = (num_cols - len(row)) // 2
            svg = svg.copy().translate(Point(grid_width * (j + j_shift), grid_width * i))

            grid.add_path_groups(svg.svg_path_groups)

    return grid


COLORS = ["aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
          "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
          "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
          "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
          "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
          "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia",
          "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink",
          "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
          "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
          "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey",
          "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
          "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen",
          "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite",
          "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
          "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple",
          "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna",
          "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan", "teal",
          "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen"]


def contains_only_fp(input_string):
    pattern = r'^[0-9\s.-]+$'
    return bool(re.match(pattern, input_string))


def split_list_by_value(lst, x):
    result = []
    chunk = []

    for item in lst:
        if item == x:
            if chunk:
                result.append(chunk)
                chunk = []
        else:
            chunk.append(item)

    if chunk:
        result.append(chunk)

    return result
