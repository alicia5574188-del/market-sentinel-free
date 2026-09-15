import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/residual-shock-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.0005;
const LOOKS = [1, 2, 4, 8, 12];
const HOLDS = [1, 2, 4, 8];
const RANKS = [1, 2, 3];
const MODES = ['FADE', 'FOLLOW'];
const FILTERS = ['ALL', 'ROBUST_2', 'ROBUST_3', 'ROBUST_4', 'SPREAD_30BP', 'SPREAD_60BP', 'SPREAD_100BP', 'SPREAD_150BP'];

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
const priceMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM && t < EVAL_TO);

function filterOk(id, signal) {
  if (id === 'ALL') return true;
  if (id === 'ROBUST_2') return signal.robust >= 2;
  if (id === 'ROBUST_3') return signal.robust >= 3;
  if (id === 'ROBUST_4') return signal.robust >= 4;
  if (id === 'SPREAD_30BP') return signal.spread >= 0.003;
  if (id === 'SPREAD_60BP') return signal.spread >= 0.006;
  if (id === 'SPREAD_100BP') return signal.spread >= 0.010;
  if (id === 'SPREAD_150BP') return signal.spread >= 0.015;
  return false;
}

const signalCache = new Map();
for (const look of LOOKS) {
  const cache = new Map();
  for (const t of allTimes) {
    const raw = [];
    for (const symbol of symbols) {
      const pm = priceMap.get(symbol);
      const p0 = pm.get(t - look * HOUR)?.open;
      const p1 = pm.get(t)?.open;
      const next = pm.get(t + HOUR)?.open;
      if (![p0, p1, next].every((v) => Number.isFinite(v) && v > 0)) continue;
      raw.push({ symbol, ret: p1 / p0 - 1 });
    }
    if (raw.length < 15) continue;
    const common = median(raw.map((x) => x.ret));
    const xs = raw.map((x) => ({ ...x, residual: x.ret - common })).sort((a, b) => a.residual - b.residual);
    const center = median(xs.map((x) => x.residual));
    const mad = median(xs.map((x) => Math.abs(x.residual - center))) || 1e-8;
    cache.set(t, { xs, common, mad });
  }
  signalCache.set(look, cache);
}

function eventFor(config, t) {
  const snapshot = signalCache.get(config.look)?.get(t);
  if (!snapshot) return null;
  const q = config.rank - 1;
  const low = snapshot.xs[q];
  const high = snapshot.xs[snapshot.xs.length - 1 - q];
  if (!low || !high || low.symbol === high.symbol) return null;
  const signal = {
    lowResidual: low.residual,
    highResidual: high.residual,
    spread: high.residual - low.residual,
    robust: (high.residual - low.residual) / Math.max(snapshot.mad, 1e-8),
    common: snapshot.common,
    mad: snapshot.mad,
  };
  if (!filterOk(config.filter, signal)) return null;

  const long = config.mode === 'FADE' ? low.symbol : high.symbol;
  const short = config.mode === 'FADE' ? high.symbol : low.symbol;
  const entryAt = t + HOUR;
  const exitAt = entryAt + config.hold * HOUR;
  if (exitAt > EVAL_TO) return null;
  const lp = priceMap.get(long);
  const sp = priceMap.get(short);
  const longEntry0 = lp.get(entryAt)?.open;
  const shortEntry0 = sp.get(entryAt)?.open;
  const longExit = lp.get(exitAt)?.open;
  const shortExit = sp.get(exitAt)?.open;
  if (![longEntry0, shortEntry0, longExit, shortExit].every((v) => Number.isFinite(v) && v > 0)) return null;

  const longEntry = longEntry0 * (1 + ENTRY_SLIP);
  const shortEntry = shortEntry0 * (1 - ENTRY_SLIP);
  const adverseLongEntry = longEntry0 * (1 + ADVERSE_SLIP);
  const adverseShortEntry = shortEntry0 * (1 - ADVERSE_SLIP);
  const gross = ((longExit / longEntry - 1) + (1 - shortExit / shortEntry)) / 2;
  const adverseGross = ((longExit / adverseLongEntry - 1) + (1 - shortExit / adverseShortEntry)) / 2;
  return {
    signalAt: t,
    entryAt,
    exitAt,
    long,
    short,
    pair: [long, short].sort().join('|'),
    look: config.look,
    hold: config.hold,
    rank: config.rank,
    mode: config.mode,
    filter: config.filter,
    signal,
    gross,
    base: gross - BASE_COST,
    stress: gross - STRESS_COST,
    adverse: adverseGross - BASE_COST,
    month: monthKey(entryAt),
  };
}

