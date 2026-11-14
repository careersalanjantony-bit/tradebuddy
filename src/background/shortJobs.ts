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
import { dayKeys } from './dayJobs';

/**
 * App v1.4: market breadth (Nifty 500 up vs down, every minute) and the "Falling now" sell-first
 * scan (every 5 minutes from 9:35 to 2:30). Read-only: prices and candles from Upstox only.
 */

const log = createLogger('shorts');
const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ShortIdea {
  key: string;
  symbol: string;
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

/** Every 5 minutes in the morning-to-2:30 window (and on request). */
export async function scanShorts(now = Date.now(), force = false): Promise<number> {
  if (scanRunning) return 0;
  const settings = await getSettings();
  const t = minutesIST(now);
  const m = marketState(now, await getCalendar());
  if (!force && (m.phase !== 'open' || t < SHORT_FIRST_T || t > SHORT_LAST_T + 5)) return 0;
  const prev = await getSession('shortIdeas');
  const slot = Math.floor(t / 5);
  if (!force && prev && istDate(prev.at) === istDate(now) && Math.floor(minutesIST(prev.at) / 5) === slot) return prev.ideas.length;
  scanRunning = true;
  try {
    const quotes = await getQuotes();
    const keys = await dayKeys();
    // candidates: falling today, below the opening price, liquid enough to sell first
    const cands = keys
      .map((k) => ({ k, q: quotes[k] }))
      .filter(({ k, q }) => q && q.prevClose && q.open && q.ltp < q.open && q.ltp / q.prevClose - 1 < -0.003 && (NIFTY100_KEYS.has(k) || (q.volume ?? 0) * q.ltp >= 20e7))
      .sort((a, b) => a.q!.ltp / a.q!.prevClose! - b.q!.ltp / b.q!.prevClose!)
      .slice(0, 15);
    const risk = settings.dayTrade.shortRiskInr ?? 50;
    const ideas: ShortIdea[] = [];
    await pool(cands, 4, async ({ k, q }) => {
      try {
        const bars = await fetchTodayBars(k, now);
        if (!bars) return;
        const i = lastClosedIndex(bars, t);
        if (i < 4) return;
        const s = bearishScore(bars, i, q!.prevClose);
        if (!s || s.score < MIN_SCORE) return;
        const inst = await getInstrument(k);
        const plan = planShort(bars, i, q!.ltp, s.vwap, risk, inst?.tick ?? 0.05);
        if (!plan) return;
        ideas.push({ key: k, symbol: inst?.trading_symbol ?? k, score: s.score, reasons: s.reasons, plan, changePct: (q!.ltp / q!.prevClose! - 1) * 100, candleT: bars.t[i]!, at: now });
      } catch (err) {
        log.debug(`Short scan skipped ${k}`, { error: errorMessage(err) });
      }
    });
    ideas.sort((a, b) => b.score - a.score);
    await setSession('shortIdeas', { at: now, ideas, risk });
    await alertShorts(ideas, now);
    return ideas.length;
  } finally {
    scanRunning = false;
  }
}

/** The strongest new idea (score ≥ 75), at most 3 alerts a day, each stock once. */
async function alertShorts(ideas: ShortIdea[], now: number): Promise<void> {
  const settings = await getSettings();
  if (!settings.notifications.shorts) return;
  const date = istDate(now);
  const prev = await getSession('shortAlerted');
  const sent = prev?.date === date ? prev.keys : [];
  if (sent.length >= 3) return;
  const breadth = await getSession('breadth');
  const top = ideas.find((x) => x.score >= 75 && !sent.includes(x.key));
  if (!top) return;
  const against = breadth && breadth.advanced > breadth.declined * 2;
  await notify(`alert:short-${top.key}-${date}`, {
    title: `▼ Sell-first idea: ${top.symbol} at ${rs(top.plan.entry)} · score ${top.score}`,
    message: `Buy back if it rises to ${rs(top.plan.stop)} · target 1 ${rs(top.plan.t1)} · target 2 ${rs(top.plan.t2)} · ${top.plan.qty} shares (risk ${rs(top.plan.risk)}). Close by 3:10 pm.${against ? ' Most stocks are rising today — be careful.' : ''}`,
    priority: 2,
  });
  await playSound('info');
  await setSession('shortAlerted', { date, keys: [...sent, top.key] });
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
