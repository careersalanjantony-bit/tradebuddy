import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * The app's IndexedDB on the server (milestone 3), in SQLite — so the app's own data code
 * (src/data/candles.ts, intraday.ts, instruments.ts, corporateActions.ts, alerts/engine.ts…) runs
 * unchanged and everything survives a restart. It answers the calls of the `idb` library that the app
 * makes: get / getAll / getAllFromIndex / count / put / add / delete / clear on the database, and
 * transaction(...).store with the same calls plus openCursor / openKeyCursor and `done`.
 *
 * Keys keep IndexedDB's order (numbers < strings < arrays, arrays element by element), encoded as
 * text that SQLite sorts the same way, so key ranges such as [key, ''] … [key, '￿'] work.
 * Each store is one set of rows in `idb_rows`; up to two index values per row (i1, i2).
 * The store definitions mirror src/storage/db.ts (keep them in step when a store is added there).
 */

interface StoreDef {
  keyPath: string | string[];
  autoIncrement?: boolean;
  indexes?: Record<string, { col: 'i1' | 'i2'; path: string }>;
}

export const STORES: Record<string, StoreDef> = {
  instruments: { keyPath: 'instrument_key', indexes: { by_symbol: { col: 'i1', path: 'trading_symbol' }, by_isin: { col: 'i2', path: 'isin' } } },
  candles: { keyPath: ['instrument_key', 'date'], indexes: { by_instrument: { col: 'i1', path: 'instrument_key' } } },
  adjustments: { keyPath: 'instrument_key' },
  corporateActions: { keyPath: 'isin' },
  fundamentals: { keyPath: ['isin', 'kind'] },
  news: { keyPath: 'id', indexes: { by_instrument: { col: 'i1', path: 'instrument_key' }, by_published: { col: 'i2', path: 'published_time' } } },
  reports: { keyPath: 'id', indexes: { by_symbol: { col: 'i1', path: 'symbol' }, by_created: { col: 'i2', path: 'created_at' } } },
  journal: { keyPath: 'id', indexes: { by_status: { col: 'i1', path: 'status' }, by_symbol: { col: 'i2', path: 'symbol' } } },
  alertLog: { keyPath: 'id', autoIncrement: true, indexes: { by_ts: { col: 'i1', path: 'ts' } } },
  logs: { keyPath: 'id', autoIncrement: true, indexes: { by_ts: { col: 'i1', path: 'ts' } } },
  intraday: { keyPath: ['key', 'date'] },
};

// ---------------------------------------------------------------- keys and ranges

export class DataError extends Error {
  override name = 'DataError';
}

