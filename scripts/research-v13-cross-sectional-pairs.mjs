import { readFileSync } from 'node:fs';

const DATASET = process.env.RESEARCH_DATASET ?? '/tmp/gate-history-v13.json';
const INITIAL_EQUITY = 1_000;
const LEG_FRACTION = Number(process.env.V13_LEG_FRACTION ?? 0.25);
const BASE_COST_PER_LEG = Number(process.env.V13_BASE_COST_PER_LEG ?? 0.00165); // 14bp friction + 2.5bp adverse entry
const STRESS_COST_PER_LEG = Number(process.env.V13_STRESS_COST_PER_LEG ?? 0.00245); // 22bp friction + 2.5bp adverse entry
const TARGET_TURNOVER = Number(process.env.V13_TARGET_TURNOVER ?? 5);

const raw = JSON.parse(readFileSync(DATASET, 'utf8'));
const datasets = raw.datasets ?? [];
if (datasets.length < 8) throw new Error(`need >=8 datasets, got ${datasets.length}`);

const median = (values) => {
  if (!values.length) return NaN;
  const ordered = [...values].sort((a, b) => a - b);
  const m = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[m] : (ordered[m - 1] + ordered[m]) / 2;
};
const pct = (value) => Number((value * 100).toFixed(3));
const finite = Number.isFinite;

const symbols = datasets.map((d) => d.symbol);
const times = datasets[0].rows.map((r) => Number(r.time));
const n = times.length;
const columns = datasets.map((dataset) => {
  const open = new Float64Array(n); open.fill(NaN);
  const close = new Float64Array(n); close.fill(NaN);
  let i = 0;
  for (const row of dataset.rows) {
    const t = Number(row.time);
    while (i < n && times[i] < t) i += 1;
    if (i >= n) break;
    if (times[i] === t) {
      open[i] = Number(row.open);
      close[i] = Number(row.close);
    }
  }
  return { symbol: dataset.symbol, open, close };
});
raw.datasets = [];

const lookbacks = [3, 6, 12, 24];
const holds = [1, 2, 3, 6, 12];
const zThresholds = [0.8, 1.1, 1.4, 1.8];
const modes = ['REVERT', 'CONTINUE'];
const confirmations = [false, true];

function buildFeatures(lookback) {
  const top = new Int16Array(n); top.fill(-1);
  const bottom = new Int16Array(n); bottom.fill(-1);
  const topZ = new Float32Array(n); topZ.fill(NaN);
  const bottomZ = new Float32Array(n); bottomZ.fill(NaN);
  const spread = new Float32Array(n); spread.fill(NaN);
  const priorSpread = new Float32Array(n); priorSpread.fill(NaN);
  for (let i = lookback + 1; i < n - 13; i += 1) {
    const returns = [];
    const priorReturns = [];
    const validIndexes = [];
    for (let s = 0; s < columns.length; s += 1) {
      const c = columns[s].close;
      if (![c[i], c[i - lookback], c[i - 1], c[i - 1 - lookback]].every(finite)
        || c[i - lookback] <= 0 || c[i - 1 - lookback] <= 0) continue;
      returns.push(c[i] / c[i - lookback] - 1);
      priorReturns.push(c[i - 1] / c[i - 1 - lookback] - 1);
      validIndexes.push(s);
    }
    if (returns.length < Math.max(8, Math.ceil(columns.length * 0.75))) continue;
    const market = median(returns);
    const residuals = returns.map((value) => value - market);
    const scale = median(residuals.map((value) => Math.abs(value))) * 1.4826;
    if (!(scale > 1e-7)) continue;
    let hi = 0; let lo = 0;
    for (let j = 1; j < residuals.length; j += 1) {
      if (residuals[j] > residuals[hi]) hi = j;
      if (residuals[j] < residuals[lo]) lo = j;
    }
    const hiS = validIndexes[hi]; const loS = validIndexes[lo];
    top[i] = hiS; bottom[i] = loS;
    topZ[i] = residuals[hi] / scale;
    bottomZ[i] = residuals[lo] / scale;
    spread[i] = returns[hi] - returns[lo];
    priorSpread[i] = priorReturns[hi] - priorReturns[lo];
  }
  return { lookback, top, bottom, topZ, bottomZ, spread, priorSpread };
}

const featureByLookback = new Map(lookbacks.map((lookback) => [lookback, buildFeatures(lookback)]));

