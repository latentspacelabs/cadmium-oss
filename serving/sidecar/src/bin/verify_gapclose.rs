//! Golden verification harness for the tiled gap-closing /segment port.
//!
//! Usage: cargo run --release --bin verify_gapclose -- <goldens_root> [--onnx <model.onnx>]
//!
//! For every drawing directory under <goldens_root> (line.png,
//! 01_cropped_alpha.npy .. 12_boundary_final.npy, 07_borders.npz,
//! meta.json as dumped by serving/tools/dump_gapcloser_goldens.py), runs the Rust
//! pipeline from line.png — taking the golden 03_tile_boundary as the ML
//! model's output — and compares every stage byte-exact. Prints a
//! per-drawing per-stage PASS/FAIL matrix (first-mismatch coordinates on
//! failure) plus meta.json cross-checks, and exits nonzero on any failure.
//!
//! With --onnx, additionally runs the ONNX UDF model on the stage-02
//! tiles and reports how many boundary pixels differ from the golden
//! stage 03 (torch-CUDA vs ONNX-CPU threshold flips). Report-only: it
//! never affects the exit code.
//!
//! With --coreml-bucket, does the same through the PRODUCTION serving path
//! instead: `Engine::run_gap_udfs` on the batch-pinned export (CoreML EP,
//! fixed batches, zero-padded tail) — macOS only. Also report-only.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use cadmium_sidecar::goldens::{
    load_alpha_png, load_npy_i32, load_npy_u32, load_npy_u8, parse_npy_f32, parse_npy_i32,
    read_npz,
};
use cadmium_sidecar::segment::tiled::{self, GapCloseStages};
use cadmium_sidecar::segment::tiler::{PlaneF32, Tiler};
use cadmium_sidecar::segment::{binarize, Gray};
use cadmium_sidecar::serve::engine::{Engine, EpSelect};

const STAGE_NAMES: [&str; 13] = [
    "01_crop", "02_pad", "03_in", "04_bnd", "05_segp", "06_tseg", "07_bord", "08_cc", "09_unm",
    "10_mrg", "11_fin", "12_bfin", "meta",
];
const N_STAGES: usize = STAGE_NAMES.len();

