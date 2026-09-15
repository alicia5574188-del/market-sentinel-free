import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/session-cycle-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.0005;
const LOOKS = [4, 12, 24];
const HOLDS = [1, 2, 4, 8];
const BASES = ['ABS', 'REL'];
const STATES = ['TREND', 'PULLBACK'];
const THRESHOLDS = [0.005, 0.010];
const MODES = ['FOLLOW', 'FADE'];
const SESSIONS = ['ALL', 'ASIA', 'EUROPE', 'US'];
const DAYTYPES = ['ALL', 'WEEKDAY', 'WEEKEND'];

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
const sessionOk = (session, t) => {
  if (session === 'ALL') return true;
  const h = new Date(t * 1000).getUTCHours();
  if (session === 'ASIA') return h >= 0 && h < 8;
  if (session === 'EUROPE') return h >= 8 && h < 16;
  if (session === 'US') return h >= 16 && h < 24;
  return false;
};
const daytypeOk = (daytype, t) => {
  if (daytype === 'ALL') return true;
  const day = new Date(t * 1000).getUTCDay();
  const weekend = day === 0 || day === 6;
  return daytype === 'WEEKEND' ? weekend : !weekend;
};

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, d.rows]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM && t < EVAL_TO);

const featureMap = new Map();
for (const look of LOOKS) {
  const absRows = [];
  const relRows = [];
  for (const t of allTimes) {
    const raw = [];
    for (const symbol of symbols) {
      const rm = rowMap.get(symbol);
      const p0 = rm.get(t - look * HOUR)?.open;
      const p1 = rm.get(t)?.open;
      const pPrev = rm.get(t - HOUR)?.open;
      if (![p0, p1, pPrev].every((v) => Number.isFinite(v) && v > 0)) continue;
      raw.push({ symbol, ret: p1 / p0 - 1, lastRet: p1 / pPrev - 1 });
    }
    if (raw.length < 15) continue;
    const market = median(raw.map((x) => x.ret));
    for (const x of raw) {
      const common = { symbol: x.symbol, signalAt: t, look, lastRet: x.lastRet, marketRet: market };
      absRows.push({ ...common, basis: 'ABS', score: x.ret });
      relRows.push({ ...common, basis: 'REL', score: x.ret - market });
    }
  }
  featureMap.set(`${look}:ABS`, absRows);
  featureMap.set(`${look}:REL`, relRows);
}

function signalOk(state, threshold, x) {
  if (Math.abs(x.score) < threshold) return false;
  if (state === 'TREND') return true;
  if (state === 'PULLBACK') {
    const s = Math.sign(x.score);
    const last = x.lastRet;
    return Math.sign(last) === -s
      && Math.abs(last) >= 0.0005
      && Math.abs(last) <= Math.max(0.0015, Math.abs(x.score) * 0.60);
  }
  return false;
}

const signalCache = new Map();
function signalsFor(config) {
  const key = `${config.look}:${config.basis}:${config.state}:${config.threshold}:${config.session}:${config.daytype}`;
  if (signalCache.has(key)) return signalCache.get(key);
  const source = featureMap.get(`${config.look}:${config.basis}`) ?? [];
  const rows = source.filter((x) => signalOk(config.state, config.threshold, x)
    && sessionOk(config.session, x.signalAt)
    && daytypeOk(config.daytype, x.signalAt));
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
    const baseDirection = Math.sign(x.score);
    if (!baseDirection) continue;
    const direction = config.mode === 'FOLLOW' ? baseDirection : -baseDirection;
    const gross = legReturn(x.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
    const adverseGross = legReturn(x.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
    if (![gross, adverseGross].every(Number.isFinite)) continue;
    out.push({
      ...x,
      entryAt,
      exitAt,
      direction,
      mode: config.mode,
      state: config.state,
      threshold: config.threshold,
      session: config.session,
      daytype: config.daytype,
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
for (const look of LOOKS) for (const basis of BASES) for (const state of STATES) for (const threshold of THRESHOLDS) for (const mode of MODES) for (const session of SESSIONS) for (const daytype of DAYTYPES) for (const hold of HOLDS) {
  const c = { id: `SC-${id++}`, look, basis, state, threshold, mode, session, daytype, hold };
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
const discoveryRobust = candidates.filter((x) => x.discoveryRobust).sort((a, b) => b.score - a.score);
const eligible = candidates.filter((x) => x.eligible).sort((a, b) => b.score - a.score);
const targetFrequencyQualified = candidates.filter((x) => x.targetFrequencyQualified).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 50);

const groupSummary = (field, values) => Object.fromEntries(values.map((value) => {
  const xs = diagnosticPool.filter((x) => x.c[field] === value);
  const best = [...xs].sort((a, b) => b.score - a.score)[0];
  return [value, {
    configs: xs.length,
    bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
    discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
    target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
    best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
  }];
}));

const diagnostics = {
  allSignalHours: allTimes.length,
  featureRows: Object.fromEntries([...featureMap.entries()].map(([k, v]) => [k, v.length])),
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
  byBasis: groupSummary('basis', BASES),
  byState: groupSummary('state', STATES),
  byMode: groupSummary('mode', MODES),
  bySession: groupSummary('session', SESSIONS),
  byDaytype: groupSummary('daytype', DAYTYPES),
};

// Freeze solely on discovery eras. Keep only one best config per orthogonal session/state/basis bucket.
const frozenMap = new Map();
for (const x of eligible) {
  const key = `${x.c.basis}:${x.c.state}:${x.c.session}:${x.c.daytype}`;
  if (!frozenMap.has(key)) frozenMap.set(key, x);
}
const frozen = [...frozenMap.values()].sort((a, b) => a.c.id.localeCompare(b.c.id));
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
    const dedupe = `${e.entryAt}:${e.symbol}:${e.direction}`;
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
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  symbols,
  grid: { candidates: candidates.length, looksHours: LOOKS, holdsHours: HOLDS, bases: BASES, states: STATES, thresholds: THRESHOLDS, modes: MODES, sessions: SESSIONS, daytypes: DAYTYPES },
  diagnostics,
  eligible: eligible.length,
  targetFrequencyQualified: targetFrequencyQualified.length,
  frozen: frozen.map((x) => ({ c: x.c, score: x.score, old: x.old, currentTrain: x.currentTrain, evaluation: x.evaluation })),
  results,
  evaluationRobust,
  evaluationTarget,
  topNear,
  topEligible: eligible.slice(0, 40),
  topTargetFrequency: targetFrequencyQualified.slice(0, 40),
  note: 'Cross-era recurring-session frontier. Signal uses only open prices known at the signal hour. ABS tests raw 4/12/24h trend; REL removes same-hour cross-sectional median market return. TREND enters on persistent displacement; PULLBACK requires the last hour to move against the larger trend before entry. FOLLOW and FADE are symmetric. Sessions are fixed UTC 8-hour blocks plus ALL, with weekday/weekend split. Entry is the next hourly open; no future price is used. Discovery/freeze uses 2024-09..2025-08 and 2025-09..2026-05 only. 2026-06..2026-08 remains untouched evaluation. Frequency counts independent symbol decisions.',
};

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`SESSION_CYCLE=${JSON.stringify({ symbols, grid: report.grid, diagnostics, eligible: report.eligible, targetFrequencyQualified: report.targetFrequencyQualified, frozen: report.frozen, results, evaluationRobust, evaluationTarget, topNear: topNear.slice(0, 12), topEligible: report.topEligible.slice(0, 12), topTargetFrequency: report.topTargetFrequency.slice(0, 12), note: report.note })}`);
