//! Bit-faithful replicas of the torch CPU f32 reduction arithmetic that
//! `compute_normalized_entropy` flows through on the production host
//! (linux x86-64, torch 2.6.0+cu126, AVX2 dispatch — pytorch keeps AVX512
//! opt-in, see pytorch/pytorch#80252; the kernel sources below are
//! line-identical between v2.4.1 and v2.6.0, and every path was verified
//! bitwise against the production host on the golden corpus):
//!
//!   - `at::vec::reduce_all` / `map_reduce_all`
//!     (`ATen/cpu/vec/functional_base.h`): 8-lane accumulation. For
//!     `size < 8` the partial vector is folded SEQUENTIALLY into lane 0
//!     (the "slow path" `vec_reduce_all(op, vec, size)`); full vectors are
//!     folded with the AVX2 shuffle tree (`VecReduceAllSIMD<float>`:
//!     permute2f128, shuffle 0x4E, shuffle 0xB1).
//!   - the cascade sum kernel behind `Tensor.sum(dim=-1)`
//!     (`ATen/native/cpu/SumKernel.cpp::cascade_sum`). NOTE the dispatch
//!     quirk: the vectorized contiguous-inner path requires
//!     `size0 >= Vec::size()` (8), so a last-dim reduction over fewer than
//!     8 f32s takes `scalar_inner_sum` — a per-row `row_sum` with
//!     ilp_factor=4 interleaving: partial k accumulates elements
//!     k, k+4, k+8, ... , the tail (size % 4) folds into partial 0, then
//!     partials 1..3 fold into 0. NOT a plain left-to-right sum.
//!     (Verified bit-exact against the production host's torch on the
//!     whole corpus; the block-of-4 `multi_row_sum` structure belongs to
//!     `scalar_outer_sum`, which this shape never reaches.)
//!
//! Summation order is data-dependent rounding, so all of this is replicated
//! literally. Everything here assumes the serial path (tensor numel below
//! `at::internal::GRAIN_SIZE` = 32768, as in production postprocess calls);
//! larger tensors would be split across threads with chunk-dependent block
//! boundaries.

pub(crate) const LANES: usize = 8; // AVX2 Vectorized<float>::size()

type V8 = [f32; 8];

/// `Vectorized<float>::loadu(ptr, count)`: zero-fill the tail lanes.
fn loadu_partial(data: &[f32]) -> V8 {
    let mut v = [0.0f32; LANES];
    v[..data.len()].copy_from_slice(data);
    v
}

fn loadu(data: &[f32]) -> V8 {
    data[..LANES].try_into().unwrap()
}

fn lanewise(op: impl Fn(f32, f32) -> f32, a: V8, b: V8) -> V8 {
    std::array::from_fn(|i| op(a[i], b[i]))
}

/// `vec_reduce_all(op, acc_vec, size)` — the sized "slow path": fold the
/// original lanes 1..size into lane 0, sequentially, as op(acc, lane_i).
fn vec_reduce_all_seq(op: &impl Fn(f32, f32) -> f32, v: V8, size: usize) -> f32 {
    let mut acc = v[0];
    for &lane in v.iter().take(size).skip(1) {
        acc = op(acc, lane);
    }
    acc
}

/// `VecReduceAllSIMD<float, Op>` for AVX2: three shuffle/op rounds.
fn vec_reduce_all_tree(op: &impl Fn(f32, f32) -> f32, v: V8) -> f32 {
    // _mm256_permute2f128_ps(v, v, 0x1): swap 128-bit halves
    let v1: V8 = std::array::from_fn(|i| v[(i + 4) % 8]);
    let v = lanewise(op, v, v1);
    // _mm256_shuffle_ps(v, v, 0x4E): [2,3,0,1] within each half
    let v1: V8 = [v[2], v[3], v[0], v[1], v[6], v[7], v[4], v[5]];
    let v = lanewise(op, v, v1);
    // _mm256_shuffle_ps(v, v, 0xB1): [1,0,3,2] within each half
    let v1: V8 = [v[1], v[0], v[3], v[2], v[5], v[4], v[7], v[6]];
    let v = lanewise(op, v, v1);
    v[0]
}

