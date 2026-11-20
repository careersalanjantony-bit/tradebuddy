import { getLocal, setLocal } from '../storage/local';
import { setSession } from '../storage/session';
import { UpstoxError } from '../upstox/errors';
import { historicalRequestDiagnostics } from '../upstox/client';

export type HistoryKind = 'daily' | 'intraday';

export interface HistoryStock {
  key: string;
  /** Days/sessions of history, or the refresh policy, selected by the caller. */
  parameter: number;
}

interface StockCheckpoint extends HistoryStock {
  outcome?: 'ok' | 'failed';
  retryAt?: number;
}

export interface HistoryCheckpoint {
  window: string;
  stocks: StockCheckpoint[];
  startedAt: number;
  updatedAt: number;
  pausedUntil?: number;
  lastError?: { kind: string; status: number | null; at: number };
}

const storageKey = { daily: 'dailyHistoryCheckpoint', intraday: 'intradayHistoryCheckpoint' } as const;
const sessionKey = { daily: 'syncProgress', intraday: 'intradayProgress' } as const;
const RETRY_DELAY = 5 * 60_000;
const AUTH_RETRY_DELAY = 15 * 60_000;

const running = new Map<HistoryKind, { window: string; work: Promise<unknown> }>();
let stopped = false;

export function startHistoricalJobs(): void {
  stopped = false;
}

/** Stop planning more requests before the server cancels and drains the HTTP queue. */
export function stopHistoricalJobs(): Promise<unknown> {
  stopped = true;
  return Promise.allSettled([...running.values()].map((job) => job.work));
}

function idleError(): UpstoxError {
  return new UpstoxError('Historical downloads are stopping', 'cancelled');
}

function historyJobActive(kind: HistoryKind): boolean {
  return running.has(kind);
}

/** At most one writer per checkpoint, including overlapping startup, alarm, and manual calls. */
export async function withHistoryJob<T>(kind: HistoryKind, window: string, work: () => Promise<T>): Promise<T> {
  if (stopped) throw idleError();
  const current = running.get(kind);
  if (current) {
    if (current.window === window) return current.work as Promise<T>;
    await current.work.catch(() => undefined);
    return withHistoryJob(kind, window, work);
  }
  const task = work().finally(() => running.delete(kind));
  running.set(kind, { window, work: task });
  return task;
}

function counts(batch: HistoryCheckpoint) {
  const ok = batch.stocks.filter((s) => s.outcome === 'ok').length;
  const failed = batch.stocks.filter((s) => s.outcome === 'failed').length;
  return { ok, failed, pending: batch.stocks.length - ok - failed, total: batch.stocks.length };
}

function nextRun(batch: HistoryCheckpoint): number | null {
  if (!batch.stocks.some((s) => s.outcome === undefined)) return null;
  return Math.max(batch.pausedUntil ?? 0, Math.min(...batch.stocks.filter((s) => s.outcome === undefined).map((s) => s.retryAt ?? 0)));
}

export async function historyNeedsResume(
  kind: HistoryKind, now = Date.now(), window?: string, includeComplete = false,
): Promise<boolean> {
  if (stopped || historyJobActive(kind)) return false;
  const batch = await getLocal(storageKey[kind]);
  if (!batch || (window !== undefined && batch.window !== window)) return window !== undefined;
  const next = nextRun(batch);
  return next === null ? includeComplete : next <= now;
}

export async function historyJobProgress() {
  async function progress(kind: HistoryKind) {
    const batch = await getLocal(storageKey[kind]);
    if (!batch) return null;
    return {
      window: batch.window,
      ...counts(batch),
      running: historyJobActive(kind),
      startedAt: batch.startedAt,
      updatedAt: batch.updatedAt,
      resumeAt: nextRun(batch) || null,
      lastError: batch.lastError ?? null,
    };
  }
  const [daily, intraday] = await Promise.all([progress('daily'), progress('intraday')]);
  return { daily, intraday };
}

type BatchResult = { ok: number; failed: string[]; pending: string[] };

/**
 * Checkpoint each stock after its candle/cache transaction finishes. Rebuilding the plan at startup
 * includes newly tracked stocks and retains completed work for the same window and lookback.
 */
export async function runHistoryBatch(
  kind: HistoryKind,
  window: string,
  stocks: HistoryStock[],
  download: (stock: HistoryStock) => Promise<void>,
  reportError: (key: string, err: unknown) => void,
): Promise<BatchResult> {
  if (stopped) throw idleError();
  const previous = await getLocal(storageKey[kind]);
  const sameWindow = previous?.window === window;
  const byKey = new Map(sameWindow ? previous.stocks.map((s) => [s.key, s]) : []);
  const batch: HistoryCheckpoint = {
    ...(sameWindow ? previous : { window, startedAt: Date.now(), updatedAt: Date.now() }),
    stocks: stocks.map((s) => {
      const old = byKey.get(s.key);
      return old?.parameter === s.parameter ? old : { ...s };
    }),
  };

  async function checkpoint(): Promise<void> {
    batch.updatedAt = Date.now();
    await setLocal(storageKey[kind], batch);
  }

  async function showProgress(running: boolean, error?: string): Promise<void> {
    const { ok, failed, total } = counts(batch);
    await setSession(sessionKey[kind], { done: ok + failed, total, running, at: Date.now(), ...(error ? { error } : {}) });
  }

  let error: string | undefined;
  await checkpoint();
  try {
    if (stopped) throw idleError();
    await showProgress(true);
    if (batch.lastError?.kind !== 'rate_limit' || (batch.pausedUntil ?? 0) <= Date.now()) {
      delete batch.pausedUntil;
      let checked = 0;
      for (const stock of batch.stocks) {
        if (stopped) throw idleError();
        if (stock.outcome || (stock.retryAt ?? 0) > Date.now()) continue;
        try {
          await download(stock);
          stock.outcome = 'ok';
          delete stock.retryAt;
        } catch (err) {
          if (stopped || (err instanceof UpstoxError && err.kind === 'cancelled')) throw err;
          const upstox = err instanceof UpstoxError ? err : null;
          const at = Date.now();
          const blocked = upstox?.kind === 'auth' || upstox?.kind === 'not_logged_in' || upstox?.kind === 'config';
          const rateLimited = upstox?.kind === 'rate_limit';
          batch.lastError = { at, kind: upstox?.kind ?? 'download', status: upstox?.httpStatus ?? null };
          reportError(stock.key, err);
          if (blocked || rateLimited) {
            const cooldown = rateLimited ? (await historicalRequestDiagnostics()).cooldownUntil ?? 0 : 0;
            batch.pausedUntil = Math.max(cooldown, at + (blocked ? AUTH_RETRY_DELAY : 60_000));
            error = upstox?.message;
            await checkpoint();
            if (kind === 'daily' || rateLimited) throw err;
            break;
          }
          if (upstox?.kind === 'client') stock.outcome = 'failed';
          else stock.retryAt = at + RETRY_DELAY;
        }
        await checkpoint();
        if (++checked % 5 === 0) await showProgress(true);
      }
    }
  } finally {
    await showProgress(false, error);
  }
  return {
    ok: batch.stocks.filter((s) => s.outcome === 'ok').length,
    failed: batch.stocks.filter((s) => s.outcome === 'failed').map((s) => s.key),
    pending: batch.stocks.filter((s) => !s.outcome).map((s) => s.key),
  };
}
