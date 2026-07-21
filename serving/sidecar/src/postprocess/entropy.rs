//! Byte-exact port of `colorize/common/ops.py::compute_normalized_entropy`
//! as executed by torch on the production CPU host (x86-64, AVX2 dispatch):
//!
//! ```python
//! def compute_entropy(logits, num_classes):
//!     probs     = softmax(logits[:, :, :num_classes], dim=-1)
//!     log_probs = log_softmax(logits[:, :, :num_classes], dim=-1)
//!     return -(probs * log_probs).sum(dim=-1)
//!
//! def compute_normalized_entropy(logits, num_classes):
//!     return compute_entropy(...) / torch.log(tensor(num_classes, dtype=f32))
//! ```
//!
//! Exact op sequence replicated (see `torchcpu` / `sleef` for the layers
//! underneath):
//!   - the `[:, :, :num_classes]` slice is materialized contiguous by
//!     `_softmax`/`_log_softmax`, then the LASTDIM kernels run per row
//!     (`SoftMaxKernel.cpp::_vec_softmax_lastdim` / `_vec_log_softmax_lastdim`):
//!       softmax:      max = reduce_all(max); out = exp(x - max) [SLEEF u10];
//!                     sum = reduce_all(+); out *= (1/sum)  <- reciprocal
//!                     MULTIPLY, not division
//!       log_softmax:  max = reduce_all(max);
//!                     sum = map_reduce_all(exp(x - max), +);
//!                     logsum = SLEEF log u10 (the vectorized `x.log()` map);
//!                     out = x - max - logsum
//!   - `probs * log_probs` is a plain elementwise f32 mul;
//!     `.sum(dim=-1)` is the cascade sum (`torchcpu::sum_lastdim` — for
//!     num_classes < 8 that is scalar_inner_sum's per-row ilp4 `row_sum`);
//!     the leading `-` negates after the sum.
//!   - `torch.log(torch.tensor(nc))` runs through the unary log kernel,
//!     which on the production host (torch built with USE_MKL) is Intel
//!     MKL VML `vmsLn` — NOT correctly-rounded libm. Its value for
//!     ln(7) is 1 ulp above CR, and 13 of the first 1024 integer logs
//!     differ from CR, so `max_entropy` comes from `MKL_LN_BITS`, a table
//!     of `torch.log(torch.arange(1, 1025))` bits dumped from the
//!     production host (torch 2.6.0+cu126, x86-64 AVX2).
//!   - the final division is a plain elementwise f32 division (the 0-dim
//!     tensor divisor does NOT trigger div_true_kernel's cpu-scalar
//!     reciprocal-multiply fast path — that applies to Python-number
//!     operands only).
//!
//! Production runs torch 2.6.0+cu126 (the repo pins 2.4.1 for training;
//! the serving host's env is newer). Every op here was verified bitwise
//! against that host: probs / log_probs / products / row sums / norm /
//! conf all match on the full 236-row golden corpus.

use super::{sleef, torchcpu};

/// `F.softmax(x, dim=-1)` on a contiguous (rows, n) f32 buffer.
pub fn softmax_lastdim(data: &[f32], rows: usize, n: usize) -> Vec<f32> {
    assert_eq!(data.len(), rows * n);
    let mut out = vec![0.0f32; rows * n];
    for r in 0..rows {
        let x = &data[r * n..][..n];
        let o = &mut out[r * n..][..n];
        let max = torchcpu::reduce_all(torchcpu::vmax, x);
        for (oi, &xi) in o.iter_mut().zip(x) {
            *oi = sleef::expf_u10(xi - max);
        }
        let sum = torchcpu::reduce_all(torchcpu::vadd, o);
        let inv = 1.0 / sum; // tmp_sum = 1 / tmp_sum; out *= tmp_sum
        for oi in o.iter_mut() {
            *oi *= inv;
        }
    }
    out
}

