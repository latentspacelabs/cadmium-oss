//! Byte-exact port of the `tiler` Python package v0.5.7 (`tiler.py`,
//! `merger.py`, `_windows.py`), restricted to what the gap-closing path
//! uses: 2-D data, explicit integer overlap tuples, tiling mode
//! "constant" with `constant_value=0`, and the "overlap-tile" merge
//! window. Quirks of the original are preserved and commented.

use super::Gray;

/// Single-channel f32 image, row-major (C order).
#[derive(Clone, PartialEq)]
pub struct PlaneF32 {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

impl PlaneF32 {
    pub fn new(w: usize, h: usize, fill: f32) -> Self {
        PlaneF32 {
            w,
            h,
            data: vec![fill; w * h],
        }
    }
}

/// `tiler.Tiler(data_shape, tile_shape, overlap, mode="constant",
/// constant_value=0.0)` for 2-D shapes (axis 0 = rows/H, axis 1 = cols/W).
#[derive(Clone, Debug)]
pub struct Tiler {
    pub data_shape: [i64; 2],
    pub tile_shape: [i64; 2],
    pub overlap: [i64; 2],
    /// `_tile_step = tile_shape - overlap`
    pub step: [i64; 2],
    /// `_indexing_shape` (mosaic shape); components can be <= 0 when
    /// `tile_shape > data_shape` (the Python emits a "zero tiles" warning
    /// and `n_tiles == 0`)
    pub indexing_shape: [i64; 2],
    /// `_new_shape = indexing_shape * step + overlap` (padded canvas the
    /// Merger buffers use)
    pub new_shape: [i64; 2],
}

impl Tiler {
    pub fn new(data_shape: [usize; 2], tile_shape: [usize; 2], overlap: [usize; 2]) -> Tiler {
        assert!(
            overlap[0] < tile_shape[0] && overlap[1] < tile_shape[1],
            "Overlap size must be smaller than tile_shape."
        );
        let mut t = Tiler {
            data_shape: [data_shape[0] as i64, data_shape[1] as i64],
            tile_shape: [tile_shape[0] as i64, tile_shape[1] as i64],
            overlap: [overlap[0] as i64, overlap[1] as i64],
            step: [0; 2],
            indexing_shape: [0; 2],
            new_shape: [0; 2],
        };
        t.compute();
        t
    }

    /// `Tiler.recalculate(data_shape=...)` keeping every other setting.
    pub fn recalculate(&mut self, data_shape: [usize; 2]) {
        self.data_shape = [data_shape[0] as i64, data_shape[1] as i64];
        self.compute();
    }

    fn compute(&mut self) {
        for d in 0..2 {
            self.step[d] = self.tile_shape[d] - self.overlap[d];
            // div, mod = np.divmod(data_shape - overlap, step); numpy uses
            // floor division, so a data extent smaller than the overlap
            // yields div = -1 (and usually a nonzero mod).
            let num = self.data_shape[d] - self.overlap[d];
            let div = num.div_euclid(self.step[d]);
            let rem = num.rem_euclid(self.step[d]);
            self.indexing_shape[d] = div + (rem != 0) as i64;
            self.new_shape[d] = self.indexing_shape[d] * self.step[d] + self.overlap[d];
        }
    }

    /// `len(tiler)`: 0 whenever any mosaic dimension is <= 0 (the
    /// "zero tiles" warning case, e.g. tile_shape > data_shape).
    pub fn n_tiles(&self) -> usize {
        (self.indexing_shape[0].max(0) * self.indexing_shape[1].max(0)) as usize
    }

    /// `get_mosaic_shape()`.
    pub fn mosaic_shape(&self) -> [usize; 2] {
        [
            self.indexing_shape[0].max(0) as usize,
            self.indexing_shape[1].max(0) as usize,
        ]
    }

    /// `tiler._new_shape` — the padded canvas shape.
    pub fn padded_shape(&self) -> [usize; 2] {
        [self.new_shape[0] as usize, self.new_shape[1] as usize]
    }

