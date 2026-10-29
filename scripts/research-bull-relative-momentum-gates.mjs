import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-bull-rm-44m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/bull-relative-momentum-gates.json";
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m") throw new Error("Requires Gate 5m history");
if ((raw.months?.length ?? 0) < 44) throw new Error("Requires the frozen 44-month window");

const CONFIG = {
  id: "directional_trend-bull-relative_momentum-7",
  system: "DIRECTIONAL_TREND",
  tactic: "BULL_RELATIVE_MOMENTUM",
  riskRate: 0.015,
  notionalMultiple: 0.5,
  minNotionalMultiple: 0.05,
  stopCap: 0.20,
  cooldownHours: 24,
  relative7: 0.03,
  confirm24: 0.005,
  stopFloor: 0.06,
  stopAtr: 6,
  exitModel: "TRAIL",
  trailScale: 0.8,
  maxHoldHours: 168,
};

const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
};
const sign = (value) => value > 0 ? 1 : value < 0 ? -1 : 0;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const nextMonthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const fromMs = monthStart(raw.months[0]);
const toMs = nextMonthStart(raw.months.at(-1));

function aggregateTo1h(rows) {
  const out = [];
  let index = 0;
  while (index < rows.length) {
    const bucket = Math.floor(rows[index].time / 3600) * 3600;
    const block = [];
    while (index < rows.length && Math.floor(rows[index].time / 3600) * 3600 === bucket) block.push(rows[index++]);
    if (block.length !== 12) continue;
    let contiguous = true;
    for (let i = 0; i < 12; i += 1) {
      if (block[i].time !== bucket + i * 300) { contiguous = false; break; }
    }
    if (!contiguous) continue;
    out.push({
      time: bucket,
      open: block[0].open,
      high: Math.max(...block.map((row) => row.high)),
      low: Math.min(...block.map((row) => row.low)),
      close: block.at(-1).close,
      volume: sum(block.map((row) => row.volume)),
    });
  }
  return out;
}

const signalDatasets = raw.datasets.map((item) => ({ symbol: item.symbol, rows: aggregateTo1h(item.rows) }));
const executionBySymbol = new Map(raw.datasets.map((item) => [item.symbol, item.rows]));

function gapPrefix(rows) {
  const prefix = [0];
  for (let index = 1; index < rows.length; index += 1) {
    prefix.push(prefix.at(-1) + Number(rows[index].time !== rows[index - 1].time + 3600));
  }
  return prefix;
}
const ret = (rows, index, hours) => rows[index].close / rows[index - hours].close - 1;
const rangeRate = (row) => (row.high - row.low) / Math.max(row.close, 1e-12);

const observationsByTime = new Map();
for (const { symbol, rows } of signalDatasets) {
  const gaps = gapPrefix(rows);
  for (let index = 720; index < rows.length - 1; index += 1) {
    const current = rows[index];
    if (gaps[index] !== gaps[index - 720] || rows[index + 1].time !== current.time + 3600) continue;
    const previous24 = rows.slice(index - 24, index);
    const previous7d = rows.slice(index - 168, index);
    const currentRanges = rows.slice(index - 5, index + 1).map(rangeRate);
    const baselineRanges = rows.slice(index - 168, index - 6).map(rangeRate);
    const recentVolume = sum(rows.slice(index - 5, index + 1).map((row) => row.volume)) / 6;
    const baselineVolume = sum(rows.slice(index - 48, index - 6).map((row) => row.volume)) / 42;
    const f = {
      symbol, rows, index, current,
      r1: ret(rows, index, 1), r6: ret(rows, index, 6), r24: ret(rows, index, 24),
      r7d: ret(rows, index, 168), r30d: ret(rows, index, 720),
      atr6: median(currentRanges),
      compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9),
      volumeBurst: recentVolume / Math.max(baselineVolume, 1e-9),
      high24: Math.max(...previous24.map((row) => row.high)), low24: Math.min(...previous24.map((row) => row.low)),
      high7d: Math.max(...previous7d.map((row) => row.high)), low7d: Math.min(...previous7d.map((row) => row.low)),
    };
    const values = observationsByTime.get(current.time) ?? [];
    values.push(f); observationsByTime.set(current.time, values);
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

const observations = [];
for (const [time, rows] of observationsByTime) {
  if (rows.length < Math.max(8, raw.symbols.length - 2)) continue;
  const values = (key) => rows.map((row) => row[key]);
  const context = {
    median24: median(values("r24")), median7: median(values("r7d")), median30: median(values("r30d")),
    breadth24: rows.filter((row) => row.r24 > 0).length / rows.length,
    breadth7: rows.filter((row) => row.r7d > 0).length / rows.length,
    breadth30: rows.filter((row) => row.r30d > 0).length / rows.length,
    compression: median(values("compression")), markets: rows.length,
  };
  const system = classify(context);
  for (const f of rows) observations.push({ ...f, time, context,
    relative24: f.r24 - context.median24, relative7: f.r7d - context.median7, system });
}

function signal(f) {
  if (f.system !== "DIRECTIONAL_TREND" || f.context.median30 <= 0) return null;
  const direction = sign(f.relative7);
  if (!direction || Math.abs(f.relative7) < CONFIG.relative7 || direction * f.relative24 < CONFIG.confirm24) return null;
  return { direction, strength: Math.abs(f.relative7) + direction * f.relative24 };
}

function lowerBound(rows, time) {
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time < time) low = middle + 1; else high = middle;
  }
  return low;
}

