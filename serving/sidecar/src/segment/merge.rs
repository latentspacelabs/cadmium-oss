//! Port of `trapped_ball.py::merge_fill` (plus its helpers
//! `get_bounding_rect`, `get_border_bounding_rect`, `get_border_point`),
//! preserving the original's quirks exactly:
//!
//! - every iteration re-asserts `result[fillmap == 0] = 0` against the
//!   ORIGINAL fillmap;
//! - the fill list is rebuilt from `np.unique(result)` each iteration —
//!   ids ascending, each with a point-set snapshot taken at iteration
//!   start — but border pixels are read from the LIVE result, so merges
//!   earlier in the same iteration are visible;
//! - `new_id = ids[0]`: the SMALLEST nonzero border id (despite the
//!   "largest contact" comment in the Python);
//! - merge condition precedence: (len(approx)==1 or area==1) →
//!   (len(approx)<6 and area<500) → (area<250 and len(ids)==1) →
//!   (area < 10*min_seg_size); the no-border case uses new_id=0 when
//!   area < min_seg_size, else keeps its own id;
//! - terminates when the unique-label count stops changing, max `max_iter`
//!   iterations.

use super::contour::{approx_poly_dp, arc_length_closed, find_contours_ext_simple};
use super::{Gray, Map32};

struct FillInfo {
    id: i32,
    /// linear indices, row-major ascending (np.where order)
    points: Vec<u32>,
    /// bounding rect (x1, y1, x2, y2), inclusive
    rect: (usize, usize, usize, usize),
}

/// `merge_fill(fillmap, max_iter, min_seg_size)`.
pub fn merge_fill(fillmap: &Map32, max_iter: usize, min_seg_size: usize) -> Map32 {
    let (w, h) = (fillmap.w, fillmap.h);
    let mut result = fillmap.clone();
    let max_id = *fillmap.data.iter().max().unwrap_or(&0);
    debug_assert!(*fillmap.data.iter().min().unwrap_or(&0) >= 0);

    for _ in 0..max_iter {
        // result[np.where(fillmap == 0)] = 0  (ORIGINAL fillmap)
        for (r, &orig) in result.data.iter_mut().zip(fillmap.data.iter()) {
            if orig == 0 {
                *r = 0;
            }
        }

        // fill_id = np.unique(result); snapshot point sets per id
        let fills = bucket_fills(&result, max_id);
        let num_ids_before = fills.len() + usize::from(result.data.contains(&0));

        for f in &fills {
            // ignore lines (id 0 entries are not bucketed at all)
            debug_assert!(f.id != 0);

            let (approx_len, border_points) =
                get_border_point(&f.points, f.rect, h, w);
            let area = f.points.len();

            // ids = unique nonzero border pixel values from the LIVE result
            let mut ids: Vec<i32> = border_points
                .iter()
                .map(|&p| result.data[p as usize])
                .filter(|&v| v != 0)
                .collect();
            ids.sort_unstable();
            ids.dedup();

            let new_id = if ids.is_empty() {
                if area < min_seg_size {
                    0
                } else {
                    f.id
                }
            } else {
                ids[0]
            };

            let merge = if approx_len == 1 || area == 1 {
                true // a point
            } else if approx_len < 6 && area < 500 {
                true // a non-complex shape that is also small-medium sized
            } else if area < 250 && ids.len() == 1 {
                true // a complex shape but small and only one border segment
            } else {
                area < 10 * min_seg_size // a complex shape that is very small
            };

            if merge {
                for &p in &f.points {
                    result.data[p as usize] = new_id;
                }
            }
        }

        // if len(fill_id) == len(np.unique(result)): break
        let mut present = vec![false; (max_id + 1) as usize];
        for &v in &result.data {
            present[v as usize] = true;
        }
        let num_ids_after = present.iter().filter(|&&b| b).count();
        if num_ids_before == num_ids_after {
            break;
        }
    }
    result
}

