import { describe, expect, it } from 'vitest';
import { errorMessage, toLoggable } from '../src/lib/serialize';

describe('toLoggable', () => {
  it('turns errors into plain objects with cause', () => {
    const err = new Error('outer', { cause: new Error('inner') });
    const out = toLoggable(err) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.message).toBe('outer');
    expect(typeof out.stack).toBe('string');
    expect((out.cause as Record<string, unknown>).message).toBe('inner');
  });
  it('marks cycles and limits depth', () => {
    const a: Record<string, unknown> = {};
    a.a = a;
    expect((toLoggable(a) as Record<string, unknown>).a).toBe('[circular]');
    const deep = { l1: { l2: { l3: { l4: 1 } } } };
    expect(toLoggable(deep, { maxDepth: 2 })).toEqual({ l1: { l2: '[max depth]' } });
  });
  it('truncates long strings and arrays', () => {
    const out = toLoggable({ s: 'x'.repeat(50), a: [1, 2, 3, 4, 5] }, { maxString: 10, maxArray: 2 }) as Record<string, unknown>;
    expect(out.s).toBe('xxxxxxxxxx… [40 more chars]');
    expect(out.a).toEqual([1, 2, '[… 3 more items]']);
  });
  it('handles non-JSON primitives', () => {
    expect(toLoggable({ n: NaN, i: Infinity, b: 10n, u: undefined, f: function named() {} })).toEqual({
      n: 'NaN',
      i: 'Infinity',
      b: '10n',
      u: null,
      f: '[function named]',
    });
  });
  it('serialises dates as ISO strings', () => {
    expect(toLoggable(new Date('2026-11-09T04:30:00Z'))).toBe('2026-11-09T04:30:00.000Z');
  });
});

describe('errorMessage', () => {
  it('extracts a readable message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
  });
});
