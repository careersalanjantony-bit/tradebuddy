import { newId } from '../alerts/rules';
import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getInstrument } from '../data/instruments';
import { fetchTodayBars, pool, pruneIntraday, syncIntraday } from '../data/intraday';
import { getQuotes, pollQuotes } from '../data/quotes';
import type { Quote } from '../data/quotesParse';
import { NIFTY100_KEYS, universeKeys } from '../data/universe';
import { inTheNews } from '../data/news';
import { marketMood } from '../advisor/mood';
import { newsFor } from './newsJobs';
import { appendBar, completedBars, dayExitAt, liveConfig, marketMove, minutesIST, sideWord, signalFrom, slotStart, type DayLive, type LiveStock } from '../daytrade/live';
import { DEFAULT_RULES, OPEN_T, dayTradePnl, findBreakout, hhmm, openingRange, relativeVolume, type Breakout } from '../daytrade/rules';
import type { DaySignal, DayTrade, Side } from '../daytrade/types';
import { createLogger } from '../lib/log';
import { createQueue } from '../lib/queue';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getDb } from '../storage/db';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { UpstoxError } from '../upstox/errors';
import { scoreLive } from './mlJobs';
import { buyersMeter } from '../data/flow';
import { stockSentiment } from '../data/sentiment';

/**
 * Day-trade mode in the service worker (v0.11.0): downloads the 5-minute history, raises BUY / SELL
 * signals during the morning window and watches open day trades (stop, target, 3:10 pm exit).
 * Read-only towards Upstox: the owner places every order himself.
 */

const log = createLogger('daytrade');
const R = DEFAULT_RULES;
const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The stocks the day-trade mode watches: the studied list (or your own stocks if no list is chosen). */
export async function dayKeys(): Promise<string[]> {
  const u = await universeKeys();
  return u.length ? u : ((await getLocal('watchlist')) ?? []);
}

// ---------------------------------------------------------------- 5-minute history

let intradayRunning: Promise<{ ok: number; failed: number }> | null = null;

/** Downloads missing 5-minute history for every watched stock (4 at a time). One run at a time. */
export function syncIntradayAll(now = Date.now()): Promise<{ ok: number; failed: number }> {
  intradayRunning ??= (async () => {
    const [settings, keys] = await Promise.all([getSettings(), dayKeys()]);
    const sessions = settings.dayTrade.testSessions;
    let ok = 0;
    let failed = 0;
    let fatal: string | undefined;
    await setSession('intradayProgress', { done: 0, total: keys.length, running: true, at: Date.now() });
    try {
      await pool(keys, 4, async (key) => {
        if (fatal) return;
        try {
          const n = await syncIntraday(key, sessions, now);
          if (n > 20) await pruneIntraday(key, sessions, now);
          ok++;
        } catch (err) {
          if (err instanceof UpstoxError && (err.kind === 'not_logged_in' || err.kind === 'auth')) fatal = errorMessage(err);
          failed++;
          if (failed <= 3) log.warn(`5-minute history failed for ${key}`, { error: err });
        }
        if ((ok + failed) % 4 === 0) await setSession('intradayProgress', { done: ok + failed, total: keys.length, running: true, at: Date.now() });
      });
    } finally {
      await setSession('intradayProgress', { done: ok + failed, total: keys.length, running: false, at: Date.now(), ...(fatal ? { error: fatal } : {}) });
      // a run that stopped for lack of a login is tried again as soon as there is one
      await setSession('intradayCheckedAt', fatal ? 0 : Date.now());
    }
    log.info(`5-minute history: ${ok} stocks up to date, ${failed} failed`);
    return { ok, failed };
  })().finally(() => {
    intradayRunning = null;
  });
  return intradayRunning;
}

/** Called at start-up and after a login: keeps the 5-minute history current when day trading is on. */
export async function ensureIntraday(now = Date.now()): Promise<void> {
  if (!(await getSettings()).dayTrade.enabled) return;
  const checked = await getSession('intradayCheckedAt');
  if (checked && now - checked < 30 * 60_000) return;
  void syncIntradayAll(now).catch((err: unknown) => log.info('5-minute history waits for a login or an Analytics Token', { reason: String(err) }));
}

