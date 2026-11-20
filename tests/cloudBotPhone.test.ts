import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { learnFrom, newBrain } from '../src/bot/brain';
import { botDigest, parseCommand } from '../src/bot/cloud';
import { BotElsewhereError, botSetEnabled, getBot, newBot, runBot, type BotState } from '../src/background/botJobs';
import { istEpoch } from '../src/lib/time';
import { CloudBot } from '../server/src/bot/cloudBot';
import { DeviceStore, type Device } from '../server/src/push/devices';
import { SqliteKV } from '../server/src/storage/kv';
import { openStore, type Store } from '../server/src/storage/sqlite';
import { tempDir } from '../server/tests/helpers';

/**
 * App v1.22 — the PHONE's side of the cloud auto-trader, against the server's real CloudBot (its own
 * SQLite file, its own storage — not the phone's). Every request goes through a stand-in "network" that
 * copies the request and the answer as JSON (like the wire) and can drop an answer after the server
 * acted (the case that matters: did it happen or not?). What is proved: the phone never runs a second
 * auto-trader, the move and the way back are repeat-safe, and a clear "no" is the only thing that lets
 * the phone's own auto-trader run again.
 */

const h = vi.hoisted(() => ({
  request: null as null | ((path: string, method: string, body?: unknown) => Promise<unknown>),
  categories: null as string[] | null,
}));

vi.mock('../src/platform/push', () => {
  class CloudError extends Error {
    override name = 'CloudError';
    constructor(
      message: string,
      readonly status?: number,
      readonly code: string | null = null,
      readonly data: unknown = null,
    ) {
      super(message);
    }
  }
  return {
    CloudError,
    cloudRequest: (path: string, method: string, body?: unknown) => h.request!(path, method, body),
    // like the real one: sends the choices and keeps them on the phone
    syncPreferences: async (cats?: string[]) => {
      h.categories = cats ?? null;
      if (!cats) return;
      const area = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, any>>; set(o: object): Promise<void> } } } }).chrome.storage.local;
      const c = (await area.get('cloud')).cloud;
      await area.set({ cloud: { ...c, categories: cats } });
    },
  };
});

const jobs = await import('../src/background/cloudBotJobs');
const { CloudError } = (await import('../src/platform/push')) as unknown as { CloudError: new (m: string, s?: number, c?: string | null, d?: unknown) => Error & { status?: number } };

const DAY = '2026-11-23';
const NOW = istEpoch(DAY, '10:00');
const AAA = 'NSE_EQ|INE000A01AAA';

let chrome: ReturnType<typeof installChromeMock>;
let tmp: ReturnType<typeof tempDir>;
let store: Store;
let serverLocal: SqliteKV;
let devices: DeviceStore;
let server: CloudBot;
let device: Device;
const net = { offline: false, lose: 0, calls: [] as Array<{ path: string; method: string; body: any }>, analytics: 'valid', commands: [] as any[] };

/** The stand-in network: the request and the answer travel as JSON; `lose` drops answers AFTER the server acted. */
async function wire(path: string, method: string, body?: unknown): Promise<unknown> {
  const sentBody = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
  net.calls.push({ path, method, body: sentBody });
  if (net.offline) throw new CloudError('The server could not be reached.');
  const [p, q] = path.split('?');
  let ans: { status: number; body: any };
  if (method === 'GET' && p === '/v1/bot') ans = await server.snapshot(device, new URLSearchParams(q ?? '').get('have'));
  else if (method === 'GET' && p === '/v1/bot/preflight') ans = { status: 200, body: await server.preflight() };
  else if (method === 'POST' && p === '/v1/bot/cutover') ans = await server.cutover(device, sentBody);
  else if (method === 'POST' && p === '/v1/bot/release') ans = await server.release(device, sentBody);
  else if (method === 'POST' && p === '/v1/bot/commands') {
    // the server's own command path uses the server process's storage; here a stand-in applies it
    const seen = net.commands.find((c) => c.requestId === sentBody.requestId);
    if (seen) ans = { status: 200, body: { ...seen.answer, repeated: true } };
    else {
      const cmd = parseCommand(sentBody.command);
      const bot = (await serverLocal.get('bot')).bot as BotState;
      if (cmd.type === 'reset' && sentBody.ifRev !== bot.rev) ans = { status: 409, body: { error: 'conflict', message: 'changed', rev: bot.rev } };
      else {
        if (cmd.type === 'enable') await serverLocal.set({ bot: { ...bot, enabled: cmd.enabled, rev: (bot.rev ?? 0) + 1, updatedAt: Date.now() } });
        ans = { status: 200, body: { ok: true, type: cmd.type, result: { done: true }, rev: (bot.rev ?? 0) + 1 } };
        net.commands.push({ requestId: sentBody.requestId, answer: ans.body });
      }
    }
  } else ans = { status: 404, body: { error: 'not_found', message: 'No such address.' } };
  if (net.lose > 0) {
    net.lose--;
    throw new CloudError('The request timed out.');
  }
  if (ans.status >= 400) throw new CloudError(ans.body.message, ans.status, ans.body.error, ans.body);
  return JSON.parse(JSON.stringify(ans.body));
}

