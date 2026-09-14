import { readFileSync, writeFileSync } from "node:fs";
import { allRegimePaperApproved, detectAllRegimeRoutes }
  from "../lib/previous-all-regime-engine.ts";
import { deriveMarketStateFeatures } from "../lib/strategy-coverage.ts";
import { routeMarketApproved } from "../lib/previous-strategy-coverage-policy.ts";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/all-regime-candles.json";
const RESEARCH_MODE = process.env.RESEARCH_MODE ?? "high-volatility";
const OUTPUT = process.env.RESEARCH_OUTPUT;
const BASE_FRICTION = 0.0014;
const BASE_SLIPPAGE = 0.00025;
const STRESS_FRICTION = 0.0022;
const STRESS_SLIPPAGE = 0.0005;
const MIN_NET_REWARD_RISK = 1.2;
const MAX_COST_SHARE = 0.25;
const MIN_NOTIONAL_MULTIPLE = 1;
const MAX_NOTIONAL_MULTIPLE = 4;
const PORTFOLIO_RISK_CAP = 0.10;
const SAME_DIRECTION_RISK_CAP = 0.065;
const MARGIN_CAP = 0.30;
const SAME_BRANCH_COOLDOWN_MS = 30 * 60_000;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const quantile = (values, fraction) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
};

const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.days !== 30 || raw.universePolicy !== "gate-crypto-contract-type-v1") {
  throw new Error("V4 volatility research requires the frozen 30-day crypto-only dataset");
}
const datasets = raw.datasets;
const symbols = raw.symbols;
const fromMs = (raw.now - raw.days * 86_400) * 1_000;
const toMs = raw.now * 1_000;
const splitMs = fromMs + (toMs - fromMs) / 2;

async function contractMetadata() {
  try {
    const response = await fetch("https://api.gateio.ws/api/v4/futures/usdt/contracts", {
      headers: { Accept: "application/json", "X-Gate-Size-Decimal": "1" },
    });
    if (!response.ok) throw new Error(`Gate ${response.status}`);
    const rows = await response.json();
    return new Map(rows.filter((row) => symbols.includes(row.name)).map((row) => [row.name, {
      multiplier: Math.max(Number(row.quanto_multiplier), 1e-12),
      leverageMax: Math.max(1, Math.floor(Number(row.leverage_max) || 50)),
      maintenanceRate: Math.max(0, Number(row.maintenance_rate) || 0.005),
    }]));
  } catch (error) {
    console.warn(`contract metadata unavailable; using conservative defaults: ${error instanceof Error ? error.message : error}`);
    return new Map(symbols.map((symbol) => [symbol, { multiplier: 1, leverageMax: 20, maintenanceRate: 0.01 }]));
  }
}

const marketMoves = new Map();
for (const { rows } of datasets) for (let index = 6; index < rows.length; index += 1) {
  const values = marketMoves.get(rows[index].time) ?? [];
  values.push(rows[index].close / rows[index - 6].close - 1);
  marketMoves.set(rows[index].time, values);
}
const marketContext = new Map([...marketMoves].map(([time, values]) => {
  const ordered = [...values].sort((left, right) => left - right);
  return [time, { breadth: values.filter((value) => value > 0).length / values.length,
    medianMove: ordered[Math.floor(ordered.length / 2)] ?? 0, markets: values.length }];
}));

function preEntryUnitRate(rows, index, triggerPrice) {
  return median(rows.slice(Math.max(0, index - 35), index + 1).map((row) => row.high - row.low))
    / Math.max(triggerPrice, 1e-12);
}

function approvedRawSignals() {
  const output = [];
  for (const { symbol, rows } of datasets) for (let index = 120; index < rows.length - 1; index += 1) {
    const context = marketContext.get(rows[index].time);
    if (!context || context.markets < 12) continue;
    const state = deriveMarketStateFeatures(rows.slice(index - 119, index + 1), context.breadth, context.medianMove);
    if (!state) continue;
    for (const route of detectAllRegimeRoutes(rows.slice(index - 119, index + 1))) {
      if (!allRegimePaperApproved(route.strategyId)
        || !routeMarketApproved(route, state)) continue;
      output.push({ symbol, at: rows[index + 1].time * 1_000,
        unitRate: preEntryUnitRate(rows, index, route.triggerPrice) });
    }
  }
  return output;
}

