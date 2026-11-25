import type { DatabaseSync } from 'node:sqlite';
import { BotConflictError, BotElsewhereError, botReset, botResume, botSetAmount, botSetEnabled, botSetPlaybook, botSetRules, newBot, withBotLock, type BotGateAnswer, type BotObserver, type BotRunInfo, type BotState } from '../../../src/background/botJobs';
import { testProtect } from '../../../src/background/botTest';
import { newBrain } from '../../../src/bot/brain';
import { BOT_START } from '../../../src/bot/policy';
import {
  BOT_API_VERSION,
  botDigest,
  botView,
  classifyCutover,
  parseCommand,
  summarizeBot,
  validateBotState,
  type BotAuthorityView,
  type BotCommand,
  type BotMoney,
  type BotSummary,
  type BotTelemetry,
  type CloudBotSnapshot,
  type CutoverChoice,
} from '../../../src/bot/cloud';
import type { Quote } from '../../../src/data/quotesParse';
import { createLogger } from '../../../src/lib/log';
import { errorMessage } from '../../../src/lib/serialize';
import { istDate } from '../../../src/lib/time';
import { notify } from '../../../src/notify/chrome';
import { walletSummary } from '../../../src/wallet/wallet';
import type { Device, DeviceStore } from '../push/devices';
import type { SqliteKV } from '../storage/kv';

/**
 * App 1.22 — the cloud auto-trader on the server.
 *
 * ONE auto-trader, ONE writer. Until the owner moves it here (a one-time, explicit "cutover" from a phone)
 * the server is on STANDBY: its own copy (kv 'bot') is kept exactly as it is and never trades, so the
 * phone's auto-trader stays the only one. After the move the server runs it — the app's own runBot(),
 * unchanged, from the same price polls — also with every phone closed, and phones only show it and send
 * controls here. Moving it back to a phone ("release") puts the server on standby again.
 *
 * Security (one user, one server): every paired phone is the owner's, so every paired phone may READ
 * the auto-trader; only ONE phone — the one that moved it here (or the one the owner names with the
 * admin token) — may CHANGE it. Every change is written to bot_audit with the phone, the request id (a
 * repeated request is answered from there and never done twice) and the versions before / after. The
 * admin token (TB_API_TOKEN, never on a phone) can stop it, name the controlling phone, list and restore
 * backups. Pretend money only: nothing here places, changes or cancels an order at Upstox.
 */

const log = createLogger('cloud-bot');

export interface CloudBotDeps {
  db: DatabaseSync;
  /** the 'local' storage area (kv 'bot' and the rest of the app's data) */
  local: SqliteKV;
  devices: DeviceStore;
  now: () => number;
  /** TB_JOBS: the server runs the app's jobs (without them nothing would run the auto-trader) */
  jobs: boolean;
  hasToken: boolean;
  analytics: () => Promise<string>;
  market: (now: number) => Promise<{ phase: string; label: string }>;
  quotes: () => Promise<Record<string, Quote>>;
  feedConnected: () => boolean | null;
}

/** An answer for the HTTP layer: status + body. */
export interface BotAnswer {
  status: number;
  body: Record<string, unknown>;
}

interface AuthorityRow {
  server_id: string;
  mode: 'standby' | 'cloud';
  epoch: number;
  controller_id: string | null;
  activated_at: number | null;
  changed_at: number;
}

/** The phone sends, for the move. */
export interface CutoverRequest {
  requestId: string;
  choice: CutoverChoice;
  /** the server id the phone saw in the preview (the same server) */
  serverId: string;
  /** the server copy's digest the phone saw in the preview (null = it had none): nothing changed since */
  expectServerDigest: string | null;
  /** the phone's own auto-trader (null = none) — kept here as a backup whatever the choice */
  phone: BotState | null;
  phoneDigest: string | null;
  /** 'fresh': the money to start with, and whose learning to keep */
  fresh?: { startCash: number; brainFrom: 'phone' | 'server' | 'none' };
}

export const LIMITS = {
  /** reads of GET /v1/bot per phone per minute (the open screen asks every few seconds) */
  readsPerMinute: 60,
  /** controls per phone per minute */
  commandsPerMinute: 20,
  /** moves / releases per phone per hour */
  movesPerHour: 6,
  /** one past test of the protection every 10 minutes */
  protectTestEveryMs: 10 * 60_000,
};

/** The server's auto-trader has not run for this long during market hours: something is wrong. */
export const STALE_RUN_MS = 3 * 60_000;
export const STALE_PRICE_MS = 2 * 60_000;

