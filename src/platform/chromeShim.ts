/* eslint-disable @typescript-eslint/no-explicit-any */
import { openDB, type IDBPDatabase } from 'idb';
import { appOnScreen } from './appState';

/**
 * TradeBuddy started as a Chrome extension. Its tested logic talks to a handful of `chrome.*` APIs
 * (storage, messages, alarms, notifications, login window). In the app those are provided here, on
 * top of what a phone has:
 *
 *   chrome.storage.local    → IndexedDB inside the app (kept on the phone, survives restarts)
 *   chrome.storage.session  → memory (cleared when the app is closed, like Chrome's session storage)
 *   chrome.runtime messages → a direct call inside the same page (the "background" runs in the app)
 *   chrome.alarms           → a 1-second timer that runs while the app is running
 *   chrome.notifications    → Android notifications (native) or browser notifications (web)
 *   chrome.identity         → the Upstox login page in an in-app browser
 *
 * Everything stays on the phone. Nothing is sent anywhere except Upstox and NSE.
 */

type Listener = (...args: any[]) => any;

class Event<L extends Listener> {
  private ls = new Set<L>();
  addListener(l: L): void {
    this.ls.add(l);
  }
  removeListener(l: L): void {
    this.ls.delete(l);
  }
  hasListener(l: L): boolean {
    return this.ls.has(l);
  }
  get listeners(): L[] {
    return [...this.ls];
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function keyList(keys: unknown, all: Map<string, unknown>): { list: string[]; defaults: Record<string, unknown> } {
  if (keys == null) return { list: [...all.keys()], defaults: {} };
  if (typeof keys === 'string') return { list: [keys], defaults: {} };
  if (Array.isArray(keys)) return { list: keys as string[], defaults: {} };
  return { list: Object.keys(keys as object), defaults: keys as Record<string, unknown> };
}

const storageChanged = new Event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>();

class Area {
  readonly data = new Map<string, unknown>();
  readonly onChanged = new Event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void>();
  constructor(
    private name: 'local' | 'session',
    private persist?: { put(k: string, v: unknown): Promise<void>; del(k: string): Promise<void>; clear(): Promise<void> },
    private ready: Promise<void> = Promise.resolve(),
  ) {}

  private fire(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): void {
    if (!Object.keys(changes).length) return;
    for (const l of this.onChanged.listeners) queueMicrotask(() => l(clone(changes)));
    for (const l of storageChanged.listeners) queueMicrotask(() => l(clone(changes), this.name));
  }

  async get(keys?: unknown): Promise<Record<string, unknown>> {
    await this.ready;
    const { list, defaults } = keyList(keys, this.data);
    const out: Record<string, unknown> = {};
    for (const k of list) {
      if (this.data.has(k)) out[k] = clone(this.data.get(k));
      else if (k in defaults) out[k] = defaults[k];
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await this.ready;
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items)) {
      if (v === undefined) continue;
      const old = this.data.get(k);
      const nv = clone(v);
      this.data.set(k, nv);
      changes[k] = { ...(old !== undefined ? { oldValue: old } : {}), newValue: clone(nv) };
      await this.persist?.put(k, nv);
    }
    this.fire(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
    await this.ready;
    const changes: Record<string, { oldValue?: unknown }> = {};
    for (const k of typeof keys === 'string' ? [keys] : keys) {
      if (!this.data.has(k)) continue;
      changes[k] = { oldValue: this.data.get(k) };
      this.data.delete(k);
      await this.persist?.del(k);
    }
    this.fire(changes);
  }

  async clear(): Promise<void> {
    await this.ready;
    const changes: Record<string, { oldValue?: unknown }> = {};
    for (const [k, v] of this.data) changes[k] = { oldValue: v };
    this.data.clear();
    await this.persist?.clear();
    this.fire(changes);
  }

  async getBytesInUse(): Promise<number> {
    await this.ready;
    let n = 0;
    for (const [k, v] of this.data) n += k.length + (JSON.stringify(v)?.length ?? 0);
    return n;
  }

  async setAccessLevel(): Promise<void> {
    /* not needed in the app */
  }
}

// ---------- persistent local storage (IndexedDB "tradebuddy-kv")
let kvDb: IDBPDatabase | null = null;
const local = new Area(
  'local',
  {
    put: async (k, v) => {
      await kvDb?.put('kv', v, k);
    },
    del: async (k) => {
      await kvDb?.delete('kv', k);
    },
    clear: async () => {
      await kvDb?.clear('kv');
    },
  },
  (async () => {
    try {
      kvDb = await openDB('tradebuddy-kv', 1, {
        upgrade(db) {
          db.createObjectStore('kv');
        },
      });
      const keys = await kvDb.getAllKeys('kv');
      const values = await kvDb.getAll('kv');
      keys.forEach((k, i) => local.data.set(String(k), values[i]));
    } catch (err) {
      console.error('TradeBuddy: could not open app storage', err);
    }
  })(),
);
const session = new Area('session');

// ---------- runtime + messages
const APP_ID = 'tradebuddy-app';
const onMessage = new Event<(msg: unknown, sender: { id: string }, sendResponse: (r?: unknown) => void) => boolean | void>();

function sendMessage(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let answered = false;
    let waiting = false;
    const respond = (r?: unknown) => {
      if (answered) return;
      answered = true;
      resolve(clone(r));
    };
    for (const l of onMessage.listeners) {
      try {
        if (l(clone(msg), { id: APP_ID }, respond) === true) waiting = true;
      } catch (err) {
        console.error('TradeBuddy: message handler failed', err);
      }
      if (answered) return;
    }
    if (!waiting) respond(undefined);
  });
}

