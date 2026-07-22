//! `/segment` — the Rust replica of `serving/handlers/segment.py::run_segment`
//! over `segmentation/gap_closing/inference.py::process_image`:
//!
//! - empty alpha  -> all-zero seg map, num_segments 1, no boundary field;
//! - strength <= 0 (or no gap model configured) -> trapped-ball only:
//!   `binarize(img, 'adaptive_mean')` + `compute_seg_fast(tb_sizes=[2,1,0],
//!   max_iter=10, min_seg_size=...)`, labels `.astype(np.uint8)`;
//! - strength > 0 -> `GapCloser.predict`: the ONNX UDF net per 512x512 tile
//!   (batch 1 — the composition verified 0-flips by `verify_gapclose --onnx`)
//!   feeding the tiled classical glue (`segment::tiled::gap_close_stages`).
//!
//! Response images go out through the cv2 encoder (grayscale, so no channel
//! swap), except the compare-skipped colorized visualization.

use crate::segment::tiler::Tiler;
use crate::segment::{binarize, compute_seg_fast_stages, tiled, Gray};

use super::codec;
use super::contract::{SegmentRequest, SegmentResponse};
use super::engine::Engine;

pub fn run_segment(engine: &Engine, req: &SegmentRequest) -> Result<SegmentResponse, String> {
    let img = codec::decode_png_uri_cv2(&req.line_image_uri, false)?;
    if img.channels != 4 {
        // process_image raises ValueError on non-RGBA inputs.
        return Err(format!(
            "Expected RGBA image (H, W, 4), got {} channel(s)",
            img.channels
        ));
    }
    let (w, h) = (img.w, img.h);
    let mut alpha = Gray::new(w, h, 0);
    for (dst, px) in alpha.data.iter_mut().zip(img.data.chunks_exact(4)) {
        *dst = px[3];
    }

    // check empty: img[:, :, 3].sum() == 0
    if alpha.data.iter().all(|&a| a == 0) {
        let thinned = Gray::new(w, h, 0);
        let colorized = req
            .return_colorized
            .then(|| colorized_uri(&thinned));
        return Ok(SegmentResponse {
            seg_map_uri: codec::encode_gray_uri_cv2(&thinned),
            colorized_seg_map_uri: colorized,
            boundary_binary_uri: None,
            num_segments: 1,
        });
    }

    let min_seg_size = req.min_seg_size as usize;
    let (labels_u8, boundary, num_segments) = if req.gap_closer_strength > 0.0
        && engine.gap_model_path.is_some()
    {
        gap_close_path(engine, &alpha, req.gap_closer_strength, min_seg_size)?
    } else {
        trapped_ball_path(&alpha, min_seg_size)
    };

    let colorized = req.return_colorized.then(|| colorized_uri(&labels_u8));
    Ok(SegmentResponse {
        seg_map_uri: codec::encode_gray_uri_cv2(&labels_u8),
        colorized_seg_map_uri: colorized,
        boundary_binary_uri: Some(codec::encode_gray_uri_cv2(&boundary)),
        num_segments,
    })
}

/// `process_image` with model=None: binarize + compute_seg_fast, labels cast
/// to u8; `num_regions = len(unique) - 1 if 0 in unique else len(unique)`
/// computed on the CAST array.
fn trapped_ball_path(alpha: &Gray, min_seg_size: usize) -> (Gray, Gray, u32) {
    let boundary = binarize::binarize_adaptive_mean(alpha);
    let labels = compute_seg_fast_stages(&boundary, [2, 1, 0], 10, min_seg_size).final_labels;
    let labels_u8 = Gray {
        w: labels.w,
        h: labels.h,
        data: labels.data.iter().map(|&v| v as u8).collect(),
    };
    let num = count_regions_u8(&labels_u8.data);
    (labels_u8, boundary, num)
}

/// `GapCloser.predict` with the ONNX UDF model: build the padded model
/// plane, forward every 512x512 tile (batch 1), compose each boundary tile,
/// then run the verified tiled classical glue.
fn gap_close_path(
    engine: &Engine,
    alpha: &Gray,
    strength: f32,
    min_seg_size: usize,
) -> Result<(Gray, Gray, u32), String> {
    let mi = tiled::build_model_input(alpha);
    let overlap = (tiled::TILE_SIZE as f64 * tiled::OVERLAP_FACTOR) as usize;
    let tiler = Tiler::new(
        [mi.padded_edge.h, mi.padded_edge.w],
        [tiled::TILE_SIZE, tiled::TILE_SIZE],
        [overlap, overlap],
    );

    // Gather every 512x512 tile, run the UDF net over them (batched on CoreML,
    // one at a time on CPU), then compose each tile's boundary.
    let tiles: Vec<_> = (0..tiler.n_tiles())
        .map(|tile_id| tiler.get_tile_f32(&mi.padded_edge, tile_id))
        .collect();
    let udfs = engine
        .run_gap_udfs(&tiles)?
        .ok_or("gap model disappeared mid-request")?;
    let boundaries: Vec<_> = tiles
        .iter()
        .zip(udfs.iter())
        .map(|(tile, udf)| tiled::tile_boundary_from_udf(udf, tile, strength))
        .collect();

    let stages = tiled::gap_close_stages(alpha, &boundaries, [2, 1, 0], 10, min_seg_size);

    // predict: `num_regions = len(unique) - 1 if 0 in unique else len(unique)`
    // over the PRE-relabel merged map (stage 10).
    let has_zero = stages.merged.data.contains(&0);
    let num = (stages.num_labels - has_zero as usize) as u32;

    Ok((stages.final_labels, stages.boundary_final, num))
}

fn count_regions_u8(labels: &[u8]) -> u32 {
    let mut seen = [false; 256];
    for &v in labels {
        seen[v as usize] = true;
    }
    let uniques = seen.iter().filter(|&&s| s).count() as u32;
    if seen[0] {
        uniques - 1
    } else {
        uniques
    }
}

/// `show_fill_map(labels)` visualization. Production colors each label with
/// UNSEEDED `np.random.randint` — the field is compare-skipped in the golden
/// contract — so the sidecar uses a deterministic pseudo-random colormap of
/// the same shape (H x W x 3 through the cv2 encoder).
fn colorized_uri(labels: &Gray) -> String {
    let color_of = |label: u8| -> [u8; 3] {
        let mut state = label as u32 * 0x9e37_79b9 + 0x85eb_ca6b;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 8) as u8
        };
        [next(), next(), next()]
    };
    let mut rgb = Vec::with_capacity(labels.w * labels.h * 3);
    for &v in &labels.data {
        rgb.extend_from_slice(&color_of(v));
    }
    codec::encode_rgb_uri_cv2(labels.w, labels.h, &rgb)
}
