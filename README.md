# Local Buzzer System

> Self-hosted, **100% offline** quiz buzzer for a live conference game.
> A single Node + SQLite + WebSocket host is the **single source of truth**; 4 team
> tablets buzz, one big display shows the winner. The winner is decided by
> **synchronized edge timestamps** inside a short **settling window**, not by which
> network packet arrives first — so the *true* first press wins, regardless of Wi-Fi
> latency.

This repo replaces the previous Base44-backed version. The old design resolved
"who pressed first" as *"whose packet reached the server last"* (last-write-wins on a
shared row). See [`ANALYSIS.md`](ANALYSIS.md) for that post-mortem and
[`DESIGN.md`](DESIGN.md) for the full design of the system documented here.

---

## Why this exists (the core idea)

A buzzer does **not** need minimal latency — it needs **correct ordering**. If every
tablet had a constant 80 ms delay it would still be perfectly fair. The failure mode to
design out is **variable latency deciding the winner**.

So instead of racing packets, we:

1. **Timestamp the press at the edge.** The tablet captures the exact moment of the
   physical press from the DOM event's high-resolution `timeStamp` (same time origin as
   `performance.now()`), in the synchronous pointer handler — **no React state in the
   critical path**.
2. **Synchronize clocks.** Each tablet continuously estimates the offset between its own
   monotonic clock and the server's monotonic clock (SNTP/Cristian's style, min-RTT
   sample) to ~1–3 ms on a clean LAN. The press timestamp is converted into **server
   time** before it is sent.
3. **Settle, then sort.** When the first press of an open question arrives, the server
   starts a short **settling window** (default 50 ms). Any presses that land during the
   window join the candidate set. When the window closes, the server **sorts by edge
   timestamp** and declares the **earliest** the winner.

A tablet can therefore be *slow to report* its press and still win if it *pressed*
first. Transport latency only affects how long the server waits (the window), never who
wins. Human "tie" differences are 10–100 ms; we resolve order to a few ms, well below
anything a human can contest.

Because Node's event loop serializes every incoming message, the first `buzz` handled
for an open round starts the window and subsequent presses merely join the set — there
is **no read-modify-write against a shared row**, so the old last-write-wins race is
*structurally impossible*.

---

## Architecture

```
                       ┌─────────────────────────────────────────────┐
                       │   HOST MACHINE (laptop / mini-PC)            │
                       │                                              │
                       │   Node server  ── in-memory game state       │
                       │     │            (single authority)          │
                       │     ├── WebSocket server (ws)   /ws          │
                       │     ├── Static file server (Vite build)      │
                       │     └── SQLite (better-sqlite3, write-behind) │
                       │                                              │
                       │   Display page (browser) ── HDMI ───────────────► PROJECTOR
                       └───────────────┬──────────────────────────────┘
                                       │ Ethernet (wired)
                                ┌──────┴───────┐
                                │ DEDICATED AP │  (5 GHz, private SSID, no internet)
                                └──────┬───────┘
                  ┌──────────┬─────────┼─────────┬──────────┐  Wi-Fi
              ┌───┴───┐  ┌───┴───┐ ┌───┴───┐ ┌───┴───┐
              │Tablet1│  │Tablet2│ │Tablet3│ │Tablet4│   (one per team, kiosk-locked)
              └───────┘  └───────┘ └───────┘ └───────┘
```

- **One Node process serves everything** on a single origin/port: the built React client
  (static files), optional uploaded banner assets, and the WebSocket endpoint that is the
  game's authority.
- **In-memory authority, write-behind SQLite.** The live round (`currentRound`) decides
  the winner in memory; rounds/buzzes are persisted to SQLite *after* the result is
  broadcast, purely for recovery and audit. SQLite is **never** in the buzz hot path.
- **Presence is the socket.** A tablet is "connected" exactly while its WebSocket is open
  — no heartbeat table, no stale rows.
- **No internet** is required at any point. Clock sync is our own ping/pong over the LAN,
  not NTP.

---

## Tech stack

