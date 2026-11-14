import { formatTimeIST } from '../lib/format';

/**
 * App v1.8 (owner: "Good evening Alan!" and "a short motivation message, very short"). The greeting
 * follows the time in India; the line changes once a day. Never about returns — only about habits.
 */

export function greetingWord(now: number): string {
  const h = Number(formatTimeIST(now).slice(0, 2));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export const firstName = (name: string | null | undefined): string => (name ?? '').trim().split(/\s+/)[0] ?? '';

/** "Good evening Alan!" — or "Good evening!" before a profile exists. */
export function greetingLine(now: number, name?: string | null): string {
  const first = firstName(name);
  return `${greetingWord(now)}${first ? ` ${first}` : ''}!`;
}

export const MOTTOS = [
  'Plan the trade. Trade the plan.',
  'Protect your money first.',
  'Small losses, big lessons.',
  'Patience pays.',
  'Discipline beats luck.',
  'No trade is also a trade.',
  'Cut losses early.',
  'Stay calm. Follow your rules.',
  'Learn a little every day.',
  'One good trade at a time.',
  'Respect the safety net.',
  'Practice now, confidence later.',
];

/** Today's line (India's date). */
export function motto(now: number): string {
  const day = Math.floor((now + 5.5 * 3600_000) / 86_400_000);
  return MOTTOS[((day % MOTTOS.length) + MOTTOS.length) % MOTTOS.length]!;
}
