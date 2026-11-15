import { resetScanList } from '../src/background/scanList';
import type { ScanLists } from '../src/data/scanUniverse';

/**
 * The five index lists, empty: the scanners then watch only the test's own stocks (app v1.12 always
 * scans all five indices; without this the ~535 bundled companies would join every engine test).
 */
export function noIndexLists(): ScanLists {
  resetScanList();
  const empty = { members: [], source: 'nse' as const, fetchedAt: 0 };
  return { at: Date.now(), lists: { nifty50: empty, nifty100: empty, midcap100: empty, smallcap100: empty, nifty500: empty } };
}
