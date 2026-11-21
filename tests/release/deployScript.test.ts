import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The server deploy script (server/deploy/deploy-release.sh) for real — real git (a local "GitHub" with
 * release tags), a real SQLite database, real backups with SQLite's backup API — in a sandbox where only
 * systemd, the server's HTTP answers, npm and node are stand-ins whose behaviour each test chooses
 * (a release that never gets ready, a migration, an auto-trader whose owner changed …).
 */

const SCRIPT = join(__dirname, '../../server/deploy/deploy-release.sh');
const TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';

let box: string;
const releases: Record<string, string> = {}; // version → commit

const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The stand-ins (python): systemd, the running server's HTTP answers, npm, node. Scenario knobs come from $SANDBOX/knobs.json. */
function writeFakes(bin: string): void {
  const common = `#!/usr/bin/env python3
import json, os, sqlite3, subprocess, sys
BOX = os.environ["SANDBOX"]
def load(name, default=None):
    p = os.path.join(BOX, name)
    return json.load(open(p)) if os.path.exists(p) else default
def save(name, value):
    json.dump(value, open(os.path.join(BOX, name), "w"))
knobs = load("knobs.json", {})
def db_schema():
    c = sqlite3.connect(os.environ["TB_DB_FILE"]); v = c.execute("select version from schema_version").fetchone()[0]; c.close(); return v
def set_schema(v):
    c = sqlite3.connect(os.environ["TB_DB_FILE"]); c.execute("update schema_version set version = ?", (v,)); c.commit(); c.close()
`;
  const files: Record<string, string> = {
    systemctl: `${common}
cmd = sys.argv[1]
if cmd == "stop":
    if os.path.exists(os.path.join(BOX, "running.json")): os.remove(os.path.join(BOX, "running.json"))
    if knobs.get("stop_touches_schema"): set_schema(db_schema() + 7)
    sys.exit(0)
if cmd == "start":
    app = os.environ["TB_APP_DIR"]
    info = json.load(open(os.path.join(app, "fake-version.json")))
    # the commit is built into the real server (it never runs git): read the detached HEAD like a file
    commit = open(os.path.join(app, ".git", "HEAD")).read().strip()
    if info["schema"] > db_schema(): set_schema(info["schema"])   # the new server migrates on start
    save("running.json", {**info, "commit": commit})
    # like a real long-running server process: it inherits whatever files the caller left open
    subprocess.Popen(["sleep", "20"], close_fds=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    starts = load("starts.json", []); starts.append(info["version"]); save("starts.json", starts)
    sys.exit(0)
if cmd == "is-active":
    sys.exit(0 if os.path.exists(os.path.join(BOX, "running.json")) else 3)
sys.exit(0)
`,
    curl: `${common}
url = sys.argv[-1]
hdr = None
for i, a in enumerate(sys.argv):
    if a == "-H" and sys.argv[i + 1].startswith("@"): hdr = open(sys.argv[i + 1][1:]).read()
calls = load("curl.json", []); calls.append([url, hdr is not None]); save("curl.json", calls)
run = load("running.json")
if not run: sys.exit(7)                       # connection refused: nothing listens
path = url.split("://", 1)[1].split("/", 1)[1] if "/" in url.split("://", 1)[1] else ""
path = "/" + path
v = run["version"]
authed = hdr is not None and "Bearer " + os.environ.get("FAKE_TOKEN", "") in hdr
if path == "/readyz":
    if knobs.get("not_ready") == v: sys.exit(22)
    print(json.dumps({"status": "ready"})); sys.exit(0)
if path == "/healthz":
    body = {"status": "ok", "version": v, "uptimeSeconds": 1}
    if not run.get("old_build"): body.update({"commit": run["commit"], "botApi": run.get("botApi", 1)})
    print(json.dumps(body)); sys.exit(0)
if not authed: sys.exit(22)
if path == "/v1/health":
    print(json.dumps({"status": "ok", "database": {"ok": True, "schemaVersion": db_schema()}})); sys.exit(0)
if path == "/v1/bot/admin":
    bot = load("bot.json")
    if bot is None: sys.exit(22)
    after = knobs.get("bot_after", {}).get(v, {})
    bot = {**bot, **after}
    print(json.dumps({"authority": {"mode": bot["mode"], "epoch": bot["epoch"], "controller": {"deviceId": bot["controller"]} if bot["controller"] else None}, "server": {"rev": bot["rev"]}})); sys.exit(0)
sys.exit(22)
`,
    journalctl: '#!/bin/sh\necho "(the service journal)"\n',
    npm: `${common}
args = sys.argv[1:]
version = json.load(open("fake-version.json"))["version"]
if args[0] == "ci":
    sys.exit(1 if knobs.get("npm_ci_fails") == version else 0)
if args[:2] == ["run", "server:build"]:
    os.makedirs("server/dist", exist_ok=True); open("server/dist/main.js", "w").write("// built"); sys.exit(0)
if args[:2] == ["run", "server:test"]:
    sys.exit(1 if knobs.get("server_tests_fail") == version else 0)
sys.exit(0)
`,
    node: `${common}
if sys.argv[1:] == ["server/dist/main.js", "--version-info"]:
    info = json.load(open("fake-version.json"))
    commit = os.environ.get("TB_BUILD_COMMIT") or subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    print(json.dumps({"version": info["version"], "commit": commit, "schema": info["schema"], "botApi": info.get("botApi", 1)})); sys.exit(0)
sys.exit(1)
`,
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
}

function setup(): void {
  box = realpathSync(mkdtempSync(join(tmpdir(), 'tb-deploy-')));
  for (const d of ['bin', 'state', 'backups', 'releases', 'logs', 'work']) mkdirSync(join(box, d));
  writeFakes(join(box, 'bin'));
  // "GitHub": four releases; 1.2.0 needs database schema 5 (a migration), 1.3.0 is built for an older schema
  sh(box, 'git init -q --bare origin.git');
  const work = join(box, 'work');
  sh(work, 'git init -q -b main && git config user.email t@t && git config user.name t');
  for (const [version, schema] of [['1.0.0', 4], ['1.1.0', 4], ['1.2.0', 5], ['1.3.0', 3]] as const) {
    writeFileSync(join(work, 'fake-version.json'), JSON.stringify({ version, schema, botApi: 1 }));
    sh(work, `git add -A && git commit -q -m "release ${version}" && git tag -a v${version} -m v${version}`);
    releases[version] = sh(work, 'git rev-parse HEAD');
  }
  sh(work, `git push -q ${join(box, 'origin.git')} main --tags`);
  // the server: 1.0.0 checked out in /opt/tradebuddy, its database (schema 4) with the owner's data
  sh(box, `git clone -q origin.git app && git -C app checkout -q --detach v1.0.0`);
  const db = new DatabaseSync(join(box, 'state', 'tradebuddy.db'));
  db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (4); CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT); INSERT INTO kv VALUES ('bot', '{\"trades\":42}'), ('settings', '{}');");
  db.close();
  writeFileSync(join(box, 'server.env'), `TB_HOST=127.0.0.1\nTB_API_TOKEN=${TOKEN}\nUPSTOX_ANALYTICS_TOKEN=secret-upstox\n`);
  writeFileSync(join(box, 'bot.json'), JSON.stringify({ mode: 'cloud', epoch: 2, controller: 'dev-1', rev: 50 }));
  knobs({});
  fake('systemctl start tradebuddy-server'); // the running 1.0.0
}

