import { calibrate, historyPairs, indicatorsOf, shortSellList, shortSetupAt, type Calibration, type Pair } from '../advisor/shortSell';
import { suggestBuys, type BuySuggestion } from '../advisor/suggest';
import { stockChance } from '../advisor/shortModel';
import { dailyShortPlan, type DailyShortPlan } from '../advisor/shortPlan';
import { newBrain, learnFrom, upgradeBrain, type Brain, type IdeaContext, type Strategy } from '../bot/brain';
import { addSample, evaluateAll, priorsFrom, toSample, type EvidenceSummary, type PlaybookEvidence, type PlaybookMemo, type PlaybookState, type SampleBook } from '../bot/evidence';
import { PLAYBOOK_LABEL, playbookOf, RISE_STRONG_REASON, type PlaybookId } from '../bot/playbooks';
import { BOT_START, decide, scoreIdea, SWING_MAX_DAYS, type Idea, type MarketGates, type ShadowPick } from '../bot/policy';
import { checkDay, drawdownFactor, drawdownOf, DRAWDOWN, manageTrade, openRiskOf, protectRules, type DayGuard, type ProtectRules } from '../bot/protect';
import { notify } from '../notify/chrome';
import { copyLine } from '../bot/copy';
import { marketGate, marketInputs } from '../early/early';
import { sideStats } from '../intraday/record';
import { marketRising } from '../intraday/short';
import { PLAN as RISE_PLAN, quickPlan as quickPlanFrom } from '../rising/momentum';
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
import { scanUniverse } from './scanList';
import { coverShort, estimateCharges, newWallet, openShort, placeOrder, processWallet, sellFromBackground, updateHolding, walletSummary, type Fill, type MarketCtx, type WalletQuote, type WalletState } from '../wallet/wallet';

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
  /** app v1.23: the kind of trade it was judged as (older trades: read with bot/playbooks.playbookOf) */
  playbook?: PlaybookId;
  /** app v1.23: the kind's state when it was opened (trial = small size) */
  state?: PlaybookState;
  /** app v1.23: its charges in R when it was opened */
  chargesR?: number;
  /** app v1.23: the result in R before charges (the evidence counts this, bot/evidence.ts) */
  grossR?: number;
  /** app v1.23: a shadow trade — followed with no money, never alerted (only in `BotState.shadow`) */
  shadow?: true;
}

/**
 * App v1.23 — shadow trades: the ideas of kinds of trade that may not use money yet (not proven, paused,
 * two losses today), followed in a separate pretend wallet so they can prove themselves. They never count
 * in the auto-trader's money, its open trades, its limits or its alerts.
 */
export interface ShadowBook {
  wallet: WalletState;
  trades: BotTrade[];
  /** IST date and shadow trades opened that day */
  day: { date: string; opened: number };
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
  /**
   * app v1.22 (cloud auto-trader): counts every change that matters — a fill, a trade opened or closed, a
   * safety net moved, a setting changed (not the every-30-seconds "still running" saves). Controls sent
   * from a phone can say which version they saw, so nothing is changed on top of a state nobody looked at.
   */
  rev?: number;
  /** app v1.22: when this state was last saved */
  updatedAt?: number;
  /** app v1.23: shadow trades (see ShadowBook) */
  shadow?: ShadowBook;
  /** app v1.23: the newest results of each kind of trade (kept when it starts again without forgetting) */
  samples?: SampleBook;
  /** app v1.23: switched off by you / paused, per kind of trade */
  playbooks?: Partial<Record<PlaybookId, PlaybookMemo>>;
  /** app v1.23: each kind's state, worked out by the one that runs it (the screen shows this) */
  evidence?: EvidenceSummary;
  /** app v1.23: its best money so far (the drawdown brake counts from it) */
  peak?: number;
  /** app v1.23: stopped 8 % below its best — no new trades until Resume */
  ddStop?: { at: number; peak: number; total: number } | null;
}

/** Pretend cash of the shadow wallet: never the limit (shadow trades are sized like trial trades). */
export const SHADOW_CASH = 10_000_000_000;
/** At most this many shadow trades open at once, and opened a day. */
export const SHADOW_MAX_OPEN = 8;
export const SHADOW_MAX_DAY = 30;

export const newShadow = (now: number): ShadowBook => ({ wallet: newWallet(now, SHADOW_CASH), trades: [], day: { date: '', opened: 0 } });

export function newBot(now: number, brain: Brain = newBrain(), startCash = BOT_START): BotState {
  return { v: 1, enabled: true, createdAt: now, wallet: newWallet(now, startCash), brain, trades: [], log: [{ at: now, kind: 'info', text: `Started with ${rupees(startCash)} of pretend money.` }], day: { date: '', opened: 0 }, lastRun: 0, lastDecideAt: 0, note: null, looked: 0, equity: [] };
}

