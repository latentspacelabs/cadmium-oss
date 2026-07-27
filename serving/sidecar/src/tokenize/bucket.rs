//! Byte-exact port of `serving/onnx/export_ant_v2.py::pad_feed_to_bucket`:
//! pad every dynamic dim of a built feed to fixed bucket sizes so ONE
//! static-shape compile (CoreML) serves many inputs.
//!
//! Real decoder tokens stay a PREFIX of the packed sequence (pads go last,
//! masked False in `packed_attn_mask`), so RoPE positions of real tokens are
//! unchanged and valid outputs are bit-comparable to the unpadded run. The
//! caller keeps slicing target rows at `[n_ref .. n_ref+n_tgt)` as before.
//!
//! Careful bits mirrored from the Python:
//!   - the command dim is per SIDE (each side's tokenization pads to its own
//!     max commands-per-segment), so `flat_idx` is remapped from the old cmd
//!     stride to the bucket's: `(flat // c) * cb + (flat % c)`;
//!   - pad attention rows are the identity so no softmax row is fully masked;
//!   - pad `cmd_slot_idx` entries scatter into the LAST slot `sb - 1`, which
//!     is guaranteed padding (the bucket requires `sb > real slots`);
//!   - `packed_gather_idx` target entries are re-offset onto the padded
//!     concat axis: `where(g >= s_ref, g - s_ref + sb, g)`.

use super::feed::AntFeed;
use super::Tensor;

/// Bucket sizes. `slots`/`rows`/`cmds`/`flat` are per SIDE; `length` is the
/// packed decoder-token axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bucket {
    pub slots: usize,
    pub rows: usize,
    pub cmds: usize,
    pub flat: usize,
    pub length: usize,
}

/// `parity_corpus.py::CORPUS_BUCKET` — the bucket-pinned AnT export has all
/// input dims fixed to these sizes. Sized so real drawings fit: slots cover
/// the segment distribution's tail (vast majority < 50, long tail to 512 — a
/// >255-segment drawing falls back to the dynamic CPU session), flat/rows
/// cover ~150 average-complexity segments (corpus average ~53 cmds/segment).
/// On CoreML the compile (~107s) and forward (~1s) are dominated by the
/// image-UNet, so these dims are nearly free vs the old 32-slot bucket;
/// growing rows/flat further measurably slows the forward (128/16384: ~1.7s).
pub const CORPUS_BUCKET: Bucket = Bucket {
    slots: 256,
    rows: 64,
    cmds: 256,
    flat: 8192,
    length: 512,
};

/// `pad_to(t, shape, value)`: value-filled tensor of `shape` with `t` in the
/// leading corner (`out[tuple(slice(0, d) for d in t.shape)] = t`).
fn pad_to<T: Copy>(t: &Tensor<T>, shape: &[usize], fill: T) -> Tensor<T> {
    assert_eq!(t.shape.len(), shape.len(), "pad_to rank mismatch");
    for (s, d) in t.shape.iter().zip(shape) {
        assert!(s <= d, "pad_to shrink: {:?} -> {shape:?}", t.shape);
    }
    let mut out = Tensor::full(shape.to_vec(), fill);
    if t.data.is_empty() {
        return out;
    }
    let n = shape.len();
    let mut dst_strides = vec![1usize; n];
    for i in (0..n.saturating_sub(1)).rev() {
        dst_strides[i] = dst_strides[i + 1] * shape[i + 1];
    }
    let inner = t.shape[n - 1];
    let outer: usize = t.shape[..n - 1].iter().product();
    for o in 0..outer {
        let (mut rem, mut dst_off) = (o, 0usize);
        for i in (0..n - 1).rev() {
            dst_off += (rem % t.shape[i]) * dst_strides[i];
            rem /= t.shape[i];
        }
        out.data[dst_off..dst_off + inner].copy_from_slice(&t.data[o * inner..(o + 1) * inner]);
    }
    out
}

