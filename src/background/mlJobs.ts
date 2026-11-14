import { buildCandidates, DEFAULT_VARIANT, DAY_RULES_VERSION } from '../daytrade/backtest';
import type { Breakout } from '../daytrade/rules';
import type { LiveStock } from '../daytrade/live';
import { getInstrument } from '../data/instruments';
import { getIntradayDays } from '../data/intraday';
import { NIFTY100_KEYS } from '../data/universe';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { featureVector, prevDayOf, type PrevDay } from '../ml/features';
import { learn, ML_VERSION, type MlReport } from '../ml/learn';
import { predictEnsemble } from '../ml/models';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { setSession } from '../storage/session';
import { dayKeys } from './dayJobs';
import { testShorts } from './shortJobs';
import { testBreakouts } from './breakoutJobs';

/**
 * Self-learning jobs: learn from the stored 5-minute history (after the day-trade test, every
 * evening, or on request), and score live signals with the learned chance.
 */

const log = createLogger('learning');
let running: Promise<MlReport | null> | null = null;

export function learnNow(now = Date.now()): Promise<MlReport | null> {
  running ??= (async () => {
    const settings = await getSettings();
    const keys = await dayKeys();
    const refs = await Promise.all(keys.map(async (k) => ({ key: k, symbol: (await getInstrument(k))?.trading_symbol ?? k, shortAllowed: NIFTY100_KEYS.has(k), tick: (await getInstrument(k))?.tick ?? 0.05 })));
    const amount = settings.risk.capitalInr && settings.risk.capitalInr > 0 ? settings.risk.capitalInr : 100_000;
    const slots = Math.max(1, Math.min(5, Math.round(settings.risk.sizing === 'split' ? settings.risk.splitInto : settings.risk.maxOpenTrades)));
    await setSession('mlProgress', { running: true, done: 0, total: refs.length, at: now });
    try {
      const { candidates, dates } = await buildCandidates(refs, getIntradayDays, {
        slippagePct: settings.dayTrade.slippagePct,
        priceMin: settings.ui.priceMin,
        priceMax: settings.ui.priceMax,
        onProgress: (done, total) => void setSession('mlProgress', { running: true, done, total, at: Date.now() }),
      });
      const test = await getLocal('dayTest');
      const variant = test?.report?.rulesVersion === DAY_RULES_VERSION ? test.report.chosen : DEFAULT_VARIANT;
      const report = learn(candidates, dates, { amount, slots, maxLosses: settings.dayTrade.maxLossesPerDay }, variant, now);
      if (report) {
        await setLocal('mlModel', report);
        log.info(`Learned from ${report.samples} past signals over ${report.sessions} days: ${report.passed ? 'IN USE' : 'not used'} — ${report.reason}`, { auc: report.auc, threshold: report.threshold, ms: report.computedMs });
      } else {
        log.info('Not enough 5-minute history to learn yet', { days: dates.length, signals: candidates.length });
      }
      void testShorts(now).catch(() => undefined);
      void testBreakouts(now).catch(() => undefined);
      return report;
    } catch (err) {
      log.warn('Learning failed', { error: errorMessage(err) });
      throw err;
    } finally {
      await setSession('mlProgress', { running: false, done: refs.length, total: refs.length, at: Date.now() });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Learns again when the last learning is older than ~20 hours (called in the evening and at start-up). */
export async function learnIfDue(now = Date.now()): Promise<void> {
  const m = await getLocal('mlModel');
  if (m && m.version === ML_VERSION && now - m.trainedAt < 20 * 3600_000) return;
  await learnNow(now).catch(() => undefined);
}

// ------------------------------------------------------------- live scoring

const prevCache = new Map<string, { date: string; days: PrevDay[] }>();

export async function prevDays(key: string, date: string): Promise<PrevDay[]> {
  const c = prevCache.get(key);
  if (c?.date === date) return c.days;
  const days = (await getIntradayDays(key))
    .filter((d) => d.date < date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-10)
    .map(prevDayOf)
    .filter((x): x is PrevDay => !!x);
  prevCache.set(key, { date, days });
  return days;
}

export interface LiveScore {
  chance: number;
  /** the learning passed its check: its chance decides */
  inUse: boolean;
  threshold: number;
}

/** The learned chance for a live breakout, or null when nothing has been learned yet. */
export async function scoreLive(date: string, key: string, s: LiveStock, bo: Breakout, market: number | null): Promise<LiveScore | null> {
  const m = await getLocal('mlModel');
  if (!m || m.version !== ML_VERSION || s.rvol === null) return null;
  try {
    const f = featureVector(s.bars, bo.idx, bo.side, bo.or, await prevDays(key, date), market ?? 0, s.rvol);
    return { chance: predictEnsemble(m.model, f), inUse: m.passed, threshold: m.threshold };
  } catch (err) {
    log.warn('Could not score a live signal', { error: errorMessage(err) });
    return null;
  }
}
