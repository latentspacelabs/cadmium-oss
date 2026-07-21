//! Golden verification harness for the AnT v2 preprocess image-prep port.
//!
//! Usage:
//!   cargo run --release --bin verify_imageprep -- \
//!       <imageprep_goldens_root> <robot_corpus_dir> \
//!       [--color-list-json <tokenizer 01_color_list.json>]
//!
//! For every drawing directory under <imageprep_goldens_root> (01..10[+11]
//! npy stages, 07_vtrace_input.png, 08_vtrace_output.svg, meta.json as
//! dumped by serving/tools/dump_imageprep_goldens.py), loads the line (and for
//! *_ref the color) RGBA from the corpus, takes golden 01_seg_input.npy as
//! the seg input (its producer, the trapped-ball path, is verified by
//! verify_segment), runs `imageprep::prepare_image_stages`, and compares
//! every stage byte-exact. The 08 column reruns the vendored vtracer on the
//! golden 07 png and compares the SVG string; a mismatch that is purely
//! numeric (identical path/command structure, digits-only diffs in
//! coordinate values) is reported as PLAT — the known macOS-arm64 libm
//! rounding drift — and does not fail the run. With --color-list-json, the
//! *_ref drawing additionally replays `KeyFrame.compute_color_list` on the
//! full-res seg/line/color and compares against the tokenizer golden.
//!
//! Exits nonzero on any FAIL (PLAT allowed for the 08 column only).
//!
//! Platform note (2026-07-20): on linux x86_64 (wallace, glibc — the
//! platform the golden-producing wheel ran on) this harness is 13/13
//! drawings x 14 stages BYTE-exact, vtracer SVG strings included. On macOS
//! arm64 the same build shows 8 vtracer-column diffs from system-libm
//! rounding inside visioncortex's spline fitting: 3 drawings differ only in
//! coordinate digits (classified PLAT) and 5 where an ulp-level angle/error
//! flip changes a subdivision decision, giving a different C-command count
//! inside one path (classified FAIL by the structural rule — rerun on
//! linux to disambiguate a real regression from this drift; everything
//! outside the 08 column is byte-exact on both platforms).

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use cadmium_sidecar::goldens::{load_npy_i32, load_npy_u8, load_rgba_png};
use cadmium_sidecar::imageprep::{
    self, color_list::compute_color_list, vtrace_prep::IdMap, PrepStages, Rgba,
};
use cadmium_sidecar::segment::Map32;

const STAGE_NAMES: [&str; 14] = [
    "bbox", "02_segc", "03_line", "03c_col", "04_segr", "05_line", "05c_col", "06_vprep",
    "07_rgba", "08_svg", "09_segp", "10_line", "11_colp", "clrlist",
];
const N_STAGES: usize = STAGE_NAMES.len();

#[derive(Clone, Copy, PartialEq)]
enum R {
    Pass,
    Fail,
    Plat,
    /// not applicable for this drawing (color stages on non-ref drawings)
    Na,
}

impl R {
    fn label(self) -> &'static str {
        match self {
            R::Pass => "PASS",
            R::Fail => "FAIL",
            R::Plat => "PLAT",
            R::Na => "-",
        }
    }
    fn from_bool(ok: bool) -> R {
        if ok {
            R::Pass
        } else {
            R::Fail
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut pos: Vec<PathBuf> = Vec::new();
    let mut color_list_json: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--color-list-json" => {
                color_list_json =
                    Some(PathBuf::from(it.next().expect("--color-list-json needs a path")))
            }
            _ => pos.push(PathBuf::from(a)),
        }
    }
    if pos.len() != 2 {
        eprintln!(
            "usage: verify_imageprep <imageprep_goldens_root> <robot_corpus_dir> \
             [--color-list-json <01_color_list.json>]"
        );
        return ExitCode::from(2);
    }
    let (root, corpus) = (&pos[0], &pos[1]);

    let mut drawings: Vec<PathBuf> = std::fs::read_dir(root)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", root.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("meta.json").is_file())
        .collect();
    drawings.sort();
    if drawings.is_empty() {
        eprintln!("no golden directories (with meta.json) under {}", root.display());
        return ExitCode::from(2);
    }

    let mut matrix: Vec<(String, [R; N_STAGES], f64)> = Vec::new();
    let mut all_ok = true;

    for dir in &drawings {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let (results, secs) = verify_drawing(dir, corpus, color_list_json.as_deref());
        all_ok &= results.iter().all(|&r| r != R::Fail);
        matrix.push((name, results, secs));
    }

    println!();
    print!("{:10}", "drawing");
    for s in STAGE_NAMES {
        print!(" {:>8}", s);
    }
    println!(" {:>9}", "time");
    for (name, results, secs) in &matrix {
        print!("{:10}", name);
        for r in results {
            print!(" {:>8}", r.label());
        }
        println!(" {:>8.3}s", secs);
    }
    println!();
    let plats = matrix
        .iter()
        .flat_map(|(_, r, _)| r.iter())
        .filter(|&&r| r == R::Plat)
        .count();
    if all_ok {
        if plats > 0 {
            println!(
                "all {} drawings byte-exact except {plats} PLAT (platform libm) svg diff(s)",
                matrix.len()
            );
        } else {
            println!("all {} drawings x {} stages byte-exact", matrix.len(), N_STAGES);
        }
        ExitCode::SUCCESS
    } else {
        println!("MISMATCHES FOUND");
        ExitCode::FAILURE
    }
}

