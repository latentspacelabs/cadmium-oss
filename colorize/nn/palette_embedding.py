import torch
import torch.nn as nn

class PaletteEmbedding(torch.nn.Module):

    def __init__(
        self,
        embed_dim: int,
        max_palette_size: int,
    ):
        super().__init__()
        self.max_palette_size = max_palette_size

        self.palette_idx_embedding = torch.nn.Embedding(
            num_embeddings=max_palette_size + 1,
            embedding_dim=embed_dim,
            padding_idx=max_palette_size,
        )

    def __call__(
        self,
        color_ids: torch.LongTensor,
        color_prompt_mask: torch.BoolTensor,
    ) -> torch.FloatTensor:
        null_color_id = torch.tensor([self.max_palette_size], device=color_ids.device).long()
        prompt_color_ids = torch.where(
            color_prompt_mask,
            color_ids,
            null_color_id.unsqueeze(0).expand_as(color_ids)
        )

        return self.palette_idx_embedding(prompt_color_ids)
