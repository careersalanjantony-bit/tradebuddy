import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSink, configureLogger, createLogger, setMinLevel } from '../src/lib/log';
import { clearKnownSecrets, REDACTED, registerSecrets } from '../src/lib/redact';
import type { LogEntry } from '../src/storage/db';

let entries: LogEntry[] = [];
let off: () => void;

beforeEach(() => {
  entries = [];
  configureLogger({ ctx: 'test', console: false });
  setMinLevel('info');
  off = addSink((e) => {
    entries.push(e);
  });
});
afterEach(() => {
  off();
  clearKnownSecrets();
});

describe('logger', () => {
  it('writes entries with context, module and level', () => {
    createLogger('feed').info('connected', { keys: 3 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ctx: 'test', module: 'feed', level: 'info', msg: 'connected', data: { keys: 3 } });
    expect(typeof entries[0]!.ts).toBe('number');
  });

  it('drops debug below the min level but always keeps warn/error', () => {
    setMinLevel('warn');
    const log = createLogger('x');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error']);
    setMinLevel('debug');
    log.debug('d2');
    expect(entries.at(-1)?.msg).toBe('d2');
  });

  it('redacts secrets in message and data before any sink sees them', () => {
    registerSecrets(['upstox-secret-1234']);
    createLogger('auth').error('Token exchange failed for upstox-secret-1234', {
      headers: { Authorization: 'Bearer abcdefghijkl' },
      body: 'code=XYZ&client_secret=upstox-secret-1234',
      error: new Error('bad Bearer abcdefghijkl'),
    });
    const e = entries[0]!;
    const json = JSON.stringify(e);
    expect(json).not.toContain('upstox-secret-1234');
    expect(json).not.toContain('abcdefghijkl');
    expect(e.msg).toBe(`Token exchange failed for ${REDACTED}`);
    expect((e.data as { headers: { Authorization: string } }).headers.Authorization).toBe(REDACTED);
  });

  it('serialises errors in data', () => {
    createLogger('x').error('failed', { error: new Error('boom') });
    expect((entries[0]!.data as { error: { message: string } }).error.message).toBe('boom');
  });

  it('survives a failing sink', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offBad = addSink(() => {
      throw new Error('disk full');
    });
    createLogger('x').info('still logged');
    expect(entries.at(-1)?.msg).toBe('still logged');
    offBad();
    spy.mockRestore();
  });
});
