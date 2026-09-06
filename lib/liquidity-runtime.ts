import {
  aggregateBook,
  breakoutEntryConfirmed,
  cascadeRatio,
  dataIsFresh,
  decideThreeState,
  flowPressure,
  MAX_GENERIC_PLAN_DISTANCE_RATE,
  MIN_NET_REWARD_RISK,
  MIN_STRUCTURAL_STOP_RATE,
  PLAN_SOFT_INVALIDATION_CONFIRMATIONS,
  planTriggered,
  ROUND_TRIP_FRICTION_RATE,
  selectSafeLeverage,
  sizePaperPosition,
  stablePriceBin,
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
  type RangeStructure,
  type Side,
  type TimeframeState,
  type WallEvidence,
  WALL_WINDOW,
} from "./liquidity-core.ts";

export const PLAN_TTL_MS = 15 * 60_000;

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

export function deriveRangeStructure(rows: StructureCandle[]): RangeStructure | null {
  const window = rows.slice(-12);
  if (window.length < 10) return null;
  const quantile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
  };
  // Repeated upper/lower quartiles ignore a single sweep wick while retaining
  // the boundary that price actually tests on the 15-minute chart.
  const upper = quantile(window.map((row) => row.high), 0.75);
  const lower = quantile(window.map((row) => row.low), 0.25);
  const midpoint = (upper + lower) / 2;
  const width = upper - lower;
  const widthRate = width / Math.max(midpoint, 1e-9);
  if (!(lower > 0 && widthRate >= 0.0012 && widthRate <= 0.025)) return null;
  const edge = width * 0.16;
  const touchesUpper = window.filter((row) => row.high >= upper - edge).length;
  const touchesLower = window.filter((row) => row.low <= lower + edge).length;
  const contained = window.filter((row) => row.close <= upper + edge * 0.4 && row.close >= lower - edge * 0.4).length / window.length;
  const drift = Math.abs(window.at(-1)!.close - window[0].open) / width;
  const quality = clamp(contained * 0.45 + Math.min(1, touchesUpper / 3) * 0.2
    + Math.min(1, touchesLower / 3) * 0.2 + Math.max(0, 1 - drift) * 0.15, 0, 1);
  if (touchesUpper < 2 || touchesLower < 2 || quality < 0.58) return null;
  return { lower, upper, midpoint, widthRate, touchesLower, touchesUpper, quality,
    observedAt: (window.at(-1)!.time + 900) * 1_000 };
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
  for (const side of ["LONG", "SHORT"] as const) {
    const nodes = higher(side);
    const first = nodes.find((item) => {
      const distanceRate = Math.abs(item.zone.price - (side === "LONG" ? range.upper : range.lower)) / midpoint;
      return distanceRate >= 0.0025 && distanceRate <= maxSegmentDistanceRate;
    });
    const confirmationScore = routeConfirmation(memory, side);
    const fakeoutRisk = clamp(absorption * 0.35 + (1 - confirmationScore) * 0.55
      + (memory.timeframeBias.h1 === (side === "LONG" ? "DOWN" : "UP") ? 0.18 : 0), 0, 1);
    if (first) {
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
      routes.push({ id: `${symbol}:LOCAL_BREAKOUT:${side}:${stablePriceBin(range.upper)}:${stablePriceBin(range.lower)}`,
        symbol, side, kind: "LOCAL_BREAKOUT", stage: "LOCAL_TO_NODE", entryTrigger, invalidation,
        target: currentTarget.price, targetIdentity: currentTarget.identity,
        targetTimeframe: currentTarget.timeframe, nextTarget: next?.zone.price ?? null, confirmationScore, fakeoutRisk,
        activationDistanceRate, score, executableNow: Math.abs(entryTrigger - midpoint) / midpoint <= activationDistanceRate
          && confirmationScore >= 0.52 && fakeoutRisk <= 0.62,
        reason: ["15分钟重复边界", "完整1分钟收在突破位外才允许成交",
          nodeBeyondProjection ? "先兑现15分钟局部量度空间" : `${first.timeframe}流动性作为本段终点`,
          "更远高周期节点留给下一段重判", "订单流、微价格与周期方向联合过滤假突破"] });
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
          reason: ["到达上一段高周期流动性节点", "仅在节点被吸收且延续强度通过后启动", `${next.timeframe}下一流动性为新目标`] });
      }
    }
    const rejectionSide: Side = side === "LONG" ? "SHORT" : "LONG";
    const edgePrice = side === "LONG" ? range.upper : range.lower;
    const rejectionConfirmation = routeConfirmation(memory, rejectionSide);
    const rejectionEntry = side === "LONG" ? edgePrice - buffer * 0.25 : edgePrice + buffer * 0.25;
    const structuralInvalidation = side === "LONG" ? range.upper + buffer * 1.5 : range.lower - buffer * 1.5;
    const rejectionStopDistance = rejectionEntry * minimumStopRate;
    const rejectionInvalidation = rejectionSide === "LONG" ? Math.min(structuralInvalidation, rejectionEntry - rejectionStopDistance)
      : Math.max(structuralInvalidation, rejectionEntry + rejectionStopDistance);
    const actualStopDistance = Math.abs(rejectionEntry - rejectionInvalidation);
    const frictionDistance = rejectionEntry * ROUND_TRIP_FRICTION_RATE;
    const minimumEconomicDistance = frictionDistance + MIN_NET_REWARD_RISK * (actualStopDistance + frictionDistance);
    const midpointDistance = Math.abs(rejectionEntry - range.midpoint);
    const rejectionDistance = Math.min(width * 0.7, Math.max(midpointDistance, minimumEconomicDistance));
    const rejectionTarget = rejectionSide === "LONG" ? rejectionEntry + rejectionDistance : rejectionEntry - rejectionDistance;
    const minute = memory.lastCompletedMinuteCandle;
    const rejectionConfirmed = minute != null && (side === "LONG"
      ? minute.high >= edgePrice - buffer * 0.25 && minute.close <= rejectionEntry && minute.close < minute.open
      : minute.low <= edgePrice + buffer * 0.25 && minute.close >= rejectionEntry && minute.close > minute.open);
    const rejectionScore = range.quality * 0.48 + rejectionConfirmation * 0.27 + absorption * 0.25;
    routes.push({ id: `${symbol}:EDGE_REJECTION:${side}:${stablePriceBin(edgePrice)}`, symbol, side: rejectionSide,
      kind: "EDGE_REJECTION", stage: "LOCAL_TO_NODE", entryTrigger: rejectionEntry,
      invalidation: rejectionInvalidation,
      target: rejectionTarget, targetIdentity: `RANGE_SEGMENT:${rejectionSide}:${stablePriceBin(rejectionTarget)}`,
      targetTimeframe: "15m", nextTarget: null, confirmationScore: rejectionConfirmation,
      fakeoutRisk: clamp(1 - absorption * 0.55 - rejectionConfirmation * 0.3, 0, 1), activationDistanceRate,
      score: rejectionScore, executableNow: Math.abs(rejectionEntry - midpoint) / midpoint <= activationDistanceRate
        && absorption >= 0.55 && rejectionConfirmation >= 0.48 && rejectionConfirmed,
      reason: ["15分钟区间边界出现吸收", "完整1分钟K线完成扫边并收回", "优先兑现区间中轴，扣成本不足时最多延伸到70%", "失效后等待突破路线重新评估"] });
  }
  return routes.sort((a, b) => Number(b.executableNow) - Number(a.executableNow) || b.score - a.score).slice(0, 6);
}

