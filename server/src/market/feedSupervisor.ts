import { createLogger } from '../../../src/lib/log';
import { errorMessage } from '../../../src/lib/serialize';
import type { SocketStats } from '../adapters/websocket';

/**
 * Keeps the Upstox Market Data Feed V3 healthy on the server.
 *
 * The connection itself is the app's own, unchanged code (src/background/feed.ts: authorise, connect,
 * subscribe in "full" / "ltpc" mode within Upstox's limits, decode, merge prices into storage). On a
 * phone that code is nudged by the 30-second price alarm and the open screen; here this supervisor
 * nudges it every few seconds and adds what a server needs:
 *  - connect only in pre-open and market hours (holidays and weekends come from the market calendar);
 *  - a silence watchdog: no prices for `staleMs` while connected → close, so the next check reconnects;
 *  - heartbeat failures are handled by the socket itself (adapters/websocket.ts);
 *  - one health record (state, last price, subscription counts, reconnects).
 * The feed code waits 30 s between connection attempts, which also protects Upstox's limits.
 */

export interface FeedStatusRecord {
  connected: boolean;
  lastTickAt: number;
  at: number;
  keys: number;
  full?: number;
  ltpc?: number;
  overflow?: number;
  error?: string;
}

export interface FeedSupervisorDeps {
  ensureFeed(now: number, force?: boolean): Promise<string>;
  closeFeed(reason: string): void;
  readStatus(): Promise<FeedStatusRecord | undefined>;
  socketStats(): SocketStats;
  now?: () => number;
}

export interface FeedHealth {
  state: string;
  stateSince: number | null;
  connected: boolean;
  connectedSince: number | null;
  lastTickAt: number | null;
  lastTickAgeMs: number | null;
  keys: number;
  full: number;
  ltpc: number;
  overflow: number;
  lastError: string | null;
  connects: number;
  staleRestarts: number;
  lastCheckAt: number | null;
  socket: SocketStats;
}

const log = createLogger('feed-supervisor');

export class FeedSupervisor {
  private state = 'not started';
  private stateSince: number | null = null;
  private connectedSince: number | null = null;
  private connects = 0;
  private staleRestarts = 0;
  private lastCheckAt: number | null = null;
  private lastError: string | null = null;
  private status: FeedStatusRecord | undefined;

  constructor(
    private readonly deps: FeedSupervisorDeps,
    private readonly staleMs = 90_000,
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** One check: connect / keep / close the feed and watch for silence. Returns the state. */
  async check(): Promise<string> {
    const now = this.now();
    let state: string;
    try {
      state = await this.deps.ensureFeed(now);
    } catch (err) {
      state = 'failed';
      this.lastError = errorMessage(err);
    }
    this.status = await this.deps.readStatus().catch(() => undefined);
    if (this.status?.error) this.lastError = this.status.error;
    this.lastCheckAt = now;

    if (state === 'connected') {
      if (this.connectedSince === null) {
        this.connectedSince = now;
        this.connects++;
      }
      const lastData = Math.max(this.status?.lastTickAt ?? 0, this.connectedSince);
      if (now - lastData > this.staleMs) {
        this.staleRestarts++;
        log.warn(`No live prices for ${Math.round((now - lastData) / 1000)} s — reconnecting the feed`);
        this.deps.closeFeed('no prices');
        this.connectedSince = null;
        state = 'reconnecting';
      }
    } else {
      this.connectedSince = null;
    }

    if (state !== this.state) {
      log.info(`Live feed: ${state}`, this.lastError && state === 'failed' ? { error: this.lastError } : undefined);
      this.state = state;
      this.stateSince = now;
    }
    return state;
  }

  stop(reason: string): void {
    this.deps.closeFeed(reason);
    this.connectedSince = null;
    this.state = 'stopped';
    this.stateSince = this.now();
  }

  health(): FeedHealth {
    const s = this.status;
    const lastTickAt = s?.lastTickAt ? s.lastTickAt : null;
    return {
      state: this.state,
      stateSince: this.stateSince,
      connected: this.state === 'connected',
      connectedSince: this.connectedSince,
      lastTickAt,
      lastTickAgeMs: lastTickAt === null ? null : Math.max(0, this.now() - lastTickAt),
      keys: s?.keys ?? 0,
      full: s?.full ?? 0,
      ltpc: s?.ltpc ?? 0,
      overflow: s?.overflow ?? 0,
      lastError: this.lastError,
      connects: this.connects,
      staleRestarts: this.staleRestarts,
      lastCheckAt: this.lastCheckAt,
      socket: this.deps.socketStats(),
    };
  }
}
