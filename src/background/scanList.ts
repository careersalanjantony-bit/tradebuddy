import { buildScan, refreshScanLists, type ScanLists, type ScanUniverse } from '../data/scanUniverse';
import { universeKeys } from '../data/universe';
import { trackedKeys } from '../data/quotes';
import { createLogger } from '../lib/log';
import { appFetch } from '../platform/http';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';

/**
 * App v1.11: the Day Trade scan list in the background — all five indices, each stock once (or, with
 * "only my Stocks-tab list", that list). Built from the stored NSE lists (refreshed weekly) and kept
 * in memory; the screen gets a short summary (how many stocks, from which index).
 */

const log = createLogger('scan-list');
let stored: ScanLists | null | undefined;
let memo: { sig: string; u: ScanUniverse } | null = null;

export async function scanUniverse(): Promise<ScanUniverse> {
  if (stored === undefined) stored = (await getLocal('scanLists')) ?? null;
  const settings = await getSettings();
  const watchlist = (await getLocal('watchlist')) ?? [];
  const scope = settings.dayTrade.scanScope ?? 'all';
  const listKeys = scope === 'list' ? await universeKeys() : [];
  const sig = `${scope}|${stored?.at ?? 0}|${settings.scanner.universe}|${listKeys.length}|${watchlist.join(',')}`;
  if (memo?.sig === sig) return memo.u;
  const all = buildScan(stored, watchlist);
  let u: ScanUniverse;
  if (scope === 'list') {
    // only the Stocks-tab list (or your own stocks): same tags, fewer stocks
    const keys = listKeys.length ? listKeys : watchlist;
    const tag: Record<string, string> = {};
    for (const k of keys) tag[k] = all.tag[k] ?? 'Your list';
    const added: Record<string, number> = {};
    for (const k of keys) added[tag[k]!] = (added[tag[k]!] ?? 0) + 1;
    u = { keys, tag, added, perIndex: all.perIndex, sources: all.sources };
  } else u = all;
  memo = { sig, u };
  const prev = await getSession('scanUniverse');
  if (!prev || prev.count !== u.keys.length || prev.scope !== scope) await setSession('scanUniverse', { at: Date.now(), count: u.keys.length, added: u.added, scope });
  return u;
}

/** The narrowest index of a stock in the scan list ("Nifty 50", "Midcap 100"…), or undefined. */
export async function indexTagOf(key: string): Promise<string | undefined> {
  return (await scanUniverse()).tag[key];
}

/** All five lists from NSE once a week (each falls back to the stored or bundled copy). */
export async function ensureScanLists(force = false, now = Date.now()): Promise<ScanLists> {
  const prev = (await getLocal('scanLists')) ?? null;
  const next = await refreshScanLists(
    prev,
    async (url) => {
      const res = await appFetch(url, { timeoutMs: 30_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    now,
    force,
  );
  if (next !== prev) {
    await setLocal('scanLists', next);
    stored = next;
    memo = null;
    const fromNse = Object.values(next.lists).filter((l) => l?.source === 'nse').length;
    log.info(`Day Trade scan lists checked: ${fromNse} of 5 from NSE (the rest bundled)`);
  }
  return next;
}

/**
 * Every stock that needs live prices: what you hold or trade, your stocks and Stocks-tab list, and —
 * while Day trade is on — the whole scan list. Each once, most important first.
 */
export async function priceKeys(): Promise<string[]> {
  const tracked = await trackedKeys();
  if (!(await getSettings()).dayTrade.enabled) return tracked;
  return [...new Set([...tracked, ...(await scanUniverse()).keys])];
}

/** For tests. */
export function resetScanList(): void {
  stored = undefined;
  memo = null;
}
