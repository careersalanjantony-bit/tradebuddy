import { getRecentCandles, syncCandles } from '../data/candles';
import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { NIFTY_KEY } from '../data/indices';
import { getAllInstruments } from '../data/instruments';
import type { Instrument } from '../data/instrumentsParse';
import { fetchTodayBars, getIntradayDays, pool } from '../data/intraday';
import { getQuotes } from '../data/quotes';
import { testKeys, universeKeys } from '../data/universe';
import { completedBars, minutesIST } from '../daytrade/live';
import type { Bars } from '../daytrade/types';
import { marketGate } from '../early/early';
import { backtestIntraday, INTRADAY_TEST_VERSION, type IntradayTestReport } from '../intraday/backtest';
import { classifyIntraday, hhmmT, INTRADAY, sortIntraday, type IntradayRow } from '../intraday/scanner';
import { chunk } from '../lib/chunk';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';
import { UpstoxError } from '../upstox/errors';
import { claimAlert } from './ideaGate';

/**
 * App v1.19 — the Intraday scanner, live: every 15 seconds from 9:15 to 3:15 on market days.
 *
 *  Universe — every NSE EQ-series stock in the instrument list (BE / T2T and other series are not in it:
 *  they never get an intraday signal), not only the pre-open list.
 *  Prices — stocks the live feed / price polls already price are read from there (fresh within 20 s);
 *  the others come from Upstox Full Market Quotes V3 (500 a call): stocks already rising every round,
 *  the quiet rest in four turns (each at least once a minute) — inside Upstox's request limits.
 *  Candles — the official 5-minute candles of today (Upstox intraday API) for the risers, once per
 *  5-minute candle each. Usual volume — the last 20 daily candles (downloaded once for a new stock).
 *  Alerts — a BUY is announced once per stock per day (and not again within 30 minutes by another
 *  scanner); at most 8 a day. Read-only: nothing is ever ordered.
 */

const log = createLogger('intraday');
export const INTRADAY_EVERY_MS = 15_000;
const MAX_ROWS = 40;
const MAX_CANDIDATES = 40;
const MAX_ALERTS = 8;
const LIVE_FRESH_MS = 20_000;

export interface IntradayState {
  date: string;
  at: number;
  /** eligible stocks (NSE EQ series) */
  universe: number;
  /** of those, with a fresh price this round */
  priced: number;
  /** up +0.6 % or more */
  candidates: number;
  rows: IntradayRow[];
  counts: { buy: number; wait: number; noTrade: number };
  /** why there are no buys now (falling market), if so */
  gate: string | null;
  error?: string;
}

interface Snap {
  ltp: number;
  prevClose: number | null;
  volume: number | null;
  vwap: number | null;
  buyQty: number | null;
  sellQty: number | null;
  at: number;
}

let universe: { date: string; list: Instrument[] } | null = null;
const snaps = new Map<string, Snap>();
const barsCache = new Map<string, { slot: number; bars: Bars }>();
const avgVol = new Map<string, { date: string; avg: number | null }>();
let round = 0;
let lastRun = 0;
let running: Promise<number> | null = null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Full Market Quotes V3 → snapshots (same fields as the pre-open job reads). Pure. */
export function parseFullQuotes(data: unknown, at: number): Map<string, Snap> {
  const out = new Map<string, Snap>();
  for (const v of Object.values((data ?? {}) as Record<string, Record<string, unknown>>)) {
    const key = v?.instrument_token;
    const ltp = num(v?.last_price);
    if (typeof key !== 'string' || !(ltp !== null && ltp > 0)) continue;
    const pc = num(v.prev_close_price);
    const vw = num(v.average_price);
    out.set(key, { ltp, prevClose: pc !== null && pc > 0 ? pc : null, volume: num(v.volume), vwap: vw !== null && vw > 0 ? vw : null, buyQty: num(v.total_buy_quantity), sellQty: num(v.total_sell_quantity), at });
  }
  return out;
}

async function eligible(now: number): Promise<Instrument[]> {
  const date = istDate(now);
  if (universe?.date === date && universe.list.length) return universe.list;
  const list = (await getAllInstruments()).filter((i) => i.instrument_type === 'EQ');
  universe = { date, list };
  return list;
}

async function usualVolume(key: string, date: string): Promise<number | null> {
  const c = avgVol.get(key);
  if (c?.date === date) return c.avg;
  const days = (await getRecentCandles(key, 21)).filter((x) => x.date < date).slice(-20);
  const avg = days.length >= 5 ? days.reduce((s, x) => s + x.volume, 0) / days.length : null;
  avgVol.set(key, { date, avg });
  return avg;
}

/** One scan (paced: at most every 15 s; `force` = now). Returns how many stocks were classified. */
export function intradayTick(now = Date.now(), force = false): Promise<number> {
  if (running) return running;
  if (!force && now - lastRun < INTRADAY_EVERY_MS - 500) return Promise.resolve(0);
  running = scan(now, force).finally(() => {
    running = null;
  });
  return running;
}

