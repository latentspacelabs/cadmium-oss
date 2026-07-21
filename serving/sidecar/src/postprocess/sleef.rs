//! Scalar ports of the exact SLEEF routines behind torch's AVX2
//! `Vectorized<float>::exp()` / `::log()` — `Sleef_expf8_u10` (`xexpf`) and
//! `Sleef_logf8_u10` (`xlogf_u1`) from the SLEEF commit pinned by the
//! pytorch v2.4.1 submodule (shibatch/sleef@60e76d2, `src/libm/sleefsimdsp.c`
//! + `src/common/df.h`, AVX2 target => `ENABLE_FMA_SP`). The algorithms are
//! unchanged through the production host's torch 2.6.0, whose softmax /
//! log-softmax outputs these ports reproduce bit-for-bit on the golden
//! corpus.
//!
//! Both functions are pure lane-wise polynomial evaluations, so the scalar
//! port is bit-identical to the production 8-lane AVX2 evaluation as long as
//! every operation keeps its exact order and fusedness:
//!   - `vmla`/`vfma`/`vfmapn`/`vfmanp` are single-rounding FMAs
//!     (`_mm256_fmadd_ps` etc.) -> `f32::mul_add`.
//!   - `vrint` is `_mm256_cvtps_epi32` -> round half to even.
//!   - The double-float (`vfloat2`) helpers in `df.h` use the
//!     `ENABLE_FMA_SP` variants.
//!
//! Constants are written as the same C literals (f64 literals narrowed to
//! f32 where the C source passes a double constant to `vcast_vf_f(float)`).

/// `misc.h`: `R_LN2f` (float literal in C).
const R_LN2_F: f32 = 1.442695040888963407359924681001892137426645954152985934135449406931;
/// `misc.h`: `L2Uf` = 0.693145751953125f (exact in binary).
const L2U_F: f32 = 0.693145751953125;
/// `misc.h`: `L2Lf`.
const L2L_F: f32 = 1.428606765330187045e-06;

/// `vpow2i_vf_vi2(q)`: reinterpret `(q + 0x7f) << 23` as a float. Wrapping
/// integer ops, exactly as the SIMD registers behave.
fn pow2i(q: i32) -> f32 {
    f32::from_bits((q.wrapping_add(0x7f).wrapping_shl(23)) as u32)
}

/// `vldexp2_vf_vf_vi2(d, e)` = d * 2^(e>>1) * 2^(e - (e>>1)), arithmetic
/// shift (`vsra`).
fn ldexp2f(d: f32, e: i32) -> f32 {
    d * pow2i(e >> 1) * pow2i(e - (e >> 1))
}

/// `vldexp3_vf_vf_vi2(d, q)`: add q directly to the exponent bits.
fn ldexp3f(d: f32, q: i32) -> f32 {
    f32::from_bits((d.to_bits() as i32).wrapping_add(q.wrapping_shl(23)) as u32)
}

/// `vilogb2k_vi2_vf(d)`: raw biased exponent minus 0x7f (no subnormal or
/// special-value handling — the callers pre-scale).
fn ilogb2k(d: f32) -> i32 {
    (((d.to_bits() >> 23) & 0xff) as i32) - 0x7f
}

/// `xexpf` (SLEEF expf, 1.0-ULP variant) — what `Vectorized<float>::exp()`
/// computes per lane on the AVX2 (FMA) dispatch.
pub fn expf_u10(d: f32) -> f32 {
    // vrint_vi2_vf = _mm256_cvtps_epi32: round half to even
    let q = (d * R_LN2_F).round_ties_even() as i32;
    let qf = q as f32; // vcast_vf_vi2 (exact for these magnitudes)

    // Cody-Waite reduction with fused multiply-adds (vmla == vfma here)
    let mut s = f32::mul_add(qf, -L2U_F, d);
    s = f32::mul_add(qf, -L2L_F, s);

    // polynomial (C double literals narrowed to f32 by vcast_vf_f)
    let mut u = 0.000198527617612853646278381f64 as f32;
    u = f32::mul_add(u, s, 0.00139304355252534151077271f64 as f32);
    u = f32::mul_add(u, s, 0.00833336077630519866943359f64 as f32);
    u = f32::mul_add(u, s, 0.0416664853692054748535156f64 as f32);
    u = f32::mul_add(u, s, 0.166666671633720397949219f64 as f32);
    u = f32::mul_add(u, s, 0.5);

    u = 1.0 + f32::mul_add(s * s, u, s);
    u = ldexp2f(u, q);

    // vandnot(d < -104, u): underflow clamps to +0.0 (bits cleared)
    if d < -104.0 {
        u = 0.0;
    }
    // vsel(100 < d, +inf, u)
    if 100.0 < d {
        u = f32::INFINITY;
    }
    u
}

// ---------------------------------------------------------------------------
// double-float helpers (`df.h`, ENABLE_FMA_SP variants)

type F2 = (f32, f32);

/// `dfadd2_vf2_vf_vf` (no |x| >= |y| precondition).
fn dfadd2_f_f(x: f32, y: f32) -> F2 {
    let s = x + y;
    let v = s - x;
    (s, (x - (s - v)) + (y - v))
}

/// `dfadd_vf2_vf2_vf2` (|x| >= |y|): lo = vadd_vf_4vf(x.x - s, y.x, x.y, y.y).
fn dfadd_f2_f2(x: F2, y: F2) -> F2 {
    let s = x.0 + y.0;
    (s, (((x.0 - s) + y.0) + x.1) + y.1)
}

