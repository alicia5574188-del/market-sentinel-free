import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/volume-pressure-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

const LOOKS = [6, 12, 24];
const PRESSURE_TYPES = ['CLV', 'BODY'];
const PRESSURE_THRESHOLDS = [0.05, 0.15];
const PRICE_THRESHOLDS = [0, 0.005];
const RELATIONS = ['ANY', 'ALIGNED', 'DIVERGENT'];
const MODES = ['FOLLOW_PRESSURE', 'FADE_PRESSURE'];
const HOLDS = [1, 2, 4];

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
const nanArray = (n) => { const a = new Float64Array(n); a.fill(Number.NaN); return a; };
const clamp1 = (x) => Math.max(-1, Math.min(1, x));

const symbols = DATA.datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);

const series = [];
let featureRows = 0;
for (const dataset of DATA.datasets) {
  const rows = [...dataset.rows].sort((a, b) => a.time - b.time);
  const n = rows.length;
  const prefixVolume = new Float64Array(n + 1);
  const prefixClvVolume = new Float64Array(n + 1);
  const prefixBodyVolume = new Float64Array(n + 1);
  const invalidPrefix = new Uint32Array(n + 1);
  const gapPrefix = new Uint32Array(n + 1);

  for (let i = 0; i < n; i += 1) {
    const r = rows[i];
    const valid = [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)
      && r.open > 0 && r.high >= r.low && r.close > 0 && r.volume >= 0;
    const range = valid ? r.high - r.low : 0;
    const clv = valid && range > 0 ? clamp1((2 * r.close - r.high - r.low) / range) : 0;
    const body = valid && range > 0 ? clamp1((r.close - r.open) / range) : 0;
    const volume = valid ? r.volume : 0;
    prefixVolume[i + 1] = prefixVolume[i] + volume;
    prefixClvVolume[i + 1] = prefixClvVolume[i] + volume * clv;
    prefixBodyVolume[i + 1] = prefixBodyVolume[i] + volume * body;
    invalidPrefix[i + 1] = invalidPrefix[i] + Number(!valid);
    const gap = i > 0 && rows[i].time !== rows[i - 1].time + HOUR;
    gapPrefix[i + 1] = gapPrefix[i] + Number(gap);
  }

  const priceRet = new Map(LOOKS.map((look) => [look, nanArray(n)]));
  const pressureClv = new Map(LOOKS.map((look) => [look, nanArray(n)]));
  const pressureBody = new Map(LOOKS.map((look) => [look, nanArray(n)]));
  const warm = Math.max(...LOOKS);

  for (let i = warm; i < n; i += 1) {
    const signalAt = rows[i].time;
    if (signalAt < OLD_FROM || signalAt >= EVAL_TO) continue;
    let rowHasFeature = false;
    for (const look of LOOKS) {
      const anchorIndex = i - look;
      const windowFrom = i - look + 1;
      if (anchorIndex < 0) continue;
      if (rows[anchorIndex].time !== signalAt - look * HOUR) continue;
      if (gapPrefix[i + 1] - gapPrefix[windowFrom + 1] > 0) continue;
      if (invalidPrefix[i + 1] - invalidPrefix[windowFrom] > 0) continue;
      const anchorClose = rows[anchorIndex].close;
      if (!(anchorClose > 0)) continue;
      const totalVolume = prefixVolume[i + 1] - prefixVolume[windowFrom];
      if (!(totalVolume > 0)) continue;
      const p = rows[i].close / anchorClose - 1;
      const clvP = (prefixClvVolume[i + 1] - prefixClvVolume[windowFrom]) / totalVolume;
      const bodyP = (prefixBodyVolume[i + 1] - prefixBodyVolume[windowFrom]) / totalVolume;
      if (![p, clvP, bodyP].every(Number.isFinite)) continue;
      priceRet.get(look)[i] = p;
      pressureClv.get(look)[i] = clamp1(clvP);
      pressureBody.get(look)[i] = clamp1(bodyP);
      rowHasFeature = true;
    }
    if (rowHasFeature) featureRows += 1;
  }

  series.push({ symbol: dataset.symbol, rows, priceRet, pressureClv, pressureBody, warm });
}

