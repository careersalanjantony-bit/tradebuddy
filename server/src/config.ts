import { resolve } from 'node:path';
import type { LogLevel } from '../../src/storage/schema';

declare const __APP_VERSION__: string;

/** The app version this server was built from (package.json, set at build time). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * Server settings. Everything comes from environment variables (on EC2: the systemd EnvironmentFile,
 * /etc/tradebuddy/server.env, readable by root and the service only). Secrets are never read from or
 * written to the repository, and never logged.
 */
export interface ServerConfig {
  host: string;
  port: number;
  /** SQLite database and other state; systemd's StateDirectory sets STATE_DIRECTORY */
  dataDir: string;
  logLevel: LogLevel;
  /** Bearer token the Android app sends to the REST API; null = API switched off (health checks still work) */
  apiToken: string | null;
  /** Upstox Analytics Token (read-only market data); null = no market data */
  upstoxAnalyticsToken: string | null;
  /** keep the Upstox live price feed (WebSocket) connected during market hours */
  liveFeed: boolean;
  /** download holidays, NSE index lists and prices in the background (off only in tests) */
  backgroundTasks: boolean;
  /** milestone 3: run the app's own jobs (scans, signals, alerts, learning) on the server */
  jobs: boolean;
  shutdownTimeoutMs: number;
  version: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const MIN_API_TOKEN_LENGTH = 32;
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const TRUE = ['1', 'true', 'on', 'yes'];
const FALSE = ['0', 'false', 'off', 'no'];

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = read(env, name)?.toLowerCase();
  if (raw === undefined || raw === null) return fallback;
  if (TRUE.includes(raw)) return true;
  if (FALSE.includes(raw)) return false;
  problems.push(`${name} must be on or off, got "${raw}"`);
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];

  const portRaw = read(env, 'TB_PORT') ?? '8787';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port > 65535) problems.push(`TB_PORT must be a port number (0-65535), got "${portRaw}"`);

  const logLevel = (read(env, 'TB_LOG_LEVEL') ?? 'info').toLowerCase() as LogLevel;
  if (!LEVELS.includes(logLevel)) problems.push(`TB_LOG_LEVEL must be one of ${LEVELS.join(', ')}, got "${logLevel}"`);

  const apiToken = read(env, 'TB_API_TOKEN');
  if (apiToken !== null && apiToken.length < MIN_API_TOKEN_LENGTH) {
    problems.push(`TB_API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters (make one with: openssl rand -hex 32)`);
  }

  const timeoutRaw = read(env, 'TB_SHUTDOWN_TIMEOUT_MS') ?? '20000';
  const shutdownTimeoutMs = Number(timeoutRaw);
  if (!/^\d+$/.test(timeoutRaw) || shutdownTimeoutMs < 1000) problems.push(`TB_SHUTDOWN_TIMEOUT_MS must be a number of milliseconds (1000 or more), got "${timeoutRaw}"`);

  const liveFeed = flag(env, 'TB_LIVE_FEED', true, problems);
  const backgroundTasks = flag(env, 'TB_BACKGROUND_TASKS', true, problems);
  const jobs = flag(env, 'TB_JOBS', true, problems);

  // systemd may pass several state directories separated by ':'; the first one is ours
  const dataDir = resolve(read(env, 'TB_DATA_DIR') ?? read(env, 'STATE_DIRECTORY')?.split(':')[0] ?? './server-data');

  if (problems.length) throw new ConfigError(`Invalid TradeBuddy server configuration:\n - ${problems.join('\n - ')}`);

  return {
    host: read(env, 'TB_HOST') ?? '127.0.0.1',
    port,
    dataDir,
    logLevel,
    apiToken,
    upstoxAnalyticsToken: read(env, 'UPSTOX_ANALYTICS_TOKEN'),
    liveFeed,
    backgroundTasks,
    jobs,
    shutdownTimeoutMs,
    version: APP_VERSION,
  };
}
