import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Milestone 4 — the app's notification layer: "in the app only", and taps that arrive before the screens. */

type Notifications = {
  create(id: string, o: object): Promise<string>;
  onClicked: { addListener(l: (id: string) => void): void; removeListener(l: (id: string) => void): void };
};
let shim: typeof import('../src/platform/chromeShim');
let n: Notifications;
const show = vi.fn(async () => undefined);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  // just enough of a page for the shim (it never appears on screen here)
  (globalThis as unknown as { document: unknown }).document = { visibilityState: 'hidden', addEventListener: () => undefined, baseURI: 'https://localhost/' };
  shim = await import('../src/platform/chromeShim');
  shim.installChromeShim('test');
  shim.setNotificationBackend({ show, clear: async () => undefined });
  n = (globalThis as unknown as { chrome: { notifications: Notifications } }).chrome.notifications;
});

afterAll(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

describe('notification shim', () => {
  it('"in the app only" (the server pushes it) never shows a second Android notification', async () => {
    await n.create('alert:rise-X-2026-11-19', { title: 'T', message: 'M', inAppOnly: true });
    expect(show).not.toHaveBeenCalled();
    await n.create('alert:rule-1:2', { title: 'Stop hit', message: 'M', requireInteraction: true });
    expect(show).toHaveBeenCalledWith('alert:rule-1:2', 'Stop hit', 'M', expect.objectContaining({ requireInteraction: true }));
  });

  it('a tap that starts the app waits for the screens; later taps go straight to them', () => {
    shim.notificationClicked('alert:bo-A-1');
    expect(shim.takePendingNotificationClick()).toBe('alert:bo-A-1');
    expect(shim.takePendingNotificationClick()).toBeNull();
    const opened: string[] = [];
    const l = (id: string) => void opened.push(id);
    n.onClicked.addListener(l);
    shim.notificationClicked('alert:bo-B-1');
    expect(opened).toEqual(['alert:bo-B-1']);
    expect(shim.takePendingNotificationClick()).toBeNull();
    n.onClicked.removeListener(l);
  });
});
