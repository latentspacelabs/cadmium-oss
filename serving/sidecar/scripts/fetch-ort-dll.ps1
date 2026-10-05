<#
Fetch Microsoft's official ONNX Runtime (DirectML build) DLLs the Windows
sidecar loads at runtime (`ort` load-dynamic, located by src/ort_dylib.rs).

Why not pyke's static binary (what the `ort` crate links by default): that
prebuilt is compiled assuming AVX2/BMI2, so the sidecar died at load with
0xC000001D STATUS_ILLEGAL_INSTRUCTION on every CPU older than Haswell
(confirmed in CI under Intel SDE: Goldmont Plus/Nehalem fault on AVX `vpxor`,
Sandy Bridge on BMI2 `shlx`). Microsoft's builds dispatch SIMD kernels at
runtime, so they also run on older CPUs. This mirrors the macOS route
(scripts/fetch-ort-dylib.sh).

Version: 1.24.x — the line DirectML performance was validated on (pyke's
static binary was 1.24.2). Its NuGet package depends on DirectML 1.15.4,
which scripts/fetch-directml.ps1 already ships.

Output: serving/sidecar/vendor/onnxruntime.dll + onnxruntime_providers_shared.dll
(gitignored). Packaging copies them next to cadmium-sidecar.exe
(app/vue.config.js win extraResources).
#>
$ErrorActionPreference = 'Stop'

# A version bump edits all three lines.
$ORT_VERSION = '1.24.4'
$FILES = @{
    'onnxruntime.dll'                 = 'E7EEDEC6A6F26DC39DC948276A75EF6D2BEE3FFF944D874CEED0BBD3B97BFF40'
    'onnxruntime_providers_shared.dll' = '265C8DAF29637CB259CAC8BE9F08F2CD45F3883F0F0E4949CBFDDD5B4CBEC3B6'
}

$vendor = Join-Path (Join-Path $PSScriptRoot '..') 'vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null

$allPresent = $true
foreach ($name in $FILES.Keys) {
    $p = Join-Path $vendor $name
    if (-not ((Test-Path $p) -and ((Get-FileHash $p -Algorithm SHA256).Hash -eq $FILES[$name]))) {
        $allPresent = $false
    }
}
if ($allPresent) {
    Write-Output "ONNX Runtime $ORT_VERSION DLLs already present and verified"
    exit 0
}

# Invoke-WebRequest renders a progress UI that throttles large downloads ~100x.
$ProgressPreference = 'SilentlyContinue'
$url = "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/$ORT_VERSION/microsoft.ml.onnxruntime.directml.$ORT_VERSION.nupkg"
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "ortdml-$ORT_VERSION")
$nupkg = Join-Path $tmp 'ortdml.nupkg'
Write-Output "fetching $url"
Invoke-WebRequest -Uri $url -OutFile $nupkg

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
try {
    foreach ($name in $FILES.Keys) {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq "runtimes/win-x64/native/$name" }
        if (-not $entry) { throw "runtimes/win-x64/native/$name not found in $url" }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $vendor $name), $true)
    }
} finally {
    $zip.Dispose()
}

foreach ($name in $FILES.Keys) {
    $got = (Get-FileHash (Join-Path $vendor $name) -Algorithm SHA256).Hash
    if ($got -ne $FILES[$name]) { throw "$name sha256 mismatch: got $got expected $($FILES[$name])" }
}
Write-Output "fetched ONNX Runtime $ORT_VERSION (DirectML build) into $vendor, sha256 verified"
