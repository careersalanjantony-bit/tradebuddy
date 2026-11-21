import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as lib from '../../scripts/release/lib.mjs';
import { parseLatest, isNewer } from '../../src/update/update';

/** The release pipeline's rules and scripts: gate (CI), plan (what a release does), publish (the updates branch). */

const SCRIPTS = join(__dirname, '../../scripts/release');
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tb-release-'));
  tmp.push(d);
  return d;
};
const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};
const node = (cwd: string, script: string, args: string[], env: Record<string, string> = {}) => spawnSync('node', [join(cwd, 'scripts/release', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env } });

/** A small TradeBuddy-like repository with the release scripts, at `version`. */
function repo(): string {
  const d = dir();
  sh(d, 'git init -q -b main && git config user.email t@t && git config user.name t');
  cpSync(SCRIPTS, join(d, 'scripts/release'), { recursive: true });
  mkdirSync(join(d, 'android/app'), { recursive: true });
  writeFileSync(join(d, 'android/app/build.gradle'), 'def appVersionCode = parts[0] * 10000 + parts[1] * 100 + parts[2]\n');
  for (const p of ['src/ui', 'src/bot', 'server/src', 'release-notes', 'docs']) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, 'src/ui/Screen.tsx'), 'a');
  writeFileSync(join(d, 'src/bot/policy.ts'), 'a');
  writeFileSync(join(d, 'server/src/engine.ts'), 'a');
  return d;
}
function release(d: string, version: string, opts: { notes?: string | null; lockVersion?: string; deps?: Record<string, string>; touch?: string[]; tag?: boolean } = {}): string {
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'tradebuddy', version, dependencies: opts.deps ?? { vite: '7.3.7' } }, null, 2));
  const lv = opts.lockVersion ?? version;
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ name: 'tradebuddy', version: lv, lockfileVersion: 3, packages: { '': { name: 'tradebuddy', version: lv, dependencies: opts.deps ?? { vite: '7.3.7' } } } }, null, 2));
  if (opts.notes !== null) writeFileSync(join(d, `release-notes/${version}.txt`), opts.notes ?? `New in ${version}: something useful.\nNot a guarantee.\n`);
  for (const f of opts.touch ?? []) writeFileSync(join(d, f), `${version}-${Math.random()}`);
  sh(d, `git add -A && git commit -q -m "release ${version}"`);
  if (opts.tag !== false) sh(d, `git tag -a v${version} -m v${version}`);
  return sh(d, 'git rev-parse HEAD');
}

