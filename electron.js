import { exec, execSync, spawn } from "child_process";
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import isDev from "electron-is-dev";
import dotenv from 'dotenv';
import fs from 'fs';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let nodeServer;
let pythonServer;

const CREDENTIAL_FILES = ['sheets_credentials.json', 'drive_credentials.json', 'drive_token.json'];

// Where runtime-added files (.env, credentials) get written so they persist and
// are readable by the spawned servers.
function appDataDir() {
  return app.getPath('userData');
}

// Resolve a config file from a predictable set of locations. First existing wins.
function resolveConfig(name) {
  const candidates = [];
  if (name === '.env' && process.env.ENV_PATH) candidates.push(process.env.ENV_PATH);
  for (const dir of [
    path.dirname(app.getPath('exe')),   // next to the installed app (Windows install dir)
    appDataDir(),                       // per-user app data (recommended drop spot)
    process.resourcesPath || __dirname, // bundled fallback
    __dirname,                          // dev
  ]) {
    candidates.push(path.join(dir, name));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Serialize an env object to KEY="value" lines and write it into the writable
// app-data dir (the same spot resolveConfig/the servers read from first).
function writeEnv(values) {
  fs.mkdirSync(appDataDir(), { recursive: true });
  const body = Object.entries(values)
    .map(([k, v]) => `${k}="${String(v ?? '').replace(/"/g, '\\"')}"`)
    .join('\n');
  fs.writeFileSync(path.join(appDataDir(), '.env'), body + '\n');
}

// ---- Preflight checks -------------------------------------------------------

// Path to the bundled, standalone Python classifier (PyInstaller output) shipped
// in a packaged build. Returns null in dev or when it isn't present.
function bundledClassifierPath() {
  if (isDev) return null;
  const exe = process.platform === 'win32' ? 'classifier.exe' : 'classifier';
  const p = path.join(process.resourcesPath || __dirname, 'classifier', exe);
  return fs.existsSync(p) ? p : null;
}

function checkFiles() {
  const required = ['server.js', 'xlsx.html'];
  // In a packaged build the Python side is the bundled binary; app.py is only
  // needed when we fall back to a system Python (dev / no bundle).
  if (!bundledClassifierPath()) required.push('app.py');
  if (!isDev) required.push(path.join('build', 'index.html'));
  const missing = required.filter((rel) => !fs.existsSync(path.join(__dirname, rel)));
  return {
    id: 'files',
    label: 'Checking your files...',
    ok: missing.length === 0,
    detail: missing.length ? `Missing: ${missing.join(', ')}. Reinstall the app.` : 'All app files present.',
  };
}

function checkPackages() {
  const coreDeps = ['express', 'googleapis', 'openai', 'pdf-poppler', 'dotenv'];
  const missingNode = coreDeps.filter((d) => !fs.existsSync(path.join(__dirname, 'node_modules', d)));
  // The bundled classifier needs no system Python; otherwise we require one.
  const pythonOk = bundledClassifierPath() !== null || resolvePython() !== null;
  const ok = missingNode.length === 0 && pythonOk;
  let detail = 'Dependencies installed.';
  if (missingNode.length) detail = `Missing Node packages: ${missingNode.join(', ')}. Run npm install.`;
  else if (!pythonOk) detail = 'Python was not found. Run the install script (macinstall.sh / wininstall.ps1).';
  return { id: 'packages', label: 'Checking packages and dependencies...', ok, detail };
}

// API key, folder/sheet IDs, and Google JSON credentials are no longer gated
// here — they're entered in the in-app Settings panel, which prompts on launch
// if anything is missing. The preflight only confirms the app can run.
function runPreflight() {
  const steps = [checkFiles(), checkPackages()];
  return { steps, allOk: steps.every((s) => s.ok) };
}

// ---- Process management -----------------------------------------------------

function killProcesses() {
  for (const child of [nodeServer, pythonServer]) {
    if (!child || child.killed) continue;
    try {
      if (process.platform === 'win32') {
        // /T kills the whole tree, /F forces it — guarantees the port frees.
        exec(`taskkill /pid ${child.pid} /T /F`);
      } else {
        // SIGKILL (not SIGINT) so a busy/ignoring child can't keep the port bound.
        child.kill('SIGKILL');
      }
    } catch { /* already gone */ }
  }
  nodeServer = null;
  pythonServer = null;
}

// Resolve a Python executable cross-platform. Prefers an interpreter that
// actually has Flask (app.py's core dependency), since the machine may have
// several Pythons and the deps might only be installed in one of them.
function resolvePython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'python3.11', 'python3.10']
    : ['python3.11', 'python3.10', 'python3', 'python'];

  const available = [];
  for (const cmd of candidates) {
    try {
      const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
      execSync(probe, { stdio: 'ignore' });
      available.push(cmd);
    } catch {
      // not on PATH — try next candidate
    }
  }

  // Prefer whichever available interpreter can import Flask.
  for (const cmd of available) {
    try {
      execSync(`${cmd} -c "import flask"`, { stdio: 'ignore' });
      return cmd;
    } catch {
      // deps missing here — keep looking
    }
  }

  // Fall back to the first available Python (so the missing-Flask error still
  // surfaces and points the user to the install step).
  return available[0] || null;
}

