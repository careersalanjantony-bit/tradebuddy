#!/usr/bin/env bash
# TradeBuddy server — deploy one release on the EC2 instance (run as root by the release pipeline
# through AWS Systems Manager; see docs/RELEASE_PIPELINE.md). Never run it by hand during market hours.
#
#   deploy-release.sh --tag v1.23.0 --sha <40-hex commit> --version 1.23.0 [--skip-server-tests] [--retry-failed]
#
# A release whose switch failed (rolled back, or failed after a migration) is NEVER tried again
# automatically (the pipeline looks every 15 minutes: it would restart production again and again) —
# only with --retry-failed (the owner's deliberate retry) or as a new version. A build that failed
# before anything changed is tried again at most every 2 hours.
#
# What it does, in this order (any failure before step 5 changes NOTHING in production):
#   1. one deploy at a time (a lock); the tag must point at exactly --sha
#   2. builds the release in a NEW directory beside the running one — a fresh checkout of the tag from the
#      public repository, owned by root (npm ci, server build, server tests) — while the old server keeps
#      running; checks the checked-out commit, version and the database schema it needs (a build older
#      than the database is refused)
#   3. stops the service (a clean stop checkpoints SQLite's WAL), takes a consistent SQLite backup with
#      SQLite's own backup API, checks it (integrity_check, schema) and records its SHA-256
#   4. swaps the directories (old one kept for a rollback) and starts the service
#   5. checks: ready, /healthz version + commit + auto-trader contract, the database schema, and that the
#      cloud auto-trader has the same owner (mode, epoch, controlling phone) and did not go back in history
#   6. failure after the switch: if the database schema did not change, the previous code is put back and
#      started (safe: the same database); if a migration ran, NOTHING is rolled back automatically (an
#      older build cannot open a newer database and restoring the backup would lose data) — it stops with
#      the backup's path and the recovery steps
# Never touched: /etc/tradebuddy/server.env (secrets), the Firebase key, the systemd unit, Caddy.
# Git as root: /opt/tradebuddy may belong to the account that set the server up, and Git refuses such a
# checkout for root ("detected dubious ownership"). Git only ever READS it (`rev-parse`: which commit
# runs), with an exception for exactly that directory on that one command line
# (`git -c safe.directory=<its real path>`) — never safe.directory=*, never written to any Git config.
# The release itself is a fresh checkout owned by root (step 2): nothing is copied from the old one.
# Every Git step that fails ends the deploy with an explicit failure result; none can look like success.
# The last line of the output is `TB_DEPLOY_RESULT {json}`; the full log is in $LOG_DIR.
set -Eeuo pipefail
umask 022

APP_DIR=${TB_APP_DIR:-/opt/tradebuddy}
RELEASES_DIR=${TB_RELEASES_DIR:-/opt/tradebuddy-releases}
STATE_DIR=${TB_STATE_DIR:-/var/lib/tradebuddy}
DB_FILE=${TB_DB_FILE:-$STATE_DIR/tradebuddy.db}
BACKUP_DIR=${TB_BACKUP_DIR:-/var/backups/tradebuddy}
ENV_FILE=${TB_ENV_FILE:-/etc/tradebuddy/server.env}
SERVICE=${TB_SERVICE:-tradebuddy-server}
LOCAL_URL=${TB_LOCAL_URL:-http://127.0.0.1:8787}
LOCK_FILE=${TB_LOCK_FILE:-/run/lock/tradebuddy-deploy.lock}
LOG_DIR=${TB_DEPLOY_LOG_DIR:-/var/log/tradebuddy-deploy}
ORIGIN=${TB_ORIGIN:-https://github.com/careersalanjantony-bit/tradebuddy.git}
READY_TIMEOUT=${TB_READY_TIMEOUT:-120}
POLL_SECONDS=${TB_POLL_SECONDS:-2}
MIN_FREE_MB=${TB_MIN_FREE_MB:-1500}
KEEP_RELEASES=${TB_KEEP_RELEASES:-2}
KEEP_BACKUPS=${TB_KEEP_BACKUPS:-10}
BUILD_RETRY_SECONDS=${TB_BUILD_RETRY_SECONDS:-7200}
NPM=${TB_NPM:-npm}
NODE=${TB_NODE:-node}

TAG='' SHA='' VERSION='' RUN_TESTS=1 RETRY_FAILED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=${2:-}; shift 2 ;;
    --sha) SHA=${2:-}; shift 2 ;;
    --version) VERSION=${2:-}; shift 2 ;;
    --skip-server-tests) RUN_TESTS=0; shift ;;
    --retry-failed) RETRY_FAILED=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

