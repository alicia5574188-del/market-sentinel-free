import { readFileSync, writeFileSync } from "node:fs";
import { allRegimePaperApproved, detectAllRegimeRoutes } from "../lib/all-regime-engine.ts";
import { classifyMarketState, deriveMarketStateFeatures } from "../lib/strategy-coverage.ts";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-44m-5m.json";
const OUTPUT = process.env.RESIDUAL_OUTPUT ?? "/tmp/residual-microcells.json";
const STEP = 300;
const DECISION_STEP = 900;
const FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const ENTRY_SLIPPAGE = 0.00025;
const ADVERSE_ENTRY_SLIPPAGE = 0.0005;
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m" || raw.months.length < 44) throw new Error("Residual research requires 44 months of 5m Gate archives");

const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const monthKey = (timeMs) => new Date(timeMs).toISOString().slice(0, 7).replace("-", "");
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const fromMs = monthStart(raw.months[0]);
const toMs = monthStart(raw.months.at(-1).slice(0, 4) + String(Number(raw.months.at(-1).slice(4)) + 1).padStart(2, "0"));
// Robust next-month boundary even for December.
const lastYear = Number(raw.months.at(-1).slice(0, 4));
const lastMonth = Number(raw.months.at(-1).slice(4));
const endMs = Date.UTC(lastYear, lastMonth, 1);
const foldEnds = [monthStart(raw.months[10]), monthStart(raw.months[20]), discoveryEnd];
const foldStarts = [fromMs, foldEnds[0], foldEnds[1]];

const datasets = raw.datasets.filter(({ symbol }) => raw.symbols.includes(symbol));
if (datasets.length < 11) throw new Error(`Expected 11 stable contracts, got ${datasets.length}`);

// Cross-market context is built only on 15-minute decision boundaries; no future bars are used.
const contexts = new Map();
for (const { symbol, rows } of datasets) {
  for (let index = 288; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.time % DECISION_STEP !== 0) continue;
    if (rows[index - 6].time !== row.time - 6 * STEP || rows[index - 48].time !== row.time - 48 * STEP
      || rows[index - 288].time !== row.time - 288 * STEP) continue;
    const value = contexts.get(row.time) ?? { move30m: [], move4h: [], move24h: [], btcMove24h: null };
    value.move30m.push(row.close / rows[index - 6].close - 1);
    value.move4h.push(row.close / rows[index - 48].close - 1);
    const move24h = row.close / rows[index - 288].close - 1;
    value.move24h.push(move24h);
    if (symbol === "BTC_USDT") value.btcMove24h = move24h;
    contexts.set(row.time, value);
  }
}
for (const [time, value] of contexts) {
  contexts.set(time, {
    breadth: value.move30m.filter((move) => move > 0).length / value.move30m.length,
    medianMove: median(value.move30m), markets: value.move30m.length,
    marketBreadth4h: value.move4h.filter((move) => move > 0).length / value.move4h.length,
    marketMedianMove4h: median(value.move4h),
    marketBreadth24h: value.move24h.filter((move) => move > 0).length / value.move24h.length,
    marketMedianMove24h: median(value.move24h), btcMove24h: value.btcMove24h ?? 0,
    regimeMarkets: Math.min(value.move4h.length, value.move24h.length),
  });
}

