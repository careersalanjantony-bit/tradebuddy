import type { LogContext, LogEntry } from '../storage/db';
import type { LogLevel } from '../storage/schema';
import { redact, redactString } from './redact';
import { toLoggable } from './serialize';

/**
 * Logger core. Every entry is serialised and redacted BEFORE it reaches the console or storage.
 * The sink (IndexedDB in the extension) is plugged in by logSetup.ts; tests plug in an array.
 */

export type LogSink = (entry: LogEntry) => void | Promise<void>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LoggerState {
  ctx: LogContext;
  minLevel: LogLevel;
  sinks: LogSink[];
  console: boolean;
}

const state: LoggerState = { ctx: 'unknown', minLevel: 'info', sinks: [], console: true };

export function configureLogger(opts: Partial<LoggerState>): void {
  Object.assign(state, opts);
}

export function setMinLevel(level: LogLevel): void {
  state.minLevel = level;
}

export function getLoggerContext(): LogContext {
  return state.ctx;
}

export function addSink(sink: LogSink): () => void {
  state.sinks.push(sink);
  return () => {
    state.sinks = state.sinks.filter((s) => s !== sink);
  };
}

export function buildEntry(level: LogLevel, module: string, msg: string, data?: unknown, now = Date.now()): LogEntry {
  const entry: LogEntry = { ts: now, level, ctx: state.ctx, module, msg: redactString(msg) };
  if (data !== undefined) entry.data = redact(toLoggable(data));
  return entry;
}

export function emit(level: LogLevel, module: string, msg: string, data?: unknown): void {
  // warn/error are always kept; the min level only filters debug/info.
  if (RANK[level] < RANK[state.minLevel] && RANK[level] < RANK.warn) return;
  let entry: LogEntry;
  try {
    entry = buildEntry(level, module, msg, data);
  } catch (err) {
    entry = { ts: Date.now(), level, ctx: state.ctx, module, msg: redactString(msg), data: { serializeError: String(err) } };
  }
  if (state.console) {
    const line = `[${entry.ctx}/${entry.module}] ${entry.msg}`;
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    if (entry.data !== undefined) fn(line, entry.data);
    else fn(line);
  }
  for (const sink of state.sinks) {
    try {
      const r = sink(entry);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) => console.error('[log] sink failed', err));
      }
    } catch (err) {
      console.error('[log] sink failed', err);
    }
  }
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, data) => emit('debug', module, msg, data),
    info: (msg, data) => emit('info', module, msg, data),
    warn: (msg, data) => emit('warn', module, msg, data),
    error: (msg, data) => emit('error', module, msg, data),
  };
}
