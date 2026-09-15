import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/absorption-reversal-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.0005;
const STRUCTURE_LOOKBACKS = [6, 12, 24, 48];
const HOLDS = [1, 2, 4, 8];
const FAILURES = ['INSTANT_WICK', 'CONFIRM_INSIDE', 'CONFIRM_MID'];
const FILTERS = ['ALL', 'NOT_BROAD', 'IDIO'];
const PROFILES = [
  { id: 'LOOSE', minRangeMult: 1.5, minExcursion: 0.004, minVolumeMult: 0, minBreach: 0 },
  { id: 'CLEAN', minRangeMult: 2.0, minExcursion: 0.006, minVolumeMult: 0, minBreach: 0 },
  { id: 'VOLUME', minRangeMult: 1.5, minExcursion: 0.004, minVolumeMult: 1.5, minBreach: 0 },
  { id: 'STRONG', minRangeMult: 2.5, minExcursion: 0.008, minVolumeMult: 0, minBreach: 0 },
  { id: 'HARD_BREAK', minRangeMult: 2.0, minExcursion: 0.006, minVolumeMult: 0, minBreach: 0.001 },
  { id: 'CLIMAX', minRangeMult: 2.0, minExcursion: 0.010, minVolumeMult: 1.5, minBreach: 0 },
];

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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, d.rows]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const indexMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r, i) => [r.time, i]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM && t < EVAL_TO);

const marketAt = new Map();
for (const t of allTimes) {
  const rets = [];
  for (const symbol of symbols) {
    const row = rowMap.get(symbol).get(t);
    if (!row || !(row.open > 0 && row.close > 0)) continue;
    rets.push(row.close / row.open - 1);
  }
  if (rets.length < 15) continue;
  marketAt.set(t, {
    medianBody: median(rets),
    upBreadth: rets.filter((x) => x > 0).length / rets.length,
    downBreadth: rets.filter((x) => x < 0).length / rets.length,
  });
}

function primitiveFor(symbol, structureLookback, failure) {
  const rows = rowsBySymbol.get(symbol);
  const indices = indexMap.get(symbol);
  const out = [];
  for (const t of allTimes) {
    const i = indices.get(t);
    if (!Number.isInteger(i) || i < Math.max(structureLookback, 24)) continue;
    const shock = rows[i];
    const confirm = rows[i + 1];
    if (!shock || !confirm || confirm.time !== t + HOUR) continue;
    const history = rows.slice(i - structureLookback, i);
    const volHistory = rows.slice(i - 24, i);
    if (history.length !== structureLookback || volHistory.length !== 24) continue;
    const prevHigh = Math.max(...history.map((r) => r.high));
    const prevLow = Math.min(...history.map((r) => r.low));
    const medianRange = median(volHistory.map((r) => (r.high - r.low) / r.open));
    const medianVolume = median(volHistory.map((r) => r.volume));
    const range = shock.high - shock.low;
    if (!(prevHigh > 0 && prevLow > 0 && medianRange > 0 && range > 0 && shock.open > 0)) continue;
    const market = marketAt.get(t);
    if (!market) continue;
    const rangePct = range / shock.open;
    const rangeMult = rangePct / medianRange;
    const volumeMult = medianVolume > 0 ? shock.volume / medianVolume : 0;
    const closeLoc = (shock.close - shock.low) / range;
    const shockMid = (shock.high + shock.low) / 2;

    for (const dir of [1, -1]) {
      const breached = dir > 0 ? shock.high > prevHigh : shock.low < prevLow;
      if (!breached) continue;
      const breach = dir > 0 ? shock.high / prevHigh - 1 : prevLow / shock.low - 1;
      const excursion = dir > 0 ? shock.high / shock.open - 1 : 1 - shock.low / shock.open;
      if (!(excursion > 0 && breach >= 0)) continue;

      let failed = false;
      let entryAt = t + 2 * HOUR;
      if (failure === 'INSTANT_WICK') {
        failed = dir > 0
          ? shock.close < prevHigh && closeLoc <= 0.65
          : shock.close > prevLow && closeLoc >= 0.35;
        entryAt = t + HOUR;
      } else if (failure === 'CONFIRM_INSIDE') {
        const extension = dir > 0
          ? Math.max(0, confirm.high - shock.high) / range
          : Math.max(0, shock.low - confirm.low) / range;
        failed = extension <= 0.25 && (dir > 0 ? confirm.close < prevHigh : confirm.close > prevLow);
      } else if (failure === 'CONFIRM_MID') {
        failed = (dir > 0 ? confirm.close < Math.min(prevHigh, shockMid) : confirm.close > Math.max(prevLow, shockMid));
      }
      if (!failed) continue;
      const directionalBreadth = dir > 0 ? market.upBreadth : market.downBreadth;
      const directionalMarket = dir * market.medianBody;
      out.push({
        symbol,
        signalAt: failure === 'INSTANT_WICK' ? t : t + HOUR,
        shockAt: t,
        entryAt,
        dir,
        reversalDir: -dir,
        structureLookback,
        failure,
        rangeMult,
        volumeMult,
        breach,
        excursion,
        closeLoc,
        directionalBreadth,
        directionalMarket,
        marketMedianBody: market.medianBody,
        prevHigh,
        prevLow,
        shockHigh: shock.high,
        shockLow: shock.low,
        shockOpen: shock.open,
        shockClose: shock.close,
        confirmClose: confirm.close,
      });
    }
  }
  return out;
}

