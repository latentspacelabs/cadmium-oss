from typing import *

from transformers.configuration_utils import PretrainedConfig


class AnTV2Config(PretrainedConfig):
    
    model_type = "AnT-v2"

    def __init__(
        self,

        max_segments: int = 512,

        # svg
        svg_max_seq_length: int = 256,

        # embeddings
        color_embeds_feature_dim: int = 256,
        frame_embeds_feature_dim: int = 256,
        palette_idx_embedding_dim: int = 256,

        # decoder
        decoder_embed_dim: int = 1024,
        decoder_num_layers: int = 16,
        decoder_num_heads: int = 16,
        decoder_max_position_embeddings: int = 2048,

        # lm head
        max_palette_size: int = 512,

        **kwargs,
    ):
        super().__init__(**kwargs) 

        self.max_segments = max_segments


        self.svg_max_seq_length = svg_max_seq_length

        # embeddings
        self.color_embeds_feature_dim = color_embeds_feature_dim
        self.frame_embeds_feature_dim = frame_embeds_feature_dim
        self.palette_idx_embedding_dim = palette_idx_embedding_dim

        # decoder
        self.decoder_embed_dim = decoder_embed_dim
        self.decoder_num_layers = decoder_num_layers
        self.decoder_num_heads = decoder_num_heads
        self.decoder_max_position_embeddings = decoder_max_position_embeddings

        # lm head
        self.max_palette_size = max_palette_size
