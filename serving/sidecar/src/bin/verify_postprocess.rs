//! Golden verification harness for the AnT v2 postprocess port
//! (`src/postprocess/`).
//!
//! Usage: cargo run --release --bin verify_postprocess -- <scratch_root>
//!
//! <scratch_root> must contain the four golden trees the stages consume:
//!   postprocess_goldens/pair_f<ref>_f<tgt>/  (serving/tools/dump_postprocess_goldens.py)
//!   robot_feeds/pair_f<ref>_f<tgt>.npz       (production ref_logits/ref_ids)
//!   tokenizer_goldens/pair_.../01_color_list.json (ref compute_color_list)
//!   segment_goldens/f<NNN>/08_final.npy      (trapped-ball label maps)
//!
//! For every pair the harness rebuilds the postprocess inputs exactly as
//! production assembled them — palette from the ref color list, seg maps
//! through the /segment u8 PNG-roundtrip cast — runs the Rust postprocess,
//! and compares per stage:
//!
//!   ids        bundle ref_ids vs golden in_ids (input identity) + our
//!              clamp vs golden clamped_ids
//!   colors     target_colors_rgba vs 02_colors.json
//!   entropy    num_classes + norm_entropy + entropy_conf_scores vs
//!              03_entropy.npz (f32 bitwise)
//!   dense      color_ids_to_dense_colors vs 06_dense_colors.npy
//!   ref_rend   decoded 04_ref_render.png RGBA pixels
//!   tgt_rend   decoded 05_target_render.png RGBA pixels
//!   meta       n_tgt / palette_len / num_classes / render sizes
//!
//! Prints a per-pair per-stage PASS/FAIL matrix with first-mismatch details
//! and exits nonzero on any failure.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use cadmium_sidecar::goldens::{load_npy_i32, load_npy_i64, load_rgba_png, parse_npy_f32, parse_npy_i64, read_npz};
use cadmium_sidecar::imageprep::Rgba;
use cadmium_sidecar::postprocess::{postprocess, seg_from_labels, PostprocessOutput};
use cadmium_sidecar::segment::Map32;
use cadmium_sidecar::tokenize::palette::palette_from_color_list;

const STAGE_NAMES: [&str; 7] = [
    "ids", "colors", "entropy", "dense", "ref_rend", "tgt_rend", "meta",
];
const N_STAGES: usize = STAGE_NAMES.len();

fn main() -> ExitCode {
    let root = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("usage: verify_postprocess <scratch_root>");
            return ExitCode::from(2);
        }
    };
    let goldens_root = root.join("postprocess_goldens");

    let mut pairs: Vec<PathBuf> = std::fs::read_dir(&goldens_root)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", goldens_root.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("meta.json").is_file())
        .collect();
    pairs.sort();
    if pairs.is_empty() {
        eprintln!("no pair directories under {}", goldens_root.display());
        return ExitCode::from(2);
    }

    let mut matrix: Vec<(String, [bool; N_STAGES], f64)> = Vec::new();
    let mut all_pass = true;
    for dir in &pairs {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let (results, secs) = verify_pair(&root, dir);
        all_pass &= results.iter().all(|&r| r);
        matrix.push((name, results, secs));
    }

    println!();
    print!("{:14}", "pair");
    for s in STAGE_NAMES {
        print!(" {:>8}", s);
    }
    println!(" {:>9}", "time");
    for (name, results, secs) in &matrix {
        print!("{:14}", name);
        for r in results {
            print!(" {:>8}", if *r { "PASS" } else { "FAIL" });
        }
        println!(" {:>8.3}s", secs);
    }
    println!();
    if all_pass {
        println!("all {} pairs x {} stages byte-exact", matrix.len(), N_STAGES);
        ExitCode::SUCCESS
    } else {
        println!("MISMATCHES FOUND");
        ExitCode::FAILURE
    }
}

// ---------------------------------------------------------------------------
// per-pair verification

