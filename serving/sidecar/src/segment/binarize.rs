//! Port of `segmentation/trapped_ball/line.py::binarize(img, 'adaptive_mean')`
//! — i.e. `cv2.adaptiveThreshold(255 - alpha, 255, ADAPTIVE_THRESH_MEAN_C,
//! THRESH_BINARY, 51, 2)`.
//!
//! cv2 semantics replicated exactly (OpenCV 4.11 `thresh.cpp` +
//! `box_filter.simd.hpp`):
//! - mean = normalized 51x51 box filter of the source, u8 output, border
//!   BORDER_REPLICATE (out-of-bounds samples replicate the edge pixel, with
//!   multiplicity);
//! - the normalization rounds `sum * (1/2601)` with round-half-to-EVEN
//!   (`cvRound`). OpenCV's SIMD path computes this in f32 and its scalar
//!   tail in f64; for a 51x51 kernel the two can never disagree (the
//!   closest `sum/2601` gets to a half-integer is 0.5/2601 ~ 1.9e-4, far
//!   above the ~4e-5 worst-case f32 error), so f64 is used here;
//! - dst = 255 where `src - mean > -idelta` with `idelta = ceil(2.0) = 2`
//!   (the LUT `tab[i] = i - 255 > -2 ? 255 : 0` applied to
//!   `src - mean + 255`).

use super::Gray;

const NEIGHBORHOOD: usize = 51;
const RADIUS: usize = NEIGHBORHOOD / 2; // 25
const CONSTANT_IDELTA: i32 = 2; // cvCeil(2.0)

/// `binarize(img, type='adaptive_mean')` for an RGBA input, taking the
/// alpha plane: `im = 255 - alpha`, then adaptive-mean threshold.
pub fn binarize_adaptive_mean(alpha: &Gray) -> Gray {
    let (w, h) = (alpha.w, alpha.h);
    let mut im = Gray::new(w, h, 0);
    for (dst, &a) in im.data.iter_mut().zip(alpha.data.iter()) {
        *dst = 255 - a;
    }
    adaptive_threshold_mean(&im)
}

/// `cv2.adaptiveThreshold(im, 255, ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY,
/// 51, 2)`.
pub fn adaptive_threshold_mean(im: &Gray) -> Gray {
    let mean = box_mean_51_replicate(im);
    let (w, h) = (im.w, im.h);
    let mut out = Gray::new(w, h, 0);
    for i in 0..w * h {
        let diff = im.data[i] as i32 - mean.data[i] as i32;
        out.data[i] = if diff > -CONSTANT_IDELTA { 255 } else { 0 };
    }
    out
}

/// Normalized 51x51 box filter, u8 in/out, BORDER_REPLICATE, cvRound
/// (round-half-even) normalization. Separable: horizontal replicated
/// sliding sums, then vertical.
fn box_mean_51_replicate(im: &Gray) -> Gray {
    let (w, h) = (im.w, im.h);
    assert!(w > 0 && h > 0);

    // Horizontal pass: rowsum[y][x] = sum_{dx=-25..25} im[y][clamp(x+dx)]
    let mut rowsum = vec![0i32; w * h];
    for y in 0..h {
        let row = &im.data[y * w..(y + 1) * w];
        let out = &mut rowsum[y * w..(y + 1) * w];
        // initial window centered at x=0: indices -25..=25 clamped
        let mut s: i32 = (RADIUS as i32 + 1) * row[0] as i32; // x = -25..=0 clamped to 0
        for x in 1..=RADIUS.min(w - 1) {
            s += row[x] as i32;
        }
        if w - 1 < RADIUS {
            // replicate right edge for the part of the initial window beyond w-1
            s += (RADIUS - (w - 1)) as i32 * row[w - 1] as i32;
        }
        out[0] = s;
        for x in 1..w {
            let add = row[(x + RADIUS).min(w - 1)] as i32;
            // leaving index is (x-1) - 25, clamped to 0
            let sub = row[(x as i32 - 1 - RADIUS as i32).max(0) as usize] as i32;
            s += add - sub;
            out[x] = s;
        }
    }

    // Vertical pass: colsum[y][x] = sum_{dy=-25..25} rowsum[clamp(y+dy)][x],
    // then normalize with round-half-even.
    let scale = 1.0f64 / (NEIGHBORHOOD * NEIGHBORHOOD) as f64;
    let mut mean = Gray::new(w, h, 0);
    let mut colsum = vec![0i64; w];
    // initial window centered at y=0
    for x in 0..w {
        colsum[x] = (RADIUS as i64 + 1) * rowsum[x] as i64;
    }
    for y in 1..=RADIUS.min(h - 1) {
        for x in 0..w {
            colsum[x] += rowsum[y * w + x] as i64;
        }
    }
    if h - 1 < RADIUS {
        for x in 0..w {
            colsum[x] += (RADIUS - (h - 1)) as i64 * rowsum[(h - 1) * w + x] as i64;
        }
    }
    for y in 0..h {
        if y > 0 {
            let add_row = (y + RADIUS).min(h - 1) * w;
            let sub_row = (y as i32 - 1 - RADIUS as i32).max(0) as usize * w;
            for x in 0..w {
                colsum[x] += rowsum[add_row + x] as i64 - rowsum[sub_row + x] as i64;
            }
        }
        let out = &mut mean.data[y * w..(y + 1) * w];
        for x in 0..w {
            let v = (colsum[x] as f64 * scale).round_ties_even();
            out[x] = v.clamp(0.0, 255.0) as u8;
        }
    }
    mean
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brute-force reference for the replicated box mean.
    fn box_mean_naive(im: &Gray) -> Gray {
        let (w, h) = (im.w, im.h);
        let mut out = Gray::new(w, h, 0);
        for y in 0..h {
            for x in 0..w {
                let mut s: i64 = 0;
                for dy in -(RADIUS as i32)..=(RADIUS as i32) {
                    for dx in -(RADIUS as i32)..=(RADIUS as i32) {
                        let yy = (y as i32 + dy).clamp(0, h as i32 - 1) as usize;
                        let xx = (x as i32 + dx).clamp(0, w as i32 - 1) as usize;
                        s += im.data[yy * w + xx] as i64;
                    }
                }
                let v = (s as f64 / (NEIGHBORHOOD * NEIGHBORHOOD) as f64).round_ties_even();
                out.data[y * w + x] = v.clamp(0.0, 255.0) as u8;
            }
        }
        out
    }

    #[test]
    fn sliding_box_matches_naive() {
        // deterministic pseudo-random small image, wider and narrower than
        // the kernel in each dimension
        for (w, h) in [(60usize, 40usize), (20, 70), (10, 10)] {
            let mut im = Gray::new(w, h, 0);
            let mut state = 0x12345678u32;
            for v in im.data.iter_mut() {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                *v = (state >> 24) as u8;
            }
            let fast = box_mean_51_replicate(&im);
            let naive = box_mean_naive(&im);
            assert_eq!(fast.data, naive.data, "w={} h={}", w, h);
        }
    }

    #[test]
    fn threshold_lut_semantics() {
        // dst = 255 iff src > mean - 2, i.e. src >= mean - 1
        let mut im = Gray::new(1, 1, 0);
        im.data[0] = 100;
        // uniform image: mean == src -> diff 0 > -2 -> 255
        let out = adaptive_threshold_mean(&im);
        assert_eq!(out.data[0], 255);
    }
}
