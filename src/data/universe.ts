import { createLogger } from '../lib/log';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { BUNDLED, BUNDLED_AS_OF } from './indexLists';
import { INDEX_CSV_URLS, INDEX_LABEL, INDEX_MIN_ROWS, memberKey, parseIndexCsv, type IndexMember, type UniverseIndex } from './universeParse';
import { appFetch } from '../platform/http';

const log = createLogger('universe');
const WEEK = 7 * 24 * 3600_000;

export interface UniverseState {
  index: UniverseIndex;
  members: IndexMember[];
  fetchedAt: number;
  source: 'nse' | 'bundled';
}

const bundled = (index: UniverseIndex): IndexMember[] => BUNDLED[index] ?? BUNDLED.nifty100;

/** ISINs of the Nifty 100 companies (large, liquid): the only ones the day-trade mode suggests selling short. */
export const NIFTY100_KEYS: ReadonlySet<string> = new Set(BUNDLED.nifty100.map(memberKey));

/**
 * The list of companies the extension studies by itself (Nifty 50 / 100 / Midcap 100 / Smallcap 100 /
 * Nifty 500). Downloaded from NSE weekly; falls back to the bundled copy if NSE cannot be reached.
 */
export async function ensureUniverse(force = false, now = Date.now()): Promise<UniverseState | null> {
  const settings = await getSettings();
  const index = settings.scanner.universe;
  if (index === 'watchlist') return null;
  const prev = await getLocal('universe');
  if (!force && prev && prev.index === index && prev.source === 'nse' && now - prev.fetchedAt < WEEK) return prev;
  try {
    const res = await appFetch(INDEX_CSV_URLS[index], { timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const members = parseIndexCsv(await res.text());
    if (members.length < INDEX_MIN_ROWS[index]) throw new Error(`only ${members.length} companies in the list`);
    const state: UniverseState = { index, members, fetchedAt: now, source: 'nse' };
    await setLocal('universe', state);
    log.info(`${INDEX_LABEL[index]} list updated from NSE: ${members.length} companies`);
    return state;
  } catch (err) {
    if (prev && prev.index === index) {
      log.warn(`Could not refresh the ${INDEX_LABEL[index]} list from NSE; keeping the stored one`, { error: err });
      return prev;
    }
    const state: UniverseState = { index, members: bundled(index), fetchedAt: Date.parse(`${BUNDLED_AS_OF}T00:00:00+05:30`), source: 'bundled' };
    await setLocal('universe', state);
    log.warn(`NSE not reachable; using the ${INDEX_LABEL[index]} list bundled on ${BUNDLED_AS_OF}`, { error: err });
    return state;
  }
}

export async function universeKeys(): Promise<string[]> {
  const settings = await getSettings();
  if (settings.scanner.universe === 'watchlist') return [];
  const u = await getLocal('universe');
  if (!u || u.index !== settings.scanner.universe) return bundled(settings.scanner.universe).map(memberKey);
  return u.members.map(memberKey);
}