fn verify_pair(root: &Path, dir: &Path) -> ([bool; N_STAGES], f64) {
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    let read = |f: &str| {
        std::fs::read_to_string(dir.join(f)).unwrap_or_else(|e| panic!("{name}/{f}: {e}"))
    };
    let meta: serde_json::Value =
        serde_json::from_str(&read("meta.json")).unwrap_or_else(|e| panic!("{name}/meta: {e}"));
    let ref_frame = meta["ref_frame"].as_u64().expect("meta ref_frame") as usize;
    let target_frame = meta["target_frame"].as_u64().expect("meta target_frame") as usize;

    // ---- inputs, assembled exactly as production did
    let feeds = Npz::load(&root.join("robot_feeds").join(format!("{name}.npz")));
    let (ids_data, ids_shape) = feeds.i64("ref_ids");
    let (logits_data, logits_shape) = feeds.f32("ref_logits");
    assert_eq!(ids_shape.len(), 2, "{name}: ref_ids not (1, n)");
    let n_tgt = ids_shape[1];
    assert_eq!(logits_shape[0], 1, "{name}: ref_logits not batched");
    assert_eq!(logits_shape[1], n_tgt, "{name}: logits/ids row mismatch");
    let palette_dim = logits_shape[2];

    let color_list: Vec<i64> = serde_json::from_str(
        &std::fs::read_to_string(
            root.join("tokenizer_goldens").join(&name).join("01_color_list.json"),
        )
        .unwrap_or_else(|e| panic!("{name}/01_color_list.json: {e}")),
    )
    .unwrap_or_else(|e| panic!("{name}/01_color_list.json: {e}"));
    let palette = palette_from_color_list(&color_list);

    let load_seg = |frame: usize| -> Map32 {
        let p = root
            .join("segment_goldens")
            .join(format!("f{frame:03}"))
            .join("08_final.npy");
        let (data, shape) = load_npy_i32(&p);
        assert_eq!(shape.len(), 2, "{}: not a 2d map", p.display());
        seg_from_labels(&Map32 {
            w: shape[1],
            h: shape[0],
            data,
        })
    };
    let ref_seg = load_seg(ref_frame);
    let tgt_seg = load_seg(target_frame);

    let t0 = Instant::now();
    let out: PostprocessOutput = postprocess(
        &ids_data,
        &logits_data,
        palette_dim,
        &palette,
        &color_list,
        &ref_seg,
        &tgt_seg,
    );
    let secs = t0.elapsed().as_secs_f64();

    let mut results = [false; N_STAGES];

    // ---- ids
    let g_ids = Npz::load(&dir.join("01_ids.npz"));
    let (in_ids, _) = g_ids.i64("in_ids");
    let (clamped_ids, _) = g_ids.i64("clamped_ids");
    results[0] = cmp_i64(&name, "ids/in_ids", &ids_data, &in_ids)
        & cmp_i64(&name, "ids/clamped", &out.target_color_ids, &clamped_ids);

    // ---- colors
    let want_colors: Vec<[i64; 4]> = serde_json::from_str(&read("02_colors.json"))
        .unwrap_or_else(|e| panic!("{name}/02: {e}"));
    results[1] = if out.target_colors_rgba == want_colors {
        true
    } else {
        let i = out
            .target_colors_rgba
            .iter()
            .zip(&want_colors)
            .position(|(g, w)| g != w);
        println!(
            "{name}/colors: mismatch at seg {:?}: got {:?} want {:?}",
            i,
            i.map(|i| out.target_colors_rgba[i]),
            i.map(|i| want_colors[i])
        );
        false
    };

    // ---- entropy (f32 bitwise)
    let g_ent = Npz::load(&dir.join("03_entropy.npz"));
    let (nc_golden, _) = g_ent.i64("num_classes");
    let (norm_want, _) = g_ent.f32("norm_entropy");
    let (conf_want, _) = g_ent.f32("entropy_conf_scores");
    let nc_ok = out.num_classes as i64 == nc_golden[0];
    if !nc_ok {
        println!(
            "{name}/entropy: num_classes {} want {}",
            out.num_classes, nc_golden[0]
        );
    }
    results[2] = nc_ok
        & cmp_f32(&name, "entropy/norm", &out.norm_entropy, &norm_want)
        & cmp_f32(&name, "entropy/conf", &out.entropy_conf_scores, &conf_want);

    // ---- dense
    let (dense_want, _) = load_npy_i64(&dir.join("06_dense_colors.npy"));
    results[3] = cmp_i64(&name, "dense", &out.target_dense_colors, &dense_want);

    // ---- renders (decoded RGBA pixels)
    let ref_want = load_rgba_png(&dir.join("04_ref_render.png"));
    let tgt_want = load_rgba_png(&dir.join("05_target_render.png"));
    results[4] = cmp_rgba(&name, "ref_rend", &out.ref_color_image, &ref_want);
    results[5] = cmp_rgba(&name, "tgt_rend", &out.target_color_image, &tgt_want);

    // ---- meta cross-checks
    let want = |k: &str| meta[k].as_u64().unwrap_or(u64::MAX) as usize;
    let sizes_ok = |img: &Rgba, key: &str| {
        meta[key][0].as_u64() == Some(img.w as u64) && meta[key][1].as_u64() == Some(img.h as u64)
    };
    results[6] = n_tgt == want("n_tgt")
        && palette.color_list.len() == want("palette_len")
        && out.num_classes == want("num_classes")
        && sizes_ok(&out.ref_color_image, "ref_render_size")
        && sizes_ok(&out.target_color_image, "target_render_size");
    if !results[6] {
        println!(
            "{name}/meta: n_tgt {} palette_len {} num_classes {} renders {}x{} / {}x{} vs {}",
            n_tgt,
            palette.color_list.len(),
            out.num_classes,
            out.ref_color_image.w,
            out.ref_color_image.h,
            out.target_color_image.w,
            out.target_color_image.h,
            meta
        );
    }

    (results, secs)
}

