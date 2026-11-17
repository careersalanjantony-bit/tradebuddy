import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { fetchTodayBars, getIntradayDays, pool } from '../data/intraday';
import { getInstrument } from '../data/instruments';
import { getQuotes } from '../data/quotes';
import type { Quote } from '../data/quotesParse';
import { completedBars, minutesIST } from '../daytrade/live';
import type { Bars } from '../daytrade/types';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { prevDayOf, type PrevDay } from '../ml/features';
import { notify } from '../notify/chrome';
import { holdAdvice, quickPlan, readRise, riseFeatures, RISE_FIRST_T, RISE_LAST_T, RISE_VERSION, running, samplesOfDay, usualFrom, isRisingMoment, type RiseModel, type RiseRead, type RiseSample, type RiseTag } from '../rising/momentum';
import { trainRiseAsync } from '../rising/trainRun';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { claimAlert } from './ideaGate';
import { prevDays } from './mlJobs';
import { scanUniverse } from './scanList';

/**
 * App v1.14 — "Rising now", live. On every live price (at most every 1.5 seconds) each stock of the
 * scan list gets its current 5-minute candle updated from the Upstox live feed, and the learned model
 * (rising/momentum.ts) reads it: "likely to keep rising", "unclear" or "slowing". Rising stocks are
 * listed best first, the moment they qualify — not after a 15-second full-quote round. Stocks you hold
 * (practice, "I bought this", real day trades, the auto-trader) get the same reading with keep / protect
 * / take-the-profit advice. Read-only towards the broker; genuine live prices only.
 */

const log = createLogger('rising');

export interface RiseRow {
  key: string;
  symbol: string;
  index?: string;
  price: number;
  fromOpenPct: number;
  changePct: number;
  tag: RiseTag;
  chance: number | null;
  measured: number | null;
  reasons: string[];
  /** not up much yet (< 1 % since the open) */
  early: boolean;
  /** when (and at what price) it was first "likely to keep rising" today */
  since: number | null;
  sincePrice: number | null;
  plan: { entry: number; target: number; stop: number; sellBy: number };
}

export interface HeldRow {
  key: string;
  symbol: string;
  source: 'practice' | 'real' | 'auto';
  qty: number;
  buyPrice: number;
  price: number;
  tag: RiseTag;
  chance: number | null;
  measured: number | null;
  action: 'keep' | 'protect' | 'sell';
  protectAt: number | null;
  text: string;
  reasons: string[];
}

interface Cur {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v0: number | null;
  vNow: number | null;
  seen: number;
  last: number;
  exact: boolean;
}

interface Track {
  bars: Bars;
  cur: Cur | null;
  load: 'no' | 'loading' | 'yes';
  retryAt: number;
  prev: PrevDay[] | null;
  since: number | null;
  sincePrice: number | null;
}

const empty = (): Bars => ({ t: [], o: [], h: [], l: [], c: [], v: [] });
let state: { date: string; tracks: Map<string, Track> } = { date: '', tracks: new Map() };
let model: { at: number; m: RiseModel | null } | null = null;
let scanning = false;
let lastScanAt = 0;
let loading = false;

/** For tests: waits until today's candles have loaded. */
export async function risingIdle(): Promise<void> {
  for (let i = 0; i < 200 && loading; i++) await new Promise((r) => setTimeout(r, 5));
}

/** For tests. */
export function resetRising(): void {
  state = { date: '', tracks: new Map() };
  model = null;
  scanning = false;
  lastScanAt = 0;
  loading = false;
}

async function getModel(): Promise<RiseModel | null> {
  const stored = await getLocal('riseModel');
  if (!model || model.at !== (stored?.report.at ?? 0)) model = { at: stored?.report.at ?? 0, m: stored && stored.version === RISE_VERSION ? stored : null };
  return model.m;
}

