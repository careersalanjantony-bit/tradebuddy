import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { createLogger } from '../../lib/log';
import { LOG_CHANNEL } from '../../lib/logSetup';
import { formatBytes, formatDateIST, formatDateTimeIST, formatRelative, formatTimeIST, isoDateIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import type { LogContext, LogEntry } from '../../storage/db';
import { clearLogs, countLogs, exportLogs, listLogs, MAX_LOG_ENTRIES } from '../../storage/logStore';
import type { LogLevel } from '../../storage/schema';
import { callBackground, type ApiUsageRow, type BackgroundStatus } from '../../shared/messages';
import { useLocal, useNow, useSessionValue } from '../hooks';
import { DataCheck } from '../components/DataCheck';

const log = createLogger('diagnostics');
const PAGE = 200;

export function DiagnosticsScreen() {
  return (
    <>
      <ExtensionInfo />
      <TestAlerts />
      <UpstoxDiagnostics />
      <DataCheck />
      <LaterMetrics />
      <LogViewer />
    </>
  );
}

function ExtensionInfo() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ local: number; idb: number | null } | null>(null);
  const meta = useLocal('meta');
  const now = useNow(5000);

  const refresh = useCallback(async () => {
    try {
      const t0 = performance.now();
      const s = await callBackground('status:get');
      setPingMs(Math.round(performance.now() - t0));
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      log.warn('Background did not answer', { error: err });
    }
    const local = await chrome.storage.local.getBytesInUse(null);
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    setUsage({ local, idb: est?.usage ?? null });
  }, []);

  // Refresh on open and every 3 s, so "starting" turns into "ready" without a click.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <section class="card">
      <div class="row">
        <h2>Extension</h2>
        <span class="spacer" />
        <button class="btn small" type="button" onClick={() => void refresh()}>
          Ping service worker
        </button>
      </div>
      {error && <div class="banner err">Service worker not reachable: {error}</div>}
      {status?.startupError && <div class="banner err">Startup failed: {status.startupError}</div>}
      <dl class="kv">
        <dt>Version</dt>
        <dd>{status?.version ?? '—'}</dd>
        <dt>Extension ID</dt>
        <dd class="mono">{chrome.runtime.id}</dd>
        <dt>Service worker</dt>
        <dd>
          {status ? (
            <>
              {status.ready ? 'ready' : 'starting'} · started {formatTimeIST(status.startedAt)} IST (
              {formatRelative(status.startedAt, now)}) · reply {pingMs} ms
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt>Storage schema</dt>
        <dd>
          settings v{meta?.schemaVersion ?? '—'} · database v{status?.dbVersion ?? '—'}
        </dd>
        <dt>Installed</dt>
        <dd>{meta?.installedAt ? formatDateTimeIST(meta.installedAt) : '—'}</dd>
        <dt>Storage used</dt>
        <dd>
          settings {formatBytes(usage?.local)} · database {formatBytes(usage?.idb)}
        </dd>
      </dl>
    </section>
  );
}

