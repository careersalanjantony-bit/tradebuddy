import { describe, expect, it } from 'vitest';
import { calibrate, chanceFor, emaSeries, historyPairs, indicatorsOf, rsiSeries, shortSellList, shortSetupAt } from '../src/advisor/shortSell';
import { features, learnFrom, newBrain, predict, strategyFocus, topLessons, type IdeaContext } from '../src/bot/brain';
import { BOT_START, decide, hash01, MAX_OPEN, scoreIdea, trailStop, type Book, type Idea } from '../src/bot/policy';
import { newBot, settleClosed, weekdaysBetween, type BotTrade } from '../src/background/botJobs';
import { placeOrder, processWallet, type MarketCtx } from '../src/wallet/wallet';
import type { Candle } from '../src/indicators/types';

const ctx = (over: Partial<IdeaContext> = {}): IdeaContext => ({ strategy: 'rising', prior: 0.5, movePct: 1, pressure: 0.5, breadth: 0.2, t: 630, news: 0, vwapPct: 0.4, riskPct: 0.8, ...over });

describe('auto-trader brain', () => {
  it('starts by agreeing with the studies', () => {
    const b = newBrain();
    for (const p of [0.35, 0.5, 0.6, 0.7]) expect(Math.abs(predict(b, features(ctx({ prior: p }))) - p)).toBeLessThan(0.05);
  });

  it('trusts a kind of trade less after it keeps losing, more after it keeps winning', () => {
    let b = newBrain();
    const xRise = features(ctx({ strategy: 'rising' }));
    const xSwing = features(ctx({ strategy: 'swing' }));
    const start = predict(b, xRise);
    for (let i = 0; i < 12; i++) {
      b = learnFrom(b, xRise, false, -1, -5000, 'rising').brain;
      b = learnFrom(b, xSwing, true, 1.8, 9000, 'swing').brain;
    }
    expect(predict(b, xRise)).toBeLessThan(start - 0.1);
    expect(predict(b, xSwing)).toBeGreaterThan(start + 0.1);
    expect(b.by.rising).toMatchObject({ n: 12, wins: 0 });
    expect(b.by.swing.wins).toBe(12);
    expect(strategyFocus(b.by.rising)).toBe('paused');
    expect(strategyFocus(b.by.swing)).toBe('more');
    expect(strategyFocus(b.by['day-buy'])).toBe('learning');
    expect(b.curve).toHaveLength(24);
    const lessons = topLessons(b);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons.map((l) => l.text).join(' ')).toMatch(/Rising today|top picks/);
  });

  it('says what it learned in plain words', () => {
    const l = learnFrom(newBrain(), features(ctx({ strategy: 'short' })), true, 1.5, 4000, 'short');
    expect(l.text).toMatch(/^Learned: /);
    expect(l.after).toBeGreaterThan(l.before);
  });
});

