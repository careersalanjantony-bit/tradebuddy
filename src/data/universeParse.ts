/** NSE index constituent CSV: "Company Name,Industry,Symbol,Series,ISIN Code" (checked 9 Nov 2026). */

export interface IndexMember {
  symbol: string;
  isin: string;
  name: string;
  industry: string;
}

export type UniverseIndex = 'nifty50' | 'nifty100' | 'midcap100' | 'smallcap100' | 'nifty500';

const NSE_LISTS = 'https://nsearchives.nseindia.com/content/indices/';
/** All five checked on 11 Nov 2026 (same CSV columns). */
export const INDEX_CSV_URLS: Record<UniverseIndex, string> = {
  nifty50: `${NSE_LISTS}ind_nifty50list.csv`,
  nifty100: `${NSE_LISTS}ind_nifty100list.csv`,
  midcap100: `${NSE_LISTS}ind_niftymidcap100list.csv`,
  smallcap100: `${NSE_LISTS}ind_niftysmallcap100list.csv`,
  nifty500: `${NSE_LISTS}ind_nifty500list.csv`,
};

export const INDEX_LABEL: Record<UniverseIndex, string> = {
  nifty50: 'Nifty 50',
  nifty100: 'Nifty 100',
  midcap100: 'Nifty Midcap 100',
  smallcap100: 'Nifty Smallcap 100',
  nifty500: 'Nifty 500',
};

/** Fewest companies a downloaded list must have to be accepted (a few rows are not series EQ). */
export const INDEX_MIN_ROWS: Record<UniverseIndex, number> = { nifty50: 40, nifty100: 80, midcap100: 80, smallcap100: 80, nifty500: 400 };

export const INDEX_ORDER: UniverseIndex[] = ['nifty50', 'nifty100', 'midcap100', 'smallcap100', 'nifty500'];

/** Splits one CSV line, honouring double quotes (company names can contain commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseIndexCsv(text: string): IndexMember[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('Index list is empty');
  const head = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const iSym = col('symbol');
  const iIsin = col('isin code');
  const iName = col('company name');
  const iInd = col('industry');
  const iSeries = col('series');
  if (iSym < 0 || iIsin < 0) throw new Error('Index list has no Symbol / ISIN Code columns');
  const out: IndexMember[] = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const symbol = c[iSym];
    const isin = c[iIsin];
    if (!symbol || !isin || !/^IN[A-Z0-9]{10}$/.test(isin)) continue;
    if (iSeries >= 0 && c[iSeries] && c[iSeries] !== 'EQ') continue;
    out.push({ symbol, isin, name: (iName >= 0 ? c[iName] : symbol) ?? symbol, industry: (iInd >= 0 ? c[iInd] : '') ?? '' });
  }
  return out;
}

export const memberKey = (m: IndexMember) => `NSE_EQ|${m.isin}`;

/** Price-range filter. `max` null = no upper limit. */
export function inPriceRange(price: number | null | undefined, min: number, max: number | null): boolean {
  if (price === null || price === undefined || !Number.isFinite(price)) return true; // unknown price: don't hide
  return price >= min && (max === null || price <= max);
}
