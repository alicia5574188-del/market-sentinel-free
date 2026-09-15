import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-defrel-44m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/defensive-relative-timeframe-audit.json";
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m" || raw.months.length !== 44 || raw.symbols.length !== 11) throw new Error("Requires frozen 44-month Gate 5m / 11-symbol core dataset");

const CONFIG = {
  id: "directional_trend-defensive_relative-5",
  riskRate: 0.015,
  notionalMultiple: 0.5,
  minNotionalMultiple: 0.05,
  stopCap: 0.20,
  cooldownHours: 24,
  relative7: 0.03,
  confirm6: 0.004,
  stopFloor: 0.03,
  stopAtr: 5,
  rewardRisk: 2.2,
  maxHoldHours: 72,
};
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const BASE_SLIPPAGE = 0.00025;
const ADVERSE_SLIPPAGE = 0.00050;
const MIN_CONTEXT_MARKETS = 9;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
};
const sign = (value) => value > 0 ? 1 : value < 0 ? -1 : 0;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const nextMonth = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
const fromMs = monthStart(raw.months[0]);
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const toMs = nextMonth(raw.months.at(-1));
const executionBySymbol = new Map(raw.datasets.map((item) => [item.symbol, item.rows]));

function aggregateRows(rows, stepSeconds) {
  const samplesExpected = stepSeconds / 300;
  const minSamples = Math.ceil(samplesExpected * 5 / 6);
  const maxFillBuckets = Math.floor(3 * 3600 / stepSeconds);
  const result = [];
  let bucket = null;
  for (const row of rows) {
    const time = Math.floor(row.time / stepSeconds) * stepSeconds;
    if (!bucket || bucket.time !== time) {
      if (bucket?.samples >= minSamples) result.push(bucket);
      bucket = { time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, samples: 1 };
    } else {
      bucket.high = Math.max(bucket.high, row.high);
      bucket.low = Math.min(bucket.low, row.low);
      bucket.close = row.close;
      bucket.volume += row.volume;
      bucket.samples += 1;
    }
  }
  if (bucket?.samples >= minSamples) result.push(bucket);
  const filled = [];
  for (const row of result) {
    const previous = filled.at(-1);
    const missing = previous ? (row.time - previous.time) / stepSeconds - 1 : 0;
    if (previous && missing > 0 && missing <= maxFillBuckets) {
      for (let offset = 1; offset <= missing; offset += 1) filled.push({
        time: previous.time + offset * stepSeconds,
        open: previous.close, high: previous.close, low: previous.close, close: previous.close,
        volume: 0, samples: 0, synthetic: true,
      });
    }
    filled.push(row);
  }
  return filled;
}

const barsByStep = new Map();
for (const stepSeconds of [3600, 1800, 900]) {
  barsByStep.set(stepSeconds, new Map(raw.datasets.map(({ symbol, rows }) => [symbol, aggregateRows(rows, stepSeconds)])));
}

const rangeRate = (row) => (row.high - row.low) / Math.max(row.close, 1e-12);
const hourlyRowsBySymbol = barsByStep.get(3600);
const hourlyFeaturesByTime = new Map();
for (const [symbol, rows] of hourlyRowsBySymbol) {
  let gaps = [0];
  for (let index = 1; index < rows.length; index += 1) gaps.push(gaps.at(-1) + Number(rows[index].time !== rows[index - 1].time + 3600));
  for (let index = 720; index < rows.length - 1; index += 1) {
    if (gaps[index] !== gaps[index - 720] || rows[index + 1].time !== rows[index].time + 3600) continue;
    const currentRanges = rows.slice(index - 5, index + 1).map(rangeRate);
    const baselineRanges = rows.slice(index - 168, index - 6).map(rangeRate);
    const r24 = rows[index].close / rows[index - 24].close - 1;
    const r7d = rows[index].close / rows[index - 168].close - 1;
    const r30d = rows[index].close / rows[index - 720].close - 1;
    const f = {
      symbol,
      atr6: median(currentRanges),
      compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9),
      r24, r7d, r30d,
    };
    const list = hourlyFeaturesByTime.get(rows[index].time) ?? [];
    list.push(f); hourlyFeaturesByTime.set(rows[index].time, list);
  }
}

