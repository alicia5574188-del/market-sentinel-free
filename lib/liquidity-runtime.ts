import {
  aggregateBook,
  breakoutEntryConfirmed,
  breakoutMinuteAccepted,
  breakoutEntryPriceAcceptable,
  cascadeRatio,
  dataIsFresh,
  decideThreeState,
  flowPressure,
  MAX_GENERIC_PLAN_DISTANCE_RATE,
  MIN_NET_REWARD_RISK,
  MIN_TARGET_DISTANCE_RATE,
  MIN_STRUCTURAL_STOP_RATE,
  ROUND_TRIP_FRICTION_RATE,
  observeFastBreakout,
  PLAN_SOFT_INVALIDATION_CONFIRMATIONS,
  PORTFOLIO_RISK_CAP,
  planTriggered,
  selectSafeLeverage,
  sizePaperPosition,
  stablePriceBin,
  stagedEconomicTarget,
  tradeEconomics,
  updatePosition,
  zoneUtility,
  type BookSnapshot,
  type CompletedMinuteCandle,
  type Decision,
  type FlowEvidence,
  type LiquidationBand,
  type LiquidityRoute,
  type LiquidityZone,
  type PaperPlan,
  type PaperPosition,
  type RangeBand,
  type RangeRole,
  type RangeStructure,
  type Side,
  type TimeframeState,
  type WallEvidence,
  WALL_WINDOW,
} from "./liquidity-core.ts";

export const PLAN_TTL_MS = 15 * 60_000;

export type RangeSweepObservation = {
  structureId: string;
  structureRole: "PARENT" | "CHILD";
  side: Side;
  boundary: number;
  buffer: number;
  extreme: number;
  sweptAt: number;
  lastObservedAt: number;
  reclaimCount: number;
  reclaimedAt?: number;
};

export type SymbolMemory = {
  lastSequence: number;
  lastBookObservedAt: number;
  priorMid: number;
  lastMid: number;
  lastBidDepth: number;
  lastAskDepth: number;
  lastOpenInterest: number;
  lastOiStatTime: number;
  flow: FlowEvidence;
  midpoints: number[];
  wallFrames: string[][];
  wallEvidence: Record<string, WallEvidence>;
  actualLiquidationNotional: number;
  recentLiquidations: Array<{ side: "LONG" | "SHORT"; price: number; notional: number; observedAt: number }>;
  lastTradeId: number;
  lastLiquidationTime: number;
  oiUpdatedAt: number;
  tradesUpdatedAt: number;
  liquidationsUpdatedAt: number;
  quantoMultiplier: number;
  maintenanceRate: number;
  longCohortNotional: number;
  shortCohortNotional: number;
  structureZones: LiquidityZone[];
  structureByTimeframe: { m1: LiquidityZone[]; m15: LiquidityZone[]; h1: LiquidityZone[]; h4: LiquidityZone[] };
  range15m: RangeStructure | null;
  oiCohorts: Array<{ entryPrice: number; longNotional: number; shortNotional: number }>;
  timeframeBias: { m1: TimeframeState; m15: TimeframeState; h1: TimeframeState; h4: TimeframeState };
  timeframeUpdatedAt: { m1: number; m15: number; h1: number; h4: number };
  lastCompletedMinuteClose: number;
  lastCompletedMinuteCandle: CompletedMinuteCandle | null;
  minuteNoiseRate: number;
  rangeSweeps: RangeSweepObservation[];
};

