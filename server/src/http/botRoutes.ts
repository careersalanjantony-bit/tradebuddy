import type { CloudBot } from '../bot/cloudBot';
import type { Device } from '../push/devices';
import { BadRequest, type ApiResult, type RequestContext, type Router } from './router';

/**
 * App 1.22 — the cloud auto-trader's REST API (see server/src/bot/cloudBot.ts and docs/CLOUD_AUTOTRADER.md).
 *
 * A paired phone (its own device credential from the Android Keystore — never the admin token):
 *   GET  /v1/bot              the auto-trader as the server runs it (?have=<rev>:<updatedAt> leaves the big part out when unchanged)
 *   GET  /v1/bot/preflight    before the move: the server's copy (summary + digest) and whether the server can run it
 *   POST /v1/bot/cutover      the one-time move (import the phone's / keep the server's / start fresh), atomic and repeat-safe
 *   POST /v1/bot/commands     a control (switch, amount, protection, start again, past test) — only the controlling phone
 *   POST /v1/bot/release      move it back to the controlling phone (the server goes on standby)
 *   GET  /v1/bot/audit        who changed what, when
 * The owner, with TB_API_TOKEN (on the server: curl to 127.0.0.1):
 *   GET  /v1/bot/admin                    everything (who runs it, health, backups, audit)
 *   GET  /v1/bot/admin/preflight          the same preview a phone gets (the dry run before the move)
 *   POST /v1/bot/admin/standby            emergency stop {"reason": "…"}
 *   POST /v1/bot/admin/resume             start it again {"controllerId": "<device id>"} (optional)
 *   POST /v1/bot/admin/controller         {"deviceId": "<device id>"}: the phone that may change it
 *   GET  /v1/bot/admin/backups/:id        one backup, in full
 *   POST /v1/bot/admin/restore            {"backupId": n} — on standby only
 *
 * No cookies and no CORS headers (the Android app uses native HTTP); requests with a body must be JSON.
 */

/** A moved auto-trader is a few hundred KB; the limit leaves room. */
export const CUTOVER_MAX_BYTES = 4 * 1024 * 1024;

const answer = (a: { status: number; body: unknown }): ApiResult => ({ status: a.status, body: a.body });
const obj = (b: unknown): Record<string, unknown> => {
  if (b === undefined) return {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('Send a JSON object.');
  return b as Record<string, unknown>;
};

export function addBotRoutes(r: Router, bot: CloudBot): void {
  const me = (ctx: RequestContext) => ctx.device as Device;
  const device = { auth: 'device' as const, requireJson: true };

  r.add('GET', '/v1/bot', async (ctx) => answer(await bot.snapshot(me(ctx), ctx.query.get('have'))), { ...device, quiet: true });
  r.add('GET', '/v1/bot/preflight', async () => ({ body: await bot.preflight() }), device);
  r.add('POST', '/v1/bot/cutover', async (ctx) => answer(await bot.cutover(me(ctx), obj(ctx.body))), { ...device, maxBodyBytes: CUTOVER_MAX_BYTES });
  r.add('POST', '/v1/bot/commands', async (ctx) => answer(await bot.command(me(ctx), obj(ctx.body))), device);
  r.add('POST', '/v1/bot/release', async (ctx) => answer(await bot.release(me(ctx), obj(ctx.body))), device);
  r.add('GET', '/v1/bot/audit', (ctx) => ({ body: { audit: bot.auditLog(Number(ctx.query.get('limit') ?? 50) || 50) } }), device);

  // ---------- the owner (admin token)
  const admin = { requireJson: true };
  r.add('GET', '/v1/bot/admin', async () => ({ body: await bot.adminStatus() }), admin);
  r.add('GET', '/v1/bot/admin/preflight', async () => ({ body: await bot.preflight() }), admin);
  r.add('POST', '/v1/bot/admin/standby', async (ctx) => {
    const b = obj(ctx.body);
    return answer(await bot.adminStandby(typeof b.reason === 'string' ? b.reason : ''));
  }, admin);
  r.add('POST', '/v1/bot/admin/resume', async (ctx) => {
    const b = obj(ctx.body);
    if (b.controllerId !== undefined && typeof b.controllerId !== 'string') throw new BadRequest('controllerId must be a device id.');
    return answer(await bot.adminResume((b.controllerId as string | undefined) ?? null));
  }, admin);
  r.add('POST', '/v1/bot/admin/controller', async (ctx) => {
    const b = obj(ctx.body);
    if (typeof b.deviceId !== 'string' || !b.deviceId) throw new BadRequest('Give {"deviceId": "<device id from GET /v1/devices>"}.');
    return answer(await bot.adminController(b.deviceId));
  }, admin);
  r.add('GET', '/v1/bot/admin/backups/:id', ({ params }) => {
    const b = bot.backupState(Number(params.id));
    return b ? { body: b } : { status: 404, body: { error: 'not_found', message: 'No such backup.' } };
  }, admin);
  r.add('POST', '/v1/bot/admin/restore', async (ctx) => {
    const b = obj(ctx.body);
    if (!Number.isInteger(b.backupId)) throw new BadRequest('Give {"backupId": <number from GET /v1/bot/admin>}.');
    return answer(await bot.adminRestore(b.backupId as number));
  }, admin);
}
