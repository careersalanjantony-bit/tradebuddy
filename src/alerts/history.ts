import { createQueue } from '../lib/queue';
import { getLocal, setLocal } from '../storage/local';

/**
 * App v1.18 — every notification the app shows (trade alerts and system messages), kept in one list for
 * the Alerts tab, with the trade details for the detail view.
 *
 *  - The same notification (same id) is shown and stored only once in 24 hours, so a cleared or
 *    dismissed alert does not come back when the app starts again and catches up.
 *  - "Clear all" empties the list; what was seen stays remembered, so cleared alerts stay cleared.
 *  - Dismissed banners are remembered for 24 hours and not shown again.
 */

export interface AlertDetail {
  symbol: string;
  key?: string;
  /** 'buy' = buy first; 'sell' = sell first (buy back later) */
  side: 'buy' | 'sell';
  /** where the idea comes from: "Falling now", "Day trade", "Breakout", "Rising now", "Early Movers", "Auto-trader" */
  source: string;
  entry: number | null;
  /** stop-loss — for a sell-first idea: buy back if it rises to this */
  stop: number | null;
  targets: number[];
  qty: number | null;
  /** ₹ lost if the stop-loss is hit */
  risk: number | null;
  /** score out of 100, or the learned chance in % */
  score: number | null;
  scoreKind?: 'score' | 'chance';
  reasons: string[];
  /** e.g. "3:10 pm" */
  closeBy?: string;
}

export interface AlertRecord {
  id: string;
  title: string;
  message: string;
  at: number;
  detail?: AlertDetail;
}

export interface AlertHistory {
  /** newest first */
  items: AlertRecord[];
  clearedAt: number | null;
  /** id → when it was last shown; a repeat within REPEAT_MS is not shown or stored again */
  seen: Record<string, number>;
  /** id → when its banner was dismissed */
  dismissed: Record<string, number>;
}

export const HISTORY_MAX = 300;
export const REPEAT_MS = 24 * 3600_000;
export const EMPTY_HISTORY: AlertHistory = { items: [], clearedAt: null, seen: {}, dismissed: {} };

const prune = (m: Record<string, number>, now: number): Record<string, number> => Object.fromEntries(Object.entries(m).filter(([, t]) => now - t < 2 * REPEAT_MS));

export function normalizeHistory(h: Partial<AlertHistory> | null | undefined): AlertHistory {
  return { items: h?.items ?? [], clearedAt: h?.clearedAt ?? null, seen: h?.seen ?? {}, dismissed: h?.dismissed ?? {} };
}

/** Adds a notification; null when the same id was already shown in the last 24 hours. Pure. */
export function addRecord(h: AlertHistory, rec: AlertRecord): AlertHistory | null {
  const last = h.seen[rec.id];
  // milestone 4: either way round — a pushed alert carries the server's time, which can be a little
  // earlier than when this phone found the same alert itself
  if (last !== undefined && Math.abs(rec.at - last) < REPEAT_MS) return null;
  return {
    ...h,
    items: [rec, ...h.items.filter((x) => x.id !== rec.id)].slice(0, HISTORY_MAX),
    seen: { ...prune(h.seen, rec.at), [rec.id]: rec.at },
  };
}

/** Empties the list but keeps what was seen, so nothing cleared comes back. Pure. */
export function clearRecords(h: AlertHistory, now: number): AlertHistory {
  return { ...h, items: [], clearedAt: now };
}

export function dismissRecord(h: AlertHistory, id: string, now: number): AlertHistory {
  return { ...h, dismissed: { ...prune(h.dismissed, now), [id]: now } };
}

export function wasDismissed(h: AlertHistory | null | undefined, id: string, now: number): boolean {
  const t = h?.dismissed?.[id];
  return t !== undefined && now - t < REPEAT_MS;
}

// ---------------------------------------------------------------- storage (one change at a time)

const queue = createQueue();

