#!/usr/bin/env node
/**
 * The release gate (CI on every pull request and push to main; the tagger after CI passed on main).
 *
 *   node scripts/release/gate.mjs                 # check: is this commit a valid release, or no release?
 *   node scripts/release/gate.mjs --tag <sha>     # main only: is <sha> a new release? → GITHUB_OUTPUT tag=v… create=true
 *
 * A commit IS a release when package.json's version is newer than the newest v* tag. Then:
 * release-notes/<version>.txt must be finished (1–12 short lines), package-lock.json must carry the
 * same version, and the version may only go up. A commit with the same version as the newest tag is an
 * ordinary change (no release). Needs the tags (actions/checkout with fetch-depth: 0).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareVersions, newestReleaseTag, parseReleaseNotes, parseVersion, tagOf, versionCode, versionOfTag } from './lib.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (m) => {
  console.log(`::error::release gate: ${m}`);
  process.exit(1);
};
const out = (k, v) => {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};

const tagMode = process.argv[2] === '--tag';
const sha = tagMode ? process.argv[3] : git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail('give the full commit SHA');

const show = (path) => {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], { cwd: root, encoding: 'utf8' });
  } catch {
    return null;
  }
};
const pkg = JSON.parse(show('package.json') ?? '{}');
const lock = JSON.parse(show('package-lock.json') ?? '{}');
const version = pkg.version;
if (!parseVersion(version)) fail(`package.json version "${version}" is not x.y.z (y and z below 100)`);
if (lock.version !== version || lock.packages?.['']?.version !== version) fail(`package-lock.json says ${lock.version}, package.json says ${version} — run: npm install --package-lock-only --ignore-scripts`);

const tags = git('tag', '-l', 'v*').split('\n').filter(Boolean);
const newest = newestReleaseTag(tags);
const newestVersion = newest ? versionOfTag(newest) : null;
console.log(`version ${version} (versionCode ${versionCode(version)}), newest release tag ${newest ?? 'none'}`);

if (newestVersion && compareVersions(version, newestVersion) < 0) fail(`the version went backwards: ${version} < ${newestVersion}`);
const isRelease = !newestVersion || compareVersions(version, newestVersion) > 0;
if (!isRelease) {
  // the same version as the newest tag: an ordinary change, not a release
  if (tags.includes(tagOf(version)) && tagMode) {
    const at = git('rev-list', '-n', '1', tagOf(version));
    console.log(`${tagOf(version)} already exists (${at.slice(0, 7)}): nothing to tag`);
  }
  out('release', 'false');
  out('create', 'false');
  process.exit(0);
}

const notesPath = `release-notes/${version}.txt`;
const notesText = show(notesPath);
if (notesText === null) fail(`${notesPath} is missing — write what is new in plain words (one line each)`);
const notes = parseReleaseNotes(notesText);
if (notes.problems.length) fail(`${notesPath}: ${notes.problems.join('; ')}`);
const gradle = show('android/app/build.gradle');
if (gradle === null) fail('android/app/build.gradle is missing');
if (!/parts\[0\] \* 10000 \+ parts\[1\] \* 100 \+ parts\[2\]/.test(gradle)) fail('the versionCode formula in android/app/build.gradle changed — update scripts/release/lib.mjs versionCode() with it');

console.log(`release ${tagOf(version)}: ${notes.lines.length} note line(s)`);
out('release', 'true');
out('version', version);
out('version_code', String(versionCode(version)));
out('tag', tagOf(version));
out('create', tagMode ? 'true' : 'false');