function UpstoxDiagnostics() {
  const auth = useLocal('auth');
  const jobs = useLocal('scheduleState');
  const api = useSessionValue('apiStatus');
  const feed = useSessionValue('feedStatus');
  const now = useNow(5000);
  const [usage, setUsage] = useState<ApiUsageRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void callBackground('diag:api')
        .then((r) => alive && setUsage(r.usage))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const session =
    auth?.status === 'logged_in' && auth.expiresAt
      ? `logged in${auth.userId ? ` (${auth.userId})` : ''} · ends ${formatDateTimeIST(auth.expiresAt)}`
      : auth?.status === 'expired'
        ? `ended ${auth.expiredAt ? formatDateTimeIST(auth.expiredAt) : ''}${auth.lastError ? ` — ${auth.lastError}` : ''}`
        : 'not logged in';
  const analytics = auth?.analytics ? `${auth.analytics.status}${auth.analytics.checkedAt ? ` (checked ${formatRelative(auth.analytics.checkedAt, now)})` : ''}` : 'not set';
  const limited = api?.rateLimitedUntil && api.rateLimitedUntil > now;

  return (
    <section class="card">
      <h2>Upstox</h2>
      <dl class="kv small">
        <dt>Session</dt>
        <dd>{session}</dd>
        <dt>Analytics Token</dt>
        <dd>{analytics}</dd>
        <dt>API usage</dt>
        <dd data-testid="api-usage">
          {usage ? usage.map((u) => `${u.used}/${u.max} ${u.label}`).join(' · ') : '—'}
          {limited && <span class="warn-text"> · rate-limited, waiting</span>}
        </dd>
        <dt>Requests today</dt>
        <dd>{api?.requestsToday ?? 0}</dd>
        <dt>Instant prices</dt>
        <dd data-testid="feed-status">
          {feed ? (feed.connected ? `connected — ${feed.keys} stocks, last price ${feed.lastTickAt ? formatTimeIST(feed.lastTickAt) : 'not yet'}` : `not connected${feed.error ? ` (${feed.error})` : ''} — normal 2-second updates are used`) : 'not started (connects in market hours)'}{' '}
          <button class="link-btn" type="button" data-testid="feed-test" onClick={() => void callBackground('feed:connect').catch(() => undefined)}>
            test now
          </button>
        </dd>
        <dt>Last success</dt>
        <dd>{api?.lastOkAt ? `${formatTimeIST(api.lastOkAt)} IST (${formatRelative(api.lastOkAt, now)})` : '—'}</dd>
        <dt>Last error</dt>
        <dd class={api?.lastError ? 'err-text' : ''}>{api?.lastErrorAt ? `${formatTimeIST(api.lastErrorAt)} IST — ${api.lastError}` : '—'}</dd>
      </dl>
      <h3>Scheduled jobs</h3>
      <table class="simple" data-testid="jobs">
        <thead>
          <tr>
            <th>Job</th>
            <th>Next run</th>
            <th>Last run</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(jobs ?? {}).map(([name, j]) => (
            <tr>
              <td class="mono">{name}</td>
              <td>{j.nextRunAt ? formatDateTimeIST(j.nextRunAt) : '—'}</td>
              <td>
                {j.lastRunAt ? formatRelative(j.lastRunAt, now) : 'never'}
                {j.lastError && <div class="err-text">{j.lastError}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function LaterMetrics() {
  return (
    <section class="card">
      <h2>Coming later</h2>
      <dl class="kv small">
        <dt>Feed messages/sec</dt>
        <dd class="muted">— (M4)</dd>
        <dt>Claude spend this month</dt>
        <dd class="muted">— (M7)</dd>
        <dt>Telegram</dt>
        <dd class="muted">— (M8)</dd>
      </dl>
    </section>
  );
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const CONTEXTS: Array<LogContext | 'all'> = ['all', 'background', 'sidepanel', 'popup', 'offscreen'];

function LogViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [minLevel, setMinLevel] = useState<LogLevel>('debug');
  const [ctx, setCtx] = useState<LogContext | 'all'>('all');
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const [rows, count] = await Promise.all([listLogs({ limit, minLevel, ctx, text }), countLogs()]);
    setEntries(rows);
    setTotal(count);
  }, [limit, minLevel, ctx, text]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh when any context writes a log entry.
  useEffect(() => {
    const ch = new BroadcastChannel(LOG_CHANNEL);
    ch.onmessage = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 250);
    };
    return () => {
      ch.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const selfTest = async () => {
    setBusy(true);
    try {
      const r = await callBackground('diag:selfTest');
      log.info('Test entry from the side panel');
      setNote(`Wrote ${r.written + 1} test entries (service worker + side panel).`);
    } catch (err) {
      setNote(`Test failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    const all = await exportLogs();
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const t = formatTimeIST(Date.now()).replace(/:/g, '');
    a.href = url;
    a.download = `swing-logs-${isoDateIST(Date.now())}-${t}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const doClear = async () => {
    if (!confirm('Delete all log entries?')) return;
    await clearLogs();
    log.info('Logs cleared by owner');
    await load();
  };

  return (
    <section class="card">
      <div class="row">
        <h2>Log</h2>
        <span class="muted small">
          {total} of max {MAX_LOG_ENTRIES.toLocaleString('en-IN')} entries
        </span>
      </div>
      <div class="row" style={{ marginBottom: '8px' }}>
        <button class="btn primary small" type="button" disabled={busy} onClick={() => void selfTest()}>
          Write test entries
        </button>
        <button class="btn small" type="button" onClick={() => void doExport()}>
          Export JSON
        </button>
        <button class="btn small danger" type="button" onClick={() => void doClear()}>
          Clear
        </button>
      </div>
      {note && <p class="small muted">{note}</p>}
      <div class="row" style={{ marginBottom: '8px' }}>
        <select
          aria-label="Minimum level"
          value={minLevel}
          onChange={(e) => setMinLevel((e.currentTarget as HTMLSelectElement).value as LogLevel)}
        >
          {LEVELS.map((l) => (
            <option value={l}>{l === 'debug' ? 'All levels' : `${l} and above`}</option>
          ))}
        </select>
        <select
          aria-label="Source"
          value={ctx}
          onChange={(e) => setCtx((e.currentTarget as HTMLSelectElement).value as LogContext | 'all')}
        >
          {CONTEXTS.map((c) => (
            <option value={c}>{c === 'all' ? 'All sources' : c}</option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search"
          value={text}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          style={{ flex: 1, minWidth: '100px' }}
        />
      </div>
      <div class="logs" data-testid="log-list">
        {entries.length === 0 && <div class="empty">No log entries match.</div>}
        {entries.map((e) => (
          <LogRow key={e.id} entry={e} />
        ))}
      </div>
      {entries.length >= limit && (
        <div class="row" style={{ marginTop: '8px' }}>
          <button class="btn small" type="button" onClick={() => setLimit(limit + PAGE)}>
            Show more
          </button>
        </div>
      )}
    </section>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const hasData = entry.data !== undefined;
  const today = isoDateIST(Date.now()) === isoDateIST(entry.ts);
  return (
    <div
      class={`log-row${hasData ? ' has-data' : ''}`}
      data-level={entry.level}
      onClick={() => hasData && setOpen(!open)}
      title={hasData ? 'Click to show details' : undefined}
    >
      <span class={`badge ${entry.level}`}>{entry.level}</span>
      <span class="log-time">
        {today ? '' : `${formatDateIST(entry.ts)} `}
        {formatTimeIST(entry.ts, true)}
      </span>
      <span class="log-src">
        {entry.ctx}/{entry.module}
      </span>
      <span class="log-msg">
        {entry.msg}
        {hasData && !open && <span class="muted"> ▸</span>}
      </span>
      {open && <pre class="log-data">{JSON.stringify(entry.data, null, 2)}</pre>}
    </div>
  );
}

function TestAlerts() {
  const [msg, setMsg] = useState<string | null>(null);
  const test = async (sound: 'stop' | 'target' | 'info') => {
    try {
      const r = await callBackground('diag:testAlert', { sound });
      setMsg(r.played ? 'Notification shown and sound played. If you heard nothing, check the computer volume and Windows notification settings for Chrome.' : 'Notification shown; the sound could not play (see the log).');
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };
  return (
    <section class="card">
      <h2>Test alerts</h2>
      <p class="small muted">Check that notifications and sounds reach you. Sounds can be turned off in Settings.</p>
      <div class="row">
        <button class="btn small" type="button" onClick={() => void test('stop')}>Stop-loss sound</button>
        <button class="btn small" type="button" onClick={() => void test('target')}>Target sound</button>
        <button class="btn small" type="button" onClick={() => void test('info')}>Other alert</button>
      </div>
      {msg && <p class="small">{msg}</p>}
    </section>
  );
}
