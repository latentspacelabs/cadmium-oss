//! Port of the fill passes from `trapped_ball.py`:
//! `trapped_ball_fill_single/multi`, `flood_fill_single/multi`,
//! `mark_fill`, `build_fill_map`.
//!
//! Quirks preserved:
//! - a fill's recorded points are `np.where(fill == 0)` on the *returned*
//!   image (after the closing erode), which can include pixels that were
//!   already filled or are line pixels — they are recorded anyway;
//! - `method='max'` keeps every fill whose size is >= the maximum
//!   (ties keep all), in insertion order; `method=None` keeps all;
//! - seeds are the first unfilled point (row-major) of the *eroded*
//!   unfill area for trapped-ball, of the raw unfill area for flood fill.

use super::flood::flood_pass;
use super::morph::{dilate, erode, first_eroded_unfilled, Kernel};
use super::Gray;

/// One fill: linear pixel indices (row-major, ascending — np.where order).
pub type Fill = Vec<u32>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FilterMethod {
    /// `method='max'`: keep fills with size >= max(sizes)
    Max,
    /// `method=None`: keep all fills
    None,
}

/// `trapped_ball_fill_single(image, seed_point, radius)`:
/// flood the raw image's 255-region at seed, dilate by the ball, flood the
/// dilated result's 0-region at the same seed, erode by the ball.
pub fn trapped_ball_fill_single(image: &Gray, seed: (usize, usize), ball: &Kernel) -> Gray {
    let (w, h) = (image.w, image.h);
    let pass1 = flood_pass(w, h, seed, |i| image.data[i] == 255);
    let pass1 = dilate(&pass1, ball);
    let pass2 = flood_pass(w, h, seed, |i| pass1.data[i] == 0);
    erode(&pass2, ball)
}

/// `trapped_ball_fill_multi(image, radius, method, max_iter)`.
pub fn trapped_ball_fill_multi(
    image: &Gray,
    radius: usize,
    method: FilterMethod,
    max_iter: usize,
) -> Vec<Fill> {
    let ball = Kernel::ball(radius);
    let mut unfill = image.clone();
    let mut fills: Vec<Fill> = Vec::new();

    for _ in 0..max_iter {
        // seed = get_unfilled_point(exclude_area(unfill_area, radius))[0]
        let Some(seed) = first_eroded_unfilled(&unfill, &ball) else {
            break;
        };
        let fill = trapped_ball_fill_single(&unfill, seed, &ball);
        // unfill_area = cv2.bitwise_and(unfill_area, fill)
        for (u, &f) in unfill.data.iter_mut().zip(fill.data.iter()) {
            *u &= f;
        }
        // filled_area.append(np.where(fill == 0))
        let points: Fill = fill
            .data
            .iter()
            .enumerate()
            .filter_map(|(i, &v)| (v == 0).then_some(i as u32))
            .collect();
        fills.push(points);
    }

    if fills.is_empty() {
        return fills;
    }
    let threshold = match method {
        FilterMethod::Max => fills.iter().map(|f| f.len()).max().unwrap(),
        FilterMethod::None => 0,
    };
    fills.retain(|f| f.len() >= threshold);
    fills
}

/// `flood_fill_multi(image, max_iter=20000)`: plain flood fills, no ball,
/// seeds from the raw unfill area, keeps all fills.
pub fn flood_fill_multi(image: &Gray, max_iter: usize) -> Vec<Fill> {
    let (w, h) = (image.w, image.h);
    let mut unfill = image.clone();
    let mut fills: Vec<Fill> = Vec::new();

    for _ in 0..max_iter {
        // get_unfilled_point: first 255 pixel in row-major order
        let Some(first) = unfill.data.iter().position(|&v| v == 255) else {
            break;
        };
        let seed = (first % w, first / w);
        let fill = flood_pass(w, h, seed, |i| unfill.data[i] == 255);
        for (u, &f) in unfill.data.iter_mut().zip(fill.data.iter()) {
            *u &= f;
        }
        let points: Fill = fill
            .data
            .iter()
            .enumerate()
            .filter_map(|(i, &v)| (v == 0).then_some(i as u32))
            .collect();
        fills.push(points);
    }
    fills
}

/// `mark_fill(image, fills)`: set the fills' points to 0.
pub fn mark_fill(image: &Gray, fills: &[Fill]) -> Gray {
    let mut result = image.clone();
    for fill in fills {
        for &p in fill {
            result.data[p as usize] = 0;
        }
    }
    result
}

/// `build_fill_map(image, fills)`: zeros i32; fills[i] pixels get id i+1,
/// applied in order (later fills overwrite earlier on overlap).
pub fn build_fill_map(w: usize, h: usize, fills: &[Fill]) -> super::Map32 {
    let mut result = super::Map32::new(w, h, 0);
    for (index, fill) in fills.iter().enumerate() {
        let id = (index + 1) as i32;
        for &p in fill {
            result.data[p as usize] = id;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 9x7 image with a 1px vertical line broken by a 1px gap: the r=1
    /// trapped ball must not leak through the gap, a plain flood fill does.
    fn gap_image() -> Gray {
        let (w, h) = (9, 7);
        let mut img = Gray::new(w, h, 255);
        for y in 0..h {
            if y != 3 {
                img.data[y * w + 4] = 0;
            }
        }
        img
    }

    #[test]
    fn trapped_ball_does_not_leak_through_gap() {
        let img = gap_image();
        let fills = trapped_ball_fill_multi(&img, 1, FilterMethod::None, 1000);
        assert!(fills.len() >= 2, "gap should split the area for the ball");
        // no fill contains pixels from both sides of the line
        for f in &fills {
            let sides: Vec<bool> = f.iter().map(|&p| (p as usize % 9) > 4).collect();
            assert!(
                sides.iter().all(|&s| s) || sides.iter().all(|&s| !s),
                "a single trapped-ball fill leaked through the gap"
            );
        }
    }

    #[test]
    fn flood_fill_leaks_through_gap_and_covers_everything() {
        let img = gap_image();
        let fills = flood_fill_multi(&img, 20000);
        assert_eq!(fills.len(), 1, "the gap connects both sides for flood fill");
        assert_eq!(fills[0].len(), 9 * 7 - 6, "everything except the line");
    }

    #[test]
    fn max_filter_keeps_ties_in_order() {
        let img = gap_image();
        let all = trapped_ball_fill_multi(&img, 1, FilterMethod::None, 1000);
        let kept = trapped_ball_fill_multi(&img, 1, FilterMethod::Max, 1000);
        let max = all.iter().map(|f| f.len()).max().unwrap();
        let expect: Vec<Fill> = all.into_iter().filter(|f| f.len() >= max).collect();
        assert_eq!(kept, expect);
    }

    #[test]
    fn build_fill_map_overwrites_in_order() {
        let fills = vec![vec![0u32, 1, 2], vec![2, 3]];
        let m = build_fill_map(4, 1, &fills);
        assert_eq!(m.data, vec![1, 1, 2, 2]);
    }
}
