/**
 * A very small router: exact path segments and `:name` parameters. No dependency, easy to read.
 */

export interface ApiResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  /** milestone 4: the JSON body of POST / PUT / DELETE (undefined when there is none) */
  body?: unknown;
  /** the caller's address (for rate limits) */
  ip: string;
  /** milestone 4: the paired phone, on routes with auth 'device' */
  device?: unknown;
}

export type Handler = (ctx: RequestContext) => ApiResult | Promise<ApiResult>;

export interface Route {
  method: string;
  path: string;
  /** true = the admin API token; 'device' = a paired phone's own credential; false = none */
  auth: boolean | 'device';
  /** logged at debug level only (health checks every few seconds) */
  quiet: boolean;
  handler: Handler;
}

export class BadRequest extends Error {
  override name = 'BadRequest';
}

export type Match = { route: Route; params: Record<string, string> } | { allowed: string[] } | null;

export class Router {
  private readonly routes: Array<Route & { parts: string[] }> = [];

  add(method: string, path: string, handler: Handler, opts: { auth?: boolean | 'device'; quiet?: boolean } = {}): this {
    this.routes.push({ method: method.toUpperCase(), path, auth: opts.auth ?? true, quiet: opts.quiet ?? false, handler, parts: path.split('/').filter(Boolean) });
    return this;
  }

  list(): Route[] {
    return this.routes.map(({ parts: _parts, ...r }) => r);
  }

  /** The route for this method and path; `{ allowed }` when only the method is wrong; null when unknown. */
  match(method: string, pathname: string): Match {
    const segs = pathname.split('/').filter(Boolean);
    const allowed: string[] = [];
    for (const r of this.routes) {
      const params = matchParts(r.parts, segs);
      if (!params) continue;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { route: r, params };
      allowed.push(r.method);
    }
    return allowed.length ? { allowed: [...new Set(allowed)] } : null;
  }
}

function matchParts(parts: string[], segs: string[]): Record<string, string> | null {
  if (parts.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const s = segs[i]!;
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(s);
      } catch {
        throw new BadRequest(`Bad characters in the address: ${s}`);
      }
    } else if (p !== s) return null;
  }
  return params;
}
