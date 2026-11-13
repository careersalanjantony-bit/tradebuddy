import { newId } from '../alerts/rules';
import { mutatePlans } from '../alerts/engine';
import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getQuotes } from '../data/quotes';
import { loadStockData } from '../data/stockData';
import { liveConfig } from '../daytrade/live';
import { DEFAULT_RULES, dayTradePnl, openingRange, stopFor, targetFor } from '../daytrade/rules';
import { targetMult } from '../daytrade/backtest';
import type { DayTrade } from '../daytrade/types';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { planForPurchase } from '../planner/autoPlan';
import { savePlan, updatePlan } from '../planner/plans';
import { parsePositions, reconcileDay, reconcileDelivery, type DaySyncAction, type DeliverySyncAction } from '../portfolio/sync';
import { getAuth, getLocal, getSettings } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';
import { UpstoxError } from '../upstox/errors';
import { hasLiveSession } from '../upstox/token';
import { mutateDayTrades } from './dayJobs';

/**
 * Finds the owner's trades in the Upstox account by itself (v0.12.0) and watches them: intraday
 * positions become day trades (stop, target, 3:10 pm alerts), delivery purchases become trades with
 * a GTT reminder, and a position that is closed in Upstox is closed here with its result.
 * READ-ONLY: one GET of today's positions about every 10 seconds while the market is open.
 */

