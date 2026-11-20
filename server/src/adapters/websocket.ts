import WS from 'ws';

/**
 * The browser WebSocket the shared feed code uses (src/background/feed.ts), built on the `ws` package
 * so the server can do what a browser cannot: a heartbeat. Every `pingMs` the socket sends a ping;
 * if no pong comes back within `pongTimeoutMs` the connection is treated as dead and closed, and the
 * feed supervisor connects again. Also counts messages for the health check.
 */

export interface HeartbeatOptions {
  pingMs: number;
  pongTimeoutMs: number;
  handshakeTimeoutMs?: number;
  /** tests only: connect somewhere else than the address Upstox gave */
  rewriteUrl?: (url: string) => string;
}

export interface SocketStats {
  created: number;
  opened: number;
  closed: number;
  open: number;
  messages: number;
  lastMessageAt: number | null;
  pings: number;
  pongs: number;
  heartbeatFailures: number;
  lastRttMs: number | null;
  lastCloseCode: number | null;
}

export interface HeartbeatSocketKit {
  /** installed as globalThis.WebSocket; keeps the static OPEN / CLOSED… constants of the ws class */
  WebSocket: { new (address: string | URL, protocols?: string | string[]): WS; readonly OPEN: number };
  stats(): SocketStats;
}

export function createHeartbeatWebSocket(opts: HeartbeatOptions): HeartbeatSocketKit {
  const stats: SocketStats = { created: 0, opened: 0, closed: 0, open: 0, messages: 0, lastMessageAt: null, pings: 0, pongs: 0, heartbeatFailures: 0, lastRttMs: null, lastCloseCode: null };

  class HeartbeatWebSocket extends WS {
    #beat: ReturnType<typeof setInterval> | null = null;
    #pongTimer: ReturnType<typeof setTimeout> | null = null;
    #waiting = false;
    #sentAt = 0;
    #wasOpen = false;

    constructor(address: string | URL, protocols?: string | string[]) {
      const url = String(address);
      super(opts.rewriteUrl ? opts.rewriteUrl(url) : url, protocols, { handshakeTimeout: opts.handshakeTimeoutMs ?? 15_000, perMessageDeflate: false });
      stats.created++;
      // without an 'error' listener the ws package would throw; feed.ts adds its own onerror too
      this.on('error', () => undefined);
      this.on('open', () => {
        this.#wasOpen = true;
        stats.opened++;
        stats.open++;
        this.#beat = setInterval(() => this.#ping(), opts.pingMs);
        this.#beat.unref?.();
      });
      this.on('pong', () => {
        this.#waiting = false;
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
        this.#pongTimer = null;
        stats.pongs++;
        stats.lastRttMs = Date.now() - this.#sentAt;
      });
      this.on('message', () => {
        stats.messages++;
        stats.lastMessageAt = Date.now();
      });
      this.on('close', (code: number) => {
        if (this.#beat) clearInterval(this.#beat);
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
        this.#beat = null;
        this.#pongTimer = null;
        if (this.#wasOpen) stats.open--;
        this.#wasOpen = false;
        stats.closed++;
        stats.lastCloseCode = code;
      });
    }

    #ping(): void {
      if (this.readyState !== WS.OPEN || this.#waiting) return;
      this.#waiting = true;
      this.#sentAt = Date.now();
      stats.pings++;
      this.#pongTimer = setTimeout(() => {
        if (!this.#waiting) return;
        stats.heartbeatFailures++;
        this.terminate(); // emits 'close' (1006): the feed code sees a dropped connection
      }, opts.pongTimeoutMs);
      this.#pongTimer.unref?.();
      try {
        this.ping();
      } catch {
        /* closing already */
      }
    }
  }

  return { WebSocket: HeartbeatWebSocket, stats: () => ({ ...stats }) };
}
