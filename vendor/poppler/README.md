# Bundled poppler binaries

`server.js` (`resolvePdftocairo()`) looks for `pdftocairo` here before falling back
to system paths. Drop the binaries in the matching platform folder so the app works
without the user installing poppler.

Expected layout (`<platform>-<arch>` matches Node's `process.platform`-`process.arch`):

```
vendor/poppler/
  darwin-arm64/bin/pdftocairo          # Apple Silicon Mac
  darwin-x64/bin/pdftocairo            # Intel Mac
  win32-x64/bin/pdftocairo.exe         # Windows (+ all DLLs alongside it)
```

## Where to get them

- **macOS:** install poppler (`brew install poppler`) then copy the `pdftocairo`
  binary from `$(brew --prefix poppler)/bin/`. For a self-contained copy you also
  need its dylibs; the simplest portable option is a static build. Do this once on
  an Apple Silicon machine for `darwin-arm64` and once on Intel for `darwin-x64`.
- **Windows x64:** download the latest release zip from
  https://github.com/oschwartz10612/poppler-windows/releases
  and copy the entire contents of `poppler-<ver>/Library/bin/` (the `.exe` **and**
  all `.dll` files) into `vendor/poppler/win32-x64/bin/`.

## Notes

- On Windows the DLLs must sit next to `pdftocairo.exe` or it won't launch.
- You can override discovery at runtime with the `POPPLER_PATH` env var
  (point it at the folder containing the binary).
- These binaries are intentionally committed so packaged builds are self-contained;
  they're shipped via electron-builder `extraResources` (see `package.json`).
