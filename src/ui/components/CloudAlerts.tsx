import { useEffect, useState } from 'preact/hooks';
import { getLocal } from '../../storage/local';
import { CATEGORY_LABEL, MARKET_CATEGORIES, type AlertCategory } from '../../notify/categories';
import { cloudActive, cloudConfirmed } from '../../notify/cloudMode';
import { isNative } from '../../platform/http';
import { formatDateTimeIST } from '../../lib/format';
import { useLocal } from '../hooks';
import { toast } from './Motion';
import { callBackground } from '../../shared/messages';
import { errorMessage } from '../../lib/serialize';

/**
 * Settings → Cloud alerts (milestone 4, optional). Pair this phone with your own TradeBuddy server, so
 * the server's alerts arrive through Firebase even when the app is closed. Without pairing the app works
 * exactly as before.
 */

const CHOICES: AlertCategory[] = [...MARKET_CATEGORIES, 'system'];
const push = () => import('../../platform/push');
const msgOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CloudAlerts() {
  const cloud = useLocal('cloud');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('My phone');
  const [busy, setBusy] = useState<null | 'pair' | 'test' | 'unpair' | 'check' | 'prefs'>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairForce, setUnpairForce] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // phones updated from an older version have no "cloud" entry at all (= not paired): wait only for loading
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void getLocal('cloud').finally(() => setLoaded(true));
  }, []);

  if (cloud === undefined && !loaded) return null;

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast(msgOf(err), 'err');
    } finally {
      setBusy(null);
    }
  };

  if (!cloud) {
    return (
      <section class="card" data-testid="cloud-alerts">
        <h2>Cloud alerts (optional)</h2>
        <p class="small muted" style={{ marginTop: 0 }}>
          If you run your own TradeBuddy server, it can send its alerts to this phone even when the app is closed or the phone was off. Without it, the app works exactly as now. Delivery
          goes through Google Firebase and is best effort — an alert can arrive late or not at all, so keep an eye on the app too.
        </p>
        {!isNative() ? (
          <p class="small muted">Pairing works in the Android app only.</p>
        ) : (
          <>
            <div class="field">
              <label for="cloud-url">Server address</label>
              <input id="cloud-url" type="url" inputMode="url" autoComplete="off" placeholder="https://tradebuddy.example.com" value={url} onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="cloud-code">One-time pairing code</label>
              <input
                id="cloud-code"
                autoComplete="off"
                autoCapitalize="characters"
                spellcheck={false}
                placeholder="XXXXX-XXXXX"
                value={code}
                onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
              />
              <span class="hint">Make a code on the server (it works once, for 10 minutes). The setup guide explains how.</span>
            </div>
            <div class="field">
              <label for="cloud-name">Name for this phone</label>
              <input id="cloud-name" maxLength={60} value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <button
              class="btn primary"
              type="button"
              data-testid="cloud-pair"
              disabled={busy !== null || !url.trim() || !code.trim()}
              onClick={() =>
                void run('pair', async () => {
                  const p = await push();
                  const state = await p.pairWithServer(url, code, name, chrome.runtime.getManifest().version);
                  setCode('');
                  toast(state.lastError ? `Paired, but: ${state.lastError}` : 'Paired. Cloud alerts are on.', state.lastError ? 'err' : 'ok');
                })
              }
            >
              {busy === 'pair' ? 'Pairing…' : 'Pair this phone'}
            </button>
          </>
        )}
      </section>
    );
  }

  const active = cloudActive(cloud);
  // review fix: "On" only while the server confirms it covers this phone; otherwise the phone alerts by itself
  const confirmed = cloudConfirmed(cloud);
  const toggle = (c: AlertCategory, on: boolean) =>
    void run('prefs', async () => {
      const next = on ? [...new Set([...cloud.categories, c])] : cloud.categories.filter((x) => x !== c);
      await (await push()).syncPreferences(next);
    });

  return (
    <section class="card" data-testid="cloud-alerts">
      <h2>Cloud alerts</h2>
      <p class="small" style={{ marginTop: 0 }}>
        {confirmed ? '✅ On' : active ? '⚠️ Paired — the server is not confirmed right now, so this phone alerts by itself' : '⏳ Waiting for Firebase'} — paired with <b>{new URL(cloud.serverUrl).host}</b> as “
        {cloud.name}” since {formatDateTimeIST(cloud.pairedAt)}.
      </p>
      {cloud.lastError && <p class="small err-text">Last problem: {cloud.lastError}</p>}
      <p class="small muted">
        The server sends the market alerts you tick below. While the server confirms it is working (checked every 3 minutes while the app runs), this phone shows those in the app only (no
        second pop-up); if the server stops, the phone's own pop-ups come back by themselves. Your practice money, price alerts, plans and the auto-trader still alert from the phone itself.
        Delivery is best effort.
      </p>
      {CHOICES.map((c) => (
        <label class="switch-row" data-cloud={c}>
          <span>
            <b>{CATEGORY_LABEL[c]}</b>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={cloud.categories.includes(c)}
            disabled={busy !== null}
            onChange={(e) => toggle(c, (e.currentTarget as HTMLInputElement).checked)}
          />
        </label>
      ))}
      <div class="row" style={{ gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <button
          class="btn small primary"
          type="button"
          data-testid="cloud-test"
          disabled={busy !== null || !active}
          onClick={() =>
            void run('test', async () => {
              await (await push()).sendTestPush();
              toast('The server is sending a test alert. Close the app — it should arrive within a minute.', 'ok');
            })
          }
        >
          Send a test push
        </button>
        <button
          class="btn small"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run('check', async () => {
              const p = await push();
              if (isNative()) await p.startPush();
              const s = await p.serverStatus();
              await p.checkServer();
              setStatus(
                `Server reached. Push ${s.pushConfigured ? (s.server?.push === false ? 'is set up but failing right now' : 'is set up') : 'is NOT set up on the server yet'}; signals ${s.server?.signals ? 'being made' : 'NOT being made (Upstox token or jobs)'}; this phone's token: ${s.device.tokenState}; sent ${s.device.push.sent}, waiting ${s.device.push.pending}, failed ${s.device.push.failed}.`,
              );
            })
          }
        >
          Check connection
        </button>
        {!confirmUnpair ? (
          <button class="btn small" type="button" data-testid="cloud-unpair" disabled={busy !== null} onClick={() => setConfirmUnpair(true)}>
            Unpair
          </button>
        ) : (
          <>
            <button
              class="btn small danger"
              type="button"
              data-testid="cloud-unpair-yes"
              disabled={busy !== null}
              onClick={() =>
                void run('unpair', async () => {
                  // app v1.22: an auto-trader running on the server comes back to this phone first (never left without a phone)
                  try {
                    await callBackground('cloudbot:before-unpair', { force: unpairForce });
                  } catch (e) {
                    setUnpairForce(true);
                    throw new Error(`${errorMessage(e)} Tap "Yes, unpair" again to unpair anyway: this phone then takes back the last copy it saw, paused.`);
                  }
                  await (await push()).unpair();
                  setConfirmUnpair(false);
                  setUnpairForce(false);
                  setStatus(null);
                  toast('Unpaired. This phone alerts on its own again.', 'ok');
                })
              }
            >
              Yes, unpair
            </button>
            <button class="btn small" type="button" onClick={() => setConfirmUnpair(false)}>
              Keep
            </button>
          </>
        )}
      </div>
      {status && <p class="small muted">{status}</p>}
    </section>
  );
}
