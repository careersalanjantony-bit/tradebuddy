import { describe, expect, it } from 'vitest';
import { calibrate, chanceFor, emaSeries, historyPairs, indicatorsOf, rsiSeries, shortSellList, shortSetupAt } from '../src/advisor/shortSell';
import { features, learnFrom, newBrain, predict, strategyFocus, topLessons, type IdeaContext } from '../src/bot/brain';
import { BOT_START, decide, MAX_CHARGES_R, MAX_OPEN_RISK, MIN_POSITION, minPositionFor, RISK_SHARE, riskShareFor, scoreIdea, trailStop, type Book, type Idea } from '../src/bot/policy';
import { drawdownFactor, drawdownOf, protectRules } from '../src/bot/protect';
import { estimateCharges } from '../src/wallet/wallet';
import { allIn, decideCtx, ev } from './botHelpers';
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

describe('auto-trader decisions and size (evidence first, app v1.23)', () => {
  const R = protectRules(undefined);
  const book = (over: Partial<Book> = {}): Book => ({ equity: BOT_START, free: BOT_START, openKeys: [], openCount: 0, newToday: 0, todayPnl: 0, t: 630, rules: R, halted: null, swingValue: 0, openRisk: 0, ...over });
  const idea = (key: string, over: Partial<Idea> = {}): Idea => ({ key, symbol: key, strategy: 'day-buy', playbook: 'day-buy', side: 'long', price: 1000, stop: 900, target: 1200, ctx: ctx({ strategy: 'day-buy', prior: 0.5, riskPct: 10 }), reasons: ['test'], ...over });
  // the Rising now quick trade: +0.6 % / −0.4 %
  const quick = (key: string, over: Partial<Idea> = {}) => idea(key, { strategy: 'rising', playbook: 'rise-strong', stop: 996, target: 1006, ctx: ctx({ strategy: 'rising', riskPct: 0.4 }), ...over });

  it('risks 0.5 % of its money on a proven kind, 0.25 % on a trial kind, never more than half the daily loss limit', () => {
    const proven = decide(newBrain(), [idea('A')], book(), decideCtx()).decisions[0]!;
    expect(proven.state).toBe('proven');
    expect(proven.riskRupees).toBe(25_000); // 0.5 % of ₹50 lakh: 250 shares, ₹100 to the safety net
    expect(proven.sizeWhy).toMatch(/^Proven kind: ₹25,000 at risk \(0\.5% of its money\)/);
    const trial = decide(newBrain(), [idea('A')], book(), decideCtx({ evidence: allIn('trial') })).decisions[0]!;
    expect(trial.riskRupees).toBe(12_500);
    expect(trial.sizeWhy).toMatch(/Trial kind \(small size\)/);
    const tight = decide(newBrain(), [idea('A')], book({ rules: { ...R, dayLossPct: 0.5 } }), decideCtx()).decisions[0]!;
    expect(tight.riskRupees).toBe(12_500); // half of a 0.5 % day limit
    expect(riskShareFor('proven', { ...R, on: false })).toBe(RISK_SHARE.proven);
  });

  it('all open trades together risk at most 2 % of the money', () => {
    const d = decide(newBrain(), [idea('A')], book({ openRisk: BOT_START * 0.019 }), decideCtx()).decisions[0]!;
    expect(d.riskRupees).toBeLessThanOrEqual(BOT_START * 0.001);
    const full = decide(newBrain(), [idea('A')], book({ openRisk: BOT_START * MAX_OPEN_RISK }), decideCtx());
    expect(full.decisions).toHaveLength(0);
    expect(full.note).toMatch(/already risk 2% of the money/);
    // several ideas at once share the 2 %
    const many = decide(newBrain(), ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => idea(k)), book(), decideCtx());
    expect(many.decisions.reduce((s, x) => s + x.riskRupees, 0)).toBeLessThanOrEqual(BOT_START * MAX_OPEN_RISK);
  });

  it('counts the real Upstox charges for its size: a small quick trade is skipped, the same trade with more money is taken', () => {
    const small = decide(newBrain(), [quick('Q')], book({ equity: 25_000, free: 25_000 }), decideCtx());
    expect(small.decisions).toHaveLength(0);
    expect(small.note).toMatch(/charges would be more than a quarter of the risk/);
    const big = decide(newBrain(), [quick('Q')], book(), decideCtx()).decisions[0]!;
    expect(big.chargesR).toBeGreaterThan(0.08);
    expect(big.chargesR).toBeLessThanOrEqual(MAX_CHARGES_R);
    expect(big.edgeR).toBeCloseTo(0.3 - big.chargesR, 3);
    // the smallest positions that keep the charges within a quarter of the risk (the plan's table)
    const value = (v: number) => estimateCharges('intraday', 1, v);
    expect(minPositionFor(0.004, value)).toBeGreaterThan(72_000);
    expect(minPositionFor(0.004, value)).toBeLessThanOrEqual(73_000);
    expect(minPositionFor(0.01, value)).toBeLessThanOrEqual(22_100);
    expect(minPositionFor(0.02, value)).toBe(MIN_POSITION);
  });

  it('takes a trade only when its kind’s safe estimate minus its charges is at least +0.05 R', () => {
    const weak = decide(newBrain(), [quick('Q')], book(), decideCtx({ evidence: allIn('proven', 0.12) }));
    expect(weak.decisions).toHaveLength(0);
    expect(weak.note).toMatch(/worth less than \+0\.05 R after charges/);
    expect(decide(newBrain(), [quick('Q')], book(), decideCtx({ evidence: allIn('proven', 0.2) })).decisions).toHaveLength(1);
  });

  it('no new buys while the market is falling, no new sell-first while it is rising', () => {
    const short = idea('S', { side: 'short', strategy: 'short', playbook: 'short-scan', price: 1000, stop: 1100, target: 800, t1: 900, ctx: ctx({ strategy: 'short', riskPct: 10 }) });
    const falling = decide(newBrain(), [idea('A'), short], book(), decideCtx({ market: { buys: 'NIFTY 50 −0.62% today', shorts: null } }));
    expect(falling.decisions.map((d) => d.idea.key)).toEqual(['S']);
    const onlyBuy = decide(newBrain(), [idea('A')], book(), decideCtx({ market: { buys: 'NIFTY 50 −0.62% today', shorts: null } }));
    expect(onlyBuy.note).toMatch(/the market is falling \(NIFTY 50 −0\.62% today\)/);
    const rising = decide(newBrain(), [idea('A'), short], book(), decideCtx({ market: { buys: null, shorts: 'NIFTY 50 +0.55% today' } }));
    expect(rising.decisions.map((d) => d.idea.key)).toEqual(['A']);
  });

  it('prove each kind first (switch on): only trial and proven kinds get money; the others are followed as shadow trades, off ones not at all', () => {
    const evidence = { ...allIn('proven'), 'day-buy': ev('day-buy', 'watch', -0.1), 'rise-strong': ev('rise-strong', 'paused', -0.3), breakout: ev('breakout', 'off') };
    const prove = { ...R, proveFirst: true };
    const plan = decide(newBrain(), [idea('A'), quick('B'), idea('C', { strategy: 'breakout', playbook: 'breakout' })], book({ rules: prove }), decideCtx({ evidence }));
    expect(plan.decisions).toHaveLength(0);
    expect(plan.shadow.map((x) => x.idea.key).sort()).toEqual(['A', 'B']);
    const a = plan.shadow.find((x) => x.idea.key === 'A')!;
    expect(a.riskRupees).toBe(12_500); // sized as a trial, so its charges are realistic
    expect(a.why).toBe('watch (test)');
    expect(plan.note).toMatch(/2 ideas of kinds not proven yet \(followed as shadow trades, no money\)/);
    // two losing trades today: that kind is followed without money for the rest of the day
    const braked = decide(newBrain(), [idea('A')], book({ rules: prove }), decideCtx({ braked: new Set(['day-buy']) }));
    expect(braked.decisions).toHaveLength(0);
    expect(braked.shadow[0]!.why).toBe('two losing trades today');
  });

  it('buy now (the default, app 1.24): kinds not proven yet buy with the small size while they learn — proven ones first, no shadow trades', () => {
    const evidence = { ...allIn('proven'), 'day-buy': ev('day-buy', 'watch', -0.1), 'rise-strong': ev('rise-strong', 'paused', -0.3), breakout: ev('breakout', 'off') };
    const swing = idea('D', { strategy: 'swing', playbook: 'swing-pick', ctx: ctx({ strategy: 'swing', riskPct: 10 }) });
    const plan = decide(newBrain(), [idea('A'), quick('B'), idea('C', { strategy: 'breakout', playbook: 'breakout' }), swing], book(), decideCtx({ evidence }));
    expect(plan.shadow).toEqual([]);
    expect(plan.decisions.map((d) => d.idea.key)).toEqual(['D', 'A', 'B']); // proven first; the switched-off breakout not at all
    expect(plan.decisions.map((d) => d.state)).toEqual(['proven', 'learning', 'learning']);
    const a = plan.decisions[1]!;
    expect(a.riskRupees).toBe(12_500); // the trial size: 0.25 % of ₹50 lakh
    expect(a.sizeWhy).toMatch(/^Learning \(kind not proven yet, small size\): ₹12,500 at risk/);
    expect(a.edgeR).toBeGreaterThan(0.05); // the brain's own estimate after this trade's real charges
    // two losing trades of that kind today: no money for it today, and no shadow trade either
    const braked = decide(newBrain(), [idea('A')], book(), decideCtx({ evidence, braked: new Set(['day-buy']) }));
    expect(braked.decisions).toHaveLength(0);
    expect(braked.shadow).toEqual([]);
    // not worth it by the brain's estimate after charges: not taken
    const poor = idea('P', { stop: 990, target: 1005, ctx: ctx({ strategy: 'day-buy', prior: 0.2, riskPct: 1 }) });
    expect(decide(newBrain(), [poor], book(), decideCtx({ evidence })).note).toMatch(/worth less than \+0\.05 R after charges/);
  });

  it('one idea per stock: the kind with the better state wins', () => {
    const evidence = { ...allIn('proven'), 'rise-flow': ev('rise-flow', 'watch', -0.2) };
    const plan = decide(newBrain(), [idea('A', { strategy: 'rising', playbook: 'rise-flow' }), idea('A')], book(), decideCtx({ evidence }));
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]!.idea.playbook).toBe('day-buy');
    expect(plan.shadow).toHaveLength(0);
  });

  it('at most 2 open trades in one industry', () => {
    const industryOf = (k: string) => (k === 'Z' ? 'Pharma' : 'Banks');
    const plan = decide(newBrain(), ['A', 'B', 'C', 'Z'].map((k) => idea(k)), book({ industries: { Banks: 1 } }), decideCtx({ industryOf }));
    expect(plan.decisions.map((d) => d.idea.key).sort()).toEqual(['A', 'Z']);
  });

  it('the drawdown brake: half size from 4 % below its best, no new trades from 8 %', () => {
    expect([drawdownFactor(drawdownOf(97, 100)), drawdownFactor(drawdownOf(96, 100)), drawdownFactor(drawdownOf(92, 100)), drawdownFactor(drawdownOf(120, 100))]).toEqual([1, 0.5, 0, 1]);
    expect(decide(newBrain(), [idea('A')], book({ ddFactor: 0.5 }), decideCtx()).decisions[0]!.riskRupees).toBe(12_500);
    const stopped = decide(newBrain(), [idea('A')], book({ ddFactor: 0, ddText: 'Stopped at −8%' }), decideCtx({ evidence: { ...allIn('proven'), 'rise-strong': ev('rise-strong', 'watch') } }));
    expect(stopped.decisions).toHaveLength(0);
    expect(stopped.note).toBe('Stopped at −8%');
  });

  it('no limit on trades a day, but it keeps the time rules, one trade per stock, and waits when all money is in trades', () => {
    expect(decide(newBrain(), [idea('A')], book({ newToday: 60 }), decideCtx()).decisions).toHaveLength(1);
    expect(decide(newBrain(), [idea('A')], book({ t: 9 * 60 + 20 }), decideCtx()).decisions).toHaveLength(0);
    expect(decide(newBrain(), [idea('A')], book({ t: 14 * 60 + 45 }), decideCtx()).note).toMatch(/No new same-day trades after 2:30 pm/);
    expect(decide(newBrain(), [idea('A', { strategy: 'swing', playbook: 'swing-pick', ctx: ctx({ strategy: 'swing', riskPct: 10 }) })], book({ t: 14 * 60 + 45 }), decideCtx()).decisions).toHaveLength(1);
    expect(decide(newBrain(), [idea('A')], book({ openKeys: ['A'], openCount: 1 }), decideCtx()).decisions).toHaveLength(0);
    const broke = decide(newBrain(), [idea('A')], book({ free: 1000 }), decideCtx());
    expect(broke.decisions).toHaveLength(0);
    expect(broke.note).toMatch(/All its money is in open trades/);
  });

  it('the brain still scores ideas (to rank them and for your own suggestions)', () => {
    const s = scoreIdea(newBrain(), idea('A', { stop: 999, target: 1000.8, ctx: ctx({ strategy: 'day-buy', prior: 0.6, riskPct: 0.1 }) }))!;
    expect(s.ev).toBeLessThan(0.05);
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
