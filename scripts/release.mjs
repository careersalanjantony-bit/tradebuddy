#!/usr/bin/env node
/**
 * Publishes the built app on TradeBuddy's GitHub releases page, so phones see "Update now".
 *
 *   npm run build && npx cap sync android && (cd android && ./gradlew assembleRelease)
 *   cp android/app/build/outputs/apk/release/app-release.apk release/TradeBuddy-<version>.apk
 *   node scripts/release.mjs            # version from package.json, notes from release-notes/<version>.txt
 *
 * Uploads two files to the release "v<version>": TradeBuddy-<version>.apk and latest.json
 * (version, download link, size, SHA-256, plain-words notes). The app reads latest.json of the newest
 * release. The commit must already be pushed. Uses the GitHub REST API through `gh api`.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'careersalanjantony-bit/tradebuddy';
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

const bytes = readFileSync(apk);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const notes = readFileSync(notesFile, 'utf8')
  .split('\n')
  .map((l) => l.replace(/^[-*•]\s*/, '').trim())
  .filter(Boolean);
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const latest = { version, date, apk: `https://github.com/${REPO}/releases/download/v${version}/${apkName}`, size: bytes.length, sha256, notes };
const latestPath = join(root, 'release', 'latest.json');
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n');

const gh = (args, input) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(input ? { input } : {}) }) || 'null');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const remote = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: root, encoding: 'utf8' }).split('\t')[0];
if (remote !== head) die(`push ${branch} first (remote ${remote?.slice(0, 7)} ≠ local ${head.slice(0, 7)})`);

let rel = null;
try {
  rel = gh([`repos/${REPO}/releases/tags/v${version}`]);
} catch {
  /* not there yet */
}
if (!rel) {
  const body = [
    `## What's new in ${version}`,
    '',
    ...notes.map((n) => `- ${n}`),
    '',
    '**How to update:** in TradeBuddy, tap **Update now** on Home (or Me → App updates). Your practice money, settings and login stay.',
    `First time only, or without the app: download \`${apkName}\` below on the phone and open it.`,
    '',
    `SHA-256 of the app file: \`${sha256}\``,
  ].join('\n');
  rel = gh([`repos/${REPO}/releases`, '--method', 'POST', '--input', '-'], JSON.stringify({ tag_name: `v${version}`, target_commitish: head, name: `TradeBuddy ${version}`, body, make_latest: 'true' }));
  console.log(`created release v${version} (${rel.html_url})`);
}

for (const [name, file, type] of [
  [apkName, apk, 'application/vnd.android.package-archive'],
  ['latest.json', latestPath, 'application/json'],
]) {
  const old = (rel.assets ?? []).find((a) => a.name === name);
  if (old) gh([`repos/${REPO}/releases/assets/${old.id}`, '--method', 'DELETE']);
  const up = gh([`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, '--method', 'POST', '-H', `Content-Type: ${type}`, '--input', file]);
  console.log(`uploaded ${name} (${up.size} bytes)`);
}
console.log(`done: phones will offer ${version} at their next check (every 6 hours, or Me → App updates → Check now)`);
