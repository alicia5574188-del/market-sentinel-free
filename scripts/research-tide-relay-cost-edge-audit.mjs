import { readFileSync, writeFileSync } from "node:fs";
import { classifyMarketState, deriveMarketStateFeatures } from "../lib/strategy-coverage.ts";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-tide-relay-44m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/tide-relay-cost-edge-audit.json";
const MIN_CONTEXT_MARKETS = Number(process.env.RESEARCH_MIN_CONTEXT_MARKETS ?? 9);
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const BASE_SLIPPAGE = 0.00025;
const ADVERSE_SLIPPAGE = 0.00050;
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
const datasets = raw.datasets;
if (raw.interval !== "5m" || raw.months.length !== 44 || raw.symbols.length !== 11) {
  throw new Error("Requires frozen 44-month Gate 5m / 11-symbol core dataset");
}

const CONFIG = {
  id: "tide_relay:2",
  path: 20,
  lag: 2,
  breadth: 0.60,
  marketMove: 0.0010,
  efficiency: 0.32,
  displacement: 2.8,
  lagMove: 0.25,
  body: 0.40,
  closeLocation: 0.60,
  stopPad: 0.20,
  armR: 1.7,
  maxBars: 24,
  noProgressBars: 6,
};
const AUTHORITY_STATE = "EXPANSION:BROAD_UP:HIGH_EDGE";
const signFor = (side) => side === "LONG" ? 1 : -1;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const efficiency = (rows) => Math.abs(rows.at(-1).close - rows[0].open)
  / Math.max(rows.slice(1).reduce((total, row, index) => total + Math.abs(row.close - rows[index].close), 0), rows.at(-1).close * 1e-7);
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const nextMonth = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7).replace("-", "");
const from = monthStart(raw.months[0]);
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const to = nextMonth(raw.months.at(-1));

const marketMoves = new Map();
for (const { rows } of datasets) {
  for (let index = 6; index < rows.length; index += 1) {
    if (rows[index].time - rows[index - 6].time !== 1_800) continue;
    const values = marketMoves.get(rows[index].time) ?? [];
    values.push(rows[index].close / rows[index - 6].close - 1);
    marketMoves.set(rows[index].time, values);
  }
}
const contexts = new Map([...marketMoves].map(([time, values]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return [time, {
    breadth: values.filter((value) => value > 0).length / values.length,
    medianMove: ordered[Math.floor(ordered.length / 2)] ?? 0,
    markets: values.length,
  }];
}));

function tideRelay(rows, context) {
  const latest = rows.at(-1);
  const path = rows.slice(-CONFIG.path);
  const preResume = path.slice(0, -1);
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const broadDirection = context.medianMove > 0 ? 1 : -1;
  const broadStrong = broadDirection > 0
    ? context.breadth >= CONFIG.breadth && context.medianMove >= CONFIG.marketMove
    : context.breadth <= 1 - CONFIG.breadth && context.medianMove <= -CONFIG.marketMove;
  if (!broadStrong) return null;
  const earlier = preResume.slice(0, -CONFIG.lag);
  const lag = preResume.slice(-CONFIG.lag);
  const alignedDisplacement = broadDirection * (earlier.at(-1).close - earlier[0].open);
  const lagMove = broadDirection * (lag.at(-1).close - lag[0].open);
  const latestBody = broadDirection * (latest.close - latest.open);
  const reclaim = broadDirection > 0
    ? latest.close > Math.max(...lag.map((row) => row.close))
    : latest.close < Math.min(...lag.map((row) => row.close));
  const closeLocation = broadDirection > 0
    ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (efficiency(earlier) < CONFIG.efficiency || alignedDisplacement < unit * CONFIG.displacement
    || lagMove > -unit * CONFIG.lagMove || latestBody < unit * CONFIG.body || !reclaim
    || closeLocation < CONFIG.closeLocation) return null;
  const side = broadDirection > 0 ? "LONG" : "SHORT";
  const lagExtreme = broadDirection > 0 ? Math.min(...lag.map((row) => row.low)) : Math.max(...lag.map((row) => row.high));
  const stop = broadDirection > 0 ? lagExtreme - unit * CONFIG.stopPad : lagExtreme + unit * CONFIG.stopPad;
  const risk = Math.abs(latest.close - stop);
  return {
    name: "潮接", environment: "TREND", side, trigger: latest.close, stop,
    arm: latest.close + broadDirection * risk * CONFIG.armR,
    maxBars: CONFIG.maxBars, noProgressBars: CONFIG.noProgressBars, at: latest.time,
  };
}

