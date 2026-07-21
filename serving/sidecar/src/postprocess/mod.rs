//! Byte-exact Rust port of the AnT v2 postprocess —
//! `colorize/ant_v2/pipeline_ant_v2.py::AnTV2Pipeline.postprocess` with
//! `return_colorized=True`, exactly as the serving pipeline runs it.
//!
//! Stage map (verified per-stage by `src/bin/verify_postprocess.rs` against
//! goldens from `serving/tools/dump_postprocess_goldens.py`):
//!   - id clamp:  raw argmax predictions >= len(color_list) -> -100.
//!                NEGATIVE ids pass the `id < len` clamp untouched (and
//!                later wrap Python-style when they index the color list).
//!   - colors:    `Palette.color_ids_to_colors` (`tokenize::palette`).
//!   - entropy:   num_classes = len(np.unique(frame_idx_to_color_ids["0"]))
//!                — the palette's UNMASKED per-seg ids, -100 counting as a
//!                class if present; `compute_normalized_entropy` (`entropy`)
//!                when num_classes > 1, else all-ones confidences and NO
//!                norm-entropy tensor.
//!   - renders:   `MaterializedKeyFrame.render_color_image()` for the ref
//!                frame (its `compute_color_list` colors over the FULL-RES
//!                seg map — `PartialSequence.from_keyframes` deep-copies the
//!                frames, so `prepare_image` never mutates the ones
//!                postprocess renders from) and
//!                `SegImageFrame.render_as_image(color_ids_to_dense_colors)`
//!                for the target (`render`).
//!
//! The seg maps here are what production rendered from: the trapped-ball
//! label map after the /segment handler's PNG roundtrip
//! (`base64_png_uri_to_img` does `.astype('uint8')` — labels mod 256), then
//! `SegImageFrame._maybe_bitshift`'s uint32 cast. `seg_from_labels` applies
//! that cast.

pub mod entropy;
pub mod render;
pub mod sleef;
pub mod torchcpu;

use std::collections::BTreeSet;

use crate::imageprep::Rgba;
use crate::segment::Map32;
use crate::tokenize::palette::{color_ids_to_colors, color_ids_to_dense_colors, Palette};

/// `AnTV2PipelineOutput`, minus the fields the pipeline merely echoes.
pub struct PostprocessOutput {
    /// clamped `target_color_ids`
    pub target_color_ids: Vec<i64>,
    /// `target_colors_rgba` (RGBA per target seg, [-100;4] for nulls)
    pub target_colors_rgba: Vec<[i64; 4]>,
    /// `len(np.unique(palette.frame_idx_to_color_ids["0"]))`
    pub num_classes: usize,
    /// `compute_normalized_entropy(...).squeeze(0)`; empty when
    /// num_classes <= 1 (production never computes it then)
    pub norm_entropy: Vec<f32>,
    /// `1 - norm_entropy`, or all ones when num_classes <= 1
    pub entropy_conf_scores: Vec<f32>,
    /// `palette.color_ids_to_dense_colors(target_color_ids)`
    pub target_dense_colors: Vec<i64>,
    /// `ref_key_frame.render_color_image()`
    pub ref_color_image: Rgba,
    /// `target_frame.render_as_image(dense colors)`
    pub target_color_image: Rgba,
}

/// The `>= len(color_list) -> -100` clamp. Negative ids (including an
/// already-null -100) satisfy `id < len` and pass through unchanged.
pub fn clamp_color_ids(ids: &[i64], palette_len: usize) -> Vec<i64> {
    ids.iter()
        .map(|&id| if id < palette_len as i64 { id } else { -100 })
        .collect()
}

/// `len(np.unique(...))` over the palette's frame-0 color ids.
pub fn num_classes(color_ids: &[i64]) -> usize {
    color_ids.iter().collect::<BTreeSet<_>>().len()
}

/// The /segment-served seg map as the pipeline sees it: labels cast to u8
/// by the PNG roundtrip (mod 256), then widened (uint32 in production;
/// non-negative i32 here).
pub fn seg_from_labels(labels: &Map32) -> Map32 {
    Map32 {
        w: labels.w,
        h: labels.h,
        data: labels.data.iter().map(|&v| (v as u8) as i32).collect(),
    }
}

