//! Byte-exact Rust port of the AnT v2 preprocess image-prep path —
//! `colorize/common/image.py::prepare_image` (inference: augment=False) —
//! plus `colorize/common/frame.py::KeyFrame.compute_color_list`.
//!
//! Stage map (verified per-stage by `src/bin/verify_imageprep.rs` against
//! goldens from `serving/tools/dump_imageprep_goldens.py`):
//!   - crop:    `segmentation/trapped_ball/cropping.py::get_bbox_pad_dims`
//!              + the `bbox_pad_dims` branch of `crop_image`
//!              (`segment::cropping::{get_bbox_pad_dims_rgba,
//!              crop_with_pad_dims}`)
//!   - resize:  `image.py::resize_proportionally` (skimage order-0 nearest
//!              == scipy `ndi.zoom` grid_mode; see `resize`)
//!   - vtrace prep: `colorize/vectorization/vtrace.py::
//!              prepare_resized_seg_for_vtrace` + `unpad_seg_image` +
//!              `serialization.py::int32_to_rgba_with_padding`
//!              (`vtrace_prep`); the vectorization itself runs through the
//!              vendored `third_party/vtracer` crate in the verify bin
//!   - pad:     `image.py::pad_sides_equally`
//!   - color list: `color_list` (the /preprocess + tokenizer ref-frame
//!              palette)
//!
//! The seg input is the production trapped-ball label map (`segment::
//! segment_from_alpha` output — already ported/verified separately); this
//! module takes it as given, exactly like `prepare_image(seg_image=...)`.

pub mod color_list;
pub mod resize;
pub mod vtrace_prep;

use crate::segment::cropping::{crop_with_pad_dims, get_bbox_pad_dims_rgba};
use crate::segment::{Gray, Map32};

/// `ImageArgs` production defaults (width, height; `padding` is the
/// `get_bbox_pad_dims` default of 10, hardcoded at the `prepare_image` call
/// sites).
pub const TARGET_W: usize = 1024;
pub const TARGET_H: usize = 1024;
pub const BBOX_PADDING: usize = 10;

/// Interleaved 8-bit RGBA image, row-major (C order) — the `np.array` of a
/// PIL RGBA image.
#[derive(Clone, PartialEq, Eq)]
pub struct Rgba {
    pub w: usize,
    pub h: usize,
    /// len = w * h * 4
    pub data: Vec<u8>,
}

impl Rgba {
    pub fn new(w: usize, h: usize, data: Vec<u8>) -> Self {
        assert_eq!(data.len(), w * h * 4, "rgba buffer size mismatch");
        Rgba { w, h, data }
    }

    /// The alpha plane as a Gray image.
    pub fn alpha_plane(&self) -> Gray {
        let mut g = Gray::new(self.w, self.h, 0);
        for (dst, px) in g.data.iter_mut().zip(self.data.chunks_exact(4)) {
            *dst = px[3];
        }
        g
    }
}

/// Every intermediate of the `prepare_image` replay, one per golden stage
/// (the numbers match `serving/tools/dump_imageprep_goldens.py`).
pub struct PrepStages {
    /// `get_bbox_pad_dims(line_image)` — meta.json `vert_pad_dims`
    pub vert_pad_dims: (usize, usize),
    /// meta.json `horiz_pad_dims`
    pub horiz_pad_dims: (usize, usize),
    /// 02: `crop_image(seg, 10, bbox_pad_dims)` (i32 preserved)
    pub seg_cropped: Map32,
    /// 03: `crop_image(line rgba, 10, bbox_pad_dims)`
    pub line_cropped: Rgba,
    /// 03c (ref style only)
    pub color_cropped: Option<Rgba>,
    /// 04: `resize_proportionally(seg_cropped)` — dtype-preserving nearest
    pub seg_resized: Map32,
    /// 05
    pub line_resized: Rgba,
    /// 05c
    pub color_resized: Option<Rgba>,
    /// 06: after `prepare_resized_seg_for_vtrace` (mutates seg_resized)
    pub seg_for_vtrace: Map32,
    /// meta.json `id_map` (None on the golden corpus — nothing goes
    /// missing on upscales)
    pub id_map: Option<vtrace_prep::IdMap>,
    /// 07: the RGBA pixels of the png handed to vtracer (`unpad_seg_image`
    /// if id_map, then `int32_to_rgba_with_padding`)
    pub vtrace_rgba: Rgba,
    /// 09: `pad_sides_equally(seg, -100)` [final]
    pub seg_padded: Map32,
    /// 10: `pad_sides_equally(line, 0)` [final]
    pub line_padded: Rgba,
    /// 11: `pad_sides_equally(color, 0)` [final, ref style only]
    pub color_padded: Option<Rgba>,
}

