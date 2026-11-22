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
import { catalystFor, catalystLookup, type NseFiles } from './earlyJobs';
import { lookAt, marketGate, marketInputs, scoreEarly, setupCheck, sizeTrade, stepEarly, type EarlyPlan, type EarlyState, type Size, type Stage, type SuggestionCheck } from '../early/early';
import { DRIVE, drivePlan, readDrive, scoreDrive, type DriveState } from '../early/preopen';
import type { Catalyst } from '../early/catalyst';
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
  /** app v1.15: its stage in Early Movers today */
  early: EarlyState | null;
  /** app v1.16: the opening drive (9:15–9:35) */
  drive?: { state: DriveState; since: number | null; outWhy?: string; alerted?: boolean };
  /** when the earlier days (usual volume) were last looked for, while none were stored */
  prevAt?: number;
}

/** App v1.15 — one row of "Early Movers — Before the Rally". */
export interface EarlyRow {
  key: string;
  symbol: string;
  name: string;
  index?: string;
  industry?: string;
  stage: Stage;
  since: number;
  breakAt: number | null;
  confirmedAt: number | null;
  price: number;
  changePct: number;
  gapPct: number | null;
  rvolDay: number | null;
  rvolBar: number | null;
  vwap: number;
  ema9: number;
  rsi: number | null;
  resistance: number;
  plan: EarlyPlan;
  size: Size;
  score: number;
  reasons: string[];
  warnings: string[];
  catalyst: Catalyst | null;
  deals: Array<{ kind: 'bulk' | 'block'; side: 'BUY' | 'SELL'; qty: number; client: string; date: string }>;
  delivery: { pct: number; date: string } | null;
  rise: RiseTag | null;
  buyShare: number | null;
}