function startServers() {
  const serverPath = isDev ? path.join(process.cwd(), "server.js") : path.join(__dirname, "server.js");
  const pythonPath = isDev ? path.join(process.cwd(), "app.py") : path.join(__dirname, "app.py");
  const pythonCmd = resolvePython() || (process.platform === 'win32' ? 'python' : 'python3');

  const envFile = resolveConfig('.env');
  const childEnv = {
    ...process.env,
    ELECTRON_IS_PACKAGED: isDev ? 'false' : 'true',
    APP_DATA_DIR: appDataDir(),                 // where servers find runtime-added creds
    ...(envFile ? { APP_ENV_PATH: envFile } : {}),
  };

  // In dev, inherit the existing terminal so logs show up where you launched
  // `npm run electron-dev` from. In a packaged build, `inherit` has no real
  // console to attach to — on Windows this makes the OS pop up a *new*,
  // uncaptured console window for any console-subsystem child (like the
  // PyInstaller classifier, built with console=True). Redirect to log files
  // instead: no stray window, and the logs actually persist.
  let nodeStdio = 'inherit';
  let pythonStdio = 'inherit';
  if (!isDev) {
    const logDir = path.join(appDataDir(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    nodeStdio = ['ignore', fs.openSync(path.join(logDir, 'server.log'), 'a'), fs.openSync(path.join(logDir, 'server.log'), 'a')];
    pythonStdio = ['ignore', fs.openSync(path.join(logDir, 'classifier.log'), 'a'), fs.openSync(path.join(logDir, 'classifier.log'), 'a')];
  }

  // Managed child processes — no external terminal window, reliable cleanup.
  nodeServer = spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: nodeStdio,
    windowsHide: true,
  });
  nodeServer.on('error', (err) => console.error('Failed to start Node server:', err));

  // Prefer the bundled standalone classifier (no Python needed); fall back to a
  // system Python running app.py in dev or if the binary isn't present.
  const classifier = bundledClassifierPath();
  if (classifier) {
    pythonServer = spawn(classifier, [], { cwd: __dirname, env: childEnv, stdio: pythonStdio, windowsHide: true });
  } else {
    pythonServer = spawn(pythonCmd, [pythonPath], { cwd: __dirname, env: childEnv, stdio: pythonStdio, windowsHide: true });
  }
  pythonServer.on('error', (err) => console.error('Failed to start Python classifier:', err));
}

// Poll a TCP port until the server is accepting connections (or timeout).
function waitForPort(port, timeout = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => { socket.end(); resolve(true); });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeout) resolve(false);
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

// ---- Windows ----------------------------------------------------------------

function loadMainApp() {
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'build', 'index.html'));
  }
}

// App icon for dev (Windows/Linux window + macOS Dock). In a packaged build the
// icon is embedded from the .icns/.ico by electron-builder, so this is a no-op there.
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Always show the preflight screen first; it drives what happens next.
  mainWindow.loadFile(path.join(__dirname, 'preflight.html'));
}

// ---- IPC --------------------------------------------------------------------

ipcMain.handle('preflight:run', async () => runPreflight());