const knobs = (k: Record<string, unknown>) => writeFileSync(join(box, 'knobs.json'), JSON.stringify(k));
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${join(box, 'bin')}:${process.env.PATH}`,
  SANDBOX: box,
  FAKE_TOKEN: TOKEN,
  TB_APP_DIR: join(box, 'app'),
  TB_RELEASES_DIR: join(box, 'releases'),
  TB_STATE_DIR: join(box, 'state'),
  TB_DB_FILE: join(box, 'state', 'tradebuddy.db'),
  TB_BACKUP_DIR: join(box, 'backups'),
  TB_ENV_FILE: join(box, 'server.env'),
  TB_LOCAL_URL: 'http://127.0.0.1:8787',
  TB_LOCK_FILE: join(box, 'deploy.lock'),
  TB_DEPLOY_LOG_DIR: join(box, 'logs'),
  TB_ORIGIN: join(box, 'origin.git'),
  TB_READY_TIMEOUT: '3',
  TB_POLL_SECONDS: '1',
  TB_MIN_FREE_MB: '1',
  TB_NPM: join(box, 'bin', 'npm'),
  TB_NODE: join(box, 'bin', 'node'),
  ...extra,
});
const fake = (cmd: string) => spawnSync('bash', ['-c', cmd], { env: env(), encoding: 'utf8' });
// Systems Manager runs the deploy as root with no sudo in between: no SUDO_UID (Git would use it)
for (const k of ['SUDO_UID', 'SUDO_GID', 'SUDO_USER', 'SUDO_COMMAND']) delete process.env[k];

function deploy(version: string, opts: { sha?: string; tag?: string; extraEnv?: Record<string, string>; args?: string[] } = {}) {
  const r = spawnSync('bash', [SCRIPT, '--tag', opts.tag ?? `v${version}`, '--sha', opts.sha ?? releases[version]!, '--version', version, ...(opts.args ?? [])], { env: env(opts.extraEnv), encoding: 'utf8', timeout: 60_000 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('TB_DEPLOY_RESULT '));
  const logs = readdirSync(join(box, 'logs')).map((f) => readFileSync(join(box, 'logs', f), 'utf8')).join('\n');
  return { code: r.status, out: r.stdout + r.stderr, result: line ? JSON.parse(line.slice('TB_DEPLOY_RESULT '.length)) : null, logs };
}

const running = () => (existsSync(join(box, 'running.json')) ? JSON.parse(readFileSync(join(box, 'running.json'), 'utf8')) : null);
// the test itself may read a checkout another user owns (the root tests below): trust exactly that one
const head = () => sh(box, `git -c safe.directory=${join(box, 'app')} -C app rev-parse HEAD`);
const dbRows = (file = join(box, 'state', 'tradebuddy.db')) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = { schema: (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, kv: db.prepare('SELECT k, v FROM kv ORDER BY k').all() };
  db.close();
  return out;
};
const backups = () => readdirSync(join(box, 'backups')).filter((d) => d.startsWith('deploy-'));

beforeEach(setup);
afterEach(() => rmSync(box, { recursive: true, force: true }));

// each test runs the real script one to three times (git, SQLite, the stand-ins): give it time under load
describe('server deploy (server/deploy/deploy-release.sh)', { timeout: 120_000 }, () => {
  it('deploys a release: builds beside the running server, backs up, switches, checks everything', () => {
    const before = dbRows();
    const r = deploy('1.1.0');
    expect(r.result).toMatchObject({ ok: true, outcome: 'deployed', version: '1.1.0', sha: releases['1.1.0'], previousVersion: '1.0.0', schemaBefore: '4', schemaAfter: '4' });
    expect(r.code).toBe(0);
    expect(head()).toBe(releases['1.1.0']);
    expect(running()).toMatchObject({ version: '1.1.0', commit: releases['1.1.0'] });
    expect(dbRows()).toEqual(before); // the owner's data, untouched
    // a consistent, checked backup with a manifest
    const [b] = backups();
    expect(b).toMatch(/^deploy-\d{8}T\d{6}\.\d{9}Z-v1\.1\.0$/);
    expect(dbRows(join(box, 'backups', b!, 'tradebuddy.db'))).toEqual(before);
    const manifest = JSON.parse(readFileSync(join(box, 'backups', b!, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ schema: 4, from: { version: '1.0.0', sha: releases['1.0.0'] }, to: { version: '1.1.0', sha: releases['1.1.0'] } });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the previous release is kept for a rollback
    expect(readdirSync(join(box, 'releases')).some((d) => d.startsWith(`prev-${releases['1.0.0']!.slice(0, 12)}`))).toBe(true);
    // the admin token was used on the server only, and never printed
    expect(r.out).not.toContain(TOKEN);
    expect(r.logs).not.toContain(TOKEN);
    expect(r.out + r.logs).not.toContain('secret-upstox');
  });

  it('the same release again: nothing to do (a replay is harmless)', () => {
    deploy('1.1.0');
    const r = deploy('1.1.0');
    expect(r.result).toMatchObject({ ok: true, outcome: 'already' });
    expect(backups()).toHaveLength(1);
  });

  it('a release that never gets ready, same database schema: the previous release is put back and runs', () => {
    knobs({ not_ready: '1.1.0' });
    const before = dbRows();
    const r = deploy('1.1.0');
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ ok: false, outcome: 'rolled_back' });
    expect(r.result.message).toMatch(/did not become ready.*previous release \(1\.0\.0\) runs again/);
    expect(head()).toBe(releases['1.0.0']);
    expect(running()).toMatchObject({ version: '1.0.0' });
    expect(dbRows()).toEqual(before);
    expect(readdirSync(join(box, 'releases')).some((d) => d.startsWith('failed-'))).toBe(true);
  });

  it('a migration (schema 4 → 5) that works: deployed, the database is schema 5, the backup is schema 4', () => {
    const r = deploy('1.2.0');
    expect(r.result).toMatchObject({ ok: true, outcome: 'deployed', schemaBefore: '4', schemaAfter: '5' });
    expect(dbRows().schema).toBe(5);
    expect(dbRows(join(box, 'backups', backups()[0]!, 'tradebuddy.db')).schema).toBe(4);
  });

  it('a migration whose server then fails its checks: NO automatic rollback (never an older build on a newer database)', () => {
    knobs({ not_ready: '1.2.0' });
    const r = deploy('1.2.0');
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ ok: false, outcome: 'failed_no_rollback' });
    expect(r.result.message).toMatch(/migrated \(4 -> 5\).*nothing was rolled back automatically/);
    expect(r.result.backup).toContain('deploy-');
    expect(head()).toBe(releases['1.2.0']); // the old code was NOT started on the migrated database
    expect(JSON.parse(readFileSync(join(box, 'starts.json'), 'utf8'))).toEqual(['1.0.0', '1.2.0', '1.2.0']);
    expect(dbRows(join(box, 'backups', backups()[0]!, 'tradebuddy.db')).schema).toBe(4); // the way back, by hand
  });

  it('a build older than the database is refused before anything is stopped', () => {
    deploy('1.2.0'); // the database is now schema 5
    const starts = readFileSync(join(box, 'starts.json'), 'utf8');
    const r = deploy('1.3.0');
    expect(r.result).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.result.message).toMatch(/schema 5, newer than this build \(schema 3\)/);
    expect(head()).toBe(releases['1.2.0']);
    expect(readFileSync(join(box, 'starts.json'), 'utf8')).toBe(starts); // never stopped
    expect(backups()).toHaveLength(1);
  });

  it('a tag that does not point at the given commit is refused (tags never move)', () => {
    const r = deploy('1.1.0', { sha: releases['1.2.0'] });
    expect(r.result).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.result.message).toMatch(/v1\.1\.0 points at .* not /);
    expect(head()).toBe(releases['1.0.0']);
    expect(readdirSync(join(box, 'releases'))).toEqual([]);
  });

  it('npm ci or the server tests failing on the server: nothing changes, nothing is left behind', () => {
    knobs({ npm_ci_fails: '1.1.0' });
    expect(deploy('1.1.0').result).toMatchObject({ ok: false, outcome: 'build_failed' });
    knobs({ server_tests_fail: '1.1.0' });
    const r = deploy('1.1.0', { extraEnv: { TB_BUILD_RETRY_SECONDS: '0' } });
    expect(r.result).toMatchObject({ ok: false, outcome: 'build_failed' });
    expect(r.result.message).toMatch(/server tests failed/);
    expect(head()).toBe(releases['1.0.0']);
    expect(running()).toMatchObject({ version: '1.0.0' });
    expect(readdirSync(join(box, 'releases'))).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('a backup that fails its check: nothing is switched, the previous server is started again', () => {
    knobs({ stop_touches_schema: true }); // something wrote to the database while it was being backed up
    const r = deploy('1.1.0');
    expect(r.result).toMatchObject({ ok: false, outcome: 'backup_failed' });
    expect(head()).toBe(releases['1.0.0']);
    expect(running()).toMatchObject({ version: '1.0.0' });
  });

  it('the cloud auto-trader must keep its owner and history: otherwise the release is rolled back', () => {
    knobs({ bot_after: { '1.1.0': { mode: 'standby' } } });
    let r = deploy('1.1.0');
    expect(r.result).toMatchObject({ ok: false, outcome: 'rolled_back' });
    expect(r.result.message).toMatch(/owner changed \(cloud\/2\/dev-1 -> standby\/2\/dev-1\)/);
    knobs({ bot_after: { '1.1.0': { rev: 49 } } });
    r = deploy('1.1.0', { args: ['--retry-failed'] });
    expect(r.result).toMatchObject({ ok: false, outcome: 'rolled_back' });
    expect(r.result.message).toMatch(/went back in history \(version 50 -> 49\)/);
    knobs({ bot_after: { '1.1.0': { rev: 51 } } }); // it traded meanwhile: fine
    expect(deploy('1.1.0', { args: ['--retry-failed'] }).result).toMatchObject({ ok: true, outcome: 'deployed' });
  });

  it('a release that failed in production is NOT tried again automatically (the pipeline looks every 15 minutes)', () => {
    knobs({ not_ready: '1.1.0' });
    expect(deploy('1.1.0').result).toMatchObject({ outcome: 'rolled_back' });
    knobs({});
    const again = deploy('1.1.0');
    expect(again.result).toMatchObject({ ok: false, outcome: 'refused_failed_before' });
    expect(again.result.message).toMatch(/not tried again automatically/);
    expect(JSON.parse(readFileSync(join(box, 'starts.json'), 'utf8'))).toEqual(['1.0.0', '1.1.0', '1.0.0']); // not restarted again
    // the owner's deliberate retry (after fixing the cause) works, and clears the mark
    expect(deploy('1.1.0', { args: ['--retry-failed'] }).result).toMatchObject({ ok: true, outcome: 'deployed' });
    expect(existsSync(join(box, 'logs', `failed-${releases['1.1.0']}`))).toBe(false);
  });

  it('a build that failed before anything changed is tried again only after a pause (no build every 15 minutes)', () => {
    knobs({ npm_ci_fails: '1.1.0' });
    expect(deploy('1.1.0').result).toMatchObject({ outcome: 'build_failed' });
    knobs({});
    expect(deploy('1.1.0').result).toMatchObject({ ok: false, outcome: 'waiting', message: expect.stringMatching(/tried again later/) });
    expect(deploy('1.1.0', { extraEnv: { TB_BUILD_RETRY_SECONDS: '0' } }).result).toMatchObject({ ok: true, outcome: 'deployed' });
  });

  it('one deploy at a time; not enough disk space; bad arguments — all refused before anything happens', () => {
    const holder = spawnSync('bash', ['-c', `exec 9>"${join(box, 'deploy.lock')}"; flock -n 9 && bash "${SCRIPT}" --tag v1.1.0 --sha ${releases['1.1.0']} --version 1.1.0`], { env: env(), encoding: 'utf8' });
    expect(holder.stdout).toContain('"outcome": "locked"');
    expect(deploy('1.1.0', { extraEnv: { TB_MIN_FREE_MB: '999999999' } }).result).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/not enough disk space/) });
    expect(deploy('1.1.0', { tag: 'v9.9.9', extraEnv: { TB_BUILD_RETRY_SECONDS: '0' } }).result).toMatchObject({ ok: false, outcome: 'refused' });
    expect(head()).toBe(releases['1.0.0']);
    expect(running()).toMatchObject({ version: '1.0.0' });
  });

  it('a running server without the commit on /healthz (an older build) is still recognised and replaced', () => {
    const run = running();
    writeFileSync(join(box, 'running.json'), JSON.stringify({ ...run, old_build: true }));
    expect(deploy('1.1.0').result).toMatchObject({ ok: true, outcome: 'deployed', previousVersion: '1.0.0' });
  });

  it('keeps only the newest previous releases and deploy backups, never other backups', () => {
    mkdirSync(join(box, 'backups', 'state-m4-20261120-1800'));
    deploy('1.1.0', { extraEnv: { TB_KEEP_BACKUPS: '1', TB_KEEP_RELEASES: '1' } });
    deploy('1.2.0', { extraEnv: { TB_KEEP_BACKUPS: '1', TB_KEEP_RELEASES: '1' } });
    expect(backups()).toHaveLength(1);
    expect(backups()[0]).toMatch(/v1\.2\.0$/);
    expect(existsSync(join(box, 'backups', 'state-m4-20261120-1800'))).toBe(true);
    expect(readdirSync(join(box, 'releases')).filter((d) => d.startsWith('prev-'))).toHaveLength(1);
  });

  it('two deploys in the same second (a fast machine) never share a log, a backup or a release directory', () => {
    // a clock that always says 10:00:00 (nanoseconds still move): like the CI run where a retry came
    // within the same second as the rollback before it and the backup directory already existed
    const clock = join(box, 'clock');
    mkdirSync(clock);
    writeFileSync(join(clock, 'date'), `#!/usr/bin/env python3
