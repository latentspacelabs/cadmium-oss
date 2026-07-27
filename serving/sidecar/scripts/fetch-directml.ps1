<#
Fetch the DirectML runtime DLL the Windows sidecar loads at runtime.

The sidecar links pyke's static ORT 1.24 with the DirectML EP, which dlopens
DirectML.dll at runtime. Windows ships a system DirectML (1.4.0 on the Server
2022 image, from 2020) that is too old to create sessions for our fp16 gap /
tiled colorize models: session creation fails with 887A0004
(DXGI_ERROR_UNSUPPORTED, "feature level not supported") and the sidecar silently
falls back to the CPU EP. So we ship Microsoft's modern DirectML redistributable
next to cadmium-sidecar.exe; the executable's own directory is searched before
System32, so the bundled DLL wins. This mirrors the macOS libonnxruntime dylib
(scripts/fetch-ort-dylib.sh + src/ort_dylib.rs).

Output: serving/sidecar/vendor/DirectML.dll (gitignored).
Packaging copies it from there (app/vue.config.js win extraResources).
#>
$ErrorActionPreference = 'Stop'

# The DirectML redistributable version. 1.15.4 is the build Microsoft's
# onnxruntime-directml 1.24.x wheel bundles, and the version validated on the
# T4 rig (segment.active flips cpu -> dml). A bump edits both lines here.
$DIRECTML_VERSION = '1.15.4'
$SHA256 = '9C9E6D822561C6C41B90E6994B3E8857CF1D66DBFB1E0C4C799C7C89B4E92DA1'

$vendor = Join-Path (Join-Path $PSScriptRoot '..') 'vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$dll = Join-Path $vendor 'DirectML.dll'

if ((Test-Path $dll) -and ((Get-FileHash $dll -Algorithm SHA256).Hash -eq $SHA256)) {
    Write-Output "$dll already present and verified"
    exit 0
}

# Invoke-WebRequest renders a progress UI that throttles large downloads ~100x.
$ProgressPreference = 'SilentlyContinue'
$url = "https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/$DIRECTML_VERSION/microsoft.ai.directml.$DIRECTML_VERSION.nupkg"
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "dml-$DIRECTML_VERSION")
$nupkg = Join-Path $tmp 'dml.nupkg'
Write-Output "fetching $url"
Invoke-WebRequest -Uri $url -OutFile $nupkg

# .nupkg is a zip; the x64 Windows redistributable lives at bin/x64-win/.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'bin/x64-win/DirectML.dll' }
    if (-not $entry) { throw "bin/x64-win/DirectML.dll not found in $url" }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dll, $true)
} finally {
    $zip.Dispose()
}

$got = (Get-FileHash $dll -Algorithm SHA256).Hash
if ($got -ne $SHA256) { throw "DirectML.dll sha256 mismatch: got $got expected $SHA256" }
Write-Output "fetched $dll (DirectML $DIRECTML_VERSION, sha256 verified)"
