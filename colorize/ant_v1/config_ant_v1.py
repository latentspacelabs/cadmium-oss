from typing import *

from transformers.configuration_utils import PretrainedConfig

class AnTV1Config(PretrainedConfig):
    
    model_type = "AnT-v1"

    def __init__(
        self,
        
        corr_temperature: float = 0.1,
        max_segments: int = 512,
        cycle_weight: float = 0.5,
        dift_weight: float = 0.0,

        fusion_embed_dim: int = 512,
        fusion_num_layers: int = 4,
        fusion_num_heads: int = 8,

        gnn_embed_dim: int = 512,
        gnn_layer_type_list: List[str] = ["cross"] * 2,
        gnn_num_heads: int = 4,

        svg_input_embed_dim: int = 512,
        svg_max_seq_length: int = 256,
        svg_num_layers = 3,
        svg_output_embed_dim = 512,

        image_enc_resolution: int = 1024,
        image_embed_output_dim: int = 512,

        **kwargs,
    ):
        super().__init__(**kwargs) 
        
        self.corr_temperature = corr_temperature
        self.max_segments = max_segments
        self.cycle_weight = cycle_weight
        self.dift_weight = dift_weight

        # fusion
        self.fusion_embed_dim = fusion_embed_dim
        self.fusion_num_layers = fusion_num_layers
        self.fusion_num_heads = fusion_num_heads

        # gnn
        self.gnn_embed_dim = gnn_embed_dim
        self.gnn_layer_type_list = gnn_layer_type_list
        self.gnn_num_heads = gnn_num_heads
        
        # svg features
        self.svg_input_embed_dim = svg_input_embed_dim
        self.svg_max_seq_length = svg_max_seq_length
        self.svg_num_layers = svg_num_layers
        self.svg_output_embed_dim = svg_output_embed_dim

        # image
        self.image_enc_resolution = image_enc_resolution
        self.image_embed_output_dim = image_embed_output_dim
