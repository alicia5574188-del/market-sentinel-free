import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/leader-lag-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.0005;
const LOOKS = [1, 2, 4];
const HOLDS = [1, 2, 4, 8];
const LAG_RANKS = [1, 2];
const LEADER_SETS = ['CORE', 'ANY'];
const MODES = ['CATCHUP', 'PAIR', 'LEADER'];
const CORE_LEADERS = new Set(['BTC_USDT', 'ETH_USDT', 'SOL_USDT']);
const PROFILES = [
  { id: 'LOOSE', impulse: 0.0015, leaderExcess: 0.0015, breadth: 0.55, lagFloor: -0.010, lagMaxRatio: 1.00 },
  { id: 'CLEAN', impulse: 0.0030, leaderExcess: 0.0030, breadth: 0.60, lagFloor: -0.003, lagMaxRatio: 0.75 },
  { id: 'SAME_SIGN', impulse: 0.0030, leaderExcess: 0.0030, breadth: 0.65, lagFloor: 0.000, lagMaxRatio: 0.75 },
  { id: 'STRONG', impulse: 0.0050, leaderExcess: 0.0040, breadth: 0.65, lagFloor: -0.002, lagMaxRatio: 0.50 },
  { id: 'STRONG_SIGN', impulse: 0.0050, leaderExcess: 0.0040, breadth: 0.70, lagFloor: 0.000, lagMaxRatio: 0.50 },
  { id: 'EXTREME', impulse: 0.0080, leaderExcess: 0.0060, breadth: 0.75, lagFloor: -0.002, lagMaxRatio: 0.50 },
  { id: 'BROAD', impulse: 0.0030, leaderExcess: 0.0015, breadth: 0.75, lagFloor: -0.003, lagMaxRatio: 1.00 },
  { id: 'LEAD_HEAVY', impulse: 0.0015, leaderExcess: 0.0060, breadth: 0.55, lagFloor: -0.003, lagMaxRatio: 0.75 },
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
const priceMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM && t < EVAL_TO);

const snapshots = new Map();
for (const look of LOOKS) {
  const byTime = new Map();
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
    const market = median(raw.map((x) => x.ret));
    if (!Number.isFinite(market) || Math.abs(market) < 1e-9) continue;
    const sign = market > 0 ? 1 : -1;
    const directional = raw
      .map((x) => ({ ...x, directional: sign * x.ret }))
      .sort((a, b) => a.directional - b.directional);
    const breadth = directional.filter((x) => x.directional > 0).length / directional.length;
    const leaderAny = directional[directional.length - 1];
    const core = directional.filter((x) => CORE_LEADERS.has(x.symbol));
    const leaderCore = core.length ? core[core.length - 1] : null;
    byTime.set(t, {
      market,
      marketAbs: Math.abs(market),
      sign,
      breadth,
      directional,
      leaderAny,
      leaderCore,
    });
  }
  snapshots.set(look, byTime);
}

function profileOk(profile, snap, leader, lag) {
  if (!leader || !lag || leader.symbol === lag.symbol) return false;
  const leaderExcess = leader.directional - snap.marketAbs;
  if (snap.marketAbs < profile.impulse) return false;
  if (leaderExcess < profile.leaderExcess) return false;
  if (snap.breadth < profile.breadth) return false;
  if (lag.directional < profile.lagFloor) return false;
  if (lag.directional > snap.marketAbs * profile.lagMaxRatio) return false;
  if (leader.directional <= lag.directional) return false;
  return true;
}

