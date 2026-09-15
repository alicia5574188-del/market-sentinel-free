import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/cross-sectional-basket-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

const LOOKS = [24, 48, 72, 168];
const PERIODS = [4, 8, 12, 24];
const TOPKS = [1, 2, 3];
const SCORE_TYPES = ['RAW', 'VOL'];
const MODES = ['MOMENTUM', 'REVERSAL'];
const SPREAD_PROFILES = [
  { id: 'ANY', threshold: 0 },
  { id: 'SPREAD_2', threshold: 0.02 },
  { id: 'SPREAD_4', threshold: 0.04 },
];

const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : 0;
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
  .filter((t) => t >= OLD_FROM - 180 * HOUR && t < EVAL_TO);

const snapshotMap = new Map();
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
    snapshots.push({ signalAt: t, rows });
  }
  snapshotMap.set(look, snapshots);
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const entry0 = rm.get(entryAt)?.open;
  const exit = rm.get(exitAt)?.open;
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

const eventCache = new Map();
function events(config) {
  const key = `${config.look}:${config.period}:${config.topK}:${config.scoreType}:${config.mode}:${config.spreadProfile}`;
  if (eventCache.has(key)) return eventCache.get(key);
  const threshold = SPREAD_PROFILES.find((p) => p.id === config.spreadProfile).threshold;
  const source = snapshotMap.get(config.look) ?? [];
  const out = [];
  for (const snap of source) {
    const offset = Math.round((snap.signalAt - OLD_FROM) / HOUR);
    if (offset < 0 || offset % config.period !== 0) continue;
    const ranked = [...snap.rows].sort((a, b) => {
      const sa = config.scoreType === 'RAW' ? a.rawRet : a.volScore;
      const sb = config.scoreType === 'RAW' ? b.rawRet : b.volScore;
      return sb - sa || a.symbol.localeCompare(b.symbol);
    });
    if (ranked.length < Math.max(15, config.topK * 2)) continue;
    const top = ranked.slice(0, config.topK);
    const bottom = ranked.slice(-config.topK);
    const rawSpread = mean(top.map((x) => x.rawRet)) - mean(bottom.map((x) => x.rawRet));
    if (rawSpread < threshold) continue;

    const entryAt = snap.signalAt + HOUR;
    const exitAt = entryAt + config.period * HOUR;
    if (exitAt > EVAL_TO) continue;
    const topDirection = config.mode === 'MOMENTUM' ? 1 : -1;
    const bottomDirection = -topDirection;
    const legs = [
      ...top.map((x) => ({ symbol: x.symbol, direction: topDirection, rankSide: 'TOP', rawRet: x.rawRet, score: config.scoreType === 'RAW' ? x.rawRet : x.volScore })),
      ...bottom.map((x) => ({ symbol: x.symbol, direction: bottomDirection, rankSide: 'BOTTOM', rawRet: x.rawRet, score: config.scoreType === 'RAW' ? x.rawRet : x.volScore })),
    ];
    const baseLegReturns = [];
    const adverseLegReturns = [];
    let valid = true;
    for (const leg of legs) {
      const gross = legReturn(leg.symbol, leg.direction, entryAt, exitAt, ENTRY_SLIP);
      const adverseGross = legReturn(leg.symbol, leg.direction, entryAt, exitAt, ADVERSE_SLIP);
      if (![gross, adverseGross].every(Number.isFinite)) { valid = false; break; }
      baseLegReturns.push(gross);
      adverseLegReturns.push(adverseGross);
    }
    if (!valid) continue;
    const gross = mean(baseLegReturns);
    const adverseGross = mean(adverseLegReturns);
    out.push({
      signalAt: snap.signalAt,
      entryAt,
      exitAt,
      look: config.look,
      period: config.period,
      topK: config.topK,
      scoreType: config.scoreType,
      mode: config.mode,
      spreadProfile: config.spreadProfile,
      rawSpread,
      orderLegs: legs.length,
      legs,
      gross,
      base: gross - BASE_COST,
      stress: gross - STRESS_COST,
      adverse: adverseGross - BASE_COST,
      month: monthKey(entryAt),
    });
  }
  eventCache.set(key, out);
  return out;
}

