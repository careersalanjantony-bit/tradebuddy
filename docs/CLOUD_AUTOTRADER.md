# Cloud auto-trader (app 1.22) — design, safety and the one-time cutover

The auto-trader (pretend money, paper trading only) can run on your own TradeBuddy server: it then opens,
manages and closes its practice trades every market minute **with the app closed or the phone off**, and
every paired phone shows the server's state and sends your controls to it. **Nothing in TradeBuddy ever
places, changes or cancels an order at Upstox** — the server only reads market data with the Analytics
Token.

Status: **implemented and tested; not deployed, not enabled.** Production stays exactly as it is until you
follow section 6 yourself.

---

## 1. One auto-trader, one writer

| Where | State | What runs the auto-trader |
| --- | --- | --- |
| Server | `standby` (after the update, before the move) | **nothing on the server.** Its own old copy (the one the milestone 4 server made by itself) is kept untouched and frozen. |
| Server | `cloud` (after the move) | the server — the app's own `runBot()`, unchanged, from the same price polls, every market minute |
| Phone | no `botCloud` (default) | the phone, as before |
| Phone | `botCloud.mode = 'pending'` (during the move) | **nothing** — stopped so it cannot change while it is sent |
| Phone | `botCloud.mode = 'cloud'` | **nothing on the phone** — it shows the server's copy and sends controls |

How it is enforced:

* `setBotGate()` in `src/background/botJobs.ts`: `runBot()` and every change (`botSetEnabled`,
  `botSetAmount`, `botSetRules`, `botReset`) first ask the gate. On the phone the gate is installed before
  anything else starts (`src/background/index.ts`) and says "no" while `botCloud` exists — on price polls,
  resume, retries, market open, offline. On the server the gate says "yes" only in `cloud` mode
  (`server/src/bot/cloudBot.ts`).
* All runs and changes go through one queue (`withBotLock`), so two price updates, a feed tick and a retry
  at the same moment can never open the same trade twice (tested with five runs at once).
* After the move the phone keeps **no** second auto-trader: its own copy goes to `botArchive` (last 5
  kept) and `bot` becomes empty. Moving back puts the server's full state into `bot` and the server goes to
  `standby` — again one writer.
* The server never merges two auto-traders. If both the phone and the server have their own history, the
  owner chooses one (section 4); the other is kept as a backup.

Fail-safe: during market hours, if the newest price is older than 2 minutes (Upstox token refused, feed
quiet, server cut off) the auto-trader opens **nothing new** and says so ("Prices are not up to date…");
open trades are only changed on fresh prices (as before). The server's health turns `degraded`, and after
one minute one push goes to the phones ("⚠️ Auto-trader on the server is not trading"), and one more when it
recovers. A Firebase test push does **not** prove the market feed works — the health report shows the real
price age.

## 2. Security model (one user, one server)

* The server belongs to one person. Every phone paired with it (with a one-time code from the server's
  admin) is that person's phone.
* **Reading:** every paired phone may read the auto-trader (`GET /v1/bot`), with its own device credential
  from the Android Keystore. Nothing about the auto-trader is public: without a credential every `/v1/bot`
  address answers 401.
* **Changing:** only **one** phone — the one that did the move, or the one the owner names with the admin
  token — may change it. Other phones are read-only (403 `not_controller`); the screen says "Controlled from
  …".
* **The admin token (`TB_API_TOKEN`) never goes on a phone.** It is only used on the server (curl to
  127.0.0.1) for: status, emergency stop, naming the controlling phone, backups and restore.
* Every change is written to `bot_audit` (time, phone, action, request id, versions before/after, result).
  A request repeated with the same request id is answered from there and never done twice.
* "Start again" must carry the version the phone looked at (`ifRev`); if a trade happened since, it is
  refused (409) and the phone shows the new state first.
* No cookies and no CORS headers. Bodies must be JSON (`Content-Type: application/json`, else 415), so a
  web page cannot post to the server. Limits: 60 reads, 20 controls per phone per minute; 6 moves per hour;
  wrong credentials lock the address out for 10 minutes (as before).

## 3. API

Phone (its own `Bearer tbd.…` credential):

| Request | What it does |
| --- | --- |
| `GET /v1/bot[?have=<rev>:<updatedAt>]` | the server's auto-trader for the screen: who runs it, `you.canControl`, version, the state (trimmed: all open trades, the last 60 finished, today's + the last 120 fills, the last 60 log lines; brain, rules and equity in full — left out when `have` is current), money totals worked out by the server with its prices, the server's prices of the open trades, health (`telemetry`), the protection's past test |
| `GET /v1/bot/preflight` | before the move: the server's copy (summary + SHA-256 digest), whether it can run it (`ready`, `problems`, `warnings`), recent backups |
| `POST /v1/bot/cutover` | the move: `{requestId, choice: import \| keep-server \| fresh, serverId, expectServerDigest, phone, phoneDigest, fresh?}` — up to 4 MB, one SQLite transaction |
| `POST /v1/bot/commands` | `{requestId, command, ifRev?}` — `enable`, `amount`, `rules`, `reset` (needs `ifRev`), `protect-test` |
| `POST /v1/bot/release` | `{requestId}` — back to this phone: the server goes on standby and answers with the **full** state |
| `GET /v1/bot/audit` | who changed what |

