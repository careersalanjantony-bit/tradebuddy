import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getRecentCandles } from '../data/candles';
import { getInstrument } from '../data/instruments';
import { fetchTodayBars, getIntradayDays, pool } from '../data/intraday';
import { getQuotes } from '../data/quotes';
import type { Quote } from '../data/quotesParse';
import { barsOf, BO, checkBreakout, confirmCandle, normalCandleVolume, planBreakout, resistanceOf, runBreakoutTest, vwapOf, type Bar, type BreakoutPlan } from '../daytrade/breakout';
import { completedBars, minutesIST } from '../daytrade/live';
import { rsi } from '../daytrade/shortScan';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { listKeys } from './dayJobs';
import { scanUniverse } from './scanList';
import { claimAlert } from './ideaGate';

/** the scan list's size and each stock's index tag, from the last scan (app v1.11) */
let scanTotal = 0;
let scanTags: Record<string, string> = {};

/**
 * App v1.9 — "🚀 Breakout Today", live. On every price update (each second with the Upstox
 * WebSocket feed, every 2 s otherwise) the current 5-minute candle of every stock in the list is
 * built from the live data, and checked against its resistance (daytrade/breakout.ts):
 *   - the moment the price crosses with a volume surge (and the filters pass) → "Breakout" alert;
 *   - when that 5-minute candle closes above the resistance with volume → "Confirmed breakout";
 *   - closes back below → failed; more than 10 minutes old or ran too far → "Too late".
 * Only genuine Upstox data: a stock whose price is more than 15 s old is skipped, never guessed.
 * Each stock / level alerts once per kind; old ideas are removed. Read-only towards the broker.
 */

const log = createLogger('breakout');
const FRESH_QUOTE_MS = 15_000;
const KEEP_DONE_MS = 30 * 60_000;
const MAX_PER_STOCK = 3;

export type BreakoutStatus = 'breakout' | 'confirmed' | 'late' | 'failed' | 'stopped' | 'target';

export interface BreakoutSignal {
  id: string;
  key: string;
  symbol: string;
  /** narrowest index of the stock: "Nifty 50", "Midcap 100"… (app v1.11) */
  index?: string;
  level: number;
  kind: 'day-high' | 'prev-day-high';
  /** when the breakout was first seen (ms) */
  at: number;
  /** price when it broke out */
  price: number;
  volX: number;
  vwap: number | null;
  ema9: number;
  rsi: number | null;
  momentumPct: number;
  score: number;
  reasons: string[];
  plan: BreakoutPlan;
  status: BreakoutStatus;
  confirmedAt?: number;
  lastPrice: number;
  lastAt: number;
  /** alerts already sent for it */
  alerted: { early: boolean; confirmed: boolean };
  /** why it is too late, failed or done, in plain words */
  note?: string;
}

export interface LiveCandle {
  /** minutes since midnight IST when the candle started */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** today's total volume when the app first saw this candle, and now */
  vStart: number | null;
  vNow: number | null;
  seenMs: number;
  lastMs: number;
  exact: boolean;
  /** the resistance this candle is measured against (null = none yet) */
  level: number | null;
  /** the day's open / high / low at the last update */
  day: { o: number | null; h: number | null; l: number | null };
  /** the day's high (Upstox) when the app first saw this candle: the resistance is never below it */
  hi0: number | null;
}

interface StockLive {
  key: string;
  symbol: string;
  tick: number;
  /** finished 5-minute candles today */
  bars: Bar[];
  /**
   * The candle being built from live prices. `exact` = followed from its first seconds (so its volume
   * is known: today's volume now minus today's volume when it started). `seenMs` / `vSeen` = when the
   * app first saw it, for the volume pace of a candle joined part-way.
   */
  cur: LiveCandle | null;
  prevDayHigh: number | null;
  /** finished candles must be reloaded from Upstox (the app missed part of one): not before this time */
  reloadAt: number | null;
  reloadTries: number;
}

