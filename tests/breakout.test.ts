import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { breakoutsIdle, liveBar, resetBreakouts, sameLevel, scanBreakouts, type BreakoutSignal, type LiveCandle } from '../src/background/breakoutJobs';
import { BO, BREAKOUT_RULES_VERSION as BO_VERSION, checkBreakout, confirmCandle, normalCandleVolume, planBreakout, resistanceOf, runBreakoutTest, simulateBreakoutDay, vwapOf, type Bar, type LiveInput } from '../src/daytrade/breakout';
import { features, FEATURES, newBrain, STRATEGIES, upgradeBrain, type Brain } from '../src/bot/brain';
import type { Quote } from '../src/data/quotesParse';
import { addDays, istEpoch } from '../src/lib/time';
import { getDb } from '../src/storage/db';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';

const bar = (t: string, o: number, h: number, l: number, c: number, v: number): Bar => {
  const [hh, mm] = t.split(':').map(Number);
  return { t: hh! * 60 + mm!, o, h, l, c, v };
};

/** a quiet morning: the first candle sets the high (100.6), then three calm candles of 30,000 shares */
const MORNING: Bar[] = [bar('09:15', 100, 100.6, 99.9, 100.5, 60_000), bar('09:20', 100.5, 100.55, 100.2, 100.3, 30_000), bar('09:25', 100.3, 100.5, 100.2, 100.4, 30_000), bar('09:30', 100.4, 100.55, 100.3, 100.5, 30_000)];
const D = '2026-11-12';
const ms = (hhmm: string, s = 0) => istEpoch(D, hhmm, s);

const input = (over: Partial<LiveInput> = {}): LiveInput => ({
  t: 9 * 60 + 35,
  nowMs: ms('09:35', 30),
  price: 100.8,
  dayOpen: 100,
  vwap: 100.35,
  bars: MORNING,
  cur: { volume: 20_000, startMs: ms('09:35') },
  m1Vol: null,
  prevDayHigh: 100.2,
  ...over,
});

