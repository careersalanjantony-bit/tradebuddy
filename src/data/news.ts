import { chunk } from '../lib/chunk';
import { upstoxRequest } from '../upstox/client';

/**
 * Headlines from the Upstox News API (docs checked 12 Nov 2026): GET /v2/news
 * ?category=instrument_keys&instrument_keys=k1,k2 (at most 30 keys per request) → data: { "<key>":
 * [ { heading, summary, thumbnail, article_link, published_time (ms) } ] }, news of the past 7 days.
 * Free, works with the Analytics Token. Only the headline, the time and the link are kept.
 */

export interface NewsItem {
  key: string;
  heading: string;
  link: string;
  /** published time (ms) */
  at: number;
}

export const NEWS_KEYS_PER_REQUEST = 30;

export function parseNews(data: unknown): NewsItem[] {
  const out: NewsItem[] = [];
  if (!data || typeof data !== 'object') return out;
  for (const [key, list] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const r = raw as Record<string, unknown>;
      const heading = typeof r.heading === 'string' ? r.heading.trim() : '';
      const link = typeof r.article_link === 'string' && /^https:\/\//.test(r.article_link) ? r.article_link : '';
      const at = typeof r.published_time === 'number' && Number.isFinite(r.published_time) ? r.published_time : 0;
      if (!heading || !at) continue;
      out.push({ key, heading: heading.slice(0, 200), link, at });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Latest headlines for these stocks (newest first). */
export async function fetchNews(keys: string[]): Promise<NewsItem[]> {
  const all: NewsItem[] = [];
  for (const part of chunk(keys, NEWS_KEYS_PER_REQUEST)) {
    const data = await upstoxRequest<unknown>('/v2/news', { tokenKind: 'market', query: { category: 'instrument_keys', instrument_keys: part.join(','), page_size: 100 } });
    all.push(...parseNews(data));
  }
  return all.sort((a, b) => b.at - a.at);
}

/** Stocks with a headline in the last `hours` hours. */
export function inTheNews(items: NewsItem[], now: number, hours = 24): Set<string> {
  const since = now - hours * 3600_000;
  return new Set(items.filter((i) => i.at >= since).map((i) => i.key));
}

/** One line per article (the same article can be listed under several stocks), newest first. */
export function headlines(items: NewsItem[], limit: number): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const i of items) {
    const id = i.link || i.heading;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}