const boundaries = {
  discoveryStart: Date.UTC(2025, 8, 1) / 1_000,
  discoveryMid: Date.UTC(2026, 0, 1) / 1_000,
  validationStart: Date.UTC(2026, 4, 1) / 1_000,
  evaluationStart: Date.UTC(2026, 6, 1) / 1_000,
  end: Date.UTC(2026, 8, 1) / 1_000,
};
function indexAtOrAfter(ts) {
  let lo = 0; let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}
const ranges = {
  discovery: [indexAtOrAfter(boundaries.discoveryStart), indexAtOrAfter(boundaries.validationStart)],
  discoveryA: [indexAtOrAfter(boundaries.discoveryStart), indexAtOrAfter(boundaries.discoveryMid)],
  discoveryB: [indexAtOrAfter(boundaries.discoveryMid), indexAtOrAfter(boundaries.validationStart)],
  validation: [indexAtOrAfter(boundaries.validationStart), indexAtOrAfter(boundaries.evaluationStart)],
  evaluation: [indexAtOrAfter(boundaries.evaluationStart), indexAtOrAfter(boundaries.end)],
  full: [indexAtOrAfter(boundaries.discoveryStart), indexAtOrAfter(boundaries.end)],
};

function simulate(config, range, costPerLeg = BASE_COST_PER_LEG) {
  const [start, end] = range;
  const f = featureByLookback.get(config.lookback);
  let equity = INITIAL_EQUITY;
  let peak = equity;
  let maxDrawdown = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  let trades = 0;
  const monthGrowth = new Map();
  const perSymbol = new Map();
  const tradeReturns = [];
  for (let i = Math.max(start, config.lookback + 1); i < end - config.hold - 1; i += 1) {
    const top = f.top[i]; const bottom = f.bottom[i];
    if (top < 0 || bottom < 0 || f.topZ[i] < config.z || f.bottomZ[i] > -config.z) continue;
    if (!(f.spread[i] > 0) || !(f.priorSpread[i] > 0)) continue;
    if (config.confirm) {
      if (config.mode === 'REVERT' && !(f.spread[i] < f.priorSpread[i] * 0.98)) continue;
      if (config.mode === 'CONTINUE' && !(f.spread[i] > f.priorSpread[i] * 1.02)) continue;
    }
    const entry = i + 1;
    const exit = entry + config.hold;
    if (exit >= end) break;
    const longS = config.mode === 'REVERT' ? bottom : top;
    const shortS = config.mode === 'REVERT' ? top : bottom;
    const longEntry = columns[longS].open[entry]; const longExit = columns[longS].open[exit];
    const shortEntry = columns[shortS].open[entry]; const shortExit = columns[shortS].open[exit];
    if (![longEntry, longExit, shortEntry, shortExit].every(finite)
      || Math.min(longEntry, longExit, shortEntry, shortExit) <= 0) continue;
    const longReturn = longExit / longEntry - 1;
    const shortReturn = 1 - shortExit / shortEntry;
    const combinedNet = longReturn + shortReturn - 2 * costPerLeg;
    const accountReturn = LEG_FRACTION * combinedNet;
    const pnl = equity * accountReturn;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    if (pnl > 0) { wins += 1; grossWin += pnl; } else grossLoss += -pnl;
    trades += 1;
    tradeReturns.push(accountReturn);
    const key = new Date(times[exit] * 1_000).toISOString().slice(0, 7);
    monthGrowth.set(key, (monthGrowth.get(key) ?? 1) * (1 + accountReturn));
    for (const s of [longS, shortS]) perSymbol.set(symbols[s], (perSymbol.get(symbols[s]) ?? 0) + 1);
    i = exit - 1; // one market-neutral pair at a time; no overlapping gross exposure
  }
  // Use actual timestamp span, guarding partial/misaligned ranges.
  const spanDays = Math.max(1, (times[Math.min(end - 1, n - 1)] - times[Math.min(start, n - 1)]) / 86_400);
  const growth = equity / INITIAL_EQUITY;
  const monthlyEquivalent = Math.pow(Math.max(growth, 1e-9), 30 / spanDays) - 1;
  const months = [...monthGrowth.values()].map((g) => g - 1);
  const largestSymbolShare = trades ? Math.max(0, ...perSymbol.values()) / (trades * 2) : 0;
  return {
    trades,
    days: Number(spanDays.toFixed(2)),
    tradesPerDay: Number((trades / spanDays).toFixed(3)),
    turnoverPerDay: Number((trades / spanDays * 4 * LEG_FRACTION).toFixed(3)),
    returnPct: pct(growth - 1),
    monthlyEquivalentPct: pct(monthlyEquivalent),
    profitFactor: Number((grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0).toFixed(3)),
    winRatePct: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    maxDrawdownPct: pct(maxDrawdown),
    positiveMonths: months.filter((value) => value > 0).length,
    activeMonths: months.length,
    largestSymbolSharePct: Number((largestSymbolShare * 100).toFixed(2)),
    avgTradeAccountBps: tradeReturns.length ? Number((tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length * 10_000).toFixed(3)) : 0,
  };
}

