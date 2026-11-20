import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../../../src/lib/log';
import { bearerMatches, FailureLimiter } from './auth';
import { BadRequest, type ApiResult, type Router } from './router';

/**
 * The HTTP server: JSON in, JSON out, no cookies, no CORS (the Android app uses native HTTP).
 * It listens on 127.0.0.1 by default; on EC2 a reverse proxy (Caddy / nginx) adds HTTPS in front.
 */

export interface HttpOptions {
  host: string;
  port: number;
  apiToken: string | null;
  router: Router;
}

export interface HttpServer {
  readonly server: Server;
  listen(): Promise<number>;
  close(timeoutMs: number): Promise<void>;
}

const log = createLogger('http');

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>, head: boolean): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(head ? undefined : text);
}

export function createHttpServer(o: HttpOptions): HttpServer {
  const limiter = new FailureLimiter();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = randomUUID();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://server.local');
    const ip = req.socket.remoteAddress ?? 'unknown';
    const head = method === 'HEAD';
    const base = { 'X-Request-Id': requestId };
    let status = 500;
    let quiet = false;
    try {
      const m = o.router.match(method, url.pathname);
      let result: ApiResult;
      if (!m) result = { status: 404, body: { error: 'not_found', message: 'No such address.' } };
      else if ('allowed' in m) {
        const allow = [...m.allowed, ...(m.allowed.includes('GET') ? ['HEAD'] : [])].join(', ');
        result = { status: 405, body: { error: 'method_not_allowed', message: `Use ${allow}.` }, headers: { Allow: allow } };
      } else {
        quiet = m.route.quiet;
        if (m.route.auth && !o.apiToken) {
          result = { status: 503, body: { error: 'api_disabled', message: 'The API is off: set TB_API_TOKEN on the server.' } };
        } else if (m.route.auth && limiter.blocked(ip, started)) {
          result = { status: 429, body: { error: 'too_many_attempts', message: 'Too many wrong tokens. Try again later.' }, headers: { 'Retry-After': '600' } };
        } else if (m.route.auth && !bearerMatches(req.headers.authorization, o.apiToken!)) {
          limiter.fail(ip, started);
          result = { status: 401, body: { error: 'unauthorized', message: 'Send Authorization: Bearer <token>.' }, headers: { 'WWW-Authenticate': 'Bearer' } };
        } else {
          result = await m.route.handler({ params: m.params, query: url.searchParams, requestId });
        }
      }
      status = result.status ?? 200;
      send(res, status, result.body, { ...base, ...(result.headers ?? {}) }, head);
    } catch (err) {
      if (err instanceof BadRequest) {
        status = 400;
        send(res, status, { error: 'bad_request', message: err.message }, base, head);
      } else {
        status = 500;
        log.error('Request failed', { requestId, path: url.pathname, error: err });
        if (!res.headersSent) send(res, status, { error: 'internal', message: 'Something went wrong on the server.', requestId }, base, head);
        else res.destroy();
      }
    } finally {
      const line = `${method} ${url.pathname} ${status} ${Date.now() - started} ms`;
      if (quiet && status < 400) log.debug(line, { requestId });
      else log.info(line, { requestId, ip });
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, o.host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: (timeoutMs) =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
        force.unref?.();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