let state: { date: string; stocks: Map<string, StockLive>; loading: Promise<void> | null; loaded: boolean; signals: BreakoutSignal[]; lastSave: number; dirty: boolean } = {
  date: '',
  stocks: new Map(),
  loading: null,
  loaded: false,
  signals: [],
  lastSave: 0,
  dirty: false,
};

/** For tests. */
export function resetBreakouts(): void {
  state = { date: '', stocks: new Map(), loading: null, loaded: false, signals: [], lastSave: 0, dirty: false };
  lastScanAt = 0;
}

const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const slotStartMs = (now: number, slotT: number) => {
  const d = new Date(now + 5.5 * 3600_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - 5.5 * 3600_000 + slotT * 60_000;
};
const timeText = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);

async function prevDayHighOf(key: string, today: string): Promise<number | null> {
  try {
    const days = (await getIntradayDays(key)).filter((d) => d.date < today).sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = days[days.length - 1];
    if (last && last.h.length) return Math.max(...last.h);
    const daily = (await getRecentCandles(key, 3)).filter((c) => c.date < today);
    return daily.length ? daily[daily.length - 1]!.high : null;
  } catch {
    return null;
  }
}

async function loadStock(key: string, today: string, now: number): Promise<StockLive> {
  const inst = await getInstrument(key);
  let bars: Bar[] = [];
  try {
    const b = await fetchTodayBars(key, now);
    if (b) bars = barsOf(completedBars(b, minutesIST(now)));
  } catch (err) {
    log.debug(`Today's candles not loaded for ${key}`, { error: errorMessage(err) });
  }
  return { key, symbol: inst?.trading_symbol ?? key, tick: inst?.tick ?? 0.05, bars, cur: null, prevDayHigh: await prevDayHighOf(key, today), reloadAt: null, reloadTries: 0 };
}

/**
 * Today's finished candles for every stock in the list, once a day (the live candles take over).
 * Before 9:20 there is no finished candle yet, so nothing is downloaded; later the day-trade
 * engine's candles are reused when it has them, else they come from Upstox. Each stock is scanned
 * as soon as its candles are in.
 */
function ensureLoaded(keys: string[], today: string, now: number): void {
  if (state.loading) return;
  // the whole list at the start; later only stocks added to the list
  const missing = keys.filter((k) => !state.stocks.has(k));
  if (!missing.length) {
    state.loaded = true;
    return;
  }
  // the scan's own clock (tests pass a simulated time), moving on with the real one while loading
  const realStart = Date.now();
  const clock = () => now + (Date.now() - realStart);
  state.loading = (async () => {
    const early = minutesIST(now) < 9 * 60 + 20;
    const dayLive = early ? undefined : await getSession('dayLive');
    await pool(missing, 4, async (key) => {
      if (state.date !== today) return;
      const dl = dayLive?.date === today ? dayLive.stocks[key] : undefined;
      if (early || (dl && dl.bars.t.length)) {
        const inst = await getInstrument(key);
        const bars = dl ? barsOf(completedBars(dl.bars, minutesIST(clock()))) : [];
        state.stocks.set(key, { key, symbol: inst?.trading_symbol ?? key, tick: inst?.tick ?? 0.05, bars, cur: null, prevDayHigh: await prevDayHighOf(key, today), reloadAt: null, reloadTries: 0 });
      } else state.stocks.set(key, await loadStock(key, today, clock()));
    });
    state.loaded = true;
    log.info(`Breakout scan ready: ${state.stocks.size} stocks`);
  })()
    .catch((err: unknown) => log.warn('Breakout scan could not load', { error: errorMessage(err) }))
    .finally(() => {
      state.loading = null;
    });
}

/** Each alert once a day, also across app restarts. Returns false when it was already sent. */
async function firstTime(id: string, today: string): Promise<boolean> {
  const prev = await getLocal('breakoutAlerted');
  const ids = prev?.date === today ? prev.ids : [];
  if (ids.includes(id)) return false;
  await setLocal('breakoutAlerted', { date: today, ids: [...ids, id].slice(-300) });
  return true;
}