/** The phone's auto-trader: ₹1 lakh, learned from one winning trade, with history. */
function phoneBot(): BotState {
  let brain = newBrain();
  brain = learnFrom(brain, [0.6, 0.1, 0.2, 0, 0, 0, 0, 0, 0, 0], true, 1.4, 1_200, 'day-buy').brain;
  const b = newBot(NOW - 86_400_000, brain, 100_000);
  return { ...b, wallet: { ...b.wallet, cash: 101_200 }, log: [...b.log, { at: NOW - 3_600_000, kind: 'close', text: 'Sold AAA — target reached: +₹1,200' }], lastRun: NOW - 60_000, lastDecideAt: NOW - 60_000, rev: 3, updatedAt: NOW - 60_000 };
}

const local = async <T>(k: string) => (await chrome.storage.local.get(k))[k] as T;

beforeAll(() => {
  h.request = wire;
});

beforeEach(async () => {
  chrome = installChromeMock();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  tmp = tempDir();
  store = openStore(tmp.dir);
  serverLocal = new SqliteKV(store.db, 'local');
  devices = new DeviceStore(store.db, () => Date.now());
  device = devices.pair(devices.issuePairingCode().code, { name: 'Alan phone', platform: 'android', appVersion: '1.22.0' })!.device;
  server = new CloudBot({ db: store.db, local: serverLocal, devices, now: () => Date.now(), jobs: true, hasToken: true, analytics: async () => net.analytics, market: async () => ({ phase: 'open', label: 'open' }), quotes: async () => ({}), feedConnected: () => true });
  Object.assign(net, { offline: false, lose: 0, calls: [], analytics: 'valid', commands: [] });
  h.categories = null;
  jobs.installPhoneBotGate();
  await chrome.storage.local.set({ bot: phoneBot(), botCloud: null, botArchive: null, cloud: { serverUrl: 'https://tb.example.com', deviceId: device.id, name: 'Alan phone', pairedAt: 1, categories: ['rising', 'system'], tokenSentAt: 2, lastError: null } });
});

afterAll(() => {
  tmp?.cleanup();
});

const moveImport = async () => {
  const preview = await jobs.cloudBotPreview(NOW);
  return { preview, link: await jobs.cloudBotMove('import', preview, undefined, NOW) };
};

