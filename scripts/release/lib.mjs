/**
 * TradeBuddy release pipeline — the pure rules (no I/O, no dependencies), shared by the scripts in this
 * folder, the public CI workflows and the private release workflow (tradebuddy-keys). Tested in
 * tests/release/*.test.ts. See docs/RELEASE_PIPELINE.md.
 */

export const REPO = 'careersalanjantony-bit/tradebuddy';
export const UPDATES_BRANCH = 'updates';
export const DOWNLOAD_PREFIX = `https://raw.githubusercontent.com/${REPO}/${UPDATES_BRANCH}/`;
/** the same limits the app's updater applies to latest.json (src/update/update.ts) */
export const MAX_NOTES = 12;
export const MAX_NOTE_CHARS = 300;
export const MAX_APK_BYTES = 200 * 1024 * 1024;

const VERSION_RE = /^(\d{1,3})\.(\d{1,2})\.(\d{1,2})$/;

/** "1.22.0" → [1, 22, 0]; null when it is not a release version (x.y.z, y and z below 100). */
export function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 like a sort comparator. Throws on something that is not a release version. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a release version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/** Android versionCode exactly as android/app/build.gradle computes it: x·10000 + y·100 + z. */
export function versionCode(v) {
  const p = parseVersion(v);
  if (!p) throw new Error(`not a release version: ${v}`);
  return p[0] * 10_000 + p[1] * 100 + p[2];
}

export const tagOf = (version) => `v${version}`;
export const versionOfTag = (tag) => (typeof tag === 'string' && tag.startsWith('v') && parseVersion(tag.slice(1)) ? tag.slice(1) : null);

/** The newest release tag (v1.2.3) of a list; other tags (m5-cloudbot-rc1, …) are ignored. */
export function newestReleaseTag(tags) {
  const vs = tags.map(versionOfTag).filter(Boolean);
  if (!vs.length) return null;
  return tagOf(vs.sort(compareVersions).at(-1));
}

// ---------------------------------------------------------------- what a change touches

/**
 * Which parts of TradeBuddy a changed file affects. `server` = the AWS server (its bundle is built from
 * server/ AND the shared code in src/), `app` = the Android app. Unknown files count for both (a release
 * that deploys too much is safe; one that misses a part is not).
 */
export function componentsOf(path) {
  const p = path.replace(/^\.\//, '');
  const none = { server: false, app: false };
  if (/\.md$/i.test(p) || p.startsWith('docs/') || p.startsWith('release-notes/') || p === 'LICENSE') return none;
  if (p.startsWith('tests/') || p.startsWith('server/tests/') || p.startsWith('.github/') || p.startsWith('scripts/release/') || p === '.gitignore') return none;
  if (p.startsWith('server/')) return { server: true, app: false };
  if (p.startsWith('src/ui/') || p === 'src/main.tsx' || /^src\/.*\.css$/.test(p) || p === 'index.html' || p.startsWith('public/') || p.startsWith('android/') || /^capacitor\.config\./.test(p) || p === 'vite.config.ts' || p === 'tsconfig.json') {
    return { server: false, app: true };
  }
  if (p.startsWith('scripts/')) return p === 'scripts/build-apk.mjs' || p.startsWith('scripts/make-') ? { server: false, app: true } : none;
  if (p.startsWith('src/')) return { server: true, app: true };
  if (p === 'package.json' || p === 'package-lock.json') return { server: true, app: true }; // refined by packageChanged()
  return { server: true, app: true };
}

/** package.json / package-lock.json: did anything but the version change? (a version bump alone deploys nothing) */
export function packageChanged(beforeText, afterText) {
  const strip = (t) => {
    if (t === null || t === undefined) return null;
    const o = JSON.parse(t);
    delete o.version;
    if (o.packages && o.packages['']) delete o.packages[''].version;
    return JSON.stringify(o);
  };
  return strip(beforeText) !== strip(afterText);
}

/**
 * The parts changed between two commits. `files` = changed paths; `pkg` = { 'package.json': [before, after], … }
 * for the package files among them.
 */
export function changedComponents(files, pkg = {}) {
  let server = false;
  let app = false;
  const why = [];
  for (const f of files) {
    let c = componentsOf(f);
    if ((f === 'package.json' || f === 'package-lock.json') && pkg[f]) c = packageChanged(pkg[f][0], pkg[f][1]) ? { server: true, app: true } : { server: false, app: false };
    if (c.server && !server) why.push(`server: ${f}`);
    if (c.app && !app) why.push(`app: ${f}`);
    server ||= c.server;
    app ||= c.app;
  }
  return { server, app, why };
}

// ---------------------------------------------------------------- release notes

/** The plain-words notes (release-notes/<version>.txt): what the phone shows under "Update now". */
export function parseReleaseNotes(text) {
  const problems = [];
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) problems.push('the release notes are empty');
  if (lines.length > MAX_NOTES) problems.push(`at most ${MAX_NOTES} lines (the app shows no more), got ${lines.length}`);
  for (const l of lines) if (l.length > MAX_NOTE_CHARS) problems.push(`a line is longer than ${MAX_NOTE_CHARS} characters: "${l.slice(0, 40)}…"`);
  if (lines.some((l) => /\bTODO\b|\bTBD\b|lorem ipsum/i.test(l))) problems.push('the release notes are not finished (TODO / TBD)');
  return { lines, problems };
}