describe('auto-trader decisions and size', () => {
  const book = (over: Partial<Book> = {}): Book => ({ equity: BOT_START, free: BOT_START, openKeys: [], openCount: 0, newToday: 0, todayPnl: 0, t: 630, ...over });
  const idea = (key: string, prior: number, over: Partial<Idea> = {}): Idea => ({ key, symbol: key, strategy: 'day-buy', side: 'long', price: 1000, stop: 990, target: 1020, ctx: ctx({ strategy: 'day-buy', prior, riskPct: 1 }), reasons: ['test'], ...over });

  it('takes good ideas, best first, and sizes by confidence (0.5 % of the money at normal confidence)', () => {
    // safety net 3 % away, so the 20 % cap does not decide the size
    const wide = (k: string, p: number) => idea(k, p, { stop: 970, target: 1060 });
    const plan = decide(newBrain(), [wide('A', 0.55), wide('B', 0.68), wide('C', 0.3)], book(), 'no-explore-seed-1');
    const keys = plan.decisions.map((d) => d.idea.key);
    expect(keys[0]).toBe('B');
    expect(keys).toContain('A');
    expect(keys).not.toContain('C');
    const b = plan.decisions[0]!;
    expect(b.riskRupees).toBeGreaterThan(BOT_START * 0.005);
    expect(b.riskRupees).toBeLessThanOrEqual(BOT_START * 0.0075 + 10);
    expect(b.qty * 1000).toBeLessThanOrEqual(BOT_START * 0.2);
    const a = plan.decisions.find((d) => d.idea.key === 'A')!;
    expect(a.riskRupees).toBeLessThan(b.riskRupees);
  });

  it('never puts more than 20 % of its money in one stock', () => {
    const plan = decide(newBrain(), [idea('A', 0.7, { stop: 999.5, target: 1003 })], book(), 'x');
    expect(plan.decisions[0]!.qty * 1000).toBeLessThanOrEqual(BOT_START * 0.2);
  });

  it('respects its limits: open trades, daily loss, time of day, no doubles', () => {
    expect(decide(newBrain(), [idea('A', 0.7)], book({ openCount: MAX_OPEN }), 'x').decisions).toHaveLength(0);
    const lost = decide(newBrain(), [idea('A', 0.7)], book({ todayPnl: -BOT_START * 0.02 }), 'x');
    expect(lost.decisions).toHaveLength(0);
    expect(lost.note).toMatch(/Stopped for today/);
    expect(decide(newBrain(), [idea('A', 0.7)], book({ t: 9 * 60 + 20 }), 'x').decisions).toHaveLength(0);
    expect(decide(newBrain(), [idea('A', 0.7)], book({ t: 14 * 60 + 45 }), 'x').decisions).toHaveLength(0);
    expect(decide(newBrain(), [idea('A', 0.7, { strategy: 'swing', ctx: ctx({ strategy: 'swing', prior: 0.7 }) })], book({ t: 14 * 60 + 45 }), 'x').decisions).toHaveLength(1);
    expect(decide(newBrain(), [idea('A', 0.7)], book({ openKeys: ['A'], openCount: 1 }), 'x').decisions).toHaveLength(0);
  });

  it('counts charges: a tiny target is not worth it', () => {
    const s = scoreIdea(newBrain(), idea('A', 0.6, { stop: 999, target: 1000.8 }))!;
    expect(s.ev).toBeLessThan(0.05);
  });

  it('now and then makes a small test trade to keep learning', () => {
    const seeds = Array.from({ length: 400 }, (_, i) => `s${i}`).filter((s) => hash01(s) < 0.125);
    expect(seeds.length).toBeGreaterThan(20);
    const plan = decide(newBrain(), [idea('A', 0.3)], book(), seeds[0]!);
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]!.explore).toBe(true);
    expect(plan.decisions[0]!.riskRupees).toBeLessThan(BOT_START * 0.002);
  });

  it('moves the safety net to the buy price once 1 R up', () => {
    expect(trailStop('long', 100, 98, 101)).toBe(98);
    expect(trailStop('long', 100, 98, 102)).toBe(100);
    expect(trailStop('short', 100, 102, 97.9)).toBe(100);
    expect(trailStop('short', 100, 100, 95)).toBe(100);
  });

  it('counts weekdays for the 10-day limit', () => {
    expect(weekdaysBetween('2026-11-13', '2026-11-16')).toBe(1); // Fri → Mon
    expect(weekdaysBetween('2026-11-02', '2026-11-16')).toBe(10);
  });
});

describe('auto-trader learns from a finished trade', () => {
  it('closes the trade record and learns once the wallet position is gone', () => {
    const t0 = Date.UTC(2026, 10, 16, 5, 0);
    const c: MarketCtx = { now: t0, today: '2026-11-16', t: 630, open: true };
    let bot = newBot(t0);
    const r = placeOrder(bot.wallet, { key: 'K', symbol: 'ABC', side: 'buy', qty: 100, type: 'market', stop: 990, target: 1020, sellByClose: true }, { ltp: 1000, prevClose: 995, fetchedAt: t0 }, c);
    if (!r.ok) throw new Error(r.error);
    const trade: BotTrade = { id: 'b1', key: 'K', symbol: 'ABC', strategy: 'day-buy', side: 'long', qty: 100, entry: r.fill!.price, stop: 990, stop0: 990, target: 1020, openedAt: t0, date: '2026-11-16', x: features(ctx({ strategy: 'day-buy' })), chance: 0.55, prior: 0.55, riskRupees: 1000, explore: false, reasons: [], sizeWhy: '', status: 'open' };
    bot = { ...bot, wallet: r.wallet, trades: [trade] };
    expect(settleClosed(bot, t0).trades[0]!.status).toBe('open');
    const t1 = t0 + 20 * 60_000;
    const w = processWallet(bot.wallet, { K: { ltp: 1021, prevClose: 995, fetchedAt: t1 } }, { ...c, now: t1, t: 650 }).wallet;
    const after = settleClosed({ ...bot, wallet: w }, t1);
    const done = after.trades[0]!;
    expect(done.status).toBe('closed');
    expect(done.exitWhy).toBe('target reached');
    expect(done.pnl!).toBeGreaterThan(1500);
    expect(done.r!).toBeGreaterThan(1.5);
    expect(after.brain.n).toBe(1);
    expect(after.brain.by['day-buy'].wins).toBe(1);
    expect(after.log.some((l) => l.kind === 'learn')).toBe(true);
  });
});

