import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/autocorr-switch-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

const STATE_WINDOWS = [48, 96, 168];
const LAGS = [1, 3];
const IMPULSE_LOOKS = [3, 6, 12];
const IMPULSE_THRESHOLDS = [0.005, 0.01, 0.02];
const AUTOCORR_THRESHOLDS = [0, 0.05, 0.10];
const HOLDS = [2, 4, 8];

const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const monthKey = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthKeys = (from, to) => {
  const out = [];
  const d = new Date(from * 1000);
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() / 1000 < to) {
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
};
const rangeSum = (prefix, from, to) => to < from ? 0 : prefix[to + 1] - prefix[from];
const nanArray = (length) => {
  const out = new Float64Array(length);
  out.fill(Number.NaN);
  return out;
};

const symbols = DATA.datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);

// Memory-bounded representation: each symbol keeps its original hourly rows plus compact
// typed feature arrays. We deliberately do NOT cache per-config signal/event objects.
const series = [];
let featureRows = 0;
for (const dataset of DATA.datasets) {
  const rows = [...dataset.rows].sort((a, b) => a.time - b.time);
  const n = rows.length;
  const rets = nanArray(n);
  for (let i = 1; i < n; i += 1) {
    if (rows[i].time !== rows[i - 1].time + HOUR || !(rows[i - 1].close > 0) || !(rows[i].close > 0)) continue;
    rets[i] = rows[i].close / rows[i - 1].close - 1;
  }

  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  const invalidPrefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    const valid = Number.isFinite(rets[i]);
    const v = valid ? rets[i] : 0;
    prefix[i + 1] = prefix[i] + v;
    prefixSq[i + 1] = prefixSq[i] + v * v;
    invalidPrefix[i + 1] = invalidPrefix[i] + Number(!valid);
  }

  const xyPrefixes = new Map();
  for (const lag of LAGS) {
    const xy = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) {
      const x = rets[i];
      const y = i >= lag ? rets[i - lag] : Number.NaN;
      xy[i + 1] = xy[i] + (Number.isFinite(x) && Number.isFinite(y) ? x * y : 0);
    }
    xyPrefixes.set(lag, xy);
  }

  const impulses = new Map(IMPULSE_LOOKS.map((look) => [look, nanArray(n)]));
  const corrs = new Map();
  for (const window of STATE_WINDOWS) for (const lag of LAGS) corrs.set(`${window}:${lag}`, nanArray(n));

  const warm = Math.max(...STATE_WINDOWS) + Math.max(...LAGS) + 2;
  for (let i = warm; i < n; i += 1) {
    const row = rows[i];
    if (row.time < OLD_FROM || row.time >= EVAL_TO || !(row.close > 0)) continue;

    let impulsesOk = true;
    for (const look of IMPULSE_LOOKS) {
      const anchor = rows[i - look];
      if (!anchor || anchor.time !== row.time - look * HOUR || !(anchor.close > 0)) {
        impulsesOk = false;
        break;
      }
      impulses.get(look)[i] = row.close / anchor.close - 1;
    }
    if (!impulsesOk) continue;

    let anyCorr = false;
    for (const window of STATE_WINDOWS) for (const lag of LAGS) {
      const xFrom = i - window + 1;
      const xTo = i;
      const yFrom = xFrom - lag;
      const yTo = xTo - lag;
      if (yFrom < 1) continue;
      const invalidX = invalidPrefix[xTo + 1] - invalidPrefix[xFrom];
      const invalidY = invalidPrefix[yTo + 1] - invalidPrefix[yFrom];
      if (invalidX || invalidY) continue;
      const sx = rangeSum(prefix, xFrom, xTo);
      const sy = rangeSum(prefix, yFrom, yTo);
      const sxx = rangeSum(prefixSq, xFrom, xTo);
      const syy = rangeSum(prefixSq, yFrom, yTo);
      const sxy = rangeSum(xyPrefixes.get(lag), xFrom, xTo);
      const denomX = sxx - sx * sx / window;
      const denomY = syy - sy * sy / window;
      const denom = Math.sqrt(Math.max(0, denomX) * Math.max(0, denomY));
      if (!(denom > 0)) continue;
      const corr = (sxy - sx * sy / window) / denom;
      if (!Number.isFinite(corr)) continue;
      corrs.get(`${window}:${lag}`)[i] = Math.max(-1, Math.min(1, corr));
      anyCorr = true;
    }
    if (anyCorr) featureRows += 1;
  }

  series.push({ symbol: dataset.symbol, rows, impulses, corrs, warm });
}

