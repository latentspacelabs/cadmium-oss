//! `/colorize` — the Rust replica of
//! `serving/handlers/colorize.py::run_colorize` over the AnT v2 pipeline
//! (`AnTV1Pipeline.preprocess` -> ONNX forward -> `AnTV2Pipeline.postprocess`),
//! with the model forward going through the export graph
//! (`serving/onnx/export_ant_v2.py`) exactly as the parity harnesses drive it.
//!
//! Channel-order contract (load-bearing): `base64_png_uri_to_img` is
//! cv2.imdecode, so LINE images flow through the whole pipeline in B,G,R,A
//! order — the UNet consumes them that way in production (the SDF is
//! channel-order invariant: min over RGB). Seg maps are grayscale PNGs (2-D).
//! Response renders are RGBA-ordered arrays pushed through the cv2 ENCODER,
//! i.e. stored R/B-swapped — replicated so decoded pixels match production.
//!
//! Chain:
//!   decode (cv2)                         -> u8 frames
//!   ref colors_rgba -> rgba_to_dense_flat -> ref color_list -> Palette
//!   prepare_image_stages (both frames)   -> 1024x1024 padded seg/line
//!   vendored vtracer on the vtrace RGBA  -> SVG -> command tensors -> feeds
//!   ONNX packed_logits (1, R+T, 512)     -> target rows -> argmax ids
//!   postprocess (id clamp, colors, FULL-RES renders from the pre-prepare
//!   frames — `PartialSequence.from_keyframes` deep-copies, so the renders
//!   never see the prepared/padded data)  -> response

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::imageprep::{self, Rgba};
use crate::postprocess;
use crate::tokenize::{self, feed, palette, svg::Svg, Tensor};

use super::codec;
use super::contract::{ColorizeRequest, ColorizeResponse};
use super::engine::Engine;
use super::preprocess_impl::seg_frame_from_decoded;

/// The UNet's output resolution for the fixed 1024x1024 prepared inputs
/// (`probe_lowres_hw` on the production checkpoint; the tokenizer goldens
/// record `lowres_hw: [512, 512]`).
const LOWRES_HW: (usize, usize) = (512, 512);
/// The graph's palette dimension (`max_palette`; `packed_logits` dim 2).
const PALETTE_DIM: usize = 512;

