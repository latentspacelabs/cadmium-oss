//! `/preprocess` — the Rust replica of
//! `serving/handlers/preprocess.py::run_preprocess`: decode the reference
//! (PIL semantics, URL-safe base64 — channel order preserved), compute the
//! per-segment color list (`KeyFrame.compute_color_list`; production runs the
//! parallel variant, whose output is identical to the ported serial
//! algorithm), and optionally render the anti-alias-free filled reference
//! (PIL encoder — RGBA order preserved, standard base64).

use crate::imageprep::{color_list::compute_color_list, Rgba};
use crate::postprocess::render::render_as_image;
use crate::segment::Map32;
use crate::tokenize::palette::dense_to_rgba_flat;

use super::codec::{self, DecodedPng};
use super::contract::{PreprocessRequest, PreprocessResponse};

pub fn run_preprocess(req: &PreprocessRequest) -> Result<PreprocessResponse, String> {
    // References arrive as an ordered list (length-1 today); legacy flat
    // ref_* fields remain accepted. Python processes the first.
    let (seg_uri, color_uri, line_uri) = match req.references.as_deref() {
        Some([first, rest @ ..]) => {
            if !rest.is_empty() {
                tracing::info!(
                    "run_preprocess: {} references supplied; preprocessing the first.",
                    rest.len() + 1
                );
            }
            (
                first.seg_map_uri.as_str(),
                first.color_image_uri.as_str(),
                first.line_image_uri.as_deref(),
            )
        }
        _ => match (&req.ref_seg_map_uri, &req.ref_color_image_uri) {
            (Some(seg), Some(color)) => {
                (seg.as_str(), color.as_str(), req.ref_line_image_uri.as_deref())
            }
            _ => {
                return Err(
                    "run_preprocess: no reference provided — expected a `references` list \
                     or the legacy ref_seg_map_uri/ref_color_image_uri fields."
                        .into(),
                )
            }
        },
    };

    // PIL decoders, URL-safe base64 (the app's encoding).
    let seg = seg_frame_from_decoded(&codec::decode_png_uri_pil(seg_uri, true)?)?;
    let color = rgba_from_pil(codec::decode_png_uri_pil(color_uri, true)?)?;
    let line_png = line_uri
        .map(|u| codec::decode_png_uri_pil(u, true))
        .transpose()?;
    let line = match line_png {
        Some(png) if png.channels == 4 => Rgba::new(png.w, png.h, png.data),
        Some(png) => {
            // LineImageFrame feeds the raw array to binarize(), whose 3-dim
            // branch indexes [:, :, 3]; anything but RGBA raises upstream.
            return Err(format!(
                "reference line image must be RGBA, got {} channel(s)",
                png.channels
            ));
        }
        // The ported compute_color_list requires the line frame; production
        // accepts line_frame=None, but every client (and the golden corpus)
        // sends it.
        None => return Err("run_preprocess: line_image_uri is required by the sidecar".into()),
    };

    let (color_list, stats) = compute_color_list(&seg, &color, &line);

    // Convert to RGBA for the response; the null color becomes transparent.
    let palette_rgba: Vec<[u8; 4]> = color_list
        .iter()
        .map(|&c| {
            if c == -100 {
                [0, 0, 0, 0]
            } else {
                let [r, g, b, a] = dense_to_rgba_flat(c);
                [r as u8, g as u8, b as u8, a as u8]
            }
        })
        .collect();

    let preprocessed_uri = if req.return_filled {
        let filled = render_as_image(&seg, &color_list, [0, 0, 0, 0]);
        Some(codec::encode_rgba_uri_pil(&filled))
    } else {
        None
    };

    tracing::info!(
        num_segs = stats.num_total_segs,
        transparent = stats.num_transparent_segs,
        multi = stats.num_multi_color_segs,
        "preprocess color list computed"
    );

    Ok(PreprocessResponse {
        palette_rgba,
        preprocessed_uri,
    })
}

/// `SegImageFrame.from_image(decoded array)`: `_maybe_bitshift` (2-D gray ->
/// uint32 labels; 4-channel -> `rgba_to_int32` packing the channels IN
/// DECODE ORDER — PIL gives RGBA, cv2 gives BGRA, exactly as production's
/// untyped array flows) followed by the `_check_contiguous` guard
/// (production nulls the frame and crashes downstream; the sidecar reports
/// it).
pub fn seg_frame_from_decoded(png: &DecodedPng) -> Result<Map32, String> {
    let data: Vec<i32> = match png.channels {
        1 => png.data.iter().map(|&v| v as i32).collect(),
        4 => png
            .data
            .chunks_exact(4)
            .map(|px| {
                // rgba_to_int32: 256^3 r + 256^2 g + 256 b + a (uint32)
                let dense = (px[0] as u32) * 256 * 256 * 256
                    + (px[1] as u32) * 256 * 256
                    + (px[2] as u32) * 256
                    + px[3] as u32;
                i32::try_from(dense).map_err(|_| {
                    format!("seg map label {dense} exceeds the supported label range")
                })
            })
            .collect::<Result<_, _>>()?,
        n => return Err(format!("seg map must be grayscale or RGBA, got {n} channel(s)")),
    };
    let seg = Map32 {
        w: png.w,
        h: png.h,
        data,
    };
    if !check_contiguous(&seg.data) {
        return Err("non-contiguous seg map (labels are not a dense range)".into());
    }
    Ok(seg)
}

/// `SegImageFrame._check_contiguous`: sorted unique labels form the dense
/// range min..=max.
fn check_contiguous(labels: &[i32]) -> bool {
    let mut unique: Vec<i32> = labels.to_vec();
    unique.sort_unstable();
    unique.dedup();
    match (unique.first(), unique.last()) {
        (Some(&lo), Some(&hi)) => (hi - lo) as usize + 1 == unique.len(),
        _ => false,
    }
}

/// `ImageFrame._maybe_convert_to_rgba` for the color image: RGB gains an
/// opaque alpha channel; RGBA passes through; anything else raises.
fn rgba_from_pil(png: DecodedPng) -> Result<Rgba, String> {
    match png.channels {
        4 => Ok(Rgba::new(png.w, png.h, png.data)),
        3 => {
            let mut data = Vec::with_capacity(png.w * png.h * 4);
            for px in png.data.chunks_exact(3) {
                data.extend_from_slice(px);
                data.push(255);
            }
            Ok(Rgba::new(png.w, png.h, data))
        }
        n => Err(format!("Image has {n} channels")),
    }
}
