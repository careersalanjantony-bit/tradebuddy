import { evaluateEndOfDay, evaluateIntraday, mutatePlans } from '../alerts/engine';
import { adviceForPlan } from '../advisor/forPlan';
import type { TradePlan } from '../storage/schema';
import { marketState, pollDue } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { syncCandles } from '../data/candles';
import { refreshCorporateActions } from '../data/corporateActions';
import { countInstruments, findBySymbol, getInstrument, refreshInstruments } from '../data/instruments';
import { SEED_SYMBOLS } from '../data/instrumentsParse';
import { getQuotes, pollLtp, pollQuotes, trackedKeys } from '../data/quotes';
import { invalidateStockCache, loadStockData } from '../data/stockData';
import { newTopPicks, suggestBuys } from '../advisor/suggest';
import { isShortlisted } from '../indicators/snapshot';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate, istEpoch } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getDb } from '../storage/db';
import { getSession, setSession } from '../storage/session';
import { UpstoxError } from '../upstox/errors';
import { checkPracticeTrades } from './practiceJobs';
import { dayTick } from './dayJobs';
import { ensureFeed, feedFresh, setFeedListener } from './feed';
import { refreshNews } from './newsJobs';
import { syncPortfolio } from './portfolioJobs';
import { INDEX_KEYS } from '../data/indices';
import { checkWallet, recordEquity } from './walletJobs';
import { refreshFlow } from './flowJobs';
import { refreshBreadth, scanShorts } from './shortJobs';
import { scanBreakouts } from './breakoutJobs';
import { runBot } from './botJobs';

const log = createLogger('data');

/** Tells open pages that stored data changed, so they recompute. */
export const DATA_CHANNEL = 'swing-data';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(DATA_CHANNEL) : null;
export function announce(type: 'candles' | 'quotes' | 'instruments', key?: string): void {
  channel?.postMessage({ type, key });
}

/** Downloads the instrument list if missing or older than a day; seeds the watchlist the first time. */
export async function ensureInstruments(force = false, now = Date.now()): Promise<number> {
  const state = (await getLocal('scheduleState'))?.['instruments-refresh'];
  const count = await countInstruments();
  if (!force && count > 0 && state?.lastSuccessAt && now - state.lastSuccessAt < 24 * 3600_000) return count;
  const n = await refreshInstruments();
  const watchlist = (await getLocal('watchlist')) ?? [];
  if (!watchlist.length && !state?.lastSuccessAt) {
    const keys: string[] = [];
    for (const sym of SEED_SYMBOLS) {
      const inst = await findBySymbol(sym);
      if (inst) keys.push(inst.instrument_key);
      else log.warn(`Seed symbol ${sym} not found in the instrument list`);
    }
    await setLocal('watchlist', keys);
    log.info(`Watchlist seeded with ${keys.length} stocks from the 9 Nov 2026 screen`);
  }
  announce('instruments');
  return n;
}

/** Corporate actions + candles for one stock. Corporate actions: daily for your own stocks, weekly for the studied list. */
export async function syncStock(key: string, now = Date.now(), corpMaxAgeMs = 20 * 3600_000): Promise<{ fetched: number; lastDate: string | null }> {
  const cal = await getCalendar();
  const inst = await getInstrument(key);
  if (inst?.isin && inst.instrument_type === 'EQ') await refreshCorporateActions(inst.isin, corpMaxAgeMs, now);
  const r = await syncCandles(key, cal, now);
  invalidateStockCache(key);
  announce('candles', key);
  return { fetched: r.fetched, lastDate: r.lastDate };
}

let syncRunning: Promise<{ ok: number; failed: string[] }> | null = null;

/** History for every tracked stock (studied list + your stocks + trades). One run at a time; progress in session storage. */
export function syncAllTracked(now = Date.now()): Promise<{ ok: number; failed: string[] }> {
  syncRunning ??= (async () => {
    const keys = await trackedKeys();
    const own = new Set([...((await getLocal('watchlist')) ?? []), ...((await getLocal('plans')) ?? []).map((p) => p.key)]);
    const failed: string[] = [];
    let ok = 0;
    await setSession('syncProgress', { done: 0, total: keys.length, running: true, at: Date.now() });
    try {
      for (const key of keys) {
        try {
          await syncStock(key, now, own.has(key) ? 20 * 3600_000 : 7 * 24 * 3600_000);
          ok++;
        } catch (err) {
          if (err instanceof UpstoxError && err.kind === 'not_logged_in') throw err;
          failed.push(key);
          log.warn(`Candle sync failed for ${key}`, { error: err });
        }
        if ((ok + failed.length) % 5 === 0) await setSession('syncProgress', { done: ok + failed.length, total: keys.length, running: true, at: Date.now() });
      }
    } finally {
      await setSession('syncProgress', { done: ok + failed.length, total: keys.length, running: false, at: Date.now() });
    }
    return { ok, failed };
  })().finally(() => {
    syncRunning = null;
  });
  return syncRunning;
}



