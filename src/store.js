// src/store.js
//
// The single client-side game store (DESIGN.md §13). It is fed exclusively by
// server messages over one WebSocket and is the only state the React pages read.
// Replaces the Base44 + React-Query data layer: there is no local "session" to
// mutate and no last-write-wins — the server is the sole authority and we render
// whatever its `state` / events say.
//
// Implementation: a tiny external store exposed to React via `useSyncExternalStore`
// (React 18 built-in — no extra dependency). Components subscribe with the
// `useGame(selector)` hook (selector + `Object.is` bail-out, like Zustand) and
// call action methods (`buzz`, `openQuestion`, …) which delegate to the socket.
//
// Wire contract: imports message types from ../shared/protocol.js and tuning /
// enums from ../shared/constants.js, so this never drifts from the server.

import { useSyncExternalStore } from 'react';
import { S2C } from '../shared/protocol.js';
import { STATUS, ROLE } from '../shared/constants.js';
import { GameSocket } from './net/socket.js';
import { perfNow } from './net/clockSync.js';

/**
 * @typedef {import('../shared/protocol.js').Team} Team
 * @typedef {import('../shared/protocol.js').Winner} Winner
 * @typedef {import('../shared/protocol.js').RankingEntry} RankingEntry
 */

/**
 * @typedef {Object} GameState
 * @property {import('./net/socket.js').ConnectionStatus} connection  WS connection status.
 * @property {boolean} synced              True once clock sync has completed.
 * @property {number} clockOffset          ms to add to client time → server time.
 * @property {number} lastRtt              ms RTT of the current offset sample.
 * @property {STATUS} status               Authoritative game status.
 * @property {?string} roundId             Current round id, or null when idle.
 * @property {number} questionNumber       Current question number (0 when reset).
 * @property {?number} openAt              Server ms the round opened, or null.
 * @property {Team[]} teams                All teams, ordered by slot.
 * @property {string[]} connected          teamIds of currently-connected tablets.
 * @property {?Winner} winner              Winner when status === BUZZED, else null.
 * @property {RankingEntry[]} ranking      Full ordering from the last buzzResult.
 * @property {?{ roundId: string, reason: string }} lastReject  Last rejection for THIS client.
 * @property {boolean} buzzSent            Optimistic: this tablet has pressed this round.
 */

/** Initial, pre-connection state. */
function initialState() {
  return {
    // connection / clock
    connection: /** @type {const} */ ('closed'),
    synced: false,
    clockOffset: 0,
    lastRtt: 0,
    // authoritative game state (server-owned)
    status: STATUS.IDLE,
    roundId: null,
    questionNumber: 0,
    openAt: null,
    teams: [],
    connected: [],
    winner: null,
    ranking: [],
    // local-only UI state for this client
    lastReject: null,
    buzzSent: false,
  };
}

class GameStore {
  constructor() {
    /** @type {GameState} @private */ this._state = initialState();
    /** @type {Set<() => void>} @private */ this._listeners = new Set();
    /** @type {GameSocket|null} @private */ this._socket = null;
    /** @private role this store was initialized with (tablet|display|admin). */
    this._role = null;
    /** @private teamId for the tablet role (used to derive my win/lose). */
    this._teamId = null;
  }

  // --- external-store contract (useSyncExternalStore) ---------------------

  /** @param {() => void} listener @returns {() => void} unsubscribe */
  subscribe = (listener) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  /** @returns {GameState} the current immutable snapshot. */
  getSnapshot = () => this._state;

  /** @private replace state (shallow-merged) and notify subscribers. */
  _set(patch) {
    this._state = { ...this._state, ...patch };
    for (const l of this._listeners) l();
  }

  // --- setup --------------------------------------------------------------

  /**
   * Connect to the server for a given role. Idempotent per role+identity: a
   * second call with the same args is a no-op; different args tear down and
   * reconnect. Returns a disposer suitable for a React effect cleanup.
   *
   * @param {Object} opts
   * @param {ROLE} opts.role        ROLE.TABLET | ROLE.DISPLAY | ROLE.ADMIN.
   * @param {string} opts.clientId  Stable per-device id (from localStorage).
   * @param {string} [opts.teamId]  Required for ROLE.TABLET.
   * @param {string} [opts.secret]  Optional admin secret.
   * @param {string} [opts.url]     Override WS URL (tests).
   * @returns {() => void} disposer that closes the socket.
   */
  init({ role, clientId, teamId, secret, url }) {
    const sameIdentity =
      this._socket &&
      this._role === role &&
      this._teamId === (teamId ?? null) &&
      this._socket.clientId === clientId;
    if (sameIdentity) return () => this.dispose();

    // Tear down any previous socket before re-initializing.
    if (this._socket) this.dispose();

    this._role = role;
    this._teamId = teamId ?? null;

    this._socket = new GameSocket({
      role,
      clientId,
      teamId,
      secret,
      url,
      onMessage: (msg) => this._onMessage(msg),
      onStatus: (s) => this._onStatus(s),
    });
    this._socket.connect();
    return () => this.dispose();
  }

