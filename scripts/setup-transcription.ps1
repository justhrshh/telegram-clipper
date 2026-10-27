# ==============================================================================
# Telegram Clipper — Transcription & CUDA Environment Setup
# ==============================================================================
# Sets up the Python virtual environment (.venv) with faster-whisper, CTranslate2,
# and official NVIDIA CUDA 12 + cuDNN 9 wheels for hardware-accelerated GPU transcription.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-transcription.ps1
# ==============================================================================

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$VenvDir = Join-Path $ProjectRoot ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"
$HfCacheDir = Join-Path $ProjectRoot "assets\hf_cache"
$TempDir = Join-Path $ProjectRoot "temp\pip_setup_tmp"

Write-Host "`n=== Telegram Clipper: AI Transcription Environment Setup ===" -ForegroundColor Cyan
Write-Host "Project Root: $ProjectRoot" -ForegroundColor Gray

# 1. Create or verify virtual environment
if (-not (Test-Path $VenvPython)) {
    Write-Host "`n[1/5] Creating Python virtual environment in .venv..." -ForegroundColor Yellow
    $SystemPython = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $SystemPython) {
        Write-Error "Python was not found on PATH. Please install Python 3.10+ (64-bit) before running this script."
        exit 1
    }
    Write-Host "Using base Python: $SystemPython" -ForegroundColor Gray
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create virtual environment."
        exit 1
    }
    Write-Host "Virtual environment created at: $VenvDir" -ForegroundColor Green
} else {
    Write-Host "`n[1/5] Existing .venv verified: $VenvPython" -ForegroundColor Green
}

# 2. Redirect pip cache/temp to D: drive if available to avoid C: exhaustion
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
New-Item -ItemType Directory -Force -Path $HfCacheDir | Out-Null
$env:TEMP = $TempDir
$env:TMP = $TempDir
$env:HF_HOME = $HfCacheDir

# 3. Upgrade pip
Write-Host "`n[2/5] Ensuring latest pip and packaging tools..." -ForegroundColor Yellow
& $VenvPython -m pip install --quiet --upgrade pip setuptools wheel --no-cache-dir

# 4. Install faster-whisper and pinned dependencies
Write-Host "`n[3/5] Installing faster-whisper and CTranslate2..." -ForegroundColor Yellow
& $VenvPython -m pip install --no-cache-dir "faster-whisper>=1.0.0" "ctranslate2>=4.0.0" numpy

# 5. Install NVIDIA CUDA 12 and cuDNN 9 wheels into .venv
Write-Host "`n[4/5] Installing official NVIDIA CUDA 12 and cuDNN 9 runtime wheels into .venv..." -ForegroundColor Yellow
Write-Host "Downloading nvidia-cublas-cu12, nvidia-cudnn-cu12, nvidia-cuda-nvrtc-cu12..." -ForegroundColor Gray
& $VenvPython -m pip install --no-cache-dir `
    nvidia-cublas-cu12 `
    nvidia-cudnn-cu12 `
    nvidia-cuda-nvrtc-cu12 `
    nvidia-cuda-runtime-cu12

# Cleanup setup temp
Remove-Item -Recurse -Force -Path $TempDir -ErrorAction SilentlyContinue

# 6. Verify environment via diagnostic health check
Write-Host "`n[5/5] Running diagnostic health check..." -ForegroundColor Yellow
& $VenvPython (Join-Path $ProjectRoot "python\transcription.py") --diagnose

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nSetup successfully verified! GPU transcription is ready." -ForegroundColor Green
} else {
    Write-Host "`nSetup completed with warnings. Check the diagnostic output above." -ForegroundColor Yellow
}