/// One row-major pass bucketing the points of every nonzero id, with
/// bounding rects. Ids returned ascending (np.unique order).
fn bucket_fills(result: &Map32, max_id: i32) -> Vec<FillInfo> {
    let (w, h) = (result.w, result.h);
    let n = (max_id + 1) as usize;
    let mut points: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut rects: Vec<(usize, usize, usize, usize)> = vec![(usize::MAX, usize::MAX, 0, 0); n];
    for y in 0..h {
        for x in 0..w {
            let v = result.data[y * w + x];
            if v == 0 {
                continue;
            }
            let v = v as usize;
            points[v].push((y * w + x) as u32);
            let r = &mut rects[v];
            r.0 = r.0.min(x);
            r.1 = r.1.min(y);
            r.2 = r.2.max(x);
            r.3 = r.3.max(y);
        }
    }
    let mut fills = Vec::new();
    for id in 1..n {
        if points[id].is_empty() {
            continue;
        }
        fills.push(FillInfo {
            id: id as i32,
            points: std::mem::take(&mut points[id]),
            rect: rects[id],
        });
    }
    fills
}

/// `get_border_point(points, rect, max_height, max_width)`:
/// returns (len(approx_shape), border pixel linear indices in image coords,
/// row-major order of the local rect).
fn get_border_point(
    points: &[u32],
    rect: (usize, usize, usize, usize),
    max_height: usize,
    max_width: usize,
) -> (usize, Vec<u32>) {
    // get_border_bounding_rect(h, w, rect[:2], rect[2:], r=2):
    //   x1 = x1-r if 0 < x1-r else 0; x2 = x2+r+1 if x2+r+1 < w else w
    let r = 2usize;
    let bx1 = rect.0.saturating_sub(r);
    let by1 = rect.1.saturating_sub(r);
    let bx2 = (rect.2 + r + 1).min(max_width);
    let by2 = (rect.3 + r + 1).min(max_height);
    let lw = bx2 - bx1;
    let lh = by2 - by1;

    // local mask, 255 at the fill's points
    let mut fill = Gray::new(lw, lh, 0);
    for &p in points {
        let p = p as usize;
        let (y, x) = (p / max_width, p % max_width);
        fill.data[(y - by1) * lw + (x - bx1)] = 255;
    }

    // contours[0] under cv2 4.x ordering; only len(approxPolyDP) is used
    let contours = find_contours_ext_simple(&fill);
    let c0 = contours
        .first()
        .expect("findContours returned no contours for a non-empty fill (cv2 would IndexError)");
    let eps = 0.02 * arc_length_closed(c0);
    let approx_len = approx_poly_dp(c0, eps, true).len();

    // border pixels: dilate(fill, CROSS3) - fill == 255, i.e. background
    // pixels 4-adjacent to the fill, in row-major order of the local rect
    let mut border: Vec<u32> = Vec::new();
    for y in 0..lh {
        for x in 0..lw {
            if fill.data[y * lw + x] != 0 {
                continue;
            }
            let touches = (y > 0 && fill.data[(y - 1) * lw + x] != 0)
                || (x > 0 && fill.data[y * lw + x - 1] != 0)
                || (x + 1 < lw && fill.data[y * lw + x + 1] != 0)
                || (y + 1 < lh && fill.data[(y + 1) * lw + x] != 0);
            if touches {
                border.push(((y + by1) * max_width + (x + bx1)) as u32);
            }
        }
    }
    (approx_len, border)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiny_fill_merges_into_smallest_border_id() {
        // 8x8: id 2 region (area 4) surrounded by id 3 on one side and id 5
        // on the other; smallest border id (3) wins, NOT the largest contact
        let (w, h) = (8, 8);
        let mut m = Map32::new(w, h, 3);
        for y in 0..h {
            for x in 5..w {
                m.data[y * w + x] = 5;
            }
        }
        for y in 3..5 {
            for x in 3..5 {
                m.data[y * w + x] = 2;
            }
        }
        let merged = merge_fill(&m, 10, 10);
        // area 4 < 100 == 10*min_seg_size -> merged; new_id = min(3,5) = 3
        assert!(merged.data.iter().all(|&v| v != 2));
        assert_eq!(merged.data[3 * w + 3], 3);
    }

    #[test]
    fn zero_pixels_stay_zero() {
        let (w, h) = (6, 6);
        let mut m = Map32::new(w, h, 1);
        for x in 0..w {
            m.data[2 * w + x] = 0; // a line
        }
        for x in 0..w {
            for y in 3..6 {
                m.data[y * w + x] = 4;
            }
        }
        let merged = merge_fill(&m, 10, 10);
        for x in 0..w {
            assert_eq!(merged.data[2 * w + x], 0, "line must survive merge_fill");
        }
    }
}
