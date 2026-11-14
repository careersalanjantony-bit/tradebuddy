import { calibrate, historyPairs, indicatorsOf, shortSellList, type Calibration, type Pair } from '../advisor/shortSell';
import { suggestBuys, type BuySuggestion } from '../advisor/suggest';
import { stockChance } from '../advisor/shortModel';
import { newBrain, learnFrom, STRATEGY_LABEL, type Brain, type IdeaContext, type Strategy } from '../bot/brain';
import { BOT_START, decide, SWING_MAX_DAYS, trailStop, type Idea } from '../bot/policy';
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
import { newWallet, openShort, placeOrder, processWallet, sellFromBackground, updateHolding, walletSummary, type MarketCtx, type WalletQuote, type WalletState } from '../wallet/wallet';

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
}

export function newBot(now: number, brain: Brain = newBrain()): BotState {
  return { v: 1, enabled: true, createdAt: now, wallet: newWallet(now, BOT_START), brain, trades: [], log: [{ at: now, kind: 'info', text: `Started with ${rupees(BOT_START)} of pretend money.` }], day: { date: '', opened: 0 }, lastRun: 0, lastDecideAt: 0, note: null, looked: 0, equity: [] };
}

const rupees = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const signedRs = (x: number) => `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const px = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let seq = 0;
const newId = (now: number) => `B${now.toString(36)}${(seq++ % 1296).toString(36)}`;

export async function getBot(now = Date.now()): Promise<BotState> {
  return (await getLocal('bot')) ?? newBot(now);
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
    const why = last.reason === 'stop' ? (t.stop === t.entry ? 'came back to the buy price (no loss)' : 'safety net hit') : last.reason === 'target' ? 'target reached' : last.reason === 'day-end' ? (t.strategy === 'swing' ? 'time limit reached' : 'closed at 3:10 pm') : last.reason === 't1' ? 'target 1' : 'closed';
    const lesson = learnFrom(b.brain, t.x, pnl > 0, r, pnl, t.strategy);
    const closed: BotTrade = { ...t, status: 'closed', closedAt: last.at, exitPrice: last.price, pnl, r, exitWhy: why, lesson: lesson.text };
    b = { ...b, brain: lesson.brain, trades: b.trades.map((x) => (x.id === t.id ? closed : x)) };
    b = addLog(b, last.at, 'close', `${t.side === 'long' ? 'Sold' : 'Bought back'} ${t.symbol} at ${px(last.price)} — ${why}: ${signedRs(pnl)} (${r >= 0 ? '+' : ''}${r.toFixed(1)} R).`);
    b = addLog(b, now, 'learn', `${lesson.text ?? 'Learned a little.'} Its chance for a trade like this: ${Math.round(lesson.before * 100)}% → ${Math.round(lesson.after * 100)}%.`);
  }
  return b;
}

/** Moves safety nets to the buy price once 1 R up; tracks best/worst prices for the progress bars. */
function manageOpen(bot: BotState, quotes: Record<string, Quote>): BotState {
  let w = bot.wallet;
  const trades = bot.trades.map((t) => {
    if (t.status !== 'open') return t;
    const q = quotes[t.key];
    if (!q) return t;
    const best = t.side === 'long' ? Math.max(t.best ?? t.entry, q.ltp) : Math.min(t.best ?? t.entry, q.ltp);
    const worst = t.side === 'long' ? Math.min(t.worst ?? t.entry, q.ltp) : Math.max(t.worst ?? t.entry, q.ltp);
    const stop = trailStop(t.side, t.entry, t.stop, q.ltp);
    if (stop !== t.stop) {
      if (t.side === 'long') w = updateHolding(w, t.key, { stop });
      else w = { ...w, shorts: (w.shorts ?? []).map((s) => (s.key === t.key ? { ...s, stop } : s)) };
    }
    return { ...t, best, worst, stop };
  });
  return { ...bot, wallet: w, trades };
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
      const steps = t.side === 'long' ? [bars.o[i]!, bars.l[i]!, h?.target != null && bars.h[i]! >= h.target ? h.target : bars.h[i]!, bars.c[i]!] : [bars.o[i]!, bars.h[i]!, s && bars.l[i]! <= s.t2 ? s.t2 : s && bars.l[i]! <= s.t1 ? s.t1 : bars.l[i]!, bars.c[i]!];
      for (const p of steps) {
        const r = processWallet(w, { [t.key]: { ltp: p, prevClose: null, fetchedAt: at } }, { now: at, today: ctx.today, t: bt + 5, open: true });
        w = r.wallet;
      }
    }
  }
  return { ...bot, wallet: w };
}

// ---------------------------------------------------------------- studies (top picks, sell-first chances)

let studies: { at: number; picks: BuySuggestion[]; calDate: string; calLive: Calibration | null; shortChance: Map<string, number> } = { at: 0, picks: [], calDate: '', calLive: null, shortChance: new Map() };

/** Every 15 minutes: the top picks (sized as if for the auto-trader's money) and the sell-first chances. */
async function refreshStudies(now: number, equity: number): Promise<void> {
  if (now - studies.at < 15 * 60_000) return;
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
      for (const st of stocks) {
        const c = stockChance(model, st.key, st.data.candles);
        if (c) m.set(st.key, c.chance);
      }
      studies.shortChance = m;
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
  studies = { at: 0, picks: [], calDate: '', calLive: null, shortChance: new Map() };
}

// ---------------------------------------------------------------- ideas

async function gatherIdeas(now: number, quotes: Record<string, Quote>): Promise<Idea[]> {
  const today = istDate(now);
  const t = minutesIST(now);
  const [signals, flow, breadth, shortIdeas, news] = await Promise.all([getSession('daySignals'), getSession('flow'), getSession('breadth'), getSession('shortIdeas'), getSession('news')]);
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
  // 2. "Rising today": up from the open with more buyers — its own safety net under the day's average price
  for (const r of flow?.rising ?? []) {
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
  return ideas;
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

    if (ctx.open) bot = await catchUp(bot, ctx);
    bot = manageOpen(bot, quotes);
    bot = timeExits(bot, quotes, ctx);
    bot = { ...bot, wallet: processWallet(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), ctx).wallet };
    bot = settleClosed(bot, now);

    if (bot.day.date !== ctx.today) bot = { ...bot, day: { date: ctx.today, opened: 0 } };
    const sum = walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, wq(q)])), ctx.today);

    if (ctx.open && (force || now - bot.lastDecideAt >= 60_000)) {
      await refreshStudies(now, sum.total);
      const ideas = await gatherIdeas(now, quotes);
      const openTrades = bot.trades.filter((t) => t.status === 'open');
      const plan = decide(bot.brain, ideas, { equity: sum.total, free: sum.free, openKeys: openTrades.map((t) => t.key), openCount: openTrades.length, newToday: bot.day.opened, todayPnl: sum.todayPnl, t: ctx.t }, `${ctx.today}-${ctx.t}`);
      for (const d of plan.decisions) {
        const i = d.idea;
        const q = wq(quotes[i.key]);
        const source = `Auto-trader · ${STRATEGY_LABEL[i.strategy]}`;
        const r = i.side === 'long'
          ? placeOrder(bot.wallet, { key: i.key, symbol: i.symbol, side: 'buy', qty: d.qty, type: 'market', stop: i.stop, target: i.target, sellByClose: i.strategy !== 'swing', source }, q, ctx)
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
        };
        bot = { ...bot, wallet: r.wallet, trades: [...bot.trades, trade].slice(-400), day: { ...bot.day, opened: bot.day.opened + 1 } };
        bot = addLog(bot, now, 'open', `${i.side === 'long' ? 'Bought' : 'Sold first'} ${d.qty} ${i.symbol} at ${px(entry)} (${rupees(d.qty * entry)}) — ${STRATEGY_LABEL[i.strategy].toLowerCase()}, ${Math.round(i.chance * 100)}% chance. ${d.sizeWhy}`);
        log.info(`Auto-trader ${i.side === 'long' ? 'bought' : 'sold first'} ${d.qty} ${i.symbol} @ ${entry}`);
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

/** Start again with ₹50 lakh; keep what it learned unless `forget`. */
export function botReset(forget: boolean, now = Date.now()): Promise<void> {
  return queue(async () => {
    const old = await getLocal('bot');
    const fresh = newBot(now, forget || !old ? newBrain() : old.brain);
    await setLocal('bot', addLog(fresh, now, 'info', forget ? 'Reset: new money and a fresh brain.' : `Reset the money; kept what it learned from ${old?.brain.n ?? 0} trades.`));
  });
}
