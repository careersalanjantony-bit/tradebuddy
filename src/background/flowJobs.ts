import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { parseFullQuotes, risingNow, type Flow, type RisingRow } from '../data/flow';
import { minutesIST } from '../daytrade/live';
import { chunk } from '../lib/chunk';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { istDate } from '../lib/time';
import type { PrevDay } from '../ml/features';
import { getSession, setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';
import { dayKeys } from './dayJobs';
import { prevDays } from './mlJobs';

/**
 * Buyers meter + "rising now" (app v1.0): the full market quote of every studied stock about every
 * 15 seconds in market hours (one request per 500 stocks). Read-only.
 */

const log = createLogger('flow');
export const FLOW_EVERY_MS = 15_000;
let running = false;

/** Usual volume by this time of day, from the last 10 sessions of 5-minute history. */
function usualVolumeBy(days: PrevDay[], t: number): number | null {
  const vals: number[] = [];
  for (const d of days.slice(-10)) {
    let v: number | null = null;
    for (let i = 0; i < d.t.length && d.t[i]! + 5 <= t; i++) v = d.cumV[i]!;
    if (v && v > 0) vals.push(v);
  }
  return vals.length >= 3 ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
}

export async function refreshFlow(now = Date.now(), force = false): Promise<{ stocks: number; rising: number } | null> {
  if (running) return null;
  const last = await getSession('flow');
  if (!force && last && now - last.at < FLOW_EVERY_MS) return null;
  const m = marketState(now, await getCalendar());
  if (!force && m.phase !== 'open') return null;
  running = true;
  try {
    const keys = await dayKeys();
    const flows: Record<string, Flow> = {};
    for (const part of chunk(keys, 500)) {
      const data = await upstoxRequest<unknown>('/v2/market-quote/quotes', { query: { instrument_key: part.join(',') }, tokenKind: 'market', attempts: 1 });
      Object.assign(flows, parseFullQuotes(data, now));
    }
    const date = istDate(now);
    const t = minutesIST(now);
    const paces = new Map<string, number | null>();
    for (const k of Object.keys(flows)) {
      const usual = usualVolumeBy(await prevDays(k, date), t);
      paces.set(k, usual ? flows[k]!.volume / usual : null);
    }
    const rising: RisingRow[] = t >= 9 * 60 + 20 && t <= 15 * 60 ? risingNow(flows, (k) => paces.get(k) ?? null) : [];
    const lite: Record<string, { buyQty: number; sellQty: number; vwap: number | null; pace: number | null }> = {};
    for (const f of Object.values(flows)) lite[f.key] = { buyQty: f.buyQty, sellQty: f.sellQty, vwap: f.vwap, pace: paces.get(f.key) ?? null };
    await setSession('flow', { at: now, stocks: lite, rising });
    return { stocks: Object.keys(flows).length, rising: rising.length };
  } catch (err) {
    log.info('Buyers meter not updated', { reason: errorMessage(err) });
    await setSession('flow', { at: now, stocks: last?.stocks ?? {}, rising: last?.rising ?? [], error: errorMessage(err) });
    return null;
  } finally {
    running = false;
  }
}
