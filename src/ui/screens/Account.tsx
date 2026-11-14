import { useEffect, useState } from 'preact/hooks';
import { AVATAR_COLORS, checkPin, hashPin, makeBackup, readBackup, type AccountState } from '../../account/account';
import { formatINR, formatPct } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { biometricAvailable } from '../../platform/biometric';
import { callBackground } from '../../shared/messages';
import { setLocal, updateSettings } from '../../storage/local';
import { newWallet, walletSummary } from '../../wallet/wallet';
import type { Go } from '../App';
import { AlertSettings } from '../components/AlertSettings';
import { Avatar, PinPad, wipeAll } from '../components/Lock';
import { AnimatedNumber, toast } from '../components/Motion';
import { useQuotes } from '../data';
import { useLocal, useNow, useSettings } from '../hooks';
import { MoreScreen } from './More';
import { UpdateCard } from '../components/Update';

declare const __APP_VERSION__: string;
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;

/** My account (app v1.3): profile, practice record, Upstox connection, security, look, alerts, data. */
export function AccountScreen({ go, unread }: { go: Go; unread: number }) {
  const account = useLocal('account');
  const settings = useSettings();
  const wallet = useLocal('wallet');
  const secrets = useLocal('secrets');
  const auth = useLocal('auth');
  const quotes = useQuotes();
  const now = useNow(10_000);
  const [editing, setEditing] = useState(false);
  const [pinFlow, setPinFlow] = useState<null | 'set' | 'change' | 'remove'>(null);
  const [bioOk, setBioOk] = useState(false);
  const [restore, setRestore] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'reset' | 'wipe'>(null);
  useEffect(() => void biometricAvailable().then(setBioOk), []);
  if (!settings) return null;

  const a: AccountState = account ?? { v: 1, name: 'Trader', color: AVATAR_COLORS[0]!, createdAt: now, pin: null, biometric: false, lockAfterMin: 1 };
  const s = walletSummary(wallet ?? newWallet(now), quotes, istDate(now));
  const sells = (wallet?.fills ?? []).filter((f) => f.side === 'sell' && f.pnl !== undefined);
  const best = sells.reduce((m, f) => Math.max(m, f.pnl!), -Infinity);
  const worst = sells.reduce((m, f) => Math.min(m, f.pnl!), Infinity);
  const save = (patch: Partial<AccountState>) => setLocal('account', { ...a, ...patch });
  const tokenOk = !!secrets?.upstoxAnalyticsToken && auth?.analytics?.status !== 'invalid';
  const loggedIn = auth?.status === 'logged_in' && !!auth.expiresAt && auth.expiresAt > now;

  const copyBackup = async () => {
    const keys = ['settings', 'watchlist', 'wallet', 'plans', 'alerts', 'dayTrades', 'mlJournal', 'account'];
    const data = await chrome.storage.local.get(keys);
    try {
      await navigator.clipboard.writeText(makeBackup(data, Date.now(), __APP_VERSION__));
      toast('Backup copied — paste it into a note or a chat to yourself');
    } catch {
      toast('Could not copy — allow clipboard access', 'err');
    }
  };
  const doRestore = async () => {
    try {
      const data = readBackup(restore ?? '');
      await chrome.storage.local.set(data);
      toast('Backup restored');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(errorMessage(err), 'err');
    }
  };

  return (
    <div class="screen account" data-testid="account">
      <section class="profile-card" data-tilt>
        <span class="glare" aria-hidden="true" />
        <Avatar name={a.name} color={a.color} size={68} />
        <div class="profile-text">
          {editing ? (
            <>
              <input class="name-input small-input" value={a.name} maxLength={40} data-field="account-name" onInput={(e) => void save({ name: (e.currentTarget as HTMLInputElement).value || 'Trader' })} />
              <div class="colors">
                {AVATAR_COLORS.map((c) => (
                  <button type="button" class={`swatch ${c === a.color ? 'on' : ''}`} style={{ background: c }} aria-label="Choose colour" onClick={() => void save({ color: c })} />
                ))}
              </div>
            </>
          ) : (
            <>
              <h1>{a.name}</h1>
              <span class="small">Member since {new Date(a.createdAt).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} · on this phone only</span>
            </>
          )}
        </div>
        <button class="icon-btn light" type="button" aria-label="Edit profile" data-testid="edit-profile" onClick={() => setEditing(!editing)}>
          {editing ? '✓' : '✎'}
        </button>
      </section>

      <section class="card" data-testid="account-stats">
        <h2>Your practice record</h2>
        <div class="stat-grid">
          <div>
            <span>Practice money</span>
            <b>
              <AnimatedNumber value={s.total} format={(v) => formatINR(v, 0)} />
            </b>
          </div>
          <div>
            <span>Overall</span>
            <b class={s.totalPnl >= 0 ? 'ok-text' : 'err-text'}>
              {signed(s.totalPnl)} <small>({formatPct(s.totalPct, 1)})</small>
            </b>
          </div>
          <div>
            <span>Trades closed</span>
            <b>{s.trades}</b>
          </div>
          <div>
            <span>With a profit</span>
            <b>{s.trades ? `${Math.round((s.wins / s.trades) * 100)}%` : '—'}</b>
          </div>
          <div>
            <span>Best trade</span>
            <b class="ok-text">{sells.length ? signed(best) : '—'}</b>
          </div>
          <div>
            <span>Worst trade</span>
            <b class="err-text">{sells.length ? signed(worst) : '—'}</b>
          </div>
        </div>
        <button class="link-btn small" type="button" onClick={() => go('practice')}>
          Open Practice
        </button>
      </section>

      <section class="card" data-testid="account-upstox">
        <h2>Upstox connection</h2>
        <div class="status-row">
          <span class={`dot ${tokenOk ? 'ok' : 'warn'}`} /> Live prices (Analytics Token): <b>{tokenOk ? 'connected' : secrets?.upstoxAnalyticsToken ? 'not accepted' : 'not set'}</b>
        </div>
        <div class="status-row">
          <span class={`dot ${loggedIn ? 'ok' : 'idle'}`} /> Daily login (find your real trades): <b>{loggedIn ? 'logged in today' : 'not logged in'}</b>
        </div>
        <button class="btn small" type="button" onClick={() => go('settings')}>
          Manage connection
        </button>
        <p class="tiny muted">TradeBuddy only reads from Upstox. It never places an order.</p>
      </section>

      <section class="card" data-testid="account-security">
        <h2>Security</h2>
        <label class="switch-row">
          <span>
            <b>App lock (PIN)</b>
            <span class="small muted">Asked when TradeBuddy opens. The PIN is never stored, only a scrambled check.</span>
          </span>
          <input type="checkbox" role="switch" class="switch" data-testid="lock-toggle" checked={!!a.pin} onChange={() => setPinFlow(a.pin ? 'remove' : 'set')} />
        </label>
        {a.pin && (
          <>
            {bioOk && (
              <label class="switch-row">
                <span>
                  <b>Unlock with fingerprint</b>
                  <span class="small muted">The PIN still works.</span>
                </span>
                <input type="checkbox" role="switch" class="switch" checked={a.biometric} onChange={(e) => void save({ biometric: (e.currentTarget as HTMLInputElement).checked })} />
              </label>
            )}
            <div class="switch-row">
              <span>
                <b>Lock again after</b>
              </span>
              <select value={String(a.lockAfterMin)} data-field="lock-after" onChange={(e) => void save({ lockAfterMin: Number((e.currentTarget as HTMLSelectElement).value) })}>
                <option value="0">at once</option>
                <option value="1">1 minute away</option>
                <option value="5">5 minutes away</option>
                <option value="-1">never</option>
              </select>
            </div>
            <div class="row" style={{ gap: '8px', marginTop: '6px' }}>
              <button class="btn small" type="button" onClick={() => setPinFlow('change')}>
                Change PIN
              </button>
              <button class="btn small" type="button" data-testid="lock-now" onClick={() => window.dispatchEvent(new Event('tb-lock'))}>
                Lock now
              </button>
            </div>
          </>
        )}
        {pinFlow && <PinFlow mode={pinFlow} account={a} onClose={() => setPinFlow(null)} />}
      </section>

      <section class="card" data-testid="account-look">
        <h2>Look</h2>
        <div class="seg" role="tablist">
          {(['dark', 'light', 'system'] as const).map((t) => (
            <button type="button" class={settings.ui.theme === t ? 'on theme' : ''} data-theme-choice={t} onClick={() => void updateSettings({ ui: { theme: t } })}>
              {t === 'dark' ? '🌙 Dark' : t === 'light' ? '☀️ Light' : '📱 Phone'}
            </button>
          ))}
        </div>
      </section>

      <AlertSettings settings={settings} />

      <MoreScreen go={go} unread={unread} simple={settings.ui.mode === 'simple'} />

      <UpdateCard />

      <section class="card" data-testid="account-data">
        <h2>Your data</h2>
        <p class="small muted">Everything stays on this phone. Uninstalling the app deletes it.</p>
        <div class="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
          <button class="btn small" type="button" onClick={() => void copyBackup()}>
            Copy backup
          </button>
          <button class="btn small" type="button" onClick={() => setRestore(restore === null ? '' : null)}>
            Restore a backup
          </button>
          <button class="btn small" type="button" onClick={() => setConfirm('reset')}>
            Reset practice money
          </button>
          <button class="btn small danger" type="button" onClick={() => setConfirm('wipe')}>
            Delete all data
          </button>
        </div>
        {restore !== null && (
          <div style={{ marginTop: '10px' }}>
            <textarea class="restore-box" rows={4} placeholder="Paste the backup text here" value={restore} onInput={(e) => setRestore((e.currentTarget as HTMLTextAreaElement).value)} />
            <button class="btn small primary" type="button" disabled={!restore.trim()} onClick={() => void doRestore()}>
              Restore
            </button>
          </div>
        )}
        {confirm && (
          <div class="confirm-box small">
            {confirm === 'reset' ? 'Start again with ₹10,00,000? Practice shares and history are deleted.' : 'Delete everything on this phone: profile, practice, settings, Upstox keys?'}
            <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
              <button
                class="btn small danger"
                type="button"
                onClick={() => {
                  if (confirm === 'reset') void callBackground('wallet:reset', {}).then(() => toast('Practice money reset'));
                  else void wipeAll();
                  setConfirm(null);
                }}
              >
                Yes
              </button>
              <button class="btn small" type="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <p class="tiny muted">The backup has your practice trades and settings — never your Upstox keys or tokens.</p>
      </section>

      <p class="tiny muted center">TradeBuddy {__APP_VERSION__} · not investment advice · you place every real order yourself</p>
    </div>
  );
}

/** Set / change / remove the PIN in a small panel. */
function PinFlow({ mode, account, onClose }: { mode: 'set' | 'change' | 'remove'; account: AccountState; onClose: () => void }) {
  const [step, setStep] = useState<'current' | 'new' | 'confirm'>(mode === 'set' ? 'new' : 'current');
  const [first, setFirst] = useState('');
  const [error, setError] = useState(false);
  const title = step === 'current' ? 'Enter your current PIN' : step === 'new' ? 'Choose a new 4-digit PIN' : 'Type the new PIN again';
  const fail = () => {
    setError(true);
    setTimeout(() => setError(false), 450);
  };
  const done = async (pin: string) => {
    if (step === 'current') {
      if (!account.pin || !(await checkPin(pin, account.pin))) return fail();
      if (mode === 'remove') {
        await setLocal('account', { ...account, pin: null, biometric: false });
        toast('App lock turned off');
        return onClose();
      }
      return setStep('new');
    }
    if (step === 'new') {
      setFirst(pin);
      return setStep('confirm');
    }
    if (pin !== first) {
      fail();
      return setStep('new');
    }
    await setLocal('account', { ...account, pin: await hashPin(pin) });
    toast(mode === 'set' ? 'App lock is on' : 'PIN changed');
    onClose();
  };
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section class="sheet center" data-testid="pin-flow">
        <h2>{title}</h2>
        <PinPad onDone={(p) => void done(p)} error={error} />
        <button class="link-btn small" type="button" onClick={onClose}>
          Cancel
        </button>
      </section>
    </div>
  );
}
