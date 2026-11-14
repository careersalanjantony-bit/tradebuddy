import { features, predict, strategyFocus, type Brain, type IdeaContext, type Strategy } from './brain';

/**
 * The auto-trader's rules: which ideas to take and how much pretend money to put in. Pure functions.
 *
 * App v1.8 (owner: "no limit for auto trading, you can use any amount"): no cap on open trades, on
 * new trades a day, on the day's loss or on the share of money in one stock. What is left:
 * - Expected result per trade, in R (1 R = the planned loss at the safety net):
 *     EV = chance × reward/risk − (1 − chance) × 1 − charges/risk
 *   Only ideas with EV > 0.05 R are taken, best first.
 * - Size from its own confidence (a quarter of the Kelly fraction): it risks between 0.25 % and 3 %
 *   of its money on a trade, and may put in any amount up to all its free cash (no borrowing). When
 *   several good ideas appear at once, the free cash is shared among them by how good each one is.
 * - About 1 in 8 decisions is a small "test trade" on an idea it is unsure about, so it keeps
 *   learning about kinds of trades it would otherwise never try.
 * - Same-day trades are opened until 2:30 pm (they must be closed by 3:10); top picks until 3:15.
 */

export const BOT_START = 5_000_000;
/** smallest trade worth the charges */
export const MIN_POSITION = 5_000;
export const EXPLORE_RATE = 0.125;
/** share of the Kelly fraction used (full Kelly assumes the chance is exactly right — it never is) */
export const KELLY_SHARE = 0.25;
export const MIN_RISK = 0.0025;
export const MAX_RISK = 0.03;
export const EXPLORE_RISK = 0.002;
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

/** Share of its money to risk on one trade: a quarter of Kelly, between 0.25 % and 3 %. */
export function riskFraction(chance: number, rewardR: number): number {
  const kelly = chance - (1 - chance) / Math.max(0.1, rewardR);
  return Math.min(MAX_RISK, Math.max(MIN_RISK, kelly * KELLY_SHARE));
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

const pctText = (x: number) => `${Math.round(x * 10000) / 100}%`;

export function decide(brain: Brain, ideas: Idea[], book: Book, seed: string): Plan {
  if (book.t < FIRST_ENTRY_T) return { decisions: [], note: 'Waits until 9:30 am — the first minutes are too jumpy.' };
  const seen = new Set(book.openKeys);
  const scored = ideas
    .filter((i) => !seen.has(i.key))
    .filter((i) => (i.strategy === 'swing' ? book.t <= LAST_SWING_ENTRY_T : book.t <= LAST_DAY_ENTRY_T))
    .map((i) => scoreIdea(brain, i))
    .filter((s): s is Scored => !!s)
    .sort((a, b) => b.ev - a.ev);
  if (!scored.length) return { decisions: [], note: book.t > LAST_DAY_ENTRY_T ? 'No new same-day trades after 2:30 pm (they must be closed by 3:10).' : 'No idea right now — waiting for one.' };
  if (book.free < MIN_POSITION) return { decisions: [], note: 'All its money is in open trades — it waits for one to finish.' };

  const good = scored.filter((s) => s.ev > 0.05 && strategyFocus(brain.by[s.strategy]) !== 'paused');
  const explore = good.length === 0 || hash01(seed) < EXPLORE_RATE ? scored.find((s) => !good.includes(s) && s.ev > -0.4) : undefined;
  // the free cash is shared among the good ideas by how good each one is
  const weight = good.reduce((sum, s) => sum + s.ev, 0);
  const decisions: Decision[] = [];
  let free = book.free;
  const take = (idea: Scored, isExplore: boolean, cashShare: number) => {
    const perShare = Math.abs(idea.price - idea.stop);
    const focus = strategyFocus(brain.by[idea.strategy]);
    const fraction = isExplore ? EXPLORE_RISK : riskFraction(idea.chance, idea.rewardR) * (focus === 'less' ? 0.6 : 1);
    let qty = Math.floor((book.equity * fraction) / perShare);
    // the fill can be a little worse than the live price (slippage, 5-paise ticks): keep a margin
    const fillPrice = idea.price * 1.002;
    const cash = Math.min(cashShare, free * 0.995);
    if (qty * fillPrice > cash) qty = Math.floor(cash / fillPrice);
    if (qty < 1 || qty * idea.price < MIN_POSITION) return;
    free -= qty * fillPrice;
    const riskRupees = Math.round(qty * perShare);
    const atRisk = riskRupees / book.equity;
    decisions.push({
      idea,
      qty,
      riskRupees,
      explore: isExplore,
      sizeWhy: isExplore
        ? `Test trade: small (${pctText(atRisk)} of its money at risk) — it is unsure and wants to learn.`
        : `${Math.round(idea.chance * 100)}% chance, ${idea.rewardR.toFixed(1)}× reward → ${formatRs(qty * idea.price)} in (${pctText((qty * idea.price) / book.equity)} of its money), ${pctText(atRisk)} at risk${focus === 'less' ? ' (smaller: this kind of trade has been losing)' : ''}.`,
    });
  };
  for (const s of good) take(s, false, weight > 0 ? book.free * (s.ev / weight) : book.free);
  if (explore) take(explore, true, free);
  return {
    decisions,
    note: decisions.length ? null : `Looked at ${scored.length} idea${scored.length === 1 ? '' : 's'}; none good enough after charges (best: ${Math.round(scored[0]!.chance * 100)}% chance).`,
  };
}

const formatRs = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;

/** Moves the safety net to the buy price once a trade is 1 R in profit (it can no longer lose). */
export function trailStop(side: 'long' | 'short', entry: number, stop: number, price: number): number {
  const r = Math.abs(entry - stop);
  if (side === 'long' && price >= entry + r && stop < entry) return entry;
  if (side === 'short' && price <= entry - r && stop > entry) return entry;
  return stop;
}
