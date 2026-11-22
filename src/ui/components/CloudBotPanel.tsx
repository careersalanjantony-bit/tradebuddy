import { useEffect, useState } from 'preact/hooks';
import type { BotState } from '../../background/botJobs';
import type { BotCloudLink, CloudBotPreview, FreshStart } from '../../background/cloudBotJobs';
import { CLOUD_BOT_FRESH_MS } from '../../background/cloudBotJobs';
import { BOT_START } from '../../bot/policy';
import type { BotCommand, BotSummary, CloudBotSnapshot, CutoverChoice } from '../../bot/cloud';
import type { ProtectRules } from '../../bot/protect';
import { formatDateTimeIST, formatINR, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { getLocal } from '../../storage/local';
import { useLocal, useNow } from '../hooks';
import { Icon } from './Icon';
import { toast } from './Motion';
import type { PlaybookId } from '../../bot/playbooks';

/**
 * App v1.22 — the cloud auto-trader on screen. When the auto-trader runs on the user's server, the
 * Auto-trader screen shows the SERVER's state (its trades, money worked out with its prices, its
 * learning and log) and every control goes to the server; this phone never trades it itself. This file:
 * where the screen's data and controls come from, the status bar, the one-time move and the way back.
 */

const hm = (t: number | null | undefined) => (t ? formatTimeIST(t).slice(0, 5) : '—');
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `at ${formatDateTimeIST(Date.now() - ms)}`);

export type BotQuotes = Record<string, { ltp: number; prevClose: number | null; fetchedAt: number }>;

/** The controls of the Auto-trader screen: to this phone's own auto-trader, or to the server's. */
export interface BotControls {
  /** true = changes go to the server */
  cloud: boolean;
  /** false = this phone may not change it (another phone controls it, or it is not running anywhere) */
  canControl: boolean;
  why: string | null;
  enable(enabled: boolean): Promise<void>;
  amount(amount: number): Promise<{ total: number; free: number }>;
  rules(patch: Partial<ProtectRules>): Promise<void>;
  reset(forget: boolean, startCash: number): Promise<void>;
  protectTest(): Promise<{ ok: boolean; days: number }>;
  /** app v1.23: switch one kind of trade off / on again */
  playbook(id: PlaybookId, off: boolean): Promise<void>;
  /** app v1.23: trade again after the drawdown brake stopped it */
  resume(): Promise<void>;
}

const command = async (c: BotCommand): Promise<unknown> => (await callBackground('cloudbot:command', { command: c })).result;

export function botControls(link: BotCloudLink | null | undefined): BotControls {
  if (link?.mode === 'pending') {
    const no = async () => {
      throw new Error('The auto-trader is being moved to your server — wait a moment.');
    };
    return { cloud: true, canControl: false, why: 'Being moved to your server…', enable: no, amount: no, rules: no, reset: no, protectTest: no, playbook: no, resume: no };
  }
  if (link?.mode === 'cloud') {
    const snap = link.snapshot;
    const canControl = !!snap?.you.canControl;
    const why = !snap ? 'Waiting for the server…' : snap.authority.mode !== 'cloud' ? 'It is stopped on the server (standby): nothing can be changed now.' : canControl ? null : `Controlled from ${snap.authority.controller?.name ?? 'another phone'} — this phone only shows it.`;
    return {
      cloud: true,
      canControl,
      why,
      enable: async (enabled) => void (await command({ type: 'enable', enabled })),
      amount: async (amount) => (await command({ type: 'amount', amount })) as { total: number; free: number },
      rules: async (rules) => void (await command({ type: 'rules', rules })),
      reset: async (forget, startCash) => void (await command({ type: 'reset', forget, startCash })),
      protectTest: async () => (await command({ type: 'protect-test' })) as { ok: boolean; days: number },
      playbook: async (playbook, off) => void (await command({ type: 'playbook', playbook, off })),
      resume: async () => void (await command({ type: 'resume' })),
    };
  }
  return {
    cloud: false,
    canControl: true,
    why: null,
    enable: async (enabled) => void (await callBackground('bot:enable', { enabled })),
    amount: (amount) => callBackground('bot:amount', { amount }),
    rules: async (rules) => void (await callBackground('bot:rules', { rules })),
    reset: async (forget, startCash) => void (await callBackground('bot:reset', { forget, startCash })),
    protectTest: () => callBackground('bot:test'),
    playbook: async (playbook, off) => void (await callBackground('bot:playbook', { playbook, off })),
    resume: async () => void (await callBackground('bot:resume')),
  };
}

