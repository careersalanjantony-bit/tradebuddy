import type { AlertDetail } from '../alerts/history';
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
import { sectorGaps } from '../early/preopen';
import { backtestIntraday, INTRADAY_TEST_VERSION, type IntradayTestReport } from '../intraday/backtest';
import { classifyIntraday, hhmmT, INTRADAY, sortIntraday, type IntradayRow } from '../intraday/scanner';
import { addResult, sideStats, signalPnl, type SignalOutcome, type SignalResult } from '../intraday/record';
import { classifyShort, marketRising, SHORT } from '../intraday/short';
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
import { tierOf } from '../wallet/tiers';
import { claimAlert } from './ideaGate';
import { scanUniverse } from './scanList';

/**
 * App v1.19 — the Intraday scanner, live: every 15 seconds from 9:15 to 3:15 on market days.
 *
 *  Universe — every NSE EQ-series stock in the instrument list (BE / T2T and other series are not in it:
 *  they never get an intraday signal), not only the pre-open list.
 *  Prices — stocks the live feed / price polls already price are read from there (fresh within 20 s);
 *  the others come from Upstox Full Market Quotes V3 (500 a call): stocks already moving every round,
 *  the quiet rest in four turns (each at least once a minute) — inside Upstox's request limits.
 *  Candles — the official 5-minute candles of today (Upstox intraday API) for the movers, once per
 *  5-minute candle each; app v1.20: 1-minute candles for the few stocks close to a SELL (once a minute).
 *  Usual volume — the last 20 daily candles (downloaded once for a new stock).
 *  Alerts — a BUY or SELL is announced once per stock per day (and not again within 30 minutes by another
 *  scanner); at most 8 of each a day. App v1.20: then followed — target reached, stop-loss hit or the
 *  signal invalidated, each once. Read-only: nothing is ever ordered.
 *
 * App v1.20 — the SELL side (sell first, buy back later): a separate engine (intraday/short.ts) looks
 * at falling Nifty 500 stocks and at risers trading below VWAP. The BUY engine (scanner.ts) is unchanged.
 * Each stock has one call: BUY when the BUY engine says so, else SELL when the short engine says so,
 * else the BUY engine's WAIT / NO TRADE for a riser, the short engine's for a faller.
 */

const log = createLogger('intraday');
export const INTRADAY_EVERY_MS = 15_000;
const MAX_ROWS = 80;
const MAX_CANDIDATES = 40;
const MAX_SHORT_CANDIDATES = 40;
const MAX_ALERTS = 8;
const LIVE_FRESH_MS = 20_000;

export interface IntradayState {
  date: string;
  at: number;
  /** eligible stocks (NSE EQ series) */
  universe: number;
  /** of those, with a fresh price this round */
  priced: number;
  /** up +0.6 % or more (BUY side), down 0.6 % or more and shortable (SELL side) */
  candidates: number;
  shortCandidates?: number;
  rows: IntradayRow[];
  /** counts of the rows listed (they add up to rows.length) */
  counts: { buy: number; sell?: number; wait: number; noTrade: number };
  /** why there are no buys now (falling market), if so */
  gate: string | null;
  /** app v1.20: why there are no shorts now (rising market), if so */
  shortGate?: string | null;
  error?: string;
  /** app v1.20.1: what was still arriving from Upstox when this round was saved (it comes next round) */
  slow?: string[];
}

/** app v1.20: an announced signal, followed until its target, stop-loss or invalidation */
export interface IntradayTracked {
  key: string;
  symbol: string;
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  /** SELL: target 1 (half) */
  t1: number | null;
  /** BUY: the target; SELL: target 2 */
  target: number;
  qty: number;
  risk: number;
  score: number;
  /** BUY: the opening-range high it broke; SELL: the level it broke below */
  level: number | null;
  at: number;
  state: 'open' | 't1' | 'done';
}

interface Snap {
  ltp: number;
  prevClose: number | null;
  volume: number | null;
  vwap: number | null;
  buyQty: number | null;
  sellQty: number | null;
  at: number;
  /** app v1.20: the lower price band, when Upstox gives it */
  lowerCircuit?: number | null;
}

