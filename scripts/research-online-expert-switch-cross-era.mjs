import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/online-expert-switch-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

const EXPERT_HORIZONS = [3, 6, 12, 24];
const IMPULSE_THRESHOLDS = [0, 0.005, 0.01];
const SCORE_WINDOWS = [72, 168, 336];
const SCOPES = ['GLOBAL', 'SYMBOL'];
const MIN_EDGES = [0, 0.0003, 0.0006];
const HOLDS = [1, 2, 4, 8];
const EXPERTS = EXPERT_HORIZONS.flatMap((horizon) => [
  { horizon, mode: 'FOLLOW', multiplier: 1 },
  { horizon, mode: 'FADE', multiplier: -1 },
]);

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
const nanFloat32 = (n) => { const a = new Float32Array(n); a.fill(Number.NaN); return a; };

const datasets = DATA.datasets.map((dataset) => ({
  symbol: dataset.symbol,
  rows: [...dataset.rows].sort((a, b) => a.time - b.time),
}));
if (datasets.length < 15) throw new Error(`Only ${datasets.length} symbols; need >=15`);
const symbols = datasets.map((d) => d.symbol);
const n = datasets[0].rows.length;
if (!n) throw new Error('Empty dataset');
for (const d of datasets) {
  if (d.rows.length !== n) throw new Error(`Unaligned row count for ${d.symbol}: ${d.rows.length} != ${n}`);
  for (let i = 0; i < n; i += 1) {
    if (d.rows[i].time !== datasets[0].rows[i].time) throw new Error(`Unaligned timestamp for ${d.symbol} at ${i}`);
  }
}
const times = datasets[0].rows.map((r) => r.time);

// Precompute only raw causal impulse features. Expert scoring itself remains online and
// uses only predictions that have fully matured before the current decision.
const impulses = datasets.map((d) => {
  const byHorizon = new Map();
  for (const horizon of EXPERT_HORIZONS) {
    const arr = nanFloat32(n);
    for (let i = horizon; i < n; i += 1) {
      const now = d.rows[i];
      const anchor = d.rows[i - horizon];
      if (anchor.time !== now.time - horizon * HOUR || !(anchor.close > 0) || !(now.close > 0)) continue;
      arr[i] = now.close / anchor.close - 1;
    }
    byHorizon.set(horizon, arr);
  }
  return byHorizon;
});

