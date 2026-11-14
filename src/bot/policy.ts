import { features, predict, strategyFocus, type Brain, type IdeaContext, type Strategy } from './brain';

/**
 * The auto-trader's rules (app v1.6): which ideas to take and how much pretend money to put in.
 * Pure functions only.
 *
 * - Expected result per trade, in R (1 R = the planned loss at the safety net):
 *     EV = chance × reward/risk − (1 − chance) × 1 − charges/risk
 *   Only ideas with EV > 0.05 R are taken, best first.
 * - Size: it risks 0.5 % of its money on a normal trade, from 0.15 % (unsure) to 0.75 % (confident),
 *   never more than 20 % of its money in one stock, at most 6 trades open and 10 new trades a day.
 * - It stops opening trades for the day after losing 1.5 % of its money that day.
 * - About 1 in 8 decisions is a small "test trade" on an idea it is unsure about, so it keeps
 *   learning about kinds of trades it would otherwise never try.
 */

export const BOT_START = 5_000_000;
export const MAX_OPEN = 6;
export const MAX_NEW_PER_DAY = 10;
export const DAILY_LOSS_LIMIT = 0.015;
export const BASE_RISK = 0.005;
export const MAX_POSITION = 0.2;
export const MIN_POSITION = 20_000;
export const EXPLORE_RATE = 0.125;
/** no new same-day trades after 2:30 pm; swing (few-day) entries until 3:15 pm */
export const LAST_DAY_ENTRY_T = 14 * 60 + 30;
export const LAST_SWING_ENTRY_T = 15 * 60 + 15;
export const FIRST_ENTRY_T = 9 * 60 + 30;
/** top picks are sold after this many trading days if neither price was reached */
export const SWING_MAX_DAYS = 10;

export interface Idea {
  key: string;
  symbol: string;
  strategy: Strategy;
  side: 'long' | 'short';
  /** live price now */
  price: number;
  stop: number;
  target: number;
  /** sell-first only: first target (half is bought back there) */
  t1?: number;
  ctx: IdeaContext;
  /** plain words: why this idea exists */
  reasons: string[];
}

export interface Scored extends Idea {
  x: number[];
  chance: number;
  rewardR: number;
  chargesR: number;
  ev: number;
}

/** Rough round-trip charges as a share of the money traded (intraday ≈ 0.1 %, delivery ≈ 0.25 %). */
export const chargesShare = (s: Strategy) => (s === 'swing' ? 0.0025 : 0.001);

export function scoreIdea(brain: Brain, idea: Idea): Scored | null {
  const risk = Math.abs(idea.price - idea.stop);
  if (!(risk > 0) || !(idea.price > 0)) return null;
  const reward = idea.side === 'long' ? idea.target - idea.price : idea.price - (idea.t1 !== undefined ? (idea.t1 + idea.target) / 2 : idea.target);
  if (!(reward > 0)) return null;
  const x = features(idea.ctx);
  const chance = predict(brain, x);
  const rewardR = reward / risk;
  const chargesR = (idea.price * chargesShare(idea.strategy)) / risk;
  const ev = chance * rewardR - (1 - chance) - chargesR;
  return { ...idea, x, chance, rewardR, chargesR, ev };
}

export interface Book {
  /** money now (cash + open trades at live prices) */
  equity: number;
  /** cash free to use */
  free: number;
  openKeys: string[];
  openCount: number;
  newToday: number;
  /** today's result so far (closed + open), ₹ */
  todayPnl: number;
  /** minutes since midnight IST */
  t: number;
}

export interface Decision {
  idea: Scored;
  qty: number;
  /** ₹ it can lose at the safety net */
  riskRupees: number;
  explore: boolean;
  /** plain words: why this size */
  sizeWhy: string;
}

export interface Plan {
  decisions: Decision[];
  /** why nothing (more) was opened, in plain words */
  note: string | null;
}