import datetime, os, shutil, sys, time
fmt = next((a[1:] for a in sys.argv[1:] if a.startswith("+")), "")
if "%Y" in fmt:
    ns = time.time_ns() % 1_000_000_000
    print(datetime.datetime(2026, 11, 21, 10, 0, 0).strftime(fmt.replace("%N", f"{ns:09d}"))); sys.exit(0)
real = next(p for p in ("/usr/bin/date", "/bin/date") if os.path.exists(p))
os.execv(real, [real] + sys.argv[1:])
`);
    chmodSync(join(clock, 'date'), 0o755);
    const sameSecond = { PATH: `${clock}:${join(box, 'bin')}:${process.env.PATH}` };
    knobs({ not_ready: '1.1.0' });
    expect(deploy('1.1.0', { extraEnv: sameSecond }).result).toMatchObject({ ok: false, outcome: 'rolled_back' });
    knobs({});
    expect(deploy('1.1.0', { extraEnv: sameSecond, args: ['--retry-failed'] }).result).toMatchObject({ ok: true, outcome: 'deployed' });
    expect(backups()).toHaveLength(2);
    expect(readdirSync(join(box, 'logs')).filter((f) => f.endsWith('.log'))).toHaveLength(2);
    const dirs = readdirSync(join(box, 'releases'));
    expect(dirs.filter((d) => d.startsWith('failed-'))).toHaveLength(1);
    expect(dirs.filter((d) => d.startsWith('prev-'))).toHaveLength(1);
    // nothing was moved INTO another release directory
    for (const d of dirs) expect(readdirSync(join(box, 'releases', d)).some((f) => f.startsWith('prev-') || f.startsWith('failed-') || f === 'app')).toBe(false);
  });

  it('a git step that fails is never a success: each one ends with an explicit failure and changes nothing', () => {
    const unchanged = () => {
      expect(head()).toBe(releases['1.0.0']);
      expect(running()).toMatchObject({ version: '1.0.0' });
      expect(backups()).toEqual([]);
      expect(readdirSync(join(box, 'releases'))).toEqual([]);
    };
    const failed = (r: ReturnType<typeof deploy>, outcome: string, message: RegExp) => {
      expect(r.code).not.toBe(0);
      expect(r.result).toMatchObject({ ok: false, outcome, message: expect.stringMatching(message) });
      unchanged();
    };
    const retry = { TB_BUILD_RETRY_SECONDS: '0' };
    // fetching the tag: GitHub unreachable, or the tag is not there
    failed(deploy('1.1.0', { extraEnv: { ...retry, TB_ORIGIN: join(box, 'no-such-repo.git') } }), 'build_failed', /could not fetch v1\.1\.0/);
    failed(deploy('1.4.0', { sha: releases['1.1.0'], extraEnv: retry }), 'build_failed', /could not fetch v1\.4\.0/);
    // verifying the commit: the tag points elsewhere
    failed(deploy('1.1.0', { sha: releases['1.2.0'], extraEnv: retry }), 'refused', /points at .*not .*tags never move/);
    // reading the running commit: git cannot read the checkout
    const headFile = join(box, 'app', '.git', 'HEAD');
    const original = readFileSync(headFile, 'utf8');
    writeFileSync(headFile, 'ref: refs/heads/no-such-branch\n');
    const r = deploy('1.1.0', { extraEnv: retry });
    writeFileSync(headFile, original);
    failed(r, 'refused', /cannot read the running commit/);
    // and it is not the "already running" success either, even when the server reports the same version
    expect(r.result.ok).toBe(false);
  });

  it('git on the running checkout: only through app_git, only reads, never a wildcard or a stored exception', () => {
    const raw = readFileSync(SCRIPT, 'utf8');
    expect(raw).toContain('\napp_git() { git -c safe.directory="$APP_REAL" -C "$APP_REAL" "$@"; }\n');
    // the script's commands: comments, the definition and messages (finish/say texts) left out
    const lines = raw.split('\n').filter((l) => !/^\s*#/.test(l) && !l.startsWith('app_git()'))
      .map((l) => l.replace(/(finish (true|false) [a-z_]+|say) "[^"]*"/g, '$1 ""').replace(/\/\.git\b/g, ''));
    const code = lines.join('\n');
    // every git command that names the running checkout goes through app_git, and only to read
    const onApp = lines.filter((l) => /\bgit\b/.test(l) && /\$\{?APP_(DIR|REAL)/.test(l));
    expect(onApp.filter((l) => !/app_git rev-parse /.test(l))).toEqual([]);
    expect(code.match(/app_git [a-z-]+/g)?.every((m) => m === 'app_git rev-parse')).toBe(true);
    expect(code).not.toMatch(/safe\.directory=["']?\*/);
    expect(code).not.toMatch(/\bgit\b[^\n]*\bconfig\b/); // no git config writes (global, system or local)
    expect(code).not.toMatch(/git clone[^\n]*APP_/); // the release is never copied from the running checkout
  });
});

/**
 * What AWS Systems Manager does: the deploy runs as ROOT, and /opt/tradebuddy belongs to ANOTHER user
 * (the account that set the server up). Git refuses such a checkout for root ("detected dubious
 * ownership") — the reason the first real deploy could not even start. Real ownership, real Git: these
 * run only as root (CI runs this file a second time with sudo; TB_REQUIRE_ROOT_TESTS=1 makes sure).
 */
const isRoot = process.getuid?.() === 0;
if (process.env.TB_REQUIRE_ROOT_TESTS === '1' && !isRoot) throw new Error('TB_REQUIRE_ROOT_TESTS=1, but these tests do not run as root');

describe.runIf(isRoot)('as root through Systems Manager, on a checkout another user owns', { timeout: 120_000 }, () => {
  const OTHER = 65534; // "nobody": any account that is not root
  const app = () => join(box, 'app');
  // root's own Git configuration, to show that nothing is ever written there
  const gitConfigs = () => [join(box, 'root-home', '.gitconfig'), join(box, 'root-home', '.config', 'git', 'config'), join(box, 'etc-gitconfig')];
  const asRoot = () => ({ HOME: join(box, 'root-home'), XDG_CONFIG_HOME: join(box, 'root-home', '.config'), GIT_CONFIG_SYSTEM: join(box, 'etc-gitconfig') });
  /** every file and directory below `dir`: owner, mode, size, time — a write anywhere changes it */
  const snapshot = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        const st = lstatSync(p);
        out.push(`${relative(dir, p)} ${st.uid} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs}`);
        if (st.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out;
  };

  beforeEach(() => {
    mkdirSync(join(box, 'root-home'));
    sh(box, `chown -R ${OTHER}:${OTHER} app`);
  });

  it('the sandbox is production: plain git refuses the checkout for root, only the exact exception opens it', () => {
    const plain = spawnSync('git', ['-C', app(), 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, ...asRoot() } });
    expect(plain.status).toBe(128);
    expect(plain.stderr).toMatch(/detected dubious ownership/);
    const parent = spawnSync('git', ['-c', `safe.directory=${box}`, '-C', app(), 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, ...asRoot() } });
    expect(parent.status).toBe(128); // a parent directory is not enough: the exception is exact
    expect(head()).toBe(releases['1.0.0']);
  });

  it('deploys: reads the running commit, stages a fresh checkout of the tag owned by root, never writes the old one', () => {
    const before = snapshot(app());
    const r = deploy('1.1.0', { extraEnv: asRoot() });
    expect(r.result).toMatchObject({ ok: true, outcome: 'deployed', previousSha: releases['1.0.0'], previousVersion: '1.0.0' });
    expect(r.code).toBe(0);
    expect(head()).toBe(releases['1.1.0']);
    expect(running()).toMatchObject({ version: '1.1.0', commit: releases['1.1.0'] });
    // the new code belongs to root (the service reads it; nobody else can change it) …
    expect(statSync(app()).uid).toBe(0);
    expect(statSync(join(app(), '.git', 'objects')).uid).toBe(0);
    // … and the other user's checkout, kept for a rollback, is exactly as it was: not a byte written
    const prev = readdirSync(join(box, 'releases')).find((d) => d.startsWith('prev-'))!;
    expect(snapshot(join(box, 'releases', prev))).toEqual(before);
    expect(statSync(join(box, 'releases', prev)).uid).toBe(OTHER);
    // the exception was never stored anywhere
    for (const f of gitConfigs()) expect(existsSync(f)).toBe(false);
    expect(readFileSync(join(box, 'releases', prev, '.git', 'config'), 'utf8')).not.toMatch(/safe/);
  });

  it('the same release again is recognised on the other user\'s checkout (already running)', () => {
    knobs({});
    expect(deploy('1.0.0', { extraEnv: asRoot() }).result).toMatchObject({ ok: true, outcome: 'already', previousSha: releases['1.0.0'] });
  });

  it('a rollback brings the other user\'s checkout back; the next deploy still works on it', () => {
    knobs({ not_ready: '1.1.0' });
    const r = deploy('1.1.0', { extraEnv: asRoot() });
    expect(r.result).toMatchObject({ ok: false, outcome: 'rolled_back' });
    expect(statSync(app()).uid).toBe(OTHER);
    expect(head()).toBe(releases['1.0.0']);
    expect(running()).toMatchObject({ version: '1.0.0' });
    knobs({});
    expect(deploy('1.1.0', { extraEnv: asRoot(), args: ['--retry-failed'] }).result).toMatchObject({ ok: true, outcome: 'deployed', previousSha: releases['1.0.0'] });
    expect(head()).toBe(releases['1.1.0']);
    for (const f of gitConfigs()) expect(existsSync(f)).toBe(false);
  });

  it('a moved tag is still refused, and nothing is written to the other user\'s checkout', () => {
    const before = snapshot(app());
    const r = deploy('1.1.0', { sha: releases['1.2.0'], extraEnv: asRoot() });
    expect(r.result).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/tags never move/) });
    expect(snapshot(app())).toEqual(before);
    expect(running()).toMatchObject({ version: '1.0.0' });
  });
});
