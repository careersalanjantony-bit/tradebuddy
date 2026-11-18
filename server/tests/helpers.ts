import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '../src/config';

export const API_TOKEN = 'test-api-token-0123456789abcdef0123456789abcdef';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tb-server-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string, patch: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    logLevel: 'debug',
    apiToken: API_TOKEN,
    upstoxAnalyticsToken: null,
    liveFeed: false,
    backgroundTasks: false,
    jobs: false,
    shutdownTimeoutMs: 5000,
    version: 'test',
    ...patch,
  };
}

/** Collects the server's JSON log lines. */
export function logCapture(): { lines: string[]; write: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line), text: () => lines.join('\n') };
}

export async function getJson(port: number, path: string, token: string | null = API_TOKEN): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