pub fn run_colorize(engine: &Engine, req: &ColorizeRequest) -> Result<ColorizeResponse, String> {
    let t0 = Instant::now();

    // -- reference resolution (references list preferred, legacy flat fields)
    let (ref_seg_uri, ref_line_uri, ref_colors_rgba): (&str, &str, &[[i64; 4]]) =
        match req.references.as_deref() {
            Some([first, rest @ ..]) => {
                if !rest.is_empty() {
                    tracing::info!(
                        "run_colorize: {} references supplied; using the first.",
                        rest.len() + 1
                    );
                }
                (
                    first.seg_map_uri.as_str(),
                    first.line_image_uri.as_str(),
                    &first.colors_rgba,
                )
            }
            _ => match (&req.ref_seg_map_uri, &req.ref_line_image_uri, &req.ref_colors_rgba) {
                (Some(seg), Some(line), Some(colors)) => {
                    (seg.as_str(), line.as_str(), colors.as_slice())
                }
                _ => {
                    return Err(
                        "run_colorize: no reference provided — expected a `references` list or \
                         the legacy ref_seg_map_uri/ref_line_image_uri/ref_colors_rgba fields."
                            .into(),
                    )
                }
            },
        };

    // -- decode (cv2 semantics: standard base64, BGRA color order)
    let ref_seg = seg_frame_from_decoded(&codec::decode_png_uri_cv2(ref_seg_uri, false)?)?;
    let ref_line = line_from_cv2(codec::decode_png_uri_cv2(ref_line_uri, false)?)?;
    let tgt_seg = seg_frame_from_decoded(&codec::decode_png_uri_cv2(&req.target_seg_map_uri, false)?)?;
    let tgt_line = line_from_cv2(codec::decode_png_uri_cv2(&req.target_line_image_uri, false)?)?;

    // -- ref color list + palette (rgba_to_dense_flat over the raw request
    //    colors; -100 entries keep the add-before-null-check palette quirk)
    let ref_color_list: Vec<i64> = ref_colors_rgba
        .iter()
        .map(|&[r, g, b, a]| r + 256 * g + 256 * 256 * b + 256 * 256 * 256 * a)
        .collect();
    let pal = palette::palette_from_color_list(&ref_color_list);

    // -- prepare_image (deep-copy semantics: renders below use the ORIGINAL
    //    full-res frames, never these prepared ones)
    let t_prep = Instant::now();
    let prep_ref = imageprep::prepare_image_stages(&ref_seg, &ref_line, None);
    let prep_tgt = imageprep::prepare_image_stages(&tgt_seg, &tgt_line, None);
    for (side, prep) in [("ref", &prep_ref), ("target", &prep_tgt)] {
        if prep.id_map.is_some() {
            // Production would vectorize a reduced id set and then fail the
            // tokenizer's path-count assertion; never hit on real corpora.
            return Err(format!(
                "{side} frame lost segments in the resize (id_map path unsupported)"
            ));
        }
    }

    // -- vectorize (the vendored production vtracer crate)
    let t_vec = Instant::now();
    let ref_svg = vectorize(&prep_ref.vtrace_rgba)?;
    let tgt_svg = vectorize(&prep_tgt.vtrace_rgba)?;

    // -- tokenize: command tensors + packing
    let t_tok = Instant::now();
    let vec_tokens = tokenize::get_vec_tokens(&ref_svg, &tgt_svg);
    let s_ref = vec_tokens.ref_seg_svg.shape[1];
    let s_tgt = vec_tokens.target_seg_svg.shape[1];
    if s_ref != pal.color_ids.len() {
        // tokenizer_ant_v2.py asserts svg path count == len(ref_color_ids)
        return Err(format!(
            "reference SVG has {s_ref} paths but {} colors were supplied",
            pal.color_ids.len()
        ));
    }

    // mask colors for segs that do not exist in the PREPARED ref seg map
    let masked_ids = palette::mask_null_color_ids(&prep_ref.seg_padded.data, &pal.color_ids);
    let ref_colors_i64: Vec<i64> = palette::color_ids_to_colors(&pal.color_list, &masked_ids)
        .into_iter()
        .flatten()
        .collect();

    // -- feed building (export_ant_v2.py::build_feed)
    let ref_pre = feed::svg_pre(
        &vec_tokens.ref_seg_svg,
        &vec_tokens.ref_seg_svg_packed,
        &vec_tokens.ref_seg_svg_attn_mask_packed,
    );
    let tgt_pre = feed::svg_pre(
        &vec_tokens.target_seg_svg,
        &vec_tokens.target_seg_svg_packed,
        &vec_tokens.target_seg_svg_attn_mask_packed,
    );
    let ref_idx = feed::nonpad_slot_indices(&vec_tokens.ref_seg_svg);
    let tgt_idx = feed::nonpad_slot_indices(&vec_tokens.target_seg_svg);
    let (n_ref, n_tgt) = (ref_idx.len(), tgt_idx.len());
    if n_tgt != s_tgt {
        // The production render indexes the id list by raw pixel label, so a
        // fully-padded slot would misalign everything downstream too.
        return Err(format!(
            "target has {s_tgt} slots but only {n_tgt} are non-pad"
        ));
    }
    let gather = feed::packed_gather_idx(&ref_idx, &tgt_idx, s_ref);

    let (ref_line_feed, ref_sdf, ref_seg_lowres) = image_feeds(&prep_ref)?;
    let (tgt_line_feed, tgt_sdf, tgt_seg_lowres) = image_feeds(&prep_tgt)?;

    // -- ONNX forward (EP dispatch lives in the engine: CPU dynamic, CoreML
    //    bucket-padded, or DirectML dynamic — see `serve::engine`)
    let t_fwd = Instant::now();
    let n_packed = gather.len();
    let ant_feed = feed::AntFeed {
        ref_line_image: ref_line_feed,
        ref_sdf,
        ref_seg_lowres,
        target_line_image: tgt_line_feed,
        target_sdf: tgt_sdf,
        target_seg_lowres: tgt_seg_lowres,
        ref_svg_packed_nopad: ref_pre.packed_nopad,
        ref_svg_attn_nopad: ref_pre.attn_nopad,
        ref_svg_flat_idx: Tensor::new(vec![ref_pre.flat_idx.len()], ref_pre.flat_idx),
        ref_svg_cmd_slot_idx: Tensor::new(vec![ref_pre.cmd_slot_idx.len()], ref_pre.cmd_slot_idx),
        ref_svg_slot_counts: Tensor::new(vec![ref_pre.slot_counts.len()], ref_pre.slot_counts),
        target_svg_packed_nopad: tgt_pre.packed_nopad,
        target_svg_attn_nopad: tgt_pre.attn_nopad,
        target_svg_flat_idx: Tensor::new(vec![tgt_pre.flat_idx.len()], tgt_pre.flat_idx),
        target_svg_cmd_slot_idx: Tensor::new(vec![tgt_pre.cmd_slot_idx.len()], tgt_pre.cmd_slot_idx),
        target_svg_slot_counts: Tensor::new(vec![tgt_pre.slot_counts.len()], tgt_pre.slot_counts),
        ref_colors: Tensor::new(vec![1, s_ref, 4], ref_colors_i64),
        ref_color_ids: Tensor::new(vec![1, s_ref], masked_ids),
        target_colors: Tensor::full(vec![1, s_tgt, 4], -100i64),
        target_color_ids: Tensor::full(vec![1, s_tgt], -100i64),
        packed_gather_idx: Tensor::new(vec![n_packed], gather),
        packed_attn_mask: Tensor::full(vec![1, n_packed], true),
    };
    let (dims, logits) = engine.run_ant(&ant_feed)?;
    // On the bucket-padded (CoreML) path dims[1] is the bucket length; real
    // tokens stay a prefix, so the target rows below sit at the same offsets.
    if dims.len() != 3 || dims[0] != 1 || dims[2] != PALETTE_DIM || dims[1] < n_packed {
        return Err(format!(
            "unexpected packed_logits shape {dims:?} (want [1, >={n_packed}, {PALETTE_DIM}])"
        ));
    }
    let forward_secs = t_fwd.elapsed().as_secs_f64();

    // -- target rows -> argmax ids (ties -> first, like torch/numpy)
    let tgt_logits = &logits[n_ref * PALETTE_DIM..(n_ref + n_tgt) * PALETTE_DIM];
    let mut ids = Vec::with_capacity(n_tgt);
    let mut min_margin = f32::INFINITY;
    for row in tgt_logits.chunks_exact(PALETTE_DIM) {
        let (mut best, mut best_v, mut second_v) = (0usize, f32::NEG_INFINITY, f32::NEG_INFINITY);
        for (i, &v) in row.iter().enumerate() {
            if v > best_v {
                second_v = best_v;
                best_v = v;
                best = i;
            } else if v > second_v {
                second_v = v;
            }
        }
        min_margin = min_margin.min(best_v - second_v);
        ids.push(best as i64);
    }
    tracing::debug!(min_argmax_margin = min_margin, "colorize argmax margins");

    // -- postprocess: clamp + colors + FULL-RES renders from the original
    //    (pre-prepare) frames
    let out = postprocess::postprocess(
        &ids,
        tgt_logits,
        PALETTE_DIM,
        &pal,
        &ref_color_list,
        &ref_seg,
        &tgt_seg,
    );

    // The local server injects return_colorized=True when absent.
    let return_colorized = req.return_colorized.unwrap_or(true);
    let (target_uri, ref_uri) = if return_colorized {
        (
            Some(codec::encode_rgba_uri_cv2(&out.target_color_image)),
            Some(codec::encode_rgba_uri_cv2(&out.ref_color_image)),
        )
    } else {
        (None, None)
    };

    if req.verbose {
        tracing::info!(
            prep_ms = (t_vec - t_prep).as_millis() as u64,
            vtrace_ms = (t_tok - t_vec).as_millis() as u64,
            tokenize_ms = (t_fwd - t_tok).as_millis() as u64,
            forward_ms = (forward_secs * 1e3) as u64,
            total_ms = t0.elapsed().as_millis() as u64,
            n_ref,
            n_tgt,
            "colorize done"
        );
    }

    Ok(ColorizeResponse {
        target_colors_rgba: out
            .target_colors_rgba
            .into_iter()
            .map(|c| [c[0], c[1], c[2], c[3]])
            .collect(),
        target_color_ids: out.target_color_ids,
        target_color_image_uri: target_uri,
        ref_color_image_uri: ref_uri,
    })
}

