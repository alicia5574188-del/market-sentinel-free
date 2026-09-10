import test from "node:test";
import assert from "node:assert/strict";
import { advanceStrategyArena, applyStrategySleepStates, ARENA_FRICTION_RATE, initialStrategyArena,
  normalizeStrategyArena, observeStrategyArena, PROMOTION_WIN_STREAK, resetStrategyArenaAccount,
  STRATEGY_CATALOG, type ArenaObservation, type StrategyArenaState } from "../lib/strategy-arena.ts";

const strategyId = "anomaly_follow:confirm:fast";

function observation(event: number, now: number, symbol = "BTC_USDT", weakTarget = false): ArenaObservation {
  return {
    candidate: { id: `${symbol}:ANOMALY:${event}`, symbol, channel: "ANOMALY", regime: "EXPANSION", side: "LONG", score: 70,
      referencePrice: 100, moveRate: 0.01, trendRate: 0.005, trendEfficiency: 0.7, volatilityRatio: 2,
      rangePosition: 1, volume24hUsd: 1_000_000_000, fundingRate: 0.0001, openInterestChangeRate: 0,
      confirmations: 3, firstSeenAt: now - 20_000, observedAt: now, anomalyKind: "PRICE_SHOCK" },
    midpoint: 101, bestBid: 100.99, bestAsk: 101.01, alignedFlow: 0.4, minuteNoiseRate: 0.003,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.1 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 }, bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, dataFresh: true, contractReady: true,
    managementCapacity: true,
    routes: [{ id: `route:${event}`, symbol, side: "LONG", kind: "LOCAL_BREAKOUT", stage: "LOCAL_TO_NODE",
      entryTrigger: 100.82, invalidation: 100.65, target: weakTarget ? 101.45 : 103, targetIdentity: `target:${event}`,
      targetTimeframe: "15m", nextTarget: null, confirmationScore: 0.8, fakeoutRisk: 0.2,
      activationDistanceRate: 0.01, score: 80, executableNow: true, reason: ["test structure"] }], now,
  };
}

function openEvent(state: StrategyArenaState, event: number, now: number, symbol = "BTC_USDT", weakTarget = false) {
  return observeStrategyArena({ state, observation: observation(event, now, symbol, weakTarget) });
}

function settleEvent(state: StrategyArenaState, now: number, winner: boolean, symbol = "BTC_USDT") {
  const trades = [...Object.values(state.open), ...Object.values(state.portfolioOpen)].filter((trade) => trade.symbol === symbol);
  assert.ok(trades.length);
  const price = winner ? Math.max(...trades.map((trade) => trade.targetPrice)) + 0.01
    : Math.min(...trades.map((trade) => trade.stopPrice)) - 0.01;
  return advanceStrategyArena({ state, quotes: { [symbol]: { midpoint: price, bestBid: price, bestAsk: price + 0.01, fresh: true } }, now });
}

function openForStrategy(state: StrategyArenaState, wanted: string, eventStart: number, now: number, symbol = "BTC_USDT") {
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = openEvent(structuredClone(state), eventStart + offset, now + offset, symbol);
    if (Object.values(candidate.open).some((trade) => trade.strategyId === wanted))
      return { state: candidate, event: eventStart + offset, now: now + offset };
  }
  throw new Error(`no event selected ${wanted}`);
}

function openForStrategyAtLifecycle(state: StrategyArenaState, wanted: string, lifecycleAt: number,
  eventStart: number, now: number, symbol: string) {
  for (let offset = 0; offset < 100; offset += 1) {
    const input = observation(eventStart + offset, now + offset, symbol);
    input.candidate.id = `${symbol}:CANDLE5M:EXPANSION:LONG:${lifecycleAt}:${eventStart + offset}`;
    const candidate = observeStrategyArena({ state: structuredClone(state), observation: input });
    if (Object.values(candidate.open).some((trade) => trade.strategyId === wanted))
      return { state: candidate, now: now + offset };
  }
  throw new Error(`no lifecycle event selected ${wanted}`);
}

