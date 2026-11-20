import { BOT_API_VERSION, botDigest, classifyCutover, summarizeBot, validateBotState, type BotCommand, type BotSummary, type CloudBotSnapshot, type CutoverAdvice, type CutoverChoice } from '../bot/cloud';
import type { AlertCategory } from '../notify/categories';
import { createLogger } from '../lib/log';
import { createQueue } from '../lib/queue';
import { errorMessage } from '../lib/serialize';
import { CloudError, cloudRequest, syncPreferences } from '../platform/push';
import { getLocal, getSettings, setLocal } from '../storage/local';
import { setBotGate, withBotLock, type BotState } from './botJobs';

/**
 * App v1.22 — the phone's side of the cloud auto-trader (see src/bot/cloud.ts, server/src/bot/cloudBot.ts).
 *
 * While `botCloud` is set, the phone NEVER runs or changes an auto-trader of its own — not on a price
 * poll, not on resume, not on a retry, not when the server cannot be reached. It shows the server's
 * copy (kept here, so it is there offline too, marked with its time) and sends the owner's controls to
 * the server. The phone's own auto-trader is kept in `botArchive` every time it stops running here.
 *
 * The move is explicit and repeat-safe: the phone first stops its own auto-trader (so it cannot change
 * while it is being sent), keeps a copy, then sends it with a request id. If the answer is lost, the
 * same request is sent again and the server answers from its record — it is never done twice. Only a
 * clear "no" from the server lets the phone's own auto-trader run again.
 */

const log = createLogger('cloud-bot');
const line = createQueue();

/** 'fresh': the money to start with on the server, and whose learning to keep. */
export interface FreshStart {
  startCash: number;
  brainFrom: 'phone' | 'server' | 'none';
}

export interface BotCloudLink {
  /** 'pending' = being moved to the server (the phone's own auto-trader is stopped); 'cloud' = it runs there */
  mode: 'pending' | 'cloud';
  serverId: string;
  deviceId: string;
  since: number;
  epoch: number;
  /** the move in progress (repeat-safe: the same request id until the server answers) */
  pending?: { requestId: string; choice: CutoverChoice; fresh?: FreshStart; expectServerDigest: string | null; phoneDigest: string | null; startedAt: number };
  /** the move back to this phone in progress */
  releasing?: { requestId: string; startedAt: number };
  /** the server's auto-trader as last seen (shown offline too, with its time) */
  snapshot: CloudBotSnapshot | null;
  /** this phone's clock when it was fetched */
  fetchedAt: number | null;
  lastError: string | null;
}

export interface BotArchiveEntry {
  at: number;
  reason: string;
  state: BotState;
  digest: string;
}

/** A copy older than this is shown as "offline — the server's state from hh:mm". */
export const CLOUD_BOT_FRESH_MS = 2 * 60_000;
const ARCHIVE_KEEP = 5;

