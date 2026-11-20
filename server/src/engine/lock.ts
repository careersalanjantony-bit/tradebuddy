import type { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';

/**
 * One server per database: a second TradeBuddy server started on the same data folder (by hand while
 * systemd runs one, say) would run every job twice and send every alert twice. The running server
 * writes a heartbeat every 10 s; a newer start refuses while that heartbeat is fresh. A server that
 * crashed leaves a stale heartbeat, which is taken over after 30 s.
 */

export const LOCK_STALE_MS = 30_000;
const BEAT_MS = 10_000;

export class LockedError extends Error {
  override name = 'LockedError';
}

export interface ServerLock {
  release(): void;
}

export function acquireLock(db: DatabaseSync, now: () => number = Date.now, pid = process.pid): ServerLock {
  const t = now();
  const row = db.prepare('SELECT pid, host, heartbeat_at FROM server_lock WHERE id = 1').get() as { pid: number; host: string; heartbeat_at: number } | undefined;
  if (row && row.pid !== pid && t - row.heartbeat_at < LOCK_STALE_MS) {
    throw new LockedError(`Another TradeBuddy server (pid ${row.pid} on ${row.host}) is using this database. Stop it first (sudo systemctl stop tradebuddy-server), or use another TB_DATA_DIR.`);
  }
  db.prepare('INSERT INTO server_lock (id, pid, host, started_at, heartbeat_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, host = excluded.host, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at').run(pid, hostname(), t, t);
  const timer = setInterval(() => {
    try {
      db.prepare('UPDATE server_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?').run(now(), pid);
    } catch {
      /* database closing */
    }
  }, BEAT_MS);
  timer.unref?.();
  return {
    release() {
      clearInterval(timer);
      try {
        db.prepare('DELETE FROM server_lock WHERE id = 1 AND pid = ?').run(pid);
      } catch {
        /* already closed */
      }
    },
  };
}