async function alertEarly(sig: BreakoutSignal): Promise<void> {
  if (!(await firstTime(`${sig.id}-early`, istDate(sig.at)))) return;
  // one alert per stock and direction across the three scanners (app v1.11)
  if (!(await claimAlert(sig.key, 'buy', 'breakout', sig.at))) return;
  const p = sig.plan;
  await notify(`alert:bo-${sig.key}-${sig.level.toFixed(2)}-early`, {
    title: `🚀 Breakout: ${sig.symbol} ${rs(sig.price)} above ${rs(sig.level)} · ${sig.volX.toFixed(1)}× volume`,
    message: `Buy around ${rs(p.entry)} · stop-loss ${rs(p.stop)} · target 1 ${rs(p.t1)} · target 2 ${rs(p.t2)} · ${p.qty} shares (risk ${rs(p.risk)}). Not confirmed yet — the 5-minute candle closes at ${timeText(slotStartMs(sig.at, Math.floor(minutesIST(sig.at) / 5) * 5) + 300_000)}. Sell by 3:10 pm.`,
    priority: 2,
  });
  await playSound('info');
}

async function alertConfirmed(sig: BreakoutSignal): Promise<void> {
  if (!(await firstTime(`${sig.id}-ok`, istDate(sig.confirmedAt ?? sig.at)))) return;
  if (!(await claimAlert(sig.key, 'buy', 'breakout', sig.confirmedAt ?? sig.at))) return;
  const p = sig.plan;
  await notify(`alert:bo-${sig.key}-${sig.level.toFixed(2)}-ok`, {
    title: `✅ Confirmed breakout: ${sig.symbol} closed above ${rs(sig.level)}`,
    message: `Now ${rs(sig.lastPrice)} · buy around ${rs(p.entry)} · stop-loss ${rs(p.stop)} · targets ${rs(p.t1)} / ${rs(p.t2)} · ${p.qty} shares (risk ${rs(p.risk)}). Skip it if the price has run far above the entry. Sell by 3:10 pm.`,
    priority: 2,
  });
  await playSound('target');
}

/**
 * The candle as it really was, from the live prices — or null when part of it was missed (then the
 * finished candles are taken from Upstox instead of guessing). The first candle of the day can always
 * be completed: its open / high / low / volume are the day's own.
 */
export function liveBar(c: LiveCandle, firstOfDay: boolean): Bar | null {
  // followed until its last 20 seconds (else its close and volume are not known)
  const endMs = slotStartMs(c.seenMs, c.t) + 300_000;
  if (c.lastMs < endMs - 20_000 || c.vNow === null) return null;
  if (c.exact && c.vStart !== null) return { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: Math.max(0, c.vNow - c.vStart) };
  if (firstOfDay && c.day.o !== null && c.day.h !== null && c.day.l !== null) return { t: c.t, o: c.day.o, h: Math.max(c.day.h, c.h), l: Math.min(c.day.l, c.l), c: c.c, v: c.vNow };
  return null;
}

/** Two levels within 0.15 % are the same resistance (one breakout, one alert). */
export const sameLevel = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(a, b) * 0.0015;

/** The resistance for a new candle: from today's finished candles, never below the day's high. */
function levelOf(s: StockLive, hi0: number | null): number | null {
  const r = resistanceOf(s.bars, s.prevDayHigh)?.level ?? null;
  if (hi0 !== null && (r === null || hi0 > r)) return hi0;
  return r;
}

