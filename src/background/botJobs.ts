import { calibrate, historyPairs, indicatorsOf, shortSellList, shortSetupAt, type Calibration, type Pair } from '../advisor/shortSell';
import { suggestBuys, type BuySuggestion } from '../advisor/suggest';
import { stockChance } from '../advisor/shortModel';
import { dailyShortPlan, type DailyShortPlan } from '../advisor/shortPlan';
import { newBrain, learnFrom, upgradeBrain, STRATEGY_LABEL, type Brain, type IdeaContext, type Strategy } from '../bot/brain';
import { BOT_START, decide, scoreIdea, SWING_MAX_DAYS, type Idea } from '../bot/policy';
import { checkDay, manageTrade, protectRules, type DayGuard, type ProtectRules } from '../bot/protect';
import { notify } from '../notify/chrome';
import { copyLine } from '../bot/copy';
import { quickPlan as quickPlanFrom } from '../rising/momentum';
import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { buyersMeter } from '../data/flow';
import { fetchTodayBars } from '../data/intraday';
import { getInstrument } from '../data/instruments';
import { getQuotes, trackedKeys } from '../data/quotes';
import type { Quote } from '../data/quotesParse';
import { stockSentiment } from '../data/sentiment';
import { loadStockData } from '../data/stockData';
import { minutesIST, signalState } from '../daytrade/live';
import { createLogger } from '../lib/log';
import { createQueue } from '../lib/queue';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession } from '../storage/session';
import { coverShort, newWallet, openShort, placeOrder, processWallet, sellFromBackground, updateHolding, walletSummary, type MarketCtx, type WalletQuote, type WalletState } from '../wallet/wallet';

/**
 * App v1.6 — the auto-trader. ₹50 lakh of pretend money that trades by itself during market hours:
 * it takes ideas from the day-trade signals, "Rising today", the top picks and the sell-first scan,
 * scores each with its brain (studies + what it learned from its own trades), decides the size,
 * opens the trades in its own practice wallet, manages them (safety net, targets, moving the safety
 * net to the buy price once 1 R up, 3:10 pm exit, 10-day limit for top picks) and learns from every
 * result. Pretend money only: nothing is ever sent to Upstox.
 */

const log = createLogger('bot');
const queue = createQueue();

export interface BotTrade {
  id: string;
  key: string;
  symbol: string;
  strategy: Strategy;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  stop: number;
  /** the safety net when the trade was opened */
  stop0: number;
  target: number;
  t1?: number;
  openedAt: number;
  date: string;
  /** features at entry (what the brain saw) */
  x: number[];
  chance: number;
  prior: number;
  riskRupees: number;
  explore: boolean;
  reasons: string[];
  sizeWhy: string;
  status: 'open' | 'closed';
  /** best and worst price seen while open (for the progress bar) */
  best?: number;
  worst?: number;
  closedAt?: number;
  exitPrice?: number;
  pnl?: number;
  r?: number;
  exitWhy?: string;
  lesson?: string | null;
  /** app v1.13: half already sold at 1× the risk */
  halfDone?: boolean;
  /** app v1.13: shares still open after the half was sold */
  left?: number;
  /** app v1.13: why the protection closed it (overrides the fill's reason in the record) */
  closeWhy?: string;
  /** app v1.13: Upstox product it was opened with (same-day buys: Intraday) */
  product?: 'intraday' | 'delivery';
}

export interface BotLogEntry {
  at: number;
  kind: 'open' | 'close' | 'learn' | 'info';
  text: string;
}

export interface BotState {
  v: 1;
  enabled: boolean;
  createdAt: number;
  wallet: WalletState;
  brain: Brain;
  trades: BotTrade[];
  log: BotLogEntry[];
  /** IST date and number of trades opened that day */
  day: { date: string; opened: number };
  lastRun: number;
  lastDecideAt: number;
  /** why it is not trading right now, in plain words */
  note: string | null;
  /** ideas looked at in the last decision */
  looked: number;
  equity: Array<{ date: string; total: number }>;
  /** app v1.13: the money protection (missing values = the defaults, on) */
  rules?: Partial<ProtectRules>;
  /** app v1.13: today's best result and whether it stopped for the day */
  guard?: DayGuard;
  /** app v1.13: the last time it could not run during market hours (app closed / phone asleep) */
  lastGap?: { from: number; to: number };
}

export function newBot(now: number, brain: Brain = newBrain(), startCash = BOT_START): BotState {
  return { v: 1, enabled: true, createdAt: now, wallet: newWallet(now, startCash), brain, trades: [], log: [{ at: now, kind: 'info', text: `Started with ${rupees(startCash)} of pretend money.` }], day: { date: '', opened: 0 }, lastRun: 0, lastDecideAt: 0, note: null, looked: 0, equity: [] };
}

