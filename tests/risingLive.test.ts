import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { resetScanList } from '../src/background/scanList';
import { resetRising, risingIdle, scanRising } from '../src/background/risingJobs';
import { RISE_VERSION, RISE_FEATURES, type RiseModel } from '../src/rising/momentum';
import { newWallet, placeOrder } from '../src/wallet/wallet';
import { getDb } from '../src/storage/db';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { istEpoch } from '../src/lib/time';
import type { SessionStore } from '../src/storage/session';

const DAY = '2026-11-16'; // Monday
const at = (hhmm: string, s = 0) => istEpoch(DAY, hhmm, s);
const A = 'NSE_EQ|INE000AAA011';
const member = { isin: 'INE000AAA011', symbol: 'AAA', name: 'AAA Ltd', industry: '' };
const empty = { members: [], source: 'nse' as const, fetchedAt: 0 };

/** today's finished 5-minute candles: flat open, then a push with heavy volume */
const CANDLES: Array<[string, number, number, number, number, number]> = [
  ['09:15', 100, 100.2, 99.9, 100, 1000],
  ['09:20', 100, 100.2, 99.9, 100.1, 1000],
  ['09:25', 100.1, 100.3, 100, 100.2, 1000],
  ['09:30', 100.2, 100.8, 100.2, 100.7, 4000],
  ['09:35', 100.7, 101.2, 100.6, 101.1, 4000],
  ['09:40', 101.1, 101.6, 101, 101.5, 4000],
];

/** a model that answers 0.5 for everything, with "likely" from 0.4 (to test the plumbing, not the maths) */
const MODEL: RiseModel = {
  version: RISE_VERSION,
  model: { scaler: { mean: RISE_FEATURES.map(() => 0), std: RISE_FEATURES.map(() => 1) }, logistic: { w: RISE_FEATURES.map(() => 0), b: 0 }, boosted: { base: 0, lr: 0.1, trees: [] } },
  report: {
    version: RISE_VERSION,
    at: 1,
    trainDays: 20,
    testDays: 9,
    testFrom: '2026-10-20',
    testTo: '2026-11-13',
    samples: 5000,
    base: { n: 1000, win: 0.3, avgNetPct: -0.05 },
    auc: 0.62,
    bands: [{ lo: 0, hi: 1, n: 1000, win: 0.62, avgNetPct: 0.12 }],
    strongFrom: 0.4,
    fadeTo: -1,
    old: { n: 300, win: 0.28, avgNetPct: -0.08 },
    strong: { n: 200, win: 0.62, avgNetPct: 0.12 },
    early: null,
    importance: [],
  },
};

let chrome: ReturnType<typeof installChromeMock>;
const titles = () => chrome.notifications.create.mock.calls.map((c) => String(c[1].title));
const quote = async (ltp: number, when: number, vwap = 100.9) => {
  await chrome.storage.session.set({ quotes: { [A]: { key: A, ltp, open: 100, high: Math.max(101.6, ltp), low: 99.9, volume: 20_000, prevClose: 99.8, fetchedAt: when, vwap } } });
};