export function emptySymbolMemory(): SymbolMemory {
  return {
    lastSequence: 0, lastBookObservedAt: 0, priorMid: 0,
    lastMid: 0,
    lastBidDepth: 0,
    lastAskDepth: 0,
    lastOpenInterest: 0, lastOiStatTime: 0,
    flow: { ofi: 0, micropriceDisplacementBps: 0, takerDelta: 0, openInterestDelta: 0, funding: 0, actualLiquidations: 0, priceResponseBps: 0 },
    midpoints: [],
    wallFrames: [],
    wallEvidence: {},
    actualLiquidationNotional: 0, recentLiquidations: [],
    lastTradeId: 0, lastLiquidationTime: 0, oiUpdatedAt: 0, tradesUpdatedAt: 0, liquidationsUpdatedAt: 0,
    quantoMultiplier: 1,
    maintenanceRate: 0.005,
    longCohortNotional: 0,
    shortCohortNotional: 0,
    structureZones: [], structureByTimeframe: { m1: [], m15: [], h1: [], h4: [] }, range15m: null,
    oiCohorts: [],
    timeframeBias: { m1: "UNKNOWN", m15: "UNKNOWN", h1: "UNKNOWN", h4: "UNKNOWN" }, timeframeUpdatedAt: { m1: 0, m15: 0, h1: 0, h4: 0 },
    lastCompletedMinuteClose: 0,
    lastCompletedMinuteCandle: null,
    minuteNoiseRate: 0,
    rangeSweeps: [],
  };
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function mid(snapshot: BookSnapshot) {
  return ((snapshot.bids[0]?.price ?? 0) + (snapshot.asks[0]?.price ?? 0)) / 2;
}

function wallKey(zone: LiquidityZone, midpoint: number, tickSize: number) {
  if (zone.identity) return zone.identity;
  const width = Math.max(tickSize * 5, midpoint * 0.0002);
  return `${zone.side}:${Math.round(zone.price / width)}`;
}

export function updateWallMemory(memory: SymbolMemory, snapshot: BookSnapshot, zones: LiquidityZone[]) {
  const midpoint = mid(snapshot);
  const keys = zones.map((zone) => wallKey(zone, midpoint, snapshot.tickSize));
  const unique = [...new Set(keys)];
  const previous = new Set(memory.wallFrames.at(-1) ?? []);
  const current = new Set(unique);
  const removed = [...previous].filter((key) => !current.has(key));
  for (const evidence of Object.values(memory.wallEvidence)) evidence.snapshots += 1;
  for (const key of unique) {
    const evidence = memory.wallEvidence[key] ?? { snapshots: 1, seen: 0, approachCancels: 0, approachObservations: 0 };
    evidence.seen += 1;
    memory.wallEvidence[key] = evidence;
  }
  const approaching = (key: string) => key.startsWith("LONG:") ? midpoint > memory.priorMid : midpoint < memory.priorMid;
  for (const key of previous) {
    const evidence = memory.wallEvidence[key];
    if (evidence && memory.priorMid > 0 && approaching(key)) evidence.approachObservations += 1;
  }
  for (const key of removed) {
    const evidence = memory.wallEvidence[key];
    if (evidence && memory.priorMid > 0 && approaching(key)) evidence.approachCancels += 1;
  }
  memory.wallFrames.push(unique);
  if (memory.wallFrames.length > WALL_WINDOW) {
    const expired = memory.wallFrames.shift() ?? [];
    for (const key of expired) {
      const evidence = memory.wallEvidence[key];
      if (evidence) {
        evidence.seen = Math.max(0, evidence.seen - 1);
        evidence.snapshots = Math.min(WALL_WINDOW, evidence.snapshots);
      }
    }
  }
  for (const [key, evidence] of Object.entries(memory.wallEvidence)) {
    evidence.snapshots = Math.min(WALL_WINDOW, Math.max(evidence.snapshots, memory.wallFrames.length));
    if (!memory.wallFrames.some((frame) => frame.includes(key)) && evidence.snapshots >= WALL_WINDOW) delete memory.wallEvidence[key];
  }
}

export function applyFlow(memory: SymbolMemory, snapshot: BookSnapshot) {
  const midpoint = mid(snapshot);
  memory.flow.priceResponseBps = memory.lastMid > 0 ? (midpoint - memory.lastMid) / memory.lastMid * 10_000 : 0;
  const bidDepth = snapshot.bids.slice(0, 20).reduce((sum, row) => sum + row.size, 0);
  const askDepth = snapshot.asks.slice(0, 20).reduce((sum, row) => sum + row.size, 0);
  const bidChange = bidDepth - memory.lastBidDepth;
  const askChange = askDepth - memory.lastAskDepth;
  const scale = Math.max(1, Math.abs(bidChange) + Math.abs(askChange));
  const ofi = clamp((bidChange - askChange) / scale, -1, 1);
  const bestBid = snapshot.bids[0];
  const bestAsk = snapshot.asks[0];
  const microprice = bestBid && bestAsk
    ? (bestAsk.price * bestBid.size + bestBid.price * bestAsk.size) / Math.max(1e-9, bestBid.size + bestAsk.size)
    : midpoint;
  memory.flow.ofi = memory.lastMid > 0 ? ofi : 0;
  memory.flow.micropriceDisplacementBps = midpoint > 0 ? (microprice - midpoint) / midpoint * 10_000 : 0;
  memory.priorMid = memory.lastMid;
  memory.lastBidDepth = bidDepth;
  memory.lastAskDepth = askDepth;
  memory.lastMid = midpoint;
  memory.midpoints.push(midpoint);
  if (memory.midpoints.length > 120) memory.midpoints.shift();
}

export function inferLiquidationBands(memory: SymbolMemory, snapshot: BookSnapshot): LiquidationBand[] {
  const midpoint = mid(snapshot);
  const cumulativeDepth = (side: "LONG" | "SHORT", price: number) => (side === "LONG"
    ? snapshot.asks.filter((row) => row.price <= price)
    : snapshot.bids.filter((row) => row.price >= price)).reduce((sum, row) => sum + row.size, 0);
  const upwardOpposingDepth = snapshot.asks.slice(0, 40).reduce((sum, row) => sum + row.size, 0);
  const downwardOpposingDepth = snapshot.bids.slice(0, 40).reduce((sum, row) => sum + row.size, 0);
  const referenceDepth = Math.max(1, (upwardOpposingDepth + downwardOpposingDepth) / 2);
  const cohorts = memory.oiCohorts.length ? memory.oiCohorts : [{ entryPrice: midpoint, longNotional: memory.longCohortNotional, shortNotional: memory.shortCohortNotional }];
  const projected = cohorts.flatMap((cohort) => ([5, 10, 20, 50] as const).flatMap((leverage) => {
    const distance = Math.max(0.005, 1 / leverage - memory.maintenanceRate);
    return [
      { side: "LONG" as const, price: cohort.entryPrice * (1 + distance), expectedForcedNotional: cohort.shortNotional / 4, opposingDepth: 0, leverage, actualCalibration: 0.7 },
      { side: "SHORT" as const, price: cohort.entryPrice * (1 - distance), expectedForcedNotional: cohort.longNotional / 4, opposingDepth: 0, leverage, actualCalibration: 0.7 },
    ];
  })).filter((band) => band.side === "LONG"
    ? band.price > midpoint && band.price <= (snapshot.asks.at(-1)?.price ?? midpoint)
    : band.price < midpoint && band.price >= (snapshot.bids.at(-1)?.price ?? midpoint));
  const binWidth = Math.max(snapshot.tickSize * 5, midpoint * 0.0002);
  const merged = new Map<string, LiquidationBand>();
  for (const band of projected) {
    const key = `${band.side}:${Math.round(band.price / binWidth)}`;
    const prior = merged.get(key);
    if (prior) prior.expectedForcedNotional += band.expectedForcedNotional;
    else merged.set(key, { ...band });
  }
  return [...merged.values()].sort((a, b) => a.side === "LONG" ? a.price - b.price : b.price - a.price).map((band, index, ordered) => {
    const previous = ordered.slice(0, index).reverse().find((item) => item.side === band.side);
    const from = previous?.price ?? midpoint;
    const segmentDepth = (band.side === "LONG"
      ? snapshot.asks.filter((row) => row.price > from && row.price <= band.price)
      : snapshot.bids.filter((row) => row.price < from && row.price >= band.price)).reduce((sum, row) => sum + row.size, 0);
    const actual = memory.recentLiquidations.filter((row) => row.side === band.side && snapshot.observedAt - row.observedAt <= 120_000
      && Math.abs(row.price - band.price) / midpoint <= 0.01).reduce((sum, row) => sum + row.notional, 0);
    return { ...band, opposingDepth: Math.max(1, cumulativeDepth(band.side, band.price)), segmentDepth: Math.max(1, segmentDepth), actualCalibration: actual > 0 ? 1 + Math.min(2, actual / referenceDepth) : 0.7 };
  });
}

function repeatedExtrema(memory: SymbolMemory, midpoint: number): LiquidityZone[] {
  const values = memory.midpoints;
  if (values.length < 12) return [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = 2; index < values.length - 2; index += 1) {
    const value = values[index];
    const window = values.slice(index - 2, index + 3);
    if (value === Math.max(...window)) highs.push(value);
    if (value === Math.min(...window)) lows.push(value);
  }
  const zones: LiquidityZone[] = [];
  for (const [rows, side] of [[highs, "LONG"], [lows, "SHORT"]] as const) {
    if (!rows.length) continue;
    const price = rows.reduce((sum, value) => sum + value, 0) / rows.length;
    const repeat = rows.filter((value) => Math.abs(value - price) / midpoint < 0.0015).length;
    if (repeat < 2 || (side === "LONG" ? price <= midpoint : price >= midpoint)) continue;
    zones.push(zoneUtility({
      identity: `LOCAL:${side}:${stablePriceBin(price)}`,
      side,
      price,
      liquidity: repeat * 2,
      cascade: 0,
      pathCost: 1,
      distanceCost: Math.max(0.5, Math.abs(price - midpoint) / midpoint * 1_000),
      probabilityReach: 0.54,
      persistence: clamp(repeat / 8, 0.25, 0.9),
      source: "STOP_POOL",
    }));
  }
  return zones;
}

function observeRealtimeRangeSweeps(memory: SymbolMemory, midpoint: number, observedAt: number, absorption: number) {
  const parent = memory.range15m;
  if (!parent || (parent.breakState ?? "INSIDE") !== "INSIDE") {
    memory.rangeSweeps = [];
    return;
  }
  const bands: RangeBand[] = [parent];
  if (parent.child && (parent.child.breakState ?? "INSIDE") === "INSIDE") bands.push(parent.child);
  const activeIds = new Set(bands.map((band) => band.id).filter((id): id is string => Boolean(id)));
  memory.rangeSweeps = memory.rangeSweeps.filter((row) => activeIds.has(row.structureId)
    && observedAt - row.lastObservedAt <= 3 * 60_000);
  for (const band of bands) {
    if (!band.id) continue;
    const width = band.upper - band.lower;
    const buffer = Math.max(midpoint * 0.00025, width * 0.06);
    for (const side of ["LONG", "SHORT"] as const) {
      const boundary = side === "LONG" ? band.lower : band.upper;
      const swept = side === "LONG" ? midpoint <= boundary - buffer * 0.25 : midpoint >= boundary + buffer * 0.25;
      const reclaimed = side === "LONG" ? midpoint >= boundary + buffer * 0.15 : midpoint <= boundary - buffer * 0.15;
      const index = memory.rangeSweeps.findIndex((row) => row.structureId === band.id && row.side === side);
      let row = index >= 0 ? memory.rangeSweeps[index] : null;
      if (swept) {
        if (!row) {
          row = { structureId: band.id, structureRole: band.role ?? "PARENT", side, boundary, buffer,
            extreme: midpoint, sweptAt: observedAt, lastObservedAt: observedAt, reclaimCount: 0 };
          memory.rangeSweeps.push(row);
        } else {
          row.extreme = side === "LONG" ? Math.min(row.extreme, midpoint) : Math.max(row.extreme, midpoint);
          row.lastObservedAt = observedAt;
          row.reclaimCount = 0;
          row.reclaimedAt = undefined;
        }
        continue;
      }
      if (!row || !reclaimed) continue;
      const confirmation = routeConfirmation(memory, side);
      const strong = confirmation >= 0.65 && absorption >= 0.60;
      const consecutive = observedAt - row.lastObservedAt <= 10_000;
      row.reclaimCount = strong ? (consecutive ? row.reclaimCount + 1 : 1) : 0;
      row.lastObservedAt = observedAt;
      if (row.reclaimCount >= 4) row.reclaimedAt ??= observedAt;
    }
  }
}

export function analyzeSnapshot(memory: SymbolMemory, snapshot: BookSnapshot) {
  const midpoint = mid(snapshot);
  const rawBookZones = aggregateBook(snapshot);
  const rankedLiquidity = rawBookZones.map((zone) => zone.liquidity).sort((a, b) => a - b);
  const wallCutoff = rankedLiquidity[Math.max(0, Math.floor(rankedLiquidity.length * 0.75))] ?? Infinity;
  updateWallMemory(memory, snapshot, rawBookZones.filter((zone) => zone.liquidity >= wallCutoff));
  const bookZones = rawBookZones.filter((zone) => zone.liquidity >= wallCutoff).map((zone) => zoneUtility({
    identity: zone.identity,
    side: zone.side,
    price: zone.price,
    liquidity: zone.liquidity,
    cascade: zone.cascade,
    pathCost: zone.pathCost,
    distanceCost: zone.distanceCost,
    probabilityReach: zone.probabilityReach,
    persistence: zone.persistence,
    source: zone.source,
  }, memory.wallEvidence[wallKey(zone, midpoint, snapshot.tickSize)]));
  const bands = inferLiquidationBands(memory, snapshot);
  const bookScale = Math.max(1, bookZones.sort((a, b) => a.liquidity - b.liquidity)[Math.floor(bookZones.length / 2)]?.liquidity ?? 1);
  const liquidationZones = bands.map((band) => zoneUtility({
    identity: `LIQ:${band.side}:${stablePriceBin(band.price)}`,
    side: band.side, price: band.price, liquidity: 0, cascade: band.expectedForcedNotional * Math.max(0.25, band.actualCalibration),
    pathCost: Math.max(1, band.segmentDepth ?? band.opposingDepth), distanceCost: Math.max(1, Math.abs(band.price - midpoint) / midpoint * 10_000),
    probabilityReach: clamp(0.72 - Math.abs(band.price - midpoint) / midpoint * 4, 0.08, 0.72), persistence: 0.7,
    source: "LIQUIDATION",
  }));
  const structureZones = [
    ...(snapshot.observedAt - memory.timeframeUpdatedAt.m1 <= 3 * 60_000 ? memory.structureByTimeframe.m1 : []),
    ...(snapshot.observedAt - memory.timeframeUpdatedAt.m15 <= 45 * 60_000 ? memory.structureByTimeframe.m15 : []),
    ...(snapshot.observedAt - memory.timeframeUpdatedAt.h1 <= 3 * 60 * 60_000 ? memory.structureByTimeframe.h1 : []),
    ...(snapshot.observedAt - memory.timeframeUpdatedAt.h4 <= 12 * 60 * 60_000 ? memory.structureByTimeframe.h4 : []),
  ];
  const zones = [...bookZones, ...liquidationZones, ...repeatedExtrema(memory, midpoint), ...structureZones].map((zone) => {
    const nearby = bands.filter((band) => band.side === zone.side && Math.abs(band.price - zone.price) / midpoint < 0.01);
    const baseLiquidity = zone.source === "BOOK" || zone.source === "LIQUIDATION" ? zone.liquidity : zone.liquidity * bookScale * 0.08;
    const visible = zone.side === "LONG"
      ? zone.price <= (snapshot.asks.at(-1)?.price ?? -Infinity)
      : zone.price >= (snapshot.bids.at(-1)?.price ?? Infinity);
    const pathDepth = (zone.side === "LONG" ? snapshot.asks.filter((level) => level.price < zone.price) : snapshot.bids.filter((level) => level.price > zone.price))
      .reduce((sum, level) => sum + level.size, 0);
    const distanceBps = Math.abs(zone.price - midpoint) / midpoint * 10_000;
    return zoneUtility({
      identity: zone.identity,
      side: zone.side,
      price: zone.price,
      liquidity: baseLiquidity,
      cascade: zone.cascade + nearby.reduce((sum, band) => sum + band.expectedForcedNotional * Math.min(2, cascadeRatio(band)), 0),
      pathCost: Math.max(bookScale * 0.05, pathDepth) * (visible ? 1 : 10),
      distanceCost: Math.max(bookScale * 0.02, bookScale * distanceBps / 500),
      probabilityReach: visible ? clamp(zone.probabilityReach + Math.sign(zone.side === "LONG" ? 1 : -1) * memory.flow.ofi * 0.12, 0.05, 0.95) : 0.05,
      persistence: zone.persistence,
      source: zone.source,
    });
  });
  const activeFlow = Math.abs(memory.flow.takerDelta);
  const absorption = clamp(activeFlow * (1 - Math.min(1, Math.abs(memory.flow.priceResponseBps) / Math.max(2, activeFlow * 8))), 0, 1);
  observeRealtimeRangeSweeps(memory, midpoint, snapshot.observedAt, absorption);
  const freshBias = {
    m1: snapshot.observedAt - memory.timeframeUpdatedAt.m1 <= 3 * 60_000 ? memory.timeframeBias.m1 : "UNKNOWN" as const,
    m15: snapshot.observedAt - memory.timeframeUpdatedAt.m15 <= 45 * 60_000 ? memory.timeframeBias.m15 : "UNKNOWN" as const,
    h1: snapshot.observedAt - memory.timeframeUpdatedAt.h1 <= 3 * 60 * 60_000 ? memory.timeframeBias.h1 : "UNKNOWN" as const,
    h4: snapshot.observedAt - memory.timeframeUpdatedAt.h4 <= 12 * 60 * 60_000 ? memory.timeframeBias.h4 : "UNKNOWN" as const,
  };
  const routes = buildLiquidityRoutes(memory, snapshot.symbol, snapshot.observedAt, midpoint, absorption);
  const fallbackDecision = decideThreeState({ symbol: snapshot.symbol, observedAt: snapshot.observedAt, mid: midpoint, zones, bands,
    flow: memory.flow, absorption, timeframeBias: freshBias, minuteNoiseRate: memory.minuteNoiseRate });
  const decision = arbitrateDecision(routes, snapshot.observedAt, fallbackDecision);
  const confirmationBySide = { LONG: routeConfirmation(memory, "LONG"), SHORT: routeConfirmation(memory, "SHORT") };
  return { midpoint, zones, bands, absorption, decision, routes, range15m: memory.range15m, confirmationBySide };
}

export function updateOpenInterestCohorts(memory: SymbolMemory, nextOpenInterest: number) {
  const previous = memory.lastOpenInterest;
  const delta = previous > 0 ? (nextOpenInterest - previous) / previous : 0;
  memory.flow.openInterestDelta = clamp(delta * 10, -1, 1);
  const changeNotional = Math.abs(nextOpenInterest - previous) * Math.max(memory.lastMid, 1) * Math.max(memory.quantoMultiplier, 1e-12);
  if (delta > 0) {
    const binWidth = Math.max(memory.lastMid * 0.002, 1e-9);
    const entryPrice = Math.round(memory.lastMid / binWidth) * binWidth;
    let cohort = memory.oiCohorts.find((item) => Math.abs(item.entryPrice - entryPrice) < binWidth * 0.5);
    if (!cohort) {
      cohort = { entryPrice, longNotional: 0, shortNotional: 0 };
      memory.oiCohorts.push(cohort);
      if (memory.oiCohorts.length > 12) memory.oiCohorts.shift();
    }
    // OI is created in paired long/short contracts; taker flow can only tilt the estimate.
    const longShare = clamp(0.5 + memory.flow.takerDelta * 0.15, 0.35, 0.65);
    const longAdded = changeNotional * longShare;
    const shortAdded = changeNotional - longAdded;
    memory.longCohortNotional += longAdded; cohort.longNotional += longAdded;
    memory.shortCohortNotional += shortAdded; cohort.shortNotional += shortAdded;
  } else if (delta < 0) {
    const remaining = Math.max(0, 1 - Math.abs(delta));
    memory.longCohortNotional *= remaining;
    memory.shortCohortNotional *= remaining;
    for (const cohort of memory.oiCohorts) { cohort.longNotional *= remaining; cohort.shortNotional *= remaining; }
  }
  memory.lastOpenInterest = nextOpenInterest;
}

type StructureCandle = { time: number; volume: number; close: number; high: number; low: number; open: number };

export function deriveMinuteNoiseRate(rows: StructureCandle[]) {
  const ranges = rows.slice(-20).map((row) => (row.high - row.low) / Math.max((row.high + row.low + row.close) / 3, 1e-9))
    .filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!ranges.length) return 0;
  const percentile = ranges[Math.min(ranges.length - 1, Math.floor((ranges.length - 1) * 0.7))];
  return clamp(percentile, 0, 0.0045);
}