const rupees = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const signedRs = (x: number) => `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const px = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let seq = 0;
const newId = (now: number) => `B${now.toString(36)}${(seq++ % 1296).toString(36)}`;

export async function getBot(now = Date.now()): Promise<BotState> {
  const b = await getLocal('bot');
  // app v1.9: a brain saved by an older version learns the new kinds of trade (breakouts) too
  return b ? { ...b, brain: upgradeBrain(b.brain) } : newBot(now);
}

async function marketCtx(now: number): Promise<MarketCtx> {
  const m = marketState(now, await getCalendar());
  return { now, today: istDate(now), t: minutesIST(now), open: m.phase === 'open' };
}

const wq = (q: Quote | undefined): WalletQuote | undefined => (q ? { ltp: q.ltp, prevClose: q.prevClose, fetchedAt: q.fetchedAt } : undefined);

function addLog(bot: BotState, at: number, kind: BotLogEntry['kind'], text: string): BotState {
  return { ...bot, log: [...bot.log, { at, kind, text }].slice(-150) };
}

/** Monday–Friday days from `from` (exclusive) to `to` (inclusive). Holidays are not subtracted. */
export function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

const isOpenInWallet = (w: WalletState, t: BotTrade) => (t.side === 'long' ? w.holdings.some((h) => h.key === t.key) : (w.shorts ?? []).some((s) => s.key === t.key));

/** Trades whose position is gone from the wallet: work out the result and learn from it. */
export function settleClosed(bot: BotState, now: number): BotState {
  let b = bot;
  for (const t of bot.trades) {
    if (t.status !== 'open' || isOpenInWallet(b.wallet, t)) continue;
    const fills = b.wallet.fills.filter((f) => f.key === t.key && f.at >= t.openedAt && f.pnl !== undefined);
    if (!fills.length) continue;
    const pnl = Math.round(fills.reduce((s, f) => s + (f.pnl ?? 0), 0) * 100) / 100;
    const last = fills[fills.length - 1]!;
    const r = t.riskRupees > 0 ? Math.round((pnl / t.riskRupees) * 100) / 100 : 0;
    const why =
      t.closeWhy ??
      (last.reason === 'stop'
        ? t.stop === t.entry
          ? 'came back to the buy price (no loss)'
          : (t.side === 'long' ? t.stop > t.entry : t.stop < t.entry)
            ? 'safety net followed the price up — profit kept'
            : 'safety net hit'
        : last.reason === 'target'
          ? 'target reached'
          : last.reason === 'day-end'
            ? t.strategy === 'swing'
              ? 'time limit reached'
              : 'closed at 3:10 pm'
            : last.reason === 't1'
              ? 'target 1'
              : 'closed');
    const lesson = learnFrom(b.brain, t.x, pnl > 0, r, pnl, t.strategy);
    const closed: BotTrade = { ...t, status: 'closed', closedAt: last.at, exitPrice: last.price, pnl, r, exitWhy: why, lesson: lesson.text };
    b = { ...b, brain: lesson.brain, trades: b.trades.map((x) => (x.id === t.id ? closed : x)) };
    b = addLog(b, last.at, 'close', `${t.side === 'long' ? 'Sold' : 'Bought back'} ${t.symbol} at ${px(last.price)} — ${why}: ${signedRs(pnl)} (${r >= 0 ? '+' : ''}${r.toFixed(1)} R).`);
    // the day's stop sends one summary instead of an alert per trade
    if (!t.closeWhy || !/daily loss limit|today's profit/.test(t.closeWhy)) void alertClose(closed, last.price).catch(() => undefined);
    b = addLog(b, now, 'learn', `${lesson.text ?? 'Learned a little.'} Its chance for a trade like this: ${Math.round(lesson.before * 100)}% → ${Math.round(lesson.after * 100)}%.`);
  }
  return b;
}

/**
 * Each open trade at the live price (app v1.13, see bot/protect.ts): the safety net moves to the buy
 * price early and then follows the best price; half is sold at 1× the risk; a same-day trade that
 * goes nowhere is closed. Also tracks best/worst prices for the progress bars.
 */
function manageOpen(bot: BotState, quotes: Record<string, Quote>, ctx: MarketCtx, riseTags: Map<string, 'strong' | 'unclear' | 'fading'> = new Map()): BotState {
  const rules = protectRules(bot.rules);
  let w = bot.wallet;
  const trades = bot.trades.map((t) => {
    if (t.status !== 'open') return t;
    const q = quotes[t.key];
    if (!q || !(q.ltp > 0)) return t;
    const best = t.side === 'long' ? Math.max(t.best ?? t.entry, q.ltp) : Math.min(t.best ?? t.entry, q.ltp);
    const worst = t.side === 'long' ? Math.min(t.worst ?? t.entry, q.ltp) : Math.max(t.worst ?? t.entry, q.ltp);
    const fresh = ctx.open && ctx.now - q.fetchedAt < 2 * 60_000;
    const a = manageTrade({ side: t.side, entry: t.entry, stop: t.stop, stop0: t.stop0, target: t.target, best, sameDay: t.strategy !== 'swing', openedAt: t.openedAt, ...(t.halfDone ? { halfDone: true } : {}) }, q.ltp, ctx.now, rules);
    let next: BotTrade = { ...t, best, worst };
    if (a.stop !== t.stop) {
      if (t.side === 'long') w = updateHolding(w, t.key, { stop: a.stop });
      else w = { ...w, shorts: (w.shorts ?? []).map((s) => (s.key === t.key ? { ...s, stop: a.stop } : s)) };
      next = { ...next, stop: a.stop };
    }
    if (!fresh) return next;
    // app v1.14: a "Rising now" quick trade: after 20 minutes it stays only while still "likely to keep
    // rising" (its safety net keeps following the price); "slowing" sells it at once (after 5 minutes)
    const mins = (ctx.now - t.openedAt) / 60_000;
    const tag = riseTags.get(t.key);
    if (t.strategy === 'rising' && t.side === 'long' && ((mins >= 20 && tag !== 'strong') || (mins >= 5 && tag === 'fading'))) {
      w = closePosition(w, t, q.ltp, ctx);
      return { ...next, closeWhy: tag === 'fading' ? 'Rising now turned to "slowing" — sold' : '20-minute quick trade done (no longer "likely to keep rising")' };
    }
    if (a.exit === 'quick') {
      w = closePosition(w, t, q.ltp, ctx);
      const losing = (q.ltp - t.entry) * (t.side === 'long' ? 1 : -1) < 0;
      return { ...next, closeWhy: losing ? `not working after ${rules.quickExitMin} minutes — closed early to cut the loss` : `went nowhere for ${rules.quickExitMin} minutes — closed to free the money` };
    }
    if (a.sellHalf) {
      const h = w.holdings.find((x) => x.key === t.key);
      const half = h ? Math.floor(h.qty / 2) : 0;
      if (h && half >= 1) {
        const r = placeOrder(w, { key: t.key, symbol: t.symbol, side: 'sell', qty: half, type: 'market', source: 'Auto-trader · half at target 1', ...(h.product ? { product: h.product, ...(h.marginPct !== undefined ? { marginPct: h.marginPct } : {}) } : {}) }, wq(q), ctx);
        if (r.ok && r.fill) {
          w = r.wallet;
          void alertHalf(t, half, r.fill.price).catch(() => undefined);
          return { ...next, halfDone: true, left: h.qty - half };
        }
      }
    }
    return next;
  });
  return { ...bot, wallet: w, trades };
}

/** Sells (or buys back) the whole position of a trade at `price`. */
function closePosition(w: WalletState, t: BotTrade, price: number, ctx: MarketCtx): WalletState {
  return t.side === 'long' ? sellFromBackground(w, t.key, price, ctx, 'stop').wallet : coverShort(w, t.key, price, ctx, 'stop').wallet;
}

/**
 * The day (app v1.13): keeps the day's profit once it is big enough, and stops at the daily loss limit
 * — both sell everything bought today and stop new trades until tomorrow.
 */
function guardDay(bot: BotState, quotes: Record<string, Quote>, ctx: MarketCtx): BotState {
  const rules = protectRules(bot.rules);
  const sum = walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), ctx.today);
  const money = sum.total - sum.todayPnl;
  const { guard, justHalted } = checkDay(bot.guard, ctx.today, sum.todayPnl, money, rules, ctx.now);
  let b: BotState = { ...bot, guard };
  if (!justHalted || !ctx.open) return b;
  let w = b.wallet;
  const why = justHalted === 'lock' ? `kept today's profit (the day was up ${signedRs(guard.best)}, came back to ${signedRs(sum.todayPnl)})` : `daily loss limit (${rules.dayLossPct}% of the money) reached`;
  const trades = b.trades.map((t) => {
    if (t.status !== 'open' || t.date !== ctx.today) return t;
    const p = quotes[t.key]?.ltp;
    if (!(p && p > 0)) return t;
    w = closePosition(w, t, p, ctx);
    return { ...t, closeWhy: justHalted === 'lock' ? "sold to keep today's profit" : 'sold at the daily loss limit' };
  });
  b = addLog({ ...b, wallet: w, trades }, ctx.now, 'info', `Stopped for today: ${why}. Sold what it bought today; it starts again tomorrow at 9:30.`);
  void alertHalt(justHalted, sum.todayPnl, trades.filter((t) => t.closeWhy && t.date === ctx.today && t.status === 'open').length).catch(() => undefined);
  return b;
}

