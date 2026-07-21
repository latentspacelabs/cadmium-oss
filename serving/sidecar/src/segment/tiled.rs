//! Byte-exact port of the TILED gap-closing `/segment` path:
//! `segmentation/gap_closing/gap_closer.py::GapCloser.predict` (classical
//! glue only — the ML UDF model's per-tile boundary outputs are inputs
//! here) plus `segmentation/trapped_ball/parallel.py` (`compute_seg_full`,
//! `build_border_data`, `compute_cc`). Verified per stage against goldens
//! dumped by `serving/tools/dump_gapcloser_goldens.py` (see
//! `src/bin/verify_gapclose.rs`).

use super::cropping;
use super::tiler::{Merger, PlaneF32, Tiler};
use super::{compute_seg_fast_stages, thinning, Gray, Map32};

/// Production `/segment` gap-closing constants (`GapCloser.predict` +
/// `run_segment` defaults).
pub const TILE_SIZE: usize = 512;
pub const OVERLAP_FACTOR: f64 = 0.5;
pub const CROP_PADDING: usize = 10;
pub const EDGE_WIDTH: usize = 2;
/// `GapCloser.forward`: udf_denormalized = udf_normalized * udf_max_dist
/// (production checkpoint hparam: 10.0), thresholded at `udf_threshold`
/// (the request's `gap_closer_strength`).
pub const UDF_MAX_DIST: f32 = 10.0;

/// Single-channel u32 map, row-major (the seg merger's `dtype=np.uint32`
/// output).
#[derive(Clone, PartialEq, Eq)]
pub struct MapU32 {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u32>,
}

/// One border-sample array from `parallel.py::build_border_data`
/// (top/bottom are `[mosaic_h, padded_w]`, left/right `[mosaic_w,
/// padded_h]`), initialized to -1 where no tile wrote.
#[derive(Clone, PartialEq, Eq)]
pub struct Border {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<i32>,
}

impl Border {
    fn new(rows: usize, cols: usize) -> Border {
        Border {
            rows,
            cols,
            data: vec![-1; rows * cols],
        }
    }
}

pub struct BorderData {
    pub top: Border,
    pub bottom: Border,
    pub left: Border,
    pub right: Border,
}

/// Every intermediate artifact of the tiled gap-closing pipeline, one per
/// golden stage of `serving/tools/dump_gapcloser_goldens.py`.
pub struct GapCloseStages {
    /// 01: `crop_image(alpha_roundtrip, padding=10)`
    pub cropped_alpha: Gray,
    pub vert_pad: (usize, usize),
    pub horiz_pad: (usize, usize),
    /// model tiler `calculate_padding()` (meta `model_tiler_padding`)
    pub model_padding: [(usize, usize); 2],
    /// 02: alpha/255 f32, np.pad mode='edge', 2px edge stamp to 1.0
    pub padded_edge: PlaneF32,
    /// meta `num_model_tiles`
    pub num_model_tiles: usize,
    /// 04: `255 - merger.merge(extra_padding, dtype=np.uint8) * 255`
    pub merged_boundary: Gray,
    /// seg tiler `calculate_padding()` (meta `seg_tiler_padding`)
    pub seg_padding: [(usize, usize); 2],
    /// 05: merged boundary padded (constant 0) for seg tiling
    pub seg_padded: Gray,
    pub num_seg_tiles: usize,
    pub max_seg_id: usize,
    /// (border_h_delta, border_w_delta) — both `int(512 * 0.5 / 2)`
    pub border_deltas: (usize, usize),
    /// 06: per-tile `compute_seg_fast` + `tile_id * 256`
    pub tile_segs: Vec<Map32>,
    /// 07: border samples
    pub borders: BorderData,
    /// 08: scipy `connected_components` labels over `max_seg_id` nodes
    pub n_labels: Vec<i32>,
    /// 09: seg `merger.merge(extra_padding, dtype=np.uint32)`
    pub unmerged: MapU32,
    /// 10: `n_labels[unmerged]`
    pub merged: Map32,
    /// meta `num_labels` (count of unique values in 10)
    pub num_labels: usize,
    /// 11: unique/return_inverse relabel, `astype(np.uint8)`, uncrop
    pub final_labels: Gray,
    /// 12: merged boundary after uncrop
    pub boundary_final: Gray,
}