function resolveTrade(symbol, rows, signalIndex, route, costRate = FRICTION, slippage = ENTRY_SLIPPAGE) {
  if (signalIndex + 1 >= rows.length) return null;
  const sideSign = route.side === "LONG" ? 1 : -1;
  const entry = rows[signalIndex + 1].open * (1 + sideSign * slippage);
  const riskRate = Math.abs(route.triggerPrice - route.invalidationPrice) / route.triggerPrice;
  const targetRate = Math.abs(route.profitArmPrice - route.triggerPrice) / route.triggerPrice;
  const stop = entry * (1 - sideSign * riskRate);
  const target = entry * (1 + sideSign * targetRate);
  const maxBars = Math.ceil(route.maxHoldMinutes / 5);
  const noProgressBars = Math.ceil(route.noProgressMinutes / 5);
  let bestFavorableRate = 0;
  for (let offset = 1; offset <= maxBars && signalIndex + offset < rows.length; offset += 1) {
    const row = rows[signalIndex + offset];
    const favorableRate = route.side === "LONG" ? (row.high - entry) / entry : (entry - row.low) / entry;
    bestFavorableRate = Math.max(bestFavorableRate, favorableRate);
    const stopped = route.side === "LONG" ? row.low <= stop : row.high >= stop;
    const targeted = route.side === "LONG" ? row.high >= target : row.low <= target;
    let exit = null; let outcome = null;
    if (stopped) { exit = stop; outcome = "STOP"; }
    else if (targeted) { exit = target; outcome = "TARGET"; }
    else {
      const closeMove = sideSign * (row.close - entry) / entry;
      const noProgress = offset >= noProgressBars && bestFavorableRate < riskRate * 0.35 && closeMove < riskRate * 0.15;
      if (noProgress) { exit = row.close; outcome = "THESIS_INVALID"; }
      else if (offset === maxBars) { exit = row.close; outcome = "EDGE_DECAY"; }
    }
    if (exit != null) {
      const grossReturnRate = sideSign * (exit - entry) / entry;
      return { symbol, strategyId: route.strategyId, strategyName: route.strategyName, environment: route.environment,
        side: route.side, score: route.score, openedAt: rows[signalIndex + 1].time * 1000,
        closedAt: row.time * 1000, riskRate, targetRate, grossReturnRate,
        netReturnRate: grossReturnRate - costRate, outcome };
    }
  }
  return null;
}

function rawMetrics(trades, value = (trade) => trade.netReturnRate, start = -Infinity, end = Infinity) {
  const rows = trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end);
  const returns = rows.map(value); const gains = sum(returns.filter((v) => v > 0));
  const losses = Math.abs(sum(returns.filter((v) => v <= 0))); const monthly = new Map(); const bySymbol = new Map();
  let equity = 1; let peak = 1; let maxDrawdown = 0;
  for (const trade of [...rows].sort((a, b) => a.openedAt - b.openedAt)) {
    const result = value(trade); equity += result; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
    monthly.set(monthKey(trade.openedAt), (monthly.get(monthKey(trade.openedAt)) ?? 0) + result);
    bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + result);
  }
  const positiveSymbolPnl = [...bySymbol.values()].filter((v) => v > 0); const positiveTotal = sum(positiveSymbolPnl);
  return { trades: rows.length, wins: returns.filter((v) => v > 0).length,
    winRate: rows.length ? returns.filter((v) => v > 0).length / rows.length : 0,
    net: sum(returns), profitFactor: losses ? gains / losses : gains ? 99 : 0, maxDrawdown,
    symbols: new Set(rows.map((row) => row.symbol)).size, activeMonths: monthly.size,
    positiveMonths: [...monthly.values()].filter((v) => v > 0).length,
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positiveSymbolPnl) / positiveTotal : 1,
    monthly: Object.fromEntries([...monthly].sort()) };
}

const candidates = [];
for (const { symbol, rows } of datasets) {
  const gapPrefix = [0];
  for (let index = 1; index < rows.length; index += 1) gapPrefix.push(gapPrefix.at(-1) + Number(rows[index].time !== rows[index - 1].time + STEP));
  const busyUntil = new Map();
  for (let index = 359; index < rows.length - 1; index += 1) {
    if (rows[index].time % DECISION_STEP !== 0) continue;
    if (gapPrefix[index] !== gapPrefix[index - 359] || rows[index + 1].time !== rows[index].time + STEP) continue;
    const context = contexts.get(rows[index].time);
    if (!context || context.markets < 8 || context.regimeMarkets < 8) continue;
    const state = deriveMarketStateFeatures(rows.slice(index - 119, index + 1), context.breadth, context.medianMove);
    if (!state) continue;
    const cell = classifyMarketState(state);
    for (const route of detectAllRegimeRoutes(rows.slice(index - 359, index + 1), symbol)) {
      if (!allRegimePaperApproved(route.strategyId) || (busyUntil.get(route.strategyId) ?? 0) >= rows[index + 1].time) continue;
      const nextOpen = rows[index + 1].open;
      const entryExtension = Math.abs(nextOpen - route.triggerPrice) / route.triggerPrice;
      const stopRate = Math.abs(nextOpen - route.invalidationPrice) / nextOpen;
      const rewardRate = Math.abs(route.profitArmPrice - nextOpen) / nextOpen;
      const netRewardRisk = (rewardRate - FRICTION) / Math.max(stopRate + FRICTION, 1e-9);
      if (entryExtension > Math.max(stopRate * 0.65, 0.0008) || stopRate < FRICTION
        || FRICTION / Math.max(rewardRate, 1e-9) > 0.25 || netRewardRisk < 1.2) continue;
      const base = resolveTrade(symbol, rows, index, route, FRICTION, ENTRY_SLIPPAGE);
      const stress = resolveTrade(symbol, rows, index, route, STRESS_FRICTION, ENTRY_SLIPPAGE);
      const adverse = resolveTrade(symbol, rows, index, route, FRICTION, ADVERSE_ENTRY_SLIPPAGE);
      if (!base || !stress || !adverse) continue;
      candidates.push({ ...base, stressedNetReturnRate: stress.netReturnRate, adverseNetReturnRate: adverse.netReturnRate,
        cellKey: `${route.strategyId}:${cell.key}`, phase: cell.phase, crowding: cell.crowding, location: cell.location,
        context: { ...context } });
      busyUntil.set(route.strategyId, base.closedAt / 1000);
    }
  }
  console.log(`RESIDUAL_RAW ${symbol} ${candidates.filter((trade) => trade.symbol === symbol).length}`);
}
candidates.sort((a, b) => a.openedAt - b.openedAt || b.score - a.score);

