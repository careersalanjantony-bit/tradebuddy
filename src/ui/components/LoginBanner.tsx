import { useState } from 'preact/hooks';
import { hasLiveSession } from '../../upstox/token';
import { useLocal, useNow } from '../hooks';
import { loginWithUpstox } from '../login';

/** Shown on every screen while there is no live Upstox session (spec §7.1: persistent "Log in" banner). */
export function LoginBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const auth = useLocal('auth');
  const secrets = useLocal('secrets');
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (auth === undefined || hasLiveSession(auth, now)) return null;
  const keysSaved = !!secrets?.upstoxApiKey && !!secrets?.upstoxApiSecret;
  const expired = auth.status === 'expired' || auth.status === 'logged_in';
  const dataViaAnalytics = auth.analytics?.status === 'valid';

  const login = async () => {
    setBusy(true);
    setMessage(null);
    const r = await loginWithUpstox();
    setBusy(false);
    if (!r.ok) setMessage(r.message);
  };

  return (
    <div class={`banner ${expired ? 'err' : 'warn'} login-banner`} role="alert">
      {!keysSaved ? (
        <>
          <b>Upstox is not connected yet.</b> Add your Upstox API key and secret in Settings.
          <div class="row" style={{ marginTop: '6px' }}>
            <button class="btn primary small" type="button" onClick={onOpenSettings}>
              Open Settings
            </button>
          </div>
        </>
      ) : (
        <>
          <b>{expired ? 'Upstox session ended.' : 'Not logged in to Upstox.'}</b>{' '}
          {expired ? 'The login lasts until 03:30 each night. Please log in again.' : 'Log in once each trading day.'}
          {dataViaAnalytics && <span class="muted"> Prices and charts still work with your Analytics Token.</span>}
          <div class="row" style={{ marginTop: '6px' }}>
            <button class="btn primary small" type="button" disabled={busy} onClick={() => void login()}>
              {busy ? 'Waiting for Upstox login…' : 'Log in to Upstox'}
            </button>
          </div>
        </>
      )}
      {message && <p class="small" style={{ marginBottom: 0 }}>{message}</p>}
    </div>
  );
}
