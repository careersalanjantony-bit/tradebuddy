import { breadthOf } from '../advisor/breadth';
import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getInstrument } from '../data/instruments';
import { fetchTodayBars, getIntradayDays, pool } from '../data/intraday';
import { BUNDLED } from '../data/indexLists';
import { getQuotes } from '../data/quotes';
import { NIFTY100_KEYS } from '../data/universe';
import { memberKey } from '../data/universeParse';
import { minutesIST } from '../daytrade/live';
import { bearishScore, lastClosedIndex, MIN_SCORE, planShort, runShortTest, SHORT_FIRST_T, SHORT_LAST_T, type Reason, type ShortPlan } from '../daytrade/shortScan';
import { createLogger } from '../lib/log';
import { chunk } from '../lib/chunk';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';
import { dayKeys, listKeys } from './dayJobs';
import { scanUniverse } from './scanList';
import { claimAlert } from './ideaGate';
import type { Quote } from '../data/quotesParse';
import { SHORT_MODEL_VERSION } from '../advisor/shortModel';
import { trainShortModelAsync } from '../advisor/shortModelRun';
import { loadStockData } from '../data/stockData';
import type { Candle } from '../indicators/types';

/**
 * App v1.4: market breadth (Nifty 500 up vs down, every minute) and the "Falling now" sell-first
 * scan (every 5 minutes from 9:35 to 2:30). Read-only: prices and candles from Upstox only.
 */

const log = createLogger('shorts');
const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ShortIdea {
  key: string;
  symbol: string;
  /** narrowest index of the stock: "Nifty 50", "Midcap 100"… (app v1.11) */
  index?: string;
  score: number;
  reasons: Reason[];
  plan: ShortPlan;
  changePct: number;
  /** minutes since midnight of the candle that triggered it */
  candleT: number;
  at: number;
}

// ---------------------------------------------------------------- breadth

let breadthRunning = false;
export async function refreshBreadth(now = Date.now(), force = false): Promise<void> {
  if (breadthRunning) return;
  const prev = await getSession('breadth');
  const m = marketState(now, await getCalendar());
  const open = m.phase === 'open';
  if (!force && prev && now - prev.at < (open ? 60_000 : 6 * 3600_000)) return;
  breadthRunning = true;
  try {
    const keys = BUNDLED.nifty500.map(memberKey);
    const quotes: Record<string, { ltp: number; prevClose: number | null }> = {};
    for (const part of chunk(keys, 500)) {
      const data = await upstoxRequest<Record<string, { instrument_token?: string; last_price?: number; cp?: number }>>('/v3/market-quote/ltp', { query: { instrument_key: part.join(',') }, tokenKind: 'market', attempts: 1 });
      for (const q of Object.values(data ?? {})) if (q?.instrument_token && q.last_price) quotes[q.instrument_token] = { ltp: q.last_price, prevClose: q.cp ?? null };
    }
    await setSession('breadth', { at: now, list: 'Nifty 500', ...breadthOf(quotes, keys) });
  } catch (err) {
    log.info('Breadth not updated', { reason: errorMessage(err) });
  } finally {
    breadthRunning = false;
  }
}

// ---------------------------------------------------------------- falling now

let scanRunning = false;

/** Most candidates scored in one scan (one Upstox candle request each); the biggest falls go first. */
export const MAX_SHORT_CANDIDATES = 150;
/** Seconds after each 5-minute mark before the scan, so Upstox has published the candle that just closed. */
export const SHORT_SCAN_DELAY_MS = 15_000;

/**
 * App v1.11: every stock of the scan list that is falling today, below its opening price and easy to
 * sell first (a Nifty 100 company, or ₹20 crore traded today), biggest fall first. No fixed top-15:
 * all of them are scored, up to MAX_SHORT_CANDIDATES (the count of any left over is shown). Pure.
 */
export function shortCandidates(keys: string[], quotes: Record<string, Quote>, max = MAX_SHORT_CANDIDATES): { picked: Array<{ k: string; q: Quote }>; total: number } {
  const all = [...new Set(keys)]
    .map((k) => ({ k, q: quotes[k] }))
    .filter((x): x is { k: string; q: Quote } => {
      const q = x.q;
      return !!q && !!q.prevClose && !!q.open && q.ltp < q.open && q.ltp / q.prevClose - 1 < -0.003 && (NIFTY100_KEYS.has(x.k) || (q.volume ?? 0) * q.ltp >= 20e7);
    })
    .sort((a, b) => a.q.ltp / a.q.prevClose! - b.q.ltp / b.q.prevClose!);
  return { picked: all.slice(0, max), total: all.length };
}