  /** Close the socket and reset to initial state. */
  dispose() {
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
    this._role = null;
    this._teamId = null;
    this._set(initialState());
  }

  // --- inbound message handling -------------------------------------------

  /** @private apply a connection/clock status update from the socket. */
  _onStatus({ connection, synced, clockOffset, lastRtt }) {
    const patch = { connection, synced, clockOffset, lastRtt };
    // On a dropped connection, clear the optimistic "pressed" flag so a tablet
    // is never left stuck showing it pressed (fixes the old "pressing stuck
    // true" bug, DESIGN.md §14); the authoritative state arrives on reconnect.
    if (connection !== 'open') patch.buzzSent = false;
    this._set(patch);
  }

  /**
   * @private route an inbound server frame into state. `pong` never reaches
   * here (consumed by the socket's clock layer).
   * @param {import('../shared/protocol.js').ServerMessage} msg
   */
  _onMessage(msg) {
    switch (msg.type) {
      case S2C.STATE: {
        // Full authoritative snapshot — replace the server-owned slice wholesale.
        const isOpen = msg.status === STATUS.OPEN || msg.status === STATUS.SETTLING;
        this._set({
          status: msg.status,
          roundId: msg.roundId ?? null,
          questionNumber: msg.questionNumber ?? 0,
          openAt: msg.openAt ?? null,
          teams: msg.teams ?? [],
          connected: msg.connected ?? [],
          winner: msg.winner ?? null,
          // A fresh snapshot that isn't a decided round clears stale UI bits.
          ranking: msg.status === STATUS.BUZZED ? this._state.ranking : [],
          lastReject: isOpen ? null : this._state.lastReject,
          // Keep an in-flight optimistic press only while the round is still open.
          buzzSent: isOpen ? this._state.buzzSent : false,
        });
        break;
      }

      case S2C.ROUND_OPEN: {
        // A new question went live — reset per-round local UI for this client.
        this._set({
          status: STATUS.OPEN,
          roundId: msg.roundId,
          questionNumber: msg.questionNumber,
          openAt: msg.openAt,
          winner: null,
          ranking: [],
          lastReject: null,
          buzzSent: false,
        });
        break;
      }

      case S2C.BUZZ_RESULT: {
        this._set({
          status: STATUS.BUZZED,
          roundId: msg.roundId,
          winner: msg.winner,
          ranking: msg.ranking ?? [],
        });
        break;
      }

      case S2C.REJECTED: {
        // Surface to this client (tablet) and drop the optimistic press.
        this._set({
          lastReject: { roundId: msg.roundId, reason: msg.reason },
          buzzSent: false,
        });
        break;
      }

      case S2C.RESET: {
        this._set({
          status: STATUS.IDLE,
          roundId: null,
          questionNumber: 0,
          openAt: null,
          winner: null,
          ranking: [],
          lastReject: null,
          buzzSent: false,
        });
        break;
      }

      case S2C.PRESENCE: {
        this._set({ connected: msg.connected ?? [] });
        break;
      }

      case S2C.ERROR: {
        // Non-fatal protocol/validation error; log for diagnostics, keep state.
        console.warn('[game] server error:', msg.message);
        break;
      }

      default:
        break;
    }
  }

  // --- actions (delegate to the socket) -----------------------------------

  /**
   * Buzz for the current round. Pass the edge timestamp captured synchronously
   * in the `pointerdown`/`touchstart` handler (`event.timeStamp`, same origin as
   * `performance.now()`); omit it to stamp now. Optimistically marks `buzzSent`
   * so the UI shows "pressed" instantly; the real outcome arrives via
   * `buzzResult`/`rejected`. No-op (returns false) if not synced / not open.
   *
   * @param {number} [edgePerfTs] Edge timestamp in `performance.now()` origin (ms).
   * @returns {boolean} whether a buzz was sent.
   */
  buzz(edgePerfTs) {
    const s = this._state;
    if (!this._socket) return false;
    if (!s.synced) return false;
    if (s.status !== STATUS.OPEN && s.status !== STATUS.SETTLING) return false;
    if (s.buzzSent) return false; // local de-dupe; server also de-dupes per team
    if (!s.roundId) return false;

    const ts = typeof edgePerfTs === 'number' ? edgePerfTs : perfNow();
    const ok = this._socket.buzz(s.roundId, ts);
    if (ok) this._set({ buzzSent: true });
    return ok;
  }

  /** Admin: open a new question. @returns {boolean} */
  openQuestion() {
    return this._socket ? this._socket.openQuestion() : false;
  }

  /** Admin: clear the current buzz and reopen the same round. @returns {boolean} */
  clearBuzz() {
    const id = this._state.roundId;
    return this._socket && id ? this._socket.clearBuzz(id) : false;
  }

  /** Admin: reset the game to idle. @returns {boolean} */
  resetGame() {
    return this._socket ? this._socket.resetGame() : false;
  }

  /**
   * Admin: create or edit a team (omit `id` to create).
   * @param {{ id?: string, name: string, color: string, banner_url?: string, slot: number }} team
   * @returns {boolean}
   */
  upsertTeam(team) {
    return this._socket ? this._socket.upsertTeam(team) : false;
  }