fn main() -> ExitCode {
    if let Err(e) = cadmium_sidecar::ort_dylib::init() {
        eprintln!("ort dylib: {e}");
        return ExitCode::from(2);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut root: Option<PathBuf> = None;
    let mut onnx: Option<PathBuf> = None;
    let mut coreml_bucket: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--onnx" => onnx = Some(PathBuf::from(it.next().expect("--onnx needs a path"))),
            "--coreml-bucket" => {
                coreml_bucket =
                    Some(PathBuf::from(it.next().expect("--coreml-bucket needs a path")));
            }
            _ => root = Some(PathBuf::from(a)),
        }
    }
    let root = match root {
        Some(p) => p,
        None => {
            eprintln!(
                "usage: verify_gapclose <goldens_root> [--onnx <model.onnx>] \
                 [--coreml-bucket <model.onnx>]"
            );
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

    let mut onnx_session = onnx.as_deref().map(load_onnx);
    // The production serving path for the batch-pinned export: no dynamic gap
    // model is supplied, so a CoreML failure surfaces as "no udfs" here
    // instead of silently passing via the CPU fallback.
    let engine = coreml_bucket.map(|p| {
        Engine::new(None, Some(p), None, None, None, EpSelect::Auto, None)
            .unwrap_or_else(|e| panic!("engine: {e}"))
    });

    let mut matrix: Vec<(String, [bool; N_STAGES], f64)> = Vec::new();
    let mut all_pass = true;

    for dir in &drawings {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let (results, secs, stages) = verify_drawing(dir);
        all_pass &= results.iter().all(|&r| r);
        matrix.push((name, results, secs));
        if let Some(session) = onnx_session.as_mut() {
            report_onnx_flips(dir, &stages, session);
        }
        if let Some(engine) = engine.as_ref() {
            report_coreml_flips(dir, &stages, engine);
        }
    }

    println!();
    print!("{:8}", "drawing");
    for s in STAGE_NAMES {
        print!(" {:>8}", s);
    }
    println!(" {:>9}", "time");
    for (name, results, secs) in &matrix {
        print!("{:8}", name);
        for r in results {
            print!(" {:>8}", if *r { "PASS" } else { "FAIL" });
        }
        println!(" {:>8.3}s", secs);
    }
    println!();
    if all_pass {
        println!(
            "all {} drawings x {} stages byte-exact",
            matrix.len(),
            N_STAGES
        );
        ExitCode::SUCCESS
    } else {
        println!("MISMATCHES FOUND");
        ExitCode::FAILURE
    }
}

fn verify_drawing(dir: &Path) -> ([bool; N_STAGES], f64, GapCloseStages) {
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    let alpha = load_alpha_png(&dir.join("line.png"));

    let meta = std::fs::read_to_string(dir.join("meta.json")).unwrap_or_default();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap_or(serde_json::Value::Null);
    let musize = |v: &serde_json::Value| v.as_u64().unwrap_or(u64::MAX) as usize;
    let mpair = |v: &serde_json::Value| -> (usize, usize) {
        (musize(&v[0]), musize(&v[1]))
    };
    let tb_sizes = [
        musize(&meta["tb_sizes"][0]),
        musize(&meta["tb_sizes"][1]),
        musize(&meta["tb_sizes"][2]),
    ];
    let tb_max_iter = musize(&meta["tb_max_iter"]);
    let tb_min_seg_size = musize(&meta["tb_min_seg_size"]);

    // golden stage 03: the ML model's combined boundary tiles (the input
    // this port takes as given)
    let (b03, b03_shape) = load_npy_u8(&dir.join("03_tile_boundary.npy"));
    assert_eq!(b03_shape.len(), 3, "03_tile_boundary must be [N, th, tw]");
    let (n_tiles, th, tw) = (b03_shape[0], b03_shape[1], b03_shape[2]);
    let tile_boundaries: Vec<Gray> = (0..n_tiles)
        .map(|i| Gray {
            w: tw,
            h: th,
            data: b03[i * th * tw..(i + 1) * th * tw].to_vec(),
        })
        .collect();

    let t0 = Instant::now();
    let stages = tiled::gap_close_stages(&alpha, &tile_boundaries, tb_sizes, tb_max_iter, tb_min_seg_size);
    let secs = t0.elapsed().as_secs_f64();

    let mut results = [false; N_STAGES];

    // 01: cropped alpha
    results[0] = compare_u8(dir, "01_cropped_alpha", "01_crop", &stages.cropped_alpha);

    // 02: padded + edge-stamped f32, bitwise
    {
        let bytes = std::fs::read(dir.join("02_padded_edge.npy"))
            .unwrap_or_else(|e| panic!("{name}/02: {e}"));
        let (want, shape) = parse_npy_f32(&bytes);
        let got = &stages.padded_edge;
        assert_eq!(shape, vec![got.h, got.w], "02: golden shape mismatch");
        let got_bits: Vec<u32> = got.data.iter().map(|v| v.to_bits()).collect();
        let want_bits: Vec<u32> = want.iter().map(|v| v.to_bits()).collect();
        results[1] = report_mismatch(&name, "02_pad", &got_bits, &want_bits, got.w);
    }

    // 03 is an input; sanity-check it: one tile per model tile, values {0,1}
    results[2] = {
        let ok_count = n_tiles == stages.num_model_tiles;
        let ok_vals = b03.iter().all(|&v| v <= 1);
        if !ok_count {
            println!(
                "{name}/03_in: golden has {n_tiles} tiles but the model tiler makes {}",
                stages.num_model_tiles
            );
        }
        if !ok_vals {
            println!("{name}/03_in: boundary tiles not binary");
        }
        ok_count && ok_vals
    };

    // 04/05: merged boundary + seg padding
    results[3] = compare_u8(dir, "04_merged_boundary", "04_bnd", &stages.merged_boundary);
    results[4] = compare_u8(dir, "05_seg_padded", "05_segp", &stages.seg_padded);

    // 06: per-tile segs, [M, 512, 512] i32
    {
        let (want, shape) = load_npy_i32(&dir.join("06_tile_segs.npy"));
        let m = stages.tile_segs.len();
        assert_eq!(
            shape,
            vec![m, tiled::TILE_SIZE, tiled::TILE_SIZE],
            "06: golden shape mismatch"
        );
        let mut ok = true;
        for (i, tile) in stages.tile_segs.iter().enumerate() {
            let want_tile = &want[i * th * tw..(i + 1) * th * tw];
            if tile.data != want_tile {
                ok &= report_mismatch(
                    &name,
                    &format!("06_tseg[tile {i}]"),
                    &tile.data,
                    want_tile,
                    tile.w,
                );
            }
        }
        results[5] = ok;
    }

    // 07: border samples (npz keys top/bottom/left/right)
    {
        let entries = read_npz(&dir.join("07_borders.npz"));
        let mut ok = true;
        for (key, got) in [
            ("top", &stages.borders.top),
            ("bottom", &stages.borders.bottom),
            ("left", &stages.borders.left),
            ("right", &stages.borders.right),
        ] {
            let bytes = entries
                .iter()
                .find(|(n, _)| n == &format!("{key}.npy"))
                .unwrap_or_else(|| panic!("{name}/07: npz missing {key}"));
            let (want, shape) = parse_npy_i32(&bytes.1);
            assert_eq!(shape, vec![got.rows, got.cols], "07/{key}: shape mismatch");
            ok &= report_mismatch(&name, &format!("07_bord[{key}]"), &got.data, &want, got.cols);
        }
        results[6] = ok;
    }

    // 08: connected-component labels (1-D, len max_seg_id)
    {
        let (want, shape) = load_npy_i32(&dir.join("08_n_labels.npy"));
        assert_eq!(shape, vec![stages.max_seg_id], "08: golden shape mismatch");
        results[7] = report_mismatch(&name, "08_cc", &stages.n_labels, &want, shape[0]);
    }

    // 09: unmerged seg (u32)
    {
        let (want, shape) = load_npy_u32(&dir.join("09_unmerged.npy"));
        let got = &stages.unmerged;
        assert_eq!(shape, vec![got.h, got.w], "09: golden shape mismatch");
        results[8] = report_mismatch(&name, "09_unm", &got.data, &want, got.w);
    }

    // 10: n_labels[unmerged] (i32)
    {
        let (want, shape) = load_npy_i32(&dir.join("10_merged.npy"));
        let got = &stages.merged;
        assert_eq!(shape, vec![got.h, got.w], "10: golden shape mismatch");
        results[9] = report_mismatch(&name, "10_mrg", &got.data, &want, got.w);
    }

    // 11/12: relabeled u8 + uncropped boundary, at original size
    results[10] = compare_u8(dir, "11_final", "11_fin", &stages.final_labels);
    results[11] = compare_u8(dir, "12_boundary_final", "12_bfin", &stages.boundary_final);

    // meta.json cross-checks
    {
        let mut ok = true;
        let mut check = |what: &str, got: String, want: String| {
            if got != want {
                println!("{name}/meta: {what}: got {got} want {want}");
                ok = false;
            }
        };
        check(
            "orig_shape",
            format!("{:?}", (alpha.h, alpha.w)),
            format!("{:?}", (musize(&meta["orig_shape"][0]), musize(&meta["orig_shape"][1]))),
        );
        check(
            "vert_pad_dims",
            format!("{:?}", stages.vert_pad),
            format!("{:?}", mpair(&meta["vert_pad_dims"])),
        );
        check(
            "horiz_pad_dims",
            format!("{:?}", stages.horiz_pad),
            format!("{:?}", mpair(&meta["horiz_pad_dims"])),
        );
        check(
            "model_tiler_padding",
            format!("{:?}", stages.model_padding),
            format!(
                "{:?}",
                [mpair(&meta["model_tiler_padding"][0]), mpair(&meta["model_tiler_padding"][1])]
            ),
        );
        check(
            "seg_tiler_padding",
            format!("{:?}", stages.seg_padding),
            format!(
                "{:?}",
                [mpair(&meta["seg_tiler_padding"][0]), mpair(&meta["seg_tiler_padding"][1])]
            ),
        );
        check(
            "num_model_tiles",
            stages.num_model_tiles.to_string(),
            musize(&meta["num_model_tiles"]).to_string(),
        );
        check(
            "num_seg_tiles",
            stages.num_seg_tiles.to_string(),
            musize(&meta["num_seg_tiles"]).to_string(),
        );
        check(
            "max_seg_id",
            stages.max_seg_id.to_string(),
            musize(&meta["max_seg_id"]).to_string(),
        );
        check(
            "border_deltas",
            format!("{:?}", stages.border_deltas),
            format!("{:?}", mpair(&meta["border_deltas"])),
        );
        check(
            "num_labels",
            stages.num_labels.to_string(),
            musize(&meta["num_labels"]).to_string(),
        );
        results[12] = ok;
    }

    (results, secs, stages)
}

// ---------------------------------------------------------------------------
// comparison

fn report_mismatch<T: std::fmt::Display + PartialEq>(
    name: &str,
    stage: &str,
    got: &[T],
    want: &[T],
    w: usize,
) -> bool {
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

fn compare_u8(dir: &Path, file_stem: &str, stage: &str, got: &Gray) -> bool {
    let name = dir.file_name().unwrap().to_string_lossy();
    let (data, shape) = load_npy_u8(&dir.join(format!("{file_stem}.npy")));
    assert_eq!(shape, vec![got.h, got.w], "{file_stem}: golden shape mismatch");
    report_mismatch(&name, stage, &got.data, &data, got.w)
}

// ---------------------------------------------------------------------------
// stretch: ONNX UDF cross-check (report-only)

/// `GapCloser.forward` constants: udf_denormalized = udf_normalized *
/// udf_max_dist, thresholded at udf_threshold (production checkpoint:
/// max_dist 10.0, threshold 1.0).
const UDF_MAX_DIST: f32 = 10.0;
const UDF_THRESHOLD: f32 = 1.0;
const ONNX_INPUT: &str = "tiles";

fn load_onnx(path: &Path) -> ort::session::Session {
    use ort::execution_providers::CPUExecutionProvider;
    let session = (|| {
        ort::session::Session::builder()?
            .with_execution_providers([CPUExecutionProvider::default().build()])?
            .commit_from_file(path)
    })()
    .unwrap_or_else(|e| panic!("cannot load {}: {e}", path.display()));
    println!("ONNX UDF loaded from {} (CPU EP)", path.display());
    session
}

/// The stage-02 model tiles for a drawing, checked against golden 03's count.
fn model_tiles(stages: &GapCloseStages, n_golden: usize) -> Vec<PlaneF32> {
    let overlap = (tiled::TILE_SIZE as f64 * tiled::OVERLAP_FACTOR) as usize;
    let tiler = Tiler::new(
        [stages.padded_edge.h, stages.padded_edge.w],
        [tiled::TILE_SIZE, tiled::TILE_SIZE],
        [overlap, overlap],
    );
    assert_eq!(tiler.n_tiles(), n_golden, "model tile count mismatch");
    (0..n_golden)
        .map(|tile_id| tiler.get_tile_f32(&stages.padded_edge, tile_id))
        .collect()
}

/// Replays `GapCloser.forward`'s boundary computation with the ONNX model
/// (one tile per forward, CPU EP) and counts pixels differing from golden 03.
fn report_onnx_flips(dir: &Path, stages: &GapCloseStages, session: &mut ort::session::Session) {
    let (b03, shape) = load_npy_u8(&dir.join("03_tile_boundary.npy"));
    let (n, th, tw) = (shape[0], shape[1], shape[2]);
    let tiles = model_tiles(stages, n);

    let t0 = Instant::now();
    let udfs: Vec<Vec<f32>> = tiles
        .iter()
        .map(|tile| {
            // ONNX UDF forward on [1, 1, 512, 512]
            let tensor = ort::value::Tensor::from_array(([1usize, 1, th, tw], tile.data.clone()))
                .expect("tensor");
            let outputs = session
                .run(ort::inputs![ONNX_INPUT => tensor])
                .expect("onnx forward");
            let first_output = outputs.iter().next().expect("no outputs").1;
            let (_, udf) = first_output
                .try_extract_tensor::<f32>()
                .expect("f32 output");
            udf.to_vec()
        })
        .collect();
    report_flips(dir, "onnx", &b03, (n, th, tw), &tiles, &udfs, t0.elapsed().as_secs_f64());
}

/// Same flip count, but the UDFs come from the PRODUCTION serving path:
/// `Engine::run_gap_udfs` on the batch-pinned CoreML export.
fn report_coreml_flips(dir: &Path, stages: &GapCloseStages, engine: &Engine) {
    let name = dir.file_name().unwrap().to_string_lossy();
    let (b03, shape) = load_npy_u8(&dir.join("03_tile_boundary.npy"));
    let (n, th, tw) = (shape[0], shape[1], shape[2]);
    let tiles = model_tiles(stages, n);

    let t0 = Instant::now();
    let udfs = match engine.run_gap_udfs(&tiles) {
        Ok(Some(udfs)) => udfs,
        Ok(None) => {
            println!("{name}/coreml: no udfs (CoreML failed and no CPU fallback model)");
            return;
        }
        Err(e) => {
            println!("{name}/coreml: FAILED: {e}");
            return;
        }
    };
    report_flips(dir, "coreml", &b03, (n, th, tw), &tiles, &udfs, t0.elapsed().as_secs_f64());
}

/// boundary_binary = (udf * max_dist < threshold); combined with
/// 1 - binarize((tile * 255).astype(np.uint8)) / 255  (line.py's 2-D
/// branch is im = 255 - img, which binarize_adaptive_mean applies)
fn report_flips(
    dir: &Path,
    label: &str,
    b03: &[u8],
    (n, th, tw): (usize, usize, usize),
    tiles: &[PlaneF32],
    udfs: &[Vec<f32>],
    secs: f64,
) {
    let name = dir.file_name().unwrap().to_string_lossy();
    let mut total_flips = 0usize;
    let mut worst_tile = (0usize, 0usize); // (tile_id, flips)
    for (tile_id, (tile, udf)) in tiles.iter().zip(udfs.iter()).enumerate() {
        let mut img_u8 = Gray::new(tw, th, 0);
        for (dst, &v) in img_u8.data.iter_mut().zip(tile.data.iter()) {
            *dst = (v * 255.0) as u8;
        }
        let binary = binarize::binarize_adaptive_mean(&img_u8);

        let golden = &b03[tile_id * th * tw..(tile_id + 1) * th * tw];
        let mut flips = 0usize;
        for i in 0..th * tw {
            let from_udf = (udf[i] * UDF_MAX_DIST < UDF_THRESHOLD) as u8;
            let from_binarize = 1 - binary.data[i] / 255;
            let combined = from_udf.max(from_binarize);
            flips += (combined != golden[i]) as usize;
        }
        total_flips += flips;
        if flips > worst_tile.1 {
            worst_tile = (tile_id, flips);
        }
    }
    println!(
        "{name}/{label}: {total_flips} boundary flips vs golden 03 over {n} tiles ({} px, {:.4}%), worst tile {} with {}; {:.2}s",
        n * th * tw,
        100.0 * total_flips as f64 / (n * th * tw) as f64,
        worst_tile.0,
        worst_tile.1,
        secs,
    );
}
