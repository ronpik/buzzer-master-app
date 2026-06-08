// shared/protocol.js
//
// The authoritative WebSocket protocol contract (DESIGN.md §9).
// Pure ESM, browser-safe — NO node-only imports.
//
// Every frame is a JSON text frame with a `type` field drawn from C2S (client→
// server) or S2C (server→client) below. Timestamps that matter (`pressAt`,
// `openAt`, `winner.pressAt`, `t`) are in SERVER time (milliseconds, from the
// server's monotonic `performance.now()` origin); clients convert local
// `performance.now()` values via their measured clock offset before sending.
//
// This file is the single place that defines the message-type strings and the
// payload shapes. The server, the client net layer, and the pages all import
// from here so the wire format can never drift between them.

import { ROLE, STATUS, REJECT_REASON } from './constants.js';

// ---------------------------------------------------------------------------
// Message type strings
// ---------------------------------------------------------------------------

/**
 * Client → Server message types (DESIGN.md §9).
 * @readonly
 * @enum {string}
 */
export const C2S = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  BUZZ: 'buzz',
  OPEN_QUESTION: 'openQuestion',
  CLEAR_BUZZ: 'clearBuzz',
  RESET_GAME: 'resetGame',
  UPSERT_TEAM: 'upsertTeam',
  DELETE_TEAM: 'deleteTeam',
});

/**
 * Server → Client message types (DESIGN.md §9).
 * @readonly
 * @enum {string}
 */
export const S2C = Object.freeze({
  PONG: 'pong',
  STATE: 'state',
  ROUND_OPEN: 'roundOpen',
  BUZZ_RESULT: 'buzzResult',
  REJECTED: 'rejected',
  RESET: 'reset',
  PRESENCE: 'presence',
  ERROR: 'error',
});

/**
 * Convenience union of every message type string (both directions).
 * @readonly
 */
export const MSG = Object.freeze({ ...C2S, ...S2C });

// ===========================================================================
// Shared sub-shapes
// ===========================================================================

/**
 * A team as it appears in `state` snapshots and team CRUD.
 * @typedef {Object} Team
 * @property {string} id          Stable team id (uuid/short id).
 * @property {string} name        Display name.
 * @property {string} color       Hex color (e.g. "#22C55E").
 * @property {string} [banner_url] Optional local asset path for a banner.
 * @property {number} slot        1..4 display order / tablet binding.
 */

/**
 * One entry in a buzz ranking (DESIGN.md §11 `finalize`).
 * @typedef {Object} RankingEntry
 * @property {string} teamId  Team that pressed.
 * @property {number} pressAt Edge timestamp in server time (ms).
 * @property {number} rank    1-based final order within the round (1 = winner).
 */

/**
 * The winning press, as carried in `buzzResult`.
 * @typedef {Object} Winner
 * @property {string} teamId  Winning team id.
 * @property {string} name    Winning team name.
 * @property {string} color   Winning team hex color.
 * @property {number} pressAt Edge timestamp in server time (ms).
 */

// ===========================================================================
// Client → Server payloads
// ===========================================================================

/**
 * Identify a connection on (re)connect. `teamId` is required for the `tablet`
 * role; `secret` optionally gates admin actions.
 * @typedef {Object} HelloMsg
 * @property {'hello'} type
 * @property {ROLE} role        One of ROLE.TABLET | ROLE.DISPLAY | ROLE.ADMIN.
 * @property {string} [teamId]  Present when role === ROLE.TABLET.
 * @property {string} clientId  Stable per-device id (e.g. from localStorage).
 * @property {string} [secret]  Optional shared secret for admin gating.
 */

/**
 * Clock-sync probe. `t0` is the client's `performance.now()` at send time.
 * Correlated with the matching `pong` by `seq`.
 * @typedef {Object} PingMsg
 * @property {'ping'} type
 * @property {number} seq Monotonic sample index within a sync pass.
 * @property {number} t0  Client `performance.now()` at send (ms).
 */

/**
 * A physical press from a tablet. `pressAt` is the edge timestamp already
 * converted into SERVER time by the client.
 * @typedef {Object} BuzzMsg
 * @property {'buzz'} type
 * @property {string} roundId The round the press is for (must be current).
 * @property {number} pressAt Edge timestamp in server time (ms).
 */