/// `F.log_softmax(x, dim=-1)` on a contiguous (rows, n) f32 buffer.
pub fn log_softmax_lastdim(data: &[f32], rows: usize, n: usize) -> Vec<f32> {
    assert_eq!(data.len(), rows * n);
    let mut out = vec![0.0f32; rows * n];
    for r in 0..rows {
        let x = &data[r * n..][..n];
        let max = torchcpu::reduce_all(torchcpu::vmax, x);
        let sum = torchcpu::map_reduce_all(|v| sleef::expf_u10(v - max), torchcpu::vadd, x);
        let logsum = sleef::logf_u10(sum);
        for (oi, &xi) in out[r * n..][..n].iter_mut().zip(x) {
            *oi = xi - max - logsum;
        }
    }
    out
}

/// `ops.py::compute_normalized_entropy(logits, num_classes).squeeze(0)` for
/// logits of shape (1, rows, palette_dim) given as a contiguous buffer.
/// Requires `num_classes >= 1` and `num_classes <= palette_dim`.
pub fn compute_normalized_entropy(
    logits: &[f32],
    rows: usize,
    palette_dim: usize,
    num_classes: usize,
) -> Vec<f32> {
    assert_eq!(logits.len(), rows * palette_dim);
    assert!(
        (1..=palette_dim).contains(&num_classes),
        "num_classes {num_classes} out of range for palette dim {palette_dim}"
    );
    // logits[:, :, :num_classes].contiguous()
    let mut sliced = Vec::with_capacity(rows * num_classes);
    for r in 0..rows {
        sliced.extend_from_slice(&logits[r * palette_dim..][..num_classes]);
    }

    let probs = softmax_lastdim(&sliced, rows, num_classes);
    let log_probs = log_softmax_lastdim(&sliced, rows, num_classes);

    let prod: Vec<f32> = probs
        .iter()
        .zip(&log_probs)
        .map(|(&p, &lp)| p * lp)
        .collect();
    let sums = torchcpu::sum_lastdim(&prod, rows, num_classes);

    let max_entropy = max_entropy(num_classes);
    sums.iter().map(|&s| -s / max_entropy).collect()
}