/** Every 5 minutes (15 s after each mark) in the morning-to-2:30 window, and on request. */
export async function scanShorts(now = Date.now(), force = false): Promise<number> {
  if (scanRunning) return 0;
  const settings = await getSettings();
  const t = minutesIST(now);
  const m = marketState(now, await getCalendar());
  if (!force && (m.phase !== 'open' || t < SHORT_FIRST_T || t > SHORT_LAST_T + 5)) return 0;
  const prev = await getSession('shortIdeas');
  const slot = Math.floor(t / 5);
  if (!force && prev && istDate(prev.at) === istDate(now) && Math.floor(minutesIST(prev.at) / 5) === slot) return prev.ideas.length;
  // the IST day starts on a 5-minute mark, so this is the time since the candle closed
  if (!force && now % 300_000 < SHORT_SCAN_DELAY_MS) return prev?.ideas.length ?? 0;
  scanRunning = true;
  try {
    const quotes = await getQuotes();
    const scan = await scanUniverse();
    const keys = scan.keys;
    // candidates: falling today, below the opening price, liquid enough to sell first
    const { picked: cands, total } = shortCandidates(keys, quotes);
    const risk = settings.dayTrade.shortRiskInr ?? 50;
    const ideas: ShortIdea[] = [];
    let scored = 0;
    await pool(cands, 6, async ({ k, q }) => {
      try {
        const bars = await fetchTodayBars(k, now);
        if (!bars) return;
        const i = lastClosedIndex(bars, t);
        if (i < 4) return;
        scored++;
        const s = bearishScore(bars, i, q!.prevClose);
        if (!s || s.score < MIN_SCORE) return;
        const inst = await getInstrument(k);
        const plan = planShort(bars, i, q!.ltp, s.vwap, risk, inst?.tick ?? 0.05);
        if (!plan) return;
        ideas.push({ key: k, symbol: inst?.trading_symbol ?? k, ...(scan.tag[k] ? { index: scan.tag[k] } : {}), score: s.score, reasons: s.reasons, plan, changePct: (q!.ltp / q!.prevClose! - 1) * 100, candleT: bars.t[i]!, at: now });
      } catch (err) {
        log.debug(`Short scan skipped ${k}`, { error: errorMessage(err) });
      }
    });
    ideas.sort((a, b) => b.score - a.score);
    await setSession('shortIdeas', { at: now, ideas, risk, scanned: keys.length, candidates: total, checked: cands.length, scored });
    await alertShorts(ideas, now);
    return ideas.length;
  } finally {
    scanRunning = false;
  }
}

/** Most sell-first alerts in one day (a safety cap against a flood on a crash day). */
export const MAX_SHORT_ALERTS = 25;

/**
 * App v1.7 (owner: "an instant alert whenever a new valid BUY or SELL trade idea appears"): every new
 * sell-first idea (score 60+) gets its own alert the moment the scan finds it, each stock once a day.
 */
async function alertShorts(ideas: ShortIdea[], now: number): Promise<void> {
  const settings = await getSettings();
  if (!settings.notifications.shorts) return;
  const date = istDate(now);
  const prev = await getSession('shortAlerted');
  const sent = prev?.date === date ? [...prev.keys] : [];
  const room = ideas.filter((x) => x.score >= MIN_SCORE && !sent.includes(x.key)).slice(0, Math.max(0, MAX_SHORT_ALERTS - sent.length));
  // one alert per stock and direction across the three scanners (app v1.11)
  const fresh: ShortIdea[] = [];
  for (const x of room) if (await claimAlert(x.key, 'sell', 'falling', now)) fresh.push(x);
  if (!fresh.length) return;
  const breadth = await getSession('breadth');
  const against = breadth && breadth.advanced > breadth.declined * 2;
  for (const top of fresh) {
    await notify(`alert:short-${top.key}-${date}`, {
      title: `▼ SELL first ${top.symbol} at ${rs(top.plan.entry)} · score ${top.score}${top.score >= 75 ? ' ⭐' : ''}`,
      message: `Buy back if it rises to ${rs(top.plan.stop)} · target 1 ${rs(top.plan.t1)} · target 2 ${rs(top.plan.t2)} · ${top.plan.qty} shares (risk ${rs(top.plan.risk)}). Close by 3:10 pm.${against ? ' Most stocks are rising today — be careful.' : ''}`,
      priority: 2,
    });
    sent.push(top.key);
  }
  await playSound('info');
  await setSession('shortAlerted', { date, keys: sent });
}

// ---------------------------------------------------------------- past test