    /// `calculate_padding()` -> (new_shape, ((pre_h, post_h), (pre_w, post_w))).
    /// The padding is `max(step // 2, overlap // 2)` before and the same
    /// plus `step % 2` after, per axis.
    pub fn calculate_padding(&self) -> ([usize; 2], [(usize, usize); 2]) {
        let mut new_shape = [0usize; 2];
        let mut padding = [(0usize, 0usize); 2];
        for d in 0..2 {
            let pre = (self.step[d] / 2).max(self.overlap[d] / 2);
            let post = pre + self.step[d] % 2;
            new_shape[d] = (pre + self.data_shape[d] + post) as usize;
            padding[d] = (pre as usize, post as usize);
        }
        (new_shape, padding)
    }

    /// `get_tile_mosaic_position(tile_id)`; tiles are numbered row-major
    /// over the mosaic (np.meshgrid indexing="ij" flattened).
    pub fn tile_mosaic_position(&self, tile_id: usize) -> [usize; 2] {
        assert!(tile_id < self.n_tiles(), "no tile {tile_id}");
        let mw = self.indexing_shape[1] as usize;
        [tile_id / mw, tile_id % mw]
    }

    /// `get_tile_bbox(tile_id)` -> ((h_start, h_end), (w_start, w_end)) on
    /// the padded canvas. `all_corners=True` in the Python returns the same
    /// values spread over four corner rows: corners[0] = (h_start, w_start),
    /// corners[1] = (h_start, w_end), corners[2] = (h_end, w_start),
    /// corners[3] = (h_end, w_end) — `build_border_data` reads
    /// bbox[0,0]/bbox[2,0]/bbox[0,1]/bbox[1,1], i.e. exactly these.
    pub fn tile_bbox(&self, tile_id: usize) -> [(usize, usize); 2] {
        let pos = self.tile_mosaic_position(tile_id);
        let mut out = [(0usize, 0usize); 2];
        for d in 0..2 {
            let start = pos[d] as i64 * self.step[d];
            out[d] = (start as usize, (start + self.tile_shape[d]) as usize);
        }
        out
    }

    /// `get_tile(data, tile_id)` in mode "constant": slice
    /// `[corner, min(data_shape, corner + tile_shape))` from the data and
    /// pad the bottom/right with `fill` up to tile_shape.
    fn tile_slice<T: Copy>(&self, data: &[T], dw: usize, dh: usize, tile_id: usize, fill: T) -> Vec<T> {
        assert_eq!(
            [dh as i64, dw as i64],
            self.data_shape,
            "data shape does not match Tiler's data_shape"
        );
        let pos = self.tile_mosaic_position(tile_id);
        let (th, tw) = (self.tile_shape[0] as usize, self.tile_shape[1] as usize);
        let corner = [
            pos[0] * self.step[0] as usize,
            pos[1] * self.step[1] as usize,
        ];
        let rows = corner[0]..dh.min(corner[0] + th);
        let cols = corner[1]..dw.min(corner[1] + tw);
        let mut out = vec![fill; th * tw];
        for (ti, y) in rows.enumerate() {
            let src = &data[y * dw + cols.start..y * dw + cols.end];
            out[ti * tw..ti * tw + src.len()].copy_from_slice(src);
        }
        out
    }

    pub fn get_tile_u8(&self, data: &Gray, tile_id: usize) -> Gray {
        Gray {
            w: self.tile_shape[1] as usize,
            h: self.tile_shape[0] as usize,
            data: self.tile_slice(&data.data, data.w, data.h, tile_id, 0u8),
        }
    }

