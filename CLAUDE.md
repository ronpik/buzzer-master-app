# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A LAN quiz-buzzer for a live event: one host (admin + projector display) and ~4 dedicated tablets. The one hard requirement is **deciding who pressed first, fairly**, with no cloud. It was migrated off Base44 (a BaaS) to a self-hosted Node + SQLite + WebSocket system. `DESIGN.md` is the authoritative design spec (code comments cite its section numbers, e.g. "DESIGN.md §11"); `ANALYSIS.md` explains why the original Base44 version's buzz logic was broken.

## Commands

```bash
# Run for the event (single origin: Node host serves the built client + the WS on :8080)
npm run build && npm run serve        # open / (admin), /display (projector), /play (tablets)

# Develop with HMR — TWO terminals (the Vite proxy in vite.config.js bridges /ws → the host)
npm run serve                         # terminal 1: Node host on :8080
npm run dev                           # terminal 2: Vite dev server (proxies /ws to VITE_WS_TARGET, default ws://localhost:8080)

npm run lint        # eslint . --quiet   (lint:fix to autofix)
npm run typecheck   # tsc over jsconfig.json — this is JS + JSDoc types, not TS

# Package a zero-prerequisite distributable (bundles the Node binary + ws + better-sqlite3 + dist)
npm run pack:local                    # → build/app/  (see packaging/assemble.mjs, launcher.mjs)
```

### Tests
```bash
npm run test:fairness                 # CORE GATE: unit-tests the arbitration in server/game.js. No server/network.
# smoke is end-to-end over a real WebSocket and needs a running server first:
BUZZER_DB=:memory: PORT=8099 node server/index.js &   # clean ephemeral host
PORT=8099 npm run test:smoke                          # connects, opens a question, buzzes, asserts the winner
```
- Both test files are plain Node scripts using `node:assert` + a tiny inline runner — **there is no test-name filter**. To run one case, run the file directly (`node server/test/fairness.test.mjs`) and temporarily narrow the `test(...)` calls.
- `test:fairness` drives the real `createGame` with a stub db; treat it as the required gate for any change to `server/game.js`.

### Environment variables
- `PORT` (default `8080`) — the single HTTP+WebSocket origin.
- `BUZZER_DB` (default `server/buzzer.db`; gitignored) — set to `:memory:` for an ephemeral DB.
- `VITE_WS_TARGET` (default `ws://localhost:8080`) — dev-only `/ws` proxy target.

## Architecture (the parts that span multiple files)

**Single authority + the fairness model — read `server/game.js`, `src/net/clockSync.js`, and `shared/constants.js` together.**
- The Node server is the single source of truth. `server/game.js` (`createGame`) holds the live round **in memory**; SQLite is strictly write-behind (audit/recovery) and is **never** in the buzz decision path.
- **Atomicity is free**: Node's single-threaded event loop serializes every `buzz`. The first press of an `open` round flips it to `settling` and starts ONE timer; later presses merely join the candidate set. There is no read-modify-write on a shared row, so the old Base44 "last write wins" race is structurally impossible.
- **Fairness = edge timestamps + clock sync + a settling window.** Each tablet stamps the press at the instant of the tap (`event.timeStamp`), converts it to **server time** via a measured clock offset (`src/net/clockSync.js`, Cristian's algorithm, keeps the min-RTT sample), and sends `pressAt`. After the first press the server waits `SETTLING_WINDOW_MS` (~50 ms), then sorts accepted presses by `pressAt` and declares the **earliest** the winner. Transport latency/jitter therefore does not pick the winner — the synchronized press time does.
- **All wire timestamps are SERVER time (ms).** Clients convert local `performance.now()` via their offset before sending. Never compare a raw client clock to a server timestamp.

**The `shared/` contract is load-bearing.** `shared/protocol.js` (C2S/S2C message-type strings + JSDoc payload shapes) and `shared/constants.js` (tuning knobs, enums, default port, settling window) are imported by **both** server and client — change a message shape in exactly one place. Server and client import `shared/` via **relative paths** (`../shared/...`); the `@/` alias only maps to `src/`.

**Client is one singleton store with a role per page — `src/store.js`.** There is no React context provider. `src/store.js` exports a singleton `store`, the `useGame(selector)` hook plus fine-grained selectors (`useStatus`, `useTeams`, `useConnected`, `useWinner`, `useCanBuzz`, …), and `initGame({ role, clientId, teamId })`. Each page calls `initGame` once in an effect to open the WebSocket in its role: Admin→`ADMIN`, Display/BuzzerJoin→`DISPLAY`, BuzzerPlay→`TABLET`. The socket layer is `src/net/socket.js` (reconnecting WS, connects same-origin to `/ws`); state is driven by inbound S2C messages. **Keep the buzz hot path synchronous**: `BuzzerPlay` reads the clock offset directly from the `clockSync` module (not React state) so nothing re-renders between tap and send.

**Routing & presence.** Routes (`src/App.jsx`): `/`→Admin, `/play`→BuzzerJoin (team picker), `/play/:groupId`→BuzzerPlay (the buzzer), `/display`→Display. A tablet's team is pinned in `localStorage` (set via `/play/:id`, `?team=`, or the picker). Presence = the live socket itself (no heartbeat table): the server tracks connected tablet teamIds and broadcasts them.

**Resilient persistence + seeding — `server/db.js`.** better-sqlite3 is loaded defensively (`createRequire` + try/catch); if the native module is missing or the DB can't open, it falls back to an **in-memory store with the same API** so the game still runs (no persistence). On boot it seeds 4 default teams when the table is empty. Schema: `server/schema.sql` (`teams`, `rounds`, `buzzes`, `settings`).

**Round flow.** Admin `openQuestion` → server stamps `openAt`, broadcasts `roundOpen` → tablets go live, buzz with `pressAt` → settling window → server broadcasts `buzzResult` (winner + full ranking) → Display plays the alarm and shows the winner. State machine: `idle → open → settling → buzzed` (DESIGN.md §12); `settling` is internal and rendered as `open` to clients.

**Offline note.** The whole game path runs with no internet. The only external dependency is two decorative conference logos loaded from `media.base44.com` in `src/pages/Display.jsx`.
