/**
 * Converts arbitrary values into small, JSON-safe structures for logging/storage.
 * Errors become {name, message, stack}; cycles, functions, bigint and oversize strings are handled.
 */

export interface SerializeOptions {
  maxDepth?: number;
  maxString?: number;
  maxArray?: number;
  maxKeys?: number;
}

const DEFAULTS: Required<SerializeOptions> = { maxDepth: 6, maxString: 4000, maxArray: 100, maxKeys: 100 };

export function toLoggable(value: unknown, opts: SerializeOptions = {}): unknown {
  const o = { ...DEFAULTS, ...opts };
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    switch (typeof v) {
      case 'string':
        return v.length > o.maxString ? `${v.slice(0, o.maxString)}… [${v.length - o.maxString} more chars]` : v;
      case 'number':
        return Number.isFinite(v) ? v : String(v);
      case 'boolean':
        return v;
      case 'bigint':
        return `${v.toString()}n`;
      case 'function':
        return `[function ${(v as { name?: string }).name || 'anonymous'}]`;
      case 'symbol':
        return v.toString();
    }
    const obj = v as object;
    if (seen.has(obj)) return '[circular]';
    if (depth >= o.maxDepth) return '[max depth]';
    seen.add(obj);

    if (obj instanceof Error) {
      const out: Record<string, unknown> = { name: obj.name, message: obj.message };
      if (obj.stack) out.stack = walk(obj.stack, depth + 1);
      for (const [k, val] of Object.entries(obj)) out[k] = walk(val, depth + 1);
      if (obj.cause !== undefined) out.cause = walk(obj.cause, depth + 1);
      return out;
    }
    if (obj instanceof Date) return obj.toISOString();
    if (Array.isArray(obj)) {
      const items = obj.slice(0, o.maxArray).map((x) => walk(x, depth + 1));
      if (obj.length > o.maxArray) items.push(`[… ${obj.length - o.maxArray} more items]`);
      return items;
    }
    const entries = Object.entries(obj as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, val] of entries.slice(0, o.maxKeys)) out[k] = walk(val, depth + 1);
    if (entries.length > o.maxKeys) out['…'] = `${entries.length - o.maxKeys} more keys`;
    return out;
  };

  return walk(value, 0);
}

/** Human-readable message from anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
