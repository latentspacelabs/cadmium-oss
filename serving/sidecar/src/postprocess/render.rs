//! `colorize/common/frame.py::SegImageFrame.render_as_image` (and through
//! it `MaterializedKeyFrame.render_color_image`) — labeled seg map + dense
//! color list -> RGBA image.
//!
//! Semantics preserved exactly:
//!   - `null_mask = image_data == -100`: the -100 PAD PIXELS (only possible
//!     when image_data went through `prepare_image`; the serving /segment
//!     path yields a u8-png-roundtripped uint32 map where the mask is
//!     always empty) render as `null_color_rgba` (production default
//!     (0,0,0,0), dense 0).
//!   - every other pixel gathers `np.array(color_list)[label]` — numpy
//!     fancy indexing, so negative labels wrap from the end (IndexError ->
//!     panic when out of range).
//!   - a -100 DENSE COLOR (a null-predicted segment, or a -100 palette
//!     entry) is NOT special-cased here: `dense_to_rgba(-100)` floor-divides
//!     to RGBA (156, 255, 255, 255). Null predictions render as that color,
//!     not as transparency.
//!   - `.astype(np.uint8)` at the end is a no-op mod-256 cast (channels are
//!     already 0..255 from the floor `% 256`).

use crate::imageprep::Rgba;
use crate::segment::Map32;
use crate::tokenize::palette::dense_to_rgba_flat;

/// `ops.py::rgba_to_dense_flat`: r + 256 g + 256^2 b + 256^3 a.
pub fn rgba_to_dense_flat(rgba: [i64; 4]) -> i64 {
    rgba[0] + 256 * rgba[1] + 256 * 256 * rgba[2] + 256 * 256 * 256 * rgba[3]
}

/// `SegImageFrame.render_as_image(color_list, null_color_rgba)`.
pub fn render_as_image(seg: &Map32, color_list: &[i64], null_color_rgba: [i64; 4]) -> Rgba {
    let null_dense = rgba_to_dense_flat(null_color_rgba);
    let n = color_list.len() as i64;
    let mut data = Vec::with_capacity(seg.w * seg.h * 4);
    for &label in &seg.data {
        let dense = if label == -100 {
            null_dense
        } else {
            // numpy gather: negative indices wrap
            let idx = if label < 0 { label as i64 + n } else { label as i64 };
            assert!(
                (0..n).contains(&idx),
                "seg label {label} out of range for color list of {n} (production IndexError)"
            );
            color_list[idx as usize]
        };
        let rgba = dense_to_rgba_flat(dense);
        data.extend(rgba.iter().map(|&c| c as u8)); // astype(np.uint8)
    }
    Rgba::new(seg.w, seg.h, data)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(w: usize, h: usize, data: Vec<i32>) -> Map32 {
        Map32 { w, h, data }
    }

    #[test]
    fn renders_labels_through_the_color_list() {
        // color 0 = transparent (dense 0), color 1 = solid-ish
        let img = render_as_image(
            &seg(2, 1, vec![0, 1]),
            &[0, 4279938297],
            [0, 0, 0, 0],
        );
        assert_eq!(img.data, vec![0, 0, 0, 0, 249, 172, 26, 255]);
    }

    #[test]
    fn pad_pixels_take_the_null_color() {
        let img = render_as_image(&seg(1, 1, vec![-100]), &[7], [0, 0, 0, 0]);
        assert_eq!(img.data, vec![0, 0, 0, 0]);
    }

    #[test]
    fn null_dense_color_renders_as_156_255_255_255() {
        // a -100 dense color (null prediction) floor-divides, NOT transparent
        let img = render_as_image(&seg(1, 1, vec![0]), &[-100], [0, 0, 0, 0]);
        assert_eq!(img.data, vec![156, 255, 255, 255]);
    }

    #[test]
    fn negative_labels_wrap_like_numpy() {
        let img = render_as_image(&seg(1, 1, vec![-1]), &[0, 255], [0, 0, 0, 0]);
        assert_eq!(img.data, vec![255, 0, 0, 0]); // color_list[-1] == 255
    }

    #[test]
    fn dense_roundtrip_through_rgba() {
        for dense in [0i64, 4279938297, 4294967295, 258] {
            assert_eq!(rgba_to_dense_flat(dense_to_rgba_flat(dense)), dense);
        }
    }
}