// ---------------------------------------------------------------------------
// per-drawing verification

fn verify_drawing(dir: &Path, corpus: &Path, color_list_json: Option<&Path>) -> ([R; N_STAGES], f64) {
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    let frame = name.strip_suffix("_ref").unwrap_or(&name);
    let is_ref = name.ends_with("_ref");

    let line = load_rgba_png(&corpus_png(corpus, &format!("lineLayer1_{frame}_")));
    let color = is_ref.then(|| load_rgba_png(&corpus_png(corpus, &format!("colorLayer1_{frame}_"))));

    // golden 01 is the input (trapped-ball seg, verified by verify_segment)
    let (seg_data, seg_shape) = load_npy_i32(&dir.join("01_seg_input.npy"));
    assert_eq!(seg_shape.len(), 2, "{name}/01: expected 2-D seg");
    let seg = Map32 {
        w: seg_shape[1],
        h: seg_shape[0],
        data: seg_data,
    };
    assert_eq!((seg.w, seg.h), (line.w, line.h), "{name}: seg/line size mismatch");

    let meta: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("meta.json")).expect("meta.json"),
    )
    .expect("meta.json parse");

    let t0 = Instant::now();
    let stages = imageprep::prepare_image_stages(&seg, &line, color.as_ref());
    let mut results = [R::Na; N_STAGES];

    // bbox: pad dims against meta.json
    results[0] = R::from_bool(check_pad_dims(&name, &meta, &stages));

    // npy stages
    results[1] = compare_i32(dir, "02_seg_cropped", "02_segc", &stages.seg_cropped);
    results[2] = compare_rgba(dir, "03_line_cropped", "03_line", &stages.line_cropped);
    if let Some(c) = &stages.color_cropped {
        results[3] = compare_rgba(dir, "03c_color_cropped", "03c_col", c);
    }
    results[4] = compare_i32(dir, "04_seg_resized", "04_segr", &stages.seg_resized);
    results[5] = compare_rgba(dir, "05_line_resized", "05_line", &stages.line_resized);
    if let Some(c) = &stages.color_resized {
        results[6] = compare_rgba(dir, "05c_color_resized", "05c_col", c);
    }
    results[7] = {
        let a = compare_i32(dir, "06_seg_for_vtrace", "06_vprep", &stages.seg_for_vtrace);
        let b = R::from_bool(check_id_map(&name, &meta["id_map"], &stages.id_map));
        if a == R::Pass && b == R::Pass {
            R::Pass
        } else {
            R::Fail
        }
    };

    // 07: our RGBA vs the decoded golden png
    let png07 = dir.join("07_vtrace_input.png");
    let golden07 = load_rgba_png(&png07);
    results[8] = {
        let got = &stages.vtrace_rgba;
        if (got.w, got.h) != (golden07.w, golden07.h) {
            println!(
                "{name}/07_rgba: shape ({}, {}) vs golden ({}, {})",
                got.w, got.h, golden07.w, golden07.h
            );
            R::Fail
        } else {
            R::from_bool(report_mismatch(
                &name,
                "07_rgba",
                &got.data,
                &golden07.data,
                got.w * 4,
            ))
        }
    };

    // 08: rerun the vendored vtracer. Feed it the golden 07 png (identical
    // to our RGBA when stage 07 passed — vtracer only sees decoded pixels,
    // exactly like production's PIL-written temp png).
    results[9] = if results[8] == R::Pass {
        verify_svg(&name, dir, &png07, &meta)
    } else {
        println!("{name}/08_svg: skipped (07 mismatch)");
        R::Fail
    };

    results[10] = compare_i32(dir, "09_seg_padded", "09_segp", &stages.seg_padded);
    results[11] = compare_rgba(dir, "10_line_padded", "10_line", &stages.line_padded);
    if let Some(c) = &stages.color_padded {
        results[12] = compare_rgba(dir, "11_color_padded", "11_colp", c);
    }

    // color list (ref drawing only, when the tokenizer golden is supplied):
    // full-res seg + line + color through KeyFrame.compute_color_list
    if is_ref {
        if let Some(json_path) = color_list_json {
            let want: Vec<i64> = serde_json::from_str(
                &std::fs::read_to_string(json_path)
                    .unwrap_or_else(|e| panic!("{}: {e}", json_path.display())),
            )
            .expect("color list json");
            let (got, stats) = compute_color_list(&seg, color.as_ref().unwrap(), &line);
            let ok = report_mismatch(&name, "clrlist", &got, &want, want.len().max(1));
            if ok {
                println!(
                    "{name}/clrlist: {} segs match ({} transparent, {} multi, {} over, {} black)",
                    stats.num_total_segs,
                    stats.num_transparent_segs,
                    stats.num_multi_color_segs,
                    stats.num_over_thresholded_segs,
                    stats.num_black_segs
                );
            }
            results[13] = R::from_bool(ok);
        }
    }

    (results, t0.elapsed().as_secs_f64())
}