const slotStart = (now: number, slot: number) => {
  const d = new Date(now + 5.5 * 3600_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - 5.5 * 3600_000 + slot * 60_000;
};

function pushBar(b: Bars, t: number, o: number, h: number, l: number, c: number, v: number): void {
  if (b.t.length && b.t[b.t.length - 1]! >= t) return;
  b.t.push(t);
  b.o.push(o);
  b.h.push(h);
  b.l.push(l);
  b.c.push(c);
  b.v.push(v);
}

/** Volume of a candle the app followed: exact from its start, else scaled from the part it saw. */
function curVolume(c: Cur, now: number, finished: boolean): number {
  const seenVol = c.vNow !== null && c.v0 !== null ? Math.max(0, c.vNow - c.v0) : 0;
  const start = slotStart(now, c.t);
  const seenFrom = c.exact ? start : c.seen;
  const until = finished ? start + 300_000 : now;
  // a candle in progress is compared with full candles: scale it up to 5 minutes (at least 1 minute seen)
  const span = Math.max(60_000, until - seenFrom);
  return Math.round(seenVol * Math.min(5, 300_000 / span));
}

/** Updates the stock's current 5-minute candle from a live price. */
function follow(tr: Track, q: Quote, now: number): void {
  const slot = Math.floor(minutesIST(now) / 5) * 5;
  if (tr.cur && slot > tr.cur.t) {
    if (slot - tr.cur.t > 5 && tr.load === 'yes') tr.load = 'no'; // whole candles missed (phone asleep): reload them
    pushBar(tr.bars, tr.cur.t, tr.cur.o, tr.cur.h, tr.cur.l, tr.cur.c, curVolume(tr.cur, now, true));
    tr.cur = null;
  }
  if (!tr.cur) {
    tr.cur = { t: slot, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, v0: q.volume, vNow: q.volume, seen: now, last: now, exact: now - slotStart(now, slot) <= 20_000 };
    return;
  }
  tr.cur.h = Math.max(tr.cur.h, q.ltp);
  tr.cur.l = Math.min(tr.cur.l, q.ltp);
  tr.cur.c = q.ltp;
  tr.cur.vNow = q.volume;
  tr.cur.last = now;
}

/** Today's finished candles from Upstox for stocks that do not have them yet (4 at a time, in the background). */
function loadMissing(keys: string[], now: number): void {
  if (loading) return;
  const todo = keys.filter((k) => {
    const tr = state.tracks.get(k);
    return tr && tr.load === 'no' && now >= tr.retryAt;
  });
  if (!todo.length) return;
  loading = true;
  const date = state.date;
  // the scan's clock (tests pass their own time): later loads move on with the real clock from there
  const realStart = Date.now();
  const clock = () => now + (Date.now() - realStart);
  for (const k of todo) state.tracks.get(k)!.load = 'loading';
  void pool(todo, 4, async (k) => {
    const tr = state.tracks.get(k);
    if (!tr || state.date !== date) return;
    try {
      const b = await fetchTodayBars(k, clock());
      const done = b ? completedBars(b, minutesIST(clock())) : empty();
      // Upstox's finished candles replace the ones followed live (exact volumes)
      tr.bars = { t: [...done.t], o: [...done.o], h: [...done.h], l: [...done.l], c: [...done.c], v: [...done.v] };
      tr.prev ??= await prevDays(k, date).catch(() => []);
      tr.load = 'yes';
    } catch (err) {
      tr.load = 'no';
      tr.retryAt = clock() + 60_000;
      log.debug(`Today's candles not loaded for ${k}`, { error: errorMessage(err) });
    }
  }).finally(() => {
    loading = false;
  });
}

/** The candles to read now: today's finished ones and the one in progress. */
function working(tr: Track, now: number): Bars {
  const b: Bars = { t: [...tr.bars.t], o: [...tr.bars.o], h: [...tr.bars.h], l: [...tr.bars.l], c: [...tr.bars.c], v: [...tr.bars.v] };
  if (tr.cur) pushBar(b, tr.cur.t, tr.cur.o, tr.cur.h, tr.cur.l, tr.cur.c, curVolume(tr.cur, now, false));
  return b;
}

function readNow(tr: Track, q: Quote, now: number, market: number | null, m: RiseModel | null): { read: RiseRead; x: number[] | null } {
  const b = working(tr, now);
  if (b.t.length < 3) return { read: readRise(null, m), x: null };
  const x = riseFeatures(b, b.t.length - 1, running(b), { prevClose: q.prevClose, usual: usualFrom(tr.prev ?? []), market: () => market });
  return { read: readRise(x, m), x };
}

interface Held {
  key: string;
  source: HeldRow['source'];
  qty: number;
  buyPrice: number;
}

async function heldStocks(): Promise<Held[]> {
  const [wallet, plans, dayTrades, bot] = await Promise.all([getLocal('wallet'), getLocal('plans'), getLocal('dayTrades'), getLocal('bot')]);
  const out: Held[] = [];
  for (const h of wallet?.holdings ?? []) out.push({ key: h.key, source: 'practice', qty: h.qty, buyPrice: h.avgPrice });
  for (const p of plans ?? []) if (p.status === 'open') out.push({ key: p.key, source: 'real', qty: p.qty, buyPrice: p.entry });
  for (const t of dayTrades ?? []) if (t.status === 'open' && !t.practice && t.side === 'long') out.push({ key: t.key, source: 'real', qty: t.qty, buyPrice: t.entry });
  for (const t of bot?.trades ?? []) if (t.status === 'open' && t.side === 'long') out.push({ key: t.key, source: 'auto', qty: t.left ?? t.qty, buyPrice: t.entry });
  return out;
}

const MAX_ALERTS = 10;

/** On every live price in market hours (at most every 1.5 seconds). Returns how many stocks are listed. */
export async function scanRising(now = Date.now()): Promise<number> {
  if (scanning || Math.abs(now - lastScanAt) < 1_500) return 0;
  scanning = true;
  lastScanAt = now;
  try {
    const m = marketState(now, await getCalendar());
    const t = minutesIST(now);
    if (m.phase !== 'open' || t < 9 * 60 + 15 || t >= 15 * 60 + 30) return 0;
    const date = istDate(now);
    if (state.date !== date) state = { date, tracks: new Map() };
    const [scan, quotes, held, mdl, settings] = await Promise.all([scanUniverse(), getQuotes(), heldStocks(), getModel(), getSettings()]);
    const keys = [...new Set([...scan.keys, ...held.map((h) => h.key)])];
    for (const k of keys) if (!state.tracks.has(k)) state.tracks.set(k, { bars: empty(), cur: null, load: 'no', retryAt: 0, prev: null, since: null, sincePrice: null });
    loadMissing(keys, now);
    // the whole market: average move since the open of every scanned stock with a live price
    let sum = 0;
    let cnt = 0;
    const fresh = (q: Quote | undefined): q is Quote => !!q && q.ltp > 0 && now - q.fetchedAt < 60_000;
    for (const k of scan.keys) {
      const q = quotes[k];
      if (fresh(q) && q.open && q.open > 0) {
        sum += (q.ltp / q.open - 1) * 100;
        cnt++;
      }
    }
    const market = cnt >= 20 ? sum / cnt : null;
    const rows: RiseRow[] = [];
    const reads = new Map<string, RiseRead>();
    let loaded = 0;
    for (const k of keys) {
      const tr = state.tracks.get(k)!;
      const q = quotes[k];
      if (tr.load === 'yes') loaded++;
      if (!fresh(q)) continue;
      follow(tr, q, now);
      if (tr.load !== 'yes') continue;
      const { read, x } = readNow(tr, q, now, market, mdl);
      reads.set(k, read);
      if (!x || !isRisingMoment(x) || !scan.tag[k]) continue;
      if (read.tag === 'strong' && tr.since === null) {
        tr.since = now;
        tr.sincePrice = q.ltp;
      }
      rows.push({
        key: k,
        symbol: (await getInstrument(k))?.trading_symbol ?? k,
        ...(scan.tag[k] ? { index: scan.tag[k] } : {}),
        price: q.ltp,
        fromOpenPct: q.open ? (q.ltp / q.open - 1) * 100 : 0,
        changePct: q.prevClose ? (q.ltp / q.prevClose - 1) * 100 : 0,
        tag: read.tag,
        chance: read.chance,
        measured: read.measured,
        reasons: read.reasons,
        early: q.open ? (q.ltp / q.open - 1) * 100 < 1 : false,
        since: tr.since,
        sincePrice: tr.sincePrice,
        plan: quickPlan(q.ltp, now),
      });
    }
    const rank = (r: RiseRow) => (r.tag === 'strong' ? 2 : r.tag === 'unclear' ? 1 : 0) * 10 + (r.chance ?? 0);
    rows.sort((a, b) => rank(b) - rank(a) || b.fromOpenPct - a.fromOpenPct);
    const top = rows.slice(0, 25);
    const heldRows: HeldRow[] = [];
    for (const h of held) {
      const q = quotes[h.key];
      const read = reads.get(h.key);
      if (!fresh(q) || !read) continue;
      const a = holdAdvice(read, q.ltp, h.buyPrice);
      heldRows.push({ key: h.key, symbol: (await getInstrument(h.key))?.trading_symbol ?? h.key, source: h.source, qty: h.qty, buyPrice: h.buyPrice, price: q.ltp, tag: read.tag, chance: read.chance, measured: read.measured, action: a.action, protectAt: a.protectAt, text: a.text, reasons: read.reasons });
    }
    await setSession('rise', { at: now, date, scanned: scan.keys.length, loaded, modelAt: mdl?.report.at ?? null, rows: top, held: heldRows });
    await alertRising(top, heldRows, now, t, settings.notifications.rising).catch((err: unknown) => log.warn('Rising alert failed', { error: errorMessage(err) }));
    return top.length;
  } finally {
    scanning = false;
  }
}

const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hhmm = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);

