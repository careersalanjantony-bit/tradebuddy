import { BUNDLED, BUNDLED_AS_OF } from './indexLists';
import { INDEX_CSV_URLS, INDEX_LABEL, INDEX_MIN_ROWS, INDEX_ORDER, memberKey, parseIndexCsv, type IndexMember, type UniverseIndex } from './universeParse';

/**
 * App v1.11 — the stocks the three Day Trade scanners (Today's buy ideas, Falling now, Breakout
 * today) watch: every company of Nifty 50, Nifty 100, Nifty Midcap 100, Nifty Smallcap 100 and
 * Nifty 500 together, each once, whatever list the Stocks tab shows. The lists come from NSE (once a
 * week) with the copy bundled in the app as the fallback. Each stock carries the narrowest index it
 * belongs to ("Nifty 50" for Reliance, "Midcap 100" for a mid-cap…), shown on the idea cards.
 */

export interface ScanLists {
  /** when the lists were last checked */
  at: number;
  lists: Partial<Record<UniverseIndex, { members: IndexMember[]; source: 'nse' | 'bundled'; fetchedAt: number }>>;
}

/** short names for the cards, narrowest index first */
export const INDEX_TAG: Record<UniverseIndex, string> = {
  nifty50: 'Nifty 50',
  nifty100: 'Nifty 100',
  midcap100: 'Midcap 100',
  smallcap100: 'Smallcap 100',
  nifty500: 'Nifty 500',
};
/** narrowest first: a Nifty 50 company is also in Nifty 100 and Nifty 500, and is tagged "Nifty 50" */
export const SCAN_ORDER: UniverseIndex[] = ['nifty50', 'nifty100', 'midcap100', 'smallcap100', 'nifty500'];
export const OWN_TAG = 'Your list';

export interface ScanUniverse {
  /** every stock once, Nifty 50 first */
  keys: string[];
  /** the narrowest index of each stock (or "Your list") */
  tag: Record<string, string>;
  /** how many stocks each index adds that no narrower index has */
  added: Record<string, number>;
  /** stocks per index (members, before removing the overlap) */
  perIndex: Record<string, number>;
  /** where each list came from */
  sources: Partial<Record<UniverseIndex, 'nse' | 'bundled'>>;
  /** app v1.15: each company's industry as NSE lists it (for sector strength) */
  industry: Record<string, string>;
}

export const membersOf = (index: UniverseIndex, stored: ScanLists | null | undefined): IndexMember[] => stored?.lists[index]?.members ?? BUNDLED[index] ?? [];

/**
 * The scan list: all five indices, each stock once (narrowest index wins its tag), then your own
 * stocks that are in none of them. Pure.
 */
export function buildScan(stored: ScanLists | null | undefined, ownKeys: string[] = []): ScanUniverse {
  const keys: string[] = [];
  const tag: Record<string, string> = {};
  const added: Record<string, number> = {};
  const perIndex: Record<string, number> = {};
  const sources: Partial<Record<UniverseIndex, 'nse' | 'bundled'>> = {};
  const industry: Record<string, string> = {};
  for (const index of SCAN_ORDER) {
    const members = membersOf(index, stored);
    perIndex[INDEX_TAG[index]] = members.length;
    sources[index] = stored?.lists[index]?.source ?? 'bundled';
    let n = 0;
    for (const m of members) {
      const k = memberKey(m);
      if (m.industry && !industry[k]) industry[k] = m.industry;
      if (tag[k]) continue;
      tag[k] = INDEX_TAG[index];
      keys.push(k);
      n++;
    }
    added[INDEX_TAG[index]] = n;
  }
  let own = 0;
  for (const k of ownKeys) {
    if (tag[k]) continue;
    tag[k] = OWN_TAG;
    keys.push(k);
    own++;
  }
  if (own) added[OWN_TAG] = own;
  return { keys, tag, added, perIndex, sources, industry };
}

/** One-line description: "Nifty 50, Nifty 100, Midcap 100, Smallcap 100 and Nifty 500 — 503 stocks". */
export const scanSummary = (u: ScanUniverse): string => `${SCAN_ORDER.map((i) => INDEX_TAG[i]).join(', ').replace(/, ([^,]*)$/, ' and $1')} — ${u.keys.length} stocks`;

const WEEK = 7 * 24 * 3600_000;

/**
 * Downloads all five lists from NSE once a week (each falls back to the stored copy, then to the one
 * bundled on BUNDLED_AS_OF). `fetchText` is injected so this stays testable.
 */
export async function refreshScanLists(prev: ScanLists | null | undefined, fetchText: (url: string) => Promise<string>, now: number, force = false): Promise<ScanLists> {
  if (!force && prev && now - prev.at < WEEK && SCAN_ORDER.every((i) => prev.lists[i])) return prev;
  const lists: ScanLists['lists'] = {};
  for (const index of INDEX_ORDER) {
    try {
      const members = parseIndexCsv(await fetchText(INDEX_CSV_URLS[index]));
      if (members.length < INDEX_MIN_ROWS[index]) throw new Error(`only ${members.length} companies in ${INDEX_LABEL[index]}`);
      lists[index] = { members, source: 'nse', fetchedAt: now };
    } catch {
      lists[index] = prev?.lists[index] ?? { members: BUNDLED[index] ?? [], source: 'bundled', fetchedAt: Date.parse(`${BUNDLED_AS_OF}T00:00:00+05:30`) };
    }
  }
  return { at: now, lists };
}