cd /   # never inside a directory this script moves
# unique per run (to the nanosecond): two deploys in the same second must never share a log, a backup
# or a previous-release directory name
STAMP=$(date -u +%Y%m%dT%H%M%S.%NZ)
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
LOG="$LOG_DIR/deploy-$STAMP-${VERSION:-unknown}.log"
: >"$LOG"
HDR=$(mktemp)
chmod 600 "$HDR"
PHASE=start PREV='' STAGE='' BACKUP='' OLD_SHA='' OLD_VERSION='' SCHEMA_BEFORE='' SCHEMA_NEW='' BOTAPI_NEW='' BOT_BEFORE=''

say() { echo "[deploy] $*"; echo "[$(date -u +%H:%M:%S)] $*" >>"$LOG"; }
# fd 9 is the deploy lock: a process started from here (the server!) must not keep it open
run() { "$@" >>"$LOG" 2>&1 9>&-; }

# the result line (JSON written by python, so every value is escaped)
finish() {
  local ok=$1 outcome=$2 message=$3 code=0
  [ "$ok" = true ] || code=1
  rm -f "$HDR"
  # remember a failed release (see the header): the next automatic attempt is refused or delayed
  case "$outcome" in
    rolled_back|failed_no_rollback|rollback_failed|failed|build_failed|backup_failed|refused)
      [[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] && printf '%s %s\n' "$outcome" "$(date -u +%s)" >"$LOG_DIR/failed-$SHA" ;;
    deployed|already)
      [[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] && rm -f "$LOG_DIR/failed-$SHA" ;;
  esac
  OK="$ok" OUTCOME="$outcome" MESSAGE="$message" python3 - <<'PY' || true
import json, os
e = os.environ
print("TB_DEPLOY_RESULT " + json.dumps({
    "ok": e["OK"] == "true", "outcome": e["OUTCOME"], "message": e["MESSAGE"],
    "tag": e.get("TAG", ""), "sha": e.get("SHA", ""), "version": e.get("VERSION", ""),
    "previousSha": e.get("OLD_SHA", ""), "previousVersion": e.get("OLD_VERSION", ""),
    "schemaBefore": e.get("SCHEMA_BEFORE", ""), "schemaAfter": e.get("SCHEMA_NEW", ""),
    "backup": e.get("BACKUP", ""), "log": e.get("LOG", ""),
}))
PY
  exit "$code"
}
export TAG SHA VERSION OLD_SHA OLD_VERSION SCHEMA_BEFORE SCHEMA_NEW BACKUP LOG

# an unexpected error: never leave the service stopped by this script
on_err() {
  local line=$1
  trap - ERR
  echo "[deploy] unexpected error at line $line (phase $PHASE)" >>"$LOG"
  case "$PHASE" in
    stopped)
      systemctl start "$SERVICE" >>"$LOG" 2>&1 9>&- || true
      finish false failed "unexpected error at line $line before the switch — nothing was changed, the previous server was started again" ;;
    switched)
      systemctl start "$SERVICE" >>"$LOG" 2>&1 9>&- || true
      finish false failed "unexpected error at line $line after the switch — check the server (log $LOG, backup $BACKUP, previous release $PREV)" ;;
    *)
      [ -n "$STAGE" ] && rm -rf "$STAGE"
      finish false failed "unexpected error at line $line — nothing was changed" ;;
  esac
}
trap 'on_err $LINENO' ERR

# JSON field from stdin: jget 'a.b.c' (empty when missing)
jget() {
  python3 -c '
import json, sys
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        v = v.get(k) if isinstance(v, dict) else None
    print("" if v is None else (json.dumps(v) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else v))
except Exception:
    print("")
' "$1"
}

