import { useMemo } from 'preact/hooks';
import { BUNDLED } from '../../data/indexLists';
import { INDEX_TAG, OWN_TAG, SCAN_ORDER, buildScan, type ScanLists, type ScanUniverse } from '../../data/scanUniverse';
import { memberKey, type IndexMember, type UniverseIndex } from '../../data/universeParse';
import { formatNumberIN, formatTimeIST } from '../../lib/format';
import { updateSettings } from '../../storage/local';
import { useLocal, useNow, useSessionValue, useSettings } from '../hooks';

/**
 * App v1.11 — what the three Day Trade scanners watch, on screen: the scan list (all five indices,
 * each stock once), the index tag on every idea card, "also in" chips when one stock shows up in two
 * scanners, and one line saying how the prices of all those stocks are kept live.
 */

let memo: { sig: string; u: ScanUniverse } | null = null;

function scanOf(stored: ScanLists | null | undefined, watchlist: string[], scope: 'all' | 'list', index: UniverseIndex | 'watchlist', universe: { index: string; members: IndexMember[] } | null | undefined): ScanUniverse {
  const sig = `${stored?.at ?? 0}|${watchlist.join(',')}|${scope}|${index}|${universe?.index ?? ''}|${universe?.members.length ?? 0}`;
  if (memo?.sig === sig) return memo.u;
  const all = buildScan(stored, watchlist);
  let u = all;
  if (scope === 'list') {
    // same rule as background/scanList.ts: only the Stocks-tab list (or your own stocks)
    const members = index === 'watchlist' ? [] : universe && universe.index === index ? universe.members : (BUNDLED[index] ?? []);
    const listKeys = members.map(memberKey);
    const keys = listKeys.length ? listKeys : watchlist;
    const tag: Record<string, string> = {};
    const added: Record<string, number> = {};
    for (const k of keys) {
      tag[k] = all.tag[k] ?? OWN_TAG;
      added[tag[k]!] = (added[tag[k]!] ?? 0) + 1;
    }
    u = { ...all, keys, tag, added };
  }
  memo = { sig, u };
  return u;
}

/** The stocks the Day Trade scanners watch (same list as the background), with each stock's index. */
export function useScanUniverse(): ScanUniverse & { scope: 'all' | 'list' } {
  const settings = useSettings();
  const stored = useLocal('scanLists');
  const universe = useLocal('universe');
  const watchlist = useLocal('watchlist') ?? [];
  const scope = settings?.dayTrade.scanScope ?? 'all';
  const index = settings?.scanner.universe ?? 'nifty100';
  const u = useMemo(() => scanOf(stored, watchlist, scope, index, universe), [stored?.at, watchlist.join(','), scope, index, universe?.index, universe?.members.length]);
  return { ...u, scope };
}

/** Small tag with the stock's narrowest index: "Nifty 50", "Midcap 100", "Smallcap 100"… */
export function IndexTag({ index, k }: { index?: string; k: string }) {
  const { tag } = useScanUniverse();
  const label = index ?? tag[k];
  if (!label) return null;
  const cls = label === OWN_TAG ? 'own' : label.replace(/\s+/g, '').toLowerCase();
  return (
    <span class={`chip index-tag ${cls}`} data-testid="index-tag" title={label === OWN_TAG ? 'One of your own stocks (not in the five indices)' : `In ${label}`}>
      {label}
    </span>
  );
}

type Scanner = 'buy' | 'falling' | 'breakout';
const SCANNER_NAME: Record<Scanner, string> = { buy: "Today's buy ideas", falling: 'Falling now', breakout: 'Breakout today' };

/** Which scanners show each stock today (to mark the same stock in another list instead of hiding it). */
export function useIdeaLists(): Map<string, Set<Scanner>> {
  const day = useSessionValue('daySignals');
  const shorts = useSessionValue('shortIdeas');
  const bo = useSessionValue('breakouts');
  const now = useNow(30_000);
  const today = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  return useMemo(() => {
    const m = new Map<string, Set<Scanner>>();
    const add = (k: string, s: Scanner) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(s);
    if (day?.date === today) for (const s of day.signals) add(s.key, 'buy');
    if (shorts && new Date(shorts.at + 5.5 * 3600_000).toISOString().slice(0, 10) === today) for (const x of shorts.ideas) add(x.key, 'falling');
    if (bo?.date === today) for (const s of bo.signals) if (s.status === 'breakout' || s.status === 'confirmed') add(s.key, 'breakout');
    return m;
  }, [day, shorts?.at, bo?.at, today]);
}