let universe: { date: string; list: Instrument[] } | null = null;
const snaps = new Map<string, Snap>();
const barsCache = new Map<string, { slot: number; bars: Bars }>();
const bars1Cache = new Map<string, { minute: number; bars: Bars }>();
const avgVol = new Map<string, { date: string; avg: number | null; prevLow: number | null }>();
let round = 0;
let lastRun = 0;
/** review fix (1.20.2): 30 s between rounds while "Save mobile data" is on */
let everyMs = INTRADAY_EVERY_MS;
let running: Promise<number> | null = null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const EMPTY: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };

/** Full Market Quotes V3 → snapshots (same fields as the pre-open job reads). Pure. */
export function parseFullQuotes(data: unknown, at: number): Map<string, Snap> {
  const out = new Map<string, Snap>();
  for (const v of Object.values((data ?? {}) as Record<string, Record<string, unknown>>)) {
    const key = v?.instrument_token;
    const ltp = num(v?.last_price);
    if (typeof key !== 'string' || !(ltp !== null && ltp > 0)) continue;
    const pc = num(v.prev_close_price);
    const vw = num(v.average_price);
    const lc = num(v.lower_circuit_limit);
    out.set(key, {
      ltp,
      prevClose: pc !== null && pc > 0 ? pc : null,
      volume: num(v.volume),
      vwap: vw !== null && vw > 0 ? vw : null,
      buyQty: num(v.total_buy_quantity),
      sellQty: num(v.total_sell_quantity),
      at,
      ...(lc !== null && lc > 0 ? { lowerCircuit: lc } : {}),
    });
  }
  return out;
}

/** Only the 1-minute candles that had finished by `minute`. */
const completed1 = (b: Bars, minute: number): Bars => {
  let n = 0;
  while (n < b.t.length && b.t[n]! + 1 <= minute) n++;
  return { t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) };
};

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
  const y = days.at(-1);
  avgVol.set(key, { date, avg, prevLow: y && y.low > 0 ? y.low : null });
  return avg;
}

/**
 * App v1.20.1 — every round finishes within these times (ms) and saves the list with what it has.
 * Before, a round waited for every Upstox request; on a phone that was busy (the morning's history
 * download, or Upstox's request limit reached) one round could wait for many minutes and the list
 * stayed empty. Requests that take longer go on in the background and are used by the next round.
 */
const BUDGET = { quotes: 12_000, bars: 6_000, history: 2_000, bars1: 4_000 };
/** a round older than this is given up waiting for (the next one starts; only the newest saves) */
const STUCK_MS = 60_000;
let runningSince = 0;
let runId = 0;
let quotesJob: Promise<void> | null = null;
let quotesError: string | null = null;
let barsJob: Promise<void> | null = null;
let historyJob: Promise<void> | null = null;
let bars1Job: Promise<void> | null = null;

