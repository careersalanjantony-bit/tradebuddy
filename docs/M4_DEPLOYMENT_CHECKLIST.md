# Milestone 4 — production deployment checklist

For deploying cloud alerts (PR #4, branch `feature/firebase-push-m4`) to the AWS server. **Prepared, not
executed.** Do every step in order; stop and roll back (step 14) if a check fails.

Assumptions: Ubuntu 24.04 on EC2 (t3.small, Mumbai), Node 24, code in `/opt/tradebuddy`, service
`tradebuddy-server`, database `/var/lib/tradebuddy/tradebuddy.db` (systemd `StateDirectory`), settings in
`/etc/tradebuddy/server.env`. Firebase project `tradebuddy-cc8d0`. On your own Ubuntu computer: the repo
in `~/tradebuddy` with `android/app/google-services.json`, and the Firebase service-account key (below
called `~/secrets/tradebuddy-firebase-key.json` — use your real path).

**Release candidates.** `m4-fcm-rc1` (app 1.20.2) is what the server runs. Its APK could not finish pairing
on a real phone (the button stayed on "Pairing…"; see "New in 1.21.0" in the README). `m4-fcm-rc2`
(app 1.21.0, versionCode 12100) fixes that in the phone app only: `git diff --stat m4-fcm-rc1 m4-fcm-rc2 -- server`
shows nothing, so **a server already running `m4-fcm-rc1` stays as it is** — only the APK (step 10) is new.
A fresh server deployment may use either tag. Neither tag ever moves.

Never paste a key or token into a chat, a ticket or Git. The commands below read secrets into shell
variables or files; none prints them.

---

## 1. Fresh SQLite backup on AWS

```bash
ssh -i ~/.ssh/<your-ec2-key>.pem ubuntu@<EC2-ADDRESS>
cd /opt/tradebuddy && git rev-parse HEAD | tee ~/m3-commit.txt      # the commit running now (for rollback)
sudo systemctl stop tradebuddy-server                               # a clean stop writes everything to the file
sudo ls -la /var/lib/tradebuddy/                                     # after a clean stop: no -wal / -shm file left
STAMP=$(date +%Y%m%d-%H%M)
sudo mkdir -p /var/backups/tradebuddy && sudo chmod 700 /var/backups/tradebuddy
sudo cp -a /var/lib/tradebuddy "/var/backups/tradebuddy/state-m3-$STAMP"   # the whole folder (db + -wal/-shm if any)
sudo sha256sum /var/lib/tradebuddy/tradebuddy.db "/var/backups/tradebuddy/state-m3-$STAMP/tradebuddy.db"   # both lines must match
```

Keep the existing older backups (`/var/lib/tradebuddy.bak-m2` etc.) as they are. Optional extra copy off
the server: `scp` the backup folder to your computer (it holds no keys — the keys live in
`/etc/tradebuddy`).

The service stays stopped through steps 2–8 (signals and alerts pause for those minutes).

## 2. Memory and disk

```bash
free -h                                   # t3.small has 2 GB; want ≥ 600 MB available (the unit caps the server at 1 GB)
df -h / /var/lib/tradebuddy /opt          # want ≥ 2 GB free on / (npm ci + build) and ≥ 2× the database size
sudo du -sh /var/lib/tradebuddy /var/backups/tradebuddy
```

If memory is short: no other heavy process should run; a 1 GB swap file helps `npm ci` on a t3.small.

## 3. Copy the Firebase service-account key to AWS (from your Ubuntu computer)

```bash
# on your computer
chmod 600 ~/secrets/tradebuddy-firebase-key.json
scp -i ~/.ssh/<your-ec2-key>.pem ~/secrets/tradebuddy-firebase-key.json ubuntu@<EC2-ADDRESS>:/home/ubuntu/firebase-key.json
```

```bash
# on the server
sudo install -d -m 750 -o root -g tradebuddy /etc/tradebuddy
sudo install -m 640 -o root -g tradebuddy /home/ubuntu/firebase-key.json /etc/tradebuddy/firebase-service-account.json
shred -u /home/ubuntu/firebase-key.json
sudo ls -l /etc/tradebuddy/                    # -rw-r----- root tradebuddy firebase-service-account.json
sudo -u tradebuddy test -r /etc/tradebuddy/firebase-service-account.json && echo readable-by-service
sudo python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['type'], d['project_id'])" /etc/tradebuddy/firebase-service-account.json   # prints only: service_account tradebuddy-cc8d0
```

Never put the key in `/opt/tradebuddy` (the Git checkout) or in `server.env` itself.

## 4. Firebase settings

```bash
sudo cp -a /etc/tradebuddy/server.env /etc/tradebuddy/server.env.bak-m3
echo 'FIREBASE_SERVICE_ACCOUNT_FILE=/etc/tradebuddy/firebase-service-account.json' | sudo tee -a /etc/tradebuddy/server.env
sudo grep -c '^FIREBASE_SERVICE_ACCOUNT_FILE=' /etc/tradebuddy/server.env   # exactly 1
sudo grep -E '^(TB_HOST|TB_PORT|TB_JOBS)=' /etc/tradebuddy/server.env        # TB_HOST=127.0.0.1, TB_PORT=8787, TB_JOBS=on
```

`TB_API_TOKEN` and `UPSTOX_ANALYTICS_TOKEN` stay as they are (server only, never in the app).

## 5. HTTPS endpoint (Caddy)

The app pairs only over `https://` (plain http is refused). You need a DNS name pointing at the EC2
Elastic IP — your own (sub)domain, or a free dynamic-DNS name. (Alternative without a public endpoint:
Tailscale with `tailscale serve`; see `docs/FIREBASE_SETUP.md` step 6.)

1. EC2 → Elastic IPs: the instance has one (the address never changes).
2. DNS: an **A record** `tb.<your-domain>` → that Elastic IP. Check: `dig +short tb.<your-domain>`.
3. Security group: inbound **443** and **80** from anywhere; **22** only from your IP; **no 8787**.
4. Install and configure Caddy:

   ```bash
   sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt-get update && sudo apt-get install -y caddy
   sudo cp /opt/tradebuddy/server/deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo sed -i 's/tradebuddy.example.com/tb.<your-domain>/' /etc/caddy/Caddyfile
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```

   (Caddy is already the recommendation in `server/deploy/Caddyfile.example`; it sets
   `X-Forwarded-For` itself, which the server's rate limits use only for connections from 127.0.0.1.)

## 6. Port 8787 stays on localhost

```bash
sudo ss -tlnp | grep 8787        # after the start in step 8: 127.0.0.1:8787 only — never 0.0.0.0 or [::]
curl -m 5 http://<EC2-ADDRESS>:8787/healthz || echo "not reachable from outside: good"   # run from your computer
```

## 7. Deploy the reviewed commit

Deploy the frozen release candidate: the annotated tag `m4-fcm-rc1`. It never moves (the PR head
may); the final review report gives the commit it points at. (Already deployed? Do not redeploy for
`m4-fcm-rc2`: its server code is the same — see "Release candidates" at the top.)

```bash
cd /opt/tradebuddy
sudo git fetch origin --tags
sudo git checkout --detach m4-fcm-rc1
git rev-parse HEAD                                 # must equal the commit in the review report
sudo npm ci
sudo npm run server:typecheck && sudo npm run server:test && sudo npm run server:build
```

All server tests must pass on the server too (they include the schema 2 → 3 migration tests).

## 8. Start: the schema migration runs by itself

```bash
sudo systemctl start tradebuddy-server
journalctl -u tradebuddy-server -n 60 --no-pager    # look for: "Push notifications on (Firebase project tradebuddy-cc8d0)"
```

The migration adds three empty tables (`devices`, `pairing_codes`, `push_outbox`) in one transaction and
changes nothing else (tested in `server/tests/migration.test.ts`). If it fails it rolls back completely and
the service stops with the error in the journal — then go to step 14.

```bash
TOKEN=$(sudo sed -n 's/^TB_API_TOKEN=//p' /etc/tradebuddy/server.env)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/health | head -c 800; echo
sudo python3 - <<'EOF'
import sqlite3; db = sqlite3.connect('file:/var/lib/tradebuddy/tradebuddy.db?mode=ro', uri=True)
print('schema', db.execute('select version from schema_version').fetchone()[0])
for t in ('kv', 'idb_rows', 'alarms', 'devices', 'push_outbox'): print(t, db.execute(f'select count(*) from {t}').fetchone()[0])
EOF
```

Expect schema 3, the same `kv` / `idb_rows` counts as before (compare with the backup if unsure), and 0 devices.

## 9. Service and API health

```bash
systemctl status tradebuddy-server --no-pager      # active (running)
curl -s http://127.0.0.1:8787/readyz               # 200 / ready
curl -s https://tb.<your-domain>/healthz           # from your computer: {"status":"ok",…}
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/push   # "configured": true, "projectId": "tradebuddy-cc8d0"
```

During market hours also check that signals continue (`/v1/health` → feed and jobs, `/v1/events`).

## 10. Build and install the Firebase-enabled APK

Use the APK of **`m4-fcm-rc2`** (app 1.21.0, versionCode 12100), not the one of `m4-fcm-rc1`. Easiest
without a computer of your own: the "Build signed APK" workflow in the private `tradebuddy-keys`
repository (its README, section "Signed build on GitHub"). Or on your Ubuntu computer (replace
`m4-fcm-rc1` with `m4-fcm-rc2` below):

```bash
cd ~/tradebuddy && git fetch origin --tags && git checkout --detach m4-fcm-rc1   # the same commit as the server
ls -l android/app/google-services.json             # present (never committed — .gitignore blocks it)
grep -c '"package_name": "in.tradebuddy.app"' android/app/google-services.json   # 1
npm ci
TRADEBUDDY_KEYS=~/tradebuddy-keys node scripts/build-apk.mjs   # prints "Firebase: on (google-services.json found)"; signs with your keys
```

Checks before installing:

```bash
APK=release/TradeBuddy-$(node -p "require('./package.json').version").apk
$ANDROID_HOME/build-tools/*/aapt2 dump resources "$APK" | grep -c google_app_id        # ≥ 1: Firebase is in the app
unzip -l "$APK" | grep -i -E 'service.?account|adminsdk|private_key' || echo "no server key inside: good"
```

Install over the current app (same signing key, data kept): `adb install -r "$APK"`, or copy the file
to the phone and open it. Do **not** uninstall first (that deletes practice trades and settings). RC2 is
versionName 1.21.0, versionCode 12100 — higher than the published 1.20.2 and than RC1 (both 12002), so
Android installs it as an update and keeps your data. After installing, the bottom of the Me screen says "TradeBuddy 1.21.0". (If a
newer app version has been published since, Android refuses an older one: a new release candidate is
needed — merge `main` into this branch and tag it again, e.g. `m4-fcm-rc3`.)

## 11. Pair the phone

```bash
# on the server
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/pairing-code
```

On the phone: Settings → Cloud alerts → `https://tb.<your-domain>`, a **new** code (each works once, 10
minutes), a name you have not used yet (e.g. `Alan RC2`, so it is easy to tell apart) → **Pair this
phone** → allow notifications. The pairing form must disappear within a few seconds (with 1.21.0 it never
waits forever: on a problem it shows the reason and the button comes back). The card should turn **✅ On** within a few seconds
(the server confirms it makes signals, can push and has the phone's token). Outside market hours or
without an Upstox token on the server it says "not confirmed" and the phone keeps alerting by itself —
that is by design.

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices    # tokenState "active", tokenHint "…xxxxxx"
```

## 12. Test push

In the app: **Send a test push** (one per 30 seconds), or from the server:

```bash
DEV=<device id from /v1/devices>
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/$DEV/test-push
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/push        # outbox: sent 1
```

## 13. App closed, phone locked

1. Recent apps → swipe TradeBuddy away (not **Force stop**, which blocks pushes until the app is opened).
2. Lock the phone; wait a minute.
3. Send the test push from the server (step 12).
4. Expected within about a minute: the notification on the lock screen. Tap it → unlock → the app opens on
   the alert's details.
5. Xiaomi / Realme / Oppo / Vivo / Samsung: if nothing arrives, allow Autostart and "No battery
   restrictions" for TradeBuddy and repeat.

Delivery is best effort (Google and the phone's battery saver decide). Do not rely on cloud alerts alone.

## 15. Remove the half-paired registrations (only after step 11–12 worked with 1.21.0)

Each attempt with the RC1 APK left a registration on the server that the phone never kept (the server
said 201, the phone hung before saving). They can never receive a push (`tokenState: "none"`), and their
credentials exist nowhere — but remove them so the list shows only real phones. Use the server's own
admin API (it marks the row revoked; nothing is deleted from the database by hand, no restart).

```bash
TOKEN=$(sudo sed -n 's/^TB_API_TOKEN=//p' /etc/tradebuddy/server.env)
# 1. look: every phone with its id, name, app version, token state and whether it is already revoked
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices \
  | python3 -c 'import json,sys; [print(d["id"], repr(d["name"]), d.get("appVersion"), d["tokenState"], "revoked" if d.get("revokedAt") else "active") for d in json.load(sys.stdin)["devices"]]'
```

Pick the ids by hand. Remove a row only when **all** of these are true: name `Alan` or `My phone` (the two
RC1 attempts), app version `1.20.2`, token state `none`, not revoked. **Never** the row of the phone just
paired with 1.21.0 (app version `1.21.0`, token state `active`).

```bash
# 2. remove one at a time (repeat for the second id)
ID=<id from the list>
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/$ID   # {"revoked":true}
# 3. check: the two old rows say "revoked", the 1.21.0 phone is still "active" with token state "active"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices \
  | python3 -c 'import json,sys; [print(d["id"], repr(d["name"]), d.get("appVersion"), d["tokenState"], "revoked" if d.get("revokedAt") else "active") for d in json.load(sys.stdin)["devices"]]'
```

A second `DELETE` of the same id answers 404 "No such active phone" — harmless. Revoking cannot be undone,
but nothing is lost: a phone is simply paired again with a new code. Then send one more test push (step 12)
to be sure the real phone still gets it.

## 14. Rollback (if anything above fails)

```bash
sudo systemctl stop tradebuddy-server
cd /opt/tradebuddy && sudo git checkout --detach "$(cat ~/m3-commit.txt)"
sudo npm ci && sudo npm run server:build
B=$(ls -d /var/backups/tradebuddy/state-m3-* | tail -1)
sudo rm -f /var/lib/tradebuddy/tradebuddy.db-wal /var/lib/tradebuddy/tradebuddy.db-shm
sudo cp -a "$B/." /var/lib/tradebuddy/                    # the schema 2 database exactly as before
sudo chown -R tradebuddy:tradebuddy /var/lib/tradebuddy
sudo cp -a /etc/tradebuddy/server.env.bak-m3 /etc/tradebuddy/server.env   # (the Firebase line is harmless, but this restores it exactly)
sudo systemctl start tradebuddy-server && journalctl -u tradebuddy-server -n 40 --no-pager
curl -s http://127.0.0.1:8787/readyz
```

A milestone 3 build refuses a schema 3 database ("newer than this server"), so restoring the backup is
required — it cannot damage it. Alerts made between the update and the rollback stay only in the schema 3
copy (keep it before restoring, if you want them: `sudo cp -a /var/lib/tradebuddy /var/backups/tradebuddy/state-m4-failed-$(date +%Y%m%d-%H%M)`). The phone: Settings → Cloud alerts → Unpair (or just leave it — while the
server does not confirm, the phone alerts by itself).