/**
 * Admin: open a new question (status → open, question_number++).
 * @typedef {Object} OpenQuestionMsg
 * @property {'openQuestion'} type
 */

/**
 * Admin: clear the current buzz and reopen the same question (optional flow).
 * @typedef {Object} ClearBuzzMsg
 * @property {'clearBuzz'} type
 * @property {string} roundId The round to clear.
 */

/**
 * Admin: reset the game back to idle (question_number → 0).
 * @typedef {Object} ResetGameMsg
 * @property {'resetGame'} type
 */

/**
 * Admin: create or edit a team. Omit `id` to create.
 * @typedef {Object} UpsertTeamMsg
 * @property {'upsertTeam'} type
 * @property {string} [id]        Present when editing an existing team.
 * @property {string} name        Display name.
 * @property {string} color       Hex color.
 * @property {string} [banner_url] Optional local asset path.
 * @property {number} slot        1..4 display order / tablet binding.
 */

/**
 * Admin: delete a team.
 * @typedef {Object} DeleteTeamMsg
 * @property {'deleteTeam'} type
 * @property {string} id Team id to remove.
 */

/**
 * Any client → server message.
 * @typedef {HelloMsg|PingMsg|BuzzMsg|OpenQuestionMsg|ClearBuzzMsg|ResetGameMsg|UpsertTeamMsg|DeleteTeamMsg} ClientMessage
 */

// ===========================================================================
// Server → Client payloads
// ===========================================================================

/**
 * Clock-sync reply. Echoes `seq` and `t0`; `tServer` is the server's
 * `performance.now()` at the moment it handled the ping.
 * @typedef {Object} PongMsg
 * @property {'pong'} type
 * @property {number} seq     Echoed from the ping.
 * @property {number} t0      Echoed client send time (ms).
 * @property {number} tServer Server `performance.now()` at handling (ms).
 */

/**
 * Full authoritative snapshot, sent on connect/reconnect and on every change.
 * @typedef {Object} StateMsg
 * @property {'state'} type
 * @property {STATUS} status            Current game status.
 * @property {?string} roundId          Current round id, or null when idle.
 * @property {number} questionNumber    Current question number (0 when reset).
 * @property {?number} openAt           Server time the round opened (ms), or null.
 * @property {Team[]} teams             All teams, ordered by slot.
 * @property {string[]} connected       teamIds of currently-connected tablets.
 * @property {Winner} [winner]          Present when status === STATUS.BUZZED.
 */

/**
 * A question opened — buzzers go live.
 * @typedef {Object} RoundOpenMsg
 * @property {'roundOpen'} type
 * @property {string} roundId        The newly opened round.
 * @property {number} questionNumber The question number for this round.
 * @property {number} openAt         Server time the round opened (ms).
 */

/**
 * Winner declared after the settling window (DESIGN.md §11).
 * @typedef {Object} BuzzResultMsg
 * @property {'buzzResult'} type
 * @property {string} roundId          The round that was decided.
 * @property {Winner} winner           The winning press.
 * @property {RankingEntry[]} ranking  Full ordering of accepted presses.
 */

/**
 * Your buzz was not accepted.
 * @typedef {Object} RejectedMsg
 * @property {'rejected'} type
 * @property {string} roundId       The round the rejected buzz referenced.
 * @property {REJECT_REASON} reason Why it was rejected.
 */

/**
 * Game reset to idle.
 * @typedef {Object} ResetMsg
 * @property {'reset'} type
 */

/**
 * Which tablets are currently connected (DESIGN.md §8 presence = the socket).
 * @typedef {Object} PresenceMsg
 * @property {'presence'} type
 * @property {string[]} connected teamIds of currently-connected tablets.
 */

/**
 * Protocol/validation error.
 * @typedef {Object} ErrorMsg
 * @property {'error'} type
 * @property {string} message Human-readable description.
 */

/**
 * Any server → client message.
 * @typedef {PongMsg|StateMsg|RoundOpenMsg|BuzzResultMsg|RejectedMsg|ResetMsg|PresenceMsg|ErrorMsg} ServerMessage
 */

/**
 * Any protocol message in either direction.
 * @typedef {ClientMessage|ServerMessage} ProtocolMessage
 */
