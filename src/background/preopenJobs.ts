import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { fetchTodayBars, pool } from '../data/intraday';
import { getInstrument } from '../data/instruments';
import { getQuotes } from '../data/quotes';
import { mergeFullQuotes } from '../data/quotesParse';
import type { PreOpenStatus } from '../data/feedProto';
import { minutesIST } from '../daytrade/live';
import type { Catalyst } from '../early/catalyst';
import { openOutcome, PRE, prePhase, preEstimate, readPreopen, sectorGaps, volumeHistory, type OpenOutcome, type PrePart, type PrePhase, type PreRead, type PreSnap } from '../early/preopen';
import { chunk } from '../lib/chunk';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';
import { catalystLookup } from './earlyJobs';
import { feedPreOpen } from './feed';
import { prevDays } from './mlJobs';
import { scanUniverse } from './scanList';

/**
 * App v1.16 — the pre-open rising candidates, live from 9:00 to 9:15 (rules in early/preopen.ts).
 *
 *   8:45  the earlier days' volume for every scanned stock is read from the stored 5-minute history;
 *   9:00  every ~15 s Upstox's Full Market Quotes V3 (500 stocks per request) gives each stock's
 *         indicative pre-open price, matched quantity, unmatched quantity and waiting buy / sell
 *         quantities; the live feed adds the same numbers in between, when it is connected;
 *   9:05  the first ranking; 9:08 re-checked when order entry closes; recalculated while the opening
 *         price is worked out; 9:13 the final top 10 is fixed (one alert) and kept for the open.
 *   9:46  how each of the final 10 did in its first 30 minutes is written to a daily record — the only
 *         honest test of the pre-open ranking, since no past pre-open data is stored anywhere in the app.
 * Read-only towards the broker; only genuine Upstox data; anything missing is shown as missing.
 */

const log = createLogger('preopen');

export interface PreRow {
  key: string;
  symbol: string;
  name: string;
  index?: string;
  industry?: string;
  rank: number;
  prevClose: number;
  iep: number;
  gapPct: number;
  ieq: number | null;
  /** unmatched quantity (Upstox's figure, as given) */
  imb: number | null;
  imbM: number | null;
  rp: number | null;
  buyQty: number | null;
  sellQty: number | null;
  buyShare: number | null;
  ieqTrend: PreRead['ieqTrend'];
  iepRangePct: number | null;
  score: number;
  parts: PrePart[];
  warnings: string[];
  catalyst: Catalyst | null;
  prevVolRatio: number | null;
  sectorGap: number | null;
  /** a first estimate (the real plan is made from live prices after 9:15) */
  estimate: { entry: number; stop: number; qty: number; risk: number; ok: boolean; why?: string };
  readings: number;
  src: 'feed' | 'quote';
  /** the last pre-open prices (for a small line) */
  path: number[];
}

export interface PreopenState {
  date: string;
  at: number;
  phase: PrePhase;
  rows: PreRow[];
  final: { at: number; rows: PreRow[] } | null;
  counts: { scanned: number; withIep: number; listed: number; badNews: number; sellers?: number; falling?: number };
  /** average pre-open gap of every scanned stock with a price (20+), % */
  marketGap: number | null;
  quoteAt: number | null;
  quoteError: string | null;
  /** stocks whose pre-open price came from the live feed in the last reading */
  fromFeed: number;
  /** Upstox's own pre-open session status (live feed), e.g. NSE_EQ */
  status: PreOpenStatus | null;
  capital: number;
  maxRisk: number;
}

export interface PreopenDay {
  date: string;
  at: number;
  rows: Array<{ key: string; symbol: string; rank: number; score: number; gapPct: number; out: OpenOutcome | null }>;
  /** outcomes filled in */
  done: boolean;
}

interface Mem {
  date: string;
  snaps: Map<string, PreSnap[]>;
  vol: Map<string, { prevVolRatio: number | null; avgDailyVol: number | null }>;
  volLoaded: 'no' | 'loading' | 'yes';
  lastAt: number;
  quoteAt: number;
  quoteError: string | null;
  recordTryAt: number;
}

