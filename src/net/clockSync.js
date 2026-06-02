// src/net/clockSync.js
//
// Client-side clock synchronization (DESIGN.md §10).
//
// Estimates `clockOffset` such that  serverTime ≈ clientPerfNow + clockOffset,
// to ~1–3 ms on a LAN. We use Cristian's / SNTP-style probing: send a `ping`
// carrying the client's `performance.now()` (`t0`), the server replies with a
// `pong` echoing `t0` and carrying its own `performance.now()` (`tServer`), and
// we compute  offset = tServer - (t0 + t1) / 2  for the round trip. The
// MIN-RTT sample of a pass is kept because the least-delayed round trip carries
// the least queuing/airtime noise and therefore the truest offset.
//
// Both ends use `performance.now()` (monotonic) so the estimate is immune to
// wall-clock jumps; the offset simply bridges the two different time origins.
//
// This module is transport-agnostic: it is handed a `sendPing(seq, t0)` to put
// a ping on the wire and a `resolvePong(pong)` is called by the socket layer
// when the matching reply arrives. It owns no WebSocket itself.

import {
  CLOCK_SYNC_SAMPLES,
  CLOCK_SYNC_INTERVAL_MS,
} from '../../shared/constants.js';

/**
 * Monotonic high-resolution clock used for all client-side timestamps. Same
 * time origin as DOM event `timeStamp` values, so an edge `event.timeStamp`
 * can be converted to server time directly via {@link ClockSync#toServerTime}.
 * @returns {number} milliseconds since the page time origin.
 */
export function perfNow() {
  return performance.now();
}

/**
 * Estimates and maintains the offset between this client's monotonic clock and
 * the server's monotonic clock. One instance is owned by the socket layer.
 */
export class ClockSync {
  /**
   * @param {Object} opts
   * @param {(seq: number, t0: number) => void} opts.sendPing
   *   Puts a single `ping` frame on the wire. Called once per sample.
   * @param {number} [opts.samples]   Samples per sync pass (default from constants).
   * @param {number} [opts.intervalMs] Periodic re-sync interval (default from constants).
   * @param {() => void} [opts.onChange] Invoked after each completed pass when the
   *   offset/RTT/`synced` flag may have changed (lets the store re-render).
   */
  constructor({
    sendPing,
    samples = CLOCK_SYNC_SAMPLES,
    intervalMs = CLOCK_SYNC_INTERVAL_MS,
    onChange,
  }) {
    /** @private */ this._sendPing = sendPing;
    /** @private */ this._samples = samples;
    /** @private */ this._intervalMs = intervalMs;
    /** @private */ this._onChange = onChange || (() => {});

    /**
     * Best (lowest-RTT) offset estimate, in ms, to add to client time to get
     * server time. 0 until the first pass completes.
     * @type {number}
     */
    this.clockOffset = 0;
    /**
     * RTT (ms) of the sample the current {@link clockOffset} came from.
     * @type {number}
     */
    this.lastRtt = 0;
    /**
     * True once at least one sync pass has completed. Tablets must not buzz
     * until this is true (DESIGN.md §10 "gate buzzing on a completed sync").
     * @type {boolean}
     */
    this.synced = false;

    /** @private in-flight ping send times, keyed by seq. */
    this._pending = new Map();
    /** @private samples ({rtt, offset}) collected in the current pass. */
    this._passSamples = [];
    /** @private monotonically increasing seq so replies never collide across passes. */
    this._seq = 0;
    /** @private setInterval handle for periodic re-sync. */
    this._timer = null;
    /** @private guards against overlapping passes. */
    this._passActive = false;
    /** @private set true by stop(); aborts any in-flight pass cleanly. */
    this._stopped = false;
  }

  /**
   * Convert a client-side monotonic timestamp (e.g. `performance.now()` or a DOM
   * event's `timeStamp`) into server time using the current offset. This is the
   * value a tablet sends as `pressAt` (DESIGN.md §11).
   * @param {number} perfTs A `performance.now()`-origin timestamp (ms).
   * @returns {number} The same instant expressed in server time (ms).
   */
  toServerTime(perfTs) {
    return perfTs + this.clockOffset;
  }

  /**
   * Start syncing: run one pass immediately, then re-sync every `intervalMs`.
   * Safe to call once per (re)connection; call {@link reset} first on reconnect.
   */
  start() {
    this._stopped = false;
    if (this._timer != null) return;
    this.syncOnce();
    this._timer = setInterval(() => this.syncOnce(), this._intervalMs);
  }

  /**
   * Stop periodic syncing and drop any in-flight pass. Does NOT clear the last
   * known offset (a brief gap shouldn't blank the estimate); call {@link reset}
   * to mark the client unsynced on disconnect.
   */
  stop() {
    this._stopped = true;
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._pending.clear();
    this._passSamples = [];
    this._passActive = false;
  }

  /**
   * Mark the client unsynced and discard in-flight samples. Call on disconnect
   * so a tablet's buzzer is re-gated until the next pass completes after
   * reconnect (DESIGN.md §10, §14).
   */
  reset() {
    this.synced = false;
    this._pending.clear();
    this._passSamples = [];
    this._passActive = false;
    this._onChange();
  }

  /**
   * Run a single sync pass: emit {@link _samples} pings back-to-back. Each
   * resulting `pong` is fed back via {@link onPong}; the pass completes when all
   * samples have returned (or are abandoned on reconnect). Overlapping passes
   * are coalesced — if one is already active this is a no-op.
   */
  syncOnce() {
    if (this._stopped || this._passActive) return;
    this._passActive = true;
    this._passSamples = [];
    this._pending.clear();
    for (let i = 0; i < this._samples; i++) {
      const seq = this._seq++;
      const t0 = perfNow();
      this._pending.set(seq, t0);
      this._sendPing(seq, t0);
    }
  }

  /**
   * Handle a `pong` reply. The socket layer calls this for every received pong.
   * Uses `pong.t0` (echoed) as the send time so we never depend on map state
   * surviving a reconnect, and ignores stale/duplicate seqs.
   * @param {import('../../shared/protocol.js').PongMsg} pong
   */
  onPong(pong) {
    const { seq, t0, tServer } = pong;
    if (!this._pending.has(seq)) return; // stale / from a dropped pass
    this._pending.delete(seq);

    const t1 = perfNow();
    const rtt = t1 - t0;
    const offset = tServer - (t0 + t1) / 2; // add to client time → server time
    this._passSamples.push({ rtt, offset });

    // Pass completes when every ping we sent has been answered.
    if (this._pending.size === 0) {
      this._finishPass();
    }
  }

  /** @private adopt the lowest-RTT sample of the pass as the new estimate. */
  _finishPass() {
    this._passActive = false;
    if (this._passSamples.length === 0) return;

    let best = this._passSamples[0];
    for (const s of this._passSamples) {
      if (s.rtt < best.rtt) best = s;
    }
    this._passSamples = [];

    this.clockOffset = best.offset;
    this.lastRtt = best.rtt;
    this.synced = true;
    this._onChange();
  }

  /**
   * Snapshot of the current sync state for diagnostics / the store.
   * @returns {{ synced: boolean, clockOffset: number, lastRtt: number }}
   */
  getState() {
    return {
      synced: this.synced,
      clockOffset: this.clockOffset,
      lastRtt: this.lastRtt,
    };
  }
}