// ---------------------------------------------------------------- short selling study

function candles(n: number, f: (i: number) => { o: number; c: number; v?: number }): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const { o, c, v } = f(i);
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return { date: d, open: o, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, close: c, volume: v ?? 100_000 };
  });
}

describe('short-selling study', () => {
  it('EMA and RSI series line up with the prices', () => {
    const e = emaSeries([1, 2, 3, 4, 5], 3);
    expect(e[1]).toBeNull();
    expect(e[2]).toBeCloseTo(2);
    expect(e[4]!).toBeGreaterThan(e[3]!);
    const r = rsiSeries(Array.from({ length: 30 }, (_, i) => 100 - i));
    expect(r[29]!).toBeLessThan(5);
  });

  it('a steady downtrend scores high, with reasons in plain words', () => {
    // falls 0.4 % a day with small bounces, opens a little below the last close
    const c = candles(120, (i) => {
      const base = 1000 * Math.pow(0.996, i) * (i % 5 === 0 ? 1.006 : 1);
      return { o: base * 1.001, c: base * 0.999 };
    });
    const s = shortSetupAt(c, 119, indicatorsOf(c))!;
    expect(s.score).toBeGreaterThanOrEqual(45);
    expect(s.reasons.join(' ')).toMatch(/downtrend/);
  });

  it('measures the chance on past days and needs at least 30 similar days', () => {
    const c = candles(200, (i) => ({ o: 1000 - i, c: 1000 - i - (i % 3 === 0 ? -1 : 4) }));
    const pairs = historyPairs(c);
    expect(pairs.length).toBeGreaterThan(100);
    const cal = calibrate(pairs);
    expect(cal.total).toBe(pairs.length);
    expect(cal.baseRate).toBeGreaterThan(0);
    const top = cal.bins.filter((b) => b.n >= 30).sort((a, b) => b.lo - a.lo)[0]!;
    const m = chanceFor(cal, top.lo)!;
    expect(m.n).toBe(top.n);
    expect(m.chance).toBeCloseTo(top.fell / top.n);
    expect(chanceFor({ bins: [{ lo: 0, hi: 100, n: 10, fell: 9, avgMove: -1 }], total: 10, baseRate: 0.9 }, 50)).toBeNull();
  });

  it('today\'s list: only stocks below today\'s open while the market is open, best measured chance first', () => {
    // up 1 % one day, down 0.8 % two days (RSI ≈ 40), each day opening a little below the last close
    const fall = (k: number) => {
      let prev = 1000;
      return candles(120, (i) => {
        const o = prev * 0.997;
        const c = i % 3 === 0 ? prev * 1.01 : prev * (0.992 - k * 0.001);
        prev = c;
        return { o, c };
      });
    };
    const live = (c: Candle[], ltpFactor: number) => {
      const last = c[c.length - 1]!;
      return [...c.slice(0, -1), { ...last, partial: true }].map((x, i, a) => (i === a.length - 1 ? { ...x, close: x.open * ltpFactor } : x));
    };
    const a = live(fall(0), 0.99);
    const b = live(fall(1), 0.995);
    const up = live(fall(0), 1.01);
    const pairs = [...historyPairs(fall(0)), ...historyPairs(fall(1))];
    const cal = calibrate(pairs);
    const rows = shortSellList(
      [
        { key: 'A', symbol: 'AAA', candles: a, ltp: a[a.length - 1]!.close, news: -1 },
        { key: 'B', symbol: 'BBB', candles: b, ltp: b[b.length - 1]!.close, news: 0 },
        { key: 'U', symbol: 'UP', candles: up, ltp: up[up.length - 1]!.close, news: 0 },
      ],
      cal,
      cal,
    );
    expect(rows.map((r) => r.symbol)).not.toContain('UP');
    expect(rows.length).toBe(2);
    expect(rows[0]!.live).toBe(true);
    expect(rows.find((r) => r.symbol === 'AAA')!.reasons).toContain('bad news today');
    expect(rows.every((r) => r.belowOpen)).toBe(true);
  });
});