const byCell = new Map();
for (const trade of candidates) {
  const rows = byCell.get(trade.cellKey) ?? [];
  rows.push(trade); byCell.set(trade.cellKey, rows);
}
const byStrategyPhase = new Map();
for (const trade of candidates) {
  const key = `${trade.strategyId}:${trade.phase}`; const rows = byStrategyPhase.get(key) ?? [];
  rows.push(trade); byStrategyPhase.set(key, rows);
}
const valueFns = {
  base: (trade) => trade.netReturnRate,
  stress: (trade) => trade.stressedNetReturnRate,
  adverse: (trade) => trade.adverseNetReturnRate,
};
function foldMetrics(rows, value) {
  return foldStarts.map((start, index) => rawMetrics(rows, value, start, foldEnds[index]));
}
function compact(metric) {
  return { trades: metric.trades, winRate: metric.winRate, net: metric.net, profitFactor: metric.profitFactor,
    maxDrawdown: metric.maxDrawdown, symbols: metric.symbols, activeMonths: metric.activeMonths,
    positiveMonths: metric.positiveMonths, largestPositiveSymbolShare: metric.largestPositiveSymbolShare };
}

const cellAudit = [];
for (const [cellKey, rows] of byCell) {
  const discovery = rawMetrics(rows, valueFns.base, fromMs, discoveryEnd);
  const stressDiscovery = rawMetrics(rows, valueFns.stress, fromMs, discoveryEnd);
  const adverseDiscovery = rawMetrics(rows, valueFns.adverse, fromMs, discoveryEnd);
  const folds = foldMetrics(rows, valueFns.base); const stressFolds = foldMetrics(rows, valueFns.stress);
  const adverseFolds = foldMetrics(rows, valueFns.adverse);
  const broadKey = `${rows[0].strategyId}:${rows[0].phase}`;
  const broadRows = byStrategyPhase.get(broadKey) ?? [];
  const broadDiscovery = rawMetrics(broadRows, valueFns.base, fromMs, discoveryEnd);
  const positiveFoldCount = (metrics) => metrics.filter((m) => m.net > 0 && m.profitFactor > 1).length;
  const qualified = discovery.trades >= 30 && discovery.net > 0 && discovery.profitFactor >= 1.12
    && stressDiscovery.net > 0 && stressDiscovery.profitFactor >= 1.05
    && adverseDiscovery.net > 0 && adverseDiscovery.profitFactor >= 1.05
    && discovery.activeMonths >= 10 && discovery.positiveMonths >= Math.ceil(discovery.activeMonths * 0.52)
    && discovery.symbols >= 4 && discovery.largestPositiveSymbolShare <= 0.55
    && folds.every((m) => m.trades >= 5) && positiveFoldCount(folds) >= 2 && folds.at(-1).net > 0
    && positiveFoldCount(stressFolds) >= 2 && stressFolds.at(-1).net > 0
    && positiveFoldCount(adverseFolds) >= 2 && adverseFolds.at(-1).net > 0
    && broadDiscovery.net > 0 && broadDiscovery.profitFactor >= 1.02;
  cellAudit.push({ cellKey, strategyId: rows[0].strategyId, phase: rows[0].phase, crowding: rows[0].crowding,
    location: rows[0].location, qualified,
    discovery: compact(discovery), stressDiscovery: compact(stressDiscovery), adverseDiscovery: compact(adverseDiscovery),
    folds: folds.map(compact), stressFolds: stressFolds.map(compact), adverseFolds: adverseFolds.map(compact),
    validation: compact(rawMetrics(rows, valueFns.base, discoveryEnd, validationEnd)),
    evaluation: compact(rawMetrics(rows, valueFns.base, validationEnd, endMs)),
    stressValidation: compact(rawMetrics(rows, valueFns.stress, discoveryEnd, validationEnd)),
    stressEvaluation: compact(rawMetrics(rows, valueFns.stress, validationEnd, endMs)),
    adverseValidation: compact(rawMetrics(rows, valueFns.adverse, discoveryEnd, validationEnd)),
    adverseEvaluation: compact(rawMetrics(rows, valueFns.adverse, validationEnd, endMs)),
  });
}