const discoveryUnitRates = approvedRawSignals().filter((row) => row.at < splitMs).map((row) => row.unitRate);
const volatilityThresholds = {
  q60: quantile(discoveryUnitRates, 0.60),
  q75: quantile(discoveryUnitRates, 0.75),
};

function geometry(rows, index, route, config) {
  const baseRiskRate = Math.abs(route.triggerPrice - route.invalidationPrice) / route.triggerPrice;
  const baseArmRate = Math.abs(route.profitArmPrice - route.triggerPrice) / route.triggerPrice;
  const unitRate = preEntryUnitRate(rows, index, route.triggerPrice);
  const highVolatility = config.threshold > 0 && unitRate >= config.threshold;
  const extraRiskRate = highVolatility ? unitRate * config.extraPad : 0;
  const riskRate = baseRiskRate + extraRiskRate;
  const armRate = config.targetMode === "sameR" && highVolatility
    ? baseArmRate * riskRate / Math.max(baseRiskRate, 1e-12) : baseArmRate;
  return { baseRiskRate, baseArmRate, riskRate, armRate, unitRate, highVolatility };
}

function resolveTrade(symbol, rows, signalIndex, route, config, friction, slippage, reverse = false) {
  if (signalIndex + 1 >= rows.length) return null;
  const shape = geometry(rows, signalIndex, route, config);
  const side = reverse ? route.side === "LONG" ? "SHORT" : "LONG" : route.side;
  const sign = side === "LONG" ? 1 : -1;
  const entryPrice = rows[signalIndex + 1].open * (1 + sign * slippage);
  const stopPrice = entryPrice * (1 - sign * shape.riskRate);
  const targetPrice = entryPrice * (1 + sign * shape.armRate);
  const risk = Math.abs(entryPrice - stopPrice);
  let activeStop = stopPrice; let armed = false; let bestFavorable = 0;
  const maxBars = Math.ceil(route.maxHoldMinutes / 5);
  const noProgressBars = Math.ceil(route.noProgressMinutes / 5);
  for (let offset = 1; offset <= maxBars && signalIndex + offset < rows.length; offset += 1) {
    const row = rows[signalIndex + offset];
    bestFavorable = Math.max(bestFavorable, side === "LONG" ? row.high - entryPrice : entryPrice - row.low);
    const stopHit = side === "LONG" ? row.low <= activeStop : row.high >= activeStop;
    const armHit = side === "LONG" ? row.high >= targetPrice : row.low <= targetPrice;
    let exitPrice = null; let outcome = null;
    if (stopHit) { exitPrice = activeStop; outcome = armed ? "RUNNER_EXIT" : "STOP"; }
    else if (armHit) armed = true;
    if (exitPrice == null && armed) {
      const giveback = Math.max(risk, bestFavorable * 0.45);
      const protectedMove = Math.max(entryPrice * friction + risk * 0.35, bestFavorable - giveback);
      activeStop = side === "LONG" ? Math.max(activeStop, entryPrice + protectedMove)
        : Math.min(activeStop, entryPrice - protectedMove);
    }
    const closeMove = sign * (row.close - entryPrice);
    if (exitPrice == null && !armed && offset >= noProgressBars
      && bestFavorable < risk * 0.35 && closeMove < risk * 0.15) {
      exitPrice = row.close; outcome = "NO_PROGRESS";
    }
    if (exitPrice == null && offset === maxBars) { exitPrice = row.close; outcome = "TIMEOUT"; }
    if (exitPrice != null) {
      const grossReturnRate = sign * (exitPrice - entryPrice) / entryPrice;
      return { eventId: `${symbol}:${route.strategyId}:${rows[signalIndex].time}`, symbol,
        strategyId: route.strategyId, strategyName: route.strategyName, branch: route.environment,
        side, score: route.score, openedAt: rows[signalIndex + 1].time * 1_000,
        closedAt: row.time * 1_000, entryPrice, stopPrice, targetPrice,
        riskRate: shape.riskRate, armRate: shape.armRate, baseRiskRate: shape.baseRiskRate,
        unitRate: shape.unitRate, highVolatility: shape.highVolatility,
        grossReturnRate, netReturnRate: grossReturnRate - friction,
        won: grossReturnRate - friction > 0, outcome, reverse };
    }
  }
  return null;
}