/** A finished candle: store it, then confirm or fail the breakouts it was carrying. */
async function finishCandle(s: StockLive, now: number, alertsOn: boolean, risk: number): Promise<void> {
  const c = s.cur!;
  const bar = liveBar(c, c.t === 9 * 60 + 15 && !s.bars.length);
  if (!bar) {
    // part of this candle was missed: take the finished candles from Upstox instead of guessing
    s.reloadAt ??= now + 5_000;
    return;
  }
  const before = s.bars;
  const level = c.level;
  s.bars = [...before.filter((b) => b.t !== bar.t), bar];
  if (level === null) return;
  const vwap = vwapOf(s.bars);
  const verdict = confirmCandle(bar, level, before, vwap);
  const open = state.signals.filter((x) => x.key === s.key && Math.abs(x.level - level) < 1e-6 && (x.status === 'breakout' || x.status === 'late'));
  for (const sig of open) {
    if (verdict === 'failed') {
      sig.status = 'failed';
      sig.note = `the 5-minute candle closed back below ${rs(level)} — a false breakout`;
      state.dirty = true;
    } else if (verdict === 'confirmed' && sig.status === 'breakout') {
      sig.status = 'confirmed';
      sig.confirmedAt = now;
      state.dirty = true;
      if (alertsOn && !sig.alerted.confirmed) {
        sig.alerted.confirmed = true;
        await alertConfirmed(sig);
      }
    }
  }
  // confirmed without an early alert (e.g. the volume came at the end of the candle)
  if (verdict === 'confirmed' && !open.length && bar.t + 5 <= BO.lastT && !state.signals.some((x) => x.key === s.key && sameLevel(x.level, level))) {
    const closes = s.bars.map((b) => b.c);
    const r = rsi(closes, 14);
    const back = s.bars.length >= 4 ? s.bars[s.bars.length - 4]!.c : s.bars[0]!.o;
    const momentumPct = (bar.c / back - 1) * 100;
    if ((r === null || (r >= BO.rsiMin && r <= BO.rsiMax)) && momentumPct >= BO.momentumPct && bar.c / level - 1 <= BO.maxExtPct && normalCandleVolume(before) * bar.c >= BO.minCandleValue) {
      const plan = planBreakout(bar.c, level, before, risk, s.tick);
      if (plan) {
        const volX = bar.v / Math.max(1, normalCandleVolume(before));
        const sig: BreakoutSignal = {
          id: `${s.key}-${level.toFixed(2)}`,
          key: s.key,
          symbol: s.symbol,
          ...(scanTags[s.key] ? { index: scanTags[s.key] } : {}),
          level,
          kind: before.length >= BO.minBars ? 'day-high' : 'prev-day-high',
          at: now,
          price: bar.c,
          volX,
          vwap,
          ema9: bar.c,
          rsi: r,
          momentumPct,
          score: Math.min(100, Math.round(55 + Math.min(20, (volX - BO.confirmSurge) * 6) + (s.prevDayHigh && bar.c > s.prevDayHigh ? 8 : 0))),
          reasons: [`closed above ₹${level.toFixed(2)}`, `${volX.toFixed(1)}× normal volume`, ...(vwap ? [`${((bar.c / vwap - 1) * 100).toFixed(1)}% above VWAP`] : []), `RSI ${r !== null ? Math.round(r) : '—'}`],
          plan,
          status: 'confirmed',
          confirmedAt: now,
          lastPrice: bar.c,
          lastAt: now,
          alerted: { early: false, confirmed: false },
        };
        state.signals.push(sig);
        state.dirty = true;
        if (alertsOn) {
          sig.alerted.confirmed = true;
          await alertConfirmed(sig);
        }
      }
    }
  }
}

/**
 * After a reload from Upstox: a breakout whose 5-minute candle the app could not follow from its start
 * is confirmed (or failed) on the real candle as Upstox reports it.
 */
async function settleFromBars(s: StockLive, now: number, alertsOn: boolean): Promise<void> {
  for (const sig of state.signals) {
    if (sig.key !== s.key || sig.status !== 'breakout') continue;
    const slotT = Math.floor(minutesIST(sig.at) / 5) * 5;
    const i = s.bars.findIndex((b) => b.t === slotT);
    if (i < 0) continue;
    const bar = s.bars[i]!;
    const verdict = confirmCandle(bar, sig.level, s.bars.slice(0, i), vwapOf(s.bars.slice(0, i + 1)));
    if (verdict === 'failed') {
      sig.status = 'failed';
      sig.note = `the 5-minute candle closed back below ${rs(sig.level)} — a false breakout`;
      state.dirty = true;
    } else if (verdict === 'confirmed') {
      sig.status = 'confirmed';
      sig.confirmedAt = now;
      state.dirty = true;
      if (alertsOn && !sig.alerted.confirmed) {
        sig.alerted.confirmed = true;
        await alertConfirmed(sig);
      }
    }
  }
}