export function aggregateFourHourCandles(rows: StructureCandle[]) {
  const groups = new Map<number, StructureCandle[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.time / 14_400) * 14_400;
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, group]) => {
    const ordered = [...group].sort((a, b) => a.time - b.time);
    const contiguous = ordered.length === 4 && ordered.every((row, index) => row.time === time + index * 3_600);
    if (!contiguous) return [];
    return [{ time, open: ordered[0].open, close: ordered[3].close,
      high: Math.max(...ordered.map((row) => row.high)), low: Math.min(...ordered.map((row) => row.low)),
      volume: ordered.reduce((sum, row) => sum + row.volume, 0) }];
  });
}

function deriveRangeBand(rows: StructureCandle[], role: "PARENT" | "CHILD", size: number, upperRatio: number, lowerRatio: number): RangeBand | null {
  // The last two completed candles are evidence about an already-built
  // boundary, not input allowed to move that boundary after the fact.
  const evidence = rows.slice(-2);
  const history = rows.slice(0, -2);
  if (history.length < size) return null;
  const window = history.slice(-size);
  const quantile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
  };
  const upper = quantile(window.map((row) => row.high), upperRatio);
  const lower = quantile(window.map((row) => row.low), lowerRatio);
  const midpoint = (upper + lower) / 2;
  const width = upper - lower;
  const widthRate = width / Math.max(midpoint, 1e-9);
  const maximumWidth = role === "PARENT" ? 0.04 : 0.025;
  if (!(lower > 0 && widthRate >= 0.0012 && widthRate <= maximumWidth)) return null;
  const edge = width * (role === "PARENT" ? 0.12 : 0.16);
  const touchesUpper = window.filter((row) => row.high >= upper - edge).length;
  const touchesLower = window.filter((row) => row.low <= lower + edge).length;
  const contained = window.filter((row) => row.close <= upper + edge * 0.4 && row.close >= lower - edge * 0.4).length / window.length;
  const drift = Math.abs(window.at(-1)!.close - window[0].open) / width;
  const quality = clamp(contained * 0.45 + Math.min(1, touchesUpper / 3) * 0.2
    + Math.min(1, touchesLower / 3) * 0.2 + Math.max(0, 1 - drift) * 0.15, 0, 1);
  const minimumQuality = role === "PARENT" ? 0.62 : 0.58;
  if (touchesUpper < 2 || touchesLower < 2 || quality < minimumQuality) return null;
  const tolerance = Math.max(midpoint * 0.0003, width * 0.04);
  const brokenUp = evidence.length === 2 && evidence.every((row) => row.close > upper + tolerance);
  const brokenDown = evidence.length === 2 && evidence.every((row) => row.close < lower - tolerance);
  const breakState = brokenUp ? "BROKEN_UP" as const : brokenDown ? "BROKEN_DOWN" as const : "INSIDE" as const;
  const observedAt = ((rows.at(-1) ?? window.at(-1)!).time + 900) * 1_000;
  const lowerExcursions = window.map((row) => Math.max(0, lower - row.low)).filter((value) => value > 0);
  const upperExcursions = window.map((row) => Math.max(0, row.high - upper)).filter((value) => value > 0);
  const sweepDepth = (values: number[]) => values.length ? quantile(values, 0.8) : 0;
  return { lower, upper, midpoint, widthRate, touchesLower, touchesUpper, quality, observedAt,
    id: `${role}:${stablePriceBin(lower)}:${stablePriceBin(upper)}`, role, breakState,
    lowerSweepDepth: sweepDepth(lowerExcursions), upperSweepDepth: sweepDepth(upperExcursions) };
}

export function deriveRangeStructure(rows: StructureCandle[]): RangeStructure | null {
  if (rows.length < 12) return null;
  const child = deriveRangeBand(rows, "CHILD", 10, 0.75, 0.25);
  if (!child) return null;
  const recent = rows.slice(-12);
  const candidates = [24, 36, 48, 72].flatMap((size) => {
    const band = deriveRangeBand(rows, "PARENT", size, 0.88, 0.12);
    if (!band) return [];
    const recentContained = recent.filter((row) => row.close <= band.upper + (band.upper - band.lower) * 0.05
      && row.close >= band.lower - (band.upper - band.lower) * 0.05).length / Math.max(recent.length, 1);
    const nested = band.lower <= child.lower + (child.upper - child.lower) * 0.2
      && band.upper >= child.upper - (child.upper - child.lower) * 0.2;
    return recentContained >= 0.75 && nested && band.widthRate >= child.widthRate * 1.35 ? [band] : [];
  });
  // Prefer the nearest valid parent regime. Wider, older windows are only used
  // when the recent 24-candle structure cannot contain the child balance.
  const parent = candidates[0];
  if (!parent) {
    return { ...child, id: `PARENT:${stablePriceBin(child.lower)}:${stablePriceBin(child.upper)}`,
      role: "PARENT", child: null };
  }
  const distinctChild = child.widthRate <= parent.widthRate * 0.8 ? child : null;
  return { ...parent, child: distinctChild };
}