function legReturn(entry0, exit, direction, slip) {
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function buildDirs(threshold) {
  return datasets.map((_, s) => EXPERTS.map((expert) => {
    const arr = new Int8Array(n);
    const feature = impulses[s].get(expert.horizon);
    for (let i = 0; i < n; i += 1) {
      const impulse = feature[i];
      if (!Number.isFinite(impulse) || Math.abs(impulse) < threshold || impulse === 0) continue;
      arr[i] = Math.sign(impulse) * expert.multiplier;
    }
    return arr;
  }));
}

function maturedStress(dirs, s, e, maturityIndex) {
  // A prediction made on signal j enters at open(j+1) and scores at open(j+2).
  // At decision index i, only maturities <= i are admitted, so this is causal.
  const signalIndex = maturityIndex - 2;
  if (signalIndex < 0) return null;
  const direction = dirs[s][e][signalIndex];
  if (!direction) return null;
  const entryIndex = signalIndex + 1;
  const exitIndex = signalIndex + 2;
  const rows = datasets[s].rows;
  if (exitIndex >= rows.length) return null;
  if (rows[entryIndex].time !== rows[signalIndex].time + HOUR) return null;
  if (rows[exitIndex].time !== rows[entryIndex].time + HOUR) return null;
  const gross = legReturn(rows[entryIndex].open, rows[exitIndex].open, direction, ENTRY_SLIP);
  return Number.isFinite(gross) ? gross - STRESS_COST : null;
}

const selectors = new Map();
let selectorRows = 0;
for (const threshold of IMPULSE_THRESHOLDS) {
  const dirs = buildDirs(threshold);

  for (const window of SCORE_WINDOWS) {
    // GLOBAL: each expert's trailing score pools all symbols, while the current signal
    // direction remains symbol-specific.
    {
      const directions = datasets.map(() => new Int8Array(n));
      const scores = datasets.map(() => nanFloat32(n));
      const rollingSum = new Float64Array(EXPERTS.length);
      const rollingCount = new Uint32Array(EXPERTS.length);
      for (let i = 0; i < n; i += 1) {
        for (let e = 0; e < EXPERTS.length; e += 1) {
          for (let s = 0; s < datasets.length; s += 1) {
            const added = maturedStress(dirs, s, e, i);
            if (added != null) { rollingSum[e] += added; rollingCount[e] += 1; }
            const expiredMaturity = i - window;
            if (expiredMaturity >= 0) {
              const expired = maturedStress(dirs, s, e, expiredMaturity);
              if (expired != null) { rollingSum[e] -= expired; rollingCount[e] -= 1; }
            }
          }
        }
        for (let s = 0; s < datasets.length; s += 1) {
          let bestExpert = -1;
          let bestScore = -Infinity;
          for (let e = 0; e < EXPERTS.length; e += 1) {
            const direction = dirs[s][e][i];
            if (!direction || rollingCount[e] < 100) continue;
            const score = rollingSum[e] / rollingCount[e];
            if (score > bestScore) { bestScore = score; bestExpert = e; }
          }
          if (bestExpert >= 0) {
            directions[s][i] = dirs[s][bestExpert][i];
            scores[s][i] = bestScore;
            selectorRows += 1;
          }
        }
      }
      selectors.set(`${threshold}:${window}:GLOBAL`, { directions, scores });
    }

    // SYMBOL: each symbol chooses its own currently best expert from only that symbol's
    // fully matured prior predictions.
    {
      const directions = datasets.map(() => new Int8Array(n));
      const scores = datasets.map(() => nanFloat32(n));
      for (let s = 0; s < datasets.length; s += 1) {
        const rollingSum = new Float64Array(EXPERTS.length);
        const rollingCount = new Uint32Array(EXPERTS.length);
        for (let i = 0; i < n; i += 1) {
          for (let e = 0; e < EXPERTS.length; e += 1) {
            const added = maturedStress(dirs, s, e, i);
            if (added != null) { rollingSum[e] += added; rollingCount[e] += 1; }
            const expiredMaturity = i - window;
            if (expiredMaturity >= 0) {
              const expired = maturedStress(dirs, s, e, expiredMaturity);
              if (expired != null) { rollingSum[e] -= expired; rollingCount[e] -= 1; }
            }
          }
          let bestExpert = -1;
          let bestScore = -Infinity;
          for (let e = 0; e < EXPERTS.length; e += 1) {
            const direction = dirs[s][e][i];
            if (!direction || rollingCount[e] < 10) continue;
            const score = rollingSum[e] / rollingCount[e];
            if (score > bestScore) { bestScore = score; bestExpert = e; }
          }
          if (bestExpert >= 0) {
            directions[s][i] = dirs[s][bestExpert][i];
            scores[s][i] = bestScore;
            selectorRows += 1;
          }
        }
      }
      selectors.set(`${threshold}:${window}:SYMBOL`, { directions, scores });
    }
  }
}

function eventsFor(config, until) {
  const selector = selectors.get(`${config.impulseThreshold}:${config.scoreWindow}:${config.scope}`);
  const out = [];
  for (let s = 0; s < datasets.length; s += 1) {
    const rows = datasets[s].rows;
    const dirs = selector.directions[s];
    const scores = selector.scores[s];
    let busyUntil = 0;
    for (let i = 0; i < n; i += 1) {
      const signalAt = times[i];
      if (signalAt < OLD_FROM) continue;
      if (signalAt >= until) break;
      const direction = dirs[i];
      const score = scores[i];
      if (!direction || !Number.isFinite(score) || score < config.minEdge) continue;
      const entryAt = signalAt + HOUR;
      const exitAt = entryAt + config.hold * HOUR;
      if (exitAt > until || busyUntil > entryAt) continue;
      const entryIndex = i + 1;
      const exitIndex = entryIndex + config.hold;
      if (exitIndex >= n) continue;
      if (rows[entryIndex].time !== entryAt || rows[exitIndex].time !== exitAt) continue;
      const gross = legReturn(rows[entryIndex].open, rows[exitIndex].open, direction, ENTRY_SLIP);
      const adverseGross = legReturn(rows[entryIndex].open, rows[exitIndex].open, direction, ADVERSE_SLIP);
      if (![gross, adverseGross].every(Number.isFinite)) continue;
      out.push({
        symbol: datasets[s].symbol,
        entryAt,
        exitAt,
        selectorScore: score,
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
for (const impulseThreshold of IMPULSE_THRESHOLDS) for (const scoreWindow of SCORE_WINDOWS)
for (const scope of SCOPES) for (const minEdge of MIN_EDGES) for (const hold of HOLDS) {
  const c = { id: `OES-${id++}`, impulseThreshold, scoreWindow, scope, minEdge, hold };
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
  rowsPerSymbol: n,
  experts: EXPERTS,
  selectorRows,
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
  byScope: groupSummary('scope', SCOPES),
  byScoreWindow: groupSummary('scoreWindow', SCORE_WINDOWS),
  byImpulseThreshold: groupSummary('impulseThreshold', IMPULSE_THRESHOLDS),
  byMinEdge: groupSummary('minEdge', MIN_EDGES),
  byHold: groupSummary('hold', HOLDS),
};

const output = {
  research: 'online-expert-switch-cross-era-v1',
  periods: {
    old: ['2024-09-01', '2025-09-01'],
    currentTrain: ['2025-09-01', '2026-06-01'],
    evaluation: ['2026-06-01', '2026-09-01'],
  },
  protocol: {
    signal: 'causal online selection among eight fixed follow/fade impulse experts; expert choice uses only fully matured trailing stress-net predictions',
    experts: EXPERTS,
    scoringLag: 'prediction at j is first admitted to selector score at j+2; no current/future return enters the choice',
    entry: 'next hourly open after completed signal bar',
    noLookahead: true,
    perSymbolNonOverlap: true,
    evaluationPolicy: 'holdout is not computed unless a selector config first passes all discovery robustness gates',
    costs: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
  },
  grid: { IMPULSE_THRESHOLDS, SCORE_WINDOWS, SCOPES, MIN_EDGES, HOLDS },
  diagnostics,
  discoveryRobust: robust.length,
  eligible: eligible.length,
  targetFrequencyQualified: target.length,
  frozen,
  topNear,
  topRobust: robust.slice(0, 12),
  note: robust.length
    ? 'At least one causal online expert selector passed both discovery eras; only the top discovery-only selector opened holdout.'
    : 'No causal online expert selector passed the predeclared discovery gate. Holdout stayed closed; do not rescue from holdout.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`ONLINE_EXPERT_SWITCH=${JSON.stringify({
  research: output.research,
  symbols: diagnostics.symbols,
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
