//! Byte-exact port of `colorize/common/packing.py::pack_sequences` /
//! `compute_indices`: greedy row-fill packing of per-segment command
//! sequences into shared rows, plus the block-diagonal attention mask that
//! keeps co-packed segments independent.
//!
//! Quirks preserved:
//!   - Sequence LENGTHS come from `(row != -100).any(dim=2)` while row
//!     SELECTION uses `torch.all(row != -100, dim=-1)` — they only agree
//!     because pad rows are exactly [-100; 6] and real rows contain no -100.
//!     The port asserts the counts match (production would hit a shape
//!     mismatch on the index_put).
//!   - `packed_tensor[idx] = tensor[all-valid mask]` selects valid commands
//!     in ROW-MAJOR (slot-major) order — the same order `compute_indices`
//!     emits destinations in, which is what makes the layout well defined.
//!   - The attention mask is built as int32 zeros with 1-blocks then cast to
//!     bool; a zero-length sequence contributes an empty block (no rows).

use super::{Tensor, PAD_VALUE};

pub struct PackResult {
    /// (R, C, F) f32, pad value -100
    pub packed: Tensor<f32>,
    /// per-slot valid command counts (torch returns these as i64)
    pub lengths: Vec<usize>,
    /// (R, C, C) bool, block-diagonal per packed sequence
    pub attn_mask: Tensor<bool>,
}

/// `packing.py::compute_indices`: greedy first-fit-in-order layout. Returns
/// the (row, position) destination per valid command plus the mask blocks.
fn compute_indices(
    lengths: &[usize],
    max_seq_len: usize,
) -> (Vec<[usize; 2]>, Tensor<bool>) {
    let mut output = Vec::new();
    let mut blocks = Vec::new(); // (row, start, end)
    let mut row = 0usize;
    let mut pos = 0usize;
    for &len in lengths {
        assert!(
            len <= max_seq_len,
            "Sequence length exceeded max_seq_len: {len} > {max_seq_len}"
        );
        if pos + len > max_seq_len {
            row += 1;
            pos = 0;
        }
        let new_pos = pos + len;
        for j in pos..new_pos {
            output.push([row, j]);
        }
        pos = new_pos;
        blocks.push((row, new_pos - len, new_pos));
    }
    let n_rows = row + 1;
    let mut attn = Tensor::full(vec![n_rows, max_seq_len, max_seq_len], false);
    for (r, start, end) in blocks {
        for i in start..end {
            for j in start..end {
                attn.data[(r * max_seq_len + i) * max_seq_len + j] = true;
            }
        }
    }
    assert_eq!(output.len(), lengths.iter().sum::<usize>());
    (output, attn)
}

/// `packing.py::pack_sequences(tensor, padding_value=-100)` on a (S, C, F)
/// tensor.
pub fn pack_sequences(tensor: &Tensor<f32>) -> PackResult {
    assert_eq!(tensor.shape.len(), 3, "pack_sequences expects (S, C, F)");
    let (s, c, f) = (tensor.shape[0], tensor.shape[1], tensor.shape[2]);

    // lengths of each sequence: rows where ANY feature != -100
    let lengths: Vec<usize> = (0..s)
        .map(|si| {
            (0..c)
                .filter(|ci| {
                    tensor.data[(si * c + ci) * f..(si * c + ci + 1) * f]
                        .iter()
                        .any(|&v| v != PAD_VALUE)
                })
                .count()
        })
        .collect();

    let (indices, attn_mask) = compute_indices(&lengths, c);

    let n_rows = indices.iter().map(|ij| ij[0]).max().map_or(0, |m| m + 1);
    assert!(n_rows > 0, "pack_sequences on all-empty input (torch.max would raise)");
    let mut packed = Tensor::full(vec![n_rows, c, f], PAD_VALUE);

    // tensor[torch.all(tensor != -100, dim=-1)] — valid commands in
    // row-major order, zipped with the destinations in emit order.
    let mut dst = indices.iter();
    let mut n_valid = 0usize;
    for si in 0..s {
        for ci in 0..c {
            let row = &tensor.data[(si * c + ci) * f..(si * c + ci + 1) * f];
            if row.iter().all(|&v| v != PAD_VALUE) {
                let [r, p] = dst
                    .next()
                    .expect("more all-valid rows than any-valid lengths (production shape mismatch)");
                packed.data[(r * c + p) * f..(r * c + p + 1) * f].copy_from_slice(row);
                n_valid += 1;
            }
        }
    }
    assert_eq!(
        n_valid,
        indices.len(),
        "any-valid lengths disagree with all-valid selection (production shape mismatch)"
    );

    PackResult {
        packed,
        lengths,
        attn_mask,
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// (S, C, 1) tensor from per-slot lengths, feature = slot*100 + cmd.
    fn seqs(lengths: &[usize], c: usize) -> Tensor<f32> {
        let mut data = Vec::new();
        for (s, &len) in lengths.iter().enumerate() {
            for i in 0..c {
                data.push(if i < len {
                    (s * 100 + i) as f32
                } else {
                    PAD_VALUE
                });
            }
        }
        Tensor::new(vec![lengths.len(), c, 1], data)
    }

    #[test]
    fn greedy_row_fill_wraps() {
        let r = pack_sequences(&seqs(&[3, 2, 2], 4));
        assert_eq!(r.lengths, vec![3, 2, 2]);
        assert_eq!(r.packed.shape, vec![2, 4, 1]);
        // row 0: seq0 (3) then seq1 (2) does not fit -> row 1: seq1, seq2
        assert_eq!(
            r.packed.data,
            vec![0.0, 1.0, 2.0, PAD_VALUE, 100.0, 101.0, 200.0, 201.0]
        );
    }

    #[test]
    fn attn_mask_is_block_diagonal() {
        let r = pack_sequences(&seqs(&[2, 2], 4));
        assert_eq!(r.packed.shape, vec![1, 4, 1]);
        let m = &r.attn_mask.data;
        assert_eq!(r.attn_mask.shape, vec![1, 4, 4]);
        for i in 0..4 {
            for j in 0..4 {
                let same_block = (i < 2) == (j < 2);
                assert_eq!(m[i * 4 + j], same_block, "({i},{j})");
            }
        }
    }

    #[test]
    fn exact_fit_does_not_wrap() {
        let r = pack_sequences(&seqs(&[2, 2], 4));
        assert_eq!(r.packed.shape[0], 1);
        assert_eq!(r.packed.data, vec![0.0, 1.0, 100.0, 101.0]);
    }

    #[test]
    fn zero_length_sequence_contributes_nothing() {
        let r = pack_sequences(&seqs(&[2, 0, 1], 4));
        assert_eq!(r.lengths, vec![2, 0, 1]);
        assert_eq!(r.packed.shape, vec![1, 4, 1]);
        assert_eq!(r.packed.data, vec![0.0, 1.0, 200.0, PAD_VALUE]);
    }

    #[test]
    #[should_panic(expected = "exceeded max_seq_len")]
    fn over_capacity_panics() {
        // unreachable via pack_sequences (lengths are derived from a
        // (S, C, F) tensor, so never exceed C) — the guard protects direct
        // compute_indices callers, as in production
        compute_indices(&[5], 4);
    }
}