db_schema() {
  python3 - "$DB_FILE" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(c.execute("select version from schema_version").fetchone()[0])
PY
}

# Git on the running checkout (see the header): read-only, this one directory trusted, nothing stored
app_git() { git -c safe.directory="$APP_REAL" -C "$APP_REAL" "$@"; }

get() { curl -fsS -m 10 "$LOCAL_URL$1"; }
get_admin() { curl -fsS -m 10 -H @"$HDR" "$LOCAL_URL$1"; }

wait_ready() {
  local waited=0
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if get /readyz >/dev/null 2>&1; then return 0; fi
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
  done
  return 1
}

# the cloud auto-trader's owner, as "mode|epoch|controller|rev" (empty when the server has no auto-trader API)
bot_owner() {
  local j
  j=$(get_admin /v1/bot/admin 2>/dev/null) || { echo ''; return 0; }
  printf '%s' "$j" | python3 -c '
import json, sys
j = json.load(sys.stdin)
a = j.get("authority") or {}
c = a.get("controller") or {}
s = j.get("server") or {}
print("%s|%s|%s|%s" % (a.get("mode", ""), a.get("epoch", ""), c.get("deviceId", ""), s.get("rev", 0) if s else 0))
'
}

# ---------------------------------------------------------------- 1. checks before anything

[[ "$VERSION" =~ ^[0-9]{1,3}\.[0-9]{1,2}\.[0-9]{1,2}$ ]] || finish false refused "--version must be x.y.z"
[ "$TAG" = "v$VERSION" ] || finish false refused "--tag must be v$VERSION"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || finish false refused "--sha must be a full 40-character commit"
exec 9>"$LOCK_FILE"
flock -n 9 || finish false locked "another deploy is running"
if [ -f "$LOG_DIR/failed-$SHA" ] && [ "$RETRY_FAILED" = 0 ]; then
  read -r last_outcome last_at <"$LOG_DIR/failed-$SHA" || true
  case "$last_outcome" in
    build_failed|backup_failed|failed|refused)
      if [ $(( $(date -u +%s) - ${last_at:-0} )) -lt "$BUILD_RETRY_SECONDS" ]; then
        trap - ERR; rm -f "$HDR"
        OK=false OUTCOME=waiting MESSAGE="$TAG failed to build here less than $((BUILD_RETRY_SECONDS / 60)) minutes ago ($last_outcome) — tried again later" python3 -c 'import json,os; e=os.environ; print("TB_DEPLOY_RESULT " + json.dumps({"ok": False, "outcome": e["OUTCOME"], "message": e["MESSAGE"], "tag": e["TAG"], "sha": e["SHA"], "version": e["VERSION"]}))'
        exit 1
      fi ;;
    *)
      trap - ERR; rm -f "$HDR"
      OK=false OUTCOME=refused_failed_before MESSAGE="$TAG failed in production before ($last_outcome): not tried again automatically. Release a fixed version, or retry deliberately (release workflow → retry_failed_deploy)." python3 -c 'import json,os; e=os.environ; print("TB_DEPLOY_RESULT " + json.dumps({"ok": False, "outcome": e["OUTCOME"], "message": e["MESSAGE"], "tag": e["TAG"], "sha": e["SHA"], "version": e["VERSION"]}))'
      exit 1 ;;
  esac
fi
say "TradeBuddy $TAG ($SHA) — log: $LOG"