    pub fn get_tile_f32(&self, data: &PlaneF32, tile_id: usize) -> PlaneF32 {
        PlaneF32 {
            w: self.tile_shape[1] as usize,
            h: self.tile_shape[0] as usize,
            data: self.tile_slice(&data.data, data.w, data.h, tile_id, 0.0f32),
        }
    }
}

/// `tiler.Merger(tiler, window="overlap-tile")`: f32 accumulation buffers
/// of `tiler._new_shape`, each added tile multiplied by the window (1 in
/// the tile's central `tile_shape - overlap` region, 0 elsewhere), then
/// `merge()` divides by the accumulated weights (`np.nan_to_num`,
/// 0/0 -> 0) and unpads.
pub struct Merger {
    tiler: Tiler,
    /// window over one tile, row-major (0.0 / 1.0)
    window: Vec<f32>,
    pub data: Vec<f32>,
    pub weights: Vec<f32>,
}

impl Merger {
    pub fn overlap_tile(tiler: &Tiler) -> Merger {
        let (th, tw) = (tiler.tile_shape[0] as usize, tiler.tile_shape[1] as usize);
        // Per-axis window: zeros with win[overlap//2 : -(overlap//2)] = 1.
        // QUIRK preserved: when overlap//2 == 0 the Python slice is
        // `win[0:-0]` == empty, leaving the window all zeros.
        let axis_win = |len: usize, overlap: i64| -> Vec<f32> {
            let half = (overlap / 2) as usize;
            let mut w = vec![0.0f32; len];
            if half > 0 && len >= 2 * half {
                w[half..len - half].fill(1.0);
            }
            w
        };
        let wh = axis_win(th, tiler.overlap[0]);
        let ww = axis_win(tw, tiler.overlap[1]);
        let mut window = vec![0.0f32; th * tw];
        for y in 0..th {
            for x in 0..tw {
                window[y * tw + x] = wh[y] * ww[x];
            }
        }
        let padded = tiler.padded_shape();
        Merger {
            tiler: tiler.clone(),
            window,
            data: vec![0.0f32; padded[0] * padded[1]],
            weights: vec![0.0f32; padded[0] * padded[1]],
        }
    }

    /// `merger.add(tile_id, tile)` for a full-shape tile.
    pub fn add_f32(&mut self, tile_id: usize, tile: &[f32]) {
        let (th, tw) = (
            self.tiler.tile_shape[0] as usize,
            self.tiler.tile_shape[1] as usize,
        );
        assert_eq!(tile.len(), th * tw, "tile shape mismatch");
        let bbox = self.tiler.tile_bbox(tile_id);
        let bw = self.tiler.padded_shape()[1];
        for ty in 0..th {
            let dst = (bbox[0].0 + ty) * bw + bbox[1].0;
            for tx in 0..tw {
                let w = self.window[ty * tw + tx];
                self.data[dst + tx] += tile[ty * tw + tx] * w;
                self.weights[dst + tx] += w;
            }
        }
    }

    pub fn add_u8(&mut self, tile_id: usize, tile: &Gray) {
        let t: Vec<f32> = tile.data.iter().map(|&v| v as f32).collect();
        self.add_f32(tile_id, &t);
    }

    pub fn add_i32(&mut self, tile_id: usize, tile: &[i32]) {
        let t: Vec<f32> = tile.iter().map(|&v| v as f32).collect();
        self.add_f32(tile_id, &t);
    }

