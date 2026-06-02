// server/game.js
//
// The in-memory game authority: state machine + buzz arbitration + settling
// window (DESIGN.md §8, §11, §12). This module is the SINGLE SOURCE OF TRUTH at
// runtime. It is transport-agnostic — ws.js injects `broadcast` and a presence
// getter, and calls the action methods below in response to client messages.
//
// Why this is race-free (the core fix vs. the old Base44 design): Node's event
// loop serialises every incoming `buzz`. The first one handled for an `open`
// round flips it to `settling` and starts ONE timer; subsequent presses merely
// join the candidate set. There is no read-modify-write against a shared row, so
// "last write wins" is structurally impossible. The winner is the earliest
// edge `pressAt`, decided after the window closes — independent of arrival order.

import { randomUUID } from 'node:crypto';
import {
  STATUS,
  ROUND_STATUS,
  REJECT_REASON,
  CLOCK_TOLERANCE_MS,
} from '../shared/constants.js';
import { S2C } from '../shared/protocol.js';
import { serverNow } from './clock.js';

/**
 * Create the game authority.
 *
 * @param {Object} deps
 * @param {ReturnType<import('./db.js').openDb>} deps.db
 * @param {ReturnType<import('./settings.js').createSettings>} deps.settings
 * @param {(msg: import('../shared/protocol.js').ServerMessage) => void} deps.broadcast
 *        Sends a message to every connected client (tablets, display, admin).
 * @param {() => string[]} deps.getConnectedTeamIds
 *        Returns teamIds of currently-connected tablets (presence = the socket).
 */