/** Same-day trades left open after the close (app was closed at 3:10) and top picks past their time limit. */
function timeExits(bot: BotState, quotes: Record<string, Quote>, ctx: MarketCtx): BotState {
  let w = bot.wallet;
  for (const t of bot.trades) {
    if (t.status !== 'open' || t.side !== 'long') continue;
    const q = quotes[t.key];
    const price = q?.ltp ?? t.entry;
    const overdueDay = t.strategy !== 'swing' && (t.date < ctx.today || (!ctx.open && ctx.t >= 15 * 60 + 30));
    const overdueSwing = t.strategy === 'swing' && ctx.open && weekdaysBetween(t.date, ctx.today) >= SWING_MAX_DAYS;
    if (overdueDay || overdueSwing) w = sellFromBackground(w, t.key, price, ctx, 'day-end').wallet;
  }
  return { ...bot, wallet: w };
}

/**
 * The app was closed for a while during market hours: replays today's 5-minute candles since the
 * last run through the same rules, worst price first, so missed safety nets count as hit.
 */
async function catchUp(bot: BotState, ctx: MarketCtx): Promise<BotState> {
  const open = bot.trades.filter((t) => t.status === 'open');
  if (!open.length || !bot.lastRun || ctx.now - bot.lastRun < 4 * 60_000 || istDate(bot.lastRun) !== ctx.today) return bot;
  const sinceT = minutesIST(bot.lastRun);
  let w = bot.wallet;
  for (const t of open) {
    let bars;
    try {
      bars = await fetchTodayBars(t.key, ctx.now);
    } catch {
      continue;
    }
    if (!bars) continue;
    for (let i = 0; i < bars.t.length; i++) {
      const bt = bars.t[i]!;
      if (bt + 5 <= sinceT || bt >= ctx.t) continue;
      const h = w.holdings.find((x) => x.key === t.key);
      const s = (w.shorts ?? []).find((x) => x.key === t.key);
      if (!h && !s) break;
      const at = ctx.now - (ctx.t - bt - 5) * 60_000;
      const steps = t.side === 'long' ? [bars.o[i]!, bars.l[i]!, h?.target != null && bars.h[i]! >= h.target ? h.target : bars.h[i]!, bars.c[i]!] : [bars.o[i]!, bars.h[i]!, s && s.t2 !== null && bars.l[i]! <= s.t2 ? s.t2 : s && s.t1 !== null && bars.l[i]! <= s.t1 ? s.t1 : bars.l[i]!, bars.c[i]!];
      for (const p of steps) {
        const r = processWallet(w, { [t.key]: { ltp: p, prevClose: null, fetchedAt: at } }, { now: at, today: ctx.today, t: bt + 5, open: true });
        w = r.wallet;
      }
    }
  }
  return { ...bot, wallet: w };
}

// ---------------------------------------------------------------- studies (top picks, sell-first chances)

/** The best sell-first stocks by the per-stock model, with a plan from daily data (app v1.8). */
interface ShortTop {
  key: string;
  symbol: string;
  chance: number;
  live: boolean;
  price: number;
  plan: DailyShortPlan;
  reasons: string[];
}

let studies: { at: number; picks: BuySuggestion[]; calDate: string; calLive: Calibration | null; shortChance: Map<string, number>; shortTop: ShortTop[] } = { at: 0, picks: [], calDate: '', calLive: null, shortChance: new Map(), shortTop: [] };

let studiesRun: Promise<void> | null = null;

/** Every 15 minutes: the top picks (sized as if for the auto-trader's money) and the sell-first chances. A second caller waits for a run in progress. */
function refreshStudies(now: number, equity: number): Promise<void> {
  if (studiesRun) return studiesRun;
  if (now - studies.at < 15 * 60_000) return Promise.resolve();
  studiesRun = doRefreshStudies(now, equity).finally(() => {
    studiesRun = null;
  });
  return studiesRun;
}

