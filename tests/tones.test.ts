import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alertChannel, channelOf, DEFAULT_TONE, QUIET_CHANNEL, SILENT_CHANNEL, SYSTEM_CHANNEL, TONES, toneOf, toneUrl } from '../src/notify/toneList';
import { routeForAlert } from '../src/ui/components/AlertBanner';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';

const root = new URL('../', import.meta.url);

describe('notification tones (app v1.9)', () => {
  it('several original money tones plus the phone’s own sound; "Cash register" by default', () => {
    expect(TONES.length).toBeGreaterThanOrEqual(6);
    expect(TONES.map((t) => t.id)).toEqual(expect.arrayContaining(['cash', 'coins', 'jackpot', 'bell', 'chime', 'pop', 'system']));
    expect(DEFAULT_TONE).toBe('cash');
    expect(DEFAULT_SETTINGS.notifications.tone).toBe('cash');
    expect(toneOf('nonsense').id).toBe('cash');
    expect(toneOf(undefined).id).toBe('cash');
  });

  it('every tone has its own Android channel (a channel’s sound cannot change), plus quiet and silent ones', () => {
    const ids = TONES.map((t) => t.channel);
    expect(new Set(ids).size).toBe(ids.length);
    expect(channelOf('system')).toBe(SYSTEM_CHANNEL);
    expect(channelOf('coins')).toBe('alerts-coins');
    expect(ids).not.toContain(QUIET_CHANNEL);
    expect(ids).not.toContain(SILENT_CHANNEL);
    expect(alertChannel({ sounds: true, tone: 'bell' })).toBe('alerts-bell');
    expect(alertChannel({ sounds: false, tone: 'bell' })).toBe(SILENT_CHANNEL);
  });

  it('each tone file is in the Android app (res/raw, used with the app closed) and in the web files (preview)', () => {
    for (const t of TONES) {
      if (!t.file) {
        expect(toneUrl(t.id)).toBeNull();
        continue;
      }
      expect(t.file).toMatch(/^[a-z0-9_]+$/); // Android resource names
      const raw = new URL(`android/app/src/main/res/raw/${t.file}.ogg`, root);
      const web = new URL(`public/sounds/${t.file}.ogg`, root);
      expect(existsSync(raw), `${t.file} in res/raw`).toBe(true);
      expect(existsSync(web), `${t.file} in public/sounds`).toBe(true);
      expect(statSync(raw).size).toBeGreaterThan(2_000);
      expect(statSync(raw).size).toBeLessThan(60_000);
      expect(readFileSync(raw).subarray(0, 4).toString()).toBe('OggS');
      expect(toneUrl(t.id)).toBe(`sounds/${t.file}.ogg`);
    }
    expect(existsSync(new URL('android/app/src/main/res/raw/tone_silent.ogg', root))).toBe(true);
  });
});

describe('tapping an alert opens the screen it belongs to', () => {
  it.each([
    ['alert:bo-NSE_EQ|X-100.60-early', 'daytrade'],
    ['alert:bo-NSE_EQ|X-100.60-ok', 'daytrade'],
    ['alert:day-NSE_EQ|X-2026-11-12', 'daytrade'],
    ['alert:short-NSE_EQ|X', 'daytrade'],
    ['alert:practice-NSE_EQ|X', 'practice'],
    ['alert:sold-NSE_EQ|X', 'practice'],
    ['alert:pick-NSE_EQ|X', 'today'],
    ['alert:rising-NSE_EQ|X', 'watchlist'],
    ['alert:update-1.9.0', 'account'],
    ['session-expired', 'settings'],
    ['alert:NSE_EQ|X:stop', 'alerts'],
  ])('%s → %s', (id, screen) => {
    expect(routeForAlert(id)).toBe(screen);
  });
});