function legReturn(entry0, exit, direction, slip) {
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

// Evaluate exactly one config at a time. Event rows are released after its statistics are
// computed, so the research frontier cannot grow memory with the number of configs.
function eventsFor(config, until) {
  const out = [];
  const corrKey = `${config.stateWindow}:${config.lag}`;
  for (const s of series) {
    const { rows, warm } = s;
    const impulseArray = s.impulses.get(config.impulseLook);
    const corrArray = s.corrs.get(corrKey);
    let busyUntil = 0;
    for (let i = warm; i < rows.length; i += 1) {
      const signalAt = rows[i].time;
      if (signalAt < OLD_FROM) continue;
      if (signalAt >= until) break;
      const impulse = impulseArray[i];
      const corr = corrArray[i];
      if (!Number.isFinite(impulse) || !Number.isFinite(corr)) continue;
      if (Math.abs(impulse) < config.impulseThreshold || Math.abs(corr) < config.autocorrThreshold) continue;
      const direction = Math.sign(impulse) * (corr >= 0 ? 1 : -1);
      if (!direction) continue;

      const entryAt = signalAt + HOUR;
      const exitAt = entryAt + config.hold * HOUR;
      if (exitAt > until) continue;
      if (busyUntil > entryAt) continue;
      const entryIndex = i + 1;
      const exitIndex = entryIndex + config.hold;
      if (exitIndex >= rows.length) continue;
      const entryRow = rows[entryIndex];
      const exitRow = rows[exitIndex];
      if (entryRow.time !== entryAt || exitRow.time !== exitAt) continue;

      const gross = legReturn(entryRow.open, exitRow.open, direction, ENTRY_SLIP);
      const adverseGross = legReturn(entryRow.open, exitRow.open, direction, ADVERSE_SLIP);
      if (![gross, adverseGross].every(Number.isFinite)) continue;
      out.push({
        symbol: s.symbol,
        entryAt,
        exitAt,
        gross,
        base: gross - BASE_COST,
        stress: gross - STRESS_COST,
        adverse: adverseGross - BASE_COST,
        month: monthKey(entryAt),
      });
      busyUntil = exitAt;
    }
  }
  return out;
}

function stats(rows, from, to, field = 'stress') {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(xs.map((e) => e[field]));
  const days = (to - from) / DAY;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol))) {
    equity += e[field];
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    events: xs.length,
    eventsPerDay: days ? xs.length / days : 0,
    net,
    net1000At1x: net * 1000,
    avgDaily1000At1x: days ? net / days * 1000 : 0,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    maxDrawdown1000At1x: maxDrawdown * 1000,
  };
}

function monthly(rows, from, to, field = 'stress') {
  return monthKeys(from, to).map((month) => {
    const xs = rows.filter((e) => e.month === month && e.entryAt >= from && e.exitAt <= to);
    const net = sum(xs.map((e) => e[field]));
    return { month, events: xs.length, net, positive: net > 0 };
  });
}