[ -d "$APP_DIR/.git" ] || finish false refused "$APP_DIR is not a git checkout"
APP_REAL=$(cd "$APP_DIR" && pwd -P) || finish false refused "cannot open $APP_DIR"
[ -f "$DB_FILE" ] || finish false refused "no database at $DB_FILE"
TOKEN=$(sed -n 's/^TB_API_TOKEN=//p' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)
[ -n "$TOKEN" ] && printf 'Authorization: Bearer %s\n' "$TOKEN" >"$HDR"
unset TOKEN
OLD_SHA=$(app_git rev-parse -q --verify 'HEAD^{commit}' 2>>"$LOG") || OLD_SHA=''
[[ "$OLD_SHA" =~ ^[0-9a-f]{40}$ ]] || finish false refused "cannot read the running commit in $APP_DIR with git (see the log) — nothing was changed"
CUR=$(get /healthz 2>/dev/null || true)
OLD_VERSION=$(printf '%s' "$CUR" | jget version)
OLD_COMMIT=$(printf '%s' "$CUR" | jget commit)
SCHEMA_BEFORE=$(db_schema) || finish false refused "cannot read the database schema"
export OLD_SHA OLD_VERSION SCHEMA_BEFORE
if [ "$OLD_VERSION" = "$VERSION" ] && { [ "$OLD_COMMIT" = "$SHA" ] || [ "$OLD_SHA" = "$SHA" ]; }; then
  finish true already "the server already runs $TAG ($SHA)"
fi
BOT_BEFORE=$(bot_owner)
say "running: ${OLD_VERSION:-unknown} (${OLD_SHA:0:7}), database schema $SCHEMA_BEFORE, auto-trader ${BOT_BEFORE:-n/a}"

mkdir -p "$RELEASES_DIR" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
db_mb=$(( ($(stat -c %s "$DB_FILE") + 1048575) / 1048576 ))
for d in "$RELEASES_DIR" "$BACKUP_DIR"; do
  free=$(df -Pm "$d" | awk 'NR==2 {print $4}')
  [ "$free" -ge $((MIN_FREE_MB + 2 * db_mb)) ] || finish false refused "not enough disk space in $d (${free} MB free, need $((MIN_FREE_MB + 2 * db_mb)) MB)"
done

# ---------------------------------------------------------------- 2. build beside the running server

PHASE=build
STAGE="$RELEASES_DIR/stage-$SHA"
rm -rf "$STAGE"
say "building in $STAGE (the running server is not touched)"
# a fresh repository owned by root, filled from the public repository only: nothing is read from (or
# written to) the running checkout, so its owner does not matter and none of its files reach the release
run git init -q -b release "$STAGE" || { rm -rf "$STAGE"; finish false build_failed "could not create $STAGE"; }
run git -C "$STAGE" remote add origin "$ORIGIN" || { rm -rf "$STAGE"; finish false build_failed "could not set up $STAGE"; }
run git -C "$STAGE" fetch -q --no-tags origin "refs/tags/$TAG:refs/tags/$TAG" || { rm -rf "$STAGE"; finish false build_failed "could not fetch $TAG from $ORIGIN"; }
AT=$(git -C "$STAGE" rev-parse -q --verify "refs/tags/$TAG^{commit}" 2>>"$LOG") || AT=''
[ "$AT" = "$SHA" ] || { rm -rf "$STAGE"; finish false refused "$TAG points at ${AT:-nothing}, not $SHA (tags never move)"; }
run git -C "$STAGE" checkout -q --detach "$SHA" || { rm -rf "$STAGE"; finish false build_failed "could not check out $SHA"; }
AT=$(git -C "$STAGE" rev-parse -q --verify 'HEAD^{commit}' 2>>"$LOG") || AT=''
[ "$AT" = "$SHA" ] || { rm -rf "$STAGE"; finish false refused "the checkout is at ${AT:-nothing}, not $SHA"; }
( cd "$STAGE" && export TB_BUILD_COMMIT="$SHA" && run "$NPM" ci --ignore-scripts --no-audit --no-fund && run "$NPM" run server:build ) || { rm -rf "$STAGE"; finish false build_failed "npm ci / server build failed (see the log)"; }
if [ "$RUN_TESTS" = 1 ]; then
  ( cd "$STAGE" && run "$NPM" run server:test ) || { rm -rf "$STAGE"; finish false build_failed "the server tests failed on this machine (see the log)"; }
