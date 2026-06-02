// server/ws.js
//
// WebSocket connection lifecycle, role routing, presence, and broadcast
// (DESIGN.md §8, §9). This is the transport edge: it owns the set of live
// connections and translates wire messages into calls on the game authority
// (game.js) and the clock responder (clock.js). It contains NO game logic.
//
// Presence model (DESIGN.md §8): the socket IS the presence. A tablet is
// "connected" exactly while its WebSocket is open — there is no heartbeat table
// and there are no stale rows. We additionally run a protocol-level keepalive
// ping to reap half-open sockets promptly so presence stays accurate.

import { WebSocketServer } from 'ws';
import { WS_PATH, ROLE } from '../shared/constants.js';
import { C2S, S2C } from '../shared/protocol.js';
import { handlePing } from './clock.js';

/** How often (ms) to send a protocol-level keepalive ping to each socket. */
const KEEPALIVE_INTERVAL_MS = 15000;

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * The game authority is bound AFTER construction via the returned `setGame`,
 * because game.js needs this layer's `broadcast`/`getConnectedTeamIds` at
 * creation time and this layer needs the game to dispatch messages — a mutual
 * dependency index.js resolves by wiring them in order.
 *
 * @param {Object} deps
 * @param {import('node:http').Server} deps.server  The HTTP server to upgrade on.
 * @returns {{
 *   broadcast: (msg: import('../shared/protocol.js').ServerMessage) => void,
 *   getConnectedTeamIds: () => string[],
 *   setGame: (game: any) => void,
 *   wss: WebSocketServer,
 *   close: () => void,
 * }}
 */
