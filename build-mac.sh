#!/usr/bin/env bash
# Builds a portable macOS .dmg with Python bundled in — end users need nothing
# preinstalled. Run this on a Mac:  bash build-mac.sh
#
# The .dmg it produces matches this Mac's chip (Apple Silicon or Intel).

set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/7] Checking prerequisites (Node, Python)…"
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found. Install it, then re-run."; exit 1; }
PYBIN="${PYTHON:-python3.11}"
command -v "$PYBIN" >/dev/null 2>&1 || PYBIN=python3
command -v "$PYBIN" >/dev/null 2>&1 || { echo "❌ Python not found. Install Python 3.11, then re-run."; exit 1; }
echo "    Using Python: $($PYBIN --version)"

echo "==> [2/7] Creating a Python build environment and installing deps…"
"$PYBIN" -m venv .buildvenv
# shellcheck disable=SC1091
source .buildvenv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller

echo "==> [3/7] Bundling the Python classifier (slow — pulls in PyTorch)…"
rm -rf pydist pywork
pyinstaller --clean --noconfirm --distpath pydist --workpath pywork classifier.spec
deactivate
test -x "pydist/classifier/classifier" || { echo "❌ Classifier build failed."; exit 1; }
echo "    ✅ Classifier binary built at pydist/classifier/classifier"

echo "==> [4/7] Bundling poppler (pdftocairo) for the PDF feature…"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  POP_DIR="vendor/poppler/darwin-arm64/bin" ;;
  x86_64) POP_DIR="vendor/poppler/darwin-x64/bin" ;;
  *)      POP_DIR="" ;;
esac
if [ -n "$POP_DIR" ] && command -v brew >/dev/null 2>&1; then
  brew list poppler >/dev/null 2>&1 || brew install poppler
  SRC="$(brew --prefix poppler)/bin/pdftocairo"
  if [ -x "$SRC" ]; then
    mkdir -p "$POP_DIR"
    cp "$SRC" "$POP_DIR/pdftocairo"
    if command -v dylibbundler >/dev/null 2>&1; then
      # Bundle the dylibs into the SAME directory as pdftocairo (not a "libs"
      # subfolder) and rewrite references as plain @loader_path. dylibbundler
      # applies the same -p prefix uniformly to every fixed binary, including
      # the dependency dylibs themselves — if they lived one level deeper than
      # pdftocairo (e.g. bin/libs/), their own sibling references would get
      # rewritten to the wrong depth (bin/libs/libs/...), which is exactly the
      # "Library not loaded" crash we hit before. Keeping everything flat in
      # one folder avoids that entirely. -s gives dylibbundler an explicit
      # fallback search path since pdftocairo's copy loses its original
      # working rpath once moved out of the Homebrew prefix.
      dylibbundler -of -b -x "$POP_DIR/pdftocairo" -d "$POP_DIR" -p @loader_path -s "$(brew --prefix poppler)/lib" >/dev/null

      # dylibbundler sometimes fails to fully fix one specific dependency (it
      # warns "MAY NOT CORRECTLY HANDLE THIS DEPENDENCY" when a lib is only
      # reachable via a versioned SONAME symlink, e.g. libpoppler.162.dylib ->
      # libpoppler.162.0.0.dylib). It copies the real file but leaves the
      # symlink name missing, and leaves whichever binaries reference it still
      # pointing at the old @rpath. Patch that up here:

      # 1. Recreate any SONAME symlinks Homebrew has, so files referenced by
      #    their unversioned/major-version name (not the exact file we copied)
      #    still resolve.
      BREW_POP_LIB="$(brew --prefix poppler)/lib"
      for link in "$BREW_POP_LIB"/*.dylib; do
        [ -L "$link" ] || continue
        target="$(basename "$(readlink "$link")")"
        linkname="$(basename "$link")"
        if [ -f "$POP_DIR/$target" ] && [ ! -e "$POP_DIR/$linkname" ]; then
          ln -sf "$target" "$POP_DIR/$linkname"
        fi
      done

      # 2. Rewrite any remaining unfixed @rpath references to @loader_path,
      #    for whichever dependency we now have a local copy of.
      for f in "$POP_DIR"/pdftocairo "$POP_DIR"/*.dylib; do
        [ -f "$f" ] || continue
        for dep in $(otool -L "$f" 2>/dev/null | tail -n +2 | awk '{print $1}' | grep '^@rpath/'); do
          depname="$(basename "$dep")"
          if [ -e "$POP_DIR/$depname" ]; then
            install_name_tool -change "$dep" "@loader_path/$depname" "$f"
          fi
        done
      done

      # 3. install_name_tool invalidates the code signature, and Apple Silicon
      #    refuses to even launch a binary with a broken signature (silent
      #    SIGKILL, no error text) — re-sign everything we touched.
      for f in "$POP_DIR"/pdftocairo "$POP_DIR"/*.dylib; do
        [ -f "$f" ] || continue
        codesign --force --sign - "$f" 2>/dev/null || true
      done

      echo "    ✅ poppler bundled with its libraries"
    else
      echo "    ⚠️  dylibbundler not found. Run 'brew install dylibbundler' for PDF to work on"
      echo "        machines without poppler. Continuing (image transcription is unaffected)."
    fi
  fi
else
  echo "    ⚠️  Skipping poppler bundling (need Homebrew). PDF needs poppler; image flow is unaffected."
fi

echo "==> [5/7] Installing Node dependencies…"
npm install

echo "==> [6/7] Building the React UI…"
npm run build

echo "==> [7/7] Packaging the .dmg (electron-builder)…"
npx electron-builder --mac

echo ""
echo "✅ Done. Your installer is in the dist/ folder (look for a .dmg)."
echo "   If macOS says the app 'can't be verified' on first open, run:"
echo "     xattr -cr \"/Applications/pdf-transcriber.app\""
echo "   (or right-click the app → Open)."
