//! findContours(RETR_EXTERNAL, CHAIN_APPROX_SIMPLE), arcLength and
//! approxPolyDP, ported from OpenCV 4.11.0 sources to match production cv2
//! byte-for-byte on the quantities `merge_fill` consumes.
//!
//! Portions are direct ports of OpenCV code
//! (modules/imgproc/src/contours_new.cpp, contours_common.{hpp,cpp},
//! shapedescr.cpp::arcLength, approx.cpp::approxPolyDP_), which is
//! licensed under the Apache License 2.0:
//!   Copyright (C) 2000-2025, Intel Corporation / OpenCV contributors.
//!   Licensed under the Apache License, Version 2.0;
//!   http://www.apache.org/licenses/LICENSE-2.0
//!
//! Notes on fidelity:
//! - OpenCV 4.11 pads the input with a 1px zero border
//!   (`copyMakeBorder(..., BORDER_CONSTANT, 0)`) and thresholds nonzero to
//!   1 before scanning; output coordinates are shifted back by (-1,-1).
//! - With RETR_EXTERNAL, hole borders are never traced; outer borders found
//!   while "inside" a previously traced contour (Suzuki lnbd bookkeeping:
//!   `image.at<schar>(last_pos) > 0`) are skipped.
//! - The returned list order comes from `TreeIterator`/`addChild`, which
//!   prepends siblings and iterates newest-first: `contours[0]` is the
//!   *last* outer border encountered in the raster scan (verified against
//!   the 4.11 source; commonly observed as "findContours returns contours
//!   bottom-up").

use super::Gray;

const MASK8_RIGHT: i8 = -128; // '\x80'
const MASK8_NEW: i8 = 2;
const MASK8_FLAGS: i32 = 0xFE;
const MAX_SIZE: i32 = 16;

/// chainCodeDeltas: (dx, dy) per direction 0..8
const CODE_DELTAS: [(i32, i32); 8] = [
    (1, 0),
    (1, -1),
    (0, -1),
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, 1),
    (1, 1),
];

#[inline]
fn get_delta(s: i32, step: i32) -> i32 {
    let (dx, dy) = CODE_DELTAS[(s % 8) as usize];
    dx + dy * step
}

/// `icvFetchContourEx<schar>` (contours_new.cpp) for the CHAIN_APPROX_SIMPLE,
/// non-chain, non-hole... (holes never reach it under RETR_EXTERNAL, but the
/// is_hole flag is kept for fidelity). Marks visited border pixels in `img`.
/// `origin` is the contour origin in output coordinates.
fn fetch_contour_ex(
    img: &mut [i8],
    step: i32,
    start_idx: usize,
    is_hole: bool,
    origin: (i32, i32),
) -> Vec<(i32, i32)> {
    let nbd: i8 = MASK8_NEW;
    let i0 = start_idx as i32;
    let mut pt = origin;
    let mut pts: Vec<(i32, i32)> = Vec::new();

    let mut s_end: i32 = if is_hole { 0 } else { 4 };
    let mut s: i32 = s_end;
    let mut i1: i32;
    loop {
        s = (s - 1) & 7;
        i1 = i0 + get_delta(s, step);
        if img[i1 as usize] != 0 || s == s_end {
            break;
        }
    }

    if s == s_end {
        // single pixel domain
        img[i0 as usize] = nbd | MASK8_RIGHT;
        pts.push(pt);
    } else {
        let mut i3 = i0;
        let mut prev_s = s ^ 4;
        let mut i4: i32 = 0;

        loop {
            s_end = s;
            s = s.min(MAX_SIZE - 1); // clamp_direction
            while s < MAX_SIZE - 1 {
                s += 1;
                i4 = i3 + get_delta(s, step);
                if img[i4 as usize] != 0 {
                    break;
                }
            }
            s &= 7;

            // check "right" bound
            if ((s - 1) as u32) < (s_end as u32) {
                img[i3 as usize] = nbd | MASK8_RIGHT;
            } else if img[i3 as usize] == 1 {
                img[i3 as usize] = nbd;
            }

            // CHAIN_APPROX_SIMPLE: emit the current point on direction change
            if s != prev_s {
                pts.push(pt);
            }
            prev_s = s;
            pt.0 += CODE_DELTAS[s as usize].0;
            pt.1 += CODE_DELTAS[s as usize].1;

            if i4 == i0 && i3 == i1 {
                break;
            }
            i3 = i4;
            s = (s + 4) & 7;
        }
    }
    pts
}

