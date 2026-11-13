import { marketState, type MarketCalendar } from '../data/calendar';
import type { Quote } from '../data/quotesParse';
import { STALE_MS } from '../data/stockData';
import { createLogger } from '../lib/log';
import { createQueue } from '../lib/queue';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getDb } from '../storage/db';
import { getLocal, setLocal } from '../storage/local';
import type { TradePlan } from '../storage/schema';
import { getSession, setSession } from '../storage/session';
import { evaluateCloseBelowSma20, evaluateRule, type AlertFiring, type AlertRule } from './rules';

/**
 * AlertEngine (spec §12), service-worker side. All writes to `alerts` and `plans` go through one
 * queue so the engine and the UI never overwrite each other.
 */

const log = createLogger('alerts');
export const runExclusive = createQueue();

export async function mutateAlerts(fn: (rules: AlertRule[]) => AlertRule[]): Promise<AlertRule[]> {
  return runExclusive(async () => {
    const next = fn((await getLocal('alerts')) ?? []);
    await setLocal('alerts', next);
    return next;
  });
}

export async function mutatePlans(fn: (plans: TradePlan[]) => TradePlan[]): Promise<TradePlan[]> {
  return runExclusive(async () => {
    const next = fn((await getLocal('plans')) ?? []);
    await setLocal('plans', next);
    return next;
  });
}

const TITLES: Record<AlertFiring['kind'], string> = {
  stop: 'STOP HIT',
  target: 'TARGET REACHED',
  safeTarget: 'SAFE TARGET REACHED',
  holdTarget: 'HOLD-UNTIL TARGET REACHED',
  nearStop: 'Near your stop',
  oneR: '+1R reached',
  above: 'Price alert',
  below: 'Price alert',
  closeBelowSma20: 'Closed below 20-day average',
};

async function deliver(firings: AlertFiring[]): Promise<void> {
  if (!firings.length) return;
  const db = await getDb();
  for (const f of firings) {
    await db.add('alertLog', { ...f });
    log.info(`Alert: ${f.message}`, { kind: f.kind, level: f.level, price: f.price });
    await notify(`alert:${f.ruleId}:${f.ts}`, {
      title: `${f.symbol} — ${TITLES[f.kind]}`,
      message: f.message,
      requireInteraction: f.critical,
      priority: f.critical ? 2 : 1,
    });
  }
  const kinds = new Set(firings.map((f) => f.kind));
  await playSound(kinds.has('stop') ? 'stop' : kinds.has('target') || kinds.has('safeTarget') || kinds.has('holdTarget') ? 'target' : 'info');
  const unread = ((await getSession('alertsUnread')) ?? 0) + firings.length;
  await setSession('alertsUnread', unread);
  await updateBadge(unread);
}

export async function updateBadge(unread?: number): Promise<void> {
  const n = unread ?? (await getSession('alertsUnread')) ?? 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
  await chrome.action.setBadgeText({ text: n > 0 ? String(Math.min(n, 99)) : '' });
}

export async function markAlertsSeen(): Promise<void> {
  await setSession('alertsUnread', 0);
  await updateBadge(0);
}

/**
 * Intraday rules on fresh prices. Only during the normal session, and never on stale prices
 * (spec §7.6, §12).
 */
export async function evaluateIntraday(quotes: Record<string, Quote>, cal: MarketCalendar | null, hysteresisPct: number, now = Date.now()): Promise<AlertFiring[]> {
  if (marketState(now, cal).phase !== 'open') return [];
  const firings: AlertFiring[] = [];
  await mutateAlerts((rules) =>
    rules.map((r) => {
      const q = quotes[r.key];
      if (!r.active || !q || now - q.fetchedAt > STALE_MS) return r;
      const res = evaluateRule(r, q.ltp, now, hysteresisPct);
      if (res.firing) firings.push(res.firing);
      return res.rule;
    }),
  );
  await deliver(firings);
  return firings;
}

/** End-of-day rules (after the candle sync): close below SMA20. */
export async function evaluateEndOfDay(closes: Map<string, { close: number; sma20: number | null }>, now = Date.now()): Promise<AlertFiring[]> {
  const firings: AlertFiring[] = [];
  await mutateAlerts((rules) =>
    rules.map((r) => {
      const c = closes.get(r.key);
      if (r.kind !== 'closeBelowSma20' || !c) return r;
      const res = evaluateCloseBelowSma20(r, c.close, c.sma20, now);
      if (res.firing) firings.push(res.firing);
      return res.rule;
    }),
  );
  await deliver(firings);
  return firings;
}

export async function recentAlertLog(limit = 100) {
  const db = await getDb();
  const out = [];
  let cur = await db.transaction('alertLog').store.openCursor(null, 'prev');
  while (cur && out.length < limit) {
    out.push(cur.value);
    cur = await cur.continue();
  }
  return out;
}
