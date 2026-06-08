// server/settings.js
//
// Runtime-tunable settings (DESIGN.md §16 calibration).
//
// The only knob the venue calibrates today is the settling window. Defaults come
// from shared/constants.js (the value every piece agrees on); the `settings`
// table can override it per venue. This wrapper keeps a parsed copy in memory so
// the arbitration path (game.js) never touches the DB to read it.

import { SETTLING_WINDOW_MS, SETTING_KEY } from '../shared/constants.js';

/**
 * Create a settings accessor bound to a db handle.
 *
 * On construction it loads any persisted overrides; thereafter reads are served
 * from the in-memory cache and writes update both the cache and the DB.
 *
 * @param {ReturnType<import('./db.js').openDb>} db
 */
export function createSettings(db) {
  /** @type {{ settlingWindowMs: number }} */
  const cache = {
    settlingWindowMs: SETTLING_WINDOW_MS,
  };

  load();

  /** (Re)load persisted overrides into the cache, falling back to defaults. */
  function load() {
    const raw = db.getSetting(SETTING_KEY.SETTLING_WINDOW_MS);
    const parsed = raw == null ? NaN : Number(raw);
    cache.settlingWindowMs = Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : SETTLING_WINDOW_MS;
  }

  return {
    /**
     * Current settling window (ms) used by arbitration. Read-cached.
     * @returns {number}
     */
    getSettlingWindowMs() {
      return cache.settlingWindowMs;
    },

    /**
     * Persist + apply a new settling window. Ignores invalid values.
     * @param {number} ms
     * @returns {number} The effective value after applying.
     */
    setSettlingWindowMs(ms) {
      const v = Number(ms);
      if (Number.isFinite(v) && v >= 0) {
        cache.settlingWindowMs = v;
        db.setSetting(SETTING_KEY.SETTLING_WINDOW_MS, String(v));
      }
      return cache.settlingWindowMs;
    },

    /** Reload overrides from the DB (e.g. after external edits). */
    reload: load,
  };
}
