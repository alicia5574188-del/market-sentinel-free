import { readFileSync, writeFileSync } from "node:fs";
import { allRegimePaperApproved, detectAllRegimeRoutes } from "../lib/all-regime-engine.ts";
import { classifyMarketState, deriveMarketStateFeatures } from "../lib/strategy-coverage.ts";
import { routeMarketApproved } from "../lib/strategy-coverage-policy.ts";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-12m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/phase-specialist-v5-audit.json";
const STEP = 300;
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m" || raw.months.length < 12) throw new Error("V5 phase audit requires at least twelve months of 5m archives");

const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const monthBounds = (month) => {
  const year = Number(month.slice(0, 4)); const zeroMonth = Number(month.slice(4, 6)) - 1;
  return [Date.UTC(year, zeroMonth, 1), Date.UTC(year, zeroMonth + 1, 1)];
};
const monthKey = (time) => new Date(time).toISOString().slice(0, 7).replace("-", "");
const splitAt = {
  validation: monthBounds(raw.months[6])[0],
  evaluation: monthBounds(raw.months[9])[0],
  end: monthBounds(raw.months.at(-1))[1],
};
const segment = (time) => time < splitAt.validation ? "discovery" : time < splitAt.evaluation ? "validation" : "evaluation";

const datasets = raw.datasets.filter(({ symbol }) => raw.symbols.includes(symbol));
if (datasets.length < 12) throw new Error(`V5 production policy requires twelve markets; received ${datasets.length}`);
const contexts = new Map();
for (const { symbol, rows } of datasets) {
  for (let index = 288; index < rows.length; index += 1) {
    const row = rows[index];
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

function resolveTrade(symbol, rows, signalIndex, route, costRate = FRICTION) {
  if (signalIndex + 1 >= rows.length) return null;
  const sign = route.side === "LONG" ? 1 : -1;
  const entry = rows[signalIndex + 1].open * (1 + sign * ENTRY_SLIPPAGE);
  const riskRate = Math.abs(route.triggerPrice - route.invalidationPrice) / route.triggerPrice;
  const targetRate = Math.abs(route.profitArmPrice - route.triggerPrice) / route.triggerPrice;
  const stop = entry * (1 - sign * riskRate); const target = entry * (1 + sign * targetRate);
  const maxBars = Math.ceil(route.maxHoldMinutes / 5); const noProgressBars = Math.ceil(route.noProgressMinutes / 5);
  let bestFavorableRate = 0;
  for (let offset = 1; offset <= maxBars && signalIndex + offset < rows.length; offset += 1) {
    const row = rows[signalIndex + offset];
    const favorableRate = route.side === "LONG" ? (row.high - entry) / entry : (entry - row.low) / entry;
    bestFavorableRate = Math.max(bestFavorableRate, favorableRate);
    const stopped = route.side === "LONG" ? row.low <= stop : row.high >= stop;
    const targeted = route.side === "LONG" ? row.high >= target : row.low <= target;
    let exit; let outcome;
    // This is the live arena's conservative same-candle rule: protection wins.
    if (stopped) { exit = stop; outcome = "STOP"; }
    else if (targeted) { exit = target; outcome = "TARGET"; }
    else {
      const closeMove = sign * (row.close - entry) / entry;
      const noProgress = offset >= noProgressBars && bestFavorableRate < riskRate * 0.35 && closeMove < riskRate * 0.15;
      if (noProgress) { exit = row.close; outcome = "THESIS_INVALID"; }
      else if (offset === maxBars) { exit = row.close; outcome = "EDGE_DECAY"; }
    }
    if (exit != null) {
      const grossReturnRate = sign * (exit - entry) / entry;
      return { symbol, strategyId: route.strategyId, strategyName: route.strategyName, environment: route.environment,
        side: route.side, score: route.score, openedAt: rows[signalIndex + 1].time * 1_000,
        closedAt: row.time * 1_000, riskRate, targetRate, grossReturnRate,
        netReturnRate: grossReturnRate - costRate, outcome };
    }
  }
  return null;
}

function metrics(trades, value = (trade) => trade.netReturnRate) {
  const returns = trades.map(value); const gains = sum(returns.filter((row) => row > 0));
  const losses = Math.abs(sum(returns.filter((row) => row <= 0))); const months = new Map();
  for (const trade of trades) months.set(monthKey(trade.openedAt), (months.get(monthKey(trade.openedAt)) ?? 0) + value(trade));
  return { trades: trades.length, wins: returns.filter((row) => row > 0).length,
    winRate: trades.length ? returns.filter((row) => row > 0).length / trades.length : 0,
    netReturnRate: sum(returns), meanReturnRate: trades.length ? sum(returns) / trades.length : 0,
    profitFactor: losses ? gains / losses : gains ? 99 : 0, symbols: new Set(trades.map((row) => row.symbol)).size,
    activeMonths: months.size, positiveMonths: [...months.values()].filter((row) => row > 0).length,
    monthlyReturns: Object.fromEntries([...months].sort()) };
}

const candidates = [];
for (const { symbol, rows } of datasets) {
  const gapPrefix = [0];
  for (let index = 1; index < rows.length; index += 1) gapPrefix.push(gapPrefix.at(-1) + Number(rows[index].time !== rows[index - 1].time + STEP));
  const busyUntil = new Map();
  for (let index = 359; index < rows.length - 1; index += 1) {
    if (gapPrefix[index] !== gapPrefix[index - 359] || rows[index + 1].time !== rows[index].time + STEP) continue;
    const context = contexts.get(rows[index].time);
    if (!context || context.markets < 12 || context.regimeMarkets < 12) continue;
    const state = deriveMarketStateFeatures(rows.slice(index - 119, index + 1), context.breadth, context.medianMove);
    if (!state) continue;
    for (const route of detectAllRegimeRoutes(rows.slice(index - 359, index + 1), symbol)) {
      if (!allRegimePaperApproved(route.strategyId) || (busyUntil.get(route.strategyId) ?? 0) >= rows[index + 1].time) continue;
      if (!routeMarketApproved(route, { ...state, ...context })) continue;
      const nextOpen = rows[index + 1].open;
      const entryExtension = Math.abs(nextOpen - route.triggerPrice) / route.triggerPrice;
      const stopRate = Math.abs(nextOpen - route.invalidationPrice) / nextOpen;
      const rewardRate = Math.abs(route.profitArmPrice - nextOpen) / nextOpen;
      const netRewardRisk = (rewardRate - FRICTION) / Math.max(stopRate + FRICTION, 1e-9);
      if (entryExtension > Math.max(stopRate * 0.65, 0.0008) || stopRate < FRICTION
        || FRICTION / Math.max(rewardRate, 1e-9) > 0.25 || netRewardRisk < 1.2) continue;
      const trade = resolveTrade(symbol, rows, index, route);
      const stressed = resolveTrade(symbol, rows, index, route, 0.0020);
      if (!trade || !stressed) continue;
      const cell = classifyMarketState(state);
      candidates.push({ ...trade, stressedNetReturnRate: stressed.netReturnRate, state, cell,
        context: { ...context }, sourceDirection: route.sourceDirection, localMoveRate: route.localMoveRate });
      busyUntil.set(route.strategyId, trade.closedAt / 1_000);
    }
  }
  console.log(`audited ${symbol}: ${candidates.filter((trade) => trade.symbol === symbol).length} approved V5 routes`);
}
candidates.sort((left, right) => left.openedAt - right.openedAt || right.score - left.score);

function segmented(rows) {
  return Object.fromEntries(["discovery", "validation", "evaluation"].map((name) => [name,
    metrics(rows.filter((row) => segment(row.openedAt) === name))]));
}
const dimensions = new Map();
for (const trade of candidates) {
  for (const [kind, key] of [["strategy", trade.strategyId], ["phase", trade.cell.phase],
    ["strategyPhase", `${trade.strategyId}:${trade.cell.phase}`], ["cell", `${trade.strategyId}:${trade.cell.key}`]]) {
    const id = `${kind}|${key}`; const row = dimensions.get(id) ?? { kind, key, trades: [] }; row.trades.push(trade); dimensions.set(id, row);
  }
}
const dimensionResults = [...dimensions.values()].map((row) => ({ kind: row.kind, key: row.key,
  full: metrics(row.trades), stress: metrics(row.trades, (trade) => trade.stressedNetReturnRate), segments: segmented(row.trades) }));

// A phase is owned only when its exact strategy/phase pair is positive in all chronological segments,
// survives higher costs, spans at least three symbols and is not supported by only one positive month.
const acceptedStrategyPhases = dimensionResults.filter((row) => row.kind === "strategyPhase").filter((row) => {
  const { discovery, validation, evaluation } = row.segments;
  return discovery.trades >= 12 && validation.trades >= 6 && evaluation.trades >= 6
    && [discovery, validation, evaluation].every((value) => value.netReturnRate > 0 && value.profitFactor >= 1.05)
    && row.full.symbols >= 3 && row.full.positiveMonths >= 3 && row.stress.netReturnRate > 0 && row.stress.profitFactor >= 1.05;
});
const acceptedKeys = new Set(acceptedStrategyPhases.map((row) => row.key));

function portfolio(rows) {
  let equity = 1_000; let peak = equity; let maxDrawdown = 0; const open = []; const selected = [];
  const settle = (time) => {
    for (const trade of open.filter((row) => row.closedAt <= time).sort((left, right) => left.closedAt - right.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
      open.splice(open.indexOf(trade), 1);
    }
  };
  for (const trade of rows.sort((left, right) => left.openedAt - right.openedAt || right.score - left.score)) {
    settle(trade.openedAt);
    if (open.some((row) => row.symbol === trade.symbol)) continue;
    const multiple = Math.min(0.5, 0.02 / Math.max(trade.riskRate + FRICTION, 0.005));
    const notional = equity * multiple; const plannedRisk = notional * (trade.riskRate + FRICTION);
    const sameSideRisk = sum(open.filter((row) => row.side === trade.side).map((row) => row.plannedRisk));
    if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10 || sameSideRisk + plannedRisk > equity * 0.065) continue;
    const accepted = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
    open.push(accepted); selected.push(accepted);
  }
  settle(Infinity);
  const measured = metrics(selected, (trade) => trade.netPnl);
  return { trades: selected.length, wins: measured.wins, winRate: measured.winRate,
    profitFactor: measured.profitFactor, symbols: measured.symbols, activeMonths: measured.activeMonths,
    positiveMonths: measured.positiveMonths, monthlyPnlU: measured.monthlyReturns,
    startEquity: 1_000, endEquity: equity, netPnlU: equity - 1_000, maxDrawdown, selected };
}

const unrestrictedPortfolio = portfolio([...candidates]);
const fixedPortfolio = portfolio(candidates.filter((trade) => acceptedKeys.has(`${trade.strategyId}:${trade.cell.phase}`)));
const monthlyPhaseOpportunity = Object.fromEntries(raw.months.map((month) => [month,
  Object.fromEntries(["COMPRESSION", "EXPANSION", "ORDERLY_TREND", "BALANCED_ROTATION", "TRANSITION"].map((phase) => [phase,
    candidates.filter((trade) => monthKey(trade.openedAt) === month && trade.cell.phase === phase).length]))]));
const report = { generatedAt: new Date().toISOString(), status: acceptedStrategyPhases.length ? "V5_PHASES_PROVISIONALLY_FIXED" : "V5_NOT_STABLE_ENOUGH_TO_FIX",
  source: raw.source, datasetSha256: raw.sha256, period: `${raw.months[0]}-${raw.months.at(-1)}`,
  split: { discovery: raw.months.slice(0, 6), validation: raw.months.slice(6, 9), evaluation: raw.months.slice(9) },
  model: { signal: "current production V5 exact route and market policy", execution: "next 5m open plus adverse entry",
    exit: "current production hard target; stop wins same-candle ambiguity", frictionRate: FRICTION,
    stressFrictionRate: 0.002, ledger: "independent hypothetical 1000U" },
  candidates: candidates.length, acceptedStrategyPhases: acceptedStrategyPhases.map(({ key, full, stress, segments }) => ({ key, full, stress, segments })),
  byStrategy: dimensionResults.filter((row) => row.kind === "strategy"),
  byPhase: dimensionResults.filter((row) => row.kind === "phase"),
  byStrategyPhase: dimensionResults.filter((row) => row.kind === "strategyPhase"),
  byCell: dimensionResults.filter((row) => row.kind === "cell"), monthlyPhaseOpportunity,
  unrestrictedPortfolio: { ...unrestrictedPortfolio, selected: undefined },
  fixedPortfolio: { ...fixedPortfolio, selected: undefined },
  selectedTrades: fixedPortfolio.selected,
  limitations: ["Historical order-book depth and funding are unavailable; costs are modeled.",
    "The final three months are an evaluation segment, but prior V6 work has already viewed this time period; it is not a pristine blind set.",
    "A phase without an accepted engine remains WAIT; coverage is not permission to manufacture a trade."],
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, status: report.status, candidates: report.candidates,
  acceptedStrategyPhases: report.acceptedStrategyPhases.map((row) => row.key),
  unrestrictedPortfolio: report.unrestrictedPortfolio, fixedPortfolio: report.fixedPortfolio }, null, 2));
