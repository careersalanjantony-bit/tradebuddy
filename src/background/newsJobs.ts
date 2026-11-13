import { fetchNews, type NewsItem } from '../data/news';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import { getLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { UpstoxError } from '../upstox/errors';

/**
 * Keeps a small list of headlines (v0.12.0) for the stocks that matter today: trades you hold or
 * planned, today's day-trade signals and top picks — at most 30 stocks, one request every 15 minutes.
 * No analysis: the list is shown as it is, and a stock with a headline in the last 24 hours gets an
 * "in the news" note on its signal.
 */

const log = createLogger('news');
export const NEWS_EVERY_MS = 15 * 60_000;
const KEEP_MS = 3 * 24 * 3600_000;
const MAX_ITEMS = 80;

/** The stocks to fetch news for, most important first (at most 30). */
export async function newsKeys(now = Date.now()): Promise<string[]> {
  const today = istDate(now);
  const [plans, dayTrades, signals, picks] = await Promise.all([getLocal('plans'), getLocal('dayTrades'), getSession('daySignals'), getSession('announcedPicks')]);
  const keys: string[] = [];
  for (const t of dayTrades ?? []) if (t.status === 'open' && !t.practice) keys.push(t.key);
  for (const p of plans ?? []) if (p.status === 'open' && !p.practice) keys.push(p.key);
  if (signals?.date === today) for (const s of signals.signals) keys.push(s.key);
  for (const p of plans ?? []) if (p.status === 'planned' && !p.practice) keys.push(p.key);
  if (picks?.day === today) keys.push(...picks.keys);
  for (const t of dayTrades ?? []) if (t.status === 'open' && t.practice) keys.push(t.key);
  for (const p of plans ?? []) if (p.status === 'open' && p.practice) keys.push(p.key);
  return [...new Set(keys)].slice(0, 30);
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

/** Headlines for these stocks right now, also added to the stored list. Never throws. */
export async function newsFor(keys: string[], now = Date.now()): Promise<NewsItem[]> {
  if (!keys.length) return [];
  try {
    const fresh = await fetchNews(keys.slice(0, 30));
    const prev = await getSession('news');
    await setSession('news', { at: prev?.at ?? now, items: mergeNews(prev?.items ?? [], fresh, now) });
    return fresh;
  } catch (err) {
    log.info('News not available', { reason: errorMessage(err) });
    return [];
  }
}

let running: Promise<number> | null = null;

/** Refreshes the stored headlines every 15 minutes (or now with `force`). Returns the number of headlines. */
export function refreshNews(now = Date.now(), force = false): Promise<number> {
  running ??= (async () => {
    const prev = await getSession('news');
    if (!force && prev && now - prev.at < NEWS_EVERY_MS) return prev.items.length;
    const keys = await newsKeys(now);
    if (!keys.length) {
      await setSession('news', { at: now, items: mergeNews(prev?.items ?? [], [], now) });
      return 0;
    }
    try {
      const items = mergeNews(prev?.items ?? [], await fetchNews(keys), now);
      await setSession('news', { at: now, items });
      return items.length;
    } catch (err) {
      const msg = err instanceof UpstoxError ? err.message : errorMessage(err);
      await setSession('news', { at: now, items: prev?.items ?? [], error: msg });
      if (!(err instanceof UpstoxError && err.kind === 'not_logged_in')) log.info('News refresh failed', { reason: msg });
      return prev?.items.length ?? 0;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
