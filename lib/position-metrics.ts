export type PositionSide = "LONG" | "SHORT";
export type PositionPricePoint = { time: number; price: number };

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

export function aggregateClosePoints(points: PositionPricePoint[], intervalMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return [];
  const buckets = new Map<number, PositionPricePoint>();
  points.forEach((point) => {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.price) || point.time <= 0 || point.price <= 0) return;
    const bucket = Math.floor(point.time / intervalMs) * intervalMs;
    const current = buckets.get(bucket);
    if (!current || point.time >= current.time) buckets.set(bucket, point);
  });
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
}