function generate(config, friction = BASE_FRICTION, slippage = BASE_SLIPPAGE) {
  const output = [];
  for (const { symbol, rows } of datasets) {
    const busyUntil = new Map();
    for (let index = 120; index < rows.length - 1; index += 1) {
      const context = marketContext.get(rows[index].time);
      if (!context || context.markets < 12) continue;
      const state = deriveMarketStateFeatures(rows.slice(index - 119, index + 1), context.breadth, context.medianMove);
      if (!state) continue;
      for (const route of detectAllRegimeRoutes(rows.slice(index - 119, index + 1))) {
        if (!allRegimePaperApproved(route.strategyId) || !routeMarketApproved(route, state)
          || (busyUntil.get(route.strategyId) ?? 0) >= rows[index + 1].time * 1_000) continue;
        const shape = geometry(rows, index, route, config);
        const nextOpen = rows[index + 1].open;
        const entryExtension = Math.abs(nextOpen - route.triggerPrice) / route.triggerPrice;
        const rewardRate = shape.armRate;
        const netRewardRisk = (rewardRate - friction) / Math.max(shape.riskRate + friction, 1e-12);
        if (entryExtension > Math.max(shape.riskRate * 0.65, 0.0008)
          || shape.riskRate < friction || friction / Math.max(rewardRate, 1e-12) > MAX_COST_SHARE
          || netRewardRisk < MIN_NET_REWARD_RISK) continue;
        const trade = resolveTrade(symbol, rows, index, route, config, friction, slippage);
        const reverseResult = resolveTrade(symbol, rows, index, route, config, friction, slippage, true);
        if (!trade || !reverseResult) continue;
        output.push({ ...trade, reverseResult, symbolRank: symbols.indexOf(symbol) });
        busyUntil.set(route.strategyId, trade.closedAt);
      }
    }
  }
  return output.sort((left, right) => left.openedAt - right.openedAt);
}

function simpleMetrics(trades) {
  const gains = trades.filter((row) => row.netReturnRate > 0).map((row) => row.netReturnRate);
  const losses = trades.filter((row) => row.netReturnRate <= 0).map((row) => row.netReturnRate);
  const netReturnRate = sum(trades.map((row) => row.netReturnRate));
  return { trades: trades.length, wins: gains.length, winRate: trades.length ? gains.length / trades.length : 0,
    netReturnRate, meanReturnRate: trades.length ? netReturnRate / trades.length : 0,
    profitFactor: losses.length ? sum(gains) / Math.abs(sum(losses)) : gains.length ? 99 : 0 };
}

function polarityTrade(trade, allTrades) {
  const history = allTrades.filter((row) => row.strategyId === trade.strategyId
    && row.openedAt < trade.openedAt && row.closedAt < trade.openedAt && row.reverseResult.closedAt < trade.openedAt);
  let orientation = "NORMAL";
  for (let index = 2; index < history.length; index += 1) {
    const latest = history.slice(index - 2, index + 1);
    const window = history.slice(Math.max(0, index - 11), index + 1);
    const normal = simpleMetrics(window); const reverse = simpleMetrics(window.map((row) => row.reverseResult));
    if (latest.every((row) => row.netReturnRate > 0) && normal.meanReturnRate > 0 && normal.profitFactor >= 1.05) {
      orientation = "NORMAL";
    } else if (latest.every((row) => row.netReturnRate < 0)
      && latest.every((row) => row.reverseResult.netReturnRate > 0)
      && window.length >= 12 && reverse.meanReturnRate > 0 && reverse.profitFactor >= 2.5) {
      orientation = "REVERSE";
    }
  }
  return orientation === "NORMAL" ? trade : trade.reverseResult;
}

