#!/usr/bin/env node
/**
 * Publishes a verified, signed APK to the `updates` branch, so phones offer "Update now" (the last step
 * of the release pipeline — only after the checks and the server deploy succeeded).
 *
 *   UPDATES_TOKEN=… node scripts/release/publish-updates.mjs --apk <file> --version 1.23.0 --sha <commit> [--remote <url>] [--dry-run]
 *
 * Run in a checkout of the release commit (the notes come from release-notes/<version>.txt at --sha).
 * - one commit with the APK, latest.json and a README (the branch only ever holds the newest version),
 *   so latest.json never points at a file that is not there;
 * - never an older or equal version (the same version with the same APK = already published: success);
 * - pushed with --force-with-lease on the commit read just before: a concurrent publish fails instead
 *   of being overwritten; read back after the push;
 * - the token goes to git through the environment (never on a command line or in the output).
 * Prints `TB_PUBLISH_RESULT {json}` as its last line.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLatest, compareVersions, istDate, parseReleaseNotes, parseVersion, REPO, UPDATES_BRANCH } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const result = (o) => {
  console.log(`TB_PUBLISH_RESULT ${JSON.stringify(o)}`);
  process.exit(o.ok ? 0 : 1);
};
const fail = (message, extra = {}) => result({ ok: false, message, ...extra });

const apk = opt('apk');
const version = opt('version');
const sha = opt('sha');
const remote = opt('remote') ?? `https://github.com/${REPO}.git`;
const dryRun = args.includes('--dry-run');
const now = Number(opt('now') ?? Date.now());
if (!apk || !existsSync(apk)) fail(`APK not found: ${apk}`);
if (!parseVersion(version ?? '')) fail(`--version must be x.y.z, got ${version}`);
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail('--sha must be the full release commit');

// the token (if any) reaches git only through its environment
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
if (process.env.UPDATES_TOKEN && remote.startsWith('https://')) {
  const basic = Buffer.from(`x-access-token:${process.env.UPDATES_TOKEN}`).toString('base64');
  Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
}
delete env.UPDATES_TOKEN;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// the notes, exactly as reviewed in the release commit
let notesText;
try {
  notesText = execFileSync('git', ['show', `${sha}:release-notes/${version}.txt`], { encoding: 'utf8' });
} catch {
  fail(`release-notes/${version}.txt is not in commit ${sha.slice(0, 7)}`);
}
const notes = parseReleaseNotes(notesText);
if (notes.problems.length) fail(`release notes: ${notes.problems.join('; ')}`);

const bytes = readFileSync(apk);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const apkName = `TradeBuddy-${version}.apk`;
const latest = buildLatest({ version, date: istDate(now), size: statSync(apk).size, sha256, notes: notes.lines, commit: sha });

const dir = mkdtempSync(join(tmpdir(), 'tb-publish-'));
try {
  git(dir, 'init', '-q', '-b', UPDATES_BRANCH);
  // what is published now (the lease: the push only succeeds if the branch is still exactly this)
  const current = git(dir, 'ls-remote', remote, `refs/heads/${UPDATES_BRANCH}`).split('\t')[0] || '';
  let currentVersion = null;
  if (current) {
    git(dir, 'fetch', '-q', '--depth', '1', remote, `refs/heads/${UPDATES_BRANCH}`);
    const cur = JSON.parse(git(dir, 'show', 'FETCH_HEAD:latest.json'));
    currentVersion = cur.version;
    if (parseVersion(currentVersion ?? '') && compareVersions(version, currentVersion) <= 0) {
      if (currentVersion === version && cur.sha256 === sha256) result({ ok: true, outcome: 'already-published', version, sha256, commit: current });
      fail(`the updates branch already offers ${currentVersion}; ${version} is not newer (never published)`, { currentVersion });
    }
  }
  copyFileSync(apk, join(dir, apkName));
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(
    join(dir, 'README.md'),
    [
      `# TradeBuddy ${version} (${latest.date})`,
      '',
      'This branch only holds the newest TradeBuddy app file, for updates from inside the app.',
      '',
      "## What's new",
      '',
      ...notes.lines.map((n) => `- ${n}`),
      '',
      '## How to update',
      '',
      '- **In TradeBuddy:** tap **Update now** on Home (or Me → App updates → Check now). Your practice money, settings and login stay.',
      `- **Without the app:** open [${apkName}](${apkName}) on the phone → **View raw** to download → open the file → Install.`,
      '',
      `SHA-256 of the app file: \`${sha256}\` · built from commit \`${sha.slice(0, 7)}\` (tag \`v${version}\`) by the release pipeline.`,
      '',
    ].join('\n'),
  );
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=TradeBuddy release', '-c', 'user.email=noreply@users.noreply.github.com', 'commit', '-q', '-m', `TradeBuddy ${version}: app file for in-app updates\n\nBuilt from ${sha} (tag v${version}) by the release pipeline.`);
  const commit = git(dir, 'rev-parse', 'HEAD');
  if (dryRun) result({ ok: true, outcome: 'dry-run', version, sha256, size: latest.size, commit, replaces: currentVersion, latest });
  try {
    git(dir, 'push', '-q', `--force-with-lease=refs/heads/${UPDATES_BRANCH}:${current}`, remote, `HEAD:refs/heads/${UPDATES_BRANCH}`);
  } catch (err) {
    fail(`push refused (someone else published at the same time, or no permission): ${String(err.stderr ?? err.message).split('\n')[0].slice(0, 200)}`);
  }
  const after = git(dir, 'ls-remote', remote, `refs/heads/${UPDATES_BRANCH}`).split('\t')[0];
  if (after !== commit) fail(`after the push the branch is ${after.slice(0, 7)}, expected ${commit.slice(0, 7)}`);
  result({ ok: true, outcome: 'published', version, sha256, size: latest.size, commit, replaces: currentVersion });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