async function scan(now: number, force: boolean): Promise<number> {
  const cal = await getCalendar();
  const m = marketState(now, cal);
  const t = minutesIST(now);
  if (!force && (m.phase !== 'open' || t < INTRADAY.firstT || t > INTRADAY.lastT)) return 0;
  lastRun = now;
  const date = istDate(now);
  const settings = await getSettings();
  const list = await eligible(now);
  const live = await getQuotes();
  let error: string | undefined;

  // 1. prices: live where fresh, the rest from Full Market Quotes (risers every round, the rest in turns)
  const need: string[] = [];
  for (const i of list) {
    const q = live[i.instrument_key];
    if (q && now - q.fetchedAt < LIVE_FRESH_MS && q.prevClose) continue;
    need.push(i.instrument_key);
  }
  const prevState = await getSession('intraday');
  const listed = new Set(prevState?.date === date ? prevState.rows.map((r) => r.key) : []);
  const isHot = (k: string) => {
    const s = snaps.get(k);
    return !s || listed.has(k) || (s.prevClose !== null && s.ltp / s.prevClose - 1 >= 0.004);
  };
  const hot = need.filter(isHot).slice(0, 1000);
  const hotSet = new Set(hot);
  const turn = round++ % 4;
  const cold = need.filter((k, idx) => !hotSet.has(k) && idx % 4 === turn);
  try {
    for (const part of chunk([...hot, ...cold], 500)) {
      const data = await upstoxRequest<unknown>('/v3/market-quote/quotes', { tokenKind: 'market', query: { instrument_key: part.join(',') }, attempts: 1 });
      for (const [k, s] of parseFullQuotes(data, Date.now())) snaps.set(k, s);
    }
  } catch (err) {
    error = err instanceof UpstoxError && err.kind === 'not_logged_in' ? 'Upstox prices need the Analytics Token or the daily login' : `prices: ${errorMessage(err)}`;
  }

  // 2. one view per stock: price, previous close, volume, VWAP, waiting buy / sell
  const view = new Map<string, Snap & { inst: Instrument }>();
  for (const i of list) {
    const k = i.instrument_key;
    const q = live[k];
    if (q && now - q.fetchedAt < LIVE_FRESH_MS && q.prevClose) {
      view.set(k, { ltp: q.ltp, prevClose: q.prevClose, volume: q.volume, vwap: q.vwap ?? null, buyQty: q.buyQty ?? null, sellQty: q.sellQty ?? null, at: q.fetchedAt, inst: i });
    } else {
      const s = snaps.get(k);
      if (s) view.set(k, { ...s, inst: i });
    }
  }
  const priced = [...view.values()].filter((v) => now - v.at < 90_000).length;
  const candidates = [...view.entries()]
    .filter(([, v]) => v.prevClose && v.ltp >= INTRADAY.minPrice && (v.ltp / v.prevClose - 1) * 100 >= INTRADAY.watchPct)
    .sort((a, b) => b[1].ltp / b[1].prevClose! - a[1].ltp / a[1].prevClose!)
    .slice(0, MAX_CANDIDATES);

  // 3. today's official 5-minute candles for the risers (once per candle each), usual volume
  const slot = Math.floor(t / 5) * 5;
  const due = candidates.filter(([k]) => barsCache.get(k)?.slot !== slot).slice(0, 12);
  await pool(due, 4, async ([k]) => {
    try {
      const b = await fetchTodayBars(k, now);
      if (b) barsCache.set(k, { slot, bars: b });
    } catch {
      /* keep the last candles; tried again next candle */
    }
  });
  let synced = 0;
  for (const [k] of candidates) {
    if ((await usualVolume(k, date)) !== null || synced >= 2) continue;
    synced++;
    try {
      await syncCandles(k, cal, now);
      avgVol.delete(k);
    } catch {
      /* no history yet: the volume check stays unknown (no BUY without it) */
    }
  }

  // 4. the market gate (no buys while the market falls), then the calls
  const nifty = live[NIFTY_KEY];
  const fresh = (q: (typeof live)[string] | undefined) => !!q && q.ltp > 0 && now - q.fetchedAt < 60_000;
  let sum = 0;
  let cnt = 0;
  for (const q of Object.values(live)) {
    if (fresh(q) && q.open && q.open > 0 && !q.key.startsWith('NSE_INDEX')) {
      sum += (q.ltp / q.open - 1) * 100;
      cnt++;
    }
  }
  const gate = marketGate({
    niftyDayPct: fresh(nifty) && nifty!.prevClose ? (nifty!.ltp / nifty!.prevClose - 1) * 100 : null,
    niftyFromOpenPct: fresh(nifty) && nifty!.open ? (nifty!.ltp / nifty!.open - 1) * 100 : null,
    listFromOpenPct: cnt >= 20 ? sum / cnt : null,
  });
  const capital = settings.dayTrade.earlyCapitalInr ?? 10_000;
  const maxRisk = settings.dayTrade.earlyRiskInr ?? 50;
  const rows: IntradayRow[] = [];
  for (const [k, v] of candidates) {
    const cached = barsCache.get(k);
    const row = classifyIntraday({
      key: k,
      symbol: v.inst.trading_symbol,
      tick: v.inst.tick,
      now,
      t,
      ltp: v.ltp,
      prevClose: v.prevClose,
      volume: v.volume,
      vwap: v.vwap,
      buyQty: v.buyQty,
      sellQty: v.sellQty,
      bars: cached ? completedBars(cached.bars, t) : { t: [], o: [], h: [], l: [], c: [], v: [] },
      avgDailyVol: avgVol.get(k)?.avg ?? null,
      fetchedAt: v.at,
      marketWeak: gate.weak,
      capital,
      maxRisk,
    });
    if (row) rows.push(row);
  }
  const sorted = sortIntraday(rows).slice(0, MAX_ROWS);
  const state: IntradayState = {
    date,
    at: now,
    universe: list.length,
    priced,
    candidates: candidates.length,
    rows: sorted,
    counts: { buy: rows.filter((r) => r.call === 'BUY').length, wait: rows.filter((r) => r.call === 'WAIT').length, noTrade: rows.filter((r) => r.call === 'NO TRADE').length },
    gate: gate.weak ? gate.text : null,
    ...(error ? { error } : {}),
  };
  await setSession('intraday', state);
  await alertBuys(sorted, now, settings.dayTrade.alerts);
  return rows.length;
}