const view = new DataView(new ArrayBuffer(8));
/** A double as 16 hex characters that sort like the numbers. */
function numberText(n: number): string {
  view.setFloat64(0, n === 0 ? 0 : n);
  let hi = view.getUint32(0);
  let lo = view.getUint32(4);
  if (n >= 0) hi = (hi ^ 0x80000000) >>> 0;
  else {
    hi = ~hi >>> 0;
    lo = ~lo >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** IndexedDB key → sortable text (number "1…", date "2…", string "3…", array "5…"). */
export function encodeKey(k: unknown): string {
  if (typeof k === 'number') {
    if (Number.isNaN(k)) throw new DataError('NaN is not a valid key');
    return `1${numberText(k)}`;
  }
  if (k instanceof Date) return `2${numberText(k.getTime())}`;
  if (typeof k === 'string') return `3${k}`;
  // \u0001 between elements: lower than every character keys use (not \u0000: SQLite text stops there)
  if (Array.isArray(k)) return `5${k.map(encodeKey).join('\u0001')}`;
  throw new DataError('Not a valid key');
}

function isKey(k: unknown): boolean {
  try {
    encodeKey(k);
    return true;
  } catch {
    return false;
  }
}

/** IDBKeyRange for Node (the server has no IndexedDB); the store accepts any object of this shape. */
export class KeyRange {
  constructor(
    readonly lower: unknown,
    readonly upper: unknown,
    readonly lowerOpen = false,
    readonly upperOpen = false,
  ) {}
  static only(v: unknown): KeyRange {
    return new KeyRange(v, v);
  }
  static lowerBound(v: unknown, open = false): KeyRange {
    return new KeyRange(v, undefined, open, true);
  }
  static upperBound(v: unknown, open = false): KeyRange {
    return new KeyRange(undefined, v, true, open);
  }
  static bound(l: unknown, u: unknown, lowerOpen = false, upperOpen = false): KeyRange {
    return new KeyRange(l, u, lowerOpen, upperOpen);
  }
  includes(k: unknown): boolean {
    const e = encodeKey(k);
    if (this.lower !== undefined) {
      const l = encodeKey(this.lower);
      if (this.lowerOpen ? e <= l : e < l) return false;
    }
    if (this.upper !== undefined) {
      const u = encodeKey(this.upper);
      if (this.upperOpen ? e >= u : e > u) return false;
    }
    return true;
  }
}

/** Puts KeyRange in place of IDBKeyRange when the runtime has none. */
export function installKeyRange(): void {
  const g = globalThis as { IDBKeyRange?: unknown };
  g.IDBKeyRange ??= KeyRange;
}

interface RangeLike {
  lower: unknown;
  upper: unknown;
  lowerOpen: boolean;
  upperOpen: boolean;
}
const isRange = (q: unknown): q is RangeLike => !!q && typeof q === 'object' && !Array.isArray(q) && !(q instanceof Date) && 'lowerOpen' in q && 'upperOpen' in q;

/** SQL condition on a column for a key or key range (and its parameters). */
function where(col: string, query: unknown): { sql: string; args: string[] } {
  if (query === undefined || query === null) return { sql: '', args: [] };
  if (!isRange(query)) return { sql: ` AND ${col} = ?`, args: [encodeKey(query)] };
  let sql = '';
  const args: string[] = [];
  if (query.lower !== undefined && query.lower !== null) {
    sql += ` AND ${col} ${query.lowerOpen ? '>' : '>='} ?`;
    args.push(encodeKey(query.lower));
  }
  if (query.upper !== undefined && query.upper !== null) {
    sql += ` AND ${col} ${query.upperOpen ? '<' : '<='} ?`;
    args.push(encodeKey(query.upper));
  }
  return { sql, args };
}

function valueAt(obj: unknown, path: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[path] : undefined;
}

// ---------------------------------------------------------------- the store

type Row = { kj: string; v: string };
const parseRow = (r: Row | undefined) => (r ? { key: JSON.parse(r.kj) as unknown, value: JSON.parse(r.v) as unknown } : null);

export class SqliteIdb {
  readonly name = 'swing-assistant';
  readonly version = 2;
  readonly objectStoreNames = { contains: (n: string) => n in STORES, length: Object.keys(STORES).length };
  private readonly upsert: StatementSync;
  private readonly insert: StatementSync;
  private inTx = false;
  closed = false;

  constructor(private readonly db: DatabaseSync) {
    this.upsert = db.prepare('INSERT INTO idb_rows (store, k, kj, v, i1, i2) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (store, k) DO UPDATE SET kj = excluded.kj, v = excluded.v, i1 = excluded.i1, i2 = excluded.i2');
    this.insert = db.prepare('INSERT INTO idb_rows (store, k, kj, v, i1, i2) VALUES (?, ?, ?, ?, ?, ?)');
  }

  private def(store: string): StoreDef {
    const d = STORES[store];
    if (!d) throw new Error(`NotFoundError: no object store "${store}"`);
    return d;
  }

  private keyOf(store: string, value: unknown, explicit?: unknown): unknown {
    if (explicit !== undefined) return explicit;
    const d = this.def(store);
    if (Array.isArray(d.keyPath)) return d.keyPath.map((p) => valueAt(value, p));
    return valueAt(value, d.keyPath);
  }

  private write(store: string, value: unknown, key: unknown, mustBeNew: boolean): unknown {
    const d = this.def(store);
    let k = this.keyOf(store, value, key);
    if ((k === undefined || k === null) && d.autoIncrement) {
      const last = this.db.prepare("SELECT kj FROM idb_rows WHERE store = ? AND k LIKE '1%' ORDER BY k DESC LIMIT 1").get(store) as { kj: string } | undefined;
      k = (last ? Number(JSON.parse(last.kj)) : 0) + 1;
      if (typeof d.keyPath === 'string' && value && typeof value === 'object') (value as Record<string, unknown>)[d.keyPath] = k;
    }
    const ek = encodeKey(k);
    const idx = { i1: null as string | null, i2: null as string | null };
    for (const ix of Object.values(d.indexes ?? {})) {
      const iv = valueAt(value, ix.path);
      idx[ix.col] = iv !== undefined && isKey(iv) ? encodeKey(iv) : null;
    }
    const v = JSON.stringify(value);
    try {
      (mustBeNew ? this.insert : this.upsert).run(store, ek, JSON.stringify(k), v, idx.i1, idx.i2);
    } catch (err) {
      if (mustBeNew && /UNIQUE|PRIMARY/i.test(String(err))) throw new Error(`ConstraintError: key already exists in "${store}"`);
      throw err;
    }
    return k;
  }

  private rows(store: string, query: unknown, opts: { col?: string; dir?: 'next' | 'prev'; limit?: number; after?: string } = {}): Array<Row & { k: string }> {
    this.def(store);
    const col = opts.col ?? 'k';
    const w = where(col, query);
    const after = opts.after !== undefined ? ` AND k ${opts.dir === 'prev' ? '<' : '>'} ?` : '';
    const order = `${col === 'k' ? '' : `${col} ${opts.dir === 'prev' ? 'DESC' : 'ASC'}, `}k ${opts.dir === 'prev' ? 'DESC' : 'ASC'}`;
    const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
    const notNull = col === 'k' ? '' : ` AND ${col} IS NOT NULL`;
    const sql = `SELECT k, kj, v FROM idb_rows WHERE store = ?${notNull}${w.sql}${after} ORDER BY ${order}${limit}`;
    return this.db.prepare(sql).all(store, ...w.args, ...(opts.after !== undefined ? [opts.after] : [])) as Array<Row & { k: string }>;
  }

  // ----- the idb database calls

  async get(store: string, query: unknown): Promise<unknown> {
    return parseRow(this.rows(store, query, { limit: 1 })[0])?.value;
  }
  async getKey(store: string, query: unknown): Promise<unknown> {
    return parseRow(this.rows(store, query, { limit: 1 })[0])?.key;
  }
  async getAll(store: string, query?: unknown, count?: number): Promise<unknown[]> {
    return this.rows(store, query, count ? { limit: count } : {}).map((r) => JSON.parse(r.v) as unknown);
  }
  async getAllKeys(store: string, query?: unknown, count?: number): Promise<unknown[]> {
    return this.rows(store, query, count ? { limit: count } : {}).map((r) => JSON.parse(r.kj) as unknown);
  }
  async getAllFromIndex(store: string, index: string, query?: unknown, count?: number): Promise<unknown[]> {
    return this.rows(store, query, { col: this.indexCol(store, index), ...(count ? { limit: count } : {}) }).map((r) => JSON.parse(r.v) as unknown);
  }
  async getFromIndex(store: string, index: string, query: unknown): Promise<unknown> {
    return parseRow(this.rows(store, query, { col: this.indexCol(store, index), limit: 1 })[0])?.value;
  }
  async count(store: string, query?: unknown): Promise<number> {
    this.def(store);
    const w = where('k', query);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM idb_rows WHERE store = ?${w.sql}`).get(store, ...w.args) as { n: number }).n;
  }
  async countFromIndex(store: string, index: string, query?: unknown): Promise<number> {
    const col = this.indexCol(store, index);
    const w = where(col, query);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM idb_rows WHERE store = ? AND ${col} IS NOT NULL${w.sql}`).get(store, ...w.args) as { n: number }).n;
  }
  async put(store: string, value: unknown, key?: unknown): Promise<unknown> {
    return this.write(store, value, key, false);
  }
  async add(store: string, value: unknown, key?: unknown): Promise<unknown> {
    return this.write(store, value, key, true);
  }
  async delete(store: string, query: unknown): Promise<void> {
    this.def(store);
    const w = where('k', query);
    this.db.prepare(`DELETE FROM idb_rows WHERE store = ?${w.sql}`).run(store, ...w.args);
  }
  async clear(store: string): Promise<void> {
    this.def(store);
    this.db.prepare('DELETE FROM idb_rows WHERE store = ?').run(store);
  }
  close(): void {
    this.closed = true;
  }

  private indexCol(store: string, index: string): string {
    const ix = this.def(store).indexes?.[index];
    if (!ix) throw new Error(`NotFoundError: no index "${index}" on "${store}"`);
    return ix.col;
  }

  /**
   * A transaction. SQLite runs every call at once; writes started in the same moment are grouped
   * into one SQLite transaction (much faster for thousands of candles), committed right after.
   */
  transaction(stores: string | string[], mode: 'readonly' | 'readwrite' = 'readonly'): IdbTransaction {
    const names = typeof stores === 'string' ? [stores] : stores;
    for (const n of names) this.def(n);
    if (mode === 'readwrite' && !this.inTx) {
      // a savepoint, not BEGIN: it also nests inside other writes on the same connection
      this.inTx = true;
      this.db.exec('SAVEPOINT idb_tx');
      setImmediate(() => {
        this.inTx = false;
        try {
          this.db.exec('RELEASE idb_tx');
        } catch {
          /* nothing to commit */
        }
      });
    }
    return new IdbTransaction(this, names);
  }

  /** @internal cursor support */
  cursorRow(store: string, query: unknown, dir: 'next' | 'prev', after: string | undefined, col?: string): (Row & { k: string }) | undefined {
    return this.rows(store, query, { dir, limit: 1, ...(after !== undefined ? { after } : {}), ...(col ? { col } : {}) })[0];
  }
}

