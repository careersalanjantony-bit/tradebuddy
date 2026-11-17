import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { resetScanList } from '../src/background/scanList';
import { resetRising, risingIdle, scanRising } from '../src/background/risingJobs';
import { getDb } from '../src/storage/db';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { addDays, istEpoch } from '../src/lib/time';
import type { SessionStore } from '../src/storage/session';

const DAY = '2026-11-16'; // Monday
const at = (hhmm: string, s = 0) => istEpoch(DAY, hhmm, s);
const A = 'NSE_EQ|INE000AAA011';
const empty = { members: [], source: 'nse' as const, fetchedAt: 0 };

/** a mixed start (high 100.6), then higher lows with heavy volume pressing under that high */
const CANDLES: Array<[string, number, number, number, number, number]> = [
  ['09:15', 100, 100.3, 99.8, 100.1, 1000],
  ['09:20', 100.1, 100.6, 99.9, 100.0, 1000],
  ['09:25', 100.0, 100.2, 99.85, 99.95, 1000],
  ['09:30', 99.95, 100.15, 99.9, 100.1, 1000],
  ['09:35', 100.1, 100.2, 99.95, 100.05, 1000],
  ['09:40', 100.05, 100.3, 100.0, 100.25, 1000],
  ['09:45', 100.25, 100.35, 100.1, 100.2, 6000],
  ['09:50', 100.2, 100.45, 100.15, 100.4, 6000],
];

let chrome: ReturnType<typeof installChromeMock>;
const titles = () => chrome.notifications.create.mock.calls.map((c) => String(c[1].title));
const quote = async (ltp: number, when: number, volume: number) => {
  await chrome.storage.session.set({ quotes: { [A]: { key: A, ltp, open: 100, high: Math.max(100.6, ltp), low: 99.8, volume, prevClose: 99.9, fetchedAt: when } } });
};

beforeEach(async () => {
  chrome = installChromeMock();
  resetScanList();
  resetRising();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dayTrade.enabled = true;
  await chrome.storage.local.set({
    settings,
    watchlist: [],
    marketCalendar: null,
    auth: { status: 'logged_out' },
    secrets: { upstoxAnalyticsToken: 'analytics-test-token' },
    scanLists: { at: Date.now(), lists: { nifty50: { members: [{ isin: 'INE000AAA011', symbol: 'AAA', name: 'AAA Ltd', industry: 'Capital Goods' }], source: 'nse', fetchedAt: 0 }, nifty100: empty, midcap100: empty, smallcap100: empty, nifty500: empty } },
  });
  const db = await getDb();
  await db.clear('instruments');
  await db.clear('intraday');
  await db.put('instruments', { instrument_key: A, trading_symbol: 'AAA', name: 'AAA Ltd', isin: 'INE000AAA011', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  // ten earlier days of 1,000 shares per 5 minutes: the "usual" volume
  for (let d = 1; d <= 10; d++) {
    const n = 75;
    await db.put('intraday', { key: A, date: addDays(DAY, -d - 1), t: Array.from({ length: n }, (_, i) => 555 + i * 5), o: Array(n).fill(100), h: Array(n).fill(100.5), l: Array(n).fill(99.5), c: Array(n).fill(100), v: Array(n).fill(1000) });
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (!/\/v3\/historical-candle\/intraday\//.test(url.pathname)) return new Response(JSON.stringify({ status: 'error', errors: [{ error_code: 'X', message: 'not mocked' }] }), { status: 404 });
      const rows = CANDLES.map(([t, o, h, l, c, v]) => [`${DAY}T${t}:00+05:30`, o, h, l, c, v, 0]).reverse();
      return new Response(JSON.stringify({ status: 'success', data: { candles: rows } }), { status: 200 });
    }),
  );
});

describe('Early Movers, live', () => {
  it('a potential setup appears, then a live breakout the moment the price crosses with volume (with an alert), sized for ₹10,000 / ₹50', async () => {
    await quote(100.45, at('09:56'), 18_000);
    await scanRising(at('09:56'));
    await risingIdle();
    await quote(100.45, at('09:56', 2), 18_000);
    await scanRising(at('09:56', 2));
    let early = (await chrome.storage.session.get('early')).early as SessionStore['early'];
    expect(early.rows[0]).toMatchObject({ key: A, symbol: 'AAA', name: 'AAA Ltd', stage: 'setup', index: 'Nifty 50', industry: 'Capital Goods', resistance: 100.6 });
    const row = early.rows[0]!;
    expect(row.plan.breakout).toBe(100.65);
    expect(row.size.ok).toBe(true);
    expect(row.size.risk).toBeLessThanOrEqual(50);
    expect(row.size.value).toBeLessThanOrEqual(10_000);
    expect(row.catalyst).toBeNull();
    expect(early).toMatchObject({ capital: 10_000, maxRisk: 50 });
    // 30 seconds later: 100.70 with 2,000 more shares traded → crosses 100.65 with volume
    await quote(100.7, at('09:56', 32), 20_000);
    await scanRising(at('09:56', 32));
    early = (await chrome.storage.session.get('early')).early as SessionStore['early'];
    expect(early.rows[0]).toMatchObject({ stage: 'breakout' });
    expect(early.rows[0]!.breakAt).toBe(at('09:56', 32));
    // bought now = at the live price: the shares are worked out from 100.70, not the 100.65 plan
    expect(early.rows[0]!.plan.entry).toBe(100.7);
    expect(early.rows[0]!.size.risk).toBeLessThanOrEqual(50);
    expect(titles().filter((t) => /AAA: breaking out \(live, not confirmed\)/.test(t))).toHaveLength(1);
  });

  it('bad news today keeps a stock out of the list', async () => {
    await chrome.storage.local.set({ catalysts: { at: at('09:00'), since: istEpoch('2026-11-13', '15:30'), asked: 1, byKey: { [A]: { kind: 'legal / trouble', tone: 'bad', score: -1, heading: 'SEBI penalty on AAA', at: at('08:00'), link: '' } } } });
    await quote(100.45, at('09:56'), 18_000);
    await scanRising(at('09:56'));
    await risingIdle();
    await quote(100.45, at('09:56', 2), 18_000);
    await scanRising(at('09:56', 2));
    const early = (await chrome.storage.session.get('early')).early as SessionStore['early'];
    expect(early.rows).toHaveLength(0);
    expect(early.badNews).toBe(1);
  });

  it('a risk limit that cannot be kept: not shown (counted)', async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.dayTrade.enabled = true;
    s.dayTrade.earlyRiskInr = 0.5; // even 1 share risks about ₹0.90 with charges
    await chrome.storage.local.set({ settings: s });
    await quote(100.45, at('09:56'), 18_000);
    await scanRising(at('09:56'));
    await risingIdle();
    await quote(100.45, at('09:56', 2), 18_000);
    await scanRising(at('09:56', 2));
    const early = (await chrome.storage.session.get('early')).early as SessionStore['early'];
    expect(early.rows).toHaveLength(0);
    expect(early.tooRisky).toBe(1);
  });
});
