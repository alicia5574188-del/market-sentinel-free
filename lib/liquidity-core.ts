export const SYSTEM_VERSION = "adaptive-target-countertrend-v4.4";
export const PORTFOLIO_RISK_CAP = 0.10;
export const CORRELATED_DIRECTION_RISK_CAP = 0.065;
export const STALE_AFTER_MS = 5_000;
export const WALL_WINDOW = 30;
export const ROUND_TRIP_FRICTION_RATE = 0.0018;
export const MIN_TARGET_DISTANCE_RATE = 0.0025;
export const MIN_NET_REWARD_RISK = 1.2;
export const MIN_SINGLE_TRADE_RISK_RATE = 0.01;
export const MAX_SINGLE_TRADE_RISK_RATE = 0.02;
export const MAX_NOTIONAL_TO_EQUITY = 4;
export const MIN_NET_TARGET_RETURN_ON_EQUITY = 0.002;
export const DYNAMIC_EXIT_CONFIRMATIONS = 3;
export const PLAN_SOFT_INVALIDATION_CONFIRMATIONS = 2;
export const MIN_SOFT_EXIT_HOLD_MS = 2 * 60_000;
export const SOFT_EXIT_ADVERSE_R = 0.75;
export const MAX_GENERIC_PLAN_DISTANCE_RATE = 0.0075;
export const TARGET_MARGIN_RATE = 0.10;
export const PORTFOLIO_MARGIN_CAP = 0.30;
export const MIN_STRUCTURAL_STOP_RATE = ROUND_TRIP_FRICTION_RATE;
export const BREAKOUT_REJECTION_MIN_R = 2;
export const BREAKOUT_REJECTION_MAX_RETENTION = 0.30;
export const BREAKOUT_ENTRY_MIN_EXTENSION_R = 0.10;
export const BREAKOUT_ENTRY_MIN_CLOSE_RETENTION = 0.55;
export const BREAKOUT_ENTRY_MAX_CHASE_R = 0.50;
export const FAST_BREAKOUT_MIN_CONFIRMATION = 0.86;
export const FAST_BREAKOUT_MAX_FAKEOUT_RISK = 0.18;
export const FAST_BREAKOUT_REQUIRED_SNAPSHOTS = 4;
export const FAST_BREAKOUT_MAX_SNAPSHOT_GAP_MS = 10_000;
export const REALTIME_RETEST_MIN_CONFIRMATION = 0.55;
export const REALTIME_RETEST_MAX_FAKEOUT_RISK = 0.55;
export const REALTIME_RETEST_REQUIRED_SNAPSHOTS = 3;
export const DYNAMIC_PROTECTION_MIN_CONFIRMED_R = 1.5;
export const DYNAMIC_PROTECTION_MIN_TARGET_PROGRESS = 0.70;
export const DYNAMIC_PROTECTION_REMAINING_RISK_R = 0.50;

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
export type TimeframeBias = { m1: TimeframeState; m15: TimeframeState; h1: TimeframeState; h4?: TimeframeState };

export type RangeBreakState = "INSIDE" | "BROKEN_UP" | "BROKEN_DOWN";
export type RangeRole = "PARENT" | "CHILD";
export type RangeBand = {
  lower: number;
  upper: number;
  midpoint: number;
  widthRate: number;
  touchesLower: number;
  touchesUpper: number;
  quality: number;
  observedAt: number;
  id?: string;
  role?: RangeRole;
  breakState?: RangeBreakState;
  lowerSweepDepth?: number;
  upperSweepDepth?: number;
};
export type RangeStructure = RangeBand & { child?: RangeBand | null };

