import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Instrument } from '../data/instrumentsParse';
import type { Quote } from '../data/quotesParse';
import { invalidateStockCache, loadStockData, type StockData } from '../data/stockData';
import { getAllInstruments } from '../data/instruments';
import { useLocal, useNow, useSessionValue, useSettings } from './hooks';
import { memberKey } from '../data/universeParse';
import { buildScan, membersOf } from '../data/scanUniverse';

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

export interface StudyKeys {
  /** everything studied: the companies plus your own stocks */
  keys: string[];
  /** the companies studied by themselves (without your own stocks) */
  universeKeys: string[];
  listLabel: string;
  /** the stocks of the 5-minute past test (with all five indices: the Nifty 100 + your stocks) */
  testKeys: string[];
  testLabel: string;
}

/**
 * The companies the app studies by itself plus your own stocks. App v1.12: all five indices together
 * (Nifty 50, 100, Midcap 100, Smallcap 100, Nifty 500), each company once — same as the background.
 */
export function useStudyKeys(): StudyKeys {
  const scanLists = useLocal('scanLists');
  const watchlist = useLocal('watchlist') ?? [];
  return useMemo(() => {
    // same as background data/universe.ts: always all five indices (no single-index choice)
    const own = (u: string[]) => (watchlist.some((k) => !u.includes(k)) ? ' + your stocks' : '');
    const universeKeys = buildScan(scanLists).keys;
    const n100 = membersOf('nifty100', scanLists).map(memberKey);
    return {
      keys: [...new Set([...universeKeys, ...watchlist])],
      universeKeys,
      listLabel: `all five indices${own(universeKeys)}`,
      testKeys: [...new Set([...n100, ...watchlist])],
      testLabel: `the Nifty 100${own(n100)}`,
    };
  }, [scanLists?.at, watchlist.join(',')]);
}
