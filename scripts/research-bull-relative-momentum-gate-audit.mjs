import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-brm-gate-44m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/bull-relative-momentum-gate-audit.json";
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m") throw new Error("Requires Gate 5m dataset");
if (raw.months.length < 44) throw new Error("Requires 44 chronological months");
if (raw.symbols.length !== 11) throw new Error("Requires frozen 11-symbol core universe");

const CONFIG = {
  id: "directional_trend-bull-relative_momentum-7",
  system: "DIRECTIONAL_TREND",
  tactic: "BULL_RELATIVE_MOMENTUM",
  relative7: 0.03,
  confirm24: 0.005,
  stopFloor: 0.06,
  stopAtr: 6,
  stopCap: 0.20,
  exitModel: "TRAIL",
  trailScale: 0.8,
  maxHoldHours: 168,
  riskRate: 0.015,
  notionalMultiple: 0.5,
  minNotionalMultiple: 0.05,
  cooldownHours: 24,
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const ys = [...xs].sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)];
};
const sign = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const discoveryEnd = monthStart(raw.months[30]);
const validationEnd = monthStart(raw.months[38]);
const fromMs = monthStart(raw.months[0]);
const toMs = Date.UTC(Number(raw.months.at(-1).slice(0, 4)), Number(raw.months.at(-1).slice(4, 6)), 1)
  + new Date(Date.UTC(Number(raw.months.at(-1).slice(0, 4)), Number(raw.months.at(-1).slice(4, 6)), 0)).getUTCDate() * 86_400_000;

function aggregate1h(rows) {
  const out = [];
  let bucket = null;
  for (const row of rows) {
    const hour = Math.floor(row.time / 3600) * 3600;
    if (!bucket || bucket.time !== hour) {
      if (bucket?.count === 12 && bucket.firstTime === bucket.time && bucket.lastTime === bucket.time + 3300) {
        out.push({ time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close, volume: bucket.volume });
      }
      bucket = { time: hour, firstTime: row.time, lastTime: row.time, count: 1,
        open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
    } else {
      bucket.count += 1; bucket.lastTime = row.time;
      bucket.high = Math.max(bucket.high, row.high); bucket.low = Math.min(bucket.low, row.low);
      bucket.close = row.close; bucket.volume += row.volume;
    }
  }
  if (bucket?.count === 12 && bucket.firstTime === bucket.time && bucket.lastTime === bucket.time + 3300) {
    out.push({ time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close, volume: bucket.volume });
  }
  return out;
}

const executionBySymbol = new Map(raw.datasets.map((d) => [d.symbol, d.rows]));
const signalDatasets = raw.datasets.map((d) => ({ symbol: d.symbol, rows: aggregate1h(d.rows) }));

function gapPrefix(rows) {
  const prefix = [0];
  for (let i = 1; i < rows.length; i += 1) prefix.push(prefix.at(-1) + Number(rows[i].time !== rows[i - 1].time + 3600));
  return prefix;
}
const ret = (rows, i, hours) => rows[i].close / rows[i - hours].close - 1;
const rangeRate = (row) => (row.high - row.low) / Math.max(row.close, 1e-12);

const observationsByTime = new Map();
for (const { symbol, rows } of signalDatasets) {
  const gaps = gapPrefix(rows);
  for (let i = 720; i < rows.length - 1; i += 1) {
    const current = rows[i];
    if (gaps[i] !== gaps[i - 720] || rows[i + 1].time !== current.time + 3600) continue;
    const prev24 = rows.slice(i - 24, i);
    const prev7d = rows.slice(i - 168, i);
    const currentRanges = rows.slice(i - 5, i + 1).map(rangeRate);
    const baselineRanges = rows.slice(i - 168, i - 6).map(rangeRate);
    const recentVolume = sum(rows.slice(i - 5, i + 1).map((r) => r.volume)) / 6;
    const baselineVolume = sum(rows.slice(i - 48, i - 6).map((r) => r.volume)) / 42;
    const f = {
      symbol, rows, index: i, current,
      r1: ret(rows, i, 1), r6: ret(rows, i, 6), r24: ret(rows, i, 24),
      r7d: ret(rows, i, 168), r30d: ret(rows, i, 720),
      atr6: median(currentRanges),
      compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9),
      volumeBurst: recentVolume / Math.max(baselineVolume, 1e-9),
      high24: Math.max(...prev24.map((r) => r.high)), low24: Math.min(...prev24.map((r) => r.low)),
      high7d: Math.max(...prev7d.map((r) => r.high)), low7d: Math.min(...prev7d.map((r) => r.low)),
    };
    const rowsAtTime = observationsByTime.get(current.time) ?? [];
    rowsAtTime.push(f); observationsByTime.set(current.time, rowsAtTime);
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
  if (rows.length < 9) continue;
  const vals = (key) => rows.map((r) => r[key]);
  const context = {
    median24: median(vals("r24")), median7: median(vals("r7d")), median30: median(vals("r30d")),
    breadth24: rows.filter((r) => r.r24 > 0).length / rows.length,
    breadth7: rows.filter((r) => r.r7d > 0).length / rows.length,
    breadth30: rows.filter((r) => r.r30d > 0).length / rows.length,
    compression: median(vals("compression")), markets: rows.length,
  };
  const system = classify(context);
  for (const f of rows) observations.push({
    ...f, time, context, system,
    relative24: f.r24 - context.median24,
    relative7: f.r7d - context.median7,
  });
}

function lowerBound(rows, time) {
  let low = 0; let high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].time < time) low = mid + 1; else high = mid;
  }
  return low;
}

