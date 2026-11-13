import type { TechSnapshot } from '../indicators/snapshot';
import { formatDateTimeIST, formatNumberIN, formatPct } from '../lib/format';

/**
 * "Study question for Claude chat" (owner's no-extra-billing choice, 9 Nov 2026): instead of calling
 * the Claude API (billed per use), the extension packs its own numbers into a question the owner
 * pastes into Claude chat, which their subscription already covers. Mirrors spec §13.2.
 */

export interface StudyPromptInput {
  symbol: string;
  name: string;
  isin?: string;
  snap: TechSnapshot;
  /** when the price was taken (epoch ms) */
  priceTime: number;
  plan?: { entry: number; stop: number; target: number; holdTarget: number | null; qty: number; riskRupees: number; historyMode: boolean } | null;
}

const rs = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `₹${formatNumberIN(x)}`);
const n = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? 'n/a' : formatNumberIN(x, d));

export function buildStudyPrompt(i: StudyPromptInput): string {
  const s = i.snap;
  const lines: string[] = [];
  lines.push(
    'You are a careful equity research analyst. I am a beginner swing trader in India (NSE cash, delivery/CNC, holding days to a few weeks).',
    'Use web search for anything newer than my data. Never invent numbers; write "not found" when you cannot find something, and give the date of every figure.',
    'Use ₹, crore and IST. Plain English, short sentences. This is an assessment, not an instruction to buy — be blunt; "Avoid" is an allowed answer.',
    '',
    `Stock: ${i.name} (${i.symbol}, NSE${i.isin ? `, ISIN ${i.isin}` : ''}).`,
    `My tool's data, price taken ${formatDateTimeIST(i.priceTime)} (daily candles up to ${s.asOf}${s.live ? ', plus today live' : ''}):`,
    `- Price ${rs(s.price)} (${formatPct(s.changePct)} today). Trend: ${s.trend ?? 'n/a'}. Setup: ${s.setup}. Warnings: ${s.flags.length ? s.flags.join(', ') : 'none'}.`,
    `- Averages: SMA20 ${rs(s.sma20)}, SMA50 ${rs(s.sma50)}, SMA200 ${rs(s.sma200)} (${s.sma200Rising === null ? 'n/a' : s.sma200Rising ? 'rising' : 'falling'}).`,
    `- RSI(14) ${n(s.rsi14)}. ATR(14) ${rs(s.atr14)}. Stretch ${n(s.stretch, 2)} ATR above SMA20.`,
    `- 20-day high/low ${rs(s.high20)} / ${rs(s.low20)}. 52-week high/low ${rs(s.high52w)} / ${rs(s.low52w)}.`,
    `- Support ${s.supports.map((l) => rs(l.price)).join(', ') || 'n/a'}. Resistance ${s.resistances.map((l) => rs(l.price)).join(', ') || 'n/a'}.`,
    `- Returns: 1M ${formatPct(s.ret1m, 1)}, 3M ${formatPct(s.ret3m, 1)}, 6M ${formatPct(s.ret6m, 1)}, 1Y ${formatPct(s.ret1y, 1)}. Volume ratio (5d/50d) ${n(s.volumeRatio, 2)}. Avg traded value ₹${n(s.avgTradedValueCr)} crore/day.`,
  );
  if (i.plan) {
    const p = i.plan;
    lines.push(
      `- My plan: buy ${p.qty} at ${rs(p.entry)}, stop-loss ${rs(p.stop)} (risk ₹${formatNumberIN(p.riskRupees, 0)}), ` +
        (p.historyMode
          ? `no fixed target — safe target ${rs(p.target)}${p.holdTarget ? `, hold-until ${rs(p.holdTarget)}` : ''} (from this stock's last-year history).`
          : `target ${rs(p.target)}.`),
    );
  }
  lines.push(
    '',
    'Please answer in these sections:',
    '1. Business — what it does and how it makes money (3 lines), main competitors.',
    '2. Latest quarterly results — date, revenue and profit vs a year ago, margins, management comments.',
    '3. Upcoming events — next results date / board meeting, dividend, bonus, split. Is anything within the next 7 days?',
    '4. News and sentiment in the last 30 days — including promoter pledge, governance or regulatory issues and rating changes.',
    '5. Valuation — P/E and P/B vs its own 5-year range and its sector.',
    '6. Risks — company, sector, market.',
    `7. Technical read using my data — is ${i.plan ? 'my entry' : 'buying now'} sensible? Is the stop beyond normal daily noise? Are the targets realistic vs resistance?`,
    '8. Overall setup quality: Strong / Acceptable / Weak / Avoid, with 3–5 reasons.',
    '9. What would prove this trade wrong (invalidation)?',
    '10. Sources with dates.',
  );
  return lines.join('\n');
}
