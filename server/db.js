// server/db.js
//
// SQLite persistence layer (DESIGN.md §7, §8).
//
// `better-sqlite3` is synchronous and sub-millisecond for the tiny writes this
// app makes, which is exactly why it fits: SQLite is used for persistence,
// recovery, and audit — it is NEVER in the buzz decision path. The in-memory
// `currentRound` (game.js) decides the winner; we persist rounds/buzzes *after*
// broadcasting the result (write-behind).
//
// This module owns: opening the database, applying schema.sql, and exposing a
// small, intention-revealing API backed by prepared statements. Callers never
// see raw SQL.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ROUND_STATUS } from '../shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load better-sqlite3 DEFENSIVELY (DESIGN.md §8): it is a native module, and if
// it ever fails to load/compile on the host the game must still run. On failure
// we fall back to an in-memory store — the buzz path never touches SQLite anyway
// (persistence is audit/recovery only), so the event proceeds, just without
// persistence across restarts.
const require = createRequire(import.meta.url);
let Database = null;
try {
  Database = require('better-sqlite3');
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn(
    `[buzzer] better-sqlite3 unavailable (${err.message}); using in-memory store — no persistence.`,
  );
}

/**
 * Default teams seeded when the teams table is empty (DESIGN.md §8). The operator
 * renames these to the real team names; defaults exist so the app is never empty
 * on first boot. Colors match the design's slot palette.
 * @type {ReadonlyArray<{name:string,color:string,slot:number}>}
 */
const DEFAULT_TEAMS = [
  { name: 'אדום', color: '#EF4444', slot: 1 },
  { name: 'כחול', color: '#3B82F6', slot: 2 },
  { name: 'ירוק', color: '#22C55E', slot: 3 },
  { name: 'כתום', color: '#F59E0B', slot: 4 },
];

/**
 * Resolve the database file path.
 *
 * Defaults to `server/buzzer.db`. Override with the `BUZZER_DB` env var; pass
 * `':memory:'` (directly or via env) for an ephemeral DB in tests.
 *
 * @param {string} [explicitPath] Caller-supplied path (wins over env/default).
 * @returns {string}
 */
function resolveDbPath(explicitPath) {
  const p = explicitPath || process.env.BUZZER_DB || join(__dirname, 'buzzer.db');
  return p;
}

/**
 * Open the SQLite database, apply the schema, and build the persistence API.
 *
 * Pragmas: WAL for concurrent readers + fast commits, NORMAL synchronous (safe
 * with WAL and ideal for a single-host write-behind workload), and foreign_keys
 * on for integrity. None of this touches the buzz hot path.
 *
 * @param {string} [dbPath] Optional explicit path (see resolveDbPath).
 * @returns {ReturnType<typeof buildApi> & { raw: import('better-sqlite3').Database }}
 *          The persistence API plus the raw handle (for close()/diagnostics).
 */