fi
INFO=$(cd "$STAGE" && "$NODE" server/dist/main.js --version-info 2>>"$LOG") || { rm -rf "$STAGE"; finish false build_failed "the new build does not start (--version-info)"; }
[ "$(printf '%s' "$INFO" | jget version)" = "$VERSION" ] || { rm -rf "$STAGE"; finish false refused "the build says version $(printf '%s' "$INFO" | jget version), expected $VERSION"; }
[ "$(printf '%s' "$INFO" | jget commit)" = "$SHA" ] || { rm -rf "$STAGE"; finish false refused "the build says commit $(printf '%s' "$INFO" | jget commit), expected $SHA"; }
SCHEMA_NEW=$(printf '%s' "$INFO" | jget schema)
BOTAPI_NEW=$(printf '%s' "$INFO" | jget botApi)
export SCHEMA_NEW
[[ "$SCHEMA_NEW" =~ ^[0-9]+$ ]] || { rm -rf "$STAGE"; finish false build_failed "the build does not say which database schema it needs"; }
if [ "$SCHEMA_NEW" -lt "$SCHEMA_BEFORE" ]; then
  rm -rf "$STAGE"
  finish false refused "the database is schema $SCHEMA_BEFORE, newer than this build (schema $SCHEMA_NEW): an older build is never started on a newer database"
fi
say "built $VERSION: database schema $SCHEMA_BEFORE -> $SCHEMA_NEW, auto-trader API ${BOTAPI_NEW:-n/a}"

# ---------------------------------------------------------------- 3. stop, consistent backup

PHASE=stopped
run systemctl stop "$SERVICE" || true
BACKUP="$BACKUP_DIR/deploy-$STAMP-v$VERSION"
export BACKUP
mkdir -m 700 "$BACKUP"
if ! BK=$(python3 - "$DB_FILE" "$BACKUP/tradebuddy.db" "$SCHEMA_BEFORE" 2>>"$LOG" <<'PY'
import hashlib, sqlite3, sys
src_path, dst_path, schema = sys.argv[1], sys.argv[2], int(sys.argv[3])
src = sqlite3.connect(src_path)              # SQLite's own online backup: consistent even with a WAL file
dst = sqlite3.connect(dst_path)
src.backup(dst)
dst.close(); src.close()
c = sqlite3.connect(f"file:{dst_path}?mode=ro", uri=True)
ok = c.execute("pragma integrity_check").fetchone()[0]
v = c.execute("select version from schema_version").fetchone()[0]
c.close()
if ok != "ok" or v != schema:
    raise SystemExit(f"backup check failed: integrity {ok}, schema {v}")
h = hashlib.sha256(open(dst_path, "rb").read()).hexdigest()
print(h)
PY
); then
  say "backup FAILED — starting the previous server again, nothing changed"
  run systemctl start "$SERVICE" || true
  wait_ready || true
  finish false backup_failed "the database backup failed its check — nothing was changed (the previous server was started again)"
fi
python3 - "$BACKUP/manifest.json" <<PY
import json, sys
json.dump({"at": "$STAMP", "from": {"version": "$OLD_VERSION", "sha": "$OLD_SHA"}, "to": {"version": "$VERSION", "sha": "$SHA"},
           "schema": $SCHEMA_BEFORE, "sha256": "$BK", "file": "tradebuddy.db"}, open(sys.argv[1], "w"), indent=2)
PY
say "backup ok: $BACKUP (schema $SCHEMA_BEFORE, sha256 ${BK:0:16}…)"

# ---------------------------------------------------------------- 4. switch

PHASE=switched
PREV="$RELEASES_DIR/prev-${OLD_SHA:0:12}-$STAMP"
mv -T "$APP_DIR" "$PREV"     # -T: fail rather than move into an existing directory
mv -T "$STAGE" "$APP_DIR"
STAGE=''
run systemctl start "$SERVICE" || true

# ---------------------------------------------------------------- 5. checks

problem=''
if ! wait_ready; then
  problem="the new server did not become ready within ${READY_TIMEOUT} s"
