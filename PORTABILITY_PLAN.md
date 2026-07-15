# Portability Plan — Mac + Windows

Goal: make the app run and package on both macOS (Intel + Apple Silicon) and Windows without per-machine hand-tweaking. This plan lists every cross-platform blocker, the fix, and how packaging changes. Architecture (React + Node + Python + Google APIs + OpenAI) stays the same — these are surgical changes.

## Current architecture (for reference)

Three processes wired over localhost:

- **React/Vite UI** (`src/`) → calls `http://localhost:3000`.
- **Node/Express** (`server.js`, port 3000) → orchestration: Drive, OpenAI gpt-4o vision, Sheets, xlsx export, PDF→image conversion.
- **Python/Flask** (`app.py`, port 5001) → FLAN-T5 classification only.

Electron (`electron.js`) packages the UI and launches the Node + Python processes at startup.

## Blockers and fixes

### 1. Hardcoded poppler path (highest priority)
`server.js` uses `const pdftocairo = '/opt/homebrew/bin/pdftocairo'` — Apple-Silicon-only. Breaks on Intel Mac and all of Windows.

**Fix:** add a `resolvePdftocairo()` resolver with this precedence:
1. `POPPLER_PATH` env override.
2. **Bundled binary** (chosen approach): `vendor/poppler/<platform>/bin/pdftocairo[.exe]`. In a packaged app, read from `process.resourcesPath`; in dev, from the repo `vendor/` dir.
3. Common system locations (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`) and bare `pdftocairo` on `PATH` as last-resort fallback.

Pick `pdftocairo.exe` on Windows, `pdftocairo` elsewhere.

**Bundling:** poppler binaries are committed under `vendor/poppler/<platform>/` and shipped via electron-builder `extraResources`. Binaries to obtain (cannot be auto-downloaded here — see "Binaries to drop in" below):
- macOS arm64 + x64 (or a universal set) — from Homebrew poppler or a static build.
- Windows x64 — from the `oschwartz10612/poppler-windows` release zip (the `Library/bin` folder).

### 2. OS-specific process launching in `electron.js`
Mac path uses `osascript` + hardcoded `python3.11`; Windows uses a nested `start cmd.exe /K ... start /b ...` string. Both open external terminal windows and make `killProcesses()` unreliable.

**Fix:** replace with managed `child_process.spawn` for both servers (no external terminal), pipe their stdout/stderr to the Electron console, and keep the child handles so `killProcesses()` can terminate them cleanly (`taskkill /pid /T /F` on Windows, `kill` elsewhere). Resolve the Python executable via a `resolvePython()` helper that tries `python3` then `python` (and a bundled venv path if present).

### 3. Mac-only browser open in `auth_drive.js`
`exec('open "<url>")` is macOS-only.

**Fix:** small cross-platform opener — `open` (mac), `start ""` (Windows), `xdg-open` (Linux).

### 4. Hardcoded personal path in `executable.sh`
`cd "/c/Users/Kyle/Desktop/project"` — personal, non-portable. It's gitignored and effectively dead.

**Fix:** replace its body with a portable version that `cd`s to the script's own directory, or delete it. Plan: rewrite to be path-independent.

### 5. `macinstall.sh` symlink assumption
Symlinks Python into `/usr/local/bin`, wrong on Apple Silicon (`/opt/homebrew`). Also assumes Homebrew exists.

**Fix:** drop the manual symlink; rely on `brew`'s own linking and call `python3.11` via `brew --prefix`. Add a Homebrew-presence check.

### 6. Port mismatch risk
`server.js` falls back to port 3001 if 3000 is busy, but the UI hardcodes `localhost:3000` in five places. If the fallback fires, the UI silently breaks.

**Fix:** centralize the base URL in `src/config.js` (single constant) and import it in the four page components, so there's one place to change. Keep the server on a fixed port and make a busy port fail loudly rather than silently shifting.

### 7. Secrets are committed/bundled (security, flagged — not auto-changed)
`.env`, `sheets_credentials.json`, `drive_credentials.json`, `drive_token.json` are tracked and listed in `package.json` `build.files`. The OAuth token is single-user and tied to the `localhost:4000` redirect, so it won't work for other users regardless.

**Recommendation (needs your decision, not done in this pass):** `git rm --cached` the secret files, rotate the keys, and have each user supply their own `.env` + credentials + run `auth_drive.js` once. Left out of the code changes because it affects your repo history and live credentials.

## Packaging changes (`package.json` build)

- Add `vendor/poppler/**` to `extraResources` so the binaries ship inside the app.
- Keep `mac.target: dmg` and `win.target: nsis`. Optionally add `mac.target: ["dmg","zip"]` and `arch: ["x64","arm64"]` for universal Mac coverage.
- Confirm `app.py`, `requirements.txt`, and `project_backup/**` (the model) are included (they currently are).

Note: Python itself is **not** bundled — users still need Python 3.11 + the pip deps. That's what the install scripts are for. Fully bundling Python (e.g. PyInstaller for `app.py`) is a larger follow-up if you want a zero-dependency installer.

## Binaries to drop in (manual step)

After the code changes, place the poppler binaries here so dev and packaged builds work:

```
vendor/poppler/darwin-arm64/bin/pdftocairo
vendor/poppler/darwin-x64/bin/pdftocairo
vendor/poppler/win32-x64/bin/pdftocairo.exe   (+ its DLLs from Library/bin)
```

I'll create the folder structure and a README in `vendor/poppler/` documenting exactly where to get each one.

## Verification

- Syntax-check all modified JS (`node --check`).
- Confirm the poppler resolver returns the right path per platform via a dry-run.
- Manual smoke test by you on each OS (run a PDF through `/process-pdf`).
