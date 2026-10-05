//! Startup hardware report for field debugging.
//!
//! Users send Debug Log screenshots when things go wrong, so the sidecar logs
//! everything that decides how it will run: CPU model and the instruction-set
//! extensions ONNX Runtime's kernels dispatch on, and (Windows) every DXGI
//! adapter with vendor, memory and driver version, plus which one the
//! DirectML EP will pick under the high-performance preference.
//!
//! Everything here is best-effort: a diagnostics failure logs a warning and
//! never stops the server.

/// Log the full startup report. Call once, right after tracing is set up.
pub fn log_startup_report() {
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        logical_cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "cadmium-sidecar starting"
    );
    log_cpu();
    log_gpus();
}

#[cfg(target_arch = "x86_64")]
fn log_cpu() {
    let brand = cpu_brand().unwrap_or_else(|| "unknown".into());
    let has = |f: bool| if f { "yes" } else { "NO" };
    let avx = std::is_x86_feature_detected!("avx");
    let avx2 = std::is_x86_feature_detected!("avx2");
    tracing::info!(
        cpu = %brand,
        sse4_1 = has(std::is_x86_feature_detected!("sse4.1")),
        sse4_2 = has(std::is_x86_feature_detected!("sse4.2")),
        avx = has(avx),
        avx2 = has(avx2),
        fma = has(std::is_x86_feature_detected!("fma")),
        f16c = has(std::is_x86_feature_detected!("f16c")),
        avx512f = has(std::is_x86_feature_detected!("avx512f")),
        "cpu"
    );
    if !avx || !avx2 {
        tracing::warn!(
            avx = has(avx),
            avx2 = has(avx2),
            "this CPU lacks AVX/AVX2 — CPU inference will be slow, and parts of \
             ONNX Runtime may not run on it at all"
        );
    }
}

/// CPUID brand string (leaves 0x80000002..=0x80000004), e.g.
/// "Intel(R) Celeron(R) N4020 CPU @ 1.10GHz".
#[cfg(target_arch = "x86_64")]
fn cpu_brand() -> Option<String> {
    use std::arch::x86_64::__cpuid;
    let max_ext = __cpuid(0x8000_0000).eax;
    if max_ext < 0x8000_0004 {
        return None;
    }
    let mut bytes = Vec::with_capacity(48);
    for leaf in 0x8000_0002u32..=0x8000_0004 {
        let r = __cpuid(leaf);
        for reg in [r.eax, r.ebx, r.ecx, r.edx] {
            bytes.extend_from_slice(&reg.to_le_bytes());
        }
    }
    let s = String::from_utf8_lossy(&bytes);
    let s = s.trim_matches(char::from(0)).trim();
    (!s.is_empty()).then(|| s.to_string())
}

#[cfg(not(target_arch = "x86_64"))]
fn log_cpu() {
    tracing::info!(arch = std::env::consts::ARCH, "cpu (non-x86; no feature report)");
}

#[cfg(target_os = "windows")]
fn log_gpus() {
    if let Err(e) = windows_gpus::log_adapters() {
        tracing::warn!(error = %e, "gpu: DXGI adapter enumeration failed");
    }
}

#[cfg(not(target_os = "windows"))]
fn log_gpus() {}

/// Microsoft's Basic Render Driver (vendor 0x1414) is a software/display-only
/// adapter: DirectML "works" on it but renders in software.
pub fn is_real_gpu(vendor_id: u32, software_flag: bool) -> bool {
    !software_flag && vendor_id != 0x1414
}

/// Windows: whether any real (hardware, non-Microsoft) GPU adapter exists.
/// None when it can't be determined (non-Windows, or DXGI failed) — callers
/// keep their default plan then.
pub fn windows_has_hardware_gpu() -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        windows_gpus::has_hardware_gpu()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Pack a DXGI user-mode driver version (four 16-bit fields, high to low)
/// into the dotted form Windows shows in Device Manager.
pub fn format_driver_version(v: i64) -> String {
    let v = v as u64;
    format!("{}.{}.{}.{}", (v >> 48) & 0xFFFF, (v >> 32) & 0xFFFF, (v >> 16) & 0xFFFF, v & 0xFFFF)
}

