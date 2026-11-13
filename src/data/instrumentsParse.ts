/**
 * Upstox instruments master (spec §7.3) — pure parsing and search.
 * tick_size in the file is in PAISE (see docs/VERIFIED.md): tick in ₹ = tick_size / 100.
 */

export interface Instrument {
  instrument_key: string;
  trading_symbol: string;
  name: string;
  short_name?: string;
  isin: string;
  /** ₹ price step */
  tick: number;
  lot_size: number;
  instrument_type: 'EQ' | 'INDEX';
}

export const INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
export const NIFTY50_KEY = 'NSE_INDEX|Nifty 50';

/** The ten stocks from the owner's 9 Nov 2026 screen (spec §10). */
export const SEED_SYMBOLS = ['ICICIBANK', 'BAJFINANCE', 'AXISBANK', 'HDFCBANK', 'SBIN', 'BSE', 'TRENT', 'EICHERMOT', 'SUNPHARMA', 'ETERNAL'];

export function parseInstruments(rows: unknown): Instrument[] {
  if (!Array.isArray(rows)) throw new Error('Instruments file: expected a JSON array');
  const out: Instrument[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    const seg = r.segment;
    const type = r.instrument_type;
    const isEq = seg === 'NSE_EQ' && type === 'EQ';
    const isIndex = seg === 'NSE_INDEX' && type === 'INDEX';
    if (!isEq && !isIndex) continue;
    const key = r.instrument_key;
    const sym = r.trading_symbol;
    if (typeof key !== 'string' || typeof sym !== 'string') continue;
    const tickPaise = typeof r.tick_size === 'number' && r.tick_size > 0 ? r.tick_size : 5;
    const inst: Instrument = {
      instrument_key: key,
      trading_symbol: sym,
      name: typeof r.name === 'string' ? r.name : sym,
      isin: typeof r.isin === 'string' ? r.isin : '',
      tick: tickPaise / 100,
      lot_size: typeof r.lot_size === 'number' && r.lot_size > 0 ? r.lot_size : 1,
      instrument_type: isEq ? 'EQ' : 'INDEX',
    };
    if (typeof r.short_name === 'string' && r.short_name) inst.short_name = r.short_name;
    out.push(inst);
  }
  return out;
}

/** Ranks: exact symbol, symbol prefix, name/short-name word prefix, then contains. EQ before INDEX. */
export function searchInstruments(list: Instrument[], query: string, limit = 15): Instrument[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const scored: Array<[number, Instrument]> = [];
  for (const i of list) {
    const sym = i.trading_symbol.toUpperCase();
    const names = `${i.name} ${i.short_name ?? ''}`.toUpperCase();
    let score = -1;
    if (sym === q) score = 0;
    else if (sym.startsWith(q)) score = 1;
    else if (names.split(/[\s.,&()-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (sym.includes(q) || names.includes(q)) score = 3;
    if (score >= 0) scored.push([score * 2 + (i.instrument_type === 'EQ' ? 0 : 1), i]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].trading_symbol.length - b[1].trading_symbol.length || a[1].trading_symbol.localeCompare(b[1].trading_symbol));
  return scored.slice(0, limit).map(([, i]) => i);
}