async function doRefreshStudies(now: number, equity: number): Promise<void> {
  studies.at = now;
  try {
    const [settings, cal, quotes, keys] = await Promise.all([getSettings(), getCalendar(), getQuotes(), trackedKeys()]);
    const stocks = [];
    for (const key of keys) {
      const d = await loadStockData(key, { quote: quotes[key] ?? null, settings, calendar: cal, now });
      stocks.push({ key, symbol: d.instrument?.trading_symbol ?? key, data: d });
    }
    const botSettings = { ...settings, risk: { ...settings.risk, capitalInr: equity, sizing: 'split' as const, splitInto: 5 }, ui: { ...settings.ui, priceMin: 0, priceMax: null } };
    const res = suggestBuys(stocks, botSettings, [], istDate(now), { priceMin: 0, priceMax: null });
    studies.picks = [...res.suggestions, ...res.more].slice(0, 12);
    const today = istDate(now);
    const model = await getLocal('shortModel');
    // the score bands are only needed until the per-stock model exists
    if (studies.calDate !== today && !model) {
      const pairs: Pair[] = [];
      for (const s of stocks) if (s.data.candles.length > 60) pairs.push(...historyPairs(s.data.candles, indicatorsOf(s.data.candles)));
      studies.calLive = calibrate(pairs, 'score');
      studies.calDate = today;
    }
    if (model) {
      // app v1.7: each stock's own chance from the per-stock model
      const m = new Map<string, number>();
      const top: Array<{ st: (typeof stocks)[number]; chance: number; live: boolean; price: number }> = [];
      for (const st of stocks) {
        const c = stockChance(model, st.key, st.data.candles);
        if (!c) continue;
        m.set(st.key, c.chance);
        const last = st.data.candles[st.data.candles.length - 1]!;
        const price = quotes[st.key]?.ltp ?? last.close;
        // while the market is open: only stocks trading below today's opening price
        if (c.live && !(price < last.open)) continue;
        if (c.chance > model.baseRate) top.push({ st, chance: c.chance, live: c.live, price });
      }
      studies.shortChance = m;
      studies.shortTop = top
        .sort((a, b) => b.chance - a.chance)
        .slice(0, 10)
        .flatMap(({ st, chance, live, price }) => {
          const plan = dailyShortPlan(st.data.candles, price, 10_000, st.data.instrument?.tick ?? 0.05);
          if (!plan) return [];
          const c = st.data.candles;
          const setup = live ? shortSetupAt(c, c.length - 1, indicatorsOf(c), true) : shortSetupAt(c, c.length, indicatorsOf(c), false);
          return [{ key: st.key, symbol: st.symbol, chance, live, price, plan, reasons: (setup?.reasons ?? []).slice(0, 3) }];
        });
    } else if (studies.calLive) {
      const rows = shortSellList(
        stocks.map((s) => ({ key: s.key, symbol: s.symbol, candles: s.data.candles, ltp: quotes[s.key]?.ltp ?? null, news: 0 })),
        studies.calLive,
        studies.calLive,
      );
      studies.shortChance = new Map(rows.filter((r) => r.chance !== null).map((r) => [r.key, r.chance!]));
    }
  } catch (err) {
    log.info('Auto-trader studies not updated', { reason: errorMessage(err) });
  }
}

/** For tests: forget the cached studies. */
export function resetBotStudies(): void {
  studies = { at: 0, picks: [], calDate: '', calLive: null, shortChance: new Map(), shortTop: [] };
}

// ---------------------------------------------------------------- ideas

