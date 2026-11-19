import { createLogger } from '../lib/log';
import { parseActionDate, type CorporateAction } from '../indicators/adjust';
import { getDb, type CorpActionsRecord } from '../storage/db';
import { upstoxRequest } from '../upstox/client';
import { UpstoxError } from '../upstox/errors';
import { historyByInstrument } from './historyCoverage';

const log = createLogger('corp-actions');
const byIsin = historyByInstrument();

export function parseCorporateActions(data: unknown): CorporateAction[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        name: typeof r.name === 'string' ? r.name : '',
        exDate: parseActionDate(typeof r.expiry_date === 'string' ? r.expiry_date : null),
        ratio: typeof r.ratio === 'string' ? r.ratio : null,
        amount: typeof r.amount === 'number' ? r.amount : null,
      };
    })
    .filter((a) => a.name);
}

export async function getCorporateActions(isin: string): Promise<CorpActionsRecord | undefined> {
  return (await getDb()).get('corporateActions', isin);
}

/** Refreshes when older than `maxAgeMs` (watchlist stocks: daily). A failure keeps the old copy. */
export async function refreshCorporateActions(isin: string, maxAgeMs = 20 * 3600_000, now = Date.now()): Promise<CorpActionsRecord | undefined> {
  if (!isin) return undefined;
  return byIsin(isin, () => downloadCorporateActions(isin, maxAgeMs, now));
}

async function downloadCorporateActions(isin: string, maxAgeMs: number, now: number): Promise<CorpActionsRecord | undefined> {
  const db = await getDb();
  const prev = await db.get('corporateActions', isin);
  if (prev && now - prev.fetchedAt < maxAgeMs && !prev.error) return prev;
  try {
    const data = await upstoxRequest<unknown>(`/v2/fundamentals/${encodeURIComponent(isin)}/corporate-actions`, { tokenKind: 'market' });
    const rec: CorpActionsRecord = { isin, fetchedAt: now, actions: parseCorporateActions(data) };
    await db.put('corporateActions', rec);
    const splits = rec.actions.filter((a) => /bonus|split/i.test(a.name));
    if (splits.length) log.info(`Corporate actions for ${isin}: ${splits.map((a) => `${a.name} ${a.ratio} on ${a.exDate}`).join(', ')}`);
    return rec;
  } catch (err) {
    if (err instanceof UpstoxError && (err.kind === 'cancelled' || err.kind === 'rate_limit')) throw err;
    log.warn(`Corporate actions for ${isin} not available; the gap detector still protects the data`, { error: err });
    if (prev) return prev;
    const rec: CorpActionsRecord = { isin, fetchedAt: now, actions: [], error: err instanceof Error ? err.message : String(err) };
    await db.put('corporateActions', rec);
    return rec;
  }
}

export async function getAdjustmentOverride(key: string) {
  return (await getDb()).get('adjustments', key);
}

/** Owner confirms a big one-day move is genuine (not a missing bonus/split adjustment). */
export async function ignoreGap(key: string, date: string, now = Date.now()): Promise<void> {
  const db = await getDb();
  const prev = await db.get('adjustments', key);
  const dates = new Set(prev?.ignoredGapDates ?? []);
  dates.add(date);
  await db.put('adjustments', { instrument_key: key, ignoredGapDates: [...dates].sort(), updatedAt: now });
  log.info(`Owner confirmed the move on ${date} for ${key} as genuine`);
}