/**
 * Price poll + intraday alerts. Runs every 30 s from an alarm; does work in pre-open/open, and once
 * when the market is closed if the last session's closing prices were not fetched yet (see pollDue).
 * `force` polls at any time (Refresh button).
 */
export async function pollAndEvaluate(force = false, now = Date.now(), light = false): Promise<{ polled: number; skipped?: string }> {
  const cal = await getCalendar();
  const m = marketState(now, cal);
  if (!force && !pollDue(now, cal, await getSession('lastPoll'))) return { polled: 0, skipped: 'market closed' };
  const keys = await trackedKeys();
  if (!keys.length) return { polled: 0, skipped: 'nothing to track' };
  try {
    void ensureFeed(now).catch(() => undefined);
    // light = last prices only (between full polls); full = prices + the day's open/high/low/volume.
    // The two index instruments (Nifty 50, India VIX) are priced along with the stocks.
    const all = [...keys, ...INDEX_KEYS];
    const quotes = light ? await pollLtp(all, now) : await pollQuotes(all, now);
    if (!light) lastFullPollAt = now;
    await afterQuotes(now);
    return { polled: Object.keys(quotes).length };
  } catch (err) {
    if (err instanceof UpstoxError && err.kind === 'not_logged_in') return { polled: 0, skipped: 'not logged in' };
    throw err;
  }
}

let afterRunning = false;

/**
 * Everything that must look at new prices: alerts, practice trades, day-trade signals and exits, the
 * Upstox account sync, news and new top picks. Runs after every poll and after live-feed updates
 * (never twice at the same time).
 */
export async function afterQuotes(now = Date.now()): Promise<void> {
  if (afterRunning) return;
  afterRunning = true;
  try {
    announce('quotes');
    const cal = await getCalendar();
    const m = marketState(now, cal);
    const { alerts } = await getSettings();
    await evaluateIntraday(await getQuotes(), cal, alerts.hysteresisPct, now);
    await checkPracticeTrades(now).catch((err: unknown) => log.warn('Practice check failed', { error: err }));
    await checkWallet(now).catch((err: unknown) => log.warn('Practice money check failed', { error: err }));
    await runBot(now).catch((err: unknown) => log.warn('Auto-trader check failed', { error: err }));
    await recordEquity(now).catch(() => undefined);
    await syncPortfolio(now).catch((err: unknown) => log.warn('Upstox account check failed', { error: err }));
    await dayTick(now).catch((err: unknown) => log.warn('Day-trade check failed', { error: err }));
    if (m.phase === 'open' && m.session.openAt !== undefined && now >= m.session.openAt + 5 * 60_000) {
      await checkNewPicks(now).catch((err: unknown) => log.warn('Top-pick check failed', { error: err }));
    }
    // news in every phase (app v1.7): weekends and evenings too, paced inside refreshNews
    void refreshNews(now).catch(() => undefined);
    if (m.phase === 'open') void refreshFlow(now).catch(() => undefined);
    void refreshBreadth(now).catch(() => undefined);
    if (m.phase === 'open') void scanShorts(now).catch(() => undefined);
    // breakouts (app v1.9): also after every price poll, when the live feed is not connected
    if (m.phase === 'open') void scanBreakouts(now).catch((err: unknown) => log.warn('Breakout scan failed', { error: err }));
  } finally {
    afterRunning = false;
  }
}

let lastFeedChecksAt = 0;
// live-feed prices are stored every second; the checks above run on them at most every 2 seconds
setFeedListener(async (now) => {
  // breakouts are checked on EVERY live price update (about each second), not every 2 seconds:
  // the alert must come the moment the price crosses the resistance with a volume surge
  void scanBreakouts(now).catch(() => undefined);
  if (now - lastFeedChecksAt < 2_000) {
    announce('quotes');
    return;
  }
  lastFeedChecksAt = now;
  await afterQuotes(now);
});

let fastInFlight: Promise<{ polled: number; skipped?: string }> | null = null;
let lastFullPollAt = 0;
/** Seconds between fast polls: 2 s per 500 stocks, so one group of requests stays well under Upstox's limits. */
export const fastIntervalMs = (keyCount: number): number => 2_000 * Math.max(1, Math.ceil(keyCount / 500));

/**
 * Fast refresh (owner, 11 Nov 2026: 5 seconds, then "faster"). Chrome's alarms cannot fire more often
 * than every 30 s, so the open side panel asks for a poll every 2 s. Market hours only; never two
 * polls at once; the interval is 2 s per 500 stocks (several open panels do not add requests).
 */