export function selectRouteDecision(routes: LiquidityRoute[], observedAt: number): Decision | null {
  const selected = routes.filter((route) => route.executableNow).sort((a, b) => b.score - a.score)[0];
  if (!selected) return null;
  const oppositeScore = routes.filter((route) => route.side !== selected.side).sort((a, b) => b.score - a.score)[0]?.score ?? 0;
  return { symbol: selected.symbol, observedAt, marketState: selected.kind === "EDGE_REJECTION" ? "RANGE" : "BREAKOUT",
    side: selected.side, entryTrigger: selected.entryTrigger, invalidation: selected.invalidation,
    target: selected.target, targetIdentity: selected.targetIdentity, score: selected.score, oppositeScore,
    reason: selected.reason, routeId: selected.id, routeStage: selected.stage, routeKind: selected.kind,
    targetTimeframe: selected.targetTimeframe, nextTarget: selected.nextTarget,
    confirmationScore: selected.confirmationScore, fakeoutRisk: selected.fakeoutRisk,
    activationDistanceRate: selected.activationDistanceRate };
}

export function arbitrateDecision(routes: LiquidityRoute[], observedAt: number, fallback: Decision | null) {
  // Once a valid 15m route map exists it is the only execution authority.
  // A legacy all-timeframe decision may still describe the market, but it may
  // not turn a distant higher-timeframe liquidity area into today's entry.
  return routes.length > 0 ? selectRouteDecision(routes, observedAt) : fallback;
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
  const activePlanRoute = !planRouteId ? null : input.activeRoutes?.filter((route) => route.id === planRouteId || (route.side === plan?.side
    && route.kind === plan.routeKind
    && Math.abs(route.target - plan.target) / Math.max(plan.target, 1e-9) <= 0.0015
    && Math.abs(route.entryTrigger - plan.entryTrigger) / Math.max(plan.entryTrigger, 1e-9) <= 0.0015))
    .sort((a, b) => Number(b.id === planRouteId) - Number(a.id === planRouteId))[0] ?? null;
  const routePresent = !planRouteId || activePlanRoute != null;
  const routeWeak = activePlanRoute != null && (activePlanRoute.confirmationScore < (plan?.routeKind === "NODE_CONTINUATION" ? 0.5 : 0.42)
    || activePlanRoute.fakeoutRisk > (plan?.routeKind === "NODE_CONTINUATION" ? 0.62 : 0.72));
  const targetPresent = !plan || plan.state !== "PREPARED" || (planRouteId
    ? routePresent
    : continuousTarget(plan.side, plan.targetIdentity, plan.target) != null);
  const triggered = plan?.state === "PREPARED" && planTriggered(plan, input.midpoint);
  const movedAway = plan?.state === "PREPARED" && !triggered && plan.activationDistanceRate != null
    && Math.abs(plan.entryTrigger - input.midpoint) / Math.max(input.midpoint, 1e-9) > plan.activationDistanceRate * 1.6;
  const invalidationCrossed = plan?.state === "PREPARED"
    && (plan.side === "LONG" ? input.midpoint <= plan.invalidation : input.midpoint >= plan.invalidation);
  const invalidLegacyFallback = plan?.state === "PREPARED" && !plan.routeId
    && ((input.activeRoutes?.length ?? 0) > 0
      || (!triggered && plan.activationDistanceRate != null
        && Math.abs(plan.entryTrigger - input.midpoint) / Math.max(input.midpoint, 1e-9) > MAX_GENERIC_PLAN_DISTANCE_RATE));
  // Freeze a prepared thesis instead of chasing every two-second recalculation.
  // Stale data and a crossed structural invalidation are hard faults. Route
  // disappearance and activation drift need two completed 1m confirmations so
  // a transient two-second recomputation cannot cancel an otherwise valid plan.
  if ((!input.fresh || input.sequenceFault || invalidationCrossed || invalidLegacyFallback) && plan?.state === "PREPARED") {
    plan = { ...plan, state: "CANCELLED" };
    cancelledThisCycle = true;
    events.push(!input.fresh ? "STALE_CANCEL" : input.sequenceFault ? "SEQUENCE_REBUILD_CANCEL"
      : invalidationCrossed ? "PRE_ENTRY_INVALIDATION_CANCEL" : "NONLOCAL_FALLBACK_CANCEL");
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
    if (materiallyDifferent && withinActivation) {
      const sized = sizePaperPosition({ equity: input.equity, entry: input.decision.entryTrigger, invalidation: input.decision.invalidation, feeBps: 10, stressSlippageBps: 8, confidence: clamp(input.decision.score / Math.max(input.decision.score + input.decision.oppositeScore, Number.EPSILON), 0, 1), openRisk: input.openRisk });
      const confidence = clamp(input.decision.score / Math.max(input.decision.score + input.decision.oppositeScore, Number.EPSILON), 0, 1);
      const economics = tradeEconomics({ entry: input.decision.entryTrigger, target: input.decision.target, lossRate: sized.lossRate, confidence,
        notional: sized.notional, equity: input.equity });
      if (sized.allowedLoss > 0 && sized.portfolioRiskAfter <= input.equity * 0.05 + 1e-9 && economics.executable) {
        const leverage = selectSafeLeverage({ notional: sized.notional, equity: input.equity, entry: input.decision.entryTrigger,
          invalidation: input.decision.invalidation, maintenanceRate: input.maintenanceRate, leverageMax: input.leverageMax });
        plan = { ...input.decision, id: `${input.decision.symbol}:${input.now}`, state: "PREPARED", createdAt: input.now,
          expiresAt: input.now + PLAN_TTL_MS, plannedRisk: sized.allowedLoss, notional: sized.notional,
          leverage: leverage.leverage, margin: leverage.margin };
        events.push("PLAN_PREPARED");
      } else if (sized.allowedLoss > 0) {
        events.push("PLAN_REJECTED_ECONOMICS");
      }
    }
  }
  if ((input.allowOpen ?? true) && plan?.state === "PREPARED" && position?.status !== "OPEN"
    && planTriggered(plan, input.midpoint)
    && breakoutEntryConfirmed(plan, input.confirmationMinute, input.confirmationCandle)) {
    const confidence = clamp(plan.score / Math.max(plan.score + plan.oppositeScore, Number.EPSILON), 0, 1);
    const resized = sizePaperPosition({ equity: input.equity, entry: input.midpoint, invalidation: plan.invalidation, feeBps: 10,
      stressSlippageBps: 8, confidence, openRisk: input.openRisk });
    const invalidFill = plan.side === "LONG" ? input.midpoint <= plan.invalidation : input.midpoint >= plan.invalidation;
    const passedTarget = plan.side === "LONG" ? input.midpoint >= plan.target : input.midpoint <= plan.target;
    const economics = tradeEconomics({ entry: input.midpoint, target: plan.target, lossRate: resized.lossRate, confidence,
      notional: resized.notional, equity: input.equity });
    if (invalidFill || resized.allowedLoss <= 0 || resized.portfolioRiskAfter > input.equity * 0.05 + 1e-9 || passedTarget || !economics.executable) {
      plan = { ...plan, state: "CANCELLED" };
      events.push(invalidFill || resized.portfolioRiskAfter > input.equity * 0.05 + 1e-9 ? "GAP_RISK_CANCEL" : "GAP_ECONOMICS_CANCEL");
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

export function ancillarySchedule(cursor: number, symbols: string[]) {
  if (!symbols.length) return null;
  const feature = (["trades", "liquidations", "1m", "15m", "1h"] as const)[Math.floor(cursor / symbols.length) % 5];
  return { symbol: symbols[cursor % symbols.length], feature };
}

export function ancillaryIsFresh(memory: SymbolMemory, now: number) {
  return now - memory.oiUpdatedAt <= 6 * 60_000
    && now - memory.tradesUpdatedAt <= 120_000
    && now - memory.liquidationsUpdatedAt <= 120_000
    && now - memory.timeframeUpdatedAt.m1 <= 3 * 60_000
    && now - memory.timeframeUpdatedAt.m15 <= 45 * 60_000
    && now - memory.timeframeUpdatedAt.h1 <= 3 * 60 * 60_000
    && now - memory.timeframeUpdatedAt.h4 <= 12 * 60 * 60_000;
}
