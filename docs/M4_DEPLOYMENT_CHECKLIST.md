# Milestone 4 — production deployment checklist

For deploying cloud alerts (PR #4, branch `feature/firebase-push-m4`) to the AWS server. **Prepared, not
executed.** Do every step in order; stop and roll back (step 14) if a check fails.

Assumptions: Ubuntu 24.04 on EC2 (t3.small, Mumbai), Node 24, code in `/opt/tradebuddy`, service
`tradebuddy-server`, database `/var/lib/tradebuddy/tradebuddy.db` (systemd `StateDirectory`), settings in
`/etc/tradebuddy/server.env`. Firebase project `tradebuddy-cc8d0`. On your own Ubuntu computer: the repo
in `~/tradebuddy` with `android/app/google-services.json`, and the Firebase service-account key (below
called `~/secrets/tradebuddy-firebase-key.json` — use your real path).

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

Use the exact head commit of PR #4 (shown on the PR page; it is printed in the final review report).

```bash
cd /opt/tradebuddy
sudo git fetch origin
sudo git checkout --detach <REVIEWED-COMMIT>
git log -1 --oneline                               # must show the reviewed commit
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

## 10. Build and install the Firebase-enabled APK (on your Ubuntu computer)

```bash
cd ~/tradebuddy && git fetch origin && git checkout --detach <REVIEWED-COMMIT>
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
to the phone and open it. (This APK is built from the M4 branch, i.e. app 1.20.0 plus cloud alerts — the
same version number as the published 1.20.0, so Android installs it over that one. If a newer app version
has been published since, merge `app-v1` into this branch first: Android refuses an older version.)

## 11. Pair the phone

```bash
# on the server
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/devices/pairing-code
```

On the phone: Settings → Cloud alerts → `https://tb.<your-domain>`, the code (works once, 10 minutes),
a name → **Pair this phone** → allow notifications. The card should turn **✅ On** within a few seconds
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