/** The server's prices of the open trades, in the shape the screen uses. */
export const cloudQuotes = (s: CloudBotSnapshot | null | undefined): BotQuotes => s?.quotes ?? {};

/** While the screen is open: the server's auto-trader every 5 s in market hours (30 s otherwise). */
export function useCloudRefresh(link: BotCloudLink | null | undefined): void {
  const on = link?.mode === 'cloud';
  const open = link?.snapshot?.telemetry.marketPhase === 'open';
  useEffect(() => {
    if (!on) return;
    void callBackground('cloudbot:refresh').catch(() => undefined);
    const id = setInterval(() => void callBackground('cloudbot:refresh').catch(() => undefined), open ? 5_000 : 30_000);
    return () => clearInterval(id);
  }, [on, open]);
}

/** Status for the hero line. */
export function cloudStatus(link: BotCloudLink, now: number): { text: string; cls: string } {
  if (link.mode === 'pending') return { text: 'Moving to your server…', cls: 'warn' };
  const t = link.snapshot?.telemetry;
  const offline = !link.fetchedAt || now - link.fetchedAt > CLOUD_BOT_FRESH_MS;
  const tail = offline ? ' · offline copy' : '';
  if (!t) return { text: `On your server — waiting for it${tail}`, cls: 'idle' };
  switch (t.health) {
    case 'ok':
      return { text: `Trading by itself on your server${tail}`, cls: offline ? 'idle' : 'live' };
    case 'closed':
      return { text: `Market closed — on your server, waits for 9:30${tail}`, cls: 'idle' };
    case 'paused':
      return { text: `Paused (on your server)${tail}`, cls: 'idle' };
    case 'standby':
      return { text: `Stopped on the server${tail}`, cls: 'warn' };
    default:
      return { text: `On your server — not trading now${tail}`, cls: 'warn' };
  }
}

// ---------------------------------------------------------------- the panel

/** The card under the hero: where the auto-trader runs, how fresh this copy is, and the move. */
export function CloudBotPanel({ link, bot }: { link: BotCloudLink | null | undefined; bot: BotState | null | undefined }) {
  const cloud = useLocal('cloud');
  const now = useNow(5_000);
  if (link?.mode === 'pending') return <PendingMove link={link} />;
  if (link?.mode === 'cloud') return <OnServer link={link} now={now} />;
  if (!cloud) return null; // not paired: the auto-trader is the phone's, as always
  return <MoveOffer hasBot={!!bot} />;
}