/** Opening volumes of the last `n` stored sessions (oldest first). */
async function recentOpeningVolumes(key: string, n: number, beforeDate: string): Promise<number[]> {
  const out: number[] = [];
  let cur = await (await getDb()).transaction('intraday').store.openCursor(IDBKeyRange.bound([key, ''], [key, beforeDate], false, true), 'prev');
  while (cur && out.length < n) {
    const or = openingRange(cur.value, R);
    if (or) out.push(or.vol);
    cur = await cur.continue();
  }
  return out.reverse();
}

// ---------------------------------------------------------------- live signals

let loadInFlight: Promise<void> | null = null;
/** earliest time for the next load attempt (set when Upstox had not published the 09:25 candles yet) */
let nextLoadAt = 0;

async function emptyState(date: string): Promise<DayLive> {
  return { date, loadedAt: null, lastSlotT: 0, stocks: {} };
}

async function slotsPerDay(): Promise<number> {
  const { risk } = await getSettings();
  return Math.max(1, Math.min(5, Math.round(risk.sizing === 'split' ? risk.splitInto : risk.maxOpenTrades)));
}

/** Losing day trades closed today (real and practice counted separately; the larger count is used). */
function lossesToday(trades: DayTrade[], date: string): number {
  const lost = (practice: boolean) => trades.filter((t) => t.date === date && t.practice === practice && t.status === 'closed' && t.exitPrice !== undefined && dayTradePnl(t.side, t.qty, t.entry, t.exitPrice).pnl < 0).length;
  return Math.max(lost(true), lost(false));
}

async function publish(date: string, fresh: DaySignal[], now: number): Promise<void> {
  if (!fresh.length) return;
  const settings = await getSettings();
  const prev = await getSession('daySignals');
  const have = prev?.date === date ? prev.signals : [];
  const known = new Set(have.map((s) => s.key));
  const add = fresh.filter((s) => !known.has(s.key));
  if (!add.length) return;
  const slots = await slotsPerDay();
  const stopped = lossesToday((await getLocal('dayTrades')) ?? [], date) >= settings.dayTrade.maxLossesPerDay;
  let announced = have.filter((s) => s.announced).length;
  let sounded = false;
  // background checks (no screen needed): is the company in the news, is the market nervous today?
  const recent = inTheNews(await newsFor(add.filter((s) => !s.late).map((s) => s.key), now), now);
  const mood = marketMood(await getQuotes(), await dayKeys());
  const newsItems = await newsFor(add.map((s) => s.key), now).catch(() => []);
  const flow = await getSession('flow');
  for (const s of add) {
    if (recent.has(s.key)) s.inNews = true;
    if (mood.caution) s.caution = mood.caution;
    const f = flow?.stocks[s.key];
    const q = (await getQuotes())[s.key];
    if (f && q) {
      const meter = buyersMeter({ ltp: q.ltp, vwap: f.vwap, buyQty: f.buyQty, sellQty: f.sellQty });
      s.buyers = meter.label;
      s.pace = f.pace;
    }
    const sent = stockSentiment(newsItems.filter((i) => i.key === s.key), now);
    if (sent) {
      s.newsMood = sent.label;
      const against = (s.side === 'long' && sent.label === 'bad') || (s.side === 'short' && sent.label === 'good');
      if (against) s.caution = `${s.caution ? `${s.caution} ` : ''}Today's news for this company points the OTHER way — skipping this one is safer.`;
    }
  }
  await recordJournal(add, now);
  // busiest stocks first when several fire at the same boundary (as in the past test)
  add.sort((a, b) => b.rvol - a.rvol);
  for (const s of add) {
    if (s.late || stopped || !settings.dayTrade.alerts || announced >= slots) continue;
    s.announced = true;
    announced++;
    const tgt = s.target !== null ? `target ${rs(s.target)}` : 'no fixed target';
    await notify(`alert:day-${s.symbol}:${now}`, {
      title: `${s.ml && s.chance !== undefined && s.chance >= 0.6 ? '⭐ Strong idea — ' : s.trusted || s.ml ? '' : 'Practice idea — '}${s.side === 'long' ? '▲ BUY' : '▼ SELL first'} ${s.symbol} at ${rs(s.entry)}${s.chance !== undefined ? ` · ${Math.round(s.chance * 100)}% chance` : ''}`,
      message: `${s.side === 'long' ? `Take profit at ${s.target !== null ? rs(s.target) : 'the 3:10 pm close'} · sell if it falls to ${rs(s.stop)}` : `Buy back at ${s.target !== null ? rs(s.target) : 'the 3:10 pm close'} for the profit · buy back if it rises to ${rs(s.stop)}`} · close by 3:10 pm.${s.inNews ? ' This company is in the news today — be extra careful.' : ''}${s.caution ? ` ${s.caution}` : ''} Open the Day trade tab.`,
      priority: 2,
    });
    sounded = true;
  }
  if (sounded) await playSound('info');
  await setSession('daySignals', { date, signals: [...have, ...add] });
  log.info(`Day-trade signal(s): ${add.map((s) => `${sideWord(s.side)} ${s.symbol}@${s.entry}${s.late ? ' (late)' : ''}`).join(', ')}`);
}

