// server/index.js
//
// Bootstrap for the local buzzer host (DESIGN.md §8, §17, §18 phase 0).
//
// One Node process serves everything on a single origin/port:
//   • the built React client (Vite `dist/`) as static files, with SPA fallback
//     so /play, /display and / all load the app;
//   • optional uploaded banner assets under /assets/uploads;
//   • the WebSocket endpoint (WS_PATH) that is the game's single source of truth.
//
// Boot order matters: the WS layer is created first (it provides broadcast +
// presence), then the game authority is created with those, then bound back into
// the WS layer. The live round always starts `idle` — we never resume a
// half-open round across a restart (DESIGN.md §14); team list and the question
// counter are recovered from SQLite.

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT, WS_PATH } from '../shared/constants.js';
import { openDb } from './db.js';
import { createSettings } from './settings.js';
import { createGame } from './game.js';
import { attachWebSocket } from './ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Vite build output served as the client. Override with CLIENT_DIST. */
const DIST_DIR = process.env.CLIENT_DIST
  ? resolve(process.env.CLIENT_DIST)
  : resolve(__dirname, '..', 'dist');

/** Directory for operator-uploaded banner assets, served at /assets/uploads/. */
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : resolve(__dirname, 'uploads');

const PORT = Number(process.env.PORT) || DEFAULT_PORT;

/** Minimal content-type map for the static assets a Vite build emits. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Stream a file with the right content type. Returns true if it handled the
 * response (file existed and was a regular file), false otherwise.
 * @param {string} filePath
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean}
 */
function tryServeFile(filePath, res) {
  if (!existsSync(filePath)) return false;
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  // Hashed Vite assets are immutable; index.html must never be cached.
  const isIndex = filePath.endsWith('index.html');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': isIndex
      ? 'no-cache'
      : (filePath.includes(`${join('assets', '')}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/**
 * Safely join a URL path under a root, preventing `..` traversal.
 * @param {string} root
 * @param {string} urlPath
 * @returns {?string} Absolute path inside root, or null if it escapes.
 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const joined = normalize(join(root, decoded));
  if (joined !== root && !joined.startsWith(root + (root.endsWith('/') ? '' : '/'))) {
    return null;
  }
  return joined;
}

/**
 * The HTTP request handler: health check, uploaded assets, static client files,
 * and SPA fallback to index.html for client-router paths (/, /play, /display).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleHttp(req, res) {
  const url = req.url || '/';

  // Lightweight health/liveness probe (handy for the runbook & tests).
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Operator-uploaded banners (optional; directory may not exist).
  if (url.startsWith('/assets/uploads/')) {
    const rel = url.slice('/assets/uploads/'.length);
    const filePath = safeJoin(UPLOADS_DIR, rel);
    if (filePath && tryServeFile(filePath, res)) return;
    res.writeHead(404).end('Not found');
    return;
  }

  // Static client files from dist/.
  const pathname = url.split('?')[0];
  if (pathname !== '/') {
    const filePath = safeJoin(DIST_DIR, pathname);
    if (filePath && tryServeFile(filePath, res)) return;
  }

  // SPA fallback: serve index.html for the app shell + all client routes.
  const indexHtml = join(DIST_DIR, 'index.html');
  if (tryServeFile(indexHtml, res)) return;

  // No build present yet (dev hasn't run `npm run build`). Be explicit.
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    'Client build not found.\n' +
    `Expected ${indexHtml}\n` +
    'Run `npm run build` first, or set CLIENT_DIST to the build directory.\n',
  );
}

/**
 * Wire everything together and start listening.
 * @returns {{ server: http.Server, ws: ReturnType<typeof attachWebSocket>, db: ReturnType<typeof openDb> }}
 */
export function start() {
  const db = openDb();
  const settings = createSettings(db);
  db.seedDefaultTeamsIfEmpty();

  const server = http.createServer(handleHttp);

  // 1) Transport edge (provides broadcast + presence).
  const ws = attachWebSocket({ server });

  // 2) Game authority, fed by the transport's broadcast/presence.
  const game = createGame({
    db,
    settings,
    broadcast: ws.broadcast,
    getConnectedTeamIds: ws.getConnectedTeamIds,
  });

  // 3) Bind the game back into the transport so it can dispatch messages.
  ws.setGame(game);

  server.listen(PORT, () => {
    const last = db.getLastRound();
    // eslint-disable-next-line no-console
    console.log(
      `[buzzer] host listening on http://0.0.0.0:${PORT}  (ws ${WS_PATH})\n` +
      `[buzzer]   admin:   http://localhost:${PORT}/\n` +
      `[buzzer]   buzzer:  http://<host>:${PORT}/play\n` +
      `[buzzer]   display: http://<host>:${PORT}/display\n` +
      `[buzzer]   teams: ${db.listTeams().length}, ` +
      `question#: ${game._getQuestionNumber()}` +
      (last ? `, last round: ${last.status}` : ', no prior rounds') +
      `, settling window: ${settings.getSettlingWindowMs()}ms`,
    );
  });

  // Graceful shutdown so the DB flushes and sockets close cleanly.
  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`[buzzer] ${signal} received, shutting down…`);
    ws.close();
    server.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    // Hard exit if something hangs.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, ws, db };
}

// Start when invoked directly (`node server/index.js`), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
