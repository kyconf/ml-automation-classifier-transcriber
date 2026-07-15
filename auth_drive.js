import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, 'drive_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'drive_token.json');
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const PORT = 4000;
const REDIRECT_URI = `http://localhost:${PORT}`;

const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const { client_id, client_secret } = creds.installed;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force refresh_token to be returned
});

console.log('🌐 Opening browser for Google Drive authorization...');
function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log('Could not open a browser automatically. Visit this URL manually:\n', url);
    }
  });
}
openBrowser(authUrl);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400);
      res.end('No authorization code found.');
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log('✅ Drive token saved to drive_token.json');
    console.log('✅ You can now start the server normally.');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>✅ Authorization successful! You can close this tab and start the server.</h1>');

    server.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error getting token:', err.message);
    res.writeHead(500);
    res.end('Error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for Google to redirect to http://localhost:${PORT}...`);
});
