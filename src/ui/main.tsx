import { render } from 'preact';
import { createLogger } from '../lib/log';
import { initLogging } from '../lib/logSetup';
import { App } from './App';
import { initTheme } from './theme';

/** Wait for storage migrations before reading or applying the first theme. */
export async function startUi(backgroundReady: Promise<void>): Promise<void> {
  await backgroundReady;
  initLogging('sidepanel');
  await initTheme();
  createLogger('ui').info('App screens opened');
  render(<App />, document.getElementById('app')!);
}
