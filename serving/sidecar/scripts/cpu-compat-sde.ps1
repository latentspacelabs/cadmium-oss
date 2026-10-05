# CPU-compatibility check: start the Windows sidecar under Intel SDE
# (Software Development Emulator) emulating progressively older CPUs, and
# record whether it reaches "listening" or crashes.
#
# Why: field reports showed the sidecar dying at load with 0xC000001D
# (STATUS_ILLEGAL_INSTRUCTION) before logging anything — i.e. something in
# the binary (most likely the statically linked prebuilt ONNX Runtime) uses
# instructions older CPUs lack. SDE reproduces that deterministically on a
# CI runner instead of needing the physical hardware.
#
# Policy: every emulated CPU MUST start. Since the switch to Microsoft's
# ONNX Runtime DLL (2026-10, scripts/fetch-ort-dll.ps1) the sidecar starts on
# all four, including no-AVX Celeron-class and Nehalem CPUs — so any red row
# is a regression (e.g. a dependency that starts assuming AVX/AVX2 again).
#
# Usage: cpu-compat-sde.ps1 -Exe <path\to\cadmium-sidecar.exe> [-Sde <sde.exe or dir>]

param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Sde = $env:SDE_PATH,
    [int]$TimeoutSec = 240
)

$ErrorActionPreference = 'Stop'

if (-not $Sde) { throw "SDE location not given (-Sde or SDE_PATH)" }
if (Test-Path $Sde -PathType Container) {
    $found = Get-ChildItem $Sde -Recurse -Filter sde.exe | Select-Object -First 1
    if (-not $found) { throw "no sde.exe under $Sde" }
    $Sde = $found.FullName
}
Write-Host "SDE: $Sde"
Write-Host "sidecar: $Exe"

# name, SDE flag, required-to-pass
$cpus = @(
    @{ Name = 'Goldmont Plus (Celeron N4020-class, no AVX)'; Flag = '-glp'; Required = $true },
    @{ Name = 'Nehalem (SSE4.2, no AVX)';                    Flag = '-nhm'; Required = $true },
    @{ Name = 'Sandy Bridge (AVX, no AVX2)';                 Flag = '-snb'; Required = $true },
    @{ Name = 'Haswell (AVX2 baseline)';                     Flag = '-hsw'; Required = $true }
)

$results = @()
$port = 47100
foreach ($cpu in $cpus) {
    $port++
    $out = Join-Path $env:TEMP "sde$($cpu.Flag).out.txt"
    $err = Join-Path $env:TEMP "sde$($cpu.Flag).err.txt"
    Write-Host "=== $($cpu.Name) [$($cpu.Flag)] ==="
    $p = Start-Process -FilePath $Sde `
        -ArgumentList @($cpu.Flag, '--', $Exe, '--host', '127.0.0.1', '--port', "$port") `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $outcome = 'timeout'
    $detail = ''
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $text = (Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content $err -Raw -ErrorAction SilentlyContinue)
        if ($text -match 'listening') { $outcome = 'ok'; break }
        if ($p.HasExited) {
            $code = [uint32]([int64]$p.ExitCode -band 0xFFFFFFFF)
            $outcome = 'crashed'
            $detail = ('exit 0x{0:X8}' -f $code)
            if ($code -eq 0xC000001D) { $detail += ' STATUS_ILLEGAL_INSTRUCTION' }
            break
        }
    }
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    # Also kill the emulated child if SDE left it behind.
    Get-Process cadmium-sidecar -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    $text = (Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content $err -Raw -ErrorAction SilentlyContinue)
    # SDE names the faulting instruction when it traps an unsupported one —
    # surface that line; it pinpoints which extension is needed.
    $sdeHint = ($text -split "`n" | Where-Object { $_ -match 'TID|illegal|unsupported|not supported|Invalid' } | Select-Object -First 3) -join ' / '
    Write-Host "result: $outcome $detail"
    if ($text) { Write-Host ($text.Substring(0, [Math]::Min(3000, $text.Length))) }
    $results += [pscustomobject]@{
        Cpu = $cpu.Name; Flag = $cpu.Flag; Outcome = $outcome; Detail = $detail
        Hint = $sdeHint; Required = $cpu.Required
    }
}

$summary = @("## Sidecar CPU compatibility (Intel SDE)", "", "| CPU | Result | Detail | SDE note |", "|---|---|---|---|")
foreach ($r in $results) {
    $icon = if ($r.Outcome -eq 'ok') { 'starts ✅' } elseif ($r.Outcome -eq 'timeout') { 'timeout ⏱️' } else { 'CRASH ❌' }
    $summary += "| $($r.Cpu) ``$($r.Flag)`` | $icon | $($r.Detail) | $($r.Hint) |"
}
$summary -join "`n" | Write-Host
if ($env:GITHUB_STEP_SUMMARY) { $summary -join "`n" | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY }

$requiredFailures = $results | Where-Object { $_.Required -and $_.Outcome -ne 'ok' }
if ($requiredFailures) {
    throw "sidecar failed to start on a required CPU: $(($requiredFailures | ForEach-Object Cpu) -join ', ')"
}