**Server** (`server/`): Node 20, [`ws`](https://github.com/websockets/ws) for WebSockets,
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for synchronous local
persistence, and Node's built-in `http` module for static files (no Express/Fastify).
Plain ESM (`"type": "module"`).

**Client** (`src/`): the existing React + Vite + Tailwind UI (Hebrew / RTL), rewired off
Base44 onto a small `net/` layer + a tiny store. State is driven entirely by server
messages over one WebSocket. The build is served by the Node host (single origin).

**Shared** (`shared/`): the wire contract — message-type strings, payload shapes, enums,
and tuning constants — imported by both the server and the client so the protocol can
never drift between them.

---

## Repository layout

```
shared/
  constants.js        # ports, paths, roles, statuses, reject reasons, tuning knobs
  protocol.js         # message-type strings (C2S/S2C) + payload shapes (single contract)

server/
  index.js            # bootstrap: HTTP static server + WS + DB; SPA fallback; graceful shutdown
  ws.js               # connection lifecycle, role routing, presence, broadcast (no game logic)
  game.js             # in-memory authority: state machine, buzz arbitration, settling window
  clock.js            # serverNow() (monotonic) + ping/pong responder
  db.js               # better-sqlite3 setup + prepared-statement persistence API
  settings.js         # runtime-tunable settling window (cached; backed by `settings` table)
  schema.sql          # SQLite schema (teams, rounds, buzzes, settings)

src/
  net/
    socket.js         # one WebSocket: auto-reconnect, hello, drives clock sync, buzz/admin sends
    clockSync.js      # client clock-offset estimator; toServerTime(); `synced` gate
  store.js            # client game store (useSyncExternalStore) fed by server messages
  pages/
    Admin.jsx         # host controls: new question / reset / clear, team CRUD, diagnostics
    BuzzerJoin.jsx    # team picker shown at /play when a tablet isn't yet bound to a team
    BuzzerPlay.jsx    # the buzzer: edge-timestamped press, wake lock, sync gate
    Display.jsx       # projector screen: idle/open/winner visuals + sound

DESIGN.md             # full design document (read this for the why/how in depth)
ANALYSIS.md           # post-mortem of the old Base44 version (what was broken)
```

---

## Quick start

> Prerequisite: **Node 20+**. `better-sqlite3` is a native module — `npm install` builds
> it for your platform.

```bash
# 1. install dependencies (builds the native SQLite module)
npm install

# 2. build the client (the server serves this static build)
npm run build

# 3. start the host (serves the client + the WebSocket on one port)
npm run serve
```

Then open, on the host machine:

| Page        | URL                            | Who                            |
|-------------|--------------------------------|--------------------------------|
| **Admin**   | `http://localhost:8080/`       | the host/operator (host only)  |
| **Display** | `http://localhost:8080/display`| the projector screen           |
| **Buzzer**  | `http://<host-ip>:8080/play`   | each team tablet               |

The server prints these URLs (with the resolved port), the team count, the current
question number, and the active settling window on startup.

> The host listens on `0.0.0.0`, so tablets reach it at the host's LAN IP
> (e.g. `http://192.168.8.10:8080/play`). On the host itself, `localhost` works.

### Development (hot reload)

For client iteration with Vite's dev server **and** the live backend, run both:

```bash
npm run serve   # terminal 1: Node host (WebSocket authority + API)
npm run dev     # terminal 2: Vite dev server (HMR) for the React UI
```

The client derives its WebSocket URL from `window.location` (same host/port as the page),
so when iterating through the Vite dev server, point the browser at the page served by the
Node host (or configure a dev proxy) so the `/ws` connection lands on the Node process.
For a faithful end-to-end run, prefer `npm run build` + `npm run serve` (single origin).

---

## npm scripts

| Script              | Purpose                                                            |
|---------------------|-------------------------------------------------------------------|
| `npm run serve`     | Start the Node host (`node server/index.js`).                     |
| `npm start`         | Alias of `serve`.                                                 |
| `npm run build`     | Build the React client to `dist/` (served by the host).          |
| `npm run dev`       | Vite dev server with HMR (client only).                          |
| `npm run preview`   | Preview the production client build with Vite.                   |
| `npm run lint`      | ESLint.                                                           |
| `npm run lint:fix`  | ESLint with `--fix`.                                              |
| `npm run typecheck` | Type-check the JSDoc-typed JS via `tsc`.                         |

---

## Configuration (environment variables)

All optional; sensible defaults are in `shared/constants.js` and `server/`.

| Variable      | Default                | Meaning                                                        |
|---------------|------------------------|----------------------------------------------------------------|
| `PORT`        | `8080`                 | Port for the HTTP + WebSocket origin.                         |
| `CLIENT_DIST` | `./dist`               | Directory of the built client to serve.                      |
| `BUZZER_DB`   | `server/buzzer.db`     | SQLite database file. Use `:memory:` for an ephemeral DB.    |
| `UPLOADS_DIR` | `server/uploads`       | Directory for operator-uploaded banners, served at `/assets/uploads/`. |

The WebSocket path is `/ws` and the client connects on the **same origin** as the page —
there is no host/port to configure on the client.

The **settling window** is *not* an env var: it defaults to 50 ms and is tuned at runtime
(persisted in the SQLite `settings` table under `settling_window_ms`) so you can calibrate
it at the venue without a restart.

Example:

```bash
PORT=9000 BUZZER_DB=/tmp/buzzer.db npm run serve
```

There is a liveness probe at `GET /health` (returns `{"ok":true}`), handy for the runbook
and tests.

---

## How a round works (end to end)

1. **Admin → "New question"** → server stamps `openAt`, increments the question number,
   assigns a fresh `roundId`, and broadcasts `roundOpen` (+ a full `state`). Tablets go
   live.
2. **A player taps.** The tablet captures the press time in the synchronous pointer
   handler, converts it to server time via its clock offset, and sends a `buzz` with the
   `roundId` and `pressAt`. The button locks (optimistic "pressed" UI).
3. **First valid buzz** flips the round to an internal `settling` state and starts the
   ~50 ms window. Later presses during the window join the candidate set.
4. **Window closes** → the server sorts candidates by `pressAt`, ranks them, declares the
   earliest the winner, and **broadcasts `buzzResult`** (winner + full ranking). It then
   persists the round and its buzzes write-behind.
5. **Display** shows the winner banner/name and plays the buzzer sound; the winning tablet
   shows "won", the others "lost". Admin presses "New question" for the next, or "Reset"
   to return to idle.

A buzz that can't win is told why via `rejected`:

| Reason        | When                                                              |
|---------------|-------------------------------------------------------------------|
| `too_late`    | a winner was already declared for this round.                    |
| `false_start` | pressed before the round opened (beyond the clock tolerance).    |
| `duplicate`   | this team already has a press in this round (ignored silently).  |
| `stale_round` | the buzz referenced a round that isn't the current one.          |

---

## Game state machine

```
   idle ──openQuestion──▶ open ──first valid buzz──▶ settling ──window elapses──▶ buzzed
    ▲                      │                            │                            │
    │                      │                            │                            ├─openQuestion─▶ open (next question)
    └──────resetGame───────┴────────────resetGame───────┴───────resetGame────────────┤
                                                                                      └─clearBuzz────▶ open (retry same question)
```

- `settling` is **internal** to the server (≤ window-ms); clients keep showing "open"
  visuals during it. In `state` snapshots it is reported as `open`.
- Only the server transitions state. Clients render whatever the latest `state`/event says.
- On **server restart**, the team list and question counter are recovered from SQLite, but
  the live round is **always reset to idle** — a half-open round is never resumed. Tablets
  reconnect automatically and receive a fresh `state`.

---

## WebSocket protocol

JSON text frames on `/ws`. Every timestamp that matters (`pressAt`, `openAt`,
`winner.pressAt`, `tServer`) is in **server time** (milliseconds, from the server's
monotonic `performance.now()` origin); clients convert local timestamps via their measured
offset before sending. The authoritative definitions live in
[`shared/protocol.js`](shared/protocol.js); the strings below must match it exactly.

Every connection identifies itself with a `hello` declaring a **role**: `tablet` (with a
`teamId`), `display`, or `admin`. Admin-only actions are rejected from non-admin
connections. The server answers every `hello` with a full `state` snapshot so a
(re)connecting client immediately agrees with the authority.

### Client → Server

| `type`         | payload                                            | sent by | meaning                              |
|----------------|----------------------------------------------------|---------|--------------------------------------|
| `hello`        | `{ role, teamId?, clientId, secret? }`             | all     | identify on (re)connect              |
| `ping`         | `{ seq, t0 }`                                       | all     | clock-sync probe (`t0` = client perf.now) |
| `buzz`         | `{ roundId, pressAt }`                              | tablet  | a press; `pressAt` in **server time**|
| `openQuestion` | `{}`                                                | admin   | start a new question                 |
| `clearBuzz`    | `{ roundId }`                                       | admin   | clear buzz, reopen the same question |
| `resetGame`    | `{}`                                                | admin   | back to idle, question number → 0    |
| `upsertTeam`   | `{ id?, name, color, banner_url, slot }`           | admin   | create (omit `id`) / edit a team     |
| `deleteTeam`   | `{ id }`                                            | admin   | remove a team                        |

### Server → Client

| `type`        | payload                                                                         | meaning                              |
|---------------|---------------------------------------------------------------------------------|--------------------------------------|
| `pong`        | `{ seq, t0, tServer }`                                                           | clock-sync reply                     |
| `state`       | `{ status, roundId, questionNumber, openAt, teams[], connected[], winner? }`     | full snapshot (on connect & on change)|
| `roundOpen`   | `{ roundId, questionNumber, openAt }`                                            | a question opened — buzzers go live  |
| `buzzResult`  | `{ roundId, winner:{teamId,name,color,pressAt}, ranking:[{teamId,pressAt,rank}] }`| winner declared after settling       |
| `rejected`    | `{ roundId, reason }`                                                            | your buzz was not accepted           |
| `reset`       | `{}`                                                                             | game reset to idle                   |
| `presence`    | `{ connected:[teamId...] }`                                                      | which tablets are currently connected|
| `error`       | `{ message }`                                                                    | protocol/validation error            |

### Clock synchronization

On connect and every 5 s, each client runs one sync pass: it sends a burst of `ping`
frames, the server replies with `pong` echoing `t0` and carrying `tServer`, and the client
computes `offset = tServer - (t0 + t1) / 2` per round trip, keeping the **lowest-RTT**
sample (least queuing noise). Both ends use monotonic `performance.now()`, so the estimate
is immune to wall-clock jumps. **Buzzing is gated on a completed sync** — a tablet shows
"syncing…" and cannot buzz until its first pass finishes; it re-syncs after any reconnect.

---

## Data model (SQLite)

Persistence, recovery, and audit only — written **behind** the live decision. Schema in
[`server/schema.sql`](server/schema.sql).

- **`teams`** — `id`, `name`, `color` (hex), `banner_url?`, `slot` (1..4, display order /
  tablet binding).
- **`rounds`** — `id`, `question_number`, `opened_at`, `status` (`open` | `buzzed` |
  `reset`), `winner_team_id?`, `winner_press_at?`, `closed_at?`. All `*_at` are
  server-clock ms (`REAL`).
- **`buzzes`** — one row per press attempt (accepted or rejected): `round_id`, `team_id`,
  `press_at` (edge timestamp), `received_at`, `rtt_ms?`, `accepted` (0/1),
  `reject_reason?`, `rank?`. This is the audit trail behind every close call.
- **`settings`** — key/value (TEXT). Currently holds `settling_window_ms`.

---

## Client store (for UI work)

React pages never talk to the socket directly. They read the single store in
[`src/store.js`](src/store.js), which is fed exclusively by server messages and exposed via
`useSyncExternalStore` (no extra state-management dependency).

- **Connect:** `initGame({ role, clientId, teamId?, secret? })` — call once per page (in an
  effect) and use the returned disposer as cleanup. `role` is one of `ROLE.TABLET` /
  `ROLE.DISPLAY` / `ROLE.ADMIN` from `shared/constants.js`.
- **Selectors (hooks):** `useStatus`, `useTeams`, `useConnected`, `useWinner`, `useRanking`,
  `useQuestionNumber`, `useRoundId`, `useOpenAt`, `useBuzzSent`, `useLastReject`,
  `useConnection` (connection + clock-sync status), `useCanBuzz` (is the button live?),
  `useMyResult` (`'won'` / `'lost'` / `null` for the bound tablet). For custom slices,
  `useGame(selector)`.
- **Actions:** `buzz(edgePerfTs?)`, `openQuestion()`, `clearBuzz()`, `resetGame()`,
  `upsertTeam(team)`, `deleteTeam(id)` — each delegates to the socket.

The optimistic "pressed" flag (`buzzSent`) is cleared automatically on disconnect, so a
tablet is never left stuck showing it pressed; the authoritative state arrives on
reconnect.

---

## Tablet provisioning

The 4 tablets are **ours** and pre-configured once before the event:

- Join the dedicated **SSID**; verify auto-reconnect. Disable Wi-Fi power saving; disable
  cellular (or airplane mode + Wi-Fi) so they don't drop a no-internet AP.
- **Kiosk / Guided Access** locked to the buzzer URL: `http://<host-ip>:8080/play`.
- Screen never sleeps, brightness up, notifications off, auto-update off.
- **Pin the team.** Open the buzzer once with `?team=<teamId>` (or `/play/<teamId>`), or use
  the on-screen team picker at `/play`. The page persists `teamId` (and a stable device
  `clientId`) in `localStorage`, so a kiosk reload re-binds the same team forever. Keys:
  `buzzer.teamId`, `buzzer.clientId`.
- The buzzer page also requests the **Screen Wake Lock API** at runtime as a belt-and-
  suspenders against sleep (and to keep the Wi-Fi radio active).

At the venue, you power them on and they're already on the right network, locked to the
right team, awake.

---

## Network & hardware

- **Dedicated AP** (travel/home router), **5 GHz**, WPA2, private SSID used only for the
  game, on a clean channel scanned at the venue. With only 4 clients, contention is
  effectively zero. Place it **centrally among the team tables** (prefer 2.4 GHz only if
  range/obstructions demand it).
- **Host wired (Ethernet) to the AP** so the tablets own the Wi-Fi airtime.
- **Display:** preferred path is the Display page rendered on the host, HDMI to the
  projector — zero network in the result path. A separate device loading `/display` over
  Wi-Fi is also fine (display lag doesn't affect fairness).
- **No internet needed.** Clock sync is our own ping/pong, not NTP.

---

## Venue runbook

**Setup (~30 min before):**

1. Power the AP centrally among the team tables; confirm a clean 5 GHz channel.
2. Wire the host to the AP; `npm run serve`; open Admin (host) + Display (HDMI to projector).
3. Power on the 4 tablets — they auto-join Wi-Fi, auto-open `/play`, auto-pin their team.
4. Confirm all 4 show **connected + synced** in the Admin diagnostics panel.
5. **Calibrate** the settling window from observed RTTs; run 2–3 mock rounds.

**During the game:** Admin presses "New question" → teams buzz → Display shows the winner →
"New question" for the next, "Reset" to start over.

**If a tablet misbehaves:** it auto-recovers on reconnect (re-`hello`, re-sync, fresh
`state`); worst case, reload the kiosk page — the team re-pins from `localStorage`.

---

## Calibration & diagnostics

The settling window only needs to cover **network delivery jitter between near-simultaneous
presses**, not the spacing between human reactions. With 4 tablets on a clean dedicated AP
that jitter is a few ms; **50 ms is a conservative, imperceptible default**.

To tune it, read each tablet's RTT distribution and clock offset in the Admin diagnostics
panel and set the window to a safe cover of observed one-way jitter (roughly
`ceil(p99_RTT / 2) + 10 ms`). The value is persisted in the `settings` table and applied
live — no restart. The panel also shows, for the last round, the full ranking with
inter-press deltas (e.g. "Team B +4 ms behind Team A"), which makes close calls
transparent.

---

## Failure handling

| Scenario                       | Behavior                                                                                  |
|--------------------------------|-------------------------------------------------------------------------------------------|
| Tablet Wi-Fi drop              | WS auto-reconnects (backoff) → re-`hello` → re-sync clock → server pushes current `state`. Button re-enables only after sync. |
| Tablet sleeps                  | Prevented by kiosk + Wake Lock; if it still happens, the reconnect path recovers it.     |
| Buzz send fails / disconnect   | Optimistic "pressed" UI is reverted; on reconnect the server's round state is authoritative. |
| Duplicate / mashed presses     | Ignored per (round, team).                                                               |
| Press after winner declared    | `rejected: too_late` → "missed" UI.                                                       |
| Press before open              | `rejected: false_start` (a small clock tolerance forgives sub-sync-error early presses). |
| Bad/early clock (not synced)   | Buzzing disabled until the first sync completes.                                          |
| **Server restart**             | Teams + question counter recovered from SQLite; live round reset to idle; tablets reconnect and get fresh `state`. |
| Two admin tabs                 | Harmless — both talk to the one authority; state is server-owned (no duplicate sessions). |
| Display device drop            | Cosmetic; reconnects and re-renders from `state`.                                        |

---

## What changed from the Base44 version

| Old (Base44)                                              | New (local)                                                           |
|----------------------------------------------------------|-----------------------------------------------------------------------|
| `Group` entity                                           | `teams` table                                                         |
| `GameSession` (single shared row, **last-write-wins**)   | server in-memory `currentRound` + `rounds` table — **authoritative, atomic** |
| `GroupSession` heartbeat rows (accumulate, go stale)     | live WS connections (`presence`) — no polling, no stale rows          |
| `subscribe()` + refetch                                  | WS push (`state` / events) — single hop, no refetch                  |
| `update()` for the buzz (the race)                       | `buzz` message → server arbitration with **timestamps + settling window** |
| Auth context / app-params / Base44 client / React-Query  | removed — single trusted LAN; a small server-fed store                |

This closes every gap in [`ANALYSIS.md`](ANALYSIS.md): atomic first-buzz, a single source
of truth, no stale presence, clean reconnect/sync recovery, and no silent buzz-lockout.

---

## License

Private project for a single event. Not for redistribution.
