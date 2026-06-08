// server/test/smoke.mjs
//
// End-to-end smoke test over the REAL WebSocket server (server/index.js +
// server/ws.js + server/game.js). Boot the server first, e.g.:
//   PORT=8099 node server/index.js &  then  node server/test/smoke.mjs
//
// Exercises: hello/role routing, openQuestion (admin), roundOpen, two tablets
// buzzing in REVERSE arrival order, buzzResult winner = earliest pressAt, and
// admin-gating (a tablet's openQuestion must be ignored).

import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import { C2S, S2C } from '../../shared/protocol.js';
import { ROLE } from '../../shared/constants.js';

const PORT = process.env.PORT || 8099;
const URL = `ws://localhost:${PORT}/ws`;

function client(role, teamId) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  });
  const api = {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor: (pred, ms = 2000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting for ${pred}`)), ms);
    }),
    open: () => new Promise((res) => ws.once('open', res)),
    qn: () => {
      const m = [...inbox].reverse().find((x) => typeof x.questionNumber === 'number');
      return m ? m.questionNumber : null;
    },
  };
  return api;
}

const run = async () => {
  const admin = client(ROLE.ADMIN);
  const a = client(ROLE.TABLET, 'A');
  const b = client(ROLE.TABLET, 'B');
  await Promise.all([admin.open(), a.open(), b.open()]);

  admin.send({ type: C2S.HELLO, role: ROLE.ADMIN, clientId: 'admin-1' });
  // Bind tablets to the first two seeded teams (we read real ids from state).
  const state = await admin.waitFor((m) => m.type === S2C.STATE && m.teams?.length >= 2);
  const [t1, t2] = state.teams;
  a.send({ type: C2S.HELLO, role: ROLE.TABLET, teamId: t1.id, clientId: 'tab-A' });
  b.send({ type: C2S.HELLO, role: ROLE.TABLET, teamId: t2.id, clientId: 'tab-B' });

  // --- open a question ---
  admin.send({ type: C2S.OPEN_QUESTION });
  const open = await a.waitFor((m) => m.type === S2C.ROUND_OPEN);
  const { roundId, openAt } = open;

  // --- both buzz; t1 pressed FIRST but we send it LAST (reverse arrival) ---
  b.send({ type: C2S.BUZZ, roundId, pressAt: openAt + 30 }); // later press, sent first
  await new Promise((r) => setTimeout(r, 8));
  a.send({ type: C2S.BUZZ, roundId, pressAt: openAt + 10 }); // earlier press, sent last

  const result = await admin.waitFor((m) => m.type === S2C.BUZZ_RESULT, 3000);
  assert.equal(result.winner.teamId, t1.id, 'earliest pressAt must win over the wire');
  assert.equal(result.ranking[0].teamId, t1.id);
  assert.equal(result.ranking[1].teamId, t2.id);
  console.log(`  PASS  e2e: ${result.winner.name} won (earliest press, arrived last)`);

  // --- admin-gating: a tablet's openQuestion must be ignored ---
  const qnAfterFirst = admin.qn(); // should be 1
  a.send({ type: C2S.OPEN_QUESTION }); // tablet tries to drive the game
  await new Promise((r) => setTimeout(r, 250));
  admin.send({ type: C2S.OPEN_QUESTION }); // legit
  const open2 = await admin.waitFor(
    (m) => m.type === S2C.ROUND_OPEN && m.roundId !== roundId, 2000);
  assert.equal(open2.questionNumber, qnAfterFirst + 1,
    `tablet openQuestion must be ignored (qn ${qnAfterFirst} -> ${open2.questionNumber}, expected +1 from admin only)`);
  console.log(`  PASS  admin-gating: tablet openQuestion ignored (qn ${qnAfterFirst} -> ${open2.questionNumber})`);

  admin.ws.close(); a.ws.close(); b.ws.close();
  console.log('\nE2E SMOKE: all checks passed');
};

run().then(() => process.exit(0)).catch((e) => {
  console.error('  FAIL ', e.message);
  process.exit(1);
});
