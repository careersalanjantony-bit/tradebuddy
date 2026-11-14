import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { decodeFeedResponse, subscribeMessage, type FeedTick } from '../data/feedProto';
import { INDEX_KEYS } from '../data/indices';
import { getQuotes, trackedKeys } from '../data/quotes';
import { mergeTicks } from '../data/quotesParse';
import { chunk } from '../lib/chunk';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { getSettings } from '../storage/local';
import { setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';

/**
 * Instant prices (v0.12.0): Upstox Market Data Feed V3 over a WebSocket — "full" mode since app v1.9
 * (price, VWAP, today's volume, buy / sell quantities, 1-minute candles), "ltpc" for any extra keys —
 * docs checked 12 Nov 2026 (proto re-checked 14 Nov 2026):
 *   GET /v3/feed/market-data-feed/authorize → data.authorized_redirect_uri (a one-time wss:// address);
 *   after connecting, send {guid, method:"sub", data:{mode:"ltpc", instrumentKeys}} as a BINARY frame;
 *   messages are protobuf (see data/feedProto.ts). Limits: 2 connections, 5000 keys in ltpc mode.
 *
 * It is an extra: the day's open/high/low/volume still come from the normal poll every ~10–30 s, and
 * if the feed is not connected or silent, the 2-second polling simply continues. Read-only.
 */

const log = createLogger('feed');
const FLUSH_MS = 1_000;
const RETRY_MS = 30_000;
const FRESH_MS = 5_000;

let ws: WebSocket | null = null;
let connecting = false;
let subscribed = new Set<string>();
let watched = new Set<string>();
const pending = new Map<string, FeedTick>();
let lastTickAt = 0;
let lastAttemptAt = 0;
let lastStatusAt = 0;
let lastError: string | undefined;
let badMessages = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let onFlush: ((now: number) => Promise<void>) | null = null;

/** Called after new prices were stored (dataJobs registers the alert / signal checks here). */
export function setFeedListener(fn: (now: number) => Promise<void>): void {
  onFlush = fn;
}

/** A feed address is accepted only if it is wss:// on upstox.com or one of its sub-domains. */
export function isUpstoxFeedUrl(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'wss:' && (u.hostname === 'upstox.com' || u.hostname.endsWith('.upstox.com'));
  } catch {
    return false;
  }
}

/** True while ticks are arriving (then the 2-second price polls are not needed). */
export const feedFresh = (now = Date.now()): boolean => !!ws && ws.readyState === WebSocket.OPEN && now - lastTickAt < FRESH_MS;

async function status(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastStatusAt < 5_000) return;
  lastStatusAt = now;
  await setSession('feedStatus', { connected: !!ws && ws.readyState === WebSocket.OPEN, lastTickAt, at: now, keys: subscribed.size, ...(lastError ? { error: lastError } : {}) });
}

export function closeFeed(reason: string): void {
  if (!ws) return;
  const sock = ws;
  ws = null;
  subscribed = new Set();
  fullKeys = new Set();
  try {
    sock.close(1000, reason);
  } catch {
    /* already closed */
  }
  void status(true);
}

/**
 * App v1.9: the first FULL_KEYS stocks are asked for in "full" mode (adds VWAP, today's volume, the
 * waiting buy / sell quantities and 1-minute candles — needed for live breakout alerts); the rest
 * in "ltpc" mode (price only). Upstox allows fewer keys in full mode than in ltpc mode.
 */
export const FULL_KEYS = 1500;

/** stocks asked for in "full" mode right now, and how many may be ("Save mobile data" → none) */
let fullKeys = new Set<string>();
let fullRoom = FULL_KEYS;

/**
 * Brings the subscription in line with `keys`: new stocks are added, old ones removed, and a stock
 * whose mode should change (the "Save mobile data" switch) is moved with Upstox's change_mode.
 */
