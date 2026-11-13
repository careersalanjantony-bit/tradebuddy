/** Daily candle, oldest → newest. Prices in ₹. */
export interface Candle {
  date: string; // YYYY-MM-DD (IST trading date)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** special session (e.g. Muhurat) — excluded from volume averages */
  special?: boolean;
  /** today's unfinished candle built from live quotes */
  partial?: boolean;
}
