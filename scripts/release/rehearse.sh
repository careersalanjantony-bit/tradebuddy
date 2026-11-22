#!/usr/bin/env bash
# npm run release:rehearse — end-to-end dry run of the TradeBuddy release pipeline. NOTHING real is touched:
# a local copy of GitHub (bare repo), the real server at $TB_PROD_REF (default m5-cloudbot-rc1) running here as "production"
# (cloud auto-trader on, a controlling phone), the real deploy script through the exact Systems Manager
# command list under dash, real npm ci / build / server tests, and the publisher against a local
# copy of the updates branch.
# Run as root (like Systems Manager), "production" first belongs to ANOTHER user, like /opt/tradebuddy on
# EC2: Git refuses such a checkout for root ("detected dubious ownership") — the rehearsal checks that,
# then that the deploy works anyway, never writes the other user's checkout and stores no Git exception.
# Needs: this repository (HEAD = what would be on main), the private tradebuddy-keys checkout next to it
# (or TRADEBUDDY_KEYS=<path>) for its release scripts, Node, npm (network to the npm registry), python3,
# git, dash, curl. Takes a few minutes. See docs/RELEASE_PIPELINE.md.
set -uo pipefail
PUB=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
KEYS=${TRADEBUDDY_KEYS:-$PUB/../tradebuddy-keys}
PROD_REF=${TB_PROD_REF:-m5-cloudbot-rc1}   # what "production" runs at the start (the frozen 1.22.0 tag)
W=${TB_REHEARSAL_DIR:-${TMPDIR:-/tmp}/tb-release-rehearsal}
[ -f "$KEYS/.github/scripts/ssm-deploy.sh" ] || { echo "the tradebuddy-keys checkout was not found at $KEYS (set TRADEBUDDY_KEYS)"; exit 2; }
rm -rf "$W"; mkdir -p "$W"
PASS=0; FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check() { if eval "$1"; then ok "$2"; else bad "$2"; fi; }
TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
PORT=18787

echo "── 1. a local GitHub: main = the pipeline branch, the production tag, the real updates branch"
git clone -q --bare "$PUB" "$W/github.git"
git -C "$W/github.git" update-ref refs/heads/main "$(git -C "$PUB" rev-parse HEAD)"
git -C "$W/github.git" fetch -q https://github.com/careersalanjantony-bit/tradebuddy.git "refs/heads/updates:refs/heads/updates"
git -C "$W/github.git" fetch -q https://github.com/careersalanjantony-bit/tradebuddy.git "refs/tags/$PROD_REF:refs/tags/$PROD_REF"
APP_NOW=$(git -C "$W/github.git" show updates:latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
check '[ -n "$APP_NOW" ]' "the updates branch (copied from GitHub) offers $APP_NOW"

echo "── 2. production stand-in: the server at $PROD_REF, its database, cloud auto-trader on"
P="$W/prod"; mkdir -p "$P/state" "$P/backups" "$P/releases" "$P/logs" "$P/bin" "$P/root"
git clone -q "$W/github.git" "$P/opt-tradebuddy"
git -C "$P/opt-tradebuddy" checkout -q --detach "$PROD_REF"
(cd "$P/opt-tradebuddy" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 && npm run server:build >/dev/null 2>&1) || bad "build the production server"
cat > "$P/server.env" <<EOF
TB_HOST=127.0.0.1
TB_PORT=$PORT
TB_API_TOKEN=$TOKEN
TB_DATA_DIR=$P/state
TB_JOBS=off
TB_LIVE_FEED=off
TB_BACKGROUND_TASKS=off
TB_LOG_LEVEL=warn
EOF
# systemd stand-in: starts / stops the REAL server process
cat > "$P/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
P=${PROD:?}; pidf="$P/server.pid"
case "$1" in
  start)
    [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && exit 0
    ( cd "$TB_APP_DIR" && set -a && . "$P/server.env" && set +a && exec node --disable-warning=ExperimentalWarning server/dist/main.js ) >>"$P/server.log" 2>&1 &
    echo $! > "$pidf"; exit 0 ;;
  stop)
    if [ -f "$pidf" ]; then pid=$(cat "$pidf"); kill -TERM "$pid" 2>/dev/null; for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; rm -f "$pidf"; fi; exit 0 ;;
  is-active) [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null ;;
  *) exit 0 ;;