/**
 * Every live signal is written down with what was known only live (buyers meter, volume pace, news
 * mood), so the self-learning can use these clues once enough days are collected.
 */
async function recordJournal(sigs: DaySignal[], now: number): Promise<void> {
  if (!sigs.length) return;
  const prev = (await getLocal('mlJournal')) ?? [];
  const rows = sigs.map((s) => ({ date: istDate(now), key: s.key, symbol: s.symbol, side: s.side, barT: s.barT, entry: s.entry, stop: s.stop, target: s.target, chance: s.chance ?? null, buyers: s.buyers ?? null, pace: s.pace ?? null, news: s.newsMood ?? null, late: !!s.late }));
  await setLocal('mlJournal', [...prev, ...rows].slice(-3000));
}

/**
 * A breakout becomes a signal by the plain rules — or, when the self-learning passed its check on
 * unseen days, when its learned chance is at least the bar it chose. Every signal shows the chance.
 */
async function scoredSignal(date: string, key: string, s: LiveStock, bo: Breakout, price: number, market: number | null, cfg: ReturnType<typeof liveConfig>, now: number, late = false): Promise<DaySignal | null> {
  const score = await scoreLive(date, key, s, bo, market);
  const learningDecides = !!score?.inUse;
  if (learningDecides && score!.chance < score!.threshold) return null;
  const sig = signalFrom(date, key, s, bo, price, market, cfg, now, late, learningDecides);
  if (sig && score) {
    sig.chance = Math.round(score.chance * 100) / 100;
    if (learningDecides) sig.ml = true;
  }
  return sig;
}

/** Loads today's finished 5-minute bars for every watched stock from Upstox and looks for breakouts so far. */
async function loadToday(date: string, now: number): Promise<void> {
  const [settings, keys, quotes, test] = await Promise.all([getSettings(), dayKeys(), getQuotes(), getLocal('dayTest')]);
  const cfg = liveConfig(test?.report, settings.ui.priceMin, settings.ui.priceMax);
  const st = await emptyState(date);
  let failed = 0;
  await pool(keys, 6, async (key) => {
    try {
      const [inst, bars, prevVols] = await Promise.all([getInstrument(key), fetchTodayBars(key, now), recentOpeningVolumes(key, R.rvolDays, date)]);
      if (!bars) return;
      const done = completedBars(bars, minutesIST(now), R);
      const or = openingRange(done, R);
      if (!or || done.t.length <= or.endIdx) return;
      st.stocks[key] = {
        symbol: inst?.trading_symbol ?? key,
        bars: done,
        rvol: relativeVolume(or.vol, prevVols, R),
        done: false,
        cumVol: quotes[key]?.volume ?? null,
        shortAllowed: NIFTY100_KEYS.has(key),
        tick: inst?.tick ?? 0.05,
      };
    } catch (err) {
      failed++;
      if (failed <= 3) log.warn(`Today's 5-minute bars failed for ${key}`, { error: errorMessage(err) });
    }
  });
  // Right after 09:30 the last candle of the first 15 minutes may not be published yet: try again shortly.
  const loadedStocks = Object.values(st.stocks);
  const lastOrT = OPEN_T + R.orMinutes - R.barMinutes;
  const incomplete = loadedStocks.filter((s) => !s.bars.t.includes(lastOrT)).length;
  if (minutesIST(now) < OPEN_T + R.orMinutes + 4 && loadedStocks.length > 0 && incomplete > loadedStocks.length * 0.3) {
    nextLoadAt = now + 15_000;
    log.info(`The 09:25 candles are not published yet for ${incomplete} of ${loadedStocks.length} stocks — trying again in 15 s`);
    return;
  }
  st.lastSlotT = slotStart(minutesIST(now));
  st.loadedAt = now;
  // breakouts that already happened: a signal only if it is on the bar that just finished, else "late"
  const market = marketMove(await getQuotes(), keys);
  const fresh: DaySignal[] = [];
  for (const [key, s] of Object.entries(st.stocks)) {
    const bo = findBreakout(s.bars, R);
    if (!bo) continue;
    s.done = true;
    const late = bo.barCloseT < st.lastSlotT;
    const sig = await scoredSignal(date, key, s, bo, late ? bo.close : ((await getQuotes())[key]?.ltp ?? bo.close), market, cfg, now, late);
    if (sig) fresh.push(sig);
  }
  await setSession('dayLive', st);
  await publish(date, fresh, now);
  log.info(`Day-trade engine ready: ${Object.keys(st.stocks).length} of ${keys.length} stocks loaded${failed ? `, ${failed} failed` : ''}; ${cfg.trusted ? 'tested settings' : 'settings NOT yet passed by the past test'}`);
}