function classify(context) {
  const aligned24 = Math.max(context.breadth24, 1 - context.breadth24);
  if (Math.abs(context.median24) >= 0.04 || (Math.abs(context.median24) >= 0.02 && aligned24 >= 0.82)) return "SHOCK_TRANSITION";
  if (context.compression <= 0.68 && Math.abs(context.median24) < 0.025) return "COMPRESSION";
  if ((context.median30 >= 0.08 && context.median7 >= 0.015 && context.breadth30 >= 0.60)
    || (context.median30 <= -0.08 && context.median7 <= -0.015 && context.breadth30 <= 0.40)) return "DIRECTIONAL_TREND";
  if (Math.abs(context.median24) >= 0.018 || aligned24 >= 0.75) return "NON_TREND_EXPANSION";
  return "BALANCED_ROTATION";
}

const hourlyContext = new Map();
const hourlyAtrByTimeSymbol = new Map();
for (const [time, rows] of hourlyFeaturesByTime) {
  if (rows.length < MIN_CONTEXT_MARKETS) continue;
  const values = (key) => rows.map((row) => row[key]);
  const context = {
    median24: median(values("r24")),
    median7: median(values("r7d")),
    median30: median(values("r30d")),
    breadth24: rows.filter((row) => row.r24 > 0).length / rows.length,
    breadth7: rows.filter((row) => row.r7d > 0).length / rows.length,
    breadth30: rows.filter((row) => row.r30d > 0).length / rows.length,
    compression: median(values("compression")),
    markets: rows.length,
  };
  context.system = classify(context);
  hourlyContext.set(time, context);
  for (const row of rows) hourlyAtrByTimeSymbol.set(`${time}:${row.symbol}`, row.atr6);
}

function lowerBound(rows, time) {
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time < time) low = middle + 1; else high = middle;
  }
  return low;
}

function resolve(symbol, entryTime, direction, atr6, friction, slippage, strength) {
  const rows = executionBySymbol.get(symbol);
  const index = lowerBound(rows, entryTime);
  if (rows[index]?.time !== entryTime) return null;
  const entry = rows[index].open * (1 + direction * slippage);
  const stopRate = Math.min(CONFIG.stopCap, Math.max(CONFIG.stopFloor, CONFIG.stopAtr * atr6));
  const targetRate = Math.max(stopRate * CONFIG.rewardRisk, friction * 2.2);
  const stop = entry * (1 - direction * stopRate);
  const target = entry * (1 + direction * targetRate);
  const maxBars = CONFIG.maxHoldHours * 12;
  let exit = entry; let closedAt = rows[index].time * 1000; let outcome = "DATA_GAP";
  for (let offset = 0; offset < maxBars && index + offset < rows.length; offset += 1) {
    const candle = rows[index + offset];
    if (offset && candle.time !== rows[index + offset - 1].time + 300) {
      exit = rows[index + offset - 1].close;
      closedAt = rows[index + offset - 1].time * 1000;
      break;
    }
    const stopped = direction > 0 ? candle.low <= stop : candle.high >= stop;
    const targeted = direction > 0 ? candle.high >= target : candle.low <= target;
    if (stopped || targeted) {
      exit = stopped ? stop : target;
      closedAt = candle.time * 1000;
      outcome = stopped ? "STOP" : "TARGET";
      break;
    }
    exit = candle.close;
    closedAt = candle.time * 1000;
    outcome = offset === maxBars - 1 ? "TIMEOUT" : outcome;
  }
  const grossReturnRate = direction * (exit - entry) / entry;
  return {
    strategyId: CONFIG.id, symbol, side: direction > 0 ? "LONG" : "SHORT",
    openedAt: rows[index].time * 1000, closedAt, entry, stop, target, stopRate, targetRate,
    friction, outcome, grossReturnRate, netReturnRate: grossReturnRate - friction, strength,
  };
}

