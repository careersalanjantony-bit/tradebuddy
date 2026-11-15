import { buildScan, refreshScanLists, type ScanLists, type ScanUniverse } from '../data/scanUniverse';
import { trackedKeys } from '../data/quotes';
import { createLogger } from '../lib/log';
import { appFetch } from '../platform/http';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';

/**
 * The scan list in the background (app v1.11; the only list from v1.12) — all five indices, each stock
 * once, plus your own stocks. Built from the stored NSE lists (refreshed weekly) and kept in memory;
 * the screen gets a short summary (how many stocks, from which index).
 */

const log = createLogger('scan-list');
let stored: ScanLists | null | undefined;
let memo: { sig: string; u: ScanUniverse } | null = null;

export async function scanUniverse(): Promise<ScanUniverse> {
  if (stored === undefined) stored = (await getLocal('scanLists')) ?? null;
  const watchlist = (await getLocal('watchlist')) ?? [];
  const sig = `${stored?.at ?? 0}|${watchlist.join(',')}`;
  if (memo?.sig === sig) return memo.u;
  // all five indices, always (app v1.12: there is no single-index choice any more)
  const u = buildScan(stored, watchlist);
  memo = { sig, u };
  const prev = await getSession('scanUniverse');
  if (!prev || prev.count !== u.keys.length) await setSession('scanUniverse', { at: Date.now(), count: u.keys.length, added: u.added });
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
