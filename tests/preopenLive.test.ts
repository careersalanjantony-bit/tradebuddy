import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { resetScanList } from '../src/background/scanList';
import { resetRising, risingIdle, scanRising } from '../src/background/risingJobs';
import { preopenTick, resetPreopen } from '../src/background/preopenJobs';
import { lastCloseBefore } from '../src/early/catalyst';
import { getDb } from '../src/storage/db';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { addDays, istEpoch } from '../src/lib/time';
import type { SessionStore } from '../src/storage/session';

/**
 * App v1.16 — the pre-open rising candidates end to end, with a fake Upstox: readings from 9:00, the
 * ranking, the final top 10 at 9:13 (one alert, one record), the opening drive from 9:15 and the
 * record of the first 30 minutes. Read-only towards the broker.
 */

const DAY = '2026-11-17'; // Tuesday
const at = (hhmm: string, s = 0) => istEpoch(DAY, hhmm, s);
const K = { A: 'NSE_EQ|INE000AAA011', B: 'NSE_EQ|INE000BBB011', C: 'NSE_EQ|INE000CCC011', D: 'NSE_EQ|INE000DDD011', E: 'NSE_EQ|INE000EEE011' };
const SYM: Record<string, string> = { [K.A]: 'AAA', [K.B]: 'BBB', [K.C]: 'CCC', [K.D]: 'DDD', [K.E]: 'EEE' };
const empty = { members: [], source: 'nse' as const, fetchedAt: 0 };

/** what the pre-open auction shows now, per stock */
let auction: Record<string, { iep: number; ieq: number; buy: number; sell: number; imb?: number }> = {};
let quoteCalls = 0;
let chrome: ReturnType<typeof installChromeMock>;
const titles = () => chrome.notifications.create.mock.calls.map((c) => String(c[1].title));
const session = async <K2 extends keyof SessionStore>(k: K2) => (await chrome.storage.session.get(k))[k] as SessionStore[K2];
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  chrome = installChromeMock();
  resetScanList();
  resetRising();
  resetPreopen();
  quoteCalls = 0;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dayTrade.enabled = true;
  const member = (s: string, industry: string) => ({ isin: `INE000${s}011`, symbol: s, name: `${s} Ltd`, industry });
  await chrome.storage.local.set({
    settings,
    watchlist: [],
    marketCalendar: null,
    auth: { status: 'logged_out' },
    secrets: { upstoxAnalyticsToken: 'analytics-test-token' },
    scanLists: { at: Date.now(), lists: { nifty50: { members: [member('AAA', 'IT'), member('BBB', 'IT'), member('CCC', 'IT'), member('DDD', 'Bank'), member('EEE', 'IT')], source: 'nse', fetchedAt: 0 }, nifty100: empty, midcap100: empty, smallcap100: empty, nifty500: empty } },
    // Upstox news, already read for every stock: results for AAA, trouble for CCC
    catalysts: {
      at: at('08:30'),
      since: lastCloseBefore(at('09:00')),
      asked: 5,
      byKey: {
        [K.A]: { kind: 'results', tone: 'good', score: 2, heading: 'AAA Q2 net profit jumps 40%', at: at('08:10'), link: '' },
        [K.C]: { kind: 'legal / trouble', tone: 'bad', score: -2, heading: 'CCC faces probe', at: at('08:20'), link: '' },
      },
    },
  });
  const db = await getDb();
  await db.clear('instruments');
  await db.clear('intraday');
  for (const [k, s] of Object.entries(SYM)) {
    await db.put('instruments', { instrument_key: k, trading_symbol: s, name: `${s} Ltd`, isin: k.slice(7), tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
    // ten earlier days of 1,000 shares per 5 minutes; AAA traded twice as much yesterday
    for (let d = 1; d <= 10; d++) {
      const n = 75;
      const v = s === 'AAA' && d === 1 ? 2000 : 1000;
      await db.put('intraday', { key: k, date: addDays(DAY, -d), t: Array.from({ length: n }, (_, i) => 555 + i * 5), o: Array(n).fill(100), h: Array(n).fill(100.5), l: Array(n).fill(99.5), c: Array(n).fill(100), v: Array(n).fill(v) });
    }
  }
  auction = {
    [K.A]: { iep: 103, ieq: 3000, buy: 9000, sell: 3000, imb: 4000 },
    [K.B]: { iep: 101.5, ieq: 800, buy: 5000, sell: 4800 },
    [K.C]: { iep: 104, ieq: 2500, buy: 8000, sell: 2000 },
    [K.D]: { iep: 100.4, ieq: 500, buy: 3000, sell: 3000 },
    [K.E]: { iep: 102.2, ieq: 1500, buy: 6000, sell: 3000 },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v3/market-quote/quotes') {
        quoteCalls++;
        const keys = (url.searchParams.get('instrument_key') ?? '').split(',');
        const data: Record<string, unknown> = {};
        for (const k of keys) {
          const a = auction[k];
          if (!a) continue;
          data[`NSE_EQ:${SYM[k]}`] = {
            instrument_token: k,
            last_price: 100,
            prev_close_price: 100,
            total_buy_quantity: a.buy,
            total_sell_quantity: a.sell,
            indicative_equilibrium_price: a.iep,
            indicative_equilibrium_quantity: a.ieq,
            indicative_imbalance_quantity_total: a.imb ?? 0,
            indicative_imbalance_quantity_market: 0,
            reference_price: 100,
          };
        }
        return new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
      }
      const m = /\/v3\/historical-candle\/intraday\/([^/]+)\//.exec(url.pathname);
      if (m) {
        // today: AAA opened 103 and rose; everyone else flat
        const k = decodeURIComponent(m[1]!);
        const rows = Array.from({ length: 8 }, (_, i) => {
          const mm = 15 + i * 5;
          const o = k === K.A ? 103 + i * 0.4 : 100;
          return [`${DAY}T09:${String(mm).padStart(2, '0')}:00+05:30`, o, o + 0.5, o - 0.1, o + 0.4, 5000, 0];
        }).reverse();
        return new Response(JSON.stringify({ status: 'success', data: { candles: rows } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'error', errors: [{ error_code: 'X', message: 'not mocked' }] }), { status: 404 });
    }),
  );
});

