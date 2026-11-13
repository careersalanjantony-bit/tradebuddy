import type { Candle } from './types';

/**
 * Corporate-action adjustment (spec §7.5).
 *
 * Why: on 9 Nov 2026 Trent's history was unadjusted for its 1:2 bonus — a fake −32.6% one-day drop that
 * broke every average. Upstox does not document whether candles are adjusted, so we look at the data.
 *
 * For each Bonus/Split we list every plausible price factor from the ratio string (the ratio's
 * direction is not documented), then look at the close-to-close change around the ex-date. If it
 * matches a candidate within the tolerance, the data is unadjusted: prices before that day are
 * multiplied by the factor and volume divided by it. If nothing matches, the data is assumed adjusted.
 */

export interface CorporateAction {
  name: string; // Dividend | Bonus | Split | Rights | …
  exDate: string | null; // YYYY-MM-DD
  ratio: string | null; // e.g. "1:2"
  amount: number | null;
}

export interface AdjustmentEvent {
  /** first date whose prices are NOT multiplied (the ex-date candle) */
  date: string;
  factor: number;
  kind: 'Bonus' | 'Split' | 'manual';
  ratio: string | null;
  /** observed close[ex] / close[ex−1] in the raw data */
  observed: number | null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "14 Aug 2025" → "2025-08-14"; also accepts ISO dates. Null if unreadable. */
export function parseActionDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS[m[2]!.toLowerCase()];
  return mon ? `${m[3]}-${mon}-${m[1]!.padStart(2, '0')}` : null;
}

export function parseRatio(ratio: string | null | undefined): [number, number] | null {
  if (!ratio) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? [a, b] : null;
}

/**
 * Plausible price factors (< 1) for a bonus or split, most likely first.
 * Bonus a:b (a new for every b held) → b/(a+b) (Trent 1:2 → 2/3). Split: new FV / old FV.
 */
export function candidateFactors(name: string, ratio: string | null): number[] {
  const r = parseRatio(ratio);
  if (!r) return [];
  const [a, b] = r;
  const kind = name.toLowerCase();
  const list: number[] = [];
  if (kind.includes('bonus')) list.push(b / (a + b), a / (a + b));
  if (kind.includes('split')) list.push(Math.min(a, b) / Math.max(a, b));
  const out: number[] = [];
  for (const f of list) if (f > 0 && f < 1 && !out.some((g) => Math.abs(g - f) < 1e-12)) out.push(f);
  return out;
}

/** Index of the first candle on or after `date`, or -1. */
function firstOnOrAfter(candles: Candle[], date: string): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo < candles.length ? lo : -1;
}

export interface AdjustmentResult {
  events: AdjustmentEvent[];
  /** bonus/split actions inside the data range whose gap did not appear (data already adjusted) */
  alreadyAdjusted: CorporateAction[];
}

/**
 * Finds the bonus/split events that are still unadjusted in `candles` (raw, oldest → newest).
 * Searches up to `window` sessions around the stated ex-date, because the API's date may be the
 * record date rather than the ex-date.
 */
export function detectAdjustments(candles: Candle[], actions: CorporateAction[], tolerancePct = 10, window = 3): AdjustmentResult {
  const events: AdjustmentEvent[] = [];
  const alreadyAdjusted: CorporateAction[] = [];
  if (candles.length < 2) return { events, alreadyAdjusted };
  const first = candles[0]!.date;
  const last = candles[candles.length - 1]!.date;

  const relevant = actions.filter((act) => {
    const k = act.name.toLowerCase();
    return (k.includes('bonus') || k.includes('split')) && !!act.exDate && act.exDate > first && act.exDate <= last && candidateFactors(act.name, act.ratio).length > 0;
  });

  /** Best matching gap near `exDate` for any of `factors`. */
  const search = (exDate: string, factors: number[]) => {
    const center = firstOnOrAfter(candles, exDate);
    if (center < 1) return null;
    let best: { idx: number; factor: number; err: number; observed: number } | null = null;
    for (let i = Math.max(1, center - window); i <= Math.min(candles.length - 1, center + window); i++) {
      const observed = candles[i]!.close / candles[i - 1]!.close;
      for (const f of factors) {
        const err = Math.abs(observed / f - 1);
        if (err * 100 <= tolerancePct && (!best || err < best.err)) best = { idx: i, factor: f, err, observed };
      }
    }
    return best;
  };
  const kindOf = (a: CorporateAction): 'Bonus' | 'Split' => (a.name.toLowerCase().includes('bonus') ? 'Bonus' : 'Split');

  const matched = new Set<CorporateAction>();
  for (const act of relevant) {
    const best = search(act.exDate!, candidateFactors(act.name, act.ratio));
    if (best) {
      matched.add(act);
      events.push({ date: candles[best.idx]!.date, factor: best.factor, kind: kindOf(act), ratio: act.ratio, observed: best.observed });
    }
  }

  // Two actions on (nearly) the same date — e.g. Bajaj Finance's 4:1 bonus + 1:2 split in June 2025 —
  // show up as ONE gap equal to the product of their factors.
  const left = relevant.filter((a) => !matched.has(a));
  for (let i = 0; i < left.length; i++) {
    for (let j = i + 1; j < left.length; j++) {
      const a = left[i]!;
      const b = left[j]!;
      if (matched.has(a) || matched.has(b)) continue;
      const days = Math.abs(Date.parse(a.exDate!) - Date.parse(b.exDate!)) / 86_400_000;
      if (days > 7) continue;
      const products = candidateFactors(a.name, a.ratio).flatMap((fa) => candidateFactors(b.name, b.ratio).map((fb) => fa * fb));
      const best = search(a.exDate! < b.exDate! ? a.exDate! : b.exDate!, products);
      if (best) {
        matched.add(a);
        matched.add(b);
        events.push({
          date: candles[best.idx]!.date,
          factor: best.factor,
          kind: kindOf(a) === kindOf(b) ? kindOf(a) : 'Bonus',
          ratio: `${kindOf(a)} ${a.ratio} + ${kindOf(b)} ${b.ratio}`,
          observed: best.observed,
        });
      }
    }
  }

  for (const act of relevant) if (!matched.has(act)) alreadyAdjusted.push(act);
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { events, alreadyAdjusted };
}

/** Multiplies OHLC before each event's date by its factor (compounding) and divides volume by it. */
export function applyAdjustments(candles: Candle[], events: AdjustmentEvent[]): Candle[] {
  if (!events.length) return candles;
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : 1));
  return candles.map((c) => {
    let f = 1;
    for (const e of sorted) if (c.date < e.date) f *= e.factor;
    if (f === 1) return c;
    return { ...c, open: c.open * f, high: c.high * f, low: c.low * f, close: c.close * f, volume: c.volume / f };
  });
}

export interface SuspiciousGap {
  date: string;
  changePct: number;
}

/**
 * Gap detector fallback (spec §7.5 step 4): one-day close-to-close moves beyond ±threshold% in the
 * (already adjusted) series. Dates the owner confirmed as genuine are skipped.
 */
export function findSuspiciousGaps(candles: Candle[], thresholdPct = 18, ignoreDates: string[] = []): SuspiciousGap[] {
  const out: SuspiciousGap[] = [];
  const ignore = new Set(ignoreDates);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.partial || ignore.has(c.date)) continue;
    const ch = (c.close / candles[i - 1]!.close - 1) * 100;
    if (Math.abs(ch) > thresholdPct) out.push({ date: c.date, changePct: ch });
  }
  return out;
}
