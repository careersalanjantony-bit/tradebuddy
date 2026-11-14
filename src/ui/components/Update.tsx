import { useEffect, useState } from 'preact/hooks';
import { formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { cleanupDownloaded, continueInstall, getUpdateStep, openInstallSettings, resetUpdateStep, startUpdate, subscribeUpdateStep, type UpdateStep } from '../../platform/updater';
import { callBackground } from '../../shared/messages';
import { availableUpdate, mb, type UpdateInfo } from '../../update/update';
import { useLocal } from '../hooks';
import { Icon } from './Icon';
import { toast } from './Motion';

declare const __APP_VERSION__: string;

/** In-app updates (app v1.5): a banner on Home and a card on the Me tab. */

function useUpdateStep(): UpdateStep {
  const [s, setS] = useState(getUpdateStep());
  useEffect(() => subscribeUpdateStep(() => setS(getUpdateStep())), []);
  return s;
}

let cleaned = false;
function useOffer(): UpdateInfo | null | undefined {
  const st = useLocal('appUpdate');
  const offer = st === undefined ? undefined : availableUpdate(st, __APP_VERSION__);
  useEffect(() => {
    if (st === undefined || cleaned) return;
    cleaned = true;
    void cleanupDownloaded(offer?.version ?? null);
  }, [st === undefined]);
  return offer;
}

/** The steps after "Update now", the same on Home and on the Me tab. */
function UpdateSteps({ offer }: { offer: UpdateInfo }) {
  const s = useUpdateStep();
  if (s.step === 'downloading') {
    return (
      <div class="update-progress" data-testid="update-progress">
        <div class="small">Downloading {offer.version}… {Math.round(s.pct * 100)}%</div>
        <div class="bar">
          <span style={{ width: `${Math.max(3, s.pct * 100)}%` }} />
        </div>
      </div>
    );
  }
  if (s.step === 'allow') {
    return (
      <div class="banner info small" data-testid="update-allow">
        <b>One-time step.</b> Android needs your OK to let TradeBuddy install its own updates.
        <ol class="how-steps">
          <li>
            Tap <b>Open the setting</b>.
          </li>
          <li>
            Turn on <b>Allow from this source</b>.
          </li>
          <li>Come back to TradeBuddy — the update carries on by itself.</li>
        </ol>
        <div class="row" style={{ gap: '8px' }}>
          <button class="btn small primary" type="button" onClick={() => void openInstallSettings().catch((e: unknown) => toast(errorMessage(e), 'err'))}>
            Open the setting
          </button>
          <button class="btn small" type="button" onClick={() => void continueInstall(offer.version)}>
            I turned it on
          </button>
        </div>
      </div>
    );
  }
  if (s.step === 'installing') {
    return (
      <p class="small" data-testid="update-installing">
        Android is asking <b>"Do you want to update this app?"</b> — tap <b>Update</b>. TradeBuddy closes and opens again with your data kept.
      </p>
    );
  }
  if (s.step === 'error') {
    return (
      <div class="banner err small" data-testid="update-error">
        {s.message}{' '}
        <button class="link-btn small" type="button" onClick={resetUpdateStep}>
          OK
        </button>
      </div>
    );
  }
  return (
    <button class="btn primary grow" type="button" data-testid="update-now" onClick={() => void startUpdate(offer)}>
      Update now · {mb(offer.size)}
    </button>
  );
}

/** Home: shown only when a newer version is ready. */
export function UpdateBanner() {
  const offer = useOffer();
  const [open, setOpen] = useState(false);
  if (!offer) return null;
  return (
    <section class="card update-card" data-testid="update-banner">
      <div class="row">
        <span class="update-icon" aria-hidden="true">
          <Icon name="spark" size={20} />
        </span>
        <div class="grow">
          <b>New version {offer.version} is ready</b>
          <div class="tiny muted">Your practice money, settings and login stay as they are.</div>
        </div>
      </div>
      {offer.notes.length > 0 && (
        <>
          <ul class="small update-notes">{(open ? offer.notes : offer.notes.slice(0, 2)).map((n) => <li>{n}</li>)}</ul>
          {offer.notes.length > 2 && (
            <button class="link-btn small" type="button" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : `What else is new (${offer.notes.length - 2} more)`}
            </button>
          )}
        </>
      )}
      <div class="row" style={{ marginTop: '10px' }}>
        <UpdateSteps offer={offer} />
      </div>
    </section>
  );
}

/** Me tab: version, "Check now", and the same update steps. */
export function UpdateCard() {
  const st = useLocal('appUpdate');
  const offer = useOffer();
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    void callBackground('update:check')
      .then((r) => {
        const o = availableUpdate(r, __APP_VERSION__);
        toast(r.error ? 'Could not check — see the card' : o ? `Version ${o.version} is ready` : 'You have the newest version');
      })
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  return (
    <section class="card" data-testid="account-update">
      <h2>App updates</h2>
      <p class="small" style={{ margin: '0 0 6px' }}>
        You have version <b data-testid="app-version">{__APP_VERSION__}</b>.{' '}
        {offer ? (
          <span class="ok-text">
            Version <b>{offer.version}</b> is ready.
          </span>
        ) : st?.latest ? (
          'This is the newest version.'
        ) : null}
      </p>
      {offer && (
        <>
          {offer.notes.length > 0 && <ul class="small update-notes">{offer.notes.map((n) => <li>{n}</li>)}</ul>}
          <div class="row" style={{ marginBottom: '8px' }}>
            <UpdateSteps offer={offer} />
          </div>
        </>
      )}
      {st?.error && <p class="tiny err-text">{st.error}</p>}
      <div class="row" style={{ gap: '8px', alignItems: 'center' }}>
        <button class={`btn small ${busy ? 'busy' : ''}`} type="button" data-testid="update-check" disabled={busy} onClick={check}>
          <Icon name="refresh" size={16} /> Check now
        </button>
        <span class="tiny muted">{st?.checkedAt ? `Checked ${formatTimeIST(st.checkedAt).slice(0, 5)}. ` : ''}Checks by itself every 6 hours.</span>
      </div>
    </section>
  );
}
