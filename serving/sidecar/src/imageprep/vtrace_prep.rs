//! Port of `colorize/vectorization/vtrace.py::prepare_resized_seg_for_vtrace`
//! (+ `preserve_small_segments`, `create_id_offset_map`, `unpad_seg_image`)
//! and the vectorize() input encoding
//! `segmentation/trapped_ball/serialization.py::int32_to_rgba_with_padding`.

use crate::segment::Map32;

/// `create_id_offset_map`'s output: a Python dict {original id -> Optional
/// remapped id} in insertion order (ascending original ids, since
/// `np.unique` sorts).
pub type IdMap = Vec<(i32, Option<i32>)>;

/// Sorted unique values (`np.unique`) of a label map.
fn unique_sorted(data: &[i32]) -> Vec<i32> {
    let mut v: Vec<i32> = data.to_vec();
    v.sort_unstable();
    v.dedup();
    v
}

/// `vtrace.py::prepare_resized_seg_for_vtrace(seg_original, seg_resized)`.
/// Mutates `seg_resized` (as production does) and returns the id_map, or
/// None when every original id survived the resize.
pub fn prepare_resized_seg_for_vtrace(
    seg_original: &Map32,
    seg_resized: &mut Map32,
) -> Option<IdMap> {
    let unique_ids = unique_sorted(&seg_original.data);
    // "augmentation adds -100 padding ... remove that first"
    let strip = |ids: Vec<i32>| -> Vec<i32> { ids.into_iter().filter(|&v| v != -100).collect() };
    let mut resized_unique_ids = strip(unique_sorted(&seg_resized.data));

    let is_proper_superset = |a: &[i32], b: &[i32]| -> bool {
        // set(a) > set(b): every b in a (always true here: resized ids come
        // from gathering original pixels) and a strictly bigger
        b.iter().all(|v| a.binary_search(v).is_ok()) && a.len() > b.len()
    };

    if is_proper_superset(&unique_ids, &resized_unique_ids) {
        preserve_small_segments(&unique_ids, &resized_unique_ids, seg_original, seg_resized);
        resized_unique_ids = strip(unique_sorted(&seg_resized.data));
    }

    if is_proper_superset(&unique_ids, &resized_unique_ids) {
        Some(create_id_offset_map(&unique_ids, &resized_unique_ids))
    } else {
        None
    }
}

/// `vtrace.py::preserve_small_segments`: stamp each missing id at the
/// scaled center of mass of its original pixels. `int()` truncation on
/// `np.mean(coords) * resized_dim / original_dim`, evaluated left to right.
/// (Production copies then reassigns; mutating in place is equivalent —
/// the copy is returned and replaces the input binding.)
fn preserve_small_segments(
    unique_ids: &[i32],
    resized_unique_ids: &[i32],
    original: &Map32,
    resized: &mut Map32,
) {
    for &unique_id in unique_ids {
        if resized_unique_ids.binary_search(&unique_id).is_err() {
            // center of mass in the original image; np.where order is
            // irrelevant to the mean. Sums of exact-integer f64s stay exact
            // (coords < 2^31, total < 2^53), so plain accumulation matches
            // numpy's pairwise mean here.
            let (mut sy, mut sx, mut n) = (0f64, 0f64, 0usize);
            for y in 0..original.h {
                for x in 0..original.w {
                    if original.data[y * original.w + x] == unique_id {
                        sy += y as f64;
                        sx += x as f64;
                        n += 1;
                    }
                }
            }
            if n > 0 {
                let mean_y = sy / n as f64;
                let mean_x = sx / n as f64;
                let center_y =
                    (mean_y * resized.h as f64 / original.h as f64).trunc() as usize;
                let center_x =
                    (mean_x * resized.w as f64 / original.w as f64).trunc() as usize;
                resized.data[center_y * resized.w + center_x] = unique_id;
            }
        }
    }
}

/// `vtrace.py::create_id_offset_map`, ported loop-for-loop.
fn create_id_offset_map(unique_ids: &[i32], resized_unique_ids: &[i32]) -> IdMap {
    let mut id_map: IdMap = Vec::with_capacity(unique_ids.len());
    let mut offset: usize = 0;
    for (i, &unique_id) in unique_ids.iter().enumerate() {
        let resized_unique_id = if i - offset < resized_unique_ids.len() {
            Some(resized_unique_ids[i - offset])
        } else {
            None
        };
        match resized_unique_id {
            Some(r) if unique_id == r => id_map.push((unique_id, Some((i - offset) as i32))),
            _ => {
                offset += 1;
                id_map.push((unique_id, None));
            }
        }
    }
    id_map
}

/// `vtrace.py::unpad_seg_image`: start from all -100, then write each
/// mapped id. Masks are disjoint, so dict order is immaterial.
pub fn unpad_seg_image(seg: &Map32, id_map: &IdMap) -> Map32 {
    let mut out = Map32::new(seg.w, seg.h, -100);
    for &(old_id, new_id) in id_map {
        if let Some(new_id) = new_id {
            for (dst, &src) in out.data.iter_mut().zip(seg.data.iter()) {
                if src == old_id {
                    *dst = new_id;
                }
            }
        }
    }
    out
}

/// Python-semantics floor division / modulo for i32 (numpy `//` and `%`
/// follow the divisor's sign).
#[inline]
fn py_floordiv(a: i64, b: i64) -> i64 {
    let (q, r) = (a / b, a % b);
    if r != 0 && (r < 0) != (b < 0) {
        q - 1
    } else {
        q
    }
}

