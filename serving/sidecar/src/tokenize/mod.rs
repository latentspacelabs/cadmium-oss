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

/// `AnTV1Tokenizer.max_vec_seq_length`. Inputs beyond it hit a
/// `np.random`-based truncation in production (`get_vec_tokens`); the corpus
/// maximum is 216 commands, so the port refuses instead of reproducing RNG.
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

/// `tokenizer_ant_v1.py::AnTV1Tokenizer.get_vec_tokens` (inference path:
/// `add_batch_dim=True`, `convert_to_list=False`).
pub fn get_vec_tokens(ref_svg: &svg::Svg, target_svg: &svg::Svg) -> VecTokens {
    let ref_t = ref_svg.to_tensor();
    let tgt_t = target_svg.to_tensor();
    // Production truncates >max_vec_seq_length command counts with
    // np.random.randint — never reached on the corpus (max 216); refuse
    // rather than replicate RNG state.
    assert!(
        ref_t.shape[1] <= MAX_VEC_SEQ_LENGTH && tgt_t.shape[1] <= MAX_VEC_SEQ_LENGTH,
        "command count exceeds max_vec_seq_length={MAX_VEC_SEQ_LENGTH}; \
         production's np.random truncation path is not ported"
    );

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