/**
 * Alerts: a stock that becomes "likely to keep rising" (each once a day, at most 10 a day, 9:25–2:45),
 * and a stock you hold that turns to "slowing — take the profit" (each at most every 15 minutes).
 */
async function alertRising(rows: RiseRow[], held: HeldRow[], now: number, t: number, on: boolean): Promise<void> {
  if (!on) return;
  const date = istDate(now);
  const prev = await getSession('riseAlerted');
  const sent = prev?.date === date ? prev : { date, keys: [] as string[], held: {} as Record<string, number> };
  let changed = false;
  if (t >= RISE_FIRST_T + 5 && t <= RISE_LAST_T) {
    for (const r of rows) {
      if (r.tag !== 'strong' || sent.keys.includes(r.key) || sent.keys.length >= MAX_ALERTS) continue;
      if (!(await claimAlert(r.key, 'buy', 'rising', now))) continue;
      sent.keys = [...sent.keys, r.key];
      changed = true;
      const p = r.plan;
      await notify(`alert:rise-${r.key}-${date}`, {
        title: `📈 ${r.symbol} likely to keep rising${r.measured !== null ? ` · rose further ${Math.round(r.measured * 100)} of 100 times` : ''}`,
        message: `₹${r.price.toFixed(2)} (${r.fromOpenPct >= 0 ? '+' : ''}${r.fromOpenPct.toFixed(1)}% since the open). Quick trade: buy around ${rs(p.entry)}, take profit ${rs(p.target)}, stop-loss ${rs(p.stop)}, sell by ${hhmm(p.sellBy)}. ${r.reasons.slice(0, 2).join(' · ')}.`,
        priority: 2,
      });
    }
  }
  for (const h of held) {
    if (h.action !== 'sell') continue;
    const last = sent.held[h.key] ?? 0;
    if (now - last < 15 * 60_000) continue;
    sent.held = { ...sent.held, [h.key]: now };
    changed = true;
    const pnl = (h.price - h.buyPrice) * h.qty;
    await notify(`alert:rise-held-${h.key}-${now}`, {
      title: `⚠ ${h.symbol}: ${h.text}`,
      message: `${h.source === 'practice' ? 'Practice' : h.source === 'auto' ? 'Auto-trader' : 'Your'} ${h.qty} shares bought at ${rs(h.buyPrice)}, now ${rs(h.price)} (${pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')}). ${h.reasons.slice(0, 2).join(' · ')}.`,
      priority: 2,
    });
  }
  if (changed) await setSession('riseAlerted', sent);
}

