//! End-to-end golden verification for the sidecar HTTP contract.
//!
//! Usage:
//!   cargo run --release --bin verify_http -- <http_goldens_root> \
//!       --ant-model <ant_v2.onnx> --gap-model <gap_closer.onnx> \
//!       [--ep auto|cpu|coreml|dml] [--ant-model-bucket <ant_v2_bucket.onnx>]
//!
//! `--ep`/`--ant-model-bucket` pass straight through to the engine, so the
//! same 36-step golden matrix gates every execution provider (run it once
//! per EP; `--ep coreml` needs the CORPUS_BUCKET-pinned model).
//!
//! Replays every request recorded by `serving/tools/dump_http_goldens.py` from the
//! production CUDA server (ref_f*/ segment+preprocess, gapclose_f*/ segment
//! at strength 1.0, pair_f*/ segment+colorize) against the sidecar router
//! IN-PROCESS (tower::ServiceExt::oneshot — no sockets) and diffs each
//! response against the recorded one:
//!
//!   - fields listed in meta.json `compare_skip` are ignored (the colorized
//!     seg map uses an unseeded-random colormap in production);
//!   - `data:image/png` string fields compare by DECODED pixels (PNG encoder
//!     bytes legitimately differ) plus channel count, so a grayscale map
//!     silently re-encoded as RGBA would still fail;
//!   - every other field must be exactly equal (serde_json::Value equality),
//!     and the key sets must match.
//!
//! Prints a per-step PASS/FAIL matrix with first-mismatch detail, a
//! per-route timing summary, and exits nonzero on any failure.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{header, Method, Request};
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;

use cadmium_sidecar::serve::engine::{Engine, EpSelect};
use cadmium_sidecar::serve::{self, codec};

#[tokio::main]
async fn main() -> ExitCode {
    // Surface the engine's session/compile-time logs (CoreML build + first
    // forward) without ORT's per-transformer chatter.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn,cadmium_sidecar::serve::engine=info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut root: Option<PathBuf> = None;
    let mut ant_model: Option<PathBuf> = None;
    let mut ant_model_bucket: Option<PathBuf> = None;
    let mut gap_model: Option<PathBuf> = None;
    let mut ep = EpSelect::Auto;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--ant-model" => ant_model = Some(PathBuf::from(it.next().expect("--ant-model path"))),
            "--ant-model-bucket" => {
                ant_model_bucket = Some(PathBuf::from(it.next().expect("--ant-model-bucket path")))
            }
            "--gap-model" => gap_model = Some(PathBuf::from(it.next().expect("--gap-model path"))),
            "--ep" => {
                ep = it
                    .next()
                    .expect("--ep value")
                    .parse()
                    .unwrap_or_else(|e| panic!("--ep: {e}"))
            }
            _ => root = Some(PathBuf::from(a)),
        }
    }
    let Some(root) = root else {
        eprintln!(
            "usage: verify_http <http_goldens_root> --ant-model <ant.onnx> --gap-model <gap.onnx> \
             [--ep auto|cpu|coreml|dml] [--ant-model-bucket <bucket.onnx>]"
        );
        return ExitCode::from(2);
    };

    let meta: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("meta.json")).expect("meta.json"),
    )
    .expect("meta.json parse");
    let compare_skip: Vec<String> = meta["compare_skip"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    // verify_http never exercises the DirectML tiled fast path (it gates the
    // CPU/CoreML goldens), so no tiled model.
    let engine = match Engine::new(gap_model, ant_model, ant_model_bucket, None, ep) {
        Ok(e) => Arc::new(e),
        Err(e) => {
            eprintln!("engine: {e}");
            return ExitCode::from(2);
        }
    };
    println!("AnT execution provider: {}", engine.ant_ep_name());
    let app = serve::router(engine);

    // step discovery: (dir, stem, route)
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", root.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let mut steps: Vec<(PathBuf, &'static str, &'static str)> = Vec::new();
    for dir in &dirs {
        let name = dir.file_name().unwrap().to_string_lossy();
        if name.starts_with("ref_") {
            steps.push((dir.clone(), "segment", "/segment"));
            steps.push((dir.clone(), "preprocess", "/preprocess"));
        } else if name.starts_with("gapclose_") {
            steps.push((dir.clone(), "segment", "/segment"));
        } else if name.starts_with("pair_") {
            steps.push((dir.clone(), "segment", "/segment"));
            steps.push((dir.clone(), "colorize", "/colorize"));
        }
    }
    if steps.is_empty() {
        eprintln!("no golden step directories under {}", root.display());
        return ExitCode::from(2);
    }

    let mut matrix: Vec<(String, &str, bool, f64)> = Vec::new();
    let mut all_pass = true;
    for (dir, stem, route) in &steps {
        let label = format!("{}/{stem}", dir.file_name().unwrap().to_string_lossy());
        let (ok, secs) = run_step(&app, dir, stem, route, &compare_skip).await;
        all_pass &= ok;
        matrix.push((label, route, ok, secs));
    }

    println!();
    println!("{:32} {:>12} {:>8} {:>9}", "step", "route", "result", "time");
    for (label, route, ok, secs) in &matrix {
        println!(
            "{:32} {:>12} {:>8} {:>8.3}s",
            label,
            route,
            if *ok { "PASS" } else { "FAIL" },
            secs
        );
    }

    // per-route timing summary (the pair_*/segment steps are strength-0
    // trapped-ball; gapclose_*/segment are the ML path — split them)
    println!();
    for (what, filter) in [
        ("/segment (strength 0)", "seg0"),
        ("/segment (gap close)", "seg1"),
        ("/preprocess", "pre"),
        ("/colorize", "col"),
    ] {
        let times: Vec<f64> = matrix
            .iter()
            .filter(|(label, route, _, _)| match filter {
                "seg0" => *route == "/segment" && !label.starts_with("gapclose_"),
                "seg1" => *route == "/segment" && label.starts_with("gapclose_"),
                "pre" => *route == "/preprocess",
                "col" => *route == "/colorize",
                _ => unreachable!(),
            })
            .map(|(_, _, _, s)| *s)
            .collect();
        if times.is_empty() {
            continue;
        }
        let (min, max) = (
            times.iter().cloned().fold(f64::INFINITY, f64::min),
            times.iter().cloned().fold(0.0, f64::max),
        );
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        println!(
            "{what:24} n={:<3} mean {mean:7.3}s  min {min:7.3}s  max {max:7.3}s",
            times.len()
        );
    }

    println!();
    if all_pass {
        println!("all {} golden steps green", matrix.len());
        ExitCode::SUCCESS
    } else {
        println!("MISMATCHES FOUND");
        ExitCode::FAILURE
    }
}