function signal(f) {
  if (f.system !== "DIRECTIONAL_TREND" || f.context.median30 <= 0) return null;
  const direction = sign(f.relative7);
  if (!direction || Math.abs(f.relative7) < CONFIG.relative7 || direction * f.relative24 < CONFIG.confirm24) return null;
  return { direction, strength: Math.abs(f.relative7) + direction * f.relative24 };
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
  const openedAt = rows[index].time * 1000;
  const dt = new Date(openedAt);
  return {
    strategyId: CONFIG.id, tactic: CONFIG.tactic, system: CONFIG.system, symbol: f.symbol,
    side: direction > 0 ? "LONG" : "SHORT", openedAt, closedAt, entry, stop: originalStop,
    stopRate, strength: found.strength, friction, outcome, grossReturnRate, netReturnRate: grossReturnRate - friction,
    gateData: {
      median30: f.context.median30, median7: f.context.median7, median24: f.context.median24,
      breadth30: f.context.breadth30, breadth7: f.context.breadth7, breadth24: f.context.breadth24,
      acceleration: f.context.median7 * 4 - f.context.median30,
      utcHour: dt.getUTCHours(), utcDow: dt.getUTCDay(),
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
    for (const trade of open.filter((t) => t.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
      open.splice(open.indexOf(trade), 1);
      cooldown.set(trade.symbol, trade.closedAt + CONFIG.cooldownHours * 3_600_000);
    }
  };
  for (let i = 0; i < trades.length;) {
    const openedAt = trades[i].openedAt; settle(openedAt);
    const simultaneous = [];
    while (i < trades.length && trades[i].openedAt === openedAt) simultaneous.push(trades[i++]);
    for (const trade of simultaneous.sort((a, b) => b.strength - a.strength || a.symbol.localeCompare(b.symbol))) {
      if (equity <= 100 || open.some((t) => t.symbol === trade.symbol) || (cooldown.get(trade.symbol) ?? 0) > trade.openedAt) continue;
      const sameSide = open.filter((t) => t.side === trade.side);
      const multiple = Math.min(CONFIG.notionalMultiple, CONFIG.riskRate / Math.max(trade.stopRate + trade.friction, 1e-9));
      if (multiple < CONFIG.minNotionalMultiple) continue;
      const notional = equity * multiple; const plannedRisk = notional * (trade.stopRate + trade.friction);
      if (sum(open.map((t) => t.plannedRisk)) + plannedRisk > equity * 0.10
        || sum(sameSide.map((t) => t.plannedRisk)) + plannedRisk > equity * 0.065) continue;
      const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
      open.push(acceptedTrade); accepted.push(acceptedTrade);
    }
  }
  settle(Infinity);
  return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(result, start, end) {
  const rows = result.trades.filter((t) => t.openedAt >= start && t.openedAt < end);
  const gains = rows.filter((t) => t.netPnl > 0), losses = rows.filter((t) => t.netPnl <= 0);
  const months = raw.months.filter((m) => monthStart(m) >= start && monthStart(m) < end);
  const monthly = months.map((month, idx) => {
    const s = monthStart(month);
    const e = idx + 1 < months.length ? monthStart(months[idx + 1]) : end;
    const xs = rows.filter((t) => t.openedAt >= s && t.openedAt < e);
    return { month, trades: xs.length, pnl: sum(xs.map((t) => t.netPnl)) };
  });
  let equity = 1000; let peak = equity; let maxDrawdown = 0;
  for (const trade of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const symbols = [...new Set(rows.map((t) => t.symbol))];
  const bySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, sum(rows.filter((t) => t.symbol === symbol).map((t) => t.netPnl))]));
  const positive = Object.values(bySymbol).filter((v) => v > 0); const positiveTotal = sum(positive);
  return {
    trades: rows.length, netPnl: sum(rows.map((t) => t.netPnl)),
    profitFactor: losses.length ? sum(gains.map((t) => t.netPnl)) / Math.abs(sum(losses.map((t) => t.netPnl))) : gains.length ? 99 : 0,
    maxDrawdown, activeMonths: monthly.filter((m) => m.trades).length,
    positiveMonths: monthly.filter((m) => m.pnl > 0).length,
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positive) / positiveTotal : 1,
    bySymbol, monthly,
  };
}

