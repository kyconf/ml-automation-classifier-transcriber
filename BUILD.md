# Building the macOS Installer (.dmg)

This produces a **portable** `.dmg` with Python and the FLAN‑T5 model bundled inside, so the people you give it to need **nothing preinstalled** — no Python, no Node, no pip. They just drag the app to Applications and open it.

This is a build step for **you** (the owner), done on a Mac. End users never see any of this — for them, see `INSTALLATION.md`.

---

## What you need on the build Mac (once)

- **Node.js** — <https://nodejs.org> (LTS).
- **Python 3.11** — `brew install python@3.11`.
- **Homebrew** — <https://brew.sh> (used to fetch poppler).
- **dylibbundler** *(recommended, for the PDF feature)* — `brew install dylibbundler`.

You do **not** need an Apple Developer account. The app will be unsigned (see "First open" below).

---

## Build it

From the project folder, run:

```bash
bash build-mac.sh
```

That's the whole thing. The script:

1. Creates a temporary Python environment and installs the app's Python dependencies.
2. Uses **PyInstaller** to package `app.py` + the model into a standalone `classifier` program (`pydist/classifier/`). *(This step is slow — it pulls in PyTorch — and is the reason the `.dmg` is large.)*
3. Copies **poppler** (`pdftocairo`) and its libraries in, so PDF conversion works.
4. Installs Node dependencies.
5. Builds the React UI.
6. Runs **electron-builder** to produce the `.dmg`.

When it finishes, your installer is in **`dist/`** (e.g. `dist/pdf-transcriber-0.0.0-arm64.dmg`).

> **Chip note:** the `.dmg` matches the Mac you build on. Build on an **Apple Silicon** Mac for Apple Silicon users; build on an **Intel** Mac for Intel users. (PyInstaller can't cross‑compile between chips.)

---

## First open on a user's Mac (unsigned app)

Because the app isn't signed with an Apple certificate, macOS may say *"pdf-transcriber can't be opened because Apple cannot check it."* Two easy ways around it:

- **Right‑click** the app in Applications → **Open** → **Open** again. (Only needed once.)
- Or, in Terminal: `xattr -cr "/Applications/pdf-transcriber.app"`

If you later get an Apple Developer ID, we can sign and notarize so this prompt disappears entirely.

---

## What each user still does (once, in the app)

Everything portable is baked in, but each user still supplies their **own** credentials the first time — the app's **Settings** panel opens automatically and asks for:

- the **OpenAI API key**,
- the three **Google credential files** (`sheets_credentials.json`, `drive_credentials.json`, `drive_token.json`),
- and confirms the **Spreadsheet ID + folder IDs**.

They click **Save & restart** and they're set. (This is why your personal keys are **no longer** shipped inside the app — that was both a security risk and non‑portable.)

---

## Troubleshooting the build

**PyInstaller fails on `transformers` or `torch`.** Make sure the build venv installed cleanly (`build-mac.sh` does `pip install -r requirements.txt`). Re‑run the script; it rebuilds from scratch.

**`electron-builder` errors that `pydist/classifier` is missing.** The classifier step didn't finish — scroll up for the PyInstaller error. Don't run `npm run electron-build` directly; use `bash build-mac.sh`, which builds the classifier first.

**PDF tab does nothing in the built app.** poppler wasn't bundled. Install `dylibbundler` (`brew install dylibbundler`) and rebuild. Image transcription doesn't use poppler and works regardless.

**The `.dmg` is very large (1–2 GB).** Expected — PyTorch plus the model. This is the trade‑off for needing no Python on the user's machine.

---

## Windows (.exe) — later

The same approach works on Windows (PyInstaller → `classifier.exe`, then `electron-builder --win`), but it must be built **on a Windows machine**. The Electron side already knows to launch `classifier.exe` when present. Ask and I'll add a `build-win.ps1` mirroring `build-mac.sh`.
