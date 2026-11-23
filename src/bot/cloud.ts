import type { BotState } from '../background/botJobs';
import { EVIDENCE } from './evidence';
import { isPlaybookId, type PlaybookId } from './playbooks';
import { PROTECT_CHOICES, type ProtectRules } from './protect';

/**
 * App v1.22 — the cloud auto-trader: what the phone and the server agree on.
 *
 * One auto-trader, one writer. Either the phone runs it (as before), or — after the owner moved it there
 * once — the user's own TradeBuddy server runs it, also with the app closed, and every paired phone only
 * shows the server's copy and sends controls to it. Pretend money only: nothing here (or anywhere in
 * TradeBuddy) places, changes or cancels an order at Upstox.
 *
 * This file is shared code: types, the snapshot the server sends, the controls a phone may send, the
 * comparison shown before the move, and the checks of an auto-trader state sent to the server.
 */

/** The version of this contract. The phone refuses a server that speaks an older one (update the server). */
export const BOT_API_VERSION = 1;

/** Whether the server runs the auto-trader: 'standby' = not (the phone does), 'cloud' = it does. */
export type BotAuthorityMode = 'standby' | 'cloud';

export interface BotAuthorityView {
  /** a random id of this server's database (the same auto-trader keeps the same id) */
  serverId: string;
  mode: BotAuthorityMode;
  /** +1 at every move to the server: a phone can tell a new cloud auto-trader from the one it knew */
  epoch: number;
  /** the phone allowed to change it (null = none: read only for every phone) */
  controller: { deviceId: string; name: string } | null;
  /** when it was moved to the server (null = never) */
  activatedAt: number | null;
  changedAt: number;
}

export type BotHealth = 'standby' | 'paused' | 'closed' | 'ok' | 'degraded' | 'error';

/** How the server's auto-trader is doing — shown on the phone, and the server's own health report. */
export interface BotTelemetry {
  health: BotHealth;
  /** in plain words */
  text: string;
  /** the last time it ran (managed trades, maybe decided) */
  lastRunAt: number | null;
  /** the last time it looked for new trades */
  lastDecisionAt: number | null;
  lastSaveAt: number | null;
  lastTradeAt: number | null;
  /** runs in the last 10 minutes (about 20 or more while the market is open) */
  runsLast10Min: number;
  /** the newest price it had, and how old it is */
  priceAt: number | null;
  priceAgeSec: number | null;
  /** the server's Upstox Analytics Token: valid / invalid / unchecked / missing */
  analytics: string;
  /** the server runs the app's jobs (TB_JOBS) */
  jobs: boolean;
  feedConnected: boolean | null;
  marketPhase: string;
  marketLabel: string;
  lastError: { at: number; message: string } | null;
}

/** Totals worked out by the server with the server's prices — the phone shows exactly these. */
export interface BotMoney {
  total: number;
  free: number;
  todayPnl: number;
  totalPnl: number;
  startCash: number;
  openCount: number;
}

/** GET /v1/bot — what a phone shows. */
export interface CloudBotSnapshot {
  api: number;
  at: number;
  authority: BotAuthorityView;
  you: { deviceId: string; canControl: boolean };
  rev: number;
  updatedAt: number | null;
  /** the auto-trader, trimmed for the screen (see botView); undefined = unchanged since `have` */
  bot?: BotState | null;
  unchanged?: boolean;
  money: BotMoney | null;
  /** the server's prices of the open trades */
  quotes: Record<string, { ltp: number; prevClose: number | null; fetchedAt: number }>;
  telemetry: BotTelemetry;
  /** the protection's past test on the server's history (null = not run yet) */
  protectTest: unknown;
}

// ---------------------------------------------------------------- the comparison before the move

export interface BotSummary {
  createdAt: number;
  rev: number;
  updatedAt: number | null;
  enabled: boolean;
  startCash: number;
  cash: number;
  openTrades: number;
  closedTrades: number;
  fills: number;
  /** finished trades it learned from, and how many it won */
  learnedFrom: number;
  wins: number;
  lastTradeAt: number | null;
  lastRun: number;
  /** SHA-256 of the whole state (without its version counters): equal = the same auto-trader */
  digest: string;
}

