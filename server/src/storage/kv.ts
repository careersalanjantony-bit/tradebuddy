import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * The server's replacement for chrome.storage.local and chrome.storage.session: the same calls
 * (get / set / remove / clear, change events), kept in memory and saved in SQLite, so everything the
 * shared code stores survives a restart.
 *
 *  - 'local'  : written to the database at once (settings, plans, practice money, learning…)
 *  - 'session': prices and other fast-changing state; written every few seconds and at shutdown
 */

export type Area = 'local' | 'session';

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type ChangeListener = (changes: Record<string, StorageChange>, area: Area) => void;

/** Shared by both areas, like chrome.storage.onChanged. */
export class ChangeHub {
  private listeners = new Set<ChangeListener>();
  addListener = (l: ChangeListener): void => void this.listeners.add(l);
  removeListener = (l: ChangeListener): void => void this.listeners.delete(l);
  hasListener = (l: ChangeListener): boolean => this.listeners.has(l);
  emit(changes: Record<string, StorageChange>, area: Area): void {
    if (!Object.keys(changes).length) return;
    for (const l of [...this.listeners]) {
      queueMicrotask(() => {
        try {
          l(changes, area);
        } catch {
          /* a listener's error must not break storage */
        }
      });
    }
  }
}

/**
 * Lets some keys differ between what the code sees and what is saved — used to keep secrets that come
 * from the environment out of the database.
 */
export interface KVOverlay {
  /** value the code sees, from what is stored */
  read(key: string, stored: unknown): unknown;
  /** value to store, from what the code set */
  write(key: string, value: unknown): unknown;
}

export interface KVOptions {
  /** 0 = write at once; otherwise save changed keys this often */
  writeBehindMs?: number;
  overlay?: KVOverlay;
  hub?: ChangeHub;
}

type Keys = string | string[] | Record<string, unknown> | null | undefined;

export class SqliteKV {
  private readonly cache = new Map<string, unknown>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly upsert: StatementSync;
  private readonly del: StatementSync;
  private readonly delAll: StatementSync;
  private closedFlag = false;
  /** writes that failed (disk full…), for the health check */
  writeErrors = 0;

  constructor(
    private readonly db: DatabaseSync,
    readonly area: Area,
    private readonly opts: KVOptions = {},
  ) {
    this.upsert = db.prepare('INSERT INTO kv (area, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (area, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    this.del = db.prepare('DELETE FROM kv WHERE area = ? AND key = ?');
    this.delAll = db.prepare('DELETE FROM kv WHERE area = ?');
    const rows = db.prepare('SELECT key, value FROM kv WHERE area = ?').all(area) as Array<{ key: string; value: string }>;
    for (const r of rows) {
      try {
        this.cache.set(r.key, JSON.parse(r.value));
      } catch {
        /* a damaged row is skipped; the next write replaces it */
      }
    }
    if (opts.writeBehindMs && opts.writeBehindMs > 0) {
      this.timer = setInterval(() => this.flush(), opts.writeBehindMs);
      this.timer.unref?.();
    }
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get size(): number {
    return this.cache.size;
  }

  get pendingWrites(): number {
    return this.dirty.size;
  }

  private view(key: string): unknown {
    const stored = this.cache.get(key);
    const seen = this.opts.overlay ? this.opts.overlay.read(key, stored) : stored;
    return seen === undefined ? undefined : structuredClone(seen);
  }

  async get(keys?: Keys): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      for (const k of this.cache.keys()) {
        const v = this.view(k);
        if (v !== undefined) out[k] = v;
      }
      // overlay-only keys (e.g. secrets that exist only in the environment)
      if (this.opts.overlay && !this.cache.has('secrets')) {
        const v = this.view('secrets');
        if (v !== undefined) out.secrets = v;
      }
      return out;
    }
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      for (const k of keys) {
        const v = this.view(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    for (const [k, fallback] of Object.entries(keys)) {
      const v = this.view(k);
      out[k] = v === undefined ? fallback : v;
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    const now = Date.now();
    for (const [key, value] of Object.entries(items)) {
      if (value === undefined) continue;
      const oldValue = this.view(key);
      // like chrome.storage: values are stored as JSON
      const json = JSON.stringify(this.opts.overlay ? this.opts.overlay.write(key, value) : value);
      if (json === undefined) continue;
      this.cache.set(key, JSON.parse(json));
      if (this.opts.writeBehindMs) this.dirty.add(key);
      else this.write(key, json, now);
      changes[key] = { oldValue, newValue: this.view(key) };
    }
    this.opts.hub?.emit(changes, this.area);
  }

  async remove(keys: string | string[]): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!this.cache.has(key)) continue;
      changes[key] = { oldValue: this.view(key) };
      this.cache.delete(key);
      this.dirty.delete(key);
      this.guard(() => this.del.run(this.area, key));
    }
    this.opts.hub?.emit(changes, this.area);
  }

  async clear(): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const key of this.cache.keys()) changes[key] = { oldValue: this.view(key) };
    this.cache.clear();
    this.dirty.clear();
    this.guard(() => this.delAll.run(this.area));
    this.opts.hub?.emit(changes, this.area);
  }

  /** Saves everything changed since the last save (write-behind area). */
  flush(): void {
    if (!this.dirty.size || this.closedFlag) return;
    const now = Date.now();
    const keys = [...this.dirty];
    this.dirty.clear();
    this.guard(() => {
      // a savepoint, so this also works inside another write (e.g. a running IndexedDB transaction)
      this.db.exec('SAVEPOINT kv_flush');
      try {
        for (const k of keys) if (this.cache.has(k)) this.upsert.run(this.area, k, JSON.stringify(this.cache.get(k)), now);
        this.db.exec('RELEASE kv_flush');
      } catch (err) {
        this.db.exec('ROLLBACK TO kv_flush');
        this.db.exec('RELEASE kv_flush');
        for (const k of keys) this.dirty.add(k);
        throw err;
      }
    });
  }

  /** Last save and stop. Later writes stay in memory only. */
  close(): void {
    if (this.closedFlag) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
    this.closedFlag = true;
  }

  private write(key: string, json: string, now: number): void {
    this.guard(() => this.upsert.run(this.area, key, json, now));
  }

  private guard(fn: () => unknown): void {
    if (this.closedFlag) return;
    try {
      fn();
    } catch {
      this.writeErrors++;
    }
  }
}