/// `torch.log(torch.arange(1, 1025, dtype=torch.float32))` f32 bit patterns
/// from the production serving host (torch 2.6.0+cu126 built with MKL,
/// x86-64/AVX2 — the env that produced the postprocess goldens). Entry i is
/// ln(i + 1). MKL VML's vmsLn is not correctly rounded: 13 of these differ
/// from libm by 1 ulp (ln(7), the golden corpus' num_classes, among them),
/// so a portable libm call CANNOT reproduce production `max_entropy`.
const MKL_LN_BITS: [u32; 1024] = [
    0x00000000, 0x3f317218, 0x3f8c9f54, 0x3fb17218, 0x3fce0210, 0x3fe55860, 0x3ff91396, 0x40051592,
    0x400c9f54, 0x40135d8e, 0x4019771e, 0x401f08b6, 0x40242821, 0x4028e651, 0x402d50b2, 0x40317218,
    0x4035535e, 0x4038fbda, 0x403c71b0, 0x403fba14, 0x4042d975, 0x4045d3a4, 0x4048abf0, 0x404b653c,
    0x404e0210, 0x405084a7, 0x4052eefe, 0x405542d7, 0x405781c6, 0x4059ad38, 0x405bc672, 0x405dce9e,
    0x405fc6c8, 0x4061afe4, 0x40638ad3, 0x40655860, 0x40671947, 0x4068ce36, 0x406a77cb, 0x406c169a,
    0x406dab2a, 0x406f35fb, 0x4070b781, 0x4072302a, 0x4073a05c, 0x40750876, 0x407668d2, 0x4077c1c2,
    0x40791396, 0x407a5e96, 0x407ba308, 0x407ce12d, 0x407e1943, 0x407f4b84, 0x40803c13, 0x4080cfae,
    0x408160ad, 0x4081ef26, 0x40827b30, 0x408304df, 0x40838c47, 0x4084117c, 0x4084948f, 0x40851592,
    0x40859495, 0x408611a7, 0x40868cd8, 0x40870635, 0x40877dcd, 0x4087f3ac, 0x408867e0, 0x4088da73,
    0x40894b72, 0x4089bae7, 0x408a28dd, 0x408a955e, 0x408b0074, 0x408b6a29, 0x408bd284, 0x408c3990,
    0x408c9f54, 0x408d03d8, 0x408d6724, 0x408dc940, 0x408e2a33, 0x408e8a03, 0x408ee8b8, 0x408f4658,
    0x408fa2e9, 0x408ffe71, 0x409058f6, 0x4090b27e, 0x40910b0e, 0x409162ac, 0x4091b95c, 0x40920f24,
    0x40926408, 0x4092b80e, 0x40930b39, 0x40935d8e, 0x4093af11, 0x4093ffc7, 0x40944fb3, 0x40949eda,
    0x4094ed3e, 0x40953ae5, 0x409587d0, 0x4095d405, 0x40961f86, 0x40966a56, 0x4096b479, 0x4096fdf1,
    0x409746c3, 0x40978ef0, 0x4097d67c, 0x40981d69, 0x409863bb, 0x4098a973, 0x4098ee94, 0x40993322,
    0x4099771e, 0x4099ba8a, 0x4099fd6a, 0x409a3fbf, 0x409a818c, 0x409ac2d2, 0x409b0395, 0x409b43d5,
    0x409b8395, 0x409bc2d8, 0x409c019e, 0x409c3fea, 0x409c7dbd, 0x409cbb1b, 0x409cf803, 0x409d3478,
    0x409d707c, 0x409dac10, 0x409de736, 0x409e21ef, 0x409e5c3e, 0x409e9623, 0x409ecfa0, 0x409f08b6,
    0x409f4167, 0x409f79b5, 0x409fb1a0, 0x409fe92a, 0x40a02054, 0x40a05720, 0x40a08d8e, 0x40a0c3a1,
    0x40a0f959, 0x40a12eb7, 0x40a163bd, 0x40a1986c, 0x40a1ccc4, 0x40a200c7, 0x40a23477, 0x40a267d3,
    0x40a29add, 0x40a2cd97, 0x40a30000, 0x40a3321b, 0x40a363e8, 0x40a39567, 0x40a3c69b, 0x40a3f783,
    0x40a42821, 0x40a45876, 0x40a48882, 0x40a4b846, 0x40a4e7c4, 0x40a516fb, 0x40a545ed, 0x40a5749b,
    0x40a5a305, 0x40a5d12c, 0x40a5ff10, 0x40a62cb4, 0x40a65a16, 0x40a68739, 0x40a6b41c, 0x40a6e0c1,
    0x40a70d28, 0x40a73951, 0x40a7653e, 0x40a790ef, 0x40a7bc64, 0x40a7e79f, 0x40a812a0, 0x40a83d67,
    0x40a867f5, 0x40a8924b, 0x40a8bc6a, 0x40a8e651, 0x40a91001, 0x40a9397c, 0x40a962c1, 0x40a98bd1,
    0x40a9b4ac, 0x40a9dd54, 0x40aa05c9, 0x40aa2e0a, 0x40aa5619, 0x40aa7df6, 0x40aaa5a2, 0x40aacd1d,
    0x40aaf467, 0x40ab1b81, 0x40ab426c, 0x40ab6928, 0x40ab8fb5, 0x40abb613, 0x40abdc44, 0x40ac0248,
    0x40ac281e, 0x40ac4dc9, 0x40ac7347, 0x40ac9899, 0x40acbdc0, 0x40ace2bc, 0x40ad078d, 0x40ad2c34,
    0x40ad50b2, 0x40ad7506, 0x40ad9931, 0x40adbd33, 0x40ade10d, 0x40ae04bf, 0x40ae2849, 0x40ae4bac,
    0x40ae6ee8, 0x40ae91fe, 0x40aeb4ed, 0x40aed7b6, 0x40aefa59, 0x40af1cd7, 0x40af3f30, 0x40af6165,
    0x40af8375, 0x40afa561, 0x40afc729, 0x40afe8cd, 0x40b00a4f, 0x40b02bad, 0x40b04ce9, 0x40b06e02,
    0x40b08ef9, 0x40b0afcf, 0x40b0d083, 0x40b0f115, 0x40b11187, 0x40b131d8, 0x40b15208, 0x40b17218,
    0x40b19208, 0x40b1b1d8, 0x40b1d189, 0x40b1f11b, 0x40b2108d, 0x40b22fe1, 0x40b24f16, 0x40b26e2d,
    0x40b28d26, 0x40b2ac00, 0x40b2cabe, 0x40b2e95e, 0x40b307e0, 0x40b32646, 0x40b3448f, 0x40b362bb,
    0x40b380cb, 0x40b39ebf, 0x40b3bc97, 0x40b3da53, 0x40b3f7f4, 0x40b41579, 0x40b432e3, 0x40b45032,
    0x40b46d67, 0x40b48a81, 0x40b4a780, 0x40b4c466, 0x40b4e131, 0x40b4fde3, 0x40b51a7a, 0x40b536f9,
    0x40b5535e, 0x40b56faa, 0x40b58bdd, 0x40b5a7f8, 0x40b5c3f9, 0x40b5dfe3, 0x40b5fbb4, 0x40b6176d,
    0x40b6330e, 0x40b64e97, 0x40b66a09, 0x40b68563, 0x40b6a0a6, 0x40b6bbd1, 0x40b6d6e6, 0x40b6f1e4,
    0x40b70ccb, 0x40b7279c, 0x40b74256, 0x40b75cfa, 0x40b77788, 0x40b79200, 0x40b7ac62, 0x40b7c6af,
    0x40b7e0e6, 0x40b7fb07, 0x40b81513, 0x40b82f0a, 0x40b848ec, 0x40b862ba, 0x40b87c72, 0x40b89616,
    0x40b8afa5, 0x40b8c920, 0x40b8e287, 0x40b8fbda, 0x40b91519, 0x40b92e43, 0x40b9475b, 0x40b9605e,
    0x40b9794e, 0x40b9922b, 0x40b9aaf4, 0x40b9c3aa, 0x40b9dc4e, 0x40b9f4de, 0x40ba0d5b, 0x40ba25c6,
    0x40ba3e1e, 0x40ba5664, 0x40ba6e98, 0x40ba86b9, 0x40ba9ec8, 0x40bab6c5, 0x40baceb0, 0x40bae689,
    0x40bafe51, 0x40bb1607, 0x40bb2dab, 0x40bb453e, 0x40bb5cc0, 0x40bb7430, 0x40bb8b90, 0x40bba2de,
    0x40bbba1b, 0x40bbd148, 0x40bbe864, 0x40bbff6f, 0x40bc1669, 0x40bc2d54, 0x40bc442d, 0x40bc5af7,
    0x40bc71b0, 0x40bc8859, 0x40bc9ef3, 0x40bcb57c, 0x40bccbf6, 0x40bce25f, 0x40bcf8b9, 0x40bd0f04,
    0x40bd253f, 0x40bd3b6b, 0x40bd5187, 0x40bd6794, 0x40bd7d92, 0x40bd9381, 0x40bda961, 0x40bdbf32,
    0x40bdd4f4, 0x40bdeaa7, 0x40be004c, 0x40be15e2, 0x40be2b6a, 0x40be40e3, 0x40be564d, 0x40be6baa,
    0x40be80f8, 0x40be9638, 0x40beab6a, 0x40bec08e, 0x40bed5a4, 0x40beeaad, 0x40beffa7, 0x40bf1494,
    0x40bf2973, 0x40bf3e44, 0x40bf5308, 0x40bf67bf, 0x40bf7c68, 0x40bf9104, 0x40bfa592, 0x40bfba14,
    0x40bfce88, 0x40bfe2f0, 0x40bff74a, 0x40c00b97, 0x40c01fd8, 0x40c0340c, 0x40c04833, 0x40c05c4d,
    0x40c0705b, 0x40c0845c, 0x40c09851, 0x40c0ac39, 0x40c0c015, 0x40c0d3e5, 0x40c0e7a8, 0x40c0fb60,
    0x40c10f0b, 0x40c122aa, 0x40c1363d, 0x40c149c4, 0x40c15d40, 0x40c170af, 0x40c18413, 0x40c1976b,
    0x40c1aab7, 0x40c1bdf8, 0x40c1d12d, 0x40c1e456, 0x40c1f774, 0x40c20a87, 0x40c21d8f, 0x40c2308b,
    0x40c2437c, 0x40c25662, 0x40c2693c, 0x40c27c0c, 0x40c28ed0, 0x40c2a18a, 0x40c2b438, 0x40c2c6dc,
    0x40c2d975, 0x40c2ec03, 0x40c2fe86, 0x40c310ff, 0x40c3236d, 0x40c335d0, 0x40c34829, 0x40c35a77,
    0x40c36cbb, 0x40c37ef5, 0x40c39124, 0x40c3a349, 0x40c3b563, 0x40c3c774, 0x40c3d97a, 0x40c3eb76,
    0x40c3fd68, 0x40c40f50, 0x40c4212e, 0x40c43302, 0x40c444cc, 0x40c4568c, 0x40c46843, 0x40c479ef,
    0x40c48b92, 0x40c49d2b, 0x40c4aebb, 0x40c4c041, 0x40c4d1bd, 0x40c4e330, 0x40c4f499, 0x40c505f9,
    0x40c5174f, 0x40c5289c, 0x40c539e0, 0x40c54b1a, 0x40c55c4c, 0x40c56d73, 0x40c57e92, 0x40c58fa8,
    0x40c5a0b4, 0x40c5b1b8, 0x40c5c2b2, 0x40c5d3a4, 0x40c5e48c, 0x40c5f56c, 0x40c60642, 0x40c61710,
    0x40c627d5, 0x40c63892, 0x40c64945, 0x40c659f0, 0x40c66a92, 0x40c67b2c, 0x40c68bbd, 0x40c69c45,
    0x40c6acc5, 0x40c6bd3c, 0x40c6cdab, 0x40c6de12, 0x40c6ee70, 0x40c6fec6, 0x40c70f13, 0x40c71f58,
    0x40c72f95, 0x40c73fca, 0x40c74ff6, 0x40c7601b, 0x40c77037, 0x40c7804b, 0x40c79057, 0x40c7a05b,
    0x40c7b057, 0x40c7c04b, 0x40c7d037, 0x40c7e01b, 0x40c7eff8, 0x40c7ffcc, 0x40c80f99, 0x40c81f5e,
    0x40c82f1b, 0x40c83ed0, 0x40c84e7e, 0x40c85e24, 0x40c86dc2, 0x40c87d59, 0x40c88ce8, 0x40c89c70,
    0x40c8abf0, 0x40c8bb69, 0x40c8cada, 0x40c8da43, 0x40c8e9a6, 0x40c8f901, 0x40c90854, 0x40c917a1,
    0x40c926e5, 0x40c93623, 0x40c9455a, 0x40c95489, 0x40c963b1, 0x40c972d2, 0x40c981eb, 0x40c990fe,
    0x40c9a00a, 0x40c9af0e, 0x40c9be0b, 0x40c9cd02, 0x40c9dbf1, 0x40c9eada, 0x40c9f9bb, 0x40ca0896,
    0x40ca176a, 0x40ca2637, 0x40ca34fd, 0x40ca43bc, 0x40ca5274, 0x40ca6126, 0x40ca6fd1, 0x40ca7e75,
    0x40ca8d13, 0x40ca9baa, 0x40caaa3a, 0x40cab8c4, 0x40cac747, 0x40cad5c3, 0x40cae439, 0x40caf2a9,
    0x40cb0112, 0x40cb0f74, 0x40cb1dd0, 0x40cb2c26, 0x40cb3a75, 0x40cb48bd, 0x40cb5700, 0x40cb653c,
    0x40cb7372, 0x40cb81a1, 0x40cb8fca, 0x40cb9ded, 0x40cbac0a, 0x40cbba20, 0x40cbc830, 0x40cbd63b,
    0x40cbe43f, 0x40cbf23c, 0x40cc0034, 0x40cc0e26, 0x40cc1c11, 0x40cc29f7, 0x40cc37d6, 0x40cc45b0,
    0x40cc5383, 0x40cc6151, 0x40cc6f18, 0x40cc7cda, 0x40cc8a96, 0x40cc984c, 0x40cca5fc, 0x40ccb3a6,
    0x40ccc14a, 0x40cccee9, 0x40ccdc81, 0x40ccea14, 0x40ccf7a2, 0x40cd0529, 0x40cd12ab, 0x40cd2027,
    0x40cd2d9e, 0x40cd3b0e, 0x40cd4879, 0x40cd55df, 0x40cd633f, 0x40cd7099, 0x40cd7dee, 0x40cd8b3d,
    0x40cd9887, 0x40cda5cb, 0x40cdb30a, 0x40cdc043, 0x40cdcd77, 0x40cddaa5, 0x40cde7ce, 0x40cdf4f2,
    0x40ce0210, 0x40ce0f29, 0x40ce1c3c, 0x40ce294a, 0x40ce3653, 0x40ce4356, 0x40ce5054, 0x40ce5d4d,
    0x40ce6a41, 0x40ce772f, 0x40ce8419, 0x40ce90fd, 0x40ce9ddb, 0x40ceaab5, 0x40ceb78a, 0x40cec459,
    0x40ced123, 0x40cedde8, 0x40ceeaa8, 0x40cef763, 0x40cf0419, 0x40cf10ca, 0x40cf1d76, 0x40cf2a1d,
    0x40cf36bf, 0x40cf435c, 0x40cf4ff3, 0x40cf5c86, 0x40cf6914, 0x40cf759e, 0x40cf8222, 0x40cf8ea1,
    0x40cf9b1c, 0x40cfa791, 0x40cfb402, 0x40cfc06e, 0x40cfccd5, 0x40cfd937, 0x40cfe595, 0x40cff1ed,
    0x40cffe41, 0x40d00a91, 0x40d016db, 0x40d02321, 0x40d02f62, 0x40d03b9e, 0x40d047d6, 0x40d05409,
    0x40d06038, 0x40d06c62, 0x40d07887, 0x40d084a7, 0x40d090c3, 0x40d09cdb, 0x40d0a8ee, 0x40d0b4fc,
    0x40d0c106, 0x40d0cd0b, 0x40d0d90c, 0x40d0e508, 0x40d0f100, 0x40d0fcf3, 0x40d108e2, 0x40d114cc,
    0x40d120b2, 0x40d12c94, 0x40d13871, 0x40d1444a, 0x40d1501e, 0x40d15bee, 0x40d167ba, 0x40d17381,
    0x40d17f44, 0x40d18b03, 0x40d196bd, 0x40d1a273, 0x40d1ae25, 0x40d1b9d3, 0x40d1c57c, 0x40d1d121,
    0x40d1dcc2, 0x40d1e85e, 0x40d1f3f7, 0x40d1ff8b, 0x40d20b1b, 0x40d216a7, 0x40d2222e, 0x40d22db2,
    0x40d23931, 0x40d244ac, 0x40d25023, 0x40d25b96, 0x40d26705, 0x40d27270, 0x40d27dd7, 0x40d2893a,
    0x40d29498, 0x40d29ff3, 0x40d2ab4a, 0x40d2b69c, 0x40d2c1eb, 0x40d2cd36, 0x40d2d87c, 0x40d2e3bf,
    0x40d2eefe, 0x40d2fa38, 0x40d3056f, 0x40d310a2, 0x40d31bd1, 0x40d326fc, 0x40d33224, 0x40d33d47,
    0x40d34866, 0x40d35382, 0x40d35e9a, 0x40d369ae, 0x40d374be, 0x40d37fca, 0x40d38ad2, 0x40d395d7,
    0x40d3a0d8, 0x40d3abd5, 0x40d3b6ce, 0x40d3c1c4, 0x40d3ccb6, 0x40d3d7a4, 0x40d3e28e, 0x40d3ed75,
    0x40d3f858, 0x40d40337, 0x40d40e12, 0x40d418ea, 0x40d423be, 0x40d42e8f, 0x40d4395c, 0x40d44425,
    0x40d44eeb, 0x40d459ad, 0x40d4646b, 0x40d46f26, 0x40d479dd, 0x40d48490, 0x40d48f40, 0x40d499ed,
    0x40d4a496, 0x40d4af3b, 0x40d4b9dd, 0x40d4c47b, 0x40d4cf16, 0x40d4d9ad, 0x40d4e441, 0x40d4eed1,
    0x40d4f95e, 0x40d503e7, 0x40d50e6d, 0x40d518f0, 0x40d5236e, 0x40d52dea, 0x40d53862, 0x40d542d7,
    0x40d54d48, 0x40d557b6, 0x40d56220, 0x40d56c87, 0x40d576eb, 0x40d5814b, 0x40d58ba8, 0x40d59602,
    0x40d5a058, 0x40d5aaab, 0x40d5b4fa, 0x40d5bf47, 0x40d5c990, 0x40d5d3d5, 0x40d5de18, 0x40d5e857,
    0x40d5f293, 0x40d5fccb, 0x40d60700, 0x40d61132, 0x40d61b61, 0x40d6258d, 0x40d62fb5, 0x40d639da,
    0x40d643fc, 0x40d64e1b, 0x40d65836, 0x40d6624f, 0x40d66c64, 0x40d67676, 0x40d68084, 0x40d68a90,
    0x40d69498, 0x40d69e9e, 0x40d6a8a0, 0x40d6b29f, 0x40d6bc9b, 0x40d6c694, 0x40d6d08a, 0x40d6da7c,
    0x40d6e46c, 0x40d6ee58, 0x40d6f842, 0x40d70228, 0x40d70c0b, 0x40d715eb, 0x40d71fc9, 0x40d729a3,
    0x40d7337a, 0x40d73d4e, 0x40d7471f, 0x40d750ed, 0x40d75ab8, 0x40d76480, 0x40d76e45, 0x40d77807,
    0x40d781c6, 0x40d78b83, 0x40d7953c, 0x40d79ef2, 0x40d7a8a5, 0x40d7b256, 0x40d7bc03, 0x40d7c5ae,
    0x40d7cf55, 0x40d7d8fa, 0x40d7e29c, 0x40d7ec3b, 0x40d7f5d7, 0x40d7ff70, 0x40d80906, 0x40d81299,
    0x40d81c2a, 0x40d825b8, 0x40d82f42, 0x40d838ca, 0x40d8424f, 0x40d84bd2, 0x40d85551, 0x40d85ece,
    0x40d86848, 0x40d871bf, 0x40d87b33, 0x40d884a4, 0x40d88e13, 0x40d8977f, 0x40d8a0e8, 0x40d8aa4f,
    0x40d8b3b2, 0x40d8bd13, 0x40d8c671, 0x40d8cfcd, 0x40d8d925, 0x40d8e27b, 0x40d8ebce, 0x40d8f51f,
    0x40d8fe6d, 0x40d907b8, 0x40d91100, 0x40d91a46, 0x40d92389, 0x40d92cc9, 0x40d93607, 0x40d93f42,
    0x40d9487a, 0x40d951b0, 0x40d95ae3, 0x40d96413, 0x40d96d41, 0x40d9766c, 0x40d97f94, 0x40d988ba,
    0x40d991de, 0x40d99afe, 0x40d9a41c, 0x40d9ad38, 0x40d9b651, 0x40d9bf67, 0x40d9c87b, 0x40d9d18c,
    0x40d9da9a, 0x40d9e3a6, 0x40d9ecb0, 0x40d9f5b7, 0x40d9febb, 0x40da07bd, 0x40da10bc, 0x40da19b9,
    0x40da22b3, 0x40da2bab, 0x40da34a0, 0x40da3d93, 0x40da4683, 0x40da4f71, 0x40da585c, 0x40da6145,
    0x40da6a2b, 0x40da730f, 0x40da7bf0, 0x40da84cf, 0x40da8dac, 0x40da9686, 0x40da9f5d, 0x40daa832,
    0x40dab105, 0x40dab9d5, 0x40dac2a3, 0x40dacb6e, 0x40dad437, 0x40dadcfe, 0x40dae5c2, 0x40daee84,
    0x40daf743, 0x40db0000, 0x40db08ba, 0x40db1173, 0x40db1a28, 0x40db22dc, 0x40db2b8d, 0x40db343c,
    0x40db3ce8, 0x40db4592, 0x40db4e3a, 0x40db56df, 0x40db5f82, 0x40db6823, 0x40db70c1, 0x40db795d,
    0x40db81f7, 0x40db8a8f, 0x40db9324, 0x40db9bb6, 0x40dba447, 0x40dbacd5, 0x40dbb561, 0x40dbbdeb,
    0x40dbc672, 0x40dbcef7, 0x40dbd77a, 0x40dbdffb, 0x40dbe879, 0x40dbf0f5, 0x40dbf96f, 0x40dc01e7,
    0x40dc0a5c, 0x40dc12cf, 0x40dc1b40, 0x40dc23af, 0x40dc2c1b, 0x40dc3485, 0x40dc3cee, 0x40dc4553,
    0x40dc4db7, 0x40dc5618, 0x40dc5e78, 0x40dc66d5, 0x40dc6f30, 0x40dc7788, 0x40dc7fdf, 0x40dc8833,
    0x40dc9085, 0x40dc98d5, 0x40dca123, 0x40dca96f, 0x40dcb1b8, 0x40dcba00, 0x40dcc245, 0x40dcca88,
    0x40dcd2c9, 0x40dcdb08, 0x40dce345, 0x40dceb7f, 0x40dcf3b8, 0x40dcfbee, 0x40dd0423, 0x40dd0c55,
    0x40dd1485, 0x40dd1cb3, 0x40dd24df, 0x40dd2d09, 0x40dd3530, 0x40dd3d56, 0x40dd457a, 0x40dd4d9b,
    0x40dd55bb, 0x40dd5dd8, 0x40dd65f4, 0x40dd6e0d, 0x40dd7624, 0x40dd7e39, 0x40dd864c, 0x40dd8e5e,
    0x40dd966d, 0x40dd9e7a, 0x40dda685, 0x40ddae8e, 0x40ddb695, 0x40ddbe9a, 0x40ddc69d, 0x40ddce9e,
];