/** Deterministic "random" in [0,1) from a string, so tests and replays give the same answer. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

export function decide(brain: Brain, ideas: Idea[], book: Book, seed: string): Plan {
  if (book.todayPnl <= -DAILY_LOSS_LIMIT * book.equity) return { decisions: [], note: `Stopped for today: it lost ${Math.round(DAILY_LOSS_LIMIT * 1000) / 10}% of its money today (its own safety rule).` };
  if (book.t < FIRST_ENTRY_T) return { decisions: [], note: 'Waits until 9:30 am — the first minutes are too jumpy.' };
  let slots = Math.min(MAX_OPEN - book.openCount, MAX_NEW_PER_DAY - book.newToday);
  if (slots <= 0) return { decisions: [], note: book.openCount >= MAX_OPEN ? `${MAX_OPEN} trades already open — waits for one to finish.` : `${MAX_NEW_PER_DAY} new trades today already — its daily limit.` };
  const seen = new Set(book.openKeys);
  const scored = ideas
    .filter((i) => !seen.has(i.key))
    .filter((i) => (i.strategy === 'swing' ? book.t <= LAST_SWING_ENTRY_T : book.t <= LAST_DAY_ENTRY_T))
    .map((i) => scoreIdea(brain, i))
    .filter((s): s is Scored => !!s)
    .sort((a, b) => b.ev - a.ev);
  if (!scored.length) return { decisions: [], note: book.t > LAST_DAY_ENTRY_T ? 'No new same-day trades after 2:30 pm.' : 'No idea right now — waiting for one.' };
  const decisions: Decision[] = [];
  let free = book.free;
  const used = new Set<string>();
  const take = (idea: Scored, explore: boolean) => {
    if (used.has(idea.key)) return;
    const focus = strategyFocus(brain.by[idea.strategy]);
    const confidence = explore ? 0.3 : Math.min(1.5, Math.max(0.3, (idea.chance - 0.4) / 0.15)) * (focus === 'less' ? 0.6 : 1);
    const riskBudget = book.equity * BASE_RISK * confidence;
    const perShare = Math.abs(idea.price - idea.stop);
    let qty = Math.floor(riskBudget / perShare);
    const cap = Math.min(book.equity * MAX_POSITION, free * 0.98);
    // the fill can be a little worse than the live price (slippage, 5-paise ticks): keep a margin
    const fillPrice = idea.price * 1.002;
    if (qty * fillPrice > cap) qty = Math.floor(cap / fillPrice);
    if (qty < 1 || qty * idea.price < MIN_POSITION) return;
    free -= qty * idea.price;
    used.add(idea.key);
    const pct = Math.round(((qty * perShare) / book.equity) * 10000) / 100;
    decisions.push({
      idea,
      qty,
      riskRupees: Math.round(qty * perShare),
      explore,
      sizeWhy: explore
        ? `Test trade: small (${pct}% of its money at risk) — it is unsure and wants to learn.`
        : `${Math.round(idea.chance * 100)}% chance → risks ${pct}% of its money (${focus === 'less' ? 'smaller: this kind of trade has been losing' : idea.chance >= 0.6 ? 'confident' : 'normal'}).`,
    });
  };
  for (const s of scored) {
    if (decisions.length >= slots) break;
    const paused = strategyFocus(brain.by[s.strategy]) === 'paused';
    if (s.ev > 0.05 && !paused) take(s, false);
  }
  // now and then, a small test trade on the best idea it would otherwise skip
  if (decisions.length < slots && hash01(seed) < EXPLORE_RATE) {
    const rest = scored.find((s) => !used.has(s.key) && s.ev > -0.4);
    if (rest) take(rest, true);
  }
  slots -= decisions.length;
  return { decisions, note: decisions.length ? null : `Looked at ${scored.length} idea${scored.length === 1 ? '' : 's'}; none good enough after charges (best: ${Math.round(scored[0]!.chance * 100)}% chance).` };
}

/** Moves the safety net to the buy price once a trade is 1 R in profit (it can no longer lose). */
export function trailStop(side: 'long' | 'short', entry: number, stop: number, price: number): number {
  const r = Math.abs(entry - stop);
  if (side === 'long' && price >= entry + r && stop < entry) return entry;
  if (side === 'short' && price <= entry - r && stop > entry) return entry;
  return stop;
}