/// `parallel.py::build_border_data` — samples each segged tile's
/// row/column at `border_delta` from each edge into shared border arrays
/// (later tiles overwrite earlier ones at overlapping positions, though
/// the sampled ranges are in fact disjoint), and adds every tile to the
/// seg merger.
pub fn build_border_data(
    tiler: &Tiler,
    merger: &mut Merger,
    segged_tiles: &[Map32],
    border_h_delta: usize,
    border_w_delta: usize,
) -> BorderData {
    let [mh, mw] = tiler.mosaic_shape();
    let [ph, pw] = tiler.padded_shape();
    let mut top = Border::new(mh, pw);
    let mut bottom = Border::new(mh, pw);
    let mut left = Border::new(mw, ph);
    let mut right = Border::new(mw, ph);
    let (bhd, bwd) = (border_h_delta, border_w_delta);

    for (tile_id, tile) in segged_tiles.iter().enumerate() {
        let (th, tw) = (tile.h, tile.w);
        let bbox = tiler.tile_bbox(tile_id);
        let (h_start, h_end) = bbox[0];
        let (w_start, w_end) = bbox[1];
        let [mosaic_h, mosaic_w] = tiler.tile_mosaic_position(tile_id);

        // top_border[mosaic_h, w_start+bwd : w_end-bwd] = tile[bhd, bwd : tw-bwd]
        // bottom samples row `th - bhd` (384, not the last row) — as written.
        for (k, c) in (w_start + bwd..w_end - bwd).enumerate() {
            top.data[mosaic_h * pw + c] = tile.data[bhd * tw + bwd + k];
            bottom.data[mosaic_h * pw + c] = tile.data[(th - bhd) * tw + bwd + k];
        }
        // left_border[mosaic_w, h_start+bhd : h_end-bhd] = tile[bhd : th-bhd, bwd]
        // right samples column `tw - bwd` (384).
        for (k, c) in (h_start + bhd..h_end - bhd).enumerate() {
            left.data[mosaic_w * ph + c] = tile.data[(bhd + k) * tw + bwd];
            right.data[mosaic_w * ph + c] = tile.data[(bhd + k) * tw + (tw - bwd)];
        }

        merger.add_i32(tile_id, &tile.data);
    }

    BorderData {
        top,
        bottom,
        left,
        right,
    }
}

/// `parallel.py::compute_cc` — builds the undirected graph pairing each
/// tile's bottom border row with the next tile row's top border (and right
/// with the next tile column's left), then labels connected components in
/// scipy 1.12 order: labels are assigned in increasing order of each
/// component's first-encountered node index scanning 0..n-1, and every
/// isolated node (unused id) is its own component.
///
/// QUIRKS preserved from the Python:
/// - bottom/top borders (whose columns run along the W axis) are trimmed
///   with `border_h_delta`, and left/right (columns along H) with
///   `border_w_delta` — the deltas are swapped relative to the axes, which
///   is invisible in production because both are 128;
/// - a `border_*_delta` of 0 would make the trim slice `[0:-0]` empty and
///   produce no edges at all.
pub fn compute_cc(
    borders: &BorderData,
    border_h_delta: usize,
    border_w_delta: usize,
    max_seg_id: usize,
) -> Vec<i32> {
    let mut parent: Vec<u32> = (0..max_seg_id as u32).collect();

    fn find(parent: &mut [u32], mut i: u32) -> u32 {
        while parent[i as usize] != i {
            parent[i as usize] = parent[parent[i as usize] as usize]; // path halving
            i = parent[i as usize];
        }
        i
    }
    let union = |parent: &mut Vec<u32>, a: i32, b: i32| {
        debug_assert!((a as usize) < max_seg_id && (b as usize) < max_seg_id);
        let (ra, rb) = (find(parent, a as u32), find(parent, b as u32));
        if ra != rb {
            // deterministic but arbitrary: component labels are recomputed
            // from first-occurrence order below, so tie-breaking is free
            parent[rb as usize] = ra;
        }
    };

    // rows = concat(bottom[:-1, bhd:-bhd], left[1:, bwd:-bwd]).ravel()
    // cols = concat(top[1:, bhd:-bhd],    right[:-1, bwd:-bwd]).ravel()
    // valid = (rows >= 0) & (cols >= 0)
    let (b, t) = (&borders.bottom, &borders.top);
    if border_h_delta > 0 {
        for r in 0..b.rows.saturating_sub(1) {
            for c in border_h_delta..b.cols - border_h_delta {
                let (row, col) = (b.data[r * b.cols + c], t.data[(r + 1) * t.cols + c]);
                if row >= 0 && col >= 0 {
                    union(&mut parent, row, col);
                }
            }
        }
    }
    let (l, rt) = (&borders.left, &borders.right);
    if border_w_delta > 0 {
        for r in 0..l.rows.saturating_sub(1) {
            for c in border_w_delta..l.cols - border_w_delta {
                let (row, col) = (l.data[(r + 1) * l.cols + c], rt.data[r * rt.cols + c]);
                if row >= 0 && col >= 0 {
                    union(&mut parent, row, col);
                }
            }
        }
    }

    // scipy connected_components(directed=False, return_labels=True) label
    // order: first-occurrence scan over node indices
    let mut labels = vec![0i32; max_seg_id];
    let mut root_label = vec![-1i32; max_seg_id];
    let mut next = 0i32;
    for i in 0..max_seg_id {
        let root = find(&mut parent, i as u32) as usize;
        if root_label[root] < 0 {
            root_label[root] = next;
            next += 1;
        }
        labels[i] = root_label[root];
    }
    labels
}

