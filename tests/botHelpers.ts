import type { PlaybookEvidence, PlaybookState } from '../src/bot/evidence';
import { PLAYBOOKS, type PlaybookId } from '../src/bot/playbooks';
import type { DecideContext } from '../src/bot/policy';
import { estimateCharges } from '../src/wallet/wallet';

/**
 * A record that proves a kind of trade (30 finished trades of +1 R before charges), as an auto-trader that
 * has been trading for a while holds it — for tests of other things (the cloud, alerts) that need it to trade.
 */
export const provenRecord = (id: PlaybookId = 'day-buy', n = 30) => ({ [id]: Array.from({ length: n }, (_, i) => ({ at: i, grossR: 1, netR: 0.9 })) });

/** A playbook's evidence as the decision sees it (only `state` and `safeR` matter there). */
export const ev = (id: PlaybookId, state: PlaybookState, safeR = 0.3): PlaybookEvidence => ({
  id,
  state,
  n: 40,
  shadow: 0,
  wins: 22,
  avgGrossR: safeR + 0.1,
  avgNetR: safeR,
  safeR,
  last20R: safeR,
  prior: null,
  priorCounted: false,
  why: `${state} (test)`,
});

/** Every playbook in one state. */
export const allIn = (state: PlaybookState, safeR = 0.3): Partial<Record<PlaybookId, PlaybookEvidence>> => Object.fromEntries(PLAYBOOKS.map((p) => [p, ev(p, state, safeR)]));

/** The decision's context: every playbook proven, an open market, real Upstox charges. */
export const decideCtx = (over: Partial<DecideContext> = {}): DecideContext => ({
  evidence: allIn('proven'),
  market: { buys: null, shorts: null },
  charges: (product, qty, price) => estimateCharges(product, qty, price),
  ...over,
});
