import { useState } from 'preact/hooks';

/**
 * App v1.7 (owner: "remember my selected filters and dropdown options"): a screen choice that
 * survives leaving the screen (memory) and restarting the app (this phone's local storage).
 */
const mem = new Map<string, unknown>();

function read<T>(key: string, initial: T): T {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = localStorage.getItem(`tb:${key}`);
    if (raw !== null) return JSON.parse(raw) as T;
  } catch {
    /* private mode / blocked storage: just use the default */
  }
  return initial;
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => read(key, initial));
  const set = (x: T) => {
    mem.set(key, x);
    try {
      localStorage.setItem(`tb:${key}`, JSON.stringify(x));
    } catch {
      /* not saved across restarts; still kept for this run */
    }
    setV(x);
  };
  return [v, set];
}

/** Scroll positions per screen for this run (restored when you come back from a stock page). */
export const scrollMemory = new Map<string, number>();
