import type { NewsItem } from '../../data/news';
import type { NewsReason } from '../../background/newsJobs';
import { useLocal, useSessionValue } from '../hooks';

/**
 * App v1.7: the headlines from this run, or — right after the app starts, before the first download
 * — the ones saved last time, so the News tab and the news-based checks are never empty.
 */
export function useNews(): { at: number; items: NewsItem[]; targets: Record<string, NewsReason>; error?: string } | null {
  const live = useSessionValue('news');
  const saved = useLocal('newsCache');
  if (live && (live.items.length || !saved?.items.length)) return { at: live.at, items: live.items, targets: live.targets ?? saved?.targets ?? {}, ...(live.error ? { error: live.error } : {}) };
  if (saved) return { at: saved.at, items: saved.items, targets: saved.targets ?? {}, ...(live?.error ? { error: live.error } : {}) };
  return live ? { at: live.at, items: live.items, targets: live.targets ?? {}, ...(live.error ? { error: live.error } : {}) } : null;
}

export function useNewsItems(): NewsItem[] {
  return useNews()?.items ?? [];
}