beforeEach(async () => {
  chrome = installChromeMock();
  resetScanList();
  resetRising();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dayTrade.enabled = true;
  // a practice holding of AAA bought at ₹100.50
  const w0 = newWallet(at('09:35'), 1_000_000);
  const r = placeOrder(w0, { key: A, symbol: 'AAA', side: 'buy', qty: 100, type: 'market', product: 'intraday', marginPct: 1, sellByClose: true }, { ltp: 100.3, prevClose: 99.8, fetchedAt: at('09:35') }, { now: at('09:35'), today: DAY, t: 575, open: true });
  if (!r.ok) throw new Error('no fill');
  await chrome.storage.local.set({
    settings,
    watchlist: [],
    wallet: r.wallet,
    marketCalendar: null,
    auth: { status: 'logged_out' },
    secrets: { upstoxAnalyticsToken: 'analytics-test-token' },
    scanLists: { at: Date.now(), lists: { nifty50: { members: [member], source: 'nse', fetchedAt: 0 }, nifty100: empty, midcap100: empty, smallcap100: empty, nifty500: empty } },
    riseModel: null,
  });
  const db = await getDb();
  await db.clear('instruments');
  await db.put('instruments', { instrument_key: A, trading_symbol: 'AAA', name: 'AAA', isin: 'INE000AAA011', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
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

describe('Rising now, live', () => {
  it('lists a rising stock the moment its candles are in; without a model it is never "likely"', async () => {
    await quote(101.6, at('09:46'));
    await scanRising(at('09:46'));
    await risingIdle();
    await quote(101.7, at('09:46', 3));
    expect(await scanRising(at('09:46', 3))).toBe(1);
    const rise = (await chrome.storage.session.get('rise')).rise as SessionStore['rise'];
    const row = rise.rows[0]!;
    expect(row).toMatchObject({ key: A, symbol: 'AAA', index: 'Nifty 50', tag: 'unclear', chance: null });
    expect(row.plan).toMatchObject({ entry: 101.7, target: 102.35, stop: 101.25 });
    expect(row.reasons.join(' ')).toMatch(/usual volume|last 15 minutes/);
    // the stock you hold: unclear → keep a tight stop
    expect(rise.held[0]).toMatchObject({ key: A, source: 'practice', qty: 100, action: 'protect' });
    expect(titles().some((t) => /likely to keep rising/.test(t))).toBe(false);
  });

  it('with the learned check: "likely to keep rising" → one alert (with a quick-trade plan), then keep advice', async () => {
    await chrome.storage.local.set({ riseModel: MODEL });
    await quote(101.6, at('09:46'));
    await scanRising(at('09:46'));
    await risingIdle();
    await quote(101.7, at('09:46', 3));
    await scanRising(at('09:46', 3));
    const rise = (await chrome.storage.session.get('rise')).rise as SessionStore['rise'];
    expect(rise.rows[0]).toMatchObject({ tag: 'strong', chance: 0.5, measured: 0.62 });
    expect(rise.rows[0]!.since).toBe(at('09:46', 3));
    expect(rise.held[0]).toMatchObject({ action: 'keep' });
    expect(rise.held[0]!.text).toMatch(/Likely to keep rising — keep, sell if it drops to ₹/);
    const alerts = titles().filter((t) => /AAA likely to keep rising · rose further 62 of 100 times/.test(t));
    expect(alerts).toHaveLength(1);
    // once a day per stock
    await quote(101.8, at('09:47'));
    await scanRising(at('09:47'));
    expect(titles().filter((t) => /likely to keep rising/.test(t))).toHaveLength(1);
  });

  it('v1.16.2: the suggestion is written down with its price 15 and 30 minutes later (the app’s own record)', async () => {
    await chrome.storage.local.set({ riseModel: MODEL });
    await quote(101.6, at('09:46'));
    await scanRising(at('09:46'));
    await risingIdle();
    await quote(101.7, at('09:46', 3));
    await scanRising(at('09:46', 3));
    await quote(101.2, at('10:01', 5));
    await scanRising(at('10:01', 5));
    const rec = (await chrome.storage.local.get('riseRecord')).riseRecord as Array<{ date: string; items: Array<{ symbol: string; price: number; p15: number | null; p30: number | null }> }>;
    expect(rec).toHaveLength(1);
    expect(rec[0]!.items).toEqual([expect.objectContaining({ symbol: 'AAA', price: 101.7, p15: 101.2, p30: null })]);
  });

  it('v1.16.2: no buy suggestion and no alert while NIFTY falls 0.5%+ — but the advice for a stock you hold stays', async () => {
    await chrome.storage.local.set({ riseModel: MODEL });
    const withNifty = async (ltp: number, when: number) => {
      await quote(ltp, when);
      const q = (await chrome.storage.session.get('quotes')).quotes as Record<string, unknown>;
      await chrome.storage.session.set({ quotes: { ...q, 'NSE_INDEX|Nifty 50': { key: 'NSE_INDEX|Nifty 50', ltp: 25_220, open: 25_300, high: 25_350, low: 25_200, volume: null, prevClose: 25_387, fetchedAt: when } } });
    };
    await withNifty(101.6, at('09:46'));
    await scanRising(at('09:46'));
    await risingIdle();
    await withNifty(101.7, at('09:46', 3));
    await scanRising(at('09:46', 3));
    const rise = (await chrome.storage.session.get('rise')).rise as SessionStore['rise'];
    expect(rise.weak).toEqual({ weak: true, text: 'NIFTY 50 −0.66% today' });
    expect(rise.rows[0]).toMatchObject({ tag: 'unclear', since: null });
    expect(rise.rows[0]!.reasons[0]).toBe('market falling (NIFTY 50 −0.66% today) — no buy');
    expect(rise.held[0]).toMatchObject({ action: 'keep' });
    expect(titles().some((t) => /likely to keep rising/.test(t))).toBe(false);
    expect((await chrome.storage.local.get('riseRecord')).riseRecord ?? null).toBeNull();
  });

  it('a stock you hold falling below the day average: "slowing — take the profit" alert', async () => {
    await quote(101.6, at('09:46'));
    await scanRising(at('09:46'));
    await risingIdle();
    await quote(100.6, at('09:46', 3), 101.0); // below the day's average price
    await scanRising(at('09:46', 3));
    const rise = (await chrome.storage.session.get('rise')).rise as SessionStore['rise'];
    expect(rise.held[0]).toMatchObject({ action: 'sell', tag: 'fading' });
    expect(titles().some((t) => /⚠ AAA: Slowing — take the profit/.test(t))).toBe(true);
    expect(rise.rows).toHaveLength(0); // no longer a rising stock
  });

  it('nothing outside market hours', async () => {
    await quote(101.6, at('08:30'));
    expect(await scanRising(at('08:30'))).toBe(0);
  });
});

describe('learning from the stored 5-minute history', () => {
  /** pushes with volume keep going, pushes without fade (as in tests/rising.test.ts) */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
      return (s >>> 8) / 2 ** 24;
    };
  }
  function synth(r: () => number) {
    const t: number[] = [];
    const o: number[] = [];
    const h: number[] = [];
    const l: number[] = [];
    const c: number[] = [];
    const v: number[] = [];
    let p = 100;
    let push = 0;
    for (let i = 0; i < 75; i++) {
      let vol = 1000 * (0.7 + 0.6 * r());
      if (push === 0 && r() < 0.06) push = r() < 0.5 ? 4 : -3;
      let d = (r() - 0.5) * 0.25;
      if (push > 0) {
        d += 0.3;
        vol *= 3.5;
        push--;
      } else if (push < 0) {
        d += push === -3 ? 0.35 : -0.25;
        push++;
      }
      const cl = p * (1 + d / 100);
      t.push(555 + i * 5);
      o.push(p);
      h.push(Math.max(p, cl) * 1.0005);
      l.push(Math.min(p, cl) * 0.9995);
      c.push(cl);
      v.push(Math.round(vol));
      p = cl;
    }
    return { t, o, h, l, c, v };
  }

  it('learns once (newest days kept aside for the test), keeps the model, and is used by the live list', async () => {
    const { trainRising } = await import('../src/background/risingJobs');
    const r = rng(3);
    const keys = Array.from({ length: 25 }, (_, i) => `NSE_EQ|INE${String(i).padStart(6, '0')}A01`);
    await chrome.storage.local.set({ scanLists: { at: Date.now(), lists: { nifty50: { members: keys.map((k) => ({ isin: k.slice(7), symbol: k.slice(7), name: '', industry: '' })), source: 'nse', fetchedAt: 0 }, nifty100: empty, midcap100: empty, smallcap100: empty, nifty500: empty } } });
    resetScanList();
    const db = await getDb();
    await db.clear('intraday');
    for (const k of keys) for (let d = 1; d <= 24; d++) await db.put('intraday', { key: k, date: `2026-10-${String(d).padStart(2, '0')}`, ...synth(r) });
    const m = (await trainRising(at('16:00'), true))!;
    expect(m).not.toBeNull();
    expect(m.report.trainDays + m.report.testDays).toBe(21);
    expect(m.report.strongFrom).not.toBeNull();
    expect(m.report.strong!.win).toBeGreaterThan(m.report.base.win);
    const stored = (await chrome.storage.local.get('riseModel')).riseModel as RiseModel;
    expect(stored.report.at).toBe(at('16:00'));
    // a day later it is not learned again during market hours unless asked
    expect((await trainRising(at('16:05')))!.report.at).toBe(at('16:00'));
  });
});