/** JSON with the keys of every object sorted, so the same state gives the same text everywhere. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** SHA-256 (hex) of a text — Web Crypto, on the phone and on the server. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The digest of an auto-trader: everything it holds, without the counters of its saves. */
export function botDigest(bot: BotState): Promise<string> {
  const { rev: _rev, updatedAt: _u, ...content } = bot;
  return sha256Hex(canonicalJson(content));
}

export async function summarizeBot(bot: BotState | null | undefined): Promise<BotSummary | null> {
  if (!bot) return null;
  const opened = bot.trades.map((t) => t.closedAt ?? t.openedAt);
  return {
    createdAt: bot.createdAt,
    rev: bot.rev ?? 0,
    updatedAt: bot.updatedAt ?? null,
    enabled: bot.enabled,
    startCash: bot.wallet.startCash,
    cash: bot.wallet.cash,
    openTrades: bot.trades.filter((t) => t.status === 'open').length,
    closedTrades: bot.trades.filter((t) => t.status === 'closed').length,
    fills: bot.wallet.fills.length,
    learnedFrom: bot.brain.n,
    wins: bot.brain.wins,
    lastTradeAt: opened.length ? Math.max(...opened) : null,
    lastRun: bot.lastRun,
    digest: await botDigest(bot),
  };
}

/** Anything worth keeping: a trade, a fill, something learned, or money changed from the start. */
export const hasHistory = (s: BotSummary | null): s is BotSummary => !!s && (s.openTrades + s.closedTrades + s.fills + s.learnedFrom > 0 || s.cash !== s.startCash);

/**
 * The owner's choice at the move (never a merge of two auto-traders):
 *  - 'import': the phone's auto-trader moves to the server (the server's own copy is kept as a backup)
 *  - 'keep-server': the server's auto-trader is used (the phone's is kept on the phone as a backup)
 *  - 'fresh': a new auto-trader starts on the server (both old ones are kept as backups)
 */
export type CutoverChoice = 'import' | 'keep-server' | 'fresh';

export interface CutoverAdvice {
  kind: 'nothing' | 'phone-only' | 'server-only' | 'same' | 'conflict';
  recommended: CutoverChoice;
  choices: CutoverChoice[];
  text: string;
}

export function classifyCutover(phone: BotSummary | null, server: BotSummary | null): CutoverAdvice {
  const p = hasHistory(phone);
  const s = hasHistory(server);
  if (phone && server && phone.digest === server.digest) return { kind: 'same', recommended: 'keep-server', choices: ['keep-server', 'fresh'], text: 'The phone and the server hold the same auto-trader.' };
  if (!p && !s) return { kind: 'nothing', recommended: phone ? 'import' : 'fresh', choices: phone ? ['import', 'fresh'] : ['fresh'], text: 'Neither has traded yet: it simply starts on the server.' };
  if (p && !s) return { kind: 'phone-only', recommended: 'import', choices: ['import', 'fresh'], text: 'Only the phone has trades and learning: move them to the server.' };
  if (!p && s) return { kind: 'server-only', recommended: 'keep-server', choices: ['keep-server', 'import', 'fresh'], text: 'Only the server has trades and learning: keep the server’s.' };
  return {
    kind: 'conflict',
    recommended: 'import',
    choices: ['import', 'keep-server', 'fresh'],
    text: 'Both have traded separately. Choose ONE — they are never mixed; the other is kept as a backup.',
  };
}

// ---------------------------------------------------------------- checks of a state sent to the server

/** The most a moved auto-trader may hold (the app itself keeps far less: 400 trades, 600 fills). */
const LIMITS = { trades: 2_000, fills: 5_000, orders: 2_000, log: 1_000, equity: 2_000, holdings: 500, shorts: 500 };

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const arr = (x: unknown, max: number, what: string): unknown[] => {
  if (!Array.isArray(x)) throw new Error(`${what} is missing.`);
  if (x.length > max) throw new Error(`${what}: too many entries (${x.length}).`);
  return x;
};

/**
 * Checks that `x` is an auto-trader state the app can run (the shape the app itself saves). Throws an
 * Error with a plain message. It does not judge the trades — they are the owner's own history.
 */
/** A practice wallet's shape (the real one or the shadow one). */
function checkWallet(w: unknown, what: string): void {
  const x = w as Record<string, unknown> | undefined;
  if (!x || typeof x !== 'object' || x.v !== 1 || !num(x.cash) || !num(x.startCash) || !num(x.createdAt)) throw new Error(`${what} is not valid.`);
  arr(x.holdings, LIMITS.holdings, `${what}: holdings`);
  arr(x.orders, LIMITS.orders, `${what}: orders`);
  arr(x.fills, LIMITS.fills, `${what}: fills`);
  if (x.shorts !== undefined) arr(x.shorts, LIMITS.shorts, `${what}: shorts`);
}

