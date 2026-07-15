# Builds a portable Windows installer (.exe via NSIS) with Python bundled in -
# end users need nothing preinstalled. Run this on Windows:  .\build-win.ps1
#
# Mirrors build-mac.sh. Unlike macOS, Windows doesn't need a dylib-bundling
# step for poppler: pdftocairo.exe loads its DLLs from its own folder, and
# electron.js already falls back to the copy bundled inside
# node_modules/pdf-poppler/lib/win/poppler-0.51/bin if vendor/poppler/win32-x64
# is empty.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> [1/5] Checking prerequisites (Node, Python)..." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Install it, then re-run." -ForegroundColor Red
    exit 1
}
$pybin = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    if (& py -3.11 --version 2>$null) { $pybin = "py -3.11" }
}
if (-not $pybin -and (Get-Command python3.11 -ErrorAction SilentlyContinue)) { $pybin = "python3.11" }
if (-not $pybin -and (Get-Command python -ErrorAction SilentlyContinue)) {
    $verOutput = & python --version 2>&1
    if ($verOutput -notmatch "3\.11") {
        Write-Host "Only found $verOutput on PATH. Python 3.11 is required (older/newer patch versions have known PyInstaller-breaking bugs). Install Python 3.11.9, then re-run." -ForegroundColor Red
        exit 1
    }
    $pybin = "python"
}
if (-not $pybin) {
    Write-Host "Python 3.11 not found. Install it (e.g. https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe), then re-run." -ForegroundColor Red
    exit 1
}
Write-Host "    Using Python: $(Invoke-Expression "$pybin --version")"

# The classifier bundles project_backup/fine_tuned_model - this folder is
# gitignored (too large for git), so it must already be present locally
# (copied over separately) before this script can succeed.
if (-not (Test-Path "project_backup/fine_tuned_model")) {
    Write-Host "project_backup/fine_tuned_model not found. Copy the fine-tuned model here first, then re-run." -ForegroundColor Red
    exit 1
}

Write-Host "==> [2/5] Creating a Python build environment and installing deps..." -ForegroundColor Cyan
Invoke-Expression "$pybin -m venv .buildvenv"
& .\.buildvenv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller

Write-Host "==> [3/5] Bundling the Python classifier (slow, pulls in PyTorch)..." -ForegroundColor Cyan
Remove-Item -Recurse -Force pydist, pywork -ErrorAction SilentlyContinue
pyinstaller --clean --noconfirm --distpath pydist --workpath pywork classifier.spec
deactivate
if (-not (Test-Path "pydist/classifier/classifier.exe")) {
    Write-Host "Classifier build failed." -ForegroundColor Red
    exit 1
}
Write-Host "    Classifier binary built at pydist/classifier/classifier.exe" -ForegroundColor Green

Write-Host "==> [4/5] Installing Node dependencies and building the React UI..." -ForegroundColor Cyan
npm install
npm run build

Write-Host "==> [5/5] Packaging the installer (electron-builder)..." -ForegroundColor Cyan
npx electron-builder --win

Write-Host ""
Write-Host "Done. Your installer is in the dist/ folder." -ForegroundColor Green
Write-Host "First run may trigger a SmartScreen warning since the app is unsigned -"
Write-Host "click 'More info' -> 'Run anyway'."