describe('the phone and the cloud auto-trader', () => {
  it('not moved: the phone’s own auto-trader runs as always', async () => {
    await botSetEnabled(false, NOW);
    expect((await local<BotState>('bot')).enabled).toBe(false);
  });

  it('the preview shows both sides and what is possible — and changes nothing', async () => {
    const p = await jobs.cloudBotPreview(NOW);
    expect(p.phone).toMatchObject({ startCash: 100_000, learnedFrom: 1, wins: 1 });
    expect(p.server).toMatchObject({ ready: true, canMove: true, authority: { mode: 'standby' }, server: null });
    expect(p.advice).toMatchObject({ kind: 'phone-only', recommended: 'import' });
    expect(await local('botCloud')).toBeNull();
  });

  it('the move: the phone sends exactly its auto-trader, keeps a copy, then never runs one of its own again', async () => {
    const before = await local<BotState>('bot');
    const { link } = await moveImport();
    expect(link).toMatchObject({ mode: 'cloud', serverId: server.authority().serverId, epoch: 1 });
    const sent = net.calls.find((c) => c.path === '/v1/bot/cutover')!.body;
    expect(sent.phone).toEqual(JSON.parse(JSON.stringify(before)));
    expect(sent.phoneDigest).toBe(await botDigest(before));
    expect(await local('bot')).toBeNull(); // no second auto-trader on the phone
    const archive = await local<Array<{ state: BotState; reason: string }>>('botArchive');
    expect(archive.at(-1)!.state).toEqual(before);
    expect(server.authority()).toMatchObject({ mode: 'cloud', controller: { deviceId: device.id } });
    // the screen shows the server's copy: the same trades, money and learning
    expect(link.snapshot!.bot!.brain).toEqual(before.brain);
    expect(link.snapshot!.you.canControl).toBe(true);
    // the server's auto-trader alerts now come to this phone
    expect(h.categories).toEqual(['rising', 'system', 'autotrader']);
  });

  it('in cloud mode nothing on the phone runs or changes an auto-trader (polls, resume, retries)', async () => {
    await moveImport();
    await chrome.storage.session.set({ quotes: { [AAA]: { key: AAA, ltp: 100.1, open: 100, high: 100.2, low: 99.9, volume: 1, prevClose: 99, fetchedAt: NOW } }, daySignals: { date: DAY, signals: [{ id: 'S', key: AAA, symbol: 'AAA', side: 'long', at: NOW - 20_000, barT: 599, entry: 100, stop: 99, target: 102.2, rvol: 2, orHigh: 100, orLow: 99, trusted: true, chance: 0.64 }] } });
    expect(await runBot(NOW)).toBeNull();
    expect(await runBot(NOW + 60_000, true)).toBeNull();
    expect(await local('bot')).toBeNull();
    await expect(botSetEnabled(false, NOW)).rejects.toBeInstanceOf(BotElsewhereError);
    // what reads the auto-trader on the phone (ideas, the past test) reads the server's copy
    expect((await getBot(NOW)).brain.n).toBe(1);
  });

  it('the answer to the move got lost: the phone stays stopped, sends the SAME request again, the server does it once', async () => {
    const preview = await jobs.cloudBotPreview(NOW);
    net.lose = 1;
    await expect(jobs.cloudBotMove('import', preview, undefined, NOW)).rejects.toThrow(/timed out/);
    const pending = await local<{ mode: string; lastError: string; pending: { requestId: string } }>('botCloud');
    expect(pending.mode).toBe('pending');
    expect(pending.lastError).toMatch(/Not sure the server got it/);
    expect(await runBot(NOW)).toBeNull(); // stopped while not sure
    expect(server.authority().mode).toBe('cloud'); // the server did take it
    const link = await jobs.sendMove();
    expect(link.mode).toBe('cloud');
    const ids = net.calls.filter((c) => c.path === '/v1/bot/cutover').map((c) => c.body.requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(server.backups()).toHaveLength(2); // one move, not two
  });

  it('a clear "no" from the server: nothing moved, the phone’s own auto-trader runs again exactly as it was', async () => {
    const before = await local<BotState>('bot');
    const preview = await jobs.cloudBotPreview(NOW);
    net.analytics = 'invalid'; // the server's token was refused between the preview and the move
    await expect(jobs.cloudBotMove('import', { ...preview, server: { ...preview.server, canMove: true } }, undefined, NOW)).rejects.toThrow(/refused/);
    expect(await local('botCloud')).toBeNull();
    expect(await local('bot')).toEqual(before);
    expect(server.authority().mode).toBe('standby');
    await botSetEnabled(false, NOW); // runs here again
  });

  it('the phone traded after the preview: refused before anything is stopped', async () => {
    const preview = await jobs.cloudBotPreview(NOW);
    const b = await local<BotState>('bot');
    await chrome.storage.local.set({ bot: { ...b, wallet: { ...b.wallet, cash: 99_000 } } });
    await expect(jobs.cloudBotMove('import', preview, undefined, NOW)).rejects.toThrow(/changed since you looked/);
    expect(await local('botCloud')).toBeNull();
    expect(server.authority().mode).toBe('standby');
  });

  it('cancelling a move whose answer never came asks the server first', async () => {
    const preview = await jobs.cloudBotPreview(NOW);
    net.offline = true;
    await expect(jobs.cloudBotMove('import', preview, undefined, NOW)).rejects.toThrow();
    await expect(jobs.cancelMove()).rejects.toThrow(/stays stopped so there are never two/);
    expect((await local<{ mode: string }>('botCloud')).mode).toBe('pending');
    net.offline = false;
    expect(await jobs.cancelMove()).toBe('cancelled'); // the server never got it (standby)
    expect(await local('botCloud')).toBeNull();
    // and when the server DID take it, "cancel" finishes the move instead of making a second auto-trader
    const p2 = await jobs.cloudBotPreview(NOW);
    net.lose = 1;
    await expect(jobs.cloudBotMove('import', p2, undefined, NOW)).rejects.toThrow();
    expect(await jobs.cancelMove()).toBe('moved');
    expect((await local<{ mode: string }>('botCloud')).mode).toBe('cloud');
  });

  it('refreshing asks only for what changed; offline keeps the last copy; another server is never mixed in', async () => {
    const { link } = await moveImport();
    const again = (await jobs.refreshCloudBot(NOW + 5_000))!;
    expect(net.calls.at(-1)!.path).toBe(`/v1/bot?have=${encodeURIComponent(`${link.snapshot!.rev}:${link.snapshot!.updatedAt}`)}`);
    expect(again.snapshot!.bot).toEqual(link.snapshot!.bot);
    net.offline = true;
    const off = (await jobs.refreshCloudBot(NOW + 10_000))!;
    expect(off.lastError).toMatch(/could not be reached/);
    expect(off.snapshot!.bot).toEqual(link.snapshot!.bot);
    expect(off.fetchedAt).toBe(NOW + 5_000);
    net.offline = false;
    await chrome.storage.local.set({ botCloud: { ...off, serverId: 'another-server' } });
    const other = (await jobs.refreshCloudBot(NOW + 15_000))!;
    expect(other.lastError).toMatch(/not the server the auto-trader was moved to/);
    expect(other.snapshot!.bot).toEqual(link.snapshot!.bot);
  });

  it('controls go to the server: starting again carries the version seen; a lost answer is retried with the same id', async () => {
    const { link } = await moveImport();
    await jobs.cloudBotCommand({ type: 'reset', forget: false, startCash: 100_000 });
    const reset = net.calls.find((c) => c.path === '/v1/bot/commands')!.body;
    expect(reset.ifRev).toBe(link.snapshot!.rev);
    net.lose = 1;
    await jobs.cloudBotCommand({ type: 'enable', enabled: false });
    const enables = net.calls.filter((c) => c.path === '/v1/bot/commands' && c.body.command.type === 'enable');
    expect(enables).toHaveLength(2);
    expect(enables[0]!.body.requestId).toBe(enables[1]!.body.requestId);
    expect(net.commands.filter((c) => c.answer.type === 'enable')).toHaveLength(1);
    expect(enables[0]!.body.ifRev).toBeUndefined();
  });

  it('a phone that only looks cannot send controls', async () => {
    await moveImport();
    const l = await local<any>('botCloud');
    await chrome.storage.local.set({ botCloud: { ...l, snapshot: { ...l.snapshot, you: { ...l.snapshot.you, canControl: false } } } });
    await expect(jobs.cloudBotCommand({ type: 'enable', enabled: false })).rejects.toThrow(/only shows it/);
  });

  it('back to the phone: the full state comes back, the server stops, the phone runs it again — repeat-safe', async () => {
    await moveImport();
    net.lose = 1;
    await expect(jobs.cloudBotRelease(NOW)).rejects.toThrow(/timed out/);
    expect(server.authority().mode).toBe('standby');
    expect((await local<{ mode: string }>('botCloud')).mode).toBe('cloud'); // not sure yet: still not running here
    const state = await jobs.cloudBotRelease(NOW);
    const ids = net.calls.filter((c) => c.path === '/v1/bot/release').map((c) => c.body.requestId);
    expect(new Set(ids).size).toBe(1);
    expect(await local('botCloud')).toBeNull();
    expect(await local('bot')).toEqual(state);
    expect(state!.log.at(-1)!.text).toMatch(/Moved back to Alan phone/);
    expect(h.categories).toEqual(['rising', 'system']);
    await botSetEnabled(true, NOW); // the phone runs it again
  });

  it('another phone joins to look; leaving brings its own (kept) auto-trader back, paused', async () => {
    // the owner's other phone moved it; this one joins
    const other = devices.pair(devices.issuePairingCode().code, { name: 'Other phone', platform: 'android', appVersion: '1.22.0' })!.device;
    const keep = device;
    device = other;
    await moveImport();
    device = keep;
    await chrome.storage.local.set({ bot: phoneBot(), botCloud: null });
    const p = await jobs.cloudBotPreview(NOW);
    expect(p.advice).toBeNull(); // already on the server: only joining is possible
    const link = await jobs.cloudBotJoin(NOW);
    expect(link.snapshot!.you.canControl).toBe(false);
    expect(await local('bot')).toBeNull();
    await expect(runBot(NOW)).resolves.toBeNull();
    const back = (await jobs.cloudBotLeave(NOW))!;
    expect(back.enabled).toBe(false);
    expect(back.brain).toEqual(phoneBot().brain);
    expect(await local('botCloud')).toBeNull();
  });

  it('emergency: the server cannot be reached — taking the copy back leaves it PAUSED with a plain warning', async () => {
    await moveImport();
    net.offline = true;
    await expect(jobs.botBeforeUnpair(false)).rejects.toThrow();
    expect((await local<{ mode: string }>('botCloud')).mode).toBe('cloud');
    await jobs.botBeforeUnpair(true);
    const b = await local<BotState>('bot');
    expect(b.enabled).toBe(false);
    expect(b.log.at(-1)!.text).toMatch(/WITHOUT the server's confirmation/);
    expect(await local('botCloud')).toBeNull();
  });
});
