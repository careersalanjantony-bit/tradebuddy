import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './chromeMock';
import { BUNDLED } from '../src/data/indexLists';
import { INDEX_TAG, OWN_TAG, SCAN_ORDER, buildScan, refreshScanLists, scanSummary, type ScanLists } from '../src/data/scanUniverse';
import { INDEX_CSV_URLS, memberKey, type IndexMember } from '../src/data/universeParse';
import { FEED_LIMITS, planSubscription } from '../src/background/feed';
import { staleKeys } from '../src/background/dataJobs';
import { SAME_IDEA_MS, claimAlert, gateAllows } from '../src/background/ideaGate';
import { MAX_SHORT_CANDIDATES, shortCandidates } from '../src/background/shortJobs';
import { indexTagOf, priceKeys, resetScanList, scanUniverse } from '../src/background/scanList';
import { NIFTY100_KEYS, testKeys, universeKeys } from '../src/data/universe';
import { MemoryKV } from '../src/storage/kv';
import { runLocalMigrations } from '../src/storage/migrations';
import type { Quote } from '../src/data/quotesParse';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { istEpoch } from '../src/lib/time';

const m = (isin: string, symbol = isin): IndexMember => ({ isin, symbol, name: symbol, industry: '' }) as IndexMember;
const key = (isin: string) => `NSE_EQ|${isin}`;

describe('scan list: all five indices, each stock once', () => {
  it('the bundled lists: no stock twice, the narrowest index wins the tag', () => {
    const u = buildScan(null);
    expect(new Set(u.keys).size).toBe(u.keys.length);
    // every company of every list is in
    for (const i of SCAN_ORDER) for (const x of BUNDLED[i]) expect(u.tag[memberKey(x)]).toBeDefined();
    // a Nifty 50 company is tagged "Nifty 50" (also in Nifty 100 and Nifty 500)
    const n50 = memberKey(BUNDLED.nifty50[0]!);
    expect(u.tag[n50]).toBe('Nifty 50');
    // Nifty 50 first, then the 50 more of Nifty 100, then mid, small, rest of Nifty 500
    expect(u.keys.slice(0, BUNDLED.nifty50.length)).toEqual(BUNDLED.nifty50.map(memberKey));
    expect(u.added['Nifty 50']).toBe(BUNDLED.nifty50.length);
    const total = Object.values(u.added).reduce((a, b) => a + b, 0);
    expect(total).toBe(u.keys.length);
    expect(u.perIndex['Nifty 500']).toBe(BUNDLED.nifty500.length);
    // no index adds more stocks than it has
    for (const i of SCAN_ORDER) expect(u.added[INDEX_TAG[i]]!).toBeLessThanOrEqual(BUNDLED[i].length);
    expect(u.keys.length).toBeGreaterThanOrEqual(BUNDLED.nifty500.length);
    expect(scanSummary(u)).toMatch(/^Nifty 50, Nifty 100, Midcap 100, Smallcap 100 and Nifty 500 — \d+ stocks$/);
  });

  it('stored NSE lists replace the bundled ones; your own stocks outside them are added once, tagged "Your list"', () => {
    const stored: ScanLists = {
      at: 1,
      lists: {
        nifty50: { members: [m('A'), m('B')], source: 'nse', fetchedAt: 1 },
        nifty100: { members: [m('A'), m('B'), m('C')], source: 'nse', fetchedAt: 1 },
        midcap100: { members: [m('D')], source: 'nse', fetchedAt: 1 },
        smallcap100: { members: [m('E'), m('D')], source: 'nse', fetchedAt: 1 },
        nifty500: { members: [m('A'), m('C'), m('D'), m('E'), m('F')], source: 'nse', fetchedAt: 1 },
      },
    };
    const u = buildScan(stored, [key('B'), key('Z'), key('Z')]);
    expect(u.keys).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'Z'].map(key));
    expect(u.tag).toEqual({ [key('A')]: 'Nifty 50', [key('B')]: 'Nifty 50', [key('C')]: 'Nifty 100', [key('D')]: 'Midcap 100', [key('E')]: 'Smallcap 100', [key('F')]: 'Nifty 500', [key('Z')]: OWN_TAG });
    expect(u.added).toEqual({ 'Nifty 50': 2, 'Nifty 100': 1, 'Midcap 100': 1, 'Smallcap 100': 1, 'Nifty 500': 1, [OWN_TAG]: 1 });
    expect(u.sources.nifty50).toBe('nse');
  });

  it('weekly download from NSE; a failed or too-short list keeps the stored (or bundled) copy', async () => {
    const csv = (n: number) => ['Company Name,Industry,Symbol,Series,ISIN Code', ...Array.from({ length: n }, (_, i) => `Co ${i},X,S${i},EQ,INE${String(i).padStart(6, '0')}A01`)].join('\n');
    const asked: string[] = [];
    const fetchText = async (url: string) => {
      asked.push(url);
      if (url === INDEX_CSV_URLS.midcap100) throw new Error('HTTP 503');
      if (url === INDEX_CSV_URLS.smallcap100) return csv(10); // too short to be real
      return csv(url === INDEX_CSV_URLS.nifty500 ? 500 : url === INDEX_CSV_URLS.nifty50 ? 50 : 100);
    };
    const now = Date.UTC(2026, 10, 15);
    const r = await refreshScanLists(null, fetchText, now);
    expect(asked).toHaveLength(5);
    expect(r.lists.nifty50).toMatchObject({ source: 'nse', fetchedAt: now });
    expect(r.lists.nifty50!.members).toHaveLength(50);
    expect(r.lists.midcap100!.source).toBe('bundled');
    expect(r.lists.smallcap100!.source).toBe('bundled');
    expect(r.lists.smallcap100!.members).toEqual(BUNDLED.smallcap100);
    // within a week nothing is downloaded again
    asked.length = 0;
    expect(await refreshScanLists(r, fetchText, now + 3 * 24 * 3600_000)).toBe(r);
    expect(asked).toHaveLength(0);
    // after a week (or when forced) it is
    await refreshScanLists(r, fetchText, now + 8 * 24 * 3600_000);
    expect(asked).toHaveLength(5);
  });
});

