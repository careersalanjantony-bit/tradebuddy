import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { checkForUpdate } from '../src/background/updateJobs';
import { availableUpdate, checkDue, compareVersions, CHECK_EVERY_MS, DOWNLOAD_PREFIX, isNewer, LATEST_JSON_URL, parseLatest } from '../src/update/update';

declare const __APP_VERSION__: string;

const SHA = 'a'.repeat(64);
const good = (version: string) => ({
  version,
  date: '2026-11-14',
  apk: `${DOWNLOAD_PREFIX}v${version}/TradeBuddy-${version}.apk`,
  size: 14_000_000,
  sha256: SHA,
  notes: ['Update the app from inside the app', '  ', 42, 'Safer signing key'],
});

describe('versions', () => {
  it('compares x.y.z numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.4.0', '1.4.0')).toBe(0);
    expect(compareVersions('1.4.0', '1.4.1')).toBe(-1);
    expect(isNewer('1.5.0', '1.4.9')).toBe(true);
    expect(isNewer('1.4.0', '1.4.0')).toBe(false);
    expect(isNewer('2.0', '1.0.0')).toBe(false); // not x.y.z: never offered
  });
});

describe('latest.json', () => {
  it('reads a correct description and drops empty or odd notes', () => {
    const u = parseLatest(good('1.5.0'))!;
    expect(u.version).toBe('1.5.0');
    expect(u.apkUrl).toBe('https://github.com/careersalanjantony-bit/tradebuddy/releases/download/v1.5.0/TradeBuddy-1.5.0.apk');
    expect(u.notes).toEqual(['Update the app from inside the app', 'Safer signing key']);
  });

  it('refuses a file from anywhere else, for another version, or without a check number', () => {
    expect(parseLatest({ ...good('1.5.0'), apk: 'https://evil.example/TradeBuddy-1.5.0.apk' })).toBeNull();
    expect(parseLatest({ ...good('1.5.0'), apk: `${DOWNLOAD_PREFIX}v1.4.0/TradeBuddy-1.4.0.apk` })).toBeNull();
    expect(parseLatest({ ...good('1.5.0'), apk: 'https://github.com/someone-else/tradebuddy/releases/download/v1.5.0/TradeBuddy-1.5.0.apk' })).toBeNull();
    expect(parseLatest({ ...good('1.5.0'), sha256: 'abc' })).toBeNull();
    expect(parseLatest({ ...good('1.5.0'), size: 0 })).toBeNull();
    expect(parseLatest({ ...good('1.5.0'), size: 500 * 1024 * 1024 })).toBeNull();
    expect(parseLatest({ ...good('1.5.0'), version: '1.5' })).toBeNull();
    expect(parseLatest(null)).toBeNull();
    expect(parseLatest('nope')).toBeNull();
  });

  it('checks every 6 hours, or at once on "Check now"', () => {
    const now = Date.UTC(2026, 10, 14, 6);
    expect(checkDue(null, now)).toBe(true);
    expect(checkDue({ checkedAt: now - 1000, latest: null }, now)).toBe(false);
    expect(checkDue({ checkedAt: now - 1000, latest: null }, now, true)).toBe(true);
    expect(checkDue({ checkedAt: now - CHECK_EVERY_MS, latest: null }, now)).toBe(true);
    expect(checkDue({ checkedAt: now + 3600_000, latest: null }, now)).toBe(true); // phone clock went back
  });

  it('offers only a newer version than the one installed', () => {
    const u = parseLatest(good('1.5.0'))!;
    expect(availableUpdate({ checkedAt: 1, latest: u }, '1.4.0')?.version).toBe('1.5.0');
    expect(availableUpdate({ checkedAt: 1, latest: u }, '1.5.0')).toBeNull();
    expect(availableUpdate({ checkedAt: 1, latest: u }, '1.6.0')).toBeNull();
    expect(availableUpdate(null, '1.4.0')).toBeNull();
  });
});

describe('checking for updates', () => {
  let chrome: ReturnType<typeof installChromeMock>;
  let reply: () => Response;
  const urls: string[] = [];
  const bump = (v: string, d: number) => v.split('.').map((x, i) => (i === 2 ? Number(x) + d : x)).join('.');

  beforeEach(() => {
    chrome = installChromeMock();
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        urls.push(String(input));
        return reply();
      }),
    );
  });

  it('stores a newer version and sends one notification for it', async () => {
    const next = bump(__APP_VERSION__, 1);
    reply = () => new Response(JSON.stringify(good(next)), { status: 200 });
    const now = Date.now();
    const s = await checkForUpdate(now, true);
    expect(urls[0]!.startsWith(LATEST_JSON_URL)).toBe(true);
    expect(s.latest?.version).toBe(next);
    expect(s.notified).toBe(next);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    expect(String(chrome.notifications.create.mock.calls[0]![1].title)).toBe(`TradeBuddy ${next} is ready`);
    // checking again: no second notification for the same version
    await checkForUpdate(now + 1000, true);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    // not due yet: no request at all
    await checkForUpdate(now + 2000);
    expect(urls).toHaveLength(2);
  });

  it('says nothing when the newest release is the installed version', async () => {
    reply = () => new Response(JSON.stringify(good(__APP_VERSION__)), { status: 200 });
    const s = await checkForUpdate(Date.now(), true);
    expect(s.latest?.version).toBe(__APP_VERSION__);
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('no release yet (404) is not a problem; a bad answer is kept as a plain message', async () => {
    reply = () => new Response('Not Found', { status: 404 });
    expect((await checkForUpdate(Date.now(), true)).error).toBeUndefined();
    reply = () => new Response(JSON.stringify({ version: '9.9.9', apk: 'https://evil.example/x.apk' }), { status: 200 });
    const s = await checkForUpdate(Date.now(), true);
    expect(s.error).toMatch(/Could not check for updates/);
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });
});