describe('breakout rules (pure)', () => {
  it('resistance: the day high of finished candles; with one candle, the higher of it and yesterday’s high', () => {
    expect(resistanceOf(MORNING, 100.2)).toEqual({ level: 100.6, kind: 'day-high', touches: 4 });
    expect(resistanceOf(MORNING.slice(0, 1), 100.2)).toEqual({ level: 100.6, kind: 'day-high', touches: 1 });
    expect(resistanceOf(MORNING.slice(0, 1), 101)).toEqual({ level: 101, kind: 'prev-day-high', touches: 1 });
    expect(resistanceOf([], 101)).toEqual({ level: 101, kind: 'prev-day-high', touches: 1 });
    expect(resistanceOf([], null)).toBeNull();
    expect(normalCandleVolume(MORNING)).toBe(30_000); // the busy first candle is left out
    expect(vwapOf(MORNING)).toBeGreaterThan(100.2);
  });

  it('a clean breakout: above the level with a volume surge, VWAP, EMA 9, momentum — found while the candle is still open', () => {
    const r = checkBreakout(input());
    expect(r.reason).toBe('breakout');
    expect(r.check).toMatchObject({ level: 100.6, kind: 'day-high', late: false });
    expect(r.check!.volX).toBeCloseTo(20_000 / (30_000 * 0.15), 5); // 30 s into the candle: counted as 45 s at least
    expect(r.check!.reasons.join(' | ')).toMatch(/broke today's high ₹100\.60 \(tested 4×\).*4\.4× normal volume.*above VWAP/);
    expect(r.check!.score).toBeGreaterThanOrEqual(60);
  });

  it('false breakouts are filtered: no surge, below VWAP, below EMA 9, too little trading, RSI too high, weak momentum', () => {
    expect(checkBreakout(input({ cur: { volume: 2_000, startMs: ms('09:35') } })).reason).toMatch(/no volume surge/);
    expect(checkBreakout(input({ vwap: 100.9 })).reason).toBe('below VWAP');
    expect(checkBreakout(input({ price: 100.62 })).reason).toBe('below the resistance'); // needs +0.05 %
    const thin = MORNING.map((b) => ({ ...b, v: 1_000 }));
    expect(checkBreakout(input({ bars: thin, cur: { volume: 900, startMs: ms('09:35') } })).reason).toBe('too little trading');
    // 16 rising candles in a row: RSI 100 — exhausted, not a fresh breakout
    const run: Bar[] = Array.from({ length: 16 }, (_, i) => ({ t: 555 + i * 5, o: 100 + i * 0.2, h: 100.25 + i * 0.2, l: 99.95 + i * 0.2, c: 100.2 + i * 0.2, v: 30_000 }));
    const rr = checkBreakout(input({ t: 555 + 16 * 5, bars: run, price: 103.5, vwap: 101, dayOpen: 100 }));
    expect(rr.reason).toMatch(/RSI 100 outside 55–80/);
    // above the level but below today's open → weak momentum
    expect(checkBreakout(input({ dayOpen: 101 })).reason).toBe('weak momentum');
    expect(checkBreakout(input({ t: 9 * 60 + 19 })).reason).toBe('before 9:20');
  });

  it('a 1-minute candle with a burst of volume also counts as a surge (full live feed)', () => {
    const r = checkBreakout(input({ cur: { volume: null, startMs: ms('09:35') }, m1Vol: 15_000 }));
    expect(r.check?.volX).toBeCloseTo(15_000 / 6_000, 5);
  });

  it('“Too late” when the price already ran more than 0.8 % above the level, or after 3:00 pm', () => {
    expect(checkBreakout(input({ price: 101.5 })).check?.late).toBe(true);
    expect(checkBreakout(input({ t: 15 * 60 + 2 })).check?.late).toBe(true);
  });

  it('the resistance is never below the day’s high reported live (a missed candle cannot hide it)', () => {
    expect(checkBreakout(input({ levelFloor: 100.9 })).reason).toBe('below the resistance');
    expect(checkBreakout(input({ levelFloor: 100.5 })).check?.level).toBe(100.6);
  });

  it('plan: stop just under the level, 0.35 %–1.5 % below the entry; targets at 1× and 2× the risk; quantity for the ₹ risk', () => {
    const p = planBreakout(100.8, 100.6, MORNING, 100)!;
    expect(p.stop).toBeLessThan(100.6);
    expect((p.entry - p.stop) / p.entry).toBeGreaterThanOrEqual(BO.stopMinPct - 0.0005);
    expect((p.entry - p.stop) / p.entry).toBeLessThanOrEqual(BO.stopMaxPct);
    const R = p.entry - p.stop;
    expect(p.t1 - p.entry).toBeGreaterThanOrEqual(R - 1e-9);
    expect(p.t1 - p.entry).toBeLessThan(R + 0.05 + 1e-9);
    expect(p.t2 - p.entry).toBeGreaterThanOrEqual(2 * R - 1e-9);
    expect(p.qty * R).toBeLessThanOrEqual(100 + 1e-6);
    expect(p.qty).toBeGreaterThanOrEqual(Math.floor(100 / R) - 1);
    expect(p.netAtStop).toBeLessThan(-p.risk + 0.01);
    expect(p.netAtTargets).toBeGreaterThan(0);
    expect(planBreakout(0, 100, MORNING, 100)).toBeNull();
  });

  it('confirmation at the candle close: above the level with volume → confirmed; back below → failed; else weak', () => {
    expect(confirmCandle(bar('09:35', 100.5, 100.9, 100.5, 100.9, 60_000), 100.6, MORNING, 100.45)).toBe('confirmed');
    expect(confirmCandle(bar('09:35', 100.5, 100.9, 100.4, 100.5, 60_000), 100.6, MORNING, 100.45)).toBe('failed');
    expect(confirmCandle(bar('09:35', 100.5, 100.9, 100.5, 100.7, 30_000), 100.6, MORNING, 100.45)).toBe('weak');
  });

  const breakoutDay = (after: Bar[]): Bar[] => [...MORNING, bar('09:35', 100.5, 100.9, 100.5, 100.9, 60_000), ...after];
  const winDay = breakoutDay([bar('09:40', 100.95, 101.5, 100.9, 101.4, 40_000), bar('09:45', 101.4, 102.1, 101.3, 102.0, 40_000), bar('09:50', 102, 102.1, 101.9, 102, 20_000)]);
  const lossDay = breakoutDay([bar('09:40', 100.9, 100.95, 100.35, 100.4, 50_000), bar('09:45', 100.4, 100.5, 100.3, 100.4, 20_000)]);

  it('past test of one day: bought at the next candle’s open, half at target 1, the rest at target 2; or the stop', () => {
    const w = simulateBreakoutDay(winDay, 100.2, 100)!;
    expect(w).toMatchObject({ t1: true, win: true });
    expect(w.pnl).toBeGreaterThan(50); // ≈ ₹155 before charges, ≈ ₹93 after
    const l = simulateBreakoutDay(lossDay, 100.2, 100)!;
    expect(l.win).toBe(false);
    expect(l.r).toBeLessThan(-0.95);
    expect(simulateBreakoutDay(MORNING, 100.2, 100)).toBeNull(); // no breakout, no trade
  });

  it('past test over many days: older half vs newest half; passes only when the newest half made money', () => {
    expect(runBreakoutTest([{ date: '2026-10-01', bars: winDay, prevDayHigh: 100.2 }], 100)).toBeNull();
    const days = Array.from({ length: 24 }, (_, i) => ({ date: addDays('2026-09-01', i), bars: i % 4 === 3 ? lossDay : winDay, prevDayHigh: 100.2 }));
    const r = runBreakoutTest(days, 100)!;
    expect(r.days).toBe(24);
    expect(r.older.trades + r.newer.trades).toBe(24);
    expect(r.newer.trades).toBeGreaterThanOrEqual(10);
    expect(r.passed).toBe(true);
    expect(r.winRate).toBeCloseTo(18 / 24, 5);
    const bad = runBreakoutTest(days.map((d) => ({ ...d, bars: lossDay })), 100)!;
    expect(bad.passed).toBe(false);
    expect(bad.winRate).toBe(0);
  });

  it('two levels within 0.15 % are the same resistance (one alert)', () => {
    expect(sameLevel(100.6, 100.65)).toBe(true);
    expect(sameLevel(100.6, 100.9)).toBe(false);
  });

  it('a live candle is used only when the app followed it to its last seconds; the first candle can use the day’s own values', () => {
    const c: LiveCandle = { t: 575, o: 100.5, h: 100.9, l: 100.5, c: 100.9, vStart: 152_500, vNow: 212_500, seenMs: ms('09:35', 2), lastMs: ms('09:39', 52), exact: true, level: 100.6, day: { o: 100, h: 100.9, l: 99.9 }, hi0: 100.6 };
    expect(liveBar(c, false)).toEqual({ t: 575, o: 100.5, h: 100.9, l: 100.5, c: 100.9, v: 60_000 });
    expect(liveBar({ ...c, lastMs: ms('09:38') }, false)).toBeNull(); // missed its end
    expect(liveBar({ ...c, exact: false }, false)).toBeNull(); // joined part-way: taken from Upstox instead
    const first: LiveCandle = { ...c, t: 555, seenMs: ms('09:17'), lastMs: ms('09:19', 50), exact: false, o: 100.3, h: 100.5, l: 100.2, vNow: 60_000, day: { o: 100, h: 100.6, l: 99.9 } };
    expect(liveBar(first, true)).toEqual({ t: 555, o: 100, h: 100.6, l: 99.9, c: 100.9, v: 60_000 });
  });
});

describe('auto-trader brain learns the new kind of trade (breakouts)', () => {
  it('an older saved brain keeps everything it learned and gains the breakout weight and scorecard', () => {
    const old = newBrain();
    const saved: Brain = { ...old, w: old.w.slice(0, 13).map((x, i) => x + i * 0.01), w0: old.w0.slice(0, 13), by: Object.fromEntries(Object.entries(old.by).filter(([k]) => k !== 'breakout')) as Brain['by'], n: 7, wins: 4 };
    const up = upgradeBrain(saved);
    expect(up.w).toHaveLength(FEATURES.length);
    expect(up.w.slice(0, 13)).toEqual(saved.w);
    expect(up.w[13]).toBe(0);
    expect(up.n).toBe(7);
    expect(STRATEGIES.every((s) => up.by[s])).toBe(true);
    expect(upgradeBrain(up)).toBe(up); // nothing to do the second time
    const x = features({ strategy: 'breakout', prior: 0.5, movePct: 1, pressure: 0.3, breadth: 0.1, t: 600, news: 0, vwapPct: 0.4, riskPct: 0.5 });
    expect(x).toHaveLength(FEATURES.length);
    expect(x[FEATURES.indexOf('breakout')]).toBe(1);
  });
});

// ---------------------------------------------------------------- the live engine

const AAA = 'NSE_EQ|INE000AAA011';
let chrome: ReturnType<typeof installChromeMock>;
let todayCandles: Array<[string, number, number, number, number, number]> = [];
let day = { high: 0, low: Infinity };
const titles = () => chrome.notifications.create.mock.calls.map((c) => String(c[1].title));
const signals = async () => (((await chrome.storage.session.get('breakouts')).breakouts as { signals: BreakoutSignal[] } | undefined)?.signals ?? []);

/** One live price from Upstox (as the feed stores it), then the scan that runs on it. */
async function tick(hhmm: string, s: number, ltp: number, volume: number, over: Partial<Quote> = {}) {
  const at = ms(hhmm, s);
  day = { high: Math.max(day.high, ltp), low: Math.min(day.low, ltp) };
  const q: Quote = { key: AAA, ltp, open: 100, high: day.high, low: day.low, volume, prevClose: 99.8, fetchedAt: at, vwap: 100.35, ...over };
  await chrome.storage.session.set({ quotes: { [AAA]: q } });
  const found = await scanBreakouts(at);
  await breakoutsIdle();
  return found;
}

/** 9:15–9:35: the quiet morning of MORNING, followed live from the first second */
async function liveMorning() {
  await tick('09:15', 1, 100, 0); // starts the engine (nothing to download before 9:20)
  await tick('09:15', 2, 100, 0);
  await tick('09:17', 0, 100.6, 30_000);
  await tick('09:19', 50, 100.5, 60_000);
  await tick('09:20', 2, 100.45, 61_000);
  await tick('09:22', 0, 100.2, 75_000);
  await tick('09:24', 55, 100.3, 91_000);
  await tick('09:25', 2, 100.35, 91_500);
  await tick('09:27', 0, 100.5, 105_000);
  await tick('09:29', 55, 100.4, 121_500);
  await tick('09:30', 2, 100.45, 122_000);
  await tick('09:32', 0, 100.55, 140_000);
  await tick('09:34', 55, 100.5, 152_000);
  await tick('09:35', 2, 100.5, 152_500);
}

beforeEach(async () => {
  chrome = installChromeMock();
  resetBreakouts();
  day = { high: 0, low: Infinity };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dayTrade.enabled = true;
  settings.scanner.universe = 'watchlist';
  settings.dayTrade.scanScope = 'list';
  await chrome.storage.local.set({ settings, watchlist: [AAA], marketCalendar: null, breakoutAlerted: null, auth: { status: 'logged_out' }, secrets: { upstoxAnalyticsToken: 'analytics-test-token' } });
  const db = await getDb();
  await db.clear('intraday');
  await db.clear('instruments');
  await db.put('instruments', { instrument_key: AAA, trading_symbol: 'AAA', name: 'AAA', isin: 'INE000AAA011', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  await db.put('intraday', { key: AAA, date: addDays(D, -1), t: [555, 560], o: [99.5, 100], h: [100, 100.2], l: [99.4, 99.9], c: [100, 100.1], v: [50_000, 30_000] });
  todayCandles = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (!/\/v3\/historical-candle\/intraday\//.test(url.pathname)) return new Response(JSON.stringify({ status: 'error', errors: [{ error_code: 'X', message: 'not mocked' }] }), { status: 404 });
      const rows = todayCandles.map(([t, o, h, l, c, v]) => [`${D}T${t}:00+05:30`, o, h, l, c, v, 0]).reverse();
      return new Response(JSON.stringify({ status: 'success', data: { candles: rows } }), { status: 200 });
    }),
  );
});

describe('live breakout engine', () => {
  it('alerts the moment the price crosses with a volume surge, then “Confirmed” at the candle close — each once', async () => {
    await liveMorning();
    expect(await signals()).toEqual([]);
    // 28 seconds into the 9:35 candle: above 100.60 with 20,000 shares already (4.4× the normal pace)
    expect(await tick('09:35', 30, 100.8, 172_500)).toBe(1);
    let s = (await signals())[0]!;
    expect(s).toMatchObject({ symbol: 'AAA', status: 'breakout', price: 100.8, level: 100.6, kind: 'day-high' });
    expect(s.volX).toBeGreaterThan(4);
    expect(s.plan.stop).toBeLessThan(100.6);
    expect(s.plan.qty).toBeGreaterThan(0);
    expect(titles().filter((t) => t.startsWith('🚀 Breakout: AAA'))).toHaveLength(1);
    expect(titles()[0]).toContain('above ₹100.60');
    expect(String((chrome.notifications.create.mock.calls[0]![1] as { message?: string }).message)).toMatch(/Buy around ₹100\.80 · stop-loss ₹100\.40 · target 1 ₹101\.20 · target 2 ₹101\.60 · 250 shares/);
    // still above the level: no second alert
    await tick('09:36', 0, 100.85, 180_000);
    await tick('09:39', 52, 100.9, 212_500);
    expect(titles().filter((t) => t.startsWith('🚀'))).toHaveLength(1);
    // the 9:35 candle closes at 100.90 with 60,000 shares (2× normal): confirmed
    await tick('09:40', 1, 100.92, 213_000);
    s = (await signals())[0]!;
    expect(s.status).toBe('confirmed');
    expect(titles().filter((t) => t.startsWith('✅ Confirmed breakout: AAA closed above ₹100.60'))).toHaveLength(1);
    // ten minutes later it is too late to buy; half an hour after the breakout it is removed
    await tick('09:50', 30, 100.95, 230_000);
    s = (await signals())[0]!;
    expect(s.status).toBe('late');
    expect(s.note).toMatch(/too late/);
    await tick('10:06', 0, 100.95, 240_000);
    expect(await signals()).toEqual([]);
    expect(titles()).toHaveLength(2);
  });

  it('a breakout that falls back to the stop-loss is marked; the alert is never sent twice, even after a restart', async () => {
    await liveMorning();
    await tick('09:35', 30, 100.8, 172_500);
    await tick('09:37', 0, 100.35, 190_000);
    expect((await signals())[0]).toMatchObject({ status: 'stopped' });
    expect((await signals())[0]!.note).toMatch(/stop-loss/);
    // the app restarts: same day, same breakout seen again → no second alert
    resetBreakouts();
    await chrome.storage.session.set({ breakouts: undefined });
    const sent = (await chrome.storage.local.get('breakoutAlerted')).breakoutAlerted as { ids: string[] };
    expect(sent.ids).toEqual([`${AAA}-100.60-early`]);
  });

  it('“Too late” without an alert when the price is already far above the level', async () => {
    await liveMorning();
    await tick('09:35', 30, 101.65, 172_500);
    const s = (await signals())[0]!;
    expect(s.status).toBe('late');
    expect(titles()).toHaveLength(0);
  });

  it('genuine live data only: an old price is never used', async () => {
    await liveMorning();
    await tick('09:35', 30, 100.8, 172_500, { fetchedAt: ms('09:35', 2) - 20_000 });
    expect(await signals()).toEqual([]);
    expect(titles()).toHaveLength(0);
  });

  it('no alerts while Day trade is switched off, or when breakout alerts are off (the idea is still listed)', async () => {
    const st = (await chrome.storage.local.get('settings')).settings as typeof DEFAULT_SETTINGS;
    await chrome.storage.local.set({ settings: { ...st, notifications: { ...st.notifications, breakouts: false } } });
    await liveMorning();
    await tick('09:35', 30, 100.8, 172_500);
    expect((await signals())[0]?.status).toBe('breakout');
    expect(titles()).toHaveLength(0);
    resetBreakouts();
    await chrome.storage.local.set({ settings: { ...st, dayTrade: { ...st.dayTrade, enabled: false } } });
    expect(await tick('09:35', 40, 100.85, 175_000)).toBe(0);
  });

  it('started mid-day: today’s candles come from Upstox; the volume pace counts from when the app joined; the close is confirmed from Upstox’s candle', async () => {
    todayCandles = [
      ['09:15', 100, 100.6, 99.9, 100.5, 60_000],
      ['09:20', 100.5, 100.55, 100.2, 100.3, 30_000],
      ['09:25', 100.3, 100.5, 100.2, 100.4, 30_000],
      ['09:30', 100.4, 100.55, 100.3, 100.5, 30_000],
      ['09:35', 100.5, 100.5, 100.3, 100.4, 30_000],
      ['09:40', 100.4, 100.5, 100.3, 100.45, 30_000],
      ['09:45', 100.45, 100.5, 100.35, 100.4, 30_000],
      ['09:50', 100.4, 100.5, 100.3, 100.45, 30_000],
      ['09:55', 100.45, 100.55, 100.4, 100.5, 30_000],
    ];
    day = { high: 100.6, low: 99.9 };
    await tick('10:02', 0, 100.5, 300_000); // loads today's candles
    await tick('10:02', 1, 100.5, 300_000); // joins the 10:00 candle part-way
    expect(await tick('10:02', 31, 100.8, 320_000)).toBe(1); // 20,000 shares in 30 s
    expect((await signals())[0]).toMatchObject({ status: 'breakout', level: 100.6 });
    // 10:05: the app did not see the whole 10:00 candle → it reads it from Upstox, then confirms it
    todayCandles.push(['10:00', 100.5, 100.95, 100.45, 100.9, 70_000]);
    await tick('10:05', 1, 100.9, 360_000);
    await tick('10:05', 7, 100.92, 361_000);
    expect((await signals())[0]!.status).toBe('confirmed');
    expect(titles().filter((t) => t.startsWith('✅ Confirmed breakout: AAA'))).toHaveLength(1);
  });
});

describe('the auto-trader and practice suggestions use live breakouts (and learn from them)', () => {
  it('a fresh breakout becomes a buy suggestion of kind "breakout" with the plan’s stop and a 1:1 target from the price now', async () => {
    const { suggestIdeas, resetBotStudies } = await import('../src/background/botJobs');
    resetBotStudies();
    await liveMorning();
    await tick('09:35', 30, 100.8, 172_500);
    await chrome.storage.local.set({ breakoutTest: { version: BO_VERSION, days: 120, from: '2026-05-01', to: '2026-11-11', riskRupees: 100, older: { trades: 40, wins: 26, t1Hits: 26, pnl: 900, avgR: 0.2 }, newer: { trades: 40, wins: 25, t1Hits: 25, pnl: 700, avgR: 0.15 }, passed: true, winRate: 0.6375, at: ms('08:00') } });
    const r = await suggestIdeas('buy', ms('09:35', 40));
    const b = r.items.find((i) => i.kind === 'breakout');
    expect(b).toBeDefined();
    expect(b).toMatchObject({ key: AAA, side: 'buy', stop: 100.4, sameDay: true });
    expect(b!.target).toBeCloseTo(100.8 + (100.8 - 100.4), 5);
    expect(b!.chance).toBeGreaterThan(0.55); // starts from the past test (64 % made money), confirmed later
    expect(b!.reasons[0]).toMatch(/broke above ₹100\.60/);
  });
});
