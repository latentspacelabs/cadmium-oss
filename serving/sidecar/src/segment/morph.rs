//! cv2-exact structuring elements and erode/dilate for u8 images.
//!
//! `cv2.getStructuringElement` shapes (verified against OpenCV 4.11
//! `getStructuringElement`'s ellipse rasterization, which uses
//! `cvRound` = round-half-even for the per-row half-width):
//! - MORPH_ELLIPSE r=0 (1x1): `[[1]]`
//! - MORPH_ELLIPSE r=1 (3x3): plus shape (010/111/010)
//! - MORPH_ELLIPSE r=2 (5x5): rows 00100/11111/11111/11111/00100
//!   (at dy=±1 the half-width is round(sqrt(3)=1.732) -> 2)
//! - MORPH_CROSS 3x3: plus shape
//!
//! erode/dilate: min/max over kernel hits, anchor center, 1 iteration.
//! cv2's default constant border acts as +inf for erode / -inf for dilate,
//! i.e. out-of-bounds samples do not contribute.

use super::Gray;

/// Structuring element as a list of (dy, dx) offsets from the anchor.
#[derive(Clone, Debug)]
pub struct Kernel {
    pub offsets: Vec<(i32, i32)>,
}

impl Kernel {
    /// `cv2.getStructuringElement(MORPH_ELLIPSE, (2r+1, 2r+1))` for r in 0..=2.
    pub fn ball(radius: usize) -> Kernel {
        let offsets: Vec<(i32, i32)> = match radius {
            0 => vec![(0, 0)],
            1 => vec![(-1, 0), (0, -1), (0, 0), (0, 1), (1, 0)],
            2 => {
                let mut v = Vec::with_capacity(21);
                v.push((-2, 0));
                for dy in -1..=1 {
                    for dx in -2..=2 {
                        v.push((dy, dx));
                    }
                }
                v.push((2, 0));
                v
            }
            _ => unreachable!("only radii 0..=2 are used by the /segment pipeline"),
        };
        Kernel { offsets }
    }

    /// `cv2.getStructuringElement(MORPH_CROSS, (3, 3))`.
    pub fn cross3() -> Kernel {
        Kernel {
            offsets: vec![(-1, 0), (0, -1), (0, 0), (0, 1), (1, 0)],
        }
    }

