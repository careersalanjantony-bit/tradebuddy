import { mutatePlans } from '../alerts/engine';
import { marketState, nseSession, quoteSessionDate, type MarketCalendar } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getQuotes, pollQuotes } from '../data/quotes';
import type { Quote } from '../data/quotesParse';
import { loadStockData, STALE_MS } from '../data/stockData';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { savePlan, type NewPlan } from '../planner/plans';
import { practiceCharges, practiceExit, practiceFill, type LiveDay } from '../practice/practice';
import { getLocal, getSettings } from '../storage/local';
import type { TradePlan } from '../storage/schema';

/**
 * Practice trades in the service worker (v0.9.0): buy at the live price (or at the next opening
 * price), and sell by themselves — checked on every price poll and after the end-of-day history sync.
 * Nothing is ever sent to Upstox.
 */

const log = createLogger('practice');
const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function liveDayOf(q: Quote | undefined | null, cal: MarketCalendar | null): LiveDay | null {
  if (!q || !(q.ltp > 0)) return null;
  const date = quoteSessionDate(q.fetchedAt, cal);
  if (!date) return null;
  const closeAt = nseSession(date, cal).closeAt;
  return { date, open: q.open, high: q.high, low: q.low, ltp: q.ltp, final: closeAt !== undefined && q.fetchedAt >= closeAt, at: q.fetchedAt };
}

/** A price from the current session that is at most 60 s old (fetched now if needed), or the last close when the market is shut. */
async function freshQuote(key: string, now: number): Promise<{ quote: Quote; live: boolean }> {
  const cal = await getCalendar();
  const live = marketState(now, cal).phase === 'open';
  let q = (await getQuotes())[key];
  if (live && (!q || now - q.fetchedAt > 60_000)) q = (await pollQuotes([key], now))[key] ?? q;
  if (!q || !(q.ltp > 0)) throw new Error('No price for this stock yet — log in or add the Analytics Token, then try again.');
  if (live && now - q.fetchedAt > STALE_MS) throw new Error('Prices are not updating — check the Upstox login, then try again.');
  return { quote: q, live };
}

/** "Practice buy": during market hours at the live price; otherwise at the next opening price. */
export async function practiceBuy(p: NewPlan, now = Date.now()): Promise<{ id: string; status: 'open' | 'planned'; price: number | null }> {
  const plans = (await getLocal('plans')) ?? [];
  if (plans.some((x) => x.key === p.key && (x.status === 'open' || x.status === 'planned'))) throw new Error(`You already have a trade in ${p.symbol}.`);
  const { quote, live } = await freshQuote(p.key, now);
  if (live && quote.ltp > p.entry * 1.01) {
    throw new Error(`${p.symbol} is now ₹${quote.ltp.toFixed(2)}, more than 1% above the buy price ₹${p.entry.toFixed(2)} — skip it, as the steps say.`);
  }
  const saved = await savePlan({ ...p, practice: true }, now);
  if (!live) {
    log.info(`Practice order ${p.symbol}: waits for the next opening price`, { id: saved.id });
    return { id: saved.id, status: 'planned', price: null };
  }
  const fill = quote.ltp;
  await mutatePlans((all) => all.map((x) => (x.id === saved.id ? { ...x, status: 'open', fillPrice: fill, openedDate: istDate(now), openedAt: now, updatedAt: now } : x)));
  log.info(`Practice buy ${p.symbol} ${p.qty} @ ${fill}`, { id: saved.id });
  return { id: saved.id, status: 'open', price: fill };
}

async function closePractice(plan: TradePlan, price: number, reason: 'stop' | 'gap' | 'target' | 'time' | 'manual', date: string, now: number, chargesPct: number | null): Promise<number> {
  const charges = practiceCharges((plan.fillPrice ?? plan.entry) * plan.qty, chargesPct);
  const pnl = (price - (plan.fillPrice ?? plan.entry)) * plan.qty - charges;
  await mutatePlans((all) =>
    all.map((x) =>
      x.id === plan.id
        ? {
            ...x,
            status: 'closed',
            exitPrice: price,
            exitReason: reason === 'gap' ? 'stop' : reason,
            exitDate: date,
            exitCharges: charges,
            updatedAt: now,
            ...(reason === 'gap' ? { notes: 'Opened below the sell price — sold at the opening price.' } : {}),
          }
        : x,
    ),
  );
  return pnl;
}

