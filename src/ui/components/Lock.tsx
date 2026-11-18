import { useEffect, useState } from 'preact/hooks';
import { AVATAR_COLORS, checkPin, hashPin, initials, newAccount, PIN_LENGTH, waitAfterFails, type AccountState } from '../../account/account';
import { biometricAvailable, biometricUnlock } from '../../platform/biometric';
import { setLocal } from '../../storage/local';
import { buzz } from './Motion';
import { greetingLine } from '../greeting';

/** Round avatar with initials. */
export function Avatar({ name, color, size = 72 }: { name: string; color: string; size?: number }) {
  // a colour saved by an older version (not in today's palette) shows as the first palette colour
  const shade = AVATAR_COLORS.includes(color) ? color : AVATAR_COLORS[0]!;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${size * 0.38}px`, background: shade }}>
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
      <h2 data-testid="lock-greeting">{greetingLine(now, account.name)}</h2>
      <p class="small muted">{waiting ? `Too many wrong tries — wait ${Math.ceil((waitUntil - now) / 1000)} s` : 'Enter your PIN'}</p>
      <PinPad
        onDone={(p) => void enter(p)}
        disabled={waiting}
        error={error}
        extra={
          bio ? (
            <button type="button" class="key ghost bio" aria-label="Use fingerprint" data-testid="bio-btn" onClick={() => void tryBio()}>
              <Fingerprint size={38} />
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

/** A fingerprint drawn ridge by ridge, with a light scanning over it (app v1.8). */
export function Fingerprint({ size = 40 }: { size?: number }) {
  return (
    <svg class="fp" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" data-testid="fingerprint">
      <defs>
        <linearGradient id="fpScanGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity="0" />
          <stop offset="0.5" stop-color="currentColor" stop-opacity="0.95" />
          <stop offset="1" stop-color="currentColor" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="fp-ridges" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
        <path d="M11 17.5C13.8 12 18.6 9 24 9s10.2 3 13 8.5" />
        <path d="M8.5 26c0-4.2 1.4-8 4-11" />
        <path d="M14 39c-2.2-3.8-3.4-8.3-3.4-13 0-7.5 6-13.6 13.4-13.6S37.4 18.5 37.4 26c0 1.5-.1 3-.4 4.4" />
        <path d="M19 41.5c-2.4-4.3-3.8-9.7-3.8-15.5 0-4.9 3.9-8.9 8.8-8.9s8.8 4 8.8 8.9c0 4.4-.6 8.6-1.8 12.4" />
        <path d="M24 25.8c0 6.2-1.2 11.5-3.6 16.2" />
        <path d="M28.6 27.5c0 5.4-1 10.3-2.9 14.5" />
        <path d="M38.5 35.5c.9-2.4 1.6-5 1.9-7.7" />
        <path d="M20.6 31c-.3-1.6-.4-3.2-.4-4.9 0-2.1 1.7-3.8 3.8-3.8s3.8 1.7 3.8 3.8" />
      </g>
      <rect class="fp-scan" x="6" y="2" width="36" height="7" rx="3.5" fill="url(#fpScanGrad)" />
    </svg>
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
