//! Byte-exact port of `serving/onnx/export_ant_v2.py::svg_pre`/`build_feed`:
//! the index tensors the export-safe ONNX graph consumes instead of
//! data-dependent boolean packing, plus the image-side pre-processing
//! (`sdf_like_cupy` and the NEAREST_EXACT seg-map downscale) that the export
//! moved out of the model forward.

use super::{Tensor, PAD_VALUE};

// ---------------------------------------------------------------------------
// the assembled graph feed

/// The complete ONNX-graph input set — `export_ant_v2.py::build_feed`'s dict
/// as one value, so EP dispatch (`serve::engine::Engine::run_ant`) and the
/// bucket padding (`bucket::pad_feed_to_bucket`) can pass a feed around
/// whole. Field names are the graph input names.
pub struct AntFeed {
    /// (1, 4, 1024, 1024) f32 — raw 0..255 line feed, cv2 channel order
    pub ref_line_image: Tensor<f32>,
    /// (1, 1, 1024, 1024) f32 — `sdf_like_cupy(line / 255)`
    pub ref_sdf: Tensor<f32>,
    /// (1, 1, 512, 512) i64 — NEAREST_EXACT low-res seg
    pub ref_seg_lowres: Tensor<i64>,
    pub target_line_image: Tensor<f32>,
    pub target_sdf: Tensor<f32>,
    pub target_seg_lowres: Tensor<i64>,
    /// (R, C, 6) f32
    pub ref_svg_packed_nopad: Tensor<f32>,
    /// (R, C, C) bool
    pub ref_svg_attn_nopad: Tensor<bool>,
    /// (V,) i64
    pub ref_svg_flat_idx: Tensor<i64>,
    /// (V,) i64
    pub ref_svg_cmd_slot_idx: Tensor<i64>,
    /// (S,) f32
    pub ref_svg_slot_counts: Tensor<f32>,
    pub target_svg_packed_nopad: Tensor<f32>,
    pub target_svg_attn_nopad: Tensor<bool>,
    pub target_svg_flat_idx: Tensor<i64>,
    pub target_svg_cmd_slot_idx: Tensor<i64>,
    pub target_svg_slot_counts: Tensor<f32>,
    /// (1, S_ref, 4) i64
    pub ref_colors: Tensor<i64>,
    /// (1, S_ref) i64
    pub ref_color_ids: Tensor<i64>,
    /// (1, S_tgt, 4) i64 — all -100 sentinels at inference
    pub target_colors: Tensor<i64>,
    /// (1, S_tgt) i64 — all -100 sentinels at inference
    pub target_color_ids: Tensor<i64>,
    /// (L,) i64
    pub packed_gather_idx: Tensor<i64>,
    /// (1, L) bool
    pub packed_attn_mask: Tensor<bool>,
}

// ---------------------------------------------------------------------------
// SVG-side index tensors

/// `svg_pre`'s five outputs for one side. Shapes as fed to the ONNX graph.
pub struct SvgPre {
    /// (R, C, 6) f32 — only the packed rows holding at least one valid command
    pub packed_nopad: Tensor<f32>,
    /// (R, C, C) bool
    pub attn_nopad: Tensor<bool>,
    /// V i64 — valid-command positions in the flattened R*C packed layout
    pub flat_idx: Vec<i64>,
    /// V i64 — destination slot per valid command (slot-major order)
    pub cmd_slot_idx: Vec<i64>,
    /// S f32 — valid commands per slot (0.0 for pad slots)
    pub slot_counts: Vec<f32>,
}