async fn run_step(
    app: &Router,
    dir: &Path,
    stem: &str,
    route: &str,
    compare_skip: &[String],
) -> (bool, f64) {
    let name = format!("{}/{stem}", dir.file_name().unwrap().to_string_lossy());
    let req_bytes = std::fs::read(dir.join(format!("{stem}_req.json")))
        .unwrap_or_else(|e| panic!("{name}: req: {e}"));
    let want: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(format!("{stem}_resp.json")))
            .unwrap_or_else(|e| panic!("{name}: resp: {e}")),
    )
    .unwrap_or_else(|e| panic!("{name}: resp parse: {e}"));

    let request = Request::builder()
        .method(Method::POST)
        .uri(route)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(req_bytes))
        .expect("request build");

    let t0 = Instant::now();
    let response = app
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|e| panic!("{name}: router error: {e}"));
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body collect")
        .to_bytes();
    let secs = t0.elapsed().as_secs_f64();

    if !status.is_success() {
        println!(
            "{name}: HTTP {status}: {}",
            String::from_utf8_lossy(&body[..body.len().min(400)])
        );
        return (false, secs);
    }
    let got: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            println!("{name}: response is not JSON: {e}");
            return (false, secs);
        }
    };

    (compare_objects(&name, &got, &want, compare_skip), secs)
}

// ---------------------------------------------------------------------------
// comparison

fn compare_objects(
    name: &str,
    got: &serde_json::Value,
    want: &serde_json::Value,
    skip: &[String],
) -> bool {
    let (Some(got), Some(want)) = (got.as_object(), want.as_object()) else {
        println!("{name}: response bodies must be JSON objects");
        return false;
    };

    let mut ok = true;
    let mut keys: Vec<&String> = got.keys().chain(want.keys()).collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        if skip.iter().any(|s| s == key) {
            continue;
        }
        match (got.get(key), want.get(key)) {
            (Some(g), Some(w)) => {
                let is_image = g.as_str().map(|s| s.starts_with("data:image")).unwrap_or(false)
                    || w.as_str().map(|s| s.starts_with("data:image")).unwrap_or(false);
                if is_image {
                    ok &= compare_image_field(name, key, g, w);
                } else if g != w {
                    println!(
                        "{name}: field `{key}` differs:\n  got:  {}\n  want: {}",
                        preview(g),
                        preview(w)
                    );
                    ok = false;
                }
            }
            (Some(_), None) => {
                println!("{name}: unexpected extra field `{key}`");
                ok = false;
            }
            (None, Some(_)) => {
                println!("{name}: missing field `{key}`");
                ok = false;
            }
            (None, None) => unreachable!("key came from one of the two objects"),
        }
    }
    ok
}

fn preview(v: &serde_json::Value) -> String {
    let s = v.to_string();
    if s.len() > 160 {
        format!("{}… ({} chars)", &s[..160], s.len())
    } else {
        s
    }
}

/// Decode both data URIs and compare (channels, size, RGBA-normalized
/// pixels). Both null is equal; null vs string is a mismatch.
fn compare_image_field(
    name: &str,
    key: &str,
    got: &serde_json::Value,
    want: &serde_json::Value,
) -> bool {
    match (got.as_str(), want.as_str()) {
        (None, None) => got == want,
        (Some(g), Some(w)) => {
            let dg = match codec::decode_png_uri(g, false) {
                Ok(d) => d,
                Err(e) => {
                    println!("{name}: `{key}`: our PNG failed to decode: {e}");
                    return false;
                }
            };
            let dw = match codec::decode_png_uri(w, false) {
                Ok(d) => d,
                Err(e) => {
                    println!("{name}: `{key}`: golden PNG failed to decode: {e}");
                    return false;
                }
            };
            if (dg.w, dg.h, dg.channels) != (dw.w, dw.h, dw.channels) {
                println!(
                    "{name}: `{key}`: shape {}x{}x{} vs golden {}x{}x{}",
                    dg.w, dg.h, dg.channels, dw.w, dw.h, dw.channels
                );
                return false;
            }
            if dg.data == dw.data {
                return true;
            }
            let c = dg.channels;
            let total = dg
                .data
                .iter()
                .zip(&dw.data)
                .filter(|(a, b)| a != b)
                .count();
            let i = dg.data.iter().zip(&dw.data).position(|(a, b)| a != b).unwrap();
            let px = i / c;
            println!(
                "{name}: `{key}`: {total} differing bytes; first at ({}, {}) channel {}: got {} want {}",
                px % dg.w,
                px / dg.w,
                i % c,
                dg.data[i],
                dw.data[i]
            );
            false
        }
        _ => {
            println!(
                "{name}: `{key}`: null-ness differs (got {}, want {})",
                preview(got),
                preview(want)
            );
            false
        }
    }
}
