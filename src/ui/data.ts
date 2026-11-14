import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Instrument } from '../data/instrumentsParse';
import type { Quote } from '../data/quotesParse';
import { invalidateStockCache, loadStockData, type StockData } from '../data/stockData';
import { getAllInstruments } from '../data/instruments';
import { useLocal, useNow, useSessionValue, useSettings } from './hooks';
import { BUNDLED } from '../data/indexLists';
import { INDEX_LABEL, memberKey } from '../data/universeParse';

/** Must match background/dataJobs.ts DATA_CHANNEL (not imported, to keep SW code out of pages). */
const DATA_CHANNEL = 'swing-data';

/** Increments whenever the service worker stores new candles / instruments. */
export function useDataVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const ch = new BroadcastChannel(DATA_CHANNEL);
    // During a history download a message arrives for every stock: update at most about once a second.
    let timer: ReturnType<typeof setTimeout> | null = null;
    ch.onmessage = (e: MessageEvent<{ type: string; key?: string }>) => {
      if (e.data?.type === 'quotes') return;
      if (e.data?.type === 'candles') invalidateStockCache(e.data.key);
      timer ??= setTimeout(() => {
        timer = null;
        setV((x) => x + 1);
      }, 900);
    };
    return () => {
      if (timer) clearTimeout(timer);
      ch.close();
    };
  }, []);
  return v;
}

export function useQuotes(): Record<string, Quote> {
  return useSessionValue('quotes') ?? {};
}

let instrumentCache: Instrument[] | null = null;

export function useInstruments(): Instrument[] | null {
  const version = useDataVersion();
  const [list, setList] = useState<Instrument[] | null>(instrumentCache);
  useEffect(() => {
    let alive = true;
    void getAllInstruments().then((l) => {
      instrumentCache = l;
      if (alive) setList(l);
    });
    return () => {
      alive = false;
    };
  }, [version]);
  return list;
}

export function useInstrumentMap(): Map<string, Instrument> {
  const list = useInstruments();
  return useMemo(() => new Map((list ?? []).map((i) => [i.instrument_key, i])), [list]);
}

/**
 * The last computed data per list (app v1.7): a screen you come back to shows its list at once — at
 * full length, so the scroll position can be restored — and refreshes it in the background.
 */
const lastData = new Map<string, Map<string, StockData>>();

/** Computed data for many stocks; recomputes on new quotes, new candles, settings or minute ticks. */
export function useStocksData(keys: string[]): { data: Map<string, StockData>; loading: boolean } {
  const settings = useSettings();
  const cal = useLocal('marketCalendar');
  const quotes = useQuotes();
  const version = useDataVersion();
  const minute = Math.floor(useNow(30_000) / 60_000);
  const keyStr = keys.join(',');
  const [state, setState] = useState<{ data: Map<string, StockData>; loading: boolean }>(() => {
    const cached = lastData.get(keyStr);
    return cached ? { data: cached, loading: false } : { data: new Map(), loading: true };
  });
  const quoteStamp = keys.map((k) => quotes[k]?.fetchedAt ?? 0).join(',');

  // A newer load may start before an older one finishes (prices arrive every 2 s). Every finished load
  // is shown unless a NEWER one was already shown — so the list never waits for the updates to stop.
  const run = useRef({ started: 0, shown: 0, keys: '' });
  useEffect(() => {
    if (!settings) return;
    let unmounted = false;
    if (run.current.keys !== keyStr) run.current = { started: run.current.started, shown: run.current.started, keys: keyStr };
    const id = ++run.current.started;
    void Promise.all(keys.map((k) => loadStockData(k, { quote: quotes[k] ?? null, settings, calendar: cal ?? null }).catch(() => null))).then((rows) => {
      if (unmounted || id < run.current.shown || run.current.keys !== keyStr) return;
      run.current.shown = id;
      const m = new Map<string, StockData>();
      rows.forEach((r) => r && m.set(r.key, r));
      lastData.delete(keyStr);
      lastData.set(keyStr, m);
      while (lastData.size > 6) lastData.delete(lastData.keys().next().value!);
      setState({ data: m, loading: false });
    });
    return () => {
      unmounted = true;
    };
  }, [keyStr, quoteStamp, version, settings, cal, minute]);
  return state;
}

export function useStockData(key: string | null): { data: StockData | null; loading: boolean } {
  const keys = useMemo(() => (key ? [key] : []), [key]);
  const { data, loading } = useStocksData(keys);
  return { data: key ? (data.get(key) ?? null) : null, loading };
}

/** The companies the extension studies by itself (Nifty 50/100) plus your own stocks. */
export function useStudyKeys(): { keys: string[]; universeKeys: string[]; listLabel: string } {
  const settings = useSettings();
  const universe = useLocal('universe');
  const watchlist = useLocal('watchlist') ?? [];
  return useMemo(() => {
    const index = settings?.scanner.universe ?? 'nifty100';
    if (index === 'watchlist') return { keys: watchlist, universeKeys: [], listLabel: 'your stocks' };
    const members = universe && universe.index === index ? universe.members : (BUNDLED[index] ?? BUNDLED.nifty100);
    const universeKeys = members.map(memberKey);
    const keys = [...new Set([...universeKeys, ...watchlist])];
    return { keys, universeKeys, listLabel: `${INDEX_LABEL[index]}${watchlist.some((k) => !universeKeys.includes(k)) ? ' + your stocks' : ''}` };
  }, [settings?.scanner.universe, universe, watchlist.join(',')]);
}
