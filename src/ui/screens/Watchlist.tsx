import { useMemo, useState } from 'preact/hooks';
import { searchInstruments } from '../../data/instrumentsParse';
import { formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { setLocal } from '../../storage/local';
import type { Go } from '../App';
import { StockRow } from '../components/StockRow';
import { useInstrumentMap, useInstruments, useStocksData } from '../data';
import { useLocal, useSessionValue, useSettings } from '../hooks';
import { useStudyKeys } from '../data';
import { PriceRange } from '../components/PriceRange';
import { DownloadNote } from '../components/DownloadNote';
import { suggestBuys } from '../../advisor/suggest';
import { explainSnapshot } from '../../advisor/explain';
import { INDEX_ORDER, inPriceRange, type UniverseIndex } from '../../data/universeParse';
import { INDEX_VIEW_LABEL, useIndexMembers, useScanUniverse, type IndexView } from '../components/ScanList';
import { istDate } from '../../lib/time';
import { ShortSellList } from '../components/ShortSell';
import { usePersistentState } from '../persist';

type SortKey = 'mine' | 'setup' | 'change' | 'rsi';
const SETUP_ORDER = ['Breakout', 'Pullback in uptrend', 'Clean uptrend', 'Recovering — trend not confirmed', 'No setup'];

export function WatchlistScreen({ go }: { go: Go }) {
  const settings = useSettings();
  const { universeKeys } = useStudyKeys();
  const [view, setView] = usePersistentState<'auto' | 'mine'>('stocks.view', 'auto');
  const auto = view === 'auto' && universeKeys.length > 0;
  return (
    <>
      {universeKeys.length > 0 && (
        <div class="segmented" role="tablist">
          <button type="button" aria-selected={auto} onClick={() => setView('auto')}>
            All five indices — ranked for you
          </button>
          <button type="button" aria-selected={!auto} onClick={() => setView('mine')}>
            My stocks
          </button>
        </div>
      )}
      {auto && settings ? <AutoList go={go} keys={universeKeys} /> : <MyStocks go={go} />}
    </>
  );
}

const VERDICT_ORDER = ['Good setup', 'Wait', 'No setup', 'Check data', 'Avoid'];

type Filter = 'all' | 'picks' | 'day' | 'good' | 'wait' | 'avoid' | 'uptrend' | 'downtrend' | 'recovering' | 'sideways' | 'breakout' | 'pullback' | 'stretched' | 'rising' | 'falling' | 'short';
/** today's change in %, from the price history or (before it has downloaded) from the live quote */
function dayChange(d: { snapshot?: { changePct: number | null } | null; quote?: { ltp: number; prevClose: number | null } | null } | undefined): number {
  const s = d?.snapshot?.changePct;
  if (s !== undefined && s !== null) return s;
  const q = d?.quote;
  return q && q.prevClose ? (q.ltp / q.prevClose - 1) * 100 : 0;
}

/** the most useful filters, one tap each */
const QUICK: Array<[Filter, string]> = [
  ['all', 'All'],
  ['picks', '⭐ Top picks'],
  ['day', '⚡ Buy ideas today'],
  ['good', 'Good to buy'],
  ['rising', '▲ Rising today'],
  ['falling', '▼ Falling today'],
  ['short', '⇣ For short selling'],
];

const FILTERS: Array<[Filter, string]> = [
  ['all', 'All stocks'],
  ['picks', 'Buy picks (few days to weeks)'],
  ['day', 'Day-trade signals today (BUY / SELL)'],
  ['good', 'Good setup'],
  ['wait', 'Wait'],
  ['avoid', 'Avoid'],
  ['uptrend', 'Uptrend (rising for months)'],
  ['downtrend', 'Downtrend (falling for months)'],
  ['recovering', 'Recovering'],
  ['sideways', 'Sideways'],
  ['breakout', 'Breakout (new 20-day high)'],
  ['pullback', 'Pullback in uptrend (dip)'],
  ['stretched', 'Stretched (ran up too fast)'],
  ['rising', 'Rising today'],
  ['falling', 'Falling today'],
  ['short', 'For short selling (sell first, buy back lower)'],
];
const PAGE = 120;

/**
 * The studied list — all five indices together (app v1.12), each company once — ranked: buy picks first
 * (in the chosen order), then Good / Wait / others. "Show only" narrows what is shown to one index; it
 * does not change what is studied or scanned.
 */
function AutoList({ go, keys }: { go: Go; keys: string[] }) {
  const settings = useSettings(); // null for a moment while loading
  const plans = useLocal('plans') ?? [];
  const byKey = useInstrumentMap();
  const { data, loading } = useStocksData(keys);
  const progress = useSessionValue('syncProgress');
  const lastPoll = useSessionValue('lastPoll');
  const daySignals = useSessionValue('daySignals');
  // remembered when you open a stock and come back, and across restarts (app v1.7)
  const [q, setQ] = usePersistentState('stocks.q', '');
  const [filter, setFilter] = usePersistentState<Filter>('stocks.filter', 'all');
  const [limit, setLimit] = usePersistentState('stocks.limit', PAGE);
  const [indexView, setIndexView] = usePersistentState<IndexView>('stocks.index', 'all');
  const members = useIndexMembers();
  const { tag } = useScanUniverse();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const safety = (settings?.scanner.rankBy ?? 'safety') === 'safety';
  const today = istDate(Date.now());
  const signalOf = useMemo(() => new Map((daySignals && daySignals.date >= today ? daySignals.signals : []).filter((x) => !x.late).map((x) => [x.key, x])), [daySignals, today]);

  const rows = useMemo(() => {
    if (!settings) return [];
    const stocks = keys.map((k) => ({ key: k, symbol: byKey.get(k)?.trading_symbol ?? k, data: data.get(k) }));
    const res = suggestBuys(stocks, settings, plans, istDate(Date.now()), { priceMin: 0, priceMax: null });
    const pickRank = new Map([...res.suggestions, ...res.more].map((s, i) => [s.key, { i, pct: s.expectedPct, won: s.record.profitable, of: s.record.samples }]));
    const text = q.trim().toUpperCase();
    const only = indexView === 'all' ? null : (members[indexView] ?? null);
    return stocks
      .filter((s) => !only || only.has(s.key))
      .filter((s) => !text || s.symbol.includes(text) || (byKey.get(s.key)?.name ?? '').toUpperCase().includes(text))
      .filter((s) => inPriceRange(s.data?.snapshot?.price ?? null, settings.ui.priceMin, settings.ui.priceMax))
      .map((s) => ({ ...s, pick: pickRank.get(s.key), signal: signalOf.get(s.key), verdict: s.data?.snapshot ? explainSnapshot(s.symbol, s.data.snapshot).verdict : 'No setup' }))
      .filter((s) => {
        const snap = s.data?.snapshot;
        switch (filter) {
          case 'all':
            return true;
          case 'picks':
            return !!s.pick;
          case 'day':
            return !!s.signal;
          case 'good':
            return s.verdict === 'Good setup';
          case 'wait':
            return s.verdict === 'Wait';
          case 'avoid':
            return s.verdict === 'Avoid';
          case 'uptrend':
            return snap?.trend === 'Uptrend';
          case 'downtrend':
            return snap?.trend === 'Downtrend';
          case 'recovering':
            return snap?.trend === 'Recovering';
          case 'sideways':
            return snap?.trend === 'Sideways';
          case 'breakout':
            return snap?.setup === 'Breakout';
          case 'pullback':
            return snap?.setup === 'Pullback in uptrend';
          case 'stretched':
            return !!snap?.flags.includes('Stretched');
          case 'rising':
            return dayChange(s.data) > 0;
          case 'falling':
            return dayChange(s.data) < 0;
          case 'short':
            return true;
        }
      })
      .sort((a, b) => {
        if (filter === 'rising') return dayChange(b.data) - dayChange(a.data);
        if (filter === 'falling') return dayChange(a.data) - dayChange(b.data);
        if (filter === 'day') return (a.signal?.at ?? 0) - (b.signal?.at ?? 0);
        if (a.pick && b.pick) return a.pick.i - b.pick.i;
        if (a.pick || b.pick) return a.pick ? -1 : 1;
        return VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict);
      });
  }, [keys.join(','), data, byKey, settings, plans, q, filter, signalOf, indexView, members]);

  const refresh = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await callBackground('quotes:refresh');
      setNote(r.skipped ? `Not refreshed: ${r.skipped}` : `Prices refreshed for ${r.polled} stocks.`);
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section class="card">
        <div class="grid2">
          <label class="field">
            <span>Show only</span>
            <select
              value={indexView}
              data-field="index-view"
              title="All five indices are always studied and scanned — this only hides the others from this list"
              onChange={(e) => (setIndexView((e.currentTarget as HTMLSelectElement).value as IndexView), setLimit(PAGE))}
            >
              {(['all', ...INDEX_ORDER] as IndexView[]).map((i) => (
                <option value={i}>
                  {INDEX_VIEW_LABEL[i]}
                  {i === 'all' ? ` (${keys.length})` : ` (${members[i as UniverseIndex]?.size ?? 0})`}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>Show</span>
            <select value={filter} data-field="filter" onChange={(e) => (setFilter((e.currentTarget as HTMLSelectElement).value as Filter), setLimit(PAGE))}>
              {FILTERS.map(([v, label]) => (
                <option value={v}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <div class="filter-chips" data-testid="stock-chips">
          {QUICK.map(([v, label]) => (
            <button type="button" class={`filter-chip ${filter === v ? 'on' : ''}`} data-filter={v} onClick={() => (setFilter(v), setLimit(PAGE))}>
              {label}
            </button>
          ))}
        </div>
        <div class="row search-row">
          <input type="search" placeholder="🔍  Find a company" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} aria-label="Find a company" style={{ flex: 1 }} />
          <button class="btn small" type="button" disabled={busy} data-testid="refresh-stocks" onClick={() => void refresh()} title="Fetch the latest prices now">
            {busy ? 'Refreshing…' : '⟳'}
          </button>
        </div>
        <PriceRange />
        <p class="small muted" style={{ margin: 0 }} data-testid="list-info">
          <b>{rows.length}</b> of {keys.length} stocks · <b>NSE</b> prices · {lastPoll ? `updated ${formatTimeIST(lastPoll.at)}` : 'prices not loaded yet'}
          {note ? ` · ${note}` : ''}
        </p>
        <DownloadNote testid="list-downloading" tail="Stocks fill in as it goes (about a minute). Nothing for you to do." />
        <div class="banner info small" data-testid="list-guide">
          <b>This list is only for looking.</b> To know what to do: <b>same-day trades</b> →{' '}
          <button class="link-btn" type="button" onClick={() => go('daytrade')}>
            Day trade
          </button>{' '}
          tab · <b>buy and hold a few days</b> →{' '}
          <button class="link-btn" type="button" onClick={() => go('today')}>
            Today
          </button>{' '}
          tab.
        </div>
        <details class="small" data-testid="list-help">
          <summary>What do the labels mean?</summary>
          <ul>
            <li>
              <b>Good to buy</b> — rising for months and at a sensible price now (for holding a few days to weeks).
            </li>
            <li>
              <b>Wait</b> — a good stock, but it rose too fast lately or its rise is not confirmed. Buying now often means buying at the top.
            </li>
            <li>
              <b>Avoid</b> — has been falling for months.
            </li>
            <li>
              <b>Nothing to do</b> — no clear direction.
            </li>
            <li>
              <b>▲ BUY today / ▼ SELL today</b> — a same-day signal from the Day trade tab (appears between 9:35 and 11:30 am).
            </li>
            <li>
              <b>#1 pick</b> — the best "Good to buy" stock by its past record.
            </li>
            <li>The green or red % on the right is today's change in price.</li>
          </ul>
        </details>
      </section>
      {filter === 'short' ? (
        <ShortSellList keys={keys} data={data} symbolOf={(k) => byKey.get(k)?.trading_symbol ?? k} go={go} />
      ) : (
      <section class="list" data-testid="auto-list">
        {loading && !rows.length && <div class="card empty">Studying…</div>}
        {!loading && !rows.length && <div class="card empty">No stock matches this filter right now.</div>}
        {rows.slice(0, limit).map((r) => (
          <StockRow
            symbol={r.symbol}
            data={r.data}
            onOpen={() => go('stock', r.key)}
            {...(tag[r.key] ? { indexTag: tag[r.key] } : {})}
            {...(r.signal ? { signal: { side: r.signal.side, time: formatTimeIST(r.signal.at).slice(0, 5) } } : {})}
            {...(r.pick ? { badge: safety ? `#${r.pick.i + 1} pick · made money ${r.pick.won} of ${r.pick.of} times` : `#${r.pick.i + 1} pick · past avg ${r.pick.pct >= 0 ? '+' : ''}${r.pick.pct.toFixed(1)}%` } : {})}
          />
        ))}
        {rows.length > limit && (
          <button class="btn" type="button" data-testid="show-all" onClick={() => setLimit(rows.length)}>
            Show all {rows.length} stocks
          </button>
        )}
      </section>
      )}
    </>
  );
}

function MyStocks({ go }: { go: Go }) {
  const watchlist = useLocal('watchlist') ?? [];
  const instruments = useInstruments();
  const byKey = useInstrumentMap();
  const { data } = useStocksData(watchlist);
  const lastPoll = useSessionValue('lastPoll');
  const [sort, setSort] = usePersistentState<SortKey>('stocks.sort', 'mine');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMsg(null);
    try {
      setMsg({ tone: 'ok', text: await fn() });
    } catch (err) {
      setMsg({ tone: 'err', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const sorted = useMemo(() => {
    const keys = [...watchlist];
    const snap = (k: string) => data.get(k)?.snapshot;
    if (sort === 'setup') keys.sort((a, b) => SETUP_ORDER.indexOf(snap(a)?.setup ?? 'No setup') - SETUP_ORDER.indexOf(snap(b)?.setup ?? 'No setup'));
    if (sort === 'change') keys.sort((a, b) => (snap(b)?.changePct ?? -999) - (snap(a)?.changePct ?? -999));
    if (sort === 'rsi') keys.sort((a, b) => (snap(b)?.rsi14 ?? -1) - (snap(a)?.rsi14 ?? -1));
    return keys;
  }, [watchlist, data, sort]);

  const move = (key: string, dir: -1 | 1) => {
    const i = watchlist.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= watchlist.length) return;
    const next = [...watchlist];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void setLocal('watchlist', next);
  };
  const remove = (key: string) => void setLocal('watchlist', watchlist.filter((k) => k !== key));
  const add = async (key: string) => {
    if (watchlist.includes(key)) return;
    await setLocal('watchlist', [...watchlist, key]);
    const sym = byKey.get(key)?.trading_symbol ?? key;
    await run('add', async () => {
      const r = await callBackground('stock:sync', { key });
      await callBackground('quotes:refresh').catch(() => undefined);
      return `${sym} added (${r.fetched} days of history).`;
    });
  };

  const missingHistory = watchlist.filter((k) => data.get(k) && !data.get(k)!.raw.length).length;

  return (
    <>
      {instruments !== null && instruments.length === 0 && (
        <div class="banner warn">
          The NSE stock list is not downloaded yet.{' '}
          <button class="btn small" type="button" disabled={!!busy} onClick={() => void run('inst', async () => `Stock list loaded: ${(await callBackground('instruments:refresh')).count} entries.`)}>
            Download now
          </button>
        </div>
      )}
      <section class="card">
        <AddStock onAdd={(k) => void add(k)} disabled={!instruments?.length} exclude={watchlist} />
        <div class="row" style={{ marginTop: '8px' }}>
          <button class="btn small primary" type="button" disabled={!!busy} onClick={() => void run('prices', async () => {
            const r = await callBackground('quotes:refresh');
            return r.skipped ? `Prices not refreshed: ${r.skipped}.` : `Prices updated for ${r.polled} stocks.`;
          })}>
            {busy === 'prices' ? 'Refreshing…' : 'Refresh prices'}
          </button>
          <button class="btn small" type="button" disabled={!!busy} onClick={() => void run('hist', async () => {
            const r = await callBackground('stocks:syncAll');
            return `History updated for ${r.ok} stocks${r.failed.length ? `, ${r.failed.length} failed (see Diagnostics)` : ''}.`;
          })}>
            {busy === 'hist' ? 'Updating history…' : 'Update history'}
          </button>
          <span class="spacer" />
          <select aria-label="Sort" value={sort} onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as SortKey)}>
            <option value="mine">My order</option>
            <option value="setup">Best setup first</option>
            <option value="change">Day % (high first)</option>
            <option value="rsi">RSI (high first)</option>
          </select>
        </div>
        <p class="small muted" style={{ marginBottom: 0 }}>
          Prices {lastPoll ? `updated ${formatTimeIST(lastPoll.at)} IST${lastPoll.ok ? '' : ` — last attempt failed: ${lastPoll.error}`}` : 'not loaded yet'} · refresh every 2 s while this panel is open in market hours.
        </p>
        {msg && <p class={`small ${msg.tone === 'ok' ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
        {missingHistory > 0 && !busy && <p class="small warn-text">{missingHistory} stock(s) have no price history yet — click "Update history".</p>}
      </section>

      <section class="list" data-testid="watchlist">
        {sorted.length === 0 && <div class="card empty">Your watchlist is empty. Search above to add stocks.</div>}
        {sorted.map((key) => (
          <StockRow
            symbol={byKey.get(key)?.trading_symbol ?? key}
            data={data.get(key)}
            onOpen={() => go('stock', key)}
            actions={
              <>
                {sort === 'mine' && (
                  <>
                    <button class="icon-btn" type="button" title="Move up" onClick={() => move(key, -1)}>↑</button>
                    <button class="icon-btn" type="button" title="Move down" onClick={() => move(key, 1)}>↓</button>
                  </>
                )}
                <button class="icon-btn" type="button" title="Remove from watchlist" onClick={() => remove(key)}>✕</button>
              </>
            }
          />
        ))}
      </section>
    </>
  );
}

export function AddStock({ onAdd, disabled, exclude = [] }: { onAdd: (key: string) => void; disabled?: boolean; exclude?: string[] }) {
  const instruments = useInstruments();
  const [q, setQ] = useState('');
  const results = useMemo(() => (instruments ? searchInstruments(instruments, q, 8).filter((i) => !exclude.includes(i.instrument_key)) : []), [instruments, q, exclude]);
  return (
    <div class="add-stock">
      <input
        type="search"
        placeholder={disabled ? 'Stock list loading…' : 'Add a stock: type a symbol or company name'}
        disabled={disabled}
        value={q}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
        aria-label="Search stocks"
      />
      {q && results.length > 0 && (
        <ul class="results" role="listbox">
          {results.map((i) => (
            <li>
              <button
                type="button"
                onClick={() => {
                  onAdd(i.instrument_key);
                  setQ('');
                }}
              >
                <b>{i.trading_symbol}</b> <span class="muted small">{i.short_name ?? i.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && results.length === 0 && instruments && <p class="small muted">No match.</p>}
    </div>
  );
}