// ---------------------------------------------------------------------------
// golden bundles

struct Npz {
    entries: Vec<(String, Vec<u8>)>,
    path: String,
}

impl Npz {
    fn load(path: &Path) -> Npz {
        Npz {
            entries: read_npz(path),
            path: path.display().to_string(),
        }
    }

    fn raw(&self, key: &str) -> &[u8] {
        &self
            .entries
            .iter()
            .find(|(n, _)| n == &format!("{key}.npy"))
            .unwrap_or_else(|| panic!("{}: missing key {key}", self.path))
            .1
    }

    fn f32(&self, key: &str) -> (Vec<f32>, Vec<usize>) {
        parse_npy_f32(self.raw(key))
    }

    fn i64(&self, key: &str) -> (Vec<i64>, Vec<usize>) {
        parse_npy_i64(self.raw(key))
    }
}

// ---------------------------------------------------------------------------
// bitwise comparison

fn cmp_slices<T, U, F>(name: &str, stage: &str, got: &[T], want: &[T], to_cmp: F) -> bool
where
    T: std::fmt::Display + Copy,
    U: PartialEq,
    F: Fn(T) -> U,
{
    if got.len() != want.len() {
        println!(
            "{name}/{stage}: length mismatch: got {} want {}",
            got.len(),
            want.len()
        );
        return false;
    }
    let mut first = None;
    let mut total = 0usize;
    for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
        if to_cmp(*g) != to_cmp(*w) {
            total += 1;
            if first.is_none() {
                first = Some(i);
            }
        }
    }
    match first {
        None => true,
        Some(i) => {
            println!(
                "{name}/{stage}: {total} differing values; first at flat index {i}: got {} want {}",
                got[i], want[i]
            );
            false
        }
    }
}

fn cmp_f32(name: &str, stage: &str, got: &[f32], want: &[f32]) -> bool {
    cmp_slices(name, stage, got, want, |v: f32| v.to_bits())
}

fn cmp_i64(name: &str, stage: &str, got: &[i64], want: &[i64]) -> bool {
    cmp_slices(name, stage, got, want, |v: i64| v)
}

fn cmp_rgba(name: &str, stage: &str, got: &Rgba, want: &Rgba) -> bool {
    if (got.w, got.h) != (want.w, want.h) {
        println!(
            "{name}/{stage}: size mismatch: got {}x{} want {}x{}",
            got.w, got.h, want.w, want.h
        );
        return false;
    }
    match got.data.iter().zip(&want.data).position(|(g, w)| g != w) {
        None => true,
        Some(i) => {
            let px = i / 4;
            let (x, y, c) = (px % got.w, px / got.w, i % 4);
            let total = got
                .data
                .iter()
                .zip(&want.data)
                .filter(|(g, w)| g != w)
                .count();
            println!(
                "{name}/{stage}: {total} differing bytes; first at ({x},{y}) channel {c}: got {} want {}",
                got.data[i], want.data[i]
            );
            false
        }
    }
}
