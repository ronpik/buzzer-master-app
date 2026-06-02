// packaging/assemble.mjs
//
// Assemble the self-contained app payload that the installer ships.
//
//   node packaging/assemble.mjs [outDir]      (default: build/app)
//
// Produces a directory that runs with ZERO prerequisites on the target machine:
//
//   <outDir>/
//     node(.exe)            ← the Node binary that ran THIS script (ABI match!)
//     launcher.mjs          ← packaging/launcher.mjs
//     server/  shared/  dist/
//     node_modules/         ← ONLY ws + better-sqlite3 (server runtime deps)
//     package.json          ← { "type": "module", ...runtime deps }
//     Buzz Master.command   ← macOS double-click wrapper (darwin only)
//
// IMPORTANT (native module): the bundled `node` is `process.execPath`, i.e. the
// very Node that runs this script. The `npm install` below fetches the
// `better-sqlite3` prebuilt for THAT Node's ABI + this OS/arch — so they always
// match. Run this on the TARGET OS (Windows for the .exe, macOS for the .zip);
// CI does exactly that with a per-OS matrix. Never cross-build the payload.

import { execSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'build', 'app'));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const RUNTIME_DEPS = {
  'better-sqlite3': pkg.dependencies['better-sqlite3'],
  ws: pkg.dependencies.ws,
};

function log(msg) {
  console.log(`[assemble] ${msg}`);
}

// --- preconditions ----------------------------------------------------------
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('[assemble] dist/ is missing — run `npm run build` first.');
  process.exit(1);
}

// --- clean output -----------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
log(`output: ${OUT}`);

// --- copy app sources (skip dev DB, tests, any stray node_modules) ----------
const skip = (src) => {
  const p = src.replaceAll('\\', '/');
  return /\/node_modules(\/|$)/.test(p)
    || /\/buzzer\.db(-wal|-shm)?$/.test(p)
    || /\/server\/test(\/|$)/.test(p);
};
for (const dir of ['server', 'shared', 'dist']) {
  cpSync(join(ROOT, dir), join(OUT, dir), { recursive: true, filter: (s) => !skip(s) });
}
cpSync(join(ROOT, 'packaging', 'launcher.mjs'), join(OUT, 'launcher.mjs'));
log('copied server/, shared/, dist/, launcher.mjs');

// --- minimal runtime package.json + node_modules ----------------------------
// The server is ESM, so the bundled root needs "type": "module".
writeFileSync(
  join(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: 'buzz-master-host',
      version: pkg.version,
      private: true,
      type: 'module',
      dependencies: RUNTIME_DEPS,
    },
    null,
    2,
  )}\n`,
);
log(`installing runtime deps: ${Object.entries(RUNTIME_DEPS).map(([k, v]) => `${k}@${v}`).join(', ')}`);
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
  cwd: OUT,
  stdio: 'inherit',
});

// --- bundle the Node binary (same ABI as the better-sqlite3 we just fetched) -
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
cpSync(process.execPath, join(OUT, nodeName));
if (process.platform !== 'win32') chmodSync(join(OUT, nodeName), 0o755);
log(`bundled Node: ${process.version} (${process.platform}/${process.arch}) → ${nodeName}`);

// --- macOS: a double-clickable launcher ------------------------------------
if (process.platform === 'darwin') {
  const cmd = join(OUT, 'Buzz Master.command');
  writeFileSync(
    cmd,
    '#!/bin/bash\n'
    + 'DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    + 'exec "$DIR/node" "$DIR/launcher.mjs"\n',
  );
  chmodSync(cmd, 0o755);
  log('wrote "Buzz Master.command"');
}

// --- summary ----------------------------------------------------------------
function dirSizeMB(p) {
  let total = 0;
  const walk = (d) => {
    for (const name of execSync(process.platform === 'win32' ? `dir /b "${d}"` : `ls -A "${d}"`)
      .toString().split('\n').map((s) => s.trim()).filter(Boolean)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  try { walk(p); } catch { /* best effort */ }
  return (total / (1024 * 1024)).toFixed(1);
}
log(`done — payload ~${dirSizeMB(OUT)} MB`);
log(`run it:  "${join(OUT, nodeName)}" "${join(OUT, 'launcher.mjs')}"`);