/// `at::vec::reduce_all<float>(op, data, size)`.
pub fn reduce_all(op: impl Fn(f32, f32) -> f32, data: &[f32]) -> f32 {
    let n = data.len();
    assert!(n > 0, "reduce_all over empty slice");
    if n < LANES {
        return vec_reduce_all_seq(&op, loadu_partial(data), n);
    }
    let mut acc = loadu(data);
    let mut d = LANES;
    while d < n - (n % LANES) {
        acc = lanewise(&op, acc, loadu(&data[d..]));
        d += LANES;
    }
    if n - d > 0 {
        // Vec::set(acc, op(acc, tail), count): lanes < count take the op
        let full = lanewise(&op, acc, loadu_partial(&data[d..]));
        acc[..(n - d)].copy_from_slice(&full[..(n - d)]);
    }
    vec_reduce_all_tree(&op, acc)
}

/// `at::vec::map_reduce_all<float>(map, red, data, size)`. The map runs on
/// whole (zero-filled) vectors, but tail-lane garbage never enters the
/// reduction — same as the SIMD original.
pub fn map_reduce_all(
    map: impl Fn(f32) -> f32,
    red: impl Fn(f32, f32) -> f32,
    data: &[f32],
) -> f32 {
    let n = data.len();
    assert!(n > 0, "map_reduce_all over empty slice");
    let map8 = |v: V8| -> V8 { std::array::from_fn(|i| map(v[i])) };
    if n < LANES {
        return vec_reduce_all_seq(&red, map8(loadu_partial(data)), n);
    }
    let mut acc = map8(loadu(data));
    let mut d = LANES;
    while d < n - (n % LANES) {
        acc = lanewise(&red, acc, map8(loadu(&data[d..])));
        d += LANES;
    }
    if n - d > 0 {
        let full = lanewise(&red, acc, map8(loadu_partial(&data[d..])));
        acc[..(n - d)].copy_from_slice(&full[..(n - d)]);
    }
    vec_reduce_all_tree(&red, acc)
}