else
  H=$(get /healthz 2>/dev/null || true)
  [ "$(printf '%s' "$H" | jget version)" = "$VERSION" ] || problem="/healthz says version $(printf '%s' "$H" | jget version), expected $VERSION"
  [ -z "$problem" ] && [ "$(app_git rev-parse -q --verify 'HEAD^{commit}' 2>>"$LOG" || true)" != "$SHA" ] && problem="the code in $APP_DIR is not at $SHA"
  [ -z "$problem" ] && [ "$(printf '%s' "$H" | jget commit)" != "$SHA" ] && problem="/healthz says commit $(printf '%s' "$H" | jget commit), expected $SHA"
  [ -z "$problem" ] && [ -n "$BOTAPI_NEW" ] && [ "$(printf '%s' "$H" | jget botApi)" != "$BOTAPI_NEW" ] && problem="/healthz says auto-trader API $(printf '%s' "$H" | jget botApi), expected $BOTAPI_NEW"
  if [ -z "$problem" ] && [ -s "$HDR" ]; then
    V=$(get_admin /v1/health 2>/dev/null || true)
    [ "$(printf '%s' "$V" | jget database.schemaVersion)" = "$SCHEMA_NEW" ] || problem="the database reports schema $(printf '%s' "$V" | jget database.schemaVersion), expected $SCHEMA_NEW"
    [ -z "$problem" ] && [ "$(printf '%s' "$V" | jget database.ok)" != "true" ] && problem="the database check failed"
  fi
  if [ -z "$problem" ] && [ -n "$BOT_BEFORE" ]; then
    BOT_AFTER=$(bot_owner)
    IFS='|' read -r m1 e1 c1 r1 <<<"$BOT_BEFORE"
    IFS='|' read -r m2 e2 c2 r2 <<<"$BOT_AFTER"
    if [ "$m1|$e1|$c1" != "$m2|$e2|$c2" ]; then
      problem="the cloud auto-trader's owner changed ($m1/$e1/${c1:-none} -> ${m2:-?}/${e2:-?}/${c2:-none})"
    elif [ "${r2:-0}" -lt "${r1:-0}" ]; then
      problem="the cloud auto-trader went back in history (version $r1 -> $r2)"
    fi
  fi
fi

if [ -z "$problem" ]; then
  # keep the newest previous releases and deploy backups; never touch any other backup
  { ls -1dt "$RELEASES_DIR"/prev-* 2>/dev/null || true; } | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
  { ls -1dt "$RELEASES_DIR"/failed-* 2>/dev/null || true; } | tail -n +2 | xargs -r rm -rf
  { ls -1dt "$BACKUP_DIR"/deploy-* 2>/dev/null || true; } | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf
  say "deployed $TAG: ready, version, commit, schema $SCHEMA_NEW and the auto-trader's owner checked"
  finish true deployed "TradeBuddy $VERSION runs (database schema $SCHEMA_BEFORE -> $SCHEMA_NEW); backup $BACKUP"
fi

# ---------------------------------------------------------------- 6. failure after the switch

say "CHECK FAILED: $problem"
run journalctl -u "$SERVICE" -n 80 --no-pager || true
run systemctl stop "$SERVICE" || true
SCHEMA_AFTER=$(db_schema 2>/dev/null || echo unknown)
if [ "$SCHEMA_AFTER" = "$SCHEMA_BEFORE" ]; then
  say "the database schema did not change ($SCHEMA_AFTER): putting the previous release back"
  mv -T "$APP_DIR" "$RELEASES_DIR/failed-${SHA:0:12}-$STAMP"
  mv -T "$PREV" "$APP_DIR"
  run systemctl start "$SERVICE" || true
  if wait_ready && [ "$(get /healthz 2>/dev/null | jget version)" = "$OLD_VERSION" ]; then
    SCHEMA_NEW=$SCHEMA_AFTER
    finish false rolled_back "$problem — the previous release ($OLD_VERSION) runs again on the same database; nothing was lost"
  fi
  finish false rollback_failed "$problem — AND the previous release did not come back: run the recovery steps in docs/RELEASE_PIPELINE.md (backup $BACKUP)"
fi
# a migration ran: an older build cannot open this database, and restoring the backup would lose
# whatever the new server wrote — so nothing is rolled back automatically
run systemctl start "$SERVICE" || true
finish false failed_no_rollback "$problem — the database was migrated ($SCHEMA_BEFORE -> $SCHEMA_AFTER), so nothing was rolled back automatically. The new release was started again. Backup before the migration: $BACKUP; previous release: $PREV. See docs/RELEASE_PIPELINE.md, recovery."