/// `export_ant_v2.py::svg_pre(seg_svg, packed, attn_packed)`. The
/// order-preserving correspondence — valid commands row-major in the packed
/// layout == valid commands slot-major in the per-slot grid — is exactly what
/// production's `unpack_sequences` relies on, so these index tensors are
/// exact by construction. "Valid" is `torch.all(row != -100.0, dim=-1)`; a
/// Move command's zero-pad columns keep it valid.
pub fn svg_pre(seg_svg: &Tensor<f32>, packed: &Tensor<f32>, attn: &Tensor<bool>) -> SvgPre {
    assert_eq!(seg_svg.shape.len(), 4, "seg_svg must be (1, S, C, 6)");
    assert_eq!(packed.shape.len(), 4, "packed must be (1, R, C, 6)");
    let (s, c, f) = (seg_svg.shape[1], seg_svg.shape[2], seg_svg.shape[3]);
    let (r_all, cp) = (packed.shape[1], packed.shape[2]);
    assert_eq!(cp, c, "packed command dim mismatch");
    assert_eq!(attn.shape, vec![1, r_all, c, c], "attn must be (1, R, C, C)");

    let row_valid = |row: &[f32]| row.iter().all(|&v| v != PAD_VALUE);

    // keep = torch.all(packed != -100, -1).any(-1): rows with >=1 valid cmd
    let keep: Vec<usize> = (0..r_all)
        .filter(|&r| (0..c).any(|ci| row_valid(&packed.data[(r * c + ci) * f..][..f])))
        .collect();

    let mut packed_nopad = Tensor::full(vec![keep.len(), c, f], 0.0f32);
    let mut attn_nopad = Tensor::full(vec![keep.len(), c, c], false);
    for (dst, &r) in keep.iter().enumerate() {
        packed_nopad.data[dst * c * f..(dst + 1) * c * f]
            .copy_from_slice(&packed.data[r * c * f..(r + 1) * c * f]);
        attn_nopad.data[dst * c * c..(dst + 1) * c * c]
            .copy_from_slice(&attn.data[r * c * c..(r + 1) * c * c]);
    }

    // flat_idx: valid-command positions in the flattened kept R*C layout
    let flat_idx: Vec<i64> = (0..keep.len() * c)
        .filter(|&i| row_valid(&packed_nopad.data[i * f..][..f]))
        .map(|i| i as i64)
        .collect();

    // cmd_slot_idx / slot_counts from the per-slot grid (seg_svg[0])
    let mut cmd_slot_idx = Vec::new();
    let mut slot_counts = vec![0.0f32; s];
    for si in 0..s {
        for ci in 0..c {
            if row_valid(&seg_svg.data[(si * c + ci) * f..][..f]) {
                cmd_slot_idx.push(si as i64);
                slot_counts[si] += 1.0;
            }
        }
    }
    assert_eq!(
        flat_idx.len(),
        cmd_slot_idx.len(),
        "valid commands in packed layout != valid commands in slot grid"
    );

    SvgPre {
        packed_nopad,
        attn_nopad,
        flat_idx,
        cmd_slot_idx,
        slot_counts,
    }
}

/// `build_feed`'s `ref_idx`/`tgt_idx`: slots that are not fully -100
/// (`torch.nonzero(~torch.all(seg_svg == -100, dim=(2, 3)))[..., 0]`).
pub fn nonpad_slot_indices(seg_svg: &Tensor<f32>) -> Vec<i64> {
    let (s, c, f) = (seg_svg.shape[1], seg_svg.shape[2], seg_svg.shape[3]);
    (0..s)
        .filter(|&si| {
            seg_svg.data[si * c * f..(si + 1) * c * f]
                .iter()
                .any(|&v| v != PAD_VALUE)
        })
        .map(|si| si as i64)
        .collect()
}

/// `build_feed`'s `packed_gather_idx = cat([ref_idx, tgt_idx + S_ref])` —
/// slot indices over the concatenated [ref slots..., target slots...] axis.
pub fn packed_gather_idx(ref_idx: &[i64], tgt_idx: &[i64], s_ref: usize) -> Vec<i64> {
    ref_idx
        .iter()
        .copied()
        .chain(tgt_idx.iter().map(|&i| i + s_ref as i64))
        .collect()
}

// ---------------------------------------------------------------------------
// image-side pre-processing

/// `export_ant_v2.py::sdf_like_cupy(line_scaled)` — the CPU replica of
/// `compute_sdf_cupy(rgba_to_rgb_torch(line), binarize=True)` including its
/// quirks: transparent pixels become WHITE=255 (although the line is already
/// /255-scaled), binary = rgb.min > 0, exact-Euclidean EDT of the binary
/// mask, then a GLOBAL min-max normalization in f32.
///
/// Degenerate all-True binary (real drawings hit this: the tokenizer resize
/// lifts every stroke pixel above 0): production replicates cucim's sentinel
/// ramp `2^15 + y` explicitly — all 22 corpus sdf maps take this branch.
///
/// Input is the already /255-scaled RGBA line, (1, 4, H, W) f32.
pub fn sdf_like_cupy(line_scaled: &Tensor<f32>) -> Tensor<f32> {
    assert_eq!(line_scaled.shape.len(), 4, "line must be (N, 4, H, W)");
    let (n, ch, h, w) = (
        line_scaled.shape[0],
        line_scaled.shape[1],
        line_scaled.shape[2],
        line_scaled.shape[3],
    );
    assert_eq!(ch, 4, "line must be RGBA");

    let mut sdf = Vec::with_capacity(n * h * w);
    for b in 0..n {
        let plane = |c: usize, i: usize| line_scaled.data[((b * ch + c) * h * w) + i];
        // rgb = where(alpha == 0, 255.0, rgb); binary = rgb.min(dim=1) > 0
        let binary: Vec<bool> = (0..h * w)
            .map(|i| {
                let (r, g, bl, a) = (plane(0, i), plane(1, i), plane(2, i), plane(3, i));
                let m = if a == 0.0 {
                    255.0f32
                } else {
                    r.min(g).min(bl)
                };
                m > 0.0
            })
            .collect();
        if binary.iter().all(|&v| v) {
            // cucim's PBA measures distance to a sentinel row above the
            // image: 32768 + y, a vertical ramp (f64, then .float())
            for y in 0..h {
                let v = (2.0f64.powi(15) + y as f64) as f32;
                sdf.extend(std::iter::repeat(v).take(w));
            }
        } else {
            // scipy.ndimage.distance_transform_edt: exact Euclidean — sqrt
            // (f64) of the exact integer squared distance, then .float()
            let sq = edt_sq(&binary, w, h);
            sdf.extend(sq.iter().map(|&d| ((d as f64).sqrt()) as f32));
        }
    }

    // (sdf - sdf.min()) / (sdf.max() - sdf.min()), f32, global over the batch
    let mn = sdf.iter().copied().fold(f32::INFINITY, f32::min);
    let mx = sdf.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let denom = mx - mn;
    Tensor::new(
        vec![n, 1, h, w],
        sdf.into_iter().map(|v| (v - mn) / denom).collect(),
    )
}