async function gatherIdeas(now: number, quotes: Record<string, Quote>): Promise<Idea[]> {
  const today = istDate(now);
  const t = minutesIST(now);
  const [signals, flow, breadth, shortIdeas, news, breakouts, boTest] = await Promise.all([
    getSession('daySignals'),
    getSession('flow'),
    getSession('breadth'),
    getSession('shortIdeas'),
    getSession('news'),
    getSession('breakouts'),
    getLocal('breakoutTest'),
  ]);
  const br = breadth && breadth.advanced + breadth.declined > 20 ? (breadth.advanced - breadth.declined) / (breadth.advanced + breadth.declined) : 0;
  const mood = (key: string): number => {
    const s = stockSentiment((news?.items ?? []).filter((i) => i.key === key), now);
    return s ? (s.label === 'good' ? 1 : s.label === 'bad' ? -1 : 0) : 0;
  };
  const flowOf = (key: string) => flow?.stocks[key];
  const pressureOf = (key: string, q: Quote): { pressure: number; vwapPct: number } => {
    const f = flowOf(key);
    if (!f) return { pressure: 0, vwapPct: 0 };
    const m = buyersMeter({ ltp: q.ltp, vwap: f.vwap, buyQty: f.buyQty, sellQty: f.sellQty });
    return { pressure: m.score / 2, vwapPct: m.vsVwapPct ?? 0 };
  };
  const ctxOf = (key: string, q: Quote, strategy: Strategy, prior: number, stop: number, dir: 1 | -1): IdeaContext => {
    const p = pressureOf(key, q);
    return {
      strategy,
      prior,
      movePct: q.prevClose ? (q.ltp / q.prevClose - 1) * 100 * dir : 0,
      pressure: p.pressure * dir,
      breadth: br * dir,
      t,
      news: mood(key) * dir,
      vwapPct: p.vwapPct * dir,
      riskPct: (Math.abs(q.ltp - stop) / q.ltp) * 100,
    };
  };
  const ideas: Idea[] = [];
  const fresh = (q: Quote | undefined): q is Quote => !!q && q.ltp > 0 && now - q.fetchedAt < 2 * 60_000;

  // 1. day-trade buy signals (the self-learning model's chance when it has one)
  for (const s of signals?.date === today ? signals.signals : []) {
    const q = quotes[s.key];
    if (s.side !== 'long' || !fresh(q) || signalState(s, q.ltp, now) !== 'fresh' || q.ltp <= s.stop) continue;
    const target = s.target ?? q.ltp + 2 * (q.ltp - s.stop);
    if (q.ltp >= target) continue;
    const prior = s.chance ?? (s.trusted ? 0.5 : 0.45);
    ideas.push({ key: s.key, symbol: s.symbol, strategy: 'day-buy', side: 'long', price: q.ltp, stop: s.stop, target, ctx: ctxOf(s.key, q, 'day-buy', prior, s.stop, 1), reasons: [`day-trade buy signal at ${s.entry.toFixed(2)}`, s.chance !== undefined ? `self-learning chance ${Math.round(s.chance * 100)}%` : s.trusted ? 'these signals passed the past test' : 'signals not tested yet'] });
  }
  // 2. "Rising now" (app v1.14): the live list's "likely to keep rising" stocks, with the quick-trade
  //    plan (+0.6 % / −0.4 %, 20 minutes) and the measured chance from days the model never saw
  const rise = await getSession('rise');
  const liveRise = rise && rise.date === today && now - rise.at < 60_000 ? rise.rows.filter((r) => r.tag === 'strong') : [];
  for (const r of liveRise) {
    const q = quotes[r.key];
    if (!fresh(q) || q.ltp >= r.plan.target || q.ltp <= r.plan.stop) continue;
    const plan = quickPlanFrom(q.ltp, now);
    const prior = Math.min(0.75, Math.max(0.3, r.measured ?? r.chance ?? 0.5));
    ideas.push({ key: r.key, symbol: r.symbol, strategy: 'rising', side: 'long', price: q.ltp, stop: plan.stop, target: plan.target, ctx: ctxOf(r.key, q, 'rising', prior, plan.stop, 1), reasons: ['Rising now: likely to keep rising', ...r.reasons.slice(0, 2)] });
  }
  // the older list only while the live one has nothing (e.g. no model yet)
  for (const r of liveRise.length ? [] : (flow?.rising ?? [])) {
    const q = quotes[r.key];
    const f = flowOf(r.key);
    if (!fresh(q)) continue;
    const vw = f?.vwap ?? q.ltp * 0.99;
    const stop = Math.round(Math.min(q.ltp * 0.996, Math.max(vw * 0.998, q.ltp * 0.988)) * 20) / 20;
    const target = Math.round((q.ltp + 2 * (q.ltp - stop)) * 20) / 20;
    const prior = Math.min(0.55, 0.44 + 0.03 * r.meter.score);
    const symbol = (await getInstrument(r.key))?.trading_symbol ?? r.key;
    ideas.push({ key: r.key, symbol, strategy: 'rising', side: 'long', price: q.ltp, stop, target, ctx: ctxOf(r.key, q, 'rising', prior, stop, 1), reasons: [`up ${r.fromOpenPct.toFixed(1)}% since the open`, r.meter.label.toLowerCase(), r.pace ? `${r.pace.toFixed(1)}× the usual trading` : 'busy trading'] });
  }
  // 3. top picks (hold a few days) — only near the planned buy price
  for (const p of studies.picks) {
    const q = quotes[p.key];
    if (!fresh(q) || q.ltp <= p.plan.stop || q.ltp >= p.plan.target || q.ltp > p.plan.entry * 1.01) continue;
    const prior = p.safeChance ?? p.safetyScore ?? 0.5;
    ideas.push({ key: p.key, symbol: p.symbol, strategy: 'swing', side: 'long', price: q.ltp, stop: p.plan.stop, target: p.plan.target, ctx: ctxOf(p.key, q, 'swing', prior, p.plan.stop, 1), reasons: [`top pick: ${p.summary}`, `made money ${p.record.profitable} of ${p.record.samples} times in the past`] });
  }
  // 4. sell first: the "Falling now" scan (5-minute candles), with the measured fall chance when known
  for (const s of shortIdeas && istDate(shortIdeas.at) === today && now - shortIdeas.at < 10 * 60_000 ? shortIdeas.ideas : []) {
    const q = quotes[s.key];
    if (!fresh(q) || q.ltp >= s.plan.stop || q.ltp <= s.plan.t1) continue;
    const measured = studies.shortChance.get(s.key);
    const prior = measured ?? Math.min(0.55, Math.max(0.35, 0.4 + (s.score - 60) / 200));
    ideas.push({ key: s.key, symbol: s.symbol, strategy: 'short', side: 'short', price: q.ltp, stop: s.plan.stop, target: s.plan.t2, t1: s.plan.t1, ctx: ctxOf(s.key, q, 'short', prior, s.plan.stop, -1), reasons: [`falling now (score ${s.score})`, ...s.reasons.slice(0, 2).map((x) => x.text), ...(measured !== undefined ? [`similar days fell ${Math.round(measured * 100)}% of the time`] : [])] });
  }
  // 5. the Stocks tab's live "For short selling" list (app v1.9): each stock's own fall chance from its
  //    model, only while it trades below today's opening price; plan from its daily prices
  for (const tTop of studies.shortTop) {
    const q = quotes[tTop.key];
    if (!tTop.live || !fresh(q) || ideas.some((i) => i.key === tTop.key && i.side === 'short')) continue;
    if (q.ltp >= tTop.plan.stop || q.ltp <= tTop.plan.t1 || (q.open !== null && q.ltp >= q.open)) continue;
    const prior = Math.min(0.7, Math.max(0.3, tTop.chance));
    ideas.push({ key: tTop.key, symbol: tTop.symbol, strategy: 'short', side: 'short', price: q.ltp, stop: tTop.plan.stop, target: tTop.plan.t2, t1: tTop.plan.t1, ctx: ctxOf(tTop.key, q, 'short', prior, tTop.plan.stop, -1), reasons: ['in the Stocks tab’s “For short selling” list', `its own chance from a year of prices: ${Math.round(tTop.chance * 100)}%`, ...tTop.reasons.slice(0, 1)] });
  }
  // 6. 🚀 breakouts (app v1.9): fresh live breakouts above today's resistance with a volume surge; the
  //    chance starts from the breakout rule's past test and the brain learns from every result.
  //    Target = 1× the risk from the price now (the same as the past test's first target).
  const boPrior = boTest && boTest.older.trades + boTest.newer.trades >= 20 ? boTest.winRate : 0.45;
  for (const b of breakouts?.date === today ? breakouts.signals : []) {
    const q = quotes[b.key];
    if ((b.status !== 'breakout' && b.status !== 'confirmed') || !fresh(q) || now - (b.confirmedAt ?? b.at) > 10 * 60_000) continue;
    const R0 = b.plan.entry - b.plan.stop;
    if (q.ltp <= b.plan.stop || q.ltp > b.plan.entry + 0.3 * R0) continue;
    const stop = b.plan.stop;
    const target = Math.round((q.ltp + (q.ltp - stop)) * 20) / 20;
    const prior = Math.min(0.62, Math.max(0.35, boPrior + (b.status === 'confirmed' ? 0.03 : 0) + (b.score - 60) / 500));
    ideas.push({ key: b.key, symbol: b.symbol, strategy: 'breakout', side: 'long', price: q.ltp, stop, target, ctx: ctxOf(b.key, q, 'breakout', prior, stop, 1), reasons: [b.status === 'confirmed' ? `confirmed breakout above ₹${b.level.toFixed(2)}` : `broke above ₹${b.level.toFixed(2)} with a volume surge`, ...b.reasons.slice(1, 3)] });
  }
  return ideas;
}