esac
EOF
printf '#!/bin/sh\ntail -n 40 "$PROD/server.log"\n' > "$P/bin/journalctl"
chmod +x "$P/bin/"*
export PROD="$P" PATH="$P/bin:$PATH" TB_APP_DIR="$P/opt-tradebuddy"
H="Authorization: Bearer $TOKEN"
up() { for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
systemctl start; up || bad "the production server starts"
systemctl stop
# the owner's state: the auto-trader moved to the server (cloud, epoch 1, a controlling phone), with history
python3 - "$P/state/tradebuddy.db" <<'PY'
import json, sqlite3, sys, time
c = sqlite3.connect(sys.argv[1])
now = int(time.time() * 1000)
c.execute("INSERT INTO devices (id, name, platform, app_version, secret_hash, token_state, categories, created_at) VALUES ('dev-alan', 'Alan phone', 'android', '1.22.0', 'x', 'active', '[]', ?)", (now,))
c.execute("UPDATE bot_authority SET mode='cloud', epoch=1, controller_id='dev-alan', activated_at=?, changed_at=? WHERE id=1", (now, now))
bot = {"v": 1, "enabled": True, "createdAt": now - 86400000, "wallet": {"v": 1, "startCash": 100000, "cash": 101200, "createdAt": now - 86400000, "holdings": [], "orders": [], "fills": [{"key": "K", "pnl": 1200}]},
       "brain": {"v": 1, "w": [1, 0], "w0": [1, 0], "n": 1, "wins": 1, "by": {}, "curve": [1]}, "trades": [{"id": "T1", "key": "K", "symbol": "AAA", "side": "long", "status": "closed", "qty": 10, "entry": 100, "stop": 99, "target": 102}],
       "log": [], "day": {"date": "2026-11-20", "opened": 1}, "lastRun": now - 60000, "lastDecideAt": now - 60000, "note": None, "looked": 0, "equity": [], "rev": 42, "updatedAt": now - 60000}
c.execute("INSERT OR REPLACE INTO kv (area, key, value, updated_at) VALUES ('local', 'bot', ?, ?)", (json.dumps(bot), now))
c.commit(); c.close()
PY
systemctl start; up || bad "the production server starts again"
before=$(curl -fsS -H "$H" "http://127.0.0.1:$PORT/v1/bot/admin")
BASE=$(curl -fsS "http://127.0.0.1:$PORT/healthz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
check '[ -n "$BASE" ]' "production stand-in runs $BASE"
check 'printf "%s" "$before" | python3 -c "import json,sys; a=json.load(sys.stdin)[\"authority\"]; assert a[\"mode\"]==\"cloud\" and a[\"epoch\"]==1 and a[\"controller\"][\"deviceId\"]==\"dev-alan\""' "the cloud auto-trader is on, controlled by the phone"

V1=$(python3 -c 'import sys; a,b,c=map(int,sys.argv[1].split(".")); print(f"{a}.{b}.{c+1}")' "$(git -C "$PUB" show HEAD:package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')")
V2=$(python3 -c 'import sys; a,b,c=map(int,sys.argv[1].split(".")); print(f"{a}.{b}.{c+1}")' "$V1")
V0=$(git -C "$PUB" show HEAD:package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
echo "── 3. a feature release: version $V1, notes, a shared-code change → CI passes → the tagger tags it"
D="$W/dev"; git clone -q "$W/github.git" "$D"; git -C "$D" config user.email dev@local; git -C "$D" config user.name dev
git -C "$D" checkout -q main
# the baseline: the tagger's first run tags the current main as v$V0
if ! git -C "$D" rev-parse -q --verify "refs/tags/v$V0" >/dev/null; then
  (cd "$D" && node scripts/release/gate.mjs --tag "$(git rev-parse HEAD)" > "$W/gate0.txt") && git -C "$D" tag -a "v$V0" -m "TradeBuddy $V0" HEAD
fi
check '[ -n "$(git -C "$D" tag -l "v$V0")" ]' "baseline: main is tagged v$V0 (the tagger's first run)"
(cd "$D" && npm version $V1 --no-git-tag-version --ignore-scripts >/dev/null && printf 'Fixed: a small thing (rehearsal).\nNot a guarantee - you place every order yourself.\n' > release-notes/$V1.txt && echo '// release rehearsal $V1' >> src/lib/format.ts && git add -A && git commit -qm "Release $V1 (rehearsal)")
REL=$(git -C "$D" rev-parse HEAD)
(cd "$D" && node scripts/release/gate.mjs > "$W/gate-ci.txt"); check 'grep -q "release=true" "$W/gate-ci.txt"' "CI's release gate accepts $V1"
(cd "$D" && node scripts/release/gate.mjs --tag "$REL" > "$W/gate1.txt") && git -C "$D" tag -a v$V1 -m "TradeBuddy $V1" "$REL"
check 'grep -q "tag=v$V1" "$W/gate1.txt" && grep -q "create=true" "$W/gate1.txt"' "the tagger creates v$V1"
git -C "$D" push -q origin main --tags

echo "── 4. the release workflow's plan job: target, production versions, plan"
T="$W/pub"; git clone -q "$W/github.git" "$T"; git -C "$T" fetch -q --tags origin
printf '{"check_runs":[{"name":"checks","status":"completed","conclusion":"success","app":{"slug":"github-actions"}}]}' > "$W/checks.json"
TB_CHECK_RUNS_FILE="$W/checks.json" GITHUB_OUTPUT= node "$KEYS/.github/scripts/release-target.mjs" --repo-dir "$T" > "$W/target.txt"
check 'grep -q "tag=v$V1" "$W/target.txt" && grep -q "status=ready" "$W/target.txt"' "release target: v$V1, annotated, on main, CI green"
SERVER=$(curl -fsS "http://127.0.0.1:$PORT/healthz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
APP=$(git -C "$T" show origin/updates:latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
(cd "$T" && git checkout -q --detach "$REL" && node scripts/release/plan.mjs --tag v$V1 --server-version "$SERVER" --app-version "$APP" --now "$(python3 -c 'import time; print(int(time.mktime((2026,11,23,19,0,0,0,0,-1))*1000))')" > "$W/plan.json")
cat "$W/plan.json" | python3 -c 'import json,sys; p=json.load(sys.stdin); print("      plan:", p["kind"], p["steps"], "server", p["production"]["server"], "app", p["production"]["app"])'
check 'python3 -c "import json; p=json.load(open(\"$W/plan.json\")); assert p[\"kind\"]==\"coordinated\" and p[\"steps\"]==[\"validate\",\"build-apk\",\"deploy-server\",\"publish-app\"] and not p[\"defer\"]"' "plan: coordinated, in the right order"

echo "── 5. deploy through the exact Systems Manager command (dash), real npm / build / server tests"
if [ "$(id -u)" = 0 ]; then
  # production belongs to another account (the one that set the server up), the deploy runs as root;
  # like EC2, no machine-wide Git configuration (a safe.directory=* there would hide the check)
  export GIT_CONFIG_NOSYSTEM=1
  chown -R 65534:65534 "$P/opt-tradebuddy"
  snap() { find "$1" -printf '%P %U %m %s %T@\n' | sort; }
  snap "$P/opt-tradebuddy" > "$W/prod-before.txt"
  check '! git -C "$P/opt-tradebuddy" rev-parse HEAD >/dev/null 2>"$W/dubious.txt" && grep -q "detected dubious ownership" "$W/dubious.txt"' "as root, plain git refuses production (it belongs to another user, like on EC2)"
else
  echo "      (not root: the other-owner check is skipped — run as root to rehearse what Systems Manager does)"
fi
CMDS=$(bash "$KEYS/.github/scripts/ssm-deploy.sh" --instance i-0abc12345def67890 --tag v$V1 --sha "$REL" --version $V1 --print-only | sed -n 's/^  //p')
check '! printf "%s" "$CMDS" | grep -q -e /opt/tradebuddy -e safe.directory -e "git config"' "the Systems Manager command never uses the production checkout and stores no Git exception"
LOCAL=$(printf '%s' "$CMDS" | sed "s#/opt/tradebuddy#$P/opt-tradebuddy#g; s#/root#$P/root#g; s#https://github.com/careersalanjantony-bit/tradebuddy.git#$W/github.git#g")
export TB_RELEASES_DIR="$P/releases" TB_STATE_DIR="$P/state" TB_DB_FILE="$P/state/tradebuddy.db" TB_BACKUP_DIR="$P/backups" TB_ENV_FILE="$P/server.env" \
  TB_LOCAL_URL="http://127.0.0.1:$PORT" TB_LOCK_FILE="$P/deploy.lock" TB_DEPLOY_LOG_DIR="$P/logs" TB_ORIGIN="$W/github.git" TB_MIN_FREE_MB=100 TB_READY_TIMEOUT=60
start=$SECONDS
env -u SUDO_UID -u SUDO_GID -u SUDO_USER dash -c "$LOCAL" > "$W/deploy1.out" 2>&1; rc=$?
echo "      deploy took $((SECONDS - start)) s (npm ci + server build + server tests on the 'instance')"
grep '^\[deploy\]' "$W/deploy1.out" | sed 's/^/      /'
R1=$(grep '^TB_DEPLOY_RESULT ' "$W/deploy1.out" | tail -1 | cut -c18-)
check '[ $rc = 0 ] && printf "%s" "$R1" | python3 -c "import json,sys; r=json.load(sys.stdin); assert r[\"ok\"] and r[\"outcome\"]==\"deployed\""' "deployed $V1"
after=$(curl -fsS -H "$H" "http://127.0.0.1:$PORT/v1/bot/admin")
check '[ "$(curl -fsS http://127.0.0.1:$PORT/healthz | python3 -c "import json,sys; h=json.load(sys.stdin); print(h[\"version\"], h[\"commit\"])")" = "$V1 $REL" ]' "/healthz: version $V1 and the release commit"
check 'python3 -c "import json,sys; b=json.loads(sys.argv[1]); a=json.loads(sys.argv[2]); assert b[\"authority\"]==a[\"authority\"] and a[\"server\"][\"rev\"]>=b[\"server\"][\"rev\"] and a[\"server\"][\"digest\"]==b[\"server\"][\"digest\"]" "$before" "$after"' "the cloud auto-trader: same owner, same epoch, same state (digest)"
BK=$(printf '%s' "$R1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backup"])')
check 'python3 -c "import sqlite3,sys; c=sqlite3.connect(\"file:\"+sys.argv[1]+\"?mode=ro\",uri=True); assert c.execute(\"pragma integrity_check\").fetchone()[0]==\"ok\" and c.execute(\"select version from schema_version\").fetchone()[0]==4 and c.execute(\"select count(*) from kv where key=\x27bot\x27\").fetchone()[0]==1" "$BK/tradebuddy.db"' "backup: integrity ok, schema 4, the auto-trader inside"
check '! grep -q "$TOKEN" "$W/deploy1.out" "$P"/logs/*' "the admin token appears in no output and no log"
if [ "$(id -u)" = 0 ]; then
  PREVDIR=$(ls -1d "$P"/releases/prev-* | head -1)
  check '[ "$(stat -c %u "$P/opt-tradebuddy")" = 0 ] && [ "$(stat -c %u "$PREVDIR")" = 65534 ] && [ "$(snap "$PREVDIR")" = "$(cat "$W/prod-before.txt")" ]' "the new release belongs to root; the other user's checkout (kept for a rollback) is unchanged, byte for byte"
  check '[ ! -e "$P/root/.gitconfig" ] && [ ! -e /etc/gitconfig -o -z "$(git config --system --get-all safe.directory 2>/dev/null)" ] && [ -z "$(ls -A "$P/root")" ]' "no Git exception stored anywhere; the temporary repository is gone"
fi
env -u SUDO_UID -u SUDO_GID -u SUDO_USER dash -c "$LOCAL" > "$W/deploy1b.out" 2>&1
check 'grep -q "\"outcome\": \"already\"" "$W/deploy1b.out"' "the same deploy again: already running (a replay is harmless)"

echo "── 6. publish to the (local) updates branch — only now, after the deploy"
APK=$(ls "$PUB"/android/app/build/outputs/apk/release/*.apk "$PUB"/release/*.apk 2>/dev/null | head -1)
if [ -n "$APK" ]; then cp "$APK" "$W/TradeBuddy-$V1.apk"; else head -c 1048576 /dev/urandom > "$W/TradeBuddy-$V1.apk"; fi   # stand-in for the signed APK
(cd "$T" && node scripts/release/publish-updates.mjs --apk "$W/TradeBuddy-$V1.apk" --version $V1 --sha "$REL" --remote "$W/github.git") > "$W/publish.out"
check 'grep -q "\"outcome\":\"published\"" "$W/publish.out"' "published $V1 (replaces 1.20.2)"
git -C "$W/github.git" show updates:latest.json > "$W/latest.json"
check 'python3 -c "import json; l=json.load(open(\"$W/latest.json\")); assert l[\"version\"]==\"$V1\" and l[\"apk\"].endswith(\"/updates/TradeBuddy-$V1.apk\") and l[\"commit\"]==\"$REL\""' "latest.json points at TradeBuddy-$V1.apk from the release commit"
check '[ "$(git -C "$W/github.git" ls-tree --name-only updates | sort | tr "\n" " ")" = "README.md TradeBuddy-$V1.apk latest.json " ] && [ "$(git -C "$W/github.git" rev-list --count updates)" = 1 ]' "the updates branch: one commit, exactly the three files"

echo "── 7. a broken release (the server does not start) → the previous release comes back"
(cd "$D" && git pull -q && npm version $V2 --no-git-tag-version --ignore-scripts >/dev/null && printf 'Rehearsal of a broken release.\n' > release-notes/$V2.txt \
  && sed -i 's#^main().catch#throw new Error("rehearsal: this release cannot start");\nmain().catch#' server/src/main.ts && git add -A && git commit -qm "Release $V2 (broken on purpose)" && git tag -a v$V2 -m v$V2 && git push -q origin main --tags)
BAD=$(git -C "$D" rev-parse HEAD)
CMDS2=$(bash "$KEYS/.github/scripts/ssm-deploy.sh" --instance i-0abc12345def67890 --tag v$V2 --sha "$BAD" --version $V2 --print-only | sed -n 's/^  //p')
LOCAL2=$(printf '%s' "$CMDS2" | sed "s#/opt/tradebuddy#$P/opt-tradebuddy#g; s#/root#$P/root#g; s#https://github.com/careersalanjantony-bit/tradebuddy.git#$W/github.git#g")
TB_READY_TIMEOUT=20 env -u SUDO_UID -u SUDO_GID -u SUDO_USER dash -c "$LOCAL2" > "$W/deploy2.out" 2>&1; rc2=$?
grep '^\[deploy\]' "$W/deploy2.out" | sed 's/^/      /'
R2=$(grep '^TB_DEPLOY_RESULT ' "$W/deploy2.out" | tail -1 | cut -c18-)
echo "      result: $(printf '%s' "$R2" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["outcome"], "—", r["message"][:160])')"
# (the build of $V2 itself fails at --version-info: a release that cannot even start is stopped before anything changes)
check '[ $rc2 != 0 ]' "the broken release is reported as failed (the release workflow would stop: nothing published)"
check '[ "$(curl -fsS http://127.0.0.1:$PORT/healthz | python3 -c "import json,sys; print(json.load(sys.stdin)[\"version\"])")" = $V1 ]' "production still runs $V1"
check 'curl -fsS -H "$H" http://127.0.0.1:$PORT/v1/bot/admin | python3 -c "import json,sys; a=json.load(sys.stdin)[\"authority\"]; assert a[\"mode\"]==\"cloud\" and a[\"controller\"][\"deviceId\"]==\"dev-alan\""' "the cloud auto-trader still runs, same owner"

systemctl stop
echo
echo "Rehearsal: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
