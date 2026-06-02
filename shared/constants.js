// shared/constants.js
//
// Browser-safe, pure ESM constants shared by the server, the client net layer,
// and the React pages. NO node-only imports may appear in this file.
//
// These values are the single source of truth for tuning knobs and the small
// set of string enums that cross the wire. The server is authoritative at
// runtime (e.g. SETTLING_WINDOW_MS may be overridden from the `settings`
// table), but these are the defaults every piece agrees on.

// ---------------------------------------------------------------------------
// Arbitration / fairness tuning (DESIGN.md §11)
// ---------------------------------------------------------------------------

/**
 * Default settling window in milliseconds. After the first valid buzz of an
 * open round arrives, the server waits this long to collect near-simultaneous
 * presses, then sorts by edge `pressAt` and declares the earliest the winner.
 * Calibrated per venue and may be overridden via the `settings` table.
 * @type {number}
 */
export const SETTLING_WINDOW_MS = 50;

/**
 * Clock tolerance in milliseconds. Presses whose `pressAt` is up to this much
 * before the round's `openAt` are still accepted, forgiving sub-sync-error
 * "early" presses. Earlier than this is treated as a false start.
 * @type {number}
 */
export const CLOCK_TOLERANCE_MS = 5;

// ---------------------------------------------------------------------------
// Clock synchronization tuning (DESIGN.md §10)
// ---------------------------------------------------------------------------

/**
 * Number of ping/pong samples taken per sync pass. The lowest-RTT sample is
 * kept (least queuing noise) to estimate the clock offset.
 * @type {number}
 */
export const CLOCK_SYNC_SAMPLES = 10;

/**
 * Interval in milliseconds between periodic clock re-syncs while connected.
 * @type {number}
 */
export const CLOCK_SYNC_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Connection / reconnect tuning (DESIGN.md §13, §14)
// ---------------------------------------------------------------------------

/**
 * Initial reconnect backoff delay in milliseconds. Doubles on each failed
 * attempt up to RECONNECT_MAX_DELAY_MS.
 * @type {number}
 */
export const RECONNECT_BASE_DELAY_MS = 500;

/**
 * Maximum reconnect backoff delay in milliseconds.
 * @type {number}
 */
export const RECONNECT_MAX_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// Server defaults
// ---------------------------------------------------------------------------

/**
 * Default port the Node host listens on (static client + WebSocket, one origin).
 * @type {number}
 */
export const DEFAULT_PORT = 8080;

/**
 * WebSocket endpoint path the client connects to on the same origin.
 * @type {string}
 */
export const WS_PATH = '/ws';

// ---------------------------------------------------------------------------
// Connection roles (declared in `hello`, DESIGN.md §8)
// ---------------------------------------------------------------------------

/**
 * Roles a WebSocket connection may declare. `tablet` additionally carries a
 * `teamId`; `admin` is only served on the host machine.
 * @readonly
 * @enum {string}
 */
export const ROLE = Object.freeze({
  TABLET: 'tablet',
  DISPLAY: 'display',
  ADMIN: 'admin',
});

// ---------------------------------------------------------------------------
// Round / game status (DESIGN.md §12 state machine)
// ---------------------------------------------------------------------------

/**
 * Authoritative game/round status. `idle` → `open` → `settling` → `buzzed`.
 * `settling` is internal to the server (≤ SETTLING_WINDOW_MS); clients may keep
 * showing "open" visuals during it.
 * @readonly
 * @enum {string}
 */
export const STATUS = Object.freeze({
  IDLE: 'idle',
  OPEN: 'open',
  SETTLING: 'settling',
  BUZZED: 'buzzed',
});

/**
 * Persisted round status as stored in the `rounds` table (schema.sql §7).
 * Note this is the persistence vocabulary and intentionally differs from the
 * in-memory STATUS: the live `settling` state is never persisted, and `reset`
 * records that a round was abandoned.
 * @readonly
 * @enum {string}
 */
export const ROUND_STATUS = Object.freeze({
  OPEN: 'open',
  BUZZED: 'buzzed',
  RESET: 'reset',
});

// ---------------------------------------------------------------------------
// Buzz rejection reasons (DESIGN.md §9 `rejected`, §11)
// ---------------------------------------------------------------------------

/**
 * Reasons a buzz may be rejected, surfaced to the tablet via `rejected` and
 * persisted in `buzzes.reject_reason`.
 * - `too_late`    : a winner was already declared for this round.
 * - `false_start` : pressed before the round opened (beyond CLOCK_TOLERANCE_MS).
 * - `duplicate`   : this team already has a press in this round (mash/double).
 * - `stale_round` : the buzz referenced a round that is not the current one.
 * @readonly
 * @enum {string}
 */
export const REJECT_REASON = Object.freeze({
  TOO_LATE: 'too_late',
  FALSE_START: 'false_start',
  DUPLICATE: 'duplicate',
  STALE_ROUND: 'stale_round',
});

// ---------------------------------------------------------------------------
// Settings keys (rows in the `settings` table)
// ---------------------------------------------------------------------------

/**
 * Keys used in the `settings` table. Values are stored as TEXT.
 * @readonly
 * @enum {string}
 */
export const SETTING_KEY = Object.freeze({
  SETTLING_WINDOW_MS: 'settling_window_ms',
});

// ---------------------------------------------------------------------------
// Teams (DESIGN.md §7) — slot bounds + UI palette
// ---------------------------------------------------------------------------

/**
 * Number of team slots / tablets. One tablet per team.
 * @type {number}
 */
export const TEAM_COUNT = 4;

/**
 * Minimum valid team slot (1-based, maps to tablet binding & display order).
 * @type {number}
 */
export const MIN_SLOT = 1;

/**
 * Maximum valid team slot.
 * @type {number}
 */
export const MAX_SLOT = TEAM_COUNT;

/**
 * Preset team colors, matching the existing admin GroupForm palette so the
 * Hebrew/RTL UI is preserved. Operators may still pick a custom hex.
 * @type {readonly string[]}
 */
export const PRESET_COLORS = Object.freeze([
  '#EF4444', '#F97316', '#EAB308', '#22C55E',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899',
  '#14B8A6', '#F59E0B', '#6366F1', '#D946EF',
]);

/**
 * UI feedback colors reused by the buzzer/display (matches existing pages).
 * @readonly
 */
export const UI_COLOR = Object.freeze({
  WIN: '#22C55E',
  LOSE: '#EF4444',
  IDLE_BG: '#1a1a1a',
});
