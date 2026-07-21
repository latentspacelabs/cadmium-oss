//! `cv2.floodFill` as used by the trapped-ball code.
//!
//! Every call site is `floodFill(pass, mask, seed, 0, 0, 0, 4)` where
//! `pass` is an all-255 image and `mask` is a (h+2)x(w+2) border-padded
//! image whose interior is 0 exactly on the passable pixels. With zero
//! lo/up diffs over a uniform image this reduces to: paint 0 over the
//! 4-connected component of "passable" pixels containing the seed. The
//! result only depends on the component as a set, so a span-filling BFS is
//! byte-exact.

use super::Gray;

/// Returns an image that is 255 everywhere except 0 on the 4-connected
/// `open` region containing `seed` (given as (x, y), which must be open).
pub fn flood_pass<F: Fn(usize) -> bool>(w: usize, h: usize, seed: (usize, usize), open: F) -> Gray {
    let mut out = Gray::new(w, h, 255);
    let (sx, sy) = seed;
    debug_assert!(sx < w && sy < h);
    debug_assert!(open(sy * w + sx), "floodFill seed must be passable");

    let mut stack: Vec<(usize, usize)> = vec![(sx, sy)];
    while let Some((x, y)) = stack.pop() {
        let row = y * w;
        if out.data[row + x] == 0 || !open(row + x) {
            continue;
        }
        // expand the horizontal run through (x, y)
        let mut x0 = x;
        while x0 > 0 && out.data[row + x0 - 1] == 255 && open(row + x0 - 1) {
            x0 -= 1;
        }
        let mut x1 = x;
        while x1 + 1 < w && out.data[row + x1 + 1] == 255 && open(row + x1 + 1) {
            x1 += 1;
        }
        for i in row + x0..=row + x1 {
            out.data[i] = 0;
        }
        for ny in [y.wrapping_sub(1), y + 1] {
            if ny >= h {
                continue;
            }
            let nrow = ny * w;
            for nx in x0..=x1 {
                if out.data[nrow + nx] == 255 && open(nrow + nx) {
                    stack.push((nx, ny));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_4_connected_component_only() {
        // 4x3: two 255 regions touching only diagonally
        // 255 255   0
        //   0 255   0
        //   0   0 255  <- diagonal neighbor: NOT filled (4-connectivity)
        let w = 3;
        let h = 3;
        let img = vec![255u8, 255, 0, 0, 255, 0, 0, 0, 255];
        let out = flood_pass(w, h, (0, 0), |i| img[i] == 255);
        assert_eq!(out.data, vec![0, 0, 255, 255, 0, 255, 255, 255, 255]);
    }

    #[test]
    fn seed_anywhere_in_component() {
        let w = 4;
        let h = 1;
        let img = vec![255u8, 255, 0, 255];
        let out = flood_pass(w, h, (1, 0), |i| img[i] == 255);
        assert_eq!(out.data, vec![0, 0, 255, 255]);
    }
}