function qualify(state = initialStrategyArena(1), start = 10_000) {
  let eventStart = 1;
  for (let index = 0; index < PROMOTION_WIN_STREAK; index += 1) {
    const opened = openForStrategy(state, strategyId, eventStart, start + index * 20_000);
    state = settleEvent(opened.state, opened.now + 10_000, true);
    eventStart = opened.event + 1;
  }
  return state;
}

function sixEventState() {
  let state = initialStrategyArena(1);
  for (let event = 1; event <= 6; event += 1) {
    state = openEvent(state, 5_000 + event, 300_000 + event * 20_000);
    state = settleEvent(state, 310_000 + event * 20_000, true);
  }
  return state;
}

function rewriteVariantWindow(state: StrategyArenaState, netReturns: number[]) {
  const trades = state.recentShadow.filter((trade) => trade.strategyId === strategyId
    && (trade.orientation ?? "NORMAL") === "NORMAL").slice(-netReturns.length);
  assert.equal(trades.length, netReturns.length);
  for (const [index, trade] of trades.entries()) {
    const funding = trade.context.fundingCostRate ?? 0;
    trade.netReturnRate = netReturns[index];
    trade.grossReturnRate = netReturns[index] + trade.context.modeledCostRate + funding;
    trade.netPnl = trade.notional * netReturns[index];
    const result = state.strategies[strategyId].recentResults.find((row) => row.eventId === trade.eventId);
    assert.ok(result); result.netReturnRate = netReturns[index]; result.netPnl = trade.netPnl; result.won = netReturns[index] > 0;
    const reverseTrade = state.recentShadow.find((row) => row.strategyId === strategyId && row.eventId === trade.eventId
      && row.orientation === "REVERSE");
    const reverseResult = state.strategies[strategyId].reverseRecentResults.find((row) => row.eventId === trade.eventId);
    assert.ok(reverseTrade && reverseResult);
    reverseTrade.netReturnRate = -(trade.grossReturnRate ?? 0) - trade.context.modeledCostRate
      - (trade.context.fundingCostRate ?? 0) - trade.context.spreadRate * 2;
    reverseTrade.netPnl = reverseTrade.notional * reverseTrade.netReturnRate;
    reverseResult.netReturnRate = reverseTrade.netReturnRate; reverseResult.netPnl = reverseTrade.netPnl;
    reverseResult.won = reverseTrade.netReturnRate > 0;
  }
  return normalizeStrategyArena(state, trades.at(-1)!.closedAt ?? 1_000_000);
}

test("V4.4 keeps 12 playbooks and 48 genuinely distinct execution variants", () => {
  assert.equal(STRATEGY_CATALOG.length, 48);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => item.id.split(":")[0])).size, 12);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => `${item.id}:${item.entryStyle}:${item.exitProfile}`)).size, 48);
});

test("confirmation/retest and fast/structure variants freeze different locations or targets", () => {
  const byStrategy = new Map();
  for (let event = 1; event <= 40; event += 1) {
    const state = openEvent(initialStrategyArena(1), event, 10_000 + event);
    for (const trade of Object.values(state.open).filter((row) => row.strategyId.startsWith("anomaly_follow:")
      && (row.orientation ?? "NORMAL") === "NORMAL"))
      byStrategy.set(trade.strategyId, trade);
  }
  const variants = [...byStrategy.values()].filter((trade) => (trade.orientation ?? "NORMAL") === "NORMAL");
  assert.equal(variants.length, 4);
  assert.equal(new Set(variants.map((trade) => trade.context.entryTrigger)).size, 2);
  assert.equal(new Set(variants.map((trade) => trade.targetPrice)).size, 2);
});

test("one market event runs every genuinely different variant while exact geometry is counted once", () => {
  const first = openEvent(initialStrategyArena(1), 1, 10_000);
  const normal = Object.values(first.open).filter((trade) => (trade.orientation ?? "NORMAL") === "NORMAL"
    && trade.strategyId.startsWith("anomaly_follow:"));
  assert.equal(normal.length, 4, "all four distinct entry/exit variants learn from the event instead of one random variant");
  assert.equal(new Set(normal.map((trade) => trade.strategyId)).size, normal.length);
  assert.equal(new Set(normal.map((trade) => `${trade.side}:${trade.context.entryTrigger}:${trade.stopPrice}:${trade.targetPrice}`)).size,
    normal.length, "only genuinely different frozen routes receive separate score identities");
  const repeated = openEvent(first, 1, 10_001);
  assert.equal(Object.keys(repeated.open).length, Object.keys(first.open).length);
  const closed = settleEvent(repeated, 20_000, true);
  assert.equal(closed.recentShadow.length, Object.keys(first.open).length);
  assert.equal(Object.values(closed.strategies).reduce((total, score) => total + score.shadowResolved + score.reverseShadowResolved, 0),
    Object.keys(first.open).length);
});

