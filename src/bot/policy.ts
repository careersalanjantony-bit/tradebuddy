import type { WalletQuote } from '../wallet/wallet';
import { features, predict, type Brain, type IdeaContext, type Strategy } from './brain';
import type { PlaybookEvidence, PlaybookState } from './evidence';
import type { PlaybookId } from './playbooks';
import { maxOpenFor, maxPositionFor, skipIdea, type ProtectRules } from './protect';

/**
 * The auto-trader's rules: which ideas to take and how much pretend money to put in. Pure functions.
 *
 * App v1.23 — evidence first (docs/AUTO_TRADER_PLAN.md). It replaces the "no limits" sizing of app v1.8
 * (a quarter of Kelly from a guessed chance, test trades with money):
 * - Each idea belongs to a playbook (bot/playbooks.ts). Only playbooks whose own results earned the
 *   state "trial" or "proven" (bot/evidence.ts) get money; the others are followed as shadow trades.
 * - Size: a fixed share of the money at risk — 0.25 % (trial) or 0.5 % (proven), never more than half the
 *   daily loss limit, halved by the drawdown brake. All open trades together risk at most 2 %; at most 2
 *   open trades per industry.
 * - Charges: Upstox's real charges for this size. A trade whose charges are more than a quarter of its
 *   risk is skipped, and the playbook's safe estimate minus the charges must still be at least +0.05 R.
 * - No new buys while the market is falling, no new sell-first trades while it is rising (the same rules
 *   as the alerts).
 * - Same-day trades are opened until 2:30 pm (they must be closed by 3:10); top picks until 3:15.
 */

export const BOT_START = 5_000_000;
/** smallest trade worth the charges */
export const MIN_POSITION = 5_000;
/** share of the money at risk per trade, by the playbook's state */
export const RISK_SHARE = { trial: 0.0025, proven: 0.005 } as const;
/** all open trades together may lose at most this share of the money at their safety nets */
export const MAX_OPEN_RISK = 0.02;
/** open trades in one industry */
export const MAX_PER_INDUSTRY = 2;
/** charges may be at most this share of the trade's risk */
export const MAX_CHARGES_R = 0.25;
/** a trade must still be worth this much after its charges (R) */
export const MIN_EDGE_R = 0.05;
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
  /** app v1.23: the kind of trade it is judged as */
  playbook: PlaybookId;
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
  /** the price to trade at when the shared prices do not have this stock (the Intraday scanner's own) */
  quote?: WalletQuote;
}

export interface Scored extends Idea {
  x: number[];
  /** the brain's chance (studies + its own learning + live signs): used to rank, never to size */
  chance: number;
  rewardR: number;
  /** rough charges in R (0.1 % / 0.25 % of the price) — the brain's own estimate, for the suggestions */
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
  /** app v1.13: the money protection (undefined = off) */
  rules?: ProtectRules;
  /** stopped for the day by the protection */
  halted?: 'lock' | 'loss' | null;
  /** money now in "hold a few days" picks */
  swingValue?: number;
  /** app v1.23: ₹ the open trades can still lose at their safety nets (protect.openRiskOf) */
  openRisk?: number;
  /** app v1.23: open trades per industry */
  industries?: Record<string, number>;
  /** app v1.23: the drawdown brake's size factor (1, 0.5 or 0) and why */
  ddFactor?: number;
  ddText?: string | null;
}

/** Why no new trades in one direction right now (null = fine). */
export interface MarketGates {
  /** a falling market: no new buys */
  buys: string | null;
  /** a rising market: no new sell-first trades */
  shorts: string | null;
}

export interface DecideContext {
  /** each playbook's state (bot/evidence.ts); a playbook missing here counts as "watch" */
  evidence: Partial<Record<PlaybookId, PlaybookEvidence>>;
  market: MarketGates;
  /** playbooks stopped for today (two losing trades today) */
  braked?: ReadonlySet<PlaybookId>;
  industryOf?: (key: string) => string | undefined;
  /** ₹ to buy and sell `qty` at `price` with this product (wallet.estimateCharges) */
  charges: (product: 'intraday' | 'delivery', qty: number, price: number) => number;
}

