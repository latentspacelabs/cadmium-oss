//! Port of `trapped_ball.py::thinning` — fills line pixels (id 0) with a
//! neighboring fill id, iterating up to `max_iter` times — and the final
//! `np.unique(..., return_inverse=True)` relabel.
//!
//! The original's bugs are PRESERVED:
//! - the neighbor bounds tests use `> 0` (not `>= 0`), so pixels at x==1 /
//!   y==1 skip their left / top neighbors (index 0 exists but is never
//!   read), and pixels at x==0 / y==0 skip them likewise;
//! - the neighbor probe order is exactly: left, top-left, top, top-right,
//!   right, bottom-right, bottom, bottom-left;
//! - reads come from the pre-iteration `result`, writes go to a copy that
//!   is swapped in at iteration end.

use super::Map32;

const LINE_ID: i32 = 0;

/// `thinning(fillmap, max_iter=100)`.
pub fn thinning(fillmap: &Map32, max_iter: usize) -> Map32 {
    let (w, h) = (fillmap.w, fillmap.h);
    let mut result = fillmap.clone();

    for _ in 0..max_iter {
        // line points; stop when none remain
        let mut any_line = false;

        // border points: line pixels with a non-line 4-neighbor
        // (dilate(line_mask, CROSS3) - line_mask == 255), np.where order
        let mut border: Vec<(usize, usize)> = Vec::new(); // (y, x)
        for y in 0..h {
            for x in 0..w {
                if result.data[y * w + x] != LINE_ID {
                    continue;
                }
                any_line = true;
                let touches = (y > 0 && result.data[(y - 1) * w + x] != LINE_ID)
                    || (x > 0 && result.data[y * w + x - 1] != LINE_ID)
                    || (x + 1 < w && result.data[y * w + x + 1] != LINE_ID)
                    || (y + 1 < h && result.data[(y + 1) * w + x] != LINE_ID);
                if touches {
                    border.push((y, x));
                }
            }
        }
        if !any_line {
            break;
        }

        let mut result_tmp = result.clone();
        for &(y, x) in &border {
            let r = &result.data;
            // exact probe order and bounds tests from the Python
            let v = if x > 1 && r[y * w + x - 1] != LINE_ID {
                r[y * w + x - 1] // left        (x-1 > 0)
            } else if x > 1 && y > 1 && r[(y - 1) * w + x - 1] != LINE_ID {
                r[(y - 1) * w + x - 1] // top-left   (x-1>0 and y-1>0)
            } else if y > 1 && r[(y - 1) * w + x] != LINE_ID {
                r[(y - 1) * w + x] // top          (y-1 > 0)
            } else if y > 1 && x + 1 < w && r[(y - 1) * w + x + 1] != LINE_ID {
                r[(y - 1) * w + x + 1] // top-right
            } else if x + 1 < w && r[y * w + x + 1] != LINE_ID {
                r[y * w + x + 1] // right
            } else if x + 1 < w && y + 1 < h && r[(y + 1) * w + x + 1] != LINE_ID {
                r[(y + 1) * w + x + 1] // bottom-right
            } else if y + 1 < h && r[(y + 1) * w + x] != LINE_ID {
                r[(y + 1) * w + x] // bottom
            } else if y + 1 < h && x > 1 && r[(y + 1) * w + x - 1] != LINE_ID {
                r[(y + 1) * w + x - 1] // bottom-left
            } else {
                continue;
            };
            result_tmp.data[y * w + x] = v;
        }
        result = result_tmp;
    }
    result
}

/// `np.unique(thinned, return_inverse=True)`: labels relabeled by sorted
/// unique value order. Returns (labels, num_labels).
pub fn relabel(map: &Map32) -> (Map32, usize) {
    let max_v = *map.data.iter().max().expect("non-empty map");
    debug_assert!(*map.data.iter().min().unwrap() >= 0);
    let mut present = vec![false; (max_v + 1) as usize];
    for &v in &map.data {
        present[v as usize] = true;
    }
    let mut lut = vec![0i32; (max_v + 1) as usize];
    let mut next = 0i32;
    for (v, &p) in present.iter().enumerate() {
        if p {
            lut[v] = next;
            next += 1;
        }
    }
    let mut out = Map32::new(map.w, map.h, 0);
    for (o, &v) in out.data.iter_mut().zip(map.data.iter()) {
        *o = lut[v as usize];
    }
    (out, next as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_absorbs_left_neighbor_first() {
        // 1x5 row: [7, 0, 9, 0, 0] — the first border pixel (x=1) has a
        // left neighbor 7 BUT x-1 == 0 fails the buggy `x-1 > 0` test, so
        // it takes... left is skipped, top/bottom don't exist (h==1),
        // right is 9 -> 9.
        let m = Map32 {
            w: 5,
            h: 1,
            data: vec![7, 0, 9, 0, 0],
        };
        let t = thinning(&m, 100);
        assert_eq!(t.data, vec![7, 9, 9, 9, 9]);
    }

    #[test]
    fn left_neighbor_used_when_x_greater_than_1() {
        // [7, 7, 0, 9]: border pixel x=2 has x-1=1 > 0 -> left neighbor 7
        let m = Map32 {
            w: 4,
            h: 1,
            data: vec![7, 7, 0, 9],
        };
        let t = thinning(&m, 100);
        assert_eq!(t.data, vec![7, 7, 7, 9]);
    }

    #[test]
    fn reads_come_from_pre_iteration_state() {
        // [0, 0, 5]: x=1 is a border pixel (right neighbor... x+1=2 is 5).
        // x=0 is NOT a border pixel in iteration 1 (its only in-bounds
        // 4-neighbor with the buggy tests... dilate uses the true cross, so
        // x=0 IS border iff a 4-neighbor is non-line: neighbor x=1 is line,
        // so not border. Iteration 2 fills it — but the buggy `x-1>0` and
        // probe order make it read the right neighbor from iteration 1.
        let m = Map32 {
            w: 3,
            h: 1,
            data: vec![0, 0, 5],
        };
        let t = thinning(&m, 100);
        assert_eq!(t.data, vec![5, 5, 5]);
    }

    #[test]
    fn stuck_pixels_survive_all_iterations() {
        // all-zero map: no border points ever, 100 iterations, unchanged
        let m = Map32 {
            w: 3,
            h: 2,
            data: vec![0; 6],
        };
        let t = thinning(&m, 100);
        assert_eq!(t.data, vec![0; 6]);
    }

    #[test]
    fn relabel_sorted_unique() {
        let m = Map32 {
            w: 4,
            h: 1,
            data: vec![7, 0, 9, 7],
        };
        let (out, n) = relabel(&m);
        assert_eq!(n, 3);
        assert_eq!(out.data, vec![1, 0, 2, 1]);
    }
}