/// `cv2.findContours(mask, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)` for a u8
/// mask (any nonzero = foreground). Returns contours in cv2's output order
/// (`contours[0]` = last outer border found in the raster scan); points are
/// (x, y) in mask coordinates.
pub fn find_contours_ext_simple(mask: &Gray) -> Vec<Vec<(i32, i32)>> {
    // preprocess: pad 1px with zeros; threshold(>0 -> 1) into schar image
    let w = mask.w + 2;
    let h = mask.h + 2;
    let step = w as i32;
    let mut img = vec![0i8; w * h];
    for y in 0..mask.h {
        for x in 0..mask.w {
            if mask.data[y * mask.w + x] != 0 {
                img[(y + 1) * w + (x + 1)] = 1;
            }
        }
    }

    // ContourScanner_ state (offset = (-1,-1) folded into emitted points)
    let mut found: Vec<Vec<(i32, i32)>> = Vec::new();
    let mut pt: (usize, usize) = (1, 1);
    let mut lnbd: (usize, usize) = (0, 1);

    // findNext loop
    'outer: loop {
        let mut x = pt.0;
        let mut y = pt.1;
        let width = w - 1;
        let height = h - 1;
        let mut last_pos = lnbd;
        let mut prev: i32 = img[y * w + x - 1] as i32;

        while y < height {
            let mut p: i32 = 0;
            while x < width {
                // findNextX (scalar path)
                while x < width {
                    p = img[y * w + x] as i32;
                    if p != prev {
                        break;
                    }
                    x += 1;
                }
                if x >= width {
                    break;
                }
                // contourScan (u8 path, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)
                let mut is_hole = false;
                let mut skip = false;
                if !(prev == 0 && p == 1) {
                    if p != 0 || prev < 1 {
                        skip = true;
                    } else {
                        if (prev & MASK8_FLAGS) != 0 {
                            last_pos.0 = x - 1;
                        }
                        is_hole = true;
                    }
                }
                if !skip {
                    // RETR_EXTERNAL: skip holes and nested outer borders
                    if is_hole || img[last_pos.1 * w + last_pos.0] > 0 {
                        skip = true;
                    }
                }
                if !skip {
                    last_pos.0 = x - if is_hole { 1 } else { 0 };
                    let start_idx = y * w + x - if is_hole { 1 } else { 0 };
                    let origin = (
                        (x - if is_hole { 1 } else { 0 }) as i32 - 1,
                        y as i32 - 1,
                    );
                    let pts = fetch_contour_ex(&mut img, step, start_idx, is_hole, origin);
                    found.push(pts);
                    pt = (x + 1, y);
                    lnbd = last_pos;
                    continue 'outer;
                }
                prev = p;
                if (prev & MASK8_FLAGS) != 0 {
                    last_pos.0 = x;
                }
                x += 1;
            }
            last_pos = (0, y + 1);
            x = 1;
            prev = 0;
            y += 1;
        }
        break;
    }

    // contourTreeToResults iterates newest-first for EXTERNAL siblings
    found.reverse();
    found
}

/// `cv2.arcLength(curve, closed=True)` for integer points — float diffs,
/// (double)dx*dx + dy*dy accumulated in double in cv2's order
/// (shapedescr.cpp). Exact for coordinates < 2^12 or so.
pub fn arc_length_closed(pts: &[(i32, i32)]) -> f64 {
    if pts.len() <= 1 {
        return 0.0;
    }
    let mut prev = (pts[pts.len() - 1].0 as f32, pts[pts.len() - 1].1 as f32);
    let mut perimeter = 0f64;
    for &(x, y) in pts {
        let p = (x as f32, y as f32);
        let dx = p.0 - prev.0;
        let dy = p.1 - prev.1;
        // C++: sqrt((double)dx*dx + dy*dy) — second product in f32
        perimeter += ((dx as f64) * (dx as f64) + ((dy * dy) as f64)).sqrt();
        prev = p;
    }
    perimeter
}