/// `vec::maximum(a, b)` == `_mm256_max_ps(a, b)` for non-NaN inputs:
/// returns b on ties (and on NaN, which the NaN-OR step then propagates —
/// the logits corpus is NaN-free, so the plain select is exact).
pub fn vmax(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

pub fn vadd(a: f32, b: f32) -> f32 {
    a + b
}

// ---------------------------------------------------------------------------
// SumKernel.cpp cascade sum

/// `ATen/native/cpu/utils.h::CeilLog2` (only reachable levels for sizes
/// > 2^16 differ from level_power=4; kept for fidelity).
fn ceil_log2(x: usize) -> usize {
    if x <= 2 {
        1
    } else {
        (usize::BITS - (x - 1).leading_zeros()) as usize
    }
}

/// `SumKernel.cpp::multi_row_sum<scalar_t, nrows>`: cascade accumulation of
/// `nrows` independent sums over `size` elements, `load(i, k)` = element i
/// of row k.
fn multi_row_sum<const NROWS: usize>(
    load: impl Fn(usize, usize) -> f32,
    size: usize,
) -> [f32; NROWS] {
    const NUM_LEVELS: usize = 4;
    let level_power = std::cmp::max(4, ceil_log2(size) / NUM_LEVELS);
    let level_step = 1usize << level_power;
    let level_mask = level_step - 1;

    let mut acc = [[0.0f32; NROWS]; NUM_LEVELS];
    let mut i = 0usize;
    while i + level_step <= size {
        for _ in 0..level_step {
            for k in 0..NROWS {
                acc[0][k] += load(i, k);
            }
            i += 1;
        }
        for j in 1..NUM_LEVELS {
            for k in 0..NROWS {
                acc[j][k] += acc[j - 1][k];
                acc[j - 1][k] = 0.0;
            }
            let mask = level_mask << (j * level_power);
            if i & mask != 0 {
                break;
            }
        }
    }
    while i < size {
        for k in 0..NROWS {
            acc[0][k] += load(i, k);
        }
        i += 1;
    }
    for j in 1..NUM_LEVELS {
        for k in 0..NROWS {
            acc[0][k] += acc[j][k];
        }
    }
    std::array::from_fn(|k| acc[0][k])
}

/// `SumKernel.cpp::row_sum` (scalar loads): view the row as (-1, 4) for
/// ILP, then fold the tail and the four partials into partial_sums[0].
fn row_sum_scalar(row: &[f32]) -> f32 {
    const ILP: usize = 4;
    let size = row.len();
    let size_ilp = size / ILP;
    let mut partial = multi_row_sum::<ILP>(|i, k| row[i * ILP + k], size_ilp);
    for &x in &row[size_ilp * ILP..] {
        partial[0] += x;
    }
    for k in 1..ILP {
        partial[0] += partial[k];
    }
    partial[0]
}

/// `SumKernel.cpp::vectorized_inner_sum` for one row (size0 >= 8): the same
/// row_sum/multi_row_sum cascade over 8-lane vectors, then the scalar tail
/// added to 0.0 first, then the 8 accumulator lanes sequentially.
fn row_sum_vectorized(row: &[f32]) -> f32 {
    const ILP: usize = 4;
    let n = row.len();
    let vec_size = n / LANES;

    // row_sum<vacc_t, VecLoadPolicy>(row, vec_stride, vec_size)
    let size_ilp = vec_size / ILP;
    let vload = |i: usize, k: usize| -> V8 { loadu(&row[(i * ILP + k) * LANES..]) };
    // multi_row_sum with vector accumulators
    const NUM_LEVELS: usize = 4;
    let level_power = std::cmp::max(4, ceil_log2(size_ilp) / NUM_LEVELS);
    let level_step = 1usize << level_power;
    let level_mask = level_step - 1;
    let mut acc = [[[0.0f32; LANES]; ILP]; NUM_LEVELS];
    let mut i = 0usize;
    while i + level_step <= size_ilp {
        for _ in 0..level_step {
            for k in 0..ILP {
                acc[0][k] = lanewise(vadd, acc[0][k], vload(i, k));
            }
            i += 1;
        }
        for j in 1..NUM_LEVELS {
            for k in 0..ILP {
                acc[j][k] = lanewise(vadd, acc[j][k], acc[j - 1][k]);
                acc[j - 1][k] = [0.0; LANES];
            }
            let mask = level_mask << (j * level_power);
            if i & mask != 0 {
                break;
            }
        }
    }
    while i < size_ilp {
        for k in 0..ILP {
            acc[0][k] = lanewise(vadd, acc[0][k], vload(i, k));
        }
        i += 1;
    }
    for j in 1..NUM_LEVELS {
        for k in 0..ILP {
            acc[0][k] = lanewise(vadd, acc[0][k], acc[j][k]);
        }
    }
    let mut partial = acc[0];
    // row_sum tail over remaining vectors, then partials 1..4 into 0
    for i in size_ilp * ILP..vec_size {
        partial[0] = lanewise(vadd, partial[0], loadu(&row[i * LANES..]));
    }
    for k in 1..ILP {
        partial[0] = lanewise(vadd, partial[0], partial[k]);
    }
    let vec_acc = partial[0];

    // vectorized_inner_sum epilogue
    let mut final_acc = 0.0f32;
    for &x in &row[vec_size * LANES..] {
        final_acc += x;
    }
    for lane in vec_acc {
        final_acc += lane;
    }
    final_acc
}

/// `Tensor.sum(dim=-1)` of a contiguous (rows, n) f32 tensor under
/// `cascade_sum` (serial, single-chunk). Output starts at 0.0 and the row
/// result is ACCUMULATED into it (`CastStoreAccumulate`), exactly like the
/// kernel's `fill_(0)` + `+=` store.
pub fn sum_lastdim(data: &[f32], rows: usize, n: usize) -> Vec<f32> {
    assert_eq!(data.len(), rows * n, "sum_lastdim shape mismatch");
    let mut out = vec![0.0f32; rows];
    if n >= LANES {
        // contiguous inner reduction -> vectorized_inner_sum
        for j in 0..rows {
            out[j] += row_sum_vectorized(&data[j * n..][..n]);
        }
    } else {
        // size0 < Vec::size() fails the vectorized gate -> scalar_inner_sum:
        // row_sum (ilp4) for every output row
        for j in 0..rows {
            out[j] += row_sum_scalar(&data[j * n..][..n]);
        }
    }
    out
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_reduce_is_sequential() {
        // n < 8: plain left fold
        let data = [1.0e8f32, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        let want = data.iter().copied().fold(f32::NEG_INFINITY, vmax);
        assert_eq!(reduce_all(vmax, &data), want);
        let mut seq = data[0];
        for &x in &data[1..] {
            seq += x;
        }
        assert_eq!(reduce_all(vadd, &data).to_bits(), seq.to_bits());
    }

    #[test]
    fn full_vector_reduce_uses_shuffle_tree() {
        // 8 lanes: ((x0+x4)+(x2+x6)) + ((x1+x5)+(x3+x7)) tree order at the end
        let data: Vec<f32> = (0..8).map(|i| (i as f32) + 0.1).collect();
        let t1 = [
            data[0] + data[4],
            data[1] + data[5],
            data[2] + data[6],
            data[3] + data[7],
        ];
        let t2 = [t1[0] + t1[2], t1[1] + t1[3]];
        let want = t2[0] + t2[1];
        assert_eq!(reduce_all(vadd, &data).to_bits(), want.to_bits());
    }

    #[test]
    fn map_reduce_matches_manual_short_fold() {
        let data = [0.5f32, -1.5, 2.0];
        let mapped: Vec<f32> = data.iter().map(|&x| x * x).collect();
        let want = (mapped[0] + mapped[1]) + mapped[2];
        assert_eq!(
            map_reduce_all(|x| x * x, vadd, &data).to_bits(),
            want.to_bits()
        );
    }

    #[test]
    fn sum_lastdim_short_rows_use_ilp4_order_per_row() {
        // n < 8 -> scalar_inner_sum: EVERY row is a row_sum with ilp4
        // interleave: p0=x0+x4+x5+x6 then +x1+x2+x3 (pk seeded from 0.0)
        let n = 7;
        let rows = 5;
        let data: Vec<f32> = (0..rows * n)
            .map(|i| ((i * 37 % 11) as f32) * 1.7e3 + 0.3)
            .collect();
        let out = sum_lastdim(&data, rows, n);
        for j in 0..rows {
            let row = &data[j * n..][..n];
            let p: Vec<f32> = (0..4).map(|k| 0.0 + row[k]).collect();
            let mut p0 = ((p[0] + row[4]) + row[5]) + row[6];
            p0 += p[1];
            p0 += p[2];
            p0 += p[3];
            assert_eq!(out[j].to_bits(), p0.to_bits(), "row {j}");
        }
    }

    #[test]
    fn sum_lastdim_wide_row_uses_vector_lanes() {
        // one row of 19: vec_size=2 -> 8-lane partials, tail 3 scalars first
        let n = 19;
        let data: Vec<f32> = (0..n).map(|i| (i as f32) * 0.7 + 0.01).collect();
        let out = sum_lastdim(&data, 1, n);
        let mut lanes = [0.0f32; 8];
        for (i, l) in lanes.iter_mut().enumerate() {
            // partial[0] holds vec 0, partial[1] holds vec 1 (ilp block of 1
            // each), folded partial[0] += partial[1]
            *l = (0.0 + data[i]) + data[8 + i];
        }
        let mut acc = 0.0f32;
        for &x in &data[16..] {
            acc += x;
        }
        for l in lanes {
            acc += l;
        }
        assert_eq!(out[0].to_bits(), acc.to_bits());
    }
}
