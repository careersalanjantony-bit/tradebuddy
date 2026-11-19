import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The server's database: one SQLite file (WAL mode) in the data directory. Node 24's built-in
 * `node:sqlite`, so nothing native has to be compiled on the server.
 *
 * Every schema change is a new entry at the END of MIGRATIONS. Never edit a released entry.
 */

const MIGRATIONS: string[] = [
  // 1: key-value areas (chrome.storage.local / session replacement) and a small event journal
  `CREATE TABLE kv (
     area TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (area, key)
   ) WITHOUT ROWID;
   CREATE TABLE server_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     data TEXT
   );
   CREATE INDEX server_events_ts ON server_events (ts);`,
  // 2 (milestone 3): the app's IndexedDB stores, chrome.alarms, and the one-server-per-database lock
  `CREATE TABLE idb_rows (
     store TEXT NOT NULL,
     k TEXT NOT NULL,
     kj TEXT NOT NULL,
     v TEXT NOT NULL,
     i1 TEXT,
     i2 TEXT,
     PRIMARY KEY (store, k)
   ) WITHOUT ROWID;
   CREATE INDEX idb_rows_i1 ON idb_rows (store, i1) WHERE i1 IS NOT NULL;
   CREATE INDEX idb_rows_i2 ON idb_rows (store, i2) WHERE i2 IS NOT NULL;
   CREATE TABLE alarms (
     name TEXT PRIMARY KEY,
     scheduled_time INTEGER NOT NULL,
     period_minutes REAL
   );
   CREATE TABLE server_lock (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     pid INTEGER NOT NULL,
     host TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     heartbeat_at INTEGER NOT NULL
   );`,
  // 3 (milestone 4): paired phones, one-time pairing codes, and the push outbox
  `CREATE TABLE devices (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     platform TEXT NOT NULL,
     app_version TEXT,
     secret_hash TEXT NOT NULL,
     fcm_token TEXT,
     fcm_token_at INTEGER,
     token_state TEXT NOT NULL DEFAULT 'none',
     categories TEXT NOT NULL,
     quiet_json TEXT,
     channel_id TEXT,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER,
     last_push_at INTEGER,
     revoked_at INTEGER
   );
   CREATE TABLE pairing_codes (
     code_hash TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     device_id TEXT
   );
   CREATE TABLE push_outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     alert_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     payload TEXT NOT NULL,
     status TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     sent_at INTEGER,
     message_id TEXT,
     UNIQUE (alert_id, device_id)
   );
   CREATE INDEX push_outbox_due ON push_outbox (status, next_at);`,
];

export const DB_SCHEMA_VERSION = MIGRATIONS.length;
const KEEP_EVENTS = 5000;

export interface ServerEvent {
  id: number;
  ts: number;
  kind: string;
  data: unknown;
}

export interface Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  readonly closed: boolean;
  /** true when the database answers */
  ping(): boolean;
  /** journal entry (start, stop, feed problems…); never throws */
  event(kind: string, data?: unknown, now?: number): void;
  recentEvents(limit?: number): ServerEvent[];
  close(): void;
}

function migrate(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  let v = row?.version ?? 0;
  if (v > MIGRATIONS.length) throw new Error(`The database is schema v${v}, newer than this server (v${MIGRATIONS.length}). Update the server.`);
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return v;
}

export function openStore(dataDir: string, file = 'tradebuddy.db'): Store {
  const path = file === ':memory:' ? ':memory:' : join(dataDir, file);
  if (file !== ':memory:') mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const schemaVersion = migrate(db);
  const insertEvent = db.prepare('INSERT INTO server_events (ts, kind, data) VALUES (?, ?, ?)');
  const trimEvents = db.prepare('DELETE FROM server_events WHERE id <= (SELECT MAX(id) FROM server_events) - ?');
  let closed = false;
  let inserts = 0;

  return {
    db,
    path,
    schemaVersion,
    get closed() {
      return closed;
    },
    ping() {
      if (closed) return false;
      try {
        return (db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined)?.ok === 1;
      } catch {
        return false;
      }
    },
    event(kind, data, now = Date.now()) {
      if (closed) return;
      try {
        insertEvent.run(now, kind, data === undefined ? null : JSON.stringify(data));
        if (++inserts % 100 === 0) trimEvents.run(KEEP_EVENTS);
      } catch {
        /* the journal is best effort */
      }
    },
    recentEvents(limit = 50) {
      if (closed) return [];
      const rows = db.prepare('SELECT id, ts, kind, data FROM server_events ORDER BY id DESC LIMIT ?').all(limit) as Array<{ id: number; ts: number; kind: string; data: string | null }>;
      return rows.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, data: r.data === null ? null : (JSON.parse(r.data) as unknown) }));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.exec('RELEASE idb_tx'); // an IndexedDB write group still open: save it
      } catch {
        /* none open */
      }
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* checkpoint is an optimisation */
      }
      db.close();
    },
  };
}