/// np.pad mode='edge' for f32 planes (clamped indexing).
fn pad_edge_f32(img: &PlaneF32, padding: [(usize, usize); 2]) -> PlaneF32 {
    let mut out = PlaneF32::new(
        img.w + padding[1].0 + padding[1].1,
        img.h + padding[0].0 + padding[0].1,
        0.0,
    );
    for y in 0..out.h {
        let sy = (y as i64 - padding[0].0 as i64).clamp(0, img.h as i64 - 1) as usize;
        for x in 0..out.w {
            let sx = (x as i64 - padding[1].0 as i64).clamp(0, img.w as i64 - 1) as usize;
            out.data[y * out.w + x] = img.data[sy * img.w + sx];
        }
    }
    out
}

/// np.pad mode='constant' (0) for u8 planes.
fn pad_constant_u8(img: &Gray, padding: [(usize, usize); 2]) -> Gray {
    let mut out = Gray::new(
        img.w + padding[1].0 + padding[1].1,
        img.h + padding[0].0 + padding[0].1,
        0,
    );
    for y in 0..img.h {
        let dst = (y + padding[0].0) * out.w + padding[1].0;
        out.data[dst..dst + img.w].copy_from_slice(&img.data[y * img.w..(y + 1) * img.w]);
    }
    out
}

/// Stages 01–02 of `GapCloser.predict` — everything that happens BEFORE the
/// ML model runs. Split out so the live /segment path can build the model's
/// input plane, forward the tiles through ONNX, and hand the boundary tiles
/// to [`gap_close_stages`].
pub struct ModelInput {
    /// 01: `crop_image(alpha_roundtrip, padding=10)`
    pub cropped_alpha: Gray,
    pub vert_pad: (usize, usize),
    pub horiz_pad: (usize, usize),
    /// model tiler `calculate_padding()` on the cropped shape
    pub model_padding: [(usize, usize); 2],
    /// 02: alpha/255 f32, np.pad mode='edge', 2px edge stamp to 1.0 — the
    /// plane the model tiler (built on THIS shape) iterates
    pub padded_edge: PlaneF32,
}