test("a new event id cannot overlap an existing effective shadow for the same symbol and exact variant", () => {
  const first = openEvent(initialStrategyArena(1), 1, 10_000);
  const second = openEvent(first, 2, 10_001);
  assert.equal(Object.keys(second.open).length, Object.keys(first.open).length);
  assert.ok(second.recentObservations.some((row) => row.eventId.endsWith(":2")
    && row.blocker.includes("这个执行变体已有有效影子持仓") && row.blocker.includes("仅观察")));
});

test("observation shadow is separate and never counts toward promotion", () => {
  const thin = observation(1, 10_000); thin.bidDepthUsd = 100; thin.askDepthUsd = 100;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: thin });
  assert.equal(Object.keys(state.open).length, 0);
  assert.ok(state.recentObservations.length > 0);
  assert.equal(state.strategies[strategyId].shadowResolved, 0);
});

test("latest three independent effective shadow wins activate only future signals and PAPER clones its exact shadow", () => {
  let state = qualify();
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
  assert.equal(Object.values(state.strategies).filter((row) => row.id.startsWith("anomaly_follow:") && row.enabled).length, 4,
    "all genuinely distinct variants collect the same event cadence without random starvation");
  assert.equal(Object.keys(state.portfolioOpen).length, 0, "completed winners are never backfilled");
  state = openEvent(state, 20, 120_000);
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper);
  const shadow = Object.values(state.open).find((trade) => trade.strategyId === paper.strategyId
    && (trade.orientation ?? "NORMAL") === (paper.orientation ?? "NORMAL"));
  assert.ok(shadow, "the selected PAPER order must exist as a same-event effective shadow");
  for (const key of ["eventId", "strategyId", "orientation", "side", "openedAt", "entryPrice", "stopPrice", "targetPrice",
    "notional", "plannedRisk", "contracts", "quantoMultiplier", "leverage", "margin"] as const)
    assert.equal(paper[key], shadow[key], `${key} must be copied from the exact effective shadow`);
  assert.equal(paper.context.maxHoldMs, shadow.context.maxHoldMs);
  assert.equal(paper.context.noProgressMs, shadow.context.noProgressMs);
  assert.deepEqual(paper.attributedStrategyIds, [paper.orientation === "REVERSE" ? `reverse|${paper.strategyId}` : paper.strategyId]);
});

test("correlated cross-symbol results in the same five-minute lifecycle count only once", () => {
  let state = initialStrategyArena(1);
  const lifecycleAt = 1_757_500_000_000;
  for (const [index, symbol] of ["BTC_USDT", "ETH_USDT", "SOL_USDT"].entries()) {
    const opened = openForStrategyAtLifecycle(state, strategyId, lifecycleAt, 900 + index * 100,
      100_000 + index * 20_000, symbol);
    state = settleEvent(opened.state, opened.now + 10_000, true, symbol);
  }
  assert.equal(state.strategies[strategyId].lane, "SHADOW");
  assert.equal(state.strategies[strategyId].enabled, false);
});

test("after-cost shadow qualification is not charged a second empirical cost gate", () => {
  const state = qualify();
  for (const score of Object.values(state.strategies)) {
    if (score.id === strategyId) continue;
    score.enabled = false;
    score.lane = "SHADOW";
    score.recentResults = [];
  }
  state.strategies[strategyId].recentResults = state.strategies[strategyId].recentResults.map((row) => ({
    ...row, netReturnRate: ARENA_FRICTION_RATE / 2, netPnl: 1, won: true,
  }));
  const opened = openForStrategy(state, strategyId, 1_100, 200_000);
  assert.ok(opened.state.portfolioOpen.BTC_USDT);
  assert.equal(opened.state.admissionRejects.EMPIRICAL_COST, undefined);
});

