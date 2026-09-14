import { readFileSync, writeFileSync } from "node:fs";
import { previousCompletedCandleStrategyCandidate } from "../lib/previous-market-regime.ts";
import { allRegimePaperApproved } from "../lib/previous-all-regime-engine.ts";
import { advanceStrategyArena, advanceStrategyShadowsFromCompletedCandle, initialStrategyArena,
  observeStrategyArena } from "../lib/previous-strategy-arena.ts";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/all-regime-candles.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/v4-production-parity.json";
const MODE = process.env.RESEARCH_MODE ?? "baseline";
const INCLUDE_TRADES = process.env.RESEARCH_INCLUDE_TRADES === "1";
const BASE_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const MIN_MARKETS = 12;

const sum = (values) => values.reduce((total, value) => total + value, 0);
const quantile = (values, fraction) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
};

const raw = JSON.parse(readFileSync(DATASET, "utf8"));
const longHorizon = raw.source === "gate-official-monthly-futures-usdt-candlesticks-5m-v1";
if (!longHorizon && (raw.days !== 30 || raw.universePolicy !== "gate-crypto-contract-type-v1")) {
  throw new Error("Production-parity V4 research requires a frozen Gate crypto futures dataset");
}
const datasets = raw.datasets;
const symbols = raw.symbols;
const fromMs = (raw.from ?? raw.now - raw.days * 86_400) * 1_000;
const monthBoundary = (index) => Date.UTC(Number(raw.months[index].slice(0, 4)), Number(raw.months[index].slice(4, 6)) - 1, 1);
const discoveryEndMs = longHorizon ? monthBoundary(6)
  : fromMs + raw.days * 86_400_000 / 2;
const validationEndMs = longHorizon ? monthBoundary(9) : discoveryEndMs;
const splitMs = discoveryEndMs;
const toMs = raw.now * 1_000;

async function contractMetadata() {
  const response = await fetch("https://api.gateio.ws/api/v4/futures/usdt/contracts", {
    headers: { Accept: "application/json", "X-Gate-Size-Decimal": "1" },
  });
  if (!response.ok) throw new Error(`Gate contract metadata unavailable: ${response.status}`);
  const rows = await response.json();
  const result = new Map(rows.filter((row) => symbols.includes(row.name)).map((row) => [row.name, {
    multiplier: Math.max(Number(row.quanto_multiplier), 1e-12),
    leverageMax: Math.max(1, Math.floor(Number(row.leverage_max) || 50)),
    maintenanceRate: Math.max(0, Number(row.maintenance_rate) || 0.005),
  }]));
  const missing = symbols.filter((symbol) => !result.has(symbol));
  if (missing.length) throw new Error(`Missing Gate contract metadata: ${missing.join(",")}`);
  return result;
}

function fiveMinuteUnitRate(rows, index) {
  const ranges = rows.slice(Math.max(0, index - 35), index + 1)
    .map((row) => (row.high - row.low) / Math.max(row.close, 1e-12));
  return quantile(ranges, 0.5);
}

function estimatedMinuteNoiseRate(rows, index) {
  const rates = rows.slice(Math.max(0, index - 3), index + 1)
    .map((row) => (row.high - row.low) / Math.max((row.high + row.low + row.close) / 3, 1e-12));
  return Math.min(0.0045, quantile(rates, 0.70) / Math.sqrt(5));
}

const volatilityThresholds = (() => {
  const discovery = [];
  for (const { rows } of datasets) for (let index = 120; index < rows.length - 1; index += 1) {
    const at = rows[index + 1].time * 1_000;
    if (at >= splitMs) break;
    discovery.push(fiveMinuteUnitRate(rows, index));
  }
  return { q60: quantile(discovery, 0.60), q75: quantile(discovery, 0.75), q90: quantile(discovery, 0.90) };
})();