/// `AnTV2Pipeline.postprocess(model_output)` with `return_colorized=True`.
///
/// * `ids`      — `target_color_id_predictions.squeeze(0)` (raw argmax)
/// * `logits`   — `target_color_logits` as a contiguous (n_tgt, palette_dim)
///                buffer (batch dim squeezed)
/// * `palette`  — the preprocess palette (`palette_from_color_list` over the
///                ref frame's `compute_color_list` output)
/// * `ref_color_list` — the ref `KeyFrame.color_list` (raw dense colors,
///                duplicates included) driving the ref render
/// * `ref_seg` / `target_seg` — full-res seg maps post `seg_from_labels`
pub fn postprocess(
    ids: &[i64],
    logits: &[f32],
    palette_dim: usize,
    palette: &Palette,
    ref_color_list: &[i64],
    ref_seg: &Map32,
    target_seg: &Map32,
) -> PostprocessOutput {
    let n_tgt = ids.len();
    assert_eq!(logits.len(), n_tgt * palette_dim, "logits shape mismatch");

    let target_color_ids = clamp_color_ids(ids, palette.color_list.len());
    let target_colors_rgba = color_ids_to_colors(&palette.color_list, &target_color_ids);

    let nc = num_classes(&palette.color_ids);
    let (norm_entropy, entropy_conf_scores) = if nc > 1 {
        let norm = entropy::compute_normalized_entropy(logits, n_tgt, palette_dim, nc);
        let conf = norm.iter().map(|&x| 1.0 - x).collect();
        (norm, conf)
    } else {
        // torch.ones_like(logits[0, :, 0])
        (Vec::new(), vec![1.0f32; n_tgt])
    };

    // return_colorized renders
    let ref_color_image = render::render_as_image(ref_seg, ref_color_list, [0, 0, 0, 0]);
    let target_dense_colors = color_ids_to_dense_colors(&palette.color_list, &target_color_ids, -100);
    let target_color_image = render::render_as_image(target_seg, &target_dense_colors, [0, 0, 0, 0]);

    PostprocessOutput {
        target_color_ids,
        target_colors_rgba,
        num_classes: nc,
        norm_entropy,
        entropy_conf_scores,
        target_dense_colors,
        ref_color_image,
        target_color_image,
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokenize::palette::palette_from_color_list;

    #[test]
    fn clamp_maps_out_of_palette_to_null_and_keeps_negatives() {
        let clamped = clamp_color_ids(&[0, 6, 7, 512, -100, -3], 7);
        assert_eq!(clamped, vec![0, 6, -100, -100, -100, -3]);
    }

    #[test]
    fn num_classes_counts_null_as_a_class() {
        assert_eq!(num_classes(&[0, 1, 1, 2]), 3);
        assert_eq!(num_classes(&[0, -100, 0, 1]), 3); // np.unique keeps -100
        assert_eq!(num_classes(&[5]), 1);
    }

    #[test]
    fn seg_cast_wraps_labels_mod_256() {
        let seg = seg_from_labels(&Map32 {
            w: 3,
            h: 1,
            data: vec![0, 255, 256],
        });
        assert_eq!(seg.data, vec![0, 255, 0]);
    }

    #[test]
    fn single_class_palette_yields_unit_confidence_and_no_entropy() {
        let palette = palette_from_color_list(&[42, 42]);
        let seg = Map32 {
            w: 1,
            h: 1,
            data: vec![0],
        };
        let out = postprocess(&[0, 0], &[1.0, 2.0], 1, &palette, &[42, 42], &seg, &seg);
        assert!(out.norm_entropy.is_empty());
        assert_eq!(out.entropy_conf_scores, vec![1.0, 1.0]);
        assert_eq!(out.num_classes, 1);
    }

    #[test]
    fn null_prediction_flows_to_colors_dense_and_render() {
        // palette [0, 4279938297]; id 9 clamps to -100
        let palette = palette_from_color_list(&[0, 4279938297]);
        let seg = Map32 {
            w: 2,
            h: 1,
            data: vec![0, 1],
        };
        let out = postprocess(
            &[0, 9],
            &[0.0, 0.0, 0.0, 0.0],
            2,
            &palette,
            &[0, 4279938297],
            &seg,
            &seg,
        );
        assert_eq!(out.target_color_ids, vec![0, -100]);
        assert_eq!(out.target_colors_rgba[1], [-100; 4]);
        assert_eq!(out.target_dense_colors, vec![0, -100]);
        // the null segment renders as dense_to_rgba(-100), not transparency
        assert_eq!(&out.target_color_image.data[4..8], &[156, 255, 255, 255]);
    }
}