/** App v1.16 — a stock holding its opening gap (9:15–9:35), or a final pre-open pick still waiting. */
export interface DriveRow {
  key: string;
  symbol: string;
  name: string;
  index?: string;
  industry?: string;
  state: 'holding' | 'waiting';
  /** when it first held its gap (null while waiting) */
  since: number | null;
  price: number;
  open: number;
  prevClose: number;
  gapPct: number;
  changePct: number;
  fromOpenPct: number;
  pace: number | null;
  vwap: number | null;
  buyShare: number | null;
  plan: EarlyPlan;
  size: Size;
  score: number;
  reasons: string[];
  warnings: string[];
  missing: string[];
  catalyst: Catalyst | null;
  /** its place and points on the final pre-open list (null = not on it) */
  preRank: number | null;
  preScore: number | null;
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
    for (const k of keys) if (!state.tracks.has(k)) state.tracks.set(k, { bars: empty(), cur: null, load: 'no', retryAt: 0, prev: null, since: null, sincePrice: null, early: null });
    loadMissing(keys, now);
    const fresh = (q: Quote | undefined): q is Quote => !!q && q.ltp > 0 && now - q.fetchedAt < 60_000;
    // the whole market: average move since the open of every scanned stock with a live price, and NIFTY
    // (app v1.23: the same helper the auto-trader uses)
    const marketIn = marketInputs(quotes, scan.keys, now);
    const market = marketIn.listFromOpenPct;
    // app v1.16.2: no buy suggestions against a falling market
    const gate = marketGate(marketIn);
    // app v1.15: each sector's average move since the open (3+ stocks with a live price)
    const secSum = new Map<string, [number, number]>();
    for (const k of scan.keys) {
      const q = quotes[k];
      const ind = scan.industry[k];
      if (!ind || !fresh(q) || !q.open) continue;
      const cell = secSum.get(ind) ?? [0, 0];
      cell[0] += (q.ltp / q.open - 1) * 100;
      cell[1]++;
      secSum.set(ind, cell);
    }
    const sectorPct = (ind: string | undefined) => {
      const c = ind ? secSum.get(ind) : undefined;
      return c && c[1] >= 3 ? c[0] / c[1] : null;
    };
    const nse = await getLocal('nseFiles');
    const capital = settings.dayTrade.earlyCapitalInr ?? 10_000;
    const maxRisk = settings.dayTrade.earlyRiskInr ?? 50;
    const earlyRows: EarlyRow[] = [];
    const earlyEvents: Array<{ row: EarlyRow; event: 'setup' | 'breakout' | 'confirmed' }> = [];
    let expired = 0;
    let tooRisky = 0;
    let badNews = 0;
    // app v1.16: the final pre-open list (or the latest ranking when the final was not made) for the opening drive
    const pre = await getSession('preopen');
    const preList = pre && pre.date === date ? (pre.final?.rows ?? pre.rows) : [];
    const preopen = new Map(preList.map((r) => [r.key, { rank: r.rank, score: r.score }]));
    const catOf = t < DRIVE.untilT ? await catalystLookup(now) : () => null;
    const driveRows: DriveRow[] = [];
    const driveEvents: DriveRow[] = [];
    let driveOut = 0;
    const rows: RiseRow[] = [];
    const reads = new Map<string, RiseRead>();
    const newChecks: SuggestionCheck[] = [];
    let loaded = 0;
    for (const k of keys) {
      const tr = state.tracks.get(k)!;
      const q = quotes[k];
      if (tr.load === 'yes') loaded++;
      if (!fresh(q)) continue;
      follow(tr, q, now);
      // the 5-minute history may arrive after the open: look for the earlier days again every minute
      if (!tr.prev?.length && now - (tr.prevAt ?? 0) > 60_000) {
        tr.prevAt = now;
        void prevDays(k, date)
          .then((p) => {
            if (p.length) tr.prev = p;
          })
          .catch(() => undefined);
      }
      // app v1.16: the opening drive — from 9:15, no waiting for the first 5-minute candle
      if (scan.tag[k] && t < DRIVE.untilT) {
        const dr = await driveStep(k, tr, q, now, preopen.get(k) ?? null, { sectorPct: sectorPct(scan.industry[k]), market, capital, maxRisk, index: scan.tag[k], industry: scan.industry[k], openAt: m.session.openAt ?? now, catOf });
        if (dr.out) driveOut++;
        if (dr.tooRisky) tooRisky++;
        if (dr.row) driveRows.push(dr.row);
        if (dr.row && dr.event) driveEvents.push(dr.row);
      }
      if (tr.load !== 'yes') continue;
      const { read, x } = readNow(tr, q, now, market, mdl);
      reads.set(k, read);
      // app v1.15: Early Movers — the same candles, read for a setup / live breakout / confirmed breakout
      if (scan.tag[k]) {
        const er = await earlyStep(k, tr, q, now, read.tag, { sectorPct: sectorPct(scan.industry[k]), market, nse, capital, maxRisk, index: scan.tag[k], industry: scan.industry[k] });
        if (er.expired) expired++;
        if (er.tooRisky) tooRisky++;
        if (er.badNews) badNews++;
        if (er.row) earlyRows.push(er.row);
        if (er.row && er.event) earlyEvents.push({ row: er.row, event: er.event });
      }
      if (!x || !isRisingMoment(x) || !scan.tag[k]) continue;
      // the list shows no buy against a falling market (the reading of stocks you hold is not changed)
      const shown: RiseRead = read.tag === 'strong' && gate.weak ? { ...read, tag: 'unclear', reasons: [`market falling (${gate.text}) — no buy`, ...read.reasons] } : read;
      if (shown.tag === 'strong' && tr.since === null) {
        tr.since = now;
        tr.sincePrice = q.ltp;
        newChecks.push({ key: k, symbol: (await getInstrument(k))?.trading_symbol ?? k, at: now, price: q.ltp, p15: null, p30: null });
      }
      rows.push({
        key: k,
        symbol: (await getInstrument(k))?.trading_symbol ?? k,
        ...(scan.tag[k] ? { index: scan.tag[k] } : {}),
        price: q.ltp,
        fromOpenPct: q.open ? (q.ltp / q.open - 1) * 100 : 0,
        changePct: q.prevClose ? (q.ltp / q.prevClose - 1) * 100 : 0,
        tag: shown.tag,
        chance: shown.chance,
        measured: shown.measured,
        reasons: shown.reasons,
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
    await setSession('rise', { at: now, date, scanned: scan.keys.length, loaded, modelAt: mdl?.report.at ?? null, rows: top, held: heldRows, weak: gate });
    await updateRecord(date, newChecks, quotes, now).catch((err: unknown) => log.debug('Suggestion record not updated', { error: errorMessage(err) }));
    const stageRank: Record<Stage, number> = { confirmed: 3, breakout: 2, setup: 1 };
    earlyRows.sort((a, b) => stageRank[b.stage] - stageRank[a.stage] || b.score - a.score);
    driveRows.sort((a, b) => (b.state === 'holding' ? 1 : 0) - (a.state === 'holding' ? 1 : 0) || b.score - a.score);
    await setSession('early', { at: now, date, rows: earlyRows.slice(0, 30), drive: driveRows.slice(0, 15), driveOut, expired, tooRisky, badNews, capital, maxRisk });
    // no buy alerts against a falling market (app v1.16.2)
    await alertEarly(earlyEvents, now, settings.notifications.early !== false && !gate.weak).catch((err: unknown) => log.warn('Early Movers alert failed', { error: errorMessage(err) }));
    await alertDrive(driveEvents, now, settings.notifications.early !== false && !gate.weak).catch((err: unknown) => log.warn('Opening-drive alert failed', { error: errorMessage(err) }));
    await alertRising(top, heldRows, now, t, settings.notifications.rising).catch((err: unknown) => log.warn('Rising alert failed', { error: errorMessage(err) }));
    return top.length;
  } finally {
    scanning = false;
  }
}

/**
 * App v1.16.2 — the app's own record: each stock the moment it first became "likely to keep rising"
 * and its price 15 and 30 minutes later (kept 20 market days). Genuine live prices only.
 */
async function updateRecord(date: string, add: SuggestionCheck[], quotes: Record<string, Quote>, now: number): Promise<void> {
  const rec = (await getLocal('riseRecord')) ?? [];
  let day = rec.find((d) => d.date === date);
  let changed = false;
  if (!day && add.length) {
    day = { date, items: [] };
    rec.push(day);
  }
  if (!day) return;
  for (const c of add) if (!day.items.some((i) => i.key === c.key)) (day.items.push(c), (changed = true));
  for (const i of day.items) {
    const q = quotes[i.key];
    if (!q || !(q.ltp > 0) || now - q.fetchedAt > 60_000) continue;
    if (i.p15 === null && now >= i.at + 15 * 60_000) (i.p15 = q.ltp), (changed = true);
    if (i.p30 === null && now >= i.at + 30 * 60_000) (i.p30 = q.ltp), (changed = true);
  }
  if (changed) await setLocal('riseRecord', rec.slice(-20));
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
        detail: { symbol: r.symbol, key: r.key, side: 'buy', source: 'Rising now', entry: p.entry, stop: p.stop, targets: [p.target], qty: null, risk: null, score: r.measured !== null ? Math.round(r.measured * 100) : null, scoreKind: 'chance', reasons: r.reasons, closeBy: hhmm(p.sellBy) },
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

// ---------------------------------------------------------------- Early Movers (app v1.15)

interface EarlyCtx {
  sectorPct: number | null;
  market: number | null;
  nse: NseFiles | null | undefined;
  capital: number;
  maxRisk: number;
  index?: string;
  industry?: string;
}

/** One stock's step in Early Movers on a live price; the row when it is listed now. */
async function earlyStep(
  k: string,
  tr: Track,
  q: Quote,
  now: number,
  rise: RiseTag,
  ctx: EarlyCtx,
): Promise<{ row: EarlyRow | null; event: 'setup' | 'breakout' | 'confirmed' | null; expired: boolean; tooRisky: boolean; badNews: boolean }> {
  const none = { row: null, event: null, expired: false, tooRisky: false, badNews: false };
  const b = working(tr, now);
  if (b.t.length < 2) return none;
  const run = running(b);
  const usual = usualFrom(tr.prev ?? []);
  const i = b.t.length - 1;
  // the candle in progress already carries its volume scaled to a full 5 minutes (see curVolume)
  const prevHigh = tr.prev?.length ? tr.prev[tr.prev.length - 1]!.high : null;
  const look = lookAt({ b, run, i, price: q.ltp, prevClose: q.prevClose, prevHigh, usual });
  if (!look) return none;
  const inst = await getInstrument(k);
  const tick = inst?.tick ?? 0.05;
  const n = tr.bars.t.length;
  const lastDone = n ? { t: tr.bars.t[n - 1]!, c: tr.bars.c[n - 1]!, v: tr.bars.v[n - 1]!, usualBar: usual(tr.bars.t[n - 1]!).bar } : null;
  const slot = Math.floor(minutesIST(now) / 5) * 5;
  const step = stepEarly(tr.early, look, now, slot, lastDone, tick);
  tr.early = step.state;
  const s = tr.early;
  if (!s || s.stage === 'expired') return { ...none, expired: s?.stage === 'expired' };
  const catalyst = await catalystFor(k, now);
  if (catalyst?.tone === 'bad') return { ...none, badNews: true };
  const symbol = inst?.trading_symbol ?? k;
  const deals = [...(ctx.nse?.bulk.deals ?? []), ...(ctx.nse?.block.deals ?? [])].filter((d) => d.symbol === symbol.toUpperCase()).map((d) => ({ kind: d.kind, side: d.side, qty: d.qty, client: d.client, date: d.date }));
  const dv = ctx.nse?.delivery.bySymbol[symbol.toUpperCase()];
  const buyShare = q.buyQty && q.sellQty && q.buyQty + q.sellQty > 0 ? q.buyQty / (q.buyQty + q.sellQty) : null;
  const stage = s.stage;
  // the plan is the frozen one; once it has broken out, buying now means buying at the live price —
  // the quantity is worked out from that price so the risk limit still holds
  const plan = stage === 'setup' ? s.plan : { ...s.plan, entry: Math.max(s.plan.entry, Math.round(Math.ceil(q.ltp / tick - 1e-9) * tick * 100) / 100) };
  const size = sizeTrade(plan, ctx.capital, ctx.maxRisk, tick);
  if (!size.ok) return { ...none, tooRisky: true };
  const sc = scoreEarly({
    look,
    stage,
    catalyst: catalyst ? { tone: catalyst.tone, kind: catalyst.kind } : null,
    rise,
    dealBuy: deals.some((d) => d.side === 'BUY'),
    dealSell: deals.some((d) => d.side === 'SELL'),
    deliveryPct: dv ? dv.pct : null,
    sectorPct: ctx.sectorPct,
    marketPct: ctx.market,
    buyShare,
  });
  const row: EarlyRow = {
    key: k,
    symbol,
    name: inst?.name ?? symbol,
    ...(ctx.index ? { index: ctx.index } : {}),
    ...(ctx.industry ? { industry: ctx.industry } : {}),
    stage,
    since: s.since,
    breakAt: s.breakAt ?? null,
    confirmedAt: s.confirmedAt ?? null,
    price: q.ltp,
    changePct: look.changePct,
    gapPct: look.gapPct,
    rvolDay: look.rvolDay,
    rvolBar: look.rvolBar,
    vwap: look.vwap,
    ema9: look.ema9,
    rsi: look.rsi,
    resistance: s.level,
    plan,
    size,
    score: sc.score,
    reasons: [...setupCheck(look).why.slice(1, 4), ...sc.reasons].filter((x, j, all) => all.indexOf(x) === j).slice(0, 6),
    warnings: sc.warnings,
    catalyst,
    deals,
    delivery: dv ? { pct: dv.pct, date: dv.date } : null,
    rise,
    buyShare,
  };
  const event = step.event === 'setup' || step.event === 'breakout' || step.event === 'confirmed' ? step.event : null;
  return { row, event, expired: false, tooRisky: false, badNews: false };
}

interface DriveCtx {
  sectorPct: number | null;
  market: number | null;
  capital: number;
  maxRisk: number;
  index?: string;
  industry?: string;
  openAt: number;
  catOf: (key: string) => Catalyst | null;
}

/** Usual volume by this moment of the day from the earlier days (the first candle at least half counted: mornings start heavy). */
function usualBy(prev: PrevDay[] | null, now: number): number | null {
  if (!prev?.length) return null;
  const usual = usualFrom(prev);
  const tm = minutesIST(now) + (((now + 5.5 * 3600_000) % 60_000) / 60_000);
  const slot = Math.floor(tm / 5) * 5;
  const frac = Math.max(0, Math.min(1, (tm - slot) / 5));
  const bar = usual(slot).bar;
  if (bar === null) return null;
  if (slot <= 9 * 60 + 15) return bar * Math.max(0.5, frac);
  const before = usual(slot - 5).cum;
  return before === null ? null : before + bar * frac;
}

/**
 * One stock's opening drive (9:15–9:35): it joins when it is on the final pre-open list or opened 1 %+
 * up; listed while it holds its gap (or, for a final pre-open pick, while it waits); out for the day
 * once it falls below its open or runs too far.
 */
async function driveStep(
  k: string,
  tr: Track,
  q: Quote,
  now: number,
  pre: { rank: number; score: number } | null,
  ctx: DriveCtx,
): Promise<{ row: DriveRow | null; event: boolean; out: boolean; tooRisky: boolean }> {
  const none = { row: null, event: false, out: false, tooRisky: false };
  if (!q.open || !q.prevClose || !(q.open > 0) || q.high === null || q.low === null) return none;
  const gap = (q.open / q.prevClose - 1) * 100;
  if (!pre && gap < DRIVE.minOpenGapPct && !tr.drive) return none;
  if (tr.drive && (tr.drive.state === 'faded' || tr.drive.state === 'ran')) return { ...none, out: true };
  const catalyst = ctx.catOf(k);
  if (catalyst?.tone === 'bad') return none;
  const buyShare = q.buyQty && q.sellQty && q.buyQty + q.sellQty > 0 ? q.buyQty / (q.buyQty + q.sellQty) : null;
  const vwap = q.vwap && q.vwap > 0 ? q.vwap : null;
  const d = readDrive({ price: q.ltp, open: q.open, prevClose: q.prevClose, high: Math.max(q.high, q.ltp), low: Math.min(q.low, q.ltp), vwap, volume: q.volume, usualVol: usualBy(tr.prev, now), buyShare, secsSinceOpen: (now - ctx.openAt) / 1000 });
  const was = tr.drive?.state;
  tr.drive = { ...(tr.drive ?? { since: null }), state: d.state, ...(d.outWhy ? { outWhy: d.outWhy } : {}) };
  if (d.state === 'faded' || d.state === 'ran') return { ...none, out: true };
  if (d.state === 'waiting' && !pre) return none;
  const inst = await getInstrument(k);
  const tick = inst?.tick ?? 0.05;
  const plan = drivePlan({ price: q.ltp, open: q.open, high: Math.max(q.high, q.ltp), low: Math.min(q.low, q.ltp), vwap }, tick);
  const size = sizeTrade(plan, ctx.capital, ctx.maxRisk, tick);
  if (!size.ok && d.state === 'holding') return { ...none, tooRisky: true };
  if (d.state === 'holding' && tr.drive.since === null) tr.drive.since = now;
  const sc = scoreDrive(d, pre?.score ?? null, { goodNews: catalyst?.tone === 'good', sectorPct: ctx.sectorPct, marketPct: ctx.market, buyShare });
  const symbol = inst?.trading_symbol ?? k;
  const row: DriveRow = {
    key: k,
    symbol,
    name: inst?.name ?? symbol,
    ...(ctx.index ? { index: ctx.index } : {}),
    ...(ctx.industry ? { industry: ctx.industry } : {}),
    state: d.state === 'holding' ? 'holding' : 'waiting',
    since: tr.drive.since,
    price: q.ltp,
    open: q.open,
    prevClose: q.prevClose,
    gapPct: d.gapPct,
    changePct: d.changePct,
    fromOpenPct: d.fromOpenPct,
    pace: d.pace,
    vwap,
    buyShare,
    plan,
    size,
    score: sc.score,
    reasons: [...d.why.filter((w) => !/trading has started/.test(w)).slice(0, 3), ...sc.reasons].filter((x, j, all) => all.indexOf(x) === j).slice(0, 6),
    warnings: sc.warnings,
    missing: d.missing,
    catalyst,
    preRank: pre?.rank ?? null,
    preScore: pre?.score ?? null,
  };
  const event = d.state === 'holding' && was !== 'holding' && !tr.drive.alerted && sc.score >= 60;
  if (event) tr.drive.alerted = true;
  return { row, event, out: false, tooRisky: false };
}

/** One alert per stock when it starts holding its opening gap with a score of 60+ (shared one-alert-per-stock gate). */
async function alertDrive(rows: DriveRow[], now: number, on: boolean): Promise<void> {
  if (!on || !rows.length) return;
  const date = istDate(now);
  const prev = await getSession('earlyAlerted');
  const sent = prev?.date === date ? [...prev.sent] : [];
  let changed = false;
  for (const r of rows) {
    const id = `${r.key}|drive`;
    if (sent.includes(id) || !(await claimAlert(r.key, 'buy', 'early', now))) continue;
    sent.push(id);
    changed = true;
    const p = r.plan;
    await notify(`alert:early-${r.key}-drive-${date}`, {
      title: `⚡ ${r.symbol}: holding its opening gap · score ${r.score}`,
      message: `₹${r.price.toFixed(2)} (opened ${r.gapPct >= 0 ? '+' : '−'}${Math.abs(r.gapPct).toFixed(1)}%${r.preRank ? `, #${r.preRank} in the pre-open` : ''}). Buy only above ₹${p.breakout.toFixed(2)} · stop-loss ₹${p.stop.toFixed(2)} · targets ₹${p.t1.toFixed(2)} / ₹${p.t2.toFixed(2)} · ${r.size.qty} shares, risk ₹${Math.round(r.size.risk)} with charges. Not a guarantee — you place the order yourself.`,
      priority: 2,
      detail: { symbol: r.symbol, key: r.key, side: 'buy', source: 'Early Movers (opening drive)', entry: p.breakout, stop: p.stop, targets: [p.t1, p.t2], qty: r.size.qty, risk: Math.round(r.size.risk), score: r.score, scoreKind: 'score', reasons: r.reasons },
    });
  }
  if (changed) await setSession('earlyAlerted', { date, sent });
}

const STAGE_WORDS: Record<Stage, string> = { setup: 'setup forming', breakout: 'breaking out (live, not confirmed)', confirmed: 'breakout confirmed' };

/**
 * Alerts with sound and the in-app banner: a new setup with a score of 60 or more (one per stock a day,
 * shared with the other scanners' alerts), its live breakout, and the confirmation — each once.
 */
async function alertEarly(events: Array<{ row: EarlyRow; event: Stage }>, now: number, on: boolean): Promise<void> {
  if (!on || !events.length) return;
  const date = istDate(now);
  const prev = await getSession('earlyAlerted');
  const sent = prev?.date === date ? [...prev.sent] : [];
  let changed = false;
  for (const { row: r, event } of events) {
    const id = `${r.key}|${event}`;
    if (sent.includes(id)) continue;
    if (event === 'setup' && (r.score < 60 || !(await claimAlert(r.key, 'buy', 'early', now)))) continue;
    sent.push(id);
    changed = true;
    const p = r.plan;
    await notify(`alert:early-${r.key}-${event}-${date}`, {
      title: `${event === 'confirmed' ? '✅' : event === 'breakout' ? '🚀' : '🌱'} ${r.symbol}: ${STAGE_WORDS[event]} · score ${r.score}`,
      message: `₹${r.price.toFixed(2)} (${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}% today). Buy above ₹${p.breakout.toFixed(2)} · stop-loss ₹${p.stop.toFixed(2)} · targets ₹${p.t1.toFixed(2)} / ₹${p.t2.toFixed(2)} · ${r.size.qty} shares, risk ₹${Math.round(r.size.risk)} with charges. ${r.reasons.slice(0, 2).join(' · ')}. Not a guarantee — you place the order yourself.`,
      priority: 2,
      detail: { symbol: r.symbol, key: r.key, side: 'buy', source: `Early Movers (${STAGE_WORDS[event]})`, entry: p.breakout, stop: p.stop, targets: [p.t1, p.t2], qty: r.size.qty, risk: Math.round(r.size.risk), score: r.score, scoreKind: 'score', reasons: r.reasons },
    });
  }
  if (changed) await setSession('earlyAlerted', { date, sent });
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