/** A new BUY is announced once per stock per day (and not by two scanners within 30 minutes). */
async function alertBuys(rows: IntradayRow[], now: number, on: boolean): Promise<void> {
  if (!on) return;
  const date = istDate(now);
  const prev = await getSession('intradayAlerted');
  const sent = prev?.date === date ? [...prev.keys] : [];
  let any = false;
  for (const r of rows) {
    if (r.call !== 'BUY' || !r.plan || !r.size?.ok || sent.includes(r.key) || sent.length >= MAX_ALERTS) continue;
    sent.push(r.key);
    if (!(await claimAlert(r.key, 'buy', 'intraday', now))) continue;
    any = true;
    const p = r.plan;
    await notify(`alert:intraday-${r.key}-${date}`, {
      title: `⚡ Intraday BUY ${r.symbol} at ₹${p.entry.toFixed(2)} · score ${r.score}`,
      message: `+${r.changePct.toFixed(1)}% today, breakout ${r.breakoutT !== null ? hhmmT(r.breakoutT) : ''} · volume ${r.rvol?.toFixed(1)}× · stop-loss ₹${p.stop.toFixed(2)} · target ₹${p.target.toFixed(2)} (1:${p.rr}) · ${r.size.qty} shares, risk ₹${Math.round(r.size.risk)} with charges. Exit by 3:15 pm. Not a guarantee — you place the order yourself.`,
      priority: 2,
      detail: {
        symbol: r.symbol,
        key: r.key,
        side: 'buy',
        source: 'Intraday scanner',
        entry: p.entry,
        stop: p.stop,
        targets: [p.target],
        qty: r.size.qty,
        risk: Math.round(r.size.risk),
        score: r.score,
        scoreKind: 'score',
        reasons: r.checks.filter((c) => c.ok).map((c) => c.text),
        closeBy: '3:15 pm',
      },
    });
  }
  if (sent.length !== (prev?.date === date ? prev.keys.length : 0)) await setSession('intradayAlerted', { date, keys: sent });
  if (any) await playSound('info');
}

// ---------------------------------------------------------------- past test (once a day, market closed)

let testing: Promise<IntradayTestReport | null> | null = null;

export function testIntradayIfDue(now = Date.now(), force = false): Promise<IntradayTestReport | null> {
  testing ??= (async () => {
    const prev = await getLocal('intradayTest');
    const m = marketState(now, await getCalendar());
    if (!force) {
      if (m.phase === 'open' || m.phase === 'pre_open') return null;
      if (prev && prev.version === INTRADAY_TEST_VERSION && istDate(prev.at) === istDate(now)) return null;
    }
    const settings = await getSettings();
    const insts = new Map((await getAllInstruments()).map((i) => [i.instrument_key, i]));
    const keys = [...new Set([...(await testKeys()), ...(await universeKeys())])];
    const stocks = [];
    for (const key of keys) {
      const days = await getIntradayDays(key);
      if (days.length < 6) continue;
      const i = insts.get(key);
      stocks.push({ key, symbol: i?.trading_symbol ?? key, tick: i?.tick ?? 0.05, days });
    }
    const report = backtestIntraday(stocks, { capital: settings.dayTrade.earlyCapitalInr ?? 10_000, maxRisk: settings.dayTrade.earlyRiskInr ?? 50, slippagePct: settings.dayTrade.slippagePct, now });
    await setLocal('intradayTest', report);
    log.info(`Intraday past test: ${report.trades} trades on ${report.days} days, win rate ${report.winRate === null ? '—' : Math.round(report.winRate * 100) + '%'}`);
    return report;
  })().finally(() => {
    testing = null;
  });
  return testing;
}

/** Tests only. */
export function __resetIntraday(): void {
  universe = null;
  snaps.clear();
  barsCache.clear();
  avgVol.clear();
  round = 0;
  lastRun = 0;
  running = null;
}