const rowsBySymbol = new Map(datasets.map((dataset) => [dataset.symbol, dataset.rows]));
const timeIndex = new Map(datasets.flatMap(({ symbol, rows }) => rows.map((row, index) => [`${symbol}:${row.time}`, index])));
const times = [...new Set(datasets.flatMap(({ rows }) => rows.map((row) => row.time)))].sort((a, b) => a - b);
const continuousHistory = (rows, index, count) => {
  if (index + 1 < count) return false;
  for (let cursor = index - count + 2; cursor <= index; cursor += 1) {
    if (rows[cursor].time !== rows[cursor - 1].time + 300) return false;
  }
  return true;
};
const frames = times.map((time) => {
  const completedAt = (time + 300) * 1_000;
  const candles = symbols.flatMap((symbol) => {
    const rows = rowsBySymbol.get(symbol); const index = timeIndex.get(`${symbol}:${time}`);
    return rows && index != null ? [{ symbol, candle: rows[index] }] : [];
  });
  const candidates = symbols.flatMap((symbol) => {
    const rows = rowsBySymbol.get(symbol); const index = timeIndex.get(`${symbol}:${time}`);
    if (!rows || index == null || !continuousHistory(rows, index, 120) || index + 1 >= rows.length
      || rows[index + 1].time !== time + 300) return [];
    const built = previousCompletedCandleStrategyCandidate({ symbol,
      candles: rows.slice(Math.max(0, index - 359), index + 1),
      volume24hUsd: 2_000_000_000, fundingRate: 0, now: completedAt });
    return built ? [{ ...built, rows, index, unitRate: fiveMinuteUnitRate(rows, index) }] : [];
  });
  return { completedAt, candles, candidates, context: contextFor(candidates) };
}).filter((frame) => frame.completedAt >= fromMs && frame.completedAt < toMs);

function applyGeometry(candidate, unitRate, config) {
  const highVolatility = config.volatilityThreshold != null && unitRate >= config.volatilityThreshold;
  const routes = (candidate.allRegimeRoutes ?? []).flatMap((route) => {
    if (!highVolatility) return [route];
    if (config.highVolatilityMode === "exclude") return [];
    if (!(config.extraStopUnits > 0)) return [route];
    const sign = route.side === "LONG" ? 1 : -1;
    const baseRiskRate = Math.abs(route.triggerPrice - route.invalidationPrice) / route.triggerPrice;
    const baseArmRate = Math.abs(route.profitArmPrice - route.triggerPrice) / route.triggerPrice;
    const riskRate = baseRiskRate + unitRate * config.extraStopUnits;
    const armRate = config.targetMode === "sameR"
      ? baseArmRate * riskRate / Math.max(baseRiskRate, 1e-12) : baseArmRate;
    return [{ ...route,
      invalidationPrice: route.triggerPrice * (1 - sign * riskRate),
      profitArmPrice: route.triggerPrice * (1 + sign * armRate) }];
  });
  return { candidate: { ...candidate, allRegimeRoutes: routes }, highVolatility };
}

function contextFor(candidates) {
  const moves = candidates.map((row) => row.candidate.broadMoveRate ?? row.candidate.trendRate)
    .filter(Number.isFinite).sort((left, right) => left - right);
  return { breadth: moves.length ? moves.filter((value) => value > 0).length / moves.length : 0.5,
    medianMove: moves.length ? moves[Math.floor(moves.length / 2)] : 0, markets: moves.length };
}

function executableQuote(price, completedMinuteAt) {
  return { midpoint: price, bestBid: price, bestAsk: price, completedMinuteAt };
}

function advancePortfolioFromCandle(state, symbol, candle, completedAt) {
  const trades = Object.values(state.portfolioOpen).filter((trade) => trade.symbol === symbol);
  for (const prior of trades) {
    const trade = state.portfolioOpen[symbol];
    if (!trade || trade.id !== prior.id || completedAt <= trade.openedAt) continue;
    const favorablePrice = trade.side === "LONG" ? candle.high : candle.low;
    const adversePrice = trade.side === "LONG" ? candle.low : candle.high;
    const favorable = trade.side === "LONG" ? (candle.high - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - candle.low) / trade.entryPrice;
    const adverse = trade.side === "LONG" ? (candle.low - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - candle.high) / trade.entryPrice;
    trade.maxFavorableRate = Math.max(trade.maxFavorableRate, favorable);
    trade.maxAdverseRate = Math.min(trade.maxAdverseRate, adverse);
    const startingProtection = trade.activeStopPrice ?? trade.stopPrice;
    const stopped = trade.side === "LONG" ? adversePrice <= startingProtection : adversePrice >= startingProtection;
    const targetHit = trade.profitArmedAt == null
      && (trade.side === "LONG" ? candle.high >= trade.targetPrice : candle.low <= trade.targetPrice);
    const shadows = state.open;
    state.open = {};
    if (stopped) {
      state = advanceStrategyArena({ state, quotes: { [symbol]: executableQuote(startingProtection, completedAt) }, now: completedAt });
      state.open = shadows;
      continue;
    }
    if (targetHit || trade.profitArmedAt != null) {
      state = advanceStrategyArena({ state, quotes: { [symbol]: executableQuote(favorablePrice, undefined) }, now: completedAt });
    }
    const afterMove = state.portfolioOpen[symbol];
    if (afterMove?.id === prior.id) {
      const tightenedProtection = afterMove.activeStopPrice;
      afterMove.activeStopPrice = startingProtection;
      state = advanceStrategyArena({ state,
        quotes: { [symbol]: executableQuote(candle.close, completedAt) }, now: completedAt });
      if (state.portfolioOpen[symbol]?.id === prior.id) {
        state.portfolioOpen[symbol].activeStopPrice = tightenedProtection;
        state.portfolioOpen[symbol].lastPrice = candle.close;
      }
    }
    state.open = shadows;
  }
  return state;
}