/// One side's padded SVG/color tensors.
struct PaddedSide {
    colors: Tensor<i64>,
    color_ids: Tensor<i64>,
    slot_counts: Tensor<f32>,
    packed_nopad: Tensor<f32>,
    attn_nopad: Tensor<bool>,
    flat_idx: Tensor<i64>,
    cmd_slot_idx: Tensor<i64>,
}

#[allow(clippy::too_many_arguments)]
fn pad_side(
    side: &str,
    b: &Bucket,
    colors: &Tensor<i64>,
    color_ids: &Tensor<i64>,
    slot_counts: &Tensor<f32>,
    packed_nopad: &Tensor<f32>,
    attn_nopad: &Tensor<bool>,
    flat_idx: &Tensor<i64>,
    cmd_slot_idx: &Tensor<i64>,
) -> Result<PaddedSide, String> {
    let (sb, rb, cb, vb) = (b.slots, b.rows, b.cmds, b.flat);
    let (r, c) = (packed_nopad.shape[0], packed_nopad.shape[1]);
    if rb < r || cb < c {
        return Err(format!(
            "bucket too small (rows/cmds): {side} has {r}x{c}, bucket {rb}x{cb}"
        ));
    }

    // pad-row attention = identity diagonal so no softmax row is fully
    // masked; the real block overwrites the top-left [r, c, c] corner
    // (matching `eye(cb).expand(rb, cb, cb); attn[:r, :c, :c] = orig`).
    let mut attn = Tensor::full(vec![rb, cb, cb], false);
    for row in 0..rb {
        for i in 0..cb {
            attn.data[(row * cb + i) * cb + i] = true;
        }
    }
    for row in 0..r {
        for i in 0..c {
            for j in 0..c {
                attn.data[(row * cb + i) * cb + j] = attn_nopad.data[(row * c + i) * c + j];
            }
        }
    }

    // flat positions are w.r.t. the flattened rows*cmds layout — remap to
    // the padded cmd stride, then pad with 0; pad commands scatter into the
    // LAST slot, which is guaranteed padding (sb > real slots) so their sums
    // are never gathered.
    let v = flat_idx.shape[0];
    if vb < v {
        return Err(format!(
            "bucket too small (flat): {side} has {v} valid commands, bucket {vb}"
        ));
    }
    let remapped = Tensor::new(
        vec![v],
        flat_idx
            .data
            .iter()
            .map(|&f| (f / c as i64) * cb as i64 + (f % c as i64))
            .collect(),
    );

    Ok(PaddedSide {
        colors: pad_to(colors, &[1, sb, 4], 0),
        color_ids: pad_to(color_ids, &[1, sb], -100),
        slot_counts: pad_to(slot_counts, &[sb], 0.0),
        packed_nopad: pad_to(packed_nopad, &[rb, cb, 6], -100.0),
        attn_nopad: attn,
        flat_idx: pad_to(&remapped, &[vb], 0),
        cmd_slot_idx: pad_to(cmd_slot_idx, &[vb], sb as i64 - 1),
    })
}