const primitive = new Map();
for (const structureLookback of STRUCTURE_LOOKBACKS) {
  for (const failure of FAILURES) {
    const key = `${structureLookback}:${failure}`;
    const xs = [];
    for (const symbol of symbols) xs.push(...primitiveFor(symbol, structureLookback, failure));
    xs.sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol));
    primitive.set(key, xs);
  }
}

function filterOk(filter, p) {
  if (filter === 'ALL') return true;
  if (filter === 'NOT_BROAD') return p.directionalBreadth <= 0.70;
  if (filter === 'IDIO') return p.directionalMarket <= p.excursion * 0.50;
  return false;
}

function profileOk(profile, p) {
  return p.rangeMult >= profile.minRangeMult
    && p.excursion >= profile.minExcursion
    && p.volumeMult >= profile.minVolumeMult
    && p.breach >= profile.minBreach;
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
  const source = primitive.get(`${config.structureLookback}:${config.failure}`) ?? [];
  const profile = PROFILES[config.profile];
  const out = [];
  const busy = new Map();
  for (const p of source) {
    if (!profileOk(profile, p) || !filterOk(config.filter, p)) continue;
    const exitAt = p.entryAt + config.hold * HOUR;
    if (exitAt > EVAL_TO) continue;
    if ((busy.get(p.symbol) ?? 0) > p.entryAt) continue;
    const gross = legReturn(p.symbol, p.reversalDir, p.entryAt, exitAt, ENTRY_SLIP);
    const adverseGross = legReturn(p.symbol, p.reversalDir, p.entryAt, exitAt, ADVERSE_SLIP);
    if (![gross, adverseGross].every(Number.isFinite)) continue;
    out.push({
      ...p,
      exitAt,
      hold: config.hold,
      profile: profile.id,
      filter: config.filter,
      gross,
      base: gross - BASE_COST,
      stress: gross - STRESS_COST,
      adverse: adverseGross - BASE_COST,
      orderLegs: 1,
      month: monthKey(p.entryAt),
    });
    busy.set(p.symbol, exitAt);
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
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt)) {
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
  const keys = [...new Set(rows.filter((e) => e.entryAt >= from && e.entryAt < to).map((e) => e.month))].sort();
  return keys.map((month) => {
    const xs = rows.filter((e) => e.month === month && e.entryAt >= from && e.exitAt <= to);
    const net = sum(xs.map((e) => e[field]));
    return { month, events: xs.length, net, positive: net > 0 };
  });
}

const candidates = [];
let id = 0;
for (const structureLookback of STRUCTURE_LOOKBACKS) for (const failure of FAILURES) for (let profile = 0; profile < PROFILES.length; profile += 1) for (const filter of FILTERS) for (const hold of HOLDS) {
  const c = { id: `AR-${id++}`, structureLookback, failure, profile, profileId: PROFILES[profile].id, filter, hold };
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
  const discoveryRobust = old.stress.net > 0
    && currentTrain.stress.net > 0
    && old.adverse.net > 0
    && currentTrain.adverse.net > 0
    && old.stress.pf >= 1.03
    && currentTrain.stress.pf >= 1.05
    && oldPositiveMonths >= 7
    && currentTrainPositiveMonths >= 5;
  const eligible = discoveryRobust && minFreq >= 8;
  const targetFrequencyQualified = discoveryRobust && minFreq >= 12;
  const minPf = Math.min(old.stress.pf, currentTrain.stress.pf);
  const minAvg = Math.min(old.stress.avgNet, currentTrain.stress.avgNet);
  const positiveRatio = ((oldPositiveMonths / 12) + (currentTrainPositiveMonths / 9)) / 2;
  const score = minPf * Math.sqrt(Math.max(0.01, minFreq)) * (1 + Math.max(-0.5, Math.min(2, minAvg * 1000))) * (0.5 + positiveRatio);
  candidates.push({ c, old, currentTrain, evaluation, oldPositiveMonths, currentTrainPositiveMonths, oldMonthly, currentTrainMonthly, discoveryRobust, eligible, targetFrequencyQualified, score });
}

const diagnosticPool = candidates.filter((x) => x.old.base.events >= 100 && x.currentTrain.base.events >= 75);
const eligible = candidates.filter((x) => x.eligible).sort((a, b) => b.score - a.score);
const targetFrequencyQualified = candidates.filter((x) => x.targetFrequencyQualified).sort((a, b) => b.score - a.score);
const discoveryRobust = candidates.filter((x) => x.discoveryRobust).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 40);