fn corpus_png(corpus: &Path, prefix: &str) -> PathBuf {
    let mut found: Vec<PathBuf> = std::fs::read_dir(corpus)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", corpus.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(prefix))
                .unwrap_or(false)
        })
        .collect();
    found.sort();
    match found.len() {
        1 => found.pop().unwrap(),
        n => panic!("{}: {n} files match prefix {prefix}", corpus.display()),
    }
}

fn check_pad_dims(name: &str, meta: &serde_json::Value, stages: &PrepStages) -> bool {
    let pair = |v: &serde_json::Value| -> (usize, usize) {
        (
            v[0].as_u64().unwrap_or(u64::MAX) as usize,
            v[1].as_u64().unwrap_or(u64::MAX) as usize,
        )
    };
    let mut ok = true;
    if stages.vert_pad_dims != pair(&meta["vert_pad_dims"]) {
        println!(
            "{name}/bbox: vert_pad_dims {:?} vs meta {:?}",
            stages.vert_pad_dims,
            pair(&meta["vert_pad_dims"])
        );
        ok = false;
    }
    if stages.horiz_pad_dims != pair(&meta["horiz_pad_dims"]) {
        println!(
            "{name}/bbox: horiz_pad_dims {:?} vs meta {:?}",
            stages.horiz_pad_dims,
            pair(&meta["horiz_pad_dims"])
        );
        ok = false;
    }
    ok
}

fn check_id_map(name: &str, meta_map: &serde_json::Value, got: &Option<IdMap>) -> bool {
    match (meta_map.is_null(), got) {
        (true, None) => true,
        (true, Some(m)) => {
            println!("{name}/06_vprep: produced an id_map {m:?} but meta has null");
            false
        }
        (false, None) => {
            println!("{name}/06_vprep: meta has id_map {meta_map} but the port produced none");
            false
        }
        (false, Some(m)) => {
            let obj = meta_map.as_object().expect("id_map object");
            let mut ok = obj.len() == m.len();
            for (old, new) in m {
                let want = &obj[&old.to_string()];
                let got_v = new.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null);
                ok &= want == &got_v;
            }
            if !ok {
                println!("{name}/06_vprep: id_map {m:?} vs meta {meta_map}");
            }
            ok
        }
    }
}

// ---------------------------------------------------------------------------
// vtracer / SVG

/// `vtrace.py::vectorize`'s production parameters through the vendored
/// crate, mirroring the wheel's `convert_image_to_svg_py` mapping
/// (colormode seg, hierarchical cutout, spline; filter_speckle 0, corner 60,
/// max_iterations 10, length 4.0, splice 10, precision 0, max_error_simp
/// 2.0). `..Default::default()` supplies mode=Spline plus the color/layer
/// fields the seg path never reads.
fn production_vec_config() -> vtracer::Config {
    vtracer::Config {
        color_mode: "seg".parse().unwrap(),
        hierarchical: "cutout".parse().unwrap(),
        filter_speckle: 0,
        corner_threshold: 60,
        length_threshold: 4.0,
        max_iterations: 10,
        splice_threshold: 10,
        path_precision: Some(0),
        max_error_simp: 2.0,
        ..Default::default()
    }
}

