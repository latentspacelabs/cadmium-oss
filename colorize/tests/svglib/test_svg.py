from glob import glob
import os

import pytest

from colorize.vectorization.lib.svg import SVG


all_test_svgs = glob('./colorize/tests/svglib/test_input/*.svg')
colorizer_test_svgs = [svg for svg in all_test_svgs if "line" not in svg]
out_dir = "./colorize/tests/svglib/test_output"
display = True


def check_svg_str_eq(new_str: str, orig_str: str):
    svg_str_clean = new_str.replace(".0 ", " ").replace(".0\"", "\"").replace("\n", "")
    orig_str_clean = orig_str.replace(".0 ", " ").replace(".0\"", "\"").replace("\n","") 
    assert svg_str_clean == orig_str_clean, f"SVG strings are not equal:\n{svg_str_clean}\n{orig_str_clean}"


@pytest.mark.parametrize('svg_path', all_test_svgs)
def test_svg_from_file(svg_path):
    svg = SVG.load_svg(svg_path)
    if display:
        out_name = os.path.basename(svg_path).replace(".svg", ".png")
        svg.draw().save(os.path.join(out_dir, out_name))
    check_svg_str_eq(svg.to_str(), open(svg_path).read())
    

@pytest.mark.parametrize('svg_path', colorizer_test_svgs)
def test_svg_to_tensor_coords(svg_path):
    svg = SVG.load_svg(svg_path)
    coords_tensor = svg.to_tensor(normalize=False)
    svg2 = SVG.from_tensor(coords_tensor, svg.viewbox)
    check_svg_str_eq(svg.to_str(), svg2.to_str())
