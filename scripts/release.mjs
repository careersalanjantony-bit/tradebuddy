#!/usr/bin/env node
/**
 * Publishes the built app so phones see "Update now".
 *
 *   npm run build && npx cap sync android && (cd android && ./gradlew assembleRelease)
 *   cp android/app/build/outputs/apk/release/app-release.apk release/TradeBuddy-<version>.apk
 *   node scripts/release.mjs            # version from package.json, notes from release-notes/<version>.txt
 *
 * The repository's `updates` branch holds only the newest version: TradeBuddy-<version>.apk,
 * latest.json (version, download link, size, SHA-256, plain-words notes) and a short README. It is
 * replaced on every release (one commit, force-pushed), so it never grows. The app reads
 * https://raw.githubusercontent.com/<repo>/updates/latest.json.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'careersalanjantony-bit/tradebuddy';
const BRANCH = 'updates';
const PREFIX = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const apkName = `TradeBuddy-${version}.apk`;
const apk = join(root, 'release', apkName);
const notesFile = join(root, 'release-notes', `${version}.txt`);

const die = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};
if (!existsSync(apk)) die(`${apk} not found — build it first`);
if (!existsSync(notesFile)) die(`${notesFile} not found — write the plain-words notes (one per line)`);

// the APK must really be this version
const aapt = '/opt/android-sdk/build-tools/36.0.0/aapt2';
if (existsSync(aapt)) {
  const badge = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' }).split('\n')[0];
  if (!badge.includes(`versionName='${version}'`)) die(`the APK is not version ${version}: ${badge}`);
}

const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
// the code for this version must be on GitHub first
const head = git(['rev-parse', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const remoteHead = git(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];
if (remoteHead !== head) die(`push ${branch} first (GitHub has ${remoteHead?.slice(0, 7)}, here ${head.slice(0, 7)})`);

const bytes = readFileSync(apk);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const notes = readFileSync(notesFile, 'utf8')
  .split('\n')
  .map((l) => l.replace(/^[-*•]\s*/, '').trim())
  .filter(Boolean);
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const latest = { version, date, apk: `${PREFIX}${apkName}`, size: bytes.length, sha256, notes, commit: head };

const dir = mkdtempSync(join(tmpdir(), 'tb-updates-'));
try {
  copyFileSync(apk, join(dir, apkName));
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  writeFileSync(
    join(dir, 'README.md'),
    [
      `# TradeBuddy ${version} (${date})`,
      '',
      'This branch only holds the newest TradeBuddy app file, for updates from inside the app.',
      '',
      "## What's new",
      '',
      ...notes.map((n) => `- ${n}`),
      '',
      '## How to update',
      '',
      '- **In TradeBuddy:** tap **Update now** on Home (or Me → App updates → Check now). Your practice money, settings and login stay.',
      `- **Without the app:** open [${apkName}](${apkName}) on the phone → **View raw** to download → open the file → Install.`,
      '',
      `SHA-256 of the app file: \`${sha256}\` · built from commit \`${head.slice(0, 7)}\` on branch \`${branch}\`.`,
      '',
    ].join('\n'),
  );
  git(['init', '-q', '-b', BRANCH], dir);
  git(['add', '-A'], dir);
  execFileSync(
    'git',
    [
      '-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '-m',
      `TradeBuddy ${version}: app file for in-app updates\n\nBuilt from ${head} (${branch}).\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014xkUegGpnukAXVUjWy6cQb`,
    ],
    { cwd: dir },
  );
  const origin = git(['remote', 'get-url', 'origin']);
  git(['push', '-q', '--force', origin, `${BRANCH}:${BRANCH}`], dir);
  console.log(`published ${apkName} (${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}…) on branch ${BRANCH}`);
  console.log(`phones offer ${version} at their next check (every 5 minutes, or Me → App updates → Check now)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