function routeConfirmation(memory: SymbolMemory, side: Side) {
  const direction = side === "LONG" ? 1 : -1;
  const bias = (value: TimeframeState) => value === "UP" ? 1 : value === "DOWN" ? -1 : 0;
  const aligned = direction * (bias(memory.timeframeBias.m1) * 0.12 + bias(memory.timeframeBias.m15) * 0.22
    + bias(memory.timeframeBias.h1) * 0.18 + bias(memory.timeframeBias.h4) * 0.08);
  return clamp(0.5 + direction * flowPressure(memory.flow) * 0.34 + aligned, 0, 1);
}

export function buildLiquidityRoutes(memory: SymbolMemory, symbol: string, observedAt: number, midpoint: number, absorption: number) {
  const range = memory.range15m;
  if (!range || midpoint <= 0 || observedAt - range.observedAt > 45 * 60_000) return [] as LiquidityRoute[];
  const parentActive = (range.breakState ?? "INSIDE") === "INSIDE";
  const child = parentActive && range.child && (range.child.breakState ?? "INSIDE") === "INSIDE" ? range.child : null;
  const width = range.upper - range.lower;
  const buffer = Math.max(midpoint * 0.00025, width * 0.06);
  const minimumStopRate = Math.max(MIN_STRUCTURAL_STOP_RATE, memory.minuteNoiseRate * 1.1);
  const activationDistanceRate = Math.max(0.0025, Math.min(0.0075, range.widthRate * 0.65));
  const maxSegmentDistanceRate = Math.max(0.012, Math.min(0.015, range.widthRate * 3));
  const higher = (side: Side) => {
    const ordered = [
      ...memory.structureByTimeframe.m15.map((zone) => ({ zone, timeframe: "15m" as const })),
      ...memory.structureByTimeframe.h4.map((zone) => ({ zone, timeframe: "4h" as const })),
      ...memory.structureByTimeframe.h1.map((zone) => ({ zone, timeframe: "1h" as const })),
    ].filter((item) => item.zone.side === side && (side === "LONG" ? item.zone.price > range.upper + buffer : item.zone.price < range.lower - buffer))
      .sort((a, b) => side === "LONG" ? a.zone.price - b.zone.price : b.zone.price - a.zone.price);
    return ordered;
  };
  const routes: LiquidityRoute[] = [];
  const nearestOppositeLiquidity = (side: Side, entry: number, lower: number, upper: number) => {
    const edge = side === "LONG" ? upper : lower;
    const candidates = memory.structureByTimeframe.m15
      .filter((zone) => zone.side === side && zone.price >= lower && zone.price <= upper
        && (side === "LONG" ? zone.price > entry : zone.price < entry))
      .sort((a, b) => side === "LONG" ? a.price - b.price : b.price - a.price);
    const first = candidates[0];
    return first
      ? { price: first.price, identity: first.identity ?? `STOP:15m:${side}:${stablePriceBin(first.price)}`,
        next: Math.abs(first.price - edge) / Math.max(edge, 1e-9) > 0.001 ? edge : null }
      : { price: edge, identity: `RANGE_OPPOSITE:${side}:${stablePriceBin(edge)}`, next: null };
  };
  const pushEdgeReclaimRoute = (band: RangeBand, role: RangeRole, crossedSide: Side, boundary: number,
    bandBuffer: number, activationRate: number) => {
    const side: Side = crossedSide === "LONG" ? "SHORT" : "LONG";
    const minute = memory.lastCompletedMinuteCandle;
    const minuteRange = minute ? Math.max(minute.high - minute.low, midpoint * 1e-9) : 0;
    const minuteSwept = minute != null && (side === "LONG"
      ? minute.low <= boundary - bandBuffer * 0.25
      : minute.high >= boundary + bandBuffer * 0.25);
    const minuteReclaimed = minute != null && (side === "LONG"
      ? minute.close >= boundary + bandBuffer * 0.15 && minute.close > minute.open
      : minute.close <= boundary - bandBuffer * 0.15 && minute.close < minute.open);
    const minuteRetention = !minute ? 0 : side === "LONG"
      ? (minute.close - minute.low) / minuteRange
      : (minute.high - minute.close) / minuteRange;
    const completedSignal = minuteSwept && minuteReclaimed && minuteRetention >= 0.55;
    const realtime = memory.rangeSweeps.find((row) => row.structureId === band.id && row.side === side
      && row.reclaimedAt != null && observedAt - row.reclaimedAt <= 30_000 && row.reclaimCount >= 4);
    if (!completedSignal && !realtime) return;
    const reclaimSource = completedSignal ? "COMPLETED_MINUTE" as const : "FAST_BOOK" as const;
    const sweepExtreme = completedSignal ? (side === "LONG" ? minute!.low : minute!.high) : realtime!.extreme;
    const confirmationScore = routeConfirmation(memory, side);
    const reclaimStrength = clamp(band.quality * 0.35 + (completedSignal ? minuteRetention : 0.75) * 0.35
      + confirmationScore * 0.2 + absorption * 0.1, 0, 1);
    const fakeoutRisk = clamp((1 - reclaimStrength) * 0.8
      + (memory.timeframeBias.h1 === (side === "LONG" ? "DOWN" : "UP") ? 0.12 : 0), 0, 1);
    const entryTrigger = side === "LONG" ? boundary + bandBuffer * 0.2 : boundary - bandBuffer * 0.2;
    const minimumStopDistance = entryTrigger * minimumStopRate;
    const historicalSweepDepth = side === "LONG" ? band.lowerSweepDepth ?? 0 : band.upperSweepDepth ?? 0;
    const historicalEnvelope = Math.max(bandBuffer * 1.5, historicalSweepDepth * 1.15, minimumStopDistance);
    const sweepPadding = Math.max(bandBuffer * 0.25, minimumStopDistance * 0.25);
    const invalidation = side === "LONG"
      ? Math.min(boundary - historicalEnvelope, sweepExtreme - sweepPadding, entryTrigger - minimumStopDistance)
      : Math.max(boundary + historicalEnvelope, sweepExtreme + sweepPadding, entryTrigger + minimumStopDistance);
    const lossRate = Math.abs(entryTrigger - invalidation) / Math.max(entryTrigger, 1e-9) + ROUND_TRIP_FRICTION_RATE;
    const requiredDistance = entryTrigger * (lossRate * MIN_NET_REWARD_RISK + ROUND_TRIP_FRICTION_RATE);
    const width = band.upper - band.lower;
    const cap = side === "LONG" ? band.lower + width * 0.7 : band.upper - width * 0.7;
    const target = side === "LONG"
      ? Math.min(cap, Math.max(band.midpoint, entryTrigger + requiredDistance))
      : Math.max(cap, Math.min(band.midpoint, entryTrigger - requiredDistance));
    const targetAhead = side === "LONG" ? target > entryTrigger : target < entryTrigger;
    const economicallyReachable = side === "LONG" ? target >= entryTrigger + requiredDistance : target <= entryTrigger - requiredDistance;
    const waitingInsideRetest = side === "LONG" ? midpoint > entryTrigger : midpoint < entryTrigger;
    if (!targetAhead || !economicallyReachable || Math.abs(target - entryTrigger) / midpoint < MIN_TARGET_DISTANCE_RATE) return;
    routes.push({ id: `${symbol}:EDGE_REJECTION:${side}:${band.id ?? stablePriceBin(boundary)}:${completedSignal ? minute!.time : realtime!.sweptAt}`,
      symbol, side, kind: "EDGE_REJECTION", stage: "LOCAL_TO_NODE", entryTrigger, invalidation,
      target, targetIdentity: `RANGE_SEGMENT:${side}:${stablePriceBin(target)}`, targetTimeframe: "15m",
      nextTarget: null, confirmationScore, fakeoutRisk, activationDistanceRate: activationRate,
      score: band.quality * 0.4 + reclaimStrength * 0.45 + confirmationScore * 0.15,
      executableNow: waitingInsideRetest && Math.abs(entryTrigger - midpoint) / midpoint <= activationRate
        && confirmationScore >= 0.42 && fakeoutRisk <= 0.72,
      structureId: band.id, structureRole: role, rangeBoundary: boundary, rangeBuffer: bandBuffer,
      sweepExtreme, reclaimSource, reclaimStrength,
      reason: [`完整${reclaimSource === "FAST_BOOK" ? "实时盘口" : "1分钟K线"}确认${role === "CHILD" ? "子" : "父"}区间扫边并收回`,
        "不在扫流动性过程中接单，只等待区间内侧回踩", "硬止损位于本次扫盘、历史扫盘与分钟噪声之外",
        "反转强度只调整置信度；只要价格继续接受在区间内就保留震荡逻辑"] });
  };
  const pushRetestRoute = (input: {
    band: RangeBand; role: RangeRole; side: Side; boundary: number; bandBuffer: number;
    target: number; targetIdentity: string; targetTimeframe: "15m" | "1h" | "4h"; nextTarget: number | null;
    confirmationScore: number; fakeoutRisk: number; activationRate: number; baseScore: number;
  }) => {
    const minute = memory.lastCompletedMinuteCandle;
    if (!minute) return;
    const candleRange = Math.max(minute.high - minute.low, midpoint * 1e-9);
    const closeRetention = input.side === "LONG"
      ? (minute.close - minute.low) / candleRange
      : (minute.high - minute.close) / candleRange;
    const heldBoundary = input.side === "LONG"
      ? minute.open > input.boundary && minute.low <= input.boundary + input.bandBuffer * 1.25
        && minute.low >= input.boundary - input.bandBuffer * 0.5
        && minute.close >= input.boundary + input.bandBuffer * 0.2 && minute.close > minute.open
      : minute.open < input.boundary && minute.high >= input.boundary - input.bandBuffer * 1.25
        && minute.high <= input.boundary + input.bandBuffer * 0.5
        && minute.close <= input.boundary - input.bandBuffer * 0.2 && minute.close < minute.open;
    if (!heldBoundary || closeRetention < 0.55) return;
    const entryTrigger = input.side === "LONG"
      ? minute.high + input.bandBuffer * 0.15
      : minute.low - input.bandBuffer * 0.15;
    const minimumStopDistance = entryTrigger * minimumStopRate;
    const invalidation = input.side === "LONG"
      ? Math.min(minute.low - input.bandBuffer * 0.25, entryTrigger - minimumStopDistance)
      : Math.max(minute.high + input.bandBuffer * 0.25, entryTrigger + minimumStopDistance);
    const targetAhead = input.side === "LONG" ? input.target > entryTrigger : input.target < entryTrigger;
    const preAcceleration = input.side === "LONG" ? midpoint < entryTrigger : midpoint > entryTrigger;
    if (!targetAhead || Math.abs(input.target - entryTrigger) / midpoint < MIN_TARGET_DISTANCE_RATE) return;
    routes.push({ id: `${symbol}:BREAKOUT_RETEST:${input.side}:${input.band.id ?? stablePriceBin(input.boundary)}:${minute.time}`,
      symbol, side: input.side, kind: "BREAKOUT_RETEST", stage: "LOCAL_TO_NODE", entryTrigger, invalidation,
      target: input.target, targetIdentity: input.targetIdentity, targetTimeframe: input.targetTimeframe,
      nextTarget: input.nextTarget, confirmationScore: input.confirmationScore, fakeoutRisk: input.fakeoutRisk,
      activationDistanceRate: input.activationRate, score: input.baseScore * 1.04,
      executableNow: preAcceleration && Math.abs(entryTrigger - midpoint) / midpoint <= input.activationRate
        && input.confirmationScore >= 0.62 && input.fakeoutRisk <= 0.48,
      structureId: input.band.id, structureRole: input.role,
      reason: [`完整1分钟在${input.role === "CHILD" ? "子" : "父"}区间边界外回踩并守住`,
        "不在首次突破后追价，只等待重新越过回踩K线极值", "当前第一目标必须独立满足扣成本经济性"] });
  };
  const pushFailedBreakRoute = (band: RangeBand, role: RangeRole, crossedSide: Side, boundary: number,
    bandBuffer: number, activationRate: number) => {
    const minute = memory.lastCompletedMinuteCandle;
    if (!minute) return;
    const candleRange = Math.max(minute.high - minute.low, midpoint * 1e-9);
    const reversalSide: Side = crossedSide === "LONG" ? "SHORT" : "LONG";
    const reversalConfirmation = routeConfirmation(memory, reversalSide);
    const swept = crossedSide === "LONG"
      ? minute.high >= boundary + bandBuffer * 0.25
      : minute.low <= boundary - bandBuffer * 0.25;
    const reclaimed = crossedSide === "LONG"
      ? minute.close <= boundary - bandBuffer * 0.15 && minute.close < minute.open
      : minute.close >= boundary + bandBuffer * 0.15 && minute.close > minute.open;
    const rejectionRetention = crossedSide === "LONG"
      ? (minute.high - minute.close) / candleRange
      : (minute.close - minute.low) / candleRange;
    if (!swept || !reclaimed || rejectionRetention < 0.6) return;
    const entryTrigger = crossedSide === "LONG" ? boundary - bandBuffer * 0.25 : boundary + bandBuffer * 0.25;
    const minimumStopDistance = entryTrigger * minimumStopRate;
    const invalidation = reversalSide === "LONG"
      ? Math.min(minute.low - bandBuffer * 0.25, entryTrigger - minimumStopDistance)
      : Math.max(minute.high + bandBuffer * 0.25, entryTrigger + minimumStopDistance);
    const target = nearestOppositeLiquidity(reversalSide, entryTrigger, band.lower, band.upper);
    if (Math.abs(target.price - entryTrigger) / midpoint < MIN_TARGET_DISTANCE_RATE) return;
    const waitingInsideRetest = reversalSide === "LONG" ? midpoint >= entryTrigger : midpoint <= entryTrigger;
    const fakeoutRisk = clamp((1 - absorption) * 0.45 + (1 - reversalConfirmation) * 0.55, 0, 1);
    routes.push({ id: `${symbol}:FAILED_BREAKOUT_REVERSAL:${reversalSide}:${band.id ?? stablePriceBin(boundary)}:${minute.time}`,
      symbol, side: reversalSide, kind: "FAILED_BREAKOUT_REVERSAL", stage: "LOCAL_TO_NODE",
      entryTrigger, invalidation, target: target.price, targetIdentity: target.identity, targetTimeframe: "15m",
      nextTarget: target.next, confirmationScore: reversalConfirmation, fakeoutRisk, activationDistanceRate: activationRate,
      score: band.quality * 0.35 + reversalConfirmation * 0.4 + absorption * 0.25,
      executableNow: waitingInsideRetest && Math.abs(entryTrigger - midpoint) / midpoint <= activationRate
        && absorption >= 0.55 && reversalConfirmation >= 0.55 && fakeoutRisk <= 0.45,
      structureId: band.id, structureRole: role,
      reason: [`${role === "CHILD" ? "子区间" : "父区间"}边界外流动性被扫后完整1分钟收回区间`, "反向实体、收盘保持率、吸收与订单流共同确认失败突破",
        "不追已经离开边界的反向行情，等待区间内部反抽原边界", "第一目标为同级结构最近反向流动性"] });
  };
  for (const side of ["LONG", "SHORT"] as const) {
    if (child) {
      const childWidth = child.upper - child.lower;
      const childBuffer = Math.max(midpoint * 0.00025, childWidth * 0.06);
      const childEntry = side === "LONG" ? child.upper + childBuffer : child.lower - childBuffer;
      const parentTarget = side === "LONG" ? range.upper : range.lower;
      const targetAhead = side === "LONG" ? parentTarget > childEntry : parentTarget < childEntry;
      const targetDistanceRate = Math.abs(parentTarget - childEntry) / midpoint;
      const childStopDistance = childEntry * minimumStopRate;
      const childStructuralStop = side === "LONG" ? child.upper - Math.max(childBuffer * 1.5, childWidth * 0.24)
        : child.lower + Math.max(childBuffer * 1.5, childWidth * 0.24);
      const childInvalidation = side === "LONG" ? Math.min(childStructuralStop, childEntry - childStopDistance)
        : Math.max(childStructuralStop, childEntry + childStopDistance);
      const confirmationScore = routeConfirmation(memory, side);
      const fakeoutRisk = clamp(absorption * 0.35 + (1 - confirmationScore) * 0.55
        + (memory.timeframeBias.h1 === (side === "LONG" ? "DOWN" : "UP") ? 0.18 : 0), 0, 1);
      const childActivation = Math.max(0.002, Math.min(0.006, child.widthRate * 0.7));
      const preTriggerSide = side === "LONG" ? midpoint < childEntry : midpoint > childEntry;
      const childScore = child.quality * 0.28 + range.quality * 0.25 + confirmationScore * 0.47;
      if (targetAhead && targetDistanceRate >= MIN_TARGET_DISTANCE_RATE) {
        routes.push({ id: `${symbol}:INTERNAL_ROTATION:${side}:${child.id ?? stablePriceBin(child.midpoint)}:${range.id ?? stablePriceBin(range.midpoint)}`,
          symbol, side, kind: "INTERNAL_ROTATION", stage: "LOCAL_TO_NODE", entryTrigger: childEntry,
          invalidation: childInvalidation, target: parentTarget,
          targetIdentity: `PARENT_RANGE:${side}:${stablePriceBin(parentTarget)}`, targetTimeframe: "15m",
          nextTarget: null, confirmationScore, fakeoutRisk, activationDistanceRate: childActivation,
          score: childScore,
          executableNow: preTriggerSide && Math.abs(childEntry - midpoint) / midpoint <= childActivation
            && confirmationScore >= 0.52 && fakeoutRisk <= 0.62,
          structureId: child.id, structureRole: "CHILD",
          reason: ["15分钟父区间内部的子区间边界", "本次只属于区间内部迁移，不是父级突破",
            "实际第一目标为15分钟父区间边缘", "第一目标必须独立满足扣成本盈亏比"] });
        pushRetestRoute({ band: child, role: "CHILD", side, boundary: side === "LONG" ? child.upper : child.lower,
          bandBuffer: childBuffer, target: parentTarget,
          targetIdentity: `PARENT_RANGE:${side}:${stablePriceBin(parentTarget)}`, targetTimeframe: "15m",
          nextTarget: null, confirmationScore, fakeoutRisk, activationRate: childActivation, baseScore: childScore });
      }
      pushFailedBreakRoute(child, "CHILD", side, side === "LONG" ? child.upper : child.lower, childBuffer, childActivation);
      pushEdgeReclaimRoute(child, "CHILD", side, side === "LONG" ? child.upper : child.lower, childBuffer, childActivation);
    }
    const nodes = higher(side);
    const first = nodes.find((item) => {
      const distanceRate = Math.abs(item.zone.price - (side === "LONG" ? range.upper : range.lower)) / midpoint;
      return distanceRate >= 0.0025 && distanceRate <= maxSegmentDistanceRate;
    });
    const confirmationScore = routeConfirmation(memory, side);
    const fakeoutRisk = clamp(absorption * 0.35 + (1 - confirmationScore) * 0.55
      + (memory.timeframeBias.h1 === (side === "LONG" ? "DOWN" : "UP") ? 0.18 : 0), 0, 1);
    if (first && parentActive) {
      const entryTrigger = side === "LONG" ? range.upper + buffer : range.lower - buffer;
      const structuralInvalidation = side === "LONG" ? range.upper - Math.max(buffer * 1.5, width * 0.24)
        : range.lower + Math.max(buffer * 1.5, width * 0.24);
      const minimumStopDistance = entryTrigger * minimumStopRate;
      const invalidation = side === "LONG" ? Math.min(structuralInvalidation, entryTrigger - minimumStopDistance)
        : Math.max(structuralInvalidation, entryTrigger + minimumStopDistance);
      const projectedDistance = midpoint * clamp(range.widthRate * 0.85, 0.0065, 0.009);
      const projectedTarget = side === "LONG" ? entryTrigger + projectedDistance : entryTrigger - projectedDistance;
      const nodeBeyondProjection = side === "LONG" ? first.zone.price > projectedTarget : first.zone.price < projectedTarget;
      const currentTarget = nodeBeyondProjection
        ? { price: projectedTarget, identity: `RANGE_PROJECTION:${side}:${stablePriceBin(projectedTarget)}`, timeframe: "15m" as const }
        : { price: first.zone.price, identity: first.zone.identity ?? `HTF:${side}:${stablePriceBin(first.zone.price)}`, timeframe: first.timeframe };
      const next = nodeBeyondProjection ? first : nodes.find((item) => (side === "LONG" ? item.zone.price > first.zone.price * 1.0025 : item.zone.price < first.zone.price * 0.9975)
        && Math.abs(item.zone.price - first.zone.price) / first.zone.price <= maxSegmentDistanceRate);
      const score = range.quality * 0.38 + confirmationScore * 0.47 + first.zone.probabilityReach * 0.15;
      const preTriggerSide = side === "LONG" ? midpoint < entryTrigger : midpoint > entryTrigger;
      routes.push({ id: `${symbol}:LOCAL_BREAKOUT:${side}:${range.id ?? `${stablePriceBin(range.upper)}:${stablePriceBin(range.lower)}`}`,
        symbol, side, kind: "LOCAL_BREAKOUT", stage: "LOCAL_TO_NODE", entryTrigger, invalidation,
        target: currentTarget.price, targetIdentity: currentTarget.identity,
        targetTimeframe: currentTarget.timeframe, nextTarget: next?.zone.price ?? null, confirmationScore, fakeoutRisk,
        activationDistanceRate, score, executableNow: preTriggerSide && Math.abs(entryTrigger - midpoint) / midpoint <= activationDistanceRate
          && confirmationScore >= 0.52 && fakeoutRisk <= 0.62,
        structureId: range.id, structureRole: "PARENT",
        reason: ["15分钟父级复合区间边界", "计划只能在首次穿越前建立", "仅A级强势突破允许连续四次两秒盘口直入；普通突破等待回踩，失败突破准备反向",
          nodeBeyondProjection ? "先兑现15分钟局部量度空间" : `${first.timeframe}流动性作为本段终点`,
          "更远高周期节点留给下一段重判", "订单流、微价格与周期方向联合过滤假突破"] });
      pushRetestRoute({ band: range, role: "PARENT", side, boundary: side === "LONG" ? range.upper : range.lower,
        bandBuffer: buffer, target: currentTarget.price, targetIdentity: currentTarget.identity,
        targetTimeframe: currentTarget.timeframe, nextTarget: next?.zone.price ?? null,
        confirmationScore, fakeoutRisk, activationRate: activationDistanceRate, baseScore: score });
      if (next) {
        const nodeBuffer = Math.max(midpoint * 0.00035, Math.abs(next.zone.price - currentTarget.price) * 0.04);
        const nodeEntry = side === "LONG" ? currentTarget.price + nodeBuffer : currentTarget.price - nodeBuffer;
        const atNode = Math.abs(midpoint - currentTarget.price) / midpoint <= Math.max(0.0025, range.widthRate * 0.5);
        const continuationStopDistance = nodeEntry * minimumStopRate;
        const continuationInvalidation = side === "LONG" ? Math.min(currentTarget.price - nodeBuffer * 1.5, nodeEntry - continuationStopDistance)
          : Math.max(currentTarget.price + nodeBuffer * 1.5, nodeEntry + continuationStopDistance);
        routes.push({ id: `${symbol}:NODE_CONTINUATION:${side}:${stablePriceBin(currentTarget.price)}`, symbol, side,
          kind: "NODE_CONTINUATION", stage: atNode ? "AT_NODE" : "NODE_TO_NEXT", entryTrigger: nodeEntry,
          invalidation: continuationInvalidation,
          target: next.zone.price, targetIdentity: next.zone.identity ?? `HTF:${side}:${stablePriceBin(next.zone.price)}`,
          targetTimeframe: next.timeframe, nextTarget: null, confirmationScore, fakeoutRisk,
          activationDistanceRate, score: score * 0.92, executableNow: atNode && Math.abs(nodeEntry - midpoint) / midpoint <= activationDistanceRate
            && confirmationScore >= 0.62 && fakeoutRisk <= 0.48,
          structureId: range.id, structureRole: "PARENT",
          reason: ["到达上一段高周期流动性节点", "仅在节点被吸收且延续强度通过后启动", `${next.timeframe}下一流动性为新目标`] });
      }
    }
    if (parentActive) pushFailedBreakRoute(range, "PARENT", side,
      side === "LONG" ? range.upper : range.lower, buffer, activationDistanceRate);
    if (parentActive) pushEdgeReclaimRoute(range, "PARENT", side,
      side === "LONG" ? range.upper : range.lower, buffer, activationDistanceRate);
  }
  return routes.sort((a, b) => Number(b.executableNow) - Number(a.executableNow) || b.score - a.score).slice(0, 6);
}