// ---------------------------------------------------------------- suggestions for your own practice trades (app v1.8)

export interface Suggestion {
  key: string;
  symbol: string;
  side: 'buy' | 'sell';
  kind: Strategy;
  /** price used for the plan (live, or the last close when the market is closed) */
  price: number;
  stop: number;
  target: number;
  /** sell first: the first target (half is bought back there) */
  t1?: number;
  /** 0–1: the brain's chance (studies + its own learning + live signs + news), or the model's */
  chance: number;
  /** expected result in R after charges (live ideas) */
  ev: number | null;
  news: 'good' | 'bad' | null;
  reasons: string[];
  /** a same-day trade (sold / bought back by 3:10 pm) */
  sameDay: boolean;
  when: 'now' | 'next-session';
}

/**
 * The best practice trades right now for one side, ranked by the same analysis the auto-trader uses:
 * the app's studies (day-trade model, top picks' record, the per-stock fall model, the 5-minute scan),
 * corrected by what the auto-trader learned from its own results, live buyers vs sellers, the whole
 * market's mood and today's news. With the market closed: top picks and the next session's
 * sell-first candidates.
 */
export async function suggestIdeas(side: 'buy' | 'sell', now = Date.now()): Promise<{ at: number; marketOpen: boolean; items: Suggestion[] }> {
  const bot = await getBot(now);
  const ctx = await marketCtx(now);
  const quotes = await getQuotes();
  const equity = walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), ctx.today).total;
  await refreshStudies(now, equity);
  const news = await getSession('news');
  const moodOf = (key: string): 'good' | 'bad' | null => {
    const m = stockSentiment((news?.items ?? []).filter((i) => i.key === key), now);
    return m && m.label !== 'neutral' ? m.label : null;
  };
  const items: Suggestion[] = [];
  const seen = new Set<string>();
  if (ctx.open) {
    for (const i of await gatherIdeas(now, quotes)) {
      if ((side === 'buy') !== (i.side === 'long')) continue;
      const sc = scoreIdea(bot.brain, i);
      if (!sc || seen.has(i.key)) continue;
      seen.add(i.key);
      items.push({ key: i.key, symbol: i.symbol, side, kind: i.strategy, price: i.price, stop: i.stop, target: i.target, ...(i.t1 !== undefined ? { t1: i.t1 } : {}), chance: sc.chance, ev: sc.ev, news: moodOf(i.key), reasons: i.reasons, sameDay: i.strategy !== 'swing', when: 'now' });
    }
  }
  if (side === 'buy') {
    for (const p of studies.picks) {
      if (seen.has(p.key)) continue;
      const q = quotes[p.key];
      const price = q?.ltp ?? p.plan.entry;
      if (price <= p.plan.stop || price >= p.plan.target) continue;
      seen.add(p.key);
      items.push({ key: p.key, symbol: p.symbol, side, kind: 'swing', price, stop: p.plan.stop, target: p.plan.target, chance: p.safeChance ?? p.safetyScore, ev: null, news: moodOf(p.key), reasons: [`top pick: ${p.summary}`, `made money ${p.record.profitable} of ${p.record.samples} times in the past`], sameDay: false, when: ctx.open ? 'now' : 'next-session' });
    }
  } else {
    for (const t of studies.shortTop) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      items.push({ key: t.key, symbol: t.symbol, side, kind: 'short', price: t.price, stop: t.plan.stop, target: t.plan.t2, t1: t.plan.t1, chance: t.chance, ev: null, news: moodOf(t.key), reasons: [...t.reasons, `its own chance from a year of prices: ${Math.round(t.chance * 100)}%`], sameDay: true, when: ctx.open ? 'now' : 'next-session' });
    }
  }
  // good news helps a buy and hurts a sell-first (and the other way round) — shown, and used as a tie-break
  const newsScore = (x: Suggestion) => (x.news === null ? 0 : (x.news === 'good') === (side === 'buy') ? 0.03 : -0.03);
  items.sort((a, b) => (b.ev ?? -1) - (a.ev ?? -1) || b.chance + newsScore(b) - (a.chance + newsScore(a)));
  return { at: now, marketOpen: ctx.open, items: items.slice(0, 8) };
}

// ---------------------------------------------------------------- the loop