function resolve(f, found, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const rows = executionBySymbol.get(f.symbol);
  const entryTime = f.rows[f.index + 1].time;
  const index = lowerBound(rows, entryTime);
  if (rows[index]?.time !== entryTime) return null;
  const direction = found.direction;
  const entry = rows[index].open * (1 + direction * slippage);
  const stopRate = Math.min(CONFIG.stopCap, Math.max(CONFIG.stopFloor, CONFIG.stopAtr * f.atr6));
  const originalStop = entry * (1 - direction * stopRate);
  const maxBars = CONFIG.maxHoldHours * 12;
  let activeStop = originalStop; let extreme = entry;
  let exit = entry; let closedAt = rows[index].time * 1000; let outcome = "DATA_GAP";
  for (let offset = 0; offset < maxBars && index + offset < rows.length; offset += 1) {
    const candle = rows[index + offset];
    if (offset && candle.time !== rows[index + offset - 1].time + 300) {
      exit = rows[index + offset - 1].close; closedAt = rows[index + offset - 1].time * 1000; break;
    }
    const stopped = direction > 0 ? candle.low <= activeStop : candle.high >= activeStop;
    if (stopped) {
      exit = activeStop; closedAt = candle.time * 1000;
      outcome = activeStop === originalStop ? "STOP" : "TRAIL"; break;
    }
    extreme = direction > 0 ? Math.max(extreme, candle.high) : Math.min(extreme, candle.low);
    const candidate = extreme * (1 - direction * stopRate * CONFIG.trailScale);
    activeStop = direction > 0 ? Math.max(activeStop, candidate) : Math.min(activeStop, candidate);
    exit = candle.close; closedAt = candle.time * 1000; outcome = offset === maxBars - 1 ? "TIMEOUT" : outcome;
  }
  const grossReturnRate = direction * (exit - entry) / entry;
  const date = new Date(entryTime * 1000);
  return {
    strategyId: CONFIG.id, tactic: CONFIG.tactic, system: CONFIG.system, symbol: f.symbol,
    side: direction > 0 ? "LONG" : "SHORT", openedAt: entryTime * 1000, closedAt,
    entry, stop: originalStop, stopRate, strength: found.strength, friction, outcome,
    grossReturnRate, netReturnRate: grossReturnRate - friction,
    signal: {
      median30: f.context.median30, median7: f.context.median7, median24: f.context.median24,
      breadth30: f.context.breadth30, breadth7: f.context.breadth7, breadth24: f.context.breadth24,
      relative7: f.relative7, relative24: f.relative24,
      utcHour: date.getUTCHours(), utcDay: date.getUTCDay(),
    },
  };
}

function rawTrades(friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const trades = [];
  for (const f of observations) {
    const found = signal(f); if (!found) continue;
    const trade = resolve(f, found, friction, slippage); if (trade) trades.push(trade);
  }
  return trades.sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength);
}

