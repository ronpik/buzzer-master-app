// src/net/socket.js
//
// Single WebSocket to the local Node authority (DESIGN.md §8, §13, §14).
//
// Responsibilities:
//   - Hold ONE persistent WebSocket to the server on the same origin (WS_PATH).
//   - Auto-reconnect with exponential backoff (RECONNECT_BASE/MAX_DELAY_MS).
//   - Send `hello` on every (re)connect to (re)declare role/teamId/clientId.
//   - Own a ClockSync and drive its ping/pong over this socket; gate buzzing on
//     a completed first sync.
//   - Parse inbound frames and hand them to an injected `onMessage(msg)` (the
//     store), plus surface connection/sync status changes via `onStatus()`.
//
// It deliberately knows nothing about React. The store wires it up and feeds the
// UI. Outbound sends that matter (`buzz`) capture the edge timestamp in the
// caller's synchronous event handler; this module only converts to server time
// and serializes — no React state in the buzz critical path (DESIGN.md §11).

import {
  WS_PATH,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ROLE,
} from '../../shared/constants.js';
import { C2S, S2C } from '../../shared/protocol.js';
import { ClockSync, perfNow } from './clockSync.js';

/**
 * @typedef {'connecting'|'open'|'closed'} ConnectionStatus
 */

/**
 * Build the same-origin WebSocket URL (ws:// or wss:// to match the page).
 * The Node host serves the static client and the WS endpoint on one origin, so
 * we never hard-code a host/port — we follow `window.location`.
 * @returns {string}
 */