const WHY = { stop: 'sell price reached', gap: 'opened below the sell price', target: 'profit target reached', time: 'time limit reached', manual: 'sold by you' } as const;

/** Practice sell now, at the latest price. */
export async function practiceSell(id: string, now = Date.now()): Promise<{ price: number; pnl: number }> {
  const plan = ((await getLocal('plans')) ?? []).find((p) => p.id === id && p.practice);
  if (!plan) throw new Error('Practice trade not found.');
  if (plan.status === 'planned') {
    await mutatePlans((all) => all.map((x) => (x.id === id ? { ...x, status: 'cancelled', notes: 'Cancelled before it was bought.', updatedAt: now } : x)));
    return { price: 0, pnl: 0 };
  }
  if (plan.status !== 'open') throw new Error('This practice trade is already finished.');
  const { quote } = await freshQuote(plan.key, now);
  const cal = await getCalendar();
  const pnl = await closePractice(plan, quote.ltp, 'manual', quoteSessionDate(quote.fetchedAt, cal) ?? istDate(now), now, (await getSettings()).risk.chargesEstimatePct);
  log.info(`Practice sell ${plan.symbol} @ ${quote.ltp} (${pnl.toFixed(0)})`, { id });
  return { price: quote.ltp, pnl };
}

export async function practiceReset(): Promise<number> {
  let removed = 0;
  await mutatePlans((all) => {
    const keep = all.filter((p) => !p.practice);
    removed = all.length - keep.length;
    return keep;
  });
  return removed;
}

/**
 * Fills waiting practice orders at the opening price and sells open practice trades whose sell
 * price, profit target or time limit was reached. Called after every price poll and after the
 * end-of-day sync.
 */
export async function checkPracticeTrades(now = Date.now()): Promise<{ filled: number; skipped: number; closed: number }> {
  const plans = ((await getLocal('plans')) ?? []).filter((p) => p.practice && (p.status === 'open' || p.status === 'planned'));
  const out = { filled: 0, skipped: 0, closed: 0 };
  if (!plans.length) return out;
  const [settings, cal, quotes] = await Promise.all([getSettings(), getCalendar(), getQuotes()]);
  const horizon = settings.planner.exitHorizonSessions;

  for (const p of plans) {
    try {
      const live = liveDayOf(quotes[p.key], cal);
      if (p.status === 'planned') {
        const openAt = live ? (nseSession(live.date, cal).openAt ?? null) : null;
        const d = practiceFill(p, live, openAt);
        if (!d) continue;
        if ('skip' in d) {
          await mutatePlans((all) => all.map((x) => (x.id === p.id ? { ...x, status: 'cancelled', notes: `Practice order ${d.skip}.`, updatedAt: now } : x)));
          await notify(`alert:practice-${p.id}:skip`, { title: `Practice: ${p.symbol} not bought`, message: `It ${d.skip}.` });
          out.skipped++;
        } else {
          await mutatePlans((all) => all.map((x) => (x.id === p.id ? { ...x, status: 'open', fillPrice: d.fill, openedDate: live!.date, openedAt: openAt!, updatedAt: now } : x)));
          await notify(`alert:practice-${p.id}:fill`, { title: `Practice: bought ${p.symbol}`, message: `${p.qty} shares at the opening price ${rs(d.fill)} (pretend money).` });
          out.filled++;
        }
        continue;
      }
      const d = await loadStockData(p.key, { quote: quotes[p.key] ?? null, settings, calendar: cal, now });
      const exit = practiceExit(p, d.candles.filter((c) => !c.partial), live, horizon);
      if (!exit) continue;
      const pnl = await closePractice(p, exit.price, exit.reason, exit.date, now, settings.risk.chargesEstimatePct);
      const sign = pnl >= 0 ? '+' : '−';
      await notify(`alert:practice-${p.id}:exit`, {
        title: `Practice: sold ${p.symbol} (${WHY[exit.reason]})`,
        message: `${p.qty} shares at ${rs(exit.price)} · ${sign}₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')} after charges (pretend money).`,
        priority: 2,
      });
      await playSound(pnl >= 0 ? 'target' : 'stop');
      log.info(`Practice exit ${p.symbol}: ${exit.reason} @ ${exit.price} (${pnl.toFixed(0)})`, { id: p.id });
      out.closed++;
    } catch (err) {
      log.warn(`Practice check failed for ${p.symbol}`, { error: errorMessage(err) });
    }
  }
  return out;
}