function resubscribe(sock: WebSocket, keys: string[]): void {
  const want = new Set(keys);
  const remove = [...subscribed].filter((k) => !want.has(k));
  for (const part of chunk(remove, 500)) sock.send(subscribeMessage(part, 'unsub'));
  const wantFull = new Set(keys.slice(0, fullRoom));
  const add = keys.filter((k) => !subscribed.has(k));
  const addFull = add.filter((k) => wantFull.has(k));
  const addPlain = add.filter((k) => !wantFull.has(k));
  const toFull = keys.filter((k) => subscribed.has(k) && wantFull.has(k) && !fullKeys.has(k));
  const toPlain = keys.filter((k) => subscribed.has(k) && !wantFull.has(k) && fullKeys.has(k));
  for (const part of chunk(addFull, 500)) sock.send(subscribeMessage(part, 'sub', undefined, 'full'));
  for (const part of chunk(addPlain, 500)) sock.send(subscribeMessage(part, 'sub', undefined, 'ltpc'));
  for (const part of chunk(toFull, 500)) sock.send(subscribeMessage(part, 'change_mode', undefined, 'full'));
  for (const part of chunk(toPlain, 500)) sock.send(subscribeMessage(part, 'change_mode', undefined, 'ltpc'));
  subscribed = want;
  fullKeys = wantFull;
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (!pending.size) return;
  const ticks = [...pending.values()];
  pending.clear();
  const now = Date.now();
  try {
    const { quotes, updated } = mergeTicks(await getQuotes(), ticks, watched, now);
    if (!updated) return;
    await setSession('quotes', quotes);
    await setSession('lastPoll', { at: now, ok: true, count: updated });
    await status();
    await onFlush?.(now);
  } catch (err) {
    log.warn('Could not store live prices', { error: errorMessage(err) });
  }
}

function open(uri: string, keys: string[]): void {
  const sock = new WebSocket(uri);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    subscribed = new Set();
    fullKeys = new Set();
    lastError = undefined;
    badMessages = 0;
    resubscribe(sock, keys);
    log.info(`Instant price feed connected (${keys.length} stocks)`);
    void status(true);
  };
  sock.onmessage = (e: MessageEvent) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    try {
      const d = decodeFeedResponse(new Uint8Array(e.data));
      if (!d.ticks.length) return;
      for (const t of d.ticks) pending.set(t.key, t);
      lastTickAt = Date.now();
      flushTimer ??= setTimeout(() => void flush(), FLUSH_MS);
    } catch (err) {
      if (++badMessages === 1) log.warn('A live price message could not be read (ignored)', { error: errorMessage(err) });
    }
  };
  sock.onerror = () => {
    lastError = 'connection error';
  };
  sock.onclose = (e: CloseEvent) => {
    if (ws === sock) {
      ws = null;
      subscribed = new Set();
      if (e.code !== 1000) lastError = `closed (${e.code})`;
      log.info(`Instant price feed closed (${e.code})`);
      void status(true);
    }
  };
}

/**
 * Keeps the feed connected while the market is open (called on every price check, at least every
 * 30 s). `force` connects at any time (Diagnostics "test" button). Returns the state in one word.
 */
export async function ensureFeed(now = Date.now(), force = false): Promise<string> {
  const settings = await getSettings();
  if (!settings.data.liveFeed) {
    closeFeed('off');
    return 'off';
  }
  const m = marketState(now, await getCalendar());
  if (m.phase !== 'open' && m.phase !== 'pre_open' && !force) {
    closeFeed('market closed');
    return 'market closed';
  }
  const keys = [...(await trackedKeys()), ...INDEX_KEYS];
  watched = new Set(keys);
  // full details (volume, VWAP, 1-minute candles) for breakout alerts, unless "Save mobile data" is on
  fullRoom = settings.data.saveData ? 0 : FULL_KEYS;
  if (ws && ws.readyState === WebSocket.OPEN) {
    resubscribe(ws, keys);
    return 'connected';
  }
  if (connecting || (ws && ws.readyState === WebSocket.CONNECTING)) return 'connecting';
  if (!force && now - lastAttemptAt < RETRY_MS) return 'waiting';
  lastAttemptAt = now;
  connecting = true;
  try {
    const data = await upstoxRequest<{ authorized_redirect_uri?: unknown; authorizedRedirectUri?: unknown }>('/v3/feed/market-data-feed/authorize', { tokenKind: 'market', attempts: 1 });
    const uri = data?.authorized_redirect_uri ?? data?.authorizedRedirectUri;
    // only ever connect to Upstox itself, over an encrypted connection (the address is never logged: it holds a one-time code)
    if (typeof uri !== 'string' || !isUpstoxFeedUrl(uri)) throw new Error('Upstox gave no feed address');
    open(uri, keys);
    return 'connecting';
  } catch (err) {
    lastError = errorMessage(err);
    log.info('Instant price feed not available — normal 2-second updates continue', { reason: lastError });
    await status(true);
    return 'failed';
  } finally {
    connecting = false;
  }
}