function portfolio(trades) {
  let equity = 1000; let peak = equity; let maxDrawdown = 0;
  const open = []; const accepted = []; const cooldown = new Map();
  const settle = (time) => {
    for (const trade of open.filter((row) => row.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
      open.splice(open.indexOf(trade), 1);
      cooldown.set(`${trade.strategyId}:${trade.symbol}`, trade.closedAt + CONFIG.cooldownHours * 3600000);
    }
  };
  for (let index = 0; index < trades.length;) {
    const openedAt = trades[index].openedAt; settle(openedAt);
    const simultaneous = [];
    while (index < trades.length && trades[index].openedAt === openedAt) simultaneous.push(trades[index++]);
    const candidates = simultaneous.sort((a, b) => b.strength - a.strength || a.symbol.localeCompare(b.symbol));
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

function metrics(account, start, end) {
  const rows = account.trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end);
  const gains = rows.filter((row) => row.netPnl > 0); const losses = rows.filter((row) => row.netPnl <= 0);
  const monthly = raw.months.flatMap((month) => {
    const startAt = monthStart(month); const endAt = nextMonthStart(month);
    if (startAt < start || endAt > end) return [];
    const trades = rows.filter((trade) => trade.openedAt >= startAt && trade.openedAt < endAt);
    return [{ month, trades: trades.length, pnl: sum(trades.map((trade) => trade.netPnl)) }];
  });
  let equity = 1000; let peak = equity; let maxDrawdown = 0;
  for (const trade of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
  }
  const bySymbol = Object.fromEntries([...new Set(rows.map((row) => row.symbol))].map((symbol) => [symbol,
    sum(rows.filter((row) => row.symbol === symbol).map((row) => row.netPnl))]));
  const positiveSymbols = Object.values(bySymbol).filter((value) => value > 0); const positiveTotal = sum(positiveSymbols);
  return {
    trades: rows.length,
    tradesPerDay: rows.length / Math.max((end - start) / 86400000, 1),
    netPnl: sum(rows.map((row) => row.netPnl)),
    profitFactor: losses.length ? sum(gains.map((row) => row.netPnl)) / Math.abs(sum(losses.map((row) => row.netPnl))) : gains.length ? 99 : 0,
    maxDrawdown,
    activeMonths: monthly.filter((row) => row.trades).length,
    positiveMonths: monthly.filter((row) => row.pnl > 0).length,
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positiveSymbols) / positiveTotal : 1,
    distinctSymbols: Object.keys(bySymbol).length,
    monthly,
    bySymbol,
  };
}

const SEGMENTS = [
  { id: "ALL", description: "unfiltered frozen strategy", test: () => true },
  { id: "SIDE_LONG", description: "long signals only", test: (t) => t.side === "LONG" },
  { id: "SIDE_SHORT", description: "short signals only", test: (t) => t.side === "SHORT" },
  { id: "TREND30_MODERATE", description: "8%-15% median 30d bull trend", test: (t) => t.signal.median30 >= 0.08 && t.signal.median30 < 0.15 },
  { id: "TREND30_STRONG", description: ">=15% median 30d bull trend", test: (t) => t.signal.median30 >= 0.15 },
  { id: "ACCEL7_MODERATE", description: "1.5%-3% median 7d rise", test: (t) => t.signal.median7 >= 0.015 && t.signal.median7 < 0.03 },
  { id: "ACCEL7_STRONG", description: ">=3% median 7d rise", test: (t) => t.signal.median7 >= 0.03 },
  { id: "MARKET24_POSITIVE", description: "positive median 24h market move", test: (t) => t.signal.median24 >= 0 },
  { id: "MARKET24_NEGATIVE", description: "negative median 24h market move", test: (t) => t.signal.median24 < 0 },
  { id: "BREADTH30_BROAD", description: ">=72% positive over 30d", test: (t) => t.signal.breadth30 >= 0.72 },
  { id: "BREADTH30_BASE", description: "60%-72% positive over 30d", test: (t) => t.signal.breadth30 >= 0.60 && t.signal.breadth30 < 0.72 },
  { id: "BREADTH24_UP", description: ">=60% positive over 24h", test: (t) => t.signal.breadth24 >= 0.60 },
  { id: "BREADTH24_MIXED", description: "40%-60% positive over 24h", test: (t) => t.signal.breadth24 > 0.40 && t.signal.breadth24 < 0.60 },
  { id: "BREADTH24_DOWN", description: "<=40% positive over 24h", test: (t) => t.signal.breadth24 <= 0.40 },
  { id: "UTC_00_07", description: "signal entry 00:00-07:59 UTC", test: (t) => t.signal.utcHour < 8 },
  { id: "UTC_08_15", description: "signal entry 08:00-15:59 UTC", test: (t) => t.signal.utcHour >= 8 && t.signal.utcHour < 16 },
  { id: "UTC_16_23", description: "signal entry 16:00-23:59 UTC", test: (t) => t.signal.utcHour >= 16 },
  { id: "WEEKDAY", description: "Monday-Friday UTC", test: (t) => t.signal.utcDay >= 1 && t.signal.utcDay <= 5 },
  { id: "WEEKEND", description: "Saturday-Sunday UTC", test: (t) => t.signal.utcDay === 0 || t.signal.utcDay === 6 },
  { id: "LONG_ACCELERATING", description: "long + median7 >=3%", test: (t) => t.side === "LONG" && t.signal.median7 >= 0.03 },
  { id: "LONG_BROAD", description: "long + breadth30 >=72%", test: (t) => t.side === "LONG" && t.signal.breadth30 >= 0.72 },
  { id: "LONG_MARKET24_UP", description: "long + positive median24", test: (t) => t.side === "LONG" && t.signal.median24 >= 0 },
  { id: "SHORT_MARKET24_DOWN", description: "short + negative median24", test: (t) => t.side === "SHORT" && t.signal.median24 < 0 },
  { id: "SHORT_BREADTH24_DOWN", description: "short + breadth24 <=40%", test: (t) => t.side === "SHORT" && t.signal.breadth24 <= 0.40 },
];

function compact(value) {
  return {
    trades: value.trades, tradesPerDay: value.tradesPerDay, netPnl: value.netPnl,
    profitFactor: value.profitFactor, maxDrawdown: value.maxDrawdown,
    activeMonths: value.activeMonths, positiveMonths: value.positiveMonths,
    largestPositiveSymbolShare: value.largestPositiveSymbolShare, distinctSymbols: value.distinctSymbols,
  };
}

function discoveryFolds(account) {
  return [[0, 10], [10, 20], [20, 30]].map(([a, b]) => metrics(account, monthStart(raw.months[a]), monthStart(raw.months[b])));
}

const baseRaw = rawTrades(FRICTION, ENTRY_SLIPPAGE);
const stressRaw = rawTrades(STRESS_FRICTION, ENTRY_SLIPPAGE);
const adverseRaw = rawTrades(FRICTION, ENTRY_SLIPPAGE * 2);

const results = [];
for (const segment of SEGMENTS) {
  const base = portfolio(baseRaw.filter(segment.test));
  const stress = portfolio(stressRaw.filter(segment.test));
  const adverse = portfolio(adverseRaw.filter(segment.test));
  const discovery = metrics(base, fromMs, discoveryEnd);
  const validation = metrics(base, discoveryEnd, validationEnd);
  const evaluation = metrics(base, validationEnd, toMs);
  const folds = discoveryFolds(base);
  const stressValidation = metrics(stress, discoveryEnd, validationEnd);
  const stressEvaluation = metrics(stress, validationEnd, toMs);
  const adverseValidation = metrics(adverse, discoveryEnd, validationEnd);
  const adverseEvaluation = metrics(adverse, validationEnd, toMs);
  const gates = {
    discoverySample: discovery.trades >= 60 && discovery.activeMonths >= 12,
    discoveryEdge: discovery.netPnl > 0 && discovery.profitFactor >= 1.10,
    discoveryMonths: discovery.positiveMonths >= Math.ceil(discovery.activeMonths * 0.50),
    discoveryFolds: folds.filter((row) => row.netPnl > 0).length >= 2 && folds.at(-1).netPnl > 0,
    discoveryDrawdown: discovery.maxDrawdown <= 0.15,
    discoveryConcentration: discovery.largestPositiveSymbolShare <= 0.45,
    validation: validation.trades >= 15 && validation.netPnl > 0 && validation.profitFactor >= 1.05,
    evaluation: evaluation.trades >= 12 && evaluation.netPnl > 0 && evaluation.profitFactor >= 1.05,
    laterMonths: validation.positiveMonths >= Math.ceil(validation.activeMonths * 0.50)
      && evaluation.positiveMonths >= Math.ceil(evaluation.activeMonths * 0.50),
    higherCost: stressValidation.netPnl > 0 && stressValidation.profitFactor >= 1.0
      && stressEvaluation.netPnl > 0 && stressEvaluation.profitFactor >= 1.0,
    doubledAdverseEntry: adverseValidation.netPnl > 0 && adverseValidation.profitFactor >= 1.0
      && adverseEvaluation.netPnl > 0 && adverseEvaluation.profitFactor >= 1.0,
  };
  results.push({
    id: segment.id, description: segment.description,
    discovery: compact(discovery), validation: compact(validation), evaluation: compact(evaluation),
    discoveryFolds: folds.map(compact),
    stress: { validation: compact(stressValidation), evaluation: compact(stressEvaluation) },
    doubledAdverseEntry: { validation: compact(adverseValidation), evaluation: compact(adverseEvaluation) },
    gates, triplePass: Object.values(gates).every(Boolean),
  });
}

results.sort((a, b) => Number(b.triplePass) - Number(a.triplePass)
  || Number(Object.values(b.gates).filter(Boolean).length) - Number(Object.values(a.gates).filter(Boolean).length)
  || b.evaluation.netPnl - a.evaluation.netPnl);

const baseline = results.find((row) => row.id === "ALL");
const expected = {
  discovery: { trades: 421, netPnl: 204.80903177913186, profitFactor: 1.1197164638469939 },
  validation: { trades: 79, netPnl: 141.79104227455198, profitFactor: 1.3481653410334404 },
  evaluation: { trades: 42, netPnl: -33.64610521165002, profitFactor: 0.8528332050054928 },
};
const close = (left, right, tolerance = 1e-6) => Math.abs(left - right) <= tolerance;
const parity = {
  discovery: baseline.discovery.trades === expected.discovery.trades
    && close(baseline.discovery.netPnl, expected.discovery.netPnl)
    && close(baseline.discovery.profitFactor, expected.discovery.profitFactor),
  validation: baseline.validation.trades === expected.validation.trades
    && close(baseline.validation.netPnl, expected.validation.netPnl)
    && close(baseline.validation.profitFactor, expected.validation.profitFactor),
  evaluation: baseline.evaluation.trades === expected.evaluation.trades
    && close(baseline.evaluation.netPnl, expected.evaluation.netPnl)
    && close(baseline.evaluation.profitFactor, expected.evaluation.profitFactor),
};
parity.exact = parity.discovery && parity.validation && parity.evaluation;

const output = {
  generatedAt: new Date().toISOString(),
  decision: !parity.exact ? "PARITY_FAILED" : results.some((row) => row.triplePass) ? "STRUCTURAL_GATE_CANDIDATE_ONLY" : "NO_STRUCTURAL_GATE",
  releaseEligible: false,
  note: "Evaluation has already been inspected by earlier research; any survivor is a research candidate, not a blind release result.",
  dataset: { source: raw.source, sha256: raw.sha256, months: raw.months, symbols: raw.symbols, rows: sum(raw.datasets.map((d) => d.rows.length)) },
  frozenConfig: CONFIG,
  parity: { exact: parity.exact, checks: parity, expected, measured: { discovery: baseline.discovery, validation: baseline.validation, evaluation: baseline.evaluation } },
  scenarios: { base: { friction: FRICTION, entrySlippage: ENTRY_SLIPPAGE }, stressFriction: STRESS_FRICTION, doubledEntrySlippage: ENTRY_SLIPPAGE * 2 },
  rawSignalTrades: baseRaw.length,
  segmentsTested: SEGMENTS.length,
  triplePassCount: results.filter((row) => row.triplePass).length,
  triplePass: results.filter((row) => row.triplePass),
  leaderboard: results,
};
writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ decision: output.decision, parity: output.parity, rawSignalTrades: output.rawSignalTrades, segmentsTested: output.segmentsTested,
  triplePassCount: output.triplePassCount, top: output.leaderboard.slice(0, 8).map((row) => ({ id: row.id, triplePass: row.triplePass,
    discovery: row.discovery, validation: row.validation, evaluation: row.evaluation, gates: row.gates })) }, null, 2));
