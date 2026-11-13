import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decodeFeedResponse, subscribeMessage } from '../src/data/feedProto';
import { mergeTicks } from '../src/data/quotesParse';
import type { Quote } from '../src/data/quotesParse';

/**
 * The hand-written decoder is checked against the standard protobuf library using Upstox's official
 * definition (tests/fixtures/MarketDataFeed.proto, downloaded 12 Nov 2026): the library ENCODES,
 * our decoder must read the same values.
 */
const root = new protobuf.Root();
// the definition imports google/protobuf/wrappers.proto (DoubleValue), which the library ships
root.addJSON((protobuf.common.get('google/protobuf/wrappers.proto') as { nested: Record<string, protobuf.AnyNestedObject> }).nested);
protobuf.parse(readFileSync(fileURLToPath(new URL('./fixtures/MarketDataFeed.proto', import.meta.url)), 'utf8'), root, { keepCase: true });
root.resolveAll();
const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
const encode = (obj: object): Uint8Array => FeedResponse.encode(FeedResponse.fromObject(obj)).finish();

describe('Upstox Market Data Feed V3 decoder', () => {
  it('reads LTPC ticks exactly as the official definition encodes them', () => {
    const bytes = encode({
      type: 1,
      currentTs: 1794456305123,
      feeds: {
        'NSE_EQ|INE040A01034': { ltpc: { ltp: 729.15, ltt: 1794456304999, ltq: 75, cp: 724.0 }, requestMode: 0 },
        'NSE_INDEX|Nifty 50': { ltpc: { ltp: 25123.45, ltt: 1794456305000, ltq: 0, cp: 25010.1 } },
      },
    });
    const d = decodeFeedResponse(bytes);
    expect(d.type).toBe(1);
    expect(d.currentTs).toBe(1794456305123);
    expect(d.ticks).toEqual([
      { key: 'NSE_EQ|INE040A01034', ltp: 729.15, cp: 724, ltt: 1794456304999, ltq: 75 },
      { key: 'NSE_INDEX|Nifty 50', ltp: 25123.45, cp: 25010.1, ltt: 1794456305000, ltq: 0 },
    ]);
  });

  it('also finds the price inside "full" and "option greeks" messages, and ignores the pre-open extra field', () => {
    const bytes = encode({
      type: 1,
      feeds: {
        A: { fullFeed: { marketFF: { ltpc: { ltp: 213.75, ltt: 5, ltq: 150, cp: 494.05 }, atp: 272.9, vtt: 779625, marketOHLC: { ohlc: [{ interval: '1d', open: 400, high: 400, low: 208.7, close: 213.75, vol: 779400, ts: 1 }] } } } },
        B: { fullFeed: { indexFF: { ltpc: { ltp: 25000.5, ltt: 6, ltq: 0, cp: 24900 } } } },
        C: { firstLevelWithGreeks: { ltpc: { ltp: 225.7, ltt: 7, ltq: 75, cp: 494.05 }, firstDepth: { bidQ: 75, bidP: 225.4, askQ: 150, askP: 225.7 }, iv: 0.13 } },
        D: { ltpc: { ltp: 100.5, ltt: 8, ltq: 1, cp: 99, iep: { value: 101.25 } } },
      },
    });
    expect(decodeFeedResponse(bytes).ticks.map((t) => [t.key, t.ltp, t.cp])).toEqual([
      ['A', 213.75, 494.05],
      ['B', 25000.5, 24900],
      ['C', 225.7, 494.05],
      ['D', 100.5, 99],
    ]);
  });

  it('market status message (first message of every connection) has no ticks', () => {
    const bytes = encode({ type: 2, currentTs: 1732775008661, marketInfo: { segmentStatus: { NSE_EQ: 2, NSE_INDEX: 2 } } });
    expect(decodeFeedResponse(bytes)).toEqual({ type: 2, ticks: [], currentTs: 1732775008661 });
  });

  it('drops entries without a price and throws on cut-off data', () => {
    const bytes = encode({ type: 1, feeds: { X: { ltpc: { ltp: 0, cp: 10 } }, Y: { requestMode: 0 }, Z: { ltpc: { ltp: 5.05, cp: 5 } } } });
    expect(decodeFeedResponse(bytes).ticks.map((t) => t.key)).toEqual(['Z']);
    expect(() => decodeFeedResponse(bytes.subarray(0, bytes.length - 3))).toThrow();
    expect(decodeFeedResponse(new Uint8Array())).toEqual({ type: 0, ticks: [], currentTs: 0 });
  });

  it('subscription request is binary JSON in the documented shape', () => {
    const msg = JSON.parse(new TextDecoder().decode(subscribeMessage(['NSE_EQ|A', 'NSE_INDEX|Nifty 50'], 'sub', 'g1')));
    expect(msg).toEqual({ guid: 'g1', method: 'sub', data: { mode: 'ltpc', instrumentKeys: ['NSE_EQ|A', 'NSE_INDEX|Nifty 50'] } });
  });
});

describe('merging live ticks into the stored prices', () => {
  const q = (ltp: number): Quote => ({ key: 'K', ltp, open: 99, high: 101, low: 98, volume: 500, prevClose: 97, fetchedAt: 1 });
  it('updates the price, stretches the day high/low, keeps open and volume', () => {
    const r = mergeTicks({ K: q(100) }, [{ key: 'K', ltp: 102, cp: 97, ltt: 0, ltq: 1 }], new Set(['K']), 50);
    expect(r.updated).toBe(1);
    expect(r.quotes.K).toEqual({ key: 'K', ltp: 102, open: 99, high: 102, low: 98, volume: 500, prevClose: 97, fetchedAt: 50 });
  });
  it('ignores stocks that are not watched and prices that jump absurdly (bad data)', () => {
    const r = mergeTicks({ K: q(100) }, [{ key: 'OTHER', ltp: 5, cp: 5, ltt: 0, ltq: 1 }, { key: 'K', ltp: 10, cp: 97, ltt: 0, ltq: 1 }], new Set(['K']), 50);
    expect(r.updated).toBe(0);
    expect(r.quotes.K!.ltp).toBe(100);
  });
  it('a stock seen for the first time gets a price with unknown open/high/low', () => {
    const r = mergeTicks({}, [{ key: 'N', ltp: 25000, cp: 24900, ltt: 0, ltq: 0 }], new Set(['N']), 9);
    expect(r.quotes.N).toEqual({ key: 'N', ltp: 25000, open: null, high: null, low: null, volume: null, prevClose: 24900, fetchedAt: 9 });
  });
});

describe('feed address check', () => {
  it('accepts only encrypted Upstox addresses', async () => {
    const { isUpstoxFeedUrl } = await import('../src/background/feed');
    expect(isUpstoxFeedUrl('wss://wsfeeder-api.upstox.com/market-data-feeder/v3/upstox-developer-api/feeds?requestId=r&code=c')).toBe(true);
    expect(isUpstoxFeedUrl('wss://api.upstox.com/feeds')).toBe(true);
    expect(isUpstoxFeedUrl('ws://api.upstox.com/feeds')).toBe(false);
    expect(isUpstoxFeedUrl('wss://upstox.com.evil.example/feeds')).toBe(false);
    expect(isUpstoxFeedUrl('wss://notupstox.com/feeds')).toBe(false);
    expect(isUpstoxFeedUrl('https://api.upstox.com/feeds')).toBe(false);
    expect(isUpstoxFeedUrl('not a url')).toBe(false);
  });
});
