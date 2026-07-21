from typing import *

import torch
import numpy as np


def compute_entropy(logits: torch.Tensor, num_classes: int):
    probs = torch.nn.functional.softmax(logits[:, :, :num_classes], dim=-1)
    log_probs = torch.nn.functional.log_softmax(logits[:, :, :num_classes], dim=-1)
    entropy = -(probs * log_probs).sum(dim=-1)  # shape: (batch,)
    return entropy


def compute_normalized_entropy(logits, num_classes):
    entropy = compute_entropy(logits, num_classes)
    max_entropy = torch.log(torch.tensor(num_classes, dtype=logits.dtype))
    normalized_entropy = entropy / max_entropy
    return normalized_entropy


def masked_softmax(logits: torch.Tensor, mask: torch.Tensor, dim: int):
    extended_inf_mask = (mask.to(logits.dtype) * -1.0e4).unsqueeze(-1)
    _p = torch.nn.functional.softmax(logits + extended_inf_mask, dim=dim)
    return _p


def masked_softmax_2d(logits: torch.Tensor, mask: torch.Tensor, dim: int):
    extended_inf_mask = (mask.to(logits.dtype) * -1.0e4)
    _p = torch.nn.functional.softmax(logits + extended_inf_mask, dim=dim)
    return _p


def norm_features(feats: torch.Tensor) -> torch.Tensor:
    feats = feats - torch.mean(feats, dim=1, keepdim=True)
    feats = feats / (torch.norm(feats, p="fro", dim=1,  keepdim=True) + 1e-10)
    return feats