/** The sell-first rules on the stored 5-minute history (after the day-trade history is downloaded). */
export async function testShorts(now = Date.now()): Promise<void> {
  const settings = await getSettings();
  const keys = (await dayKeys()).filter((k) => NIFTY100_KEYS.has(k));
  const days: Array<{ key: string; date: string; bars: import('../daytrade/types').Bars; prevClose: number | null }> = [];
  for (const k of keys) {
    const list = (await getIntradayDays(k)).sort((a, b) => (a.date < b.date ? -1 : 1));
    list.forEach((d, i) => days.push({ key: k, date: d.date, bars: d, prevClose: i > 0 ? (list[i - 1]!.c[list[i - 1]!.c.length - 1] ?? null) : null }));
  }
  const report = runShortTest(days, settings.dayTrade.shortRiskInr ?? 50, 3, now);
  await setLocal('shortTest', report ? { ...report, at: now } : null);
  if (report) log.info(`Sell-first past test: ${report.newer.trades} trades on the newest days, ${report.newer.pnl} ₹ — ${report.passed ? 'PASSED' : 'not passed'}`);
}

export async function testShortsIfDue(now = Date.now()): Promise<void> {
  const r = await getLocal('shortTest');
  if (r && now - r.at < 20 * 3600_000) return;
  await testShorts(now).catch((err: unknown) => log.warn('Sell-first past test failed', { error: errorMessage(err) }));
}

// ---------------------------------------------------------------- app v1.7: per-stock fall chance

let modelRunning = false;

/**
 * Trains the per-stock short-selling model once a day (on the list's daily candles, off the screen's
 * thread). Skipped when today's model exists for (nearly) the same list.
 */
export async function trainShortModelIfDue(now = Date.now(), force = false): Promise<boolean> {
  if (modelRunning) return false;
  const today = istDate(now);
  // the per-stock model belongs to the Stocks tab's "For short selling" list: that list's stocks
  const keys = await listKeys();
  const have = await getLocal('shortModel');
  if (!force && have && have.v === SHORT_MODEL_VERSION && have.date === today) return false;
  modelRunning = true;
  try {
    const [settings, cal, quotes] = await Promise.all([getSettings(), getCalendar(), getQuotes()]);
    const stocks: Array<{ key: string; candles: Candle[] }> = [];
    for (const key of keys) {
      const d = await loadStockData(key, { quote: quotes[key] ?? null, settings, calendar: cal, now });
      const finished = d.candles.filter((c) => !c.partial);
      if (finished.length >= 70) stocks.push({ key, candles: finished });
    }
    if (stocks.length < 5) return false;
    const m = await trainShortModelAsync(stocks, today, now);
    if (!m) return false;
    await setLocal('shortModel', m);
    log.info(`Short-selling model trained on ${m.samples} past days of ${m.stocks} stocks${m.test ? ` — newest ${m.test.n} days: top-rated fell ${Math.round(m.test.topRate * 100)}% vs ${Math.round(m.test.baseRate * 100)}% average` : ''}`);
    return true;
  } catch (err) {
    log.warn('Short-selling model not trained', { error: errorMessage(err) });
    return false;
  } finally {
    modelRunning = false;
  }
}

export interface LiveShortAnalysis {
  key: string;
  symbol: string;
  at: number;
  /** minutes since midnight of the 5-minute candle used */
  candleT: number;
  price: number;
  score: number;
  reasons: Reason[];
  vwap: number;
  ema9: number;
  rsi5: number | null;
  /** last candle's volume vs the average candle today */
  volRatio: number | null;
  plan: ShortPlan | null;
  /** today's high and low so far */
  dayHigh: number;
  dayLow: number;
}

/** The "Falling now" study for one stock right now (market hours): today's 5-minute candles. */
export async function analyzeShort(key: string, now = Date.now()): Promise<LiveShortAnalysis | null> {
  const m = marketState(now, await getCalendar());
  if (m.phase !== 'open') return null;
  const bars = await fetchTodayBars(key, now);
  if (!bars || !bars.t.length) return null;
  const i = lastClosedIndex(bars, minutesIST(now));
  if (i < 1) return null;
  const q = (await getQuotes())[key];
  const s = bearishScore(bars, i, q?.prevClose ?? null);
  if (!s) return null;
  const price = q?.ltp ?? bars.c[i]!;
  const inst = await getInstrument(key);
  const settings = await getSettings();
  const plan = planShort(bars, i, price, s.vwap, settings.dayTrade.shortRiskInr ?? 50, inst?.tick ?? 0.05);
  return {
    key,
    symbol: inst?.trading_symbol ?? key,
    at: now,
    candleT: bars.t[i]!,
    price,
    score: s.score,
    reasons: s.reasons,
    vwap: s.vwap,
    ema9: s.ema9,
    rsi5: s.rsi,
    volRatio: s.volRatio,
    plan,
    dayHigh: Math.max(...bars.h.slice(0, i + 1)),
    dayLow: Math.min(...bars.l.slice(0, i + 1)),
  };
}