const diagnostics = {
  allSignalHours: allTimes.length,
  primitiveSignals: Object.fromEntries([...primitive.entries()].map(([k, v]) => [k, v.length])),
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
  byFailure: Object.fromEntries(FAILURES.map((failure) => {
    const xs = diagnosticPool.filter((x) => x.c.failure === failure);
    const best = [...xs].sort((a, b) => b.score - a.score)[0];
    return [failure, {
      configs: xs.length,
      bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
      discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
      target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
      best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
    }];
  })),
  byFilter: Object.fromEntries(FILTERS.map((filter) => {
    const xs = diagnosticPool.filter((x) => x.c.filter === filter);
    const best = [...xs].sort((a, b) => b.score - a.score)[0];
    return [filter, {
      configs: xs.length,
      bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
      discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
      target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
      best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
    }];
  })),
};

// Freeze only on discovery eras; untouched evaluation is not referenced here.
const frozenMap = new Map();
for (const x of eligible) {
  const key = `${x.c.failure}:${x.c.filter}`;
  if (!frozenMap.has(key)) frozenMap.set(key, x);
}
const frozen = [...frozenMap.values()].sort((a, b) => a.c.failure.localeCompare(b.c.failure) || a.c.filter.localeCompare(b.c.filter));
const eventMap = new Map(frozen.map((x) => [x.c.id, events(x.c)]));

function unionStats(rows, from, to, field = 'base') {
  const all = [];
  for (const x of rows) {
    for (const e of eventMap.get(x.c.id) ?? []) {
      if (e.entryAt >= from && e.exitAt <= to) all.push({ ...e, engine: x.c.id });
    }
  }
  all.sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol) || a.engine.localeCompare(b.engine));
  const seen = new Set();
  const unique = [];
  for (const e of all) {
    const dedupe = `${e.entryAt}:${e.symbol}:${e.reversalDir}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    unique.push(e);
  }
  return {
    raw: stats(all, from, to, field),
    unique: stats(unique, from, to, field),
    overlapRate: all.length ? 1 - unique.length / all.length : 0,
  };
}

const results = {
  old: {
    base: unionStats(frozen, OLD_FROM, OLD_TO),
    stress: unionStats(frozen, OLD_FROM, OLD_TO, 'stress'),
    adverse: unionStats(frozen, OLD_FROM, OLD_TO, 'adverse'),
  },
  currentTrain: {
    base: unionStats(frozen, CURRENT_FROM, TRAIN_TO),
    stress: unionStats(frozen, CURRENT_FROM, TRAIN_TO, 'stress'),
    adverse: unionStats(frozen, CURRENT_FROM, TRAIN_TO, 'adverse'),
  },
  evaluation: {
    base: unionStats(frozen, TRAIN_TO, EVAL_TO),
    stress: unionStats(frozen, TRAIN_TO, EVAL_TO, 'stress'),
    adverse: unionStats(frozen, TRAIN_TO, EVAL_TO, 'adverse'),
  },
};

const evaluationRobust = frozen.filter((x) => x.evaluation.stress.net > 0 && x.evaluation.adverse.net > 0 && x.evaluation.stress.pf > 1).length;
const evaluationTarget = frozen.filter((x) => x.evaluation.stress.net > 0 && x.evaluation.adverse.net > 0 && x.evaluation.stress.independentEventsPerDay >= 12).length;

const report = {
  periods: {
    old: [OLD_FROM, OLD_TO],
    currentTrain: [CURRENT_FROM, TRAIN_TO],
    evaluation: [TRAIN_TO, EVAL_TO],
  },
  symbols,
  grid: {
    candidates: candidates.length,
    structureLookbacksHours: STRUCTURE_LOOKBACKS,
    holdsHours: HOLDS,
    failures: FAILURES,
    filters: FILTERS,
    profiles: PROFILES,
  },
  diagnostics,
  eligible: eligible.length,
  targetFrequencyQualified: targetFrequencyQualified.length,
  frozen: frozen.map((x) => ({ c: x.c, score: x.score, old: x.old, currentTrain: x.currentTrain, evaluation: x.evaluation })),
  results,
  evaluationRobust,
  evaluationTarget,
  topNear,
  topEligible: eligible.slice(0, 30),
  topTargetFrequency: targetFrequencyQualified.slice(0, 30),
  note: 'Cross-era failed-shock / absorption-reversal frontier using hourly OHLCV only. A contract first breaches its prior 6/12/24/48h structure with abnormal range, excursion and optionally volume; reversal is permitted only after an observable failure (same-candle wick rejection, next-candle close back inside structure, or next-candle reclaim through shock midpoint). Entry is the next hourly open after failure is observable, so no future price is used. Discovery/freeze uses 2024-09..2025-08 and 2025-09..2026-05 only; 2026-06..2026-08 is untouched evaluation. Frequency counts independent symbol decisions, never order legs.',
};

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`ABSORPTION_REVERSAL=${JSON.stringify({ symbols, grid: report.grid, diagnostics, eligible: report.eligible, targetFrequencyQualified: report.targetFrequencyQualified, frozen: report.frozen, results, evaluationRobust, evaluationTarget, topNear: topNear.slice(0, 12), topEligible: report.topEligible.slice(0, 12), topTargetFrequency: report.topTargetFrequency.slice(0, 12), note: report.note })}`);