function buildRawTrades(stepSeconds, friction, slippage) {
  const barsMap = barsByStep.get(stepSeconds);
  const barsPerHour = 3600 / stepSeconds;
  const lookback7 = 168 * barsPerHour;
  const lookback6 = 6 * barsPerHour;
  const byTime = new Map();
  for (const [symbol, rows] of barsMap) {
    const gaps = [0];
    for (let index = 1; index < rows.length; index += 1) gaps.push(gaps.at(-1) + Number(rows[index].time !== rows[index - 1].time + stepSeconds));
    for (let index = lookback7; index < rows.length - 1; index += 1) {
      if (gaps[index] !== gaps[index - lookback7] || rows[index + 1].time !== rows[index].time + stepSeconds) continue;
      const r7 = rows[index].close / rows[index - lookback7].close - 1;
      const r6 = rows[index].close / rows[index - lookback6].close - 1;
      const list = byTime.get(rows[index].time) ?? [];
      list.push({ symbol, rows, index, r7, r6 }); byTime.set(rows[index].time, list);
    }
  }
  const trades = [];
  for (const [time, features] of byTime) {
    if (features.length < MIN_CONTEXT_MARKETS) continue;
    const signalEnd = time + stepSeconds;
    const contextTime = Math.floor((signalEnd - 1) / 3600) * 3600;
    const context = hourlyContext.get(contextTime);
    if (!context || context.system !== "DIRECTIONAL_TREND") continue;
    const marketDirection = sign(context.median30);
    if (!marketDirection) continue;
    const direction = -marketDirection;
    const median7 = median(features.map((row) => row.r7));
    for (const f of features) {
      const relative7 = f.r7 - median7;
      if (direction * relative7 < CONFIG.relative7 || direction * f.r6 < CONFIG.confirm6) continue;
      const atr6 = hourlyAtrByTimeSymbol.get(`${contextTime}:${f.symbol}`);
      if (!(atr6 > 0)) continue;
      const entryTime = f.rows[f.index + 1].time;
      const strength = direction * relative7 + direction * f.r6;
      const trade = resolve(f.symbol, entryTime, direction, atr6, friction, slippage, strength);
      if (trade) trades.push(trade);
    }
  }
  return trades.sort((left, right) => left.openedAt - right.openedAt || right.strength - left.strength);
}

