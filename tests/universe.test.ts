import { describe, expect, it } from 'vitest';
import { BUNDLED_NIFTY100, BUNDLED_NIFTY50 } from '../src/data/indexLists';
import { memberKey, parseIndexCsv } from '../src/data/universeParse';

describe('NSE index list (CSV format checked 9 Nov 2026)', () => {
  it('parses the NSE columns, quoted names and skips bad rows', () => {
    const csv = [
      'Company Name,Industry,Symbol,Series,ISIN Code',
      'Adani Enterprises Ltd.,Metals & Mining,ADANIENT,EQ,INE423A01024',
      '"Mahindra & Mahindra, Ltd.",Automobile,M&M,EQ,INE101A01026',
      'Bad Row,X,BAD,EQ,NOTANISIN',
      'Some Bond,X,SGB,GB,INE000000001',
    ].join('\r\n');
    const m = parseIndexCsv(csv);
    expect(m).toEqual([
      { symbol: 'ADANIENT', isin: 'INE423A01024', name: 'Adani Enterprises Ltd.', industry: 'Metals & Mining' },
      { symbol: 'M&M', isin: 'INE101A01026', name: 'Mahindra & Mahindra, Ltd.', industry: 'Automobile' },
    ]);
    expect(memberKey(m[0]!)).toBe('NSE_EQ|INE423A01024');
  });
  it('rejects a file without the needed columns', () => {
    expect(() => parseIndexCsv('a,b\n1,2')).toThrow();
    expect(() => parseIndexCsv('')).toThrow();
  });
  it('bundled fallback lists are complete', () => {
    expect(BUNDLED_NIFTY50).toHaveLength(50);
    expect(BUNDLED_NIFTY100).toHaveLength(100);
    const n100 = new Set(BUNDLED_NIFTY100.map((m) => m.symbol));
    expect(BUNDLED_NIFTY50.every((m) => n100.has(m.symbol))).toBe(true);
    expect(n100.has('UNIONBANK')).toBe(true);
  });
});
