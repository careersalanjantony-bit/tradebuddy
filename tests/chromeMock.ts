import { vi } from 'vitest';

type Listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void;

/** Minimal in-memory chrome.* for service-worker logic tests. */
export function installChromeMock() {
  const listeners: Listener[] = [];
  const area = (name: string) => {
    const m = new Map<string, unknown>();
    return {
      map: m,
      async get(keys: string | string[] | null) {
        const list = keys === null ? [...m.keys()] : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (m.has(k)) out[k] = structuredClone(m.get(k));
        return out;
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: m.get(k), newValue: v };
          m.set(k, structuredClone(v));
        }
        listeners.forEach((l) => l(changes, name));
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
      },
    };
  };
  const mock = {
    storage: {
      local: area('local'),
      session: area('session'),
      onChanged: { addListener: (l: Listener) => listeners.push(l), removeListener: () => undefined },
    },
    notifications: { create: vi.fn(async (_id: string, _opts: { title?: string; requireInteraction?: boolean; priority?: number }) => 'id'), clear: vi.fn(async (_id: string) => true) },
    action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}`, id: 'test' },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = mock;
  return mock;
}