/** True when `p` finished within `ms` (it keeps running otherwise). */
const finishedWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([p.then(
    () => true,
    () => true,
  ), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

/** One scan (paced: at most every 15 s; `force` = now). Returns how many stocks were classified. */
export function intradayTick(now = Date.now(), force = false): Promise<number> {
  if (running && Date.now() - runningSince < STUCK_MS) return running;
  if (running) log.warn('An Intraday round took over a minute — starting a new one');
  if (!force && now - lastRun < everyMs - 500) return Promise.resolve(0);
  const id = ++runId;
  runningSince = Date.now();
  const p = scan(now, force, id)
    .catch(async (err: unknown) => {
      // app v1.20.1: a failed round still leaves the list (last good rows) with the reason
      if (id === runId) await saveFailure(now, err).catch(() => undefined);
      throw err;
    })
    .finally(() => {
      if (running === p) running = null;
    });
  running = p;
  return p;
}

async function saveFailure(now: number, err: unknown): Promise<void> {
  const date = istDate(now);
  const prev = await getSession('intraday');
  const base: IntradayState = prev?.date === date ? prev : { date, at: now, universe: 0, priced: 0, candidates: 0, rows: [], counts: { buy: 0, sell: 0, wait: 0, noTrade: 0 }, gate: null };
  await setSession('intraday', { ...base, at: now, error: `last round failed: ${errorMessage(err)}` });
}

async function scan(now: number, force: boolean, id = runId): Promise<number> {
  const cal = await getCalendar();
  const m = marketState(now, cal);
  const t = minutesIST(now);
  if (!force && (m.phase !== 'open' || t < INTRADAY.firstT || t > INTRADAY.lastT)) return 0;
  lastRun = now;
  const date = istDate(now);
  const settings = await getSettings();
  // review fix (1.20.2): "Save mobile data" — Nifty 500 only (most of it comes from the live feed), every 30 s
  const saveData = !!settings.data.saveData;
  everyMs = saveData ? 30_000 : INTRADAY_EVERY_MS;
  const list = saveData ? (await eligible(now)).filter((i) => tierOf(i.instrument_key) !== 'other') : await eligible(now);
  const live = await getQuotes();
  let error: string | undefined;

  // 1. prices: live where fresh, the rest from Full Market Quotes (movers every round, the rest in turns)
  const need: string[] = [];
  for (const i of list) {
    const q = live[i.instrument_key];
    if (q && now - q.fetchedAt < LIVE_FRESH_MS && q.prevClose) continue;
    need.push(i.instrument_key);
  }
  const prevState = await getSession('intraday');
  const alerted = await getSession('intradayAlerted');
  const tracked = alerted?.date === date ? Object.values(alerted.track ?? {}).filter((x) => x.state !== 'done') : [];
  const listed = new Set([...(prevState?.date === date ? prevState.rows.map((r) => r.key) : []), ...tracked.map((x) => x.key)]);
  const isHot = (k: string) => {
    const s = snaps.get(k);
    // app v1.20: fallers are watched as closely as risers (the SELL side)
    return !s || listed.has(k) || (s.prevClose !== null && Math.abs(s.ltp / s.prevClose - 1) >= 0.004);
  };
  const hot = need.filter(isHot).slice(0, 1000);
  const hotSet = new Set(hot);
  const turn = round++ % 4;
  const cold = need.filter((k, idx) => !hotSet.has(k) && idx % 4 === turn);
  // app v1.20.1: the price requests go on in the background when Upstox is slow; this round waits
  // at most BUDGET.quotes and uses what has arrived (one price download at a time)
  const slow: string[] = [];
  if (!quotesJob) {
    const keys = [...hot, ...cold];
    quotesJob = (async () => {
      try {
        for (const part of chunk(keys, 500)) {
          const data = await upstoxRequest<unknown>('/v3/market-quote/quotes', { tokenKind: 'market', query: { instrument_key: part.join(',') }, attempts: 1 });
          for (const [k, s] of parseFullQuotes(data, Date.now())) snaps.set(k, s);
        }
        quotesError = null;
      } catch (err) {
        quotesError = err instanceof UpstoxError && err.kind === 'not_logged_in' ? 'Upstox prices need the Analytics Token or the daily login' : `prices: ${errorMessage(err)}`;
      }
    })().finally(() => {
      quotesJob = null;
    });
  }
  if (!(await finishedWithin(quotesJob ?? Promise.resolve(), BUDGET.quotes))) slow.push('prices');
  if (quotesError) error = quotesError;

  // 2. one view per stock: price, previous close, volume, VWAP, waiting buy / sell
  const view = new Map<string, Snap & { inst: Instrument }>();
  for (const i of list) {
    const k = i.instrument_key;
    const q = live[k];
    const s = snaps.get(k);
    if (q && now - q.fetchedAt < LIVE_FRESH_MS && q.prevClose) {
      view.set(k, { ltp: q.ltp, prevClose: q.prevClose, volume: q.volume, vwap: q.vwap ?? null, buyQty: q.buyQty ?? null, sellQty: q.sellQty ?? null, at: q.fetchedAt, lowerCircuit: s?.lowerCircuit ?? null, inst: i });
    } else if (s) view.set(k, { ...s, inst: i });
  }
  const priced = [...view.values()].filter((v) => now - v.at < 90_000).length;
  const dayPct = (v: Snap) => (v.ltp / v.prevClose! - 1) * 100;
  const trackedKeys = new Set(tracked.map((x) => x.key));
  const candidates = [...view.entries()]
    .filter(([, v]) => v.prevClose && v.ltp >= INTRADAY.minPrice && dayPct(v) >= INTRADAY.watchPct)
    .sort((a, b) => b[1].ltp / b[1].prevClose! - a[1].ltp / a[1].prevClose!)
    .slice(0, MAX_CANDIDATES);
  // app v1.20: the SELL side — falling stocks that may be shorted Intraday (Nifty 500)
  const shortable = (k: string) => tierOf(k) !== 'other';
  const fallers = [...view.entries()]
    .filter(([k, v]) => shortable(k) && v.prevClose && v.ltp >= INTRADAY.minPrice && dayPct(v) <= SHORT.watchPct)
    .sort((a, b) => a[1].ltp / a[1].prevClose! - b[1].ltp / b[1].prevClose!)
    .slice(0, MAX_SHORT_CANDIDATES);
  // signals still followed stay in the lists (their candles and prices keep coming)
  for (const k of trackedKeys) {
    const v = view.get(k);
    if (!v?.prevClose) continue;
    const side = tracked.find((x) => x.key === k)!.side;
    if (side === 'buy' && !candidates.some(([c]) => c === k)) candidates.push([k, v]);
    if (side === 'sell' && !fallers.some(([c]) => c === k)) fallers.push([k, v]);
  }

  // 3. today's official 5-minute candles for the movers (once per candle each), usual volume
  const slot = Math.floor(t / 5) * 5;
  const riserDue = candidates.filter(([k]) => barsCache.get(k)?.slot !== slot).slice(0, 12);
  const fallerDue = fallers.filter(([k]) => barsCache.get(k)?.slot !== slot && !riserDue.some(([r]) => r === k)).slice(0, 8);
  // app v1.20.1: candles and the usual-volume history also go on in the background past their budget
  const due = [...riserDue, ...fallerDue];
  if (due.length && !barsJob) {
    barsJob = pool(due, 4, async ([k]) => {
      try {
        const b = await fetchTodayBars(k, now);
        if (b) barsCache.set(k, { slot, bars: b });
      } catch {
        /* keep the last candles; tried again next candle */
      }
    }).finally(() => {
      barsJob = null;
    });
  }
  if (barsJob && !(await finishedWithin(barsJob, BUDGET.bars))) slow.push('candles');
  const missing: string[] = [];
  for (const [k] of [...candidates, ...fallers]) if ((await usualVolume(k, date)) === null) missing.push(k);
  if (missing.length && !historyJob) {
    historyJob = (async () => {
      for (const k of missing.slice(0, 2)) {
        try {
          await syncCandles(k, cal, now);
          avgVol.delete(k);
          await usualVolume(k, date);
        } catch {
          /* no history yet: the volume check stays unknown (no BUY / SELL without it) */
        }
      }
    })().finally(() => {
      historyJob = null;
    });
  }
  if (historyJob && !(await finishedWithin(historyJob, BUDGET.history))) slow.push('volume history');

  // 4. the market gates (no buys while the market falls, no shorts while it rises), then the calls
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
  const niftyDayPct = fresh(nifty) && nifty!.prevClose ? (nifty!.ltp / nifty!.prevClose - 1) * 100 : null;
  const marketIn = { niftyDayPct, niftyFromOpenPct: fresh(nifty) && nifty!.open ? (nifty!.ltp / nifty!.open - 1) * 100 : null, listFromOpenPct: cnt >= 20 ? sum / cnt : null };
  const gate = marketGate(marketIn);
  const rising = marketRising(marketIn);
  const capital = settings.dayTrade.earlyCapitalInr ?? 10_000;
  const maxRisk = settings.dayTrade.earlyRiskInr ?? 50;
  const barsOf = (k: string) => {
    const cached = barsCache.get(k);
    return cached ? completedBars(cached.bars, t) : EMPTY;
  };

  // app v1.20.1: one stock that cannot be read must never stop the whole round (the list would stay empty)
  let skipped = 0;
  const safely = <T>(k: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch (err) {
      skipped++;
      log.warn(`Intraday: ${k} skipped this round`, { error: err });
      return null;
    }
  };

  // the BUY engine, unchanged
  const buyRows = new Map<string, IntradayRow>();
  for (const [k, v] of candidates) {
    const row = safely(k, () => classifyIntraday({
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
      bars: barsOf(k),
      avgDailyVol: avgVol.get(k)?.avg ?? null,
      fetchedAt: v.at,
      marketWeak: gate.weak,
      capital,
      maxRisk,
    }));
    if (row) buyRows.set(k, row);
  }

  // the SELL engine: fallers, and risers trading below VWAP (a failed breakout)
  let industry: Record<string, string> = {};
  try {
    industry = (await scanUniverse()).industry;
  } catch {
    /* sector unknown: the relative-weakness check uses NIFTY only */
  }
  const sectorOf = sectorGaps([...view.entries()].filter(([, v]) => v.prevClose && now - v.at < 90_000).map(([k, v]) => ({ key: k, sector: industry[k], gapPct: dayPct(v) })));
  const shortList = [...fallers, ...candidates.filter(([k, v]) => shortable(k) && buyRows.get(k)?.call !== 'BUY' && v.vwap !== null && v.ltp < v.vwap)];
  const shortIn = (k: string, v: Snap & { inst: Instrument }, bars1: Bars | null) => ({
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
    bars: barsOf(k),
    bars1,
    avgDailyVol: avgVol.get(k)?.avg ?? null,
    prevLow: avgVol.get(k)?.prevLow ?? null,
    fetchedAt: v.at,
    niftyDayPct,
    sectorDayPct: sectorOf.get(k) ?? null,
    marketStrong: rising.strong,
    eligible: shortable(k),
    lowerCircuit: v.lowerCircuit ?? null,
    capital,
    maxRisk,
  });
  const sellRows = new Map<string, IntradayRow>();
  const near: Array<[string, Snap & { inst: Instrument }]> = [];
  for (const [k, v] of shortList) {
    if (sellRows.has(k)) continue;
    const b1 = bars1Cache.get(k);
    const row = safely(k, () => classifyShort(shortIn(k, v, b1 && t - b1.minute <= 2 ? completed1(b1.bars, t) : null)));
    if (!row) continue;
    sellRows.set(k, row);
    // close to a SELL (a breakdown or a failed breakout, below VWAP): its 1-minute candles confirm it
    const trig = row.checks.some((c) => (c.id === 'breakdown' || c.id === 'failed') && c.ok);
    if (trig && row.call !== 'NO TRADE' && bars1Cache.get(k)?.minute !== t) near.push([k, v]);
  }
  if (near.length) {
    const want = near.slice(0, 6);
    if (!bars1Job) {
      bars1Job = pool(want, 3, async ([k]) => {
        try {
          const b1 = await fetchTodayBars(k, now, 1);
          if (b1) bars1Cache.set(k, { minute: t, bars: b1 });
        } catch {
          /* no 1-minute candles: the confirmation waits */
        }
      }).finally(() => {
        bars1Job = null;
      });
    }
    if (bars1Job && !(await finishedWithin(bars1Job, BUDGET.bars1))) slow.push('1-minute candles');
    for (const [k, v] of want) {
      const b1 = bars1Cache.get(k);
      if (!b1 || t - b1.minute > 2) continue;
      const row = safely(k, () => classifyShort(shortIn(k, v, completed1(b1.bars, t))));
      if (row) sellRows.set(k, row);
    }
  }

  // one call per stock (BUY and SELL are never the same stock)
  const merged = new Map<string, IntradayRow>();
  for (const [k, r] of buyRows) merged.set(k, r);
  for (const [k, r] of sellRows) {
    const b = merged.get(k);
    if (!b) merged.set(k, r);
    else if (b.call !== 'BUY' && r.call === 'SELL') merged.set(k, r);
  }
  const rows = [...merged.values()];
  const sorted = sortIntraday(rows).slice(0, MAX_ROWS);
  const state: IntradayState = {
    date,
    at: now,
    universe: list.length,
    priced,
    candidates: candidates.length,
    shortCandidates: fallers.length,
    rows: sorted,
    counts: {
      buy: sorted.filter((r) => r.call === 'BUY').length,
      sell: sorted.filter((r) => r.call === 'SELL').length,
      wait: sorted.filter((r) => r.call === 'WAIT').length,
      noTrade: sorted.filter((r) => r.call === 'NO TRADE').length,
    },
    gate: gate.weak ? gate.text : null,
    shortGate: rising.strong ? rising.text : null,
    ...(error || skipped ? { error: [error, skipped ? `${skipped} stock(s) could not be read this round` : null].filter(Boolean).join(' · ') } : {}),
    ...(slow.length ? { slow } : {}),
  };
  // a newer round has started meanwhile (this one was given up as stuck): it saves, not this one
  if (id !== runId) return rows.length;
  await setSession('intraday', state);
  await alertBuys(sorted, now, settings.dayTrade.alerts);
  await alertSells(sorted, now, settings.dayTrade.alerts);
  await followSignals(view, barsOf, t, now, settings.dayTrade.alerts);
  return rows.length;
}

const trackFrom = (r: IntradayRow, now: number): IntradayTracked => ({
  key: r.key,
  symbol: r.symbol,
  side: r.call === 'SELL' ? 'sell' : 'buy',
  entry: r.plan!.entry,
  stop: r.plan!.stop,
  t1: r.plan!.t1 ?? null,
  target: r.plan!.target,
  qty: r.size!.qty,
  risk: Math.round(r.size!.risk),
  score: r.score,
  level: r.call === 'SELL' ? (r.level ?? null) : r.orHigh,
  at: now,
  state: 'open',
});

/** A new BUY is announced once per stock per day (and not by two scanners within 30 minutes). */
async function alertBuys(rows: IntradayRow[], now: number, on: boolean): Promise<void> {
  if (!on) return;
  const date = istDate(now);
  const prev = await getSession('intradayAlerted');
  const sent = prev?.date === date ? [...prev.keys] : [];
  const track = prev?.date === date ? { ...(prev.track ?? {}) } : {};
  let any = false;
  for (const r of rows) {
    if (r.call !== 'BUY' || !r.plan || !r.size?.ok || sent.includes(r.key) || sent.length >= MAX_ALERTS) continue;
    sent.push(r.key);
    if (!(await claimAlert(r.key, 'buy', 'intraday', now))) continue;
    any = true;
    const p = r.plan;
    track[`buy:${r.key}`] = trackFrom(r, now);
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
        event: 'new',
      },
    });
  }
  if (sent.length !== (prev?.date === date ? prev.keys.length : 0)) await setSession('intradayAlerted', { ...(prev?.date === date ? prev : {}), date, keys: sent, track });
  if (any) await playSound('info');
}