// ---------------------------------------------------------------- learning (once a day)

let training: Promise<RiseModel | null> | null = null;

/** Deterministic 0–1 from a string (which moments go into the learning sample). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100_000) / 100_000;
}

/**
 * Learns the model from the stored 5-minute history of every scanned stock (two passes, so the phone
 * never holds all of it at once): first the whole market's move at each time of each day, then each
 * stock's rising moments with their outcome. About 90,000 moments at most.
 */
export function trainRising(now = Date.now(), force = false): Promise<RiseModel | null> {
  training ??= (async () => {
    const prev = await getLocal('riseModel');
    if (!force && prev && prev.version === RISE_VERSION && now - prev.report.at < 20 * 3600_000) return prev;
    const keys = (await scanUniverse()).keys;
    const today = istDate(now);
    // pass 1: the whole market's average move since the open at each time of each day
    const mk = new Map<string, Map<number, [number, number]>>();
    let stockDays = 0;
    for (const k of keys) {
      for (const d of await getIntradayDays(k).catch(() => [])) {
        if (d.date >= today || d.t.length < 10) continue;
        stockDays++;
        const o0 = d.o[0]!;
        let byT = mk.get(d.date);
        if (!byT) mk.set(d.date, (byT = new Map()));
        for (let i = 0; i < d.t.length; i++) {
          const cell = byT.get(d.t[i]!) ?? [0, 0];
          cell[0] += (d.c[i]! / o0 - 1) * 100;
          cell[1]++;
          byT.set(d.t[i]!, cell);
        }
      }
    }
    if (stockDays < 50) return prev ?? null;
    const rate = Math.min(1, 90_000 / (stockDays * 12));
    // pass 2: each stock's rising moments
    const samples: RiseSample[] = [];
    for (const k of keys) {
      const days = (await getIntradayDays(k).catch(() => [])).filter((d) => d.date < today && d.t.length >= 10).sort((a, b) => (a.date < b.date ? -1 : 1));
      for (let j = 3; j < days.length; j++) {
        const d = days[j]!;
        const prevD = days.slice(Math.max(0, j - 10), j).map(prevDayOf).filter((x): x is PrevDay => !!x);
        const byT = mk.get(d.date);
        const last = days[j - 1]!;
        samples.push(
          ...samplesOfDay(
            d.date,
            d,
            {
              prevClose: last.c[last.c.length - 1] ?? null,
              usual: usualFrom(prevD),
              market: (t) => {
                const cell = byT?.get(t);
                return cell && cell[1] >= 20 ? cell[0] / cell[1] : null;
              },
            },
            (i) => rate >= 1 || hash01(`${k}|${d.date}|${i}`) < rate,
          ),
        );
      }
    }
    const m = await trainRiseAsync(samples, now);
    if (m) {
      await setLocal('riseModel', m);
      model = null;
      const r = m.report;
      log.info(`Rising model: ${r.samples} moments, ${r.trainDays}+${r.testDays} days; unseen days: all ${Math.round(r.base.win * 100)}%, likely ${r.strong ? Math.round(r.strong.win * 100) : '—'}%, old list ${Math.round(r.old.win * 100)}%`);
    } else log.info(`Rising model: not enough history yet (${samples.length} moments)`);
    return m ?? prev ?? null;
  })().finally(() => {
    training = null;
  });
  return training;
}

/** Once a day outside market hours (or at once when there is no model yet). */
export async function trainRisingIfDue(now = Date.now()): Promise<void> {
  const prev = await getLocal('riseModel');
  const t = minutesIST(now);
  const open = marketState(now, await getCalendar()).phase === 'open' && t >= 9 * 60 + 10 && t < 15 * 60 + 35;
  if (prev && prev.version === RISE_VERSION && (now - prev.report.at < 20 * 3600_000 || open)) return;
  await trainRising(now).catch((err: unknown) => log.warn('Rising model not learned', { error: errorMessage(err) }));
}
