import { headlineSentiment } from '../data/sentiment';

/**
 * App v1.15 — catalysts from the headlines Upstox's News API returns for each stock (the app has no
 * results database: quarterly results, revenue and profit growth are only known when a headline says
 * so). Each headline is put in one bucket by its words and given the same good / bad / neutral reading
 * the News tab uses. The headline itself is always shown, so you can check what it really says.
 */

export type CatalystKind = 'results' | 'order win' | 'upgrade' | 'downgrade' | 'corporate action' | 'approval' | 'deal / stake' | 'legal / trouble' | 'news';

const KINDS: Array<[CatalystKind, RegExp]> = [
  ['results', /\b(q[1-4]|quarter(ly)?|results?|earnings|net profit|profit|revenue|ebitda|margin|pat\b)/i],
  ['order win', /\b(order|contract|project|tender)s?\b.{0,30}\b(win|wins|won|bag|bags|bagged|secures?|receives?|worth)\b|\b(bags?|wins?|won|secures?|bagged|receives?)\b.{0,40}\b(order|contract|project|tender)s?\b/i],
  ['upgrade', /\bupgrade[sd]?\b|\b(target price|tp)\s+(raised|hiked|increased)\b|\b(initiates?|starts?)\s+coverage\b.{0,30}\bbuy\b|\b(buy|outperform|overweight)\s+(rating|call)\b/i],
  ['downgrade', /\bdowngrade[sd]?\b|\b(target price|tp)\s+(cut|lowered|reduced)\b|\b(sell|underperform|underweight)\s+(rating|call)\b/i],
  ['corporate action', /\b(bonus|split|buyback|dividend|rights issue)\b/i],
  ['approval', /\b(approval|approves?|nod|clearance|licen[cs]e|usfda|patent)\b/i],
  ['deal / stake', /\b(acquires?|acquisition|merger|stake|block deal|bulk deal|ofs|joint venture|jv)\b/i],
  ['legal / trouble', /\b(penalty|fine[sd]?|ban(ned)?|show[- ]cause|probe|raid|fraud|default|insolvency|resigns?|fire|accident|strike|shutdown|recall)\b/i],
];

export interface Catalyst {
  kind: CatalystKind;
  tone: 'good' | 'bad' | 'neutral';
  score: number;
  heading: string;
  at: number;
  link: string;
}

/** The bucket and reading of one headline. */
export function readHeadline(h: { heading: string; at: number; link?: string }): Catalyst {
  const s = headlineSentiment(h.heading);
  const kind = KINDS.find(([, re]) => re.test(h.heading))?.[0] ?? 'news';
  // a downgrade or trouble is bad even when other words sound fine
  const tone = kind === 'downgrade' || kind === 'legal / trouble' ? (s.label === 'good' ? 'neutral' : 'bad') : s.label;
  return { kind, tone, score: s.score, heading: h.heading, at: h.at, link: h.link ?? '' };
}

/**
 * The stock's catalyst: its headlines since `since` (yesterday's close for the pre-market scan), the
 * strongest bad one first (it blocks a buy), else the strongest good one, else the newest.
 */
export function catalystOf(items: Array<{ heading: string; at: number; link?: string }>, since: number): Catalyst | null {
  const read = items.filter((i) => i.at >= since).map(readHeadline);
  if (!read.length) return null;
  const bad = read.filter((c) => c.tone === 'bad').sort((a, b) => a.score - b.score)[0];
  if (bad) return bad;
  const good = read.filter((c) => c.tone === 'good').sort((a, b) => b.score - a.score || b.at - a.at)[0];
  return good ?? read.sort((a, b) => b.at - a.at)[0]!;
}

/** Yesterday's close (15:30 IST) before `now`, skipping weekends (holidays are not known here). */
export function lastCloseBefore(now: number): number {
  const ist = new Date(now + 5.5 * 3600_000);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes < 15 * 60 + 30) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime() + (15 * 60 + 30) * 60_000 - 5.5 * 3600_000;
}