fn verify_svg(name: &str, dir: &Path, png07: &Path, meta: &serde_json::Value) -> R {
    let want = std::fs::read_to_string(dir.join("08_vtrace_output.svg")).expect("08 svg");
    let svg = match vtracer::convert(png07, production_vec_config()) {
        Ok(svg) => svg,
        Err(e) => {
            println!("{name}/08_svg: vtracer failed: {e}");
            return R::Fail;
        }
    };
    let got = svg.to_string();

    // production cross-check: meta num_paths == our path count
    let num_paths = meta["num_paths"].as_u64().unwrap_or(u64::MAX) as usize;
    let got_paths = got.matches("<path ").count();
    if got_paths != num_paths {
        println!("{name}/08_svg: {got_paths} paths vs meta num_paths {num_paths}");
        return R::Fail;
    }

    if got == want {
        return R::Pass;
    }

    // Structural comparison: split every line into a numeric-masked skeleton
    // plus its number tokens. Identical skeletons (same path count, same
    // command letters in the same order) with digits-only diffs is the known
    // macOS-arm64 vs Linux libm rounding drift -> PLAT.
    let g_lines: Vec<&str> = got.lines().collect();
    let w_lines: Vec<&str> = want.lines().collect();
    if g_lines.len() != w_lines.len() {
        println!(
            "{name}/08_svg: line count {} vs {} — structural diff",
            g_lines.len(),
            w_lines.len()
        );
        return R::Fail;
    }
    let mut num_diffs: Vec<(usize, String, String)> = Vec::new();
    for (i, (g, w)) in g_lines.iter().zip(w_lines.iter()).enumerate() {
        if g == w {
            continue;
        }
        let (gs, gn) = mask_numbers(g);
        let (ws, wn) = mask_numbers(w);
        if gs != ws || gn.len() != wn.len() {
            println!("{name}/08_svg: non-numeric diff at line {}:", i + 1);
            println!("  got:  {g}");
            println!("  want: {w}");
            return R::Fail;
        }
        for (j, (a, b)) in gn.iter().zip(wn.iter()).enumerate() {
            if a != b {
                num_diffs.push((i + 1, format!("token {j}: {a}"), b.clone()));
            }
        }
    }
    println!(
        "{name}/08_svg: PLAT — {} numeric-only token diff(s), identical path/command structure:",
        num_diffs.len()
    );
    for (line, got_tok, want_tok) in num_diffs.iter().take(8) {
        println!("  line {line}: got {got_tok} want {want_tok}");
    }
    R::Plat
}

/// Replace every number token (digits, '.', a leading '-') with '#',
/// returning the skeleton and the extracted tokens.
fn mask_numbers(s: &str) -> (String, Vec<String>) {
    let mut skeleton = String::with_capacity(s.len());
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let bytes: Vec<char> = s.chars().collect();
    for (i, &c) in bytes.iter().enumerate() {
        let is_num = c.is_ascii_digit()
            || c == '.'
            || (c == '-'
                && bytes.get(i + 1).map(|n| n.is_ascii_digit() || *n == '.').unwrap_or(false)
                && cur.is_empty());
        if is_num {
            cur.push(c);
        } else {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
                skeleton.push('#');
            }
            skeleton.push(c);
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
        skeleton.push('#');
    }
    (skeleton, tokens)
}

// ---------------------------------------------------------------------------
// comparison helpers

fn report_mismatch<T: std::fmt::Display + PartialEq>(
    name: &str,
    stage: &str,
    got: &[T],
    want: &[T],
    w: usize,
) -> bool {
    if got.len() != want.len() {
        println!("{name}/{stage}: length {} vs golden {}", got.len(), want.len());
        return false;
    }
    if got == want {
        return true;
    }
    let total = got.iter().zip(want.iter()).filter(|(g, w)| g != w).count();
    println!("{name}/{stage}: {total} differing values; first few (x, y, got, want):");
    let mut shown = 0;
    for (i, (g, wv)) in got.iter().zip(want.iter()).enumerate() {
        if g != wv {
            println!("  ({}, {}, {}, {})", i % w, i / w, g, wv);
            shown += 1;
            if shown >= 5 {
                break;
            }
        }
    }
    false
}

fn compare_i32(dir: &Path, stem: &str, stage: &str, got: &Map32) -> R {
    let name = dir.file_name().unwrap().to_string_lossy();
    let (want, shape) = load_npy_i32(&dir.join(format!("{stem}.npy")));
    if shape != vec![got.h, got.w] {
        println!(
            "{name}/{stage}: shape ({}, {}) vs golden {:?}",
            got.h, got.w, shape
        );
        return R::Fail;
    }
    R::from_bool(report_mismatch(&name, stage, &got.data, &want, got.w))
}

fn compare_rgba(dir: &Path, stem: &str, stage: &str, got: &Rgba) -> R {
    let name = dir.file_name().unwrap().to_string_lossy();
    let (want, shape) = load_npy_u8(&dir.join(format!("{stem}.npy")));
    if shape != vec![got.h, got.w, 4] {
        println!(
            "{name}/{stage}: shape ({}, {}, 4) vs golden {:?}",
            got.h, got.w, shape
        );
        return R::Fail;
    }
    R::from_bool(report_mismatch(&name, stage, &got.data, &want, got.w * 4))
}