/// `image.py::prepare_image(seg, line, image_args, vec_args, augment=False,
/// color_image=...)` replayed stage by stage, minus the `vectorize()` call
/// itself (the verify bin feeds `vtrace_rgba` to the vendored vtracer and
/// compares the SVG separately).
pub fn prepare_image_stages(
    seg_image: &Map32,
    line_image: &Rgba,
    color_image: Option<&Rgba>,
) -> PrepStages {
    assert_eq!(
        (seg_image.w, seg_image.h),
        (line_image.w, line_image.h),
        "seg/line size mismatch"
    );
    let (w, h) = (line_image.w, line_image.h);

    // get crop dims (from the LINE image, applied to all layers)
    let (vert, horiz) = get_bbox_pad_dims_rgba(&line_image.data, w, h, BBOX_PADDING);

    // seg: crop + resize (i32 all the way)
    let (seg_c, cw, ch) = crop_with_pad_dims(&seg_image.data, w, h, 1, vert, horiz);
    let seg_cropped = Map32 {
        w: cw,
        h: ch,
        data: seg_c,
    };
    let (rh, rw) = resize::resize_output_dims(ch, cw, TARGET_W, TARGET_H);
    let seg_resized = Map32 {
        w: rw,
        h: rh,
        data: resize::resize_nearest(&seg_cropped.data, cw, ch, 1, rw, rh),
    };

    // line
    let (line_c, _, _) = crop_with_pad_dims(&line_image.data, w, h, 4, vert, horiz);
    let line_cropped = Rgba::new(cw, ch, line_c);
    let line_resized = Rgba::new(
        rw,
        rh,
        resize::resize_nearest(&line_cropped.data, cw, ch, 4, rw, rh),
    );

    // color (ref style)
    let (color_cropped, color_resized) = match color_image {
        Some(color) => {
            assert_eq!((color.w, color.h), (w, h), "seg/color size mismatch");
            let (c, _, _) = crop_with_pad_dims(&color.data, w, h, 4, vert, horiz);
            let cropped = Rgba::new(cw, ch, c);
            let resized = Rgba::new(
                rw,
                rh,
                resize::resize_nearest(&cropped.data, cw, ch, 4, rw, rh),
            );
            (Some(cropped), Some(resized))
        }
        None => (None, None),
    };

    // mutates seg_resized (production rebinds the name); keep the
    // pre-mutation copy as stage 04
    let mut seg_for_vtrace = seg_resized.clone();
    let id_map = vtrace_prep::prepare_resized_seg_for_vtrace(seg_image, &mut seg_for_vtrace);

    // vectorize() input encoding: unpad if id_map, then RGBA with padding
    let vtrace_rgba = {
        let unpadded;
        let vt_in = match &id_map {
            Some(map) => {
                unpadded = vtrace_prep::unpad_seg_image(&seg_for_vtrace, map);
                &unpadded
            }
            None => &seg_for_vtrace,
        };
        Rgba::new(
            vt_in.w,
            vt_in.h,
            vtrace_prep::int32_to_rgba_with_padding(vt_in),
        )
    };

    // pad
    let seg_padded = Map32 {
        w: TARGET_W,
        h: TARGET_H,
        data: resize::pad_sides_equally(&seg_for_vtrace.data, rw, rh, 1, TARGET_W, TARGET_H, -100),
    };
    let line_padded = Rgba::new(
        TARGET_W,
        TARGET_H,
        resize::pad_sides_equally(&line_resized.data, rw, rh, 4, TARGET_W, TARGET_H, 0),
    );
    let color_padded = color_resized.as_ref().map(|c| {
        Rgba::new(
            TARGET_W,
            TARGET_H,
            resize::pad_sides_equally(&c.data, rw, rh, 4, TARGET_W, TARGET_H, 0),
        )
    });

    PrepStages {
        vert_pad_dims: vert,
        horiz_pad_dims: horiz,
        seg_cropped,
        line_cropped,
        color_cropped,
        seg_resized,
        line_resized,
        color_resized,
        seg_for_vtrace,
        id_map,
        vtrace_rgba,
        seg_padded,
        line_padded,
        color_padded,
    }
}
