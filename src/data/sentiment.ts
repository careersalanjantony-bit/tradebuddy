/**
 * Headline mood without any paid service: known good and bad words and phrases in Indian market
 * news, weighted. "Order win", "profit rises", "upgrade" count as good; "loss", "penalty", "raid",
 * "downgrade", "resigns" as bad. Simple and transparent — and only used to WARN (a buy signal on a
 * stock with bad news today gets a warning), never to create a trade.
 */

const POSITIVE: Array<[RegExp, number]> = [
  [/\b(bags?|wins?|won|secures?|bagged|clinch(es|ed)?)\b.{0,40}\b(order|contract|deal|project)s?\b/i, 2],
  [/\b(order|contract)s?\s+(worth|win|inflow)\b/i, 1.5],
  [/\b(net\s+)?profit\s+(rises?|jumps?|surges?|soars?|up|grows?|climbs?)\b/i, 2],
  [/\b(revenue|sales|income|margin)s?\s+(rises?|jumps?|surges?|up|grows?|beats?)\b/i, 1.5],
  [/\b(beats?|tops?)\s+(estimates?|expectations?|street)\b/i, 2],
  [/\bupgrade[sd]?\b/i, 1.5],
  [/\b(target price|tp)\s+(raised|hiked|increased)\b/i, 1.5],
  [/\b(record|all[- ]time)\s+high\b/i, 1],
  [/\b(buyback|bonus|special dividend|dividend)\b/i, 1],
  [/\b(approval|approves?|nod|clearance)\b/i, 1],
  [/\b(stake\s+(buy|purchase|acquisition)|acquires?|expansion|launch(es|ed)?)\b/i, 0.8],
  [/\b(rall(y|ies)|surges?|jumps?|soars?|gains?)\b/i, 0.7],
  [/\b(strong|robust|healthy|bullish)\b/i, 0.5],
];

const NEGATIVE: Array<[RegExp, number]> = [
  [/\b(net\s+)?(loss|losses)\b/i, 1.5],
  [/\b(net\s+)?profit\s+(falls?|drops?|declines?|slumps?|down|plunges?|dips?)\b/i, 2],
  [/\b(revenue|sales|income|margin)s?\s+(falls?|drops?|declines?|down|miss(es)?)\b/i, 1.5],
  [/\b(miss(es|ed)?)\s+(estimates?|expectations?)\b/i, 2],
  [/\bdowngrade[sd]?\b/i, 1.5],
  [/\b(target price|tp)\s+(cut|lowered|reduced)\b/i, 1.5],
  [/\b(penalty|fine[sd]?|ban(ned)?|show[- ]cause|sebi order|probe|raid(s|ed)?|fraud|default(s|ed)?|insolvency)\b/i, 2],
  [/\b(resigns?|resignation|steps? down|quits?)\b/i, 1.2],
  [/\b(pledge[sd]?|block deal|stake sale|offloads?|sells? stake|ofs)\b/i, 1],
  [/\b(fire|accident|strike|shutdown|recall)\b/i, 1.2],
  [/\b(crash(es|ed)?|plunges?|tanks?|slumps?|tumbles?|sinks?|falls?|drops?|slides?)\b/i, 0.8],
  [/\b(weak|bearish|concern|worries|pressure)\b/i, 0.5],
  [/\b(52[- ]week|year)\s+low\b/i, 1],
];

export interface Sentiment {
  /** −1 … +1 */
  score: number;
  label: 'good' | 'bad' | 'neutral';
}

export function headlineSentiment(text: string): Sentiment {
  let pos = 0;
  let neg = 0;
  for (const [re, w] of POSITIVE) if (re.test(text)) pos += w;
  for (const [re, w] of NEGATIVE) if (re.test(text)) neg += w;
  const raw = pos - neg;
  const score = Math.max(-1, Math.min(1, raw / 3));
  return { score, label: score >= 0.3 ? 'good' : score <= -0.3 ? 'bad' : 'neutral' };
}

/** Overall mood of several headlines for one stock (newest count most). */
export function stockSentiment(items: Array<{ heading: string; at: number }>, now: number, hours = 24): Sentiment | null {
  const recent = items.filter((i) => now - i.at <= hours * 3600_000);
  if (!recent.length) return null;
  let sum = 0;
  let wsum = 0;
  for (const i of recent) {
    const w = 1 / (1 + (now - i.at) / (6 * 3600_000));
    sum += headlineSentiment(i.heading).score * w;
    wsum += w;
  }
  const score = sum / wsum;
  return { score, label: score >= 0.3 ? 'good' : score <= -0.3 ? 'bad' : 'neutral' };
}