export function selectRouteDecision(routes: LiquidityRoute[], observedAt: number): Decision | null {
  const selected = routes.filter((route) => route.executableNow).sort((a, b) => b.score - a.score)[0];
  if (!selected) return null;
  const oppositeScore = routes.filter((route) => route.side !== selected.side).sort((a, b) => b.score - a.score)[0]?.score ?? 0;
  return { symbol: selected.symbol, observedAt,
    marketState: selected.kind === "FAILED_BREAKOUT_REVERSAL" ? "REVERSAL"
      : selected.kind === "EDGE_REJECTION" ? "RANGE" : "BREAKOUT",
    side: selected.side, entryTrigger: selected.entryTrigger, invalidation: selected.invalidation,
    target: selected.target, targetIdentity: selected.targetIdentity, score: selected.score, oppositeScore,
    reason: selected.reason, routeId: selected.id, routeStage: selected.stage, routeKind: selected.kind,
    targetTimeframe: selected.targetTimeframe, nextTarget: selected.nextTarget,
    confirmationScore: selected.confirmationScore, fakeoutRisk: selected.fakeoutRisk,
    activationDistanceRate: selected.activationDistanceRate,
    structureId: selected.structureId, structureRole: selected.structureRole,
    rangeBoundary: selected.rangeBoundary, rangeBuffer: selected.rangeBuffer,
    sweepExtreme: selected.sweepExtreme, reclaimSource: selected.reclaimSource,
    reclaimStrength: selected.reclaimStrength };
}

