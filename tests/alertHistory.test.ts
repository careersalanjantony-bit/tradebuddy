import { beforeEach, describe, expect, it } from 'vitest';
import { addRecord, alertDetail, clearAlertHistory, clearRecords, detailFromText, dismissRecord, EMPTY_HISTORY, getAlertHistory, HISTORY_MAX, REPEAT_MS, wasDismissed } from '../src/alerts/history';
import { majorSupport } from '../src/indicators/levels';
import type { Candle } from '../src/indicators/types';
import { notify } from '../src/notify/chrome';
import { installChromeMock } from './chromeMock';

const T = Date.parse('2026-11-18T05:00:00Z');
const rec = (id: string, at = T) => ({ id, title: `title ${id}`, message: 'm', at });

describe('notification history (app v1.18)', () => {
  it('keeps every notification, newest first, up to the limit', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = addRecord(h, rec(`alert:x-${i}`, T + i))!;
    expect(h.items).toHaveLength(HISTORY_MAX);
    expect(h.items[0]!.id).toBe(`alert:x-${HISTORY_MAX + 4}`);
  });

  it('the same notification is not shown again within 24 hours — also after "Clear all"', () => {
    let h = addRecord(EMPTY_HISTORY, rec('login-reminder'))!;
    expect(addRecord(h, rec('login-reminder', T + 3600_000))).toBeNull();
    h = clearRecords(h, T + 7200_000);
    expect(h.items).toEqual([]);
    expect(addRecord(h, rec('login-reminder', T + 7300_000))).toBeNull(); // cleared stays cleared
    // the next day it is a new reminder
    expect(addRecord(h, rec('login-reminder', T + REPEAT_MS + 1))?.items.map((x) => x.id)).toEqual(['login-reminder']);
  });

  it('remembers dismissed banners for 24 hours', () => {
    const h = dismissRecord(EMPTY_HISTORY, 'alert:short-A-2026-11-18', T);
    expect(wasDismissed(h, 'alert:short-A-2026-11-18', T + 1000)).toBe(true);
    expect(wasDismissed(h, 'alert:short-A-2026-11-18', T + REPEAT_MS + 1)).toBe(false);
    expect(wasDismissed(h, 'other', T)).toBe(false);
  });
});

describe('alert details read from the text of older alerts', () => {
  it('sell-first idea (as on the phone screen)', () => {
    expect(
      detailFromText('▼ SELL first TMPV at ₹252.55 · score 72', 'Buy back if it rises to ₹255.00 · target 1 ₹250.10 · target 2 ₹247.65 · 40 shares (risk ₹98.00). Close by 3:10 pm.'),
    ).toMatchObject({ symbol: 'TMPV', side: 'sell', entry: 252.55, stop: 255, targets: [250.1, 247.65], qty: 40, risk: 98, score: 72, scoreKind: 'score' });
  });

  it('day-trade buy with a chance, breakout, early mover', () => {
    expect(detailFromText('⭐ Strong idea — ▲ BUY HINDALCO at ₹900.00 · 64% chance', 'Take profit at ₹912.50 · sell if it falls to ₹894.00 · close by 3:10 pm.')).toMatchObject({
      symbol: 'HINDALCO',
      side: 'buy',
      entry: 900,
      stop: 894,
      targets: [912.5],
      score: 64,
      scoreKind: 'chance',
    });
    expect(detailFromText('🚀 Breakout: TRENT ₹4,512.00 above ₹4,500.00 · 2.1× volume', 'Buy around ₹4,512.00 · stop-loss ₹4,480.00 · target 1 ₹4,550.00 · target 2 ₹4,590.00 · 3 shares (risk ₹96.00).')).toMatchObject({
      symbol: 'TRENT',
      entry: 4512,
      stop: 4480,
      targets: [4550, 4590],
      qty: 3,
      risk: 96,
    });
    expect(detailFromText('⚡ ADANIENT: holding its opening gap · score 81', '₹2410.00 (opened +2.1%). Buy only above ₹2,415.00 · stop-loss ₹2,398.00 · targets ₹2,440.00 / ₹2,460.00 · 5 shares, risk ₹85 with charges.')).toMatchObject({
      symbol: 'ADANIENT',
      entry: 2415,
      stop: 2398,
      targets: [2440, 2460],
      qty: 5,
      risk: 85,
      score: 81,
    });
  });

  it('a message that is not about a trade has no details; saved details win over the text', () => {
    expect(detailFromText('Log in to Upstox', 'Market opens at 09:15.')).toBeNull();
    const detail = { symbol: 'X', side: 'buy' as const, source: 'Day trade', entry: 1, stop: 0.9, targets: [1.2], qty: 10, risk: 1, score: 70, reasons: ['why'] };
    expect(alertDetail({ title: '▲ BUY Y at ₹5', message: '', detail })).toBe(detail);
  });
});

