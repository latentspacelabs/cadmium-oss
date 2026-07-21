//! Byte-exact Rust port of the Cadmium `/segment` classical pipeline
//! (`segmentation/trapped_ball/trapped_ball.py::compute_seg_fast` plus
//! `line.py::binarize`), replicating production cv2 4.11 semantics —
//! including the original code's quirks/bugs, which are load-bearing for
//! byte-exactness. Verified per-stage against goldens dumped by
//! `serving/tools/dump_segment_goldens.py` (see `src/bin/verify_segment.rs`).
//!
//! The TILED gap-closing path (`GapCloser.predict`'s classical glue over
//! `parallel.py`/`cropping.py`/the `tiler` package) lives in `tiled`,
//! `tiler` and `cropping`, verified by `src/bin/verify_gapclose.rs`
//! against `serving/tools/dump_gapcloser_goldens.py` goldens.

pub mod binarize;
pub mod contour;
pub mod cropping;
pub mod flood;
pub mod merge;
pub mod morph;
pub mod thinning;
pub mod tiled;
pub mod tiler;
pub mod trapped_ball;

/// Single-channel u8 image, row-major (C order).
#[derive(Clone, PartialEq, Eq)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl Gray {
    pub fn new(w: usize, h: usize, fill: u8) -> Self {
        Gray {
            w,
            h,
            data: vec![fill; w * h],
        }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.w + x]
    }
}

/// Single-channel i32 label map, row-major (C order).
#[derive(Clone, PartialEq, Eq)]
pub struct Map32 {
    pub w: usize,
    pub h: usize,
    pub data: Vec<i32>,
}

impl Map32 {
    pub fn new(w: usize, h: usize, fill: i32) -> Self {
        Map32 {
            w,
            h,
            data: vec![fill; w * h],
        }
    }
}

/// All intermediate artifacts of `compute_seg_fast`, one per golden stage.
pub struct Stages {
    /// 01: `binarize(img, 'adaptive_mean')`
    pub binary: Gray,
    /// 02: marked result after trapped-ball r=2 (method='max')
    pub tb_r2: Gray,
    /// 03: after trapped-ball r=1 (method=None)
    pub tb_r1: Gray,
    /// 04: after trapped-ball r=0 (method=None)
    pub tb_r0: Gray,
    /// number of fills recorded per stage (r2, r1, r0, flood) — mirrors
    /// meta.json's `fills_per_stage` for cross-checking
    pub fills_per_stage: [usize; 4],
    /// 05: `build_fill_map` after `flood_fill_multi`
    pub fillmap: Map32,
    /// 06: `merge_fill(fillmap, max_iter, min_seg_size)`
    pub merged: Map32,
    /// 07: `thinning(merged)`
    pub thinned: Map32,
    /// 08: relabeled (`np.unique(..., return_inverse=True)`)
    pub final_labels: Map32,
    /// number of unique labels in 08 (meta.json `num_labels`)
    pub num_labels: usize,
}

/// The full `compute_seg_fast` pipeline starting from an already-binarized
/// image, with every stage retained (the production call is
/// `tb_sizes=[2,1,0], max_iter=10, min_seg_size=10`).
pub fn compute_seg_fast_stages(
    binary: &Gray,
    tb_sizes: [usize; 3],
    max_iter: usize,
    min_seg_size: usize,
) -> Stages {
    let mut fills: Vec<Vec<u32>> = Vec::new();
    let mut fills_per_stage = [0usize; 4];

    let mut result = binary.clone();

    let fill = trapped_ball::trapped_ball_fill_multi(
        &result,
        tb_sizes[0],
        trapped_ball::FilterMethod::Max,
        1000,
    );
    fills_per_stage[0] = fill.len();
    result = trapped_ball::mark_fill(&result, &fill);
    fills.extend(fill);
    let tb_r2 = result.clone();

    let fill = trapped_ball::trapped_ball_fill_multi(
        &result,
        tb_sizes[1],
        trapped_ball::FilterMethod::None,
        1000,
    );
    fills_per_stage[1] = fill.len();
    result = trapped_ball::mark_fill(&result, &fill);
    fills.extend(fill);
    let tb_r1 = result.clone();

    let fill = trapped_ball::trapped_ball_fill_multi(
        &result,
        tb_sizes[2],
        trapped_ball::FilterMethod::None,
        1000,
    );
    fills_per_stage[2] = fill.len();
    result = trapped_ball::mark_fill(&result, &fill);
    fills.extend(fill);
    let tb_r0 = result.clone();

    let fill = trapped_ball::flood_fill_multi(&result, 20000);
    fills_per_stage[3] = fill.len();
    fills.extend(fill);

    let fillmap = trapped_ball::build_fill_map(binary.w, binary.h, &fills);

    let merged = merge::merge_fill(&fillmap, max_iter, min_seg_size);

    let thinned = thinning::thinning(&merged, 100);

    let (final_labels, num_labels) = thinning::relabel(&thinned);

    Stages {
        binary: binary.clone(),
        tb_r2,
        tb_r1,
        tb_r0,
        fills_per_stage,
        fillmap,
        merged,
        thinned,
        final_labels,
        num_labels,
    }
}

/// Production `/segment` classical path: binarize the RGBA input's alpha
/// plane, then run `compute_seg_fast(binary, tb_sizes=[2,1,0], max_iter=10,
/// min_seg_size=10)`. Returns the final i32 label map (the u8 cast that
/// `inference.py::process_image` performs downstream is the caller's
/// business).
pub fn segment_from_alpha(alpha: &Gray) -> Map32 {
    let binary = binarize::binarize_adaptive_mean(alpha);
    compute_seg_fast_stages(&binary, [2, 1, 0], 10, 10).final_labels
}