export async function getAlertHistory(): Promise<AlertHistory> {
  return normalizeHistory(await getLocal('alertHistory'));
}

/** Stores a notification. False = a repeat within 24 hours: do not show it again. */
export function recordAlert(rec: AlertRecord): Promise<boolean> {
  return queue(async () => {
    const next = addRecord(await getAlertHistory(), rec);
    if (!next) return false;
    await setLocal('alertHistory', next);
    return true;
  });
}

export function clearAlertHistory(now = Date.now()): Promise<void> {
  return queue(async () => setLocal('alertHistory', clearRecords(await getAlertHistory(), now)));
}

export function dismissAlert(id: string, now = Date.now()): Promise<void> {
  return queue(async () => setLocal('alertHistory', dismissRecord(await getAlertHistory(), id, now)));
}

// ---------------------------------------------------------------- details from the text (older alerts)

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/,/g, '').replace(/\.$/, ''));
  return Number.isFinite(n) ? n : null;
};
const RS = '₹\\s?([\\d,]+(?:\\.\\d+)?)';
const pick = (text: string, re: string): number | null => num(new RegExp(re, 'i').exec(text)?.[1]);

/**
 * The trade details read from an alert's own words — for alerts stored before details were saved with
 * them. Null when the alert is not about a trade (no price to buy or sell at and no stop-loss).
 */
export function detailFromText(title: string, message: string): AlertDetail | null {
  const text = `${title} · ${message}`;
  const sell = /SELL first|sold first|buy back/i.test(title) || /^▼/.test(title.replace(/^\p{Extended_Pictographic}\s*/u, ''));
  const entry = pick(title, `(?:BUY|SELL first|bought \\d+ \\S+|sold first \\d+ \\S+)\\s+(?:\\S+\\s+)?at\\s+${RS}`) ?? pick(text, `(?:buy around|buy only above|buy above|sell first at)\\s+${RS}`);
  const stop = pick(text, `(?:stop-loss|sell if it falls to|buy back if it rises to)\\s+${RS}`);
  if (entry === null && stop === null) return null;
  const targets: number[] = [];
  const t1 = pick(text, `target 1\\s+${RS}`);
  const t2 = pick(text, `target 2\\s+${RS}`);
  const pair = new RegExp(`targets?\\s+${RS}\\s*\\/\\s*${RS}`, 'i').exec(text);
  const profit = pick(text, `(?:take profit(?: at)?|buy back at)\\s+${RS}`);
  if (t1 !== null) targets.push(t1);
  if (t2 !== null) targets.push(t2);
  if (!targets.length && pair) targets.push(num(pair[1])!, num(pair[2])!);
  if (!targets.length && profit !== null) targets.push(profit);
  const score = pick(title, 'score\\s+(\\d+)');
  const chance = pick(title, '(\\d+)%\\s*chance');
  const sym = /(?:BUY|SELL first|Breakout:|breakout:|bought \d+|sold first \d+)\s+([A-Z][A-Z0-9&.-]{1,19})\b/.exec(title)?.[1] ?? /^(?:\p{Extended_Pictographic}\s*)?([A-Z][A-Z0-9&.-]{1,19})\b/u.exec(title)?.[1] ?? '';
  return {
    symbol: sym,
    side: sell ? 'sell' : 'buy',
    source: '',
    entry,
    stop,
    targets,
    qty: num(/(\d[\d,]*)\s+shares/i.exec(message)?.[1]),
    risk: pick(text, `risk\\s+${RS}`),
    score: score ?? chance,
    ...(score === null && chance !== null ? { scoreKind: 'chance' as const } : { scoreKind: 'score' as const }),
    reasons: [],
  };
}

/** The details to show for a stored alert: saved ones, else read from its text. */
export function alertDetail(rec: Pick<AlertRecord, 'title' | 'message' | 'detail'>): AlertDetail | null {
  return rec.detail ?? detailFromText(rec.title, rec.message);
}
