import type { LogLevel } from './schema';
import { getDb, type LogContext, type LogEntry } from './db';

/** Ring buffer size for the logs store (spec §17). */
export const MAX_LOG_ENTRIES = 5000;

export const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export async function addLog(entry: LogEntry): Promise<number> {
  const db = await getDb();
  return db.add('logs', entry);
}

/** Deletes the oldest entries so at most `max` remain. Returns how many were deleted. */
export async function trimLogs(max = MAX_LOG_ENTRIES): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('logs', 'readwrite');
  const count = await tx.store.count();
  const excess = count - max;
  if (excess <= 0) {
    await tx.done;
    return 0;
  }
  // Keys are auto-incrementing, so the oldest entries have the smallest keys.
  let cursor = await tx.store.openKeyCursor();
  if (cursor && excess > 1) cursor = await cursor.advance(excess - 1);
  if (cursor) await tx.store.delete(IDBKeyRange.upperBound(cursor.primaryKey));
  await tx.done;
  return excess;
}

export interface LogQuery {
  limit?: number;
  /** only entries with id < beforeId (for paging back) */
  beforeId?: number;
  minLevel?: LogLevel;
  ctx?: LogContext | 'all';
  text?: string;
}

/** Newest first. */
export async function listLogs(q: LogQuery = {}): Promise<LogEntry[]> {
  const db = await getDb();
  const limit = q.limit ?? 200;
  const minRank = LEVEL_RANK[q.minLevel ?? 'debug'];
  const text = q.text?.trim().toLowerCase();
  const range = q.beforeId !== undefined ? IDBKeyRange.upperBound(q.beforeId, true) : undefined;
  const out: LogEntry[] = [];
  let cursor = await db.transaction('logs').store.openCursor(range, 'prev');
  while (cursor && out.length < limit) {
    const e = cursor.value;
    if (
      LEVEL_RANK[e.level] >= minRank &&
      (!q.ctx || q.ctx === 'all' || e.ctx === q.ctx) &&
      (!text || matchesText(e, text))
    ) {
      out.push(e);
    }
    cursor = await cursor.continue();
  }
  return out;
}

function matchesText(e: LogEntry, text: string): boolean {
  if (e.msg.toLowerCase().includes(text) || e.module.toLowerCase().includes(text)) return true;
  if (e.data === undefined) return false;
  try {
    return JSON.stringify(e.data).toLowerCase().includes(text);
  } catch {
    return false;
  }
}

export async function countLogs(): Promise<number> {
  const db = await getDb();
  return db.count('logs');
}

export async function clearLogs(): Promise<void> {
  const db = await getDb();
  await db.clear('logs');
}

export async function exportLogs(): Promise<LogEntry[]> {
  const db = await getDb();
  return db.getAll('logs');
}