/**
 * Runs after every price poll. Before 09:30:45 nothing; then loads today's bars once; at each
 * 5-minute boundary until 11:30 adds the finished bar from the latest prices and raises signals.
 * `now` can be passed by tests.
 */
export async function dayTick(now = Date.now()): Promise<{ signals: number; state: string }> {
  await monitorDayTrades(now).catch((err: unknown) => log.warn('Day-trade watch failed', { error: err }));
  const settings = await getSettings();
  if (!settings.dayTrade.enabled) return { signals: 0, state: 'off' };
  const cal = await getCalendar();
  const m = marketState(now, cal);
  if (m.phase !== 'open' || m.session.special || m.session.openAt === undefined) return { signals: 0, state: 'market closed' };
  const minute = minutesIST(now);
  const date = istDate(now);
  if (now < m.session.openAt + R.orMinutes * 60_000 + 45_000) return { signals: 0, state: 'waiting for 09:30' };
  let st = await getSession('dayLive');
  if (!st || st.date !== date) st = await emptyState(date);
  if (minute >= R.lastSignalT + R.barMinutes && (!st.loadedAt || st.lastSlotT >= R.lastSignalT)) return { signals: 0, state: 'signal window over' };

  if (!st.loadedAt) {
    if (now < nextLoadAt && now > nextLoadAt - 60_000) return { signals: 0, state: 'waiting for the first candles' };
    loadInFlight ??= loadToday(date, now)
      .catch((err: unknown) => log.warn("Loading today's 5-minute bars failed", { error: err }))
      .finally(() => {
        loadInFlight = null;
      });
    return { signals: 0, state: 'loading' };
  }

  const slotT = slotStart(minute);
  if (slotT <= st.lastSlotT) return { signals: 0, state: 'watching' };
  if (slotT - st.lastSlotT > R.barMinutes) {
    // a boundary was missed (computer asleep / Chrome closed): reload today's bars from Upstox
    await setSession('dayLive', { ...st, loadedAt: null });
    return { signals: 0, state: 'reloading after a gap' };
  }
  const [quotes, keys, test] = await Promise.all([getQuotes(), dayKeys(), getLocal('dayTest')]);
  const cfg = liveConfig(test?.report, settings.ui.priceMin, settings.ui.priceMax);
  const market = marketMove(quotes, keys);
  const barT = st.lastSlotT;
  const fresh: DaySignal[] = [];
  if (barT + R.barMinutes <= R.lastSignalT) {
    for (const [key, s] of Object.entries(st.stocks)) {
      const q: Quote | undefined = quotes[key];
      if (q && now - q.fetchedAt > 90_000) continue;
      const bo = appendBar(s, barT, q, R);
      if (!bo || !q) continue;
      const sig = await scoredSignal(date, key, s, bo, q.ltp, market, cfg, now);
      if (sig) fresh.push(sig);
    }
  }
  st.lastSlotT = slotT;
  // after the last signal bar the bars are no longer needed
  if (slotT >= R.lastSignalT) st.stocks = {};
  await setSession('dayLive', st);
  await publish(date, fresh, now);
  return { signals: fresh.length, state: slotT >= R.lastSignalT ? 'signal window over' : 'watching' };
}

