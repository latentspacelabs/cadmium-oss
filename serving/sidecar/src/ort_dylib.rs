//! Locating the ONNX Runtime dylib on macOS (`ort`'s `load-dynamic` feature).
//!
//! The newest `ort` crate release statically links ORT 1.24.2, but ORT >= 1.25
//! executes CoreML conv graphs ~3x faster (M3: GapCloser batch-24 ~5s -> 1.26s,
//! AnT bucket forward ~1.9s -> 0.7s). So the macOS build dlopens Microsoft's
//! official dylib instead of linking pyke's static binary.
//!
//! Search order:
//!   1. `ORT_DYLIB_PATH` env var (the `ort` crate's own convention — set by
//!      the Electron sidecar-manager in packaged builds, or by hand);
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
    if std::env::var("ORT_DYLIB_PATH").map(|v| !v.is_empty()).unwrap_or(false) {
        return Ok(()); // ort reads the env var itself on first use
    }
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .parent()
        .ok_or("executable has no parent directory")?
        .to_path_buf();
    let dylib = std::fs::read_dir(&exe_dir)
        .map_err(|e| format!("read_dir {}: {e}", exe_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("libonnxruntime") && n.ends_with(".dylib"))
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            format!(
                "no libonnxruntime*.dylib next to {} and ORT_DYLIB_PATH unset \
                 (run serving/sidecar/scripts/fetch-ort-dylib.sh and copy the \
                 vendor/ dylib next to the binary)",
                exe_dir.display()
            )
        })?;
    // Safe to set: we are single-threaded at process start (called from main
    // before tokio / any session threads spawn).
    std::env::set_var("ORT_DYLIB_PATH", &dylib);
    tracing::info!(dylib = %dylib.display(), "ONNX Runtime dylib resolved");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn init() -> Result<(), String> {
    Ok(())
}
