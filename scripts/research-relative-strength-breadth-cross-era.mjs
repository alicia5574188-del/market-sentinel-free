import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/relative-strength-breadth-cross-era.json';
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
  { id: 'R15', rankCut: 0.15, minResidual: 0 },
  { id: 'R25', rankCut: 0.25, minResidual: 0 },
  { id: 'R25_R005', rankCut: 0.25, minResidual: 0.005 },
  { id: 'R25_R010', rankCut: 0.25, minResidual: 0.010 },
  { id: 'R35_R010', rankCut: 0.35, minResidual: 0.010 },
  { id: 'R35_R020', rankCut: 0.35, minResidual: 0.020 },
];
const MODES = ['FOLLOW', 'FADE'];
const STRUCTURE_FILTERS = ['NONE', 'MKT_ALIGN', 'BREADTH60', 'DUAL_MKT', 'REL_PERSIST', 'FULL_ALIGN'];
const CORE = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'];

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
for (const s of CORE) if (!rowsBySymbol.has(s)) throw new Error(`Missing core symbol ${s}`);

const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM - 200 * HOUR && t < EVAL_TO);

function crossSection(t, look) {
  const rows = [];
  for (const symbol of symbols) {
    const rm = rowMap.get(symbol);
    const p0 = rm.get(t - look * HOUR)?.open;
    const p1 = rm.get(t)?.open;
    if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
    rows.push({ symbol, rawRet: p1 / p0 - 1 });
  }
  if (rows.length < 15) return null;
  const marketRet = median(rows.map((x) => x.rawRet));
  const positiveBreadth = rows.filter((x) => x.rawRet > 0).length / rows.length;
  const negativeBreadth = rows.filter((x) => x.rawRet < 0).length / rows.length;
  const coreRows = rows.filter((x) => CORE.includes(x.symbol));
  if (coreRows.length !== CORE.length) return null;
  const coreMedian = median(coreRows.map((x) => x.rawRet));
  const sorted = [...rows].sort((a, b) => a.rawRet - b.rawRet);
  const rank = new Map(sorted.map((x, i) => [x.symbol, sorted.length === 1 ? 0.5 : i / (sorted.length - 1)]));
  return { rows, marketRet, positiveBreadth, negativeBreadth, coreMedian, rank };
}

const state24 = new Map();
const state72 = new Map();
for (const t of allTimes) {
  if (t < OLD_FROM) continue;
  const x24 = crossSection(t, 24);
  const x72 = crossSection(t, 72);
  if (x24) state24.set(t, x24);
  if (x72) state72.set(t, x72);
}

const featureMap = new Map();
for (const look of LOOKS) {
  const features = [];
  for (const t of allTimes) {
    if (t < OLD_FROM) continue;
    const cs = crossSection(t, look);
    const s24 = state24.get(t);
    const s72 = state72.get(t);
    if (!cs || !s24 || !s72) continue;
    const by24 = new Map(s24.rows.map((x) => [x.symbol, x]));
    const by72 = new Map(s72.rows.map((x) => [x.symbol, x]));
    for (const x of cs.rows) {
      const rankPct = cs.rank.get(x.symbol);
      if (!Number.isFinite(rankPct)) continue;
      const residual = x.rawRet - cs.marketRet;
      const direction = residual > 0 ? 1 : residual < 0 ? -1 : 0;
      if (!direction) continue;
      const r24 = by24.get(x.symbol);
      const r72 = by72.get(x.symbol);
      if (!r24 || !r72) continue;
      const residual24 = r24.rawRet - s24.marketRet;
      const residual72 = r72.rawRet - s72.marketRet;
      features.push({
        symbol: x.symbol,
        signalAt: t,
        look,
        rawRet: x.rawRet,
        marketRet: cs.marketRet,
        residual,
        rankPct,
        direction,
        directionBreadth: direction > 0 ? cs.positiveBreadth : cs.negativeBreadth,
        market24: s24.marketRet,
        market72: s72.marketRet,
        breadth24: direction > 0 ? s24.positiveBreadth : s24.negativeBreadth,
        breadth72: direction > 0 ? s72.positiveBreadth : s72.negativeBreadth,
        residual24,
        residual72,
        core24: s24.coreMedian,
        core72: s72.coreMedian,
      });
    }
  }
  features.sort((a, b) => a.signalAt - b.signalAt || a.symbol.localeCompare(b.symbol));
  featureMap.set(look, features);
}

