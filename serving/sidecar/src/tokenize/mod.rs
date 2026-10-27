//! Byte-exact Rust port of AnT v2 tokenization + ONNX feed building: the
//! SVG-d-string -> command-tensor -> packing -> color-masking -> feed-index
//! path of `pipeline.preprocess` + `serving/onnx/export_ant_v2.py::build_feed`.
//!
//! Scope (verified per-stage by `src/bin/verify_tokenize.rs` against goldens
//! from `serving/tools/dump_tokenizer_goldens.py`):
//!   - `svg`:     `colorize/vectorization/lib/svg.py::SVG.from_str`/`to_tensor`
//!   - `pack`:    `colorize/common/packing.py::pack_sequences`
//!   - `palette`: `colorize/common/frame.py::Palette` +
//!                `colorize/ant_v1/tokenizer_ant_v1.py::mask_null_color_ids`
//!   - `feed`:    `serving/onnx/export_ant_v2.py::svg_pre`/`build_feed`
//!                (incl. `sdf_like_cupy` and the NEAREST_EXACT seg downscale)
//!
//! Production quirks are preserved and commented in place — notably the
//! silently dropped `Z` commands, the `-100` LongTensor pad rows that
//! torch.cat type-promotes into f32, `translate(0,0)` transforms rewriting
//! `-0.0` coordinates to `+0.0`, and null (-100) colors still being inserted
//! into the palette color list.

pub mod bucket;
pub mod feed;
pub mod pack;
pub mod palette;
pub mod svg;

/// The production pad value (`AnTV1Tokenizer.PAD_VALUE`).
pub const PAD_VALUE: f32 = -100.0;

/// `AnTV1Tokenizer.max_vec_seq_length`. Longer command sequences are
/// subsampled to this length (`truncate_commands`; production does it with
/// `np.random`). The verification corpus never exceeds it (max 216).
pub const MAX_VEC_SEQ_LENGTH: usize = 256;

/// Dense row-major (C-order) tensor, mirroring the numpy/torch arrays the
/// Python pipeline passes between stages.
#[derive(Clone, PartialEq)]
pub struct Tensor<T> {
    pub shape: Vec<usize>,
    pub data: Vec<T>,
}

impl<T> Tensor<T> {
    pub fn new(shape: Vec<usize>, data: Vec<T>) -> Self {
        assert_eq!(
            shape.iter().product::<usize>(),
            data.len(),
            "tensor shape/data mismatch"
        );
        Tensor { shape, data }
    }

    pub fn full(shape: Vec<usize>, fill: T) -> Self
    where
        T: Clone,
    {
        let n = shape.iter().product();
        Tensor {
            shape,
            data: vec![fill; n],
        }
    }

    /// Prepend a batch dim of 1 (`torch.unsqueeze(t, dim=0)`).
    pub fn unsqueeze0(mut self) -> Self {
        self.shape.insert(0, 1);
        self
    }
}

/// `AnTV1Tokenizer.get_vec_tokens(..., add_batch_dim=True)` output: per-path
/// command tensors plus their packed layouts, all with the leading batch dim
/// production adds for inference.
pub struct VecTokens {
    /// (1, S, C, 6) f32
    pub ref_seg_svg: Tensor<f32>,
    /// (1, S, C, 6) f32
    pub target_seg_svg: Tensor<f32>,
    /// (1, R, C, 6) f32
    pub ref_seg_svg_packed: Tensor<f32>,
    /// (1, R, C, 6) f32
    pub target_seg_svg_packed: Tensor<f32>,
    /// (1, R, C, C) bool
    pub ref_seg_svg_attn_mask_packed: Tensor<bool>,
    /// (1, R, C, C) bool
    pub target_seg_svg_attn_mask_packed: Tensor<bool>,
}

/// Keep at most `max` positions of the command axis of an (S, C, F) tensor.
///
/// Production (`get_vec_tokens`) subsamples over-long command sequences with
/// `np.sort(np.random.randint(0, C, max))`; this keeps the same intent —
/// sorted positions spread across the whole sequence — but deterministically
/// (evenly spaced, no repeats), so a frame colorizes the same way every time.
/// Before this, any segment outline over 256 commands panicked the /colorize
/// handler ("An unknown error occurred" in the app). Padding rows (-100) sit at
/// the end of each path and sorted positions keep them there, so
/// `pack_sequences`' length detection still holds.
fn truncate_commands(t: Tensor<f32>, max: usize) -> Tensor<f32> {
    let (s, c, f) = (t.shape[0], t.shape[1], t.shape[2]);
    if c <= max {
        return t;
    }
    tracing::info!(commands = c, kept = max, "truncating over-long segment outline");
    let keep: Vec<usize> = (0..max).map(|i| i * c / max).collect();
    let mut data = Vec::with_capacity(s * max * f);
    for path in 0..s {
        for &cmd in &keep {
            let at = (path * c + cmd) * f;
            data.extend_from_slice(&t.data[at..at + f]);
        }
    }
    Tensor::new(vec![s, max, f], data)
}

/// `tokenizer_ant_v1.py::AnTV1Tokenizer.get_vec_tokens` (inference path:
/// `add_batch_dim=True`, `convert_to_list=False`).
pub fn get_vec_tokens(ref_svg: &svg::Svg, target_svg: &svg::Svg) -> VecTokens {
    let ref_t = truncate_commands(ref_svg.to_tensor(), MAX_VEC_SEQ_LENGTH);
    let tgt_t = truncate_commands(target_svg.to_tensor(), MAX_VEC_SEQ_LENGTH);

    let ref_packed = pack::pack_sequences(&ref_t);
    let tgt_packed = pack::pack_sequences(&tgt_t);

    VecTokens {
        ref_seg_svg: ref_t.unsqueeze0(),
        target_seg_svg: tgt_t.unsqueeze0(),
        ref_seg_svg_packed: ref_packed.packed.unsqueeze0(),
        target_seg_svg_packed: tgt_packed.packed.unsqueeze0(),
        ref_seg_svg_attn_mask_packed: ref_packed.attn_mask.unsqueeze0(),
        target_seg_svg_attn_mask_packed: tgt_packed.attn_mask.unsqueeze0(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_commands_keeps_short_sequences_untouched() {
        let t = Tensor::new(vec![1, 3, 2], vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
        assert!(truncate_commands(t.clone(), 3) == t);
    }

    #[test]
    fn truncate_commands_subsamples_evenly_and_keeps_padding_last() {
        // 2 paths x 10 commands x 1 feature; path 1 has 4 real commands + pads.
        let mut data: Vec<f32> = (0..10).map(|i| i as f32).collect();
        data.extend([0.0, 1.0, 2.0, 3.0]);
        data.extend([PAD_VALUE; 6]);
        let out = truncate_commands(Tensor::new(vec![2, 10, 1], data), 5);
        assert_eq!(out.shape, vec![2, 5, 1]);
        // positions 0,2,4,6,8
        assert_eq!(&out.data[..5], &[0.0, 2.0, 4.0, 6.0, 8.0]);
        assert_eq!(&out.data[5..], &[0.0, 2.0, PAD_VALUE, PAD_VALUE, PAD_VALUE]);
    }
}
