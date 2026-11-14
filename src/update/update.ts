/**
 * In-app updates (app v1.5). Each new version is published on the repository's `updates` branch,
 * which holds only two files: the app (`TradeBuddy-x.y.z.apk`) and `latest.json` describing it.
 * The app reads `latest.json` (a plain file download from raw.githubusercontent.com: no GitHub API,
 * so no hourly limit), and when it is newer than the installed version, offers "Update now".
 *
 * Pure functions only; the network and the Android installer live in background/updateJobs.ts and
 * platform/updater.ts.
 */

export const UPDATE_REPO = 'careersalanjantony-bit/tradebuddy';
export const UPDATE_BRANCH = 'updates';
export const DOWNLOAD_PREFIX = `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/`;
export const LATEST_JSON_URL = `${DOWNLOAD_PREFIX}latest.json`;
/** where a person (not the app) finds the newest file */
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/tree/${UPDATE_BRANCH}`;
/** how often the app looks for a new version (app v1.8: every 5 minutes; also on every start) */
export const CHECK_EVERY_MS = 5 * 60_000;
const MAX_APK_BYTES = 200 * 1024 * 1024;

export interface UpdateInfo {
  version: string;
  /** e.g. 2026-11-14 */
  date: string;
  apkUrl: string;
  size: number;
  /** SHA-256 of the APK, checked after the download */
  sha256: string;
  /** what is new, in plain words */
  notes: string[];
}

export interface UpdateState {
  checkedAt: number;
  latest: UpdateInfo | null;
  /** the version a "new version" notification was already sent for */
  notified?: string;
  /** last problem, in plain words (cleared by the next good check) */
  error?: string;
}

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** -1, 0 or 1 like a sort comparator: compareVersions('1.10.0', '1.9.2') === 1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export const isNewer = (latest: string, current: string): boolean => VERSION_RE.test(latest) && VERSION_RE.test(current) && compareVersions(latest, current) > 0;

/** Checks `latest.json` strictly; anything unexpected is ignored (no update offered). */
export function parseLatest(raw: unknown): UpdateInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === 'string' ? o.version.trim() : '';
  if (!VERSION_RE.test(version)) return null;
  const apkUrl = typeof o.apk === 'string' ? o.apk : '';
  // only this app's own updates branch, the file for exactly this version
  if (apkUrl !== `${DOWNLOAD_PREFIX}TradeBuddy-${version}.apk`) return null;
  const size = typeof o.size === 'number' && Number.isInteger(o.size) ? o.size : 0;
  if (size <= 0 || size > MAX_APK_BYTES) return null;
  const sha256 = typeof o.sha256 === 'string' ? o.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const notes = Array.isArray(o.notes) ? o.notes.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 300)).slice(0, 12) : [];
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '';
  return { version, date, apkUrl, size, sha256, notes };
}

/** Is it time to look again? (force = the "Check now" button) */
export function checkDue(state: UpdateState | null | undefined, now: number, force = false): boolean {
  if (force || !state) return true;
  return now - state.checkedAt >= CHECK_EVERY_MS || now < state.checkedAt;
}

/** The update to offer right now, if any. */
export function availableUpdate(state: UpdateState | null | undefined, current: string): UpdateInfo | null {
  const l = state?.latest;
  return l && isNewer(l.version, current) ? l : null;
}

export const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