let mem: Mem = fresh('');
let running = false;

function fresh(date: string): Mem {
  return { date, snaps: new Map(), vol: new Map(), volLoaded: 'no', lastAt: 0, quoteAt: 0, quoteError: null, recordTryAt: 0 };
}

/** For tests. */
export function resetPreopen(): void {
  mem = fresh('');
  running = false;
}

const QUOTE_EVERY_MS = 15_000;
const TICK_MS = 10_000;

/** Earlier days' volume for every scanned stock (from the stored 5-minute history), in the background. */
function loadVolumes(keys: string[], date: string): void {
  if (mem.volLoaded !== 'no') return;
  mem.volLoaded = 'loading';
  const m = mem;
  void pool(keys, 6, async (k) => {
    if (m.date !== date) return;
    const p = await prevDays(k, date).catch(() => []);
    m.vol.set(k, volumeHistory(p));
  }).finally(() => {
    // stocks whose history is still downloading are looked for again next minute
    m.volLoaded = [...m.vol.values()].some((v) => v.avgDailyVol !== null) ? 'yes' : 'no';
  });
}

/** One round of Full Market Quotes V3 for every scanned stock (500 per request). */
async function readQuotes(keys: string[], now: number): Promise<number> {
  let withIep = 0;
  let quotes = await getQuotes();
  for (const part of chunk(keys, 500)) {
    const data = await upstoxRequest<unknown>('/v3/market-quote/quotes', { tokenKind: 'market', query: { instrument_key: part.join(',') }, attempts: 1 });
    const r = mergeFullQuotes(quotes, data, now);
    quotes = r.quotes;
    withIep += r.withIep;
  }
  await setSession('quotes', quotes);
  return withIep;
}

/**
 * Every 10 seconds (from a timer and from live prices): from 8:45 the volume history, 9:00–9:15 the
 * pre-open readings and ranking, after 9:45 the day's record. Returns the number of listed stocks.
 */
export async function preopenTick(now = Date.now(), force = false): Promise<number> {
  const t = minutesIST(now);
  if (t < 8 * 60 + 45 || t > 15 * 60 + 35) return 0;
  if (running || (!force && now - mem.lastAt < TICK_MS)) return 0;
  running = true;
  try {
    const date = istDate(now);
    if (mem.date !== date) mem = fresh(date);
    const m = marketState(now, await getCalendar());
    if (!m.session.trading) return 0;
    mem.lastAt = now;
    const phase = prePhase(t);
    if (phase === 'open') {
      if (t >= 9 * 60 + 46) await recordOutcomes(now).catch((err: unknown) => log.debug('Pre-open record not updated', { error: errorMessage(err) }));
      return 0;
    }
    const scan = await scanUniverse();
    loadVolumes(scan.keys, date);
    if (phase === 'before') return 0;
    // the quotes API every ~15 s (the live feed fills in between when it is connected)
    if (force || now - mem.quoteAt >= QUOTE_EVERY_MS) {
      mem.quoteAt = now;
      try {
        await readQuotes(scan.keys, now);
        mem.quoteError = null;
      } catch (err) {
        mem.quoteError = errorMessage(err);
        log.info('Pre-open quotes not read', { reason: mem.quoteError });
      }
    }
    return await rank(now, phase, scan);
  } finally {
    running = false;
  }
}