function portfolio(allTrades, from, to, contracts, config) {
  const rows = allTrades.filter((row) => row.openedAt >= from && row.openedAt < to)
    .sort((left, right) => left.openedAt - right.openedAt || left.symbolRank - right.symbolRank || right.score - left.score);
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  const selected = []; const open = []; const lastClose = new Map();
  const rejected = { meaningfulSize: 0, accountRisk: 0, margin: 0, duplicate: 0, cooldown: 0, directionConflict: 0 };
  const settle = (trade) => {
    equity += trade.netPnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12));
    lastClose.set(`${trade.symbol}:${trade.branch}`, trade.closedAt);
  };
  for (let index = 0; index < rows.length;) {
    const at = rows[index].openedAt;
    for (const trade of open.filter((row) => row.closedAt <= at).sort((a, b) => a.closedAt - b.closedAt)) {
      open.splice(open.indexOf(trade), 1); settle(trade);
    }
    const group = [];
    while (index < rows.length && rows[index].openedAt === at) group.push(rows[index++]);
    const topScore = Math.max(...group.map((row) => row.score));
    if (new Set(group.filter((row) => row.score >= topScore - 4).map((row) => row.side)).size > 1) {
      rejected.directionConflict += group.length; continue;
    }
    for (const rawTrade of group) {
      const trade = polarityTrade(rawTrade, allTrades);
      if (open.some((row) => row.symbol === trade.symbol)) { rejected.duplicate += 1; continue; }
      if (at - (lastClose.get(`${trade.symbol}:${trade.branch}`) ?? -Infinity) < SAME_BRANCH_COOLDOWN_MS) {
        rejected.cooldown += 1; continue;
      }
      const openRisk = sum(open.map((row) => row.plannedRisk));
      const sameRisk = sum(open.filter((row) => row.side === trade.side).map((row) => row.plannedRisk));
      const confidence = clamp(0.5 + clamp(trade.score / 100, 0.5, 0.98) * 0.35, 0.5, 0.85);
      const desiredRiskRate = 0.01 + confidence * 0.01;
      const desiredLoss = Math.min(equity * desiredRiskRate,
        Math.max(0, equity * PORTFOLIO_RISK_CAP - openRisk),
        Math.max(0, equity * SAME_DIRECTION_RISK_CAP - sameRisk));
      const usedNotional = sum(open.map((row) => row.notional));
      const maxNotional = Math.max(0, equity * MAX_NOTIONAL_MULTIPLE - usedNotional);
      const lossRate = trade.riskRate + (trade.grossReturnRate - trade.netReturnRate);
      const highVolatilityNotionalCap = trade.highVolatility
        ? equity * (config.highVolatilityMaxNotionalMultiple ?? MAX_NOTIONAL_MULTIPLE) : Infinity;
      const globalNotionalCap = config.globalMaxNotionalMultiple == null
        ? Infinity : equity * config.globalMaxNotionalMultiple;
      const rawNotional = Math.min(desiredLoss / Math.max(lossRate, 1e-12), maxNotional,
        highVolatilityNotionalCap, globalNotionalCap);
      const meta = contracts.get(trade.symbol) ?? { multiplier: 1, leverageMax: 20, maintenanceRate: 0.01 };
      const contractNotional = trade.entryPrice * meta.multiplier;
      const contractCount = Math.floor(rawNotional / Math.max(contractNotional, 1e-12));
      const notional = contractCount * contractNotional;
      const minimumNotionalMultiple = config.globalMinimumNotionalMultiple
        ?? (trade.highVolatility
          ? (config.highVolatilityMinimumNotionalMultiple ?? MIN_NOTIONAL_MULTIPLE) : MIN_NOTIONAL_MULTIPLE);
      if (notional + 1e-8 < equity * minimumNotionalMultiple) { rejected.meaningfulSize += 1; continue; }
      const safeMax = Math.max(1, Math.floor(1 / Math.max(meta.maintenanceRate + trade.riskRate * 3 + 0.0018, 1e-6)));
      const targetLeverage = Math.max(1, Math.ceil(notional / Math.max(equity * 0.10, 1e-12)));
      const leverage = Math.min(meta.leverageMax, safeMax, targetLeverage);
      const margin = notional / leverage;
      const plannedRisk = notional * lossRate;
      if (openRisk + plannedRisk > equity * PORTFOLIO_RISK_CAP + 1e-8
        || sameRisk + plannedRisk > equity * SAME_DIRECTION_RISK_CAP + 1e-8) {
        rejected.accountRisk += 1; continue;
      }
      if (sum(open.map((row) => row.margin)) + margin > equity * MARGIN_CAP + 1e-8) {
        rejected.margin += 1; continue;
      }
      const sized = { ...trade, equityAtOpen: equity, contracts: contractCount, notional, leverage, margin,
        plannedRisk, netPnl: notional * trade.netReturnRate };
      selected.push(sized); open.push(sized);
    }
  }
  for (const trade of [...open].sort((left, right) => left.closedAt - right.closedAt)) settle(trade);
  const basic = simpleMetrics(selected);
  const highVolatilityTrades = selected.filter((row) => row.highVolatility);
  const netBySymbol = Object.fromEntries([...new Set(selected.map((row) => row.symbol))].map((symbol) => [symbol,
    sum(selected.filter((row) => row.symbol === symbol).map((row) => row.netPnl))]));
  const positiveTotal = sum(Object.values(netBySymbol).filter((value) => value > 0));
  const largestPositiveSymbolShare = positiveTotal > 0 ? Math.max(0, ...Object.values(netBySymbol)) / positiveTotal : 1;
  return { ...basic, startEquity: 1_000, endEquity: equity, netPnl: equity - 1_000, maxDrawdown,
    highVolatilityTrades: highVolatilityTrades.length,
    averageNotional: selected.length ? sum(selected.map((row) => row.notional)) / selected.length : 0,
    averageMargin: selected.length ? sum(selected.map((row) => row.margin)) / selected.length : 0,
    largestPositiveSymbolShare, netBySymbol, rejected, selected };
}

