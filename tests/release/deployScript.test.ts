import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    commit = subprocess.run(["git", "-C", app, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if info["schema"] > db_schema(): set_schema(info["schema"])   # the new server migrates on start
    save("running.json", {**info, "commit": commit})
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
  box = mkdtempSync(join(tmpdir(), 'tb-deploy-'));
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

function deploy(version: string, opts: { sha?: string; tag?: string; extraEnv?: Record<string, string>; args?: string[] } = {}) {
  const r = spawnSync('bash', [SCRIPT, '--tag', opts.tag ?? `v${version}`, '--sha', opts.sha ?? releases[version]!, '--version', version, ...(opts.args ?? [])], { env: env(opts.extraEnv), encoding: 'utf8', timeout: 60_000 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('TB_DEPLOY_RESULT '));
  const logs = readdirSync(join(box, 'logs')).map((f) => readFileSync(join(box, 'logs', f), 'utf8')).join('\n');
  return { code: r.status, out: r.stdout + r.stderr, result: line ? JSON.parse(line.slice('TB_DEPLOY_RESULT '.length)) : null, logs };
}

const running = () => (existsSync(join(box, 'running.json')) ? JSON.parse(readFileSync(join(box, 'running.json'), 'utf8')) : null);
const head = () => sh(join(box, 'app'), 'git rev-parse HEAD');
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
    expect(b).toMatch(/^deploy-\d{8}T\d{6}Z-v1\.1\.0$/);
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
    const r = deploy('1.1.0');
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
    r = deploy('1.1.0');
    expect(r.result).toMatchObject({ ok: false, outcome: 'rolled_back' });
    expect(r.result.message).toMatch(/went back in history \(version 50 -> 49\)/);
    knobs({ bot_after: { '1.1.0': { rev: 51 } } }); // it traded meanwhile: fine
    expect(deploy('1.1.0').result).toMatchObject({ ok: true, outcome: 'deployed' });
  });

  it('one deploy at a time; not enough disk space; bad arguments — all refused before anything happens', () => {
    const holder = spawnSync('bash', ['-c', `exec 9>"${join(box, 'deploy.lock')}"; flock -n 9 && bash "${SCRIPT}" --tag v1.1.0 --sha ${releases['1.1.0']} --version 1.1.0`], { env: env(), encoding: 'utf8' });
    expect(holder.stdout).toContain('"outcome": "locked"');
    expect(deploy('1.1.0', { extraEnv: { TB_MIN_FREE_MB: '999999999' } }).result).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/not enough disk space/) });
    expect(deploy('1.1.0', { tag: 'v9.9.9' }).result).toMatchObject({ ok: false, outcome: 'refused' });
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
});