describe('versions and what a change touches', () => {
  it('versions only go up; versionCode exactly as android/app/build.gradle; tags v1.2.3 only', () => {
    expect(lib.compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(lib.versionCode('1.22.0')).toBe(12200);
    expect(lib.versionCode('2.0.15')).toBe(20015);
    expect(lib.parseVersion('1.100.0')).toBeNull(); // would collide with 2.0.0's versionCode
    expect(lib.newestReleaseTag(['m5-cloudbot-rc1', 'v1.9.0', 'v1.10.0', 'v1.2.0', 'vX'])).toBe('v1.10.0');
    expect(lib.newestReleaseTag(['m4-fcm-rc1'])).toBeNull();
  });

  it('server vs app vs nothing, by path; a version bump alone deploys nothing', () => {
    expect(lib.componentsOf('server/src/engine.ts')).toEqual({ server: true, app: false });
    expect(lib.componentsOf('server/deploy/deploy-release.sh')).toEqual({ server: true, app: false });
    expect(lib.componentsOf('src/ui/components/AutoTrader.tsx')).toEqual({ server: false, app: true });
    expect(lib.componentsOf('android/app/build.gradle')).toEqual({ server: false, app: true });
    expect(lib.componentsOf('src/bot/cloud.ts')).toEqual({ server: true, app: true }); // shared code
    for (const p of ['docs/X.md', 'README.md', 'tests/a.test.ts', 'server/tests/b.test.ts', '.github/workflows/ci.yml', 'release-notes/1.0.0.txt', 'scripts/release/lib.mjs']) expect(lib.componentsOf(p)).toEqual({ server: false, app: false });
    expect(lib.componentsOf('something/new.bin')).toEqual({ server: true, app: true }); // unknown: both (safe)
    const a = '{"name":"t","version":"1.0.0","dependencies":{"vite":"7"}}';
    expect(lib.packageChanged(a, a.replace('1.0.0', '1.0.1'))).toBe(false);
    expect(lib.packageChanged(a, a.replace('"7"', '"8"'))).toBe(true);
    expect(lib.changedComponents(['package.json', 'docs/x.md'], { 'package.json': [a, a.replace('1.0.0', '1.0.1')] })).toMatchObject({ server: false, app: false });
  });

  it('release notes: finished, short, at most 12 lines', () => {
    expect(lib.parseReleaseNotes('- one\n\n• two\n').lines).toEqual(['one', 'two']);
    expect(lib.parseReleaseNotes('').problems[0]).toMatch(/empty/);
    expect(lib.parseReleaseNotes('TODO: write').problems[0]).toMatch(/not finished/);
    expect(lib.parseReleaseNotes(Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n')).problems[0]).toMatch(/at most 12/);
    expect(lib.parseReleaseNotes('x'.repeat(301)).problems[0]).toMatch(/longer than 300/);
  });
});

describe('the plan: what a release does, in which order', () => {
  const plan = lib.planRelease;
  it('coordinated: build the APK → deploy the server → publish the APK (a phone never gets an app before its server)', () => {
    expect(plan({ target: '1.23.0', server: '1.22.0', app: '1.22.0' })).toEqual({ target: '1.23.0', server: 'deploy', app: 'publish', kind: 'coordinated', steps: ['validate', 'build-apk', 'deploy-server', 'publish-app'] });
  });
  it('server-only and app-only', () => {
    expect(plan({ target: '1.22.1', server: '1.22.0', app: '1.22.0', changedForServer: { server: true, app: false }, changedForApp: { server: true, app: false } })).toMatchObject({ server: 'deploy', app: 'not-needed', kind: 'server-only', steps: ['validate', 'deploy-server'] });
    expect(plan({ target: '1.22.2', server: '1.22.1', app: '1.22.0', changedForServer: { server: false, app: true }, changedForApp: { server: true, app: true } })).toMatchObject({ server: 'not-needed', app: 'publish', kind: 'app-only', steps: ['validate', 'build-apk', 'publish-app'] });
  });
  it('already running / already offered: nothing; never a downgrade; unknown production = do it', () => {
    expect(plan({ target: '1.22.0', server: '1.22.0', app: '1.22.0' })).toMatchObject({ kind: 'nothing', steps: [] });
    expect(plan({ target: '1.22.0', server: '1.23.0', app: '1.22.0' })).toMatchObject({ server: 'current', app: 'current' });
    // the server after the cloud auto-trader release: 1.22.0, the updates branch still offers 1.20.2
    expect(plan({ target: '1.22.0', server: '1.22.0', app: '1.20.2' })).toMatchObject({ server: 'current', app: 'publish', kind: 'app-only' });
    expect(plan({ target: '1.23.0', server: null, app: null })).toMatchObject({ server: 'deploy', app: 'publish' });
  });
  it('market hours: Mon–Fri 09:00–15:40 IST (a deploy restarts the cloud auto-trader)', () => {
    const ist = (iso: string) => Date.parse(`${iso}+05:30`);
    expect(lib.inMarketHoursIST(ist('2026-11-23T08:59:00'))).toBe(false);
    expect(lib.inMarketHoursIST(ist('2026-11-23T09:00:00'))).toBe(true);
    expect(lib.inMarketHoursIST(ist('2026-11-23T15:39:00'))).toBe(true);
    expect(lib.inMarketHoursIST(ist('2026-11-23T15:40:00'))).toBe(false);
    expect(lib.inMarketHoursIST(ist('2026-11-21T11:00:00'))).toBe(false); // Saturday
  });
});

describe('latest.json — exactly what the app accepts', () => {
  it('the published file passes the app’s own strict check (src/update/update.ts)', () => {
    const l = lib.buildLatest({ version: '1.23.0', date: '2026-11-24', size: 16_391_342, sha256: 'a'.repeat(64), notes: ['- New: a thing', 'Not a guarantee.'], commit: 'b'.repeat(40) });
    expect(parseLatest(JSON.parse(JSON.stringify(l)))).toEqual({ version: '1.23.0', date: '2026-11-24', apkUrl: 'https://raw.githubusercontent.com/careersalanjantony-bit/tradebuddy/updates/TradeBuddy-1.23.0.apk', size: 16_391_342, sha256: 'a'.repeat(64), notes: ['New: a thing', 'Not a guarantee.'] });
    expect(isNewer('1.23.0', '1.22.0')).toBe(true);
    expect(() => lib.buildLatest({ ...l, notes: [] } as never)).toThrow(/empty/);
    expect(() => lib.buildLatest({ ...l, notes: ['x'], commit: 'short' } as never)).toThrow(/40-character/);
  });
});

describe('gate.mjs (CI on every pull request and on main)', { timeout: 60_000 }, () => {
  it('the first run with no v* tag: the current version is the baseline release', () => {
    const d = repo();
    release(d, '1.22.0', { tag: false });
    const r = node(d, 'gate.mjs', []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('release=true');
    expect(r.stdout).toContain('tag=v1.22.0');
  });
  it('same version as the newest tag = an ordinary change; a higher version = a release; lower = refused', () => {
    const d = repo();
    release(d, '1.22.0');
    writeFileSync(join(d, 'src/ui/Screen.tsx'), 'changed');
    sh(d, 'git commit -qam change');
    expect(node(d, 'gate.mjs', []).stdout).toContain('release=false');
    const sha = release(d, '1.23.0', { tag: false });
    const t = node(d, 'gate.mjs', ['--tag', sha]);
    expect(t.stdout).toContain('create=true');
    expect(t.stdout).toContain('version_code=12300');
    release(d, '1.21.9', { tag: false });
    const back = node(d, 'gate.mjs', []);
    expect(back.status).toBe(1);
    expect(back.stdout).toMatch(/went backwards: 1\.21\.9 < 1\.22\.0/);
  });
  it('a release needs finished notes and a lockfile with the same version', () => {
    const d = repo();
    release(d, '1.22.0');
    release(d, '1.23.0', { notes: null, tag: false });
    expect(node(d, 'gate.mjs', []).stdout).toMatch(/release-notes\/1\.23\.0\.txt is missing/);
    release(d, '1.23.0', { notes: 'TODO', tag: false });
    expect(node(d, 'gate.mjs', []).stdout).toMatch(/not finished/);
    release(d, '1.23.0', { lockVersion: '1.22.0', tag: false });
    expect(node(d, 'gate.mjs', []).stdout).toMatch(/package-lock\.json says 1\.22\.0/);
  });
});

describe('plan.mjs (the private release workflow)', { timeout: 60_000 }, () => {
  it('works out server-only, app-only and coordinated from the git history between tags', () => {
    const d = repo();
    release(d, '1.22.0');
    release(d, '1.22.1', { touch: ['server/src/engine.ts'] });
    release(d, '1.22.2', { touch: ['src/ui/Screen.tsx'] });
    release(d, '1.23.0', { touch: ['src/bot/policy.ts'] });
    const plan = (tag: string, s: string, a: string, extra: string[] = []) => JSON.parse(node(d, 'plan.mjs', ['--tag', tag, '--server-version', s, '--app-version', a, '--now', String(Date.parse('2026-11-23T18:00:00+05:30')), ...extra]).stdout);
    expect(plan('v1.22.1', '1.22.0', '1.22.0')).toMatchObject({ kind: 'server-only', server: 'deploy', app: 'not-needed', versionCode: 12201 });
    expect(plan('v1.22.2', '1.22.1', '1.22.0')).toMatchObject({ kind: 'app-only', server: 'not-needed', app: 'publish' }); // app since 1.22.0: only the screen changed
    expect(plan('v1.23.0', '1.22.1', '1.22.2')).toMatchObject({ kind: 'coordinated', steps: ['validate', 'build-apk', 'deploy-server', 'publish-app'] });
    // production runs something without a v* tag (the m5-cloudbot-rc1 build): everything counts as changed
    expect(plan('v1.22.1', '1.21.0', '1.21.0')).toMatchObject({ server: 'deploy', app: 'publish' });
    // a server deploy waits for the market to close
    const open = JSON.parse(node(d, 'plan.mjs', ['--tag', 'v1.23.0', '--server-version', '1.22.1', '--app-version', '1.22.2', '--now', String(Date.parse('2026-11-23T11:00:00+05:30'))]).stdout);
    expect(open).toMatchObject({ marketHours: true, defer: true });
    expect(JSON.parse(node(d, 'plan.mjs', ['--tag', 'v1.23.0', '--server-version', '1.22.1', '--app-version', '1.22.2', '--now', String(Date.parse('2026-11-23T11:00:00+05:30')), '--allow-market-hours']).stdout).defer).toBe(false);
  });
});

describe('publish-updates.mjs (the last step: the updates branch)', { timeout: 60_000 }, () => {
  /** "GitHub" with an updates branch that offers `version` */
  function remote(version: string | null): string {
    const r = join(dir(), 'remote.git');
    sh(r.replace(/remote\.git$/, ''), 'git init -q --bare remote.git');
    if (version) {
      const w = dir();
      sh(w, 'git init -q -b updates && git config user.email t@t && git config user.name t');
      writeFileSync(join(w, 'latest.json'), JSON.stringify({ version, sha256: 'c'.repeat(64) }));
      writeFileSync(join(w, `TradeBuddy-${version}.apk`), 'old apk');
      sh(w, `git add -A && git commit -q -m old && git push -q ${r} updates`);
    }
    return r;
  }
  const publish = (d: string, args: string[], env: Record<string, string> = {}) => {
    const r = node(d, 'publish-updates.mjs', args, env);
    const line = r.stdout.split('\n').find((l) => l.startsWith('TB_PUBLISH_RESULT '));
    return { code: r.status, out: r.stdout + r.stderr, result: line ? JSON.parse(line.slice(18)) : null };
  };

  it('one commit with the APK, latest.json and the README; read back after the push', () => {
    const d = repo();
    const sha = release(d, '1.23.0');
    const apk = join(d, 'app.apk');
    writeFileSync(apk, Buffer.alloc(4096, 7));
    const r = remote('1.22.0');
    const p = publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', r, '--now', String(Date.parse('2026-11-24T19:00:00+05:30'))], { UPDATES_TOKEN: 'ghs_secret_token_value' });
    expect(p.result).toMatchObject({ ok: true, outcome: 'published', version: '1.23.0', size: 4096, replaces: '1.22.0' });
    const w = dir();
    sh(w, `git clone -q -b updates ${r} .`);
    expect(sh(w, 'git ls-files').split('\n').sort()).toEqual(['README.md', 'TradeBuddy-1.23.0.apk', 'latest.json']);
    expect(sh(w, 'git rev-list --count HEAD')).toBe('1'); // the branch never grows
    const latest = JSON.parse(readFileSync(join(w, 'latest.json'), 'utf8'));
    expect(parseLatest(latest)).toMatchObject({ version: '1.23.0', size: 4096, date: '2026-11-24' });
    expect(latest.commit).toBe(sha);
    expect(p.out).not.toContain('ghs_secret_token_value');
  });

  it('never an older or the same version; the same APK again = already published (a replay is harmless)', () => {
    const d = repo();
    const sha = release(d, '1.23.0');
    const apk = join(d, 'app.apk');
    writeFileSync(apk, Buffer.alloc(100, 1));
    const r = remote('1.24.0');
    const old = publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', r]);
    expect(old.result).toMatchObject({ ok: false, currentVersion: '1.24.0' });
    expect(old.result.message).toMatch(/already offers 1\.24\.0; 1\.23\.0 is not newer/);
    const r2 = remote('1.22.0');
    expect(publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', r2]).result.outcome).toBe('published');
    expect(publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', r2]).result).toMatchObject({ ok: true, outcome: 'already-published' });
  });

  it('someone else published at the same moment: the lease refuses the push (nothing overwritten)', () => {
    const d = repo();
    const sha = release(d, '1.23.0');
    const apk = join(d, 'app.apk');
    writeFileSync(apk, Buffer.alloc(100, 1));
    const r = remote('1.22.0');
    // a git "pre-receive" on the remote that changes the branch just before our push lands = a race
    const hook = join(r, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "rejected: concurrent publish" >&2\nexit 1\n');
    spawnSync('chmod', ['+x', hook]);
    const p = publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', r]);
    expect(p.result).toMatchObject({ ok: false });
    expect(p.result.message).toMatch(/push refused/);
  });

  it('a dry run builds the exact commit and pushes nothing', () => {
    const d = repo();
    const sha = release(d, '1.23.0');
    const apk = join(d, 'app.apk');
    writeFileSync(apk, Buffer.alloc(100, 1));
    const r = remote('1.22.0');
    const before = sh(d, `git ls-remote ${r} refs/heads/updates`);
    const p = publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', r, '--dry-run']);
    expect(p.result).toMatchObject({ ok: true, outcome: 'dry-run', replaces: '1.22.0', latest: { version: '1.23.0' } });
    expect(sh(d, `git ls-remote ${r} refs/heads/updates`)).toBe(before);
  });

  it('notes that are not in the release commit are refused', () => {
    const d = repo();
    const sha = release(d, '1.23.0', { notes: null });
    const apk = join(d, 'app.apk');
    writeFileSync(apk, 'x');
    expect(publish(d, ['--apk', apk, '--version', '1.23.0', '--sha', sha, '--remote', remote(null)]).result.message).toMatch(/release-notes\/1\.23\.0\.txt is not in commit/);
  });
});