/// `GapCloser.predict` stages 01–02 from the RGBA input's alpha plane.
pub fn build_model_input(alpha: &Gray) -> ModelInput {
    let overlap = (TILE_SIZE as f64 * OVERLAP_FACTOR) as usize; // int(512 * 0.5) = 256

    // predict first converts alpha to f32/255 and derives the crop input
    // as `(image_np[0] * 255).astype(np.uint8)` — a truncating round trip
    // that is NOT assumed to be the identity; replicate it op for op.
    let mut crop_input = Gray::new(alpha.w, alpha.h, 0);
    for (dst, &a) in crop_input.data.iter_mut().zip(alpha.data.iter()) {
        *dst = ((a as f32 / 255.0) * 255.0) as u8;
    }

    // ---- stage 01: crop to content ----
    let (cropped_alpha, vert_pad, horiz_pad) = cropping::crop_image(&crop_input, CROP_PADDING);
    let (height, width) = (cropped_alpha.h, cropped_alpha.w);

    // ---- stage 02: f32, model-tiler edge padding, 2px edge stamp ----
    // The padding-calc tiler is built on the UNPADDED shape; it may have
    // zero tiles (tile_shape > data_shape) but calculate_padding is
    // well-defined regardless.
    let pad_calc_tiler = Tiler::new([height, width], [TILE_SIZE, TILE_SIZE], [overlap, overlap]);
    let (_, model_padding) = pad_calc_tiler.calculate_padding();

    let mut image = PlaneF32::new(width, height, 0.0);
    for (dst, &a) in image.data.iter_mut().zip(cropped_alpha.data.iter()) {
        *dst = a as f32 / 255.0;
    }
    let mut padded_edge = pad_edge_f32(&image, model_padding);
    let (pw, ph) = (padded_edge.w, padded_edge.h);
    for y in (0..EDGE_WIDTH).chain(ph - EDGE_WIDTH..ph) {
        padded_edge.data[y * pw..(y + 1) * pw].fill(1.0);
    }
    for y in 0..ph {
        for x in (0..EDGE_WIDTH).chain(pw - EDGE_WIDTH..pw) {
            padded_edge.data[y * pw + x] = 1.0;
        }
    }

    ModelInput {
        cropped_alpha,
        vert_pad,
        horiz_pad,
        model_padding,
        padded_edge,
    }
}

/// `GapCloser.forward`'s boundary composition for ONE tile, given the ONNX
/// UDF output: `(udf * udf_max_dist < threshold)` max'd with the inverted
/// binarize of the tile round-tripped to u8 — exactly the composition
/// verified 0-flips against the golden tile boundaries by
/// `verify_gapclose --onnx`. Returns a {0,1} u8 tile.
pub fn tile_boundary_from_udf(udf: &[f32], tile: &PlaneF32, threshold: f32) -> Gray {
    assert_eq!(udf.len(), tile.w * tile.h, "udf/tile size mismatch");
    // 1 - binarize((tile * 255).astype(np.uint8)) / 255 — line.py's 2-D
    // branch is im = 255 - img, which binarize_adaptive_mean applies.
    let mut img_u8 = Gray::new(tile.w, tile.h, 0);
    for (dst, &v) in img_u8.data.iter_mut().zip(tile.data.iter()) {
        *dst = (v * 255.0) as u8;
    }
    let binary = super::binarize::binarize_adaptive_mean(&img_u8);

    let mut out = Gray::new(tile.w, tile.h, 0);
    for i in 0..tile.w * tile.h {
        let from_udf = (udf[i] * UDF_MAX_DIST < threshold) as u8;
        let from_binarize = 1 - binary.data[i] / 255;
        out.data[i] = from_udf.max(from_binarize);
    }
    out
}

