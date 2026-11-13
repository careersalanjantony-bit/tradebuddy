import { describe, expect, it } from 'vitest';
import { buyersMeter, parseFullQuotes, risingNow } from '../src/data/flow';
import { headlineSentiment, stockSentiment } from '../src/data/sentiment';

describe('full market quote → buyers meter', () => {
  // shape from the Upstox docs example (GET /v2/market-quote/quotes)
  const sample = {
    'NSE_EQ:NHPC': {
      ohlc: { open: 53.4, high: 53.8, low: 51.75, close: 52.05 },
      depth: { buy: [{ quantity: 6917, price: 52.05, orders: 20 }], sell: [] },
      timestamp: '2023-10-19T05:21:51.099+05:30',
      instrument_token: 'NSE_EQ|INE848E01016',
      symbol: 'NHPC',
      last_price: 52.04999923706055,
      volume: 24123697,
      average_price: 52.56,
      net_change: -1.0500000000000043,
      total_buy_quantity: 6917,
      total_sell_quantity: 0,
    },
  };

  it('parses price, average price, volume, order book and yesterday’s close', () => {
    const f = parseFullQuotes(sample, 5)['NSE_EQ|INE848E01016']!;
    expect(f).toMatchObject({ ltp: 52.04999923706055, vwap: 52.56, volume: 24123697, buyQty: 6917, sellQty: 0, open: 53.4, at: 5 });
    expect(f.prevClose).toBeCloseTo(53.1, 2);
  });

  it('meter: buyers waiting + price above the average price = buyers strong; the opposite = sellers strong', () => {
    expect(buyersMeter({ ltp: 101, vwap: 100, buyQty: 7000, sellQty: 3000 }).label).toBe('Buyers strong');
    expect(buyersMeter({ ltp: 99, vwap: 100, buyQty: 2000, sellQty: 8000 }).label).toBe('Sellers strong');
    expect(buyersMeter({ ltp: 100, vwap: 100, buyQty: 5000, sellQty: 5000 }).label).toBe('Balanced');
    // order book says buyers, price says sellers → no strong call
    expect(buyersMeter({ ltp: 99, vwap: 100, buyQty: 8000, sellQty: 2000 }).label).toBe('Balanced');
  });

  it('rising now: up from the open, above the average price, more buyers, busier than usual — best first', () => {
    const base = { volume: 1e6, at: 0 };
    const flows = {
      A: { key: 'A', ltp: 102, vwap: 101, buyQty: 7000, sellQty: 3000, prevClose: 100, open: 100, ...base },
      B: { key: 'B', ltp: 100.8, vwap: 100.5, buyQty: 6000, sellQty: 4000, prevClose: 100, open: 100, ...base },
      C: { key: 'C', ltp: 99, vwap: 100, buyQty: 7000, sellQty: 3000, prevClose: 100, open: 100, ...base }, // falling
      D: { key: 'D', ltp: 102, vwap: 101, buyQty: 7000, sellQty: 3000, prevClose: 100, open: 100, ...base }, // quiet: pace 0.8
    };
    const rows = risingNow(flows, (k) => (k === 'A' ? 3 : k === 'D' ? 0.8 : 1.5));
    expect(rows.map((r) => r.key)).toEqual(['A', 'B']);
    expect(rows[0]!.pace).toBe(3);
  });
});

describe('news mood from headlines', () => {
  it('reads good and bad news', () => {
    expect(headlineSentiment('Larsen & Toubro bags order worth ₹5,000 crore').label).toBe('good');
    expect(headlineSentiment('Q2 results: net profit rises 32%, beats estimates').label).toBe('good');
    expect(headlineSentiment('SEBI imposes penalty on company; CFO resigns').label).toBe('bad');
    expect(headlineSentiment('Brokerage downgrades stock, cuts target price').label).toBe('bad');
    expect(headlineSentiment('Company to hold board meeting on Friday').label).toBe('neutral');
  });

  it('a stock’s mood weighs the newest headlines most and ignores old ones', () => {
    const now = 1_000_000_000_000;
    expect(stockSentiment([{ heading: 'Net loss widens; shares tumble', at: now - 3600_000 }], now)!.label).toBe('bad');
    expect(stockSentiment([{ heading: 'Net loss widens', at: now - 3 * 86_400_000 }], now)).toBeNull();
  });
});