/** "Also in Breakout today" — the same stock found by another scanner (one alert was sent, not two). */
export function AlsoIn({ k, here }: { k: string; here: Scanner }) {
  const lists = useIdeaLists();
  const other = [...(lists.get(k) ?? [])].filter((s) => s !== here);
  if (!other.length) return null;
  return (
    <span class="chip also-in" data-testid="also-in" title="The same stock was found by another scanner — you were alerted once">
      also in {other.map((s) => SCANNER_NAME[s]).join(' & ')}
    </span>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumberIN(n, 0)} ${n === 1 ? one : many}`;

/**
 * Day trade intro: how many stocks are scanned (per index, without double counting), the live-price
 * coverage (instant feed / price checks), today's candles and history, and the "only my list" switch.
 */
export function ScanCoverage() {
  const u = useScanUniverse();
  const feed = useSessionValue('feedStatus');
  const fill = useSessionValue('priceFill');
  const live = useSessionValue('dayLive');
  const progress = useSessionValue('intradayProgress');
  const now = useNow(5_000);
  const feedLive = !!feed?.connected && now - feed.lastTickAt < 15_000;
  const parts = u.scope === 'all' ? SCAN_ORDER.map((i) => ({ label: INDEX_TAG[i], n: u.added[INDEX_TAG[i]] ?? 0 })).concat(u.added[OWN_TAG] ? [{ label: OWN_TAG, n: u.added[OWN_TAG] }] : []) : Object.entries(u.added).map(([label, n]) => ({ label, n }));
  const cov = live?.coverage;
  const fresh = fill && now - fill.at < 30_000;
  return (
    <div class="scan-cover small" data-testid="scan-coverage">
      <p style={{ margin: '0 0 4px' }}>
        <b data-testid="scan-count">Scanning {formatNumberIN(u.keys.length, 0)} stocks</b>{' '}
        {u.scope === 'all' ? <>— Nifty 50, Nifty 100, Midcap 100, Smallcap 100 and Nifty 500 together, each stock once.</> : <>— only your Stocks-tab list.</>}
      </p>
      <div class="scan-parts" data-testid="scan-parts">
        {parts.map((p, i) => (
          <span class="chip index-tag" key={p.label} title={i > 0 && u.scope === 'all' ? `${p.n} more stocks that the lists before it do not have` : undefined}>
            {p.label} <b>{i > 0 && u.scope === 'all' ? '+' : ''}{formatNumberIN(p.n, 0)}</b>
          </span>
        ))}
      </div>
      <p class="tiny muted" style={{ margin: '4px 0 0' }} data-testid="scan-prices">
        {feedLive ? (
          <>
            Live prices: <b>{formatNumberIN((feed?.full ?? 0) + (feed?.ltpc ?? 0), 0)}</b> stocks on the Upstox live feed{feed?.ltpc ? ` (${formatNumberIN(feed.ltpc, 0)} prices-only, over the full-detail limit)` : ''}
            {feed?.overflow ? `; ${plural(feed.overflow, 'stock')} over the feed limit get a price check every 3 seconds` : ''}
            {fresh && fill.count ? ` · ${plural(fill.count, 'stock')} checked by price request just now (no tick for 15 s)` : ''}. No stock is skipped.
          </>
        ) : (
          <>Live feed not connected — prices of all {formatNumberIN(u.keys.length, 0)} stocks are asked for in batches of 500 every few seconds.</>
        )}
      </p>
      {cov && cov.total > 0 && (
        <p class="tiny muted" style={{ margin: '2px 0 0' }} data-testid="scan-candles">
          Today's 5-minute candles: {formatNumberIN(cov.loaded, 0)} of {formatNumberIN(cov.total, 0)} stocks
          {cov.noCandles ? ` · ${plural(cov.noCandles, 'stock')} not traded yet` : ''}
          {cov.failed ? ` · ${plural(cov.failed, 'stock')} could not load (tried again at the next 5-minute mark)` : ''}
          {cov.noHistory ? ` · ${plural(cov.noHistory, 'stock')} without past volume yet (no buy idea until their history is in)` : ''}.
        </p>
      )}
      {progress?.running && (
        <p class="tiny muted" style={{ margin: '2px 0 0' }} data-testid="scan-history">
          Downloading 5-minute history: {formatNumberIN(progress.done, 0)} of {formatNumberIN(progress.total, 0)} stocks (since {formatTimeIST(progress.at)}).
        </p>
      )}
      <label class="switch-row" style={{ marginTop: '6px' }} data-testid="scan-scope">
        <span>
          <b>All five indices</b>
          <span class="tiny muted">{u.scope === 'all' ? 'On: the scanners watch every stock of the five lists.' : 'Off: only the stocks of your Stocks-tab list (fewer stocks, less mobile data).'}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          class="switch"
          checked={u.scope === 'all'}
          data-testid="scan-scope-switch"
          onChange={(e) => void updateSettings({ dayTrade: { scanScope: (e.currentTarget as HTMLInputElement).checked ? 'all' : 'list' } })}
        />
      </label>
    </div>
  );
}