export function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${WS_PATH}`;
}

export class GameSocket {
  /**
   * @param {Object} opts
   * @param {ROLE} opts.role         Connection role (tablet | display | admin).
   * @param {string} opts.clientId   Stable per-device id (from localStorage).
   * @param {string} [opts.teamId]   Required when role === ROLE.TABLET.
   * @param {string} [opts.secret]   Optional admin gating secret.
   * @param {(msg: import('../../shared/protocol.js').ServerMessage) => void} opts.onMessage
   *   Called for every inbound server frame except `pong` (consumed internally).
   * @param {(status: { connection: ConnectionStatus, synced: boolean, clockOffset: number, lastRtt: number }) => void} [opts.onStatus]
   *   Called whenever connection state or clock-sync state changes.
   * @param {string} [opts.url]      Override the WS URL (tests). Defaults to {@link wsUrl}.
   */
  constructor({ role, clientId, teamId, secret, onMessage, onStatus, url }) {
    this.role = role;
    this.clientId = clientId;
    this.teamId = teamId;
    this.secret = secret;
    /** @private */ this._onMessage = onMessage || (() => {});
    /** @private */ this._onStatus = onStatus || (() => {});
    /** @private */ this._url = url || wsUrl();

    /** @type {WebSocket|null} @private */ this._ws = null;
    /** @type {ConnectionStatus} */ this.connection = 'closed';
    /** @private current reconnect backoff delay (ms). */ this._backoff = RECONNECT_BASE_DELAY_MS;
    /** @private setTimeout handle for the pending reconnect. */ this._reconnectTimer = null;
    /** @private set by close() to suppress auto-reconnect. */ this._closedByUser = false;

    /** @private the clock synchronizer, driven over this socket. */
    this._clock = new ClockSync({
      sendPing: (seq, t0) => this._sendPing(seq, t0),
      onChange: () => this._emitStatus(),
    });
  }

  // --- lifecycle ----------------------------------------------------------

  /** Open the socket and begin the connect/reconnect lifecycle. Idempotent. */
  connect() {
    this._closedByUser = false;
    if (
      this._ws &&
      (this._ws.readyState === WebSocket.OPEN ||
        this._ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this._open();
  }

  /** @private actually create the WebSocket and attach handlers. */
  _open() {
    this._setConnection('connecting');
    let ws;
    try {
      ws = new WebSocket(this._url);
    } catch {
      // Construction can throw on a malformed URL; treat as a failed attempt.
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._backoff = RECONNECT_BASE_DELAY_MS; // reset backoff on success
      this._setConnection('open');
      this._sendHello();
      this._clock.reset(); // unsynced until the fresh pass completes
      this._clock.start();
    });

    ws.addEventListener('message', (ev) => this._onFrame(ev));

    ws.addEventListener('close', () => {
      this._clock.stop();
      this._clock.reset(); // mark unsynced → tablet buzzer re-gated
      this._ws = null;
      this._setConnection('closed');
      if (!this._closedByUser) this._scheduleReconnect();
    });

    // On error, let the subsequent 'close' drive reconnect; avoid double-scheduling.
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  /** Permanently close the socket and stop reconnecting (page unmount). */
  close() {
    this._closedByUser = true;
    if (this._reconnectTimer != null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._clock.stop();
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
      this._ws = null;
    }
    this._setConnection('closed');
  }

  /** @private schedule a reconnect with exponential backoff + jitter. */
  _scheduleReconnect() {
    if (this._closedByUser || this._reconnectTimer != null) return;
    const jitter = Math.random() * 0.3 * this._backoff; // ±30% to de-sync clients
    const delay = Math.min(this._backoff, RECONNECT_MAX_DELAY_MS) + jitter;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._open();
    }, delay);
    this._backoff = Math.min(this._backoff * 2, RECONNECT_MAX_DELAY_MS);
  }

  // --- inbound ------------------------------------------------------------

  /** @private parse a frame and route it (pong → clock; everything else → store). */
  _onFrame(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // ignore non-JSON / malformed frames
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === S2C.PONG) {
      this._clock.onPong(msg);
      return; // pong is internal; the store never sees it
    }
    this._onMessage(msg);
  }

  // --- outbound -----------------------------------------------------------

  /** @private true when the socket can carry a frame right now. */
  get _isOpen() {
    return this._ws != null && this._ws.readyState === WebSocket.OPEN;
  }

  /**
   * @private low-level send of an already-built message object. Returns false if
   * the socket is not open (caller decides whether that matters).
   * @param {object} msg
   * @returns {boolean}
   */
  _send(msg) {
    if (!this._isOpen) return false;
    try {
      this._ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** @private (re)declare identity to the server on every (re)connect. */
  _sendHello() {
    /** @type {import('../../shared/protocol.js').HelloMsg} */
    const hello = {
      type: C2S.HELLO,
      role: this.role,
      clientId: this.clientId,
    };
    if (this.role === ROLE.TABLET && this.teamId != null) hello.teamId = this.teamId;
    if (this.secret != null) hello.secret = this.secret;
    this._send(hello);
  }

  /** @private send one clock-sync ping (called by ClockSync). */
  _sendPing(seq, t0) {
    /** @type {import('../../shared/protocol.js').PingMsg} */
    this._send({ type: C2S.PING, seq, t0 });
  }

  /**
   * Send a buzz. The caller MUST pass the edge timestamp captured synchronously
   * in the `pointerdown`/`touchstart` handler (a `performance.now()`-origin ms,
   * e.g. `event.timeStamp`); this converts it to server time and sends
   * immediately (DESIGN.md §11). If `edgePerfTs` is omitted we fall back to
   * `perfNow()` at call time.
   *
   * Refuses to send (returns false) if not synced or no current round — a
   * bad-clock or stale press must never reach the server.
   *
   * @param {string} roundId  The current round id.
   * @param {number} [edgePerfTs] Edge timestamp in `performance.now()` origin (ms).
   * @returns {boolean} whether a buzz frame was put on the wire.
   */
  buzz(roundId, edgePerfTs) {
    if (!this._clock.synced) return false;
    if (!roundId) return false;
    const perfTs = typeof edgePerfTs === 'number' ? edgePerfTs : perfNow();
    const pressAt = this._clock.toServerTime(perfTs);
    /** @type {import('../../shared/protocol.js').BuzzMsg} */
    return this._send({ type: C2S.BUZZ, roundId, pressAt });
  }

  /** Admin: open a new question. @returns {boolean} */
  openQuestion() {
    return this._send({ type: C2S.OPEN_QUESTION });
  }

  /** Admin: clear the current buzz and reopen the same round. @param {string} roundId @returns {boolean} */
  clearBuzz(roundId) {
    return this._send({ type: C2S.CLEAR_BUZZ, roundId });
  }

  /** Admin: reset the game to idle. @returns {boolean} */
  resetGame() {
    return this._send({ type: C2S.RESET_GAME });
  }

  /**
   * Admin: create or edit a team. Omit `id` to create.
   * @param {{ id?: string, name: string, color: string, banner_url?: string, slot: number }} team
   * @returns {boolean}
   */
  upsertTeam(team) {
    return this._send({ type: C2S.UPSERT_TEAM, ...team });
  }

  /** Admin: delete a team. @param {string} id @returns {boolean} */
  deleteTeam(id) {
    return this._send({ type: C2S.DELETE_TEAM, id });
  }

  // --- status -------------------------------------------------------------

  /** @private set connection status and notify if it changed. */
  _setConnection(status) {
    if (this.connection === status) return;
    this.connection = status;
    this._emitStatus();
  }

  /** @private push the combined connection + clock-sync snapshot to the owner. */
  _emitStatus() {
    const c = this._clock.getState();
    this._onStatus({
      connection: this.connection,
      synced: c.synced,
      clockOffset: c.clockOffset,
      lastRtt: c.lastRtt,
    });
  }

  /**
   * Current combined status snapshot (connection + clock sync).
   * @returns {{ connection: ConnectionStatus, synced: boolean, clockOffset: number, lastRtt: number }}
   */
  getStatus() {
    const c = this._clock.getState();
    return {
      connection: this.connection,
      synced: c.synced,
      clockOffset: c.clockOffset,
      lastRtt: c.lastRtt,
    };
  }

  /**
   * Convert a client-side `performance.now()`-origin timestamp to server time.
   * Exposed so a page can stamp an edge event and pass it straight to {@link buzz}.
   * @param {number} perfTs
   * @returns {number}
   */
  toServerTime(perfTs) {
    return this._clock.toServerTime(perfTs);
  }
}