// ---------- alarms (1-second ticker; only while the app is running)
interface Alarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}
const alarms = new Map<string, Alarm>();
const onAlarm = new Event<(a: Alarm) => void>();
function tickAlarms(): void {
  const now = Date.now();
  for (const a of [...alarms.values()]) {
    if (a.scheduledTime > now) continue;
    if (a.periodInMinutes) {
      const period = a.periodInMinutes * 60_000;
      // skip missed periods instead of firing them all
      let next = a.scheduledTime + period;
      if (next <= now) next = now + period;
      alarms.set(a.name, { ...a, scheduledTime: next });
    } else {
      alarms.delete(a.name);
    }
    for (const l of onAlarm.listeners) {
      try {
        l({ ...a });
      } catch (err) {
        console.error('TradeBuddy: alarm handler failed', err);
      }
    }
  }
}

// ---------- notifications
const onNotificationClicked = new Event<(id: string) => void>();
const shownNotifications = new Map<string, { title: string; message: string }>();
export interface NotificationBackend {
  show(id: string, title: string, message: string, opts: { requireInteraction?: boolean; priority?: number; onScreen?: boolean }): Promise<void>;
  clear(id: string): Promise<void>;
  /** app v1.18: remove every notification of the app from the phone's list */
  clearAll?(): Promise<void>;
}
let notificationBackend: NotificationBackend = {
  async show(id, title, message, opts) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body: message, tag: id, requireInteraction: !!opts.requireInteraction });
    n.onclick = () => {
      window.focus();
      for (const l of onNotificationClicked.listeners) l(id);
    };
  },
  async clear() {
    /* browser notifications close themselves */
  },
};
/** Window event for alerts shown inside the app (detail: { id, title, message, at }). */
export const ALERT_EVENT = 'tb-alert';
export function setNotificationBackend(b: NotificationBackend): void {
  notificationBackend = b;
}
/** milestone 4: a tap that came before the screens were ready (the tap started the app) waits here */
let pendingClick: string | null = null;
export function notificationClicked(id: string): void {
  shownNotifications.delete(id);
  const ls = onNotificationClicked.listeners;
  if (!ls.length) {
    pendingClick = id;
    return;
  }
  for (const l of ls) l(id);
}
/** The tap that started the app, once (the screens ask for it when they are ready). */
export function takePendingNotificationClick(): string | null {
  const id = pendingClick;
  pendingClick = null;
  return id;
}

// ---------- identity (Upstox login window)
/** The login address registered in the owner's Upstox app (the extension's, so nothing has to change there). */
export const DEFAULT_REDIRECT_BASE = 'https://joalpejfcchnfbcjacmijbmmbmmnobio.chromiumapp.org/';
let redirectBase = DEFAULT_REDIRECT_BASE;
export function setRedirectBase(url: string | null | undefined): void {
  const v = (url ?? '').trim();
  redirectBase = v ? (v.endsWith('/') ? v : `${v}/`) : DEFAULT_REDIRECT_BASE;
}
export type AuthFlowRunner = (url: string, redirectPrefix: string) => Promise<string>;
let authFlow: AuthFlowRunner = (url, redirectPrefix) =>
  new Promise<string>((resolve, reject) => {
    // Browser (development / tests): a popup; the redirect page posts its address back.
    const popup = window.open(url, 'upstox-login', 'width=480,height=760');
    if (!popup) return reject(new Error('The login window could not be loaded (pop-up blocked).'));
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === 'tb-oauth' && typeof d.url === 'string' && d.url.startsWith(redirectPrefix)) {
        cleanup();
        try {
          popup.close();
        } catch {
          /* ignore */
        }
        resolve(d.url);
      }
    };
    const timer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error('The user did not approve access.'));
      }
    }, 500);
    const cleanup = () => {
      clearInterval(timer);
      window.removeEventListener('message', onMsg);
    };
    window.addEventListener('message', onMsg);
  });