function metrics(trades, start, end, extraFriction = 0) {
  const rows = trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end)
    .sort((left, right) => left.closedAt - right.closedAt);
  const pnls = rows.map((trade) => trade.netPnl - trade.notional * extraFriction);
  const gains = pnls.filter((value) => value > 0); const losses = pnls.filter((value) => value <= 0);
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  for (const pnl of pnls) { equity += pnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12)); }
  const pnlBySymbol = Object.fromEntries([...new Set(rows.map((row) => row.symbol))].map((symbol) => [symbol,
    sum(rows.filter((row) => row.symbol === symbol).map((row) => row.netPnl - row.notional * extraFriction))]));
  const positiveTotal = sum(Object.values(pnlBySymbol).filter((value) => value > 0));
  const largestPositiveSymbolShare = positiveTotal > 0
    ? Math.max(0, ...Object.values(pnlBySymbol)) / positiveTotal : 1;
  const bucketMs = 5 * 86_400_000;
  const bucketPnls = Array.from({ length: Math.ceil((end - start) / bucketMs) }, (_, index) =>
    sum(rows.filter((row) => row.openedAt >= start + index * bucketMs
      && row.openedAt < Math.min(end, start + (index + 1) * bucketMs))
      .map((row) => row.netPnl - row.notional * extraFriction)));
  const monthlyPnls = longHorizon ? raw.months.flatMap((month) => {
    const monthStart = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
    const monthEnd = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
    if (monthStart < start || monthEnd > end) return [];
    return [{ month, pnl: sum(rows.filter((row) => row.openedAt >= monthStart && row.openedAt < monthEnd)
      .map((row) => row.netPnl - row.notional * extraFriction)) }];
  }) : [];
  return { trades: rows.length, wins: gains.length, winRate: rows.length ? gains.length / rows.length : 0,
    netPnl: sum(pnls), endEquity: equity,
    profitFactor: losses.length ? sum(gains) / Math.abs(sum(losses)) : gains.length ? 99 : 0,
    maxDrawdown, largestPositiveSymbolShare, positiveBuckets: bucketPnls.filter((value) => value > 0).length,
    bucketPnls, monthlyPnls, positiveMonths: monthlyPnls.filter((row) => row.pnl > 0).length, pnlBySymbol };
}

function captureClosed(state, captured, seen) {
  for (const trade of state.recentPortfolio) if (!seen.has(trade.id)) {
    seen.add(trade.id); captured.push({ ...trade });
  }
}