function stats(rows, from, to, field = 'base') {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(xs.map((e) => e[field]));
  const days = (to - from) / DAY;
  const orderLegs = sum(xs.map((e) => e.orderLegs));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt)) {
    equity += e[field];
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const netPerDay = days ? net / days : 0;
  return {
    events: xs.length,
    independentEventsPerDay: days ? xs.length / days : 0,
    orderLegEntries: orderLegs,
    orderLegEntriesPerDay: days ? orderLegs / days : 0,
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
    avgGross: xs.length ? mean(xs.map((e) => e.gross)) : 0,
  };
}

function monthly(rows, from, to, field = 'stress') {
  return monthKeys(from, to).map((month) => {
    const xs = rows.filter((e) => e.month === month && e.entryAt >= from && e.exitAt <= to);
    const net = sum(xs.map((e) => e[field]));
    return { month, events: xs.length, orderLegEntries: sum(xs.map((e) => e.orderLegs)), net, positive: net > 0 };
  });
}

const candidates = [];
let id = 0;
for (const look of LOOKS) for (const period of PERIODS) for (const topK of TOPKS) for (const scoreType of SCORE_TYPES) for (const mode of MODES) for (const spreadProfile of SPREAD_PROFILES.map((p) => p.id)) {
  const c = { id: `CSB-${id++}`, look, period, topK, scoreType, mode, spreadProfile };
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
  const minIndependent = Math.min(old.stress.independentEventsPerDay, currentTrain.stress.independentEventsPerDay);
  const minLegFrequency = Math.min(old.stress.orderLegEntriesPerDay, currentTrain.stress.orderLegEntriesPerDay);
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
  // Basket frequency is reported honestly in two units: independent alpha decisions and executable legs.
  // A robust basket is usable if it makes >=2 independent decisions/day and >=8 executable legs/day.
  const eligible = discoveryRobust && minIndependent >= 2 && minLegFrequency >= 8;
  const targetFrequencyQualified = discoveryRobust && minIndependent >= 2 && minLegFrequency >= 12;
  const minPf = Math.min(old.stress.pf, currentTrain.stress.pf);
  const minAvg = Math.min(old.stress.avgNet, currentTrain.stress.avgNet);
  const positiveRatio = ((oldPositiveMonths / 12) + (currentTrainPositiveMonths / 9)) / 2;
  const adverseMargin = Math.min(old.adverse.avgNet, currentTrain.adverse.avgNet);
  const score = minPf * Math.sqrt(Math.max(0.01, minIndependent))
    * Math.sqrt(Math.max(1, minLegFrequency))
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
    eligible: xs.filter((x) => x.eligible).length,
    target12LegsPerDay: xs.filter((x) => x.targetFrequencyQualified).length,
    best: best ? {
      c: best.c,
      score: best.score,
      old: best.old,
      currentTrain: best.currentTrain,
      oldPositiveMonths: best.oldPositiveMonths,
      currentTrainPositiveMonths: best.currentTrainPositiveMonths,
    } : null,
  }];
}));

const diagnostics = {
  allSignalHours: allTimes.filter((t) => t >= OLD_FROM).length,
  snapshots: Object.fromEntries([...snapshotMap.entries()].map(([k, v]) => [String(k), v.length])),
  eventCaches: eventCache.size,
  candidates: candidates.length,
  eventfulConfigs: candidates.filter((x) => x.old.base.events + x.currentTrain.base.events + x.evaluation.base.events > 0).length,
  diagnosticPool: diagnosticPool.length,
  oldStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0).length,
  currentTrainStressPositive: diagnosticPool.filter((x) => x.currentTrain.stress.net > 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
  discoveryRobust: discoveryRobust.length,
  eligibleBasketConfigs: eligible.length,
  target12LegEntriesPerDay: targetFrequencyQualified.length,
  byMode: groupSummary('mode', MODES),
  byScoreType: groupSummary('scoreType', SCORE_TYPES),
  byLook: groupSummary('look', LOOKS),
  byPeriod: groupSummary('period', PERIODS),
  byTopK: groupSummary('topK', TOPKS),
};

