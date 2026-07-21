//! Port of `colorize/common/image.py::resize_proportionally` and
//! `pad_sides_equally`.
//!
//! `resize_proportionally` calls `skimage.transform.resize(image,
//! (rh, rw), order=0, preserve_range=True, anti_aliasing=False)`. On the
//! production scikit-image (0.24) that is NOT the old AffineTransform/warp
//! path; resize computes `factors = in/out` and delegates to
//! `scipy.ndimage.zoom(image, 1/factors, order=0, mode='mirror',
//! grid_mode=True)` (skimage mode 'reflect' maps to ndi 'mirror').
//! Consequences, all replicated here:
//!   - dtype is PRESERVED for order=0 integer input (`convert_to_float` only
//!     runs for order > 0), so the seg map stays i32 and the line/color
//!     images stay u8 — the goldens confirm (the dump script's docstring
//!     claim of f64 output is wrong for this skimage version);
//!   - the per-axis coordinate mapping is scipy `NI_ZoomShift` with
//!     grid_mode=1 (ni_interpolation.c): `cc = ((kk + 0.5) * zz) - 0.5` with
//!     `zz = in_dim / out_dim` as f64 (scipy recomputes it from the integer
//!     shapes; skimage's `1/factors` reciprocal only feeds the output-shape
//!     round-trip, which is lossless here);
//!   - out-of-range cc is mapped by `map_coordinate(cc, len, MIRROR)` (hit
//!     for kk=0 on upscales, where cc lands in (-0.5, 0));
//!   - the nearest index for spline order 0 is `floor(cc + 0.5)` (the even-
//!     order branch), i.e. round-half-up applied AFTER the exact
//!     `+0.5 * zz - 0.5` f64 op sequence — do not algebraically simplify.

/// `resize_proportionally`'s aspect-fit output dims: Python float division
/// plus `int()` truncation. `target_size` is (width, height); returns
/// (rows, cols) like the skimage output shape.
pub fn resize_output_dims(h: usize, w: usize, target_w: usize, target_h: usize) -> (usize, usize) {
    let aspect_image = w as f64 / h as f64;
    let aspect_target = target_w as f64 / target_h as f64;
    if aspect_image > aspect_target {
        let rw = target_w;
        let rh = (rw as f64 / aspect_image).trunc() as usize;
        (rh, rw)
    } else {
        let rh = target_h;
        let rw = (rh as f64 * aspect_image).trunc() as usize;
        (rh, rw)
    }
}

/// scipy `map_coordinate(in, len, NI_EXTEND_MIRROR)` (ni_interpolation.c),
/// exact including the `(npy_intp)` truncating casts.
fn map_coordinate_mirror(mut cc: f64, len: usize) -> f64 {
    let len_f = len as f64;
    if cc < 0.0 {
        if len <= 1 {
            cc = 0.0;
        } else {
            let sz2 = (2 * len - 2) as f64;
            cc = sz2 * ((-cc / sz2).trunc()) + cc;
            cc = if cc <= 1.0 - len_f { cc + sz2 } else { -cc };
        }
    } else if cc > len_f - 1.0 {
        if len <= 1 {
            cc = 0.0;
        } else {
            let sz2 = (2 * len - 2) as f64;
            cc -= sz2 * (cc / sz2).trunc();
            if cc >= len_f {
                cc = sz2 - cc;
            }
        }
    }
    cc
}

/// The order-0 grid_mode source index for every output position along one
/// axis: scipy `NI_ZoomShift`'s coordinate table with `zz = in/out`.
pub fn zoom_nearest_indices(in_dim: usize, out_dim: usize) -> Vec<usize> {
    assert!(in_dim > 0 && out_dim > 0);
    let zz = in_dim as f64 / out_dim as f64;
    (0..out_dim)
        .map(|kk| {
            // the exact op sequence: cc += 0.5; cc *= zoom; cc -= 0.5
            let mut cc = kk as f64;
            cc += 0.5;
            cc *= zz;
            cc -= 0.5;
            cc = map_coordinate_mirror(cc, in_dim);
            let start = (cc + 0.5).floor() as isize; // even-order branch
            debug_assert!(start >= 0 && (start as usize) < in_dim);
            start as usize
        })
        .collect()
}

/// Apply the two-axis nearest gather to an interleaved row-major image
/// (`channels`=1 for the seg map, 4 for RGBA). The trailing channel axis has
/// zoom factor 1.0, whose coordinate table is the identity.
pub fn resize_nearest<T: Copy>(
    data: &[T],
    w: usize,
    h: usize,
    channels: usize,
    out_w: usize,
    out_h: usize,
) -> Vec<T> {
    assert_eq!(data.len(), w * h * channels, "image buffer size mismatch");
    let rows = zoom_nearest_indices(h, out_h);
    let cols = zoom_nearest_indices(w, out_w);
    let mut out = Vec::with_capacity(out_w * out_h * channels);
    for &sy in &rows {
        for &sx in &cols {
            let p = (sy * w + sx) * channels;
            out.extend_from_slice(&data[p..p + channels]);
        }
    }
    out
}