function applyAuthorityPolicy(state, config) {
  if (!config.authorityMode) return state;
  const latestUnique = (rows, count) => {
    const seen = new Set();
    return [...rows].sort((left, right) => right.resolvedAt - left.resolvedAt).filter((row) => {
      if (seen.has(row.eventId)) return false;
      seen.add(row.eventId); return true;
    }).slice(0, count).reverse();
  };
  for (const score of Object.values(state.strategies)) {
    const normal12 = latestUnique(score.recentResults, 12);
    const warmupSamples = config.authorityWarmupSamples ?? 6;
    if (normal12.length < warmupSamples) {
      if (config.authorityWarmupCash) {
        score.enabled = false; score.reverseEnabled = false; score.lane = "SHADOW";
      }
      continue;
    }
    const normal6 = normal12.slice(-6);
    if (normal6.length < 6) {
      if (config.authorityWarmupCash) {
        score.enabled = false; score.reverseEnabled = false; score.lane = "SHADOW";
      }
      continue;
    }
    const reverseByEvent = new Map(latestUnique(score.reverseRecentResults, 24).map((row) => [row.eventId, row]));
    const reverse6 = normal6.flatMap((row) => reverseByEvent.get(row.eventId) ? [reverseByEvent.get(row.eventId)] : []);
    const reverse12 = normal12.flatMap((row) => reverseByEvent.get(row.eventId) ? [reverseByEvent.get(row.eventId)] : []);
    const normal3 = normal6.slice(-3); const reverse3 = normal3.flatMap((row) => reverseByEvent.get(row.eventId)
      ? [reverseByEvent.get(row.eventId)] : []);
    const threeFresh = normal3.at(-1).resolvedAt - normal3[0].resolvedAt <= 24 * 60 * 60_000;
    const sixFresh = normal6.at(-1).resolvedAt - normal6[0].resolvedAt <= 72 * 60 * 60_000;
    const normal6Net = sum(normal6.map((row) => row.netReturnRate));
    const reverse6Net = sum(reverse6.map((row) => row.netReturnRate));
    const normal12Net = sum(normal12.map((row) => row.netReturnRate));
    const reverse12Net = sum(reverse12.map((row) => row.netReturnRate));
    const profitFactor = (rows) => {
      const gains = sum(rows.filter((row) => row.netReturnRate > 0).map((row) => row.netReturnRate));
      const losses = Math.abs(sum(rows.filter((row) => row.netReturnRate <= 0).map((row) => row.netReturnRate)));
      return losses > 0 ? gains / losses : gains > 0 ? 99 : 0;
    };
    const normalThreeWins = threeFresh && normal3.every((row) => row.netReturnRate > 0);
    const reverseThreeWins = threeFresh && normal3.every((row) => row.netReturnRate < 0)
      && reverse3.length === 3 && reverse3.every((row) => row.netReturnRate > 0);
    const sixProfitFactorMinimum = config.sixProfitFactorMinimum ?? 0;
    const twelveProfitFactorMinimum = config.twelveProfitFactorMinimum ?? 1.05;
    const normalSixWins = sixFresh && normal6Net > 0 && profitFactor(normal6) >= sixProfitFactorMinimum;
    const reverseSixWins = sixFresh && normal6Net < 0 && reverse6.length === 6 && reverse6Net > 0
      && profitFactor(reverse6) >= sixProfitFactorMinimum;
    const twelveFresh = normal12.length === 12
      && normal12.at(-1).resolvedAt - normal12[0].resolvedAt <= 7 * 24 * 60 * 60_000;
    const normalTwelveWins = twelveFresh && normal12Net > 0 && profitFactor(normal12) >= twelveProfitFactorMinimum;
    const reverseTwelveWins = twelveFresh && normal12Net < 0 && reverse12.length === 12
      && reverse12Net > 0 && profitFactor(reverse12) >= twelveProfitFactorMinimum;
    let orientation = null;
    if (config.authorityMode === "three-or-six-cash") orientation = normalThreeWins || normalSixWins ? "NORMAL"
      : reverseThreeWins || reverseSixWins ? "REVERSE" : null;
    else if (config.authorityMode === "strict-six-cash") orientation = normalSixWins ? "NORMAL"
      : reverseSixWins ? "REVERSE" : null;
    else if (config.authorityMode === "three-only-cash") orientation = normalThreeWins ? "NORMAL"
      : reverseThreeWins ? "REVERSE" : null;
    else if (config.authorityMode === "three-and-six-cash") orientation = normalThreeWins && normalSixWins ? "NORMAL"
      : reverseThreeWins && reverseSixWins ? "REVERSE" : null;
    else if (config.authorityMode === "six-and-twelve-cash") orientation = normal12.length < 12
      ? normalSixWins ? "NORMAL" : reverseSixWins ? "REVERSE" : null
      : normalSixWins && normalTwelveWins ? "NORMAL" : reverseSixWins && reverseTwelveWins ? "REVERSE" : null;
    else if (config.authorityMode === "twelve-cash") orientation = normal12.length < 12 ? null
      : normalTwelveWins ? "NORMAL" : reverseTwelveWins ? "REVERSE" : null;
    else if (config.authorityMode === "loss-demotion") {
      if (reverseThreeWins || reverseSixWins) orientation = "REVERSE";
      else if (normalThreeWins || normalSixWins) orientation = "NORMAL";
      else if (normal6Net <= 0) orientation = null;
      else continue;
    }
    score.enabled = orientation === "NORMAL";
    score.reverseEnabled = orientation === "REVERSE";
    score.lane = orientation === "NORMAL" ? "ACTIVE" : "SHADOW";
  }
  return state;
}