const log = createLogger('portfolio');
const R = DEFAULT_RULES;
const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedRs = (x: number) => `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
export const PORTFOLIO_EVERY_MS = 10_000;

/** Stop and target for an intraday trade found in Upstox: today's signal if there is one, else the day-trade rules. */
async function dayLevels(key: string, side: 'long' | 'short', entry: number, date: string, tick: number): Promise<{ stop: number; target: number | null; signalId?: string }> {
  const [signals, live, test, settings] = await Promise.all([getSession('daySignals'), getSession('dayLive'), getLocal('dayTest'), getSettings()]);
  const sig = signals?.date === date ? signals.signals.find((s) => s.key === key && s.side === side) : undefined;
  if (sig) return { stop: sig.stop, target: sig.target, signalId: sig.id };
  const cfg = liveConfig(test?.report, settings.ui.priceMin, settings.ui.priceMax);
  const bars = live?.date === date ? live.stocks[key]?.bars : undefined;
  const or = bars ? openingRange(bars, R) : null;
  // without today's opening range: the widest stop the rules allow (1%)
  const range = or ?? { high: entry * 1.05, low: entry * 0.95 };
  const stop = stopFor(side, entry, range, R, tick);
  return { stop, target: targetFor(side, entry, stop, targetMult(cfg.variant.target) ?? 1.5, tick) };
}

async function applyDay(a: DaySyncAction, date: string, now: number): Promise<void> {
  if (a.type === 'open') {
    const lv = await dayLevels(a.key, a.side, a.entry, date, 0.05);
    const trade: DayTrade = { id: newId('D', now), date, key: a.key, symbol: a.symbol, side: a.side, qty: a.qty, entry: a.entry, stop: lv.stop, target: lv.target, openedAt: now, practice: false, status: 'open', auto: true, ...(lv.signalId ? { signalId: lv.signalId } : {}) };
    await mutateDayTrades((all) => [...all, trade]);
    const long = a.side === 'long';
    await notify(`alert:found-${trade.id}`, {
      title: `Found in Upstox: ${long ? 'bought' : 'sold short'} ${a.qty} ${a.symbol} at ${rs(a.entry)}`,
      message: `Intraday trade — now watched. ${long ? 'Sell' : 'Buy back'} at: stop ${rs(lv.stop)}${lv.target !== null ? ` · target ${rs(lv.target)}` : ''}. Close it by 3:10 pm. You get an alert at each.`,
      priority: 2,
    });
    await playSound('info');
    log.info(`Found intraday ${a.side} ${a.symbol} ${a.qty} @ ${a.entry}`, { id: trade.id });
    return;
  }
  if (a.type === 'update') {
    await mutateDayTrades((all) => all.map((t) => (t.id === a.id ? { ...t, side: a.side, qty: a.qty, entry: a.entry, auto: true } : t)));
    return;
  }
  if (a.type === 'close') {
    let closed: DayTrade | undefined;
    await mutateDayTrades((all) =>
      all.map((t) => {
        if (t.id !== a.id) return t;
        const { charges } = dayTradePnl(t.side, t.qty, t.entry, a.exitPrice);
        closed = { ...t, status: 'closed', exitPrice: a.exitPrice, exitAt: now, exitReason: 'manual', charges, auto: true };
        return closed;
      }),
    );
    if (closed) {
      const { pnl } = dayTradePnl(closed.side, closed.qty, closed.entry, a.exitPrice);
      await notify(`alert:closed-${closed.id}`, { title: `${closed.symbol} closed in Upstox: ${signedRs(pnl)}`, message: `${closed.side === 'long' ? 'Sold' : 'Bought back'} ${closed.qty} at ${rs(a.exitPrice)}. Result after estimated charges.`, priority: 1 });
      await playSound(pnl >= 0 ? 'target' : 'stop');
      log.info(`Intraday ${closed.symbol} closed in Upstox @ ${a.exitPrice} (${pnl.toFixed(0)})`, { id: closed.id });
    }
    return;
  }
  if (a.type === 'record') {
    const { charges } = dayTradePnl('long', a.qty, a.entry, a.exitPrice);
    const trade: DayTrade = { id: newId('D', now), date, key: a.key, symbol: a.symbol, side: 'long', qty: a.qty, entry: a.entry, stop: a.entry, target: null, openedAt: now, practice: false, status: 'closed', exitPrice: a.exitPrice, exitAt: now, exitReason: 'manual', charges, auto: true };
    await mutateDayTrades((all) => [...all, trade]);
    log.info(`Recorded finished intraday trade ${a.symbol} ${a.qty}: ${a.entry} → ${a.exitPrice}`);
    return;
  }
  await mutateDayTrades((all) => all.map((t) => (t.id === a.id ? { ...t, qty: a.qty, entry: a.entry, exitPrice: a.exitPrice, charges: dayTradePnl('long', a.qty, a.entry, a.exitPrice).charges } : t)));
}

async function applyDelivery(a: DeliverySyncAction, date: string, now: number): Promise<void> {
  if (a.type === 'bought') {
    const risk = (stop: number) => Number((a.qty * Math.max(0, a.price - stop)).toFixed(2));
    if (a.planId) {
      const plan = ((await getLocal('plans')) ?? []).find((p) => p.id === a.planId);
      if (!plan) return;
      const wasPlanned = plan.status === 'planned';
      await updatePlan(a.planId, { status: 'open', fillPrice: a.price, qty: a.qty, riskRupees: risk(plan.stop), rewardRupees: Number((a.qty * (plan.target - a.price)).toFixed(2)) }, now);
      await mutatePlans((all) => all.map((p) => (p.id === a.planId ? { ...p, auto: true } : p)));
      if (wasPlanned) await announceBought(a.symbol, a.qty, a.price, plan.stop, plan.target, a.planId);
      return;
    }
    const [settings, cal, quotes] = await Promise.all([getSettings(), getCalendar(), getQuotes()]);
    const d = await loadStockData(a.key, { quote: quotes[a.key] ?? null, settings, calendar: cal, now });
    const built = planForPurchase(d, settings, d.instrument?.trading_symbol ?? a.symbol, a.price, a.qty, date);
    if ('error' in built) {
      log.info(`Found a delivery purchase of ${a.symbol} but cannot plan it yet: ${built.error}`);
      return;
    }
    const saved = await savePlan(built.plan, now);
    await updatePlan(saved.id, { status: 'open', fillPrice: a.price, qty: a.qty }, now);
    await mutatePlans((all) => all.map((p) => (p.id === saved.id ? { ...p, auto: true } : p)));
    await announceBought(built.plan.symbol, a.qty, a.price, built.plan.stop, built.plan.target, saved.id);
    return;
  }
  const plan = ((await getLocal('plans')) ?? []).find((p) => p.id === a.planId);
  if (!plan) return;
  const basis = plan.fillPrice ?? plan.entry;
  if (a.all) {
    const reason = a.price <= plan.stop * 1.002 ? 'stop' : a.price >= plan.target * 0.998 ? 'target' : 'manual';
    await updatePlan(plan.id, { status: 'closed', exitPrice: a.price, exitReason: reason }, now);
    await mutatePlans((all) => all.map((p) => (p.id === plan.id ? { ...p, exitDate: date, syncSold: { date, qty: a.soldQty } } : p)));
    const pnl = (a.price - basis) * plan.qty;
    await notify(`alert:sold-${plan.id}`, { title: `${plan.symbol} sold in Upstox: ${signedRs(pnl)}`, message: `${plan.qty} shares at ${rs(a.price)} (bought ${rs(basis)}), before charges. The trade is closed here too. Cancel its GTT in Upstox if it is still there.`, priority: 1 });
    await playSound(pnl >= 0 ? 'target' : 'stop');
    log.info(`${plan.symbol} sold in Upstox @ ${a.price}`, { id: plan.id });
    return;
  }
  // part of the shares sold: keep watching the rest
  const already = plan.syncSold?.date === date ? plan.syncSold.qty : 0;
  const left = Math.max(1, plan.qty - (a.soldQty - already));
  await mutatePlans((all) => all.map((p) => (p.id === plan.id ? { ...p, qty: left, riskRupees: Number((left * Math.max(0, basis - p.stop)).toFixed(2)), rewardRupees: Number((left * (p.target - basis)).toFixed(2)), syncSold: { date, qty: a.soldQty }, updatedAt: now } : p)));
  await notify(`alert:sold-${plan.id}:${a.soldQty}`, { title: `${plan.symbol}: ${a.soldQty - already} shares sold in Upstox`, message: `${left} shares are still watched. Change the quantity of its GTT in Upstox to ${left}.`, priority: 1 });
}

async function announceBought(symbol: string, qty: number, price: number, stop: number, target: number, planId: string): Promise<void> {
  const limit = Math.max(0.05, Math.floor(stop * 0.995 * 20) / 20);
  await notify(`alert:found-${planId}`, {
    title: `Found in Upstox: bought ${qty} ${symbol} at ${rs(price)} (Delivery)`,
    message: `Now watched. Set your safety sell: Upstox → ${symbol} → Create GTT → Sell ${qty}, trigger ${rs(stop)}, limit ${rs(limit)}. Profit target ${rs(target)}.`,
    requireInteraction: true,
    priority: 2,
  });
  await playSound('info');
  log.info(`Found delivery purchase ${symbol} ${qty} @ ${price}`, { id: planId });
}

let running: Promise<{ ok: boolean; changes: number; skipped?: string }> | null = null;

/**
 * Reads today's positions and brings the extension's trades in line. Throttled to once every 10 s;
 * runs while the market is open (and up to 30 minutes after the close), or when `force` is set.
 */
export function syncPortfolio(now = Date.now(), force = false): Promise<{ ok: boolean; changes: number; skipped?: string }> {
  running ??= (async () => {
    const settings = await getSettings();
    if (!settings.portfolio.autoSync) return { ok: true, changes: 0, skipped: 'off' };
    if (!hasLiveSession(await getAuth(), now)) return { ok: true, changes: 0, skipped: 'not logged in' };
    const last = await getSession('portfolioStatus');
    if (!force) {
      if (last && now - last.at < PORTFOLIO_EVERY_MS) return { ok: true, changes: 0, skipped: 'recent' };
      // after a failure wait a minute before trying again
      if (last && !last.ok && now - last.at < 60_000) return { ok: false, changes: 0, skipped: 'waiting after an error' };
      const m = marketState(now, await getCalendar());
      const live = m.phase === 'open' || m.phase === 'pre_open' || (m.phase === 'after_close' && m.session.closeAt !== undefined && now < m.session.closeAt + 30 * 60_000);
      if (!live && last?.ok && istDate(last.at) === istDate(now)) return { ok: true, changes: 0, skipped: 'market closed' };
    }
    const date = istDate(now);
    try {
      const data = await upstoxRequest<unknown>('/v2/portfolio/short-term-positions', { tokenKind: 'account', attempts: 1 });
      const positions = parsePositions(data);
      const day = reconcileDay(positions, (await getLocal('dayTrades')) ?? [], date);
      for (const a of day) await applyDay(a, date, now);
      const del = reconcileDelivery(positions, (await getLocal('plans')) ?? [], date);
      for (const a of del) await applyDelivery(a, date, now).catch((err: unknown) => log.warn('Could not apply a delivery change', { error: errorMessage(err) }));
      await setSession('portfolioStatus', { at: now, ok: true, positions: positions.length });
      return { ok: true, changes: day.length + del.length };
    } catch (err) {
      const msg = err instanceof UpstoxError ? err.message : errorMessage(err);
      if (!last || last.ok || last.error !== msg) log.warn('Reading the Upstox positions failed', { error: msg });
      await setSession('portfolioStatus', { at: now, ok: false, positions: 0, error: msg });
      return { ok: false, changes: 0, skipped: msg };
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
