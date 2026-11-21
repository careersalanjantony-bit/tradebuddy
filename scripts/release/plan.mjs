#!/usr/bin/env node
/**
 * What a release must do (the private release workflow runs this in a checkout of the release tag,
 * with all tags fetched):
 *
 *   node scripts/release/plan.mjs --tag v1.23.0 --server-version 1.22.0 --app-version 1.22.0 [--allow-market-hours] [--now <ms>]
 *
 * --server-version: what the server reports on /healthz now; --app-version: what the updates branch
 * offers now (latest.json). Prints the plan as JSON and writes it to GITHUB_OUTPUT. Which parts changed
 * is worked out from the git history between the tag each side runs (v<server-version>, v<app-version>)
 * and the release tag; when that tag is missing or not an ancestor, the part counts as changed.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { changedComponents, inMarketHoursIST, planRelease, tagOf, versionCode, versionOfTag } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (m) => {
  console.log(`::error::release plan: ${m}`);
  process.exit(1);
};
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};

const tag = opt('tag');
const target = versionOfTag(tag ?? '');
if (!target) fail(`--tag must be a release tag like v1.23.0, got "${tag}"`);
const sha = tryGit('rev-parse', `${tag}^{commit}`);
if (!sha) fail(`tag ${tag} is not in this checkout (fetch the tags)`);
const serverVersion = opt('server-version') || null;
const appVersion = opt('app-version') || null;
const now = Number(opt('now') ?? Date.now());

/** the parts changed since the tag of `version` (null = unknown → everything counts as changed) */
function changedSince(version) {
  if (!version) return null;
  const base = tryGit('rev-parse', '--verify', '--quiet', `${tagOf(version)}^{commit}`);
  if (!base || tryGit('merge-base', '--is-ancestor', base, sha) === null) return null;
  const files = git('diff', '--name-only', base, sha).split('\n').filter(Boolean);
  const pkg = {};
  for (const f of ['package.json', 'package-lock.json']) if (files.includes(f)) pkg[f] = [tryGit('show', `${base}:${f}`), tryGit('show', `${sha}:${f}`)];
  return { base, ...changedComponents(files, pkg) };
}

const forServer = changedSince(serverVersion);
const forApp = changedSince(appVersion);
const plan = planRelease({ target, server: serverVersion, app: appVersion, changedForServer: forServer, changedForApp: forApp });
const market = inMarketHoursIST(now);
// a server deploy restarts the cloud auto-trader: never during market hours unless the owner allows it
const defer = plan.server === 'deploy' && market && !args.includes('--allow-market-hours');

const result = {
  ...plan,
  tag,
  sha,
  versionCode: versionCode(target),
  production: { server: serverVersion, app: appVersion },
  changed: { server: forServer, app: forApp },
  marketHours: market,
  defer,
};
console.log(JSON.stringify(result, null, 2));
if (process.env.GITHUB_OUTPUT) {
  const o = { tag, sha, version: target, version_code: String(result.versionCode), server: plan.server, app: plan.app, kind: plan.kind, defer: String(defer), steps: plan.steps.join(',') };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(''));
}