async function replay(config, contracts, start = fromMs, end = toMs, slippage = BASE_SLIPPAGE) {
  let state = initialStrategyArena(start);
  const captured = []; const seen = new Set();
  let observedRoutes = 0; let highVolatilityRoutes = 0;
  let day = null; let dayStartEquity = 1_000; let dailyBlockedFrames = 0;
  for (const frame of frames) {
    const { completedAt } = frame;
    if (completedAt < start || completedAt >= end) continue;
    const currentDay = new Date(completedAt).toISOString().slice(0, 10);
    if (currentDay !== day) { day = currentDay; dayStartEquity = state.portfolioEquity; }
    for (const { symbol, candle } of frame.candles) {
      state = advanceStrategyShadowsFromCompletedCandle({ state, symbol,
        candle: { high: candle.high, low: candle.low, close: candle.close, completedAt } });
      state = advancePortfolioFromCandle(state, symbol, candle, completedAt);
      captureClosed(state, captured, seen);
    }
    state = applyAuthorityPolicy(state, config);
    const dayPnlRate = (state.portfolioEquity - dayStartEquity) / Math.max(dayStartEquity, 1e-12);
    const dailyBlocked = config.dailyLossCapRate != null && dayPnlRate <= -config.dailyLossCapRate
      || config.dailyProfitLockRate != null && dayPnlRate >= config.dailyProfitLockRate;
    dailyBlockedFrames += Number(dailyBlocked);
    const candidates = frame.candidates.map((row) => {
      const adjusted = applyGeometry(row.candidate, row.unitRate, config);
      return { ...row, candidate: adjusted.candidate, highVolatility: adjusted.highVolatility };
    });
    const { context } = frame;
    if (context.markets < MIN_MARKETS) continue;
    const ranked = candidates.filter((row) => (row.candidate.allRegimeRoutes ?? [])
      .some((route) => allRegimePaperApproved(route.strategyId)))
      .sort((left, right) => right.candidate.score - left.candidate.score
        || symbols.indexOf(left.candidate.symbol) - symbols.indexOf(right.candidate.symbol));
    for (const row of ranked) {
      const nextOpen = row.rows[row.index + 1].open;
      const bestAsk = nextOpen * (1 + slippage); const bestBid = nextOpen * (1 - slippage);
      const meta = contracts.get(row.candidate.symbol);
      const useSizingPolicy = config.sizingScope === "all" || config.sizingScope === "highVolatility" && row.highVolatility;
      observedRoutes += 1; highVolatilityRoutes += Number(row.highVolatility);
      const sizingPolicy = dailyBlocked ? { maximumPositionNotionalMultiple: 0, minimumNotionalMultiple: 0 }
        : useSizingPolicy ? config.sizingPolicy : undefined;
      state = observeStrategyArena({ state, observation: { candidate: row.candidate, midpoint: nextOpen, bestBid, bestAsk,
        alignedFlow: 0, minuteNoiseRate: estimatedMinuteNoiseRate(row.rows, row.index),
        spreadRate: (bestAsk - bestBid) / nextOpen, range15m: null,
        confirmationBySide: { LONG: 0.8, SHORT: 0.8 }, fakeoutBySide: { LONG: 0.1, SHORT: 0.1 }, routes: [],
        bidDepthUsd: 10_000_000, askDepthUsd: 10_000_000, quantoMultiplier: meta.multiplier,
        maintenanceRate: meta.maintenanceRate, leverageMax: meta.leverageMax, now: completedAt,
        dataFresh: true, contractReady: true, managementCapacity: true, completedMinuteAt: completedAt,
        candleStructure: row.structure, globalBreadth: context.breadth, globalMedianMove: context.medianMove,
        globalMarkets: context.markets, globalOpportunityRank: ranked.indexOf(row) + 1,
        globalOpportunityCount: ranked.length }, sizingPolicy });
      captureClosed(state, captured, seen);
    }
  }
  return { config, captured, observedRoutes, highVolatilityRoutes, dailyBlockedFrames,
    open: Object.values(state.portfolioOpen),
    admissionRejects: state.admissionRejects,
    discovery: metrics(captured, start, Math.min(discoveryEndMs, end)),
    validation: end > discoveryEndMs ? metrics(captured, Math.max(discoveryEndMs, start), Math.min(validationEndMs, end)) : null,
    blind: end > validationEndMs ? metrics(captured, Math.max(validationEndMs, start), end) : null,
    heldout: end > splitMs ? metrics(captured, Math.max(splitMs, start), end) : null,
    full: metrics(captured, start, end),
    stress: metrics(captured, start, end, STRESS_FRICTION - BASE_FRICTION),
    stressDiscovery: metrics(captured, start, Math.min(discoveryEndMs, end), STRESS_FRICTION - BASE_FRICTION),
    stressValidation: end > discoveryEndMs
      ? metrics(captured, Math.max(discoveryEndMs, start), Math.min(validationEndMs, end), STRESS_FRICTION - BASE_FRICTION) : null,
    stressBlind: end > validationEndMs
      ? metrics(captured, Math.max(validationEndMs, start), end, STRESS_FRICTION - BASE_FRICTION) : null };
}

