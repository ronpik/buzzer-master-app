// packaging/launcher.mjs
//
// Entry point for the BUNDLED Windows/macOS app (not used in dev).
//
// At install time this file is copied to the app root, next to `server/`,
// `dist/`, the bundled `node` binary, and a minimal runtime `node_modules`
// (just `ws` + `better-sqlite3`). The Start Menu / Desktop shortcut runs:
//
//     node(.exe)  launcher.mjs
//
// It does four things, in order:
//   1. Redirect the SQLite DB + uploads to a WRITABLE per-user directory
//      (Program Files is read-only), and point CLIENT_DIST at the bundled build.
//   2. Start the existing host server (server/index.js → start()) IN THIS
//      process, so closing this window stops the server.
//   3. Print the host's LAN IP + the Admin/Display/Play URLs for the operator.
//   4. Open the Admin page in the default browser once the server is listening.

import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.title = 'Buzz Master';

// This file lives at the app root after bundling (sibling of server/ and dist/).
const APP_ROOT = dirname(fileURLToPath(import.meta.url));

/** Writable per-user data directory for the SQLite DB + uploaded banners. */
function dataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
    return join(base, 'BuzzMaster');
  }
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', 'BuzzMaster');
  }
  return join(os.homedir(), '.local', 'share', 'BuzzMaster');
}

const DATA = dataDir();
mkdirSync(DATA, { recursive: true });
mkdirSync(join(DATA, 'uploads'), { recursive: true });

// --- 1) Configure the server via its existing env hooks (set BEFORE import) ---
const PORT = process.env.PORT || '8080';
process.env.PORT = PORT;
process.env.BUZZER_DB = process.env.BUZZER_DB || join(DATA, 'buzzer.db');
process.env.UPLOADS_DIR = process.env.UPLOADS_DIR || join(DATA, 'uploads');
process.env.CLIENT_DIST = process.env.CLIENT_DIST || resolve(APP_ROOT, 'dist');

/** Best-effort first non-internal IPv4 address (the tablets' host IP). */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}

/** Open a URL in the OS default browser, detached. */
function openBrowser(url) {
  const spec = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(spec[0], spec[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* a missing browser launcher must never crash the host */
  }
}

// --- 2) Start the host server in this process ---
const serverUrl = pathToFileURL(join(APP_ROOT, 'server', 'index.js')).href;
const { start } = await import(serverUrl);
const { server } = start();

// --- 3 & 4) Announce + open the Admin once the socket is actually listening ---
function onReady() {
  const ip = lanIp();
  const rule = '─'.repeat(54);
  console.log(
    `\n${rule}\n` +
    `  Buzz Master is running.\n\n` +
    `  Admin   (this machine):  http://localhost:${PORT}/\n` +
    `  Display (projector)   :  http://localhost:${PORT}/display\n` +
    `  Tablets (this Wi-Fi)  :  http://${ip}:${PORT}/play\n\n` +
    `  Data folder:  ${DATA}\n` +
    `  Keep this window open during the event. Close it to stop the server.\n` +
    `${rule}\n`,
  );
  // BUZZER_NO_OPEN lets headless/kiosk/CI runs start the host without popping
  // a browser; the default (operator) path always opens the Admin page.
  if (!process.env.BUZZER_NO_OPEN) openBrowser(`http://localhost:${PORT}/`);
}

if (server.listening) onReady();
else server.once('listening', onReady);
