# Installing & running on a Windows laptop

This guide walks through running the buzzer host on a **Windows laptop connected
to the dedicated contest router**, and verifying end-to-end that the team tablets
can reach it before the event starts.

The app is **100% offline**: one Node process serves the React client *and* the
WebSocket authority on a single port (`8080` by default). No internet, no cloud,
no `.env` configuration is required.

> **The three Windows-specific gotchas** this guide exists to cover:
> 1. Installing Node so the native SQLite module builds.
> 2. Finding the laptop's LAN IP with `ipconfig` (the tablets need it).
> 3. **Windows Firewall** — it silently blocks the tablets from reaching the host
>    until you allow port `8080` inbound. This is the #1 cause of "tablets can't
>    connect" at event time.

---

## 1. One-time setup

### 1a. Install Node.js 20 or 22 (LTS)

Download the **Windows Installer (`.msi`)** from <https://nodejs.org> and run it.

- On the **"Tools for Native Modules"** screen you can leave the checkbox **off**.
  `better-sqlite3` ships a prebuilt binary for standard x64 Windows on Node LTS,
  so no compiler is needed. (Only tick it if `npm install` later fails to build —
  see [Troubleshooting](#troubleshooting).)

Verify in **PowerShell** (or Command Prompt):

```powershell
node -v   # should print v20.x or v22.x
npm -v
```

### 1b. Get the code onto the laptop

Either clone it:

```powershell
git clone <repo-url>
cd buzz-master-app
```

…or copy the project folder over (USB / network share). If you copy it, you can
skip `node_modules\` and `dist\` — they are git-ignored and get rebuilt below.

---

## 2. Install dependencies & build the client

From the project folder:

```powershell
npm install      # installs deps + the native SQLite module
npm run build    # builds the React client into dist\ (the server serves this)
```

`npm run build` is required: the host serves the static build from `dist\`. If
you start the server without it, pages return **503 "Client build not found"**.

No `.env` is needed. (The Base44 variables in `.env.local` are dead leftovers
from a past migration and are ignored at runtime.)

---

## 3. Network setup — the part that bites on Windows

### 3a. Join the contest router's Wi-Fi

Connect the laptop to the **same SSID** the team tablets will use. When Windows
asks *"Allow your PC to be discoverable on this network?"*, choose **Yes** so the
network is classified as **Private** (not Public). The firewall rule below is
scoped to the Private profile.

To check / change the profile later: **Settings → Network & Internet → Wi-Fi →**
*(your network)* **→ Network profile type → Private**.

### 3b. Find the laptop's LAN IP

```powershell
ipconfig
```

Under your **Wi-Fi adapter**, read the **IPv4 Address**, e.g. `192.168.8.10`.
That is your `<host-ip>` — the tablets connect to `http://<host-ip>:8080/play`.

> Tip: if the router lets you, reserve a static DHCP lease for the laptop so the
> IP doesn't change between sessions.

### 3c. Allow port 8080 through Windows Firewall

**Without this, tablets cannot reach the buzzer page.** Open **PowerShell as
Administrator** (right-click → *Run as administrator*) and run:

```powershell
New-NetFirewallRule -DisplayName "Buzzer 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

Alternative (Command Prompt as Administrator):

```cmd
netsh advfirewall firewall add rule name="Buzzer 8080" dir=in action=allow protocol=TCP localport=8080
```

> When you first run the server, Windows may also pop up a *"Defender Firewall
> blocked some features of this app"* dialog. Tick **Private networks** and click
> **Allow access**. Creating the explicit rule above is more reliable for an event.

To remove the rule later: `Remove-NetFirewallRule -DisplayName "Buzzer 8080"`.

---

## 4. Start the host

```powershell
npm run serve
```

On startup it prints the listening URLs, team count, current question number, and
the active settling window. The host listens on `0.0.0.0:8080` (all interfaces).

Leave this terminal open for the whole event. Press **Ctrl+C** to stop it cleanly.

---

## 5. Open the pages

| Page | Open it on… | URL |
|------|-------------|-----|
| **Admin** (operator controls) | the laptop itself | `http://localhost:8080/` |
| **Display** (projector screen) | the laptop / screen browser | `http://localhost:8080/display` |
| **Buzzer** (one per team tablet) | each team tablet's browser | `http://<host-ip>:8080/play` |

Example for the buzzer with the IP from step 3b: `http://192.168.8.10:8080/play`.

---

## 6. Verify everything works

Run these checks **before teams arrive**. Each one isolates a different layer.

### 6a. Host is up (on the laptop)

In a browser on the laptop, open:

```
http://localhost:8080/health
```

Expected response: `{"ok":true}`. If you get this, the server and build are fine.

### 6b. Tablets can reach the host (the critical cross-device check)

On **one team tablet** (connected to the contest Wi-Fi), open:

```
http://<host-ip>:8080/health
```

- **`{"ok":true}`** → router path + firewall are correct; `/play` will work. ✅
- **Times out / can't connect** → almost always (1) the firewall rule (step 3c),
  (2) the tablet is on a different SSID, or (3) the wrong IP. See
  [Troubleshooting](#troubleshooting).

This single check is the fastest way to confirm the whole network path end-to-end.

### 6c. Core fairness guarantee (automated, no network needed)

This proves the "earliest press wins regardless of packet arrival order" logic:

```powershell
npm run test:fairness
```

Exit code `0` and passing assertions = the game authority is sound.

### 6d. Full WebSocket smoke test (optional, end-to-end)

This boots the real server and drives two tablets buzzing in reverse order. Use an
**in-memory DB** so it doesn't touch your contest database. Open **two terminals**:

Terminal 1 — start a throwaway server on port 8099:

```powershell
$env:PORT = "8099"; $env:BUZZER_DB = ":memory:"; npm run serve
```

Terminal 2 — run the smoke test against it:

```powershell
$env:PORT = "8099"; npm run test:smoke
```

It exercises hello/role routing, opening a question, two tablets buzzing in reverse
arrival order, correct winner selection, and admin-gating. Stop Terminal 1 with
**Ctrl+C** when done. (Your real `npm run serve` on `8080` is unaffected.)

### 6e. Live end-to-end dry run

With the real host running (step 4):

1. On the laptop, open **Admin** (`/`) and click **New question**.
2. On a tablet at `/play`, press the buzzer — the winner should appear on the
   Admin and **Display** pages.
3. Click **Reset** on Admin to clear for the next round.

If all of 6a–6e pass, you're ready for the event.

---

## 7. Running it again later

Once installed, each subsequent session is just:

```powershell
cd path\to\buzz-master-app
npm run serve
```

- Re-run `npm run build` **only** if the client code changed.
- Re-run `npm install` **only** if dependencies changed.
- The SQLite DB auto-creates at `server\buzzer.db` on first boot and reseeds the
  4 default teams if absent. The firewall rule from step 3c persists across reboots.

---

## 8. Optional configuration

Set these in PowerShell **before** `npm run serve` if needed:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP + WebSocket port. If you change it, open *that* port in the firewall and use it in every URL. |
| `BUZZER_DB` | `server\buzzer.db` | SQLite file. Use `:memory:` for an ephemeral DB (testing). |
| `CLIENT_DIST` | `.\dist` | Directory of the built client to serve. |
| `UPLOADS_DIR` | `server\uploads` | Operator-uploaded banners, served at `/assets/uploads/`. |

Example — run on port 9000:

```powershell
$env:PORT = "9000"; npm run serve
# then use http://localhost:9000/ and http://<host-ip>:9000/play
# and open port 9000 in the firewall instead of 8080
```

> The **settling window** is not an env var — it defaults to 50 ms and is tuned at
> runtime from the Admin page (stored in the `settings` table).

---

## Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| Tablet `/health` or `/play` times out | **Firewall** — re-run step 3c as Administrator. Confirm the network is **Private** (step 3a). |
| Tablet loads nothing, laptop works | Tablet is on a **different Wi-Fi** than the laptop, or you used the wrong `<host-ip>`. Re-check `ipconfig`. |
| Pages show **503 "Client build not found"** | You skipped `npm run build`. Run it, then `npm run serve`. |
| `npm install` fails compiling `better-sqlite3` | Re-run the Node `.msi` and tick **"Automatically install the necessary tools"** (installs Python + VS Build Tools), then `npm install` again. |
| Port `8080` already in use | Another process owns it. Use a different port: `$env:PORT="8081"; npm run serve` (and open 8081 in the firewall). |
| IP changes between sessions | Reserve a static DHCP lease for the laptop on the contest router. |

---

For architecture, the protocol, and game internals, see **`README.md`** and
**`DESIGN.md`**.
