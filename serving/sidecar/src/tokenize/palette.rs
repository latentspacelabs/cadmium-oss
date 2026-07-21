//! Byte-exact port of the inference-side palette + color-id path:
//! `colorize/common/frame.py::Palette.add_frame_colors` (as driven by
//! `colorize/common/sequence.py::PartialSequence.from_keyframes` for the
//! single reference frame), `colorize/common/ops.py::dense_to_rgba_flat`,
//! `Palette.color_ids_to_dense_colors` / `color_ids_to_colors`, and
//! `colorize/ant_v1/tokenizer_ant_v1.py::mask_null_color_ids`.
//!
//! Quirks preserved:
//!   - `add_frame_colors` appends a color to the palette BEFORE checking for
//!     the null sentinel, so -100 "colors" DO enter `color_list` (shifting
//!     the ids of later colors) even though their per-seg id is -100.
//!   - `dense_to_rgba_flat` uses Python floor `%`/`//` (dense colors are
//!     non-negative u32 packs in practice, where floor == trunc).
//!   - `mask_null_color_ids` indexes a bool mask with raw seg labels, so a
//!     negative label (other than the -100 pad, which is filtered) would use
//!     Python/torch wrap-around indexing — replicated, with a panic where
//!     production would raise IndexError.

/// The palette state after `PartialSequence.from_keyframes` added the single
/// reference keyframe (`unique_color_ids=False` — the production default).
pub struct Palette {
    /// unique dense colors in first-appearance order (incl. the -100 quirk)
    pub color_list: Vec<i64>,
    /// `frame_idx_to_color_ids["0"]`: per-seg index into `color_list`
    pub color_ids: Vec<i64>,
}

/// `Palette.add_frame_colors` over one frame's `compute_color_list` output.
pub fn palette_from_color_list(colors: &[i64]) -> Palette {
    let mut color_list: Vec<i64> = Vec::new();
    let mut color_ids = Vec::with_capacity(colors.len());
    for &color in colors {
        // palette has no duplicates but color ids are not unique — and the
        // append happens before the -100 check (see module docs)
        if !color_list.contains(&color) {
            color_list.push(color);
        }
        if color != -100 {
            let idx = color_list.iter().position(|&c| c == color).unwrap();
            color_ids.push(idx as i64);
        } else {
            color_ids.push(-100);
        }
    }
    Palette {
        color_list,
        color_ids,
    }
}

/// Python floor division/modulo (differs from Rust `/`/`%` on negatives).
fn py_divmod(a: i64, b: i64) -> (i64, i64) {
    (a.div_euclid(b), a.rem_euclid(b))
}

/// `ops.py::dense_to_rgba_flat`: dense = r + 256 g + 256^2 b + 256^3 a.
pub fn dense_to_rgba_flat(dense: i64) -> [i64; 4] {
    let (q1, r) = py_divmod(dense, 256);
    let (q2, g) = py_divmod(q1, 256);
    let (q3, b) = py_divmod(q2, 256);
    let (_, a) = py_divmod(q3, 256);
    [r, g, b, a]
}

/// `self.color_list[color_id]` — a Python list index, so negative ids other
/// than the -100 sentinel wrap from the end (`color_list[-1]` is the last
/// color); out-of-range ids raise IndexError in production (panic here).
/// The -100 sentinel is checked BEFORE indexing, so it never wraps even when
/// the palette has >= 100 entries.
fn py_list_index(color_list: &[i64], id: i64) -> i64 {
    let n = color_list.len() as i64;
    let idx = if id < 0 { id + n } else { id };
    assert!(
        (0..n).contains(&idx),
        "color id {id} out of range for palette of {n} (production IndexError)"
    );
    color_list[idx as usize]
}

/// `Palette.color_ids_to_dense_colors`: id -> dense color, with the -100
/// null sentinel mapping to `null_color_dense` (production default -100).
pub fn color_ids_to_dense_colors(
    color_list: &[i64],
    color_ids: &[i64],
    null_color_dense: i64,
) -> Vec<i64> {
    color_ids
        .iter()
        .map(|&id| {
            if id == -100 {
                null_color_dense
            } else {
                py_list_index(color_list, id)
            }
        })
        .collect()
}

