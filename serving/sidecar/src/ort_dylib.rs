//! Locating the ONNX Runtime dylib on macOS (`ort`'s `load-dynamic` feature).
//!
//! The newest `ort` crate release statically links ORT 1.24.2, but ORT >= 1.25
//! executes CoreML conv graphs ~3x faster (M3: GapCloser batch-24 ~5s -> 1.26s,
//! AnT bucket forward ~1.9s -> 0.7s). So the macOS build dlopens Microsoft's
//! official dylib instead of linking pyke's static binary.
//!
//! Search order:
//!   1. `ORT_DYLIB_PATH` env var (the `ort` crate's own convention) if set —
//!      an escape hatch for hand-rolled runs; nothing in Cadmium sets it;
//!   2. `libonnxruntime.*.dylib` next to the current executable (dev builds:
//!      `scripts/fetch-ort-dylib.sh` + a copy into target/release; packaged
//!      builds: extraResources lands it next to the sidecar binary).
//!
//! Must run before any `ort` API call — `ort` panics if its lazy dlopen
//! fails, so `init()` resolves the path up front and reports a readable
//! error instead.

/// Resolve and load the ORT dylib. Call once at process start, before any
/// session is built. No-op on non-macOS targets (they link statically).
#[cfg(target_os = "macos")]
pub fn init() -> Result<(), String> {
    // An externally-set ORT_DYLIB_PATH wins — hand it straight to ort. Nothing
    // in Cadmium sets it (packaged builds rely on the sibling-glob below); it is
    // an escape hatch for hand-rolled runs. This is a read, never a set: we
    // don't mutate the environment (unsound once tokio's worker threads exist).
    if let Some(path) = std::env::var_os("ORT_DYLIB_PATH")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
    {
        return load(&path);
    }
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .parent()
        .ok_or("executable has no parent directory")?
        .to_path_buf();
    // Directory iteration order is unspecified, so collect every match and take
    // the lexicographically greatest name — for `libonnxruntime.<ver>.dylib`
    // that is the newest version, deterministically, even if an older dylib was
    // left behind by a prior install.
    let mut matches: Vec<std::path::PathBuf> = std::fs::read_dir(&exe_dir)
        .map_err(|e| format!("read_dir {}: {e}", exe_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("libonnxruntime") && n.ends_with(".dylib"))
                .unwrap_or(false)
        })
        .collect();
    matches.sort();
    let dylib = matches.pop().ok_or_else(|| {
        format!(
            "no libonnxruntime*.dylib next to {} and ORT_DYLIB_PATH unset \
             (run serving/sidecar/scripts/fetch-ort-dylib.sh and copy the \
             vendor/ dylib next to the binary)",
            exe_dir.display()
        )
    })?;
    load(&dylib)
}

/// Load a specific ORT dylib via `ort::init_from` (the `load-dynamic` entry
/// point) — no `ORT_DYLIB_PATH` mutation, so it is sound after tokio spawns.
/// Must run before any other `ort` API call.
#[cfg(target_os = "macos")]
fn load(dylib: &std::path::Path) -> Result<(), String> {
    ort::init_from(dylib)
        .map_err(|e| format!("failed to load ONNX Runtime dylib {}: {e}", dylib.display()))?
        .commit();
    tracing::info!(dylib = %dylib.display(), "ONNX Runtime dylib resolved");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn init() -> Result<(), String> {
    Ok(())
}