// ---------------------------------------------------------------- the decision

/**
 * What a release of `target` must do, given what production runs now.
 *  - server: 'deploy' | 'current' (already this version or newer) | 'not-needed' (nothing the server uses changed)
 *  - app:    'publish' | 'current' | 'not-needed'
 * `changed` = the parts changed since what each side runs (null = unknown → treated as changed).
 * The steps always run in this order: validate → build the APK → deploy the server → publish the APK,
 * so a phone is never offered an app whose server is not running yet.
 */
export function planRelease({ target, server, app, changedForServer = null, changedForApp = null }) {
  if (!parseVersion(target)) throw new Error(`not a release version: ${target}`);
  const s = server && parseVersion(server) ? (compareVersions(server, target) >= 0 ? 'current' : changedForServer && !changedForServer.server ? 'not-needed' : 'deploy') : 'deploy';
  const a = app && parseVersion(app) ? (compareVersions(app, target) >= 0 ? 'current' : changedForApp && !changedForApp.app ? 'not-needed' : 'publish') : 'publish';
  const steps = [];
  if (s === 'deploy' || a === 'publish') steps.push('validate');
  if (a === 'publish') steps.push('build-apk');
  if (s === 'deploy') steps.push('deploy-server');
  if (a === 'publish') steps.push('publish-app');
  const kind = s === 'deploy' && a === 'publish' ? 'coordinated' : s === 'deploy' ? 'server-only' : a === 'publish' ? 'app-only' : 'nothing';
  return { target, server: s, app: a, kind, steps };
}

/**
 * NSE trading hours with a margin (Mon–Fri 09:00–15:40 IST). A server deploy restarts the cloud
 * auto-trader, so it waits until after the close unless the owner allows it. Holidays count as trading
 * days here (waiting on a holiday is harmless).
 */
export function inMarketHoursIST(now) {
  const ist = new Date(now + 5.5 * 3_600_000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return m >= 9 * 60 && m < 15 * 60 + 40;
}

// ---------------------------------------------------------------- latest.json

/** The file the app reads (it accepts exactly this shape, see src/update/update.ts parseLatest). */
export function buildLatest({ version, date, size, sha256, notes, commit }) {
  if (!parseVersion(version)) throw new Error(`not a release version: ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  if (!Number.isInteger(size) || size <= 0 || size > MAX_APK_BYTES) throw new Error(`bad APK size ${size}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hex characters');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('commit must be a full 40-character SHA');
  const n = parseReleaseNotes(notes.join('\n'));
  if (n.problems.length) throw new Error(n.problems.join('; '));
  return { version, date, apk: `${DOWNLOAD_PREFIX}TradeBuddy-${version}.apk`, size, sha256, notes: n.lines, commit };
}

/** The date in India (the app shows it). */
export const istDate = (now) => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