def dense_to_rgba(dense_image: np.ndarray) -> np.ndarray:
    return np.stack([
        dense_image % 256,
        (dense_image // 256) % 256,
        (dense_image // (256 * 256)) % 256,
        (dense_image // (256 * 256 * 256)) % 256
    ], axis=-1)


def dense_to_rgba_flat(dense: int) -> Tuple[int, int, int, int]:
    return [
        dense % 256,
        (dense // 256) % 256,
        (dense // (256 * 256)) % 256,
        (dense // (256 * 256 * 256)) % 256
    ]


def rgba_to_dense(rgba_image: np.ndarray) -> np.ndarray:
    return rgba_image[:,:,0] + \
        (256 * rgba_image[:,:,1]) + \
            (256 * 256 * rgba_image[:,:,2]) + \
                (256 * 256 * 256 * rgba_image[:,:,3])

def rgba_to_dense_flat(rgba_array: np.ndarray) -> np.ndarray:
    return rgba_array[0] + \
        (256 * rgba_array[1]) + \
            (256 * 256 * rgba_array[2]) + \
                (256 * 256 * 256 * rgba_array[3])


def rgba_to_rgb(rgba_image: np.ndarray) -> np.ndarray:
    # Split the RGBA image tensor into RGB and Alpha channels
    rgb = rgba_image[:, :, :3]
    alpha = rgba_image[:, :, 3:]

    # Create a mask where the alpha channel is 0 (transparent pixels)
    transparent_mask = (alpha == 0).repeat(3, axis=2)

    # Create a tensor filled with white color
    white_tensor = np.ones_like(rgb) * 255

    # Apply the mask to replace transparent pixels with white
    rgb[transparent_mask] = white_tensor[transparent_mask]

    return rgb


def rgb_to_rgba(rgb_image: np.ndarray) -> np.ndarray:
    return np.concatenate(
        [rgb_image, np.ones_like(rgb_image)[:, :, :1] * 255],
        axis=-1
    )


def matte_rgba(rgba_image: np.ndarray) -> np.ndarray:
    white_background = np.ones_like(rgba_image) * 255
    alpha = rgba_image[:, :, 3:] / 255.0
    blended = rgba_image[:, :, :3] * alpha + white_background[:, :, :3] * (1 - alpha)
    result = np.concatenate(
        [
            blended.astype(np.uint8),
            np.ones_like(rgba_image[:, :, 3:]).astype(np.uint8) * 255,
        ],
        axis=-1
    )
    return result


def rgba_to_rgb_torch(rgba_image: torch.Tensor) -> torch.Tensor:
    # Split the RGBA image tensor into RGB and Alpha channels
    rgb = rgba_image[:, :3, :, :]
    alpha = rgba_image[:, 3:, :, :]

    # Create a mask where the alpha channel is 0 (transparent pixels)
    transparent_mask = (alpha == 0)

    # Create a tensor filled with white color
    white_tensor = torch.ones_like(rgb) * 255

    # Apply the mask to replace transparent pixels with white
    rgb = torch.where(transparent_mask, white_tensor, rgb)

    return rgb


def rgba_to_rgb_flat(rgba_array: np.ndarray) -> np.ndarray:
    rgb = rgba_array[:3]
    alpha = rgba_array[3:]
    transparent_mask = (alpha == 0).repeat(3)
    white_tensor = np.ones_like(rgb) * 255
    rgb[transparent_mask] = white_tensor[transparent_mask]
    return rgb

    
# def postprocess(dense_seg_map: torch.Tensor, color_selections: torch.Tensor):
#     batch_size, height, width, _ = dense_seg_map.size()
    
#     dense_seg_map = dense_seg_map.view(batch_size, -1)  # N x HW

#     quantized_postprocessed = color_selections.gather(1, dense_seg_map.long())
#     quantized_postprocessed = quantized_postprocessed.view(batch_size, height, width, 1)  # N x H x W x 1
    
#     return quantized_postprocessed


# def get_last_non_padding_idx(tensor: torch.Tensor, padding_value: int = -100) -> torch.Tensor:
#     mask = tensor != padding_value
#     indices = torch.where(
#         mask,
#         torch.arange(tensor.size(1)).expand_as(tensor).to(tensor.device),
#         torch.tensor(-1, dtype=torch.long).to(tensor.device),
#     )
#     last_index = torch.max(indices)
#     return last_index


def one_hot_with_ignore(
    mask: torch.Tensor,  # B C H W
    num_classes: int,
    ignored_label: Union[str, int] = "negative",
) -> torch.Tensor:
    original_shape = mask.shape
    for _ in range(4 - len(mask.shape)):
        mask = mask.unsqueeze(0)  # H W -> C H W -> B C H W, if applicable
    # start to handle ignored label
    # convert ignored label into positive index bigger than num_classes
    if type(ignored_label) is int:
        mask[mask == ignored_label] = num_classes
    elif ignored_label == "negative":
        # print(mask.shape, mask.min())
        mask[mask < 0] = num_classes
        # print(mask.shape, mask.min())

    # check if mask image is valid
    if torch.max(mask) > num_classes:
        raise RuntimeError("class values must be smaller than num_classes.")
    B, _, H, W = mask.shape
    one_hot = torch.zeros(B, num_classes + 1, H, W, device=mask.device)
    # TODO: use to_dense_batch
    one_hot.scatter_(1, mask, 1)  # mark 1 on channel(dim=1) with index of mask
    one_hot = one_hot[:, :num_classes] # remove ignored label(s)
    for _ in range(len(one_hot.shape) - len(original_shape)):
        one_hot.squeeze_(0)  # B C H W -> H W ->  C H W, if applicable
    return one_hot


def make_4d_bidirectional_attention_mask(
    inputs_embeds: torch.FloatTensor,  # N x SZ x F
    inputs_attention_mask: torch.BoolTensor,  # N x SZ
) -> torch.BoolTensor:
    # N x 1 x 1 x output
    bidirectional_attention_mask = inputs_attention_mask.unsqueeze(1).unsqueeze(1)
    # N x 1 x output x output
    bidirectional_attention_mask = bidirectional_attention_mask * bidirectional_attention_mask.transpose(-1, -2)

    # convert boolean mask to attention mask with -inf for padding tokens
    bidirectional_attention_mask = torch.where(
        bidirectional_attention_mask,
        1.0,
        torch.finfo(inputs_embeds.dtype).min
    )
    return bidirectional_attention_mask