/// cv2-decoded line image (must be 4-channel; kept in decode order, i.e.
/// B,G,R,A — production never swaps it back).
fn line_from_cv2(png: codec::DecodedPng) -> Result<Rgba, String> {
    if png.channels != 4 {
        return Err(format!(
            "line image must be RGBA, got {} channel(s)",
            png.channels
        ));
    }
    Ok(Rgba::new(png.w, png.h, png.data))
}

/// `vtrace.py::vectorize` through the vendored crate: write the RGBA seg
/// encoding to a temp PNG (production uses a NamedTemporaryFile), run the
/// production converter parameters, parse the SVG string.
fn vectorize(rgba: &Rgba) -> Result<Svg, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "cadmium-sidecar-vtrace-{}-{}.png",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let file = std::fs::File::create(&path).map_err(|e| format!("vtrace temp png: {e}"))?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), rgba.w as u32, rgba.h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| format!("vtrace temp png: {e}"))?;
        writer
            .write_image_data(&rgba.data)
            .map_err(|e| format!("vtrace temp png: {e}"))?;
    }
    let result = vtracer::convert(&path, production_vec_config())
        .map(|svg| svg.to_string())
        .map_err(|e| format!("vtracer failed: {e}"));
    let _ = std::fs::remove_file(&path);
    Ok(Svg::from_str(&result?))
}