describe('Upstox live-feed limits: no stock is left out', () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `NSE_EQ|K${i}`);
  it('up to 1,500 stocks with full details, the next 500 prices-only, the rest by price request', () => {
    const p = planSubscription([...keys(2300), 'NSE_EQ|K0'], false);
    expect(p.full).toHaveLength(FEED_LIMITS.fullMixed);
    expect(p.ltpc).toHaveLength(FEED_LIMITS.mixedTotal - FEED_LIMITS.fullMixed);
    expect(p.overflow).toHaveLength(300);
    expect(new Set([...p.full, ...p.ltpc, ...p.overflow]).size).toBe(2300);
    expect(p.full[0]).toBe('NSE_EQ|K0'); // most important first
    const small = planSubscription(keys(520), false);
    expect([small.full.length, small.ltpc.length, small.overflow.length]).toEqual([520, 0, 0]);
  });
  it('"Save mobile data": prices only, up to 5,000', () => {
    const p = planSubscription(keys(5200), true);
    expect([p.full.length, p.ltpc.length, p.overflow.length]).toEqual([0, 5000, 200]);
  });
  it('stocks with no price, or no tick for 15 s, are checked over the price API', () => {
    const q = (ltp: number, fetchedAt: number): Quote => ({ key: '', ltp, open: null, high: null, low: null, volume: null, prevClose: null, fetchedAt });
    const quotes = { a: q(10, 100_000), b: q(10, 80_000), c: q(0, 100_000) };
    expect(staleKeys(['a', 'b', 'c', 'd'], quotes, 100_000)).toEqual(['b', 'c', 'd']);
    expect(staleKeys(['a'], quotes, 115_001)).toEqual(['a']);
  });
});

describe('one alert per stock and direction across the three scanners', () => {
  beforeEach(() => {
    installChromeMock();
  });
  it('a BUY already announced by one scanner is not announced again by another for 30 minutes', () => {
    const items = [{ key: 'K', side: 'buy' as const, src: 'day', at: 1_000 }];
    expect(gateAllows(items, 'K', 'buy', 'breakout', 2_000)).toBe(false);
    expect(gateAllows(items, 'K', 'buy', 'day', 2_000)).toBe(true); // a scanner's own rules decide its repeats
    expect(gateAllows(items, 'K', 'sell', 'falling', 2_000)).toBe(true); // other direction = new idea
    expect(gateAllows(items, 'L', 'buy', 'breakout', 2_000)).toBe(true);
    expect(gateAllows(items, 'K', 'buy', 'breakout', 1_000 + SAME_IDEA_MS)).toBe(true);
  });
  it('claims are stored per day and serialized', async () => {
    const t = istEpoch('2026-11-16', '10:00');
    const r = await Promise.all([claimAlert('K', 'buy', 'day', t), claimAlert('K', 'buy', 'breakout', t)]);
    expect(r).toEqual([true, false]);
    expect(await claimAlert('K', 'sell', 'falling', t + 1)).toBe(true);
    expect(await claimAlert('K', 'sell', 'day', t + 2)).toBe(false);
    // next day: a fresh start
    expect(await claimAlert('K', 'buy', 'breakout', istEpoch('2026-11-17', '09:40'))).toBe(true);
  });
});