/** Keeps every idea's status honest: too late, stop-loss hit, target reached; drops old ones. */
function ageSignals(quotes: Record<string, Quote>, now: number): void {
  const keep: BreakoutSignal[] = [];
  for (const sig of state.signals) {
    const q = quotes[sig.key];
    if (q && now - q.fetchedAt <= FRESH_QUOTE_MS) {
      if (q.ltp !== sig.lastPrice) state.dirty = true;
      sig.lastPrice = q.ltp;
      sig.lastAt = q.fetchedAt;
    }
    const R = sig.plan.entry - sig.plan.stop;
    if (sig.status === 'breakout' || sig.status === 'confirmed') {
      if (sig.lastPrice <= sig.plan.stop) {
        sig.status = 'stopped';
        sig.note = `fell to the stop-loss ${rs(sig.plan.stop)}`;
        state.dirty = true;
      } else if (sig.lastPrice >= sig.plan.t2) {
        sig.status = 'target';
        sig.note = `reached target 2 ${rs(sig.plan.t2)}`;
        state.dirty = true;
      } else if (now - (sig.confirmedAt ?? sig.at) > BO.freshMs || sig.lastPrice > sig.plan.entry + 0.6 * R || minutesIST(now) > BO.lastT) {
        sig.status = 'late';
        sig.note = sig.lastPrice > sig.plan.entry + 0.6 * R ? 'the price already ran up — too late to buy' : minutesIST(now) > BO.lastT ? 'after 3:00 pm — too late for a same-day trade' : 'more than 10 minutes old — too late';
        state.dirty = true;
      }
    }
    const done = sig.status !== 'breakout' && sig.status !== 'confirmed';
    if (done && now - sig.at > KEEP_DONE_MS) {
      state.dirty = true;
      continue;
    }
    keep.push(sig);
  }
  state.signals = keep;
}

async function saveState(today: string, now: number): Promise<void> {
  state.dirty = false;
  state.lastSave = now;
  await setSession('breakouts', { date: today, at: now, scanned: state.stocks.size, total: scanTotal, signals: state.signals });
}

let scanning = false;
let lastScanAt = 0;
let reloading: Promise<void> | null = null;

/** For tests: waits until the stocks' candles are loaded and no reload is running. */
export async function breakoutsIdle(): Promise<void> {
  for (let i = 0; i < 100 && (state.loading || reloading); i++) await Promise.all([state.loading, reloading]);
}

/**
 * App v1.14: the owner switched "Breakout Today" off ("nothing useful in it") — the live "Rising now"
 * engine (risingJobs.ts) replaced it. The code stays (tests switch it on), but nothing runs by default.
 */
let breakoutsOn = false;
export function setBreakoutsOn(on: boolean): void {
  breakoutsOn = on;
}
export const breakoutsEnabled = (): boolean => breakoutsOn;