function compact(result) {
  const summary = { ...result };
  delete summary.selected;
  delete summary.netBySymbol;
  return summary;
}

function evaluate(config, contracts, friction = BASE_FRICTION, slippage = BASE_SLIPPAGE) {
  const trades = generate(config, friction, slippage);
  const discovery = portfolio(trades, fromMs, splitMs, contracts, config);
  const validation = portfolio(trades, splitMs, toMs, contracts, config);
  const full = portfolio(trades, fromMs, toMs, contracts, config);
  const quarter = (toMs - splitMs) / 2;
  const validationEarly = portfolio(trades, splitMs, splitMs + quarter, contracts, config);
  const validationLate = portfolio(trades, splitMs + quarter, toMs, contracts, config);
  return { config, signalTrades: trades.length, discovery, validation, full, validationEarly, validationLate };
}

const contracts = await contractMetadata();
const baselineConfig = { id: "baseline", threshold: 0, thresholdId: "none", extraPad: 0,
  targetMode: "fixed", highVolatilityMinimumNotionalMultiple: 1,
  highVolatilityMaxNotionalMultiple: MAX_NOTIONAL_MULTIPLE };
const candidates = [baselineConfig];
if (RESEARCH_MODE === "high-volatility") {
  for (const [thresholdId, threshold] of Object.entries(volatilityThresholds)) for (const extraPad of [0, 0.25, 0.5]) {
    const targetModes = extraPad === 0 ? ["fixed"] : ["fixed", "sameR"];
    for (const targetMode of targetModes) for (const maximum of [0.5, 0.75, 1]) candidates.push({
      id: `${thresholdId}-pad${extraPad}-${targetMode}-cap${maximum}`, thresholdId, threshold, extraPad, targetMode,
      highVolatilityMinimumNotionalMultiple: maximum === 0.5 ? 0.45 : 0.5,
      highVolatilityMaxNotionalMultiple: maximum,
    });
  }
} else if (RESEARCH_MODE === "global-cap") {
  for (const maximum of [0.5, 0.75, 1, 1.25, 1.5, 2]) candidates.push({
    id: `global-cap${maximum}`, threshold: 0, thresholdId: "none", extraPad: 0, targetMode: "fixed",
    highVolatilityMinimumNotionalMultiple: 1,
    highVolatilityMaxNotionalMultiple: MAX_NOTIONAL_MULTIPLE,
    globalMinimumNotionalMultiple: Math.min(0.45, maximum * 0.9),
    globalMaxNotionalMultiple: maximum,
  });
} else {
  throw new Error(`Unknown RESEARCH_MODE: ${RESEARCH_MODE}`);
}

