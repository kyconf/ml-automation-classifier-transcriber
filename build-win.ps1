# Builds a portable Windows installer (.exe via NSIS) with Python bundled in -
# end users need nothing preinstalled. Run this on Windows:  .\build-win.ps1
#
# Mirrors build-mac.sh. Unlike macOS, Windows doesn't need a dylib-bundling
# step for poppler: pdftocairo.exe loads its DLLs from its own folder, and
# electron.js already falls back to the copy bundled inside
# node_modules/pdf-poppler/lib/win/poppler-0.51/bin if vendor/poppler/win32-x64
# is empty.
#
# This script will install Node.js and Python 3.11 itself if they're missing,
# same as wininstall.ps1 does - you shouldn't need anything preinstalled to
# run this.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-Python311 {
    # Run version checks with errors treated as non-fatal - native exe stderr
    # output (e.g. py.exe's "no suitable runtime" message) would otherwise
    # trip $ErrorActionPreference = "Stop" even when redirected.
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $found = $null
    try {
        if (Get-Command py -ErrorAction SilentlyContinue) {
            $out = & py -3.11 --version 2>&1
            if ($LASTEXITCODE -eq 0) { $found = "py -3.11" }
        }
        if (-not $found -and (Get-Command python3.11 -ErrorAction SilentlyContinue)) {
            $out = & python3.11 --version 2>&1
            if ($LASTEXITCODE -eq 0) { $found = "python3.11" }
        }
        if (-not $found -and (Get-Command python -ErrorAction SilentlyContinue)) {
            $out = & python --version 2>&1
            if ($LASTEXITCODE -eq 0 -and "$out" -match "3\.11") { $found = "python" }
        }
    } finally {
        $ErrorActionPreference = $prevPref
    }
    return $found
}

Write-Host "==> [1/5] Checking prerequisites (Node, Python)..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "    Node.js not found. Installing..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi" -OutFile "$env:TEMP\node-installer.msi"
    Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$env:TEMP\node-installer.msi`" /quiet /norestart" -Wait
    Remove-Item "$env:TEMP\node-installer.msi" -Force
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node install finished but 'node' still isn't on PATH. Open a new terminal and re-run." -ForegroundColor Red
        exit 1
    }
    Write-Host "    Node.js installed." -ForegroundColor Green
}

$pybin = Find-Python311
if (-not $pybin) {
    Write-Host "    Python 3.11 not found. Installing 3.11.9..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -OutFile "$env:TEMP\python-installer.exe"
    Start-Process -FilePath "$env:TEMP\python-installer.exe" -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1" -Wait
    Remove-Item "$env:TEMP\python-installer.exe" -Force
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $pybin = Find-Python311
    if (-not $pybin) {
        Write-Host "Python 3.11 install finished but couldn't be found on PATH. Open a new terminal and re-run." -ForegroundColor Red
        exit 1
    }
    Write-Host "    Python 3.11 installed." -ForegroundColor Green
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
Remove-Item -Recurse -Force .buildvenv -ErrorAction SilentlyContinue
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
