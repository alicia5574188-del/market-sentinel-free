import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-v12-44m-5m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/v12-44m-frozen-audit.json";
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const MIN_CONTEXT_MARKETS = Number(process.env.RESEARCH_MIN_CONTEXT_MARKETS ?? 9);
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m") throw new Error("V12 frozen audit requires Gate 5m data");
if (!Array.isArray(raw.months) || raw.months.length < 39) throw new Error("V12 frozen audit requires at least 39 chronological months");

const datasets = raw.datasets;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const signFor = (side) => side === "LONG" ? 1 : -1;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const fromMs = raw.from * 1_000;
const toMs = raw.now * 1_000;
const efficiency = (rows) => Math.abs(rows.at(-1).close - rows[0].open)
  / Math.max(rows.slice(1).reduce((total, row, index) => total + Math.abs(row.close - rows[index].close), 0), rows.at(-1).close * 1e-7);

const marketMoves = new Map();
for (const { rows } of datasets) for (let index = 6; index < rows.length; index += 1) {
  const values = marketMoves.get(rows[index].time) ?? [];
  values.push(rows[index].close / rows[index - 6].close - 1);
  marketMoves.set(rows[index].time, values);
}
const contexts = new Map([...marketMoves].map(([time, values]) => [time, {
  breadth: values.filter((value) => value > 0).length / values.length,
  medianMove: median(values), markets: values.length,
}]));