  /** Admin: delete a team. @param {string} id @returns {boolean} */
  deleteTeam(id) {
    return this._socket ? this._socket.deleteTeam(id) : false;
  }
}

// ---------------------------------------------------------------------------
// Singleton + React bindings
// ---------------------------------------------------------------------------

/** The single store instance shared by every page. */
export const store = new GameStore();

const identity = (s) => s;

/**
 * Subscribe a component to the game store with an optional selector. Re-renders
 * only when the selected slice changes (`Object.is`), mirroring Zustand's API.
 *
 * @template [T=GameState]
 * @param {(state: GameState) => T} [selector] Defaults to the whole state.
 * @returns {T}
 *
 * @example
 *   const status = useGame((s) => s.status);
 *   const teams  = useGame((s) => s.teams);
 */
export function useGame(selector = identity) {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}

// --- convenience selector hooks (stable references) ------------------------

const selStatus = (s) => s.status;
const selTeams = (s) => s.teams;
const selConnected = (s) => s.connected;
const selWinner = (s) => s.winner;
const selRanking = (s) => s.ranking;
const selQuestionNumber = (s) => s.questionNumber;
const selRoundId = (s) => s.roundId;
const selOpenAt = (s) => s.openAt;
const selBuzzSent = (s) => s.buzzSent;
const selLastReject = (s) => s.lastReject;

/** @returns {STATUS} current game status. */
export const useStatus = () => useGame(selStatus);
/** @returns {Team[]} teams ordered by slot. */
export const useTeams = () => useGame(selTeams);
/** @returns {string[]} connected tablet teamIds. */
export const useConnected = () => useGame(selConnected);
/** @returns {?Winner} winner when buzzed, else null. */
export const useWinner = () => useGame(selWinner);
/** @returns {RankingEntry[]} ordering from the last buzzResult. */
export const useRanking = () => useGame(selRanking);
/** @returns {number} current question number. */
export const useQuestionNumber = () => useGame(selQuestionNumber);
/** @returns {?string} current round id. */
export const useRoundId = () => useGame(selRoundId);
/** @returns {?number} server ms the round opened. */
export const useOpenAt = () => useGame(selOpenAt);
/** @returns {boolean} whether this client optimistically pressed this round. */
export const useBuzzSent = () => useGame(selBuzzSent);
/** @returns {?{roundId:string,reason:string}} last rejection for this client. */
export const useLastReject = () => useGame(selLastReject);

/**
 * Combined connection + clock-sync status for indicators / the sync gate.
 * Reads each field with its own selector so the returned object is rebuilt only
 * when a field actually changes (no new-object churn / render loop).
 * @returns {{ connection: import('./net/socket.js').ConnectionStatus, synced: boolean, clockOffset: number, lastRtt: number }}
 */
export function useConnection() {
  const connection = useGame((s) => s.connection);
  const synced = useGame((s) => s.synced);
  const clockOffset = useGame((s) => s.clockOffset);
  const lastRtt = useGame((s) => s.lastRtt);
  return { connection, synced, clockOffset, lastRtt };
}

/**
 * Whether the buzzer button should be live for a tablet: round open, clock
 * synced, connected, and this client hasn't already pressed (DESIGN.md §11, §13).
 * @returns {boolean}
 */
export function useCanBuzz() {
  return useGame(
    (s) =>
      s.connection === 'open' &&
      s.synced &&
      (s.status === STATUS.OPEN || s.status === STATUS.SETTLING) &&
      !s.buzzSent,
  );
}

/**
 * This tablet's outcome for the current decided round: 'won', 'lost', or null.
 * Requires the store to have been initialized with a tablet `teamId`.
 * @returns {('won'|'lost'|null)}
 */
export function useMyResult() {
  const status = useGame(selStatus);
  const winner = useGame(selWinner);
  return useGame((s) => {
    if (status !== STATUS.BUZZED || !winner) return null;
    if (!store._teamId) return null;
    return winner.teamId === store._teamId ? 'won' : 'lost';
  });
}

// --- non-hook action exports (for handlers / non-component callers) --------

/**
 * Initialize the shared store's connection. Call once per page (e.g. in an
 * effect) and use the returned disposer as the effect cleanup.
 * @param {{ role: ROLE, clientId: string, teamId?: string, secret?: string, url?: string }} opts
 * @returns {() => void}
 */
export const initGame = (opts) => store.init(opts);

/** @see GameStore#buzz */
export const buzz = (edgePerfTs) => store.buzz(edgePerfTs);
/** @see GameStore#openQuestion */
export const openQuestion = () => store.openQuestion();
/** @see GameStore#clearBuzz */
export const clearBuzz = () => store.clearBuzz();
/** @see GameStore#resetGame */
export const resetGame = () => store.resetGame();
/** @see GameStore#upsertTeam */
export const upsertTeam = (team) => store.upsertTeam(team);
/** @see GameStore#deleteTeam */
export const deleteTeam = (id) => store.deleteTeam(id);