function events(config) {
  const out = [];
  const busy = new Map();
  for (const t of allTimes) {
    const e = eventFor(config, t);
    if (!e) continue;
    if ((busy.get(e.pair) ?? 0) > e.entryAt) continue;
    out.push(e);
    busy.set(e.pair, e.exitAt);
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
  return {
    events: xs.length,
    independentEventsPerDay: xs.length / days,
    orderLegEntriesPerDay: (2 * xs.length) / days,
    net,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    avgGross: xs.length ? sum(xs.map((e) => e.gross)) / xs.length : 0,
  };
}

function monthly(rows, from, to, field = 'stress') {
  const out = [];
  const keys = [...new Set(rows.filter((e) => e.entryAt >= from && e.entryAt < to).map((e) => e.month))].sort();
  for (const month of keys) {
    const xs = rows.filter((e) => e.month === month && e.entryAt >= from && e.exitAt <= to);
    const net = sum(xs.map((e) => e[field]));
    out.push({ month, events: xs.length, net, positive: net > 0 });
  }
  return out;
}

const candidates = [];
let candidateId = 0;
for (const look of LOOKS) for (const hold of HOLDS) for (const rank of RANKS) for (const mode of MODES) for (const filter of FILTERS) {
  const c = { id: `RS-${candidateId++}`, look, hold, rank, mode, filter };
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
  const eligible = old.base.events >= 600
    && currentTrain.base.events >= 400
    && old.stress.net > 0
    && currentTrain.stress.net > 0
    && old.adverse.net > 0
    && currentTrain.adverse.net > 0
    && old.stress.pf >= 1.05
    && currentTrain.stress.pf >= 1.08
    && old.base.avgNet >= 0.0004
    && currentTrain.base.avgNet >= 0.0004
    && oldPositiveMonths >= 8
    && currentTrainPositiveMonths >= 6;
  const minPf = Math.min(old.stress.pf, currentTrain.stress.pf);
  const minFreq = Math.min(old.stress.independentEventsPerDay, currentTrain.stress.independentEventsPerDay);
  const minAvg = Math.min(old.stress.avgNet, currentTrain.stress.avgNet);
  const score = minPf * Math.sqrt(Math.max(0.01, minFreq)) * (1 + Math.max(-0.5, Math.min(2, minAvg * 1000)));
  candidates.push({ c, old, currentTrain, evaluation, oldPositiveMonths, currentTrainPositiveMonths, oldMonthly, currentTrainMonthly, eligible, score });
}

const eligible = candidates.filter((x) => x.eligible).sort((a, b) => b.score - a.score);
const diagnosticPool = candidates.filter((x) => x.old.base.events >= 250 && x.currentTrain.base.events >= 180);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 40);
const diagnostics = {
  allSignalHours: allTimes.length,
  signalHoursByLook: Object.fromEntries(LOOKS.map((look) => [look, signalCache.get(look).size])),
  eventfulConfigs: candidates.filter((x) => x.old.base.events + x.currentTrain.base.events + x.evaluation.base.events > 0).length,
  diagnosticPool: diagnosticPool.length,
  oldStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0).length,
  currentTrainStressPositive: diagnosticPool.filter((x) => x.currentTrain.stress.net > 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
  byMode: Object.fromEntries(MODES.map((mode) => {
    const xs = diagnosticPool.filter((x) => x.c.mode === mode);
    const best = [...xs].sort((a, b) => b.score - a.score)[0];
    return [mode, {
      configs: xs.length,
      bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
      best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
    }];
  })),
};

