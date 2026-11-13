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

export type NewsReason = 'idea' | 'rising' | 'pick' | 'holding' | 'trade';

/**
 * The stocks to fetch news for (owner, 14 Nov 2026: "news based on the rising stocks or high chance to
 * rise stocks, not random news"). Most important first, at most 30 (one Upstox request):
 *   1. today's buy ideas, highest learned chance first;
 *   2. stocks rising now (buyers in control), best first;
 *   3. today's top picks (hold a few days);
 *   4. what you hold: real trades, then practice shares.
 */
export async function newsTargets(now = Date.now()): Promise<Array<{ key: string; reason: NewsReason }>> {
  const today = istDate(now);
  const [plans, dayTrades, signals, picks, wallet, flow] = await Promise.all([getLocal('plans'), getLocal('dayTrades'), getSession('daySignals'), getSession('announcedPicks'), getLocal('wallet'), getSession('flow')]);
  const out: Array<{ key: string; reason: NewsReason }> = [];
  const add = (key: string, reason: NewsReason) => {
    if (!out.some((x) => x.key === key)) out.push({ key, reason });
  };
  if (signals?.date === today) {
    for (const s of [...signals.signals].filter((x) => !x.late).sort((a, b) => (b.chance ?? 0.5) - (a.chance ?? 0.5))) add(s.key, 'idea');
  }
  for (const r of flow?.rising ?? []) add(r.key, 'rising');
  if (picks?.day === today) for (const k of picks.keys) add(k, 'pick');
  for (const p of plans ?? []) if (p.status === 'planned' && !p.practice) add(p.key, 'pick');
  for (const t of dayTrades ?? []) if (t.status === 'open' && !t.practice) add(t.key, 'trade');
  for (const p of plans ?? []) if (p.status === 'open' && !p.practice) add(p.key, 'trade');
  for (const h of wallet?.holdings ?? []) add(h.key, 'holding');
  return out.slice(0, 30);
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
    const targets = await newsTargets(now);
    const keys = targets.map((t) => t.key);
    const reasons = Object.fromEntries(targets.map((t) => [t.key, t.reason]));
    if (!keys.length) {
      await setSession('news', { at: now, items: mergeNews(prev?.items ?? [], [], now), targets: {} });
      return 0;
    }
    try {
      const items = mergeNews(prev?.items ?? [], await fetchNews(keys), now);
      await setSession('news', { at: now, items, targets: reasons });
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
