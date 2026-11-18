import { ConfigError, loadConfig } from './config';
import { startServer, type RunningServer } from './engine';
import { createLogger } from './log';

/**
 * Process entry (systemd runs `node server/dist/main.js`).
 *  - bad configuration → exit 78, which the systemd unit does not restart (fix the env file first);
 *  - SIGTERM / SIGINT → graceful stop: no new requests, tasks finish, feed closed, data saved, exit 0;
 *  - an uncaught error → graceful stop, exit 1, and systemd starts the server again.
 */

const EXIT_CONFIG = 78;
const log = createLogger('main');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(EXIT_CONFIG);
    }
    throw err;
  }

  const server: RunningServer = await startServer(config);
  let stopping = false;

  const stop = (reason: string, code: number): void => {
    if (stopping) {
      if (reason === 'SIGINT' || reason === 'SIGTERM') process.exit(code || 1); // second signal: stop now
      return;
    }
    stopping = true;
    const force = setTimeout(() => {
      log.error(`Shutdown took longer than ${config.shutdownTimeoutMs} ms — exiting anyway`);
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();
    server.close(reason).then(
      () => process.exit(code),
      (err: unknown) => {
        log.error('Shutdown failed', { error: err });
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => stop('SIGTERM', 0));
  process.on('SIGINT', () => stop('SIGINT', 0));
  process.on('uncaughtException', (err) => {
    log.error('Uncaught error — stopping so systemd can start a clean server', { error: err });
    stop('uncaught error', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { reason });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`TradeBuddy server could not start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