export function attachWebSocket({ server }) {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  /**
   * The game authority. Bound via setGame() during boot, before any socket can
   * realistically send a message. Reads go through this binding so the closure
   * always sees the current game.
   * @type {any}
   */
  let game = null;

  /**
   * Per-connection bookkeeping. We decorate the raw `ws` with our own fields and
   * keep the set here so broadcast/presence are O(connections).
   * @type {Set<ConnState>}
   */
  const conns = new Set();

  /**
   * @typedef {Object} ConnState
   * @property {import('ws').WebSocket} ws
   * @property {?string} role       ROLE.* once `hello` is received.
   * @property {?string} teamId     Present for tablets.
   * @property {?string} clientId   Stable per-device id from `hello`.
   * @property {?number} lastRtt    Last known RTT for this client, if any.
   * @property {boolean} isAlive    Keepalive liveness flag.
   * @property {(msg: any) => void} send  Safe JSON sender (no-op if not open).
   */

  /**
   * Send a single message to every OPEN connection. Used by game.js for all
   * broadcasts (state/roundOpen/buzzResult/rejected/reset/presence).
   * @param {import('../shared/protocol.js').ServerMessage} msg
   */
  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of conns) {
      if (c.ws.readyState === c.ws.OPEN) {
        c.ws.send(data);
      }
    }
  }

  /**
   * Distinct teamIds of currently-connected tablets (presence = open sockets).
   * @returns {string[]}
   */
  function getConnectedTeamIds() {
    const ids = new Set();
    for (const c of conns) {
      if (c.role === ROLE.TABLET && c.teamId && c.ws.readyState === c.ws.OPEN) {
        ids.add(c.teamId);
      }
    }
    return [...ids];
  }

  wss.on('connection', (ws) => {
    /** @type {ConnState} */
    const conn = {
      ws,
      role: null,
      teamId: null,
      clientId: null,
      lastRtt: null,
      isAlive: true,
      send: (msg) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },
    };
    conns.add(conn);

    ws.on('pong', () => { conn.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        conn.send({ type: S2C.ERROR, message: 'invalid JSON frame' });
        return;
      }
      handleMessage(conn, msg);
    });

    ws.on('close', () => {
      conns.delete(conn);
      // A tablet leaving changes presence; tell everyone.
      if (conn.role === ROLE.TABLET) {
        game.broadcastPresence();
      }
    });

    ws.on('error', () => {
      // Treat errors as a close; the 'close' event will follow and clean up.
    });
  });

  /**
   * Route one parsed client message (DESIGN.md §9 client → server table).
   * @param {ConnState} conn
   * @param {import('../shared/protocol.js').ClientMessage} msg
   */
  function handleMessage(conn, msg) {
    if (!game) {
      // Should not happen in practice (game is bound during boot); fail safe.
      conn.send({ type: S2C.ERROR, message: 'server not ready' });
      return;
    }
    switch (msg && msg.type) {
      case C2S.HELLO:
        onHello(conn, msg);
        break;

      case C2S.PING:
        // Clock-sync probe — answered as late as possible inside handlePing.
        handlePing(conn.send, msg);
        break;

      case C2S.BUZZ:
        game.handleBuzz(conn, msg);
        break;

      case C2S.OPEN_QUESTION:
        if (requireAdmin(conn)) game.openQuestion();
        break;

      case C2S.CLEAR_BUZZ:
        if (requireAdmin(conn)) game.clearBuzz(msg.roundId);
        break;

      case C2S.RESET_GAME:
        if (requireAdmin(conn)) game.resetGame();
        break;

      case C2S.UPSERT_TEAM:
        if (requireAdmin(conn)) game.upsertTeam(msg);
        break;

      case C2S.DELETE_TEAM:
        if (requireAdmin(conn)) game.deleteTeam(msg.id);
        break;

      default:
        conn.send({ type: S2C.ERROR, message: `unknown message type: ${msg && msg.type}` });
    }
  }

  /**
   * Process a `hello`: bind role/identity, send a full `state` snapshot so the
   * (re)connecting client agrees with the authority, and refresh presence if a
   * tablet just joined.
   * @param {ConnState} conn
   * @param {import('../shared/protocol.js').HelloMsg} msg
   */
  function onHello(conn, msg) {
    const role = msg.role;
    if (role !== ROLE.TABLET && role !== ROLE.DISPLAY && role !== ROLE.ADMIN) {
      conn.send({ type: S2C.ERROR, message: `invalid role: ${role}` });
      return;
    }
    conn.role = role;
    conn.clientId = msg.clientId ?? null;
    conn.teamId = role === ROLE.TABLET ? (msg.teamId ?? null) : null;

    if (role === ROLE.TABLET && !conn.teamId) {
      conn.send({ type: S2C.ERROR, message: 'tablet hello missing teamId' });
    }

    // Always answer a hello with the authoritative snapshot.
    conn.send(game.buildState());

    // A tablet (re)joining changes presence for everyone.
    if (role === ROLE.TABLET) {
      game.broadcastPresence();
    }
  }

  /**
   * Gate admin-only actions. With a single trusted LAN (DESIGN.md §2) we accept
   * any connection that declared the admin role; we still reject non-admins so a
   * stray tablet/display frame can't drive the game.
   * @param {ConnState} conn
   * @returns {boolean}
   */
  function requireAdmin(conn) {
    if (conn.role === ROLE.ADMIN) return true;
    conn.send({ type: S2C.ERROR, message: 'admin role required for this action' });
    return false;
  }

  // --- Keepalive: reap half-open sockets so presence stays truthful --------
  const keepalive = setInterval(() => {
    for (const c of conns) {
      if (!c.isAlive) {
        c.ws.terminate(); // triggers 'close' → presence refresh
        continue;
      }
      c.isAlive = false;
      if (c.ws.readyState === c.ws.OPEN) {
        c.ws.ping();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  return {
    broadcast,
    getConnectedTeamIds,
    /** Bind the game authority (called once during boot). */
    setGame(g) { game = g; },
    wss,
    close() {
      clearInterval(keepalive);
      for (const c of conns) {
        try { c.ws.close(); } catch { /* ignore */ }
      }
      wss.close();
    },
  };
}
