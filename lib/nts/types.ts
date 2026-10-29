export type Tf = "15m" | "1h" | "4h" | "1d";
export const TF_SEC: Record<Tf, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
/** Same shape Gate candles already have in the system: time in SECONDS (bar open). */
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Side = "LONG" | "SHORT";
export const dirOf = (side: Side) => (side === "LONG" ? 1 : -1);