class Window {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly ms: number,
  ) {}
  /** true = allowed (and counted) */
  take(key: string, now: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.ms);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 1_000) this.hits.clear();
    return true;
  }
}

const tooMany = (what: string): BotAnswer => ({ status: 429, body: { error: 'too_many_requests', message: `Too many ${what}. Wait a minute and try again.` } });
const refused = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): BotAnswer => ({ status, body: { error, message, ...extra } });

export class CloudBot {
  private readonly reads = new Window(LIMITS.readsPerMinute, 60_000);
  private readonly commands = new Window(LIMITS.commandsPerMinute, 60_000);
  private readonly moves = new Window(LIMITS.movesPerHour, 3_600_000);
  private lastProtectTestAt = 0;

  // ---- what the runs report (BotObserver)
  private runs: number[] = [];
  private lastRunAt: number | null = null;
  private lastDecisionAt: number | null = null;
  private lastSaveAt: number | null = null;
  private lastTradeAt: number | null = null;
  private priceAt: number | null = null;
  private lastError: { at: number; message: string } | null = null;
  private lastSkip: string | null = null;
  // ---- the watchdog
  private problemSince: number | null = null;
  private alertedProblem = false;

  constructor(private readonly d: CloudBotDeps) {}

  // ---------------------------------------------------------------- who runs it

  private row(): AuthorityRow {
    return this.d.db.prepare('SELECT server_id, mode, epoch, controller_id, activated_at, changed_at FROM bot_authority WHERE id = 1').get() as unknown as AuthorityRow;
  }

  authority(): BotAuthorityView {
    const r = this.row();
    const c = r.controller_id ? this.d.devices.get(r.controller_id) : null;
    return { serverId: r.server_id, mode: r.mode, epoch: r.epoch, controller: r.controller_id ? { deviceId: r.controller_id, name: c?.name ?? '(removed phone)' } : null, activatedAt: r.activated_at, changedAt: r.changed_at };
  }

  /** For setBotGate: the server runs and changes the auto-trader only after the move (and with its jobs on). */
  gate(): BotGateAnswer {
    const r = this.row();
    if (r.mode !== 'cloud') return { run: false, write: false, reason: 'On standby: the auto-trader has not been moved to this server (the phone runs it).' };
    if (!this.d.jobs) return { run: false, write: true, reason: 'TB_JOBS is off: the server does not run the app’s jobs.' };
    return { run: true, write: true, reason: '' };
  }

  /** For setBotObserver: what every run did (the health report). */
  readonly observer: BotObserver = {
    onRun: (i: BotRunInfo) => {
      this.lastRunAt = i.at;
      this.runs.push(i.at);
      this.runs = this.runs.filter((t) => i.at - t < 10 * 60_000);
      if (i.decided) this.lastDecisionAt = i.at;
      if (i.saved) this.lastSaveAt = i.at;
      if (i.opened || i.closed) this.lastTradeAt = i.at;
      if (i.priceAt !== null) this.priceAt = i.priceAt;
      this.lastSkip = null;
    },
    onSkip: (reason: string) => {
      this.lastSkip = reason;
    },
    onError: (err: unknown, at: number) => {
      this.lastError = { at, message: errorMessage(err).slice(0, 300) };
      log.warn('Auto-trader run failed', { error: this.lastError.message });
    },
  };

  private async readBot(): Promise<BotState | null> {
    return ((await this.d.local.get('bot')).bot as BotState | null | undefined) ?? null;
  }

  // ---------------------------------------------------------------- health

