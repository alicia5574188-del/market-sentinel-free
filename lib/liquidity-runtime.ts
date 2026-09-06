import {
  aggregateBook,
  cascadeRatio,
  dataIsFresh,
  decideThreeState,
  planTriggered,
  ROUND_TRIP_FRICTION_RATE,
  sizePaperPosition,
  stablePriceBin,
  updatePosition,
  zoneUtility,
  type BookSnapshot,
  type Decision,
  type FlowEvidence,
  type LiquidationBand,
  type LiquidityZone,
  type PaperPlan,
  type PaperPosition,
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
  structureByTimeframe: { m1: LiquidityZone[]; m15: LiquidityZone[]; h1: LiquidityZone[] };
  oiCohorts: Array<{ entryPrice: number; longNotional: number; shortNotional: number }>;
  timeframeBias: { m1: TimeframeState; m15: TimeframeState; h1: TimeframeState };
  timeframeUpdatedAt: { m1: number; m15: number; h1: number };
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
    structureZones: [], structureByTimeframe: { m1: [], m15: [], h1: [] },
    oiCohorts: [],
    timeframeBias: { m1: "UNKNOWN", m15: "UNKNOWN", h1: "UNKNOWN" }, timeframeUpdatedAt: { m1: 0, m15: 0, h1: 0 },
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
  };
  const decision = decideThreeState({ symbol: snapshot.symbol, observedAt: snapshot.observedAt, mid: midpoint, zones, bands, flow: memory.flow, absorption, timeframeBias: freshBias });
  return { midpoint, zones, bands, absorption, decision };
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

export function deriveStructureZones(rows: Array<{ volume: number; close: number; high: number; low: number }>, timeframe: "1m" | "15m" | "1h", midpoint: number) {
  if (rows.length < 20 || midpoint <= 0) return [] as LiquidityZone[];
  const weight = timeframe === "1h" ? 1.35 : timeframe === "15m" ? 1.15 : 1;
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
  equity: number;
  openRisk: number;
  allowOpen?: boolean;
  protectOnly?: boolean;
}) {
  let plan = input.plan;
  let position = input.position;
  const events: string[] = [];
  let expiredThisCycle = false;
  let cancelledThisCycle = false;
  const targetPresent = plan?.state !== "PREPARED" || input.zones.some((zone) => zone.side === plan!.side && zone.identity === plan!.targetIdentity);
  // Freeze a prepared thesis instead of chasing every two-second recalculation.
  // Neutral ticks and same-direction level drift are not cancellation signals.
  const opposingThesis = plan?.state === "PREPARED" && input.decision != null
    && plan.side !== input.decision.side && input.decision.score >= plan.score * 1.25;
  if ((!input.fresh || input.sequenceFault || !targetPresent || opposingThesis) && plan?.state === "PREPARED") {
    plan = { ...plan, state: "CANCELLED" };
    cancelledThisCycle = true;
    events.push(!input.fresh ? "STALE_CANCEL" : input.sequenceFault ? "SEQUENCE_REBUILD_CANCEL" : !targetPresent ? "TARGET_GONE_CANCEL" : "OPPOSING_THESIS_CANCEL");
  }
  if (position?.status === "OPEN" && input.fresh && !input.sequenceFault) {
    const own = input.protectOnly ? zoneUtility({ side: position.side, price: position.currentTarget, liquidity: 1, cascade: 0, pathCost: 1,
      distanceCost: 1, probabilityReach: 1, persistence: 1, source: "BOOK" })
      : input.zones.filter((zone) => zone.side === position!.side && (!position!.targetIdentity
        || zone.identity === position!.targetIdentity)).sort((a, b) => b.score - a.score)[0] ?? null;
    const opposite = input.zones.filter((zone) => zone.side !== position!.side).sort((a, b) => b.score - a.score)[0] ?? null;
    position = updatePosition(position, { now: input.now, price: input.midpoint, bestTarget: own, oppositeTarget: input.protectOnly ? null : opposite, absorption: input.protectOnly ? 0 : input.absorption });
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
    const sameClosedThesis = position?.status === "CLOSED" && position.side === input.decision.side && position.scenario === input.decision.marketState;
    const triggerProbe: PaperPlan = { ...input.decision, id: "probe", state: "PREPARED", createdAt: input.now, expiresAt: input.now, plannedRisk: 0, notional: 0 };
    if (sameClosedThesis && planTriggered(triggerProbe, input.midpoint)) return { plan, position, events: [...events, "WAIT_REARM"] };
    const materiallyDifferent = !plan || plan.state !== "PREPARED"
      || plan.side !== input.decision.side
      || plan.marketState !== input.decision.marketState
      || (input.now - plan.createdAt > 30_000 && Math.abs(plan.target - input.decision.target) / input.midpoint > 0.002);
    if (materiallyDifferent) {
      const sized = sizePaperPosition({ equity: input.equity, entry: input.decision.entryTrigger, invalidation: input.decision.invalidation, feeBps: 10, stressSlippageBps: 8, confidence: clamp(input.decision.score / Math.max(input.decision.score + input.decision.oppositeScore, Number.EPSILON), 0, 1), openRisk: input.openRisk });
      const confidence = clamp(input.decision.score / Math.max(input.decision.score + input.decision.oppositeScore, Number.EPSILON), 0, 1);
      const rewardRate = Math.abs(input.decision.target - input.decision.entryTrigger) / Math.max(input.decision.entryTrigger, 1e-9);
      const positiveEv = confidence * rewardRate - (1 - confidence) * sized.lossRate - ROUND_TRIP_FRICTION_RATE > 0;
      if (sized.allowedLoss > 0 && sized.portfolioRiskAfter <= input.equity * 0.05 + 1e-9 && rewardRate > ROUND_TRIP_FRICTION_RATE && positiveEv) {
        plan = { ...input.decision, id: `${input.decision.symbol}:${input.now}`, state: "PREPARED", createdAt: input.now, expiresAt: input.now + PLAN_TTL_MS, plannedRisk: sized.allowedLoss, notional: sized.notional };
        events.push("PLAN_PREPARED");
      } else if (sized.allowedLoss > 0) {
        events.push("PLAN_REJECTED_ECONOMICS");
      }
    }
  }
  if ((input.allowOpen ?? true) && plan?.state === "PREPARED" && position?.status !== "OPEN" && planTriggered(plan, input.midpoint)) {
    const confidence = clamp(plan.score / Math.max(plan.score + plan.oppositeScore, Number.EPSILON), 0, 1);
    const resized = sizePaperPosition({ equity: input.equity, entry: input.midpoint, invalidation: plan.invalidation, feeBps: 10,
      stressSlippageBps: 8, confidence, openRisk: input.openRisk });
    const invalidFill = plan.side === "LONG" ? input.midpoint <= plan.invalidation : input.midpoint >= plan.invalidation;
    const passedTarget = plan.side === "LONG" ? input.midpoint >= plan.target : input.midpoint <= plan.target;
    const rewardRate = Math.abs(plan.target - input.midpoint) / Math.max(input.midpoint, 1e-9);
    const friction = ROUND_TRIP_FRICTION_RATE;
    const positiveEv = confidence * rewardRate - (1 - confidence) * resized.lossRate - friction > 0;
    if (invalidFill || resized.allowedLoss <= 0 || resized.portfolioRiskAfter > input.equity * 0.05 + 1e-9 || passedTarget || rewardRate <= friction || !positiveEv) {
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
      status: "OPEN",
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
    && now - memory.timeframeUpdatedAt.h1 <= 3 * 60 * 60_000;
}