export type RouteStage = "LOCAL_TO_NODE" | "AT_NODE" | "NODE_TO_NEXT";
export type RouteKind = "LOCAL_BREAKOUT" | "INTERNAL_ROTATION" | "BREAKOUT_RETEST" | "FAILED_BREAKOUT_REVERSAL" | "EDGE_REJECTION" | "NODE_CONTINUATION";
export type LiquidityRoute = {
  id: string;
  symbol: string;
  side: Side;
  kind: RouteKind;
  stage: RouteStage;
  entryTrigger: number;
  invalidation: number;
  target: number;
  targetIdentity: string;
  targetTimeframe: "15m" | "1h" | "4h";
  nextTarget: number | null;
  confirmationScore: number;
  fakeoutRisk: number;
  activationDistanceRate: number;
  score: number;
  executableNow: boolean;
  blockReason?: string;
  reason: string[];
  structureId?: string;
  structureRole?: RangeRole;
  rangeBoundary?: number;
  rangeBuffer?: number;
  sweepExtreme?: number;
  reclaimSource?: "COMPLETED_MINUTE" | "FAST_BOOK";
  reclaimStrength?: number;
};

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
  routeId?: string;
  routeStage?: RouteStage;
  routeKind?: RouteKind;
  targetTimeframe?: "15m" | "1h" | "4h";
  nextTarget?: number | null;
  confirmationScore?: number;
  fakeoutRisk?: number;
  activationDistanceRate?: number;
  structureId?: string;
  structureRole?: RangeRole;
  rangeBoundary?: number;
  rangeBuffer?: number;
  sweepExtreme?: number;
  reclaimSource?: "COMPLETED_MINUTE" | "FAST_BOOK";
  reclaimStrength?: number;
};

export type PaperPlan = Decision & {
  id: string;
  state: PlanState;
  createdAt: number;
  expiresAt: number;
  plannedRisk: number;
  notional: number;
  leverage?: number;
  margin?: number;
  economicTarget?: number;
  breakoutSignalCount?: number;
  breakoutSignalAt?: number;
  breakoutCrossedAt?: number;
  breakoutFailedAt?: number;
  breakoutMissedAt?: number;
  latestConfirmationScore?: number;
  latestFakeoutRisk?: number;
  realtimeSignalCount?: number;
  realtimeSignalAt?: number;
  cancelReason?: string;
  cancelledAt?: number;
  invalidationSignalMinute?: number;
  invalidationSignalCount?: number;
  invalidationSignalReason?: "TARGET_GONE_CANCEL" | "ACTIVATION_LOST_CANCEL" | "ROUTE_WEAK_CANCEL";
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
  routeId?: string;
  routeKind?: RouteKind;
  targetTimeframe?: "15m" | "1h" | "4h";
  status: "OPEN" | "CLOSED";
  exitAt?: number;
  exitPrice?: number;
  exitReason?: string;
  realizedPnl?: number;
  feesAndSlippage?: number;
  maxFavorablePrice?: number;
  maxAdversePrice?: number;
  exitSignalMinute?: number;
  exitSignalCount?: number;
  exitSignalReason?: string;
  stopUpdatedMinute?: number;
  rangeBoundary?: number;
  rangeBuffer?: number;
  sweepExtreme?: number;
  reclaimSource?: "COMPLETED_MINUTE" | "FAST_BOOK";
  reclaimStrength?: number;
  rangeAcceptanceMinute?: number;
  rangeAcceptanceCount?: number;
};

export type CompletedMinuteCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
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

export function flowPressure(flow: FlowEvidence) {
  return directionalPressure(flow);
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
  minuteNoiseRate?: number;
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
  if ([timeframe.m1, timeframe.m15, timeframe.h1].includes("UNKNOWN")) return null;
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
  const invalidationDistance = Math.max(entryTrigger * Math.max(MIN_STRUCTURAL_STOP_RATE, (input.minuteNoiseRate ?? 0) * 1.1),
    Math.abs(entryTrigger - input.mid) * 0.38);
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
    activationDistanceRate: MAX_GENERIC_PLAN_DISTANCE_RATE,
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
  sameDirectionRisk?: number;
}) {
  const availablePortfolioRisk = Math.max(0, input.equity * PORTFOLIO_RISK_CAP - input.openRisk);
  const availableCorrelatedRisk = Math.max(0, input.equity * CORRELATED_DIRECTION_RISK_CAP - (input.sameDirectionRisk ?? 0));
  const availableRisk = Math.min(availablePortfolioRisk, availableCorrelatedRisk);
  const desiredRiskRate = clamp(MIN_SINGLE_TRADE_RISK_RATE
    + input.confidence * (MAX_SINGLE_TRADE_RISK_RATE - MIN_SINGLE_TRADE_RISK_RATE),
  MIN_SINGLE_TRADE_RISK_RATE, MAX_SINGLE_TRADE_RISK_RATE);
  const desiredLoss = Math.min(availableRisk, input.equity * desiredRiskRate);
  const structuralMove = Math.abs(input.entry - input.invalidation) / Math.max(input.entry, 1e-9);
  const friction = (input.feeBps + input.stressSlippageBps) / 10_000;
  const lossRate = structuralMove + friction;
  const riskSizedNotional = lossRate > 0 ? desiredLoss / lossRate : 0;
  const notional = Math.min(riskSizedNotional, input.equity * MAX_NOTIONAL_TO_EQUITY);
  const allowedLoss = notional * lossRate;
  return { allowedLoss, notional, lossRate, portfolioRiskAfter: input.openRisk + allowedLoss };
}