/// `cv2.approxPolyDP(curve, epsilon, closed)` for CV_32S points.
/// Direct port of OpenCV 4.11.0 approx.cpp::approxPolyDP_<int> (Apache-2.0,
/// see module header) including init_iters=3, the LE/LT comparisons, the
/// in-place wrap-around cleanup pass and its `dx != 0 && dy != 0` quirk.
pub fn approx_poly_dp(src: &[(i32, i32)], eps0: f64, is_closed0: bool) -> Vec<(i32, i32)> {
    let count0 = src.len();
    if count0 == 0 {
        return Vec::new();
    }
    assert!(
        (0.0..1e30).contains(&eps0),
        "Epsilon not valid (cv2 would throw)"
    );

    #[derive(Clone, Copy, Default)]
    struct Range {
        start: usize,
        end: usize,
    }

    let mut dst: Vec<(i32, i32)> = vec![(0, 0); count0];
    let mut stack: Vec<Range> = Vec::with_capacity(count0);

    let mut init_iters = 3usize;
    let mut slice = Range { start: 0, end: 0 };
    let mut right_slice = Range { start: 0, end: 0 };
    let mut start_pt: (i32, i32) = (-1000000, -1000000);
    let mut end_pt: (i32, i32);
    let mut pt: (i32, i32);
    let mut pos: usize = 0;
    let mut count = count0;
    let mut new_count = 0usize;
    let mut is_closed = is_closed0;
    let mut le_eps = false;

    let mut eps = eps0;
    eps *= eps;

    macro_rules! read_pt {
        ($pt:ident, $pos:ident) => {
            $pt = src[$pos];
            $pos += 1;
            if $pos >= count {
                $pos = 0;
            }
        };
    }
    macro_rules! read_dst_pt {
        ($pt:ident, $pos:ident) => {
            $pt = dst[$pos];
            $pos += 1;
            if $pos >= count {
                $pos = 0;
            }
        };
    }

    if !is_closed {
        end_pt = src[0];
        start_pt = src[count - 1];
        if start_pt.0 != end_pt.0 || start_pt.1 != end_pt.1 {
            slice.start = 0;
            slice.end = count - 1;
            stack.push(slice);
        } else {
            is_closed = true;
            init_iters = 1;
        }
    }

    if is_closed {
        // 1. Find approximately two farthest points of the contour
        right_slice.start = 0;

        for _ in 0..init_iters {
            let mut max_dist = 0f64;
            pos = (pos + right_slice.start) % count;
            read_pt!(start_pt, pos);

            for j in 1..count {
                read_pt!(pt, pos);
                let dx = (pt.0 - start_pt.0) as f64;
                let dy = (pt.1 - start_pt.1) as f64;
                let dist = dx * dx + dy * dy;
                if dist > max_dist {
                    max_dist = dist;
                    right_slice.start = j;
                }
            }
            le_eps = max_dist <= eps;
        }

        // 2. initialize the stack
        if !le_eps {
            slice.start = pos % count;
            right_slice.end = slice.start;
            right_slice.start = (right_slice.start + slice.start) % count;
            slice.end = right_slice.start;
            stack.push(right_slice);
            stack.push(slice);
        } else {
            dst[new_count] = start_pt;
            new_count += 1;
        }
    }

    // 3. run recursive process
    while let Some(top) = stack.pop() {
        slice = top;
        end_pt = src[slice.end];
        pos = slice.start;
        read_pt!(start_pt, pos);

        if pos != slice.end {
            let dx = (end_pt.0 - start_pt.0) as f64;
            let dy = (end_pt.1 - start_pt.1) as f64;
            let mut max_dist = 0f64;

            while pos != slice.end {
                read_pt!(pt, pos);
                let dist = (((pt.1 - start_pt.1) as f64) * dx - ((pt.0 - start_pt.0) as f64) * dy)
                    .abs();
                if dist > max_dist {
                    max_dist = dist;
                    right_slice.start = (pos + count - 1) % count;
                }
            }
            le_eps = max_dist * max_dist <= eps * (dx * dx + dy * dy);
        } else {
            le_eps = true;
            start_pt = src[slice.start];
        }

        if le_eps {
            dst[new_count] = start_pt;
            new_count += 1;
        } else {
            right_slice.end = slice.end;
            slice.end = right_slice.start;
            stack.push(right_slice);
            stack.push(slice);
        }
    }

    if !is_closed {
        dst[new_count] = src[count - 1];
        new_count += 1;
    }

    // last stage: cleanup of extra points on [almost] straight lines
    is_closed = is_closed0;
    count = new_count;
    pos = if is_closed { count - 1 } else { 0 };
    read_dst_pt!(start_pt, pos);
    let mut wpos = pos;
    read_dst_pt!(pt, pos);
    let not_closed = if is_closed { 0usize } else { 1usize };

    let mut i = not_closed;
    while i < count - not_closed && new_count > 2 {
        read_dst_pt!(end_pt, pos);
        let dx = (end_pt.0 - start_pt.0) as f64;
        let dy = (end_pt.1 - start_pt.1) as f64;
        let dist =
            (((pt.0 - start_pt.0) as f64) * dy - ((pt.1 - start_pt.1) as f64) * dx).abs();
        // C++ computes this in int then converts
        let successive_inner_product = ((pt.0 - start_pt.0) * (end_pt.0 - pt.0)
            + (pt.1 - start_pt.1) * (end_pt.1 - pt.1)) as f64;

        if dist * dist <= 0.5 * eps * (dx * dx + dy * dy)
            && dx != 0.0
            && dy != 0.0
            && successive_inner_product >= 0.0
        {
            new_count -= 1;
            start_pt = end_pt;
            dst[wpos] = start_pt;
            wpos += 1;
            if wpos >= count {
                wpos = 0;
            }
            read_dst_pt!(pt, pos);
            i += 1;
            i += 1;
            continue;
        }
        start_pt = pt;
        dst[wpos] = start_pt;
        wpos += 1;
        if wpos >= count {
            wpos = 0;
        }
        pt = end_pt;
        i += 1;
    }

    if !is_closed {
        dst[wpos] = pt;
    }

    dst.truncate(new_count);
    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask_from(rows: &[&str]) -> Gray {
        let h = rows.len();
        let w = rows[0].len();
        let mut m = Gray::new(w, h, 0);
        for (y, r) in rows.iter().enumerate() {
            for (x, c) in r.bytes().enumerate() {
                if c == b'1' {
                    m.data[y * w + x] = 255;
                }
            }
        }
        m
    }

    #[test]
    fn single_pixel_contour() {
        let m = mask_from(&["000", "010", "000"]);
        let cs = find_contours_ext_simple(&m);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0], vec![(1, 1)]);
    }

    #[test]
    fn rectangle_contour_simple_corners() {
        // 4x3 solid rectangle at (1,1)..(4,3): CHAIN_APPROX_SIMPLE keeps
        // 4 corner points (cv2-verified behavior for axis-aligned rects).
        let m = mask_from(&["000000", "011110", "011110", "011110", "000000"]);
        let cs = find_contours_ext_simple(&m);
        assert_eq!(cs.len(), 1);
        let c = &cs[0];
        assert_eq!(c.len(), 4);
        // cv2 emits (1,1),(1,3),(4,3),(4,1) for this rect (start at top-left,
        // clockwise in image coords via its border-following order)
        assert_eq!(c[0], (1, 1));
        assert!(c.contains(&(1, 3)) && c.contains(&(4, 3)) && c.contains(&(4, 1)));
    }

    #[test]
    fn two_blobs_output_order_is_reverse_scan() {
        let m = mask_from(&["100", "000", "001"]);
        let cs = find_contours_ext_simple(&m);
        assert_eq!(cs.len(), 2);
        // contours[0] is the LAST border found in the raster scan
        assert_eq!(cs[0], vec![(2, 2)]);
        assert_eq!(cs[1], vec![(0, 0)]);
    }

    #[test]
    fn arc_length_square() {
        let pts = vec![(0, 0), (0, 3), (3, 3), (3, 0)];
        assert_eq!(arc_length_closed(&pts), 12.0);
    }

    #[test]
    fn approx_square_stays_square() {
        let pts = vec![(0, 0), (0, 10), (10, 10), (10, 0)];
        let eps = 0.02 * arc_length_closed(&pts);
        let ap = approx_poly_dp(&pts, eps, true);
        assert_eq!(ap.len(), 4);
    }

    #[test]
    fn approx_single_point() {
        let pts = vec![(5, 7)];
        let ap = approx_poly_dp(&pts, 0.0, true);
        assert_eq!(ap.len(), 1);
        assert_eq!(ap[0], (5, 7));
    }

    #[test]
    fn approx_collinear_run_collapses() {
        // many points along a diagonal line + a far corner: DP should drop
        // interior collinear points
        let mut pts: Vec<(i32, i32)> = (0..=10).map(|i| (i, i)).collect();
        pts.push((10, 0));
        let eps = 0.02 * arc_length_closed(&pts);
        let ap = approx_poly_dp(&pts, eps, true);
        assert!(ap.len() <= 4, "got {:?}", ap);
    }
}