function tideRelay(rows, context, config) {
  const latest = rows.at(-1);
  const path = rows.slice(-config.path);
  const preResume = path.slice(0, -1);
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const broadDirection = context.medianMove > 0 ? 1 : -1;
  const broadStrong = broadDirection > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  if (!broadStrong) return null;
  const earlier = preResume.slice(0, -config.lag);
  const lag = preResume.slice(-config.lag);
  const alignedDisplacement = broadDirection * (earlier.at(-1).close - earlier[0].open);
  const lagMove = broadDirection * (lag.at(-1).close - lag[0].open);
  const latestBody = broadDirection * (latest.close - latest.open);
  const reclaim = broadDirection > 0
    ? latest.close > Math.max(...lag.map((row) => row.close))
    : latest.close < Math.min(...lag.map((row) => row.close));
  const closeLocation = broadDirection > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (efficiency(earlier) < config.efficiency || alignedDisplacement < unit * config.displacement
    || lagMove > -unit * config.lagMove || latestBody < unit * config.body || !reclaim
    || closeLocation < config.closeLocation) return null;
  const side = broadDirection > 0 ? "LONG" : "SHORT";
  const lagExtreme = broadDirection > 0 ? Math.min(...lag.map((row) => row.low)) : Math.max(...lag.map((row) => row.high));
  const stop = broadDirection > 0 ? lagExtreme - unit * config.stopPad : lagExtreme + unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { side, trigger: latest.close, stop,
    arm: latest.close + broadDirection * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function tideCatchup(rows, context, config) {
  const latest = rows.at(-1);
  const direction = context.medianMove > 0 ? 1 : -1;
  const broadStrong = direction > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  if (!broadStrong) return null;
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const lagRows = rows.slice(-config.lag - 1, -1);
  const lagMove = (lagRows.at(-1).close - lagRows[0].open) / lagRows[0].open;
  const relativeLag = direction * (context.medianMove - lagMove);
  const resumeRows = rows.slice(-config.resume);
  const alignedCloses = resumeRows.slice(1).filter((row, index) => direction * (row.close - resumeRows[index].close) > 0).length;
  const body = direction * (latest.close - latest.open);
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  const localRange = rows.slice(-config.range);
  const position = (latest.close - Math.min(...localRange.map((row) => row.low)))
    / Math.max(Math.max(...localRange.map((row) => row.high)) - Math.min(...localRange.map((row) => row.low)), 1e-12);
  const room = direction > 0 ? position <= config.maxPosition : position >= 1 - config.maxPosition;
  if (relativeLag < config.relativeLag || alignedCloses < config.alignedCloses || body < unit * config.body
    || closeLocation < config.closeLocation || !room) return null;
  const side = direction > 0 ? "LONG" : "SHORT";
  const extreme = direction > 0 ? Math.min(...lagRows.map((row) => row.low)) : Math.max(...lagRows.map((row) => row.high));
  const stop = direction > 0 ? extreme - unit * config.stopPad : extreme + unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { side, trigger: latest.close, stop,
    arm: latest.close + direction * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function quietDrift(rows, context, config) {
  const latest = rows.at(-1);
  const recent = rows.slice(-config.recent);
  const prior = rows.slice(-config.prior - config.recent, -config.recent);
  const recentUnit = median(recent.map((row) => row.high - row.low));
  const priorUnit = median(prior.map((row) => row.high - row.low));
  const direction = recent.at(-2).close >= recent[0].open ? 1 : -1;
  const net = direction * (recent.at(-2).close - recent[0].open);
  const aligned = recent.slice(1, -1).filter((row, index) => direction * (row.close - recent[index].close) > 0).length;
  const quietMarket = Math.abs(context.medianMove) <= config.marketMove;
  const resumed = direction > 0 ? latest.close > Math.max(...recent.slice(0, -1).map((row) => row.close))
    : latest.close < Math.min(...recent.slice(0, -1).map((row) => row.close));
  const body = direction * (latest.close - latest.open);
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (!quietMarket || recentUnit > priorUnit * config.quietRatio || efficiency(recent.slice(0, -1)) < config.efficiency
    || net < recentUnit * config.displacement || aligned < config.aligned || !resumed
    || body < recentUnit * config.body || closeLocation < config.closeLocation) return null;
  const side = direction > 0 ? "LONG" : "SHORT";
  const extreme = direction > 0 ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = direction > 0 ? extreme - recentUnit * config.stopPad : extreme + recentUnit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { side, trigger: latest.close, stop,
    arm: latest.close + direction * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function impulseRecoil(rows, context, config) {
  const latest = rows.at(-1);
  const impulse = rows.at(-2);
  const prior = rows.slice(-config.prior - 2, -2);
  const unit = median(prior.map((row) => row.high - row.low));
  const direction = impulse.close >= impulse.open ? 1 : -1;
  const impulseRange = impulse.high - impulse.low;
  const impulseBody = Math.abs(impulse.close - impulse.open);
  const broadConfirmed = direction > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  const retrace = direction > 0 ? (impulse.close - latest.close) / Math.max(impulseBody, 1e-12)
    : (latest.close - impulse.close) / Math.max(impulseBody, 1e-12);
  const reversed = direction > 0 ? latest.close < latest.open : latest.close > latest.open;
  const closeLocation = direction > 0 ? (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12);
  if (broadConfirmed || impulseRange < unit * config.range || impulseBody < impulseRange * config.body
    || !reversed || retrace < config.retrace || closeLocation < config.closeLocation) return null;
  const side = direction > 0 ? "SHORT" : "LONG";
  const sign = signFor(side);
  const extreme = direction > 0 ? Math.max(impulse.high, latest.high) : Math.min(impulse.low, latest.low);
  const stop = extreme - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { side, trigger: latest.close, stop,
    arm: latest.close + sign * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function economics(rows, index, signal, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const sign = signFor(signal.side);
  const entry = rows[index + 1]?.open * (1 + sign * slippage);
  if (!(entry > 0)) return false;
  const stopRate = Math.abs(signal.trigger - signal.stop) / signal.trigger;
  const armRate = Math.abs(signal.arm - signal.trigger) / signal.trigger;
  const extension = Math.abs(entry - signal.trigger) / signal.trigger;
  const rr = (armRate - friction) / Math.max(stopRate + friction, 1e-9);
  return extension <= Math.max(stopRate * .65, .0008) && stopRate >= friction
    && friction / Math.max(armRate, 1e-9) <= .25 && rr >= 1.2;
}

function resolve(rows, index, signal, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
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
    best = Math.max(best, signal.side === "LONG" ? row.high - entry : entry - row.low);
    const stopHit = signal.side === "LONG" ? row.low <= activeStop : row.high >= activeStop;
    const armHit = signal.side === "LONG" ? row.high >= arm : row.low <= arm;
    let exit = null;
    let outcome = null;
    if (stopHit) { exit = activeStop; outcome = armed ? "RUNNER_EXIT" : "STOP"; }
    else if (armHit) armed = true;
    if (exit == null && armed) {
      const giveback = Math.max(risk, best * .45);
      const locked = Math.max(entry * friction + risk * .35, best - giveback);
      activeStop = signal.side === "LONG" ? Math.max(activeStop, entry + locked) : Math.min(activeStop, entry - locked);
    }
    if (exit == null && !armed && offset >= signal.noProgressBars && best < risk * .35
      && sign * (row.close - entry) < risk * .15) { exit = row.close; outcome = "NO_PROGRESS"; }
    if (exit == null && offset === signal.maxBars) { exit = row.close; outcome = "TIMEOUT"; }
    if (exit != null) return { openedAt: rows[index + 1].time * 1_000, closedAt: row.time * 1_000,
      netReturnRate: sign * (exit - entry) / entry - friction, outcome };
  }
  return null;
}

const frozen = [
  { id: "tide_relay:2", detector: tideRelay, config: { path: 20, lag: 2, breadth: .60, marketMove: .0010,
    efficiency: .32, displacement: 2.8, lagMove: .25, body: .40, closeLocation: .60, stopPad: .20,
    armR: 1.7, maxBars: 24, noProgressBars: 6 } },
  { id: "tide_catchup:2", detector: tideCatchup, config: { lag: 9, resume: 2, range: 36, breadth: .60,
    marketMove: .0010, relativeLag: .0030, alignedCloses: 1, body: .25, closeLocation: .58,
    maxPosition: .75, stopPad: .20, armR: 1.7, maxBars: 20, noProgressBars: 5 } },
  { id: "quiet_drift:2", detector: quietDrift, config: { recent: 6, prior: 18, marketMove: .0018,
    quietRatio: .85, efficiency: .50, displacement: 1.6, aligned: 3, body: .25, closeLocation: .58,
    stopPad: .20, armR: 1.7, maxBars: 18, noProgressBars: 5 } },
  { id: "impulse_recoil:0", detector: impulseRecoil, config: { prior: 24, breadth: .62, marketMove: .0012,
    range: 2.0, body: .60, retrace: .40, closeLocation: .62, stopPad: .20, armR: 1.8,
    maxBars: 20, noProgressBars: 5 } },
];

function generate(item, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const trades = [];
  for (const { symbol, rows } of datasets) {
    let busyUntil = 0;
    for (let index = 120; index < rows.length - 1; index += 1) {
      if (rows[index].time <= busyUntil) continue;
      const context = contexts.get(rows[index].time);
      if (!context || context.markets < MIN_CONTEXT_MARKETS) continue;
      const signal = item.detector(rows.slice(index - 119, index + 1), context, item.config);
      if (!signal || !economics(rows, index, signal, friction, slippage)) continue;
      const trade = resolve(rows, index, signal, friction, slippage);
      if (!trade) continue;
      trades.push({ ...trade, symbol, side: signal.side, strategyId: item.id,
        contextBreadth: context.breadth, contextMedianMove: context.medianMove, contextMarkets: context.markets });
      busyUntil = trade.closedAt / 1_000;
    }
  }
  return trades;
}

function metrics(trades, start = fromMs, end = toMs) {
  const rows = trades.filter((row) => row.openedAt >= start && row.openedAt < end);
  const gains = rows.filter((row) => row.netReturnRate > 0);
  const losses = rows.filter((row) => row.netReturnRate <= 0);
  const gain = sum(gains.map((row) => row.netReturnRate));
  const loss = Math.abs(sum(losses.map((row) => row.netReturnRate)));
  const monthly = new Map(); const bySymbol = new Map(); const bySide = new Map();
  for (const trade of rows) {
    const month = new Date(trade.openedAt).toISOString().slice(0, 7).replace("-", "");
    monthly.set(month, (monthly.get(month) ?? 0) + trade.netReturnRate);
    bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + trade.netReturnRate);
    bySide.set(trade.side, (bySide.get(trade.side) ?? 0) + trade.netReturnRate);
  }
  const activeMonths = monthly.size;
  const positiveMonths = [...monthly.values()].filter((value) => value > 0).length;
  const days = Math.max((end - start) / 86_400_000, 1);
  return { trades: rows.length, tradesPerDay: rows.length / days, winRate: rows.length ? gains.length / rows.length : 0,
    netReturnRate: sum(rows.map((row) => row.netReturnRate)), profitFactor: loss ? gain / loss : gain ? 99 : 0,
    activeMonths, positiveMonths, positiveMonthRate: activeMonths ? positiveMonths / activeMonths : 0,
    monthly: Object.fromEntries([...monthly].sort()), bySymbol: Object.fromEntries([...bySymbol].sort()),
    bySide: Object.fromEntries([...bySide].sort()) };
}

function collisionSafeUnion(trades) {
  const ordered = [...trades].sort((a, b) => a.openedAt - b.openedAt || a.strategyId.localeCompare(b.strategyId));
  const busyBySymbol = new Map(); const accepted = []; const duplicateKeys = new Set();
  for (const trade of ordered) {
    const key = `${trade.symbol}:${trade.side}:${trade.openedAt}`;
    if (duplicateKeys.has(key)) continue;
    duplicateKeys.add(key);
    if ((busyBySymbol.get(trade.symbol) ?? 0) >= trade.openedAt) continue;
    accepted.push(trade); busyBySymbol.set(trade.symbol, trade.closedAt);
  }
  return accepted;
}

function periodMetrics(trades) {
  return { discovery: metrics(trades, fromMs, discoveryEnd), validation: metrics(trades, discoveryEnd, validationEnd),
    evaluation: metrics(trades, validationEnd, toMs), full: metrics(trades, fromMs, toMs) };
}

function runScenario(friction, slippage) {
  const strategies = frozen.map((item) => {
    const trades = generate(item, friction, slippage);
    return { id: item.id, ...periodMetrics(trades), rawTrades: trades };
  });
  const union = collisionSafeUnion(strategies.flatMap((row) => row.rawTrades));
  return { strategies: strategies.map(({ rawTrades, ...row }) => row), combined: periodMetrics(union) };
}

const base = runScenario(FRICTION, ENTRY_SLIPPAGE);
const higherCost = runScenario(0.0022, ENTRY_SLIPPAGE);
const doubledAdverseEntry = runScenario(FRICTION, ENTRY_SLIPPAGE * 2);
const report = {
  generatedAt: new Date().toISOString(), datasetSha256: raw.sha256, source: raw.source,
  months: raw.months, symbols: raw.symbols, minContextMarkets: MIN_CONTEXT_MARKETS,
  split: { discovery: raw.months.slice(0, 30), validation: raw.months.slice(30, 38), evaluation: raw.months.slice(38) },
  frozenStrategyIds: frozen.map((row) => row.id), base, higherCost, doubledAdverseEntry,
  gates: {
    everyStrategyValidationPositive: base.strategies.every((row) => row.validation.netReturnRate > 0 && row.validation.profitFactor > 1),
    everyStrategyEvaluationPositive: base.strategies.every((row) => row.evaluation.netReturnRate > 0 && row.evaluation.profitFactor > 1),
    combinedAllPeriodsPositive: [base.combined.discovery, base.combined.validation, base.combined.evaluation]
      .every((row) => row.netReturnRate > 0 && row.profitFactor > 1),
    combinedHigherCostPositive: [higherCost.combined.validation, higherCost.combined.evaluation]
      .every((row) => row.netReturnRate > 0 && row.profitFactor > 1),
    combinedAdverseEntryPositive: [doubledAdverseEntry.combined.validation, doubledAdverseEntry.combined.evaluation]
      .every((row) => row.netReturnRate > 0 && row.profitFactor > 1),
    evaluationFrequencyAtLeast4PerDay: base.combined.evaluation.tradesPerDay >= 4,
  },
};
report.longHorizonCandidate = Object.values(report.gates).every(Boolean);
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, longHorizonCandidate: report.longHorizonCandidate, gates: report.gates,
  base: { strategies: report.base.strategies.map((row) => ({ id: row.id, discovery: row.discovery,
    validation: row.validation, evaluation: row.evaluation })), combined: report.base.combined },
  higherCostCombined: report.higherCost.combined, adverseCombined: report.doubledAdverseEntry.combined }, null, 2));