function legReturn(symbol, sign, entryAt, exitAt, slip) {
  const pm = priceMap.get(symbol);
  const entry0 = pm.get(entryAt)?.open;
  const exit = pm.get(exitAt)?.open;
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = sign > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return sign > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function eventFor(config, t) {
  const snap = snapshots.get(config.look)?.get(t);
  if (!snap) return null;
  const leader = config.leaderSet === 'CORE' ? snap.leaderCore : snap.leaderAny;
  if (!leader) return null;
  const laggers = snap.directional.filter((x) => x.symbol !== leader.symbol);
  const lag = laggers[config.lagRank - 1];
  if (!lag) return null;
  const profile = PROFILES[config.profile];
  if (!profileOk(profile, snap, leader, lag)) return null;

  const entryAt = t + HOUR;
  const exitAt = entryAt + config.hold * HOUR;
  if (exitAt > EVAL_TO) return null;

  const direction = snap.sign;
  let gross = null;
  let adverseGross = null;
  let key = null;
  let orderLegs = 1;

  if (config.mode === 'CATCHUP') {
    gross = legReturn(lag.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
    adverseGross = legReturn(lag.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
    key = `${config.mode}:${lag.symbol}`;
  } else if (config.mode === 'LEADER') {
    gross = legReturn(leader.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
    adverseGross = legReturn(leader.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
    key = `${config.mode}:${leader.symbol}`;
  } else {
    const lagLeg = legReturn(lag.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
    const leaderLeg = legReturn(leader.symbol, -direction, entryAt, exitAt, ENTRY_SLIP);
    const adverseLag = legReturn(lag.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
    const adverseLeader = legReturn(leader.symbol, -direction, entryAt, exitAt, ADVERSE_SLIP);
    if (![lagLeg, leaderLeg, adverseLag, adverseLeader].every(Number.isFinite)) return null;
    gross = (lagLeg + leaderLeg) / 2;
    adverseGross = (adverseLag + adverseLeader) / 2;
    key = `${config.mode}:${[lag.symbol, leader.symbol].sort().join('|')}`;
    orderLegs = 2;
  }

  if (![gross, adverseGross].every(Number.isFinite)) return null;
  return {
    signalAt: t,
    entryAt,
    exitAt,
    key,
    orderLegs,
    leader: leader.symbol,
    lag: lag.symbol,
    direction,
    mode: config.mode,
    leaderSet: config.leaderSet,
    look: config.look,
    hold: config.hold,
    lagRank: config.lagRank,
    profile: profile.id,
    signal: {
      market: snap.market,
      marketAbs: snap.marketAbs,
      breadth: snap.breadth,
      leaderRet: leader.ret,
      lagRet: lag.ret,
      leaderDirectional: leader.directional,
      lagDirectional: lag.directional,
      leaderExcess: leader.directional - snap.marketAbs,
      leaderLagGap: leader.directional - lag.directional,
    },
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
    if ((busy.get(e.key) ?? 0) > e.entryAt) continue;
    out.push(e);
    busy.set(e.key, e.exitAt);
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
  const orderLegEntries = sum(xs.map((e) => e.orderLegs));
  const netPerDay = days ? net / days : 0;
  return {
    events: xs.length,
    independentEventsPerDay: days ? xs.length / days : 0,
    orderLegEntriesPerDay: days ? orderLegEntries / days : 0,
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
for (const look of LOOKS) for (const hold of HOLDS) for (const lagRank of LAG_RANKS) for (const leaderSet of LEADER_SETS) for (let profile = 0; profile < PROFILES.length; profile += 1) for (const mode of MODES) {
  const c = { id: `LL-${id++}`, look, hold, lagRank, leaderSet, profile, profileId: PROFILES[profile].id, mode };
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
  snapshotHoursByLook: Object.fromEntries(LOOKS.map((look) => [look, snapshots.get(look).size])),
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
  byMode: Object.fromEntries(MODES.map((mode) => {
    const xs = diagnosticPool.filter((x) => x.c.mode === mode);
    const best = [...xs].sort((a, b) => b.score - a.score)[0];
    return [mode, {
      configs: xs.length,
      bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
      discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
      target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
      best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
    }];
  })),
  byLeaderSet: Object.fromEntries(LEADER_SETS.map((leaderSet) => {
    const xs = diagnosticPool.filter((x) => x.c.leaderSet === leaderSet);
    const best = [...xs].sort((a, b) => b.score - a.score)[0];
    return [leaderSet, {
      configs: xs.length,
      discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
      target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
      best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
    }];
  })),
};

// Freeze only on the two discovery eras. The untouched evaluation era is not referenced here.
const frozenMap = new Map();
for (const x of eligible) {
  const key = `${x.c.mode}:${x.c.leaderSet}`;
  if (!frozenMap.has(key)) frozenMap.set(key, x);
}
const frozen = [...frozenMap.values()].sort((a, b) => a.c.mode.localeCompare(b.c.mode) || a.c.leaderSet.localeCompare(b.c.leaderSet));
const eventMap = new Map(frozen.map((x) => [x.c.id, events(x.c)]));

function unionStats(rows, from, to, field = 'base') {
  const all = [];
  for (const x of rows) {
    for (const e of eventMap.get(x.c.id) ?? []) {
      if (e.entryAt >= from && e.exitAt <= to) all.push({ ...e, engine: x.c.id });
    }
  }
  all.sort((a, b) => a.entryAt - b.entryAt || a.key.localeCompare(b.key) || a.engine.localeCompare(b.engine));
  const seen = new Set();
  const unique = [];
  for (const e of all) {
    const dedupe = `${e.entryAt}:${e.key}`;
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
    looksHours: LOOKS,
    holdsHours: HOLDS,
    lagRanks: LAG_RANKS,
    leaderSets: LEADER_SETS,
    modes: MODES,
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
  note: 'Cross-era leader-lag propagation frontier. Signal is formed only from open prices known at the signal hour. Entry is the next hourly open. CORE means BTC/ETH/SOL must be the leader; ANY allows any contract to lead. CATCHUP trades the lagger in the market impulse direction; PAIR trades lagger catch-up versus leader convergence; LEADER tests leader continuation. Discovery/freeze uses only 2024-09..2025-08 and 2025-09..2026-05. 2026-06..2026-08 is untouched evaluation. Independent decisions are not doubled for two-leg pairs.',
};

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`LEADER_LAG=${JSON.stringify({ symbols, grid: report.grid, diagnostics, eligible: report.eligible, targetFrequencyQualified: report.targetFrequencyQualified, frozen: report.frozen, results, evaluationRobust, evaluationTarget, topNear: topNear.slice(0, 12), topEligible: report.topEligible.slice(0, 12), topTargetFrequency: report.topTargetFrequency.slice(0, 12), note: report.note })}`);