export function arbitrateDecision(routes: LiquidityRoute[], observedAt: number, fallback: Decision | null) {
  // Once a valid 15m route map exists it is the only execution authority.
  // A legacy all-timeframe decision may still describe the market, but it may
  // not turn a distant higher-timeframe liquidity area into today's entry.
  // A generic balanced-liquidity label is not enough to place a passive range
  // catch. RANGE execution requires a frozen 15m edge plus observed reclaim.
  return routes.length > 0 ? selectRouteDecision(routes, observedAt)
    : fallback?.marketState === "RANGE" ? null : fallback;
}

export function deriveStructureZones(rows: Array<{ volume: number; close: number; high: number; low: number }>, timeframe: "1m" | "15m" | "1h" | "4h", midpoint: number) {
  if (rows.length < 20 || midpoint <= 0) return [] as LiquidityZone[];
  const weight = timeframe === "4h" ? 1.65 : timeframe === "1h" ? 1.35 : timeframe === "15m" ? 1.15 : 1;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = 2; index < rows.length - 2; index += 1) {
    const window = rows.slice(index - 2, index + 3);
    if (rows[index].high === Math.max(...window.map((row) => row.high))) highs.push(rows[index].high);
    if (rows[index].low === Math.min(...window.map((row) => row.low))) lows.push(rows[index].low);
  }
  const volumeRows = [...rows].sort((a, b) => b.volume - a.volume).slice(0, 8);
  const edges = volumeRows.flatMap((row) => [row.high, row.low]);
  const candidates = [
    ...highs.map((price) => ({ price, side: "LONG" as const, repeat: highs.filter((value) => Math.abs(value - price) / midpoint < 0.0015).length })),
    ...lows.map((price) => ({ price, side: "SHORT" as const, repeat: lows.filter((value) => Math.abs(value - price) / midpoint < 0.0015).length })),
    ...edges.map((price) => ({ price, side: price > midpoint ? "LONG" as const : "SHORT" as const, repeat: 2 })),
  ];
  const valid = candidates.filter((row) => row.repeat >= 2 && (row.side === "LONG" ? row.price > midpoint : row.price < midpoint));
  return (["LONG", "SHORT"] as const).flatMap((side) => valid.filter((row) => row.side === side)
    .sort((a, b) => b.repeat - a.repeat)
    .slice(0, 3))
    .map((row) => zoneUtility({
      identity: `STOP:${timeframe}:${row.side}:${stablePriceBin(row.price)}`, side: row.side, price: row.price, liquidity: row.repeat * weight, cascade: 0, pathCost: 1,
      distanceCost: Math.max(0.5, Math.abs(row.price - midpoint) / midpoint * 1_000), probabilityReach: 0.5,
      persistence: Math.min(0.92, 0.55 + row.repeat * 0.06), source: "STOP_POOL",
    }));
}

