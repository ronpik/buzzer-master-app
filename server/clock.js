// server/clock.js
//
// Server-side clock for the buzzer system (DESIGN.md §10).
//
// The single source of "server time" is the process's MONOTONIC high-resolution
// clock, `performance.now()`. It is immune to wall-clock jumps (NTP steps, DST,
// manual changes) and is in the same unit (milliseconds, fractional) as the
// browser's `performance.now()`. Clients estimate a constant `clockOffset` such
// that `serverTime ≈ clientPerfNow + clockOffset`, so the two monotonic clocks
// (with different, arbitrary origins) are bridged to ~1–3 ms on a clean LAN.
//
// Every timestamp that crosses the wire and matters for fairness (`pressAt`,
// `openAt`, `winner.pressAt`) is expressed in this server-time scale.

import { performance } from 'node:perf_hooks';
import { S2C } from '../shared/protocol.js';

/**
 * Current server time in milliseconds (monotonic, sub-ms resolution).
 *
 * This is the one and only clock the game logic, arbitration, and persistence
 * read. Do NOT use `Date.now()` anywhere on the buzz path — it is wall-clock and
 * can jump.
 *
 * @returns {number} Milliseconds since this process's monotonic time origin.
 */
export function serverNow() {
  return performance.now();
}

/**
 * Handle a clock-sync `ping` from a client by replying with a `pong` stamped at
 * the moment of handling (DESIGN.md §10). The reply echoes `seq` and `t0` so the
 * client can correlate the sample and compute:
 *
 *   rtt    = t1 - t0                       (t1 = client perf.now() on receipt)
 *   offset = tServer - (t0 + t1) / 2       (add to client time → server time)
 *
 * `tServer` is sampled as late as possible (right before send) to minimise the
 * server-side portion of the measured round trip.
 *
 * The reply is sent via the provided `send` callback rather than touching the
 * raw socket here, so this stays transport-agnostic and trivially testable.
 *
 * @param {(msg: import('../shared/protocol.js').PongMsg) => void} send
 *        Sends one JSON-able message back to the originating client.
 * @param {{ seq: number, t0: number }} ping  The incoming ping payload.
 */
export function handlePing(send, { seq, t0 }) {
  send({
    type: S2C.PONG,
    seq,
    t0,
    tServer: serverNow(),
  });
}
