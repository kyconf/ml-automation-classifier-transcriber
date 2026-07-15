# Installation Guide — Exam Transcriber

This is for **everyday users** installing the app from the installer you were given. Everything the app needs is already inside it — you do **not** need to install Python, Node, or anything technical. It takes about two minutes.

> Building the installer yourself? That's a separate one‑time task — see `BUILD.md`.

---

## Before you begin — what to have ready

Ask the person who set up this project (the "owner") for:

1. **An OpenAI API key** — a long text string that starts with `sk-...`.
2. **Three Google credential files:** `sheets_credentials.json`, `drive_credentials.json`, `drive_token.json`.
3. **Four Google IDs** — a Spreadsheet ID and three folder IDs (usually already filled in for you).

Save these somewhere easy to find, like your Desktop. You'll enter them once, inside the app, at the end.

---

## macOS

### 0. Make sure you have the right `.dmg` for your Mac
There are two versions — one for **Apple Silicon** Macs (M1/M2/M3/M4) and one for **Intel** Macs. They are *not* interchangeable; the wrong one won't open. Not sure which you have? Click the  menu → **About This Mac** — it'll say "Apple M‑something" (Apple Silicon) or "Intel" right there. Ask the owner for the matching `.dmg` if you're not sure which one you were given.

### 1. Open the installer
Double‑click the **`.dmg`** file you were given (e.g. `pdf-transcriber-…​.dmg`). A window opens showing the app.

### 2. Install it
Drag the **pdf‑transcriber** icon onto the **Applications** folder in that same window.

### 3. Open it (first time only)
Because the app is from outside the App Store, macOS asks you to confirm the first time:

- Go to **Applications**, **right‑click** (or Control‑click) **pdf‑transcriber**, choose **Open**, then **Open** again in the pop‑up.
- If it still won't open, open **Terminal** (press `Cmd + Space`, type `Terminal`, Enter) and paste:
  ```bash
  xattr -cr "/Applications/pdf-transcriber.app"
  ```
  Then open the app normally.

After this first time, you just open it like any other app.

---

## Windows

### 1. Run the installer
Double‑click the **`.exe`** you were given. If Windows shows a blue **"Windows protected your PC"** box, click **More info → Run anyway** (this is normal for apps not sold through the Microsoft Store).

### 2. Follow the prompts
Click through the installer. When it finishes, launch **pdf‑transcriber** from the Start menu or desktop shortcut.

---

## First launch — enter your settings (once)

The first time the app opens, the **Settings** panel appears automatically because it doesn't yet have your key and files. (You can reopen it anytime with the **⚙ Settings** button at the bottom‑left.)

On the **API & Credentials** tab:

1. **Paste your OpenAI API key** into the key box. Click the 👁 eye icon to double‑check it.
2. **Upload each Google file** — click **Upload** next to *Google Sheets credentials*, *Google Drive credentials*, and *Google Drive token*, and pick the matching `.json` file. Each shows a green **✓ Saved**.

On the **Advanced** tab, confirm the **Spreadsheet ID** and three **Folder IDs** are filled in. Only change them if the owner tells you to.

Click **Save & restart**. The app relaunches, fully set up.

✅ **You only do this once.** Your key and files are stored securely on your computer, so you won't be asked again.

---

## Everyday use

Just open **pdf‑transcriber** like any other app. The four tabs — **Image**, **PDF**, **Generate**, **Regenerate** — each show *"Currently connected to: …"* under their title so you can confirm the right folder/sheet is linked.

---

## Troubleshooting

**macOS: "app can't be opened because Apple cannot check it."**
Right‑click the app → **Open** → **Open**, or run `xattr -cr "/Applications/pdf-transcriber.app"` in Terminal (see the macOS steps above). Only needed the first time.

**Windows: "Windows protected your PC."**
Click **More info → Run anyway**. This appears because the installer isn't from the Microsoft Store; it's safe to proceed.

**macOS: the app icon just bounces once in the dock, then disappears (no error, no window).**
You likely have the wrong chip version — an Apple Silicon `.dmg` on an Intel Mac, or vice versa. Check the  menu → **About This Mac** and ask the owner for the matching one (see step 0 above).

**A tab says "Not connected to any folder."**
Open **⚙ Settings → Advanced** and make sure the Spreadsheet/Folder IDs are filled in, then **Save & restart**.

**Something fails after you changed a setting.**
Settings only take effect after a restart. Use **Save & restart** in the Settings panel (not just Save).

**Still stuck?**
Contact the project owner and let them know exactly which tab and what message you saw.

---

*Once installed, the app is fully self‑contained and portable — the same steps work on any Mac (or Windows PC), and your settings are saved locally so setup only happens once.*