const qualifiedCells = cellAudit.filter((row) => row.qualified)
  .sort((a, b) => (b.discovery.net + b.stressDiscovery.net + b.adverseDiscovery.net)
    - (a.discovery.net + a.stressDiscovery.net + a.adverseDiscovery.net));

function simulatePortfolio(cellKeys, valueKey = "netReturnRate", start = fromMs, end = endMs) {
  const allowed = new Set(cellKeys);
  const rows = candidates.filter((trade) => allowed.has(trade.cellKey) && trade.openedAt >= start && trade.openedAt < end)
    .sort((a, b) => a.openedAt - b.openedAt || b.score - a.score);
  let equity = 1000; let peak = equity; let maxDrawdown = 0; const open = []; const selected = [];
  const settle = (time) => {
    for (const trade of open.filter((row) => row.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
      open.splice(open.indexOf(trade), 1);
    }
  };
  for (const trade of rows) {
    settle(trade.openedAt);
    if (open.some((row) => row.symbol === trade.symbol)) continue;
    if (open.length >= 4 || open.filter((row) => row.side === trade.side).length >= 3) continue;
    const notionalMultiple = Math.min(0.60, 0.015 / Math.max(trade.riskRate + FRICTION, 0.005));
    const notional = equity * notionalMultiple; const plannedRisk = notional * (trade.riskRate + FRICTION);
    const totalRisk = sum(open.map((row) => row.plannedRisk));
    const sameSideRisk = sum(open.filter((row) => row.side === trade.side).map((row) => row.plannedRisk));
    if (totalRisk + plannedRisk > equity * 0.10 || sameSideRisk + plannedRisk > equity * 0.07) continue;
    const netPnl = notional * trade[valueKey]; const accepted = { ...trade, plannedRisk, notional, netPnl };
    open.push(accepted); selected.push(accepted);
  }
  settle(Infinity);
  const gains = sum(selected.filter((t) => t.netPnl > 0).map((t) => t.netPnl));
  const losses = Math.abs(sum(selected.filter((t) => t.netPnl <= 0).map((t) => t.netPnl)));
  const monthly = new Map();
  for (const trade of selected) monthly.set(monthKey(trade.openedAt), (monthly.get(monthKey(trade.openedAt)) ?? 0) + trade.netPnl);
  return { trades: selected.length, wins: selected.filter((t) => t.netPnl > 0).length,
    winRate: selected.length ? selected.filter((t) => t.netPnl > 0).length / selected.length : 0,
    netPnl: equity - 1000, endEquity: equity, profitFactor: losses ? gains / losses : gains ? 99 : 0,
    maxDrawdown, activeMonths: monthly.size, positiveMonths: [...monthly.values()].filter((v) => v > 0).length,
    monthly: Object.fromEntries([...monthly].sort()), selected };
}

// Discovery-only greedy assembly: later periods never participate in choosing cells.
const chosen = [];
let current = simulatePortfolio(chosen, "netReturnRate", fromMs, discoveryEnd);
for (const cell of qualifiedCells) {
  if (chosen.length >= 12) break;
  const testKeys = [...chosen, cell.cellKey];
  const base = simulatePortfolio(testKeys, "netReturnRate", fromMs, discoveryEnd);
  const stress = simulatePortfolio(testKeys, "stressedNetReturnRate", fromMs, discoveryEnd);
  const adverse = simulatePortfolio(testKeys, "adverseNetReturnRate", fromMs, discoveryEnd);
  const tradeGain = base.trades - current.trades;
  if (tradeGain < 8 || base.netPnl <= current.netPnl || base.profitFactor < 1.10
    || stress.netPnl <= 0 || stress.profitFactor < 1.04 || adverse.netPnl <= 0 || adverse.profitFactor < 1.04
    || Math.max(base.maxDrawdown, stress.maxDrawdown, adverse.maxDrawdown) > 0.14) continue;
  chosen.push(cell.cellKey); current = base;
}

const periods = {
  discovery: [fromMs, discoveryEnd], validation: [discoveryEnd, validationEnd], evaluation: [validationEnd, endMs], full: [fromMs, endMs],
};
const portfolios = {};
for (const [name, [start, end]] of Object.entries(periods)) {
  portfolios[name] = {
    base: simulatePortfolio(chosen, "netReturnRate", start, end),
    stress: simulatePortfolio(chosen, "stressedNetReturnRate", start, end),
    adverse: simulatePortfolio(chosen, "adverseNetReturnRate", start, end),
  };
}
const evalDays = (endMs - validationEnd) / 86_400_000;
const residualEvalPerDay = portfolios.evaluation.base.trades / evalDays;
const gates = {
  atLeastTwoIndependentCells: chosen.length >= 2,
  validationSample: portfolios.validation.base.trades >= 30,
  validationEdge: portfolios.validation.base.netPnl > 0 && portfolios.validation.base.profitFactor >= 1.10,
  validationStress: portfolios.validation.stress.netPnl > 0 && portfolios.validation.stress.profitFactor >= 1.05,
  validationAdverse: portfolios.validation.adverse.netPnl > 0 && portfolios.validation.adverse.profitFactor >= 1.05,
  evaluationSample: portfolios.evaluation.base.trades >= 40,
  evaluationEdge: portfolios.evaluation.base.netPnl > 0 && portfolios.evaluation.base.profitFactor >= 1.10,
  evaluationStress: portfolios.evaluation.stress.netPnl > 0 && portfolios.evaluation.stress.profitFactor >= 1.05,
  evaluationAdverse: portfolios.evaluation.adverse.netPnl > 0 && portfolios.evaluation.adverse.profitFactor >= 1.05,
  fullDrawdown: portfolios.full.base.maxDrawdown <= 0.12 && portfolios.full.stress.maxDrawdown <= 0.14,
  evaluationMonthBreadth: portfolios.evaluation.base.positiveMonths >= Math.max(3, Math.ceil(portfolios.evaluation.base.activeMonths * 0.50)),
};
const report = {
  generatedAt: new Date().toISOString(), decisionCadence: "15m using native 5m bars", datasetSha256: raw.sha256,
  split: { discovery: raw.months.slice(0, 30), validation: raw.months.slice(30, 38), evaluation: raw.months.slice(38) },
  selectionIntegrity: "Cell qualification and greedy portfolio assembly use discovery only; validation/evaluation never affect selection.",
  rawCandidates: candidates.length, qualifiedCellCount: qualifiedCells.length, chosenCells: chosen,
  qualifiedCells, portfolios: Object.fromEntries(Object.entries(portfolios).map(([name, variants]) => [name,
    Object.fromEntries(Object.entries(variants).map(([variant, result]) => [variant, { ...result, selected: undefined }]))])),
  residualEvaluationTradesPerDay: residualEvalPerDay,
  combinedLogicalEvaluationTradesPerDayWithCurrentBaseline: 155 / evalDays + residualEvalPerDay,
  gates, replacementLayerCandidate: Object.values(gates).every(Boolean),
};
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log("RESIDUAL_RESULT=" + JSON.stringify({ rawCandidates: report.rawCandidates, qualifiedCellCount: report.qualifiedCellCount,
  chosenCells: report.chosenCells, validation: report.portfolios.validation, evaluation: report.portfolios.evaluation,
  residualEvaluationTradesPerDay: report.residualEvaluationTradesPerDay,
  combinedLogicalEvaluationTradesPerDayWithCurrentBaseline: report.combinedLogicalEvaluationTradesPerDayWithCurrentBaseline,
  gates: report.gates, replacementLayerCandidate: report.replacementLayerCandidate }));