/// `torch.log(torch.tensor(num_classes, dtype=torch.float32))` as production
/// computes it. num_classes is a unique-count of palette color ids, so the
/// table covers every reachable value; anything larger is a config beyond
/// what production ever served (panic rather than silently drift).
fn max_entropy(num_classes: usize) -> f32 {
    assert!(
        (1..=MKL_LN_BITS.len()).contains(&num_classes),
        "num_classes {num_classes} outside the production MKL log table"
    );
    f32::from_bits(MKL_LN_BITS[num_classes - 1])
}


// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniform_two_class_row_is_exactly_max_entropy() {
        // logits [0, 0]: probs = [0.5, 0.5] exactly (exp(0)=1, sum=2,
        // 1/2 exact), log_probs = -log(2); entropy = log(2); normalized = 1.
        let norm = compute_normalized_entropy(&[0.0, 0.0], 1, 2, 2);
        assert_eq!(norm[0].to_bits(), 1.0f32.to_bits());
    }

    #[test]
    fn one_hot_like_row_has_near_zero_entropy() {
        let norm = compute_normalized_entropy(&[50.0, 0.0, 0.0], 1, 3, 3);
        assert!(norm[0] >= 0.0 && norm[0] < 1e-6, "norm = {}", norm[0]);
    }

    #[test]
    fn slice_ignores_out_of_palette_logits() {
        // identical rows, junk beyond num_classes must not matter
        let a = compute_normalized_entropy(&[1.0, 2.0, 3.0, 99.0], 1, 4, 3);
        let b = compute_normalized_entropy(&[1.0, 2.0, 3.0, -99.0], 1, 4, 3);
        assert_eq!(a[0].to_bits(), b[0].to_bits());
    }

    #[test]
    fn matches_f64_reference_within_tolerance() {
        // sanity envelope (bit-exactness is proven against production
        // goldens by verify_postprocess)
        let logits = [1.25f32, -0.5, 3.0, 0.0, 2.0, -1.0, 0.75];
        let n = logits.len();
        let norm = compute_normalized_entropy(&logits, 1, n, n);
        let max = logits.iter().cloned().fold(f64::NEG_INFINITY, |a, b| a.max(b as f64));
        let exps: Vec<f64> = logits.iter().map(|&x| ((x as f64) - max).exp()).collect();
        let sum: f64 = exps.iter().sum();
        let entropy: f64 = -exps
            .iter()
            .map(|&e| {
                let p = e / sum;
                p * p.ln()
            })
            .sum::<f64>();
        let want = entropy / (n as f64).ln();
        assert!(
            ((norm[0] as f64) - want).abs() < 1e-6,
            "norm {} vs f64 ref {}",
            norm[0],
            want
        );
    }
}