const candidates = [];
let id = 0;
for (const stateWindow of STATE_WINDOWS) for (const lag of LAGS) for (const impulseLook of IMPULSE_LOOKS)
for (const impulseThreshold of IMPULSE_THRESHOLDS) for (const autocorrThreshold of AUTOCORR_THRESHOLDS) for (const hold of HOLDS) {
  const c = { id: `ACS-${id++}`, stateWindow, lag, impulseLook, impulseThreshold, autocorrThreshold, hold };
  const ev = eventsFor(c, TRAIN_TO);
  const oldStress = stats(ev, OLD_FROM, OLD_TO, 'stress');
  const oldAdverse = stats(ev, OLD_FROM, OLD_TO, 'adverse');
  const currentStress = stats(ev, CURRENT_FROM, TRAIN_TO, 'stress');
  const currentAdverse = stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse');
  const oldMonthly = monthly(ev, OLD_FROM, OLD_TO, 'stress');
  const currentMonthly = monthly(ev, CURRENT_FROM, TRAIN_TO, 'stress');
  const oldPositiveMonths = oldMonthly.filter((x) => x.positive).length;
  const currentPositiveMonths = currentMonthly.filter((x) => x.positive).length;
  const minFreq = Math.min(oldStress.eventsPerDay, currentStress.eventsPerDay);
  const sampleEnough = oldStress.events >= 100 && currentStress.events >= 75;
  const discoveryRobust = sampleEnough
    && oldStress.net > 0
    && currentStress.net > 0
    && oldAdverse.net > 0
    && currentAdverse.net > 0
    && oldStress.pf >= 1.03
    && currentStress.pf >= 1.03
    && oldPositiveMonths >= 7
    && currentPositiveMonths >= 5;
  const eligible = discoveryRobust && minFreq >= 8;
  const targetFrequencyQualified = discoveryRobust && minFreq >= 12;
  const minPf = Math.min(oldStress.pf, currentStress.pf);
  const minAvg = Math.min(oldStress.avgNet, currentStress.avgNet);
  const positiveRatio = ((oldPositiveMonths / 12) + (currentPositiveMonths / 9)) / 2;
  const score = minPf * Math.sqrt(Math.max(0.01, minFreq))
    * (1 + Math.max(-0.5, Math.min(2, minAvg * 1000))) * (0.5 + positiveRatio);
  candidates.push({ c, oldStress, oldAdverse, currentStress, currentAdverse, oldPositiveMonths, currentPositiveMonths,
    oldMonthly, currentMonthly, minFreq, sampleEnough, discoveryRobust, eligible, targetFrequencyQualified, score });
}

const diagnosticPool = candidates.filter((x) => x.sampleEnough);
const robust = candidates.filter((x) => x.discoveryRobust).sort((a, b) => b.score - a.score);
const eligible = candidates.filter((x) => x.eligible).sort((a, b) => b.score - a.score);
const target = candidates.filter((x) => x.targetFrequencyQualified).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 30);

const groupSummary = (field, values) => Object.fromEntries(values.map((value) => {
  const xs = diagnosticPool.filter((x) => x.c[field] === value);
  const best = [...xs].sort((a, b) => b.score - a.score)[0];
  return [String(value), {
    configs: xs.length,
    oldStressPositive: xs.filter((x) => x.oldStress.net > 0).length,
    currentStressPositive: xs.filter((x) => x.currentStress.net > 0).length,
    bothStressPositive: xs.filter((x) => x.oldStress.net > 0 && x.currentStress.net > 0).length,
    bothAdversePositive: xs.filter((x) => x.oldAdverse.net > 0 && x.currentAdverse.net > 0).length,
    discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
    target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
    best: best ? { c: best.c, score: best.score, oldStress: best.oldStress, currentStress: best.currentStress,
      oldPositiveMonths: best.oldPositiveMonths, currentPositiveMonths: best.currentPositiveMonths } : null,
  }];
}));

