//! Port of `segmentation/trapped_ball/cropping.py` — crop-to-content with
//! padding (`get_bbox_pad_dims` + `crop_image`) and the inverse `uncrop`
//! (np.pad mode='edge').
//!
//! PIL semantics replicated: `get_bbox_pad_dims` composites the grayscale
//! image over transparent black using itself as the mask; the composite's
//! alpha band equals the input values exactly (MULDIV255(255, m) == m), so
//! `getbbox()` reduces to the bounding box of nonzero input pixels, with
//! exclusive right/lower edges.

use super::Gray;

/// Pillow's `MULDIV255(a, b)` macro: `tmp = a*b + 128; ((tmp >> 8) + tmp) >> 8`
/// — the rounded (a*b)/255 used by `Image.composite`'s masked paste.
#[inline]
pub fn muldiv255(a: u8, b: u8) -> u8 {
    let tmp = a as u32 * b as u32 + 128;
    (((tmp >> 8) + tmp) >> 8) as u8
}

/// `segmentation/trapped_ball/cropping.py::get_bbox_pad_dims` for the RGBA
/// line-image input `prepare_image` passes (interleaved RGBA, row-major).
///
/// PIL semantics: `Image.composite(line, transparent_black, line)` blends
/// every band b as `MULDIV255(b, alpha)`, then `getbbox()` — which on the
/// production Pillow (>= 10, `alpha_only=True` default) trims by the
/// composite's ALPHA band only. So a pixel is inside the bbox iff
/// `MULDIV255(alpha, alpha) != 0` (i.e. alpha^2 + 128 >= 256, alpha >= 12);
/// the RGB bands never matter. Verified against all 13 production golden
/// metas (4 of which disagree with the any-band Pillow-9 semantics).
///
/// Returns ((top, bottom), (left, right)) pad dims; ((0, 0), (0, 0)) when no
/// pixel qualifies (the "no bounding box" fallback).
pub fn get_bbox_pad_dims_rgba(
    rgba: &[u8],
    w: usize,
    h: usize,
    padding: usize,
) -> ((usize, usize), (usize, usize)) {
    assert_eq!(rgba.len(), w * h * 4, "rgba buffer size mismatch");
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            let a = rgba[(y * w + x) * 4 + 3];
            if muldiv255(a, a) != 0 {
                any = true;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if !any {
        // "No bounding box found for line image, returning bbox for full image"
        return ((0, 0), (0, 0));
    }
    pad_bbox((x0, y0, x1, y1), w, h, padding)
}

/// The bbox -> pad-dims padding step shared by both `get_bbox_pad_dims`
/// variants: grow each side by `1 + padding` when the bbox does not reach
/// within `padding` of that edge.
fn pad_bbox(
    (x0, y0, x1, y1): (usize, usize, usize, usize),
    w: usize,
    h: usize,
    padding: usize,
) -> ((usize, usize), (usize, usize)) {
    let mut pb = [x0, y0, x1, y1];
    if x0 > padding {
        pb[0] = x0 - (1 + padding);
    }
    if y0 > padding {
        pb[1] = y0 - (1 + padding);
    }
    if x1 < w - padding {
        pb[2] = x1 + (1 + padding);
    }
    if y1 < h - padding {
        pb[3] = y1 + (1 + padding);
    }
    ((pb[1], h - pb[3]), (pb[0], w - pb[2]))
}

/// The `bbox_pad_dims is not None` branch of `cropping.py::crop_image`:
/// `Image.fromarray(image).crop((left, top, w - rightpad, h - bottompad))`.
///
/// PIL round-trip notes: `Image.fromarray` gives mode "I" for i32 2-D input
/// and "RGBA" for u8 HxWx4 input; in both cases `.crop(box)` with an
/// in-bounds box (always true here — the pad dims come from a bbox of the
/// same-sized line image) is a plain rectangular slice, and
/// `np.array(image, dtype=image_dtype)` restores the input dtype unchanged.
/// Generic over the element type with an interleaved `channels` count so the
/// i32 seg map (channels=1) and u8 RGBA images (channels=4) share it.
pub fn crop_with_pad_dims<T: Copy>(
    data: &[T],
    w: usize,
    h: usize,
    channels: usize,
    vert: (usize, usize),
    horiz: (usize, usize),
) -> (Vec<T>, usize, usize) {
    assert_eq!(data.len(), w * h * channels, "image buffer size mismatch");
    let (top, bottom_pad) = vert;
    let (left, right_pad) = horiz;
    assert!(
        top + bottom_pad <= h && left + right_pad <= w,
        "pad dims exceed image size"
    );
    let (bottom, right) = (h - bottom_pad, w - right_pad);
    let (ow, oh) = (right - left, bottom - top);
    let mut out = Vec::with_capacity(ow * oh * channels);
    for y in top..bottom {
        let row = &data[(y * w + left) * channels..(y * w + right) * channels];
        out.extend_from_slice(row);
    }
    (out, ow, oh)
}

/// `get_bbox_pad_dims(line_image, padding)` -> (vert_pad_dims,
/// horiz_pad_dims) = ((top, bottom), (left, right)) amounts that `uncrop`
/// must re-add. Returns ((0, 0), (0, 0)) when the image has no nonzero
/// pixel (the "no bounding box" fallback).
pub fn get_bbox_pad_dims(img: &Gray, padding: usize) -> ((usize, usize), (usize, usize)) {
    let (w, h) = (img.w, img.h);
    // PIL getbbox on the self-masked composite == bbox of nonzero pixels,
    // right/lower exclusive
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            if img.at(x, y) != 0 {
                any = true;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if !any {
        // "No bounding box found for line image, returning bbox for full image"
        return ((0, 0), (0, 0));
    }

    // if the bounding box doesn't reach within `padding` of an edge, grow
    // it by 1 + padding on that side
    let mut pb = [x0, y0, x1, y1];
    if x0 > padding {
        pb[0] = x0 - (1 + padding);
    }
    if y0 > padding {
        pb[1] = y0 - (1 + padding);
    }
    if x1 < w - padding {
        pb[2] = x1 + (1 + padding);
    }
    if y1 < h - padding {
        pb[3] = y1 + (1 + padding);
    }

    ((pb[1], h - pb[3]), (pb[0], w - pb[2]))
}

/// `crop_image(image, padding)` -> (cropped, vert_pad_dims, horiz_pad_dims).
pub fn crop_image(img: &Gray, padding: usize) -> (Gray, (usize, usize), (usize, usize)) {
    let (w, h) = (img.w, img.h);
    let (vert, horiz) = get_bbox_pad_dims(img, padding);
    let (top, bottom_pad) = vert;
    let (left, right_pad) = horiz;
    let (bottom, right) = (h - bottom_pad, w - right_pad);

    let mut out = Gray::new(right - left, bottom - top, 0);
    for (oy, y) in (top..bottom).enumerate() {
        out.data[oy * out.w..(oy + 1) * out.w]
            .copy_from_slice(&img.data[y * w + left..y * w + right]);
    }
    (out, vert, horiz)
}

/// `uncrop(cropped, vert_pad_dims, horiz_pad_dims)` = np.pad mode='edge':
/// out[y][x] = img[clamp(y - top)][clamp(x - left)].
pub fn uncrop(img: &Gray, vert: (usize, usize), horiz: (usize, usize)) -> Gray {
    let (w, h) = (img.w, img.h);
    let mut out = Gray::new(w + horiz.0 + horiz.1, h + vert.0 + vert.1, 0);
    for y in 0..out.h {
        let sy = (y as i64 - vert.0 as i64).clamp(0, h as i64 - 1) as usize;
        for x in 0..out.w {
            let sx = (x as i64 - horiz.0 as i64).clamp(0, w as i64 - 1) as usize;
            out.data[y * out.w + x] = img.data[sy * w + sx];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bbox_is_exclusive_and_padded() {
        // 40x30 image with content at x in [15, 20], y in [12, 14]
        let mut img = Gray::new(40, 30, 0);
        for y in 12..=14 {
            for x in 15..=20 {
                img.data[y * 40 + x] = 200;
            }
        }
        // raw bbox (15, 12, 21, 15); all sides > padding=10 away from edges
        let (cropped, vert, horiz) = crop_image(&img, 10);
        // padded bbox: (15-11, 12-11, 21+11, 15+11) = (4, 1, 32, 26)
        assert_eq!(vert, (1, 30 - 26));
        assert_eq!(horiz, (4, 40 - 32));
        assert_eq!((cropped.w, cropped.h), (28, 25));
        assert_eq!(cropped.at(15 - 4, 12 - 1), 200);
    }

    #[test]
    fn bbox_near_edge_is_not_grown() {
        // content reaches into the 10px margin on the left/top
        let mut img = Gray::new(40, 30, 0);
        img.data[5 * 40 + 8] = 1;
        img.data[20 * 40 + 25] = 1;
        let (_, vert, horiz) = crop_image(&img, 10);
        // left = 8 (<= 10, unchanged), top = 5 (<= 10, unchanged),
        // right = 26 + 11 = 37, bottom = 21 + 11 = 32 > 30? no: 21 < 20?
        // bottom edge: y1 = 21, h - padding = 20, 21 < 20 false -> unchanged
        assert_eq!(horiz, (8, 40 - 37));
        assert_eq!(vert, (5, 30 - 21));
    }

    #[test]
    fn empty_image_full_bbox() {
        let img = Gray::new(8, 6, 0);
        let (cropped, vert, horiz) = crop_image(&img, 10);
        assert_eq!(vert, (0, 0));
        assert_eq!(horiz, (0, 0));
        assert_eq!((cropped.w, cropped.h), (8, 6));
    }

    #[test]
    fn bbox_pad_dims_crop_branch() {
        // 8x6 i32 map; crop with externally supplied pad dims (the
        // prepare_image path: dims come from the LINE image, not this map)
        let w = 8;
        let h = 6;
        let data: Vec<i32> = (0..(w * h) as i32).collect();
        let (out, ow, oh) = crop_with_pad_dims(&data, w, h, 1, (1, 2), (3, 1));
        // rows 1..4 (6-2), cols 3..7 (8-1)
        assert_eq!((ow, oh), (4, 3));
        assert_eq!(
            out,
            vec![11, 12, 13, 14, 19, 20, 21, 22, 27, 28, 29, 30]
        );

        // RGBA (channels=4) slices per pixel
        let rgba: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
        let (outc, cw, ch) = crop_with_pad_dims(&rgba, w, h, 4, (0, 5), (7, 0));
        assert_eq!((cw, ch), (1, 1));
        assert_eq!(outc, rgba[7 * 4..8 * 4].to_vec());

        // zero pad dims = identity
        let (id, iw, ih) = crop_with_pad_dims(&data, w, h, 1, (0, 0), (0, 0));
        assert_eq!((iw, ih), (w, h));
        assert_eq!(id, data);
    }

    #[test]
    fn rgba_bbox_uses_selfcomposited_alpha_only() {
        // alpha 11 -> MULDIV255(11,11)=0 (outside bbox); alpha 12 -> 1
        // (inside); RGB bands never matter (alpha_only=True getbbox).
        assert_eq!(muldiv255(11, 11), 0);
        assert_eq!(muldiv255(12, 12), 1);
        let (w, h) = (40, 30);
        let mut rgba = vec![0u8; w * h * 4];
        // faint pixel: alpha 11 with bright RGB — must NOT count
        let p = (3 * w + 2) * 4;
        rgba[p..p + 4].copy_from_slice(&[255, 255, 255, 11]);
        // counting pixels at (15,12) and (20,14), alpha 12
        for (x, y) in [(15usize, 12usize), (20, 14)] {
            rgba[(y * w + x) * 4 + 3] = 12;
        }
        let (vert, horiz) = get_bbox_pad_dims_rgba(&rgba, w, h, 10);
        // raw bbox (15,12,21,15) -> padded (4,1,32,26), as in the Gray test
        assert_eq!(vert, (1, 30 - 26));
        assert_eq!(horiz, (4, 40 - 32));

        // all-faint image -> fallback ((0,0),(0,0))
        let mut faint = vec![0u8; w * h * 4];
        for px in faint.chunks_exact_mut(4) {
            px[3] = 11;
        }
        assert_eq!(get_bbox_pad_dims_rgba(&faint, w, h, 10), ((0, 0), (0, 0)));
    }

    #[test]
    fn uncrop_replicates_edges() {
        let mut img = Gray::new(2, 2, 0);
        img.data.copy_from_slice(&[1, 2, 3, 4]);
        let out = uncrop(&img, (1, 2), (2, 1));
        assert_eq!((out.w, out.h), (5, 5));
        assert_eq!(out.at(0, 0), 1); // top-left replicated
        assert_eq!(out.at(2, 1), 1);
        assert_eq!(out.at(4, 4), 4); // bottom-right replicated
        assert_eq!(out.at(0, 4), 3);
    }
}