// ---------------------------------------------------------------- day trades (real and practice)

const dayQueue = createQueue();
export const mutateDayTrades = (fn: (all: DayTrade[]) => DayTrade[]): Promise<DayTrade[]> =>
  dayQueue(async () => {
    const next = fn((await getLocal('dayTrades')) ?? []);
    await setLocal('dayTrades', next);
    return next;
  });

async function freshLtp(key: string, now: number, needOpen: boolean): Promise<number> {
  const open = marketState(now, await getCalendar()).phase === 'open';
  if (needOpen && !open) throw new Error('The market is closed. Day trades can only be practised during market hours (09:15–15:10).');
  let q = (await getQuotes())[key];
  if (open && (!q || now - q.fetchedAt > 30_000)) q = (await pollQuotes([key], now))[key] ?? q;
  if (!q || !(q.ltp > 0)) throw new Error('No price for this stock yet — log in or add the Analytics Token, then try again.');
  return q.ltp;
}

export interface DayTakeRequest {
  key: string;
  symbol: string;
  side: Side;
  qty: number;
  stop: number;
  target: number | null;
  practice: boolean;
  /** real trade: the price you got; practice: ignored (the live price is used) */
  price?: number;
  signalId?: string;
}

/** Records a day trade: practice at the live price, or a real one at the price the owner got in Upstox. */
export async function dayTake(req: DayTakeRequest, now = Date.now()): Promise<DayTrade> {
  const date = istDate(now);
  const all = (await getLocal('dayTrades')) ?? [];
  if (all.some((t) => t.key === req.key && t.status === 'open' && t.practice === req.practice)) throw new Error(`You already have an open ${req.practice ? 'practice ' : ''}day trade in ${req.symbol}.`);
  const qty = Math.floor(req.qty);
  if (!(qty >= 1)) throw new Error('Enter the number of shares (1 or more).');
  if (req.practice && minutesIST(now) >= R.exitT) throw new Error('It is after 3:10 pm — too late for a day trade today.');
  const entry = req.practice ? await freshLtp(req.key, now, true) : Number(req.price);
  if (!(entry > 0)) throw new Error('Enter the price you got.');
  const trade: DayTrade = { id: newId('D', now), date, key: req.key, symbol: req.symbol, side: req.side, qty, entry, stop: req.stop, target: req.target, openedAt: now, practice: req.practice, status: 'open', ...(req.signalId ? { signalId: req.signalId } : {}) };
  await mutateDayTrades((list) => [...list, trade]);
  log.info(`Day trade ${req.practice ? '(practice) ' : ''}${sideWord(req.side)} ${req.symbol} ${qty} @ ${entry}`, { id: trade.id });
  return trade;
}

async function closeTrade(t: DayTrade, price: number, reason: NonNullable<DayTrade['exitReason']>, now: number): Promise<number> {
  const { pnl, charges } = dayTradePnl(t.side, t.qty, t.entry, price);
  await mutateDayTrades((list) => list.map((x) => (x.id === t.id ? { ...x, status: 'closed', exitPrice: price, exitAt: now, exitReason: reason, charges } : x)));
  return pnl;
}

/** Close a day trade now: practice at the live price; real at the price the owner got. */
export async function dayClose(id: string, price?: number, now = Date.now()): Promise<{ price: number; pnl: number }> {
  const t = ((await getLocal('dayTrades')) ?? []).find((x) => x.id === id);
  if (!t || t.status !== 'open') throw new Error('Day trade not found or already closed.');
  const exit = t.practice ? await freshLtp(t.key, now, false) : Number(price);
  if (!(exit > 0)) throw new Error('Enter the price you got.');
  const pnl = await closeTrade(t, exit, 'manual', now);
  return { price: exit, pnl };
}