const baseline = { id: "baseline", highVolatilityMode: "unchanged", extraStopUnits: 0, targetMode: "fixed" };
const sizingConfigs = [
  ...[0.0075, 0.01, 0.0125, 0.015].flatMap((risk) => [0.25, 0.5, 1].map((minimum) => ({
    id: `risk${risk}-min${minimum}`, highVolatilityMode: "unchanged", extraStopUnits: 0, targetMode: "fixed",
    sizingScope: "all", sizingPolicy: { singleTradeRiskRateCap: risk, minimumNotionalMultiple: minimum } }))),
  ...[0.5, 0.75, 1, 1.5].flatMap((cap) => [0.25, 0.5].map((minimum) => ({
    id: `cap${cap}-min${minimum}`, highVolatilityMode: "unchanged", extraStopUnits: 0, targetMode: "fixed",
    sizingScope: "all", sizingPolicy: { maximumPositionNotionalMultiple: cap, minimumNotionalMultiple: minimum } }))),
  ...Object.entries(volatilityThresholds).flatMap(([thresholdId, threshold]) => [
    { id: `${thresholdId}-exclude`, volatilityThreshold: threshold, highVolatilityMode: "exclude",
      extraStopUnits: 0, targetMode: "fixed" },
    ...[0.25, 0.5].flatMap((extraStopUnits) => ["fixed", "sameR"].map((targetMode) => ({
      id: `${thresholdId}-pad${extraStopUnits}-${targetMode}`, volatilityThreshold: threshold,
      highVolatilityMode: "resize", extraStopUnits, targetMode, sizingScope: "highVolatility",
      sizingPolicy: { singleTradeRiskRateCap: 0.01, maximumPositionNotionalMultiple: 0.75,
        minimumNotionalMultiple: 0.25 } }))),
  ])];
const authorityConfigs = ["three-or-six-cash", "strict-six-cash", "three-only-cash", "loss-demotion"].flatMap((authorityMode) => [
  { id: authorityMode, highVolatilityMode: "unchanged", extraStopUnits: 0, targetMode: "fixed", authorityMode },
  { id: `${authorityMode}-cap0.5`, highVolatilityMode: "unchanged", extraStopUnits: 0, targetMode: "fixed",
    authorityMode, sizingScope: "all",
    sizingPolicy: { maximumPositionNotionalMultiple: 0.5, minimumNotionalMultiple: 0.25 } },
  { id: `${authorityMode}-risk0.0075`, highVolatilityMode: "unchanged", extraStopUnits: 0, targetMode: "fixed",
    authorityMode, sizingScope: "all",
    sizingPolicy: { singleTradeRiskRateCap: 0.0075, minimumNotionalMultiple: 0.5 } },
]);
const stableAuthorityConfigs = ["three-and-six-cash", "six-and-twelve-cash", "twelve-cash"].flatMap((authorityMode) =>
  [0.5, 0.75, 1].map((maximumPositionNotionalMultiple) => ({
    id: `${authorityMode}-cap${maximumPositionNotionalMultiple}`, highVolatilityMode: "unchanged",
    extraStopUnits: 0, targetMode: "fixed", authorityMode, sizingScope: "all",
    sizingPolicy: { maximumPositionNotionalMultiple, minimumNotionalMultiple: 0.25 } })));
const stableBase = { id: "six-and-twelve-cash-cap0.5", highVolatilityMode: "unchanged", extraStopUnits: 0,
  targetMode: "fixed", authorityMode: "six-and-twelve-cash", sizingScope: "all",
  sizingPolicy: { maximumPositionNotionalMultiple: 0.5, minimumNotionalMultiple: 0.25 } };
const warmStableBase = { ...stableBase, id: "warm-six-and-twelve-cash-cap0.5",
  authorityWarmupCash: true, authorityWarmupSamples: 12 };
const dailyConfigs = [0.01, 0.015, 0.02, 0.03].flatMap((dailyLossCapRate) => [null, 0.03, 0.05].map((dailyProfitLockRate) => ({
  ...warmStableBase, id: `warm-stable-loss${dailyLossCapRate}-profit${dailyProfitLockRate ?? "none"}`,
  dailyLossCapRate, dailyProfitLockRate })));
const profitFactorConfigs = [1, 1.1, 1.2].flatMap((sixProfitFactorMinimum) => [1.05, 1.2, 1.4]
  .map((twelveProfitFactorMinimum) => ({ ...warmStableBase,
    id: `evidence-pf${sixProfitFactorMinimum}-${twelveProfitFactorMinimum}`,
    dailyLossCapRate: 0.02, dailyProfitLockRate: 0.03,
    sixProfitFactorMinimum, twelveProfitFactorMinimum })));