export function openDb(dbPath) {
  if (Database) {
    try {
      const db = new Database(resolveDbPath(dbPath));

      // In-memory databases don't support WAL; only set it for file-backed DBs.
      if (db.name !== ':memory:') {
        db.pragma('journal_mode = WAL');
      }
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');

      const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
      db.exec(schema);

      return buildApi(db);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[buzzer] SQLite open failed (${err.message}); falling back to in-memory store.`,
      );
    }
  }
  return buildMemoryApi();
}

/**
 * Build the prepared-statement-backed persistence API over an open handle.
 * @param {import('better-sqlite3').Database} db
 */
function buildApi(db) {
  // --- Teams -------------------------------------------------------------
  const stmtListTeams = db.prepare(
    `SELECT id, name, color, banner_url, slot FROM teams ORDER BY slot ASC, name ASC`,
  );
  const stmtGetTeam = db.prepare(
    `SELECT id, name, color, banner_url, slot FROM teams WHERE id = ?`,
  );
  const stmtInsertTeam = db.prepare(
    `INSERT INTO teams (id, name, color, banner_url, slot)
     VALUES (@id, @name, @color, @banner_url, @slot)`,
  );
  const stmtUpdateTeam = db.prepare(
    `UPDATE teams
        SET name = @name, color = @color, banner_url = @banner_url, slot = @slot
      WHERE id = @id`,
  );
  const stmtDeleteTeam = db.prepare(`DELETE FROM teams WHERE id = ?`);

  // --- Rounds ------------------------------------------------------------
  const stmtInsertRound = db.prepare(
    `INSERT INTO rounds
        (id, question_number, opened_at, status, winner_team_id, winner_press_at, closed_at)
     VALUES
        (@id, @question_number, @opened_at, @status, @winner_team_id, @winner_press_at, @closed_at)`,
  );
  const stmtUpdateRound = db.prepare(
    `UPDATE rounds
        SET status = @status,
            winner_team_id = @winner_team_id,
            winner_press_at = @winner_press_at,
            closed_at = @closed_at
      WHERE id = @id`,
  );
  const stmtGetLastRound = db.prepare(
    `SELECT id, question_number, opened_at, status, winner_team_id, winner_press_at, closed_at
       FROM rounds
      ORDER BY opened_at DESC, rowid DESC
      LIMIT 1`,
  );

  // --- Buzzes ------------------------------------------------------------
  const stmtInsertBuzz = db.prepare(
    `INSERT INTO buzzes
        (round_id, team_id, press_at, received_at, rtt_ms, accepted, reject_reason, rank)
     VALUES
        (@round_id, @team_id, @press_at, @received_at, @rtt_ms, @accepted, @reject_reason, @rank)`,
  );

  // --- Settings ----------------------------------------------------------
  const stmtGetSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const stmtUpsertSetting = db.prepare(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  return {
    /** Raw handle, for close() and ad-hoc diagnostics only. */
    raw: db,

    /** Close the underlying database. */
    close() {
      db.close();
    },

    // ---- Teams ----------------------------------------------------------

    /**
     * All teams ordered by slot (then name). Shape matches protocol `Team`.
     * @returns {import('../shared/protocol.js').Team[]}
     */
    listTeams() {
      return stmtListTeams.all();
    },

    /**
     * One team by id, or undefined.
     * @param {string} id
     * @returns {import('../shared/protocol.js').Team|undefined}
     */
    getTeam(id) {
      return stmtGetTeam.get(id);
    },

    /**
     * Insert a new team row (id supplied by caller — see game.js upsert).
     * @param {import('../shared/protocol.js').Team} team
     */
    insertTeam(team) {
      stmtInsertTeam.run({
        id: team.id,
        name: team.name,
        color: team.color,
        banner_url: team.banner_url ?? null,
        slot: team.slot,
      });
    },

    /**
     * Update an existing team row by id.
     * @param {import('../shared/protocol.js').Team} team
     */
    updateTeam(team) {
      stmtUpdateTeam.run({
        id: team.id,
        name: team.name,
        color: team.color,
        banner_url: team.banner_url ?? null,
        slot: team.slot,
      });
    },

    /**
     * Delete a team by id.
     * @param {string} id
     */
    deleteTeam(id) {
      stmtDeleteTeam.run(id);
    },

    /**
     * Insert the default teams iff the table is empty (DESIGN.md §8). Returns the
     * teams it created (empty array if seeding was skipped).
     * @returns {import('../shared/protocol.js').Team[]}
     */
    seedDefaultTeamsIfEmpty() {
      if (stmtListTeams.all().length > 0) return [];
      const created = DEFAULT_TEAMS.map((t) => ({ id: randomUUID(), banner_url: null, ...t }));
      const tx = db.transaction((rows) => {
        for (const t of rows) stmtInsertTeam.run(t);
      });
      tx(created);
      return created;
    },

    // ---- Rounds ---------------------------------------------------------

    /**
     * Persist a freshly opened round (write-behind, after broadcasting).
     * @param {{ id: string, questionNumber: number, openedAt: number }} r
     */
    insertOpenRound(r) {
      stmtInsertRound.run({
        id: r.id,
        question_number: r.questionNumber,
        opened_at: r.openedAt,
        status: ROUND_STATUS.OPEN,
        winner_team_id: null,
        winner_press_at: null,
        closed_at: null,
      });
    },

    /**
     * Mark a round closed with its outcome.
     * @param {{ id: string, status: string, winnerTeamId: ?string, winnerPressAt: ?number, closedAt: number }} r
     */
    closeRound(r) {
      stmtUpdateRound.run({
        id: r.id,
        status: r.status,
        winner_team_id: r.winnerTeamId ?? null,
        winner_press_at: r.winnerPressAt ?? null,
        closed_at: r.closedAt ?? null,
      });
    },

    /**
     * The most recently opened round, or undefined. Used on boot for audit /
     * to recover `question_number` (the live round itself is always reset to
     * idle on restart — DESIGN.md §14).
     */
    getLastRound() {
      return stmtGetLastRound.get();
    },

    // ---- Buzzes ---------------------------------------------------------

    /**
     * Persist one buzz row (accepted or rejected) for the audit log.
     * @param {{
     *   roundId: string, teamId: string, pressAt: number, receivedAt: number,
     *   rtt: ?number, accepted: boolean, rejectReason: ?string, rank: ?number
     * }} b
     */
    insertBuzz(b) {
      stmtInsertBuzz.run({
        round_id: b.roundId,
        team_id: b.teamId,
        press_at: b.pressAt,
        received_at: b.receivedAt,
        rtt_ms: b.rtt ?? null,
        accepted: b.accepted ? 1 : 0,
        reject_reason: b.rejectReason ?? null,
        rank: b.rank ?? null,
      });
    },

    /**
     * Persist a whole round's worth of buzzes atomically (write-behind).
     * @param {Array<Parameters<ReturnType<typeof buildApi>['insertBuzz']>[0]>} buzzes
     */
    insertBuzzes(buzzes) {
      const tx = db.transaction((rows) => {
        for (const b of rows) {
          stmtInsertBuzz.run({
            round_id: b.roundId,
            team_id: b.teamId,
            press_at: b.pressAt,
            received_at: b.receivedAt,
            rtt_ms: b.rtt ?? null,
            accepted: b.accepted ? 1 : 0,
            reject_reason: b.rejectReason ?? null,
            rank: b.rank ?? null,
          });
        }
      });
      tx(buzzes);
    },

    // ---- Settings -------------------------------------------------------

    /**
     * Read a setting value (TEXT), or undefined if absent.
     * @param {string} key
     * @returns {string|undefined}
     */
    getSetting(key) {
      const row = stmtGetSetting.get(key);
      return row ? row.value : undefined;
    },

    /**
     * Upsert a setting value (stored as TEXT).
     * @param {string} key
     * @param {string} value
     */
    setSetting(key, value) {
      stmtUpsertSetting.run({ key, value: String(value) });
    },
  };
}

/**
 * In-memory persistence backend with the SAME API surface as {@link buildApi}.
 * Used when better-sqlite3 is unavailable or fails to open (DESIGN.md §8). The
 * game runs fully; only cross-restart persistence/audit is lost.
 * @returns {ReturnType<typeof buildApi>}
 */
function buildMemoryApi() {
  /** @type {Map<string, import('../shared/protocol.js').Team>} */
  const teams = new Map();
  const rounds = [];
  const buzzes = [];
  const settings = new Map();

  const bySlot = (a, b) => (a.slot - b.slot) || String(a.name).localeCompare(String(b.name));
  const team = (t) => ({
    id: t.id, name: t.name, color: t.color, banner_url: t.banner_url ?? null, slot: t.slot,
  });

  return {
    raw: null,
    close() {},

    // ---- Teams ----------------------------------------------------------
    listTeams() {
      return [...teams.values()].map(team).sort(bySlot);
    },
    getTeam(id) {
      const t = teams.get(id);
      return t ? team(t) : undefined;
    },
    insertTeam(t) {
      teams.set(t.id, team(t));
    },
    updateTeam(t) {
      if (teams.has(t.id)) teams.set(t.id, team(t));
    },
    deleteTeam(id) {
      teams.delete(id);
    },
    seedDefaultTeamsIfEmpty() {
      if (teams.size > 0) return [];
      const created = DEFAULT_TEAMS.map((t) => ({ id: randomUUID(), banner_url: null, ...t }));
      for (const t of created) teams.set(t.id, t);
      return created;
    },

    // ---- Rounds ---------------------------------------------------------
    insertOpenRound(r) {
      rounds.push({
        id: r.id, question_number: r.questionNumber, opened_at: r.openedAt,
        status: ROUND_STATUS.OPEN, winner_team_id: null, winner_press_at: null, closed_at: null,
      });
    },
    closeRound(r) {
      const row = rounds.find((x) => x.id === r.id);
      if (row) {
        row.status = r.status;
        row.winner_team_id = r.winnerTeamId ?? null;
        row.winner_press_at = r.winnerPressAt ?? null;
        row.closed_at = r.closedAt ?? null;
      }
    },
    getLastRound() {
      return rounds.length ? { ...rounds[rounds.length - 1] } : undefined;
    },

    // ---- Buzzes ---------------------------------------------------------
    insertBuzz(b) {
      buzzes.push({ ...b });
    },
    insertBuzzes(rows) {
      for (const b of rows) buzzes.push({ ...b });
    },

    // ---- Settings -------------------------------------------------------
    getSetting(key) {
      return settings.get(key);
    },
    setSetting(key, value) {
      settings.set(key, String(value));
    },
  };
}
