// server/test/fairness.test.mjs
//
// Independent verification of the CORE GUARANTEE (DESIGN.md §11): the team with
// the earliest edge `pressAt` wins, regardless of the order in which presses
// arrive at the server — the exact last-write-wins race from ANALYSIS.md must be
// structurally impossible. Run with: `npm run test:fairness`.
//
// These tests drive the REAL server/game.js authority through a minimal in-memory
// db/settings stub and a captured broadcast log. No network, no SQLite.

import assert from 'node:assert/strict';
import { createGame } from '../game.js';
import { S2C } from '../../shared/protocol.js';
import { REJECT_REASON } from '../../shared/constants.js';

const WINDOW = 40; // settling window (ms) used for tests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(WINDOW + 40); // wait safely past the window

// ---- stubs -----------------------------------------------------------------

function makeDb(teams) {
  const byId = new Map(teams.map((t) => [t.id, t]));
  return {
    getLastRound: () => null,
    listTeams: () => [...byId.values()],
    getTeam: (id) => byId.get(id) || null,
    insertOpenRound: () => {},
    closeRound: () => {},
    insertBuzz: () => {},
    insertBuzzes: () => {},
    insertTeam: (t) => byId.set(t.id, t),
    updateTeam: (t) => byId.set(t.id, t),
    deleteTeam: (id) => byId.delete(id),
  };
}

function makeGame(window = WINDOW) {
  const teams = ['A', 'B', 'C', 'D'].map((id, i) => ({
    id, name: id, color: `#${i}${i}${i}`, slot: i + 1,
  }));
  const log = [];
  const game = createGame({
    db: makeDb(teams),
    settings: { getSettlingWindowMs: () => window },
    broadcast: (m) => log.push(m),
    getConnectedTeamIds: () => teams.map((t) => t.id),
  });
  return { game, log };
}

const conn = (teamId) => {
  const sent = [];
  return { teamId, lastRtt: null, send: (m) => sent.push(m), sent };
};
const rid = (game) => game._getCurrentRound().id;
const openAtOf = (game) => game._getCurrentRound().openAt;
const results = (log) => log.filter((m) => m.type === S2C.BUZZ_RESULT);
const lastResult = (log) => results(log).at(-1) || null;

// ---- tiny runner -----------------------------------------------------------

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) =>
    permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
}

// ---- tests -----------------------------------------------------------------

console.log('FAIRNESS / ARBITRATION SUITE (real game.js)\n');

await test('earliest pressAt wins even when fed LAST (reverse arrival)', async () => {
  const { game, log } = makeGame();
  game.openQuestion();
  const o = openAtOf(game), r = rid(game);
  game.handleBuzz(conn('C'), { roundId: r, pressAt: o + 30 });
  game.handleBuzz(conn('B'), { roundId: r, pressAt: o + 20 });
  game.handleBuzz(conn('A'), { roundId: r, pressAt: o + 10 }); // earliest, arrives last
  await settle();
  const res = lastResult(log);
  assert.equal(res.winner.teamId, 'A', 'earliest press must win');
  assert.deepEqual(res.ranking.map((x) => x.teamId), ['A', 'B', 'C']);
});

await test('all 24 arrival orderings → earliest pressAt always wins', async () => {
  const offset = { A: 5, B: 10, C: 15, D: 20 }; // A always earliest
  for (const order of permutations(['A', 'B', 'C', 'D'])) {
    const { game, log } = makeGame();
    game.openQuestion();
    const o = openAtOf(game), r = rid(game);
    for (const id of order) game.handleBuzz(conn(id), { roundId: r, pressAt: o + offset[id] });
    await settle();
    assert.equal(lastResult(log).winner.teamId, 'A', `order ${order.join('')}`);
  }
});

await test('earliest press delivered LAST in wall-clock (within window) still wins', async () => {
  const { game, log } = makeGame();
  game.openQuestion();
  const o = openAtOf(game), r = rid(game);
  // C arrives first (t+0) but pressed latest; A arrives last (t+25 < 40ms window) but pressed first.
  setTimeout(() => game.handleBuzz(conn('C'), { roundId: r, pressAt: o + 25 }), 0);
  setTimeout(() => game.handleBuzz(conn('B'), { roundId: r, pressAt: o + 18 }), 10);
  setTimeout(() => game.handleBuzz(conn('A'), { roundId: r, pressAt: o + 5 }), 25);
  await sleep(WINDOW + 80);
  assert.equal(lastResult(log).winner.teamId, 'A');
});

await test('winner cannot be overwritten after it is declared (too_late)', async () => {
  const { game, log } = makeGame();
  game.openQuestion();
  const o = openAtOf(game), r = rid(game);
  game.handleBuzz(conn('A'), { roundId: r, pressAt: o + 10 });
  await settle();
  assert.equal(lastResult(log).winner.teamId, 'A');
  const resultsBefore = results(log).length;

  const late = conn('B'); // a genuinely earlier PRESS, but arriving after finalize
  game.handleBuzz(late, { roundId: r, pressAt: o + 1 });
  await settle();
  assert.equal(late.sent.at(-1)?.type, S2C.REJECTED);
  assert.equal(late.sent.at(-1)?.reason, REJECT_REASON.TOO_LATE);
  assert.equal(results(log).length, resultsBefore, 'no new buzzResult after winner declared');
  assert.equal(lastResult(log).winner.teamId, 'A', 'winner unchanged');
});

await test('duplicate/mash ignored — first press time kept', async () => {
  const { game, log } = makeGame();
  game.openQuestion();
  const o = openAtOf(game), r = rid(game);
  const c = conn('A');
  game.handleBuzz(c, { roundId: r, pressAt: o + 20 }); // first press counts
  game.handleBuzz(c, { roundId: r, pressAt: o + 5 });  // earlier mash — ignored
  await settle();
  const res = lastResult(log);
  assert.equal(res.ranking.length, 1);
  assert.equal(res.winner.pressAt, o + 20, 'first press time is kept, not the later mash');
});

await test('false start (pressAt before openAt beyond tolerance) is rejected', async () => {
  const { game, log } = makeGame();
  game.openQuestion();
  const o = openAtOf(game), r = rid(game);
  const c = conn('A');
  game.handleBuzz(c, { roundId: r, pressAt: o - 50 });
  await settle();
  assert.equal(c.sent.at(-1)?.reason, REJECT_REASON.FALSE_START);
  assert.equal(results(log).length, 0, 'no winner from a false start');
});

await test('press within CLOCK_TOLERANCE before open is accepted', async () => {
  const { game, log } = makeGame();
  game.openQuestion();
  const o = openAtOf(game), r = rid(game);
  game.handleBuzz(conn('B'), { roundId: r, pressAt: o - 3 }); // within 5ms tolerance
  await settle();
  assert.equal(lastResult(log)?.winner.teamId, 'B');
});

await test('buzz for a stale/unknown round is rejected', async () => {
  const { game } = makeGame();
  game.openQuestion();
  const c = conn('A');
  game.handleBuzz(c, { roundId: 'bogus-round-id', pressAt: openAtOf(game) + 10 });
  assert.equal(c.sent.at(-1)?.reason, REJECT_REASON.STALE_ROUND);
});

// ---- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
