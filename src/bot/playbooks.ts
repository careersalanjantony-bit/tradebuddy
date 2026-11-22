import type { Strategy } from './brain';

/**
 * App v1.23 — the auto-trader's kinds of trade ("playbooks"). Each one is judged on its own results
 * (bot/evidence.ts): a kind that has not shown an edge after charges gets no money, however good its
 * ideas look. Pure: no storage, no network.
 *
 * The brain keeps its five strategies (its saved weights do not change); a playbook is the finer kind
 * of trade, and two playbooks can share a strategy (e.g. the Intraday scanner's BUY is a breakout).
 */

export type PlaybookId = 'day-buy' | 'rise-strong' | 'rise-flow' | 'swing-pick' | 'short-scan' | 'short-model' | 'breakout' | 'intraday-buy';

export const PLAYBOOKS: readonly PlaybookId[] = ['day-buy', 'rise-strong', 'rise-flow', 'swing-pick', 'short-scan', 'short-model', 'breakout', 'intraday-buy'];

export const PLAYBOOK_LABEL: Record<PlaybookId, string> = {
  'day-buy': 'Day-trade buy signals',
  'rise-strong': 'Rising now ("likely to keep rising")',
  'rise-flow': 'Rising today (older list)',
  'swing-pick': 'Top picks (hold a few days)',
  'short-scan': 'Falling now (sell first)',
  'short-model': '"For short selling" list',
  breakout: 'Breakouts',
  'intraday-buy': 'Intraday scanner BUY',
};

/** The brain's strategy for each playbook (its features and its old scorecard). */
export const PLAYBOOK_STRATEGY: Record<PlaybookId, Strategy> = {
  'day-buy': 'day-buy',
  'rise-strong': 'rising',
  'rise-flow': 'rising',
  'swing-pick': 'swing',
  'short-scan': 'short',
  'short-model': 'short',
  breakout: 'breakout',
  'intraday-buy': 'breakout',
};

export const isPlaybookId = (v: unknown): v is PlaybookId => typeof v === 'string' && (PLAYBOOKS as readonly string[]).includes(v);

/** The first reason of a "Rising now" quick trade (botJobs.gatherIdeas) — how an old trade is recognised. */
export const RISE_STRONG_REASON = 'Rising now: likely to keep rising';

/**
 * The playbook of a trade. Trades opened before app 1.23 have none: it is read from the kind of trade
 * and its first reason (the two "rising" and the two "short" sources wrote different first reasons).
 */
export function playbookOf(t: { playbook?: PlaybookId; strategy: Strategy; reasons?: readonly string[] }): PlaybookId {
  if (t.playbook && isPlaybookId(t.playbook)) return t.playbook;
  const first = t.reasons?.[0] ?? '';
  switch (t.strategy) {
    case 'day-buy':
      return 'day-buy';
    case 'swing':
      return 'swing-pick';
    case 'breakout':
      return 'breakout';
    case 'rising':
      return first === RISE_STRONG_REASON ? 'rise-strong' : 'rise-flow';
    case 'short':
      return first.startsWith('falling now') ? 'short-scan' : 'short-model';
  }
}
