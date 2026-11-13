/** Deep-partial helper type. */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * Merges stored values over defaults, so settings written by an older version gain new fields.
 * - Plain objects merge recursively.
 * - A stored value is used only if its type matches the default (null defaults accept numbers/strings).
 * - Keys not in defaults are dropped (removes obsolete settings).
 */
export function mergeWithDefaults<T>(defaults: T, stored: unknown): T {
  if (isPlainObject(defaults)) {
    const src = isPlainObject(stored) ? stored : {};
    const out: Record<string, unknown> = {};
    for (const [k, dv] of Object.entries(defaults)) {
      out[k] = mergeWithDefaults(dv, src[k]);
    }
    return out as T;
  }
  if (stored === undefined) return clone(defaults);
  if (defaults === null) {
    return (stored === null || typeof stored === 'number' || typeof stored === 'string' ? stored : null) as T;
  }
  if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : clone(defaults)) as T;
  if (typeof stored !== typeof defaults) return clone(defaults);
  if (typeof stored === 'number' && !Number.isFinite(stored)) return clone(defaults);
  return stored as T;
}

/** Applies a deep-partial patch over a full object. Arrays and non-objects are replaced. */
export function applyPatch<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, pv] of Object.entries(patch)) {
    if (pv === undefined) continue;
    const bv = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(bv) && isPlainObject(pv) ? applyPatch(bv, pv as DeepPartial<typeof bv>) : pv;
  }
  return out as T;
}

function clone<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : structuredClone(v);
}