/// `dfadd_vf2_vf2_vf` (|x| >= |y|): lo = vadd_vf_3vf(x.x - s, y, x.y).
fn dfadd_f2_f(x: F2, y: f32) -> F2 {
    let s = x.0 + y;
    (s, ((x.0 - s) + y) + x.1)
}

/// `dfscale_vf2_vf2_vf`.
fn dfscale(d: F2, s: f32) -> F2 {
    (d.0 * s, d.1 * s)
}

/// `dfmul_vf2_vf2_vf` (FMA): lo = vfma(x.y, y, vfmapn(x.x, y, s)).
fn dfmul_f2_f(x: F2, y: f32) -> F2 {
    let s = x.0 * y;
    (s, f32::mul_add(x.1, y, f32::mul_add(x.0, y, -s)))
}

/// `dfdiv_vf2_vf2_vf2` (FMA): vfmapn(a,b,c) = a*b - c, vfmanp(a,b,c) = c - a*b.
fn dfdiv_f2_f2(n: F2, d: F2) -> F2 {
    let t = 1.0 / d.0; // vrec = _mm256_div_ps(1, x)
    let s = n.0 * t;
    let u = f32::mul_add(t, n.0, -s);
    let v = f32::mul_add(-d.1, t, f32::mul_add(-d.0, t, 1.0));
    (s, f32::mul_add(s, v, f32::mul_add(n.1, t, u)))
}

/// `xlogf_u1` (SLEEF logf, 1.0-ULP variant) — what `Vectorized<float>::log()`
/// computes per lane on the AVX2 (FMA, non-AVX512) dispatch.
pub fn logf_u10(d0: f32) -> f32 {
    // subnormal pre-scale by 2^64
    let o = d0 < f32::MIN_POSITIVE; // SLEEF_FLT_MIN = 0x1p-126
    let mut d = d0;
    if o {
        d *= ((1u64 << 32) as f32) * ((1u64 << 32) as f32);
    }
    let mut e = ilogb2k(d * (1.0 / 0.75));
    let m = ldexp3f(d, e.wrapping_neg());
    if o {
        e -= 64;
    }

    // s = df(ln2_hi, ln2_lo) * e
    let mut s = dfmul_f2_f(
        (0.69314718246459960938, -1.904654323148236017e-09),
        e as f32,
    );

    // x = (m - 1) / (m + 1) in double-float
    let x = dfdiv_f2_f2(dfadd2_f_f(-1.0, m), dfadd2_f_f(1.0, m));
    let x2 = x.0 * x.0;

    let mut t = 0.3027294874f32;
    t = f32::mul_add(t, x2, 0.3996108174);
    t = f32::mul_add(t, x2, 0.6666694880);

    s = dfadd_f2_f2(s, dfscale(x, 2.0));
    s = dfadd_f2_f(s, (x2 * x.0) * t);

    let mut r = s.0 + s.1;

    // special-case selects, in source order, on the (possibly pre-scaled) d
    if d == f32::INFINITY {
        r = f32::INFINITY;
    }
    if d < 0.0 || d.is_nan() {
        r = f32::NAN;
    }
    if d == 0.0 {
        r = f32::NEG_INFINITY;
    }
    r
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expf_exact_at_zero_and_clamps() {
        assert_eq!(expf_u10(0.0).to_bits(), 1.0f32.to_bits());
        assert_eq!(expf_u10(-200.0), 0.0);
        assert!(expf_u10(-200.0).is_sign_positive()); // bits cleared, +0.0
        assert_eq!(expf_u10(101.0), f32::INFINITY);
    }

    #[test]
    fn expf_within_1ulp_of_f64_reference() {
        // sweep the range softmax feeds it (x - max in [-30, 0])
        let mut x = -30.0f32;
        while x <= 0.0 {
            let got = expf_u10(x) as f64;
            let want = (x as f64).exp();
            let ulp = (want - got).abs() / f32::EPSILON as f64 / want;
            assert!(ulp < 1.5, "expf({x}) = {got}, want ~{want}");
            x += 0.0137;
        }
    }

    #[test]
    fn logf_matches_correctly_rounded_on_simple_points() {
        // ln(2) f32 CR = 0x3F317218; SLEEF u10 agrees on these anchors
        assert_eq!(logf_u10(1.0).to_bits(), 0.0f32.to_bits());
        assert_eq!(logf_u10(2.0).to_bits(), std::f32::consts::LN_2.to_bits());
        assert_eq!(logf_u10(0.0), f32::NEG_INFINITY);
        assert!(logf_u10(-1.0).is_nan());
        assert_eq!(logf_u10(f32::INFINITY), f32::INFINITY);
    }

    #[test]
    fn logf_within_1ulp_of_f64_reference() {
        // softmax denominators live in [1, num_classes]
        let mut x = 1.0f32;
        while x <= 600.0 {
            let got = logf_u10(x) as f64;
            let want = (x as f64).ln();
            if want != 0.0 {
                let ulp = (want - got).abs() / (f32::EPSILON as f64 * want.abs().max(1.0));
                assert!(ulp < 1.5, "logf({x}) = {got}, want ~{want}");
            }
            x += 0.371;
        }
    }

    #[test]
    fn logf_handles_subnormals_via_prescale() {
        let sub = f32::from_bits(1); // smallest positive subnormal
        let got = logf_u10(sub) as f64;
        let want = (sub as f64).ln(); // ~ -103.28
        assert!((got - want).abs() < 1e-4, "log(subnormal) = {got}, want {want}");
    }
}