function economics(rows, index, signal, friction, slippage) {
  const sign = signFor(signal.side);
  const entry = rows[index + 1].open * (1 + sign * slippage);
  const stopRate = Math.abs(signal.trigger - signal.stop) / signal.trigger;
  const armRate = Math.abs(signal.arm - signal.trigger) / signal.trigger;
  const extension = Math.abs(entry - signal.trigger) / signal.trigger;
  const rr = (armRate - friction) / Math.max(stopRate + friction, 1e-9);
  return extension <= Math.max(stopRate * 0.65, 0.0008) && stopRate >= friction
    && friction / Math.max(armRate, 1e-9) <= 0.25 && rr >= 1.2;
}

function resolve(rows, index, signal, friction, slippage) {
  const sign = signFor(signal.side);
  const entry = rows[index + 1].open * (1 + sign * slippage);
  const stopRate = Math.abs(signal.trigger - signal.stop) / signal.trigger;
  const armRate = Math.abs(signal.arm - signal.trigger) / signal.trigger;
  const stop = entry * (1 - sign * stopRate);
  const arm = entry * (1 + sign * armRate);
  const risk = Math.abs(entry - stop);
  let activeStop = stop;
  let armed = false;
  let best = 0;
  for (let offset = 1; offset <= signal.maxBars && index + offset < rows.length; offset += 1) {
    const row = rows[index + offset];
    if (row.time !== rows[index + offset - 1].time + 300) return null;
    best = Math.max(best, signal.side === "LONG" ? row.high - entry : entry - row.low);
    const stopHit = signal.side === "LONG" ? row.low <= activeStop : row.high >= activeStop;
    const armHit = signal.side === "LONG" ? row.high >= arm : row.low <= arm;
    let exit = null;
    let outcome = null;
    if (stopHit) { exit = activeStop; outcome = armed ? "RUNNER_EXIT" : "STOP"; }
    else if (armHit) armed = true;
    if (exit == null && armed) {
      const giveback = Math.max(risk, best * 0.45);
      const locked = Math.max(entry * friction + risk * 0.35, best - giveback);
      activeStop = signal.side === "LONG" ? Math.max(activeStop, entry + locked) : Math.min(activeStop, entry - locked);
    }
    if (exit == null && !armed && offset >= signal.noProgressBars && best < risk * 0.35
      && sign * (row.close - entry) < risk * 0.15) { exit = row.close; outcome = "NO_PROGRESS"; }
    if (exit == null && offset === signal.maxBars) { exit = row.close; outcome = "TIMEOUT"; }
    if (exit != null) return {
      openedAt: rows[index + 1].time * 1_000,
      closedAt: row.time * 1_000,
      netReturnRate: sign * (exit - entry) / entry - friction,
      outcome,
      signalStopRate: stopRate,
      signalArmRate: armRate,
      normalCostBurden: BASE_FRICTION / Math.max(armRate, 1e-9),
    };
  }
  return null;
}

