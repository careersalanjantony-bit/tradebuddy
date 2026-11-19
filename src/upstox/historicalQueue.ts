import { UpstoxError } from './errors';
import { historicalWindows, RateLimiter } from './rateLimiter';

export interface HistoricalRequestState {
  timestamps: number[];
  cooldownUntil: number;
  consecutive429s: number;
  total429s: number;
  last429At: number | null;
  lastRetryAfterMs: number | null;
}

interface StateStore {
  load(): Promise<HistoricalRequestState | undefined>;
  save(state: HistoricalRequestState): Promise<void>;
}

interface PendingRequest {
  run(): Promise<void>;
  reject(error: unknown): void;
}

type SendRequest<T> = (signal: AbortSignal) => Promise<T>;
type PrepareRequest<T> = () => Promise<SendRequest<T>>;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, Math.min(ms, 2_147_483_647));
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One FIFO for historical HTTP attempts, including retries. Live REST APIs use separate limiters. */
export class HistoricalRequestQueue {
  private readonly pending: PendingRequest[] = [];
  private readonly controller = new AbortController();
  private readonly spacingMs: number;
  private readonly windows: ReturnType<typeof historicalWindows>;
  private initialized: Promise<void> | undefined;
  private limiter!: RateLimiter;
  private state!: HistoricalRequestState;
  private worker: Promise<void> | null = null;
  private lastStartedAt = -Infinity;
  private inFlight = false;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly store: StateStore,
    private readonly onRateLimit: (until: number, error: UpstoxError) => void = () => undefined,
  ) {
    this.windows = historicalWindows(requestsPerMinute);
    this.spacingMs = Math.ceil(60_000 / requestsPerMinute);
  }

  private init(): Promise<void> {
    this.initialized ??= this.store.load().then((persisted) => {
      this.state = persisted ?? {
        timestamps: [], cooldownUntil: 0, consecutive429s: 0, total429s: 0,
        last429At: null, lastRetryAfterMs: null,
      };
      this.limiter = new RateLimiter(this.windows, this.state.timestamps);
      this.lastStartedAt = this.limiter.snapshot().at(-1) ?? -Infinity;
    }).catch((err: unknown) => {
      this.initialized = undefined;
      throw err;
    });
    return this.initialized;
  }

  private waitTime(now: number): number {
    return Math.max(this.limiter.waitTime(now), this.state.cooldownUntil - now, this.lastStartedAt + this.spacingMs - now);
  }

  private async save(): Promise<void> {
    this.state.timestamps = this.limiter.snapshot();
    await this.store.save({ ...this.state });
  }

  async diagnostics(now = Date.now()) {
    await this.init();
    const wait = this.waitTime(now);
    return {
      requestsPerMinute: this.requestsPerMinute,
      minSpacingMs: this.spacingMs,
      queued: this.pending.length + (this.worker && !this.inFlight ? 1 : 0),
      inFlight: this.inFlight ? 1 : 0,
      nextRequestAt: now + wait,
      cooldownUntil: this.state.cooldownUntil > now ? this.state.cooldownUntil : null,
      consecutive429s: this.state.consecutive429s,
      total429s: this.state.total429s,
      last429At: this.state.last429At,
      lastRetryAfterMs: this.state.lastRetryAfterMs,
      usage: this.limiter.usage(now),
    };
  }

  enqueue<T>(prepare: PrepareRequest<T>, attempts: number): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      this.pending.push({
        reject,
        run: async () => {
          try {
            resolve(await this.execute(prepare, attempts, signal));
          } catch (err) {
            reject(err);
          }
        },
      });
      this.worker ??= this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.length) await this.pending.shift()!.run();
    this.worker = null;
  }

  private async execute<T>(prepare: PrepareRequest<T>, attempts: number, signal: AbortSignal): Promise<T> {
    await this.init();
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      let wait: number;
      while ((wait = this.waitTime(Date.now())) > 0) await delay(wait, signal);
      const request = await prepare();
      signal.throwIfAborted();
      const now = Date.now();
      this.limiter.record(now);
      this.lastStartedAt = now;
      // Persist the reservation before dispatch so a killed process cannot reopen a full budget.
      await this.save();
      signal.throwIfAborted();
      this.lastStartedAt = Date.now();
      this.inFlight = true;
      let data: T;
      try {
        data = await request(signal);
      } catch (err) {
        if (!(err instanceof UpstoxError)) throw err;
        if (err.kind === 'rate_limit') {
          const state = this.state;
          const exponential = Math.min(5_000 * 2 ** state.consecutive429s, 300_000);
          const backoff = Math.max(exponential, err.retryAfterMs ?? 0) + Math.ceil(exponential * 0.2 * Math.random());
          state.consecutive429s++;
          state.total429s++;
          state.last429At = Date.now();
          state.lastRetryAfterMs = err.retryAfterMs;
          state.cooldownUntil = state.last429At + backoff;
          this.onRateLimit(state.cooldownUntil, err);
          // Even a final attempt opens a cooldown shared by every other historical caller.
          await this.save();
        }
        signal.throwIfAborted();
        if (!err.retryable || attempt >= attempts) throw err;
        if (err.kind !== 'rate_limit') {
          this.inFlight = false;
          await delay(Math.min(1000 * 2 ** (attempt - 1), 60_000), signal);
        }
        continue;
      } finally {
        this.inFlight = false;
      }
      signal.throwIfAborted();
      if (this.state.consecutive429s) {
        this.state.consecutive429s = 0;
        await this.save();
      }
      return data;
    }
  }

  async stop(): Promise<void> {
    const error = new UpstoxError('Historical request queue stopped', 'cancelled');
    this.controller.abort(error);
    for (const pending of this.pending.splice(0)) pending.reject(error);
    await this.worker;
  }
}
