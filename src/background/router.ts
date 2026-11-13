import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { isApiRequest, type ApiMap, type ApiResponse, type ApiType } from '../shared/messages';

export type Handlers = {
  [K in ApiType]: (payload: ApiMap[K]['req'], sender: chrome.runtime.MessageSender) => Promise<ApiMap[K]['res']>;
};

const log = createLogger('router');

/**
 * Registers the message listener. Must be called synchronously at the top level of the
 * service worker so Chrome can deliver messages that wake it up.
 * Handlers wait for `ready` (startup) unless the message is `ping`/`status:get`.
 */
export function registerRouter(handlers: Handlers, ready: Promise<unknown>): void {
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isApiRequest(msg)) return false;
    // Only accept messages from our own extension pages.
    if (sender.id !== chrome.runtime.id) return false;
    const { type, payload } = msg;
    const handler = handlers[type] as (p: unknown, s: chrome.runtime.MessageSender) => Promise<unknown>;
    if (!handler) {
      sendResponse({ ok: false, error: `Unknown message type: ${type}` } satisfies ApiResponse<never>);
      return false;
    }
    const waitForReady = type === 'ping' || type === 'status:get' ? Promise.resolve() : ready;
    waitForReady
      .then(() => handler(payload, sender))
      .then(
        (data) => sendResponse({ ok: true, data }),
        (err: unknown) => {
          log.warn(`Handler "${type}" failed`, { error: err });
          sendResponse({ ok: false, error: errorMessage(err) });
        },
      );
    return true; // async response
  });
}
