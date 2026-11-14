import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../storage/defaults';
import { getLocal, getSettings, onLocalChanged } from '../storage/local';
import { mergeWithDefaults } from '../storage/merge';
import type { LocalKey, LocalStore, Settings } from '../storage/schema';
import { getSession, onSessionChanged, type SessionKey, type SessionStore } from '../storage/session';
import { marketState, type MarketState } from '../data/calendar';

/** the last value seen per key: a screen opened again shows it at once instead of flickering (app v1.9) */
const localSeen = new Map<LocalKey, unknown>();

/** Live view of one chrome.storage.local key. `undefined` while loading or when unset. */
export function useLocal<K extends LocalKey>(key: K): LocalStore[K] | undefined {
  const [value, setValue] = useState<LocalStore[K] | undefined>(() => localSeen.get(key) as LocalStore[K] | undefined);
  useEffect(() => {
    let alive = true;
    void getLocal(key).then((v) => {
      localSeen.set(key, v);
      if (alive) setValue(v);
    });
    const off = onLocalChanged(key, (v) => {
      localSeen.set(key, v);
      setValue(v);
    });
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return value;
}

/** Live, defaults-merged settings. */
export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => alive && setSettings(s));
    const off = onLocalChanged('settings', (v) => setSettings(mergeWithDefaults(DEFAULT_SETTINGS, v)));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return settings;
}

/** Re-renders every `ms` milliseconds; returns the current time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Hash routes like "#/stock/NSE_EQ%7CINE002A01018": [screen, param, go]. */
export function useHashRoute<T extends string>(valid: readonly T[], fallback: T, onLeave?: (from: T) => void): [T, string | null, (r: T, param?: string | null) => void] {
  const read = (): [T, string | null] => {
    const [screen, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    const r = (valid as readonly string[]).includes(screen ?? '') ? (screen as T) : fallback;
    const param = rest.length ? decodeURIComponent(rest.join('/')) : null;
    return [r, param];
  };
  const [route, setRoute] = useState<[T, string | null]>(read);
  // the screen being left, told before the new one is drawn (app v1.7: its scroll position is kept)
  const current = useRef(route[0]);
  current.current = route[0];
  const leave = useRef(onLeave);
  leave.current = onLeave;
  useEffect(() => {
    const onHash = () => {
      leave.current?.(current.current);
      setRoute(read());
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return [route[0], route[1], (r: T, param?: string | null) => (location.hash = param ? `/${r}/${encodeURIComponent(param)}` : `/${r}`)];
}

/** Live view of one chrome.storage.session key. */
export function useSessionValue<K extends SessionKey>(key: K): SessionStore[K] | undefined {
  const [value, setValue] = useState<SessionStore[K] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void getSession(key).then((v) => alive && setValue(v));
    const off = onSessionChanged(key, (v) => setValue(v));
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return value;
}

/** Current NSE market state from the stored holiday list; re-evaluated every 15 s. */
export function useMarketState(): MarketState {
  const cal = useLocal('marketCalendar');
  const now = useNow(15_000);
  return marketState(now, cal ?? null);
}