describe('notify() stores every notification and never repeats one', () => {
  let chrome: ReturnType<typeof installChromeMock>;
  beforeEach(() => {
    chrome = installChromeMock();
  });

  it('stores it with its trade details and shows a repeat only once', async () => {
    const detail = { symbol: 'TMPV', key: 'NSE_EQ|TMPV', side: 'sell' as const, source: 'Falling now (sell first)', entry: 252.55, stop: 255, targets: [250.1, 247.65], qty: 40, risk: 98, score: 72, scoreKind: 'score' as const, reasons: ['Fell below VWAP'] };
    await notify('alert:short-NSE_EQ|TMPV-2026-11-18', { title: '▼ SELL first TMPV at ₹252.55 · score 72', message: 'Buy back if it rises to ₹255.00', detail });
    await notify('alert:short-NSE_EQ|TMPV-2026-11-18', { title: '▼ SELL first TMPV at ₹252.55 · score 72', message: 'Buy back if it rises to ₹255.00', detail });
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    const h = await getAlertHistory();
    expect(h.items).toHaveLength(1);
    expect(h.items[0]!.detail).toEqual(detail);
    // the details are not sent to the phone's notification (Chrome would refuse unknown fields)
    expect(chrome.notifications.create.mock.calls[0]![1]).not.toHaveProperty('detail');
  });

  it('after "Clear all" the list is empty and the same alert does not come back', async () => {
    await notify('alert:bo-A-1.00-ok', { title: '✅ Confirmed breakout: A', message: 'm' });
    await clearAlertHistory();
    expect((await getAlertHistory()).items).toEqual([]);
    await notify('alert:bo-A-1.00-ok', { title: '✅ Confirmed breakout: A', message: 'm' });
    expect((await getAlertHistory()).items).toEqual([]);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    await notify('alert:bo-B-2.00-ok', { title: '✅ Confirmed breakout: B', message: 'm' });
    expect((await getAlertHistory()).items.map((x) => x.id)).toEqual(['alert:bo-B-2.00-ok']);
  });
});

describe('major support (stock page, app v1.18)', () => {
  // a stock that bounced three times near ₹90, once near ₹95 and once near ₹98
  const day = (i: number, low: number, high: number): Candle => ({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, open: (low + high) / 2, high, low, close: (low + high) / 2, volume: 1000 });
  const candles: Candle[] = [];
  const dips: Record<number, number> = { 20: 90, 50: 90.4, 80: 89.8, 110: 95, 140: 98 };
  for (let i = 0; i < 170; i++) {
    const low = dips[i] ?? 100 + (i % 5);
    candles.push(day(i, low, low + 6));
  }

  it('is the floor with the most bounces below the nearer supports', () => {
    const m = majorSupport(candles, 99, 2);
    expect(m?.touches).toBe(3);
    expect(m!.price).toBeCloseTo(90.07, 1);
  });

  it('only looks below the given price, and is null when there is nothing there', () => {
    expect(majorSupport(candles, 96, 2)?.price).toBeCloseTo(90.07, 1);
    expect(majorSupport(candles, 80, 2)).toBeNull();
  });
});