const rupees = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const signedRs = (x: number) => `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const px = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let seq = 0;
const newId = (now: number) => `B${now.toString(36)}${(seq++ % 1296).toString(36)}`;

export async function getBot(now = Date.now()): Promise<BotState> {
  const g = await gate.check();
  // app v1.22: a phone whose auto-trader runs on the server reads the server's copy (its brain, its rules)
  const b = !g.run && gate.view ? await gate.view() : await getLocal('bot');
  // app v1.9: a brain saved by an older version learns the new kinds of trade (breakouts) too
  return b ? { ...b, brain: upgradeBrain(b.brain) } : newBot(now);
}

// ---------------------------------------------------------------- app v1.22: one auto-trader, one writer

/**
 * Who may run and change the auto-trader stored here. The phone: yes, unless its auto-trader was moved
 * to the user's server (then the server is the only one that trades it, and the phone only shows it).
 * The server: only after the owner moved it there (before that it is on standby and changes nothing).
 * The default (no gate set) is the app as it always was: it runs here.
 */
export interface BotGateAnswer {
  /** may run: open, manage and close trades, learn */
  run: boolean;
  /** may change it: switch, amount, protection, start again */
  write: boolean;
  /** in plain words, when not allowed */
  reason: string;
}

export interface BotGate {
  check(): BotGateAnswer | Promise<BotGateAnswer>;
  /** where to read the auto-trader from when it does not run here (the phone: the server's copy) */
  view?: () => Promise<BotState | null>;
}

const OPEN_GATE: BotGate = { check: () => ({ run: true, write: true, reason: '' }) };
let gate: BotGate = OPEN_GATE;

export function setBotGate(g: BotGate | null): void {
  gate = g ?? OPEN_GATE;
}

/** The auto-trader runs somewhere else (on the server), so it cannot be changed here. */
export class BotElsewhereError extends Error {
  override name = 'BotElsewhereError';
}

async function mayWrite(): Promise<void> {
  const g = await gate.check();
  if (!g.write) throw new BotElsewhereError(g.reason || 'The auto-trader cannot be changed here.');
}

/** What one run did (for the server's health report). */
export interface BotRunInfo {
  at: number;
  /** looked for new trades this time */
  decided: boolean;
  opened: number;
  closed: number;
  /** written to storage */
  saved: boolean;
  /** newest price it had (null = none) */
  priceAt: number | null;
  /** market open but prices not fresh: no new trades */
  stale: boolean;
  note: string | null;
  rev: number;
}

export interface BotObserver {
  onRun?(info: BotRunInfo): void;
  /** gated: it did not run here (the reason) */
  onSkip?(reason: string, at: number): void;
  onError?(err: unknown, at: number): void;
}

let observer: BotObserver = {};
export function setBotObserver(o: BotObserver | null): void {
  observer = o ?? {};
}

/**
 * Runs `fn` while no auto-trader run or change is going on (the same one-at-a-time line they use) — for
 * the server's move of an auto-trader from a phone, which must not mix with a run.
 */
export function withBotLock<T>(fn: () => Promise<T>): Promise<T> {
  return queue(fn);
}

/** Saves the auto-trader; `material` = a change that matters (a fill, a trade, a setting): a new version. */
async function saveBot(bot: BotState, now: number, material: boolean, prev: BotState | null | undefined): Promise<BotState> {
  const rev = (prev?.rev ?? bot.rev ?? 0) + (material || !prev ? 1 : 0);
  const next: BotState = { ...bot, rev, updatedAt: now };
  await setLocal('bot', next);
  return next;
}

/** Prices older than this are not used for new trades (the same limit the practice wallet uses). */
export const BOT_PRICE_MAX_AGE_MS = 2 * 60_000;

/** The newest price time among the quotes (null = no prices at all). */
export function newestPriceAt(quotes: Record<string, Quote>): number | null {
  let t: number | null = null;
  for (const q of Object.values(quotes)) if (q && q.ltp > 0 && (t === null || q.fetchedAt > t)) t = q.fetchedAt;
  return t;
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

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A trade whose position is gone from its wallet: its result after charges, its charges and its last fill. */
function closedResult(w: WalletState, t: BotTrade): { pnl: number; charges: number; last: Fill } | null {
  if (t.status !== 'open' || isOpenInWallet(w, t)) return null;
  const fills = w.fills.filter((f) => f.key === t.key && f.at >= t.openedAt && f.pnl !== undefined);
  if (!fills.length) return null;
  return { pnl: r2(fills.reduce((s, f) => s + (f.pnl ?? 0), 0)), charges: r2(fills.reduce((s, f) => s + (f.charges ?? 0), 0)), last: fills[fills.length - 1]! };
}

/** Why a trade ended, in plain words. */
function exitWhyOf(t: BotTrade, last: Fill): string {
  return (
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
            : 'closed')
  );
}

/** Trades whose position is gone from the wallet: work out the result, learn from it and keep it as evidence. */
export function settleClosed(bot: BotState, now: number): BotState {
  let b = bot;
  for (const t of bot.trades) {
    const res = closedResult(b.wallet, t);
    if (!res) continue;
    const { pnl, charges, last } = res;
    const r = t.riskRupees > 0 ? r2(pnl / t.riskRupees) : 0;
    // app v1.23: the result before charges too — the evidence of its kind of trade counts that
    const grossR = t.riskRupees > 0 ? r2((pnl + charges) / t.riskRupees) : 0;
    const why = exitWhyOf(t, last);
    const lesson = learnFrom(b.brain, t.x, pnl > 0, r, pnl, t.strategy);
    const closed: BotTrade = { ...t, status: 'closed', closedAt: last.at, exitPrice: last.price, pnl, r, grossR, exitWhy: why, lesson: lesson.text };
    const sample = toSample(closed);
    b = { ...b, brain: lesson.brain, trades: b.trades.map((x) => (x.id === t.id ? closed : x)), ...(sample ? { samples: addSample(b.samples, playbookOf(closed), sample) } : {}) };
    b = addLog(b, last.at, 'close', `${t.side === 'long' ? 'Sold' : 'Bought back'} ${t.symbol} at ${px(last.price)} — ${why}: ${signedRs(pnl)} (${r >= 0 ? '+' : ''}${r.toFixed(1)} R).`);
    // the day's stop sends one summary instead of an alert per trade
    if (!t.closeWhy || !/daily loss limit|today's profit/.test(t.closeWhy)) void alertClose(closed, last.price).catch(() => undefined);
    b = addLog(b, now, 'learn', `${lesson.text ?? 'Learned a little.'} Its chance for a trade like this: ${Math.round(lesson.before * 100)}% → ${Math.round(lesson.after * 100)}%.`);
  }
  return b;
}

/** app v1.23: finished shadow trades become evidence of their kind — no learning, no log, no alerts. */
export function settleShadow(bot: BotState): BotState {
  const sh = bot.shadow;
  if (!sh) return bot;
  let samples = bot.samples;
  let changed = false;
  const trades = sh.trades.map((t) => {
    const res = closedResult(sh.wallet, t);
    if (!res) return t;
    changed = true;
    const closed: BotTrade = { ...t, status: 'closed', closedAt: res.last.at, exitPrice: res.last.price, pnl: res.pnl, r: t.riskRupees > 0 ? r2(res.pnl / t.riskRupees) : 0, grossR: t.riskRupees > 0 ? r2((res.pnl + res.charges) / t.riskRupees) : 0, exitWhy: exitWhyOf(t, res.last) };
    const sample = toSample(closed);
    if (sample) samples = addSample(samples, playbookOf(closed), sample);
    return closed;
  });
  return changed ? { ...bot, shadow: { ...sh, trades }, ...(samples ? { samples } : {}) } : bot;
}

/** A wallet and the trades it holds (the real one or the shadow one). */
interface TradeBook {
  wallet: WalletState;
  trades: BotTrade[];
}

/**
 * Each open trade at the live price (app v1.13, see bot/protect.ts): the safety net moves to the buy
 * price early and then follows the best price; half is sold at 1× the risk; a same-day trade that
 * goes nowhere is closed. Also tracks best/worst prices for the progress bars. `real` = the money's own
 * trades (alerted); false = shadow trades.
 */
function manageTrades(book: TradeBook, rules: ProtectRules, quotes: Record<string, Quote>, ctx: MarketCtx, riseTags: Map<string, 'strong' | 'unclear' | 'fading'>, real: boolean): TradeBook {
  let w = book.wallet;
  const trades = book.trades.map((t) => {
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
        const r = placeOrder(w, { key: t.key, symbol: t.symbol, side: 'sell', qty: half, type: 'market', source: real ? 'Auto-trader · half at target 1' : 'Shadow · half at target 1', ...(h.product ? { product: h.product, ...(h.marginPct !== undefined ? { marginPct: h.marginPct } : {}) } : {}) }, wq(q), ctx);
        if (r.ok && r.fill) {
          w = r.wallet;
          if (real) void alertHalf(t, half, r.fill.price).catch(() => undefined);
          return { ...next, halfDone: true, left: h.qty - half };
        }
      }
    }
    return next;
  });
  return { wallet: w, trades };
}

function manageOpen(bot: BotState, quotes: Record<string, Quote>, ctx: MarketCtx, riseTags: Map<string, 'strong' | 'unclear' | 'fading'> = new Map()): BotState {
  return { ...bot, ...manageTrades({ wallet: bot.wallet, trades: bot.trades }, protectRules(bot.rules), quotes, ctx, riseTags, true) };
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
function timeExitsOf(wallet: WalletState, trades: readonly BotTrade[], quotes: Record<string, Quote>, ctx: MarketCtx): WalletState {
  let w = wallet;
  for (const t of trades) {
    if (t.status !== 'open' || t.side !== 'long') continue;
    const q = quotes[t.key];
    const price = q?.ltp ?? t.entry;
    const overdueDay = t.strategy !== 'swing' && (t.date < ctx.today || (!ctx.open && ctx.t >= 15 * 60 + 30));
    const overdueSwing = t.strategy === 'swing' && ctx.open && weekdaysBetween(t.date, ctx.today) >= SWING_MAX_DAYS;
    if (overdueDay || overdueSwing) w = sellFromBackground(w, t.key, price, ctx, 'day-end').wallet;
  }
  return w;
}

/**
 * The app was closed for a while during market hours: replays today's 5-minute candles since the
 * last run through the same rules, worst price first, so missed safety nets count as hit.
 */
async function catchUpOf(wallet: WalletState, trades: readonly BotTrade[], lastRun: number, ctx: MarketCtx): Promise<WalletState> {
  const open = trades.filter((t) => t.status === 'open');
  if (!open.length || !lastRun || ctx.now - lastRun < 4 * 60_000 || istDate(lastRun) !== ctx.today) return wallet;
  const sinceT = minutesIST(lastRun);
  let w = wallet;
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
  return w;
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
  const [signals, flow, breadth, shortIdeas, news, breakouts, boTest, intra, intraTest] = await Promise.all([
    getSession('daySignals'),
    getSession('flow'),
    getSession('breadth'),
    getSession('shortIdeas'),
    getSession('news'),
    getSession('breakouts'),
    getLocal('breakoutTest'),
    getSession('intraday'),
    getLocal('intradayTest'),
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
    ideas.push({ key: s.key, symbol: s.symbol, strategy: 'day-buy', playbook: 'day-buy', side: 'long', price: q.ltp, stop: s.stop, target, ctx: ctxOf(s.key, q, 'day-buy', prior, s.stop, 1), reasons: [`day-trade buy signal at ${s.entry.toFixed(2)}`, s.chance !== undefined ? `self-learning chance ${Math.round(s.chance * 100)}%` : s.trusted ? 'these signals passed the past test' : 'signals not tested yet'] });
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
    ideas.push({ key: r.key, symbol: r.symbol, strategy: 'rising', playbook: 'rise-strong', side: 'long', price: q.ltp, stop: plan.stop, target: plan.target, ctx: ctxOf(r.key, q, 'rising', prior, plan.stop, 1), reasons: [RISE_STRONG_REASON, ...r.reasons.slice(0, 2)] });
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
    ideas.push({ key: r.key, symbol, strategy: 'rising', playbook: 'rise-flow', side: 'long', price: q.ltp, stop, target, ctx: ctxOf(r.key, q, 'rising', prior, stop, 1), reasons: [`up ${r.fromOpenPct.toFixed(1)}% since the open`, r.meter.label.toLowerCase(), r.pace ? `${r.pace.toFixed(1)}× the usual trading` : 'busy trading'] });
  }
  // 3. top picks (hold a few days) — only near the planned buy price
  for (const p of studies.picks) {
    const q = quotes[p.key];
    if (!fresh(q) || q.ltp <= p.plan.stop || q.ltp >= p.plan.target || q.ltp > p.plan.entry * 1.01) continue;
    const prior = p.safeChance ?? p.safetyScore ?? 0.5;
    ideas.push({ key: p.key, symbol: p.symbol, strategy: 'swing', playbook: 'swing-pick', side: 'long', price: q.ltp, stop: p.plan.stop, target: p.plan.target, ctx: ctxOf(p.key, q, 'swing', prior, p.plan.stop, 1), reasons: [`top pick: ${p.summary}`, `made money ${p.record.profitable} of ${p.record.samples} times in the past`] });
  }
  // 4. sell first: the "Falling now" scan (5-minute candles), with the measured fall chance when known
  for (const s of shortIdeas && istDate(shortIdeas.at) === today && now - shortIdeas.at < 10 * 60_000 ? shortIdeas.ideas : []) {
    const q = quotes[s.key];
    if (!fresh(q) || q.ltp >= s.plan.stop || q.ltp <= s.plan.t1) continue;
    const measured = studies.shortChance.get(s.key);
    const prior = measured ?? Math.min(0.55, Math.max(0.35, 0.4 + (s.score - 60) / 200));
    ideas.push({ key: s.key, symbol: s.symbol, strategy: 'short', playbook: 'short-scan', side: 'short', price: q.ltp, stop: s.plan.stop, target: s.plan.t2, t1: s.plan.t1, ctx: ctxOf(s.key, q, 'short', prior, s.plan.stop, -1), reasons: [`falling now (score ${s.score})`, ...s.reasons.slice(0, 2).map((x) => x.text), ...(measured !== undefined ? [`similar days fell ${Math.round(measured * 100)}% of the time`] : [])] });
  }
  // 5. the Stocks tab's live "For short selling" list (app v1.9): each stock's own fall chance from its
  //    model, only while it trades below today's opening price; plan from its daily prices
  for (const tTop of studies.shortTop) {
    const q = quotes[tTop.key];
    if (!tTop.live || !fresh(q) || ideas.some((i) => i.key === tTop.key && i.side === 'short')) continue;
    if (q.ltp >= tTop.plan.stop || q.ltp <= tTop.plan.t1 || (q.open !== null && q.ltp >= q.open)) continue;
    const prior = Math.min(0.7, Math.max(0.3, tTop.chance));
    ideas.push({ key: tTop.key, symbol: tTop.symbol, strategy: 'short', playbook: 'short-model', side: 'short', price: q.ltp, stop: tTop.plan.stop, target: tTop.plan.t2, t1: tTop.plan.t1, ctx: ctxOf(tTop.key, q, 'short', prior, tTop.plan.stop, -1), reasons: ['in the Stocks tab’s “For short selling” list', `its own chance from a year of prices: ${Math.round(tTop.chance * 100)}%`, ...tTop.reasons.slice(0, 1)] });
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
    ideas.push({ key: b.key, symbol: b.symbol, strategy: 'breakout', playbook: 'breakout', side: 'long', price: q.ltp, stop, target, ctx: ctxOf(b.key, q, 'breakout', prior, stop, 1), reasons: [b.status === 'confirmed' ? `confirmed breakout above ₹${b.level.toFixed(2)}` : `broke above ₹${b.level.toFixed(2)} with a volume surge`, ...b.reasons.slice(1, 3)] });
  }
  // 7. app v1.23: the Intraday scanner's BUY (a 5-minute close above the opening range, with volume, above
  //    VWAP — app v1.19). It trades with money only once the scanner's own record is proven and its own
  //    results allow it (bot/evidence.ts); before that it is followed as shadow trades. Never chased: only
  //    within 0.3 % of the scanner's entry. Its SELL side stays practice only (app v1.20.2).
  if (intra && intra.date === today && now - intra.at < 60_000) {
    const itPrior = Math.min(0.6, Math.max(0.35, intraTest?.winRate ?? 0.45));
    for (const row of intra.rows) {
      if (row.call !== 'BUY' || row.side === 'sell' || !row.plan) continue;
      const live = quotes[row.key];
      const price = fresh(live) ? live.ltp : row.price;
      const at = fresh(live) ? live.fetchedAt : row.at;
      if (!(price > 0) || now - at >= 2 * 60_000) continue;
      if (price > row.plan.entry * 1.003 || price <= row.plan.stop || price >= row.plan.target) continue;
      const prevClose = fresh(live) ? live.prevClose : row.changePct !== null && row.changePct > -100 ? price / (1 + row.changePct / 100) : null;
      const q = fresh(live) ? live : ({ ltp: price, prevClose, fetchedAt: at } as Quote);
      ideas.push({
        key: row.key,
        symbol: row.symbol,
        strategy: 'breakout',
        playbook: 'intraday-buy',
        side: 'long',
        price,
        stop: row.plan.stop,
        target: row.plan.target,
        ctx: ctxOf(row.key, q, 'breakout', itPrior, row.plan.stop, 1),
        reasons: ['Intraday scanner: BUY', row.why],
        quote: { ltp: price, prevClose, fetchedAt: at },
      });
    }
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
  /** app v1.23: the state of its kind of trade (watch = not proven yet) */
  state?: PlaybookState;
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
  const evs = evidenceMap(bot.evidence);
  const stateOf = (p: PlaybookId): PlaybookState => evs[p]?.state ?? 'watch';
  if (ctx.open) {
    for (const i of await gatherIdeas(now, quotes)) {
      if ((side === 'buy') !== (i.side === 'long')) continue;
      const sc = scoreIdea(bot.brain, i);
      const st = stateOf(i.playbook);
      // app v1.23: a paused or switched-off kind of trade is not suggested
      if (!sc || seen.has(i.key) || st === 'paused' || st === 'off') continue;
      seen.add(i.key);
      items.push({ key: i.key, symbol: i.symbol, side, kind: i.strategy, price: i.price, stop: i.stop, target: i.target, ...(i.t1 !== undefined ? { t1: i.t1 } : {}), chance: sc.chance, ev: sc.ev, state: st, news: moodOf(i.key), reasons: i.reasons, sameDay: i.strategy !== 'swing', when: 'now' });
    }
  }
  if (side === 'buy') {
    for (const p of studies.picks) {
      if (seen.has(p.key) || stateOf('swing-pick') === 'paused' || stateOf('swing-pick') === 'off') continue;
      const q = quotes[p.key];
      const price = q?.ltp ?? p.plan.entry;
      if (price <= p.plan.stop || price >= p.plan.target) continue;
      seen.add(p.key);
      items.push({ key: p.key, symbol: p.symbol, side, kind: 'swing', price, stop: p.plan.stop, target: p.plan.target, chance: p.safeChance ?? p.safetyScore, ev: null, state: stateOf('swing-pick'), news: moodOf(p.key), reasons: [`top pick: ${p.summary}`, `made money ${p.record.profitable} of ${p.record.samples} times in the past`], sameDay: false, when: ctx.open ? 'now' : 'next-session' });
    }
  } else {
    for (const t of studies.shortTop) {
      if (seen.has(t.key) || stateOf('short-model') === 'paused' || stateOf('short-model') === 'off') continue;
      seen.add(t.key);
      items.push({ key: t.key, symbol: t.symbol, side, kind: 'short', price: t.price, stop: t.plan.stop, target: t.plan.t2, t1: t.plan.t1, chance: t.chance, ev: null, state: stateOf('short-model'), news: moodOf(t.key), reasons: [...t.reasons, `its own chance from a year of prices: ${Math.round(t.chance * 100)}%`], sameDay: true, when: ctx.open ? 'now' : 'next-session' });
    }
  }
  // good news helps a buy and hurts a sell-first (and the other way round) — shown, and used as a tie-break
  const newsScore = (x: Suggestion) => (x.news === null ? 0 : (x.news === 'good') === (side === 'buy') ? 0.03 : -0.03);
  // app v1.23: proven kinds first, then trial, then the ones not proven yet
  const rank = (x: Suggestion) => (x.state === 'proven' ? 2 : x.state === 'trial' ? 1 : 0);
  items.sort((a, b) => rank(b) - rank(a) || (b.ev ?? -1) - (a.ev ?? -1) || b.chance + newsScore(b) - (a.chance + newsScore(a)));
  return { at: now, marketOpen: ctx.open, items: items.slice(0, 8) };
}

// ---------------------------------------------------------------- app v1.23: evidence, market gates, brakes

/** The samples of an auto-trader saved before app 1.23: read once from its finished (and shadow) trades. */
export function samplesFromTrades(bot: BotState): SampleBook {
  let book: SampleBook = {};
  const closed = [...bot.trades, ...(bot.shadow?.trades ?? [])].filter((t) => t.status === 'closed').sort((a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt));
  for (const t of closed) {
    const s = toSample(t);
    if (s) book = addSample(book, playbookOf(t), s);
  }
  return book;
}

const INTRADAY_UNPROVEN = 'The Intraday scanner’s own record is not proven yet (20 finished BUY alerts, more wins than losses, money made after charges): it trades at the small learning size until it is.';

/** Each kind of trade's state, from its samples, the stored past tests and what is remembered (off, paused). */
export async function withEvidence(bot: BotState, now: number): Promise<BotState> {
  const [dayTest, riseModel, shortTest, breakoutTest, intradayTest, intradayRecord] = await Promise.all([getLocal('dayTest'), getLocal('riseModel'), getLocal('shortTest'), getLocal('breakoutTest'), getLocal('intradayTest'), getLocal('intradayRecord')]);
  const samples = bot.samples ?? samplesFromTrades(bot);
  const priors = priorsFrom({ dayTest, riseModel, shortTest, breakoutTest, intradayTest }, RISE_PLAN.stop);
  const evidence = evaluateAll(samples, priors, bot.playbooks, { 'intraday-buy': sideStats(intradayRecord, 'buy').proven ? null : INTRADAY_UNPROVEN }, now);
  // a paused kind is remembered: it must recover clearly before it trades again
  const playbooks: Partial<Record<PlaybookId, PlaybookMemo>> = { ...(bot.playbooks ?? {}) };
  for (const e of evidence.list) {
    if (e.state === 'off') continue;
    const { paused: _was, ...rest } = playbooks[e.id] ?? {};
    const memo: PlaybookMemo = e.state === 'paused' ? { ...rest, paused: true } : rest;
    if (Object.keys(memo).length) playbooks[e.id] = memo;
    else delete playbooks[e.id];
  }
  return { ...bot, samples, evidence, playbooks };
}

export const evidenceMap = (s: EvidenceSummary | undefined): Partial<Record<PlaybookId, PlaybookEvidence>> => Object.fromEntries((s?.list ?? []).map((e) => [e.id, e]));

/** Why no new buys / sell-first trades now: the same market gates as the alerts (app v1.16.2 and v1.20). */
async function marketGatesNow(now: number, today: string, quotes: Record<string, Quote>): Promise<MarketGates> {
  const it = await getSession('intraday');
  if (it && it.date === today && now - it.at < 60_000) return { buys: it.gate ?? null, shorts: it.shortGate ?? null };
  const [scan, rise] = await Promise.all([scanUniverse().catch(() => null), getSession('rise')]);
  const inputs = marketInputs(quotes, scan?.keys ?? [], now);
  const weak = rise && rise.date === today && now - rise.at < 60_000 && rise.weak?.weak ? rise.weak.text : null;
  const g = marketGate(inputs);
  const r = marketRising(inputs);
  return { buys: weak ?? (g.weak ? g.text : null), shorts: r.strong ? r.text : null };
}

/** Kinds of trade with two losing trades today: no more money for them today (shadow trades go on). */
export function brakedToday(trades: readonly BotTrade[], today: string): Set<PlaybookId> {
  const losses = new Map<PlaybookId, number>();
  for (const t of trades) {
    if (t.status !== 'closed' || t.date !== today || !((t.r ?? 0) < 0)) continue;
    const p = playbookOf(t);
    losses.set(p, (losses.get(p) ?? 0) + 1);
  }
  return new Set([...losses].filter(([, n]) => n >= 2).map(([p]) => p));
}

// ---------------------------------------------------------------- the loop

/** On every price update (exits) and once a minute (new trades). Never twice at the same time. */
export function runBot(now = Date.now(), force = false): Promise<BotState | null> {
  return queue(async () => {
    // app v1.22: only where the auto-trader lives (never a second copy trading the same money)
    const g = await gate.check();
    if (!g.run) {
      observer.onSkip?.(g.reason, now);
      return null;
    }
    try {
      return await runBotNow(now, force);
    } catch (err) {
      observer.onError?.(err, now);
      throw err;
    }
  });
}

async function runBotNow(now: number, force: boolean): Promise<BotState | null> {
  const stored = await getLocal('bot');
  let bot = stored ?? newBot(now);
  if (!bot.enabled) {
    observer.onRun?.({ at: now, decided: false, opened: 0, closed: 0, saved: false, priceAt: null, stale: false, note: 'paused', rev: bot.rev ?? 0 });
    return bot;
  }
  const ctx = await marketCtx(now);
  const quotes = await getQuotes();
  const wquotes = Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)]));
  const realPrint = (b: BotState) => JSON.stringify([b.wallet.fills.length, b.trades.map((t) => [t.status, t.stop])]);
  const shadowPrint = (b: BotState) => JSON.stringify([b.shadow?.wallet.fills.length ?? 0, (b.shadow?.trades ?? []).map((t) => [t.status, t.stop])]);
  const before = realPrint(bot);
  const shadowBefore = shadowPrint(bot);
  const closedBefore = bot.trades.filter((t) => t.status === 'closed').length;
  const shadowClosedBefore = (bot.shadow?.trades ?? []).filter((t) => t.status === 'closed').length;
  const tradesBefore = bot.trades.length;
  // app v1.22: no new trades from old prices (the server's Upstox token stopped, the feed went quiet…)
  const priceAt = newestPriceAt(quotes);
  const stale = ctx.open && (priceAt === null || now - priceAt > BOT_PRICE_MAX_AGE_MS);
  let decided = false;

  if (ctx.open && bot.lastRun && now - bot.lastRun > 4 * 60_000 && istDate(bot.lastRun) === ctx.today) bot = { ...bot, lastGap: { from: bot.lastRun, to: now } };
  if (ctx.open) bot = { ...bot, wallet: await catchUpOf(bot.wallet, bot.trades, bot.lastRun, ctx) };
  const riseS = await getSession('rise');
  // the auto-trader's own stocks are tagged in the "held" list; shadow trades use the live list's tags
  const riseTags = new Map<string, 'strong' | 'unclear' | 'fading'>();
  const rowTags = new Map<string, 'strong' | 'unclear' | 'fading'>();
  if (riseS && riseS.date === ctx.today && now - riseS.at < 60_000) {
    for (const h of riseS.held) if (h.source === 'auto') riseTags.set(h.key, h.tag);
    for (const r of riseS.rows) rowTags.set(r.key, r.tag);
  }
  bot = manageOpen(bot, quotes, ctx, riseTags);
  bot = { ...bot, wallet: timeExitsOf(bot.wallet, bot.trades, quotes, ctx) };
  bot = { ...bot, wallet: processWallet(bot.wallet, wquotes, ctx).wallet };
  bot = settleClosed(bot, now);
  bot = guardDay(bot, quotes, ctx);
  bot = settleClosed(bot, now);

  // app v1.23: shadow trades, handled by the same rules (no money, no alerts)
  if (bot.shadow?.trades.some((t) => t.status === 'open')) {
    let sb: TradeBook = { wallet: bot.shadow.wallet, trades: bot.shadow.trades };
    if (ctx.open) sb = { ...sb, wallet: await catchUpOf(sb.wallet, sb.trades, bot.lastRun, ctx) };
    sb = manageTrades(sb, protectRules(bot.rules), quotes, ctx, rowTags, false);
    sb = { ...sb, wallet: processWallet(timeExitsOf(sb.wallet, sb.trades, quotes, ctx), wquotes, ctx).wallet };
    bot = settleShadow({ ...bot, shadow: { ...bot.shadow, ...sb } });
  }

  if (bot.day.date !== ctx.today) bot = { ...bot, day: { date: ctx.today, opened: 0 } };
  const sum = walletSummary(bot.wallet, wquotes, ctx.today);

  // app v1.23: the drawdown brake, counted from its best money (Amount, Start again and Resume set a new best)
  const peak = Math.max(bot.peak ?? sum.total, sum.total);
  const dd = drawdownOf(sum.total, peak);
  bot = { ...bot, peak };
  if (!bot.ddStop && drawdownFactor(dd) === 0) {
    bot = addLog({ ...bot, ddStop: { at: now, peak, total: Math.round(sum.total) } }, now, 'info', `Stopped: its money is ${DRAWDOWN.stopAtPct}% below its best (${rupees(peak)} → ${rupees(sum.total)}). No new trades until you press Resume; open trades keep their safety nets.`);
    void alertDrawdown(peak, sum.total).catch(() => undefined);
  }
  const ddFactor = bot.ddStop ? 0 : drawdownFactor(dd);
  const ddText = bot.ddStop ? `Stopped: its money fell ${DRAWDOWN.stopAtPct}% below its best (${rupees(bot.ddStop.peak)} → ${rupees(bot.ddStop.total)}). Look at "Kinds of trade", then press Resume to let it trade again.` : null;

  // app v1.23: each kind of trade's state — at every decision, after a trade closed, and at least every 15 minutes
  const wantDecide = ctx.open && !stale && (force || now - bot.lastDecideAt >= 60_000);
  const closedNow = bot.trades.filter((t) => t.status === 'closed').length - closedBefore + (bot.shadow?.trades ?? []).filter((t) => t.status === 'closed').length - shadowClosedBefore;
  if (wantDecide || closedNow > 0 || !bot.evidence || now - bot.evidence.at >= 15 * 60_000) bot = await withEvidence(bot, now);

  if (ctx.open && stale) {
    bot = { ...bot, note: priceAt === null ? 'No prices yet — no new trades until live prices arrive.' : `Prices are not up to date (the newest is from ${new Date(priceAt + 5.5 * 3_600_000).toISOString().slice(11, 16)}) — no new trades until they are.` };
  } else if (wantDecide) {
    decided = true;
    await refreshStudies(now, sum.total);
    const ideas = await gatherIdeas(now, quotes);
    const openTrades = bot.trades.filter((t) => t.status === 'open');
    const rules = protectRules(bot.rules);
    const swingValue = openTrades.filter((t) => t.strategy === 'swing').reduce((a, t) => a + t.qty * (quotes[t.key]?.ltp ?? t.entry), 0);
    const [market, scan] = await Promise.all([marketGatesNow(now, ctx.today, quotes), scanUniverse().catch(() => null)]);
    const industryOf = (k: string): string | undefined => scan?.industry[k];
    const industries: Record<string, number> = {};
    for (const t of openTrades) {
      const ind = industryOf(t.key);
      if (ind) industries[ind] = (industries[ind] ?? 0) + 1;
    }
    const plan = decide(
      bot.brain,
      ideas,
      { equity: sum.total, free: sum.free, openKeys: openTrades.map((t) => t.key), openCount: openTrades.length, newToday: bot.day.opened, todayPnl: sum.todayPnl, t: ctx.t, rules, halted: bot.guard?.date === ctx.today ? bot.guard.halted : null, swingValue, openRisk: openRiskOf(openTrades), industries, ddFactor, ddText, learningOpen: openTrades.filter((t) => t.state === 'watch').length },
      { evidence: evidenceMap(bot.evidence), market, braked: brakedToday(bot.trades, ctx.today), industryOf, charges: (product, qty, price) => estimateCharges(product, qty, price) },
    );
    for (const d of plan.decisions) {
      const i = d.idea;
      const q = wq(quotes[i.key]) ?? i.quote;
      const source = `Auto-trader · ${PLAYBOOK_LABEL[i.playbook]}`;
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
        playbook: i.playbook,
        state: d.state,
        chargesR: d.chargesR,
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
        explore: false,
        reasons: i.reasons,
        sizeWhy: d.sizeWhy,
        status: 'open',
        best: entry,
        worst: entry,
        product: i.strategy === 'swing' ? 'delivery' : 'intraday',
      };
      bot = { ...bot, wallet: r.wallet, trades: [...bot.trades, trade].slice(-400), day: { ...bot.day, opened: bot.day.opened + 1 } };
      bot = addLog(bot, now, 'open', `${i.side === 'long' ? 'Bought' : 'Sold first'} ${d.qty} ${i.symbol} at ${px(entry)} (${rupees(d.qty * entry)}) — ${PLAYBOOK_LABEL[i.playbook].toLowerCase()}. ${d.sizeWhy}`);
      log.info(`Auto-trader ${i.side === 'long' ? 'bought' : 'sold first'} ${d.qty} ${i.symbol} @ ${entry}`);
      void alertOpen(trade).catch(() => undefined);
    }
    bot = openShadowTrades(bot, plan.shadow, quotes, ctx, now);
    bot = { ...bot, lastDecideAt: now, note: plan.note, looked: ideas.length };
  } else if (!ctx.open) {
    bot = { ...bot, note: 'Market closed — it trades by itself from 9:30 am on market days.' };
  }

  // one point per day for the chart
  const eq = [...bot.equity];
  if (eq.length && eq[eq.length - 1]!.date === ctx.today) eq[eq.length - 1] = { date: ctx.today, total: Math.round(sum.total) };
  else eq.push({ date: ctx.today, total: Math.round(sum.total) });
  const keepOrders = (w: WalletState) => w.orders.filter((o) => o.status === 'open' || now - o.createdAt < 3 * 86_400_000);
  bot = { ...bot, equity: eq.slice(-250), lastRun: now, wallet: { ...bot.wallet, fills: bot.wallet.fills.slice(-600), orders: keepOrders(bot.wallet) } };
  if (bot.shadow) bot = { ...bot, shadow: { ...bot.shadow, trades: bot.shadow.trades.slice(-400), wallet: { ...bot.shadow.wallet, fills: bot.shadow.wallet.fills.slice(-600), orders: keepOrders(bot.shadow.wallet) } } };

  // only the real trades make a new version (rev): a shadow trade never makes a phone's control "outdated"
  const changed = before !== realPrint(bot);
  const save = !stored || changed || shadowBefore !== shadowPrint(bot) || now - (stored.lastRun ?? 0) >= 30_000 || force;
  if (save) bot = await saveBot(bot, now, changed, stored);
  const opened = bot.trades.length - tradesBefore;
  const closed = bot.trades.filter((t) => t.status === 'closed').length - closedBefore;
  observer.onRun?.({ at: now, decided, opened, closed: Math.max(0, closed), saved: save, priceAt, stale, note: bot.note, rev: bot.rev ?? 0 });
  return bot;
}

/** app v1.23: opens the shadow trades of kinds that may not use money yet (no money, no alerts, no log line). */
function openShadowTrades(bot: BotState, picks: readonly ShadowPick[], quotes: Record<string, Quote>, ctx: MarketCtx, now: number): BotState {
  if (!picks.length) return bot;
  let sb = bot.shadow ?? newShadow(now);
  if (sb.day.date !== ctx.today) sb = { ...sb, day: { date: ctx.today, opened: 0 } };
  const open = sb.trades.filter((t) => t.status === 'open');
  const doneToday = new Set(sb.trades.filter((t) => t.date === ctx.today).map((t) => `${t.playbook}|${t.key}`));
  const realOpen = new Set(bot.trades.filter((t) => t.status === 'open').map((t) => t.key));
  for (const p of picks) {
    if (open.length >= SHADOW_MAX_OPEN || sb.day.opened >= SHADOW_MAX_DAY) break;
    const i = p.idea;
    // one shadow position per stock (the wallet keeps one position per stock), once per kind and day
    if (doneToday.has(`${i.playbook}|${i.key}`) || realOpen.has(i.key) || open.some((t) => t.key === i.key)) continue;
    const q = wq(quotes[i.key]) ?? i.quote;
    const source = `Shadow · ${PLAYBOOK_LABEL[i.playbook]}`;
    const r = i.side === 'long'
      ? placeOrder(sb.wallet, { key: i.key, symbol: i.symbol, side: 'buy', qty: p.qty, type: 'market', stop: i.stop, target: i.target, sellByClose: i.strategy !== 'swing', source, ...(i.strategy !== 'swing' ? { product: 'intraday' as const, marginPct: 1 } : {}) }, q, ctx)
      : openShort(sb.wallet, { key: i.key, symbol: i.symbol, qty: p.qty, stop: i.stop, t1: i.t1 ?? (i.price + i.target) / 2, t2: i.target, source }, q, ctx);
    if (!r.ok || !r.fill) continue;
    const entry = r.fill.price;
    const trade: BotTrade = {
      id: `S${newId(now).slice(1)}`,
      key: i.key,
      symbol: i.symbol,
      strategy: i.strategy,
      playbook: i.playbook,
      shadow: true,
      side: i.side,
      qty: p.qty,
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
      riskRupees: Math.max(1, Math.round(Math.abs(entry - i.stop) * p.qty)),
      explore: false,
      reasons: i.reasons,
      sizeWhy: `Shadow trade (no money): ${p.why}`,
      status: 'open',
      best: entry,
      worst: entry,
      product: i.strategy === 'swing' ? 'delivery' : 'intraday',
    };
    sb = { wallet: r.wallet, trades: [...sb.trades, trade], day: { date: ctx.today, opened: sb.day.opened + 1 } };
    open.push(trade);
    doneToday.add(`${i.playbook}|${i.key}`);
  }
  return { ...bot, shadow: sb };
}

/** app v1.22: who changed it, when the change came from a phone through the server (shown in its log, alerted) */
export interface BotChangeBy {
  name: string;
}

/**
 * app v1.22: a change sent through the server. `ifRev` = the version the phone saw (the change is refused
 * if the auto-trader changed since); `backup` gets the state just before the change (inside the same
 * one-at-a-time line, so nothing can happen in between).
 */
export interface BotChangeOptions {
  by?: BotChangeBy;
  ifRev?: number;
  backup?: (before: BotState | null) => void;
}

/** The auto-trader changed since the phone looked (another phone, or a trade): look again first. */
export class BotConflictError extends Error {
  override name = 'BotConflictError';
  constructor(readonly rev: number) {
    super('The auto-trader changed since you looked (a trade or another phone). Look at it again, then try again.');
  }
}

const fromWhom = (by?: BotChangeBy) => (by ? ` (from ${by.name})` : '');

/** Inside the queue: the gate, the version check and the backup, before any change. */
async function beginChange(o: BotChangeOptions | undefined): Promise<BotState | null> {
  await mayWrite();
  const stored = (await getLocal('bot')) ?? null;
  if (o?.ifRev !== undefined && (stored?.rev ?? 0) !== o.ifRev) throw new BotConflictError(stored?.rev ?? 0);
  o?.backup?.(stored);
  return stored;
}

export function botSetEnabled(enabled: boolean, now = Date.now(), o?: BotChangeOptions): Promise<void> {
  const by = o?.by;
  return queue(async () => {
    const stored = await beginChange(o);
    const bot = await getBot(now);
    const next = await saveBot(addLog({ ...bot, enabled }, now, 'info', enabled ? `Switched on${fromWhom(by)} — it trades by itself again.` : `Paused${by ? fromWhom(by) : ' by you'} — open trades are kept but nothing new is opened.`), now, true, stored);
    if (by) void alertControl(`alert:bot-control-${next.rev}`, enabled ? '🤖 Auto-trader switched on' : '🤖 Auto-trader paused', enabled ? `Switched on from ${by.name}. It trades by itself again (pretend money).` : `Paused from ${by.name}. Nothing new is opened, and open trades wait (their safety nets are not checked) until it is switched on again.`).catch(() => undefined);
  });
}

/** Start again with any amount (₹50 lakh by default); keep what it learned unless `forget`. */
export function botReset(forget: boolean, startCash = BOT_START, now = Date.now(), o?: BotChangeOptions): Promise<void> {
  const by = o?.by;
  return queue(async () => {
    const old = await beginChange(o);
    const cash = Number.isFinite(startCash) && startCash >= 10_000 ? Math.round(startCash) : BOT_START;
    const base = newBot(now, forget || !old ? newBrain() : old.brain, cash);
    // app v1.23: each kind of trade's evidence is part of what it learned (kept unless it forgets); your off switches always stay
    const offs = Object.fromEntries(Object.entries(old?.playbooks ?? {}).filter(([, m]) => m?.off).map(([id]) => [id, { off: true }])) as Partial<Record<PlaybookId, PlaybookMemo>>;
    const keep = !forget && old ? { samples: old.samples ?? samplesFromTrades(old), playbooks: old.playbooks ?? {} } : { playbooks: offs };
    const fresh: BotState = { ...base, ...keep };
    const next = await saveBot(addLog(fresh, now, 'info', `${forget ? `Reset: ${rupees(cash)} and a fresh brain` : `Reset to ${rupees(cash)}; kept what it learned from ${old?.brain.n ?? 0} trades`}${fromWhom(by)}.`), now, true, old);
    if (by) void alertControl(`alert:bot-control-${next.rev}`, '🤖 Auto-trader started again', `Started again with ${rupees(cash)} from ${by.name}${forget ? ' and a fresh brain' : '; it kept what it learned'}.`).catch(() => undefined);
  });
}

// ---------------------------------------------------------------- amount and protection (app v1.13)

/**
 * Sets the money the auto-trader trades with — e.g. what is in your Upstox account — without starting
 * again: more money is added to its cash, less is taken from its free cash. Open trades and what it
 * learned are kept; the overall result is counted from the new amount.
 */
export function botSetAmount(amount: number, now = Date.now(), o?: BotChangeOptions): Promise<{ total: number; free: number }> {
  const by = o?.by;
  return queue(async () => {
    if (!Number.isFinite(amount) || amount < 10_000) throw new Error('Enter at least ₹10,000.');
    const target = Math.round(amount);
    const stored = await beginChange(o);
    if (!stored) {
      const fresh = addLog(newBot(now, newBrain(), target), now, 'info', `Amount set to ${rupees(target)}${fromWhom(by)}.`);
      await saveBot(fresh, now, true, null);
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
    const next = addLog({ ...bot, wallet, peak: target, ddStop: null }, now, 'info', `Amount set to ${rupees(target)}${fromWhom(by)} (${delta >= 0 ? 'added' : 'took out'} ${rupees(Math.abs(delta))}). Open trades and what it learned are kept.`);
    await saveBot(next, now, true, stored);
    return { total: target, free: Math.round(sum.free + delta) };
  });
}

/** Changes the money protection (any missing value keeps its current setting). */
export function botSetRules(patch: Partial<ProtectRules>, now = Date.now(), o?: BotChangeOptions): Promise<ProtectRules> {
  const by = o?.by;
  return queue(async () => {
    const stored = await beginChange(o);
    const bot = await getBot(now);
    const rules = protectRules({ ...protectRules(bot.rules), ...patch });
    await saveBot(addLog({ ...bot, rules }, now, 'info', `${rules.on ? `Protection: keep the profit from +${rules.lockStartPct}%, daily loss limit −${rules.dayLossPct}%, few-days picks at most ${rules.swingSharePct}%, quick exit ${rules.quickExitMin ? `after ${rules.quickExitMin} min` : 'off'}` : 'Protection switched off (as before 1.13: no day limits)'}${fromWhom(by)}.`), now, true, stored);
    return rules;
  });
}

/** app v1.23: switches one kind of trade off (no trades, not even shadow ones) or on again. */
export function botSetPlaybook(id: PlaybookId, off: boolean, now = Date.now(), o?: BotChangeOptions): Promise<void> {
  const by = o?.by;
  return queue(async () => {
    const stored = await beginChange(o);
    const bot = await getBot(now);
    const memo: PlaybookMemo = { ...(bot.playbooks?.[id] ?? {}) };
    if (off) memo.off = true;
    else delete memo.off;
    const playbooks = { ...(bot.playbooks ?? {}) };
    if (Object.keys(memo).length) playbooks[id] = memo;
    else delete playbooks[id];
    const next = await withEvidence({ ...bot, playbooks }, now);
    await saveBot(addLog(next, now, 'info', `${PLAYBOOK_LABEL[id]}: ${off ? 'switched off — no trades, not even shadow ones' : 'switched on again — it trades once its results allow'}${fromWhom(by)}.`), now, true, stored);
  });
}

/** app v1.23: lets it trade again after the drawdown brake stopped it; its best money counts from now. */
export function botResume(now = Date.now(), o?: BotChangeOptions): Promise<void> {
  const by = o?.by;
  return queue(async () => {
    const stored = await beginChange(o);
    const bot = await getBot(now);
    const quotes = await getQuotes();
    const total = Math.round(walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), istDate(now)).total);
    await saveBot(addLog({ ...bot, ddStop: null, peak: total }, now, 'info', `Resumed after the drawdown stop${fromWhom(by)}: it trades again, and its best money counts from ${rupees(total)}.`), now, true, stored);
    if (by) void alertControl(`alert:bot-control-resume-${now}`, '🤖 Auto-trader resumed', `Resumed from ${by.name} after the drawdown stop (pretend money).`).catch(() => undefined);
  });
}

// ---------------------------------------------------------------- alerts you can copy (app v1.13)

async function botAlertsOn(): Promise<boolean> {
  return (await getSettings()).notifications.bot !== false;
}

const copyOf = (t: BotTrade) => ({ symbol: t.symbol, side: t.side, qty: t.qty, entry: t.entry, stop: t.stop, target: t.target, swing: t.strategy === 'swing', ...(t.t1 !== undefined ? { t1: t.t1 } : {}) });

async function alertOpen(t: BotTrade): Promise<void> {
  if (!(await botAlertsOn())) return;
  const kind = PLAYBOOK_LABEL[playbookOf(t)];
  await notify(`alert:bot-open-${t.id}`, {
    title: `🤖 Auto-trader ${t.side === 'long' ? 'bought' : 'sold first'} ${t.qty} ${t.symbol} at ${px(t.entry)}`,
    message: `${copyLine(copyOf(t))} ${t.state === 'proven' ? 'Proven kind' : t.state === 'trial' ? 'Trial kind (small size)' : 'Not proven yet (learning size)'} · ${kind.toLowerCase()}.`,
    priority: 2,
    detail: { symbol: t.symbol, key: t.key, side: t.side === 'long' ? 'buy' : 'sell', source: `Auto-trader · ${kind}`, entry: t.entry, stop: t.stop, targets: t.t1 !== undefined ? [t.t1, t.target] : [t.target], qty: t.qty, risk: Math.round(Math.abs(t.entry - t.stop) * t.qty), score: null, reasons: t.reasons },
  });
}

/** app v1.23: the drawdown brake stopped it (once). */
async function alertDrawdown(peak: number, total: number): Promise<void> {
  if (!(await botAlertsOn())) return;
  await notify(`alert:bot-drawdown-${Math.round(peak)}`, {
    title: `🤖 Auto-trader stopped: ${DRAWDOWN.stopAtPct}% below its best`,
    message: `Its money fell from ${rupees(peak)} to ${rupees(total)}. It opens no new trades until you press Resume on the Auto-trader screen; open trades keep their safety nets. Pretend money only.`,
    priority: 2,
    requireInteraction: true,
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

/** app v1.22: a change made from a phone through the server (switched on / paused / started again) */
async function alertControl(id: `alert:${string}`, title: string, message: string): Promise<void> {
  if (!(await botAlertsOn())) return;
  await notify(id, { title, message, priority: 1 });
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