export interface Decision {
  idea: Scored;
  qty: number;
  /** ₹ it can lose at the safety net */
  riskRupees: number;
  state: 'trial' | 'proven';
  /** this trade's charges in R */
  chargesR: number;
  /** what it is worth after its charges: the playbook's safe estimate minus chargesR (R) */
  edgeR: number;
  /** plain words: why this size */
  sizeWhy: string;
}

/** An idea of a playbook that may not trade yet: followed without money. */
export interface ShadowPick {
  idea: Scored;
  qty: number;
  riskRupees: number;
  why: string;
}

export interface Plan {
  decisions: Decision[];
  shadow: ShadowPick[];
  /** why nothing (more) was opened, in plain words */
  note: string | null;
}

const pctText = (x: number) => `${Math.round(x * 10000) / 100}%`;
const formatRs = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const rText = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} R`;
const RANK: Record<PlaybookState, number> = { proven: 4, trial: 3, watch: 2, paused: 1, off: 0 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The state a playbook trades with now (braked for today = no money today). */
function stateOf(e: PlaybookEvidence | undefined, braked: boolean): PlaybookState {
  if (!e) return 'watch';
  return braked && (e.state === 'trial' || e.state === 'proven') ? 'watch' : e.state;
}

/** Share of the money it risks on a trade of this state (before the drawdown brake). */
export function riskShareFor(state: PlaybookState, rules?: ProtectRules): number {
  const base = state === 'proven' ? RISK_SHARE.proven : state === 'trial' ? RISK_SHARE.trial : 0;
  return rules?.on ? Math.min(base, rules.dayLossPct / 100 / 2) : base;
}

/** The smallest position whose charges stay within MAX_CHARGES_R of its risk, for a stop `stopPct` (0–1) away. */
export function minPositionFor(stopPct: number, chargesOfValue: (value: number) => number): number {
  if (!(stopPct > 0)) return Infinity;
  const ok = (v: number) => chargesOfValue(v) <= MAX_CHARGES_R * v * stopPct;
  let hi = MIN_POSITION;
  while (!ok(hi) && hi < 1e10) hi *= 2;
  if (!ok(hi)) return Infinity;
  let lo = hi === MIN_POSITION ? MIN_POSITION : hi / 2;
  if (ok(lo)) return lo;
  while (hi - lo > 100) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi / 100) * 100;
}

export function decide(brain: Brain, ideas: Idea[], book: Book, c: DecideContext): Plan {
  if (book.t < FIRST_ENTRY_T) return { decisions: [], shadow: [], note: 'Waits until 9:30 am — the first minutes are too jumpy.' };
  const protect = book.rules?.on ? book.rules : null;
  const seen = new Set(book.openKeys);
  const counts = { skip: 0, market: 0, late: 0 };
  let marketWhy = '';

  // 1. the plain filters: one trade per stock, entry times, news and market against it, the market gates
  const passed = ideas.filter((i) => {
    if (seen.has(i.key)) return false;
    if (!(i.strategy === 'swing' ? book.t <= LAST_SWING_ENTRY_T : book.t <= LAST_DAY_ENTRY_T)) return (counts.late++, false);
    if (protect && skipIdea(i.ctx, protect)) return (counts.skip++, false);
    const gate = i.side === 'long' ? c.market.buys : c.market.shorts;
    if (gate) {
      counts.market++;
      marketWhy ||= i.side === 'long' ? `the market is falling (${gate})` : `the market is rising (${gate})`;
      return false;
    }
    return true;
  });

  // 2. scored, one idea per stock: the one whose playbook has the better state, then the better estimate
  const best = new Map<string, Scored>();
  for (const i of passed) {
    const s = scoreIdea(brain, i);
    if (!s) continue;
    const prev = best.get(i.key);
    const rank = (x: Scored) => RANK[stateOf(c.evidence[x.playbook], !!c.braked?.has(x.playbook))] * 100 + (c.evidence[x.playbook]?.safeR ?? -9);
    if (!prev || rank(s) > rank(prev)) best.set(i.key, s);
  }
  const scored = [...best.values()];

  // 3. playbooks that may not trade (watch, paused, two losses today): followed as shadow trades, sized as a trial
  const allowed: Array<{ s: Scored; e: PlaybookEvidence; state: 'trial' | 'proven' }> = [];
  const shadow: ShadowPick[] = [];
  for (const s of scored) {
    const e = c.evidence[s.playbook];
    const braked = !!c.braked?.has(s.playbook);
    const state = stateOf(e, braked);
    if ((state === 'trial' || state === 'proven') && e && e.safeR !== null) {
      allowed.push({ s, e, state });
      continue;
    }
    if (state === 'off') continue;
    const perShare = Math.abs(s.price - s.stop);
    const cap = protect ? maxPositionFor(book.equity) : Infinity;
    const qty = Math.max(1, Math.min(Math.floor((book.equity * RISK_SHARE.trial) / perShare), Math.floor(cap / s.price)));
    shadow.push({ idea: s, qty, riskRupees: Math.round(qty * perShare), why: braked ? 'two losing trades today' : (e?.why ?? 'not proven yet') });
  }

  if (protect && book.halted) {
    return { decisions: [], shadow, note: book.halted === 'lock' ? "Stopped for today: it kept today's profit (sold what it bought today). Back tomorrow at 9:30." : 'Stopped for today: the daily loss limit was reached (sold what it bought today). Back tomorrow at 9:30.' };
  }
  const dd = book.ddFactor ?? 1;
  if (dd <= 0) return { decisions: [], shadow, note: book.ddText ?? 'Stopped: its money is 8% below its best. Press Resume to let it trade again.' };
  if (!scored.length && !counts.skip && !counts.market) {
    return { decisions: [], shadow, note: counts.late || book.t > LAST_DAY_ENTRY_T ? 'No new same-day trades after 2:30 pm (they must be closed by 3:10).' : 'No idea right now — waiting for one.' };
  }
  const slots = protect ? maxOpenFor(book.equity) - book.openCount : Infinity;
  if (slots <= 0) return { decisions: [], shadow, note: `Holding ${book.openCount} trades — the most for ${formatRs(book.equity)}. It waits for one to finish.` };
  if (book.free < MIN_POSITION) return { decisions: [], shadow, note: 'All its money is in open trades — it waits for one to finish.' };

  // 4. size each allowed idea and rank them by what they are worth after their own charges
  const perTrade = protect ? maxPositionFor(book.equity) : Infinity;
  let swingRoom = protect ? Math.max(0, (book.equity * protect.swingSharePct) / 100 - (book.swingValue ?? 0)) : Infinity;
  let free = book.free;
  let openRisk = book.openRisk ?? 0;
  const industries: Record<string, number> = { ...(book.industries ?? {}) };
  const skips = { industry: 0, heat: 0, small: 0, charges: 0, edge: 0 };
  const sizeOf = (x: (typeof allowed)[number], room: { free: number; openRisk: number; swingRoom: number }) => {
    const { s, state } = x;
    const perShare = Math.abs(s.price - s.stop);
    const share = riskShareFor(state, protect ?? undefined) * dd;
    let qty = Math.floor((book.equity * share) / perShare);
    const fillPrice = s.price * 1.002; // the fill can be a little worse than the live price
    const cash = Math.min(room.free * 0.995, perTrade, s.strategy === 'swing' ? room.swingRoom : Infinity);
    if (qty * fillPrice > cash) qty = Math.floor(cash / fillPrice);
    const heatRoom = MAX_OPEN_RISK * book.equity - room.openRisk;
    const heatQty = Math.floor(heatRoom / perShare);
    const byHeat = heatQty < qty;
    if (byHeat) qty = heatQty;
    if (qty < 1 || qty * s.price < MIN_POSITION) return { qty: 0, why: byHeat ? ('heat' as const) : ('small' as const), share, perShare, chargesR: 0, edgeR: 0 };
    const chargesR = c.charges(s.strategy === 'swing' ? 'delivery' : 'intraday', qty, s.price) / (qty * perShare);
    if (chargesR > MAX_CHARGES_R) return { qty: 0, why: 'charges' as const, share, perShare, chargesR, edgeR: 0 };
    const edgeR = x.e.safeR! - chargesR;
    if (edgeR < MIN_EDGE_R) return { qty: 0, why: 'edge' as const, share, perShare, chargesR, edgeR };
    return { qty, why: null, share, perShare, chargesR, edgeR };
  };
  const ranked = allowed
    .map((x) => ({ x, first: sizeOf(x, { free, openRisk, swingRoom }) }))
    .sort((a, b) => b.first.edgeR - a.first.edgeR || b.x.s.chance - a.x.s.chance);

  const decisions: Decision[] = [];
  for (const { x } of ranked) {
    if (decisions.length >= slots) break;
    const industry = c.industryOf?.(x.s.key);
    if (industry && (industries[industry] ?? 0) >= MAX_PER_INDUSTRY) {
      skips.industry++;
      continue;
    }
    const z = sizeOf(x, { free, openRisk, swingRoom });
    if (!z.qty) {
      skips[z.why!]++;
      continue;
    }
    const s = x.s;
    const fill = z.qty * s.price * 1.002;
    free -= fill;
    openRisk += z.qty * z.perShare;
    if (s.strategy === 'swing') swingRoom -= fill;
    if (industry) industries[industry] = (industries[industry] ?? 0) + 1;
    const riskRupees = Math.round(z.qty * z.perShare);
    decisions.push({
      idea: s,
      qty: z.qty,
      riskRupees,
      state: x.state,
      chargesR: Math.round(z.chargesR * 1000) / 1000,
      edgeR: Math.round(z.edgeR * 1000) / 1000,
      sizeWhy: `${x.state === 'proven' ? 'Proven kind' : 'Trial kind (small size)'}: ${formatRs(riskRupees)} at risk (${pctText(riskRupees / book.equity)} of its money${dd < 1 ? ', halved by the drawdown brake' : ''}), charges ${z.chargesR.toFixed(2)} R, worth ${rText(z.edgeR)} after charges.`,
    });
  }

  let note: string | null = null;
  if (!decisions.length) {
    const parts = [
      shadow.length && `${plural(shadow.length, 'idea')} of kinds not proven yet (followed as shadow trades, no money)`,
      counts.skip && `skipped ${plural(counts.skip, 'idea')} (news against it, or the whole market going the other way)`,
      counts.market && `${plural(counts.market, 'idea')} not taken: ${marketWhy}`,
      skips.charges && `${plural(skips.charges, 'idea')}: charges would be more than a quarter of the risk at this size`,
      skips.edge && `${plural(skips.edge, 'idea')} worth less than ${rText(MIN_EDGE_R)} after charges`,
      skips.heat && `${plural(skips.heat, 'idea')}: its open trades already risk ${pctText(MAX_OPEN_RISK)} of the money`,
      skips.industry && `${plural(skips.industry, 'idea')}: already ${MAX_PER_INDUSTRY} trades in that industry`,
      skips.small && `${plural(skips.small, 'idea')} too small to be worth a trade`,
    ].filter(Boolean);
    note = parts.length ? `Looked at ${plural(scored.length + counts.skip + counts.market, 'idea')}: ${parts.join('; ')}.` : 'No idea right now — waiting for one.';
  }
  return { decisions, shadow, note };
}

/** Moves the safety net to the buy price once a trade is 1 R in profit (it can no longer lose). */
export function trailStop(side: 'long' | 'short', entry: number, stop: number, price: number): number {
  const r = Math.abs(entry - stop);
  if (side === 'long' && price >= entry + r && stop < entry) return entry;
  if (side === 'short' && price <= entry - r && stop > entry) return entry;
  return stop;
}
