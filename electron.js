import { exec } from "child_process";
import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import isDev from "electron-is-dev";
import dotenv from 'dotenv';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let nodeServer;
let pythonServer;

const envPath = path.join(process.cwd(), ".env");

// Check if .env exists before loading
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log("Loaded .env from:", envPath);
} else {
    console.warn(".env file not found in:", envPath);
}


function killProcesses() {
  if (nodeServer) {
    process.platform === 'win32' ? exec(`taskkill /pid ${nodeServer.pid} /T /F`) : nodeServer.kill('SIGINT');
  }
  if (pythonServer) {
    process.platform === 'win32' ? exec(`taskkill /pid ${pythonServer.pid} /T /F`) : pythonServer.kill('SIGINT');
  }
}

function startServers() {
  // Start servers based on platform
  if (process.platform === 'win32') {
    const serverPath = isDev ? "server.js" : path.join(__dirname, "server.js");
    const pythonPath = isDev ? "app.py" : path.join(__dirname, "app.py");
    const envPath = isDev ? ".env" : path.join(__dirname, ".env");
    
    // Windows: Open a new CMD window and run both servers without pause
    exec(`start cmd.exe /K "set ELECTRON_IS_PACKAGED=true && set DOTENV_CONFIG_PATH=${envPath} && start /b node "${serverPath}" & start /b python "${pythonPath}""`, {
      cwd: __dirname,
      env: {
        ...process.env,
        ELECTRON_IS_PACKAGED: 'true'
      }
    });
  } else {
    // Mac/Linux: Open a new terminal window
    const serverPath = isDev ? "server.js" : path.join(__dirname, "server.js");
    const pythonPath = isDev ? "app.py" : path.join(__dirname, "app.py");
    exec(`osascript -e 'tell app "Terminal" to do script "node ${serverPath} & python3.11 ${pythonPath}"'`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Handle development vs production paths
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, 'build', 'index.html'));
  }

  // Start the servers in a new terminal window
  startServers();

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killProcesses();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', killProcesses);
app.on('before-quit', killProcesses);