    fn contains_center(&self) -> bool {
        self.offsets.contains(&(0, 0))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum MorphOp {
    Erode,
    Dilate,
}

fn morph(img: &Gray, k: &Kernel, op: MorphOp) -> Gray {
    let (w, h) = (img.w as i32, img.h as i32);
    let init = match op {
        MorphOp::Erode => 255u8,
        MorphOp::Dilate => 0u8,
    };
    let mut out = Gray::new(img.w, img.h, init);
    for &(dy, dx) in &k.offsets {
        // rows/cols of `out` for which the sampled pixel is in bounds
        let y0 = (-dy).max(0);
        let y1 = (h - dy).min(h);
        let x0 = (-dx).max(0);
        let x1 = (w - dx).min(w);
        if y0 >= y1 || x0 >= x1 {
            continue;
        }
        for y in y0..y1 {
            let orow = (y * w) as usize;
            // signed base: (y+dy)*w + dx; base + x is in bounds for x in x0..x1
            let base = (y + dy) * w + dx;
            let dst = &mut out.data[orow + x0 as usize..orow + x1 as usize];
            let src = &img.data[(base + x0) as usize..(base + x1) as usize];
            match op {
                MorphOp::Erode => {
                    for (d, &s) in dst.iter_mut().zip(src.iter()) {
                        *d = (*d).min(s);
                    }
                }
                MorphOp::Dilate => {
                    for (d, &s) in dst.iter_mut().zip(src.iter()) {
                        *d = (*d).max(s);
                    }
                }
            }
        }
    }
    out
}

/// `cv2.morphologyEx(img, MORPH_ERODE, k, anchor=(-1,-1), iterations=1)`.
pub fn erode(img: &Gray, k: &Kernel) -> Gray {
    morph(img, k, MorphOp::Erode)
}

/// `cv2.morphologyEx(img, MORPH_DILATE, k, anchor=(-1,-1), iterations=1)`.
pub fn dilate(img: &Gray, k: &Kernel) -> Gray {
    morph(img, k, MorphOp::Dilate)
}

/// Fused `get_unfilled_point(exclude_area(img, ball))[0]`: the first pixel
/// (row-major) whose eroded value is 255, returned as (x, y). Exact because
/// erosion by a center-containing kernel of a 0/255 image is 255 at p iff
/// every in-bounds kernel sample at p equals 255.
pub fn first_eroded_unfilled(img: &Gray, k: &Kernel) -> Option<(usize, usize)> {
    debug_assert!(k.contains_center());
    let (w, h) = (img.w as i32, img.h as i32);
    for y in 0..h {
        for x in 0..w {
            if img.data[(y * w + x) as usize] != 255 {
                continue;
            }
            let mut all = true;
            for &(dy, dx) in &k.offsets {
                let yy = y + dy;
                let xx = x + dx;
                if yy < 0 || yy >= h || xx < 0 || xx >= w {
                    continue; // OOB does not constrain the min
                }
                if img.data[(yy * w + xx) as usize] != 255 {
                    all = false;
                    break;
                }
            }
            if all {
                return Some((x as usize, y as usize));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Render a kernel into a (2r+1)^2 matrix for shape assertions.
    fn render(k: &Kernel, r: i32) -> Vec<Vec<u8>> {
        let n = (2 * r + 1) as usize;
        let mut m = vec![vec![0u8; n]; n];
        for &(dy, dx) in &k.offsets {
            m[(dy + r) as usize][(dx + r) as usize] = 1;
        }
        m
    }

    #[test]
    fn structuring_elements_match_cv2() {
        // cv2.getStructuringElement(MORPH_ELLIPSE, (1,1))
        assert_eq!(render(&Kernel::ball(0), 0), vec![vec![1]]);
        // cv2.getStructuringElement(MORPH_ELLIPSE, (3,3)) == plus
        assert_eq!(
            render(&Kernel::ball(1), 1),
            vec![vec![0, 1, 0], vec![1, 1, 1], vec![0, 1, 0]]
        );
        // cv2.getStructuringElement(MORPH_ELLIPSE, (5,5)): dy=±1 rounds
        // dx=sqrt(3)=1.732.. to 2 (cvRound), so rows -1..=1 are full.
        assert_eq!(
            render(&Kernel::ball(2), 2),
            vec![
                vec![0, 0, 1, 0, 0],
                vec![1, 1, 1, 1, 1],
                vec![1, 1, 1, 1, 1],
                vec![1, 1, 1, 1, 1],
                vec![0, 0, 1, 0, 0],
            ]
        );
        // cv2.getStructuringElement(MORPH_CROSS, (3,3)) == plus
        assert_eq!(
            render(&Kernel::cross3(), 1),
            vec![vec![0, 1, 0], vec![1, 1, 1], vec![0, 1, 0]]
        );
    }

    #[test]
    fn erode_dilate_border_semantics() {
        // 3x3 all-255 image, plus kernel: erosion keeps 255 everywhere
        // because OOB samples do not contribute (cv2 constant +inf border).
        let img = Gray::new(3, 3, 255);
        let er = erode(&img, &Kernel::ball(1));
        assert!(er.data.iter().all(|&v| v == 255));

        // single 255 pixel in the corner dilates into its in-bounds plus
        let mut img = Gray::new(3, 3, 0);
        img.data[0] = 255;
        let di = dilate(&img, &Kernel::cross3());
        assert_eq!(di.data, vec![255, 255, 0, 255, 0, 0, 0, 0, 0]);

        // erosion of a 0/255 image: 0 wherever any kernel sample is 0
        let mut img = Gray::new(3, 3, 255);
        img.data[4] = 0; // center
        let er = erode(&img, &Kernel::cross3());
        assert_eq!(er.data, vec![255, 0, 255, 0, 0, 0, 255, 0, 255]);
    }

    #[test]
    fn ball0_is_identity() {
        let mut img = Gray::new(4, 2, 0);
        for (i, v) in img.data.iter_mut().enumerate() {
            *v = (i * 37) as u8;
        }
        assert_eq!(erode(&img, &Kernel::ball(0)).data, img.data);
        assert_eq!(dilate(&img, &Kernel::ball(0)).data, img.data);
    }

    #[test]
    fn first_eroded_unfilled_scans_row_major() {
        // 255 region too thin for the r=1 ball except at one spot
        let mut img = Gray::new(5, 5, 0);
        // plus-shaped 255 region centered at (2,2)
        for &(y, x) in &[(1, 2), (2, 1), (2, 2), (2, 3), (3, 2)] {
            img.data[y * 5 + x] = 255;
        }
        assert_eq!(first_eroded_unfilled(&img, &Kernel::ball(1)), Some((2, 2)));
        assert_eq!(first_eroded_unfilled(&img, &Kernel::ball(2)), None);
        // r=0: first 255 pixel row-major
        assert_eq!(first_eroded_unfilled(&img, &Kernel::ball(0)), Some((2, 1)));
    }
}
