export type RadarTicker = {
  symbol: string;
  last: number;
  volume24hUsd: number;
  fundingRate: number;
  openInterest: number;
};

export type RadarBaseline = {
  last: number;
  observedAt: number;
  samples: number;
  movementEma: number;
  eventStartedAt: number | null;
  confirmations: number;
  quietScans: number;
  eventSide: "LONG" | "SHORT" | null;
  eventStrength: number;
  eventMoveRate: number;
  openInterest: number;
};

export type RadarCandidate = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strength: number;
  moveRate: number;
  movementMultiple: number;
  volume24hUsd: number;
  confirmations: number;
  firstSeenAt: number;
  observedAt: number;
  kind: "NEW_MONEY" | "SQUEEZE" | "LIQUIDATION" | "PRICE_SHOCK";
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function updateRadar(
  prior: Record<string, RadarBaseline>,
  rows: RadarTicker[],
  eligible: Set<string>,
  now: number,
) {
  const baselines: Record<string, RadarBaseline> = {};
  const candidates: RadarCandidate[] = [];
  for (const row of rows) {
    if (!eligible.has(row.symbol) || row.last <= 0 || row.volume24hUsd < 2_000_000) continue;
    const before = prior[row.symbol];
    const moveRate = before?.last ? (row.last - before.last) / before.last : 0;
    const absoluteMove = Math.abs(moveRate);
    const movementEma = before
      ? before.movementEma * 0.88 + absoluteMove * 0.12
      : Math.max(absoluteMove, 0.00015);
    const multiple = absoluteMove / Math.max(before?.movementEma ?? 0.00015, 0.00008);
    const liquidBonus = clamp(Math.log10(Math.max(row.volume24hUsd, 1)) - 6, 0, 3) * 4;
    const strength = clamp(absoluteMove / 0.0008 * 35 + multiple * 12 + liquidBonus, 0, 100);
    const active = before != null && before.samples >= 2 && absoluteMove >= Math.max(0.0006, before.movementEma * 2.2) && strength >= 55;
    const side = moveRate >= 0 ? "LONG" as const : "SHORT" as const;
    const sameDirection = before?.eventStartedAt != null && before.eventSide === side;
    const eventStartedAt = active ? before?.eventStartedAt ?? now : before?.eventStartedAt ?? null;
    const quietScans = active ? 0 : (before?.quietScans ?? 0) + 1;
    const retainedEvent = quietScans < 4 ? eventStartedAt : null;
    const confirmations = active ? (sameDirection ? (before?.confirmations ?? 0) + 1 : 1)
      : retainedEvent ? Math.min(6, (before?.confirmations ?? 0) + 1) : 0;
    const eventSide = active ? side : retainedEvent ? before?.eventSide ?? null : null;
    const eventStrength = active ? Math.max(strength, before?.eventStrength ?? 0) : retainedEvent ? (before?.eventStrength ?? 0) * 0.96 : 0;
    const eventMoveRate = active ? ((before?.eventMoveRate ?? 0) + moveRate) : retainedEvent ? before?.eventMoveRate ?? 0 : 0;
    baselines[row.symbol] = {
      last: row.last,
      observedAt: now,
      samples: Math.min(120, (before?.samples ?? 0) + 1),
      movementEma,
      eventStartedAt: retainedEvent,
      confirmations: retainedEvent ? confirmations : 0,
      quietScans,
      eventSide,
      eventStrength,
      eventMoveRate,
      openInterest: row.openInterest,
    };
    if (!retainedEvent || !eventSide || eventStrength < 52) continue;
    const oiGrowing = row.openInterest > 0 && (before?.openInterest ?? row.openInterest) > 0
      && row.openInterest > (before?.openInterest ?? row.openInterest) * 1.0002;
    candidates.push({
      id: `${row.symbol}:${retainedEvent}`,
      symbol: row.symbol,
      side: eventSide,
      strength: eventStrength,
      moveRate: eventMoveRate,
      movementMultiple: multiple,
      volume24hUsd: row.volume24hUsd,
      confirmations,
      firstSeenAt: retainedEvent,
      observedAt: now,
      kind: oiGrowing ? "NEW_MONEY" : eventSide === "LONG" ? "SQUEEZE" : "LIQUIDATION",
    });
  }
  return { baselines, candidates: candidates.sort((a, b) => b.strength - a.strength).slice(0, 12), scanned: Object.keys(baselines).length };
}