/** On every price update (exits) and once a minute (new trades). Never twice at the same time. */
export function runBot(now = Date.now(), force = false): Promise<BotState | null> {
  return queue(async () => {
    const stored = await getLocal('bot');
    let bot = stored ?? newBot(now);
    if (!bot.enabled) return bot;
    const ctx = await marketCtx(now);
    const quotes = await getQuotes();
    const before = JSON.stringify([bot.wallet.fills.length, bot.trades.map((t) => [t.status, t.stop])]);

    if (ctx.open && bot.lastRun && now - bot.lastRun > 4 * 60_000 && istDate(bot.lastRun) === ctx.today) bot = { ...bot, lastGap: { from: bot.lastRun, to: now } };
    if (ctx.open) bot = await catchUp(bot, ctx);
    const riseS = await getSession('rise');
    const riseTags = new Map<string, 'strong' | 'unclear' | 'fading'>();
    if (riseS && riseS.date === ctx.today && now - riseS.at < 60_000) for (const h of riseS.held) if (h.source === 'auto') riseTags.set(h.key, h.tag);
    bot = manageOpen(bot, quotes, ctx, riseTags);
    bot = timeExits(bot, quotes, ctx);
    bot = { ...bot, wallet: processWallet(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), ctx).wallet };
    bot = settleClosed(bot, now);
    bot = guardDay(bot, quotes, ctx);
    bot = settleClosed(bot, now);

    if (bot.day.date !== ctx.today) bot = { ...bot, day: { date: ctx.today, opened: 0 } };
    const sum = walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), ctx.today);

    if (ctx.open && (force || now - bot.lastDecideAt >= 60_000)) {
      await refreshStudies(now, sum.total);
      const ideas = await gatherIdeas(now, quotes);
      const openTrades = bot.trades.filter((t) => t.status === 'open');
      const rules = protectRules(bot.rules);
      const swingValue = openTrades.filter((t) => t.strategy === 'swing').reduce((a, t) => a + t.qty * (quotes[t.key]?.ltp ?? t.entry), 0);
      const plan = decide(
        bot.brain,
        ideas,
        { equity: sum.total, free: sum.free, openKeys: openTrades.map((t) => t.key), openCount: openTrades.length, newToday: bot.day.opened, todayPnl: sum.todayPnl, t: ctx.t, rules, halted: bot.guard?.date === ctx.today ? bot.guard.halted : null, swingValue },
        `${ctx.today}-${ctx.t}`,
      );
      for (const d of plan.decisions) {
        const i = d.idea;
        const q = wq(quotes[i.key]);
        const source = `Auto-trader · ${STRATEGY_LABEL[i.strategy]}`;
        const r = i.side === 'long'
          ? // same-day buys as Upstox Intraday (cheaper charges), paid in full — no borrowing
            placeOrder(bot.wallet, { key: i.key, symbol: i.symbol, side: 'buy', qty: d.qty, type: 'market', stop: i.stop, target: i.target, sellByClose: i.strategy !== 'swing', source, ...(i.strategy !== 'swing' ? { product: 'intraday' as const, marginPct: 1 } : {}) }, q, ctx)
          : openShort(bot.wallet, { key: i.key, symbol: i.symbol, qty: d.qty, stop: i.stop, t1: i.t1 ?? (i.price + i.target) / 2, t2: i.target, source }, q, ctx);
        if (!r.ok || !r.fill) {
          bot = addLog(bot, now, 'info', `Could not open ${i.symbol}: ${r.ok ? 'not filled' : r.error}`);
          continue;
        }
        const entry = r.fill.price;
        const trade: BotTrade = {
          id: newId(now),
          key: i.key,
          symbol: i.symbol,
          strategy: i.strategy,
          side: i.side,
          qty: d.qty,
          entry,
          stop: i.stop,
          stop0: i.stop,
          target: i.target,
          ...(i.t1 !== undefined ? { t1: i.t1 } : {}),
          openedAt: now,
          date: ctx.today,
          x: i.x,
          chance: i.chance,
          prior: i.ctx.prior,
          riskRupees: Math.max(1, Math.round(Math.abs(entry - i.stop) * d.qty)),
          explore: d.explore,
          reasons: i.reasons,
          sizeWhy: d.sizeWhy,
          status: 'open',
          best: entry,
          worst: entry,
          product: i.strategy === 'swing' ? 'delivery' : 'intraday',
        };
        bot = { ...bot, wallet: r.wallet, trades: [...bot.trades, trade].slice(-400), day: { ...bot.day, opened: bot.day.opened + 1 } };
        bot = addLog(bot, now, 'open', `${i.side === 'long' ? 'Bought' : 'Sold first'} ${d.qty} ${i.symbol} at ${px(entry)} (${rupees(d.qty * entry)}) — ${STRATEGY_LABEL[i.strategy].toLowerCase()}, ${Math.round(i.chance * 100)}% chance. ${d.sizeWhy}`);
        log.info(`Auto-trader ${i.side === 'long' ? 'bought' : 'sold first'} ${d.qty} ${i.symbol} @ ${entry}`);
        void alertOpen(trade).catch(() => undefined);
      }
      bot = { ...bot, lastDecideAt: now, note: plan.note, looked: ideas.length };
    } else if (!ctx.open) {
      bot = { ...bot, note: 'Market closed — it trades by itself from 9:30 am on market days.' };
    }

    // one point per day for the chart
    const eq = [...bot.equity];
    if (eq.length && eq[eq.length - 1]!.date === ctx.today) eq[eq.length - 1] = { date: ctx.today, total: Math.round(sum.total) };
    else eq.push({ date: ctx.today, total: Math.round(sum.total) });
    bot = { ...bot, equity: eq.slice(-250), lastRun: now, wallet: { ...bot.wallet, fills: bot.wallet.fills.slice(-600), orders: bot.wallet.orders.filter((o) => o.status === 'open' || now - o.createdAt < 3 * 86_400_000) } };

    const changed = before !== JSON.stringify([bot.wallet.fills.length, bot.trades.map((t) => [t.status, t.stop])]);
    if (!stored || changed || now - (stored.lastRun ?? 0) >= 30_000 || force) await setLocal('bot', bot);
    return bot;
  });
}

export function botSetEnabled(enabled: boolean, now = Date.now()): Promise<void> {
  return queue(async () => {
    const bot = await getBot(now);
    await setLocal('bot', addLog({ ...bot, enabled }, now, 'info', enabled ? 'Switched on — it trades by itself again.' : 'Paused by you — open trades are kept but nothing new is opened.'));
  });
}