const longDiscoveryConfigs = [baseline,
  ...[0.25, 0.5, 0.75, 1].map((maximumPositionNotionalMultiple) => ({
    id: `long-cap${maximumPositionNotionalMultiple}`, highVolatilityMode: "unchanged",
    extraStopUnits: 0, targetMode: "fixed", sizingScope: "all",
    sizingPolicy: { maximumPositionNotionalMultiple, minimumNotionalMultiple: 0.25 } })),
  ...["strict-six-cash", "six-and-twelve-cash", "twelve-cash"].flatMap((authorityMode) =>
    [0.25, 0.5, 0.75].map((maximumPositionNotionalMultiple) => ({
      id: `long-${authorityMode}-cap${maximumPositionNotionalMultiple}`, highVolatilityMode: "unchanged",
      extraStopUnits: 0, targetMode: "fixed", authorityMode, authorityWarmupCash: true,
      authorityWarmupSamples: authorityMode === "strict-six-cash" ? 6 : 12, sizingScope: "all",
      sizingPolicy: { maximumPositionNotionalMultiple, minimumNotionalMultiple: 0.25 } }))),
  ...profitFactorConfigs];
const byId = new Map([...sizingConfigs, ...authorityConfigs, ...stableAuthorityConfigs, ...dailyConfigs]
  .map((config) => [config.id, config]));
const validationConfigs = ["cap0.5-min0.25", "risk0.0075-min0.5", "risk0.015-min1",
  "three-or-six-cash-cap0.5", "three-only-cash-cap0.5", "q90-pad0.5-fixed"].map((id) => byId.get(id));
const stableValidationConfigs = ["three-and-six-cash-cap0.5", "six-and-twelve-cash-cap0.5",
  "twelve-cash-cap0.5"].map((id) => byId.get(id));
const warmValidationConfigs = [warmStableBase,
  ...["warm-stable-loss0.01-profitnone", "warm-stable-loss0.02-profitnone",
    "warm-stable-loss0.02-profit0.03"].map((id) => byId.get(id))];
const dailyValidationConfigs = [0.01, 0.015, 0.02, 0.03]
  .map((loss) => byId.get(`warm-stable-loss${loss}-profit0.03`));
const configs = MODE === "long-research" ? [] : MODE === "baseline" ? [baseline]
  : MODE === "authority" ? [baseline, ...authorityConfigs]
    : MODE === "stable-authority" ? [baseline, ...stableAuthorityConfigs]
      : MODE === "stable-validation" ? [baseline, ...stableValidationConfigs]
        : MODE === "warm-validation" ? [baseline, ...warmValidationConfigs]
          : MODE === "daily-validation" ? [baseline, ...dailyValidationConfigs]
            : MODE === "final" ? [profitFactorConfigs.find((config) => config.id === "evidence-pf1-1.2")]
              : MODE === "evidence-pf" ? [warmStableBase, ...profitFactorConfigs]
                : MODE === "evidence-pf-validation" ? [baseline,
                  profitFactorConfigs.find((config) => config.id === "evidence-pf1-1.2")]
        : MODE === "daily" ? [stableBase, warmStableBase, ...dailyConfigs]
    : MODE === "validation" ? [baseline, ...validationConfigs] : [baseline, ...sizingConfigs];

