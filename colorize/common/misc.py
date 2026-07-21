from typing import *

import numpy as np
import torch
import psutil
from colorize.common.ops import dense_to_rgba


def to_colored_text(rgba_color: List[int], text: str) -> str:
    # Ensure the input is a valid RGBA tuple
    if len(rgba_color) != 4:
        raise ValueError("RGBA color must be a valid tuple with values in the range [0, 255]")

    # Convert RGBA to ANSI escape code for text color
    ansi_color = "\033[38;2;{};{};{}m".format(*rgba_color)

    # Reset color after printing text
    reset_color = "\033[0m"

    # Print colored text
    return "{}{}{}".format(ansi_color, text, reset_color)
    

def color_list_to_colored_text(color_list: List[int]) -> str:
    print_str = ""
    for color in sorted(color_list):
        if color == -1:
            continue
        color_rgba = dense_to_rgba(color)
        print_str += to_colored_text(color_rgba, u"\u2588")
    return print_str


def color_counts_to_colored_text(color_counts: Dict[int, int]) -> str:
    print_str = ""
    for color, count in color_counts.items():
        color_rgba = dense_to_rgba(color)
        color_text = to_colored_text(color_rgba, u"\u2588")
        print_str += f'{color_text}: {count}, '
    return print_str


def peakiness_score(distribution):
    # Normalize the distribution
    distribution = np.array(distribution)
    distribution = distribution / np.sum(distribution)
    
    # Calculate the mean
    mean = np.mean(distribution)
    
    # Calculate the variance
    variance = np.mean((distribution - mean)**2)
    
    # Calculate the kurtosis (using a simplified formula)
    kurtosis = np.mean((distribution - mean)**4) / (variance**2)
    
    return kurtosis


def deterministic_shuffle(
    arrs: List[List[torch.Tensor]],
    seed: int,
    undo: bool = False,
) -> List[List[torch.Tensor]]:
    np.random.seed(seed)
    perm_arrs = []
    for arr in arrs:
        p = np.random.permutation(arr.shape[-1])
        if undo:
            p = np.argsort(p)
        perm_arrs.append(arr[..., p])
    return perm_arrs

def print_free_memory():
    memory_info = psutil.virtual_memory()
    free_memory = memory_info.available / (1024 ** 3)  # Convert bytes to GB
    print(f"Free memory: {free_memory:.2f} GB")