test("remaining portfolio capacity below 10 U planned risk is skipped instead of creating a dust trade", () => {
  const state = openEvent(qualify(), 20, 120_000);
  assert.ok(state.portfolioOpen.BTC_USDT);
  state.portfolioOpen.BTC_USDT.margin = state.portfolioEquity * 0.2999;
  const opened = openForStrategy(state, strategyId, 1_300, 220_000, "ETH_USDT");
  assert.equal(opened.state.portfolioOpen.ETH_USDT, undefined);
  assert.ok((opened.state.admissionRejects.SIZING ?? 0) > 0);
});

test("three wins outside the 24-hour cadence window remain research-only", () => {
  let state = initialStrategyArena(1);
  let eventStart = 700;
  for (let index = 0; index < PROMOTION_WIN_STREAK; index += 1) {
    const opened = openForStrategy(state, strategyId, eventStart, 10_000 + index * 13 * 60 * 60_000);
    state = settleEvent(opened.state, opened.now + 10_000, true);
    eventStart = opened.event + 1;
  }
  assert.equal(state.strategies[strategyId].lane, "SHADOW");
});

test("a low-win-rate variant can activate from a positive latest-six window", () => {
  let state = initialStrategyArena(1);
  const outcomes = [true, false, true, false, true, true];
  let eventStart = 300;
  for (let index = 0; index < outcomes.length; index += 1) {
    const opened = openForStrategy(state, strategyId, eventStart, 200_000 + index * 20_000);
    state = settleEvent(opened.state, opened.now + 10_000, outcomes[index]);
    eventStart = opened.event + 1;
  }
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
  assert.match(state.strategies[strategyId].lastTransitionReason, /最新6笔/);
});

test("a positive latest-six window outranks a latest-three loss streak and keeps only NORMAL enabled", () => {
  const state = rewriteVariantWindow(sixEventState(), [0.02, 0.02, 0.02, -0.005, -0.005, -0.005]);
  assert.equal(state.strategies[strategyId].enabled, true);
  assert.equal(state.strategies[strategyId].reverseEnabled, false);
  assert.match(state.strategies[strategyId].lastTransitionReason, /6笔窗口优先/);
});

test("a negative latest-six window outranks a latest-three win streak and keeps only REVERSE enabled", () => {
  const state = rewriteVariantWindow(sixEventState(), [-0.02, -0.02, -0.02, 0.004, 0.004, 0.004]);
  assert.equal(state.strategies[strategyId].enabled, false);
  assert.equal(state.strategies[strategyId].reverseEnabled, true);
  assert.match(state.strategies[strategyId].reverseLastTransitionReason, /6笔窗口优先/);
});

test("PAPER losses are performance records and never override qualified shadow authority", () => {
  let state = qualify();
  state.strategies[strategyId].paperResults = [1, 2, 3].map((event) => ({ eventId: `paper:${event}`, symbol: "BTC_USDT",
    regime: "EXPANSION", channel: "ANOMALY", netReturnRate: -0.01, netPnl: -10, won: false, resolvedAt: 100_000 + event }));
  state = normalizeStrategyArena(state, 200_000);
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
  assert.equal(state.strategies[strategyId].enabled, true);
  assert.equal(state.strategies[strategyId].paperResults.length, 3);
});

test("unproven playbooks remain in shadow instead of sleeping when their channel is absent", () => {
  const state = applyStrategySleepStates(initialStrategyArena(1), new Set(["RANGE"]), 100_000);
  assert.equal(Object.values(state.strategies).filter((row) => row.lane === "SLEEPING").length, 0);
  assert.equal(Object.values(state.strategies).filter((row) => row.lane === "SHADOW").length, 48);
});