export class IdbTransaction {
  /** resolves when the work is done (SQLite has already done it) */
  readonly done: Promise<void>;
  readonly store: IdbStore;
  constructor(
    private readonly idb: SqliteIdb,
    readonly storeNames: string[],
  ) {
    this.store = new IdbStore(idb, storeNames[0]!);
    this.done = new Promise((r) => setImmediate(r));
  }
  objectStore(name: string): IdbStore {
    if (!this.storeNames.includes(name)) throw new Error(`NotFoundError: "${name}" is not part of this transaction`);
    return new IdbStore(this.idb, name);
  }
  abort(): void {
    /* writes are already done; nothing to undo */
  }
}

export class IdbStore {
  constructor(
    private readonly idb: SqliteIdb,
    readonly name: string,
  ) {}
  get = (q: unknown) => this.idb.get(this.name, q);
  getKey = (q: unknown) => this.idb.getKey(this.name, q);
  getAll = (q?: unknown, n?: number) => this.idb.getAll(this.name, q, n);
  getAllKeys = (q?: unknown, n?: number) => this.idb.getAllKeys(this.name, q, n);
  count = (q?: unknown) => this.idb.count(this.name, q);
  put = (v: unknown, k?: unknown) => this.idb.put(this.name, v, k);
  add = (v: unknown, k?: unknown) => this.idb.add(this.name, v, k);
  delete = (q: unknown) => this.idb.delete(this.name, q);
  clear = () => this.idb.clear(this.name);
  index(name: string) {
    const store = this.name;
    const idb = this.idb;
    return {
      getAll: (q?: unknown, n?: number) => idb.getAllFromIndex(store, name, q, n),
      get: (q: unknown) => idb.getFromIndex(store, name, q),
      count: (q?: unknown) => idb.countFromIndex(store, name, q),
    };
  }
  async openCursor(query?: unknown, dir: 'next' | 'prev' = 'next'): Promise<IdbCursor | null> {
    return IdbCursor.first(this.idb, this.name, query ?? null, dir, true);
  }
  async openKeyCursor(query?: unknown, dir: 'next' | 'prev' = 'next'): Promise<IdbCursor | null> {
    return IdbCursor.first(this.idb, this.name, query ?? null, dir, false);
  }
}