describe('Falling now: candidates from the whole scan list', () => {
  const q = (ltp: number, open: number, prevClose: number, volume: number): Quote => ({ key: '', ltp, open, high: open, low: ltp, volume, prevClose, fetchedAt: 1 });
  it('falling below the open and liquid; biggest falls first; the count of all candidates is kept', () => {
    const nifty100 = [...NIFTY100_KEYS][0]!;
    const quotes: Record<string, Quote> = {
      [nifty100]: q(97, 99, 100, 10), // −3 %, Nifty 100 (always liquid enough)
      big: q(98, 99.5, 100, 3_000_000), // −2 %, ₹29 cr traded
      thin: q(90, 99, 100, 1_000), // −10 % but only ₹9 lakh traded
      up: q(101, 100, 100, 3_000_000),
      aboveOpen: q(99, 98, 100, 3_000_000),
    };
    const r = shortCandidates([nifty100, 'big', 'thin', 'up', 'aboveOpen', 'missing', 'big'], quotes);
    expect(r.picked.map((x) => x.k)).toEqual([nifty100, 'big']);
    expect(r.total).toBe(2);
    const many: Record<string, Quote> = {};
    for (let i = 0; i < 200; i++) many[`k${i}`] = q(95 + i * 0.01, 99.9, 100, 3_000_000);
    const c = shortCandidates(Object.keys(many), many);
    expect(c.picked).toHaveLength(MAX_SHORT_CANDIDATES);
    expect(c.total).toBe(200);
    expect(c.picked[0]!.k).toBe('k0');
  });
});

describe('scan list in the background', () => {
  beforeEach(async () => {
    const chrome = installChromeMock();
    resetScanList();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.dayTrade.enabled = true;
    settings.scanner.universe = 'nifty50';
    await chrome.storage.local.set({ settings, watchlist: ['NSE_EQ|INE000OWN011'] });
  });
  it('"All five indices" (the default): every stock once, with its index; prices cover all of them', async () => {
    const u = await scanUniverse();
    expect(u.keys.length).toBe(buildScan(null, ['NSE_EQ|INE000OWN011']).keys.length);
    expect(u.keys.length).toBeGreaterThan(450);
    expect(await indexTagOf(memberKey(BUNDLED.nifty50[0]!))).toBe('Nifty 50');
    expect(await indexTagOf('NSE_EQ|INE000OWN011')).toBe(OWN_TAG);
    const p = await priceKeys();
    for (const k of u.keys) expect(p).toContain(k);
    expect(new Set(p).size).toBe(p.length);
  });
  it('no single-index choice any more: an old "Nifty 50" setting still scans all five indices', async () => {
    // (the beforeEach stores scanner.universe = 'nifty50', as a phone from before v1.12 could have)
    expect((await scanUniverse()).keys.length).toBeGreaterThan(450);
  });
});

describe('everything studies all five indices (app v1.12)', () => {
  const OWN = 'NSE_EQ|INE000OWN011';
  beforeEach(async () => {
    const chrome = installChromeMock();
    resetScanList();
    await chrome.storage.local.set({ settings: structuredClone(DEFAULT_SETTINGS), watchlist: [OWN] });
  });
  it('the default is all five: the studied list is the five indices, each company once', async () => {
    expect(DEFAULT_SETTINGS.scanner.universe).toBe('all');
    const keys = await universeKeys();
    expect(keys).toEqual(buildScan(null).keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(OWN); // your own stocks are added next to it, not into it
  });
  it('the 5-minute past tests and the learning use the Nifty 100 + your stocks (a phone-sized history)', async () => {
    const t = await testKeys();
    expect(t).toEqual([...BUNDLED.nifty100.map(memberKey), OWN]);
  });
  it('an install from before v1.12 is moved to all five indices (and the old Day-trade switch is dropped)', async () => {
    const kv = new MemoryKV();
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as { scanner: { universe: string }; dayTrade: Record<string, unknown> };
    old.scanner.universe = 'nifty100';
    old.dayTrade.scanScope = 'list';
    await kv.set({ meta: { schemaVersion: 14, installedAt: 1, lastMigratedAt: 1 }, settings: old });
    const r = await runLocalMigrations(kv, 2);
    expect(r.applied.length).toBeGreaterThanOrEqual(1); // v1.12 and any later step
    const { settings } = (await kv.get(['settings'])) as { settings: typeof old };
    expect(settings.scanner.universe).toBe('all');
    expect('scanScope' in settings.dayTrade).toBe(false);
  });
});