const GATES = [
  { id: "ALL", complexity: 0, fn: () => true },
  { id: "LONG_ONLY", complexity: 1, fn: (t) => t.side === "LONG" },
  { id: "SHORT_ONLY", complexity: 1, fn: (t) => t.side === "SHORT" },
  { id: "TREND30_GE_12", complexity: 1, fn: (t) => t.gateData.median30 >= 0.12 },
  { id: "TREND30_GE_16", complexity: 1, fn: (t) => t.gateData.median30 >= 0.16 },
  { id: "BREADTH30_GE_67", complexity: 1, fn: (t) => t.gateData.breadth30 >= 0.67 },
  { id: "BREADTH30_GE_75", complexity: 1, fn: (t) => t.gateData.breadth30 >= 0.75 },
  { id: "TREND7_GE_025", complexity: 1, fn: (t) => t.gateData.median7 >= 0.025 },
  { id: "TREND7_GE_040", complexity: 1, fn: (t) => t.gateData.median7 >= 0.040 },
  { id: "ACCEL_POSITIVE", complexity: 1, fn: (t) => t.gateData.acceleration >= 0 },
  { id: "MARKET24_POSITIVE", complexity: 1, fn: (t) => t.gateData.median24 > 0 },
  { id: "BREADTH24_GE_55", complexity: 1, fn: (t) => t.gateData.breadth24 >= 0.55 },
  { id: "UTC_00_07", complexity: 1, fn: (t) => t.gateData.utcHour < 8 },
  { id: "UTC_08_15", complexity: 1, fn: (t) => t.gateData.utcHour >= 8 && t.gateData.utcHour < 16 },
  { id: "UTC_16_23", complexity: 1, fn: (t) => t.gateData.utcHour >= 16 },
  { id: "WEEKDAY", complexity: 1, fn: (t) => t.gateData.utcDow >= 1 && t.gateData.utcDow <= 5 },
  { id: "WEEKEND", complexity: 1, fn: (t) => t.gateData.utcDow === 0 || t.gateData.utcDow === 6 },
  { id: "STRONG_BROAD", complexity: 2, fn: (t) => t.gateData.median30 >= 0.12 && t.gateData.breadth30 >= 0.67 },
  { id: "STRONG_ACCEL", complexity: 2, fn: (t) => t.gateData.median30 >= 0.12 && t.gateData.acceleration >= 0 },
  { id: "BROAD_ACCEL", complexity: 2, fn: (t) => t.gateData.breadth30 >= 0.67 && t.gateData.acceleration >= 0 },
  { id: "LONG_STRONG_BROAD", complexity: 3, fn: (t) => t.side === "LONG" && t.gateData.median30 >= 0.12 && t.gateData.breadth30 >= 0.67 },
  { id: "SHORT_STRONG_BROAD", complexity: 3, fn: (t) => t.side === "SHORT" && t.gateData.median30 >= 0.12 && t.gateData.breadth30 >= 0.67 },
  { id: "LONG_ACCEL", complexity: 2, fn: (t) => t.side === "LONG" && t.gateData.acceleration >= 0 },
  { id: "SHORT_ACCEL", complexity: 2, fn: (t) => t.side === "SHORT" && t.gateData.acceleration >= 0 },
  { id: "WEEKDAY_STRONG_BROAD", complexity: 3, fn: (t) => t.gateData.utcDow >= 1 && t.gateData.utcDow <= 5
    && t.gateData.median30 >= 0.12 && t.gateData.breadth30 >= 0.67 },
];

