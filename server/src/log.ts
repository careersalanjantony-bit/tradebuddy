import { addSink, configureLogger, createLogger, setMinLevel } from '../../src/lib/log';
import { registerSecrets } from '../../src/lib/redact';
import type { LogEntry } from '../../src/storage/db';
import type { LogLevel } from '../../src/storage/schema';

/**
 * Structured logging: one JSON object per line (journald / CloudWatch friendly). The app's own logger
 * (src/lib/log.ts) is reused, so every module — shared trading code included — logs the same way and
 * every entry is redacted (tokens, secrets) before it is written.
 */

export type LineWriter = (line: string, level: LogLevel) => void;

const stdWriter: LineWriter = (line, level) => {
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
};

export function formatEntry(e: LogEntry): string {
  const out: Record<string, unknown> = { time: new Date(e.ts).toISOString(), level: e.level, module: e.module, msg: e.msg };
  if (e.data !== undefined) out.data = e.data;
  return JSON.stringify(out);
}

let removeSink: (() => void) | null = null;

export function setupLogging(opts: { level: LogLevel; secrets?: Array<string | null | undefined>; write?: LineWriter }): void {
  configureLogger({ ctx: 'background', console: false });
  setMinLevel(opts.level);
  registerSecrets(opts.secrets ?? []);
  removeSink?.();
  const write = opts.write ?? stdWriter;
  removeSink = addSink((entry) => {
    try {
      write(formatEntry(entry), entry.level);
    } catch {
      /* logging must never break the server */
    }
  });
}

export { createLogger };
