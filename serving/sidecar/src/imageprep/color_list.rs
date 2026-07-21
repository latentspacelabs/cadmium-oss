//! Port of `colorize/common/frame.py::KeyFrame.compute_color_list` — the
//! serial path (`parallel=False`, the production tokenizer-pipeline default
//! at `pipeline_ant_v1.py::preprocess`) — following into
//! `colorize/common/color_extraction.py::compute_color_list_serial` /
//! `process_single_segment`, with `colorize/common/misc.py::peakiness_score`
//! and `colorize/common/ops.py::rgba_to_dense_flat`.
//!
//! Frame-construction semantics folded in:
//!   - `SegImageFrame.from_image` casts the 2-D i32 seg to uint32
//!     (`_maybe_bitshift`) — values are nonnegative labels, so the i32 map
//!     is used as-is; `num_segments = np.max(seg) + 1`;
//!   - `LineImageFrame.__init__` binarizes the RGBA line with
//!     `line.py::binarize(_, 'adaptive_mean')` (the already-ported
//!     `segment::binarize::binarize_adaptive_mean` on the alpha plane) and
//!     stores `1 - binary/255`; `line_mask = binarized != 0`, i.e. the
//!     adaptive-threshold output being 0 marks a line pixel;
//!   - `black_mask = all(line_rgba == [0, 0, 0, 255])` per pixel.

use crate::imageprep::Rgba;
use crate::segment::{binarize, Map32};

/// `color_extraction.py` NULL_COLOR.
pub const NULL_COLOR: i64 = -100;
/// `rgba_to_dense_flat([0, 0, 0, 0])`.
pub const TRANSPARENT_COLOR: i64 = 0;
/// `rgba_to_dense_flat([0, 0, 0, 255])` = 255 * 256^3.
pub const BLACK_COLOR: i64 = 255 * 256 * 256 * 256;

const PEAKINESS_THRESHOLD: f64 = 0.49;

/// Per-status counts (`aggregate_results` stats).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ColorListStats {
    pub num_total_segs: usize,
    pub num_multi_color_segs: usize,
    pub num_over_thresholded_segs: usize,
    pub num_transparent_segs: usize,
    pub num_black_segs: usize,
}

/// `ops.py::rgba_to_dense_flat`: r + 256 g + 256^2 b + 256^3 a (i64 — numpy
/// promotes the u8 rgb rows against the Python-int 255 alpha).
#[inline]
pub fn rgba_to_dense_flat(rgba: [u8; 4]) -> i64 {
    rgba[0] as i64
        + 256 * rgba[1] as i64
        + 256 * 256 * rgba[2] as i64
        + 256 * 256 * 256 * rgba[3] as i64
}

