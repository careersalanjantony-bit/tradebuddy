import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { startServer, type RunningServer } from '../src/engine';
import { getJson, logCapture, tempDir, testConfig } from './helpers';

/**
 * Milestone 2, end to end: the app's own feed code (src/background/feed.ts) running on the server
 * against a stand-in for Upstox — authorise over HTTPS (stubbed fetch), connect, subscribe, receive a
 * protobuf price, store it, serve it over the REST API; then a dead connection (no pong) is detected
 * by the heartbeat and replaced; and the feed is closed when the market closes.
 */

const root = new protobuf.Root();
root.addJSON((protobuf.common.get('google/protobuf/wrappers.proto') as { nested: Record<string, protobuf.AnyNestedObject> }).nested);
protobuf.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/MarketDataFeed.proto', import.meta.url)), 'utf8'), root, { keepCase: true });
root.resolveAll();
const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
const encode = (obj: object): Uint8Array => FeedResponse.encode(FeedResponse.fromObject(obj)).finish();

const NIFTY = 'NSE_INDEX|Nifty 50';
const OPEN = Date.parse('2026-11-17T04:30:00Z'); // Tuesday 10:00 IST

let wss: WebSocketServer;
let wsPort = 0;
const conns: ServerSocket[] = [];
const subs: Array<{ method: string; data: { mode?: string; instrumentKeys: string[] } }> = [];
let answerPings = true;
let server: RunningServer;
const tmp = tempDir();
const logs = logCapture();
const authorizeCalls: string[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: OPEN });
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wsPort = (wss.address() as AddressInfo).port;
  wss.on('connection', (sock) => {
    conns.push(sock);
    sock.on('ping', (data) => {
      if (answerPings) sock.pong(data);
    });
    sock.on('message', (data) => subs.push(JSON.parse(String(data))));
    // Upstox sends the market status first on every connection
    sock.send(encode({ type: 2, currentTs: Date.now(), marketInfo: { segmentStatus: { NSE_EQ: 2, NSE_INDEX: 2 } } }));
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1')) return realFetch(u, init); // the test's own calls to the server API
      if (u.startsWith('https://api.upstox.com/v3/feed/market-data-feed/authorize')) {
        authorizeCalls.push(u);
        return new Response(JSON.stringify({ status: 'success', data: { authorized_redirect_uri: 'wss://wsfeeder-api.upstox.com/market-data-feeder/v3/upstox-developer-api/feeds?requestId=x&code=one-time' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'error', errors: [{ message: 'not in this test' }] }), { status: 404 });
    }),
  );
  server = await startServer(testConfig(tmp.dir, { upstoxAnalyticsToken: 'analytics-token-for-tests', liveFeed: true }), {
    write: logs.write,
    startTasks: false,
    feed: { rewriteUrl: () => `ws://127.0.0.1:${wsPort}`, pingMs: 150, pongTimeoutMs: 150, staleMs: 90_000 },
  });
});

afterAll(async () => {
  await server?.close('test end');
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});

describe('live Upstox feed on the server', () => {
  it('connects in market hours and subscribes the studied stocks in "full" mode', async () => {
    const feed = server.feed!;
    expect(await feed.check()).toBe('connecting');
    expect(authorizeCalls).toHaveLength(1);
    await vi.waitFor(() => expect(subs.length).toBeGreaterThan(0), { timeout: 5000 });
    const keys = subs.filter((s) => s.method === 'sub').flatMap((s) => s.data.instrumentKeys);
    expect(subs[0]).toMatchObject({ method: 'sub', data: { mode: 'full' } });
    expect(keys).toContain(NIFTY);
    expect(keys.length).toBeGreaterThan(400); // the five Nifty lists, from the bundled copy
    expect(await feed.check()).toBe('connected');
    expect(feed.health()).toMatchObject({ connected: true, connects: 1 });
  });

  it('stores a price from the feed and serves it over the REST API', async () => {
    conns[0]!.send(encode({ type: 1, currentTs: Date.now(), feeds: { [NIFTY]: { ltpc: { ltp: 25123.45, ltt: Date.now(), ltq: 0, cp: 25010.1 } } } }));
    await vi.waitFor(
      async () => {
        const r = await getJson(server.port, `/v1/quotes/${encodeURIComponent(NIFTY)}`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ key: NIFTY, ltp: 25123.45, prevClose: 25010.1 });
      },
      { timeout: 5000, interval: 200 },
    );
    // the feed code writes its status at most every 5 s: the next price after that shows in the health record
    vi.setSystemTime(Date.now() + 6_000);
    conns[0]!.send(encode({ type: 1, currentTs: Date.now(), feeds: { [NIFTY]: { ltpc: { ltp: 25130.5, ltt: Date.now(), ltq: 0, cp: 25010.1 } } } }));
    await vi.waitFor(
      async () => {
        await server.feed!.check();
        expect(server.feed!.health().lastTickAt).not.toBeNull();
      },
      { timeout: 5000, interval: 200 },
    );
    const h = server.feed!.health();
    expect(h.lastTickAgeMs).toBeLessThan(5_000);
    expect(h.socket.messages).toBeGreaterThanOrEqual(3);
    expect((await getJson(server.port, `/v1/quotes/${encodeURIComponent(NIFTY)}`)).body.ltp).toBe(25130.5);
  });

  it('a connection that stops answering pings is closed by the heartbeat and replaced', async () => {
    await vi.waitFor(() => expect(server.feed!.health().socket.pongs).toBeGreaterThan(0), { timeout: 5000 });
    answerPings = false;
    await vi.waitFor(() => expect(server.feed!.health().socket.heartbeatFailures).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(server.feed!.health().socket.open).toBe(0), { timeout: 5000 });
    answerPings = true;
    // the feed code waits 30 s between connection attempts
    vi.setSystemTime(Date.now() + 31_000);
    expect(await server.feed!.check()).toBe('connecting');
    await vi.waitFor(() => expect(conns).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(async () => expect(await server.feed!.check()).toBe('connected'), { timeout: 5000, interval: 100 });
    expect(server.feed!.health().connects).toBe(2);
    expect(authorizeCalls).toHaveLength(2); // a fresh one-time address for every connection
  });

  it('closes the feed when the market closes', async () => {
    vi.setSystemTime(Date.parse('2026-11-17T10:05:00Z')); // 15:35 IST
    expect(await server.feed!.check()).toBe('market closed');
    await vi.waitFor(() => expect(server.feed!.health().socket.open).toBe(0), { timeout: 5000 });
    const status = await getJson(server.port, '/v1/market/status');
    expect(status.body).toMatchObject({ phase: 'after_close', feed: { state: 'market closed', connected: false } });
  });

  it('never logs the Analytics Token or the one-time feed address', () => {
    expect(logs.text()).not.toContain('analytics-token-for-tests');
    expect(logs.text()).not.toContain('one-time');
  });
});
