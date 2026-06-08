# Packaging the host as a Windows program (and a macOS test build)

This wraps the buzzer host into a **self-contained app** an operator installs and
runs with **no Node and no dev environment** on the target machine. It is the
"lean bundled Node" approach — *not* Electron: every client (Admin, Display, Play)
is already a browser over the LAN, so there is no desktop window to ship. The
operator just launches the app and a browser opens to the Admin page.

- **Windows** → an Inno Setup installer (`BuzzMaster-Setup-<ver>.exe`).
- **macOS** → a zip (`BuzzMaster-mac-<ver>.zip`) for testing the packaged form on
  your dev Mac. (Day-to-day Mac dev is still just `npm run serve`.)

## What gets bundled

`packaging/assemble.mjs` produces a payload directory that runs standalone:

```
<payload>/
  node(.exe)            the Node binary that ran assemble.mjs (ABI-matched)
  launcher.mjs          sets writable paths, starts the host, opens the browser
  server/  shared/  dist/
  node_modules/         ONLY ws + better-sqlite3 (the server's runtime deps)
  package.json          { "type": "module", ...runtime deps }
  Buzz Master.command   macOS double-click wrapper (macOS payloads only)
```

The client libraries (React, Radix, three, …) are **build-time only** — they're
compiled into `dist/` and never shipped, which keeps the payload small.

### How it runs on the target

The shortcut runs `node(.exe) launcher.mjs`, and `launcher.mjs`:

1. Redirects the SQLite DB + uploads to a **writable** per-user folder
   (`%LOCALAPPDATA%\BuzzMaster` on Windows, `~/Library/Application Support/BuzzMaster`
   on macOS) — `Program Files` is read-only. It sets `BUZZER_DB`, `UPLOADS_DIR`,
   and `CLIENT_DIST` via the server's existing env hooks.
2. Starts `server/index.js` **in-process**, so closing the window stops the server.
3. Prints the host LAN IP + the Admin/Display/Play URLs.
4. Opens the Admin page in the default browser once the server is listening.

The **Windows installer** additionally opens TCP **port 8080** in Windows Firewall
(removed on uninstall) so team tablets on the contest Wi-Fi can connect.

## The native-module rule (read this)

`better-sqlite3` is a compiled binary that must match **(OS + arch + Node ABI)**.
The bundled `node` is `process.execPath` — the same Node that runs `assemble.mjs`
— and the `npm install` inside the payload fetches the matching `better-sqlite3`
prebuilt. They always agree **as long as you assemble on the target OS**:

> Build the Windows installer **on Windows**, the macOS zip **on macOS**.
> Never cross-build the payload from one OS for another.

CI does this automatically with a per-OS matrix (below).

## Build locally

On the OS you want to package for:

```bash
npm ci
npm run build                          # client → dist/
node packaging/assemble.mjs build/app  # → build/app/  (or: npm run pack:local)

# smoke-test the bundled payload directly:
./build/app/node ./build/app/launcher.mjs          # macOS/Linux
# build\app\node.exe build\app\launcher.mjs        # Windows
```

To produce the Windows `.exe` you also need **Inno Setup 6.3+** (`ISCC.exe`):

```powershell
ISCC /DAppVersion=1.0.0 /DStageDir=build\app installer\buzzmaster.iss
# → installer\Output\BuzzMaster-Setup-1.0.0.exe
```

## Build in CI (GitHub Actions)

`.github/workflows/build-installers.yml` runs a `windows-latest` + `macos-latest`
matrix. Each runner: `npm ci` → `npm run build` → `node packaging/assemble.mjs`
→ package (Inno Setup on Windows, `zip` on macOS) → upload the artifact.

- **On every push to a `v*` tag or manual run:** artifacts are uploaded.
- **On a `v*` tag:** artifacts are also attached to the GitHub Release.

Trigger a release build:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Then grab `BuzzMaster-Setup-1.0.0.exe` from the run's artifacts or the Release.

## Notes & caveats

- **macOS Gatekeeper:** the zip is unsigned, so the first launch may warn. Right-click
  `Buzz Master.command` → **Open**, or clear quarantine:
  `xattr -dr com.apple.quarantine "/path/to/app"`. Fine for a dev/test box; for
  distribution you'd sign + notarize.
- **Windows SmartScreen:** an unsigned installer shows a "Windows protected your PC"
  prompt (More info → Run anyway). Add Authenticode signing later to remove it.
- **Architecture:** each build targets the runner's arch (Windows x64, macOS arm64
  on `macos-latest`). Add more matrix entries if you need others.
- **Operator UX:** no typing of URLs needed — the Admin page shows a join **QR code**
  (`react-qr-code`) for tablets, and the launcher window prints the host IP too.