function legReturn(entry0, exit, direction, slip) {
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function relationOk(relation, pressure, price) {
  if (relation === 'ANY') return true;
  const ps = Math.sign(pressure);
  const rs = Math.sign(price);
  if (!ps || !rs) return false;
  if (relation === 'ALIGNED') return ps === rs;
  if (relation === 'DIVERGENT') return ps !== rs;
  return false;
}

function eventsFor(config, until) {
  const out = [];
  for (const s of series) {
    const pressureArray = config.pressureType === 'CLV'
      ? s.pressureClv.get(config.look)
      : s.pressureBody.get(config.look);
    const priceArray = s.priceRet.get(config.look);
    let busyUntil = 0;
    for (let i = s.warm; i < s.rows.length; i += 1) {
      const signalAt = s.rows[i].time;
      if (signalAt < OLD_FROM) continue;
      if (signalAt >= until) break;
      const pressure = pressureArray[i];
      const price = priceArray[i];
      if (!Number.isFinite(pressure) || !Number.isFinite(price)) continue;
      if (Math.abs(pressure) < config.pressureThreshold || Math.abs(price) < config.priceThreshold) continue;
      if (!relationOk(config.relation, pressure, price)) continue;
      const pressureDirection = Math.sign(pressure);
      if (!pressureDirection) continue;
      const direction = config.mode === 'FOLLOW_PRESSURE' ? pressureDirection : -pressureDirection;

      const entryAt = signalAt + HOUR;
      const exitAt = entryAt + config.hold * HOUR;
      if (exitAt > until || busyUntil > entryAt) continue;
      const entryIndex = i + 1;
      const exitIndex = entryIndex + config.hold;
      if (exitIndex >= s.rows.length) continue;
      const entryRow = s.rows[entryIndex];
      const exitRow = s.rows[exitIndex];
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
for (const look of LOOKS) for (const pressureType of PRESSURE_TYPES)
for (const pressureThreshold of PRESSURE_THRESHOLDS) for (const priceThreshold of PRICE_THRESHOLDS)
for (const relation of RELATIONS) for (const mode of MODES) for (const hold of HOLDS) {
  const c = { id: `VP-${id++}`, look, pressureType, pressureThreshold, priceThreshold, relation, mode, hold };
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
  byPressureType: groupSummary('pressureType', PRESSURE_TYPES),
  byRelation: groupSummary('relation', RELATIONS),
  byMode: groupSummary('mode', MODES),
  byLook: groupSummary('look', LOOKS),
  byHold: groupSummary('hold', HOLDS),
};

const output = {
  research: 'volume-pressure-cross-era-v1',
  periods: {
    old: ['2024-09-01', '2025-09-01'],
    currentTrain: ['2025-09-01', '2026-06-01'],
    evaluation: ['2026-06-01', '2026-09-01'],
  },
  protocol: {
    signal: 'volume-weighted candle pressure from close-location or candle-body position over 6/12/24h, conditioned on pressure-price alignment or divergence',
    entry: 'next hourly open after completed signal bar',
    noLookahead: true,
    perSymbolNonOverlap: true,
    evaluationPolicy: 'holdout is not computed unless a config first passes all discovery robustness gates',
    costs: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
  },
  grid: { LOOKS, PRESSURE_TYPES, PRESSURE_THRESHOLDS, PRICE_THRESHOLDS, RELATIONS, MODES, HOLDS },
  diagnostics,
  discoveryRobust: robust.length,
  eligible: eligible.length,
  targetFrequencyQualified: target.length,
  frozen,
  topNear,
  topRobust: robust.slice(0, 12),
  note: robust.length
    ? 'At least one OHLCV volume-pressure rule passed both discovery eras; only the top discovery-only rule opened holdout.'
    : 'No OHLCV volume-pressure rule passed the predeclared discovery gate. Holdout stayed closed; do not rescue from holdout.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`VOLUME_PRESSURE=${JSON.stringify({
  research: output.research,
  symbols: diagnostics.symbols,
  featureRows: diagnostics.featureRows,
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