  async telemetry(): Promise<BotTelemetry> {
    const now = this.d.now();
    const [m, analytics, bot, quotes] = await Promise.all([this.d.market(now), this.d.analytics(), this.readBot(), this.d.quotes()]);
    const r = this.row();
    let priceAt = this.priceAt;
    for (const q of Object.values(quotes)) if (q && q.ltp > 0 && (priceAt === null || q.fetchedAt > priceAt)) priceAt = q.fetchedAt;
    const priceAgeSec = priceAt === null ? null : Math.max(0, Math.round((now - priceAt) / 1000));
    const lastRunAt = this.lastRunAt ?? (r.mode === 'cloud' ? (bot?.lastRun || null) : null);
    const base = {
      lastRunAt,
      lastDecisionAt: this.lastDecisionAt ?? (bot?.lastDecideAt || null),
      lastSaveAt: this.lastSaveAt ?? bot?.updatedAt ?? null,
      lastTradeAt: this.lastTradeAt,
      runsLast10Min: this.runs.filter((t) => now - t < 10 * 60_000).length,
      priceAt,
      priceAgeSec,
      analytics,
      jobs: this.d.jobs,
      feedConnected: this.d.feedConnected(),
      marketPhase: m.phase,
      marketLabel: m.label,
      lastError: this.lastError,
    };
    const say = (health: BotTelemetry['health'], text: string): BotTelemetry => ({ health, text, ...base });
    if (r.mode !== 'cloud') return say('standby', 'On standby — the auto-trader has not been moved to the server (or was moved back / stopped). It is not trading here.');
    if (!this.d.jobs) return say('error', 'The server does not run the app’s jobs (TB_JOBS=off): nothing runs the auto-trader.');
    if (!this.d.hasToken) return say('error', 'The server has no Upstox token: no prices, no trades.');
    if (analytics === 'invalid') return say('error', 'Upstox refused the server’s token: no prices, no new trades. Put a new UPSTOX_ANALYTICS_TOKEN on the server.');
    if (bot && !bot.enabled) return say('paused', 'Paused — it opens nothing new, and open trades wait (their safety nets are not checked) until it is switched on again.');
    if (m.phase !== 'open') return say('closed', `Market closed (${m.label}) — it trades by itself from 9:15 am on market days (Opening rush; the other kinds from 9:30).`);
    if (this.lastError && (lastRunAt === null || this.lastError.at >= lastRunAt)) return say('error', `Its last run failed: ${this.lastError.message}`);
    if (lastRunAt === null || now - lastRunAt > STALE_RUN_MS) return say('degraded', `It has not run for ${lastRunAt === null ? 'a while' : `${Math.round((now - lastRunAt) / 60_000)} min`} — the server gets no prices (check its Upstox token and price feed).`);
    if (priceAgeSec === null || priceAgeSec * 1000 > STALE_PRICE_MS) return say('degraded', `Prices are ${priceAgeSec === null ? 'missing' : `${Math.round(priceAgeSec / 60)} min old`} — no new trades until they are fresh.`);
    return say('ok', 'Trading by itself on the server.');
  }

  /**
   * Every 30 s (a server task): a problem during market hours that lasts a minute is pushed to the
   * phones once ("not trading: prices are old…"), and once more when it is solved.
   */
  async watch(): Promise<string> {
    const t = await this.telemetry();
    const now = this.d.now();
    const bad = (t.health === 'degraded' || t.health === 'error') && t.marketPhase === 'open';
    if (!bad) {
      if (this.alertedProblem && t.health === 'ok') {
        void notify(`alert:bot-recovered-${istDate(now)}-${this.problemSince}`, { title: '🤖 Auto-trader is trading again', message: 'The server has fresh prices again and the auto-trader runs normally (pretend money).', priority: 1 }).catch(() => undefined);
      }
      this.problemSince = null;
      this.alertedProblem = false;
      return t.health;
    }
    this.problemSince ??= now;
    if (!this.alertedProblem && now - this.problemSince >= 60_000) {
      this.alertedProblem = true;
      void notify(`alert:bot-degraded-${istDate(now)}-${this.problemSince}`, { title: '⚠️ Auto-trader on the server is not trading', message: `${t.text} Open trades are not managed while prices are old.`, priority: 2 }).catch(() => undefined);
    }
    return `${t.health} (since ${Math.round((now - this.problemSince) / 1000)} s)`;
  }

  // ---------------------------------------------------------------- what a phone sees