/** App v1.20: a new SELL (sell first) is announced once per stock per day, at most 8 a day. */
async function alertSells(rows: IntradayRow[], now: number, on: boolean): Promise<void> {
  if (!on) return;
  const date = istDate(now);
  const prev = await getSession('intradayAlerted');
  const sells = prev?.date === date ? [...(prev.sells ?? [])] : [];
  const track = prev?.date === date ? { ...(prev.track ?? {}) } : {};
  const before = sells.length;
  let any = false;
  // review fix (1.20.2): SELL has no past test — until its own record proves it, every SELL alert says so
  const proven = sideStats(await getLocal('intradayRecord'), 'sell').proven;
  for (const r of rows) {
    if (r.call !== 'SELL' || !r.plan || r.plan.t1 === undefined || !r.size?.ok || sells.includes(r.key) || sells.length >= MAX_ALERTS) continue;
    sells.push(r.key);
    if (!(await claimAlert(r.key, 'sell', 'intraday', now))) continue;
    any = true;
    const p = r.plan;
    track[`sell:${r.key}`] = trackFrom(r, now);
    await notify(`alert:intraday-short-${r.key}-${date}`, {
      title: `🔻 Intraday SELL ${r.symbol} at ₹${p.entry.toFixed(2)} · score ${r.score}${proven ? '' : ' · practice only'}`,
      message: `${proven ? '' : 'New signal type, not proven yet — use Practice money only. '}Sell first, buy back later (Intraday only). ${r.changePct.toFixed(1)}% today · ${r.why} · buy back if it rises to ₹${p.stop.toFixed(2)} · targets ₹${p.t1!.toFixed(2)} / ₹${p.target.toFixed(2)} (1:${p.rr}) · ${r.size.qty} shares, risk ₹${Math.round(r.size.risk)} with charges. Buy back by 3:15 pm. Not a guarantee — you place the order yourself.`,
      priority: 2,
      detail: {
        symbol: r.symbol,
        key: r.key,
        side: 'sell',
        source: 'Intraday scanner',
        entry: p.entry,
        stop: p.stop,
        targets: [p.t1!, p.target],
        qty: r.size.qty,
        risk: Math.round(r.size.risk),
        score: r.score,
        scoreKind: 'score',
        reasons: r.checks.filter((c) => c.ok).map((c) => c.text),
        closeBy: '3:15 pm',
        event: 'new',
      },
    });
  }
  if (sells.length !== before) {
    const latest = await getSession('intradayAlerted');
    const base = latest?.date === date ? latest : { date, keys: [] };
    await setSession('intradayAlerted', { ...base, date, sells, track: { ...(base.track ?? {}), ...track } });
  }
  if (any) await playSound('info');
}