async function rank(now: number, phase: PrePhase, scan: Awaited<ReturnType<typeof scanUniverse>>): Promise<number> {
  const date = mem.date;
  const [quotes, settings, catalystOf, prev] = await Promise.all([getQuotes(), getSettings(), catalystLookup(now), getSession('preopen')]);
  const capital = settings.dayTrade.earlyCapitalInr ?? 10_000;
  const maxRisk = settings.dayTrade.earlyRiskInr ?? 50;
  // 1. new readings
  let fromFeed = 0;
  for (const k of scan.keys) {
    const q = quotes[k];
    const pre = q?.pre;
    if (!pre || istDate(pre.at) !== date || !(pre.iep > 0)) continue;
    if (now - pre.at < 60_000 && pre.src === 'feed') fromFeed++;
    const list = mem.snaps.get(k) ?? [];
    const last = list[list.length - 1];
    if (last && pre.at - last.at < 5_000) continue;
    list.push({ at: pre.at, iep: pre.iep, ieq: pre.ieq, buy: q.buyQty ?? null, sell: q.sellQty ?? null });
    if (list.length > 200) list.splice(0, list.length - 200);
    mem.snaps.set(k, list);
  }
  // 2. sector and market gaps from everyone with a pre-open price
  const gaps: Array<{ key: string; sector: string | undefined; gapPct: number }> = [];
  for (const [k, list] of mem.snaps) {
    const pc = quotes[k]?.prevClose;
    const last = list[list.length - 1];
    if (pc && pc > 0 && last) gaps.push({ key: k, sector: scan.industry[k], gapPct: (last.iep / pc - 1) * 100 });
  }
  const bySector = sectorGaps(gaps);
  const marketGap = gaps.length >= 20 ? gaps.reduce((s, g) => s + g.gapPct, 0) / gaps.length : null;
  // 3. each stock's points
  const read: Array<{ k: string; r: PreRead; c: Catalyst | null }> = [];
  let badNews = 0;
  let sellers = 0;
  let falling = 0;
  for (const g of gaps) {
    const c = catalystOf(g.key);
    const v = mem.vol.get(g.key) ?? { prevVolRatio: null, avgDailyVol: null };
    const r = readPreopen({ prevClose: quotes[g.key]!.prevClose!, snaps: mem.snaps.get(g.key)!, catalyst: c ? { tone: c.tone, kind: c.kind } : null, prevVolRatio: v.prevVolRatio, avgDailyVol: v.avgDailyVol, sectorGap: bySector.get(g.key) ?? null, now });
    if (!r) continue;
    if (!r.listed) {
      if (r.out === 'news' && r.gapPct >= PRE.minGapPct) badNews++;
      if (r.out === 'sellers') sellers++;
      if (r.out === 'falling') falling++;
      continue;
    }
    read.push({ k: g.key, r, c });
  }
  read.sort((a, b) => b.r.score - a.r.score || b.r.gapPct - a.r.gapPct);
  const rows: PreRow[] = [];
  for (const [i, { k, r, c }] of read.slice(0, 20).entries()) {
    const q = quotes[k]!;
    const inst = await getInstrument(k);
    const v = mem.vol.get(k);
    const est = preEstimate(r.iep, capital, maxRisk, inst?.tick ?? 0.05);
    const list = mem.snaps.get(k)!;
    rows.push({
      key: k,
      symbol: inst?.trading_symbol ?? k,
      name: inst?.name ?? inst?.trading_symbol ?? k,
      ...(scan.tag[k] ? { index: scan.tag[k] } : {}),
      ...(scan.industry[k] ? { industry: scan.industry[k] } : {}),
      rank: i + 1,
      prevClose: q.prevClose!,
      iep: r.iep,
      gapPct: r.gapPct,
      ieq: r.ieq,
      imb: q.pre?.imb ?? null,
      imbM: q.pre?.imbM ?? null,
      rp: q.pre?.rp ?? null,
      buyQty: q.buyQty ?? null,
      sellQty: q.sellQty ?? null,
      buyShare: r.buyShare,
      ieqTrend: r.ieqTrend,
      iepRangePct: r.iepRangePct,
      score: r.score,
      parts: r.parts,
      warnings: r.warnings,
      catalyst: c,
      prevVolRatio: v?.prevVolRatio ?? null,
      sectorGap: bySector.get(k) ?? null,
      estimate: { entry: est.entry, stop: est.stop, qty: est.size.qty, risk: est.size.risk, ok: est.size.ok, ...(est.size.why ? { why: est.size.why } : {}) },
      readings: list.length,
      src: q.pre?.src ?? 'quote',
      path: list.slice(-24).map((s) => s.iep),
    });
  }
  // 4. the final top 10 is fixed at 9:13 (kept as it was even if the app is reopened later)
  let final = prev && prev.date === date ? prev.final : null;
  if (!final && phase === 'final' && rows.length) {
    final = { at: now, rows: rows.slice(0, PRE.top) };
    await saveFinal(date, final, now);
    if (settings.notifications.early !== false) {
      await notify(`alert:preopen-final-${date}`, {
        title: `🌅 Pre-open top ${final.rows.length} ready for 9:15`,
        message: `${final.rows
          .slice(0, 5)
          .map((r) => `${r.rank}. ${r.symbol} ${r.gapPct >= 0 ? '+' : '−'}${Math.abs(r.gapPct).toFixed(1)}% (score ${r.score})`)
          .join(' · ')}. A watch list, not buy signals: do not buy at 9:15 — buy only a stock that turns ⚡ (holding above its opening price with heavy buying), with its stop-loss. Not a guarantee — you place every order yourself.`,
        priority: 2,
      }).catch(() => undefined);
    }
    log.info(`Pre-open final top ${final.rows.length}: ${final.rows.map((r) => `${r.symbol} ${r.gapPct.toFixed(1)}% (${r.score})`).join(', ')}`);
  }
  const state: PreopenState = {
    date,
    at: now,
    phase,
    rows: rows.slice(0, PRE.top),
    final,
    counts: { scanned: scan.keys.length, withIep: gaps.length, listed: read.length, badNews, sellers, falling },
    marketGap,
    quoteAt: mem.quoteAt || null,
    quoteError: mem.quoteError,
    fromFeed,
    status: feedPreOpen('NSE_EQ'),
    capital,
    maxRisk,
  };
  await setSession('preopen', state);
  return read.length;
}