/// `export_ant_v2.py::pad_feed_to_bucket(feed_t, bucket)`. Errors when the
/// feed does not fit the bucket (the Python asserts) — the serving path uses
/// that as its "fall back to the dynamic session" signal.
pub fn pad_feed_to_bucket(feed: &AntFeed, b: &Bucket) -> Result<AntFeed, String> {
    let s_ref = feed.ref_colors.shape[1];
    let s_tgt = feed.target_colors.shape[1];
    if b.slots < s_ref.max(s_tgt) + 1 {
        return Err(format!(
            "bucket too small (slots): {s_ref} ref / {s_tgt} target slots, bucket {} (needs one spare pad slot)",
            b.slots
        ));
    }

    let r = pad_side(
        "ref",
        b,
        &feed.ref_colors,
        &feed.ref_color_ids,
        &feed.ref_svg_slot_counts,
        &feed.ref_svg_packed_nopad,
        &feed.ref_svg_attn_nopad,
        &feed.ref_svg_flat_idx,
        &feed.ref_svg_cmd_slot_idx,
    )?;
    let t = pad_side(
        "target",
        b,
        &feed.target_colors,
        &feed.target_color_ids,
        &feed.target_svg_slot_counts,
        &feed.target_svg_packed_nopad,
        &feed.target_svg_attn_nopad,
        &feed.target_svg_flat_idx,
        &feed.target_svg_cmd_slot_idx,
    )?;

    let n_real = feed.packed_gather_idx.shape[0];
    if b.length < n_real {
        return Err(format!(
            "bucket too small (length): {n_real} packed tokens, bucket {}",
            b.length
        ));
    }
    // re-offset target entries onto the padded concat axis, pads point at 0
    let gather = Tensor::new(
        vec![n_real],
        feed.packed_gather_idx
            .data
            .iter()
            .map(|&g| {
                if g >= s_ref as i64 {
                    g - s_ref as i64 + b.slots as i64
                } else {
                    g
                }
            })
            .collect(),
    );

    Ok(AntFeed {
        // the image-side inputs are already static — pass through unchanged
        ref_line_image: feed.ref_line_image.clone(),
        ref_sdf: feed.ref_sdf.clone(),
        ref_seg_lowres: feed.ref_seg_lowres.clone(),
        target_line_image: feed.target_line_image.clone(),
        target_sdf: feed.target_sdf.clone(),
        target_seg_lowres: feed.target_seg_lowres.clone(),
        ref_svg_packed_nopad: r.packed_nopad,
        ref_svg_attn_nopad: r.attn_nopad,
        ref_svg_flat_idx: r.flat_idx,
        ref_svg_cmd_slot_idx: r.cmd_slot_idx,
        ref_svg_slot_counts: r.slot_counts,
        target_svg_packed_nopad: t.packed_nopad,
        target_svg_attn_nopad: t.attn_nopad,
        target_svg_flat_idx: t.flat_idx,
        target_svg_cmd_slot_idx: t.cmd_slot_idx,
        target_svg_slot_counts: t.slot_counts,
        ref_colors: r.colors,
        ref_color_ids: r.color_ids,
        target_colors: t.colors,
        target_color_ids: t.color_ids,
        packed_gather_idx: pad_to(&gather, &[b.length], 0),
        packed_attn_mask: pad_to(&feed.packed_attn_mask, &[1, b.length], false),
    })
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The Python export/parity pipeline keeps its own copy of these dims
    /// (`serving/onnx/parity_corpus.py::CORPUS_BUCKET`). A silent drift between
    /// the two breaks bucket parity but compiles clean, and nothing else in CI
    /// catches it (the golden harnesses that would are out-of-CI). Pin them
    /// together here — this runs in the existing `cargo test`. `include_str!`
    /// also makes the Python file a compile dependency, so moving it breaks the
    /// build loudly rather than letting the guard rot.
    #[test]
    fn corpus_bucket_matches_python_parity_source() {
        let py = include_str!("../../../onnx/parity_corpus.py");
        // Isolate the `CORPUS_BUCKET = { ... }` dict literal, then read each int
        // so an unrelated `"slots":` elsewhere in the file can't be picked up.
        let dict = py
            .split_once("CORPUS_BUCKET = {")
            .expect("parity_corpus.py: CORPUS_BUCKET assignment not found")
            .1
            .split_once('}')
            .expect("parity_corpus.py: CORPUS_BUCKET literal not closed")
            .0;
        let field = |name: &str| -> usize {
            let needle = format!("\"{name}\":");
            let after = dict
                .split_once(&needle)
                .unwrap_or_else(|| panic!("parity_corpus.py CORPUS_BUCKET: `{needle}` missing"))
                .1
                .trim_start();
            after
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or_else(|_| panic!("parity_corpus.py CORPUS_BUCKET: no int after `{needle}`"))
        };
        assert_eq!(CORPUS_BUCKET.slots, field("slots"), "slots drifted from parity_corpus.py");
        assert_eq!(CORPUS_BUCKET.rows, field("rows"), "rows drifted from parity_corpus.py");
        assert_eq!(CORPUS_BUCKET.cmds, field("cmds"), "cmds drifted from parity_corpus.py");
        assert_eq!(CORPUS_BUCKET.flat, field("flat"), "flat drifted from parity_corpus.py");
        assert_eq!(CORPUS_BUCKET.length, field("length"), "length drifted from parity_corpus.py");
    }

    fn tiny_bucket() -> Bucket {
        Bucket {
            slots: 4,
            rows: 3,
            cmds: 3,
            flat: 6,
            length: 6,
        }
    }

    /// A minimal 2-ref-slot / 1-target-slot feed (images shrunk to 1x1 —
    /// pad_feed_to_bucket never touches them).
    fn tiny_feed() -> AntFeed {
        AntFeed {
            ref_line_image: Tensor::full(vec![1, 4, 1, 1], 0.0),
            ref_sdf: Tensor::full(vec![1, 1, 1, 1], 0.0),
            ref_seg_lowres: Tensor::full(vec![1, 1, 1, 1], 0i64),
            target_line_image: Tensor::full(vec![1, 4, 1, 1], 0.0),
            target_sdf: Tensor::full(vec![1, 1, 1, 1], 0.0),
            target_seg_lowres: Tensor::full(vec![1, 1, 1, 1], 0i64),
            // ref: 1 row x 2 cmds; both cmds valid, slots 0 and 1
            ref_svg_packed_nopad: Tensor::full(vec![1, 2, 6], 1.0),
            ref_svg_attn_nopad: Tensor::new(vec![1, 2, 2], vec![true, false, false, true]),
            ref_svg_flat_idx: Tensor::new(vec![2], vec![0, 1]),
            ref_svg_cmd_slot_idx: Tensor::new(vec![2], vec![0, 1]),
            ref_svg_slot_counts: Tensor::new(vec![2], vec![1.0, 1.0]),
            // target: 1 row x 1 cmd
            target_svg_packed_nopad: Tensor::full(vec![1, 1, 6], 2.0),
            target_svg_attn_nopad: Tensor::new(vec![1, 1, 1], vec![true]),
            target_svg_flat_idx: Tensor::new(vec![1], vec![0]),
            target_svg_cmd_slot_idx: Tensor::new(vec![1], vec![0]),
            target_svg_slot_counts: Tensor::new(vec![1], vec![1.0]),
            ref_colors: Tensor::new(vec![1, 2, 4], (1..=8).map(|v| v as i64).collect()),
            ref_color_ids: Tensor::new(vec![1, 2], vec![7, 9]),
            target_colors: Tensor::full(vec![1, 1, 4], -100i64),
            target_color_ids: Tensor::full(vec![1, 1], -100i64),
            packed_gather_idx: Tensor::new(vec![3], vec![0, 1, 2]),
            packed_attn_mask: Tensor::full(vec![1, 3], true),
        }
    }

    #[test]
    fn pads_every_dynamic_dim() {
        let f = tiny_feed();
        let b = tiny_bucket();
        let p = pad_feed_to_bucket(&f, &b).unwrap();

        // colors 0-padded, ids -100-padded, counts 0-padded
        assert_eq!(p.ref_colors.shape, vec![1, 4, 4]);
        assert_eq!(&p.ref_colors.data[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(p.ref_colors.data[8..].iter().all(|&v| v == 0));
        assert_eq!(p.ref_color_ids.data, vec![7, 9, -100, -100]);
        assert_eq!(p.ref_svg_slot_counts.data, vec![1.0, 1.0, 0.0, 0.0]);

        // packed rows -100-padded to (3, 3, 6)
        assert_eq!(p.ref_svg_packed_nopad.shape, vec![3, 3, 6]);
        assert!(p.ref_svg_packed_nopad.data[..12].iter().all(|&v| v == 1.0));
        assert!(p.ref_svg_packed_nopad.data[12..].iter().all(|&v| v == -100.0));

        // flat idx remapped from cmd stride 2 to 3: [0, 1] stays, pads 0
        assert_eq!(p.ref_svg_flat_idx.data, vec![0, 1, 0, 0, 0, 0]);
        // target flat idx with old stride 1: position 0 -> 0
        assert_eq!(p.target_svg_flat_idx.data, vec![0, 0, 0, 0, 0, 0]);
        // pad cmd_slot_idx -> the pad slot sb-1 = 3
        assert_eq!(p.ref_svg_cmd_slot_idx.data, vec![0, 1, 3, 3, 3, 3]);

        // gather: ref entries unchanged, target entry 2 (>= s_ref=2)
        // re-offset to 2 - 2 + 4 = 4; pads point at 0
        assert_eq!(p.packed_gather_idx.data, vec![0, 1, 4, 0, 0, 0]);
        assert_eq!(
            p.packed_attn_mask.data,
            vec![true, true, true, false, false, false]
        );
    }

    #[test]
    fn flat_idx_remap_uses_row_stride() {
        // 2 rows x 2 cmds, valid commands at flat 1 (row 0 cmd 1) and flat 2
        // (row 1 cmd 0) -> with cb=3: 1 and 3
        let mut f = tiny_feed();
        f.ref_svg_packed_nopad = Tensor::full(vec![2, 2, 6], 1.0);
        f.ref_svg_attn_nopad = Tensor::full(vec![2, 2, 2], true);
        f.ref_svg_flat_idx = Tensor::new(vec![2], vec![1, 2]);
        let p = pad_feed_to_bucket(&f, &tiny_bucket()).unwrap();
        assert_eq!(p.ref_svg_flat_idx.data, vec![1, 3, 0, 0, 0, 0]);
    }

    #[test]
    fn pad_attn_rows_are_identity() {
        let f = tiny_feed();
        let p = pad_feed_to_bucket(&f, &tiny_bucket()).unwrap();
        assert_eq!(p.ref_svg_attn_nopad.shape, vec![3, 3, 3]);
        let at = |row: usize, i: usize, j: usize| p.ref_svg_attn_nopad.data[(row * 3 + i) * 3 + j];
        // real block kept in the top-left corner of row 0
        for i in 0..2 {
            for j in 0..2 {
                assert_eq!(at(0, i, j), i == j);
            }
        }
        // the padded command row within the real row block keeps its
        // identity diagonal (eye survives outside the [:r, :c, :c] overwrite)
        assert!(at(0, 2, 2));
        assert!(!at(0, 2, 0));
        // fully-padded rows are the identity
        for row in 1..3 {
            for i in 0..3 {
                for j in 0..3 {
                    assert_eq!(at(row, i, j), i == j);
                }
            }
        }
    }

    #[test]
    fn refuses_oversized_feeds() {
        let pad_err = |f: &AntFeed, b: &Bucket| -> String {
            match pad_feed_to_bucket(f, b) {
                Ok(_) => panic!("expected pad_feed_to_bucket to fail"),
                Err(e) => e,
            }
        };
        let b = tiny_bucket();
        let mut f = tiny_feed();
        // slots: 4 ref slots need sb >= 5
        f.ref_colors = Tensor::full(vec![1, 4, 4], 0i64);
        assert!(pad_err(&f, &b).contains("slots"));

        let mut f = tiny_feed();
        f.packed_gather_idx = Tensor::new(vec![7], vec![0; 7]);
        f.packed_attn_mask = Tensor::full(vec![1, 7], true);
        assert!(pad_err(&f, &b).contains("length"));

        let mut f = tiny_feed();
        f.ref_svg_packed_nopad = Tensor::full(vec![1, 4, 6], 1.0);
        f.ref_svg_attn_nopad = Tensor::full(vec![1, 4, 4], true);
        assert!(pad_err(&f, &b).contains("rows/cmds"));
    }
}
