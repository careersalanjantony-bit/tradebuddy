import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { notify } from '../notify/chrome';
import { appFetch } from '../platform/http';
import { getLocal, setLocal } from '../storage/local';
import { availableUpdate, CHECK_EVERY_MS, checkDue, LATEST_JSON_URL, parseLatest, type UpdateState } from '../update/update';

/**
 * App v1.5: looks for a newer TradeBuddy on its GitHub updates branch (on start, then every 5 minutes since v1.8,
 * and on "Check now"). Read-only: one small file download. Installing is done on the screen, only
 * when the owner taps Update, and Android asks before it installs anything.
 */

declare const __APP_VERSION__: string;
const log = createLogger('update');
let running = false;

export async function checkForUpdate(now = Date.now(), force = false): Promise<UpdateState> {
  const prev = await getLocal('appUpdate');
  if (running || !checkDue(prev, now, force)) return prev ?? { checkedAt: 0, latest: null };
  running = true;
  try {
    const res = await appFetch(`${LATEST_JSON_URL}?t=${Math.floor(now / 60_000)}`, { headers: { Accept: 'application/json' }, timeoutMs: 20_000 });
    if (res.status === 404) {
      // no release published yet
      const s: UpdateState = { checkedAt: now, latest: null, ...(prev?.notified ? { notified: prev.notified } : {}) };
      await setLocal('appUpdate', s);
      return s;
    }
    if (!res.ok) throw new Error(`the updates page answered ${res.status}`);
    const latest = parseLatest(await res.json());
    if (!latest) throw new Error('the update description could not be read');
    const s: UpdateState = { checkedAt: now, latest, ...(prev?.notified ? { notified: prev.notified } : {}) };
    const offer = availableUpdate(s, __APP_VERSION__);
    if (offer && prev?.notified !== offer.version) {
      await notify(`alert:update-${offer.version}`, {
        title: `TradeBuddy ${offer.version} is ready`,
        message: `${offer.notes[0] ?? 'A new version is ready.'} Open TradeBuddy and tap "Update now" — your data stays.`,
        priority: 1,
      });
      s.notified = offer.version;
    }
    await setLocal('appUpdate', s);
    if (offer) log.info(`Update available: ${offer.version} (you have ${__APP_VERSION__})`);
    return s;
  } catch (err) {
    const s: UpdateState = { ...(prev ?? { latest: null }), checkedAt: now, error: `Could not check for updates: ${errorMessage(err)}` };
    await setLocal('appUpdate', s);
    log.info('Update check failed', { reason: errorMessage(err) });
    return s;
  } finally {
    running = false;
  }
}

/** On start (a little after the screens) and then every 5 minutes. */
export function startUpdateChecks(): void {
  setTimeout(() => void checkForUpdate().catch(() => undefined), 8_000);
  setInterval(() => void checkForUpdate().catch(() => undefined), CHECK_EVERY_MS);
}
