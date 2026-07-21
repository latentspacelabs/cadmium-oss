//! Golden verification harness for the /segment classical pipeline port.
//!
//! Usage: cargo run --release --bin verify_segment -- <goldens_root>
//!
//! For every drawing directory under <goldens_root> (containing line.png,
//! 01_binary.npy .. 08_final.npy, meta.json as dumped by
//! serving/tools/dump_segment_goldens.py), runs the Rust pipeline from line.png and
//! compares each stage byte-exact against the goldens. Prints a per-drawing
//! per-stage PASS/FAIL matrix (with first-mismatch coordinates on failure)
//! and exits nonzero on any failure.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use cadmium_sidecar::goldens::{load_alpha_png, load_npy_i32, load_npy_u8};
use cadmium_sidecar::segment::{
    binarize, merge, thinning, trapped_ball, Gray, Map32,
};

const STAGE_NAMES: [&str; 8] = [
    "01_binary",
    "02_tb_r2",
    "03_tb_r1",
    "04_tb_r0",
    "05_fillmap",
    "06_merged",
    "07_thinned",
    "08_final",
];

fn main() -> ExitCode {
    let root = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("usage: verify_segment <goldens_root>");
            return ExitCode::from(2);
        }
    };

    let mut drawings: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", root.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("line.png").is_file())
        .collect();
    drawings.sort();
    if drawings.is_empty() {
        eprintln!("no drawing directories (with line.png) under {}", root.display());
        return ExitCode::from(2);
    }

    let mut matrix: Vec<(String, [bool; 8], f64)> = Vec::new();
    let mut all_pass = true;

    for dir in &drawings {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let (results, secs) = verify_drawing(dir);
        all_pass &= results.iter().all(|&r| r);
        matrix.push((name, results, secs));
    }

    // matrix
    println!();
    print!("{:8}", "drawing");
    for s in STAGE_NAMES {
        print!(" {:>10}", s);
    }
    println!(" {:>9}", "time");
    for (name, results, secs) in &matrix {
        print!("{:8}", name);
        for r in results {
            print!(" {:>10}", if *r { "PASS" } else { "FAIL" });
        }
        println!(" {:>8.3}s", secs);
    }
    println!();
    if all_pass {
        println!(
            "all {} drawings x {} stages byte-exact",
            matrix.len(),
            STAGE_NAMES.len()
        );
        ExitCode::SUCCESS
    } else {
        println!("MISMATCHES FOUND");
        ExitCode::FAILURE
    }
}

fn verify_drawing(dir: &Path) -> ([bool; 8], f64) {
    let alpha = load_alpha_png(&dir.join("line.png"));
    let (w, h) = (alpha.w, alpha.h);

    let meta = std::fs::read_to_string(dir.join("meta.json")).unwrap_or_default();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap_or(serde_json::Value::Null);
    let golden_fills: Vec<usize> = meta["fills_per_stage"]
        .as_array()
        .map(|a| a.iter().map(|v| v.as_u64().unwrap_or(0) as usize).collect())
        .unwrap_or_default();

    let mut results = [false; 8];
    let t0 = Instant::now();

    // Stage 01: binarize
    let binary = binarize::binarize_adaptive_mean(&alpha);
    results[0] = compare_u8(dir, STAGE_NAMES[0], &binary);

    // Stages 02-04: trapped-ball passes (our own pipeline state carries on)
    let mut fills: Vec<trapped_ball::Fill> = Vec::new();
    let mut result = binary.clone();
    let stage_params: [(usize, trapped_ball::FilterMethod); 3] = [
        (2, trapped_ball::FilterMethod::Max),
        (1, trapped_ball::FilterMethod::None),
        (0, trapped_ball::FilterMethod::None),
    ];
    for (i, &(radius, method)) in stage_params.iter().enumerate() {
        let fill = trapped_ball::trapped_ball_fill_multi(&result, radius, method, 1000);
        if let Some(&want) = golden_fills.get(i) {
            if fill.len() != want {
                println!(
                    "{}/{}: fills_per_stage mismatch: got {} want {}",
                    dir.file_name().unwrap().to_string_lossy(),
                    STAGE_NAMES[i + 1],
                    fill.len(),
                    want
                );
            }
        }
        result = trapped_ball::mark_fill(&result, &fill);
        fills.extend(fill);
        results[i + 1] = compare_u8(dir, STAGE_NAMES[i + 1], &result);
    }

    // Stage 05: flood_fill_multi + build_fill_map
    let fill = trapped_ball::flood_fill_multi(&result, 20000);
    if let Some(&want) = golden_fills.get(3) {
        if fill.len() != want {
            println!(
                "{}/05: flood fills_per_stage mismatch: got {} want {}",
                dir.file_name().unwrap().to_string_lossy(),
                fill.len(),
                want
            );
        }
    }
    fills.extend(fill);
    let fillmap = trapped_ball::build_fill_map(w, h, &fills);
    results[4] = compare_i32(dir, STAGE_NAMES[4], &fillmap);

    // Stage 06: merge_fill
    let merged = merge::merge_fill(&fillmap, 10, 10);
    results[5] = compare_i32(dir, STAGE_NAMES[5], &merged);

    // Stage 07: thinning
    let thinned = thinning::thinning(&merged, 100);
    results[6] = compare_i32(dir, STAGE_NAMES[6], &thinned);

    // Stage 08: relabel
    let (final_labels, _n) = thinning::relabel(&thinned);
    results[7] = compare_i32(dir, STAGE_NAMES[7], &final_labels);

    (results, t0.elapsed().as_secs_f64())
}

// ---------------------------------------------------------------------------
// comparison

fn report_mismatch<T: std::fmt::Display + PartialEq>(
    dir: &Path,
    stage: &str,
    got: &[T],
    want: &[T],
    w: usize,
) -> bool {
    if got == want {
        return true;
    }
    let name = dir.file_name().unwrap().to_string_lossy();
    let total = got.iter().zip(want.iter()).filter(|(g, w)| g != w).count();
    println!("{name}/{stage}: {total} differing pixels; first few (x, y, got, want):");
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

fn compare_u8(dir: &Path, stage: &str, got: &Gray) -> bool {
    let (data, shape) = load_npy_u8(&dir.join(format!("{stage}.npy")));
    assert_eq!(shape, vec![got.h, got.w], "{stage}: golden shape mismatch");
    report_mismatch(dir, stage, &got.data, &data, got.w)
}

fn compare_i32(dir: &Path, stage: &str, got: &Map32) -> bool {
    let (data, shape) = load_npy_i32(&dir.join(format!("{stage}.npy")));
    assert_eq!(shape, vec![got.h, got.w], "{stage}: golden shape mismatch");
    report_mismatch(dir, stage, &got.data, &data, got.w)
}