Owner (admin token, on the server):

| Request | What it does |
| --- | --- |
| `GET /v1/bot/admin` | everything: who runs it, health, the gate, summary, phones, backups, audit |
| `GET /v1/bot/admin/preflight` | the same preview a phone gets — **the read-only dry run on production** |
| `POST /v1/bot/admin/standby` | emergency stop `{"reason": "…"}` (pushes one alert) |
| `POST /v1/bot/admin/resume` | start it again `{"controllerId": "<device id>"}` |
| `POST /v1/bot/admin/controller` | `{"deviceId": "…"}` — which phone may change it (new or lost phone) |
| `GET /v1/bot/admin/backups/{id}` | one backup in full |
| `POST /v1/bot/admin/restore` | `{"backupId": n}` — only on standby; the current state is backed up first |

`GET /healthz` now also says `botApi: 1` (this contract's version); `GET /v1/health` has an `autoTrader`
block. The phone refuses a server that speaks an older contract ("update the server first").

## 4. The move (cutover) — what happens, exactly

1. The phone asks for the preview and shows the phone's and the server's auto-traders side by side (money,
   open and finished trades, learning, last trade) and the advice:
   * only the phone has history → **move the phone's** (recommended);
   * only the server has history → **keep the server's**;
   * both have their own history → **you choose one** (move the phone's / keep the server's / start fresh) —
     never a merge;
   * neither → start on the server.
2. You tick "I understand…" and tap **Move it now**. The phone, inside the bot's queue: checks its
   auto-trader has not traded since the preview, keeps a copy (`botArchive`), and **stops** its own
   auto-trader (`pending`).
3. It sends the move with a request id. The server, in one SQLite transaction: backs up its own copy and
   the phone's copy (`bot_backups`), writes the chosen state, sets `cloud` with this phone as controller,
   writes the audit line. The digests from the preview must still match (otherwise 409 "look again").
4. The phone clears its own `bot`, shows the server's copy and asks the server for auto-trader alerts.
5. If the answer is lost, the phone stays stopped and **Try again** sends the same request: the server
   answers from its record. **Cancel** first asks the server: if it took it, the move is finished; only a
   clear "it did not" lets the phone's auto-trader run again. Offline → it stays stopped (never two).

The server's first run after the move replays today's 5-minute candles for open trades since the phone's
last run (the app's existing catch-up) and marks the gap.

## 5. Tests and the dry run

* `server/tests/cloudBot.test.ts` — a real server (SQLite on disk, HTTP) through a **synthetic market day**
  with the app's real `runBot()`: standby changes nothing; auth / JSON / size limits; the preview and a
  conflicting server copy; stale preview / other server / changed phone copy refused; the move (atomic,
  both backups); the same move repeated (answered from the record); a trade opened with every phone
  closed and pushed only to the phone that wants it; two phones see the same state; five simultaneous runs
  open it once; a win (target, learning, push); stale prices (no trade, degraded, one alert); recovery and
  a loss (safety net); a server restart (owner, version and trades kept); controls only from the
  controlling phone, repeated requests done once, pause = no new trades; start-again needs the version;
  rate limits; the 3:10 pm exit; moving back (full state, standby, repeat-safe); the admin controls and a
  restore; no request to any order or GTT address.
* `tests/cloudBotPhone.test.ts` — the phone against the server's real `CloudBot`, through a stand-in
  network that can lose answers: the move, lost answers, clear refusals, cancel, refresh with `have`,
  offline copies, another server, controls, viewer, moving back, the emergency path.
* `tests/cloudBotContract.test.ts` — digests, the comparison, the state and control checks, the gate,
  versions, stale prices, run reports.
* `scripts/app-smoke.mjs` — the screen in cloud mode (server totals, locked controls for a viewer, the
  phone does not run a copy).
* **Dry run, here:** `npm run bot:dryrun` (the three test files above, verbose).
* **Dry run on production, read only:** after deploying (section 6, step 3), on the server:

  ```bash
  TOKEN=$(sudo sed -n 's/^TB_API_TOKEN=//p' /etc/tradebuddy/server.env)
  curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/bot/admin/preflight | python3 -m json.tool
  ```

  It changes nothing; it shows `authority.mode: "standby"`, the server's own old copy (`server`), whether the
  server could run it (`ready`, `problems`) and the price age.

## 6. Cutover runbook (do it yourself, in this order)

**Before:** both pull requests reviewed and merged as you decide; a release tag (e.g. `m5-cloudbot-rc1`) on
the reviewed commit; the signed APK 1.22.0 built from **the same tag** (the server and the app must speak the
same contract). Do the move outside market hours (evening or weekend).

1. **Backup the server (WAL-safe).**

   ```bash
   cd /opt/tradebuddy && git rev-parse HEAD | tee ~/m4-commit.txt
   sudo systemctl stop tradebuddy-server                    # a clean stop checkpoints the WAL into the .db file
   STAMP=$(date +%Y%m%d-%H%M)
   sudo mkdir -p /var/backups/tradebuddy && sudo chmod 700 /var/backups/tradebuddy
   sudo cp -a /var/lib/tradebuddy "/var/backups/tradebuddy/state-m4-$STAMP"
   sudo python3 -c "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(c.execute('pragma integrity_check').fetchone()[0], c.execute('select version from schema_version').fetchone()[0])" "/var/backups/tradebuddy/state-m4-$STAMP/tradebuddy.db"   # ok 3
   ```

2. **Deploy the tag** (`sudo git fetch --tags && sudo git checkout --detach m5-cloudbot-rc1`, `sudo npm ci`,
   `sudo npm run server:typecheck && sudo npm run server:test && sudo npm run server:build`), then
   `sudo systemctl start tradebuddy-server`. The database goes to schema 4 by itself (three new tables;
   nothing existing changes — tested). The server is on **standby**: it does not trade.
3. **Check:** `curl -s http://127.0.0.1:8787/healthz` → `"botApi":1`; the read-only preflight above →
   `"mode":"standby"`, `"ready":true`. Phones on 1.21.0 keep working as before (they do not use `/v1/bot`).
4. **Update the phone** to 1.22.0 over 1.21.0 (data kept; never uninstall). Optionally **Auto-trader →
   Compare and move… → Copy a backup too** and keep that text somewhere safe.
5. **Preview on the phone:** Auto-trader → *Let it trade with the app closed* → **Compare and move to my
   server…**. Read both columns and the advice. If both have history, choose deliberately.
6. **Move:** tick "I understand", **Move it now**. The screen shows **Runs on your server**.
7. **Verify on the server:**
   `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/bot/admin | python3 -m json.tool | head -60`
   → `authority.mode: "cloud"`, `controller` = your phone, two new backups, one `cutover:…` audit line.
8. **Next market morning:** `telemetry.health` becomes `ok` after 9:15 with `runsLast10Min` ≈ 20 and a
   `priceAgeSec` of a few seconds. Close the app, lock the phone; trades appear later on the screen exactly as
   the server made them, and auto-trader pushes arrive (best effort).

**Other phones** update to 1.22.0 and tap **Show the server's auto-trader here** (read only). A phone left on
1.21.0 keeps running its own separate practice auto-trader — update it.

## 7. Undo and recovery

* **Back to the phone** (normal way): Auto-trader → **Run it on this phone again**. The server hands over its
  full state and goes on standby.
* **Emergency stop on the server:** `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"reason":"…"}' http://127.0.0.1:8787/v1/bot/admin/standby`.
  Start again with `/v1/bot/admin/resume` (`{"controllerId":"<device id>"}`) — or, on the controlling phone,
  **Run it on this phone again** takes the stopped server's latest state to the phone.
* **Restore an earlier state** (on standby only): `GET /v1/bot/admin` lists backups; `POST
  /v1/bot/admin/restore {"backupId": n}` (the current state is backed up first).
* **New or lost phone:** pair the new one, then `POST /v1/bot/admin/controller {"deviceId": "<new id>"}`;
  revoke the lost one with `DELETE /v1/devices/<id>`.
* **Server unreachable and you need the phone to take over:** the move back asks the server; if it cannot be
  reached, the screen offers **Take it back, paused** — only if the server is really off (otherwise the
  server may still be trading its copy). Unpairing does the move back first.
* **Code rollback to milestone 4:** first move the auto-trader back to the phone (keeps everything made on
  the server), then stop the service, check out the commit in `~/m4-commit.txt`, build, restore the
  `state-m4-…` folder (remove `-wal` / `-shm` first), start. A milestone 4 build refuses the schema 4
  database by design, so the restore is required.

## 8. Releases and the automatic pipeline (private issue #1)

* App **1.22.0** (versionCode **12200**), higher than RC2's 1.21.0. Server and APK are built from **one**
  tag; the contract version (`botApi`, the `api` field) lets the phone refuse a server that is too old.
* Order for every release that touches this contract: **server first** (standby is harmless to older
  phones), APK second. The CI/CD work in issue #1 should keep that order and deploy the server from the same
  commit the APK is built from; it is not implemented here (the auto-trader came first, as asked).
* The frozen tags `m4-fcm-rc1` and `m4-fcm-rc2` are untouched.