test("completed five-minute structure can create a valid shadow route without radar route geometry", () => {
  const input = observation(1, 10_000);
  input.candidate = { ...input.candidate, id: "BTC_USDT:CANDLE5M:TREND:LONG:1", channel: "TREND", regime: "TREND",
    trendEfficiency: 0.8, trendRate: 0.01, rangePosition: 0.9, anomalyKind: null };
  input.routes = [];
  input.range15m = null;
  input.candleStructure = { id: "BTC_USDT:5m:1", observedAt: 10_000, lower: 98, upper: 101.2,
    midpoint: 99.6, recentLower: 99.2, recentUpper: 101.2 };
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  const trade = Object.values(state.open)[0];
  assert.ok(trade);
  assert.equal(trade.context.structureSource, "CANDLE_5M");
});

test("missing channels never sleep or erase an enabled strategy", () => {
  let state = qualify();
  const before = structuredClone(state.strategies[strategyId].recentResults);
  state = applyStrategySleepStates(state, new Set(["RANGE"]), 100_000);
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
  assert.deepEqual(state.strategies[strategyId].recentResults, before);
  state = applyStrategySleepStates(state, new Set(["ANOMALY"]), 110_000);
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
});

test("effective shadow uses bid/ask, integer contracts, frozen exits and complete costs", () => {
  let state = openForStrategy(initialStrategyArena(1), strategyId, 1, 10_000).state;
  const trade = state.open[`${strategyId}:BTC_USDT`];
  assert.equal(trade.entryPrice, 101.01);
  assert.ok(Number.isInteger(trade.contracts) && trade.contracts > 0);
  assert.ok(trade.plannedRisk >= 10 && trade.plannedRisk <= 20.1);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: 103.02, bestBid: 103.01, bestAsk: 103.03, fresh: true } }, now: 8 * 60 * 60_000 });
  const closed = state.recentShadow.find((item) => item.strategyId === strategyId);
  assert.ok(closed && (closed.context.fundingCostRate ?? 0) > 0);
  assert.equal(Number((closed!.grossReturnRate! - closed!.netReturnRate!).toFixed(8)),
    Number((ARENA_FRICTION_RATE + (closed!.context.fundingCostRate ?? 0)).toFixed(8)));
});

test("stale prices cannot close and soft exits require a new completed minute", () => {
  let state = openEvent(initialStrategyArena(1), 1, 10_000);
  const count = Object.keys(state.open).length;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: {
    midpoint: 99, bestBid: 99, bestAsk: 99.01, observedAt: 1, fresh: true,
  } }, now: 20_000 });
  assert.equal(Object.keys(state.open).length, count);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: {
    midpoint: 101, bestBid: 101, bestAsk: 101.01, observedAt: 9 * 60_000, fresh: true,
  } }, now: 9 * 60_000 });
  assert.equal(Object.keys(state.open).length, count);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: {
    midpoint: 101, bestBid: 101, bestAsk: 101.01, observedAt: 9 * 60_000, fresh: true, completedMinuteAt: 8 * 60_000,
  } }, now: 9 * 60_000 });
  assert.ok(Object.keys(state.open).length < count);
});

test("account reset uses executable quotes, archives the cycle and starts at 1000 U", () => {
  let state = openEvent(qualify(), 200, 500_000);
  state = resetStrategyArenaAccount({ state,
    quotes: { BTC_USDT: { midpoint: 101.2, bestBid: 101.19, bestAsk: 101.21, fresh: true } }, now: 510_000 });
  assert.equal(state.portfolioEquity, 1_000);
  assert.deepEqual(state.portfolioOpen, {});
  assert.equal(state.archivedPortfolioCycles.length, 1);
});

test("V4.4 freezes a materially closer target while retaining full-cost economics", () => {
  const structureId = "anomaly_follow:confirm:structure";
  const opened = openForStrategy(initialStrategyArena(1), structureId, 1, 10_000).state;
  const trade = opened.open[`${structureId}:BTC_USDT`];
  assert.ok(trade.context.targetAdapted);
  assert.ok((trade.context.originalTargetPrice ?? 0) > trade.targetPrice);
  assert.ok(trade.context.netRewardRisk >= 1.2);
  assert.equal(trade.context.targetEvidenceEvents, 0);
});