    /// `merger.merge(extra_padding=..., normalize_by_weights=True)` before
    /// the final dtype cast: `np.nan_to_num(data / weights)` (0/0 becomes
    /// 0.0, x/0 becomes +-f32::MAX like np.nan_to_num maps +-inf), then
    /// unpad `[pad_from, data_shape - pad_to)` per axis. The caller applies
    /// the `astype(dtype)` truncating cast.
    pub fn merge(&self, extra_padding: [(usize, usize); 2]) -> PlaneF32 {
        let ds = [
            self.tiler.data_shape[0] as usize,
            self.tiler.data_shape[1] as usize,
        ];
        let bw = self.tiler.padded_shape()[1];
        let (y0, y1) = (extra_padding[0].0, ds[0] - extra_padding[0].1);
        let (x0, x1) = (extra_padding[1].0, ds[1] - extra_padding[1].1);
        let mut out = PlaneF32::new(x1 - x0, y1 - y0, 0.0);
        for (oy, y) in (y0..y1).enumerate() {
            for (ox, x) in (x0..x1).enumerate() {
                let d = self.data[y * bw + x];
                let w = self.weights[y * bw + x];
                let v = d / w;
                out.data[oy * out.w + ox] = if v.is_nan() {
                    0.0
                } else if v == f32::INFINITY {
                    f32::MAX
                } else if v == f32::NEG_INFINITY {
                    f32::MIN
                } else {
                    v
                };
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// f014's model tiler: cropped 422x222 is smaller than the 512 tile in
    /// one axis — zero tiles, but calculate_padding still works.
    #[test]
    fn zero_tiles_when_tile_larger_than_data() {
        let t = Tiler::new([422, 222], [512, 512], [256, 256]);
        assert_eq!(t.n_tiles(), 0);
        assert_eq!(t.indexing_shape, [1, 0]); // div+(mod!=0) with floor div
        let (new_shape, padding) = t.calculate_padding();
        assert_eq!(new_shape, [678, 478]);
        assert_eq!(padding, [(128, 128), (128, 128)]);
    }

    #[test]
    fn f014_padded_geometry() {
        let t = Tiler::new([678, 478], [512, 512], [256, 256]);
        assert_eq!(t.n_tiles(), 2);
        assert_eq!(t.mosaic_shape(), [2, 1]);
        assert_eq!(t.padded_shape(), [768, 512]);
        assert_eq!(t.tile_mosaic_position(0), [0, 0]);
        assert_eq!(t.tile_mosaic_position(1), [1, 0]);
        assert_eq!(t.tile_bbox(0), [(0, 512), (0, 512)]);
        assert_eq!(t.tile_bbox(1), [(256, 768), (0, 512)]);
    }

    #[test]
    fn tile_ids_are_row_major() {
        let t = Tiler::new([1336, 2176], [512, 512], [256, 256]);
        assert_eq!(t.mosaic_shape(), [5, 8]);
        assert_eq!(t.n_tiles(), 40);
        assert_eq!(t.tile_mosaic_position(9), [1, 1]);
        assert_eq!(t.tile_bbox(9), [(256, 768), (256, 768)]);
    }

    #[test]
    fn odd_step_padding_goes_after() {
        // tile 5, overlap 2 -> step 3: pre = max(1, 1) = 1, post = 1 + 3%2 = 2
        let t = Tiler::new([10, 10], [5, 5], [2, 2]);
        let (new_shape, padding) = t.calculate_padding();
        assert_eq!(padding, [(1, 2), (1, 2)]);
        assert_eq!(new_shape, [13, 13]);
    }

    #[test]
    fn get_tile_pads_constant_zero() {
        // data 4x6, tile 4x4, overlap 2x2 -> step 2, mosaic [1, 2]
        let mut data = Gray::new(6, 4, 0);
        for (i, v) in data.data.iter_mut().enumerate() {
            *v = i as u8 + 1;
        }
        let t = Tiler::new([4, 6], [4, 4], [2, 2]);
        assert_eq!(t.mosaic_shape(), [1, 2]);
        let tile1 = t.get_tile_u8(&data, 1); // cols 2..6 exactly fit
        assert_eq!(tile1.at(0, 0), data.at(2, 0));
        // now a data narrower than corner+tile: 4x5
        let mut data5 = Gray::new(5, 4, 0);
        for (i, v) in data5.data.iter_mut().enumerate() {
            *v = i as u8 + 1;
        }
        let t5 = Tiler::new([4, 5], [4, 4], [2, 2]);
        assert_eq!(t5.mosaic_shape(), [1, 2]);
        let tile1 = t5.get_tile_u8(&data5, 1); // cols 2..5 real, col 3 of tile padded 0
        assert_eq!(tile1.at(0, 0), data5.at(2, 0));
        assert_eq!(tile1.at(2, 0), data5.at(4, 0));
        assert_eq!(tile1.at(3, 0), 0);
        assert_eq!(tile1.at(3, 3), 0);
    }

    #[test]
    fn overlap_tile_window_is_disjoint_and_covering() {
        // Weights must be exactly 1 everywhere in the unpadded region.
        let t = Tiler::new([678, 478], [512, 512], [256, 256]);
        let mut m = Merger::overlap_tile(&t);
        let tile = vec![1.0f32; 512 * 512];
        for id in 0..t.n_tiles() {
            m.add_f32(id, &tile);
        }
        let merged = m.merge([(128, 128), (128, 128)]);
        assert_eq!((merged.w, merged.h), (222, 422));
        assert!(merged.data.iter().all(|&v| v == 1.0));
        // and weights are never > 1 anywhere (disjoint windows)
        assert!(m.weights.iter().all(|&w| w == 0.0 || w == 1.0));
    }

    #[test]
    fn zero_overlap_window_quirk_is_all_zero() {
        // Python: win[0:-0] is an empty slice, so overlap=0 leaves the
        // whole window zero.
        let t = Tiler::new([8, 8], [4, 4], [0, 0]);
        let m = Merger::overlap_tile(&t);
        assert!(m.window.iter().all(|&w| w == 0.0));
    }
}