const configs = [];
for (const lookback of lookbacks) for (const hold of holds) for (const z of zThresholds)
  for (const mode of modes) for (const confirm of confirmations) configs.push({ lookback, hold, z, mode, confirm });

const rows = configs.map((config) => {
  const discovery = simulate(config, ranges.discovery);
  const discoveryA = simulate(config, ranges.discoveryA);
  const discoveryB = simulate(config, ranges.discoveryB);
  const turnoverPenalty = Math.abs(discovery.turnoverPerDay - TARGET_TURNOVER);
  const robustFloor = Math.min(discoveryA.monthlyEquivalentPct, discoveryB.monthlyEquivalentPct);
  const eligible = discovery.turnoverPerDay >= 3.5 && discovery.turnoverPerDay <= 6.5
    && discovery.profitFactor >= 1.03 && discoveryA.returnPct > 0 && discoveryB.returnPct > 0
    && discovery.maxDrawdownPct <= 20 && discovery.largestSymbolSharePct <= 25;
  const score = robustFloor * 3 + discovery.monthlyEquivalentPct * 1.5 - turnoverPenalty * 2 - discovery.maxDrawdownPct * 0.15;
  return { config, discovery, discoveryA, discoveryB, eligible, score: Number(score.toFixed(3)) };
}).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);

const selected = rows[0];
const validation = simulate(selected.config, ranges.validation);
const evaluation = simulate(selected.config, ranges.evaluation);
const full = simulate(selected.config, ranges.full);
const stressEvaluation = simulate(selected.config, ranges.evaluation, STRESS_COST_PER_LEG);
const doubledAdverseEvaluation = simulate(selected.config, ranges.evaluation, 0.0019); // 14bp friction + 5bp adverse
const passes = Boolean(selected.eligible
  && validation.returnPct > 0 && evaluation.returnPct > 0
  && validation.turnoverPerDay >= 3.5 && validation.turnoverPerDay <= 6.5
  && evaluation.turnoverPerDay >= 3.5 && evaluation.turnoverPerDay <= 6.5
  && full.monthlyEquivalentPct >= 5
  && evaluation.monthlyEquivalentPct >= 5
  && stressEvaluation.returnPct > 0 && doubledAdverseEvaluation.returnPct > 0
  && full.maxDrawdownPct <= 20);

const result = {
  version: 'V13_CROSS_SECTIONAL_PAIR_RESIDUAL_V1',
  source: raw.source,
  datasetSha256: raw.sha256,
  symbols,
  months: raw.months,
  candlesPerReferenceSymbol: n,
  assumptions: {
    decisionBar: 'completed 5m only', entry: 'next 5m open', onePairAtATime: true,
    legFractionOfEquity: LEG_FRACTION, normalizedTurnoverPerRoundTrip: 4 * LEG_FRACTION,
    baseCostPerLegRoundTrip: BASE_COST_PER_LEG, stressCostPerLegRoundTrip: STRESS_COST_PER_LEG,
    targetDailyTurnoverMultiple: TARGET_TURNOVER,
    mechanism: 'equal-dollar long/short cross-sectional residual pair; no order book, trades, liquidation feed, or intrabar signal',
  },
  search: { configs: configs.length, eligible: rows.filter((row) => row.eligible).length,
    topDiscovery: rows.slice(0, 10) },
  selected: { ...selected, validation, evaluation, full, stressEvaluation, doubledAdverseEvaluation },
  decision: passes ? 'FORWARD_VALIDATION_CANDIDATE' : 'REJECT',
  acceptance: {
    required: 'discovery halves positive, 3.5-6.5x daily turnover, PF>=1.03, <=20% DD, validation/evaluation positive, evaluation and full >=5% monthly-equivalent, positive stress costs',
    passes,
  },
};
console.log(`V13_PAIR_RESEARCH_JSON=${JSON.stringify(result)}`);
