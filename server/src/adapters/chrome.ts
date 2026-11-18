import type { ChangeHub, SqliteKV } from '../storage/kv';

/**
 * The few Chrome extension calls the shared code makes, answered on the server:
 *  - storage.local / storage.session / storage.onChanged → SQLite (storage/kv.ts)
 *  - notifications → the server's notification service (logged now; push in a later milestone)
 *  - action badge → nothing to show on a server
 *  - runtime → version and id only
 *  - alarms → engine/alarms.ts (persistent, milestone 3), when the app's jobs run on the server
 */

export interface ChromeAdapterOptions {
  local: SqliteKV;
  session: SqliteKV;
  hub: ChangeHub;
  version: string;
  notify?: (id: string, options: { title?: string; message?: string }) => void;
  /** milestone 3: chrome.alarms (engine/alarms.ts) */
  alarms?: unknown;
}

const area = (kv: SqliteKV) => ({
  get: (keys?: string | string[] | Record<string, unknown> | null) => kv.get(keys),
  set: (items: Record<string, unknown>) => kv.set(items),
  remove: (keys: string | string[]) => kv.remove(keys),
  clear: () => kv.clear(),
});

const noopEvent = { addListener: () => undefined, removeListener: () => undefined, hasListener: () => false };

/** Installs `globalThis.chrome`; returns a function that puts back what was there before. */
export function installChrome(o: ChromeAdapterOptions): () => void {
  const g = globalThis as { chrome?: unknown };
  const previous = g.chrome;
  g.chrome = {
    storage: { local: area(o.local), session: area(o.session), onChanged: o.hub },
    ...(o.alarms ? { alarms: o.alarms } : {}),
    notifications: {
      create: async (id: string, options: { title?: string; message?: string }) => {
        o.notify?.(id, options);
        return id;
      },
      clear: async () => true,
      onClicked: noopEvent,
    },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    runtime: {
      id: 'tradebuddy-server',
      getManifest: () => ({ manifest_version: 3, name: 'TradeBuddy server', version: o.version }),
      getURL: (path: string) => path,
      onMessage: noopEvent,
      sendMessage: async () => undefined,
    },
  };
  return () => {
    g.chrome = previous;
  };
}