function profileOk(profile, x) {
  const extreme = x.direction > 0 ? x.rankPct >= 1 - profile.rankCut : x.rankPct <= profile.rankCut;
  return extreme && Math.abs(x.residual) >= profile.minResidual;
}

function structureOk(filter, x) {
  if (filter === 'NONE') return true;
  const sign = x.direction;
  const align = (v) => Math.sign(v) === sign;
  if (filter === 'MKT_ALIGN') return align(x.marketRet);
  if (filter === 'BREADTH60') return align(x.marketRet) && x.directionBreadth >= 0.60;
  if (filter === 'DUAL_MKT') return align(x.market24) && align(x.market72)
    && x.breadth24 >= 0.55 && x.breadth72 >= 0.55;
  if (filter === 'REL_PERSIST') return align(x.residual24) && align(x.residual72);
  if (filter === 'FULL_ALIGN') return align(x.market24) && align(x.market72)
    && x.breadth24 >= 0.55 && x.breadth72 >= 0.55
    && align(x.residual24) && align(x.residual72)
    && align(x.core24) && align(x.core72);
  return false;
}

const signalCache = new Map();
function signalsFor(config) {
  const key = `${config.look}:${config.profileId}:${config.mode}:${config.structureFilter}`;
  if (signalCache.has(key)) return signalCache.get(key);
  const profile = PROFILES.find((p) => p.id === config.profileId);
  const source = featureMap.get(config.look) ?? [];
  const rows = source.filter((x) => profileOk(profile, x) && structureOk(config.structureFilter, x));
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

function events(config, maxTo = TRAIN_TO) {
  const rows = signalsFor(config);
  const out = [];
  const busy = new Map();
  for (const x of rows) {
    const entryAt = x.signalAt + HOUR;
    const exitAt = entryAt + config.hold * HOUR;
    if (exitAt > maxTo) continue;
    if ((busy.get(x.symbol) ?? 0) > entryAt) continue;
    const direction = config.mode === 'FOLLOW' ? x.direction : -x.direction;
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
      structureFilter: config.structureFilter,
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
for (const look of LOOKS) for (const profile of PROFILES) for (const mode of MODES)
  for (const structureFilter of STRUCTURE_FILTERS) for (const hold of HOLDS) {
    const c = {
      id: `RSB-${id++}`,
      look,
      profileId: profile.id,
      rankCut: profile.rankCut,
      minResidual: profile.minResidual,
      mode,
      structureFilter,
      hold,
    };
    const ev = events(c, TRAIN_TO);
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
    candidates.push({
      c, old, currentTrain, oldPositiveMonths, currentTrainPositiveMonths,
      oldMonthly, currentTrainMonthly, discoveryRobust, eligible,
      targetFrequencyQualified, score,
    });
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
    best: best ? {
      c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain,
      oldPositiveMonths: best.oldPositiveMonths, currentTrainPositiveMonths: best.currentTrainPositiveMonths,
    } : null,
  }];
}));

const diagnostics = {
  candidates: candidates.length,
  eventfulConfigs: candidates.filter((x) => x.old.base.events + x.currentTrain.base.events > 0).length,
  diagnosticPool: diagnosticPool.length,
  oldStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0).length,
  currentTrainStressPositive: diagnosticPool.filter((x) => x.currentTrain.stress.net > 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
  discoveryRobust: discoveryRobust.length,
  eligible8PerDay: eligible.length,
  target12PerDay: targetFrequencyQualified.length,
  byLook: groupSummary('look', LOOKS),
  byMode: groupSummary('mode', MODES),
  byStructure: groupSummary('structureFilter', STRUCTURE_FILTERS),
  byHold: groupSummary('hold', HOLDS),
};

const compactDiscovery = (x) => ({
  c: x.c,
  old: x.old,
  currentTrain: x.currentTrain,
  oldPositiveMonths: x.oldPositiveMonths,
  currentTrainPositiveMonths: x.currentTrainPositiveMonths,
  oldMonthly: x.oldMonthly,
  currentTrainMonthly: x.currentTrainMonthly,
  discoveryRobust: x.discoveryRobust,
  eligible: x.eligible,
  targetFrequencyQualified: x.targetFrequencyQualified,
  score: x.score,
});

let evaluationOpened = false;
let frozen = [];
let results = null;
let evaluationRobust = null;
let evaluationTarget = null;

