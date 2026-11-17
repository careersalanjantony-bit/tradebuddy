import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getIntradayDays } from '../data/intraday';
import { getInstrument } from '../data/instruments';
import { fetchNews } from '../data/news';
import { getQuotes } from '../data/quotes';
import { minutesIST } from '../daytrade/live';
import { catalystOf, lastCloseBefore, type Catalyst } from '../early/catalyst';
import { runEarlyTest, type TestDay } from '../early/earlyTest';
import { runOpenTest } from '../early/preopen';
import { NSE_BLOCK_URL, NSE_BULK_URL, nseDeliveryUrl, parseDeals, parseDelivery, type Deal, type Delivery } from '../early/nseFiles';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { addDays, istDate } from '../lib/time';
import { prevDayOf, type PrevDay } from '../ml/features';
import { appFetch } from '../platform/http';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { scanUniverse } from './scanList';

/**
 * App v1.15 — the slower inputs of "Early Movers — Before the Rally":
 *  - NSE's end-of-day files (bulk deals, block deals, delivery %), once a day, dated;
 *  - a catalyst sweep: Upstox news for EVERY scanned stock (30 per request), before the open and
 *    every 30 minutes in market hours, reduced to one catalyst per stock (results, order win, upgrade…);
 *  - the pre-market view: catalysts since yesterday's close and opening gaps (indicative before 9:15);
 *  - the past test of the rules, once a day.
 * Read-only; genuine data only — anything missing is shown as missing.
 */

const log = createLogger('early');

export interface NseFiles {
  at: number;
  bulk: { date: string | null; deals: Deal[] };
  block: { date: string | null; deals: Deal[] };
  delivery: { date: string | null; bySymbol: Record<string, Delivery> };
  errors: string[];
}