export async function fastPoll(now = Date.now()): Promise<{ polled: number; skipped?: string }> {
  const m = marketState(now, await getCalendar());
  if (m.phase !== 'open' && m.phase !== 'pre_open') return { polled: 0, skipped: 'market closed' };
  if (fastInFlight) return { polled: 0, skipped: 'busy' };
  // every ~10 s a full poll (day's open/high/low/volume); in between only the last prices —
  // and none at all while the instant feed is delivering them
  const light = now - lastFullPollAt < 10_000;
  if (light) {
    if (feedFresh(now)) return { polled: 0, skipped: 'instant feed' };
    const last = await getSession('lastPoll');
    const every = fastIntervalMs((await trackedKeys()).length);
    if (last && now - last.at < every - 300) return { polled: 0, skipped: 'recent' };
  }
  fastInFlight = pollAndEvaluate(false, now, light).finally(() => {
    fastInFlight = null;
  });
  return fastInFlight;
}

/**
 * After the close (spec §7.4, §10, §12): sync candles for every tracked stock, run end-of-day
 * alerts, scan the watchlist and send one summary notification per day.
 */
export async function runEndOfDay(now = Date.now()): Promise<{ synced: number; failed: number; shortlist: string[] }> {
  const { ok, failed } = await syncAllTracked(now);
  const [settings, cal, quotes, watchlist] = await Promise.all([getSettings(), getCalendar(), getQuotes(), getLocal('watchlist')]);
  const closes = new Map<string, { close: number; sma20: number | null }>();
  const shortlist: string[] = [];
  for (const key of await trackedKeys()) {
    try {
      const d = await loadStockData(key, { quote: quotes[key] ?? null, settings, calendar: cal, now });
      if (!d.snapshot) continue;
      closes.set(key, { close: d.snapshot.price, sma20: d.snapshot.sma20 });
      if ((watchlist ?? []).includes(key) && isShortlisted(d.snapshot)) shortlist.push(`${d.instrument?.trading_symbol ?? key} (${d.snapshot.setup})`);
    } catch (err) {
      log.warn(`End-of-day analysis failed for ${key}`, { error: errorMessage(err) });
    }
  }
  await evaluateEndOfDay(closes, now);
  await checkPracticeTrades(now).catch((err: unknown) => log.warn('Practice check failed', { error: err }));
  await sendHoldSellAdvice(now);

  const state = (await getLocal('scheduleState'))?.['eod-candles'];
  const today = istDate(now);
  if (settings.scanner.eveningEnabled && !(state?.lastNotifiedAt && istDate(state.lastNotifiedAt) === today)) {
    await notify('scan-summary', {
      title: shortlist.length ? `Evening scan: ${shortlist.length} on the shortlist` : 'Evening scan: no setups today',
      message: shortlist.length ? shortlist.slice(0, 6).join(', ') : 'No watchlist stock has a valid setup. Open the Shortlist for details.',
    });
    const all = (await getLocal('scheduleState')) ?? {};
    await setLocal('scheduleState', { ...all, 'eod-candles': { ...all['eod-candles'], lastNotifiedAt: now } });
  }
  log.info(`End of day: ${ok} synced, ${failed.length} failed, shortlist: ${shortlist.join(', ') || 'none'}`);
  return { synced: ok, failed: failed.length, shortlist };
}

/**
 * Evening hold-or-sell advice for every open trade (owner's history-based exit logic). A notification
 * is sent when the advice changes, or when the suggested GTT stop moves up.
 */
export async function sendHoldSellAdvice(now = Date.now()): Promise<number> {
  const plans = (await getLocal('plans')) ?? [];
  const open = plans.filter((p) => p.status === 'open' && !p.practice); // practice trades sell by themselves
  if (!open.length) return 0;
  const [settings, cal, quotes] = await Promise.all([getSettings(), getCalendar(), getQuotes()]);
  const updates = new Map<string, NonNullable<TradePlan['lastAdvice']>>();
  for (const p of open) {
    try {
      const d = await loadStockData(p.key, { quote: quotes[p.key] ?? null, settings, calendar: cal, now });
      const a = adviceForPlan(p, d, settings);
      if (!a) continue;
      const prev = p.lastAdvice;
      const changed = !prev || prev.action !== a.action || (a.moveStopTo !== null && (prev.moveStopTo === null || a.moveStopTo > prev.moveStopTo));
      if (!changed) continue;
      updates.set(p.id, { action: a.action, headline: a.headline, at: now, moveStopTo: a.moveStopTo });
      const stopNote = a.moveStopTo !== null && a.action === 'HOLD' ? ` Move your GTT stop up to ₹${a.moveStopTo.toFixed(2)}.` : '';
      await notify(`alert:advice-${p.id}:${now}`, {
        title: `${p.symbol} — ${a.action.replace('_', ' ')}`,
        message: `${a.headline}${stopNote}`,
        requireInteraction: a.action !== 'HOLD',
        priority: a.action === 'HOLD' ? 1 : 2,
      });
      await playSound(a.action === 'SELL' || a.action === 'EXIT' ? 'stop' : a.action === 'BOOK_PROFIT' ? 'target' : 'info');
      log.info(`Advice ${p.symbol}: ${a.action} — ${a.headline}`, { r: a.r, trailingStop: a.trailingStop });
    } catch (err) {
      log.warn(`Advice failed for ${p.symbol}`, { error: errorMessage(err) });
    }
  }
  if (updates.size) await mutatePlans((all) => all.map((p) => (updates.has(p.id) ? { ...p, lastAdvice: updates.get(p.id)! } : p)));
  return updates.size;
}

