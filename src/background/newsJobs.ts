import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { fetchNews, type NewsItem } from '../data/news';
import { getQuotes } from '../data/quotes';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { getLocal, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { UpstoxError } from '../upstox/errors';
import { dayKeys } from './dayJobs';

/**
 * Headlines (v0.12.0; always available since app v1.7). Upstox's News API gives news per stock
 * (at most 30 stocks per request, the last 7 days) — there is no general market feed — so the app
 * asks for the stocks that matter most first and fills up with the rest of the list:
 *   today's buy ideas → rising now → falling now (sell first) → top picks → what you hold →
 *   today's biggest movers in the list → the rest of the list.
 * Every 15 minutes in market hours, every 45 minutes otherwise (weekends and evenings too). The list
 * is kept on the phone, so the News tab is not empty after a restart or on a closed day.
 */

const log = createLogger('news');
export const NEWS_EVERY_MS = 15 * 60_000;
export const NEWS_EVERY_CLOSED_MS = 45 * 60_000;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_ITEMS = 600;
/** three requests of 30 stocks */
export const MAX_NEWS_STOCKS = 90;

export type NewsReason = 'idea' | 'rising' | 'falling' | 'pick' | 'holding' | 'trade' | 'mover' | 'market';

/**
 * The stocks to fetch news for, most important first (owner, 14 Nov 2026: "news based on the rising
 * stocks or high chance to rise stocks, not random news"; 15 Nov 2026: "show the recent and live news
 * even when the market is down").
 */
export async function newsTargets(now = Date.now()): Promise<Array<{ key: string; reason: NewsReason }>> {
  const today = istDate(now);
  const [plans, dayTrades, signals, picks, wallet, flow, shortIdeas, list, quotes, bot] = await Promise.all([
    getLocal('plans'),
    getLocal('dayTrades'),
    getSession('daySignals'),
    getSession('announcedPicks'),
    getLocal('wallet'),
    getSession('flow'),
    getSession('shortIdeas'),
    dayKeys(),
    getQuotes(),
    getLocal('bot'),
  ]);
  const out: Array<{ key: string; reason: NewsReason }> = [];
  const add = (key: string, reason: NewsReason) => {
    if (!out.some((x) => x.key === key)) out.push({ key, reason });
  };
  if (signals?.date === today) {
    for (const s of [...signals.signals].filter((x) => !x.late).sort((a, b) => (b.chance ?? 0.5) - (a.chance ?? 0.5))) add(s.key, 'idea');
  }
  for (const r of flow?.rising ?? []) add(r.key, 'rising');
  if (shortIdeas && istDate(shortIdeas.at) === today) for (const s of shortIdeas.ideas) add(s.key, 'falling');
  if (picks?.day === today) for (const k of picks.keys) add(k, 'pick');
  for (const p of plans ?? []) if (p.status === 'planned' && !p.practice) add(p.key, 'pick');
  for (const t of dayTrades ?? []) if (t.status === 'open' && !t.practice) add(t.key, 'trade');
  for (const p of plans ?? []) if (p.status === 'open' && !p.practice) add(p.key, 'trade');
  for (const h of wallet?.holdings ?? []) add(h.key, 'holding');
  for (const s of wallet?.shorts ?? []) add(s.key, 'holding');
  for (const t of bot?.trades ?? []) if (t.status === 'open') add(t.key, 'holding');
  // the list's biggest movers (up or down) in the latest session
  const moves = list
    .map((k) => ({ k, q: quotes[k] }))
    .filter((x) => x.q && x.q.prevClose)
    .map((x) => ({ k: x.k, m: Math.abs(x.q!.ltp / x.q!.prevClose! - 1) }))
    .sort((a, b) => b.m - a.m);
  for (const x of moves.slice(0, 20)) add(x.k, 'mover');
  for (const k of list) add(k, 'market');
  return out.slice(0, MAX_NEWS_STOCKS);
}

/** Instrument keys only (kept for older callers). */
export async function newsKeys(now = Date.now()): Promise<string[]> {
  return (await newsTargets(now)).map((x) => x.key);
}

export function mergeNews(old: NewsItem[], fresh: NewsItem[], now: number): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const i of [...fresh, ...old].sort((a, b) => b.at - a.at)) {
    const id = `${i.key}|${i.link || i.heading}`;
    if (seen.has(id) || now - i.at > KEEP_MS) continue;
    seen.add(id);
    out.push(i);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

type Stored = { at: number; items: NewsItem[]; targets?: Record<string, NewsReason>; error?: string };

/** The latest list from this run, or the one saved on the phone last time. */
async function current(): Promise<Stored | null> {
  const live = await getSession('news');
  if (live && live.items.length) return live;
  const saved = await getLocal('newsCache');
  return saved ? { ...saved, ...(live?.error ? { error: live.error } : {}) } : (live ?? null);
}

async function store(v: Stored): Promise<void> {
  await setSession('news', v);
  if (v.items.length) await setLocal('newsCache', { at: v.at, items: v.items, ...(v.targets ? { targets: v.targets } : {}) });
}

/** On start: show last time's headlines until the first download. */
export async function restoreNews(): Promise<void> {
  const live = await getSession('news');
  if (live?.items.length) return;
  const saved = await getLocal('newsCache');
  if (saved?.items.length) await setSession('news', { at: saved.at, items: saved.items, ...(saved.targets ? { targets: saved.targets } : {}) });
}

/** Headlines for these stocks right now, also added to the stored list. Never throws. */
export async function newsFor(keys: string[], now = Date.now()): Promise<NewsItem[]> {
  if (!keys.length) return [];
  try {
    const fresh = await fetchNews(keys.slice(0, 30));
    const prev = await current();
    await store({ at: prev?.at ?? now, items: mergeNews(prev?.items ?? [], fresh, now), ...(prev?.targets ? { targets: prev.targets } : {}) });
    return fresh;
  } catch (err) {
    log.info('News not available', { reason: errorMessage(err) });
    return [];
  }
}

let running: Promise<number> | null = null;
/** when the last download was tried (also failed ones), so a closed market is not asked every minute */
let lastTry = 0;

/** Refreshes the stored headlines (every 15 min in market hours, 45 min otherwise, or now with `force`). */
export function refreshNews(now = Date.now(), force = false): Promise<number> {
  running ??= (async () => {
    const prev = await current();
    const open = marketState(now, await getCalendar()).phase === 'open';
    const every = open ? NEWS_EVERY_MS : NEWS_EVERY_CLOSED_MS;
    const fetchedRecently = prev && prev.items.length && now - prev.at < every;
    if (!force && (fetchedRecently || now - lastTry < Math.min(every, 5 * 60_000))) return prev?.items.length ?? 0;
    lastTry = now;
    const targets = await newsTargets(now);
    const keys = targets.map((t) => t.key);
    const reasons = Object.fromEntries(targets.map((t) => [t.key, t.reason]));
    if (!keys.length) {
      await store({ at: now, items: mergeNews(prev?.items ?? [], [], now), targets: prev?.targets ?? {} });
      return prev?.items.length ?? 0;
    }
    try {
      const items = mergeNews(prev?.items ?? [], await fetchNews(keys), now);
      await store({ at: now, items, targets: { ...(prev?.targets ?? {}), ...reasons } });
      return items.length;
    } catch (err) {
      const msg = err instanceof UpstoxError ? err.message : errorMessage(err);
      await setSession('news', { at: prev?.at ?? 0, items: prev?.items ?? [], ...(prev?.targets ? { targets: prev.targets } : {}), error: msg });
      if (!(err instanceof UpstoxError && err.kind === 'not_logged_in')) log.info('News refresh failed', { reason: msg });
      return prev?.items.length ?? 0;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** On start and then every 15 minutes, whether the market is open or not (the call itself paces it). */
export function startNewsChecks(): void {
  void restoreNews().catch(() => undefined);
  setTimeout(() => void refreshNews().catch(() => undefined), 6_000);
  setInterval(() => void refreshNews().catch(() => undefined), NEWS_EVERY_MS);
}
