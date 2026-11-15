import { getLocal } from '../storage/local';
import { BUNDLED } from './indexLists';
import { buildScan, membersOf } from './scanUniverse';
import { memberKey, type IndexMember, type UniverseIndex } from './universeParse';


export interface UniverseState {
  index: UniverseIndex;
  members: IndexMember[];
  fetchedAt: number;
  source: 'nse' | 'bundled';
}

/** ISINs of the Nifty 100 companies (large, liquid): the only ones the day-trade mode suggests selling short. */
export const NIFTY100_KEYS: ReadonlySet<string> = new Set(BUNDLED.nifty100.map(memberKey));

/**
 * The companies the app studies by itself (app v1.12): Nifty 50, Nifty 100, Nifty Midcap 100, Nifty
 * Smallcap 100 and Nifty 500 together, each company once, Nifty 50 first — always. There is no
 * single-index choice any more; an old `scanner.universe` value (e.g. from a restored backup) is
 * ignored. The five lists come from NSE weekly (background/scanList.ts ensureScanLists), with the
 * bundled copy as the fallback. Your own stocks are added next to this list, not into it.
 */
export async function universeKeys(): Promise<string[]> {
  return buildScan(await getLocal('scanLists')).keys;
}

/**
 * The stocks the 5-minute past tests and the self-learning study: the Nifty 100 plus your own stocks.
 * About 6 months of 5-minute prices for all ~535 stocks would be too big for a phone (the other stocks
 * keep about 5 weeks — enough for the live scanners).
 */
export async function testKeys(): Promise<string[]> {
  const watchlist = (await getLocal('watchlist')) ?? [];
  return [...new Set([...membersOf('nifty100', await getLocal('scanLists')).map(memberKey), ...watchlist])];
}