/** What happened to a followed signal at price `p` (and the last finished 5-minute close). Pure. */
export function followStep(s: IntradayTracked, p: number, lastClose: number | null, lastCloseT: number | null, vwap: number | null): { event: 't1' | 'target' | 'stop' | 'invalid'; text: string } | null {
  if (s.state === 'done') return null;
  const alertedT = minutesIST(s.at);
  const closedAfter = lastClose !== null && lastCloseT !== null && lastCloseT > alertedT;
  if (s.side === 'buy') {
    if (p >= s.target) return { event: 'target', text: `reached the target ₹${s.target.toFixed(2)} — take the profit` };
    if (p <= s.stop) return { event: 'stop', text: `fell to the stop-loss ₹${s.stop.toFixed(2)} — sell to keep the loss small` };
    if (closedAfter && s.level !== null && lastClose! < s.level) return { event: 'invalid', text: `a 5-minute candle closed back below the breakout level ₹${s.level.toFixed(2)} — the breakout failed; consider selling` };
    return null;
  }
  const stopNow = s.state === 't1' ? s.entry : s.stop;
  if (p <= s.target) return { event: 'target', text: `reached target 2 ₹${s.target.toFixed(2)} — buy back the rest` };
  if (s.state === 'open' && s.t1 !== null && p <= s.t1) return { event: 't1', text: `reached target 1 ₹${s.t1.toFixed(2)} — buy back half; the stop for the rest moves to the entry ₹${s.entry.toFixed(2)}` };
  if (p >= stopNow) return { event: 'stop', text: s.state === 't1' ? `rose back to the entry ₹${s.entry.toFixed(2)} — buy back the rest (no loss on it)` : `rose to the buy-back stop ₹${s.stop.toFixed(2)} — buy back to keep the loss small` };
  if (closedAfter && s.state === 'open' && ((s.level !== null && lastClose! > s.level) || (vwap !== null && lastClose! > vwap)))
    return { event: 'invalid', text: `a 5-minute candle closed back above ${s.level !== null && lastClose! > s.level ? `the broken level ₹${s.level.toFixed(2)}` : `VWAP ₹${vwap!.toFixed(2)}`} — the breakdown failed; consider buying back` };
  return null;
}

