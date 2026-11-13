import { describe, expect, it } from 'vitest';
import { parseInstruments, searchInstruments, SEED_SYMBOLS } from '../src/data/instrumentsParse';
import { mergeQuotes, parseCandles } from '../src/data/quotesParse';

// Rows copied from the real NSE.json.gz (downloaded 9 Nov 2026)
const rows = [
  { segment: 'NSE_EQ', name: 'RELIANCE INDUSTRIES LTD', exchange: 'NSE', isin: 'INE002A01018', instrument_type: 'EQ', instrument_key: 'NSE_EQ|INE002A01018', lot_size: 1, freeze_quantity: 100000.0, exchange_token: '2885', tick_size: 10.0, trading_symbol: 'RELIANCE', short_name: 'Reliance Industries', qty_multiplier: 1.0, security_type: 'NORMAL', cas_eligible: true },
  { segment: 'NSE_EQ', name: 'TRENT LTD', exchange: 'NSE', isin: 'INE849A01020', instrument_type: 'EQ', instrument_key: 'NSE_EQ|INE849A01020', lot_size: 1, tick_size: 10.0, trading_symbol: 'TRENT', short_name: 'Trent' },
  { segment: 'NSE_EQ', name: 'ETERNAL LIMITED', exchange: 'NSE', isin: 'INE758T01015', instrument_type: 'EQ', instrument_key: 'NSE_EQ|INE758T01015', lot_size: 1, tick_size: 5.0, trading_symbol: 'ETERNAL', short_name: 'Zomato' },
  { segment: 'NSE_EQ', name: 'MRF LTD', isin: 'INE883A01011', instrument_type: 'EQ', instrument_key: 'NSE_EQ|INE883A01011', lot_size: 1, tick_size: 500.0, trading_symbol: 'MRF' },
  { segment: 'NSE_INDEX', name: 'Nifty 50', exchange: 'NSE', instrument_type: 'INDEX', instrument_key: 'NSE_INDEX|Nifty 50', exchange_token: '26000', trading_symbol: 'NIFTY' },
  { segment: 'NSE_FO', instrument_type: 'CE', instrument_key: 'NSE_FO|1', trading_symbol: 'NIFTY X CE' },
  { segment: 'NSE_EQ', instrument_type: 'SG', instrument_key: 'NSE_EQ|SGB', trading_symbol: 'SGBX' },
];

describe('instruments', () => {
  const list = parseInstruments(rows);
  it('keeps NSE equities and indices only', () => {
    expect(list.map((i) => i.trading_symbol)).toEqual(['RELIANCE', 'TRENT', 'ETERNAL', 'MRF', 'NIFTY']);
  });
  it('converts tick_size from paise to rupees', () => {
    const t = Object.fromEntries(list.map((i) => [i.trading_symbol, i.tick]));
    expect(t).toMatchObject({ RELIANCE: 0.1, ETERNAL: 0.05, MRF: 5, NIFTY: 0.05 });
  });
  it('searches by symbol, name and short name', () => {
    expect(searchInstruments(list, 'trent')[0]?.trading_symbol).toBe('TRENT');
    expect(searchInstruments(list, 'zomato')[0]?.trading_symbol).toBe('ETERNAL');
    expect(searchInstruments(list, 'reli').map((i) => i.trading_symbol)).toEqual(['RELIANCE']);
    expect(searchInstruments(list, 'nifty')[0]?.instrument_type).toBe('INDEX');
    expect(searchInstruments(list, '  ')).toEqual([]);
  });
  it('has the ten seed symbols from the spec', () => {
    expect(SEED_SYMBOLS).toHaveLength(10);
  });
  it('rejects a non-array file', () => {
    expect(() => parseInstruments({})).toThrow();
  });
});

describe('quotes', () => {
  it('merges LTP v3 and OHLC v3 by instrument_token', () => {
    const ltp = { 'NSE_EQ:TRENT': { last_price: 4210.5, instrument_token: 'NSE_EQ|INE849A01020', ltq: 3, volume: 120000, cp: 4150 } };
    const ohlc = {
      'NSE_EQ:TRENT': {
        last_price: 4210.5,
        instrument_token: 'NSE_EQ|INE849A01020',
        prev_ohlc: { open: 4100, high: 4170, low: 4090, close: 4150, volume: 900000, ts: 1 },
        live_ohlc: { open: 4160, high: 4225, low: 4155, close: 4210.5, volume: 125000, ts: 2 },
      },
      'NSE_EQ:BAD': { instrument_token: 'NSE_EQ|BAD' },
    };
    const q = mergeQuotes(ltp, ohlc, 99);
    expect(Object.keys(q)).toEqual(['NSE_EQ|INE849A01020']);
    expect(q['NSE_EQ|INE849A01020']).toEqual({ key: 'NSE_EQ|INE849A01020', ltp: 4210.5, open: 4160, high: 4225, low: 4155, volume: 125000, prevClose: 4150, fetchedAt: 99 });
  });
  it('falls back to prev_ohlc.close when LTP data is missing', () => {
    const q = mergeQuotes({}, { a: { last_price: 10, instrument_token: 'K', prev_ohlc: { close: 9 } } }, 1);
    expect(q.K).toMatchObject({ ltp: 10, prevClose: 9 });
  });
});

describe('candles', () => {
  it('parses, sorts oldest-first and de-duplicates', () => {
    const data = {
      candles: [
        ['2026-11-06T00:00:00+05:30', 101, 105, 100, 104, 5000, 0],
        ['2026-11-05T00:00:00+05:30', 100, 102, 99, 101, 4000, 0],
        ['2026-11-06T00:00:00+05:30', 101, 106, 100, 105, 5100, 0],
        ['bad'],
      ],
    };
    expect(parseCandles(data)).toEqual([
      { date: '2026-11-05', open: 100, high: 102, low: 99, close: 101, volume: 4000 },
      { date: '2026-11-06', open: 101, high: 106, low: 100, close: 105, volume: 5100 },
    ]);
    expect(() => parseCandles({})).toThrow();
  });
});
