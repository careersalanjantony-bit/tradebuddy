import { useEffect, useState } from 'preact/hooks';
import { formatDateIST, formatDateTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { formatDuration } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { updateSecrets, updateSettings } from '../../storage/local';
import type { LogLevel, ThemePref } from '../../storage/schema';
import { hasLiveSession } from '../../upstox/token';
import { CopyBox } from '../components/CopyBox';
import { useLocal, useNow, useSettings } from '../hooks';
import { loginWithUpstox } from '../login';
import { RiskSettings } from './RiskSettings';
import { AmountCard } from './AmountCard';
import { AlertSettings } from '../components/AlertSettings';

const DEV_APPS_URL = 'https://account.upstox.com/developer/apps';

/**
 * Settings (spec §15.1). M1: Upstox connection (redirect URL, keys, login, optional Analytics Token,
 * holiday list), appearance, logging. Each milestone adds its own section.
 */
export function SettingsScreen() {
  const settings = useSettings();
  if (!settings) return <p class="muted">Loading…</p>;

  const simple = settings.ui.mode === 'simple';
  return (
    <>
      <AmountCard risk={settings.risk} newPickAlerts={settings.scanner.newPickAlerts} rankBy={settings.scanner.rankBy} />
      <AlertSettings settings={settings} />
      {simple ? (
        <details class="card">
          <summary>
            <b>Advanced settings</b> <span class="muted small">(optional — the defaults are already safe for beginners)</span>
          </summary>
          <RiskSettings risk={settings.risk} />
        </details>
      ) : (
        <RiskSettings risk={settings.risk} />
      )}
      <section class="card">
        <h2>Screens</h2>
        <label class="row small">
          <input
            type="checkbox"
            checked={!simple}
            onChange={(e) => void updateSettings({ ui: { mode: (e.currentTarget as HTMLInputElement).checked ? 'advanced' : 'simple' } })}
          />
          Show expert screens (Shortlist, Stock, Planner) and every number
        </label>
      </section>
      <UpstoxSettings />
      <AnalyticsTokenSettings />

      <section class="card">
        <h2>Alerts</h2>
        <label class="row small">
          <input
            type="checkbox"
            checked={settings.notifications.sounds}
            onChange={(e) => void updateSettings({ notifications: { sounds: (e.currentTarget as HTMLInputElement).checked } })}
          />
          Play a sound with alerts (falling beeps = stop-loss, rising chime = target). Test them in Diagnostics.
        </label>
      </section>

      {/* review fix (1.20.2): the switch was only on the Breakouts card, which is off since app 1.14 */}
      <section class="card" data-testid="settings-data">
        <h2>Mobile data</h2>
        <label class="switch-row">
          <span>
            <b>Save mobile data</b>
            <span class="tiny muted">
              {settings.data.saveData
                ? 'On: the Intraday list checks the Nifty 500 stocks every 30 seconds, and live prices come without volume details (volume is checked about every 10 seconds).'
                : 'Off: the Intraday list checks every NSE stock every 15 seconds with full live details — this uses a lot of data; Wi-Fi is best. Turn on if your data pack is small.'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            data-field="save-data"
            checked={!!settings.data.saveData}
            onChange={(e) => void updateSettings({ data: { saveData: (e.currentTarget as HTMLInputElement).checked } })}
          />
        </label>
      </section>

      <section class="card">
        <h2>Appearance</h2>
        <div class="field">
          <label for="theme">Theme</label>
          <select
            id="theme"
            value={settings.ui.theme}
            onChange={(e) => void updateSettings({ ui: { theme: (e.currentTarget as HTMLSelectElement).value as ThemePref } })}
          >
            <option value="system">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>

      <section class="card">
        <h2>Logging</h2>
        <div class="field">
          <label for="loglevel">Detail level</label>
          <select
            id="loglevel"
            value={settings.logging.level}
            onChange={(e) => void updateSettings({ logging: { level: (e.currentTarget as HTMLSelectElement).value as LogLevel } })}
          >
            <option value="info">Normal (info, warnings, errors)</option>
            <option value="debug">Detailed (adds debug entries)</option>
          </select>
          <span class="hint">Warnings and errors are always kept. Secrets are removed from every log entry.</span>
        </div>
      </section>

      <section class="card">
        <h2>Coming next</h2>
        <p class="muted small">
          Indicator thresholds, scanner schedule, Claude (M7), Telegram (M8), sounds and quiet hours (M5), data export/backup (M8).
        </p>
      </section>
    </>
  );
}

function UpstoxSettings() {
  const secrets = useLocal('secrets');
  const auth = useLocal('auth');
  const now = useNow(15_000);
  const [redirectUrl, setRedirectUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'login' | 'logout' | 'test'>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => setRedirectUrl(chrome.identity.getRedirectURL('upstox')), []);
  // Prefill the API key (it is the app's public client id); never prefill the secret.
  useEffect(() => {
    if (secrets?.upstoxApiKey && !apiKey) setApiKey(secrets.upstoxApiKey);
  }, [secrets?.upstoxApiKey]);

  const keysSaved = !!secrets?.upstoxApiKey && !!secrets?.upstoxApiSecret;
  const live = hasLiveSession(auth, now);

  const saveKeys = async () => {
    const key = apiKey.trim();
    const secret = apiSecret.trim();
    if (!key) return setSaveMsg('Enter the API key.');
    if (!secret && !secrets?.upstoxApiSecret) return setSaveMsg('Enter the API secret.');
    await updateSecrets({ upstoxApiKey: key, ...(secret ? { upstoxApiSecret: secret } : {}) });
    setApiSecret('');
    setShowSecret(false);
    setSaveMsg('Saved on this computer.');
  };

  const run = async (kind: 'login' | 'logout' | 'test') => {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === 'login') {
        const r = await loginWithUpstox();
        setMsg(r.ok ? { tone: 'ok', text: `Logged in${r.userName ? ` as ${r.userName}` : ''}.` } : { tone: 'err', text: r.message });
      } else if (kind === 'logout') {
        await callBackground('auth:logout');
        setMsg({ tone: 'ok', text: 'Logged out.' });
      } else {
        const p = await callBackground('auth:test');
        setMsg({ tone: 'ok', text: `Connection OK${p.userName ? ` — ${p.userName}` : ''}${p.userId ? ` (${p.userId})` : ''}.` });
      }
    } catch (err) {
      setMsg({ tone: 'err', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="card">
      <h2>Upstox</h2>

      <div class="step">
        <h3>Step 1 · Redirect URL</h3>
        <CopyBox value={redirectUrl} />
        <p class="hint small muted">
          In{' '}
          <a href={DEV_APPS_URL} target="_blank" rel="noreferrer">
            Upstox Developer Apps
          </a>
          , create an app and paste this exact URL as its redirect URL. It never changes.
        </p>
      </div>

      <div class="step">
        <h3>Step 2 · API key and secret</h3>
        <div class="field">
          <label for="upx-key">API key</label>
          <input id="upx-key" type="text" autocomplete="off" spellcheck={false} value={apiKey} onInput={(e) => setApiKey((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="upx-secret">API secret</label>
          <div class="inline-input">
            <input
              id="upx-secret"
              type={showSecret ? 'text' : 'password'}
              autocomplete="off"
              spellcheck={false}
              placeholder={secrets?.upstoxApiSecret ? 'saved — type only to replace it' : ''}
              value={apiSecret}
              onInput={(e) => setApiSecret((e.currentTarget as HTMLInputElement).value)}
            />
            <button class="btn small" type="button" onClick={() => setShowSecret(!showSecret)}>
              {showSecret ? 'Hide' : 'Show'}
            </button>
          </div>
          <span class="hint">Stored only in this Chrome profile on this computer. Never paste it anywhere else.</span>
        </div>
        <div class="row">
          <button class="btn primary small" type="button" onClick={() => void saveKeys()}>
            Save keys
          </button>
          {keysSaved && !saveMsg && <span class="small ok-text">✓ Keys saved</span>}
          {saveMsg && <span class="small">{saveMsg}</span>}
        </div>
      </div>

      <div class="step">
        <h3>Step 3 · Log in (once each trading day)</h3>
        <p class="small" data-testid="login-status">
          {live && auth?.expiresAt ? (
            <span class="ok-text">
              ✓ Logged in{auth.userName ? ` as ${auth.userName}` : ''}. Ends {formatDateTimeIST(auth.expiresAt)} (in {formatDuration(auth.expiresAt - now)}).
            </span>
          ) : auth?.status === 'expired' || auth?.status === 'logged_in' ? (
            <span class="err-text">Session ended{auth.lastError ? ` (${auth.lastError})` : ''}. Log in again.</span>
          ) : (
            <span class="muted">Not logged in.</span>
          )}
        </p>
        <div class="row">
          {!live && (
            <button class="btn primary small" type="button" disabled={!keysSaved || busy !== null} onClick={() => void run('login')}>
              {busy === 'login' ? 'Waiting for Upstox login…' : 'Log in to Upstox'}
            </button>
          )}
          {live && (
            <>
              <button class="btn small" type="button" disabled={busy !== null} onClick={() => void run('test')}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
              <button class="btn small danger" type="button" disabled={busy !== null} onClick={() => void run('logout')}>
                Log out
              </button>
            </>
          )}
        </div>
        {!keysSaved && <p class="hint small muted">Save your API key and secret first.</p>}
        {msg && <p class={`small ${msg.tone === 'ok' ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
        <p class="hint small muted">
          A window from Upstox opens. Type your mobile/ID, OTP and PIN there — the extension never sees them. The login lasts until 03:30
          at night; a reminder appears at 08:45 on trading days.
        </p>
      </div>

      <HolidayStatus />
    </section>
  );
}

function HolidayStatus() {
  const cal = useLocal('marketCalendar');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await callBackground('calendar:refresh');
      setMsg(`Updated: ${r.holidays} entries for ${r.year}.`);
    } catch (err) {
      setMsg(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="step">
      <h3>Market holidays</h3>
      <p class="small">
        {cal ? (
          <>
            {cal.year} list loaded ({cal.holidays.length} entries), updated {formatDateIST(cal.fetchedAt)}. Refreshes every Monday.
          </>
        ) : (
          <span class="muted">Not loaded yet. It loads automatically after you log in (or with an Analytics Token).</span>
        )}
      </p>
      <div class="row">
        <button class="btn small" type="button" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Refreshing…' : 'Refresh now'}
        </button>
        {msg && <span class="small">{msg}</span>}
      </div>
    </div>
  );
}

function AnalyticsTokenSettings() {
  const secrets = useLocal('secrets');
  const auth = useLocal('auth');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const saved = !!secrets?.upstoxAnalyticsToken;
  const state = auth?.analytics;

  const saveAndTest = async () => {
    const t = token.trim();
    if (!t && !saved) return setMsg({ tone: 'err', text: 'Paste the token first.' });
    setBusy(true);
    setMsg(null);
    try {
      // The service worker saves a new token only after Upstox accepted it.
      const r = await callBackground('analytics:test', t ? { token: t } : {});
      setToken('');
      setMsg({ tone: 'ok', text: `Token works. Holiday list loaded (${r.holidays} entries for ${r.year}).` });
    } catch (err) {
      setMsg({ tone: 'err', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Remove the saved Analytics Token from this computer?')) return;
    await updateSecrets({ upstoxAnalyticsToken: null });
    setMsg({ tone: 'ok', text: 'Removed.' });
  };

  return (
    <section class="card">
      <h2>Upstox Analytics Token (optional, recommended)</h2>
      <p class="small">
        A <b>read-only</b> token from Upstox that lasts <b>1 year</b>. With it, prices, charts, scans and the live feed keep working even
        when you have not logged in that day. It cannot place orders. Your holdings and positions still need the daily login.
      </p>
      <p class="small muted">
        Get it from{' '}
        <a href={`${DEV_APPS_URL}#analytics`} target="_blank" rel="noreferrer">
          Upstox Developer Apps → Analytics tab
        </a>{' '}
        → Generate Token → copy.
      </p>
      <div class="field">
        <label for="upx-analytics">Analytics Token</label>
        <input
          id="upx-analytics"
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder={saved ? 'saved — paste only to replace it' : 'paste token here'}
          value={token}
          onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="row">
        <button class="btn primary small" type="button" disabled={busy} onClick={() => void saveAndTest()}>
          {busy ? 'Testing…' : saved && !token ? 'Test saved token' : 'Save and test'}
        </button>
        {saved && (
          <button class="btn small danger" type="button" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
        {saved && state?.status === 'valid' && !msg && <span class="small ok-text">✓ Working</span>}
        {saved && state?.status === 'invalid' && !msg && <span class="small err-text">Not accepted by Upstox — generate a new one</span>}
      </div>
      {msg && <p class={`small ${msg.tone === 'ok' ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
    </section>
  );
}