export function selectSafeLeverage(input: {
  notional: number;
  equity: number;
  entry: number;
  invalidation: number;
  maintenanceRate?: number;
  leverageMax?: number;
}) {
  const structuralMove = Math.abs(input.entry - input.invalidation) / Math.max(input.entry, 1e-9);
  const maintenanceRate = clamp(input.maintenanceRate ?? 0.005, 0, 0.25);
  const exchangeMax = Math.max(1, Math.floor(input.leverageMax ?? 50));
  // Reserve roughly three structural-stop distances before the estimated
  // liquidation boundary. Higher leverage only releases margin; risk sizing
  // and the account-wide stop-loss budget remain unchanged.
  const liquidationSafeMax = Math.max(1, Math.floor(1 / Math.max(maintenanceRate + structuralMove * 3 + ROUND_TRIP_FRICTION_RATE, 1e-6)));
  const targetLeverage = Math.max(1, Math.ceil(input.notional / Math.max(input.equity * TARGET_MARGIN_RATE, 1e-9)));
  const leverage = Math.min(exchangeMax, liquidationSafeMax, targetLeverage);
  const margin = input.notional / Math.max(leverage, 1);
  return { leverage, margin, marginRate: margin / Math.max(input.equity, 1e-9), liquidationSafeMax };
}

export function tradeEconomics(input: { entry: number; target: number; lossRate: number; confidence: number; notional: number;
  equity: number; frictionRate?: number }) {
  const frictionRate = input.frictionRate ?? ROUND_TRIP_FRICTION_RATE;
  const rewardRate = Math.abs(input.target - input.entry) / Math.max(input.entry, 1e-9);
  const netRewardRate = Math.max(0, rewardRate - frictionRate);
  const netRewardRisk = netRewardRate / Math.max(input.lossRate, 1e-9);
  const expectedReturnRate = input.confidence * netRewardRate - (1 - input.confidence) * input.lossRate;
  const netTargetProfit = input.notional * netRewardRate;
  const minimumNetTargetProfit = input.equity * MIN_NET_TARGET_RETURN_ON_EQUITY;
  return { rewardRate, netRewardRate, netRewardRisk, expectedReturnRate, netTargetProfit, minimumNetTargetProfit,
    executable: netRewardRisk >= MIN_NET_REWARD_RISK && expectedReturnRate > 0 && netTargetProfit >= minimumNetTargetProfit };
}