/// Exact squared Euclidean distance transform (distance to the nearest
/// `false` pixel), Felzenszwalb–Huttenlocher two-pass. The squared distances
/// are exact integers, so `sqrt` in f64 reproduces scipy's
/// `distance_transform_edt` bitwise (which also takes the correctly-rounded
/// f64 sqrt of an exact integer square). Parabola intersections use f64, but
/// any rounding there can only reassign ties, never change the min value.
pub fn edt_sq(binary: &[bool], w: usize, h: usize) -> Vec<i64> {
    const INF: i64 = 1 << 40;
    assert_eq!(binary.len(), w * h);

    // pass 1: per-column distance (in rows) to the nearest false
    let mut d = vec![INF; w * h];
    for x in 0..w {
        let mut run = INF;
        for y in 0..h {
            run = if binary[y * w + x] { (run + 1).min(INF) } else { 0 };
            d[y * w + x] = run;
        }
        let mut run = INF;
        for y in (0..h).rev() {
            run = if binary[y * w + x] { (run + 1).min(INF) } else { 0 };
            d[y * w + x] = d[y * w + x].min(run);
        }
    }
    for v in d.iter_mut() {
        if *v < INF {
            *v *= *v;
        }
    }

    // pass 2: per-row lower envelope of parabolas
    let mut out = vec![0i64; w * h];
    let mut v = vec![0usize; w];
    let mut z = vec![0f64; w + 2];
    for y in 0..h {
        let f = &d[y * w..(y + 1) * w];
        let sep = |q: usize, p: usize| -> f64 {
            ((f[q] + (q * q) as i64 - f[p] - (p * p) as i64) as f64)
                / ((2 * q) as f64 - (2 * p) as f64)
        };
        let mut k = 0usize;
        v[0] = 0;
        z[0] = f64::NEG_INFINITY;
        z[1] = f64::INFINITY;
        for q in 1..w {
            let mut s = sep(q, v[k]);
            while s <= z[k] {
                k -= 1;
                s = sep(q, v[k]);
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = f64::INFINITY;
        }
        k = 0;
        for q in 0..w {
            while z[k + 1] < q as f64 {
                k += 1;
            }
            let p = v[k];
            let dx = q as i64 - p as i64;
            out[y * w + q] = dx * dx + f[p];
        }
    }
    out
}

/// `export_ant_v2.py::lowres_seg`: `TF.resize(seg, lowres_hw,
/// InterpolationMode.NEAREST_EXACT)` on the already-`long()` seg map —
/// source index `min(floor((dst + 0.5) * in/out), in - 1)` per axis (ATen's
/// nearest-exact index computation, f64 scale).
pub fn lowres_seg(seg: &Tensor<i32>, lowres_hw: (usize, usize)) -> Tensor<i64> {
    assert_eq!(seg.shape.len(), 4, "seg must be (1, 1, H, W)");
    let (h, w) = (seg.shape[2], seg.shape[3]);
    let (oh, ow) = lowres_hw;
    let src_idx = |dst: usize, out_size: usize, in_size: usize| -> usize {
        let scale = in_size as f64 / out_size as f64;
        (((dst as f64 + 0.5) * scale).floor() as usize).min(in_size - 1)
    };
    let ys: Vec<usize> = (0..oh).map(|y| src_idx(y, oh, h)).collect();
    let xs: Vec<usize> = (0..ow).map(|x| src_idx(x, ow, w)).collect();
    let mut data = Vec::with_capacity(oh * ow);
    for &y in &ys {
        for &x in &xs {
            data.push(seg.data[y * w + x] as i64);
        }
    }
    Tensor::new(vec![1, 1, oh, ow], data)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edt_sq_matches_brute_force() {
        // exactness is the property that guarantees scipy parity; check it
        // against O(n^2) brute force on pseudo-random masks
        let (w, h) = (17, 13);
        let mut state = 0x2545f4914f6cdd1du64;
        for round in 0..8 {
            let binary: Vec<bool> = (0..w * h)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state % 4 != 0
                })
                .collect();
            if binary.iter().all(|&v| v) {
                continue;
            }
            let got = edt_sq(&binary, w, h);
            for y in 0..h {
                for x in 0..w {
                    let mut best = i64::MAX;
                    for yy in 0..h {
                        for xx in 0..w {
                            if !binary[yy * w + xx] {
                                let (dy, dx) = (y as i64 - yy as i64, x as i64 - xx as i64);
                                best = best.min(dy * dy + dx * dx);
                            }
                        }
                    }
                    assert_eq!(got[y * w + x], best, "round {round} at ({x},{y})");
                }
            }
        }
    }

    #[test]
    fn edt_sq_zero_on_background() {
        let binary = vec![true, false, true, true];
        assert_eq!(edt_sq(&binary, 4, 1), vec![1, 0, 1, 4]);
    }

    #[test]
    fn sdf_degenerate_all_true_is_vertical_ramp() {
        // opaque white everywhere -> binary all true -> 2^15 + y ramp,
        // normalized to y/(h-1) in f32
        let (h, w) = (4, 3);
        let mut data = vec![1.0f32; 4 * h * w];
        for v in data[3 * h * w..].iter_mut() {
            *v = 1.0; // alpha nonzero
        }
        let sdf = sdf_like_cupy(&Tensor::new(vec![1, 4, h, w], data));
        for y in 0..h {
            let want = ((2.0f64.powi(15) + y as f64) as f32 - 32768.0) / 3.0;
            for x in 0..w {
                assert_eq!(sdf.data[y * w + x].to_bits(), want.to_bits());
            }
        }
    }

    #[test]
    fn sdf_transparent_pixels_count_as_white() {
        // one opaque black pixel among transparent ones: binary is false
        // only there
        let (h, w) = (1, 3);
        let mut data = vec![0.0f32; 4 * h * w];
        data[3 * h * w + 1] = 1.0; // alpha on the middle pixel; rgb stays 0
        let sdf = sdf_like_cupy(&Tensor::new(vec![1, 4, h, w], data));
        // distances 1, 0, 1 -> normalized 1, 0, 1
        assert_eq!(sdf.data, vec![1.0, 0.0, 1.0]);
    }

    #[test]
    fn lowres_seg_nearest_exact_picks_odd_indices_at_2x() {
        let seg = Tensor::new(vec![1, 1, 4, 4], (0..16).collect::<Vec<i32>>());
        let low = lowres_seg(&seg, (2, 2));
        assert_eq!(low.shape, vec![1, 1, 2, 2]);
        assert_eq!(low.data, vec![5, 7, 13, 15]); // rows/cols 1 and 3
    }

    #[test]
    fn svg_pre_indices_line_up() {
        use crate::tokenize::pack::pack_sequences;
        // two slots: 2 and 1 commands, C=3
        let seg = Tensor::new(
            vec![2, 3, 2],
            vec![
                1.0, 1.0, 2.0, 2.0, PAD_VALUE, PAD_VALUE, // slot 0
                3.0, 3.0, PAD_VALUE, PAD_VALUE, PAD_VALUE, PAD_VALUE, // slot 1
            ],
        );
        let packed = pack_sequences(&seg);
        let pre = svg_pre(
            &seg.clone().unsqueeze0(),
            &packed.packed.unsqueeze0(),
            &packed.attn_mask.unsqueeze0(),
        );
        assert_eq!(pre.packed_nopad.shape, vec![1, 3, 2]);
        assert_eq!(pre.flat_idx, vec![0, 1, 2]);
        assert_eq!(pre.cmd_slot_idx, vec![0, 0, 1]);
        assert_eq!(pre.slot_counts, vec![2.0, 1.0]);
    }

    #[test]
    fn gather_idx_offsets_target_slots() {
        assert_eq!(
            packed_gather_idx(&[0, 1, 2], &[0, 2], 5),
            vec![0, 1, 2, 5, 7]
        );
    }
}