async function morning(): Promise<void> {
  await preopenTick(at('08:50'));
  await settle();
  for (const t of ['09:01', '09:02', '09:03', '09:04', '09:05:30', '09:06', '09:07', '09:08:30', '09:09', '09:10', '09:11', '09:12']) {
    const [hh, mm, ss] = t.split(':');
    await preopenTick(at(`${hh}:${mm}`, Number(ss ?? 0)));
  }
}

describe('Pre-open rising candidates, live (9:00–9:15)', () => {
  it('reads Upstox every 15 s from 9:00 and ranks with the fixed points; bad news and gaps under 1% are left out', async () => {
    await preopenTick(at('08:50'));
    await settle();
    expect(quoteCalls).toBe(0); // nothing is asked before 9:00
    await preopenTick(at('09:01'));
    let pre = await session('preopen');
    expect(pre).toMatchObject({ date: DAY, phase: 'collecting', counts: { scanned: 5, withIep: 5, listed: 3, badNews: 1 } });
    expect(quoteCalls).toBe(1);
    await morning();
    pre = await session('preopen');
    expect(pre.phase).toBe('discovery');
    expect(pre.rows.map((r) => r.symbol)).toEqual(['AAA', 'EEE', 'BBB']);
    const a = pre.rows[0]!;
    expect(a).toMatchObject({ rank: 1, iep: 103, ieq: 3000, imb: 4000, rp: 100, buyQty: 9000, sellQty: 3000, prevClose: 100, src: 'quote', name: 'AAA Ltd', industry: 'IT', index: 'Nifty 50' });
    expect(a.gapPct).toBeCloseTo(3, 5);
    expect(a.catalyst?.kind).toBe('results');
    const parts = Object.fromEntries(a.parts.map((p) => [p.id, Math.round(p.pts)]));
    expect(parts).toMatchObject({ gap: 25, demand: 20, news: 15, stable: 5 });
    // yesterday 2× its usual volume; sector = the other IT stocks with a price (BBB, CCC, EEE)
    expect(a.prevVolRatio).toBeCloseTo(2, 5);
    expect(a.sectorGap).toBeCloseTo((1.5 + 4 + 2.2) / 3, 5);
    expect(a.estimate.ok).toBe(true);
    expect(a.estimate.risk).toBeLessThanOrEqual(50);
    expect(a.score).toBeGreaterThan(pre.rows[1]!.score);
    expect(pre.final).toBeNull();
  });

  it('9:13: the final top 10 is fixed, one alert goes out and the day is written to the record; later readings do not change it', async () => {
    await morning();
    await preopenTick(at('09:13', 5));
    const pre = await session('preopen');
    expect(pre.phase).toBe('final');
    expect(pre.final?.rows.map((r) => r.symbol)).toEqual(['AAA', 'EEE', 'BBB']);
    expect(titles().filter((x) => x.includes('Pre-open top'))).toEqual(['🌅 Pre-open top 3 ready for 9:15']);
    const rec = (await chrome.storage.local.get('preopenRecord')).preopenRecord as Array<{ date: string; rows: Array<{ symbol: string; out: unknown }> }>;
    expect(rec).toHaveLength(1);
    expect(rec[0]!.rows.map((r) => [r.symbol, r.out])).toEqual([
      ['AAA', null],
      ['EEE', null],
      ['BBB', null],
    ]);
    auction[K.B] = { iep: 106, ieq: 9000, buy: 9000, sell: 100 };
    await preopenTick(at('09:14', 5));
    const again = await session('preopen');
    expect(again.final).toEqual(pre.final);
    // the live ranking moves on; the final list keeps what it was at 9:13
    expect(again.rows.find((r) => r.symbol === 'BBB')!.iep).toBe(106);
    expect(again.final!.rows.find((r) => r.symbol === 'BBB')!.iep).toBe(101.5);
    expect(titles().filter((x) => x.includes('Pre-open top'))).toHaveLength(1);
  });

  it('9:15: a final pick holding its gap is a buy plan within ₹50 at once (with an alert); one falling below its open drops out', async () => {
    await morning();
    await preopenTick(at('09:13', 5));
    const t = at('09:15', 40);
    const q = (k: string, ltp: number, open: number, high: number, low: number, extra: object = {}) => ({ key: k, ltp, open, high, low, volume: 90_000, prevClose: 100, fetchedAt: t, vwap: (open + ltp) / 2, buyQty: 9000, sellQty: 3000, ...extra });
    await chrome.storage.session.set({ quotes: { [K.A]: q(K.A, 103.4, 103, 103.6, 102.9, { vwap: 103.2 }), [K.B]: q(K.B, 101.0, 101.5, 101.6, 100.9), [K.E]: q(K.E, 102.3, 102.2, 102.4, 102.1, { volume: 100 }) } });
    await scanRising(t);
    await risingIdle();
    const early = await session('early');
    const a = early.drive!.find((r) => r.symbol === 'AAA')!;
    expect(a).toMatchObject({ state: 'holding', since: t, preRank: 1, open: 103 });
    expect(a.plan).toMatchObject({ breakout: 103.65, entry: 103.65, stop: 103.15, t1: 104.15, t2: 104.65 });
    expect(a.size.ok).toBe(true);
    expect(a.size.risk).toBeLessThanOrEqual(50);
    expect(a.size.value).toBeLessThanOrEqual(10_000);
    expect(a.score).toBeGreaterThanOrEqual(60);
    // EEE is a final pick still waiting (volume not heavy yet); BBB fell below its open: out
    expect(early.drive!.find((r) => r.symbol === 'EEE')).toMatchObject({ state: 'waiting', missing: ['volume not heavy yet'] });
    expect(early.drive!.some((r) => r.symbol === 'BBB')).toBe(false);
    expect(early.driveOut).toBe(1);
    expect(titles()).toContain(`⚡ AAA: holding its opening gap · score ${a.score}`);
  });

  it('9:47: how the final picks did in their first 30 minutes is written down (from Upstox candles)', async () => {
    await morning();
    await preopenTick(at('09:13', 5));
    await preopenTick(at('09:47'));
    const rec = (await chrome.storage.local.get('preopenRecord')).preopenRecord as Array<{ done: boolean; rows: Array<{ symbol: string; out: { upFirst: boolean; at945Pct: number } | null }> }>;
    expect(rec[0]!.done).toBe(true);
    const a = rec[0]!.rows.find((r) => r.symbol === 'AAA')!;
    expect(a.out).toMatchObject({ upFirst: true });
    expect(a.out!.at945Pct).toBeGreaterThan(2);
    expect(rec[0]!.rows.find((r) => r.symbol === 'BBB')!.out!.upFirst).toBe(false);
  });

  it('weekends and holidays: nothing is asked', async () => {
    await preopenTick(istEpoch('2026-11-21', '09:05'));
    expect(quoteCalls).toBe(0);
  });
});