// Freeze only from discovery periods. Evaluation is computed into the artifact but never printed
// or consulted unless discoveryRobust > 0.
const freezePool = eligible.length ? eligible : discoveryRobust;
const frozenRows = [];
const familyKeys = new Set();
for (const x of freezePool) {
  const family = `${x.c.look}:${x.c.period}:${x.c.topK}:${x.c.scoreType}:${x.c.mode}`;
  if (familyKeys.has(family)) continue;
  familyKeys.add(family);
  frozenRows.push(x);
  if (frozenRows.length >= 3) break;
}

const evaluationRobustRows = frozenRows.filter((x) => x.evaluation.stress.net > 0
  && x.evaluation.adverse.net > 0 && x.evaluation.stress.pf >= 1.0);
const evaluationTargetRows = evaluationRobustRows.filter((x) => x.evaluation.stress.orderLegEntriesPerDay >= 12);

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
    rebalanceHoldHours: PERIODS,
    topKPerSide: TOPKS,
    scoreTypes: SCORE_TYPES,
    modes: MODES,
    spreadProfiles: SPREAD_PROFILES,
  },
  diagnostics,
  eligible: eligible.length,
  targetFrequencyQualified: targetFrequencyQualified.length,
  frozen: frozenRows.map(compact),
  evaluationRobust: evaluationRobustRows.length,
  evaluationTarget: evaluationTargetRows.length,
  topNear: topNear.map(compact),
  topEligible: eligible.slice(0, 50).map(compact),
  topTargetFrequency: targetFrequencyQualified.slice(0, 50).map(compact),
  note: 'Cross-era cross-sectional market-neutral basket frontier. At each deterministic rebalance signal, contracts are ranked by trailing 24/48/72/168h RAW return or return normalized by realized open-to-open volatility. MOMENTUM is long top-K/short bottom-K; REVERSAL flips both sides. Equal-weight basket PnL removes common market direction by construction. Signal uses only opens known at the signal hour; entry is next hourly open; hold equals rebalance period so baskets do not overlap. Frequency reports independent basket decisions separately from executable leg entries and never counts legs as independent alpha decisions. Discovery/freeze uses only 2024-09..2025-08 and 2025-09..2026-05. The 2026-06..2026-08 evaluation is stored but must remain unopened unless discovery robustness is passed.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`CROSS_SECTIONAL_BASKET_DISCOVERY=${JSON.stringify({
  periods: { old: output.periods.old, currentTrain: output.periods.currentTrain },
  symbols,
  grid: output.grid,
  diagnostics,
  eligible: output.eligible,
  targetFrequencyQualified: output.targetFrequencyQualified,
  frozen: output.frozen.map((x) => ({
    c: x.c, old: x.old, currentTrain: x.currentTrain,
    oldPositiveMonths: x.oldPositiveMonths, currentTrainPositiveMonths: x.currentTrainPositiveMonths, score: x.score,
  })),
  topNear: output.topNear.slice(0, 12).map((x) => ({
    c: x.c, old: x.old, currentTrain: x.currentTrain,
    oldPositiveMonths: x.oldPositiveMonths, currentTrainPositiveMonths: x.currentTrainPositiveMonths, score: x.score,
  })),
  topEligible: output.topEligible.slice(0, 12).map((x) => ({
    c: x.c, old: x.old, currentTrain: x.currentTrain,
    oldPositiveMonths: x.oldPositiveMonths, currentTrainPositiveMonths: x.currentTrainPositiveMonths, score: x.score,
  })),
  note: output.note,
})}`);