/** Start again with any amount (₹50 lakh by default); keep what it learned unless `forget`. */
export function botReset(forget: boolean, startCash = BOT_START, now = Date.now()): Promise<void> {
  return queue(async () => {
    const old = await getLocal('bot');
    const cash = Number.isFinite(startCash) && startCash >= 10_000 ? Math.round(startCash) : BOT_START;
    const fresh = newBot(now, forget || !old ? newBrain() : old.brain, cash);
    await setLocal('bot', addLog(fresh, now, 'info', forget ? `Reset: ${rupees(cash)} and a fresh brain.` : `Reset to ${rupees(cash)}; kept what it learned from ${old?.brain.n ?? 0} trades.`));
  });
}

// ---------------------------------------------------------------- amount and protection (app v1.13)

/**
 * Sets the money the auto-trader trades with — e.g. what is in your Upstox account — without starting
 * again: more money is added to its cash, less is taken from its free cash. Open trades and what it
 * learned are kept; the overall result is counted from the new amount.
 */
export function botSetAmount(amount: number, now = Date.now()): Promise<{ total: number; free: number }> {
  return queue(async () => {
    if (!Number.isFinite(amount) || amount < 10_000) throw new Error('Enter at least ₹10,000.');
    const target = Math.round(amount);
    const stored = await getLocal('bot');
    if (!stored) {
      const fresh = addLog(newBot(now, newBrain(), target), now, 'info', `Amount set to ${rupees(target)}.`);
      await setLocal('bot', fresh);
      return { total: target, free: target };
    }
    const bot = { ...stored, brain: upgradeBrain(stored.brain) };
    const quotes = await getQuotes();
    const sum = walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), istDate(now));
    const delta = Math.round((target - sum.total) * 100) / 100;
    if (delta < 0 && -delta > sum.free + 0.5) {
      throw new Error(`${rupees(sum.total - sum.free)} is in open trades right now, so the lowest amount it can go to is ${rupees(sum.total - sum.free)}. Try again when trades have closed.`);
    }
    const wallet: WalletState = { ...bot.wallet, cash: Math.round((bot.wallet.cash + delta) * 100) / 100, startCash: Math.round((bot.wallet.startCash + delta) * 100) / 100 };
    const next = addLog({ ...bot, wallet }, now, 'info', `Amount set to ${rupees(target)} (${delta >= 0 ? 'added' : 'took out'} ${rupees(Math.abs(delta))}). Open trades and what it learned are kept.`);
    await setLocal('bot', next);
    return { total: target, free: Math.round(sum.free + delta) };
  });
}

/** Changes the money protection (any missing value keeps its current setting). */
export function botSetRules(patch: Partial<ProtectRules>, now = Date.now()): Promise<ProtectRules> {
  return queue(async () => {
    const bot = await getBot(now);
    const rules = protectRules({ ...protectRules(bot.rules), ...patch });
    await setLocal('bot', addLog({ ...bot, rules }, now, 'info', rules.on ? `Protection: keep the profit from +${rules.lockStartPct}%, daily loss limit −${rules.dayLossPct}%, few-days picks at most ${rules.swingSharePct}%, quick exit ${rules.quickExitMin ? `after ${rules.quickExitMin} min` : 'off'}.` : 'Protection switched off (as before 1.13: no day limits).'));
    return rules;
  });
}

// ---------------------------------------------------------------- alerts you can copy (app v1.13)

async function botAlertsOn(): Promise<boolean> {
  return (await getSettings()).notifications.bot !== false;
}

const copyOf = (t: BotTrade) => ({ symbol: t.symbol, side: t.side, qty: t.qty, entry: t.entry, stop: t.stop, target: t.target, swing: t.strategy === 'swing', ...(t.t1 !== undefined ? { t1: t.t1 } : {}) });

async function alertOpen(t: BotTrade): Promise<void> {
  if (!(await botAlertsOn())) return;
  await notify(`alert:bot-open-${t.id}`, {
    title: `🤖 Auto-trader ${t.side === 'long' ? 'bought' : 'sold first'} ${t.qty} ${t.symbol} at ${px(t.entry)}`,
    message: `${copyLine(copyOf(t))} ${Math.round(t.chance * 100)}% chance · ${STRATEGY_LABEL[t.strategy].toLowerCase()}.`,
    priority: 2,
  });
}

async function alertHalf(t: BotTrade, qty: number, price: number): Promise<void> {
  if (!(await botAlertsOn())) return;
  await notify(`alert:bot-half-${t.id}`, {
    title: `🤖 Auto-trader sold half of ${t.symbol}: ${qty} at ${px(price)}`,
    message: `Target 1 reached. If you copied it: sell ${qty} ${t.symbol} in Upstox now; the rest keeps a safety net at the buy price or higher.`,
    priority: 2,
  });
}

async function alertClose(t: BotTrade, price: number): Promise<void> {
  if (!(await botAlertsOn())) return;
  await notify(`alert:bot-close-${t.id}`, {
    title: `🤖 Auto-trader ${t.side === 'long' ? 'sold' : 'bought back'} ${t.symbol} at ${px(price)}: ${signedRs(t.pnl ?? 0)}`,
    message: `${t.exitWhy ?? 'closed'}. If you copied it: ${t.side === 'long' ? 'sell' : 'buy back'} the rest of ${t.symbol} in Upstox now (and cancel its stop-loss order).`,
    priority: 2,
  });
}

async function alertHalt(why: 'lock' | 'loss', pnl: number, sold: number): Promise<void> {
  if (!(await botAlertsOn())) return;
  await notify(`alert:bot-halt-${why}-${Date.now()}`, {
    title: why === 'lock' ? `🤖 Auto-trader kept today's profit: ${signedRs(pnl)}` : `🤖 Auto-trader hit today's loss limit: ${signedRs(pnl)}`,
    message: `It sold ${sold} trade${sold === 1 ? '' : 's'} bought today and stops until tomorrow 9:30. If you copied its trades: sell (or buy back) what you bought today in Upstox.`,
    priority: 2,
    requireInteraction: true,
  });
}