/** A list of trades: each with its id, stock, side, status and prices; no id twice. */
function checkTrades(list: unknown, what: string): void {
  const trades = arr(list, LIMITS.trades, what);
  for (const t of trades) {
    const r = t as Record<string, unknown>;
    if (!r || typeof r.id !== 'string' || typeof r.key !== 'string' || typeof r.symbol !== 'string' || (r.side !== 'long' && r.side !== 'short') || (r.status !== 'open' && r.status !== 'closed') || !num(r.qty) || !num(r.entry) || !num(r.stop) || !num(r.target)) {
      throw new Error(`A trade in its record is not valid (${what}).`);
    }
  }
  if (new Set(trades.map((t) => (t as { id: string }).id)).size !== trades.length) throw new Error(`Two trades have the same id (${what}).`);
}

/**
 * Checks that `x` is an auto-trader state the app can run (the shape the app itself saves). Throws an
 * Error with a plain message. It does not judge the trades — they are the owner's own history.
 */
export function validateBotState(x: unknown): BotState {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('The auto-trader state is not an object.');
  const b = x as Record<string, unknown>;
  if (b.v !== 1) throw new Error('Unknown auto-trader version.');
  if (typeof b.enabled !== 'boolean') throw new Error('enabled is missing.');
  if (!num(b.createdAt) || !num(b.lastRun) || !num(b.lastDecideAt)) throw new Error('Its times are missing.');
  checkWallet(b.wallet, 'Its practice wallet');
  const brain = b.brain as Record<string, unknown> | undefined;
  if (!brain || brain.v !== 1 || !Array.isArray(brain.w) || !Array.isArray(brain.w0) || !num(brain.n) || !num(brain.wins) || !brain.by || typeof brain.by !== 'object') throw new Error('What it learned (its brain) is not valid.');
  if (!(brain.w as unknown[]).every(num) || !(brain.w0 as unknown[]).every(num)) throw new Error('Its brain has numbers that are not numbers.');
  checkTrades(b.trades, 'trades');
  arr(b.log, LIMITS.log, 'log');
  arr(b.equity, LIMITS.equity, 'equity');
  const day = b.day as Record<string, unknown> | undefined;
  if (!day || typeof day.date !== 'string' || !num(day.opened)) throw new Error('Its day counter is not valid.');
  // app v1.23: shadow trades and the evidence of each kind of trade (both optional)
  if (b.shadow !== undefined) {
    const sh = b.shadow as Record<string, unknown> | null;
    if (!sh || typeof sh !== 'object' || Array.isArray(sh)) throw new Error('Its shadow trades are not valid.');
    checkWallet(sh.wallet, 'Its shadow wallet');
    checkTrades(sh.trades, 'shadow trades');
    const sd = sh.day as Record<string, unknown> | undefined;
    if (!sd || typeof sd.date !== 'string' || !num(sd.opened)) throw new Error('Its shadow day counter is not valid.');
  }
  if (b.samples !== undefined) {
    const sm = b.samples as Record<string, unknown> | null;
    if (!sm || typeof sm !== 'object' || Array.isArray(sm)) throw new Error('Its evidence is not valid.');
    for (const [id, list] of Object.entries(sm)) {
      if (!isPlaybookId(id)) throw new Error(`Unknown kind of trade in its evidence: ${id}.`);
      for (const v of arr(list, EVIDENCE.window, `evidence of ${id}`)) {
        const r = v as Record<string, unknown>;
        if (!r || !num(r.at) || !num(r.grossR) || !num(r.netR)) throw new Error(`A result in the evidence of ${id} is not valid.`);
      }
    }
  }
  return x as BotState;
}

/**
 * The auto-trader trimmed for the screen (a phone asks for it every few seconds): every open trade, the
 * latest finished trades, today's and the latest fills, the latest log lines; the brain, the equity curve,
 * the rules and the protection state in full. The money totals come separately, worked out on the full state.
 */
