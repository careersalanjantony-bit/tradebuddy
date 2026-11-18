import { describe, expect, it } from 'vitest';
import { AVATAR_COLORS, checkPin, hashPin, initials, lockDue, makeBackup, newAccount, readBackup, validPin, waitAfterFails } from '../src/account/account';

describe('app login', () => {
  it('stores only a salted hash of the PIN and checks it', async () => {
    const h = await hashPin('4821', 2000);
    expect(h.hash).not.toContain('4821');
    expect(h.salt).toHaveLength(32);
    expect(await checkPin('4821', h)).toBe(true);
    expect(await checkPin('4822', h)).toBe(false);
    expect(await checkPin('48', h)).toBe(false);
    // same PIN, new salt → different hash
    expect((await hashPin('4821', 2000)).hash).not.toBe(h.hash);
  });

  it('PIN must be 4 digits', async () => {
    expect(validPin('1234')).toBe(true);
    expect(validPin('12a4')).toBe(false);
    await expect(hashPin('12')).rejects.toThrow('4 digits');
  });

  it('locks again after the chosen time away; never without a PIN or when set to never', async () => {
    const a = { ...newAccount('Alan', AVATAR_COLORS[0]!, 0), pin: await hashPin('1234', 1000), lockAfterMin: 1 };
    expect(lockDue(a, 0, 30_000)).toBe(false);
    expect(lockDue(a, 0, 60_000)).toBe(true);
    expect(lockDue({ ...a, lockAfterMin: -1 }, 0, 9e9)).toBe(false);
    expect(lockDue({ ...a, pin: null }, 0, 9e9)).toBe(false);
    expect(lockDue({ ...a, lockAfterMin: 0 }, 0, 1)).toBe(true);
  });

  it('slows down guessing after 5 wrong PINs', () => {
    expect(waitAfterFails(4)).toBe(0);
    expect(waitAfterFails(5)).toBe(30_000);
    expect(waitAfterFails(7)).toBe(90_000);
  });

  it('profile basics', () => {
    expect(initials('Alan Joy')).toBe('AJ');
    expect(initials('  ')).toBe('T');
    // an unknown colour (for example one saved by an older look) becomes the first colour of today's palette
    expect(newAccount('', 'nope', 5)).toMatchObject({ name: 'Trader', color: AVATAR_COLORS[0], pin: null, lockAfterMin: 1 });
    expect(newAccount('Alan', '#6d5dfc', 5).color).toBe(AVATAR_COLORS[0]);
  });

  it('backup: practice and settings in, keys and tokens never', () => {
    const text = makeBackup({ settings: { a: 1 }, wallet: { cash: 5 }, secrets: { upstoxApiSecret: 'S' }, auth: { accessToken: 'T' } }, 0, '1.3.0');
    expect(text).not.toContain('upstoxApiSecret');
    expect(text).not.toContain('accessToken');
    expect(readBackup(text)).toEqual({ settings: { a: 1 }, wallet: { cash: 5 } });
    expect(() => readBackup('{"x":1}')).toThrow('not a TradeBuddy backup');
  });
});
