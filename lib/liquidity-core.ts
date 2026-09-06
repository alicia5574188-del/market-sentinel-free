export const SYSTEM_VERSION = "liquidity-three-state-v1";
export const PORTFOLIO_RISK_CAP = 0.05;
export const STALE_AFTER_MS = 3_000;
export const WALL_WINDOW = 30;
export const ROUND_TRIP_FRICTION_RATE = 0.0018;
export const MIN_TARGET_DISTANCE_RATE = 0.0025;

export type Side = "LONG" | "SHORT";
export type MarketState = "BREAKOUT" | "REVERSAL" | "RANGE";
export type PlanState = "PREPARED" | "TRIGGERED" | "CANCELLED";

export type BookLevel = { price: number; size: number };
export type BookSnapshot = {
  symbol: string;
  observedAt: number;
  sequence: number;
  tickSize: number;
  bids: BookLevel[];
  asks: BookLevel[];
};

export type FlowEvidence = {
  ofi: number;
  micropriceDisplacementBps: number;
  takerDelta: number;
  openInterestDelta: number;
  funding: number;
  actualLiquidations: number;
  priceResponseBps: number;
};

export type TimeframeState = "UNKNOWN" | "NEUTRAL" | "UP" | "DOWN";
export type TimeframeBias = { m1: TimeframeState; m15: TimeframeState; h1: TimeframeState };

export type WallEvidence = {
  snapshots: number;
  seen: number;
  approachCancels: number;
  approachObservations: number;
};

export type LiquidityZone = {
  identity?: string;
  side: Side;
  price: number;
  liquidity: number;
  cascade: number;
  pathCost: number;
  distanceCost: number;
  probabilityReach: number;
  persistence: number;
  score: number;
  source: "BOOK" | "STOP_POOL" | "LIQUIDATION";
  spoofed: boolean;
};

export type Decision = {
  symbol: string;
  observedAt: number;
  marketState: MarketState;
  side: Side;
  entryTrigger: number;
  invalidation: number;
  target: number;
  targetIdentity: string;
  score: number;
  oppositeScore: number;
  reason: string[];
};

export type PaperPlan = Decision & {
  id: string;
  state: PlanState;
  createdAt: number;
  expiresAt: number;
  plannedRisk: number;
  notional: number;
};

