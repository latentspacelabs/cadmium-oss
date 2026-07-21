from __future__ import annotations
from dataclasses import dataclass, field
from typing import *
import pickle

import torch

from colorize.common.frame import Palette


@dataclass
class FeaturizedFrame:
    """Per-frame output of the frozen image + SVG encoders, plus metadata to
    map segments back to the scene palette.

    Tensors are stored bf16 on disk to halve IO; cast back to the model's
    compute dtype at collate time.
    """

    idx: int
    num_segments: int
    image_feats: torch.Tensor   # [S, image_embed_output_dim], bf16
    svg_feats: torch.Tensor     # [S, svg_output_embed_dim],   bf16
    color_ids: torch.Tensor     # [S], int32; -100 = null


@dataclass
class FeaturizedSequence:
    """A single (scene, augmentation_variant) pass through the frozen encoders.

    Each variant is a fully independent augmentation pass over every frame in
    the scene. The dataloader samples (N+1)-frame tuples out of `frames` at
    train time.
    """

    frames: List[FeaturizedFrame]
    palette: Palette                          # full scene palette
    variant_idx: int                          # which augmentation pass produced this pickle
    metadata: Dict[str, Any] = field(default_factory=dict)
    # metadata keys we expect (not enforced):
    #   encoder_checkpoint: str (path or hash)
    #   image_args: dict
    #   vec_args: dict
    #   aug_seed: int
    #   ingest_git_sha: str

    def save(self, path: str) -> None:
        with open(path, 'wb') as f:
            pickle.dump(self, f, protocol=pickle.HIGHEST_PROTOCOL)

    @staticmethod
    def load(path: str) -> FeaturizedSequence:
        with open(path, 'rb') as f:
            return pickle.load(f)
