import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/long-horizon-momentum-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

const LOOKS = [24, 48, 72, 168];
const HOLDS = [6, 12, 24, 48];
const PROFILES = [
  { id: 'ABS_1', type: 'ABS', threshold: 0.01 },
  { id: 'ABS_2', type: 'ABS', threshold: 0.02 },
  { id: 'ABS_4', type: 'ABS', threshold: 0.04 },
  { id: 'VOL_075', type: 'VOL', threshold: 0.75 },
  { id: 'VOL_125', type: 'VOL', threshold: 1.25 },
  { id: 'VOL_175', type: 'VOL', threshold: 1.75 },
];
const MODES = ['TREND', 'FADE'];
const MARKET_FILTERS = ['NONE', 'MEDIAN', 'BROAD'];

const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const ys = [...xs].sort((a, b) => a - b);
  const i = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[i] : (ys[i - 1] + ys[i]) / 2;
};
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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, d.rows]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM - 200 * HOUR && t < EVAL_TO);

const featureMap = new Map();
for (const look of LOOKS) {
  const snapshots = [];
  for (const t of allTimes) {
    if (t < OLD_FROM) continue;
    const rows = [];
    for (const symbol of symbols) {
      const rm = rowMap.get(symbol);
      const p0 = rm.get(t - look * HOUR)?.open;
      const p1 = rm.get(t)?.open;
      if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
      let sumSq = 0;
      let valid = true;
      for (let k = 1; k <= look; k += 1) {
        const a = rm.get(t - k * HOUR)?.open;
        const b = rm.get(t - (k - 1) * HOUR)?.open;
        if (![a, b].every((v) => Number.isFinite(v) && v > 0)) { valid = false; break; }
        const r = b / a - 1;
        sumSq += r * r;
      }
      if (!valid || !(sumSq > 0)) continue;
      const rawRet = p1 / p0 - 1;
      rows.push({ symbol, rawRet, volScore: rawRet / Math.sqrt(sumSq) });
    }
    if (rows.length < 15) continue;
    const marketRet = median(rows.map((x) => x.rawRet));
    const positiveBreadth = rows.filter((x) => x.rawRet > 0).length / rows.length;
    const negativeBreadth = rows.filter((x) => x.rawRet < 0).length / rows.length;
    for (const x of rows) {
      const direction = Math.sign(x.rawRet);
      if (!direction) continue;
      snapshots.push({
        symbol: x.symbol,
        signalAt: t,
        look,
        rawRet: x.rawRet,
        volScore: x.volScore,
        direction,
        marketRet,
        directionBreadth: direction > 0 ? positiveBreadth : negativeBreadth,
      });
    }
  }
  snapshots.sort((a, b) => a.signalAt - b.signalAt || a.symbol.localeCompare(b.symbol));
  featureMap.set(look, snapshots);
}

function marketOk(filter, x) {
  if (filter === 'NONE') return true;
  const aligned = x.direction > 0 ? x.marketRet > 0 : x.marketRet < 0;
  if (!aligned) return false;
  if (filter === 'MEDIAN') return true;
  if (filter === 'BROAD') return x.directionBreadth >= 0.60;
  return false;
}