export type PaperPosition = {
  id: string;
  symbol: string;
  side: Side;
  scenario: MarketState;
  entryAt: number;
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  currentTarget: number;
  plannedRisk: number;
  notional: number;
  targetScore: number;
  targetIdentity?: string;
  status: "OPEN" | "CLOSED";
  exitAt?: number;
  exitPrice?: number;
  exitReason?: string;
  realizedPnl?: number;
  feesAndSlippage?: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function priceBinSize(mid: number, tickSize: number) {
  return Math.max(tickSize * 5, mid * 0.0002);
}

export function stablePriceBin(price: number) {
  return Math.round(Math.log(Math.max(price, 1e-12)) / Math.log(1.0002));
}

export function wallPersistence(evidence: WallEvidence) {
  if (evidence.snapshots < WALL_WINDOW) return 0;
  const persistence = evidence.seen / evidence.snapshots;
  const cancelRatio = evidence.approachObservations > 0
    ? evidence.approachCancels / evidence.approachObservations
    : 0;
  return cancelRatio > 0.5 ? 0 : persistence >= 0.7 ? persistence : 0;
}

export function zoneUtility(input: Omit<LiquidityZone, "score" | "spoofed">, wall?: WallEvidence): LiquidityZone {
  const persistence = wall ? wallPersistence(wall) : clamp(input.persistence, 0, 1);
  const spoofed = wall != null && persistence === 0;
  const denominator = Math.max(1e-9, input.pathCost + input.distanceCost);
  const score = spoofed ? 0 : clamp(input.probabilityReach, 0, 1)
    * Math.max(0, input.liquidity + input.cascade)
    / denominator
    * persistence;
  return { ...input, persistence, score, spoofed };
}

export function aggregateBook(snapshot: BookSnapshot, walls: Map<string, WallEvidence> = new Map()) {
  const bestBid = snapshot.bids[0]?.price ?? 0;
  const bestAsk = snapshot.asks[0]?.price ?? 0;
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return [] as LiquidityZone[];
  const width = priceBinSize(mid, snapshot.tickSize);
  const grouped = new Map<string, { side: Side; priceWeighted: number; size: number }>();
  for (const [levels, side] of [[snapshot.asks, "LONG"], [snapshot.bids, "SHORT"]] as const) {
    for (const level of levels.slice(0, 60)) {
      if (!(level.price > 0 && level.size > 0)) continue;
      const bin = Math.round(level.price / width);
      const key = `${side}:${bin}`;
      const current = grouped.get(key) ?? { side, priceWeighted: 0, size: 0 };
      current.priceWeighted += level.price * level.size;
      current.size += level.size;
      grouped.set(key, current);
    }
  }
  return [...grouped.entries()].map(([key, item]) => {
    const price = item.priceWeighted / item.size;
    const distanceBps = Math.abs(price - mid) / mid * 10_000;
    const probabilityReach = clamp(0.82 - distanceBps / 500, 0.08, 0.82);
    return zoneUtility({
      identity: `BOOK:${item.side}:${Math.round(price / Math.max(snapshot.tickSize * 5, 1e-12))}`,
      side: item.side,
      price,
      liquidity: item.size,
      cascade: 0,
      pathCost: 1 + distanceBps / 20,
      distanceCost: Math.max(0.5, distanceBps / 10),
      probabilityReach,
      persistence: 1,
      source: "BOOK",
    }, walls.get(key));
  }).filter((zone) => !zone.spoofed && zone.score > 0);
}

export type LiquidationBand = {
  side: Side;
  price: number;
  expectedForcedNotional: number;
  opposingDepth: number;
  segmentDepth?: number;
  leverage: 5 | 10 | 20 | 50;
  actualCalibration: number;
};

export function cascadeRatio(band: LiquidationBand) {
  return band.expectedForcedNotional * Math.max(0.25, band.actualCalibration)
    / Math.max(1, band.segmentDepth ?? band.opposingDepth);
}

export function hasCascade(bands: LiquidationBand[], side: Side, midpoint?: number) {
  const reachable = bands
    .filter((band) => band.side === side && (midpoint == null || (side === "LONG" ? band.price > midpoint : band.price < midpoint)))
    .sort((a, b) => side === "LONG" ? a.price - b.price : b.price - a.price);
  let consecutive = 0;
  let previousPrice: number | null = null;
  for (const band of reachable) {
    const firstReachable = previousPrice == null && (midpoint == null || Math.abs(band.price - midpoint) / midpoint <= 0.03);
    const adjacent = previousPrice != null && Math.abs(band.price - previousPrice) / Math.max(midpoint ?? previousPrice, 1e-9) <= 0.003;
    const ordered = firstReachable || adjacent;
    if (ordered && cascadeRatio(band) > 1) {
      consecutive += 1;
      if (consecutive >= 2) return true;
    } else {
      consecutive = 0;
    }
    previousPrice = band.price;
  }
  return false;
}

function directionalPressure(flow: FlowEvidence) {
  return clamp(
    flow.ofi * 0.34
      + flow.micropriceDisplacementBps / 8 * 0.2
      + flow.takerDelta * 0.18
      + flow.openInterestDelta * 0.16
      - flow.funding * 0.04
      + flow.actualLiquidations * 0.08,
    -1,
    1,
  );
}

export function decideThreeState(input: {
  symbol: string;
  observedAt: number;
  mid: number;
  zones: LiquidityZone[];
  bands: LiquidationBand[];
  flow: FlowEvidence;
  absorption: number;
  timeframeBias?: TimeframeBias;
}): Decision | null {
  // A nearby liquidity pocket can be real yet still be untradeable after fees
  // and stress slippage. Do not build plans whose destination cannot pay for
  // the round trip.
  const longZones = input.zones.filter((zone) => zone.side === "LONG" && zone.price >= input.mid * (1 + MIN_TARGET_DISTANCE_RATE)).sort((a, b) => b.score - a.score);
  const shortZones = input.zones.filter((zone) => zone.side === "SHORT" && zone.price <= input.mid * (1 - MIN_TARGET_DISTANCE_RATE)).sort((a, b) => b.score - a.score);
  const long = longZones[0];
  const short = shortZones[0];
  if (!long || !short) return null;
  const pressure = directionalPressure(input.flow);
  const longCascade = hasCascade(input.bands, "LONG", input.mid);
  const shortCascade = hasCascade(input.bands, "SHORT", input.mid);
  const timeframe = input.timeframeBias ?? { m1: "UNKNOWN", m15: "UNKNOWN", h1: "UNKNOWN" };
  if (Object.values(timeframe).includes("UNKNOWN")) return null;
  const direction = (value: TimeframeState) => value === "UP" ? 1 : value === "DOWN" ? -1 : 0;
  const matrix = { m1: direction(timeframe.m1), m15: direction(timeframe.m15), h1: direction(timeframe.h1) };
  const directional = Object.values(matrix).filter((value) => value !== 0);
  const timeframeConflict = directional.includes(1) && directional.includes(-1);
  const maxScore = Math.max(long.score, short.score, 1e-9);
  const balance = Math.min(long.score, short.score) / maxScore;
  let state: MarketState;
  let side: Side;
  const reason: string[] = [];

  const priceFlowDivergence = Math.abs(input.flow.priceResponseBps) < Math.abs(pressure) * 5;
  const nearSweep = Math.min(Math.abs(long.price - input.mid), Math.abs(short.price - input.mid)) / input.mid < 0.004;
  const continuingCascade = pressure > 0 ? longCascade : pressure < 0 ? shortCascade : false;
  if (!timeframeConflict && ((longCascade && pressure > 0.18 && matrix.h1 !== -1) || (shortCascade && pressure < -0.18 && matrix.h1 !== 1))) {
    state = "BREAKOUT";
    side = longCascade && pressure > 0 ? "LONG" : "SHORT";
    reason.push("连续两层可达清算梯度", "订单流与微价格同向");
  } else if (input.absorption >= 0.62 && Math.abs(pressure) >= 0.28 && priceFlowDivergence && nearSweep && !continuingCascade && !longCascade && !shortCascade) {
    state = "REVERSAL";
    side = pressure > 0 ? "SHORT" : "LONG";
    reason.push(timeframeConflict ? "1m/15m/1h显式矩阵冲突" : "流动性区吸收增强", "扫过密集区后主动流与价格响应背离", "没有延续清算链");
  } else if ((timeframeConflict || (balance >= 0.72 && balance < 0.995 && Math.abs(pressure) < 0.32)) && !longCascade && !shortCascade) {
    state = "RANGE";
    side = long.score > short.score ? "LONG" : "SHORT";
    reason.push(timeframeConflict ? "1m/15m/1h显式矩阵冲突" : "上下流动性效用接近", "无清算链延续，按区间边缘准备");
  } else if (!timeframeConflict && ((long.score > short.score * 1.35 && pressure > 0.1 && matrix.h1 !== -1) || (short.score > long.score * 1.35 && pressure < -0.1 && matrix.h1 !== 1))) {
    state = "BREAKOUT";
    side = long.score > short.score ? "LONG" : "SHORT";
    reason.push("单侧流动性目标效用占优", "方向流与目标一致，提前准备边界触发");
  } else {
    return null;
  }
  if (state !== "RANGE" && ((side === "LONG" && matrix.h1 === -1) || (side === "SHORT" && matrix.h1 === 1))) return null;

  const targetZone = side === "LONG" ? long : short;
  const oppositeZone = side === "LONG" ? short : long;
  const target = targetZone.price;
  const distance = Math.max(input.mid * 0.0005, Math.abs(target - input.mid));
  const entryEdge = state === "BREAKOUT" ? targetZone.price : oppositeZone.price;
  const entryTrigger = state === "BREAKOUT"
    ? (side === "LONG" ? input.mid + distance * 0.18 : input.mid - distance * 0.18)
    : input.mid + (entryEdge - input.mid) * (state === "REVERSAL" ? 0.72 : 0.66);
  const invalidationDistance = Math.max(input.mid * 0.001, Math.abs(entryTrigger - input.mid) * 0.38);
  const invalidation = side === "LONG" ? entryTrigger - invalidationDistance : entryTrigger + invalidationDistance;
  return {
    symbol: input.symbol,
    observedAt: input.observedAt,
    marketState: state,
    side,
    entryTrigger,
    invalidation,
    target,
    targetIdentity: targetZone.identity ?? `${targetZone.source}:${targetZone.side}:${targetZone.price.toPrecision(12)}`,
    score: targetZone.score,
    oppositeScore: oppositeZone.score,
    reason,
  };
}

export function sizePaperPosition(input: {
  equity: number;
  entry: number;
  invalidation: number;
  feeBps: number;
  stressSlippageBps: number;
  confidence: number;
  openRisk: number;
}) {
  const availableRisk = Math.max(0, input.equity * PORTFOLIO_RISK_CAP - input.openRisk);
  const desiredRiskRate = clamp(0.01 + input.confidence * 0.02, 0.01, 0.03);
  const allowedLoss = Math.min(availableRisk, input.equity * desiredRiskRate);
  const structuralMove = Math.abs(input.entry - input.invalidation) / Math.max(input.entry, 1e-9);
  const friction = (input.feeBps + input.stressSlippageBps) / 10_000;
  const lossRate = structuralMove + friction;
  const notional = lossRate > 0 ? allowedLoss / lossRate : 0;
  return { allowedLoss, notional, lossRate, portfolioRiskAfter: input.openRisk + allowedLoss };
}

export function remainingStressRisk(position: PaperPosition, markPrice = position.entryPrice) {
  if (position.status !== "OPEN") return 0;
  const adverseMove = position.side === "LONG"
    ? Math.max(0, markPrice - position.currentStop) / Math.max(markPrice, 1e-9)
    : Math.max(0, position.currentStop - markPrice) / Math.max(markPrice, 1e-9);
  return position.notional * (adverseMove + ROUND_TRIP_FRICTION_RATE);
}

export function closePaperPosition(position: PaperPosition, now: number, price: number, reason: string): PaperPosition {
  if (position.status === "CLOSED") return position;
  const direction = position.side === "LONG" ? 1 : -1;
  const gross = position.notional * ((price - position.entryPrice) / Math.max(position.entryPrice, 1e-9)) * direction;
  const feesAndSlippage = position.notional * ROUND_TRIP_FRICTION_RATE;
  return { ...position, status: "CLOSED", exitAt: now, exitPrice: price, exitReason: reason, realizedPnl: gross - feesAndSlippage, feesAndSlippage };
}

export function updatePosition(position: PaperPosition, input: {
  now: number;
  price: number;
  bestTarget: LiquidityZone | null;
  oppositeTarget: LiquidityZone | null;
  absorption: number;
}): PaperPosition {
  if (position.status === "CLOSED") return position;
  const stopped = position.side === "LONG" ? input.price <= position.currentStop : input.price >= position.currentStop;
  const close = (reason: string) => closePaperPosition(position, input.now, input.price, reason);
  if (stopped) return close("STRUCTURAL_STOP");

  if (!input.bestTarget) return close("TARGET_DISAPPEARED");

  const arrived = position.side === "LONG" ? input.price >= position.currentTarget : input.price <= position.currentTarget;
  const oppositeDominates = input.oppositeTarget && input.bestTarget
    ? input.oppositeTarget.score > input.bestTarget.score * 1.18
    : false;
  if ((arrived && input.absorption >= 0.55) || oppositeDominates) {
    return close(arrived ? "TARGET_ABSORBED" : "OPPOSITE_UTILITY_DOMINANT");
  }

  let currentStop = position.currentStop;
  const favorable = position.side === "LONG" ? input.price > position.entryPrice : input.price < position.entryPrice;
  if (favorable) {
    const rawCandidate = position.side === "LONG"
      ? position.entryPrice + (input.price - position.entryPrice) * 0.25
      : position.entryPrice - (position.entryPrice - input.price) * 0.25;
    const initialRisk = Math.max(Math.abs(position.entryPrice - position.initialStop), position.entryPrice * 0.0001);
    const step = initialRisk * 0.1;
    const steps = position.side === "LONG"
      ? Math.max(0, Math.floor((rawCandidate - position.initialStop) / step))
      : Math.max(0, Math.floor((position.initialStop - rawCandidate) / step));
    const candidate = position.side === "LONG" ? position.initialStop + steps * step : position.initialStop - steps * step;
    currentStop = position.side === "LONG" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
  }
  const targetStillBest = input.bestTarget && input.bestTarget.side === position.side;
  return {
    ...position,
    currentStop,
    currentTarget: targetStillBest ? input.bestTarget!.price : position.currentTarget,
    targetScore: targetStillBest ? input.bestTarget!.score : position.targetScore,
  };
}

export function dataIsFresh(observedAt: number, now: number) {
  return observedAt <= now + 1_000 && now - observedAt <= STALE_AFTER_MS;
}

export function planTriggered(plan: PaperPlan, price: number) {
  if (plan.state !== "PREPARED") return false;
  return plan.side === "LONG"
    ? (plan.marketState === "BREAKOUT" ? price >= plan.entryTrigger : price <= plan.entryTrigger)
    : (plan.marketState === "BREAKOUT" ? price <= plan.entryTrigger : price >= plan.entryTrigger);
}