const baseRaw = rawTrades(FRICTION, ENTRY_SLIPPAGE);
const stressRaw = rawTrades(STRESS_FRICTION, ENTRY_SLIPPAGE);
const adverseRaw = rawTrades(FRICTION, ENTRY_SLIPPAGE * 2);

function runGate(gate) {
  const build = (rows) => portfolio(rows.filter(gate.fn));
  const base = build(baseRaw), stress = build(stressRaw), adverse = build(adverseRaw);
  const periods = (result) => ({
    discovery: metrics(result, fromMs, discoveryEnd),
    validation: metrics(result, discoveryEnd, validationEnd),
    evaluation: metrics(result, validationEnd, toMs),
    full: metrics(result, fromMs, toMs),
  });
  return { id: gate.id, complexity: gate.complexity, base: periods(base), stress: periods(stress), adverse: periods(adverse) };
}

const results = GATES.map(runGate);
const baseline = results.find((r) => r.id === "ALL");
const expected = { discoveryTrades: 421, discoveryNetPnl: 204.80903177913186, discoveryPF: 1.1197164638469939,
  validationTrades: 79, validationNetPnl: 141.79104227455198, recentTrades: 42, recentNetPnl: -33.64610521165002 };
const parity = {
  discoveryTrades: baseline.base.discovery.trades === expected.discoveryTrades,
  discoveryNetPnl: Math.abs(baseline.base.discovery.netPnl - expected.discoveryNetPnl) <= 1.0,
  discoveryPF: Math.abs(baseline.base.discovery.profitFactor - expected.discoveryPF) <= 0.02,
  validationTrades: baseline.base.validation.trades === expected.validationTrades,
  validationNetPnl: Math.abs(baseline.base.validation.netPnl - expected.validationNetPnl) <= 1.0,
  recentTrades: baseline.base.evaluation.trades === expected.recentTrades,
  recentNetPnl: Math.abs(baseline.base.evaluation.netPnl - expected.recentNetPnl) <= 1.0,
};
parity.all = Object.values(parity).every(Boolean);

const discoveryFolds = (result) => [[0, 10], [10, 20], [20, 30]].map(([a, b]) =>
  metrics(result, monthStart(raw.months[a]), monthStart(raw.months[b])));
function discoveryQualifies(row) {
  const m = row.base.discovery;
  const account = portfolio(baseRaw.filter(GATES.find((g) => g.id === row.id).fn));
  const folds = discoveryFolds(account);
  return {
    pass: m.trades >= 80 && m.netPnl > 0 && m.profitFactor >= 1.10 && m.activeMonths >= 15
      && m.positiveMonths >= Math.ceil(m.activeMonths * 0.50) && m.largestPositiveSymbolShare <= 0.45
      && folds.filter((x) => x.netPnl > 0).length >= 2 && folds.at(-1).netPnl > 0,
    folds,
  };
}
function laterPass(row, key, minTrades) {
  return row.base[key].trades >= minTrades && row.base[key].netPnl > 0 && row.base[key].profitFactor >= 1.03
    && row.stress[key].trades >= minTrades && row.stress[key].netPnl > 0 && row.stress[key].profitFactor >= 1.00
    && row.adverse[key].trades >= minTrades && row.adverse[key].netPnl > 0 && row.adverse[key].profitFactor >= 1.00;
}
function score(row) {
  const m = row.base.discovery;
  return m.netPnl + m.positiveMonths * 10 + m.profitFactor * 20 - m.maxDrawdown * 1000 - row.complexity * 10;
}