  private async money(bot: BotState, quotes: Record<string, Quote>, today: string): Promise<BotMoney> {
    const wq = Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, { ltp: q.ltp, prevClose: q.prevClose, fetchedAt: q.fetchedAt }]));
    const s = walletSummary(bot.wallet, wq, today);
    return { total: Math.round(s.total * 100) / 100, free: Math.round(s.free * 100) / 100, todayPnl: Math.round(s.todayPnl * 100) / 100, totalPnl: Math.round(s.totalPnl * 100) / 100, startCash: bot.wallet.startCash, openCount: bot.trades.filter((t) => t.status === 'open').length };
  }

  /** GET /v1/bot. `have` = "<rev>:<updatedAt>" of the copy the phone already has: then the big part is left out. */
  async snapshot(device: Device, have: string | null): Promise<BotAnswer> {
    const now = this.d.now();
    if (!this.reads.take(device.id, now)) return tooMany('requests');
    const [bot, quotes, telemetry, protectTest] = await Promise.all([this.readBot(), this.d.quotes(), this.telemetry(), this.d.local.get('botProtectTest')]);
    const a = this.authority();
    const today = istDate(now);
    const rev = bot?.rev ?? 0;
    const updatedAt = bot?.updatedAt ?? null;
    const keys = new Set<string>();
    for (const t of bot?.trades ?? []) if (t.status === 'open') keys.add(t.key);
    for (const h of bot?.wallet.holdings ?? []) keys.add(h.key);
    for (const s of bot?.wallet.shorts ?? []) keys.add(s.key);
    const q: CloudBotSnapshot['quotes'] = {};
    for (const k of keys) if (quotes[k]) q[k] = { ltp: quotes[k]!.ltp, prevClose: quotes[k]!.prevClose, fetchedAt: quotes[k]!.fetchedAt };
    const unchanged = have !== null && have === `${rev}:${updatedAt}`;
    const body: CloudBotSnapshot = {
      api: BOT_API_VERSION,
      at: now,
      authority: a,
      you: { deviceId: device.id, canControl: a.mode === 'cloud' && a.controller?.deviceId === device.id },
      rev,
      updatedAt,
      ...(unchanged ? { unchanged: true } : { bot: bot ? botView(bot, today) : null }),
      money: bot ? await this.money(bot, quotes, today) : null,
      quotes: q,
      telemetry,
      protectTest: protectTest.botProtectTest ?? null,
    };
    return { status: 200, body: body as unknown as Record<string, unknown> };
  }

  /** What is needed before the move: the server's copy (summary + digest) and whether the server can run it. */
  async preflight(): Promise<Record<string, unknown>> {
    const now = this.d.now();
    const [bot, telemetry] = await Promise.all([this.readBot(), this.telemetry()]);
    const a = this.authority();
    const server = await summarizeBot(bot);
    const problems: string[] = [];
    if (!this.d.jobs) problems.push('The server does not run the app’s jobs (set TB_JOBS=on).');
    if (!this.d.hasToken) problems.push('The server has no Upstox token (UPSTOX_ANALYTICS_TOKEN).');
    if (telemetry.analytics === 'invalid') problems.push('Upstox refused the server’s token — put a new one on the server first.');
    const warnings: string[] = [];
    if (telemetry.marketPhase === 'open' && (telemetry.priceAgeSec === null || telemetry.priceAgeSec * 1000 > STALE_PRICE_MS)) warnings.push('The market is open but the server’s prices are not fresh.');
    if (telemetry.marketPhase !== 'open') warnings.push('The market is closed, so live prices cannot be checked now — the server’s first market minutes will show it.');
    return {
      api: BOT_API_VERSION,
      at: now,
      authority: a,
      server,
      telemetry,
      ready: problems.length === 0,
      problems,
      warnings,
      canMove: a.mode === 'standby' && problems.length === 0,
      backups: this.backups(10),
    };
  }

  // ---------------------------------------------------------------- audit and backups

  private done(deviceId: string | null, requestId: string): Record<string, unknown> | null {
    const r = this.d.db.prepare('SELECT result FROM bot_audit WHERE device_id IS ? AND request_id = ? AND ok = 1').get(deviceId, requestId) as { result: string | null } | undefined;
    return r ? (JSON.parse(r.result ?? '{}') as Record<string, unknown>) : null;
  }

  private audit(o: { deviceId: string | null; action: string; requestId?: string | null; revBefore?: number | null; revAfter?: number | null; ok: boolean; detail?: unknown; result?: unknown }): void {
    const epoch = this.row().epoch;
    this.d.db
      .prepare('INSERT INTO bot_audit (at, device_id, action, request_id, epoch, rev_before, rev_after, ok, detail, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.d.now(), o.deviceId, o.action, o.requestId ?? null, epoch, o.revBefore ?? null, o.revAfter ?? null, o.ok ? 1 : 0, o.detail === undefined ? null : JSON.stringify(o.detail), o.result === undefined ? null : JSON.stringify(o.result));
  }

  auditLog(limit = 50): Array<Record<string, unknown>> {
    const rows = this.d.db.prepare('SELECT id, at, device_id, action, request_id, epoch, rev_before, rev_after, ok, detail FROM bot_audit ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...r, ok: r.ok === 1, detail: r.detail ? JSON.parse(String(r.detail)) : null }));
  }

  private backup(reason: string, source: 'server' | 'phone', state: BotState | null, deviceId: string | null, digest: string | null): number {
    const r = this.d.db.prepare('INSERT INTO bot_backups (at, reason, source, device_id, rev, digest, state) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.d.now(), reason, source, deviceId, state?.rev ?? null, digest, state ? JSON.stringify(state) : null);
    return Number(r.lastInsertRowid);
  }

  backups(limit = 50): Array<Record<string, unknown>> {
    return this.d.db.prepare('SELECT id, at, reason, source, device_id, rev, digest, length(state) AS bytes FROM bot_backups ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as Array<Record<string, unknown>>;
  }

  backupState(id: number): { meta: Record<string, unknown>; state: BotState | null } | null {
    const r = this.d.db.prepare('SELECT id, at, reason, source, device_id, rev, digest, state FROM bot_backups WHERE id = ?').get(id) as (Record<string, unknown> & { state: string | null }) | undefined;
    if (!r) return null;
    const { state, ...meta } = r;
    return { meta, state: state ? (JSON.parse(state) as BotState) : null };
  }

  /**
   * One SQLite transaction for a move: backups, the new state, who runs it, the audit line. The state
   * the code sees changes only after the commit, so a failed move leaves everything as it was.
   */
  private async atomically(write: () => { applyBot?: () => void }): Promise<void> {
    // never inside an open IndexedDB write group (it commits on the next turn of the event loop)
    for (let i = 0; this.d.db.isTransaction && i < 200; i++) await new Promise((r) => setImmediate(r));
    if (this.d.db.isTransaction) throw new Error('The database is busy — try again.');
    this.d.db.exec('BEGIN IMMEDIATE');
    let applyBot: (() => void) | undefined;
    try {
      applyBot = write().applyBot;
      this.d.db.exec('COMMIT');
    } catch (err) {
      this.d.db.exec('ROLLBACK');
      throw err;
    }
    applyBot?.();
  }

  // ---------------------------------------------------------------- the move (phone → server)

  async cutover(device: Device, raw: unknown): Promise<BotAnswer> {
    const now = this.d.now();
    const b = (raw ?? {}) as Partial<CutoverRequest>;
    if (typeof b.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(b.requestId)) return refused(400, 'bad_request', 'requestId is missing.');
    const previous = this.done(device.id, b.requestId);
    if (previous) return { status: 200, body: { ...previous, repeated: true } }; // a retry: already done, nothing done twice
    if (!this.moves.take(device.id, now)) return tooMany('moves');
    if (b.choice !== 'import' && b.choice !== 'keep-server' && b.choice !== 'fresh') return refused(400, 'bad_request', 'choice must be import, keep-server or fresh.');
    const choice = b.choice;
    let phone: BotState | null = null;
    if (b.phone !== null && b.phone !== undefined) {
      try {
        phone = validateBotState(b.phone);
      } catch (err) {
        return refused(400, 'bad_state', `The phone’s auto-trader could not be read: ${errorMessage(err)}`);
      }
    }
    return withBotLock(async () => {
      const a = this.row();
      if (b.serverId !== a.server_id) return refused(409, 'other_server', 'This is not the server the preview was made on. Look again.');
      if (a.mode === 'cloud') return refused(409, 'already_cloud', `The auto-trader already runs on the server (controlled from ${this.authority().controller?.name ?? 'no phone'}).`, { authority: this.authority() });
      const pre = await this.preflight();
      if (!pre.ready) return refused(409, 'not_ready', (pre.problems as string[]).join(' '), { problems: pre.problems });
      const server = await this.readBot();
      const serverSum = await summarizeBot(server);
      if ((b.expectServerDigest ?? null) !== (serverSum?.digest ?? null)) return refused(409, 'server_changed', 'The server’s copy changed since the preview. Look again.');
      const phoneSum = await summarizeBot(phone);
      if ((b.phoneDigest ?? null) !== (phoneSum?.digest ?? null)) return refused(400, 'phone_changed', 'The phone’s auto-trader arrived different from the preview (it may still be running). Look again.');
      const advice = classifyCutover(phoneSum, serverSum);
      if (!advice.choices.includes(choice)) return refused(409, 'not_allowed', `“${choice}” is not possible here: ${advice.text}`);

      const at = new Date(now + 5.5 * 3_600_000).toISOString().slice(11, 16);
      const line = (text: string) => ({ at: now, kind: 'info' as const, text });
      let next: BotState;
      if (choice === 'import') {
        next = { ...phone!, log: [...phone!.log, line(`Moved to the server from ${device.name} at ${at} — it now trades there, also with the app closed.`)].slice(-150) };
      } else if (choice === 'keep-server') {
        if (!server) return refused(409, 'not_allowed', 'The server has no auto-trader to keep.');
        next = { ...server, log: [...server.log, line(`Runs on the server from ${at} (chosen on ${device.name}); the phone’s own copy was kept as a backup.`)].slice(-150) };
      } else {
        const f = b.fresh ?? { startCash: BOT_START, brainFrom: 'none' as const };
        const cash = Number.isFinite(f.startCash) && f.startCash >= 10_000 && f.startCash <= 1e11 ? Math.round(f.startCash) : BOT_START;
        const brain = f.brainFrom === 'phone' && phone ? phone.brain : f.brainFrom === 'server' && server ? server.brain : newBrain();
        const fresh = newBot(now, brain, cash);
        next = { ...fresh, log: [...fresh.log, line(`Started on the server from ${device.name} at ${at}${f.brainFrom !== 'none' ? `, keeping what the ${f.brainFrom} learned (${brain.n} trades)` : ''}.`)] };
      }
      const revBefore = server?.rev ?? 0;
      next = { ...next, rev: Math.max(revBefore, phone?.rev ?? 0) + 1, updatedAt: now };
      const nextDigest = await botDigest(next);
      const result: Record<string, unknown> = { ok: true, choice, epoch: a.epoch + 1, rev: next.rev, digest: nextDigest, at: now };
      await this.atomically(() => {
        const serverBackup = this.backup('before the move to the server', 'server', server, null, serverSum?.digest ?? null);
        const phoneBackup = this.backup(`the phone’s auto-trader at the move (${device.name})`, 'phone', phone, device.id, phoneSum?.digest ?? null);
        result.backups = { server: serverBackup, phone: phoneBackup };
        const applyBot = this.d.local.writeNow('bot', next, now);
        this.d.db.prepare("UPDATE bot_authority SET mode = 'cloud', epoch = epoch + 1, controller_id = ?, activated_at = ?, changed_at = ? WHERE id = 1").run(device.id, now, now);
        this.audit({ deviceId: device.id, action: `cutover:${choice}`, requestId: b.requestId, revBefore, revAfter: next.rev, ok: true, detail: { advice: advice.kind, phone: phoneSum, server: serverSum }, result });
        return { applyBot };
      });
      log.info(`Auto-trader moved to the server (${choice}) from ${device.name}`, { epoch: a.epoch + 1, rev: next.rev });
      return { status: 200, body: result };
    });
  }

  // ---------------------------------------------------------------- controls

  async command(device: Device, raw: unknown): Promise<BotAnswer> {
    const now = this.d.now();
    const b = (raw ?? {}) as { requestId?: unknown; command?: unknown; ifRev?: unknown };
    if (typeof b.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(b.requestId)) return refused(400, 'bad_request', 'requestId is missing.');
    const previous = this.done(device.id, b.requestId);
    if (previous) return { status: 200, body: { ...previous, repeated: true } };
    if (!this.commands.take(device.id, now)) return tooMany('controls');
    let cmd: BotCommand;
    try {
      cmd = parseCommand(b.command);
    } catch (err) {
      return refused(400, 'bad_request', errorMessage(err));
    }
    const ifRev = b.ifRev === undefined || b.ifRev === null ? undefined : Number(b.ifRev);
    if (ifRev !== undefined && !Number.isInteger(ifRev)) return refused(400, 'bad_request', 'ifRev must be a whole number.');
    if (cmd.type === 'reset' && ifRev === undefined) return refused(400, 'bad_request', 'Starting again needs ifRev (the version you looked at).');
    const a = this.authority();
    if (a.mode !== 'cloud') return refused(409, 'standby', 'The auto-trader does not run on the server right now (standby).');
    if (a.controller?.deviceId !== device.id) return refused(403, 'not_controller', `Only ${a.controller?.name ?? 'the phone that moved it'} can change the auto-trader. This phone can only look.`);
    const before = (await this.readBot())?.rev ?? 0;
    const by = { name: device.name };
    try {
      let out: unknown = { done: true };
      switch (cmd.type) {
        case 'enable':
          await botSetEnabled(cmd.enabled, now, { by, ...(ifRev !== undefined ? { ifRev } : {}) });
          break;
        case 'amount':
          out = await botSetAmount(cmd.amount, now, { by, ...(ifRev !== undefined ? { ifRev } : {}) });
          break;
        case 'rules':
          out = await botSetRules(cmd.rules, now, { by, ...(ifRev !== undefined ? { ifRev } : {}) });
          break;
        case 'reset':
          await botReset(cmd.forget, cmd.startCash, now, {
            by,
            ifRev: ifRev!,
            backup: (old) => void this.backup(`before starting again (${device.name})`, 'server', old, device.id, null),
          });
          break;
        case 'protect-test': {
          if (now - this.lastProtectTestAt < LIMITS.protectTestEveryMs) return refused(429, 'too_soon', 'The past test runs at most every 10 minutes.');
          this.lastProtectTestAt = now;
          const r = await testProtect(now, true);
          out = { ok: !!r, days: r?.days ?? 0 };
          break;
        }
        // app v1.23: switch a kind of trade off / on, and trade again after the drawdown stop
        case 'playbook':
          await botSetPlaybook(cmd.playbook, cmd.off, now, { by, ...(ifRev !== undefined ? { ifRev } : {}) });
          break;
        case 'resume':
          await botResume(now, { by, ...(ifRev !== undefined ? { ifRev } : {}) });
          break;
        default: {
          const never: never = cmd;
          return refused(400, 'bad_request', `Unknown control ${(never as { type: string }).type}.`);
        }
      }
      const after = await this.readBot();
      const result = { ok: true, type: cmd.type, result: out, rev: after?.rev ?? 0, updatedAt: after?.updatedAt ?? null };
      this.audit({ deviceId: device.id, action: `command:${cmd.type}`, requestId: b.requestId, revBefore: before, revAfter: result.rev, ok: true, detail: cmd, result });
      return { status: 200, body: result };
    } catch (err) {
      this.audit({ deviceId: device.id, action: `command:${cmd.type}`, requestId: b.requestId, revBefore: before, ok: false, detail: { command: cmd, error: errorMessage(err) } });
      if (err instanceof BotConflictError) return refused(409, 'conflict', err.message, { rev: err.rev });
      if (err instanceof BotElsewhereError) return refused(409, 'standby', err.message);
      return refused(400, 'refused', errorMessage(err));
    }
  }

  // ---------------------------------------------------------------- back to a phone

  /**
   * The controlling phone takes the auto-trader back: the server goes on standby and hands over its full
   * state. Also after an emergency stop (standby, the same phone still named): the phone gets the latest state.
   */
  async release(device: Device, raw: unknown): Promise<BotAnswer> {
    const now = this.d.now();
    const b = (raw ?? {}) as { requestId?: unknown };
    if (typeof b.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(b.requestId)) return refused(400, 'bad_request', 'requestId is missing.');
    const previous = this.done(device.id, b.requestId);
    if (previous) {
      // a retry after the release: hand over the same (frozen) state again
      const bot = await this.readBot();
      if (bot && (await botDigest(bot)) === previous.digest) return { status: 200, body: { ...previous, state: bot, repeated: true } };
      return refused(409, 'changed', 'The server’s auto-trader changed after the release (it was moved again). Look again.');
    }
    if (!this.moves.take(device.id, now)) return tooMany('moves');
    return withBotLock(async () => {
      const a = this.authority();
      if (a.controller?.deviceId !== device.id) {
        if (a.mode !== 'cloud' && !a.controller) return refused(409, 'standby', 'The auto-trader is not running on the server.');
        return refused(403, 'not_controller', `Only ${a.controller?.name ?? 'the controlling phone'} can move it back.`);
      }
      const bot = await this.readBot();
      const at = new Date(now + 5.5 * 3_600_000).toISOString().slice(11, 16);
      const state: BotState | null = bot ? { ...bot, rev: (bot.rev ?? 0) + 1, updatedAt: now, log: [...bot.log, { at: now, kind: 'info' as const, text: `Moved back to ${device.name} at ${at} — the server stopped trading it.` }].slice(-150) } : null;
      const digest = state ? await botDigest(state) : null;
      const result: Record<string, unknown> = { ok: true, rev: state?.rev ?? 0, digest, at: now };
      await this.atomically(() => {
        result.backup = this.backup(`moved back to ${device.name}`, 'server', state, device.id, digest);
        const applyBot = state ? this.d.local.writeNow('bot', state, now) : undefined;
        this.d.db.prepare("UPDATE bot_authority SET mode = 'standby', controller_id = NULL, changed_at = ? WHERE id = 1").run(now);
        this.audit({ deviceId: device.id, action: 'release', requestId: b.requestId as string, revBefore: bot?.rev ?? 0, revAfter: state?.rev ?? 0, ok: true, result });
        return applyBot ? { applyBot } : {};
      });
      log.info(`Auto-trader moved back to ${device.name}: the server is on standby`);
      return { status: 200, body: { ...result, state } };
    });
  }

  // ---------------------------------------------------------------- the owner, with the admin token

  /** Emergency stop: the server stops trading at once (phones keep showing the last state, read only). */
  async adminStandby(reason: string): Promise<BotAnswer> {
    return withBotLock(async () => {
      const a = this.row();
      if (a.mode !== 'cloud') return refused(409, 'standby', 'Already on standby.');
      const now = this.d.now();
      await this.atomically(() => {
        this.d.db.prepare("UPDATE bot_authority SET mode = 'standby', changed_at = ? WHERE id = 1").run(now);
        this.audit({ deviceId: null, action: 'admin:standby', ok: true, detail: { reason: reason.slice(0, 200) } });
        return {};
      });
      void notify(`alert:bot-standby-${now}`, { title: '🤖 Auto-trader stopped on the server', message: `The server’s owner stopped it${reason ? `: ${reason.slice(0, 120)}` : ''}. Open trades are kept but not managed until it is started again.`, priority: 2 }).catch(() => undefined);
      return { status: 200, body: { ok: true, authority: this.authority() } };
    });
  }

  /** Starts the server's auto-trader again after an emergency stop (the same state, the same or a named phone). */
  async adminResume(controllerId: string | null): Promise<BotAnswer> {
    return withBotLock(async () => {
      const a = this.row();
      if (a.mode === 'cloud') return refused(409, 'already_cloud', 'It already runs on the server.');
      if (a.epoch === 0 || !(await this.readBot())) return refused(409, 'never_moved', 'It was never moved to this server: move it from the phone (Auto-trader → Run it on my server).');
      const id = controllerId ?? a.controller_id;
      const dev = id ? this.d.devices.get(id) : null;
      if (!dev || dev.revokedAt !== null) return refused(400, 'no_controller', 'Name an active paired phone that may control it: {"controllerId": "<device id>"}.');
      const pre = await this.preflight();
      if (!pre.ready) return refused(409, 'not_ready', (pre.problems as string[]).join(' '));
      const now = this.d.now();
      await this.atomically(() => {
        this.d.db.prepare("UPDATE bot_authority SET mode = 'cloud', epoch = epoch + 1, controller_id = ?, activated_at = ?, changed_at = ? WHERE id = 1").run(dev.id, now, now);
        this.audit({ deviceId: null, action: 'admin:resume', ok: true, detail: { controller: dev.id } });
        return {};
      });
      return { status: 200, body: { ok: true, authority: this.authority() } };
    });
  }

  /** Names the phone that may change it (e.g. a new phone after the old one was lost). */
  async adminController(deviceId: string): Promise<BotAnswer> {
    const dev = this.d.devices.get(deviceId);
    if (!dev || dev.revokedAt !== null) return refused(404, 'not_found', 'No such active paired phone.');
    return withBotLock(async () => {
      await this.atomically(() => {
        this.d.db.prepare('UPDATE bot_authority SET controller_id = ?, changed_at = ? WHERE id = 1').run(dev.id, this.d.now());
        this.audit({ deviceId: null, action: 'admin:controller', ok: true, detail: { controller: dev.id, name: dev.name } });
        return {};
      });
      return { status: 200, body: { ok: true, authority: this.authority() } };
    });
  }

  /** Puts a backup back (on standby only; the current state is backed up first). */
  async adminRestore(backupId: number): Promise<BotAnswer> {
    const b = this.backupState(backupId);
    if (!b) return refused(404, 'not_found', 'No such backup.');
    if (!b.state) return refused(409, 'empty', 'That backup holds no auto-trader (there was none at the time).');
    let state: BotState;
    try {
      state = validateBotState(b.state);
    } catch (err) {
      return refused(409, 'bad_state', errorMessage(err));
    }
    return withBotLock(async () => {
      if (this.row().mode !== 'standby') return refused(409, 'running', 'Stop it first (POST /v1/bot/admin/standby): a running auto-trader is never replaced.');
      const now = this.d.now();
      const current = await this.readBot();
      const next: BotState = { ...state, rev: Math.max(current?.rev ?? 0, state.rev ?? 0) + 1, updatedAt: now };
      const result: Record<string, unknown> = { ok: true, restored: backupId, rev: next.rev };
      await this.atomically(() => {
        result.backup = this.backup(`before restoring backup ${backupId}`, 'server', current, null, null);
        const applyBot = this.d.local.writeNow('bot', next, now);
        this.audit({ deviceId: null, action: 'admin:restore', ok: true, revBefore: current?.rev ?? 0, revAfter: next.rev, detail: { backupId } });
        return { applyBot };
      });
      return { status: 200, body: result };
    });
  }

  async adminStatus(): Promise<Record<string, unknown>> {
    const bot = await this.readBot();
    return {
      api: BOT_API_VERSION,
      authority: this.authority(),
      telemetry: await this.telemetry(),
      gate: this.gate(),
      lastSkip: this.lastSkip,
      server: await summarizeBot(bot),
      devices: this.d.devices.list().map((d) => ({ id: d.id, name: d.name, appVersion: d.appVersion, lastSeenAt: d.lastSeenAt, revoked: d.revokedAt !== null })),
      backups: this.backups(20),
      audit: this.auditLog(30),
    };
  }

  /** For tests and the dry run: summary of what the server holds. */
  async summary(): Promise<BotSummary | null> {
    return summarizeBot(await this.readBot());
  }
}