// Freeze using discovery periods only. Evaluation is never referenced here.
const frozenMap = new Map();
for (const x of eligible) {
  const key = `${x.c.mode}:${x.c.rank}`;
  if (!frozenMap.has(key)) frozenMap.set(key, x);
}
const frozen = [...frozenMap.values()].sort((a, b) => a.c.mode.localeCompare(b.c.mode) || a.c.rank - b.c.rank);
const eventMap = new Map(frozen.map((x) => [x.c.id, events(x.c)]));

function unionStats(rows, from, to, field = 'base') {
  const all = [];
  for (const x of rows) {
    for (const e of eventMap.get(x.c.id) ?? []) {
      if (e.entryAt >= from && e.exitAt <= to) all.push({ ...e, engine: x.c.id });
    }
  }
  all.sort((a, b) => a.entryAt - b.entryAt || a.pair.localeCompare(b.pair) || a.engine.localeCompare(b.engine));
  const seen = new Set();
  const unique = [];
  for (const e of all) {
    const key = `${e.entryAt}:${e.pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return {
    raw: stats(all, from, to, field),
    unique: stats(unique, from, to, field),
    overlapRate: all.length ? 1 - unique.length / all.length : 0,
  };
}

const pack = (rows) => ({
  old: {
    base: unionStats(rows, OLD_FROM, OLD_TO),
    stress: unionStats(rows, OLD_FROM, OLD_TO, 'stress'),
    adverse: unionStats(rows, OLD_FROM, OLD_TO, 'adverse'),
  },
  currentTrain: {
    base: unionStats(rows, CURRENT_FROM, TRAIN_TO),
    stress: unionStats(rows, CURRENT_FROM, TRAIN_TO, 'stress'),
    adverse: unionStats(rows, CURRENT_FROM, TRAIN_TO, 'adverse'),
  },
  evaluation: {
    base: unionStats(rows, TRAIN_TO, EVAL_TO),
    stress: unionStats(rows, TRAIN_TO, EVAL_TO, 'stress'),
    adverse: unionStats(rows, TRAIN_TO, EVAL_TO, 'adverse'),
  },
});

const evaluationRobust = frozen.filter((x) => x.evaluation.stress.net > 0 && x.evaluation.adverse.net > 0 && x.evaluation.stress.pf >= 1.05);
const report = {
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  symbols,
  grid: { candidates: candidateId, looksHours: LOOKS, holdsHours: HOLDS, ranks: RANKS, modes: MODES, filters: FILTERS },
  diagnostics,
  eligible: eligible.length,
  frozen: frozen.length,
  results: pack(frozen),
  evaluationRobust: evaluationRobust.length,
  evaluationRobustResults: pack(evaluationRobust),
  topNear,
  topEligible: eligible.slice(0, 100),
  frozenRows: frozen,
  note: 'Cross-era market-neutral residual-shock frontier. Signal uses cross-sectional open-to-open return minus same-hour median market return. Entry is the next hourly open, so the signal contains no future price. FADE and FOLLOW are tested symmetrically. Selection/freeze uses only 2024-09..2025-08 and 2025-09..2026-05; 2026-06..2026-08 is untouched evaluation. Frequency is reported as independent pair decisions/day; the two legs are reported separately and are not counted as two independent trades.',
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log('RESIDUAL_SHOCK=' + JSON.stringify({
  symbols: report.symbols,
  grid: report.grid,
  diagnostics: report.diagnostics,
  eligible: report.eligible,
  frozen: report.frozen,
  results: report.results,
  evaluationRobust: report.evaluationRobust,
  evaluationRobustResults: report.evaluationRobustResults,
  topNear: report.topNear.slice(0, 12),
  topEligible: report.topEligible.slice(0, 12),
  note: report.note,
}));