#[inline]
fn py_mod(a: i64, b: i64) -> i64 {
    let r = a % b;
    if r != 0 && (r < 0) != (b < 0) {
        r + b
    } else {
        r
    }
}

/// `serialization.py::int32_to_rgba` on an i32 array (the resize preserved
/// the i32 dtype; no f64 coercion happens on the inference path). numpy
/// floor-division/modulo semantics for negatives, then `astype(np.uint8)`
/// (wrap mod 256).
pub fn int32_to_rgba(v: i32) -> [u8; 4] {
    let v = v as i64;
    const C3: i64 = 256 * 256 * 256;
    const C2: i64 = 256 * 256;
    let r = py_floordiv(v, C3);
    let g = py_floordiv(py_mod(v, C3), C2);
    let b = py_floordiv(py_mod(py_mod(v, C3), C2), 256);
    let a = py_mod(py_mod(py_mod(v, C3), C2), 256);
    [r as u8, g as u8, b as u8, a as u8]
}

/// `serialization.py::int32_to_rgba_with_padding`: -100 encodes as opaque
/// white (the vtracer-side padding sentinel).
pub fn int32_to_rgba_with_padding(seg: &Map32) -> Vec<u8> {
    let mut out = Vec::with_capacity(seg.data.len() * 4);
    for &v in &seg.data {
        if v == -100 {
            out.extend_from_slice(&[255, 255, 255, 255]);
        } else {
            out.extend_from_slice(&int32_to_rgba(v));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `rgba_to_int32` (serialization.py) as the round-trip check:
    /// 256^3 r + 256^2 g + 256 b + a recovers the id for the id range
    /// vtracer sees (0 .. num_segs, plus the -100 sentinel as white).
    #[test]
    fn int32_rgba_round_trip() {
        for v in [0i32, 1, 99, 255, 256, 65535, 65536, 16777215, 16777216, i32::MAX] {
            let [r, g, b, a] = int32_to_rgba(v);
            let back = ((r as i64) << 24) + ((g as i64) << 16) + ((b as i64) << 8) + a as i64;
            assert_eq!(back, v as i64, "v={v}");
        }
        // the padding sentinel maps to opaque white, matching what
        // vtracer's read_seg_image decodes back to -100
        let seg = Map32 {
            w: 2,
            h: 1,
            data: vec![-100, 7],
        };
        assert_eq!(
            int32_to_rgba_with_padding(&seg),
            vec![255, 255, 255, 255, 0, 0, 0, 7]
        );
        // raw int32_to_rgba of -100 (numpy floor semantics): r = -1 -> 255,
        // then positive mods of 16777116
        assert_eq!(int32_to_rgba(-100), [255, 255, 255, 156]);
    }

    #[test]
    fn preserve_and_id_map_paths() {
        // original 4x4 with ids 0..3; id 3 is a single pixel that a 2x2
        // downscale drops
        let mut original = Map32::new(4, 4, 0);
        for y in 2..4 {
            for x in 0..4 {
                original.data[y * 4 + x] = 1;
            }
        }
        original.data[1 * 4 + 3] = 2;
        original.data[0 * 4 + 3] = 3;
        // nearest 4->2 gather takes indices [0, 2] on both axes
        let mut resized = Map32 {
            w: 2,
            h: 2,
            data: vec![0, 0, 1, 1],
        };
        let id_map = prepare_resized_seg_for_vtrace(&original, &mut resized);
        // ids 2 and 3 were missing; centers of mass: id 2 at (y=1,x=3) ->
        // (int(1*2/4), int(3*2/4)) = (0, 1); id 3 at (0,3) -> (0, 1) — id 3
        // overwrites id 2's stamp (ascending unique_ids order), so 2 stays
        // missing and an id_map is created.
        assert_eq!(resized.data, vec![0, 3, 1, 1]);
        let id_map = id_map.expect("id 2 unrecoverable -> id_map");
        assert_eq!(
            id_map,
            vec![(0, Some(0)), (1, Some(1)), (2, None), (3, Some(2))]
        );
    }

    /// Literal replay of `create_id_offset_map([0,1,2,3], [0,1,3])`:
    /// i=0: r=0==0 -> 0; i=1: r=1==1 -> 1; i=2: r=2? resized[2]=3 != 2 ->
    /// offset 1, None; i=3: resized[3-1]=3 == 3 -> Some(2).
    #[test]
    fn id_offset_map_matches_python_trace() {
        let m = create_id_offset_map(&[0, 1, 2, 3], &[0, 1, 3]);
        assert_eq!(m, vec![(0, Some(0)), (1, Some(1)), (2, None), (3, Some(2))]);

        // unpad rewrites via the map, missing ids become -100
        let seg = Map32 {
            w: 2,
            h: 2,
            data: vec![0, 3, 1, 2],
        };
        let out = unpad_seg_image(&seg, &m);
        assert_eq!(out.data, vec![0, 2, 1, -100]);
    }

    #[test]
    fn no_missing_ids_no_map() {
        let original = Map32 {
            w: 2,
            h: 1,
            data: vec![0, 1],
        };
        let mut resized = Map32 {
            w: 4,
            h: 1,
            data: vec![0, 0, 1, 1],
        };
        assert!(prepare_resized_seg_for_vtrace(&original, &mut resized).is_none());
        assert_eq!(resized.data, vec![0, 0, 1, 1]);
    }
}