/// `vtrace.py::vectorize`'s production parameters (colormode seg,
/// hierarchical cutout, spline; filter_speckle 0, corner 60, max_iterations
/// 10, length 4.0, splice 10, precision 0, max_error_simp 2.0).
fn production_vec_config() -> vtracer::Config {
    vtracer::Config {
        color_mode: "seg".parse().unwrap(),
        hierarchical: "cutout".parse().unwrap(),
        filter_speckle: 0,
        corner_threshold: 60,
        length_threshold: 4.0,
        max_iterations: 10,
        splice_threshold: 10,
        path_precision: Some(0),
        max_error_simp: 2.0,
        ..Default::default()
    }
}

/// The image-side graph inputs for one prepared frame
/// (`export_ant_v2.py::build_feed`): the raw 0..255 line feed (channel-first
/// f32, cv2 channel order), `sdf_like_cupy(line / 255)`, and the
/// NEAREST_EXACT low-res seg (already `.long()`).
fn image_feeds(
    prep: &imageprep::PrepStages,
) -> Result<(Tensor<f32>, Tensor<f32>, Tensor<i64>), String> {
    let line = &prep.line_padded;
    let seg = &prep.seg_padded;
    if (line.w, line.h) != (imageprep::TARGET_W, imageprep::TARGET_H) {
        return Err("prepared line image is not 1024x1024".into());
    }

    // H x W x 4 interleaved -> (1, 4, H, W) f32
    let (w, h) = (line.w, line.h);
    let mut chw = vec![0f32; 4 * h * w];
    for c in 0..4 {
        for i in 0..h * w {
            chw[c * h * w + i] = line.data[i * 4 + c] as f32;
        }
    }
    let line_feed = Tensor::new(vec![1, 4, h, w], chw);

    let scaled = Tensor::new(
        line_feed.shape.clone(),
        line_feed.data.iter().map(|&v| v / 255.0).collect(),
    );
    let sdf = feed::sdf_like_cupy(&scaled);

    let seg_t: Tensor<i32> = Tensor::new(vec![1, 1, seg.h, seg.w], seg.data.clone());
    let seg_lowres = feed::lowres_seg(&seg_t, LOWRES_HW);

    Ok((line_feed, sdf, seg_lowres))
}