/// Readable GPU vendor from a PCI vendor id.
pub fn vendor_name(id: u32) -> &'static str {
    match id {
        0x10de => "NVIDIA",
        0x1002 | 0x1022 => "AMD",
        0x8086 => "Intel",
        0x1414 => "Microsoft",
        0x5143 => "Qualcomm",
        _ => "unknown",
    }
}

#[cfg(target_os = "windows")]
mod windows_gpus {
    use super::{format_driver_version, is_real_gpu, vendor_name};
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory6, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
    };

    pub fn log_adapters() -> windows::core::Result<()> {
        // SAFETY: plain COM factory/adapter queries; no aliasing concerns.
        unsafe {
            let factory: IDXGIFactory6 = CreateDXGIFactory1()?;

            // What the pre-fix default (adapter 0 in plain enumeration order)
            // would have used — logged so before/after reports compare.
            let default_name = factory
                .EnumAdapters1(0)
                .and_then(|a| a.GetDesc1())
                .map(|d| utf16_name(&d.Description))
                .unwrap_or_else(|_| "?".into());

            let mut picked = false;
            let mut count = 0u32;
            for i in 0.. {
                let adapter: IDXGIAdapter1 =
                    match factory.EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE) {
                        Ok(a) => a,
                        Err(_) => break,
                    };
                count += 1;
                let desc = adapter.GetDesc1()?;
                let software = desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0;
                let driver = adapter
                    .CheckInterfaceSupport(&IDXGIDevice::IID)
                    .map(format_driver_version)
                    .unwrap_or_else(|_| "?".into());
                let dml_pick = is_real_gpu(desc.VendorId, software) && !picked;
                picked |= dml_pick;
                tracing::info!(
                    index = i,
                    name = %utf16_name(&desc.Description),
                    vendor = vendor_name(desc.VendorId),
                    vendor_id = format!("0x{:04x}", desc.VendorId),
                    device_id = format!("0x{:04x}", desc.DeviceId),
                    dedicated_vram_mb = desc.DedicatedVideoMemory / (1024 * 1024),
                    shared_mem_mb = desc.SharedSystemMemory / (1024 * 1024),
                    driver = %driver,
                    software,
                    directml = if dml_pick { "<- DirectML uses this" } else { "" },
                    "gpu adapter (high-performance order)"
                );
            }
            tracing::info!(adapters = count, plain_default = %default_name, "gpu: enumeration done");
            if !picked {
                tracing::warn!(
                    "gpu: no hardware GPU found (only Microsoft Basic Render Driver / software \
                     adapters) — the backend will run on the CPU"
                );
            }
        }
        Ok(())
    }

    pub fn has_hardware_gpu() -> Option<bool> {
        // SAFETY: plain COM factory/adapter queries.
        unsafe {
            let factory: IDXGIFactory6 = CreateDXGIFactory1().ok()?;
            for i in 0.. {
                let Ok(adapter) = factory.EnumAdapters1(i) else { break };
                let Ok(desc) = adapter.GetDesc1() else { continue };
                let software = desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0;
                if is_real_gpu(desc.VendorId, software) {
                    return Some(true);
                }
            }
            Some(false)
        }
    }

    fn utf16_name(raw: &[u16]) -> String {
        let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        String::from_utf16_lossy(&raw[..end]).trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_version_matches_device_manager_format() {
        // 31.0.15.5222 — a typical NVIDIA DCH driver.
        let v: i64 = (31 << 48) | (0 << 32) | (15 << 16) | 5222;
        assert_eq!(format_driver_version(v), "31.0.15.5222");
    }

    #[test]
    fn basic_render_driver_is_not_a_real_gpu() {
        assert!(!is_real_gpu(0x1414, false)); // Basic Render Driver (hardware-flagged)
        assert!(!is_real_gpu(0x10de, true)); // anything software-flagged
        assert!(is_real_gpu(0x8086, false)); // Intel iGPU counts
        assert!(is_real_gpu(0x10de, false));
    }

    #[test]
    fn vendor_names() {
        assert_eq!(vendor_name(0x10de), "NVIDIA");
        assert_eq!(vendor_name(0x8086), "Intel");
        assert_eq!(vendor_name(0xdead), "unknown");
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn cpu_brand_is_readable() {
        if let Some(b) = cpu_brand() {
            assert!(!b.contains('\0'));
        }
    }
}