const contracts = await contractMetadata();
const results = [];
let selection = null;
let adverseEntry = null;
if (MODE === "long-research") {
  if (!longHorizon) throw new Error("long-research mode requires the official Gate monthly archive dataset");
  const discoveryRows = [];
  for (const config of longDiscoveryConfigs) {
    const result = await replay(config, contracts, fromMs, discoveryEndMs);
    discoveryRows.push(result);
    console.log(`discovery ${config.id}: ${result.full.trades} trades, ${result.full.netPnl.toFixed(2)} U, PF ${result.full.profitFactor.toFixed(2)}, DD ${(result.full.maxDrawdown * 100).toFixed(2)}%`);
  }
  const eligible = discoveryRows.filter((result) => result.config.id !== "baseline" && result.full.trades >= 60
    && result.full.netPnl > 0 && result.full.profitFactor >= 1.2 && result.full.maxDrawdown <= 0.15
    && result.full.positiveMonths >= 4 && result.full.largestPositiveSymbolShare <= 0.40
    && result.full.positiveBuckets >= Math.ceil(result.full.bucketPnls.length * 0.50));
  const ranked = eligible.sort((left, right) => (right.full.positiveMonths - left.full.positiveMonths) * 1_000
    + (right.full.netPnl - left.full.netPnl)
    - (right.full.maxDrawdown - left.full.maxDrawdown) * 2_000);
  const winner = ranked[0] ?? null;
  selection = { frozenOn: "first-six-months-only", eligible: eligible.length,
    selectedId: winner?.config.id ?? null, discoveryCandidates: discoveryRows.map((result) => ({ id: result.config.id,
      trades: result.full.trades, netPnl: result.full.netPnl, profitFactor: result.full.profitFactor,
      maxDrawdown: result.full.maxDrawdown, positiveMonths: result.full.positiveMonths,
      positiveFiveDayBuckets: result.full.positiveBuckets, fiveDayBuckets: result.full.bucketPnls.length,
      largestPositiveSymbolShare: result.full.largestPositiveSymbolShare })) };
  results.push(await replay(baseline, contracts, fromMs, toMs));
  if (winner) {
    const selected = await replay(winner.config, contracts, fromMs, toMs);
    results.push(selected);
    adverseEntry = await replay(winner.config, contracts, fromMs, toMs, BASE_SLIPPAGE * 2);
    const positive = (period, minimumPf) => period && period.netPnl > 0 && period.profitFactor >= minimumPf;
    selection.releaseGates = {
      discoveryPositive: positive(selected.discovery, 1.2),
      validationPositive: positive(selected.validation, 1.1),
      blindPositive: positive(selected.blind, 1.1),
      majorityMonthsPositive: selected.full.positiveMonths >= Math.ceil(raw.months.length * 2 / 3),
      drawdownBounded: selected.full.maxDrawdown <= 0.15,
      concentrationBounded: selected.full.largestPositiveSymbolShare <= 0.35,
      stressDiscoveryPositive: positive(selected.stressDiscovery, 1.05),
      stressValidationPositive: positive(selected.stressValidation, 1.05),
      stressBlindPositive: positive(selected.stressBlind, 1.05),
      doubledAdverseEntryPositive: positive(adverseEntry.full, 1.1) && adverseEntry.full.maxDrawdown <= 0.20,
    };
    selection.accepted = Object.values(selection.releaseGates).every(Boolean);
  } else {
    selection.releaseGates = null;
    selection.accepted = false;
  }
} else {
  for (const config of configs) {
    const result = await replay(config, contracts, fromMs,
      MODE === "baseline" || MODE === "final" || MODE.endsWith("validation") ? toMs : splitMs);
    results.push(result);
    console.log(`${config.id}: ${result.full.trades} trades, ${result.full.netPnl.toFixed(2)} U, PF ${result.full.profitFactor.toFixed(2)}, DD ${(result.full.maxDrawdown * 100).toFixed(2)}%`);
  }
}
const compact = (result) => ({ config: result.config, observedRoutes: result.observedRoutes,
  highVolatilityRoutes: result.highVolatilityRoutes, discovery: result.discovery,
  validation: result.validation, blind: result.blind, heldout: result.heldout,
  full: result.full, stress: result.stress, stressDiscovery: result.stressDiscovery,
  stressValidation: result.stressValidation, stressBlind: result.stressBlind, openPositions: result.open.length,
  dailyBlockedFrames: result.dailyBlockedFrames, admissionRejects: result.admissionRejects,
  ...(INCLUDE_TRADES ? { trades: result.captured } : {}) });
const report = { generatedAt: new Date().toISOString(), mode: MODE,
  dataset: { source: raw.source ?? "Gate REST frozen cache", days: raw.days, from: raw.from, now: raw.now,
    months: raw.months, symbols, sha256: raw.sha256,
    quality: raw.datasets.map((item) => ({ symbol: item.symbol, gaps: item.gaps, coverage: item.coverage })) },
  assumptions: { source: "current previous V4 candidate builder and previous V12 arena",
    unavailableHistoricalInputs: ["two-second executable bid/ask path", "one-minute candles", "historical depth/funding/contract metadata"],
    replacements: ["next-five-minute open with adverse entry", "five-minute stop-first path", "estimated one-minute noise", "ample depth and zero funding"],
    baseFriction: BASE_FRICTION, baseSlippage: BASE_SLIPPAGE, stressFriction: STRESS_FRICTION,
    productionAuthorityMutated: false,
    candidateAuthorityStudied: (MODE === "long-research" ? longDiscoveryConfigs : configs)
      .some((config) => Boolean(config.authorityMode)) },
  volatilityThresholds, selection, results: results.map(compact),
  adverseEntry: adverseEntry ? compact(adverseEntry) : null };
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`V4_PRODUCTION_PARITY_REPORT=${OUTPUT}`);