export function structureDirection(zones: LiquidityZone[]) {
  const up = zones.filter((zone) => zone.side === "LONG").sort((a, b) => b.score - a.score)[0];
  const down = zones.filter((zone) => zone.side === "SHORT").sort((a, b) => b.score - a.score)[0];
  if (!up || !down) return "UNKNOWN" as const;
  return up.score > down.score * 1.1 ? "UP" as const : down.score > up.score * 1.1 ? "DOWN" as const : "NEUTRAL" as const;
}

export function reconcilePaper(input: {
  now: number;
  midpoint: number;
  fresh: boolean;
  sequenceFault: boolean;
  decision: Decision | null;
  plan: PaperPlan | null;
  position: PaperPosition | null;
  zones: LiquidityZone[];
  absorption: number;
  confirmationMinute?: number;
  confirmationPrice?: number;
  confirmationCandle?: CompletedMinuteCandle | null;
  equity: number;
  openRisk: number;
  sameDirectionRisk?: number;
  allowOpen?: boolean;
  protectOnly?: boolean;
  activeRoutes?: LiquidityRoute[];
  breakoutConfirmation?: number;
  maintenanceRate?: number;
  leverageMax?: number;
}) {
  let plan = input.plan;
  let position = input.position;
  const events: string[] = [];
  let expiredThisCycle = false;
  let cancelledThisCycle = false;
  const continuousTarget = (side: "LONG" | "SHORT", identity: string | undefined, price: number) => {
    const zone = input.zones.filter((item) => item.side === side && (item.identity === identity
      || Math.abs(item.price - price) / Math.max(price, 1e-9) <= 0.0015)).sort((a, b) => b.score - a.score)[0];
    if (zone) return zone;
    const route = input.activeRoutes?.filter((item) => item.side === side && (item.targetIdentity === identity
      || Math.abs(item.target - price) / Math.max(price, 1e-9) <= 0.0015)).sort((a, b) => b.score - a.score)[0];
    return route ? zoneUtility({ identity: route.targetIdentity, side, price: route.target, liquidity: route.score,
      cascade: 0, pathCost: 1, distanceCost: 1, probabilityReach: route.confirmationScore,
      persistence: 1, source: "STOP_POOL" }) : null;
  };
  const planRouteId = plan?.routeId;
  const activePlanRoute = !planRouteId ? null : input.activeRoutes?.find((route) => route.id === planRouteId) ?? null;
  const structureRoutes = plan?.structureId == null ? [] : input.activeRoutes?.filter((route) => route.structureRole === plan!.structureRole) ?? [];
  const structureStillMapped = plan?.structureId != null && structureRoutes.some((route) => route.structureId === plan!.structureId);
  const structureReplaced = plan?.state === "PREPARED" && plan.structureId != null && !structureStillMapped
    && structureRoutes.some((route) => route.structureId != null && route.structureId !== plan!.structureId);
  const routePresent = !planRouteId || activePlanRoute != null;
  const routeWeak = activePlanRoute != null && (activePlanRoute.confirmationScore < (plan?.routeKind === "NODE_CONTINUATION" ? 0.5 : 0.42)
    || activePlanRoute.fakeoutRisk > (plan?.routeKind === "NODE_CONTINUATION" ? 0.62 : 0.72));
  const frozenAuctionRoute = plan?.routeKind === "BREAKOUT_RETEST" || plan?.routeKind === "FAILED_BREAKOUT_REVERSAL"
    || plan?.routeKind === "EDGE_REJECTION";
  const targetPresent = !plan || plan.state !== "PREPARED" || (planRouteId
    ? routePresent || (frozenAuctionRoute && structureStillMapped)
    : continuousTarget(plan.side, plan.targetIdentity, plan.target) != null);
  const triggered = plan?.state === "PREPARED" && planTriggered(plan, input.midpoint);
  const movedAway = plan?.state === "PREPARED" && !triggered && plan.activationDistanceRate != null
    && Math.abs(plan.entryTrigger - input.midpoint) / Math.max(input.midpoint, 1e-9) > plan.activationDistanceRate * 1.6;
  const invalidationCrossed = plan?.state === "PREPARED"
    && (plan.side === "LONG" ? input.midpoint <= plan.invalidation : input.midpoint >= plan.invalidation);
  const targetPassed = plan?.state === "PREPARED" && triggered
    && (plan.side === "LONG" ? input.midpoint >= plan.target : input.midpoint <= plan.target);
  const invalidLegacyFallback = plan?.state === "PREPARED" && !plan.routeId
    && (plan.marketState === "RANGE" || (input.activeRoutes?.length ?? 0) > 0
      || (!triggered && plan.activationDistanceRate != null
        && Math.abs(plan.entryTrigger - input.midpoint) / Math.max(input.midpoint, 1e-9) > MAX_GENERIC_PLAN_DISTANCE_RATE));
  // Freeze a prepared thesis instead of chasing every two-second recalculation.
  // Stale data and a crossed structural invalidation are hard faults. Route
  // disappearance and activation drift need two completed 1m confirmations so
  // a transient two-second recomputation cannot cancel an otherwise valid plan.
  if ((!input.fresh || input.sequenceFault || invalidationCrossed || targetPassed || invalidLegacyFallback || structureReplaced) && plan?.state === "PREPARED") {
    plan = { ...plan, state: "CANCELLED" };
    cancelledThisCycle = true;
    events.push(!input.fresh ? "STALE_CANCEL" : input.sequenceFault ? "SEQUENCE_REBUILD_CANCEL"
      : invalidationCrossed ? "PRE_ENTRY_INVALIDATION_CANCEL" : targetPassed ? "GAP_ECONOMICS_CANCEL"
        : structureReplaced ? "STRUCTURE_REPLACED_CANCEL" : "NONLOCAL_FALLBACK_CANCEL");
  } else if (plan?.state === "PREPARED") {
    const softReason = !targetPresent ? "TARGET_GONE_CANCEL" as const : routeWeak ? "ROUTE_WEAK_CANCEL" as const
      : movedAway ? "ACTIVATION_LOST_CANCEL" as const : null;
    let invalidationSignalMinute = plan.invalidationSignalMinute;
    let invalidationSignalCount = plan.invalidationSignalCount ?? 0;
    let invalidationSignalReason = plan.invalidationSignalReason;
    if (!softReason) {
      invalidationSignalMinute = undefined;
      invalidationSignalCount = 0;
      invalidationSignalReason = undefined;
    } else if (input.confirmationMinute && input.confirmationMinute > plan.createdAt
      && input.confirmationMinute !== invalidationSignalMinute) {
      invalidationSignalCount = invalidationSignalReason === softReason ? invalidationSignalCount + 1 : 1;
      invalidationSignalMinute = input.confirmationMinute;
      invalidationSignalReason = softReason;
    }
    plan = { ...plan, invalidationSignalMinute, invalidationSignalCount, invalidationSignalReason };
    if (softReason && invalidationSignalCount >= PLAN_SOFT_INVALIDATION_CONFIRMATIONS) {
      plan = { ...plan, state: "CANCELLED" };
      cancelledThisCycle = true;
      events.push(softReason);
    }
  }
  if (plan?.state === "PREPARED" && input.fresh && !input.sequenceFault && (input.allowOpen ?? true) === false) {
    plan = observeFastBreakout(plan, { now: input.now, price: input.midpoint,
      confirmation: input.breakoutConfirmation ?? 0,
      fakeoutRisk: activePlanRoute?.fakeoutRisk ?? plan.fakeoutRisk ?? 1 });
    if (plan.breakoutFailedAt != null || plan.breakoutMissedAt != null) {
      const missed = plan.breakoutMissedAt != null;
      plan = { ...plan, state: "CANCELLED" };
      cancelledThisCycle = true;
      events.push(missed ? "BREAKOUT_MISSED_CANCEL" : "BREAKOUT_FIRST_CROSS_FAILED_CANCEL");
    } else if (plan.marketState === "BREAKOUT" && plan.routeKind !== "BREAKOUT_RETEST"
      && breakoutMinuteAccepted(plan, input.confirmationMinute, input.confirmationCandle)
      && !breakoutEntryConfirmed(plan, input.confirmationMinute, input.confirmationCandle)) {
      plan = { ...plan, state: "CANCELLED" };
      cancelledThisCycle = true;
      events.push("BREAKOUT_ACCEPTED_WAIT_RETEST");
    }
  }
  if (position?.status === "OPEN" && input.fresh && !input.sequenceFault) {
    const own = input.protectOnly ? zoneUtility({ side: position.side, price: position.currentTarget, liquidity: 1, cascade: 0, pathCost: 1,
      distanceCost: 1, probabilityReach: 1, persistence: 1, source: "BOOK" })
      : continuousTarget(position.side, position.targetIdentity, position.currentTarget);
    const opposite = input.zones.filter((zone) => zone.side !== position!.side).sort((a, b) => b.score - a.score)[0] ?? null;
    const continuationRoute = input.activeRoutes?.filter((route) => route.kind === "NODE_CONTINUATION" && route.side === position!.side
      && Math.abs(route.entryTrigger - position!.currentTarget) / Math.max(position!.currentTarget, 1e-9) <= route.activationDistanceRate)
      .sort((a, b) => b.score - a.score)[0] ?? null;
    position = updatePosition(position, { now: input.now, price: input.midpoint, bestTarget: own, oppositeTarget: input.protectOnly ? null : opposite,
      absorption: input.protectOnly ? 0 : input.absorption, confirmationMinute: input.confirmationMinute,
      confirmationPrice: input.confirmationPrice,
      confirmationCandle: input.confirmationCandle,
      continuationRoute: input.protectOnly ? null : continuationRoute });
    if (position.status === "CLOSED") {
      events.push(position.exitReason ?? "CLOSED");
      return { plan, position, events };
    }
  }
  if (plan?.state === "PREPARED" && input.now > plan.expiresAt) {
    plan = { ...plan, state: "CANCELLED" };
    expiredThisCycle = true;
    events.push("PLAN_EXPIRED");
  }
  if (input.fresh && !input.sequenceFault && input.decision && !cancelledThisCycle && !expiredThisCycle && position?.status !== "OPEN") {
    const sameClosedThesis = position?.status === "CLOSED" && position.exitReason === "STRUCTURAL_STOP"
      && position.side === input.decision.side && position.scenario === input.decision.marketState
      && (position.routeId && input.decision.routeId ? position.routeId === input.decision.routeId : true);
    const rebuildMinute = position?.exitAt ? Math.floor(position.exitAt / 60_000) * 60_000 + 120_000 : Infinity;
    const reclaimed = input.confirmationPrice != null && (input.decision.side === "LONG"
      ? input.confirmationPrice > input.decision.entryTrigger : input.confirmationPrice < input.decision.entryTrigger);
    if (sameClosedThesis && (!(input.confirmationMinute && input.confirmationMinute >= rebuildMinute) || !reclaimed)) {
      return { plan, position, events: [...events, "WAIT_STRUCTURE_REBUILD"] };
    }
    // PREPARED is a direction-locked lifecycle. Recalculation can describe a
    // different market, but cannot mutate or replace the executable plan.
    const materiallyDifferent = !plan || plan.state !== "PREPARED";
    const withinActivation = input.decision.activationDistanceRate == null
      || Math.abs(input.decision.entryTrigger - input.midpoint) / Math.max(input.midpoint, 1e-9) <= input.decision.activationDistanceRate;
    const breakoutStillAhead = input.decision.marketState !== "BREAKOUT"
      || (input.decision.side === "LONG" ? input.midpoint < input.decision.entryTrigger : input.midpoint > input.decision.entryTrigger);
    if (materiallyDifferent && withinActivation && breakoutStillAhead) {
      const sized = sizePaperPosition({ equity: input.equity, entry: input.decision.entryTrigger, invalidation: input.decision.invalidation,
        feeBps: 10, stressSlippageBps: 8,
        confidence: clamp(input.decision.score / Math.max(input.decision.score + input.decision.oppositeScore, Number.EPSILON), 0, 1),
        openRisk: input.openRisk, sameDirectionRisk: input.sameDirectionRisk });
      const confidence = clamp(input.decision.score / Math.max(input.decision.score + input.decision.oppositeScore, Number.EPSILON), 0, 1);
      const economicTarget = stagedEconomicTarget(input.decision);
      const economics = tradeEconomics({ entry: input.decision.entryTrigger, target: economicTarget, lossRate: sized.lossRate, confidence,
        notional: sized.notional, equity: input.equity });
      if (sized.allowedLoss > 0 && sized.portfolioRiskAfter <= input.equity * PORTFOLIO_RISK_CAP + 1e-9 && economics.executable) {
        const leverage = selectSafeLeverage({ notional: sized.notional, equity: input.equity, entry: input.decision.entryTrigger,
          invalidation: input.decision.invalidation, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
        plan = { ...input.decision, id: `${input.decision.symbol}:${input.now}`, state: "PREPARED", createdAt: input.now,
          expiresAt: input.now + PLAN_TTL_MS, plannedRisk: sized.allowedLoss, notional: sized.notional,
          leverage: leverage.leverage, margin: leverage.margin, economicTarget };
        events.push("PLAN_PREPARED");
      } else if (sized.allowedLoss > 0) {
        events.push("PLAN_REJECTED_ECONOMICS");
      }
    } else if (materiallyDifferent && withinActivation && !breakoutStillAhead) {
      events.push("BREAKOUT_ALREADY_CROSSED_SKIP");
    }
  }
  if ((input.allowOpen ?? true) && plan?.state === "PREPARED" && position?.status !== "OPEN"
    && planTriggered(plan, input.midpoint)
    && breakoutEntryConfirmed(plan, input.confirmationMinute, input.confirmationCandle)
    && breakoutEntryPriceAcceptable(plan, input.midpoint)) {
    const confidence = clamp(plan.score / Math.max(plan.score + plan.oppositeScore, Number.EPSILON), 0, 1);
    const resized = sizePaperPosition({ equity: input.equity, entry: input.midpoint, invalidation: plan.invalidation, feeBps: 10,
      stressSlippageBps: 8, confidence, openRisk: input.openRisk, sameDirectionRisk: input.sameDirectionRisk });
    const invalidFill = plan.side === "LONG" ? input.midpoint <= plan.invalidation : input.midpoint >= plan.invalidation;
    const passedTarget = plan.side === "LONG" ? input.midpoint >= plan.target : input.midpoint <= plan.target;
    const economics = tradeEconomics({ entry: input.midpoint, target: stagedEconomicTarget(plan), lossRate: resized.lossRate, confidence,
      notional: resized.notional, equity: input.equity });
    if (invalidFill || resized.allowedLoss <= 0 || resized.portfolioRiskAfter > input.equity * PORTFOLIO_RISK_CAP + 1e-9 || passedTarget || !economics.executable) {
      plan = { ...plan, state: "CANCELLED" };
      events.push(invalidFill || resized.portfolioRiskAfter > input.equity * PORTFOLIO_RISK_CAP + 1e-9 ? "GAP_RISK_CANCEL" : "GAP_ECONOMICS_CANCEL");
      return { plan, position, events };
    }
    plan = { ...plan, state: "TRIGGERED" };
    position = {
      id: plan.id,
      symbol: plan.symbol,
      side: plan.side,
      scenario: plan.marketState,
      entryAt: input.now,
      entryPrice: input.midpoint,
      initialStop: plan.invalidation,
      currentStop: plan.invalidation,
      currentTarget: plan.target,
      plannedRisk: resized.allowedLoss,
      notional: resized.notional,
      targetScore: plan.score,
      targetIdentity: plan.targetIdentity,
      routeId: plan.routeId,
      routeKind: plan.routeKind,
      targetTimeframe: plan.targetTimeframe,
      status: "OPEN",
      maxFavorablePrice: input.midpoint,
      maxAdversePrice: input.midpoint,
      rangeBoundary: plan.rangeBoundary,
      rangeBuffer: plan.rangeBuffer,
      sweepExtreme: plan.sweepExtreme,
      reclaimSource: plan.reclaimSource,
      reclaimStrength: plan.reclaimStrength,
    };
    events.push("PAPER_OPEN");
  }
  return { plan, position, events };
}

export function usableSnapshot(snapshot: BookSnapshot, now: number, lastSequence: number, lastObservedAt = 0) {
  const sequenceReset = snapshot.sequence > 0 && lastSequence > 0 && snapshot.sequence < lastSequence && snapshot.observedAt > lastObservedAt;
  const unchanged = snapshot.sequence > 0 && snapshot.sequence === lastSequence && snapshot.observedAt === lastObservedAt;
  // Sequence is the ordering authority. Gate can publish more than one book
  // id within the same timestamp, so equal (but never older) update time is a
  // valid advance.
  const advanced = lastSequence === 0 || (snapshot.sequence > lastSequence && snapshot.observedAt >= lastObservedAt);
  const sequenceFault = snapshot.sequence > 0 && lastSequence > 0 && !sequenceReset && !unchanged && !advanced;
  return { fresh: dataIsFresh(snapshot.observedAt, now), sequenceFault, sequenceReset, unchanged, advanced };
}

export function ancillarySchedule(cursor: number, symbols: string[], priorityMinuteSymbols: string[] = []) {
  if (!symbols.length) return null;
  const eligiblePriority = priorityMinuteSymbols.filter((symbol) => symbols.includes(symbol));
  const prioritySymbol = eligiblePriority.length ? eligiblePriority[Math.abs(cursor) % eligiblePriority.length] : null;
  if (prioritySymbol) return { symbol: prioritySymbol, feature: "1m" as const };
  const feature = (["trades", "liquidations", "1m", "15m", "1h"] as const)[Math.floor(cursor / symbols.length) % 5];
  return { symbol: symbols[cursor % symbols.length], feature };
}

export function ancillaryIsFresh(memory: SymbolMemory, now: number) {
  return now - memory.timeframeUpdatedAt.m1 <= 3 * 60_000
    && now - memory.timeframeUpdatedAt.m15 <= 45 * 60_000
    && now - memory.timeframeUpdatedAt.h1 <= 3 * 60 * 60_000
    && now - memory.timeframeUpdatedAt.h4 <= 12 * 60 * 60_000;
}

export function optionalEvidenceIsFresh(memory: SymbolMemory, now: number) {
  return now - memory.oiUpdatedAt <= 6 * 60_000
    && now - memory.tradesUpdatedAt <= 120_000
    && now - memory.liquidationsUpdatedAt <= 120_000;
}