let frozen = null;
if (robust.length) {
  const selected = robust[0];
  const fullEvents = eventsFor(selected.c, EVAL_TO);
  frozen = {
    selectedByDiscoveryOnly: selected.c,
    discoveryScore: selected.score,
    oldStress: selected.oldStress,
    oldAdverse: selected.oldAdverse,
    currentStress: selected.currentStress,
    currentAdverse: selected.currentAdverse,
    oldPositiveMonths: selected.oldPositiveMonths,
    currentPositiveMonths: selected.currentPositiveMonths,
    evaluation: {
      stress: stats(fullEvents, TRAIN_TO, EVAL_TO, 'stress'),
      adverse: stats(fullEvents, TRAIN_TO, EVAL_TO, 'adverse'),
      monthlyStress: monthly(fullEvents, TRAIN_TO, EVAL_TO, 'stress'),
    },
  };
}

const diagnostics = {
  symbols: symbols.length,
  featureRows,
  implementation: 'typed-features-streaming-configs-v2',
  configs: candidates.length,
  diagnosticPool: diagnosticPool.length,
  oldStressPositive: diagnosticPool.filter((x) => x.oldStress.net > 0).length,
  currentStressPositive: diagnosticPool.filter((x) => x.currentStress.net > 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.oldStress.net > 0 && x.currentStress.net > 0).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.oldAdverse.net > 0 && x.currentAdverse.net > 0).length,
  discoveryRobust: robust.length,
  eligible8PerDay: eligible.length,
  target12PerDay: target.length,
  evaluationOpened: Boolean(frozen),
  byStateWindow: groupSummary('stateWindow', STATE_WINDOWS),
  byLag: groupSummary('lag', LAGS),
  byImpulseLook: groupSummary('impulseLook', IMPULSE_LOOKS),
  byAutocorrThreshold: groupSummary('autocorrThreshold', AUTOCORR_THRESHOLDS),
  byHold: groupSummary('hold', HOLDS),
};

const output = {
  research: 'autocorr-switch-cross-era-v1',
  periods: {
    old: ['2024-09-01', '2025-09-01'],
    currentTrain: ['2025-09-01', '2026-06-01'],
    evaluation: ['2026-06-01', '2026-09-01'],
  },
  protocol: {
    signal: 'short-horizon displacement whose trade direction switches automatically: follow when recent return autocorrelation is positive, fade when negative',
    entry: 'next hourly open after completed signal bar',
    noLookahead: true,
    perSymbolNonOverlap: true,
    evaluationPolicy: 'holdout is not computed unless a config first passes all discovery robustness gates',
    costs: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
  },
  grid: { STATE_WINDOWS, LAGS, IMPULSE_LOOKS, IMPULSE_THRESHOLDS, AUTOCORR_THRESHOLDS, HOLDS },
  diagnostics,
  discoveryRobust: robust.length,
  eligible: eligible.length,
  targetFrequencyQualified: target.length,
  frozen,
  topNear,
  topRobust: robust.slice(0, 12),
  note: robust.length
    ? 'At least one adaptive autocorrelation-switch rule passed both discovery eras; only the top discovery-only rule opened holdout.'
    : 'No adaptive autocorrelation-switch rule passed the predeclared discovery gate. Holdout stayed closed; do not rescue from holdout.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`AUTOCORR_SWITCH=${JSON.stringify({
  research: output.research,
  symbols: diagnostics.symbols,
  featureRows: diagnostics.featureRows,
  implementation: diagnostics.implementation,
  configs: diagnostics.configs,
  diagnosticPool: diagnostics.diagnosticPool,
  oldStressPositive: diagnostics.oldStressPositive,
  currentStressPositive: diagnostics.currentStressPositive,
  bothStressPositive: diagnostics.bothStressPositive,
  bothAdversePositive: diagnostics.bothAdversePositive,
  discoveryRobust: diagnostics.discoveryRobust,
  eligible8PerDay: diagnostics.eligible8PerDay,
  target12PerDay: diagnostics.target12PerDay,
  evaluationOpened: diagnostics.evaluationOpened,
  frozen,
  topNear: topNear.slice(0, 12),
  note: output.note,
})}`);