export function setAuthFlowRunner(r: AuthFlowRunner): void {
  authFlow = r;
}

// ---------- badge (shown in the app header instead of a toolbar icon)
export const badge = { text: '', listeners: new Set<(t: string) => void>() };

// ---------- install
let installed = false;
export const storageReady = (local as any).ready as Promise<void>;

export function installChromeShim(version: string): void {
  if (installed) return;
  installed = true;
  const chromeApi: any = {
    storage: { local, session, onChanged: storageChanged },
    runtime: {
      id: APP_ID,
      lastError: undefined,
      getManifest: () => ({ name: 'TradeBuddy', version, manifest_version: 3 }),
      getURL: (p: string) => new URL(p.replace(/^\//, ''), document.baseURI).toString(),
      sendMessage,
      onMessage,
      onStartup: new Event(),
      onInstalled: new Event(),
      getContexts: async () => [],
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL', POPUP: 'POPUP' },
    },
    alarms: {
      create: async (name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }) => {
        const when = info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
        alarms.set(name, { name, scheduledTime: when, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) });
      },
      get: async (name: string) => (alarms.has(name) ? { ...alarms.get(name)! } : undefined),
      getAll: async () => [...alarms.values()].map((a) => ({ ...a })),
      clear: async (name: string) => alarms.delete(name),
      clearAll: async () => {
        alarms.clear();
        return true;
      },
      onAlarm,
    },
    notifications: {
      create: async (id: string, o: { title: string; message: string; requireInteraction?: boolean; priority?: number; inAppOnly?: boolean }) => {
        shownNotifications.set(id, { title: o.title, message: o.message });
        // app v1.9: on screen → the app shows the alert itself (a banner at the top, with the chosen tone)
        const onScreen = appOnScreen();
        if (onScreen) window.dispatchEvent(new CustomEvent(ALERT_EVENT, { detail: { id, title: o.title, message: o.message, at: Date.now() } }));
        // milestone 4: the server pushes this alert (cloud alerts on) — no second copy from the phone
        if (o.inAppOnly) return id;
        await notificationBackend.show(id, o.title, o.message, { ...(o.requireInteraction ? { requireInteraction: true } : {}), ...(o.priority !== undefined ? { priority: o.priority } : {}), onScreen });
        return id;
      },
      clear: async (id: string) => {
        const had = shownNotifications.delete(id);
        await notificationBackend.clear(id);
        return had;
      },
      getAll: async () => Object.fromEntries([...shownNotifications.keys()].map((k) => [k, true])),
      /** app v1.18 (not a Chrome API): Alerts tab "Clear all" */
      clearAll: async () => {
        const ids = [...shownNotifications.keys()];
        shownNotifications.clear();
        if (notificationBackend.clearAll) await notificationBackend.clearAll();
        else for (const id of ids) await notificationBackend.clear(id);
      },
      onClicked: onNotificationClicked,
    },
    identity: {
      getRedirectURL: (path = '') => redirectBase + path.replace(/^\//, ''),
      launchWebAuthFlow: async ({ url }: { url: string }) => authFlow(url, redirectBase),
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        badge.text = text;
        for (const l of badge.listeners) l(text);
      },
      setBadgeBackgroundColor: async () => undefined,
    },
    sidePanel: { open: async () => undefined, setPanelBehavior: async () => undefined },
    windows: { getLastFocused: async () => ({ id: 1 }), getCurrent: async () => ({ id: 1 }) },
    tabs: {
      create: async ({ url }: { url: string }) => {
        const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
        if (hash) location.hash = hash;
        else window.open(url, '_blank');
      },
    },
    offscreen: { createDocument: async () => undefined, Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' } },
  };
  (globalThis as any).chrome = chromeApi;
  setInterval(tickAlarms, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tickAlarms();
  });
}

/** First start / update / normal start, like Chrome's onInstalled + onStartup. */
export async function fireStartupEvents(version: string): Promise<void> {
  const c = (globalThis as any).chrome;
  const prev = (await local.get('__appVersion')).__appVersion as string | undefined;
  if (prev !== version) await local.set({ __appVersion: version });
  if (!prev) for (const l of (c.runtime.onInstalled as Event<Listener>).listeners) l({ reason: 'install' });
  else if (prev !== version) for (const l of (c.runtime.onInstalled as Event<Listener>).listeners) l({ reason: 'update', previousVersion: prev });
  else for (const l of (c.runtime.onStartup as Event<Listener>).listeners) l();
}
