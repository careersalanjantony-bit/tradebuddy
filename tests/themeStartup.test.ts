import { render } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { chromeLocalKV } from '../src/storage/kv';
import { getSettings, updateSettings } from '../src/storage/local';
import { LOCAL_SCHEMA_VERSION, runLocalMigrations } from '../src/storage/migrations';
import { startUi } from '../src/ui/main';
import { installChromeMock } from './chromeMock';

vi.mock('preact', async (importOriginal) => ({
  ...await importOriginal<typeof import('preact')>(),
  render: vi.fn(),
}));
vi.mock('../src/ui/App', () => ({ App: () => null }));
vi.mock('../src/lib/logSetup', () => ({ initLogging: vi.fn() }));
vi.mock('../src/lib/log', () => ({ createLogger: () => ({ info: vi.fn() }) }));

const attributes = new Map<string, string>();
const look = new Map<string, string>();

beforeEach(() => {
  installChromeMock();
  vi.clearAllMocks();
  attributes.clear();
  look.clear();
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    },
    getElementById: () => ({}),
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => look.get(key) ?? null,
    setItem: (key: string, value: string) => look.set(key, value),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('finishes a delayed dark-theme migration before persisting and rendering the first-run light theme', async () => {
  await chromeLocalKV.set({
    meta: { schemaVersion: 10, installedAt: 1, lastMigratedAt: 1 },
    settings: DEFAULT_SETTINGS,
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const write = chromeLocalKV.set;
  const migrating = vi.spyOn(chromeLocalKV, 'set').mockImplementation(async (items) => {
    if ('bot' in items) await paused;
    await write(items);
  });

  const startup = runLocalMigrations(chromeLocalKV);
  let firstRenderTheme: string | undefined;
  vi.mocked(render).mockImplementationOnce(() => { firstRenderTheme = attributes.get('data-theme'); });
  const mounted = startUi(startup.then(() => undefined));
  try {
    await vi.waitFor(() => expect(migrating).toHaveBeenCalledWith({ bot: null }));
    expect(render).not.toHaveBeenCalled();
    expect(look.has('tb-look-2')).toBe(false);
  } finally {
    release();
    await startup;
    await mounted;
  }

  expect(render).toHaveBeenCalledOnce();
  expect(firstRenderTheme).toBe('light');
  expect((await chromeLocalKV.get(['meta'])).meta).toMatchObject({ schemaVersion: LOCAL_SCHEMA_VERSION });
  expect((await getSettings()).ui.theme).toBe('light');
  await updateSettings({ ui: { theme: 'dark' } });
  expect(attributes.get('data-theme')).toBe('dark');
});

it.each(['dark', 'light', 'system'] as const)('keeps a returning user’s %s preference', async (theme) => {
  look.set('tb-look-2', '1');
  await chromeLocalKV.set({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, theme } } });

  await startUi(Promise.resolve());

  expect(attributes.get('data-theme')).toBe(theme === 'system' ? undefined : theme);
  expect((await getSettings()).ui.theme).toBe(theme);
});
