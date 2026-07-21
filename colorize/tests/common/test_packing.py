import torch

from colorize.common.packing import pack_sequences, unpack_sequences

def verify_packing(batch_dim=5, max_sequence_dim=10, feature_dim=3, padding_value=-100):
    # Create a sample tensor with variable-length sequences
    original_tensor = torch.full((batch_dim, max_sequence_dim, feature_dim), 
                                 fill_value=padding_value)

    for i in range(batch_dim):
        length = torch.randint(1, max_sequence_dim // 2 + 1, (1,)).item()
        original_tensor[i, :length] = torch.randn((length, feature_dim))

    print("Original tensor shape:", original_tensor.shape)

    # Pack the sequences
    packed_tensor, lengths, attn_mask = pack_sequences(original_tensor)

    print("Packed tensor shape:", packed_tensor.shape)
    print("Sequence lengths:", lengths)

    # Unpack the sequences
    valid_packed_tensor_mask = torch.all(packed_tensor != -100, dim=-1)
    unpacked_tensor = unpack_sequences(packed_tensor, valid_packed_tensor_mask, original_tensor)

    print("Unpacked tensor shape:", unpacked_tensor.shape)

    # Verify the unpacking
    print("\nVerification:")
    print("Original and unpacked tensors are identical:", 
          torch.allclose(original_tensor, unpacked_tensor))

    # Additional verification
    print("Total non-padding elements (original):", (original_tensor != padding_value).sum().item())
    print("Total non-padding elements (unpacked):", (unpacked_tensor != padding_value).sum().item())


if __name__ == "__main__":
    # Run the verification
    for _ in range(10):
        verify_packing()