export function stagedEconomicTarget(plan: Pick<Decision, "marketState" | "side" | "target" | "nextTarget" | "routeKind" | "confirmationScore" | "fakeoutRisk">) {
  // Admission must stand on the target that the position will actually use.
  // A farther node is context for a later at-node decision, never collateral
  // for an otherwise uneconomical first segment.
  return plan.target;
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
  confirmationMinute?: number;
  confirmationPrice?: number;
  confirmationCandle?: CompletedMinuteCandle | null;
  continuationRoute?: LiquidityRoute | null;
}): PaperPosition {
  if (position.status === "CLOSED") return position;
  const fullMinuteStart = Math.ceil(position.entryAt / 60_000) * 60_000;
  const confirmationCandle = input.confirmationCandle
    && input.confirmationCandle.time * 1_000 >= fullMinuteStart
    ? input.confirmationCandle : null;
  const candleFavorablePrice = confirmationCandle
    ? (position.side === "LONG" ? confirmationCandle.high : confirmationCandle.low)
    : position.entryPrice;
  const candleAdversePrice = confirmationCandle
    ? (position.side === "LONG" ? confirmationCandle.low : confirmationCandle.high)
    : position.entryPrice;
  const observed = {
    ...position,
    maxFavorablePrice: position.side === "LONG"
      ? Math.max(position.maxFavorablePrice ?? position.entryPrice, input.price, candleFavorablePrice)
      : Math.min(position.maxFavorablePrice ?? position.entryPrice, input.price, candleFavorablePrice),
    maxAdversePrice: position.side === "LONG"
      ? Math.min(position.maxAdversePrice ?? position.entryPrice, input.price, candleAdversePrice)
      : Math.max(position.maxAdversePrice ?? position.entryPrice, input.price, candleAdversePrice),
  };
  const stopped = observed.side === "LONG" ? input.price <= observed.currentStop : input.price >= observed.currentStop;
  const close = (reason: string) => closePaperPosition(observed, input.now, input.price, reason);
  if (stopped) {
    const initialRisk = Math.max(Math.abs(observed.entryPrice - observed.initialStop), observed.entryPrice * 0.0001);
    const tightened = Math.abs(observed.currentStop - observed.initialStop) > initialRisk * 0.001;
    return close(tightened ? "DYNAMIC_PROTECTION_STOP" : "STRUCTURAL_STOP");
  }
  if (observed.targetIdentity?.startsWith("EVENT_TARGET:")) {
    const age = input.now - observed.entryAt;
    const initialRisk = Math.max(Math.abs(observed.entryPrice - observed.initialStop), observed.entryPrice * 0.0001);
    const favorable = observed.side === "LONG"
      ? (observed.maxFavorablePrice ?? input.price) - observed.entryPrice
      : observed.entryPrice - (observed.maxFavorablePrice ?? input.price);
    const currentMove = observed.side === "LONG" ? input.price - observed.entryPrice : observed.entryPrice - input.price;
    if (age >= 20 * 60_000) return close("EVENT_MAX_HOLD_EXIT");
    if (age >= 10 * 60_000 && favorable < initialRisk * 0.35 && currentMove < initialRisk * 0.15) return close("EVENT_STALLED_EXIT");
  }

  const arrived = observed.side === "LONG" ? input.price >= observed.currentTarget : input.price <= observed.currentTarget;
  if (arrived && input.absorption >= 0.55) return close("TARGET_ABSORBED");
  if (arrived && observed.routeId && input.continuationRoute?.executableNow && input.continuationRoute.side === observed.side) {
    const continuation = input.continuationRoute;
    return { ...observed,
      currentStop: observed.side === "LONG" ? Math.max(observed.currentStop, continuation.invalidation)
        : Math.min(observed.currentStop, continuation.invalidation),
      currentTarget: continuation.target, targetScore: continuation.score, targetIdentity: continuation.targetIdentity,
      routeId: continuation.id, routeKind: continuation.kind, targetTimeframe: continuation.targetTimeframe,
      exitSignalMinute: undefined, exitSignalCount: 0, exitSignalReason: undefined };
  }
  if (arrived && observed.routeId) return close("TARGET_NODE_EXIT");

  const rangeReclaim = observed.scenario === "RANGE" && observed.routeKind === "EDGE_REJECTION"
    && observed.rangeBoundary != null && observed.rangeBuffer != null;
  const acceptedInsideRange = rangeReclaim && input.confirmationPrice != null
    ? (observed.side === "LONG"
      ? input.confirmationPrice >= observed.rangeBoundary! - observed.rangeBuffer! * 0.15
      : input.confirmationPrice <= observed.rangeBoundary! + observed.rangeBuffer! * 0.15)
    : false;
  const oppositeDominates = input.oppositeTarget && input.bestTarget
    ? input.oppositeTarget.score > Math.max(input.bestTarget.score, observed.targetScore) * 1.5
    : false;
  // A reclaimed balance is governed by price acceptance at its frozen edge.
  // Weak flow or a temporarily missing target cannot evict it while completed
  // candles continue to accept inside the range.
  const adverseReason = rangeReclaim && acceptedInsideRange ? null
    : !input.bestTarget ? "TARGET_DISAPPEARED" : oppositeDominates ? "OPPOSITE_UTILITY_DOMINANT" : null;
  let exitSignalMinute = observed.exitSignalMinute;
  let exitSignalCount = observed.exitSignalCount ?? 0;
  let exitSignalReason = observed.exitSignalReason;
  if (!adverseReason) {
    exitSignalMinute = undefined;
    exitSignalCount = 0;
    exitSignalReason = undefined;
  } else if (input.confirmationMinute && input.confirmationMinute > observed.entryAt && input.confirmationMinute !== exitSignalMinute) {
    exitSignalCount = exitSignalReason === adverseReason ? exitSignalCount + 1 : 1;
    exitSignalMinute = input.confirmationMinute;
    exitSignalReason = adverseReason;
  }
  const initialRisk = Math.max(Math.abs(observed.entryPrice - observed.initialStop), observed.entryPrice * 0.0001);
  const completedMinute = input.confirmationMinute && input.confirmationMinute > observed.entryAt
    && input.confirmationMinute !== observed.stopUpdatedMinute && Number.isFinite(input.confirmationPrice)
    ? input.confirmationMinute : null;
  let rangeAcceptanceMinute = observed.rangeAcceptanceMinute;
  let rangeAcceptanceCount = observed.rangeAcceptanceCount ?? 0;
  if (rangeReclaim && input.confirmationMinute && input.confirmationMinute > observed.entryAt
    && input.confirmationMinute !== rangeAcceptanceMinute && input.confirmationPrice != null) {
    const acceptedOutside = observed.side === "LONG"
      ? input.confirmationPrice < observed.rangeBoundary! - observed.rangeBuffer! * 0.15
      : input.confirmationPrice > observed.rangeBoundary! + observed.rangeBuffer! * 0.15;
    rangeAcceptanceCount = acceptedOutside ? rangeAcceptanceCount + 1 : 0;
    rangeAcceptanceMinute = input.confirmationMinute;
    if (rangeAcceptanceCount >= 2) {
      const closed = close("RANGE_OUTSIDE_ACCEPTANCE");
      return { ...closed, rangeAcceptanceMinute, rangeAcceptanceCount };
    }
  }
  const feeDistance = observed.entryPrice * ROUND_TRIP_FRICTION_RATE;
  if (completedMinute && confirmationCandle && observed.scenario === "BREAKOUT") {
    const extremeMove = observed.side === "LONG"
      ? confirmationCandle.high - observed.entryPrice
      : observed.entryPrice - confirmationCandle.low;
    const retainedMove = observed.side === "LONG"
      ? confirmationCandle.close - observed.entryPrice
      : observed.entryPrice - confirmationCandle.close;
    const retention = Math.max(0, retainedMove) / Math.max(extremeMove, 1e-9);
    const extremeR = extremeMove / initialRisk;
    if (input.now - observed.entryAt >= 60_000
      && extremeR >= BREAKOUT_REJECTION_MIN_R
      && extremeMove >= feeDistance + initialRisk * 0.5
      && retention <= BREAKOUT_REJECTION_MAX_RETENTION) {
      return close("BREAKOUT_PROFIT_REJECTION");
    }
  }
  const adverseCloseMove = input.confirmationPrice == null ? 0
    : observed.side === "LONG" ? observed.entryPrice - input.confirmationPrice : input.confirmationPrice - observed.entryPrice;
  const softExitEligible = completedMinute != null
    && input.now - observed.entryAt >= MIN_SOFT_EXIT_HOLD_MS
    && adverseCloseMove / initialRisk >= SOFT_EXIT_ADVERSE_R;
  if (adverseReason && softExitEligible && exitSignalCount >= DYNAMIC_EXIT_CONFIRMATIONS) {
    return close(adverseReason);
  }

  let currentStop = observed.currentStop;
  let stopUpdatedMinute = observed.stopUpdatedMinute;
  if (completedMinute && input.confirmationPrice != null) {
    const closeMove = observed.side === "LONG"
      ? input.confirmationPrice - observed.entryPrice
      : observed.entryPrice - input.confirmationPrice;
    const targetDistance = observed.side === "LONG"
      ? observed.currentTarget - observed.entryPrice
      : observed.entryPrice - observed.currentTarget;
    const confirmedR = closeMove / initialRisk;
    const targetProgress = targetDistance > 0 ? closeMove / targetDistance : 0;
    let candidate: number | null = null;
    // The first liquidity node is already checked on every fresh tick. Before
    // that node, an MFE-percentage trail only places protection inside normal
    // rotation. Completed target progress may reduce remaining loss, but it
    // cannot manufacture a profit stop before the planned target is reached.
    if (confirmedR >= DYNAMIC_PROTECTION_MIN_CONFIRMED_R
      && targetProgress >= DYNAMIC_PROTECTION_MIN_TARGET_PROGRESS) {
      candidate = observed.side === "LONG"
        ? observed.entryPrice - initialRisk * DYNAMIC_PROTECTION_REMAINING_RISK_R
        : observed.entryPrice + initialRisk * DYNAMIC_PROTECTION_REMAINING_RISK_R;
    }
    if (candidate != null) {
      currentStop = observed.side === "LONG" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
    }
    stopUpdatedMinute = completedMinute;
  }
  const targetStillBest = input.bestTarget && input.bestTarget.side === observed.side;
  return {
    ...observed,
    currentStop,
    currentTarget: observed.routeId ? position.currentTarget : targetStillBest ? input.bestTarget!.price : position.currentTarget,
    targetScore: observed.routeId ? position.targetScore : targetStillBest ? input.bestTarget!.score : position.targetScore,
    exitSignalMinute,
    exitSignalCount,
    exitSignalReason,
    stopUpdatedMinute,
    rangeAcceptanceMinute,
    rangeAcceptanceCount,
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

export function breakoutEntryConfirmed(
  plan: Pick<PaperPlan, "marketState" | "routeKind" | "breakoutSignalCount">,
  _confirmationMinute?: number,
  _confirmationCandle?: CompletedMinuteCandle | null,
) {
  void _confirmationMinute;
  void _confirmationCandle;
  if (plan.marketState !== "BREAKOUT") return true;
  if (plan.routeKind === "BREAKOUT_RETEST") return true;
  return (plan.breakoutSignalCount ?? 0) >= FAST_BREAKOUT_REQUIRED_SNAPSHOTS;
}

export function breakoutMinuteAccepted(
  plan: Pick<PaperPlan, "marketState" | "side" | "entryTrigger" | "invalidation" | "createdAt">,
  confirmationMinute?: number,
  confirmationCandle?: CompletedMinuteCandle | null,
) {
  if (plan.marketState !== "BREAKOUT") return false;
  if (!confirmationMinute || confirmationMinute <= plan.createdAt || !confirmationCandle) return false;
  const completedAt = (confirmationCandle.time + 60) * 1_000;
  if (completedAt <= plan.createdAt || completedAt > confirmationMinute) return false;
  const initialRisk = Math.max(Math.abs(plan.entryTrigger - plan.invalidation), plan.entryTrigger * 0.0001);
  const extension = Math.max(plan.entryTrigger * 0.00005, initialRisk * BREAKOUT_ENTRY_MIN_EXTENSION_R);
  const candleRange = Math.max(confirmationCandle.high - confirmationCandle.low, plan.entryTrigger * 1e-9);
  if (plan.side === "LONG") {
    const closeRetention = (confirmationCandle.close - confirmationCandle.low) / candleRange;
    return confirmationCandle.close >= plan.entryTrigger + extension
      && confirmationCandle.close > confirmationCandle.open
      && closeRetention >= BREAKOUT_ENTRY_MIN_CLOSE_RETENTION;
  }
  const closeRetention = (confirmationCandle.high - confirmationCandle.close) / candleRange;
  return confirmationCandle.close <= plan.entryTrigger - extension
    && confirmationCandle.close < confirmationCandle.open
    && closeRetention >= BREAKOUT_ENTRY_MIN_CLOSE_RETENTION;
}

export function observeFastBreakout(
  plan: PaperPlan,
  input: { now: number; price: number; confirmation: number; fakeoutRisk: number },
) {
  if (plan.marketState !== "BREAKOUT" || plan.routeKind === "BREAKOUT_RETEST" || plan.state !== "PREPARED") return plan;
  const livePlan = { ...plan, latestConfirmationScore: input.confirmation, latestFakeoutRisk: input.fakeoutRisk };
  const initialRisk = Math.max(Math.abs(plan.entryTrigger - plan.invalidation), plan.entryTrigger * 0.0001);
  const extension = plan.side === "LONG" ? input.price - plan.entryTrigger : plan.entryTrigger - input.price;
  const breakoutCrossedAt = plan.breakoutCrossedAt ?? (extension >= 0 ? input.now : undefined);
  if (breakoutCrossedAt != null && extension < 0) return { ...livePlan, breakoutCrossedAt, breakoutFailedAt: input.now,
    breakoutSignalCount: 0, breakoutSignalAt: undefined };
  if (extension > initialRisk * BREAKOUT_ENTRY_MAX_CHASE_R) return { ...livePlan, breakoutCrossedAt,
    breakoutMissedAt: input.now, breakoutSignalCount: 0, breakoutSignalAt: undefined };
  const minimumExtension = Math.max(plan.entryTrigger * 0.00005, initialRisk * BREAKOUT_ENTRY_MIN_EXTENSION_R);
  // Geometry is frozen when the plan is created, but breakout quality is live
  // evidence. A mediocre pre-break snapshot must not permanently veto a later
  // exceptional cross.
  const highQuality = input.confirmation >= FAST_BREAKOUT_MIN_CONFIRMATION
    && input.fakeoutRisk <= FAST_BREAKOUT_MAX_FAKEOUT_RISK
    && extension >= minimumExtension
    && breakoutEntryPriceAcceptable(plan, input.price);
  if (!highQuality) return (plan.breakoutSignalCount ?? 0) > 0
    ? { ...livePlan, breakoutCrossedAt, breakoutSignalCount: 0, breakoutSignalAt: undefined }
    : { ...livePlan, breakoutCrossedAt };
  if (plan.breakoutSignalAt === input.now) return livePlan;
  const consecutive = plan.breakoutSignalAt != null && input.now - plan.breakoutSignalAt <= FAST_BREAKOUT_MAX_SNAPSHOT_GAP_MS;
  return { ...livePlan,
    breakoutCrossedAt,
    breakoutSignalCount: Math.min(FAST_BREAKOUT_REQUIRED_SNAPSHOTS, consecutive ? (plan.breakoutSignalCount ?? 0) + 1 : 1),
    breakoutSignalAt: input.now };
}

export function observeRealtimeRetest(
  plan: PaperPlan,
  input: { now: number; price: number; confirmation: number; fakeoutRisk: number },
) {
  if (plan.state !== "PREPARED" || plan.marketState === "BREAKOUT" && plan.routeKind !== "FAILED_BREAKOUT_REVERSAL" && plan.routeKind !== "EDGE_REJECTION") return plan;
  const livePlan = { ...plan, latestConfirmationScore: input.confirmation, latestFakeoutRisk: input.fakeoutRisk };
  if (!planTriggered(plan, input.price)) return (plan.realtimeSignalCount ?? 0) > 0
    ? { ...livePlan, realtimeSignalCount: 0, realtimeSignalAt: undefined }
    : livePlan;
  const confirmed = input.confirmation >= REALTIME_RETEST_MIN_CONFIRMATION
    && input.fakeoutRisk <= REALTIME_RETEST_MAX_FAKEOUT_RISK;
  if (!confirmed) return (plan.realtimeSignalCount ?? 0) > 0
    ? { ...livePlan, realtimeSignalCount: 0, realtimeSignalAt: undefined }
    : livePlan;
  if (plan.realtimeSignalAt === input.now) return livePlan;
  const consecutive = plan.realtimeSignalAt != null && input.now - plan.realtimeSignalAt <= FAST_BREAKOUT_MAX_SNAPSHOT_GAP_MS;
  return { ...livePlan,
    realtimeSignalCount: Math.min(REALTIME_RETEST_REQUIRED_SNAPSHOTS, consecutive ? (plan.realtimeSignalCount ?? 0) + 1 : 1),
    realtimeSignalAt: input.now };
}

export function realtimeEntryConfirmed(plan: Pick<PaperPlan, "marketState" | "routeKind" | "breakoutSignalCount" | "realtimeSignalCount">) {
  return plan.marketState === "BREAKOUT" && plan.routeKind !== "FAILED_BREAKOUT_REVERSAL" && plan.routeKind !== "EDGE_REJECTION"
    ? breakoutEntryConfirmed(plan)
    : (plan.realtimeSignalCount ?? 0) >= REALTIME_RETEST_REQUIRED_SNAPSHOTS;
}

export function breakoutEntryPriceAcceptable(
  plan: Pick<PaperPlan, "marketState" | "side" | "entryTrigger" | "invalidation">,
  price: number,
) {
  if (plan.marketState !== "BREAKOUT") return true;
  const initialRisk = Math.max(Math.abs(plan.entryTrigger - plan.invalidation), plan.entryTrigger * 0.0001);
  const extension = plan.side === "LONG" ? price - plan.entryTrigger : plan.entryTrigger - price;
  return extension >= 0 && extension <= initialRisk * BREAKOUT_ENTRY_MAX_CHASE_R;
}
