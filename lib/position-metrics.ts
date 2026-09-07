export type PositionSide = "LONG" | "SHORT";

const direction = (side: PositionSide) => side === "LONG" ? 1 : -1;

export function unrealizedPnl(notional: number, side: PositionSide, entry: number, mark: number) {
  if (![notional, entry, mark].every(Number.isFinite) || notional < 0 || entry <= 0 || mark <= 0) return 0;
  return notional * (mark - entry) / entry * direction(side);
}

export function directionalReturnRate(side: PositionSide, entry: number, mark: number) {
  if (![entry, mark].every(Number.isFinite) || entry <= 0 || mark <= 0) return 0;
  return (mark - entry) / entry * direction(side);
}

export function marginReturnRate(pnl: number, margin: number) {
  if (![pnl, margin].every(Number.isFinite) || margin <= 0) return 0;
  return pnl / margin;
}
