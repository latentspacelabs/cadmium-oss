//! Locating the ONNX Runtime shared library (`ort`'s `load-dynamic` feature)
//! on macOS and Windows.
//!
//! macOS: the newest `ort` crate release statically links ORT 1.24.2, but ORT
//! >= 1.25 executes CoreML conv graphs ~3x faster (M3: GapCloser batch-24 ~5s
//! -> 1.26s, AnT bucket forward ~1.9s -> 0.7s). So the macOS build dlopens
//! Microsoft's official dylib instead of linking pyke's static binary.
//!
//! Windows: pyke's static binary is compiled assuming AVX2/BMI2 and crashed
//! at load (0xC000001D STATUS_ILLEGAL_INSTRUCTION) on every pre-Haswell CPU.
//! Microsoft's official DirectML build dispatches SIMD at runtime, so the
//! Windows build loads its `onnxruntime.dll` instead.
//!
//! Search order:
//!   1. `ORT_DYLIB_PATH` env var (the `ort` crate's own convention) if set —
//!      an escape hatch for hand-rolled runs; nothing in Cadmium sets it;
//!   2. the platform's library next to the current executable
//!      (`libonnxruntime.*.dylib` on macOS, `onnxruntime.dll` on Windows) —
//!      dev builds: the fetch script + a copy into target/…/release; packaged
//!      builds: extraResources lands it next to the sidecar binary.
//!
//! Must run before any `ort` API call — `ort` panics if its lazy load fails,
//! so `init()` resolves the path up front and reports a readable error
//! instead.

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn init() -> Result<(), String> {
    // An externally-set ORT_DYLIB_PATH wins — hand it straight to ort. This is
    // a read, never a set: we don't mutate the environment (unsound once
    // tokio's worker threads exist).
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
                .map(is_ort_library_name)
                .unwrap_or(false)
        })
        .collect();
    matches.sort();
    let lib = matches.pop().ok_or_else(|| {
        format!(
            "no ONNX Runtime library ({}) next to {} and ORT_DYLIB_PATH unset \
             (run serving/sidecar/scripts/{} and copy the vendor/ file(s) next \
             to the binary)",
            if cfg!(target_os = "windows") { "onnxruntime.dll" } else { "libonnxruntime*.dylib" },
            exe_dir.display(),
            if cfg!(target_os = "windows") { "fetch-ort-dll.ps1" } else { "fetch-ort-dylib.sh" },
        )
    })?;
    load(&lib)
}

/// Whether a file name is this platform's ONNX Runtime library.
pub fn is_ort_library_name(name: &str) -> bool {
    if cfg!(target_os = "windows") {
        // Exactly onnxruntime.dll — not onnxruntime_providers_shared.dll.
        name.eq_ignore_ascii_case("onnxruntime.dll")
    } else {
        name.starts_with("libonnxruntime") && name.ends_with(".dylib")
    }
}

/// Load a specific ORT library via `ort::init_from` (the `load-dynamic` entry
/// point) — no `ORT_DYLIB_PATH` mutation, so it is sound after tokio spawns.
/// Must run before any other `ort` API call.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load(lib: &std::path::Path) -> Result<(), String> {
    let t0 = std::time::Instant::now();
    ort::init_from(lib)
        .map_err(|e| format!("failed to load ONNX Runtime library {}: {e}", lib.display()))?
        .commit();
    tracing::info!(
        library = %lib.display(),
        load_ms = t0.elapsed().as_millis() as u64,
        "ONNX Runtime library resolved"
    );
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn init() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_ort_library_name;

    #[test]
    fn matches_only_the_runtime_library() {
        if cfg!(target_os = "windows") {
            assert!(is_ort_library_name("onnxruntime.dll"));
            assert!(is_ort_library_name("ONNXRUNTIME.DLL"));
            assert!(!is_ort_library_name("onnxruntime_providers_shared.dll"));
            assert!(!is_ort_library_name("DirectML.dll"));
        } else {
            assert!(is_ort_library_name("libonnxruntime.1.27.0.dylib"));
            assert!(!is_ort_library_name("libonnxruntime.1.27.0.dylib.dSYM"));
        }
    }
}
