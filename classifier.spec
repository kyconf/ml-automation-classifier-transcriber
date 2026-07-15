# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: bundles app.py (the FLAN-T5 classifier) + its model into a
# standalone "classifier" program so end users don't need Python installed.
#
# Build (from the project root, inside the build venv):
#   pyinstaller --clean --noconfirm --distpath pydist --workpath pywork classifier.spec
#
# Output: pydist/classifier/  (a folder containing the "classifier" executable).

from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = []

# Ship the fine-tuned model so app.py finds it under sys._MEIPASS at runtime.
datas += [('project_backup/fine_tuned_model', 'project_backup/fine_tuned_model')]

# These packages ship data files and/or use dynamic imports PyInstaller can't
# see on its own — collect everything they need.
for pkg in [
    'transformers', 'torch', 'tokenizers', 'safetensors',
    'sentencepiece', 'regex', 'pdfplumber', 'flask_cors', 'huggingface_hub',
]:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # a package may be optional/absent — keep going
        print(f'collect_all skipped {pkg}: {exc}')

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='classifier',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='classifier',
)
