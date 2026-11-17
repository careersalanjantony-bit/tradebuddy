/**
 * Minimal decoder for the Upstox Market Data Feed V3 (WebSocket, protobuf). Written by hand from the
 * official definition (https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto,
 * copied to tests/fixtures on 12 Nov 2026) — no library, no generated code, no `eval` (MV3).
 *
 *   FeedResponse { Type type = 1; map<string, Feed> feeds = 2; int64 currentTs = 3; MarketInfo marketInfo = 4; }
 *   Feed         { oneof { LTPC ltpc = 1; FullFeed fullFeed = 2; FirstLevelWithGreeks firstLevelWithGreeks = 3; } RequestMode requestMode = 4; }
 *   FullFeed     { oneof { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; } }   (both: LTPC ltpc = 1)
 *   FirstLevelWithGreeks { LTPC ltpc = 1; … }
 *   LTPC         { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; DoubleValue iep = 5; }
 *   MarketFullFeed { LTPC ltpc = 1; MarketLevel marketLevel = 2; OptionGreeks optionGreeks = 3;
 *                    MarketOHLC marketOHLC = 4; double atp = 5; int64 vtt = 6; double oi = 7; double iv = 8;
 *                    double tbq = 9; double tsq = 10;
 *                    double iep = 11; double rp = 12; int64 ieq = 13; int64 iiqTotal = 14; int64 iiqM = 15;
 *                    bool casEligible = 16; }   (re-checked 17 Nov 2026 in Upstox's own SDKs, upstox-nodejs
 *                    src/feeder/proto/MarketDataFeedV3.proto and upstox-python, both updated that day)
 *   MarketInfo     { map<string, MarketStatus> segmentStatus = 1; map<string, StatusInfo> casMarketStatus = 2;
 *                    map<string, StatusInfo> preOpenSessionStatus = 3; }   StatusInfo { string status = 1; int64 updatedTime = 2; }
 *   IndexFullFeed  { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; }
 *   MarketOHLC     { repeated OHLC ohlc = 1; }
 *   OHLC           { string interval = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 vol = 6; int64 ts = 7; }
 *
 * Read: the last price (ltp), previous close (cp), trade time and quantity; in "full" mode (app v1.9)
 * also the day's average price (atp = VWAP), the volume traded today (vtt), the waiting buy / sell
 * quantities (tbq / tsq), today's candle ("1d") and the latest 1-minute candle ("I1"). App v1.16: the
 * pre-open call auction (9:00–9:15) — indicative equilibrium price (iep, also LTPC.iep), the quantity
 * that would match there (ieq), the unmatched (imbalance) quantity (iiqTotal, iiqM — signed int64) and
 * the reference price (rp); and the market-info message's pre-open session status per segment.
 */

export interface FeedCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  /** start time (ms) */
  ts: number;
}

export interface FeedTick {
  key: string;
  ltp: number;
  /** previous close */
  cp: number;
  /** last traded time (ms) */
  ltt: number;
  ltq: number;
  /** full mode only: the day's average traded price (VWAP) */
  atp?: number;
  /** full mode only: volume traded today */
  vtt?: number;
  /** full mode only: total quantity waiting to buy / to sell */
  tbq?: number;
  tsq?: number;
  /** full mode only: today's candle */
  day?: FeedCandle;
  /** full mode only: the latest 1-minute candle */
  m1?: FeedCandle;
  /** app v1.16 — pre-open call auction: indicative equilibrium price, its matched quantity, the unmatched
   * (imbalance) quantity in total and from market orders, and the reference price (full mode / LTPC) */
  iep?: number;
  ieq?: number;
  iiq?: number;
  iiqM?: number;
  rp?: number;
}

export interface PreOpenStatus {
  status: string;
  /** ms */
  at: number;
}

export interface DecodedFeed {
  /** 0 = initial_feed, 1 = live_feed, 2 = market_info */
  type: number;
  ticks: FeedTick[];
  currentTs: number;
  /** app v1.16: the pre-open session status per segment (market-info messages), e.g. NSE_EQ → PRE_OPEN_END */
  preOpen?: Record<string, PreOpenStatus>;
}

