/**
 * Notification tones (app v1.9). Original sounds made for TradeBuddy (scripts/make-tones.py); the same
 * files are in the Android app (res/raw, used by the notification channels, so they also play when
 * the app is closed) and in the web files (public/sounds, for the preview in Settings).
 *
 * Android fixes a channel's sound when the channel is created, so every tone has its own channel;
 * choosing a tone simply switches the channel the app posts to. All channels are "high importance":
 * the alert pops up at the top of the screen (heads-up) with sound and vibration.
 */

export type ToneId = 'cash' | 'coins' | 'bell' | 'chime' | 'jackpot' | 'pop' | 'system';

export interface ToneInfo {
  id: ToneId;
  name: string;
  hint: string;
  emoji: string;
  /** file name without extension (res/raw and public/sounds/<file>.ogg); null = the phone's own sound */
  file: string | null;
  /** Android notification channel */
  channel: string;
}

/** The original channel (phone's default sound), kept for everyone who had alerts before v1.9. */
export const SYSTEM_CHANNEL = 'trade-alerts';

export const TONES: ToneInfo[] = [
  { id: 'cash', name: 'Cash register', hint: 'Ka-ching! — a drawer and two bright bells', emoji: '💰', file: 'tone_cash', channel: 'alerts-cash' },
  { id: 'coins', name: 'Falling coins', hint: 'A handful of coins landing on a pile', emoji: '🪙', file: 'tone_coins', channel: 'alerts-coins' },
  { id: 'jackpot', name: 'Jackpot', hint: 'A quick winning run with coins', emoji: '🎰', file: 'tone_jackpot', channel: 'alerts-jackpot' },
  { id: 'bell', name: 'Market bell', hint: 'Two strikes of a brass bell', emoji: '🔔', file: 'tone_bell', channel: 'alerts-bell' },
  { id: 'chime', name: 'Profit chime', hint: 'Three rising notes and a sparkle', emoji: '✨', file: 'tone_chime', channel: 'alerts-chime' },
  { id: 'pop', name: 'Soft pop', hint: 'Short and quiet', emoji: '🫧', file: 'tone_pop', channel: 'alerts-pop' },
  { id: 'system', name: "Phone's own sound", hint: 'Your phone’s usual notification sound', emoji: '📱', file: null, channel: SYSTEM_CHANNEL },
];

export const DEFAULT_TONE: ToneId = 'cash';

export function toneOf(id: string | null | undefined): ToneInfo {
  return TONES.find((t) => t.id === id) ?? TONES.find((t) => t.id === DEFAULT_TONE)!;
}

/** The notification channel for a tone. */
export const channelOf = (id: string | null | undefined): string => toneOf(id).channel;

/** Web address of a tone's sound file (for playing it inside the app). */
export const toneUrl = (id: string | null | undefined): string | null => {
  const t = toneOf(id);
  return t.file ? `sounds/${t.file}.ogg` : null;
};

/** While TradeBuddy is on screen the alert shows inside the app; Android keeps a quiet copy in the list. */
export const QUIET_CHANNEL = 'alerts-quiet';
/** Sounds switched off in Settings: alerts still pop up, without a sound. */
export const SILENT_CHANNEL = 'alerts-silent';

/** The channel for alerts when the app is not on screen (closed, in the background, phone locked). */
export function alertChannel(n: { sounds: boolean; tone?: string | undefined }): string {
  return n.sounds ? channelOf(n.tone) : SILENT_CHANNEL;
}