/// `image.py::pad_sides_equally`: center-pad to `target_size` (width,
/// height) with a constant; `delta // 2` goes on the top/left. Deltas are
/// never negative on the inference path (the resize is an aspect-fit into
/// the target).
pub fn pad_sides_equally<T: Copy>(
    data: &[T],
    w: usize,
    h: usize,
    channels: usize,
    target_w: usize,
    target_h: usize,
    pad_value: T,
) -> Vec<T> {
    assert_eq!(data.len(), w * h * channels, "image buffer size mismatch");
    assert!(target_w >= w && target_h >= h, "pad target smaller than image");
    let (delta_w, delta_h) = (target_w - w, target_h - h);
    let (top, left) = (delta_h / 2, delta_w / 2);
    let mut out = vec![pad_value; target_w * target_h * channels];
    for y in 0..h {
        let dst = ((y + top) * target_w + left) * channels;
        let src = y * w * channels;
        out[dst..dst + w * channels].copy_from_slice(&data[src..src + w * channels]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixtures generated with the production-pinned scikit-image 0.24 /
    /// scipy 1.14.1 (`resize(np.arange(i).reshape(i,1), (o,1), order=0,
    /// preserve_range=True, anti_aliasing=False)`), covering odd/even
    /// factors, upscale, downscale and identity.
    #[test]
    fn nearest_indices_match_skimage() {
        let cases: Vec<(usize, usize, Vec<usize>)> = vec![
            (5, 3, vec![0, 2, 4]),
            (3, 5, vec![0, 0, 1, 2, 2]),
            (7, 2, vec![1, 5]),
            (2, 7, vec![0, 0, 0, 1, 1, 1, 1]),
            (4, 8, vec![0, 0, 1, 1, 2, 2, 3, 3]),
            (8, 4, vec![1, 3, 5, 7]),
            (9, 3, vec![1, 4, 7]),
            (3, 9, vec![0, 0, 0, 1, 1, 1, 2, 2, 2]),
            (10, 7, vec![0, 2, 3, 5, 6, 7, 9]),
            (7, 10, vec![0, 1, 1, 2, 3, 3, 4, 5, 5, 6]),
            (1, 4, vec![0, 0, 0, 0]),
            (4, 1, vec![2]), // cc = 1.5 -> floor(2.0) = 2 (round-half-up)
            (6, 6, vec![0, 1, 2, 3, 4, 5]),
        ];
        for (i, o, want) in cases {
            assert_eq!(zoom_nearest_indices(i, o), want, "in={i} out={o}");
        }
    }

    /// Long-axis spot checks from the same fixtures (corpus-shaped upscale
    /// and its reverse downscale).
    #[test]
    fn nearest_indices_long_axes() {
        let up = zoom_nearest_indices(422, 1024);
        assert_eq!(
            &up[..16],
            &[0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5, 6]
        );
        assert_eq!(&up[1020..], &[420, 420, 421, 421]);
        let down = zoom_nearest_indices(1024, 422);
        assert_eq!(
            &down[..16],
            &[1, 3, 6, 8, 10, 13, 15, 18, 20, 23, 25, 27, 30, 32, 35, 37]
        );
        assert_eq!(&down[418..], &[1015, 1017, 1020, 1022]);
    }

    #[test]
    fn resize_output_dims_truncates() {
        // f014: (422, 222) -> (1024, int(1024*222/422)) = (1024, 538)
        assert_eq!(resize_output_dims(422, 222, 1024, 1024), (1024, 538));
        // f035: (321, 318) -> (1024, 1014)
        assert_eq!(resize_output_dims(321, 318, 1024, 1024), (1024, 1014));
        // wider-than-target aspect goes through the other branch
        assert_eq!(resize_output_dims(200, 800, 1024, 1024), (256, 1024));
        assert_eq!(resize_output_dims(1024, 1024, 1024, 1024), (1024, 1024));
    }

    #[test]
    fn pad_sides_equally_centers_with_floor() {
        // 3x2 -> 6x5: delta_w=3 -> left 1, right 2; delta_h=3 -> top 1
        let data = vec![1i32, 2, 3, 4, 5, 6];
        let out = pad_sides_equally(&data, 3, 2, 1, 6, 5, -100);
        assert_eq!(out.len(), 30);
        assert_eq!(&out[..6], &[-100; 6]);
        assert_eq!(&out[6..12], &[-100, 1, 2, 3, -100, -100]);
        assert_eq!(&out[12..18], &[-100, 4, 5, 6, -100, -100]);
        assert!(out[18..].iter().all(|&v| v == -100));
    }
}