// Let the user pick a missing .env or credential file; copy it into app data, re-check.
ipcMain.handle('preflight:addFile', async (_event, name) => {
  const filters = name === '.env'
    ? [{ name: 'env file', extensions: ['env'] }, { name: 'All Files', extensions: ['*'] }]
    : [{ name: 'JSON', extensions: ['json'] }];

  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Select ${name}`,
    properties: ['openFile'],
    filters,
  });
  if (result.canceled || !result.filePaths.length) {
    return { ...runPreflight(), canceled: true };
  }

  try {
    const dest = path.join(appDataDir(), name);
    fs.mkdirSync(appDataDir(), { recursive: true });
    fs.copyFileSync(result.filePaths[0], dest);
  } catch (err) {
    return { ...runPreflight(), error: `Could not save ${name}: ${err.message}` };
  }
  return runPreflight();
});

// All checks passed — start the servers and switch to the main app.
ipcMain.handle('preflight:proceed', async () => {
  startServers();
  await waitForPort(Number(process.env.PORT) || 3000);
  loadMainApp();
  return true;
});

// ---- Settings (in-app editor) ----------------------------------------------

// Read current config so the Settings panel can prefill its fields and show
// which credential files are already saved.
ipcMain.handle('settings:get', async () => {
  let env = {};
  const p = resolveConfig('.env');
  if (p) {
    try { env = dotenv.parse(fs.readFileSync(p)); } catch { env = {}; }
  }
  const creds = {};
  for (const name of CREDENTIAL_FILES) {
    creds[name] = Boolean(resolveConfig(name));
  }
  return {
    apiKey: env.OPENAI_API_KEY || '',
    spreadsheetId: env.SPREADSHEET_ID || '',
    exportFolderId: env.EXPORT_FOLDER_ID || '',
    folderId: env.FOLDER_ID || '',
    folderPdf: env.FOLDER_PDF || '',
    creds,
  };
});

// Persist the edited values. Merge onto the existing .env so keys the form
// doesn't expose (PORT, POPPLER_PATH, etc.) are preserved.
ipcMain.handle('settings:save', async (_event, values) => {
  try {
    let existing = {};
    const p = resolveConfig('.env');
    if (p) {
      try { existing = dotenv.parse(fs.readFileSync(p)); } catch { existing = {}; }
    }
    const merged = {
      ...existing,
      OPENAI_API_KEY: values.apiKey ?? existing.OPENAI_API_KEY ?? '',
      SPREADSHEET_ID: values.spreadsheetId ?? existing.SPREADSHEET_ID ?? '',
      EXPORT_FOLDER_ID: values.exportFolderId ?? existing.EXPORT_FOLDER_ID ?? '',
      FOLDER_ID: values.folderId ?? existing.FOLDER_ID ?? '',
      FOLDER_PDF: values.folderPdf ?? existing.FOLDER_PDF ?? '',
    };
    writeEnv(merged);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Let the user pick a JSON credential file; copy it into app data so it
// persists and is found by the servers on next launch.
ipcMain.handle('settings:pickCredential', async (_event, name) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Select ${name}`,
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true, saved: Boolean(resolveConfig(name)) };
  }
  try {
    JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')); // validate
    fs.mkdirSync(appDataDir(), { recursive: true });
    fs.copyFileSync(result.filePaths[0], path.join(appDataDir(), name));
    return { saved: true };
  } catch (err) {
    return { saved: Boolean(resolveConfig(name)), error: `Invalid file: ${err.message}` };
  }
});

// Restart the app so the servers pick up the new config (they read it at boot).
ipcMain.handle('settings:relaunch', async () => {
  app.relaunch();
  app.exit(0);
});

// ---- Lifecycle --------------------------------------------------------------

// Friendlier name than "Electron" in the dev menu bar / About panel.
app.setName('Exam Transcriber');

app.whenReady().then(() => {
  // Show the logo on the macOS Dock during dev (packaged builds use the .icns).
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON)) {
    try { app.dock.setIcon(APP_ICON); } catch { /* non-fatal */ }
  }
  createWindow();
});

// Kill the spawned servers, then leave. Guarded so the multiple exit paths
// (window close, app quit, terminal signal) don't double-run it.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  killProcesses();
}

// Closing the app frees the ports on every platform (no lingering servers on
// macOS, where the app would otherwise stay alive after the window closes).
app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});

app.on('before-quit', shutdown);
app.on('quit', shutdown);

// Terminal signals: Ctrl-C (SIGINT), kills (SIGTERM), closed terminal (SIGHUP),
// and Ctrl-Z (SIGTSTP — normally just suspends, but we treat it as "shut down"
// so it doesn't leave the ports held by a stopped process). All tear down the
// servers and exit so ports 3000/5001 are freed for the next run.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP']) {
  process.on(sig, () => {
    shutdown();
    app.exit(0);
  });
}
