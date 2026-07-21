from typing import *

import os
import re


class EmptySceneError(Exception):
    pass


def path_to_idx(path: str) -> int:
    filename = os.path.basename(path)
    # 007A.png --> 007A
    match = re.search(r'(\d+)([a-zA-Z])?(?=\.png)', filename)
    idx = remove_letter_from_integer_string(match.group())
    return idx


def remove_letter_from_integer_string(s):
    # Use regular expression to match an optional letter at the end of the string
    match = re.match(r'(\d+)[a-zA-Z]?$', s)
    # Extract the integer part
    integer_part = match.group(1)
    # Convert the integer part to an integer and return
    return int(integer_part)


def align_frames(
    seg_path_frame_nums: List[int],
    color_path_frame_nums: List[int],
    line_path_frame_nums: List[int],
):
    shared_frame_nums = set(color_path_frame_nums).intersection(set(seg_path_frame_nums)).intersection(set(line_path_frame_nums))
    shared_frame_nums = sorted(list(shared_frame_nums))
    
    if len(shared_frame_nums) == 0:
        raise EmptySceneError('No shared frames found')
    
    if len(shared_frame_nums) == 1:
        raise EmptySceneError('Only one shared frame found')
    
    seg_indices = [seg_path_frame_nums.index(frame_num) for frame_num in shared_frame_nums]
    color_indices = [color_path_frame_nums.index(frame_num) for frame_num in shared_frame_nums]
    line_indices = [line_path_frame_nums.index(frame_num) for frame_num in shared_frame_nums]
    
    return seg_indices, color_indices, line_indices
        