/// numpy's scalar pairwise summation (`pairwise_sum_DOUBLE`): naive below 8
/// elements, 8-accumulator unrolled blocks up to 128, then recursive halving
/// on 8-multiples. Replicated so `np.sum`/`np.mean` round-off matches when
/// the peakiness score sits near the threshold. (numpy's SIMD builds combine
/// lanes in a different order; the branch decision has enormous margins on
/// real palettes, and the golden gate would catch a flip.)
fn pairwise_sum(a: &[f64]) -> f64 {
    let n = a.len();
    if n < 8 {
        let mut res = 0.0;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - (n % 8) {
            for j in 0..8 {
                r[j] += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pairwise_sum(&a[..n2]) + pairwise_sum(&a[n2..])
    }
}

/// `misc.py::peakiness_score`: kurtosis (simplified formula) of the
/// normalized count distribution.
fn peakiness_score(counts: &[u64]) -> f64 {
    // np.sum on int64 counts is exact; the normalize divides in f64
    let total: u64 = counts.iter().sum();
    let dist: Vec<f64> = counts.iter().map(|&c| c as f64 / total as f64).collect();
    let n = dist.len() as f64;
    let mean = pairwise_sum(&dist) / n;
    let dev2: Vec<f64> = dist.iter().map(|&d| (d - mean) * (d - mean)).collect();
    let variance = pairwise_sum(&dev2) / n;
    let dev4: Vec<f64> = dev2.iter().map(|&d2| d2 * d2).collect();
    let kurtosis = pairwise_sum(&dev4) / n / (variance * variance);
    kurtosis
}

/// `KeyFrame.compute_color_list(seg_frame, color_frame, line_frame)` —
/// serial, line frame present (the production ref-frame call). Returns the
/// per-segment dense color list and the aggregate stats.
pub fn compute_color_list(seg: &Map32, color: &Rgba, line: &Rgba) -> (Vec<i64>, ColorListStats) {
    assert_eq!((seg.w, seg.h), (color.w, color.h), "seg/color size mismatch");
    assert_eq!((seg.w, seg.h), (line.w, line.h), "seg/line size mismatch");
    let n_px = seg.w * seg.h;

    // LineImageFrame: binarized = 1 - binarize(line, 'adaptive_mean')/255;
    // line_mask = binarized != 0  <=>  adaptive-threshold output == 0
    let alpha = line.alpha_plane();
    let binary = binarize::binarize_adaptive_mean(&alpha);
    let line_mask: Vec<bool> = binary.data.iter().map(|&b| b == 0).collect();

    let transparent_mask: Vec<bool> = (0..n_px).map(|i| color.data[i * 4 + 3] == 0).collect();
    let black_mask: Vec<bool> = (0..n_px)
        .map(|i| {
            let p = &line.data[i * 4..i * 4 + 4];
            p == [0, 0, 0, 255]
        })
        .collect();

    // num_segments = np.max(seg) + 1 (seg is contiguous 0..max — the
    // trapped-ball relabel guarantees it; process_single_segment asserts
    // each has pixels)
    let max_id = *seg.data.iter().max().expect("empty seg map");
    assert!(max_id >= 0, "negative seg ids in compute_color_list input");
    let num_segments = max_id as usize + 1;

    let mut color_list = Vec::with_capacity(num_segments);
    let mut stats = ColorListStats {
        num_total_segs: num_segments,
        ..Default::default()
    };

    for seg_idx in 0..num_segments as i32 {
        let mut num_pixels = 0usize;
        let mut n_no_line = 0usize;
        let mut n_no_line_transparent = 0usize;
        let mut n_not_black = 0usize;
        // pixels for the color histogram: in-seg, not line, not transparent
        let mut px: Vec<[u8; 3]> = Vec::new();
        for i in 0..n_px {
            if seg.data[i] != seg_idx {
                continue;
            }
            num_pixels += 1;
            if !black_mask[i] {
                n_not_black += 1;
            }
            if !line_mask[i] {
                n_no_line += 1;
                if transparent_mask[i] {
                    n_no_line_transparent += 1;
                }
                if !transparent_mask[i] {
                    px.push([
                        color.data[i * 4],
                        color.data[i * 4 + 1],
                        color.data[i * 4 + 2],
                    ]);
                }
            }
        }
        assert!(num_pixels > 0, "Seg {seg_idx} has no pixels");

        // 1) line mask covers the whole segment -> over-thresholded
        if n_no_line == 0 {
            color_list.push(NULL_COLOR);
            stats.num_over_thresholded_segs += 1;
            continue;
        }
        // 2) majority of non-line pixels transparent -> background
        if n_no_line_transparent as f64 > 0.5 * n_no_line as f64 {
            color_list.push(TRANSPARENT_COLOR);
            stats.num_transparent_segs += 1;
            continue;
        }
        // 3) every pixel pure black in the line layer -> black
        if n_not_black == 0 {
            color_list.push(BLACK_COLOR);
            stats.num_black_segs += 1;
            continue;
        }

        // np.unique(..., axis=0, return_counts=True): lexicographic row sort
        px.sort_unstable();
        let mut unique: Vec<([u8; 3], u64)> = Vec::new();
        for p in px {
            match unique.last_mut() {
                Some((u, c)) if *u == p => *c += 1,
                _ => unique.push((p, 1)),
            }
        }

        let score = if unique.len() > 1 {
            Some(peakiness_score(&unique.iter().map(|&(_, c)| c).collect::<Vec<_>>()) / unique.len() as f64)
        } else {
            None
        };

        // NaN scores (all counts equal -> 0/0 kurtosis) fail the >=
        // comparison, matching numpy
        if unique.len() == 1 || score.is_some_and(|s| s >= PEAKINESS_THRESHOLD) {
            // np.argmax(counts): first maximum, in sorted-color order
            let (dom, _) = unique
                .iter()
                .fold(None::<&([u8; 3], u64)>, |best, cur| match best {
                    Some(b) if b.1 >= cur.1 => Some(b),
                    _ => Some(cur),
                })
                .unwrap();
            color_list.push(rgba_to_dense_flat([dom[0], dom[1], dom[2], 255]));
        } else {
            color_list.push(NULL_COLOR);
            stats.num_multi_color_segs += 1;
        }
    }

    (color_list, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_constants() {
        assert_eq!(rgba_to_dense_flat([0, 0, 0, 0]), TRANSPARENT_COLOR);
        assert_eq!(rgba_to_dense_flat([0, 0, 0, 255]), BLACK_COLOR);
        assert_eq!(BLACK_COLOR, 4278190080);
        assert_eq!(rgba_to_dense_flat([255, 255, 255, 255]), 4294967295);
    }

    #[test]
    fn pairwise_sum_matches_naive_orderings() {
        // exact-representable values: any summation order agrees, which
        // pins the block boundaries without depending on round-off
        let a: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        assert_eq!(pairwise_sum(&a), (999 * 1000 / 2) as f64);
        for n in [0, 1, 7, 8, 9, 127, 128, 129, 300] {
            let b: Vec<f64> = (0..n).map(|i| (i * i) as f64).collect();
            let want: f64 = b.iter().sum();
            assert_eq!(pairwise_sum(&b), want, "n={n}");
        }
    }

    #[test]
    fn peakiness_flat_distribution_is_nan_scored() {
        // equal counts -> variance 0 -> kurtosis NaN -> comparison fails
        let s = peakiness_score(&[5, 5, 5]);
        assert!(s.is_nan());
        assert!(!(s >= PEAKINESS_THRESHOLD));
        // strongly peaked distribution scores high
        let s = peakiness_score(&[1000, 1, 1]);
        assert!(s > 1.0);
    }
}