const EVENT_WORD: Record<'t1' | 'target' | 'stop' | 'invalid', { id: string; icon: string; head: (s: IntradayTracked) => string }> = {
  t1: { id: 't1', icon: '🎯', head: () => 'SELL target 1 reached' },
  target: { id: 'tgt', icon: '🎯', head: (s) => (s.side === 'buy' ? 'BUY target reached' : 'SELL target 2 reached') },
  stop: { id: 'stop', icon: '🛑', head: (s) => (s.state === 't1' ? 'SELL back at entry' : 'Stop-loss hit') },
  invalid: { id: 'inv', icon: '⚠️', head: () => 'Signal invalidated' },
};

/** App v1.20: follows today's announced BUY / SELL signals: target, stop-loss, invalidated — each once. */
async function followSignals(view: Map<string, Snap>, barsOf: (k: string) => Bars, t: number, now: number, on: boolean): Promise<void> {
  const date = istDate(now);
  const prev = await getSession('intradayAlerted');
  if (prev?.date !== date || !prev.track) return;
  const track = { ...prev.track };
  let changed = false;
  // review fix (1.20.2): each finished signal's result goes to the record shown on the list
  const results: SignalResult[] = [];
  const finish = (s: IntradayTracked, exit: number, outcome: SignalOutcome) =>
    results.push({ key: s.key, symbol: s.symbol, side: s.side, at: s.at, entry: s.entry, exit, outcome, t1Hit: s.state === 't1', qty: s.qty, pnl: signalPnl(s, exit, s.state === 't1') });
  for (const [id, s] of Object.entries(track)) {
    if (s.state === 'done') continue;
    if (t >= INTRADAY.lastT) {
      track[id] = { ...s, state: 'done' };
      changed = true;
      const v = view.get(s.key);
      if (v && now - v.at <= 120_000) finish(s, v.ltp, 'close');
      continue;
    }
    const v = view.get(s.key);
    if (!v || now - v.at > 60_000) continue;
    const b = barsOf(s.key);
    const n = b.t.length;
    const step = followStep(s, v.ltp, n ? b.c[n - 1]! : null, n ? b.t[n - 1]! + 5 : null, v.vwap);
    if (!step) continue;
    const w = EVENT_WORD[step.event];
    const next: IntradayTracked = { ...s, state: step.event === 't1' ? 't1' : 'done' };
    track[id] = next;
    changed = true;
    if (step.event !== 't1') finish(s, v.ltp, step.event);
    if (!on) continue;
    const detail: AlertDetail = {
      symbol: s.symbol,
      key: s.key,
      side: s.side,
      source: 'Intraday scanner',
      entry: s.entry,
      stop: step.event === 't1' ? s.entry : s.stop,
      targets: s.side === 'sell' && s.t1 !== null ? [s.t1, s.target] : [s.target],
      qty: s.qty,
      risk: s.risk,
      score: s.score,
      scoreKind: 'score',
      reasons: [step.text],
      closeBy: '3:15 pm',
      event: step.event,
    };
    // a SELL's follow-ups have their own ids: a BUY and a SELL on the same stock the same day must not share
    // one (an id shown in the last 24 hours is never shown or pushed again). BUY ids are unchanged.
    await notify(`alert:intraday-${s.side === 'sell' ? 'sell-' : ''}${w.id}-${s.key}-${date}`, {
      title: `${w.icon} ${w.head(s)}: ${s.symbol} at ₹${v.ltp.toFixed(2)}`,
      message: `${s.side === 'buy' ? 'Intraday BUY' : 'Intraday SELL (sold first)'} from ₹${s.entry.toFixed(2)}: ${step.text}. You place the order yourself in Upstox.`,
      priority: step.event === 'stop' || step.event === 'invalid' ? 2 : 1,
      detail,
    });
  }
  if (changed) {
    const latest = await getSession('intradayAlerted');
    const base = latest?.date === date ? latest : prev;
    await setSession('intradayAlerted', { ...base, date, track: { ...(base.track ?? {}), ...track } });
  }
  if (results.length) {
    let rec = (await getLocal('intradayRecord')) ?? [];
    for (const r of results) rec = addResult(rec, date, r);
    await setLocal('intradayRecord', rec);
  }
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
export function __resetIntraday(budget?: Partial<typeof BUDGET>): void {
  universe = null;
  snaps.clear();
  barsCache.clear();
  bars1Cache.clear();
  avgVol.clear();
  round = 0;
  lastRun = 0;
  everyMs = INTRADAY_EVERY_MS;
  running = null;
  runningSince = 0;
  quotesJob = barsJob = historyJob = bars1Job = null;
  quotesError = null;
  Object.assign(BUDGET, { quotes: 12_000, bars: 6_000, history: 2_000, bars1: 4_000 }, budget ?? {});
}