test("three consecutive normal shadow losses directly activate the profitable countertrend", () => {
  let state = initialStrategyArena(1);
  let eventStart = 2_000;
  let now = 1_000_000;
  for (let index = 0; index < 3; index += 1) {
    const opened = openForStrategy(state, strategyId, eventStart, now);
    state = settleEvent(opened.state, opened.now + 10_000, false);
    eventStart = opened.event + 1; now += 20_000;
  }
  assert.equal(state.strategies[strategyId].reverseEnabled, true,
    JSON.stringify(state.strategies[strategyId].recentResults));
  assert.equal(state.strategies[strategyId].reverseQualificationResults.length, 3,
    "the same three losing normal paths are the fully costed reverse qualification sample");
  assert.equal(state.strategies[strategyId].reverseRecentResults.length, 3,
    "the genuinely executable paired reverse shadow keeps running independently of activation");
  assert.deepEqual(state.strategies[strategyId].reverseQualificationResults.map((row) => [row.eventId, row.netReturnRate]),
    state.strategies[strategyId].reverseRecentResults.map((row) => [row.eventId, row.netReturnRate]),
    "actual paired reverse fills replace the legacy counterfactual whenever both are available");

  const next = openForStrategy(state, strategyId, eventStart, now).state;
  assert.ok(Object.values(next.open).some((trade) => trade.strategyId === strategyId
    && (trade.orientation ?? "NORMAL") === "NORMAL"), "normal effective shadow remains continuous after inverse promotion");
  assert.ok(Object.values(next.open).some((trade) => trade.strategyId === strategyId
    && trade.orientation === "REVERSE"), "reverse shadow remains continuous beside the enabled route");
  assert.equal(Object.keys(next.portfolioOpen).length, 1, "one account selects one direction and never self-hedges");
  assert.equal(next.portfolioOpen.BTC_USDT.orientation, "REVERSE");
  assert.equal(next.portfolioOpen.BTC_USDT.side, "SHORT");
});

test("a negative six-result normal window activates reverse without a three-loss streak", () => {
  let state = initialStrategyArena(1);
  let eventStart = 3_000;
  let now = 2_000_000;
  for (const winner of [false, false, true, false, false, true]) {
    const opened = openForStrategy(state, strategyId, eventStart, now);
    state = settleEvent(opened.state, opened.now + 10_000, winner);
    eventStart = opened.event + 1; now += 20_000;
  }
  const trades = state.recentShadow.filter((trade) => trade.strategyId === strategyId).slice(-6);
  assert.equal(trades.length, 6);
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    const grossReturnRate = index === 2 || index === 5 ? 0.002 : -0.01;
    const cost = trade.context.modeledCostRate + (trade.context.fundingCostRate ?? 0) + trade.context.spreadRate;
    trade.grossReturnRate = grossReturnRate;
    trade.netReturnRate = grossReturnRate - cost;
    trade.netPnl = trade.notional * trade.netReturnRate;
    const result = state.strategies[strategyId].recentResults.find((row) => row.eventId === trade.eventId);
    if (result) { result.netReturnRate = trade.netReturnRate; result.netPnl = trade.netPnl; result.won = trade.netReturnRate > 0; }
    const reverseTrade = state.recentShadow.find((row) => row.strategyId === strategyId && row.eventId === trade.eventId
      && row.orientation === "REVERSE");
    const reverseResult = state.strategies[strategyId].reverseRecentResults.find((row) => row.eventId === trade.eventId);
    assert.ok(reverseTrade && reverseResult);
    reverseTrade.netReturnRate = -grossReturnRate - trade.context.modeledCostRate
      - (trade.context.fundingCostRate ?? 0) - trade.context.spreadRate * 2;
    reverseTrade.netPnl = reverseTrade.notional * reverseTrade.netReturnRate;
    reverseResult.netReturnRate = reverseTrade.netReturnRate; reverseResult.netPnl = reverseTrade.netPnl;
    reverseResult.won = reverseTrade.netReturnRate > 0;
  }
  state = normalizeStrategyArena(state, now);
  assert.equal(state.strategies[strategyId].reverseEnabled, true,
    JSON.stringify(state.strategies[strategyId].recentResults));
  assert.equal(state.strategies[strategyId].reverseQualificationResults.length, 6);
  assert.match(state.strategies[strategyId].reverseLastTransitionReason, /最新6笔正常影子成本后总收益为负/);
});
