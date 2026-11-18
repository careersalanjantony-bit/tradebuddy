import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('server configuration (environment variables)', () => {
  it('has safe defaults: localhost only, API off without a token, live feed on', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: '127.0.0.1', port: 8787, apiToken: null, upstoxAnalyticsToken: null, liveFeed: true, backgroundTasks: true, jobs: true, logLevel: 'info', shutdownTimeoutMs: 20000 });
    expect(c.dataDir).toBe(resolve('./server-data'));
  });

  it('reads every setting, and the data folder from systemd StateDirectory', () => {
    const c = loadConfig({
      TB_PORT: '9000',
      TB_HOST: '0.0.0.0',
      TB_LOG_LEVEL: 'DEBUG',
      TB_API_TOKEN: 'x'.repeat(40),
      UPSTOX_ANALYTICS_TOKEN: ' tok ',
      TB_LIVE_FEED: 'off',
      TB_BACKGROUND_TASKS: 'no',
      TB_SHUTDOWN_TIMEOUT_MS: '15000',
      STATE_DIRECTORY: '/var/lib/tradebuddy:/var/lib/other',
    });
    expect(c).toMatchObject({ port: 9000, host: '0.0.0.0', logLevel: 'debug', apiToken: 'x'.repeat(40), upstoxAnalyticsToken: 'tok', liveFeed: false, backgroundTasks: false, shutdownTimeoutMs: 15000 });
    expect(c.dataDir).toBe(resolve('/var/lib/tradebuddy'));
    expect(loadConfig({ TB_DATA_DIR: '/data/tb', STATE_DIRECTORY: '/var/lib/tradebuddy' }).dataDir).toBe(resolve('/data/tb'));
  });

  it('refuses a short API token and other bad values, listing every problem', () => {
    let err: unknown;
    try {
      loadConfig({ TB_API_TOKEN: 'short', TB_PORT: '99999', TB_LOG_LEVEL: 'loud', TB_LIVE_FEED: 'maybe', TB_SHUTDOWN_TIMEOUT_MS: '5' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    for (const name of ['TB_API_TOKEN', 'TB_PORT', 'TB_LOG_LEVEL', 'TB_LIVE_FEED', 'TB_SHUTDOWN_TIMEOUT_MS']) expect(msg).toContain(name);
    // the message never repeats a secret
    expect(msg).not.toContain('short');
  });
});