/**
 * "New top pick" alerts (v0.7.0): every 5 minutes in market hours, rank the studied list with live
 * prices; announce each stock the first time it becomes a top pick that day (max 3 per check).
 */
export async function checkNewPicks(now = Date.now()): Promise<string[]> {
  const stored = await getSettings();
  if (!stored.scanner.newPickAlerts) return [];
  // app v1.7: alerts also before an amount is set — the plan is then sized for ₹1 lakh
  const settings = stored.risk.capitalInr ? stored : { ...stored, risk: { ...stored.risk, capitalInr: 100_000 } };
  const last = await getSession('lastPickCheck');
  if (last && now - last < 5 * 60_000) return [];
  await setSession('lastPickCheck', now);
  const [cal, quotes, plans, keys] = await Promise.all([getCalendar(), getQuotes(), getLocal('plans'), trackedKeys()]);
  const stocks = [];
  for (const key of keys) {
    const d = await loadStockData(key, { quote: quotes[key] ?? null, settings, calendar: cal, now });
    stocks.push({ key, symbol: d.instrument?.trading_symbol ?? key, data: d });
  }
  const res = suggestBuys(stocks, settings, plans ?? [], istDate(now));
  const today = istDate(now);
  const prev = await getSession('announcedPicks');
  const announced = prev?.day === today ? prev.keys : [];
  const fresh = newTopPicks(announced, res.suggestions).slice(0, 3);
  for (const p of fresh) {
    await notify(`alert:pick-${p.symbol}:${now}`, {
      title: `New top pick: ${p.symbol}`,
      message: `Buy ${p.plan.qty} at ₹${p.plan.entry.toFixed(2)}${stored.risk.capitalInr ? '' : ' (for ₹1 lakh)'} · sell if it falls to ₹${p.plan.stop.toFixed(2)} · target ₹${p.plan.target.toFixed(2)}. Possible +₹${Math.round(p.targetEarning).toLocaleString('en-IN')} · most you could lose ₹${Math.round(p.plan.riskRupees).toLocaleString('en-IN')}. Hold a few days.`,
    });
  }
  if (fresh.length) {
    await playSound('info');
    await setSession('announcedPicks', { day: today, keys: [...announced, ...fresh.map((p) => p.key)] });
    log.info(`New top pick(s): ${fresh.map((p) => p.symbol).join(', ')}`);
  }
  return fresh.map((p) => p.symbol);
}

/** Tracked stocks with no stored history yet (e.g. right after switching to Nifty 100). */
export async function keysWithoutHistory(): Promise<string[]> {
  const db = await getDb();
  const missing: string[] = [];
  for (const key of await trackedKeys()) {
    const n = await db.count('candles', IDBKeyRange.bound([key, ''], [key, '\uffff']));
    if (n === 0) missing.push(key);
  }
  return missing;
}

/** True when today's 09:20 re-check should still run (trading day, 09:20 – close, not done today). */
export async function morningDue(now = Date.now()): Promise<boolean> {
  const cal = await getCalendar();
  const m = marketState(now, cal);
  const today = istDate(now);
  if (!m.session.trading || m.session.closeAt === undefined || now < istEpoch(today, '09:20') || now >= m.session.closeAt) return false;
  const state = (await getLocal('scheduleState'))?.['morning-recheck'];
  return !(state?.lastSuccessAt && state.lastSuccessAt >= istEpoch(today, '09:20'));
}

/** True when today's end-of-day job should still run (trading day, after 16:00, not yet done today). */
export async function eodDue(now = Date.now()): Promise<boolean> {
  const cal = await getCalendar();
  const m = marketState(now, cal);
  const today = istDate(now);
  if (!m.session.trading || now < istEpoch(today, '16:00')) return false;
  const state = (await getLocal('scheduleState'))?.['eod-candles'];
  return !(state?.lastSuccessAt && state.lastSuccessAt >= istEpoch(today, '16:00'));
}