const results = candidates.map((config) => evaluate(config, contracts));
const baseline = results[0];
const discoveryEligible = results.slice(1).filter((row) => row.discovery.netPnl > baseline.discovery.netPnl
  && row.discovery.profitFactor > 1 && row.discovery.maxDrawdown <= baseline.discovery.maxDrawdown * 1.10
  && row.discovery.largestPositiveSymbolShare <= 0.45);
const selected = discoveryEligible.sort((left, right) => right.discovery.netPnl - left.discovery.netPnl
  || right.discovery.profitFactor - left.discovery.profitFactor)[0] ?? null;
const stressBaseline = evaluate(baselineConfig, contracts, STRESS_FRICTION, STRESS_SLIPPAGE);
const stressSelected = selected ? evaluate(selected.config, contracts, STRESS_FRICTION, STRESS_SLIPPAGE) : null;
const accepted = Boolean(selected
  && selected.validation.netPnl > baseline.validation.netPnl
  && selected.validation.profitFactor >= baseline.validation.profitFactor
  && selected.validation.maxDrawdown <= baseline.validation.maxDrawdown * 1.10
  && selected.validationEarly.netPnl > 0 && selected.validationLate.netPnl > 0
  && selected.validation.largestPositiveSymbolShare <= 0.45
  && stressSelected.validation.netPnl > 0
  && stressSelected.validation.netPnl >= stressBaseline.validation.netPnl);

console.table(results.map((row) => ({
  candidate: row.config.id,
  trainPnl: row.discovery.netPnl.toFixed(2),
  trainPF: row.discovery.profitFactor.toFixed(2),
  heldoutPnl: row.validation.netPnl.toFixed(2),
  heldoutPF: row.validation.profitFactor.toFixed(2),
  heldoutDD: `${(row.validation.maxDrawdown * 100).toFixed(2)}%`,
  monthPnl: row.full.netPnl.toFixed(2),
  trades: row.full.trades,
  highVol: row.full.highVolatilityTrades,
  avgNotional: row.full.averageNotional.toFixed(0),
  avgMargin: row.full.averageMargin.toFixed(0),
})));
const report = {
  generatedAt: new Date().toISOString(), researchMode: RESEARCH_MODE,
  dataset: { days: raw.days, now: raw.now, symbols },
  constants: { baseFriction: BASE_FRICTION, baseSlippage: BASE_SLIPPAGE,
    stressFriction: STRESS_FRICTION, stressSlippage: STRESS_SLIPPAGE,
    volatilityThresholds, rejectionRulesChanged: false },
  baseline: { config: baseline.config, discovery: compact(baseline.discovery), validation: compact(baseline.validation),
    full: compact(baseline.full), validationEarly: compact(baseline.validationEarly), validationLate: compact(baseline.validationLate),
    stressValidation: compact(stressBaseline.validation) },
  candidateSummaries: results.slice(1).map((row) => ({ config: row.config,
    discovery: compact(row.discovery), validation: compact(row.validation), full: compact(row.full),
    validationEarly: compact(row.validationEarly), validationLate: compact(row.validationLate) })),
  selected: selected ? { config: selected.config, discovery: compact(selected.discovery), validation: compact(selected.validation),
    full: compact(selected.full), validationEarly: compact(selected.validationEarly), validationLate: compact(selected.validationLate),
    stressValidation: compact(stressSelected.validation) } : null,
  accepted,
  decision: !selected ? `No ${RESEARCH_MODE} candidate improved discovery profit within the drawdown/concentration gates.`
    : accepted ? "The discovery-selected candidate improved untouched held-out and stress results; it may proceed to implementation review."
      : "The discovery-selected candidate failed at least one untouched held-out, segment, drawdown, concentration, or stress gate; retain V4.",
};
if (OUTPUT) writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`V4_VOLATILITY_RESEARCH_JSON=${JSON.stringify(report)}`);
if (!accepted) process.exitCode = 2;
