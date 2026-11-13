import { addLog, MAX_LOG_ENTRIES, trimLogs } from '../storage/logStore';
import { getSecrets, getSettings, onLocalChanged } from '../storage/local';
import type { LogContext } from '../storage/db';
import { addSink, configureLogger, createLogger, setMinLevel } from './log';
import { registerSecrets } from './redact';

/** BroadcastChannel used to tell open panels that new log entries exist. */
export const LOG_CHANNEL = 'swing-logs';
const TRIM_EVERY = 50;

let initialised = false;

/**
 * Wires the logger to IndexedDB, keeps the min level in sync with settings, teaches the redactor
 * the stored secret values, and captures uncaught errors. Synchronous part runs immediately so
 * nothing logged during startup is lost; async parts complete in the background.
 */
export function initLogging(ctx: LogContext): void {
  if (initialised) return;
  initialised = true;
  configureLogger({ ctx });

  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(LOG_CHANNEL) : null;
  let writes = 0;
  addSink(async (entry) => {
    const id = await addLog(entry);
    channel?.postMessage({ type: 'new', id });
    if (++writes % TRIM_EVERY === 0) await trimLogs(MAX_LOG_ENTRIES);
  });

  const log = createLogger('runtime');
  globalThis.addEventListener('error', (ev: ErrorEvent) => {
    log.error(`Uncaught error: ${ev.message}`, { error: ev.error, source: ev.filename, line: ev.lineno, col: ev.colno });
  });
  globalThis.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    log.error('Unhandled promise rejection', { reason: ev.reason });
  });

  void (async () => {
    try {
      const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
      setMinLevel(settings.logging.level);
      registerSecrets(Object.values(secrets));
      onLocalChanged('settings', (s) => s?.logging?.level && setMinLevel(s.logging.level));
      onLocalChanged('secrets', (s) => s && registerSecrets(Object.values(s)));
      await trimLogs(MAX_LOG_ENTRIES);
    } catch (err) {
      console.error('[log] init failed', err);
    }
  })();
}