export class IdbCursor {
  private constructor(
    private readonly idb: SqliteIdb,
    private readonly store: string,
    private readonly query: unknown,
    readonly direction: 'next' | 'prev',
    private readonly withValue: boolean,
    private readonly row: Row & { k: string },
  ) {}

  static first(idb: SqliteIdb, store: string, query: unknown, dir: 'next' | 'prev', withValue: boolean): IdbCursor | null {
    const row = idb.cursorRow(store, query, dir, undefined);
    return row ? new IdbCursor(idb, store, query, dir, withValue, row) : null;
  }

  get key(): unknown {
    return JSON.parse(this.row.kj) as unknown;
  }
  get primaryKey(): unknown {
    return this.key;
  }
  get value(): any {
    return this.withValue ? (JSON.parse(this.row.v) as unknown) : undefined;
  }
  async continue(): Promise<IdbCursor | null> {
    const row = this.idb.cursorRow(this.store, this.query, this.direction, this.row.k);
    return row ? new IdbCursor(this.idb, this.store, this.query, this.direction, this.withValue, row) : null;
  }
  async delete(): Promise<void> {
    await this.idb.delete(this.store, JSON.parse(this.row.kj));
  }
  async update(value: unknown): Promise<unknown> {
    return this.idb.put(this.store, value, JSON.parse(this.row.kj));
  }
}
