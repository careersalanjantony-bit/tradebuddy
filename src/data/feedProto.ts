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
 *
 * Only the last price (ltp), the previous close (cp), the trade time and quantity are read.
 */

export interface FeedTick {
  key: string;
  ltp: number;
  /** previous close */
  cp: number;
  /** last traded time (ms) */
  ltt: number;
  ltq: number;
}

export interface DecodedFeed {
  /** 0 = initial_feed, 1 = live_feed, 2 = market_info */
  type: number;
  ticks: FeedTick[];
  currentTs: number;
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

function readLtpc(r: Reader): Omit<FeedTick, 'key'> {
  const t = { ltp: 0, cp: 0, ltt: 0, ltq: 0 };
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 1) t.ltp = r.double();
    else if (field === 2 && wire === 0) t.ltt = r.varint();
    else if (field === 3 && wire === 0) t.ltq = r.varint();
    else if (field === 4 && wire === 1) t.cp = r.double();
    else r.skip(wire);
  }
  return t;
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
      // FullFeed: marketFF = 1 or indexFF = 2, each with ltpc = 1
      const full = r.sub();
      while (!full.done) {
        const t2 = full.varint();
        if ((t2 >>> 3 === 1 || t2 >>> 3 === 2) && (t2 & 7) === 2) out = ltpcInField1(full.sub()) ?? out;
        else full.skip(t2 & 7);
      }
    } else if (field === 3 && wire === 2) out = ltpcInField1(r.sub()) ?? out;
    else r.skip(wire);
  }
  return out;
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

/** The subscription request (must be sent as a BINARY frame). */
export function subscribeMessage(keys: string[], method: 'sub' | 'unsub' = 'sub', guid = `swing-${Date.now().toString(36)}`): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ guid, method, data: { mode: 'ltpc', instrumentKeys: keys } }));
}
