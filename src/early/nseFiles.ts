/**
 * App v1.15 — NSE's end-of-day files (checked 17 Nov 2026), parsed here; downloaded once a day by
 * background/earlyJobs.ts:
 *   bulk deals:  https://nsearchives.nseindia.com/content/equities/bulk.csv
 *                Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks
 *   block deals: https://nsearchives.nseindia.com/content/equities/block.csv  (same columns; "NO RECORDS" when none)
 *   delivery:    https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv
 *                SYMBOL, SERIES, DATE1, …, TTL_TRD_QNTY, …, DELIV_QTY, DELIV_PER   ("-" when not given)
 * They describe the LAST trading day, not today: shown as supporting signs with their date. FII / DII
 * figures are only on NSE's website (not in these files), so the app shows them as unavailable.
 */

export const NSE_BULK_URL = 'https://nsearchives.nseindia.com/content/equities/bulk.csv';
export const NSE_BLOCK_URL = 'https://nsearchives.nseindia.com/content/equities/block.csv';
export const nseDeliveryUrl = (date: string): string => {
  const [y, m, d] = date.split('-');
  return `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`;
};

export interface Deal {
  date: string;
  symbol: string;
  client: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  kind: 'bulk' | 'block';
}

/** Splits one CSV line (quoted fields allowed). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
/** "16-NOV-2026" / "16-Nov-2026" → "2026-11-16" (null if not a date). */
export function nseDate(s: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  const mm = m ? MONTHS[m[2]!.toUpperCase()] : undefined;
  return m && mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, '0')}` : null;
}

/** Bulk or block deals file → deals (empty for "NO RECORDS"). Throws when the columns are not the expected ones. */
export function parseDeals(text: string, kind: Deal['kind']): Deal[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = cells(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const iDate = col('date');
  const iSym = col('symbol');
  const iClient = col('client');
  const iSide = col('buy/sell');
  const iQty = col('quantity');
  const iPrice = col('trade price');
  if ([iDate, iSym, iSide, iQty].some((i) => i < 0)) throw new Error(`NSE ${kind} deals file: unexpected columns`);
  const out: Deal[] = [];
  for (const line of lines.slice(1)) {
    const c = cells(line);
    const date = nseDate(c[iDate] ?? '');
    const side = (c[iSide] ?? '').toUpperCase();
    const qty = Number((c[iQty] ?? '').replace(/,/g, ''));
    if (!date || (side !== 'BUY' && side !== 'SELL') || !(qty > 0)) continue;
    out.push({ date, symbol: (c[iSym] ?? '').toUpperCase(), client: c[iClient] ?? '', side, qty, price: Number(c[iPrice] ?? '') || 0, kind });
  }
  return out;
}

export interface Delivery {
  date: string;
  /** delivered share of the traded quantity, % */
  pct: number;
  qty: number;
}

/** Delivery file → symbol → delivery (EQ series only; rows without delivery figures are skipped). */
export function parseDelivery(text: string, only?: ReadonlySet<string>): Record<string, Delivery> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = cells(lines[0] ?? '').map((h) => h.toUpperCase());
  const iSym = head.indexOf('SYMBOL');
  const iSer = head.indexOf('SERIES');
  const iDate = head.indexOf('DATE1');
  const iQty = head.indexOf('DELIV_QTY');
  const iPct = head.indexOf('DELIV_PER');
  if ([iSym, iSer, iDate, iQty, iPct].some((i) => i < 0)) throw new Error('NSE delivery file: unexpected columns');
  const out: Record<string, Delivery> = {};
  for (const line of lines.slice(1)) {
    const c = cells(line);
    const sym = (c[iSym] ?? '').toUpperCase();
    if (c[iSer] !== 'EQ' || (only && !only.has(sym))) continue;
    const pct = Number(c[iPct]);
    const qty = Number(c[iQty]);
    const date = nseDate(c[iDate] ?? '');
    if (!date || !Number.isFinite(pct) || !Number.isFinite(qty)) continue;
    out[sym] = { date, pct, qty };
  }
  return out;
}