function generate(friction, slippage) {
  const trades = [];
  for (const { symbol, rows } of datasets) {
    let busyUntil = 0;
    for (let index = 120; index < rows.length - 1; index += 1) {
      if (rows[index].time <= busyUntil) continue;
      if (rows[index].time - rows[index - 119].time !== 35_700 || rows[index + 1].time !== rows[index].time + 300) continue;
      const context = contexts.get(rows[index].time);
      if (!context || context.markets < MIN_CONTEXT_MARKETS) continue;
      const signal = tideRelay(rows.slice(index - 119, index + 1), context);
      if (!signal || !economics(rows, index, signal, friction, slippage)) continue;
      const trade = resolve(rows, index, signal, friction, slippage);
      if (!trade) continue;
      const state = deriveMarketStateFeatures(rows.slice(index - 119, index + 1), context.breadth, context.medianMove);
      if (!state) continue;
      trades.push({ ...trade, symbol, side: signal.side, state });
      busyUntil = trade.closedAt / 1_000;
    }
  }
  return trades.filter((row) => classifyMarketState(row.state).key === AUTHORITY_STATE);
}

function metric(rows) {
  const gain = sum(rows.filter((row) => row.netReturnRate > 0).map((row) => row.netReturnRate));
  const loss = Math.abs(sum(rows.filter((row) => row.netReturnRate <= 0).map((row) => row.netReturnRate)));
  const byMonth = new Map(); const bySymbol = new Map();
  for (const row of rows) {
    const month = monthKey(row.openedAt);
    byMonth.set(month, (byMonth.get(month) ?? 0) + row.netReturnRate);
    bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + row.netReturnRate);
  }
  const positives = [...bySymbol.values()].filter((value) => value > 0);
  const positiveTotal = sum(positives);
  const netReturnSum = sum(rows.map((row) => row.netReturnRate));
  return {
    trades: rows.length,
    netReturnSum,
    profitFactor: loss ? gain / loss : gain ? 99 : 0,
    winRate: rows.length ? rows.filter((row) => row.netReturnRate > 0).length / rows.length : 0,
    activeMonths: byMonth.size,
    positiveMonths: [...byMonth.values()].filter((value) => value > 0).length,
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positives) / positiveTotal : 0,
  };
}
const compact = (value) => ({
  trades: value.trades, netReturnSum: value.netReturnSum, profitFactor: value.profitFactor,
  winRate: value.winRate, activeMonths: value.activeMonths, positiveMonths: value.positiveMonths,
  largestPositiveSymbolShare: value.largestPositiveSymbolShare,
});
const periodMetric = (rows, start, end) => metric(rows.filter((row) => row.openedAt >= start && row.openedAt < end));
const sixMonthBounds = [0, 6, 12, 18, 24].map((offset) => [monthStart(raw.months[offset]), monthStart(raw.months[offset + 6])]);

const scenarios = {
  base: { friction: BASE_FRICTION, slippage: BASE_SLIPPAGE, rows: generate(BASE_FRICTION, BASE_SLIPPAGE) },
  stress: { friction: STRESS_FRICTION, slippage: BASE_SLIPPAGE, rows: generate(STRESS_FRICTION, BASE_SLIPPAGE) },
  adverse: { friction: BASE_FRICTION, slippage: ADVERSE_SLIPPAGE, rows: generate(BASE_FRICTION, ADVERSE_SLIPPAGE) },
};

const EXPECTED = {
  discovery: { trades: 1403, netReturnSum: -0.5907123123690741, profitFactor: 0.9281552920067809 },
  validation: { trades: 341, netReturnSum: -0.2276422338399049, profitFactor: 0.8744717633868818 },
  evaluation: { trades: 183, netReturnSum: -0.11744664017766976, profitFactor: 0.8745533407889263 },
};
const baseline = {
  discovery: compact(periodMetric(scenarios.base.rows, from, discoveryEnd)),
  validation: compact(periodMetric(scenarios.base.rows, discoveryEnd, validationEnd)),
  evaluation: compact(periodMetric(scenarios.base.rows, validationEnd, to)),
};
const parityChecks = Object.fromEntries(Object.entries(EXPECTED).flatMap(([period, expected]) => [
  [`${period}Trades`, baseline[period].trades === expected.trades],
  [`${period}Net`, Math.abs(baseline[period].netReturnSum - expected.netReturnSum) <= 1e-9],
  [`${period}PF`, Math.abs(baseline[period].profitFactor - expected.profitFactor) <= 1e-9],
]));
parityChecks.all = Object.values(parityChecks).every(Boolean);