class Reader {
  pos = 0;
  private readonly view: DataView;
  constructor(
    private readonly buf: Uint8Array,
    private readonly end = buf.length,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('feed: truncated varint');
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
    throw new Error('feed: varint too long');
  }
  /** int64 (two's complement in 10 bytes when negative) as a Number. */
  int64(): number {
    let v = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('feed: truncated varint');
      const b = this.buf[this.pos++]!;
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return Number(BigInt.asIntN(64, v));
      shift += 7n;
    }
    throw new Error('feed: varint too long');
  }
  double(): number {
    if (this.pos + 8 > this.end) throw new Error('feed: truncated double');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  /** A sub-reader over the next length-delimited field. */
  sub(): Reader {
    const len = this.varint();
    if (this.pos + len > this.end) throw new Error('feed: truncated field');
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
  string(): string {
    const len = this.varint();
    if (this.pos + len > this.end) throw new Error('feed: truncated string');
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint(); // read the length first: it moves `pos` itself
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`feed: unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new Error('feed: truncated field');
  }
}

/** google.protobuf.DoubleValue { double value = 1; } */
function readDoubleValue(r: Reader): number | null {
  let v: number | null = 0; // an empty wrapper is 0 (proto3 default)
  while (!r.done) {
    const tag = r.varint();
    if (tag >>> 3 === 1 && (tag & 7) === 1) v = r.double();
    else r.skip(tag & 7);
  }
  return v;
}

function readLtpc(r: Reader): Omit<FeedTick, 'key'> {
  const t: Omit<FeedTick, 'key'> = { ltp: 0, cp: 0, ltt: 0, ltq: 0 };
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 1) t.ltp = r.double();
    else if (field === 2 && wire === 0) t.ltt = r.varint();
    else if (field === 3 && wire === 0) t.ltq = r.varint();
    else if (field === 4 && wire === 1) t.cp = r.double();
    else if (field === 5 && wire === 2) {
      // app v1.16: set only during the pre-open / closing call auction
      const iep = readDoubleValue(r.sub());
      if (iep !== null && Number.isFinite(iep) && iep > 0) t.iep = iep;
    } else r.skip(wire);
  }
  return t;
}

type TickData = Omit<FeedTick, 'key'>;

function readOhlc(r: Reader): (FeedCandle & { interval: string }) | null {
  const c = { interval: '', open: 0, high: 0, low: 0, close: 0, vol: 0, ts: 0 };
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) c.interval = r.string();
    else if (field === 2 && wire === 1) c.open = r.double();
    else if (field === 3 && wire === 1) c.high = r.double();
    else if (field === 4 && wire === 1) c.low = r.double();
    else if (field === 5 && wire === 1) c.close = r.double();
    else if (field === 6 && wire === 0) c.vol = r.varint();
    else if (field === 7 && wire === 0) c.ts = r.varint();
    else r.skip(wire);
  }
  return c.interval ? c : null;
}

/** MarketOHLC { repeated OHLC ohlc = 1 }: today's candle and the newest 1-minute candle. */
function readMarketOhlc(r: Reader, into: TickData): void {
  while (!r.done) {
    const tag = r.varint();
    if (tag >>> 3 === 1 && (tag & 7) === 2) {
      const c = readOhlc(r.sub());
      if (!c) continue;
      const { interval, ...candle } = c;
      if (interval === '1d') into.day = candle;
      else if (interval === 'I1' && (!into.m1 || candle.ts >= into.m1.ts)) into.m1 = candle;
    } else r.skip(tag & 7);
  }
}

/** MarketFullFeed (stocks) or IndexFullFeed (indices: marketOHLC is field 2 there). */
function readFull(r: Reader, index: boolean): TickData | null {
  let out: TickData | null = null;
  const extra: Partial<TickData> = {};
  const imb: { iiq?: number; iiqM?: number } = {};
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) out = readLtpc(r.sub());
    else if (wire === 2 && field === (index ? 2 : 4)) readMarketOhlc(r.sub(), extra as TickData);
    else if (!index && field === 5 && wire === 1) extra.atp = r.double();
    else if (!index && field === 6 && wire === 0) extra.vtt = r.varint();
    else if (!index && field === 9 && wire === 1) extra.tbq = r.double();
    else if (!index && field === 10 && wire === 1) extra.tsq = r.double();
    // app v1.16: the pre-open call auction (0 outside it)
    else if (!index && field === 11 && wire === 1) extra.iep = r.double();
    else if (!index && field === 12 && wire === 1) extra.rp = r.double();
    else if (!index && field === 13 && wire === 0) extra.ieq = r.int64();
    else if (!index && field === 14 && wire === 0) imb.iiq = r.int64();
    else if (!index && field === 15 && wire === 0) imb.iiqM = r.int64();
    else r.skip(wire);
  }
  if (!out) return null;
  // the call-auction numbers mean something only while there is an indicative price
  const auction = (extra.iep !== undefined && extra.iep > 0) || (out.iep !== undefined && out.iep > 0);
  if (extra.iep !== undefined && !(extra.iep > 0)) delete extra.iep;
  if (!auction) {
    delete extra.ieq;
    delete extra.rp;
  } else {
    if (imb.iiq !== undefined && Number.isFinite(imb.iiq)) out.iiq = imb.iiq;
    if (imb.iiqM !== undefined && Number.isFinite(imb.iiqM)) out.iiqM = imb.iiqM;
  }
  if (extra.rp !== undefined && !(extra.rp > 0)) delete extra.rp;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && (typeof v !== 'number' || (Number.isFinite(v) && v >= 0))) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** The LTPC inside a message whose field 1 is an LTPC (MarketFullFeed, IndexFullFeed, FirstLevelWithGreeks). */
function ltpcInField1(r: Reader): Omit<FeedTick, 'key'> | null {
  let out: Omit<FeedTick, 'key'> | null = null;
  while (!r.done) {
    const tag = r.varint();
    if (tag >>> 3 === 1 && (tag & 7) === 2) out = readLtpc(r.sub());
    else r.skip(tag & 7);
  }
  return out;
}

function readFeed(r: Reader): Omit<FeedTick, 'key'> | null {
  let out: Omit<FeedTick, 'key'> | null = null;
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) out = readLtpc(r.sub());
    else if (field === 2 && wire === 2) {
      // FullFeed: marketFF = 1 (stocks) or indexFF = 2 (indices)
      const full = r.sub();
      while (!full.done) {
        const t2 = full.varint();
        if ((t2 >>> 3 === 1 || t2 >>> 3 === 2) && (t2 & 7) === 2) out = readFull(full.sub(), t2 >>> 3 === 2) ?? out;
        else full.skip(t2 & 7);
      }
    } else if (field === 3 && wire === 2) out = ltpcInField1(r.sub()) ?? out;
    else r.skip(wire);
  }
  return out;
}

/** MarketInfo: only the pre-open session status per segment (field 3: map<string, StatusInfo>). */
function readMarketInfo(r: Reader): Record<string, PreOpenStatus> | null {
  const out: Record<string, PreOpenStatus> = {};
  let any = false;
  while (!r.done) {
    const tag = r.varint();
    if (tag >>> 3 === 3 && (tag & 7) === 2) {
      const entry = r.sub();
      let key = '';
      let st: PreOpenStatus | null = null;
      while (!entry.done) {
        const t = entry.varint();
        if (t >>> 3 === 1 && (t & 7) === 2) key = entry.string();
        else if (t >>> 3 === 2 && (t & 7) === 2) {
          const v = entry.sub();
          const s: PreOpenStatus = { status: '', at: 0 };
          while (!v.done) {
            const t2 = v.varint();
            if (t2 >>> 3 === 1 && (t2 & 7) === 2) s.status = v.string();
            else if (t2 >>> 3 === 2 && (t2 & 7) === 0) s.at = v.varint();
            else v.skip(t2 & 7);
          }
          st = s;
        } else entry.skip(t & 7);
      }
      if (key && st?.status) {
        out[key] = st;
        any = true;
      }
    } else r.skip(tag & 7);
  }
  return any ? out : null;
}

/** Decodes one binary feed message. Throws on malformed data (the caller ignores that message). */
export function decodeFeedResponse(bytes: Uint8Array): DecodedFeed {
  const r = new Reader(bytes);
  const out: DecodedFeed = { type: 0, ticks: [], currentTs: 0 };
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) out.type = r.varint();
    else if (field === 3 && wire === 0) out.currentTs = r.varint();
    else if (field === 4 && wire === 2) {
      const pre = readMarketInfo(r.sub());
      if (pre) out.preOpen = pre;
    }
    else if (field === 2 && wire === 2) {
      // map entry: key = 1 (string), value = 2 (Feed)
      const entry = r.sub();
      let key = '';
      let tick: Omit<FeedTick, 'key'> | null = null;
      while (!entry.done) {
        const t = entry.varint();
        if (t >>> 3 === 1 && (t & 7) === 2) key = entry.string();
        else if (t >>> 3 === 2 && (t & 7) === 2) tick = readFeed(entry.sub());
        else entry.skip(t & 7);
      }
      if (key && tick && Number.isFinite(tick.ltp) && tick.ltp > 0) out.ticks.push({ key, ...tick });
    } else r.skip(wire);
  }
  return out;
}

export type FeedMode = 'ltpc' | 'full';

/** The subscription request (must be sent as a BINARY frame). */
export function subscribeMessage(keys: string[], method: 'sub' | 'unsub' | 'change_mode' = 'sub', guid = `swing-${Date.now().toString(36)}`, mode: FeedMode = 'ltpc'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ guid, method, data: { mode, instrumentKeys: keys } }));
}