async function saveFinal(date: string, final: { at: number; rows: PreRow[] }, now: number): Promise<void> {
  const rec = (await getLocal('preopenRecord')) ?? [];
  if (rec.some((d) => d.date === date)) return;
  const day: PreopenDay = { date, at: now, done: false, rows: final.rows.map((r) => ({ key: r.key, symbol: r.symbol, rank: r.rank, score: r.score, gapPct: Math.round(r.gapPct * 100) / 100, out: null })) };
  await setLocal('preopenRecord', [...rec, day].slice(-60));
}

/** After 9:45: how each of today's final 10 did in its first 30 minutes (Upstox's 5-minute candles). */
async function recordOutcomes(now: number): Promise<void> {
  const date = istDate(now);
  if (now < mem.recordTryAt) return;
  const rec = (await getLocal('preopenRecord')) ?? [];
  const day = rec.find((d) => d.date === date);
  if (!day || day.done) return;
  mem.recordTryAt = now + 5 * 60_000;
  let filled = 0;
  for (const r of day.rows) {
    if (r.out) {
      filled++;
      continue;
    }
    try {
      const b = await fetchTodayBars(r.key, now);
      const out = b ? openOutcome(b) : null;
      if (out) {
        r.out = { upPct: round2(out.upPct), downPct: round2(out.downPct), at945Pct: round2(out.at945Pct), upFirst: out.upFirst };
        filled++;
      }
    } catch {
      /* tried again in 5 minutes */
    }
  }
  day.done = filled === day.rows.length || minutesIST(now) >= 15 * 60 + 30;
  await setLocal('preopenRecord', rec.map((d) => (d.date === date ? day : d)));
  if (day.done) log.info(`Pre-open record ${date}: ${day.rows.filter((r) => r.out?.upFirst).length} of ${day.rows.length} rose 1% above the open before falling 1% below`);
}

const round2 = (x: number) => Math.round(x * 100) / 100;