const GATES = [
  { id: "COST_BURDEN_LE_20", maxBurden: 0.20 },
  { id: "COST_BURDEN_LE_17_5", maxBurden: 0.175 },
  { id: "COST_BURDEN_LE_15", maxBurden: 0.15 },
  { id: "COST_BURDEN_LE_12_5", maxBurden: 0.125 },
  { id: "COST_BURDEN_LE_10", maxBurden: 0.10 },
];
const gateRows = (rows, gate) => rows.filter((row) => row.normalCostBurden <= gate.maxBurden);
const discoveryPass = (m, folds) => m.trades >= 180 && m.netReturnSum > 0 && m.profitFactor >= 1.05
  && m.activeMonths >= 18 && m.positiveMonths >= Math.ceil(m.activeMonths * 0.50)
  && m.largestPositiveSymbolShare <= 0.50
  && folds.filter((fold) => fold.netReturnSum > 0 && fold.profitFactor >= 1).length >= 3
  && folds.at(-1).netReturnSum > 0;
const validationPass = (base, stress, adverse) => base.trades >= 50 && base.netReturnSum > 0 && base.profitFactor >= 1.03
  && stress.trades >= 40 && stress.netReturnSum > 0 && stress.profitFactor >= 1
  && adverse.trades >= 40 && adverse.netReturnSum > 0 && adverse.profitFactor >= 1;
const evaluationPass = (base, stress, adverse, days) => base.trades >= 36 && base.netReturnSum > 0 && base.profitFactor >= 1.03
  && stress.trades >= 30 && stress.netReturnSum > 0 && stress.profitFactor >= 1
  && adverse.trades >= 30 && adverse.netReturnSum > 0 && adverse.profitFactor >= 1
  && base.trades / days >= 0.20;
const discoveryScore = (m) => (m.profitFactor - 1) * Math.sqrt(m.trades) + m.netReturnSum * 2 + m.positiveMonths * 0.02;

const discoveryAudit = GATES.map((gate) => {
  const rows = gateRows(scenarios.base.rows, gate).filter((row) => row.openedAt >= from && row.openedAt < discoveryEnd);
  const measured = metric(rows);
  const folds = sixMonthBounds.map(([start, end]) => metric(rows.filter((row) => row.openedAt >= start && row.openedAt < end)));
  return {
    id: gate.id, maxBurden: gate.maxBurden,
    impliedMinArmRate: BASE_FRICTION / gate.maxBurden,
    discovery: compact(measured),
    discoverySixMonth: folds.map(compact),
    qualified: discoveryPass(measured, folds),
    score: discoveryScore(measured),
  };
});
const shortlist = discoveryAudit.filter((row) => row.qualified)
  .sort((a, b) => b.score - a.score || a.maxBurden - b.maxBurden)
  .slice(0, 2);

const validationAudit = shortlist.map((selected) => {
  const gate = GATES.find((item) => item.id === selected.id);
  const base = periodMetric(gateRows(scenarios.base.rows, gate), discoveryEnd, validationEnd);
  const stress = periodMetric(gateRows(scenarios.stress.rows, gate), discoveryEnd, validationEnd);
  const adverse = periodMetric(gateRows(scenarios.adverse.rows, gate), discoveryEnd, validationEnd);
  return {
    id: gate.id,
    base: compact(base), stress: compact(stress), adverse: compact(adverse),
    pass: validationPass(base, stress, adverse),
    discoveryScore: selected.score,
  };
});
const survivors = validationAudit.filter((row) => row.pass)
  .sort((a, b) => b.discoveryScore - a.discoveryScore || a.id.localeCompare(b.id));