const newRequestId = () => `tb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
/** The server answered (any HTTP status): a definite answer. No status = offline / timed out: unknown. */
const answered = (err: unknown): err is CloudError => err instanceof CloudError && typeof err.status === 'number' && err.status < 500 && err.status !== 429;

// ---------------------------------------------------------------- the gate: never two auto-traders

/** Installed at start, before anything can run the auto-trader on this phone. */
export function installPhoneBotGate(): void {
  setBotGate({
    check: async () => {
      const l = await getLocal('botCloud');
      if (!l) return { run: true, write: true, reason: '' };
      return { run: false, write: false, reason: l.mode === 'pending' ? 'The auto-trader is being moved to your server — wait a moment.' : 'The auto-trader runs on your server: change it on the Auto-trader screen (the change goes to the server).' };
    },
    view: async () => (await getLocal('botCloud'))?.snapshot?.bot ?? null,
  });
}

async function setLink(l: BotCloudLink | null): Promise<void> {
  await setLocal('botCloud', l);
}

async function archive(state: BotState | null | undefined, reason: string, now: number): Promise<BotArchiveEntry | null> {
  if (!state) return null;
  const e: BotArchiveEntry = { at: now, reason, state, digest: await botDigest(state) };
  const list = (await getLocal('botArchive')) ?? [];
  await setLocal('botArchive', [...list, e].slice(-ARCHIVE_KEEP));
  return e;
}

/** The server's alerts about the auto-trader go to this phone while it shows the server's auto-trader (if bot alerts are on). */
export async function syncBotAlerts(on: boolean): Promise<void> {
  const c = await getLocal('cloud');
  if (!c) return;
  const want = on && (await getSettings()).notifications.bot !== false;
  const has = c.categories.includes('autotrader');
  if (want === has) return;
  const cats: AlertCategory[] = want ? [...c.categories, 'autotrader'] : c.categories.filter((x) => x !== 'autotrader');
  await syncPreferences(cats).catch((err: unknown) => log.info('Alert choices not sent to the server', { reason: errorMessage(err) }));
}

function checkSnapshot(r: CloudBotSnapshot): void {
  if (!r || typeof r !== 'object' || typeof r.api !== 'number' || !r.authority || !r.telemetry) throw new CloudError('The server sent an answer the app does not understand.');
  if (r.api < BOT_API_VERSION) throw new CloudError('The server is older than this app — update the TradeBuddy server first.');
}

// ---------------------------------------------------------------- reading

/** Fetches the server's auto-trader (only what changed). Never throws: an error is kept in the link. */
export function refreshCloudBot(now = Date.now()): Promise<BotCloudLink | null> {
  return line(async () => {
    const l = await getLocal('botCloud');
    if (!l || l.mode !== 'cloud') return l ?? null;
    const have = l.snapshot?.bot !== undefined && l.snapshot ? `${l.snapshot.rev}:${l.snapshot.updatedAt}` : null;
    try {
      const r = await cloudRequest<CloudBotSnapshot>(`/v1/bot${have ? `?have=${encodeURIComponent(have)}` : ''}`, 'GET', undefined, 15_000);
      checkSnapshot(r);
      if (r.authority.serverId !== l.serverId) throw new CloudError('This is not the server the auto-trader was moved to (another server, or its database was replaced). Nothing was changed.');
      const { unchanged, ...rest } = r;
      const snapshot: CloudBotSnapshot = unchanged ? { ...rest, bot: l.snapshot?.bot ?? null } : rest;
      const next: BotCloudLink = { ...l, snapshot, epoch: r.authority.epoch, fetchedAt: now, lastError: null };
      await setLink(next);
      return next;
    } catch (err) {
      const next: BotCloudLink = { ...l, lastError: errorMessage(err) };
      await setLink(next);
      return next;
    }
  });
}

export interface CloudBotPreview {
  at: number;
  /** the server's answer: who runs it, its copy (summary + digest), whether it can run it */
  server: { authority: CloudBotSnapshot['authority']; server: BotSummary | null; ready: boolean; canMove: boolean; problems: string[]; warnings: string[]; telemetry: CloudBotSnapshot['telemetry'] };
  phone: BotSummary | null;
  /** null when the auto-trader already runs on the server (this phone can only join it, to look) */
  advice: CutoverAdvice | null;
}

/** Before the move: this phone's auto-trader next to the server's, and what is possible. Changes nothing. */
export async function cloudBotPreview(now = Date.now()): Promise<CloudBotPreview> {
  if (!(await getLocal('cloud'))) throw new CloudError('Pair this phone with your server first (Settings → Cloud alerts).');
  const r = await cloudRequest<CloudBotPreview['server'] & { api: number }>('/v1/bot/preflight', 'GET', undefined, 20_000);
  if (typeof r.api !== 'number' || r.api < BOT_API_VERSION) throw new CloudError('The server is older than this app — update the TradeBuddy server first.');
  const phone = await summarizeBot(await getLocal('bot'));
  return { at: now, server: r, phone, advice: r.authority.mode === 'cloud' ? null : classifyCutover(phone, r.server) };
}

// ---------------------------------------------------------------- the move

/**
 * Moves the auto-trader to the server, with the owner's choice from the preview. The phone's own
 * auto-trader stops first and is kept (botArchive); it starts again only if the server clearly says no.
 */
export async function cloudBotMove(choice: CutoverChoice, preview: CloudBotPreview, fresh?: FreshStart, now = Date.now()): Promise<BotCloudLink> {
  const cloud = await getLocal('cloud');
  if (!cloud) throw new CloudError('Pair this phone with your server first (Settings → Cloud alerts).');
  if (preview.advice && !preview.advice.choices.includes(choice)) throw new CloudError('That choice is not possible here.');
  if (!preview.server.canMove) throw new CloudError(preview.server.problems.join(' ') || 'The server cannot take the auto-trader right now.');
  const existing = await getLocal('botCloud');
  if (existing?.mode === 'cloud') throw new CloudError('The auto-trader already runs on your server.');
  if (existing?.mode === 'pending') return sendMove();
  await withBotLock(async () => {
    const phone = (await getLocal('bot')) ?? null;
    const digest = phone ? await botDigest(phone) : null;
    if (digest !== (preview.phone?.digest ?? null)) {
      // it traded since the preview: show the new comparison first (nothing was stopped)
      throw new CloudError('The phone’s auto-trader changed since you looked (it traded). Look at the comparison again.');
    }
    const kept = await archive(phone, 'before moving it to the server', now);
    await setLink({
      mode: 'pending',
      serverId: preview.server.authority.serverId,
      deviceId: cloud.deviceId,
      since: now,
      epoch: 0,
      pending: { requestId: newRequestId(), choice, ...(fresh ? { fresh } : {}), expectServerDigest: preview.server.server?.digest ?? null, phoneDigest: kept?.digest ?? null, startedAt: now },
      snapshot: null,
      fetchedAt: null,
      lastError: null,
    });
  });
  return sendMove();
}

/** Sends (or sends again) the move in progress — always the same request id and the same copy. */
export async function sendMove(): Promise<BotCloudLink> {
  const l = await getLocal('botCloud');
  if (!l || l.mode !== 'pending' || !l.pending) throw new CloudError('No move in progress.');
  const p = l.pending;
  const phone = p.phoneDigest ? ((await getLocal('botArchive')) ?? []).filter((e) => e.digest === p.phoneDigest).at(-1)?.state ?? null : null;
  if (p.phoneDigest && !phone) throw new CloudError('The kept copy of the phone’s auto-trader is missing — cancel and look again.');
  try {
    const r = await cloudRequest<{ ok: boolean; epoch: number; rev: number }>(
      '/v1/bot/cutover',
      'POST',
      { requestId: p.requestId, choice: p.choice, serverId: l.serverId, expectServerDigest: p.expectServerDigest, phone, phoneDigest: p.phoneDigest, ...(p.fresh ? { fresh: p.fresh } : {}) },
      60_000,
    );
    return await finishMove(r.epoch);
  } catch (err) {
    if (answered(err)) {
      // a clear no: nothing moved — the phone's own auto-trader runs again, exactly as it was
      await setLink(null);
      throw err;
    }
    await setLink({ ...l, lastError: `Not sure the server got it (${errorMessage(err)}). The phone’s auto-trader stays stopped until you try again or cancel.` });
    throw err;
  }
}

async function finishMove(epoch: number): Promise<BotCloudLink> {
  const next = await withBotLock(async () => {
    const l = (await getLocal('botCloud'))!;
    const done: BotCloudLink = { mode: 'cloud', serverId: l.serverId, deviceId: l.deviceId, since: Date.now(), epoch, snapshot: null, fetchedAt: null, lastError: null };
    await setLink(done);
    // the phone's own copy is in botArchive; the phone keeps no second auto-trader
    await setLocal('bot', null);
    return done;
  });
  log.info('Auto-trader moved to the server', { epoch });
  await syncBotAlerts(true);
  return (await refreshCloudBot()) ?? next;
}

/**
 * Stops a move whose answer never came. Asks the server first: if it did take the auto-trader, the move
 * is finished instead; only if it clearly did not, the phone's own auto-trader runs again.
 */
export async function cancelMove(): Promise<'moved' | 'cancelled'> {
  const l = await getLocal('botCloud');
  if (!l || l.mode !== 'pending') return 'cancelled';
  const r = await cloudRequest<CloudBotSnapshot>('/v1/bot', 'GET', undefined, 15_000).catch((err: unknown) => {
    throw new CloudError(`Cannot reach the server to check (${errorMessage(err)}). The phone’s auto-trader stays stopped so there are never two — try again when online.`);
  });
  if (r.authority.serverId === l.serverId && r.authority.mode === 'cloud' && r.authority.controller?.deviceId === l.deviceId) {
    await finishMove(r.authority.epoch);
    return 'moved';
  }
  await setLink(null);
  return 'cancelled';
}

/** Another phone already moved it: this phone shows the server's auto-trader too (read only). Its own is kept. */
export async function cloudBotJoin(now = Date.now()): Promise<BotCloudLink> {
  const cloud = await getLocal('cloud');
  if (!cloud) throw new CloudError('Pair this phone with your server first (Settings → Cloud alerts).');
  const r = await cloudRequest<CloudBotSnapshot>('/v1/bot', 'GET', undefined, 15_000);
  checkSnapshot(r);
  if (r.authority.mode !== 'cloud') throw new CloudError('The auto-trader does not run on the server yet — move it there first.');
  const next = await withBotLock(async () => {
    await archive(await getLocal('bot'), 'stopped on this phone: showing the server’s auto-trader instead', now);
    const link: BotCloudLink = { mode: 'cloud', serverId: r.authority.serverId, deviceId: cloud.deviceId, since: now, epoch: r.authority.epoch, snapshot: { ...r }, fetchedAt: now, lastError: null };
    await setLink(link);
    await setLocal('bot', null);
    return link;
  });
  await syncBotAlerts(true);
  return next;
}

// ---------------------------------------------------------------- controls

/** Sends a control to the server's auto-trader (only the controlling phone may). Repeat-safe. */
export async function cloudBotCommand(command: BotCommand): Promise<unknown> {
  const l = await getLocal('botCloud');
  if (!l || l.mode !== 'cloud') throw new CloudError('The auto-trader does not run on the server.');
  if (l.snapshot && !l.snapshot.you.canControl) throw new CloudError(`Only ${l.snapshot.authority.controller?.name ?? 'the controlling phone'} can change it — this phone only shows it.`);
  const body = { requestId: newRequestId(), command, ...(command.type === 'reset' ? { ifRev: l.snapshot?.rev ?? 0 } : {}) };
  let r: { result?: unknown };
  try {
    r = await cloudRequest<{ result?: unknown }>('/v1/bot/commands', 'POST', body, 30_000);
  } catch (err) {
    if (answered(err)) throw err;
    // no answer: once more with the same request id (the server never does it twice)
    r = await cloudRequest<{ result?: unknown }>('/v1/bot/commands', 'POST', body, 30_000);
  }
  await refreshCloudBot();
  return r.result;
}

// ---------------------------------------------------------------- back to this phone

/** The controlling phone takes the auto-trader back: the server stops and hands over its full state. */
export async function cloudBotRelease(now = Date.now()): Promise<BotState | null> {
  const l = await getLocal('botCloud');
  if (!l || l.mode !== 'cloud') throw new CloudError('The auto-trader does not run on the server.');
  const releasing = l.releasing ?? { requestId: newRequestId(), startedAt: now };
  if (!l.releasing) await setLink({ ...l, releasing });
  let r: { state: unknown };
  try {
    r = await cloudRequest<{ state: unknown }>('/v1/bot/release', 'POST', { requestId: releasing.requestId }, 60_000);
  } catch (err) {
    const cur = await getLocal('botCloud');
    if (cur) {
      if (answered(err)) {
        const { releasing: _r, ...rest } = cur;
        await setLink(rest);
      } else await setLink({ ...cur, lastError: `Not sure the server got it (${errorMessage(err)}). Try again.` });
    }
    throw err;
  }
  const state = r.state === null ? null : validateBotState(r.state);
  await withBotLock(async () => {
    await setLocal('bot', state);
    await setLink(null);
  });
  await syncBotAlerts(false);
  log.info('Auto-trader moved back to this phone');
  return state;
}

/**
 * A phone that only looked: back to its own auto-trader (the newest kept copy), PAUSED — it was not
 * trading while kept, so the owner decides when it starts again.
 */
export async function cloudBotLeave(now = Date.now()): Promise<BotState | null> {
  const l = await getLocal('botCloud');
  if (!l) return (await getLocal('bot')) ?? null;
  if (l.mode === 'cloud' && l.snapshot && l.snapshot.authority.controller?.deviceId === l.snapshot.you.deviceId) throw new CloudError('This phone controls the server’s auto-trader: move it back instead (so its latest state comes back, and the server is not left with no phone to control it).');
  if (l.mode === 'pending') throw new CloudError('A move is in progress: cancel it first.');
  const kept = ((await getLocal('botArchive')) ?? []).at(-1)?.state ?? null;
  const at = new Date(now + 5.5 * 3_600_000).toISOString().slice(11, 16);
  const back = kept ? { ...kept, enabled: false, log: [...kept.log, { at: now, kind: 'info' as const, text: `Back on this phone at ${at}, paused — switch it on when you want it to trade here again.` }].slice(-150) } : null;
  await withBotLock(async () => {
    await setLocal('bot', back);
    await setLink(null);
  });
  await syncBotAlerts(false);
  return back;
}

/**
 * Emergency only (the server cannot be reached and the owner insists): the last copy seen comes back to
 * this phone PAUSED. The server may still be trading its own copy — say so plainly.
 */
export async function cloudBotForceLocal(now = Date.now()): Promise<BotState | null> {
  const l = await getLocal('botCloud');
  if (!l) return (await getLocal('bot')) ?? null;
  const copy = l.snapshot?.bot ?? ((await getLocal('botArchive')) ?? []).at(-1)?.state ?? null;
  const at = new Date(now + 5.5 * 3_600_000).toISOString().slice(11, 16);
  const back = copy ? { ...copy, enabled: false, log: [...copy.log, { at: now, kind: 'info' as const, text: `Taken back at ${at} WITHOUT the server's confirmation — paused. The server may still be trading its copy: switch this on only after the server's auto-trader was stopped.` }].slice(-150) } : null;
  await withBotLock(async () => {
    await setLocal('bot', back);
    await setLink(null);
  });
  await syncBotAlerts(false).catch(() => undefined);
  return back;
}

/** Before unpairing: the auto-trader must not be left on the server with no phone (or the phone without one). */
export async function botBeforeUnpair(force = false): Promise<void> {
  const l = await getLocal('botCloud');
  if (!l) return;
  try {
    if (l.mode === 'pending') {
      if ((await cancelMove()) === 'cancelled') return;
    }
    const cur = await getLocal('botCloud');
    if (!cur) return;
    if (cur.snapshot && cur.snapshot.authority.controller?.deviceId === cur.snapshot.you.deviceId) await cloudBotRelease();
    else await cloudBotLeave();
  } catch (err) {
    if (!force) throw err;
    await cloudBotForceLocal();
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** While the app runs: the server's auto-trader every minute (only what changed is sent). */
export function startCloudBotChecks(): void {
  void refreshCloudBot().catch(() => undefined);
  timer ??= setInterval(() => void refreshCloudBot().catch(() => undefined), 60_000);
  (timer as { unref?: () => void }).unref?.();
}