/** On every price update in market hours (at most about once a second). */
export async function scanBreakouts(now = Date.now()): Promise<number> {
  if (!breakoutsOn || scanning || Math.abs(now - lastScanAt) < 800) return 0;
  scanning = true;
  lastScanAt = now;
  try {
    const today = istDate(now);
    if (state.date !== today) {
      const saved = await getSession('breakouts');
      resetBreakouts();
      state.date = today;
      if (saved?.date === today) state.signals = saved.signals;
    }
    const m = marketState(now, await getCalendar());
    const t = minutesIST(now);
    if (m.phase !== 'open' || t < 9 * 60 + 15 || t >= 15 * 60 + 30) return 0;
    const scan = await scanUniverse();
    const keys = scan.keys;
    scanTotal = keys.length;
    scanTags = scan.tag;
    // stocks are scanned as soon as their candles are in (the rest are still loading)
    ensureLoaded(keys, today, now);
    const settings = await getSettings();
    // part of Day trade (its tab shows the ideas): nothing while Day trade is switched off
    if (!settings.dayTrade.enabled) return 0;
    const alertsOn = settings.notifications.breakouts !== false;
    const risk = settings.dayTrade.breakoutRiskInr ?? 100;
    const quotes = await getQuotes();
    const slot = Math.floor(t / 5) * 5;
    let found = 0;
    const reloads: StockLive[] = [];
    for (const key of keys) {
      const s = state.stocks.get(key);
      const q = quotes[key];
      if (!s) continue;
      if (s.reloadAt !== null && now >= s.reloadAt) reloads.push(s);
      // genuine live data only
      if (!q || !(q.ltp > 0) || now - q.fetchedAt > FRESH_QUOTE_MS) continue;
      if (s.cur && slot > s.cur.t) {
        if (slot - s.cur.t > 5) s.reloadAt ??= now; // whole candles were missed (phone asleep)
        else await finishCandle(s, now, alertsOn, risk);
        s.cur = null;
      }
      const day = { o: q.open, h: q.high, l: q.low };
      if (!s.cur) {
        const start = slotStartMs(now, slot);
        // the day's high so far (Upstox) — the resistance can never be below it, even if a candle was missed
        const hi0 = slot > 9 * 60 + 15 && q.high !== null && q.high > 0 ? q.high : null;
        // while candles are missing, no resistance (it would be wrong): the reload fills them in
        const level = s.reloadAt === null ? levelOf(s, hi0) : null;
        s.cur = { t: slot, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, vStart: q.volume, vNow: q.volume, seenMs: now, lastMs: now, exact: now - start <= 20_000, level, day, hi0 };
      } else {
        s.cur.h = Math.max(s.cur.h, q.ltp);
        s.cur.l = Math.min(s.cur.l, q.ltp);
        s.cur.c = q.ltp;
        s.cur.vNow = q.volume;
        s.cur.lastMs = now;
        s.cur.day = day;
      }
      if (s.reloadAt !== null) continue;
      if (state.signals.filter((x) => x.key === key).length >= MAX_PER_STOCK) continue;
      const res = checkBreakout({
        t,
        nowMs: now,
        price: q.ltp,
        dayOpen: q.open,
        vwap: q.vwap ?? null,
        bars: s.bars,
        // the volume pace since the app first saw this candle (from its start when followed from the start)
        cur: { volume: s.cur.vStart !== null && s.cur.vNow !== null ? s.cur.vNow - s.cur.vStart : null, startMs: s.cur.exact ? slotStartMs(now, slot) : s.cur.seenMs },
        m1Vol: q.m1 && now - q.m1.ts < 120_000 ? q.m1.vol : null,
        prevDayHigh: s.prevDayHigh,
        levelFloor: s.cur.hi0,
      });
      const c = res.check;
      if (!c || state.signals.some((x) => x.key === key && sameLevel(x.level, c.level))) continue;
      const plan = planBreakout(q.ltp, c.level, s.bars, risk, s.tick);
      if (!plan) continue;
      const sig: BreakoutSignal = {
        id: `${key}-${c.level.toFixed(2)}`,
        key,
        symbol: s.symbol,
        ...(scanTags[key] ? { index: scanTags[key] } : {}),
        level: c.level,
        kind: c.kind,
        at: now,
        price: q.ltp,
        volX: c.volX,
        vwap: c.vwap,
        ema9: c.ema9,
        rsi: c.rsi,
        momentumPct: c.momentumPct,
        score: c.score,
        reasons: c.reasons,
        plan,
        status: c.late ? 'late' : 'breakout',
        ...(c.late ? { note: t > BO.lastT ? 'after 3:00 pm — too late for a same-day trade' : 'seen only after the price ran far above the level — too late' } : {}),
        lastPrice: q.ltp,
        lastAt: q.fetchedAt,
        alerted: { early: false, confirmed: false },
      };
      // the candle in progress belongs to this level from now on (for its confirmation at the close)
      s.cur.level = c.level;
      state.signals.push(sig);
      state.dirty = true;
      found++;
      if (!c.late && alertsOn) {
        sig.alerted.early = true;
        await alertEarly(sig);
      }
      log.info(`Breakout ${s.symbol} ${q.ltp} > ${c.level} (${c.volX.toFixed(1)}× volume)${c.late ? ' — too late' : ''}`);
    }
    // candles the app could not follow: take them from Upstox (a few at a time, never twice at once)
    if (reloads.length) {
      for (const s of reloads.slice(0, 12)) s.reloadAt = Number.POSITIVE_INFINITY;
      const realStart = Date.now();
      reloading = pool(reloads.slice(0, 12), 4, async (s) => {
        const at = now + (Date.now() - realStart);
        try {
          const b = await fetchTodayBars(s.key, at);
          const bars = b ? barsOf(completedBars(b, minutesIST(at))) : [];
          // Upstox publishes a finished candle a few seconds late: try again until the last one is in
          const want = Math.floor(minutesIST(at) / 5) * 5 - 5;
          if (want < 9 * 60 + 15 || (bars.length && bars[bars.length - 1]!.t >= want)) {
            s.bars = bars;
            s.reloadAt = null;
            s.reloadTries = 0;
            // the candle in progress was started without a resistance: measure it against the real one now
            if (s.cur) s.cur.level = levelOf(s, s.cur.hi0);
            await settleFromBars(s, at, alertsOn);
            state.dirty = true;
          } else {
            if (bars.length) s.bars = bars;
            s.reloadTries++;
            s.reloadAt = s.reloadTries >= 4 ? null : at + 15_000;
          }
        } catch {
          s.reloadTries++;
          s.reloadAt = s.reloadTries >= 4 ? null : at + 30_000;
        }
      })
        // show what the reload changed (e.g. a confirmed breakout) right away
        .then(() => (state.dirty && state.date === today ? saveState(today, now + (Date.now() - realStart)) : undefined))
        .finally(() => {
          reloading = null;
        });
    }
    ageSignals(quotes, now);
    if (state.dirty || now - state.lastSave > 5_000) await saveState(today, now);
    return found;
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------- past test of the confirmed rule

/** The confirmed-breakout rule on the stored 5-minute history (after the day-trade history downloads). */
export async function testBreakouts(now = Date.now()): Promise<void> {
  const settings = await getSettings();
  // the past test uses the Stocks-tab list (the scan-only stocks keep a short history)
  const keys = await listKeys();
  const days: Array<{ date: string; bars: Bar[]; prevDayHigh: number | null }> = [];
  for (const k of keys) {
    const list = (await getIntradayDays(k)).sort((a, b) => (a.date < b.date ? -1 : 1));
    list.forEach((d, i) => days.push({ date: d.date, bars: barsOf(d), prevDayHigh: i > 0 && list[i - 1]!.h.length ? Math.max(...list[i - 1]!.h) : null }));
  }
  const report = runBreakoutTest(days, settings.dayTrade.breakoutRiskInr ?? 100);
  await setLocal('breakoutTest', report ? { ...report, at: now } : null);
  if (report) log.info(`Breakout past test: ${report.newer.trades} trades on the newest days, ₹${report.newer.pnl} — ${report.passed ? 'PASSED' : 'not passed'}`);
}

export async function testBreakoutsIfDue(now = Date.now()): Promise<void> {
  if (!breakoutsOn) return;
  const r = await getLocal('breakoutTest');
  if (r && now - r.at < 20 * 3600_000) return;
  await testBreakouts(now).catch((err: unknown) => log.warn('Breakout past test failed', { error: errorMessage(err) }));
}