const lockedGate = survivors[0]?.id ?? null;

let finalEvaluation = null;
if (parityChecks.all && lockedGate) {
  const gate = GATES.find((item) => item.id === lockedGate);
  const base = periodMetric(gateRows(scenarios.base.rows, gate), validationEnd, to);
  const stress = periodMetric(gateRows(scenarios.stress.rows, gate), validationEnd, to);
  const adverse = periodMetric(gateRows(scenarios.adverse.rows, gate), validationEnd, to);
  const days = (to - validationEnd) / 86_400_000;
  finalEvaluation = {
    gate: lockedGate,
    base: compact(base), stress: compact(stress), adverse: compact(adverse),
    tradesPerDay: base.trades / days,
    pass: evaluationPass(base, stress, adverse, days),
  };
}

const grossBreakEven = (period, start, end) => {
  const m = periodMetric(scenarios.base.rows, start, end);
  const gross = m.netReturnSum + BASE_FRICTION * m.trades;
  return {
    trades: m.trades,
    netReturnSum: m.netReturnSum,
    netAverageBps: m.trades ? m.netReturnSum / m.trades * 10_000 : 0,
    impliedGrossReturnSum: gross,
    impliedGrossAverageBps: m.trades ? gross / m.trades * 10_000 : 0,
    modeledFrictionBps: BASE_FRICTION * 10_000,
  };
};
const costDecomposition = {
  discovery: grossBreakEven("discovery", from, discoveryEnd),
  validation: grossBreakEven("validation", discoveryEnd, validationEnd),
  evaluation: grossBreakEven("evaluation", validationEnd, to),
  full: grossBreakEven("full", from, to),
};
const decision = !parityChecks.all ? "INVALID_PARITY"
  : !shortlist.length ? "NO_DISCOVERY_COST_GATE"
  : !lockedGate ? "NO_VALIDATION_COST_GATE"
  : finalEvaluation?.pass ? "FORWARD_CANDIDATE" : "NO_EVALUATION_COST_GATE";

const report = {
  generatedAt: new Date().toISOString(),
  decision,
  methodology: {
    hypothesis: "Frozen tide_relay:2 has persistent positive pre-friction edge but normal 14bp friction exceeds its average edge; pre-entry structural arm distance may identify events whose opportunity is large enough relative to fixed cost.",
    configFrozen: CONFIG,
    authorityState: AUTHORITY_STATE,
    gates: GATES,
    selection: "Discovery only ranks predeclared cost-burden thresholds; top 2 go to validation; highest discovery-score survivor is locked; evaluation is computed only for that locked gate.",
    noMakerFillAssumption: true,
    noParameterRetuning: true,
    noProductionAuthority: true,
  },
  dataset: { source: raw.source, sha256: raw.sha256, months: raw.months, symbols: raw.symbols, minContextMarkets: MIN_CONTEXT_MARKETS },
  parity: { expected: EXPECTED, measured: baseline, checks: parityChecks },
  costDecomposition,
  discoveryShortlist: shortlist.map((row) => row.id),
  discoveryAudit,
  validationAudit,
  validationSurvivors: survivors.map((row) => row.id),
  lockedGate,
  finalEvaluation,
};
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  output: OUTPUT, decision, parity: parityChecks.all, costDecomposition,
  discoveryShortlist: report.discoveryShortlist,
  validationSurvivors: report.validationSurvivors,
  lockedGate, finalEvaluation,
  discovery: discoveryAudit.map((row) => ({ id: row.id, qualified: row.qualified, armMin: row.impliedMinArmRate,
    trades: row.discovery.trades, net: row.discovery.netReturnSum, pf: row.discovery.profitFactor,
    activeMonths: row.discovery.activeMonths, positiveMonths: row.discovery.positiveMonths,
    folds: row.discoverySixMonth.map((fold) => ({ n: fold.trades, net: fold.netReturnSum, pf: fold.profitFactor })) })),
  validation: validationAudit,
}, null, 2));