/// `Palette.color_ids_to_colors`: id -> dense (via `color_ids_to_dense_colors`
/// with null -100) -> RGBA, null ids becoming [-100; 4].
pub fn color_ids_to_colors(color_list: &[i64], color_ids: &[i64]) -> Vec<[i64; 4]> {
    color_ids_to_dense_colors(color_list, color_ids, -100)
        .iter()
        .map(|&dense| {
            if dense == -100 {
                [-100; 4]
            } else {
                dense_to_rgba_flat(dense)
            }
        })
        .collect()
}

/// `AnTV1Tokenizer.mask_null_color_ids(seg_image, color_ids, ...)`: mask ids
/// whose segment never appears in the seg image (after dropping -100 pad
/// pixels) or whose id is already the null sentinel.
pub fn mask_null_color_ids(seg_flat: &[i32], color_ids: &[i64]) -> Vec<i64> {
    let n = color_ids.len();
    let mut seg_exists = vec![false; n];
    for &label in seg_flat {
        if label == -100 {
            continue; // flat_seg[flat_seg != -100]
        }
        // torch bool-mask index_put wraps negatives Python-style
        let idx = if label < 0 {
            let wrapped = label as i64 + n as i64;
            assert!(wrapped >= 0, "seg label {label} out of range for {n} slots");
            wrapped as usize
        } else {
            label as usize
        };
        assert!(idx < n, "seg label {label} out of range for {n} slots");
        seg_exists[idx] = true;
    }
    color_ids
        .iter()
        .zip(&seg_exists)
        .map(|(&id, &exists)| if id != -100 && exists { id } else { -100 })
        .collect()
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_dedups_and_indexes_by_first_appearance() {
        let p = palette_from_color_list(&[7, 3, 7, 9, 3]);
        assert_eq!(p.color_list, vec![7, 3, 9]);
        assert_eq!(p.color_ids, vec![0, 1, 0, 2, 1]);
    }

    #[test]
    fn null_color_still_enters_color_list() {
        // the -100 append-before-check quirk shifts later ids
        let p = palette_from_color_list(&[5, -100, 8]);
        assert_eq!(p.color_list, vec![5, -100, 8]);
        assert_eq!(p.color_ids, vec![0, -100, 2]);
    }

    #[test]
    fn dense_to_rgba_unpacks_channels() {
        assert_eq!(dense_to_rgba_flat(0), [0, 0, 0, 0]);
        assert_eq!(dense_to_rgba_flat(4294967295), [255, 255, 255, 255]);
        // a corpus color: round-trips through the packing formula
        let [r, g, b, a] = dense_to_rgba_flat(4279938297);
        assert_eq!(
            4279938297,
            r + 256 * g + 256 * 256 * b + 256 * 256 * 256 * a
        );
    }

    #[test]
    fn color_ids_to_colors_maps_null_to_neg100() {
        let colors = color_ids_to_colors(&[258], &[0, -100]);
        assert_eq!(colors, vec![[2, 1, 0, 0], [-100, -100, -100, -100]]);
    }

    #[test]
    fn dense_colors_wrap_negative_ids_python_style() {
        // color_list[color_id] is a Python list index: -1 is the last entry;
        // the -100 sentinel is checked BEFORE indexing and never wraps
        let dense = color_ids_to_dense_colors(&[10, 20, 30], &[-1, -3, -100, 2], -100);
        assert_eq!(dense, vec![30, 10, -100, 30]);
    }

    #[test]
    #[should_panic(expected = "out of range")]
    fn dense_colors_out_of_range_negative_id_panics_like_indexerror() {
        color_ids_to_dense_colors(&[10, 20], &[-3], -100);
    }

    #[test]
    fn predicted_id_hitting_a_null_palette_entry_yields_null_rgba() {
        // the -100-enters-color_list quirk: a model PREDICTION can index the
        // -100 entry; color_ids_to_colors checks the DENSE value, so it
        // yields [-100; 4] (not dense_to_rgba(-100))
        let colors = color_ids_to_colors(&[5, -100, 8], &[1]);
        assert_eq!(colors, vec![[-100; 4]]);
    }

    #[test]
    fn mask_nulls_missing_segments_and_null_ids() {
        // slots 0..3; seg image only shows labels 0 and 2 (plus -100 pads)
        let masked = mask_null_color_ids(&[0, 2, -100, 0], &[4, 5, 6, -100]);
        assert_eq!(masked, vec![4, -100, 6, -100]);
    }

    #[test]
    fn negative_labels_wrap_like_torch_indexing() {
        let masked = mask_null_color_ids(&[-1], &[7, 8]);
        assert_eq!(masked, vec![-100, 8]); // -1 marks the LAST slot
    }
}