if (discoveryRobust.length) {
  const freezePool = eligible.length ? eligible : discoveryRobust;
  const familyKeys = new Set();
  for (const x of freezePool) {
    const family = `${x.c.look}:${x.c.profileId}:${x.c.mode}:${x.c.structureFilter}:${x.c.hold}`;
    if (familyKeys.has(family)) continue;
    familyKeys.add(family);
    frozen.push(x);
    if (frozen.length >= 3) break;
  }
  evaluationOpened = true;

  function combineEvents(rows, maxTo) {
    const buckets = new Map();
    for (const x of rows) {
      for (const e of events(x.c, maxTo)) {
        const key = `${e.symbol}:${e.entryAt}`;
        if (!buckets.has(key)) { buckets.set(key, e); continue; }
        const prev = buckets.get(key);
        if (prev === null) continue;
        if (prev.direction !== e.direction) { buckets.set(key, null); continue; }
        if (Math.abs(e.residual) > Math.abs(prev.residual)) buckets.set(key, e);
      }
    }
    return [...buckets.values()].filter(Boolean)
      .sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol));
  }

  const frozenEvents = combineEvents(frozen, EVAL_TO);
  const periodResult = (from, to) => ({
    base: stats(frozenEvents, from, to, 'base'),
    stress: stats(frozenEvents, from, to, 'stress'),
    adverse: stats(frozenEvents, from, to, 'adverse'),
  });
  results = {
    old: periodResult(OLD_FROM, OLD_TO),
    currentTrain: periodResult(CURRENT_FROM, TRAIN_TO),
    evaluation: periodResult(TRAIN_TO, EVAL_TO),
  };

  const perFrozenEvaluation = frozen.map((x) => {
    const ev = events(x.c, EVAL_TO);
    return {
      c: x.c,
      evaluation: {
        base: stats(ev, TRAIN_TO, EVAL_TO),
        stress: stats(ev, TRAIN_TO, EVAL_TO, 'stress'),
        adverse: stats(ev, TRAIN_TO, EVAL_TO, 'adverse'),
      },
    };
  });
  evaluationRobust = perFrozenEvaluation.filter((x) =>
    x.evaluation.stress.net > 0 && x.evaluation.adverse.net > 0 && x.evaluation.stress.pf >= 1.0).length;
  evaluationTarget = perFrozenEvaluation.filter((x) =>
    x.evaluation.stress.net > 0 && x.evaluation.adverse.net > 0
    && x.evaluation.stress.pf >= 1.0 && x.evaluation.stress.independentEventsPerDay >= 12).length;
}

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
    profiles: PROFILES,
    modes: MODES,
    structureFilters: STRUCTURE_FILTERS,
    holdsHours: HOLDS,
  },
  diagnostics,
  eligible: eligible.length,
  targetFrequencyQualified: targetFrequencyQualified.length,
  evaluationOpened,
  frozen: frozen.map(compactDiscovery),
  results,
  evaluationRobust,
  evaluationTarget,
  topNear: topNear.map(compactDiscovery),
  topEligible: eligible.slice(0, 50).map(compactDiscovery),
  topTargetFrequency: targetFrequencyQualified.slice(0, 50).map(compactDiscovery),
  note: 'Cross-era relative-strength x market-structure frontier. Signal is cross-sectional residual strength/weakness after removing the contemporaneous market median over 24/48/72/168h, with rank extremes and optional residual magnitude. Structure filters independently test market alignment, directional breadth, dual-horizon market trend, residual persistence, and full market+core alignment. Decision uses only information available at signalAt; entry is next hourly open. Per-symbol busy windows prevent overlap. Discovery gate uses only 2024-09..2025-08 and 2025-09..2026-05. The 2026-06..2026-08 holdout is not even evaluated unless at least one rule passes the predeclared discovery robustness gate, preventing failed families from repeatedly peeking at holdout results.',
};

writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`RELATIVE_STRENGTH_BREADTH=${JSON.stringify({
  symbols,
  grid: output.grid,
  diagnostics,
  eligible: output.eligible,
  targetFrequencyQualified: output.targetFrequencyQualified,
  evaluationOpened,
  frozen: output.frozen.map((x) => x.c),
  results,
  evaluationRobust,
  evaluationTarget,
  topNear: output.topNear.slice(0, 12),
  topEligible: output.topEligible.slice(0, 12),
  topTargetFrequency: output.topTargetFrequency.slice(0, 12),
  note: output.note,
})}`);