async function text(url: string): Promise<string> {
  const res = await appFetch(url, { timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

let nseRunning: Promise<NseFiles | null> | null = null;

/** NSE's bulk / block deals and delivery files, at most every 6 hours (only the scanned stocks are kept). */
export function refreshNseFiles(now = Date.now(), force = false): Promise<NseFiles | null> {
  nseRunning ??= (async () => {
    const prev = await getLocal('nseFiles');
    if (!force && prev && now - prev.at < 6 * 3600_000) return prev;
    const scan = await scanUniverse();
    const symbols = new Set<string>();
    for (const k of scan.keys) {
      const s = (await getInstrument(k))?.trading_symbol;
      if (s) symbols.add(s.toUpperCase());
    }
    const errors: string[] = [];
    const deals = async (url: string, kind: Deal['kind']) => {
      try {
        const all = parseDeals(await text(url), kind);
        return { date: all[0]?.date ?? null, deals: all.filter((d) => symbols.has(d.symbol)) };
      } catch (err) {
        errors.push(`${kind} deals: ${errorMessage(err)}`);
        return prev?.[kind] ?? { date: null, deals: [] };
      }
    };
    const bulk = await deals(NSE_BULK_URL, 'bulk');
    const block = await deals(NSE_BLOCK_URL, 'block');
    // the delivery file of the latest trading day that has one (today after the evening, else earlier)
    let delivery: NseFiles['delivery'] = prev?.delivery ?? { date: null, bySymbol: {} };
    const t = minutesIST(now);
    for (let back = t >= 19 * 60 ? 0 : 1; back <= 6; back++) {
      const date = addDays(istDate(now), -back);
      const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      if (delivery.date === date) break;
      try {
        const bySymbol = parseDelivery(await text(nseDeliveryUrl(date)), symbols);
        if (Object.keys(bySymbol).length) {
          delivery = { date, bySymbol };
          break;
        }
      } catch {
        // not published for that day (holiday / not yet): try the day before
      }
    }
    if (!delivery.date) errors.push('delivery: no NSE file found for the last 6 days');
    const out: NseFiles = { at: now, bulk, block, delivery, errors };
    await setLocal('nseFiles', out);
    log.info(`NSE files: ${bulk.deals.length} bulk and ${block.deals.length} block deals in the list (${bulk.date ?? '—'}), delivery ${delivery.date ?? '—'}${errors.length ? `; ${errors.join('; ')}` : ''}`);
    return out;
  })().finally(() => {
    nseRunning = null;
  });
  return nseRunning;
}

// ---------------------------------------------------------------- catalysts for every stock

export interface CatalystStore {
  at: number;
  since: number;
  byKey: Record<string, Catalyst>;
  /** stocks asked for, and the news service's answer */
  asked: number;
  error?: string;
}

let sweeping: Promise<CatalystStore | null> | null = null;

/** Upstox news for every scanned stock (30 per request), reduced to one catalyst each. */
export function sweepCatalysts(now = Date.now(), force = false): Promise<CatalystStore | null> {
  sweeping ??= (async () => {
    const prev = await getLocal('catalysts');
    const since = lastCloseBefore(now);
    const t = minutesIST(now);
    const open = marketState(now, await getCalendar()).phase === 'open';
    // before the open: once (from 7:30); in market hours: every 30 minutes; otherwise every 3 hours
    const every = open ? 30 * 60_000 : t >= 7 * 60 + 30 && t < 9 * 60 + 15 ? 45 * 60_000 : 3 * 3600_000;
    if (!force && prev && prev.since === since && now - prev.at < every) return prev;
    const keys = (await scanUniverse()).keys;
    const byKey: Record<string, Catalyst> = {};
    let asked = 0;
    let error: string | undefined;
    for (let i = 0; i < keys.length; i += 30) {
      const part = keys.slice(i, i + 30);
      try {
        const items = await fetchNews(part);
        asked += part.length;
        for (const k of part) {
          const c = catalystOf(items.filter((x) => x.key === k), since);
          if (c) byKey[k] = c;
        }
      } catch (err) {
        error = errorMessage(err);
        break;
      }
    }
    if (!asked) {
      if (prev && error) await setLocal('catalysts', { ...prev, error });
      return prev ?? null;
    }
    const out: CatalystStore = { at: now, since, byKey, asked, ...(error ? { error } : {}) };
    await setLocal('catalysts', out);
    log.info(`Catalysts: ${Object.keys(byKey).length} of ${asked} stocks have news since the last close`);
    return out;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

/** The stock's catalyst: the full sweep, or the fresher headlines the News tab keeps for important stocks. */
export async function catalystFor(key: string, now: number): Promise<Catalyst | null> {
  return (await catalystLookup(now))(key);
}

/** App v1.16: the same for many stocks at once (one read of the stored news). */
export async function catalystLookup(now: number): Promise<(key: string) => Catalyst | null> {
  const [store, news] = await Promise.all([getLocal('catalysts'), getSession('news')]);
  const since = lastCloseBefore(now);
  const byKey = new Map<string, NonNullable<typeof news>['items']>();
  for (const i of news?.items ?? []) {
    const list = byKey.get(i.key) ?? [];
    list.push(i);
    byKey.set(i.key, list);
  }
  return (key) => {
    const fresh = catalystOf(byKey.get(key) ?? [], since);
    const swept = store && store.since === since ? (store.byKey[key] ?? null) : null;
    if (fresh && swept) return fresh.tone === 'bad' || swept.tone !== 'bad' ? (fresh.at >= swept.at ? fresh : swept) : swept;
    return fresh ?? swept;
  };
}

// ---------------------------------------------------------------- pre-market view (and the opening gaps)

export interface PremarketRow {
  key: string;
  symbol: string;
  index?: string;
  catalyst: Catalyst | null;
  /** opening gap vs yesterday's close, % — before 9:15 the indicative pre-open price if Upstox gives one */
  gapPct: number | null;
  gapKind: 'open' | 'pre-open' | null;
  price: number | null;
}

/** Every minute from 7:30 to 3:30: good catalysts since yesterday's close and the opening gaps. */
export async function refreshPremarket(now = Date.now()): Promise<number> {
  const t = minutesIST(now);
  if (t < 7 * 60 + 30 || t > 15 * 60 + 30) return 0;
  const last = await getSession('premarket');
  if (last && now - last.at < 60_000) return last.rows.length;
  const [scan, quotes, store] = await Promise.all([scanUniverse(), getQuotes(), getLocal('catalysts')]);
  const m = marketState(now, await getCalendar());
  const opened = t >= 9 * 60 + 15 && m.phase === 'open';
  const since = lastCloseBefore(now);
  const rows: PremarketRow[] = [];
  for (const k of scan.keys) {
    const q = quotes[k];
    const fresh = q && istDate(q.fetchedAt) === istDate(now);
    let gapPct: number | null = null;
    let gapKind: PremarketRow['gapKind'] = null;
    if (fresh && q.prevClose) {
      if (opened && q.open) {
        gapPct = (q.open / q.prevClose - 1) * 100;
        gapKind = 'open';
      } else if (!opened && t >= 9 * 60 && q.pre && istDate(q.pre.at) === istDate(now)) {
        // app v1.16: Upstox's indicative pre-open price (IEP)
        gapPct = (q.pre.iep / q.prevClose - 1) * 100;
        gapKind = 'pre-open';
      } else if (!opened && t >= 9 * 60 && q.ltp !== q.prevClose) {
        gapPct = (q.ltp / q.prevClose - 1) * 100;
        gapKind = 'pre-open';
      }
    }
    const c = store && store.since === since ? (store.byKey[k] ?? null) : null;
    const goodNews = c?.tone === 'good';
    const gapUp = gapPct !== null && gapPct >= 1;
    if (!goodNews && !gapUp) continue;
    rows.push({ key: k, symbol: (await getInstrument(k))?.trading_symbol ?? k, ...(scan.tag[k] ? { index: scan.tag[k] } : {}), catalyst: c, gapPct, gapKind, price: fresh ? q.ltp : null });
  }
  rows.sort((a, b) => (b.catalyst?.tone === 'good' ? 1 : 0) - (a.catalyst?.tone === 'good' ? 1 : 0) || (b.gapPct ?? 0) - (a.gapPct ?? 0));
  await setSession('premarket', { at: now, opened, rows: rows.slice(0, 30), newsAt: store?.at ?? null, newsAsked: store?.asked ?? 0, newsError: store?.error ?? null });
  return rows.length;
}

// ---------------------------------------------------------------- the past test

let testing: Promise<unknown> | null = null;

/** Once a day (or on request): the rules on the stored 5-minute history of the scanned stocks. */
export function testEarly(now = Date.now(), force = false): Promise<unknown> {
  testing ??= (async () => {
    const settings = await getSettings();
    const capital = settings.dayTrade.earlyCapitalInr ?? 10_000;
    const maxRisk = settings.dayTrade.earlyRiskInr ?? 50;
    const prev = await getLocal('earlyTest');
    if (!force && prev && prev.capital === capital && prev.maxRisk === maxRisk && now - prev.at < 20 * 3600_000) return prev;
    const today = istDate(now);
    const days: TestDay[] = [];
    for (const k of (await scanUniverse()).keys) {
      const list = (await getIntradayDays(k).catch(() => [])).filter((d) => d.date < today && d.t.length >= 10).sort((a, b) => (a.date < b.date ? -1 : 1));
      for (let j = 3; j < list.length; j++) {
        const d = list[j]!;
        const before = list[j - 1]!;
        days.push({
          key: k,
          date: d.date,
          bars: d,
          prevClose: before.c[before.c.length - 1] ?? null,
          prevHigh: before.h.length ? Math.max(...before.h) : null,
          prev: list.slice(Math.max(0, j - 10), j).map(prevDayOf).filter((x): x is PrevDay => !!x),
        });
      }
    }
    const r = runEarlyTest(days, capital, maxRisk);
    // app v1.16: the opening-drive rule on the same days (the pre-open auction itself has no stored history)
    const open = runOpenTest(days, capital, maxRisk);
    await setLocal('earlyTest', r ? { ...r, at: now, open } : null);
    if (r) log.info(`Early Movers past test: ${r.days} days, live ${r.live.trades} trades ₹${Math.round(r.live.pnl)}, late ${r.late.trades} ₹${Math.round(r.late.pnl)}, baseline ${r.baseline.trades} ₹${Math.round(r.baseline.pnl)}`);
    return r;
  })().finally(() => {
    testing = null;
  });
  return testing;
}

/** The slow jobs, at most once a minute from anywhere (each decides itself whether it is due). */
let lastTick = 0;
export function earlyTick(now = Date.now()): void {
  if (now - lastTick < 60_000) return;
  lastTick = now;
  void refreshPremarket(now).catch((err: unknown) => log.debug('Pre-market view not updated', { error: errorMessage(err) }));
  void sweepCatalysts(now).catch((err: unknown) => log.debug('Catalyst sweep failed', { error: errorMessage(err) }));
  void refreshNseFiles(now).catch((err: unknown) => log.debug('NSE files not loaded', { error: errorMessage(err) }));
  const t = minutesIST(now);
  if (t < 9 * 60 || t > 15 * 60 + 35) void testEarly(now).catch((err: unknown) => log.debug('Early past test failed', { error: errorMessage(err) }));
}
