import { useEffect, useState } from 'preact/hooks';
import { AVATAR_COLORS, checkPin, hashPin, initials, newAccount, PIN_LENGTH, waitAfterFails, type AccountState } from '../../account/account';
import { biometricAvailable, biometricUnlock } from '../../platform/biometric';
import { setLocal } from '../../storage/local';
import { buzz } from './Motion';

/** Round avatar with initials. */
export function Avatar({ name, color, size = 72 }: { name: string; color: string; size?: number }) {
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${size * 0.38}px`, background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #3ba3ff))` }}>
      {initials(name)}
    </span>
  );
}

/** PIN entry: dots that fill, a number pad, a shake on a wrong PIN. */
export function PinPad({ onDone, disabled = false, error = false, extra }: { onDone: (pin: string) => void; disabled?: boolean; error?: boolean; extra?: preact.ComponentChildren }) {
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (error) setPin('');
  }, [error]);
  const press = (d: string) => {
    if (disabled) return;
    void buzz('light');
    const next = (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) setTimeout(() => (onDone(next), setPin('')), 120);
  };
  return (
    <div class="pinpad">
      <div class={`pin-dots ${error ? 'shake' : ''}`} data-testid="pin-dots">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span class={i < pin.length ? 'on' : ''} />
        ))}
      </div>
      <div class="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button type="button" class="key" data-key={d} onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <span class="key-slot">{extra}</span>
        <button type="button" class="key" data-key="0" onClick={() => press('0')}>
          0
        </button>
        <button type="button" class="key ghost" aria-label="Delete" onClick={() => setPin(pin.slice(0, -1))}>
          ⌫
        </button>
      </div>
    </div>
  );
}

/** The lock screen shown when the app opens (or comes back after the chosen time). */
export function LockScreen({ account, onUnlock }: { account: AccountState; onUnlock: () => void }) {
  const [error, setError] = useState(false);
  const [fails, setFails] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [bio, setBio] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const tryBio = async () => {
    if (await biometricUnlock(account.name)) {
      void buzz('success');
      onUnlock();
    }
  };
  useEffect(() => {
    if (!account.biometric) return;
    void biometricAvailable().then((ok) => {
      setBio(ok);
      if (ok) void tryBio();
    });
  }, []);
  const waiting = waitUntil > now;
  const enter = async (pin: string) => {
    if (!account.pin || waiting) return;
    if (await checkPin(pin, account.pin)) {
      void buzz('success');
      onUnlock();
      return;
    }
    void buzz('medium');
    const f = fails + 1;
    setFails(f);
    setError(true);
    setTimeout(() => setError(false), 450);
    const w = waitAfterFails(f);
    if (w) setWaitUntil(Date.now() + w);
  };
  return (
    <div class="lock-screen" data-testid="lock-screen">
      <div class="lock-glow" aria-hidden="true" />
      <Avatar name={account.name} color={account.color} size={84} />
      <h2>Welcome back, {account.name.split(' ')[0]}</h2>
      <p class="small muted">{waiting ? `Too many wrong tries — wait ${Math.ceil((waitUntil - now) / 1000)} s` : 'Enter your PIN'}</p>
      <PinPad
        onDone={(p) => void enter(p)}
        disabled={waiting}
        error={error}
        extra={
          bio ? (
            <button type="button" class="key ghost" aria-label="Use fingerprint" data-testid="bio-btn" onClick={() => void tryBio()}>
              ☝
            </button>
          ) : null
        }
      />
      {!forgot ? (
        <button class="link-btn small" type="button" onClick={() => setForgot(true)}>
          Forgot PIN?
        </button>
      ) : (
        <div class="forgot small">
          The PIN cannot be shown or recovered — it is never stored. To start again, delete all app data: practice money, settings and keys on this phone are removed.
          <div class="row" style={{ gap: '8px', marginTop: '8px', justifyContent: 'center' }}>
            <button class="btn small danger" type="button" onClick={() => void wipeAll()}>
              Delete all data
            </button>
            <button class="btn small" type="button" onClick={() => setForgot(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Removes everything the app stored on this phone, then restarts it. */
export async function wipeAll(): Promise<void> {
  await chrome.storage.local.clear();
  for (const name of ['swing-assistant', 'tradebuddy-kv']) {
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
  location.reload();
}

/** First start, after the guide: name, colour, optional PIN and fingerprint. */
export function ProfileSetup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'name' | 'pin' | 'confirm'>('name');
  const [name, setName] = useState('');
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [first, setFirst] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bioOk, setBioOk] = useState(false);
  const [useBio, setUseBio] = useState(true);
  useEffect(() => void biometricAvailable().then(setBioOk), []);
  const save = async (pin: string | null) => {
    const a = newAccount(name, color, Date.now());
    await setLocal('account', { ...a, pin: pin ? await hashPin(pin) : null, biometric: !!pin && bioOk && useBio });
    void buzz('success');
    onDone();
  };
  return (
    <div class="lock-screen setup" data-testid="profile-setup">
      <div class="lock-glow" aria-hidden="true" />
      <Avatar name={name || 'You'} color={color} size={84} />
      {step === 'name' && (
        <>
          <h2>Create your profile</h2>
          <p class="small muted">It stays on this phone. No email, no password online.</p>
          <input class="name-input" placeholder="Your name" value={name} maxLength={40} data-field="profile-name" onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          <div class="colors">
            {AVATAR_COLORS.map((c) => (
              <button type="button" class={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} aria-label="Choose colour" onClick={() => setColor(c)} />
            ))}
          </div>
          <button class="btn primary block" type="button" data-testid="profile-next" disabled={!name.trim()} onClick={() => setStep('pin')}>
            Next
          </button>
        </>
      )}
      {step === 'pin' && (
        <>
          <h2>Set a {PIN_LENGTH}-digit PIN</h2>
          <p class="small muted">Asked when TradeBuddy opens, so nobody else sees your trades.</p>
          <PinPad onDone={(p) => (setFirst(p), setStep('confirm'), setError(null))} />
          <button class="link-btn small" type="button" data-testid="profile-skip-pin" onClick={() => void save(null)}>
            Skip — no lock
          </button>
        </>
      )}
      {step === 'confirm' && (
        <>
          <h2>Type the PIN again</h2>
          {error && <p class="small err-text">{error}</p>}
          <PinPad
            error={!!error}
            onDone={(p) => {
              if (p !== first) {
                setError('The two PINs were different — try again.');
                setStep('pin');
                return;
              }
              void save(p);
            }}
          />
          {bioOk && (
            <label class="row small" style={{ gap: '8px', justifyContent: 'center' }}>
              <input type="checkbox" role="switch" class="switch" checked={useBio} onChange={(e) => setUseBio((e.currentTarget as HTMLInputElement).checked)} /> Also unlock with fingerprint
            </label>
          )}
        </>
      )}
    </div>
  );
}