function portfolio(trades) {
  let equity = 1000; let peak = equity; let maxDrawdown = 0;
  const open = []; const accepted = []; const cooldown = new Map();
  const settle = (time) => {
    for (const trade of open.filter((row) => row.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
      open.splice(open.indexOf(trade), 1);
      cooldown.set(`${trade.strategyId}:${trade.symbol}`, trade.closedAt + CONFIG.cooldownHours * 3_600_000);
    }
  };
  for (let index = 0; index < trades.length;) {
    const openedAt = trades[index].openedAt;
    settle(openedAt);
    const simultaneous = [];
    while (index < trades.length && trades[index].openedAt === openedAt) simultaneous.push(trades[index++]);
    const candidates = simultaneous.sort((left, right) => right.strength - left.strength || left.strategyId.localeCompare(right.strategyId));
    for (const trade of candidates) {
      if (equity <= 100 || open.some((row) => row.symbol === trade.symbol)
        || (cooldown.get(`${trade.strategyId}:${trade.symbol}`) ?? 0) > trade.openedAt) continue;
      const sameSide = open.filter((row) => row.side === trade.side);
      const multiple = Math.min(CONFIG.notionalMultiple, CONFIG.riskRate / Math.max(trade.stopRate + trade.friction, 1e-9));
      if (multiple < CONFIG.minNotionalMultiple) continue;
      const notional = equity * multiple;
      const plannedRisk = notional * (trade.stopRate + trade.friction);
      if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10
        || sum(sameSide.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.065) continue;
      const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
      open.push(acceptedTrade); accepted.push(acceptedTrade);
    }
  }
  settle(Infinity);
  return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(result, start, end) {
  const rows = result.trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end);
  const gains = rows.filter((row) => row.netPnl > 0);
  const losses = rows.filter((row) => row.netPnl <= 0);
  let equity = 1000; let peak = equity; let maxDrawdown = 0;
  for (const trade of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += trade.netPnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
  }
  const months = raw.months.flatMap((month) => {
    const startAt = monthStart(month); const endAt = nextMonth(month);
    if (startAt < start || endAt > end) return [];
    const monthRows = rows.filter((row) => row.openedAt >= startAt && row.openedAt < endAt);
    return [{ month, trades: monthRows.length, pnl: sum(monthRows.map((row) => row.netPnl)) }];
  });
  const bySymbol = Object.fromEntries([...new Set(rows.map((row) => row.symbol))].map((symbol) => [symbol,
    sum(rows.filter((row) => row.symbol === symbol).map((row) => row.netPnl))]));
  const positives = Object.values(bySymbol).filter((value) => value > 0); const positiveTotal = sum(positives);
  return {
    trades: rows.length,
    netPnl: sum(rows.map((row) => row.netPnl)),
    profitFactor: losses.length ? sum(gains.map((row) => row.netPnl)) / Math.abs(sum(losses.map((row) => row.netPnl))) : gains.length ? 99 : 0,
    maxDrawdown,
    activeMonths: months.filter((row) => row.trades).length,
    positiveMonths: months.filter((row) => row.pnl > 0).length,
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positives) / positiveTotal : 1,
  };
}
const compact = (value) => ({ trades: value.trades, netPnl: value.netPnl, profitFactor: value.profitFactor,
  maxDrawdown: value.maxDrawdown, activeMonths: value.activeMonths, positiveMonths: value.positiveMonths,
  largestPositiveSymbolShare: value.largestPositiveSymbolShare });
const folds = (account) => [[0, 10], [10, 20], [20, 30]].map(([a, b]) =>
  metrics(account, monthStart(raw.months[a]), monthStart(raw.months[b])));

function evaluate(stepSeconds) {
  const base = portfolio(buildRawTrades(stepSeconds, BASE_FRICTION, BASE_SLIPPAGE));
  const stress = portfolio(buildRawTrades(stepSeconds, STRESS_FRICTION, BASE_SLIPPAGE));
  const adverse = portfolio(buildRawTrades(stepSeconds, BASE_FRICTION, ADVERSE_SLIPPAGE));
  const period = (account, start, end) => compact(metrics(account, start, end));
  const result = {
    stepSeconds,
    label: stepSeconds === 3600 ? "1h" : stepSeconds === 1800 ? "30m" : "15m",
    base: {
      discovery: period(base, fromMs, discoveryEnd),
      validation: period(base, discoveryEnd, validationEnd),
      evaluation: period(base, validationEnd, toMs),
      full: period(base, fromMs, toMs),
      discoveryFolds: folds(base).map(compact),
    },
    stress: {
      discovery: period(stress, fromMs, discoveryEnd),
      validation: period(stress, discoveryEnd, validationEnd),
      evaluation: period(stress, validationEnd, toMs),
    },
    adverse: {
      discovery: period(adverse, fromMs, discoveryEnd),
      validation: period(adverse, discoveryEnd, validationEnd),
      evaluation: period(adverse, validationEnd, toMs),
    },
  };
  const evaluationDays = (toMs - validationEnd) / 86_400_000;
  result.evaluationTradesPerDay = result.base.evaluation.trades / evaluationDays;
  return result;
}

