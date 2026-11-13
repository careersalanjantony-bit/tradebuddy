/** Day-trade mode (v0.11.0): buy and sell — or sell short and buy back — on the same day. */

export type Side = 'long' | 'short';

/** One day of 5-minute candles for one stock. `t` = minutes since midnight IST of each bar's start (09:15 → 555). */
export interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export interface DayBars extends Bars {
  key: string;
  date: string;
}

/** A live day-trade signal. */
export interface DaySignal {
  id: string;
  key: string;
  symbol: string;
  side: Side;
  /** when the signal fired (ms) */
  at: number;
  /** minutes since midnight IST when the signal bar closed */
  barT: number;
  /** price when the signal fired */
  entry: number;
  stop: number;
  /** null = no fixed target (hold until the 3:10 pm exit) */
  target: number | null;
  /** volume in the first 15 minutes compared with this stock's usual (1 = usual) */
  rvol: number;
  orHigh: number;
  orLow: number;
  /** this kind of signal (buy / short) passed the past test */
  trusted: boolean;
  /** found while catching up: the breakout happened earlier than the latest 5-minute bar */
  late?: boolean;
  announced?: boolean;
  /** the company had a headline in the last 24 hours (v0.12.0) */
  inNews?: boolean;
  /** one short caution from the market mood, if any */
  caution?: string;
}

export interface DayTrade {
  id: string;
  /** IST date of the trade */
  date: string;
  key: string;
  symbol: string;
  side: Side;
  qty: number;
  entry: number;
  stop: number;
  target: number | null;
  openedAt: number;
  /** pretend money */
  practice: boolean;
  status: 'open' | 'closed';
  exitPrice?: number;
  exitAt?: number;
  exitReason?: 'stop' | 'target' | 'time' | 'manual';
  /** estimated charges for the round trip (₹), stored when closed */
  charges?: number;
  /** alerts already sent for a real trade */
  alerted?: { stop?: boolean; target?: boolean; time?: boolean };
  signalId?: string;
  /** found automatically in the Upstox account (v0.12.0) */
  auto?: boolean;
}