export function createGame({ db, settings, broadcast, getConnectedTeamIds }) {
  /**
   * The live round. `null` while idle. This is the authoritative state during
   * play; SQLite is written behind it.
   *
   * @typedef {Object} LiveRound
   * @property {string} id
   * @property {number} questionNumber
   * @property {number} openAt                         Server time (ms).
   * @property {STATUS} status                          idle/open/settling/buzzed.
   * @property {Map<string, {teamId:string, pressAt:number, receivedAt:number, rtt:?number}>} presses
   * @property {?NodeJS.Timeout} settleTimer
   * @property {?import('../shared/protocol.js').Winner} winner
   * @property {?import('../shared/protocol.js').RankingEntry[]} ranking
   */

  /** @type {?LiveRound} */
  let currentRound = null;

  /**
   * Question counter. On boot we continue numbering from the last persisted
   * round (the live round itself is never resumed — it starts idle — but the
   * operator's "New question" should keep counting up). `resetGame` zeroes it.
   * @type {number}
   */
  let questionNumber = (() => {
    const last = db.getLastRound();
    return last ? last.question_number : 0;
  })();

  // -----------------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------------

  /**
   * Build the full authoritative `state` snapshot (DESIGN.md §9). Sent to a
   * client on connect/reconnect and broadcast on every meaningful change.
   *
   * `status` collapses the internal `settling` phase to `open` for clients —
   * they keep showing "open" visuals during the ≤ window-ms settle (§12).
   *
   * @returns {import('../shared/protocol.js').StateMsg}
   */
  function buildState() {
    const teams = db.listTeams();
    const status = currentRound
      ? (currentRound.status === STATUS.SETTLING ? STATUS.OPEN : currentRound.status)
      : STATUS.IDLE;

    /** @type {import('../shared/protocol.js').StateMsg} */
    const msg = {
      type: S2C.STATE,
      status,
      roundId: currentRound ? currentRound.id : null,
      questionNumber,
      openAt: currentRound ? currentRound.openAt : null,
      teams,
      connected: getConnectedTeamIds(),
    };
    if (currentRound && currentRound.status === STATUS.BUZZED && currentRound.winner) {
      msg.winner = currentRound.winner;
    }
    return msg;
  }

  /** Broadcast a fresh full snapshot to everyone. */
  function broadcastState() {
    broadcast(buildState());
  }

  // -----------------------------------------------------------------------
  // Presence
  // -----------------------------------------------------------------------

  /**
   * Broadcast the current tablet presence set (DESIGN.md §9 `presence`). Called
   * by ws.js whenever a tablet connects or disconnects.
   */
  function broadcastPresence() {
    broadcast({ type: S2C.PRESENCE, connected: getConnectedTeamIds() });
  }

  // -----------------------------------------------------------------------
  // Round lifecycle (admin actions)
  // -----------------------------------------------------------------------

  /**
   * Open a new question (idle/open/buzzed → open). Stamps `openAt`, increments
   * the question number, clears any previous presses, and tells buzzers to go
   * live via `roundOpen` (plus a full `state` so late joiners agree).
   *
   * If a previous round was mid-`settling`, its timer is cancelled and it is
   * recorded as `reset` (abandoned) before the new one opens.
   */
  function openQuestion() {
    if (currentRound) {
      cancelSettleTimer(currentRound);
      // A round that never reached a winner is recorded as abandoned.
      if (currentRound.status !== STATUS.BUZZED) {
        persistAbandoned(currentRound);
      }
    }

    questionNumber += 1;
    const openAt = serverNow();
    currentRound = {
      id: randomUUID(),
      questionNumber,
      openAt,
      status: STATUS.OPEN,
      presses: new Map(),
      settleTimer: null,
      winner: null,
      ranking: null,
    };

    // Write-behind: record the open round for audit/recovery.
    db.insertOpenRound({
      id: currentRound.id,
      questionNumber: currentRound.questionNumber,
      openedAt: currentRound.openAt,
    });

    broadcast({
      type: S2C.ROUND_OPEN,
      roundId: currentRound.id,
      questionNumber: currentRound.questionNumber,
      openAt: currentRound.openAt,
    });
    broadcastState();
  }

  /**
   * Clear the current buzz and reopen the SAME question (optional retry flow,
   * DESIGN.md §12). Only valid when the named round is the current one. Keeps
   * the same `questionNumber`; assigns a fresh round id so old presses/stale
   * buzzes can't bleed in. Records the cleared round as `reset`.
   *
   * @param {string} roundId The round the admin intends to clear.
   */
  function clearBuzz(roundId) {
    if (!currentRound || currentRound.id !== roundId) return;

    cancelSettleTimer(currentRound);
    persistAbandoned(currentRound);

    const openAt = serverNow();
    currentRound = {
      id: randomUUID(),
      questionNumber, // same question, retried
      openAt,
      status: STATUS.OPEN,
      presses: new Map(),
      settleTimer: null,
      winner: null,
      ranking: null,
    };

    db.insertOpenRound({
      id: currentRound.id,
      questionNumber: currentRound.questionNumber,
      openedAt: currentRound.openAt,
    });

    broadcast({
      type: S2C.ROUND_OPEN,
      roundId: currentRound.id,
      questionNumber: currentRound.questionNumber,
      openAt: currentRound.openAt,
    });
    broadcastState();
  }

  /**
   * Reset the whole game back to idle, question number → 0 (DESIGN.md §12).
   * Cancels any settle timer and abandons an unfinished round.
   */
  function resetGame() {
    if (currentRound) {
      cancelSettleTimer(currentRound);
      if (currentRound.status !== STATUS.BUZZED) {
        persistAbandoned(currentRound);
      }
    }
    currentRound = null;
    questionNumber = 0;

    broadcast({ type: S2C.RESET });
    broadcastState();
  }

  // -----------------------------------------------------------------------
  // Buzz arbitration (DESIGN.md §11)
  // -----------------------------------------------------------------------

  /**
   * Handle a `buzz` from a tablet. Validates against the current round, records
   * the press, and (on the first valid press) starts the settling window. The
   * winner is decided in `finalize` after the window — NOT here — so arrival
   * order never determines the outcome.
   *
   * @param {{ teamId: ?string, lastRtt: ?number, send: (m:any)=>void }} conn
   *        The originating connection (ws.js attaches teamId/lastRtt/send).
   * @param {import('../shared/protocol.js').BuzzMsg} msg
   */
  function handleBuzz(conn, { roundId, pressAt }) {
    const teamId = conn.teamId;
    const r = currentRound;

    const reject = (reason) => {
      // Persist the rejected attempt for audit (write-behind, best effort).
      if (teamId && roundId) {
        try {
          db.insertBuzz({
            roundId,
            teamId,
            pressAt: typeof pressAt === 'number' ? pressAt : 0,
            receivedAt: serverNow(),
            rtt: conn.lastRtt ?? null,
            accepted: false,
            rejectReason: reason,
            rank: null,
          });
        } catch {
          // A rejected buzz may reference a round id we never stored (stale);
          // auditing it is best-effort and must never break arbitration.
        }
      }
      conn.send({ type: S2C.REJECTED, roundId, reason });
    };

    // No team binding → cannot attribute a press.
    if (!teamId) {
      conn.send({ type: S2C.ERROR, message: 'buzz from a connection with no teamId' });
      return;
    }

    // Round validity.
    if (!r || r.id !== roundId) return reject(REJECT_REASON.STALE_ROUND);

    // Winner already declared.
    if (r.status === STATUS.BUZZED) return reject(REJECT_REASON.TOO_LATE);

    // Validate pressAt is a finite number before comparing.
    if (typeof pressAt !== 'number' || !Number.isFinite(pressAt)) {
      return reject(REJECT_REASON.FALSE_START);
    }

    // Pressed before the round opened (beyond clock tolerance) → false start.
    if (pressAt < r.openAt - CLOCK_TOLERANCE_MS) return reject(REJECT_REASON.FALSE_START);

    // One press per team per round; extra mashes are silently ignored
    // (NOT surfaced as an error — the first press already counts).
    if (r.presses.has(teamId)) return;

    r.presses.set(teamId, {
      teamId,
      pressAt,
      receivedAt: serverNow(),
      rtt: conn.lastRtt ?? null,
    });

    // First arrival opens the settling window; later arrivals just join.
    if (r.status === STATUS.OPEN) {
      r.status = STATUS.SETTLING;
      const windowMs = settings.getSettlingWindowMs();
      r.settleTimer = setTimeout(() => finalize(r), windowMs);
    }
  }

  /**
   * Close the settling window: sort accepted presses by edge `pressAt`, assign
   * ranks, declare the earliest the winner, broadcast `buzzResult`, then persist
   * write-behind (DESIGN.md §11 `finalize`).
   *
   * Guarded so a stale timer (e.g. after reset/clear) can never act on a round
   * that is no longer current or already finalized.
   *
   * @param {LiveRound} r
   */
  function finalize(r) {
    if (r !== currentRound) return;       // superseded by reset/clear/open
    if (r.status === STATUS.BUZZED) return; // already finalized
    r.settleTimer = null;
    r.status = STATUS.BUZZED;

    const ranked = [...r.presses.values()].sort((a, b) => a.pressAt - b.pressAt);
    ranked.forEach((p, i) => { p.rank = i + 1; });

    const top = ranked[0];
    const winnerTeam = db.getTeam(top.teamId);
    /** @type {import('../shared/protocol.js').Winner} */
    const winner = {
      teamId: top.teamId,
      name: winnerTeam ? winnerTeam.name : '',
      color: winnerTeam ? winnerTeam.color : '',
      pressAt: top.pressAt,
    };
    /** @type {import('../shared/protocol.js').RankingEntry[]} */
    const ranking = ranked.map(({ teamId, pressAt, rank }) => ({ teamId, pressAt, rank }));

    r.winner = winner;
    r.ranking = ranking;

    // Broadcast FIRST (fairness/UX), persist AFTER (write-behind).
    broadcast({ type: S2C.BUZZ_RESULT, roundId: r.id, winner, ranking });
    broadcastState();

    persistBuzzedRound(r, ranked, winner);
  }

  // -----------------------------------------------------------------------
  // Team CRUD (admin actions)
  // -----------------------------------------------------------------------

  /**
   * Create or edit a team (DESIGN.md §9 `upsertTeam`). Omit `id` to create.
   * Broadcasts a fresh `state` so every client's team list updates.
   *
   * @param {import('../shared/protocol.js').UpsertTeamMsg} msg
   * @returns {import('../shared/protocol.js').Team} The persisted team.
   */
  function upsertTeam({ id, name, color, banner_url, slot }) {
    /** @type {import('../shared/protocol.js').Team} */
    const team = {
      id: id || randomUUID(),
      name,
      color,
      banner_url: banner_url ?? null,
      slot,
    };
    if (id && db.getTeam(id)) {
      db.updateTeam(team);
    } else {
      db.insertTeam(team);
    }
    broadcastState();
    return team;
  }

  /**
   * Delete a team (DESIGN.md §9 `deleteTeam`). Broadcasts a fresh `state`.
   * @param {string} id
   */
  function deleteTeam(id) {
    db.deleteTeam(id);
    broadcastState();
  }

  // -----------------------------------------------------------------------
  // Write-behind persistence helpers
  // -----------------------------------------------------------------------

  /**
   * Persist a finalized (buzzed) round and all its accepted presses.
   * @param {LiveRound} r
   * @param {Array<{teamId:string,pressAt:number,receivedAt:number,rtt:?number,rank:number}>} ranked
   * @param {import('../shared/protocol.js').Winner} winner
   */
  function persistBuzzedRound(r, ranked, winner) {
    const closedAt = serverNow();
    try {
      db.closeRound({
        id: r.id,
        status: ROUND_STATUS.BUZZED,
        winnerTeamId: winner.teamId,
        winnerPressAt: winner.pressAt,
        closedAt,
      });
      db.insertBuzzes(ranked.map((p) => ({
        roundId: r.id,
        teamId: p.teamId,
        pressAt: p.pressAt,
        receivedAt: p.receivedAt,
        rtt: p.rtt ?? null,
        accepted: true,
        rejectReason: null,
        rank: p.rank,
      })));
    } catch {
      // Persistence is for audit/recovery only; never let it affect live play.
    }
  }

  /**
   * Record a round that was opened but abandoned (reset/clear/superseded) as
   * `reset` in the audit log. Any presses it collected are stored unranked.
   * @param {LiveRound} r
   */
  function persistAbandoned(r) {
    try {
      db.closeRound({
        id: r.id,
        status: ROUND_STATUS.RESET,
        winnerTeamId: null,
        winnerPressAt: null,
        closedAt: serverNow(),
      });
      if (r.presses.size > 0) {
        db.insertBuzzes([...r.presses.values()].map((p) => ({
          roundId: r.id,
          teamId: p.teamId,
          pressAt: p.pressAt,
          receivedAt: p.receivedAt,
          rtt: p.rtt ?? null,
          accepted: false,
          rejectReason: null,
          rank: null,
        })));
      }
    } catch {
      // best effort
    }
  }

  /**
   * Cancel a round's settling timer if present (idempotent).
   * @param {LiveRound} r
   */
  function cancelSettleTimer(r) {
    if (r && r.settleTimer) {
      clearTimeout(r.settleTimer);
      r.settleTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Public API (called by ws.js)
  // -----------------------------------------------------------------------

  return {
    buildState,
    broadcastState,
    broadcastPresence,
    openQuestion,
    clearBuzz,
    resetGame,
    handleBuzz,
    upsertTeam,
    deleteTeam,

    /** Test/diagnostic accessors (not part of the wire protocol). */
    _getCurrentRound: () => currentRound,
    _getQuestionNumber: () => questionNumber,
  };
}