const results = [3600, 1800, 900].map(evaluate);
const baseline = results[0];
const EXPECTED = {
  discovery: { trades: 405, netPnl: 160.20113985242372, profitFactor: 1.081804990767622 },
  validation: { trades: 110, netPnl: 103.19201639926293, profitFactor: 1.1401901282519435 },
  evaluation: { trades: 45, netPnl: 293.79738240641836, profitFactor: 2.9314147423271115 },
};
const parityChecks = Object.fromEntries(Object.entries(EXPECTED).flatMap(([period, expected]) => [
  [`${period}Trades`, baseline.base[period].trades === expected.trades],
  [`${period}Net`, Math.abs(baseline.base[period].netPnl - expected.netPnl) <= 1.0],
  [`${period}PF`, Math.abs(baseline.base[period].profitFactor - expected.profitFactor) <= 0.02],
]));
parityChecks.all = Object.values(parityChecks).every(Boolean);
const baselineEvalRate = baseline.evaluationTradesPerDay;

function transformedPass(result) {
  const d = result.base.discovery; const v = result.base.validation; const e = result.base.evaluation;
  const sd = result.stress.discovery; const sv = result.stress.validation; const se = result.stress.evaluation;
  const ad = result.adverse.discovery; const av = result.adverse.validation; const ae = result.adverse.evaluation;
  const dFolds = result.base.discoveryFolds;
  return d.trades >= 300 && d.netPnl > 0 && d.profitFactor >= 1.05 && d.maxDrawdown <= 0.30
    && d.activeMonths >= 20 && d.positiveMonths >= Math.ceil(d.activeMonths * 0.50)
    && d.largestPositiveSymbolShare <= 0.50
    && dFolds.filter((fold) => fold.netPnl > 0).length >= 2 && dFolds.at(-1).netPnl > 0
    && v.trades >= 60 && v.netPnl > 0 && v.profitFactor >= 1.03
    && e.trades >= 30 && e.netPnl > 0 && e.profitFactor >= 1.05
    && sd.netPnl > 0 && sd.profitFactor >= 1.00 && sv.netPnl > 0 && sv.profitFactor >= 1.00 && se.netPnl > 0 && se.profitFactor >= 1.00
    && ad.netPnl > 0 && ad.profitFactor >= 1.00 && av.netPnl > 0 && av.profitFactor >= 1.00 && ae.netPnl > 0 && ae.profitFactor >= 1.00
    && result.evaluationTradesPerDay >= baselineEvalRate * 1.5;
}
for (const result of results.slice(1)) result.accepted = parityChecks.all && transformedPass(result);
const accepted = results.slice(1).filter((result) => result.accepted).map((result) => result.label);
const decision = !parityChecks.all ? "INVALID_PARITY" : accepted.length ? "TIMEFRAME_CANDIDATE" : "NO_TIMEFRAME_CANDIDATE";

const report = {
  generatedAt: new Date().toISOString(),
  decision,
  methodology: {
    motherStrategy: CONFIG,
    regimeContext: "Frozen canonical 1h five-regime context. Shorter refreshes never classify regimes on shorter bars.",
    relativeSignal: "Same 7-day relative-strength threshold and same 6-hour confirmation measured in clock time, refreshed every 1h/30m/15m.",
    stopVolatility: "Uses the latest causally completed canonical 1h atr6 feature so stop semantics remain on the original scale.",
    cooldownAndRisk: "Frozen 24h cooldown, risk sizing, portfolio caps, RR, max hold, friction and slippage assumptions.",
    transformsTested: ["30m", "15m"],
    noThresholdRetuning: true,
    noProductionAuthority: true,
  },
  dataset: { source: raw.source, sha256: raw.sha256, months: raw.months, symbols: raw.symbols },
  parity: { expected: EXPECTED, measured: {
    discovery: baseline.base.discovery, validation: baseline.base.validation, evaluation: baseline.base.evaluation,
  }, checks: parityChecks },
  baselineEvaluationTradesPerDay: baselineEvalRate,
  accepted,
  results,
};
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  output: OUTPUT, decision, parity: parityChecks.all, baselineEvaluationTradesPerDay: baselineEvalRate, accepted,
  results: results.map((result) => ({ label: result.label, accepted: result.accepted ?? null,
    evaluationTradesPerDay: result.evaluationTradesPerDay,
    base: result.base, stress: result.stress, adverse: result.adverse })),
}, null, 2));