for (const row of results) {
  const d = discoveryQualifies(row);
  row.discoveryQualified = d.pass;
  row.discoveryFolds = d.folds;
  row.discoveryScore = score(row);
  row.validationPass = laterPass(row, "validation", 15);
  row.evaluationPass = laterPass(row, "evaluation", 10);
}
const discoveryShortlist = results.filter((r) => r.id !== "ALL" && r.discoveryQualified)
  .sort((a, b) => b.discoveryScore - a.discoveryScore || a.complexity - b.complexity || a.id.localeCompare(b.id))
  .slice(0, 3);
const validationSurvivors = discoveryShortlist.filter((r) => r.validationPass);
const locked = validationSurvivors.sort((a, b) => b.discoveryScore - a.discoveryScore || a.id.localeCompare(b.id))[0] ?? null;
const decision = !parity.all ? "INVALID_PARITY"
  : !discoveryShortlist.length ? "NO_DISCOVERY_GATE"
  : !locked ? "NO_VALIDATION_GATE"
  : locked.evaluationPass ? "FORWARD_CANDIDATE" : "NO_EVALUATION_GATE";

const compact = (m) => ({ trades: m.trades, netPnl: m.netPnl, profitFactor: m.profitFactor,
  maxDrawdown: m.maxDrawdown, activeMonths: m.activeMonths, positiveMonths: m.positiveMonths,
  largestPositiveSymbolShare: m.largestPositiveSymbolShare });
const summaryRows = results.map((r) => ({
  id: r.id, complexity: r.complexity, discoveryQualified: r.discoveryQualified,
  validationPass: r.validationPass, evaluationPass: r.evaluationPass, discoveryScore: r.discoveryScore,
  discovery: compact(r.base.discovery), validation: compact(r.base.validation), evaluation: compact(r.base.evaluation),
  stressValidation: compact(r.stress.validation), stressEvaluation: compact(r.stress.evaluation),
  adverseValidation: compact(r.adverse.validation), adverseEvaluation: compact(r.adverse.evaluation),
  discoveryFolds: r.discoveryFolds.map(compact),
})).sort((a, b) => b.discoveryScore - a.discoveryScore);

const out = {
  generatedAt: new Date().toISOString(),
  decision,
  methodology: {
    configFrozen: CONFIG,
    gateCount: GATES.length,
    selection: "Discovery-only shortlist top 3; validation survivors ranked only by discovery score; one locked gate receives final evaluation authority.",
    discoveryGate: ">=80 trades, PF>=1.10, >=15 active months, >=50% positive active months, concentration<=45%, >=2/3 positive 10-month folds and final fold positive",
    validationGate: ">=15 trades; base PF>=1.03/net>0; stress PF>=1/net>0; doubled-entry-slippage PF>=1/net>0",
    evaluationGate: ">=10 trades; same base/stress/adverse requirements as validation",
    noProductionAuthority: true,
  },
  dataset: { source: raw.source, months: raw.months, symbols: raw.symbols, sha256: raw.sha256 ?? null },
  parity: { expected, measured: {
    discovery: compact(baseline.base.discovery), validation: compact(baseline.base.validation), evaluation: compact(baseline.base.evaluation),
  }, checks: parity },
  discoveryShortlist: discoveryShortlist.map((r) => r.id),
  validationSurvivors: validationSurvivors.map((r) => r.id),
  lockedGate: locked?.id ?? null,
  lockedEvaluationPass: locked?.evaluationPass ?? false,
  leaderboard: summaryRows,
};
writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  output: OUTPUT, decision, parity: parity.all, rawSignals: baseRaw.length,
  discoveryShortlist: out.discoveryShortlist, validationSurvivors: out.validationSurvivors,
  lockedGate: out.lockedGate, lockedEvaluationPass: out.lockedEvaluationPass,
  top: summaryRows.slice(0, 10).map((r) => ({ id: r.id, dq: r.discoveryQualified, vp: r.validationPass, ep: r.evaluationPass,
    dN: r.discovery.trades, dPF: r.discovery.profitFactor, dNet: r.discovery.netPnl,
    vN: r.validation.trades, vPF: r.validation.profitFactor, vNet: r.validation.netPnl,
    eN: r.evaluation.trades, ePF: r.evaluation.profitFactor, eNet: r.evaluation.netPnl })),
}, null, 2));