export async function dayReset(): Promise<number> {
  let removed = 0;
  await mutateDayTrades((all) => {
    const keep = all.filter((t) => !t.practice);
    removed = all.length - keep.length;
    return keep;
  });
  return removed;
}

const WHY = { stop: 'stop reached', target: 'target reached', time: '3:10 pm — time to close' } as const;

/**
 * Watches open day trades on every price poll. Practice trades are closed by the extension itself;
 * for real trades the owner gets one alert each for the stop, the target and the 3:05 pm reminder.
 */
export async function monitorDayTrades(now = Date.now()): Promise<number> {
  const open = ((await getLocal('dayTrades')) ?? []).filter((t) => t.status === 'open');
  if (!open.length) return 0;
  const [quotes, cal] = await Promise.all([getQuotes(), getCalendar()]);
  const phase = marketState(now, cal).phase;
  const today = istDate(now);
  const minute = minutesIST(now);
  let acted = 0;
  for (const t of open) {
    const q = quotes[t.key];
    if (t.date < today) {
      // left open on an earlier day: practice is closed at the last known close; a real one needs the owner
      if (t.practice && q && q.prevClose) {
        await closeTrade(t, phase === 'open' || phase === 'pre_open' ? q.prevClose : q.ltp, 'time', now);
        acted++;
      }
      continue;
    }
    if (!q || !(q.ltp > 0) || phase !== 'open' || now - q.fetchedAt > 90_000 || q.fetchedAt < t.openedAt) {
      // after the close: a practice trade still open is closed at the closing price
      if (t.practice && q && q.ltp > 0 && phase === 'after_close') {
        await closeTrade(t, q.ltp, 'time', now);
        acted++;
      }
      continue;
    }
    const exit = dayExitAt(t, q.ltp, minute, R);
    const verb = t.side === 'long' ? 'SELL' : 'BUY BACK';
    if (t.practice) {
      if (!exit) continue;
      const pnl = await closeTrade(t, exit.price, exit.reason, now);
      await notify(`alert:daypractice-${t.id}:exit`, {
        title: `Practice day trade closed: ${t.symbol} (${WHY[exit.reason]})`,
        message: `${t.side === 'long' ? 'Sold' : 'Bought back'} ${t.qty} at ${rs(exit.price)} · ${pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')} after charges (pretend money).`,
        priority: 2,
      });
      await playSound(pnl >= 0 ? 'target' : 'stop');
      acted++;
      continue;
    }
    // real trade: alerts only — the owner closes it in Upstox
    const alerted = { ...(t.alerted ?? {}) };
    let changed = false;
    if (exit && exit.reason !== 'time' && !alerted[exit.reason]) {
      alerted[exit.reason] = true;
      changed = true;
      await notify(`alert:day-${t.id}:${exit.reason}`, {
        title: `${verb} ${t.symbol} NOW — ${WHY[exit.reason]}`,
        message: `Price ${rs(q.ltp)}. ${exit.reason === 'stop' ? `Your stop was ${rs(t.stop)}: close the trade in Upstox to limit the loss.` : `Your target was ${rs(t.target!)}: close the trade in Upstox to take the profit.`} Then click "I closed it".`,
        requireInteraction: true,
        priority: 2,
      });
      await playSound(exit.reason === 'stop' ? 'stop' : 'target');
    }
    if (minute >= R.exitT - 5 && !alerted.time) {
      alerted.time = true;
      changed = true;
      await notify(`alert:day-${t.id}:time`, {
        title: `Close ${t.symbol} now — it is ${hhmm(Math.max(minute, R.exitT - 5))}`,
        message: `${verb} your ${t.qty} ${t.symbol} shares in Upstox before 3:10 pm. After about 3:15 pm Upstox closes intraday trades itself and may charge a fee.`,
        requireInteraction: true,
        priority: 2,
      });
      await playSound('stop');
    }
    if (changed) {
      await mutateDayTrades((list) => list.map((x) => (x.id === t.id ? { ...x, alerted } : x)));
      acted++;
    }
  }
  return acted;
}

export { OPEN_T };