export function botView(bot: BotState, today: string): BotState {
  const open = bot.trades.filter((t) => t.status === 'open');
  const closed = bot.trades.filter((t) => t.status === 'closed').slice(-60);
  const keep = new Set([...open, ...closed].map((t) => t.id));
  const fills = bot.wallet.fills.filter((f, i, all) => f.date === today || i >= all.length - 120);
  // app v1.23: shadow trades — every open one and the latest 30 finished; no fills or orders
  const sh = bot.shadow;
  const shadow = sh ? { ...sh, trades: [...sh.trades.filter((t) => t.status === 'open'), ...sh.trades.filter((t) => t.status === 'closed').slice(-30)], wallet: { ...sh.wallet, fills: [], orders: [] } } : undefined;
  return {
    ...bot,
    trades: bot.trades.filter((t) => keep.has(t.id)),
    wallet: { ...bot.wallet, fills, orders: bot.wallet.orders.filter((o) => o.status === 'open') },
    log: bot.log.slice(-60),
    ...(shadow ? { shadow } : {}),
  };
}

// ---------------------------------------------------------------- controls a phone may send

export type BotCommand =
  | { type: 'enable'; enabled: boolean }
  | { type: 'amount'; amount: number }
  | { type: 'rules'; rules: Partial<ProtectRules> }
  | { type: 'reset'; forget: boolean; startCash: number }
  | { type: 'protect-test' }
  /** app v1.23: switch one kind of trade off (no trades, not even shadow ones) or on again */
  | { type: 'playbook'; playbook: PlaybookId; off: boolean }
  /** app v1.23: trade again after the drawdown brake stopped it */
  | { type: 'resume' };

const RULE_KEYS = ['on', 'lockStartPct', 'dayLossPct', 'swingSharePct', 'quickExitMin', 'proveFirst'] as const;

/** Checks a control sent by a phone (throws an Error with a plain message). */
export function parseCommand(x: unknown): BotCommand {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('Send a control as a JSON object.');
  const c = x as Record<string, unknown>;
  switch (c.type) {
    case 'enable':
      if (typeof c.enabled !== 'boolean') throw new Error('enabled must be true or false.');
      return { type: 'enable', enabled: c.enabled };
    case 'amount':
      if (!num(c.amount) || c.amount < 10_000 || c.amount > 1e11) throw new Error('Enter an amount of at least ₹10,000.');
      return { type: 'amount', amount: Math.round(c.amount) };
    case 'rules': {
      const r = c.rules as Record<string, unknown> | undefined;
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('rules must be an object.');
      const out: Partial<ProtectRules> = {};
      for (const k of Object.keys(r)) {
        if (!(RULE_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown protection setting: ${k}.`);
      }
      if (r.on !== undefined) {
        if (typeof r.on !== 'boolean') throw new Error('on must be true or false.');
        out.on = r.on;
      }
      // app v1.24: prove each kind of trade first with shadow trades (true) or buy small while it learns (false)
      if (r.proveFirst !== undefined) {
        if (typeof r.proveFirst !== 'boolean') throw new Error('proveFirst must be true or false.');
        out.proveFirst = r.proveFirst;
      }
      for (const k of ['lockStartPct', 'dayLossPct', 'swingSharePct', 'quickExitMin'] as const) {
        if (r[k] === undefined) continue;
        if (!(PROTECT_CHOICES[k] as readonly number[]).includes(r[k] as number)) throw new Error(`${k} must be one of ${PROTECT_CHOICES[k].join(', ')}.`);
        out[k] = r[k] as number;
      }
      if (!Object.keys(out).length) throw new Error('Nothing to change.');
      return { type: 'rules', rules: out };
    }
    case 'reset':
      if (typeof c.forget !== 'boolean') throw new Error('forget must be true or false.');
      if (!num(c.startCash) || c.startCash < 10_000 || c.startCash > 1e11) throw new Error('Start with at least ₹10,000.');
      return { type: 'reset', forget: c.forget, startCash: Math.round(c.startCash) };
    case 'protect-test':
      return { type: 'protect-test' };
    case 'playbook':
      if (!isPlaybookId(c.playbook)) throw new Error('Unknown kind of trade.');
      if (typeof c.off !== 'boolean') throw new Error('off must be true or false.');
      return { type: 'playbook', playbook: c.playbook, off: c.off };
    case 'resume':
      return { type: 'resume' };
    default:
      throw new Error('Unknown control.');
  }
}

/** A request id from the phone (repeating a request with the same id never does it twice). */
export const isRequestId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v);