const signalCache = new Map();
function signalsFor(config) {
  const key = `${config.look}:${config.profileId}:${config.mode}:${config.marketFilter}`;
  if (signalCache.has(key)) return signalCache.get(key);
  const profile = PROFILES.find((p) => p.id === config.profileId);
  const source = featureMap.get(config.look) ?? [];
  const rows = source.filter((x) => {
    const score = profile.type === 'ABS' ? Math.abs(x.rawRet) : Math.abs(x.volScore);
    return score >= profile.threshold && marketOk(config.marketFilter, x);
  });
  signalCache.set(key, rows);
  return rows;
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const entry0 = rm.get(entryAt)?.open;
  const exit = rm.get(exitAt)?.open;
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function events(config) {
  const rows = signalsFor(config);
  const out = [];
  const busy = new Map();
  for (const x of rows) {
    const entryAt = x.signalAt + HOUR;
    const exitAt = entryAt + config.hold * HOUR;
    if (exitAt > EVAL_TO) continue;
    if ((busy.get(x.symbol) ?? 0) > entryAt) continue;
    const direction = config.mode === 'TREND' ? x.direction : -x.direction;
    const gross = legReturn(x.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
    const adverseGross = legReturn(x.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
    if (![gross, adverseGross].every(Number.isFinite)) continue;
    out.push({
      ...x,
      entryAt,
      exitAt,
      direction,
      mode: config.mode,
      profileId: config.profileId,
      marketFilter: config.marketFilter,
      hold: config.hold,
      gross,
      base: gross - BASE_COST,
      stress: gross - STRESS_COST,
      adverse: adverseGross - BASE_COST,
      orderLegs: 1,
      month: monthKey(entryAt),
    });
    busy.set(x.symbol, exitAt);
  }
  return out;
}

function stats(rows, from, to, field = 'base') {
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
  const netPerDay = days ? net / days : 0;
  return {
    events: xs.length,
    independentEventsPerDay: days ? xs.length / days : 0,
    orderLegEntriesPerDay: days ? xs.length / days : 0,
    net,
    netPerDay,
    net1000At1x: net * 1000,
    avgDaily1000At1x: netPerDay * 1000,
    requiredLeverageFor50UDay: netPerDay > 0 ? 0.05 / netPerDay : null,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    maxDrawdown1000At1x: maxDrawdown * 1000,
    avgGross: xs.length ? sum(xs.map((e) => e.gross)) / xs.length : 0,
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
for (const look of LOOKS) for (const profile of PROFILES) for (const mode of MODES) for (const marketFilter of MARKET_FILTERS) for (const hold of HOLDS) {
  const c = { id: `LHM-${id++}`, look, profileId: profile.id, profileType: profile.type, threshold: profile.threshold, mode, marketFilter, hold };
  const ev = events(c);
  const old = {
    base: stats(ev, OLD_FROM, OLD_TO),
    stress: stats(ev, OLD_FROM, OLD_TO, 'stress'),
    adverse: stats(ev, OLD_FROM, OLD_TO, 'adverse'),
  };
  const currentTrain = {
    base: stats(ev, CURRENT_FROM, TRAIN_TO),
    stress: stats(ev, CURRENT_FROM, TRAIN_TO, 'stress'),
    adverse: stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse'),
  };
  const evaluation = {
    base: stats(ev, TRAIN_TO, EVAL_TO),
    stress: stats(ev, TRAIN_TO, EVAL_TO, 'stress'),
    adverse: stats(ev, TRAIN_TO, EVAL_TO, 'adverse'),
  };
  const oldMonthly = monthly(ev, OLD_FROM, OLD_TO);
  const currentTrainMonthly = monthly(ev, CURRENT_FROM, TRAIN_TO);
  const oldPositiveMonths = oldMonthly.filter((x) => x.positive).length;
  const currentTrainPositiveMonths = currentTrainMonthly.filter((x) => x.positive).length;
  const minFreq = Math.min(old.stress.independentEventsPerDay, currentTrain.stress.independentEventsPerDay);
  const sampleEnough = old.stress.events >= 100 && currentTrain.stress.events >= 75;
  const discoveryRobust = sampleEnough
    && old.stress.net > 0
    && currentTrain.stress.net > 0
    && old.adverse.net > 0
    && currentTrain.adverse.net > 0
    && old.stress.pf >= 1.03
    && currentTrain.stress.pf >= 1.03
    && oldPositiveMonths >= 7
    && currentTrainPositiveMonths >= 5;
  const eligible = discoveryRobust && minFreq >= 8;
  const targetFrequencyQualified = discoveryRobust && minFreq >= 12;
  const minPf = Math.min(old.stress.pf, currentTrain.stress.pf);
  const minAvg = Math.min(old.stress.avgNet, currentTrain.stress.avgNet);
  const positiveRatio = ((oldPositiveMonths / 12) + (currentTrainPositiveMonths / 9)) / 2;
  const adverseMargin = Math.min(old.adverse.avgNet, currentTrain.adverse.avgNet);
  const score = minPf * Math.sqrt(Math.max(0.01, minFreq))
    * (1 + Math.max(-0.5, Math.min(2, minAvg * 1000)))
    * (0.5 + positiveRatio)
    * (1 + Math.max(-0.25, Math.min(1, adverseMargin * 500)));
  candidates.push({ c, old, currentTrain, evaluation, oldPositiveMonths, currentTrainPositiveMonths, oldMonthly, currentTrainMonthly, discoveryRobust, eligible, targetFrequencyQualified, score });
}

const diagnosticPool = candidates.filter((x) => x.old.base.events >= 100 && x.currentTrain.base.events >= 75);
const discoveryRobust = candidates.filter((x) => x.discoveryRobust).sort((a, b) => b.score - a.score);
const eligible = candidates.filter((x) => x.eligible).sort((a, b) => b.score - a.score);
const targetFrequencyQualified = candidates.filter((x) => x.targetFrequencyQualified).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 50);

const groupSummary = (field, values) => Object.fromEntries(values.map((value) => {
  const xs = diagnosticPool.filter((x) => x.c[field] === value);
  const best = [...xs].sort((a, b) => b.score - a.score)[0];
  return [String(value), {
    configs: xs.length,
    oldStressPositive: xs.filter((x) => x.old.stress.net > 0).length,
    currentTrainStressPositive: xs.filter((x) => x.currentTrain.stress.net > 0).length,
    bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
    bothAdversePositive: xs.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
    discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
    target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
    best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
  }];
}));

const diagnostics = {
  allSignalHours: allTimes.filter((t) => t >= OLD_FROM).length,
  featureRows: Object.fromEntries([...featureMap.entries()].map(([k, v]) => [String(k), v.length])),
  signalCaches: signalCache.size,
  candidates: candidates.length,
  eventfulConfigs: candidates.filter((x) => x.old.base.events + x.currentTrain.base.events + x.evaluation.base.events > 0).length,
  diagnosticPool: diagnosticPool.length,
  oldStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0).length,
  currentTrainStressPositive: diagnosticPool.filter((x) => x.currentTrain.stress.net > 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
  discoveryRobust: discoveryRobust.length,
  eligible8PerDay: eligible.length,
  target12PerDay: targetFrequencyQualified.length,
  byMode: groupSummary('mode', MODES),
  byProfileType: groupSummary('profileType', ['ABS', 'VOL']),
  byMarketFilter: groupSummary('marketFilter', MARKET_FILTERS),
  byLook: groupSummary('look', LOOKS),
};

const freezePool = eligible.length ? eligible : discoveryRobust;
const frozenRows = [];
const familyKeys = new Set();
for (const x of freezePool) {
  const family = `${x.c.look}:${x.c.profileType}:${x.c.mode}:${x.c.marketFilter}:${x.c.hold}`;
  if (familyKeys.has(family)) continue;
  familyKeys.add(family);
  frozenRows.push(x);
  if (frozenRows.length >= 3) break;
}

function combineEvents(rows) {
  const buckets = new Map();
  for (const x of rows) {
    for (const e of events(x.c)) {
      const key = `${e.symbol}:${e.entryAt}`;
      if (!buckets.has(key)) { buckets.set(key, e); continue; }
      const prev = buckets.get(key);
      if (prev === null) continue;
      if (prev.direction !== e.direction) { buckets.set(key, null); continue; }
      if (Math.abs(e.rawRet) > Math.abs(prev.rawRet)) buckets.set(key, e);
    }
  }
  return [...buckets.values()].filter(Boolean).sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol));
}

const frozenEvents = combineEvents(frozenRows);
const periodResult = (from, to) => ({
  base: stats(frozenEvents, from, to, 'base'),
  stress: stats(frozenEvents, from, to, 'stress'),
  adverse: stats(frozenEvents, from, to, 'adverse'),
});
const results = {
  old: periodResult(OLD_FROM, OLD_TO),
  currentTrain: periodResult(CURRENT_FROM, TRAIN_TO),
  evaluation: periodResult(TRAIN_TO, EVAL_TO),
};

const evaluationRobustRows = frozenRows.filter((x) => x.evaluation.stress.net > 0
  && x.evaluation.adverse.net > 0 && x.evaluation.stress.pf >= 1.0);
const evaluationTargetRows = evaluationRobustRows.filter((x) => x.evaluation.stress.independentEventsPerDay >= 12);

const compact = (x) => ({
  c: x.c,
  old: x.old,
  currentTrain: x.currentTrain,
  evaluation: x.evaluation,
  oldPositiveMonths: x.oldPositiveMonths,
  currentTrainPositiveMonths: x.currentTrainPositiveMonths,
  oldMonthly: x.oldMonthly,
  currentTrainMonthly: x.currentTrainMonthly,
  discoveryRobust: x.discoveryRobust,
  eligible: x.eligible,
  targetFrequencyQualified: x.targetFrequencyQualified,
  score: x.score,
});

const output = {
  periods: {
    old: [OLD_FROM, OLD_TO],
    currentTrain: [CURRENT_FROM, TRAIN_TO],
    evaluation: [TRAIN_TO, EVAL_TO],
  },
  symbols,
  grid: {
    candidates: candidates.length,
    looksHours: LOOKS,
    holdsHours: HOLDS,
    profiles: PROFILES,
    modes: MODES,
    marketFilters: MARKET_FILTERS,
  },
  diagnostics,
  eligible: eligible.length,
  targetFrequencyQualified: targetFrequencyQualified.length,
  frozen: frozenRows.map(compact),
  results,
  evaluationRobust: evaluationRobustRows.length,
  evaluationTarget: evaluationTargetRows.length,
  topNear: topNear.map(compact),
  topEligible: eligible.slice(0, 50).map(compact),
  topTargetFrequency: targetFrequencyQualified.slice(0, 50).map(compact),
  note: 'Cross-era long-horizon time-series momentum/reversal frontier. Signal is formed only from hourly opens already known at the signal hour. Lookbacks are 24/48/72/168h; scores are absolute return or return normalized by realized open-to-open volatility. TREND follows the sign and FADE is a diagnostic opposite sign. Optional MEDIAN/BROAD filters require contemporaneous market direction alignment. Entry is next hourly open; per-symbol busy windows prevent overlapping positions. Discovery/freeze uses only 2024-09..2025-08 and 2025-09..2026-05. 2026-06..2026-08 is untouched by parameter selection.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`LONG_HORIZON_MOMENTUM=${JSON.stringify({
  symbols,
  grid: output.grid,
  diagnostics,
  eligible: output.eligible,
  targetFrequencyQualified: output.targetFrequencyQualified,
  frozen: output.frozen.map((x) => x.c),
  results,
  evaluationRobust: output.evaluationRobust,
  evaluationTarget: output.evaluationTarget,
  topNear: output.topNear.slice(0, 12),
  topEligible: output.topEligible.slice(0, 12),
  topTargetFrequency: output.topTargetFrequency.slice(0, 12),
  note: output.note,
})}`);