/// The full `GapCloser.predict` classical glue, from the RGBA input's
/// alpha plane and the ML model's per-tile boundary outputs (stage 03,
/// u8 {0,1}, one 512x512 tile per model tile in tile_id order) to the
/// final label map, with every stage retained. Production parameters are
/// `tb_sizes=[2,1,0], tb_max_iter=10, tb_min_seg_size=10`.
pub fn gap_close_stages(
    alpha: &Gray,
    tile_boundaries: &[Gray],
    tb_sizes: [usize; 3],
    tb_max_iter: usize,
    tb_min_seg_size: usize,
) -> GapCloseStages {
    let overlap = (TILE_SIZE as f64 * OVERLAP_FACTOR) as usize; // int(512 * 0.5) = 256

    let ModelInput {
        cropped_alpha,
        vert_pad,
        horiz_pad,
        model_padding,
        padded_edge,
    } = build_model_input(alpha);
    let (height, width) = (cropped_alpha.h, cropped_alpha.w);
    let (pw, ph) = (padded_edge.w, padded_edge.h);

    // ---- stages 03/04: merge the model's boundary tiles ----
    // A NEW tiler is built on the padded shape (mode default "constant")
    // and iterated; the boundary tiles are the ML outputs, given.
    let model_tiler = Tiler::new([ph, pw], [TILE_SIZE, TILE_SIZE], [overlap, overlap]);
    let num_model_tiles = model_tiler.n_tiles();
    assert_eq!(
        tile_boundaries.len(),
        num_model_tiles,
        "need one boundary tile per model tile"
    );
    let mut boundary_merger = Merger::overlap_tile(&model_tiler);
    for (tile_id, tile) in tile_boundaries.iter().enumerate() {
        boundary_merger.add_u8(tile_id, tile);
    }
    // merged_boundary = 255 - (merger.merge(extra_padding, dtype=np.uint8) * 255)
    // (uint8 arithmetic wraps like numpy's; the astype cast truncates)
    let merged_f32 = boundary_merger.merge(model_padding);
    let mut merged_boundary = Gray::new(merged_f32.w, merged_f32.h, 0);
    for (dst, &v) in merged_boundary.data.iter_mut().zip(merged_f32.data.iter()) {
        *dst = 255u8.wrapping_sub((v as u8).wrapping_mul(255));
    }

    // ---- stage 05: seg tiler padding (constant 0) ----
    let mut seg_tiler = Tiler::new([height, width], [TILE_SIZE, TILE_SIZE], [overlap, overlap]);
    let (seg_new_shape, seg_padding) = seg_tiler.calculate_padding();
    seg_tiler.recalculate(seg_new_shape);
    let seg_padded = pad_constant_u8(&merged_boundary, seg_padding);

    // ---- stage 06: per-tile compute_seg_fast + tile_id * 256 ----
    let num_seg_tiles = seg_tiler.n_tiles();
    let max_seg_id = num_seg_tiles * 512;
    let tile_segs: Vec<Map32> = (0..num_seg_tiles)
        .map(|tile_id| {
            let tile = seg_tiler.get_tile_u8(&seg_padded, tile_id);
            let mut seg =
                compute_seg_fast_stages(&tile, tb_sizes, tb_max_iter, tb_min_seg_size).final_labels;
            for v in seg.data.iter_mut() {
                *v += (tile_id * 256) as i32;
            }
            seg
        })
        .collect();

    // ---- stage 07: border sampling + seg merger accumulation ----
    let border_h_delta = ((seg_tiler.tile_shape[0] as f64 * OVERLAP_FACTOR) / 2.0) as usize;
    let border_w_delta = ((seg_tiler.tile_shape[1] as f64 * OVERLAP_FACTOR) / 2.0) as usize;
    let mut seg_merger = Merger::overlap_tile(&seg_tiler);
    let borders = build_border_data(
        &seg_tiler,
        &mut seg_merger,
        &tile_segs,
        border_h_delta,
        border_w_delta,
    );

    // ---- stage 08: connected components across tile borders ----
    let n_labels = compute_cc(&borders, border_h_delta, border_w_delta, max_seg_id);

    // ---- stage 09: seg merge (dtype=np.uint32) ----
    let unmerged_f32 = seg_merger.merge(seg_padding);
    let unmerged = MapU32 {
        w: unmerged_f32.w,
        h: unmerged_f32.h,
        data: unmerged_f32.data.iter().map(|&v| v as u32).collect(),
    };

    // ---- stage 10: n_labels[unmerged] ----
    let mut merged = Map32::new(unmerged.w, unmerged.h, 0);
    for (dst, &v) in merged.data.iter_mut().zip(unmerged.data.iter()) {
        assert!((v as usize) < max_seg_id, "seg id {v} out of range");
        *dst = n_labels[v as usize];
    }

    // ---- stages 11/12: relabel, uint8 cast, uncrop ----
    let (relabeled, num_labels) = thinning::relabel(&merged);
    let mut final_labels = Gray::new(relabeled.w, relabeled.h, 0);
    for (dst, &v) in final_labels.data.iter_mut().zip(relabeled.data.iter()) {
        *dst = v as u8; // .astype(np.uint8) wraps
    }
    let mut boundary_final = merged_boundary.clone();
    if vert_pad != (0, 0) || horiz_pad != (0, 0) {
        final_labels = cropping::uncrop(&final_labels, vert_pad, horiz_pad);
        boundary_final = cropping::uncrop(&boundary_final, vert_pad, horiz_pad);
    }

    GapCloseStages {
        cropped_alpha,
        vert_pad,
        horiz_pad,
        model_padding,
        padded_edge,
        num_model_tiles,
        merged_boundary,
        seg_padding,
        seg_padded,
        num_seg_tiles,
        max_seg_id,
        border_deltas: (border_h_delta, border_w_delta),
        tile_segs,
        borders,
        n_labels,
        unmerged,
        merged,
        num_labels,
        final_labels,
        boundary_final,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// scipy label order: component of node 0 gets label 0; each later
    /// unvisited node starts the next label; isolated nodes are their own
    /// components.
    #[test]
    fn compute_cc_matches_scipy_label_order() {
        // 5 nodes, single edge (3, 1): components {0}, {1,3}, {2}, {4}
        let mut borders = BorderData {
            top: Border::new(2, 3),
            bottom: Border::new(2, 3),
            left: Border::new(1, 3),
            right: Border::new(1, 3),
        };
        // bottom[0, 1] = 3 pairs with top[1, 1] = 1 (delta 1 trims col 0/2)
        borders.bottom.data[1] = 3;
        borders.top.data[3 + 1] = 1;
        let labels = compute_cc(&borders, 1, 1, 5);
        assert_eq!(labels, vec![0, 1, 2, 1, 3]);
    }

    #[test]
    fn compute_cc_ignores_minus_one_and_zero_delta() {
        let mut borders = BorderData {
            top: Border::new(2, 3),
            bottom: Border::new(2, 3),
            left: Border::new(1, 3),
            right: Border::new(1, 3),
        };
        borders.bottom.data[1] = 2; // pairs with top[1,1] = -1 -> dropped
        let labels = compute_cc(&borders, 1, 1, 3);
        assert_eq!(labels, vec![0, 1, 2]);
        // delta 0 -> Python's [0:-0] empty slice -> no edges at all
        borders.top.data[3 + 1] = 2;
        let labels = compute_cc(&borders, 0, 0, 3);
        assert_eq!(labels, vec![0, 1, 2]);
    }

    #[test]
    fn border_sampling_positions() {
        // 2x1 mosaic of 512-tiles over a 768x512 padded canvas
        let mut seg_tiler = Tiler::new([512, 256], [512, 512], [256, 256]);
        let (new_shape, _) = seg_tiler.calculate_padding();
        seg_tiler.recalculate(new_shape); // (768, 512): mosaic [2, 1]
        assert_eq!(seg_tiler.mosaic_shape(), [2, 1]);

        let mut tiles = Vec::new();
        for tile_id in 0..2 {
            let mut t = Map32::new(512, 512, 0);
            for y in 0..512 {
                for x in 0..512 {
                    // encode (tile, y, x) so sampled positions are checkable
                    t.data[y * 512 + x] = (tile_id * 1_000_000 + y * 1000 + x) as i32;
                }
            }
            tiles.push(t);
        }
        let mut merger = Merger::overlap_tile(&seg_tiler);
        let b = build_border_data(&seg_tiler, &mut merger, &tiles, 128, 128);

        // top row of tile 1 (mosaic row 1) sampled at tile row 128
        assert_eq!(b.top.data[1 * 512 + 128], 1_000_000 + 128 * 1000 + 128);
        // bottom sampled at row 512-128 = 384 (not 383/511)
        assert_eq!(b.bottom.data[0 * 512 + 130], 384 * 1000 + 130);
        // left border of the single mosaic column: tile 1 rows are offset
        // by its bbox start 256
        assert_eq!(b.left.data[256 + 128 + 3], 1_000_000 + (128 + 3) * 1000 + 128);
        // untouched positions stay -1
        assert_eq!(b.top.data[0], -1);
        assert_eq!(b.top.data[1 * 512 + 500], -1);
    }
}
