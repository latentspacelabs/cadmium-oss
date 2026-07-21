import torch
import torch.nn.functional as F
import numpy as np


def compute_indices(seq_lengths, max_seq_len):
    seq_lengths = seq_lengths.numpy().tolist()

    output = [] # num_indices x 2
    attn_mask_start_ends = []
    current_batch_idx = 0
    current_seq_idx = 0
    
    for i, seq_length in enumerate(seq_lengths):
        if seq_length > max_seq_len:
            raise AssertionError(f'Sequence length exceeded max_seq_len: {seq_length} > {max_seq_len}')
        
        if current_seq_idx + seq_length > max_seq_len:
            current_batch_idx += 1
            current_seq_idx = 0
        
        new_seq_len = current_seq_idx + seq_length
        for j in range(current_seq_idx, new_seq_len):
            output.append([current_batch_idx, j])
            current_seq_idx += 1
            
            if current_seq_idx > max_seq_len:
                raise AssertionError(f'Sequence length exceeded max_seq_len: {current_seq_idx} > {max_seq_len}')

        seq_start = new_seq_len - seq_length
        seq_end = new_seq_len
        attn_mask_start_ends.append([current_batch_idx, seq_start, seq_end])

    attn_mask = [np.zeros((max_seq_len, max_seq_len), dtype=np.int32) for _ in range(current_batch_idx + 1)]  # batch x num_sequences x num_sequences
    for batch_idx, seq_start, seq_end in attn_mask_start_ends:
        attn_mask[batch_idx][seq_start:seq_end, seq_start:seq_end] = 1

    assert len(output) == sum(seq_lengths)
        
    output = torch.tensor(np.stack(output), dtype=torch.long)
    attn_mask = torch.tensor(np.stack(attn_mask), dtype=torch.bool)
    return output, attn_mask 


def pack_sequences(tensor, padding_value=-100):
    batch_dim, max_sequence_dim, feature_dim = tensor.shape 
    # lengths of each sequence
    lengths = (tensor != padding_value).any(dim=2).sum(dim=1)

    # convert into (batch, seq) indices
    valid_batch_seq_indices, attn_mask = compute_indices(lengths, max_sequence_dim)

    max_new_batch_dim = torch.max(valid_batch_seq_indices[:, 0]) + 1

    # N-D index select 
    packed_tensor = torch.full(
        (max_new_batch_dim, max_sequence_dim, feature_dim), 
        fill_value=padding_value, 
        dtype=tensor.dtype, 
    )
    valid_batch_indices = valid_batch_seq_indices[:, 0]
    valid_seq_indices = valid_batch_seq_indices[:, 1]
    packed_tensor[valid_batch_indices, valid_seq_indices] = tensor[torch.all(tensor != -100,dim=-1)]

    return packed_tensor, lengths, attn_mask


def unpack_sequences(
    packed_tensor,
    valid_packed_tensor_mask,
    original_tensor, # we could also use lengths here
    padding_value=-100
):
    unpacked_data = packed_tensor[valid_packed_tensor_mask]

    # Create the unpacked tensor
    unpacked_tensor = torch.full(
        (original_tensor.shape[0], original_tensor.shape[1], packed_tensor.shape[2]),
        fill_value=padding_value, 
        dtype=packed_tensor.dtype,
        device=packed_tensor.device,
    )

    unpacked_tensor[torch.all(original_tensor != -100, dim=2)] = unpacked_data
    return unpacked_tensor