function OnServer({ link, now }: { link: BotCloudLink; now: number }) {
  const s = link.snapshot;
  const t = s?.telemetry;
  const [busy, setBusy] = useState<null | 'back' | 'leave' | 'force'>(null);
  const [confirm, setConfirm] = useState<null | 'back' | 'leave'>(null);
  const [offerForce, setOfferForce] = useState(false);
  const age = link.fetchedAt ? now - link.fetchedAt : null;
  const offline = age === null || age > CLOUD_BOT_FRESH_MS;
  // the phone named on the server (also after an emergency stop on the server: it can take the latest state back)
  const controller = !!s && s.authority.controller?.deviceId === s.you.deviceId;
  const act = (what: 'back' | 'leave' | 'force', type: 'cloudbot:release' | 'cloudbot:leave' | 'cloudbot:force-local', done: string) => {
    setBusy(what);
    void callBackground(type)
      .then(() => toast(done, 'ok'))
      .catch((e: unknown) => {
        toast(errorMessage(e), 'err');
        if (what === 'back') setOfferForce(true);
      })
      .finally(() => {
        setBusy(null);
        setConfirm(null);
      });
  };
  return (
    <section class="card" data-testid="bot-cloud">
      <div class="row" style={{ gap: '8px' }}>
        <Icon name="robot" size={18} />
        <b class="grow">Runs on your server</b>
        <span class={`chip ${offline ? 'flag' : 'pick'}`} data-testid="bot-cloud-fresh">
          {offline ? (link.fetchedAt ? `offline · copy from ${hm(link.fetchedAt)}` : 'not reached yet') : `updated ${ago(age!)}`}
        </span>
      </div>
      <p class="tiny muted" style={{ margin: '6px 0 0' }} data-testid="bot-cloud-times">
        It trades on the server, also with this app closed — this phone shows the server’s own state. Last run {hm(t?.lastRunAt)} · last look for trades {hm(t?.lastDecisionAt)} · server prices {t?.priceAt ? `${hm(t.priceAt)}${t.priceAgeSec !== null && t.priceAgeSec > 120 ? ' (old)' : ''}` : '—'} · market {t?.marketLabel ?? '—'}
      </p>
      {t && t.health !== 'ok' && t.health !== 'closed' && (
        <p class="small bot-gap" data-testid="bot-cloud-health">
          {t.health === 'paused' ? '⏸' : '⚠️'} {t.text}
        </p>
      )}
      {offline && (
        <p class="small bot-gap" data-testid="bot-cloud-offline">
          Can’t reach the server{link.lastError ? ` (${link.lastError})` : ''}. This is the last copy it sent{link.fetchedAt ? ` (${formatDateTimeIST(link.fetchedAt)})` : ''}. The auto-trader keeps running on the server; this phone does not trade it.
        </p>
      )}
      {s && !controller && s.authority.mode === 'cloud' && (
        <p class="tiny muted" data-testid="bot-cloud-viewer">
          Controlled from <b>{s.authority.controller?.name ?? 'another phone'}</b>. This phone only shows it.
        </p>
      )}
      <div class="row" style={{ gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
        {controller ? (
          <button class="btn small" type="button" data-testid="bot-cloud-back" disabled={busy !== null} onClick={() => setConfirm('back')}>
            Run it on this phone again
          </button>
        ) : (
          <button class="btn small" type="button" data-testid="bot-cloud-leave" disabled={busy !== null} onClick={() => setConfirm('leave')}>
            Stop showing the server’s auto-trader
          </button>
        )}
      </div>
      {confirm === 'back' && (
        <div class="confirm-box small">
          The server stops trading it and hands everything (trades, money, learning) to this phone, which then trades it only while the app runs. Move it back?
          <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
            <button class="btn small danger" type="button" data-testid="bot-cloud-back-yes" disabled={busy !== null} onClick={() => act('back', 'cloudbot:release', 'The auto-trader is back on this phone.')}>
              {busy === 'back' ? 'Moving…' : 'Yes, move it back'}
            </button>
            <button class="btn small" type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {confirm === 'leave' && (
        <div class="confirm-box small">
          This phone’s own auto-trader (kept since it stopped here) comes back, paused. The server’s keeps running. Go back?
          <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
            <button class="btn small danger" type="button" disabled={busy !== null} onClick={() => act('leave', 'cloudbot:leave', 'Showing this phone’s own auto-trader (paused).')}>
              Yes
            </button>
            <button class="btn small" type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {offerForce && (
        <div class="confirm-box small" data-testid="bot-cloud-force">
          The server could not be reached, so it may still be trading. Only if the server is really off: take the last copy back to this phone, <b>paused</b>.
          <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
            <button class="btn small danger" type="button" disabled={busy !== null} onClick={() => act('force', 'cloudbot:force-local', 'Taken back, paused. Switch it on only after the server’s auto-trader was stopped.')}>
              Take it back, paused
            </button>
            <button class="btn small" type="button" onClick={() => setOfferForce(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PendingMove({ link }: { link: BotCloudLink }) {
  const [busy, setBusy] = useState(false);
  const go = (type: 'cloudbot:retry' | 'cloudbot:cancel') => {
    setBusy(true);
    void callBackground(type)
      .then((r) => toast(type === 'cloudbot:retry' || (r as { result?: string }).result === 'moved' ? 'The auto-trader now runs on your server.' : 'Cancelled — the auto-trader runs on this phone again.', 'ok'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  return (
    <section class="card" data-testid="bot-cloud-pending">
      <b>Moving the auto-trader to your server…</b>
      <p class="small muted" style={{ margin: '6px 0' }}>
        {link.lastError ?? 'Sending it now.'} Until the server answers, this phone’s auto-trader stays stopped, so there are never two.
      </p>
      <div class="row" style={{ gap: '8px' }}>
        <button class="btn small primary" type="button" data-testid="bot-cloud-retry" disabled={busy} onClick={() => go('cloudbot:retry')}>
          Try again
        </button>
        <button class="btn small" type="button" data-testid="bot-cloud-cancel" disabled={busy} onClick={() => go('cloudbot:cancel')}>
          Cancel the move
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the one-time move

const CHOICE_TEXT: Record<CutoverChoice, string> = {
  import: 'Move THIS PHONE’s auto-trader to the server — its open trades, money, record and learning. The server’s own copy is kept as a backup.',
  'keep-server': 'Use the SERVER’s auto-trader. This phone’s is kept as a backup (on the phone and on the server).',
  fresh: 'Start a NEW auto-trader on the server. Both old ones are kept as backups.',
};

function MoveOffer({ hasBot }: { hasBot: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section class="card" data-testid="bot-cloud-offer">
      <div class="row" style={{ gap: '8px' }}>
        <Icon name="robot" size={18} />
        <b class="grow">Let it trade with the app closed</b>
      </div>
      <p class="tiny muted" style={{ margin: '6px 0' }}>
        Your server can run the auto-trader for you — every market minute, with this app closed or the phone off. This phone then shows the server’s trades and sends your controls to it. {hasBot ? 'Its trades, money and learning move with it.' : ''} Pretend money only, as always.
      </p>
      {!open ? (
        <button class="btn small primary" type="button" data-testid="bot-cloud-compare" onClick={() => setOpen(true)}>
          Compare and move to my server…
        </button>
      ) : (
        <MoveFlow onClose={() => setOpen(false)} />
      )}
    </section>
  );
}

function SummaryCol({ title, s }: { title: string; s: BotSummary | null }) {
  return (
    <div class="grow" data-testid={`bot-cloud-sum-${title.toLowerCase()}`}>
      <b>{title}</b>
      {!s ? (
        <div class="tiny muted">no auto-trader</div>
      ) : (
        <ul class="tiny" style={{ margin: '4px 0 0', paddingLeft: '16px' }}>
          <li>
            started with {formatINR(s.startCash, 0)}, cash {formatINR(s.cash, 0)}
          </li>
          <li>
            {s.openTrades} open · {s.closedTrades} finished trades
          </li>
          <li>
            learned from {s.learnedFrom} (won {s.wins})
          </li>
          <li>last trade {s.lastTradeAt ? formatDateTimeIST(s.lastTradeAt) : '—'}</li>
          <li>{s.enabled ? 'switched on' : 'paused'}</li>
        </ul>
      )}
    </div>
  );
}

function MoveFlow({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<CloudBotPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<CutoverChoice | null>(null);
  const [cash, setCash] = useState(String(BOT_START));
  const [brainFrom, setBrainFrom] = useState<FreshStart['brainFrom']>('phone');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const look = () => {
    setErr(null);
    setP(null);
    void callBackground('cloudbot:preview')
      .then((r) => {
        setP(r);
        setChoice(r.advice?.recommended ?? null);
        if (r.phone) setCash(String(Math.round(r.phone.startCash)));
      })
      .catch((e: unknown) => setErr(errorMessage(e)));
  };
  useEffect(look, []);
  const startCash = Math.round(Number(cash.replace(/[^0-9.]/g, '')) || 0);
  const move = () => {
    if (!p || !choice) return;
    setBusy(true);
    setErr(null);
    void callBackground('cloudbot:move', { choice, preview: p, ...(choice === 'fresh' ? { fresh: { startCash, brainFrom } } : {}) })
      .then(() => {
        toast('Done — the auto-trader now runs on your server.', 'ok');
        onClose();
      })
      .catch((e: unknown) => setErr(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const join = () => {
    setBusy(true);
    void callBackground('cloudbot:join')
      .then(() => toast('This phone now shows the server’s auto-trader.', 'ok'))
      .catch((e: unknown) => setErr(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const copyBackup = () =>
    void getLocal('bot')
      .then(async (bot) => {
        await navigator.clipboard.writeText(JSON.stringify({ kind: 'tradebuddy-autotrader-backup', at: Date.now(), bot: bot ?? null }));
        toast('A copy of this phone’s auto-trader is on the clipboard — paste it somewhere safe.', 'ok');
      })
      .catch((e: unknown) => toast(errorMessage(e), 'err'));

  if (err && !p) {
    return (
      <div class="small">
        <p class="err-text">{err}</p>
        <button class="btn small" type="button" onClick={look}>
          Try again
        </button>
      </div>
    );
  }
  if (!p) return <p class="small muted">Asking your server…</p>;
  if (!p.advice) {
    return (
      <div class="small" data-testid="bot-cloud-join">
        <p>
          The auto-trader already runs on your server (controlled from <b>{p.server.authority.controller?.name ?? 'no phone'}</b>). This phone can show it too. Its own auto-trader stops here and is kept, so there is still only one.
        </p>
        {err && <p class="err-text">{err}</p>}
        <button class="btn small primary" type="button" disabled={busy} onClick={join}>
          Show the server’s auto-trader here
        </button>
      </div>
    );
  }
  return (
    <div class="small" data-testid="bot-cloud-flow">
      <div class="row" style={{ gap: '12px', alignItems: 'flex-start' }}>
        <SummaryCol title="Phone" s={p.phone} />
        <SummaryCol title="Server" s={p.server.server} />
      </div>
      <p style={{ margin: '8px 0' }} data-testid="bot-cloud-advice">
        <b>{p.advice.text}</b>
      </p>
      {p.server.problems.map((x) => (
        <p class="err-text">{x}</p>
      ))}
      {p.server.warnings.map((x) => (
        <p class="tiny muted">{x}</p>
      ))}
      {p.advice.choices.map((c) => (
        <label class="row" style={{ gap: '8px', alignItems: 'flex-start', margin: '6px 0' }}>
          <input type="radio" name="bot-cloud-choice" data-choice={c} checked={choice === c} onChange={() => setChoice(c)} />
          <span>
            {CHOICE_TEXT[c]}
            {c === p.advice!.recommended && <span class="chip pick" style={{ marginLeft: '6px' }}>suggested</span>}
          </span>
        </label>
      ))}
      {choice === 'fresh' && (
        <div class="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
          <label class="field" style={{ margin: 0 }}>
            <span>Start with (₹)</span>
            <input type="text" inputMode="numeric" value={cash} onInput={(e) => setCash((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="field" style={{ margin: 0 }}>
            <span>Keep what it learned</span>
            <select value={brainFrom} onChange={(e) => setBrainFrom((e.currentTarget as HTMLSelectElement).value as FreshStart['brainFrom'])}>
              {p.phone && <option value="phone">from the phone</option>}
              {p.server.server && <option value="server">from the server</option>}
              <option value="none">nothing (a fresh brain)</option>
            </select>
          </label>
        </div>
      )}
      <p class="tiny muted" style={{ margin: '8px 0' }}>
        Backups: this phone keeps a copy of its auto-trader, and the server keeps a copy of both before anything changes. Nothing is ever mixed.{' '}
        <button class="btn small" type="button" onClick={copyBackup}>
          Copy a backup too
        </button>
      </p>
      <label class="row" style={{ gap: '8px' }}>
        <input type="checkbox" data-testid="bot-cloud-sure" checked={sure} onChange={(e) => setSure((e.currentTarget as HTMLInputElement).checked)} />
        <span>I understand: from now on only the server trades it; this phone shows it and sends my controls.</span>
      </label>
      {err && <p class="err-text">{err}</p>}
      <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
        <button class="btn small primary" type="button" data-testid="bot-cloud-move" disabled={busy || !sure || !choice || !p.server.canMove || (choice === 'fresh' && startCash < 10_000)} onClick={move}>
          {busy ? 'Moving…' : 'Move it now'}
        </button>
        <button class="btn small" type="button" disabled={busy} onClick={look}>
          Look again
        </button>
        <button class="btn small" type="button" disabled={busy} onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  );
}
