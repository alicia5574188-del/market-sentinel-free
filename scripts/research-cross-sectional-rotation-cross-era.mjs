import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/cross-sectional-rotation-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

const LOOKS = [24, 72, 168];
const SCORE_TYPES = ['RAW', 'VOL'];
const REBALANCES = [3, 6, 12];
const DEPTHS = [2, 4, 6];
const MODES = ['MOMENTUM', 'REVERSION'];
const HOLDS = [3, 6, 12, 24];
const MIN_RAW_SPREADS = [0.02, 0.05];

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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, [...d.rows].sort((a, b) => a.time - b.time)]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM - 200 * HOUR && t < EVAL_TO);

const snapshotsByLook = new Map();
for (const look of LOOKS) {
  const snapshots = new Map();
  for (const t of allTimes) {
    if (t < OLD_FROM) continue;
    const rows = [];
    for (const symbol of symbols) {
      const rm = rowMap.get(symbol);
      const anchor = rm.get(t - look * HOUR)?.open;
      const current = rm.get(t);
      if (!(anchor > 0) || !current || !(current.close > 0)) continue;
      let sumSq = 0;
      let valid = true;
      for (let k = look; k >= 1; k -= 1) {
        const a = rm.get(t - k * HOUR)?.open;
        const b = rm.get(t - (k - 1) * HOUR)?.open;
        if (!(a > 0) || !(b > 0)) { valid = false; break; }
        const r = b / a - 1;
        sumSq += r * r;
      }
      if (!valid) continue;
      const lastOpen = current.open;
      if (!(lastOpen > 0)) continue;
      const finalLeg = current.close / lastOpen - 1;
      sumSq += finalLeg * finalLeg;
      const rawRet = current.close / anchor - 1;
      const rv = Math.sqrt(sumSq);
      if (!(rv > 0) || !Number.isFinite(rawRet)) continue;
      rows.push({ symbol, rawRet, volScore: rawRet / rv });
    }
    if (rows.length < 15) continue;
    snapshots.set(t, rows);
  }
  snapshotsByLook.set(look, snapshots);
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
function events(config, until = TRAIN_TO) {
  const cacheKey = `${config.look}:${config.scoreType}:${config.rebalance}:${config.depth}:${config.mode}:${config.hold}:${config.minRawSpread}:${until}`;
  if (eventCache.has(cacheKey)) return eventCache.get(cacheKey);
  const snapshots = snapshotsByLook.get(config.look);
  const out = [];
  const busy = new Map();
  for (const [signalAt, rows] of snapshots) {
    if (signalAt >= until) continue;
    const d = new Date(signalAt * 1000);
    if (d.getUTCHours() % config.rebalance !== 0) continue;
    const ranked = [...rows].sort((a, b) => {
      const av = config.scoreType === 'RAW' ? a.rawRet : a.volScore;
      const bv = config.scoreType === 'RAW' ? b.rawRet : b.volScore;
      return bv - av;
    });
    if (ranked.length < config.depth * 2) continue;
    const top = ranked.slice(0, config.depth);
    const bottom = ranked.slice(-config.depth);
    const rawSpread = Math.min(...top.map((x) => x.rawRet)) - Math.max(...bottom.map((x) => x.rawRet));
    if (rawSpread < config.minRawSpread) continue;
    const selections = [
      ...top.map((x) => ({ ...x, side: 1 })),
      ...bottom.map((x) => ({ ...x, side: -1 })),
    ];
    const entryAt = signalAt + HOUR;
    const exitAt = entryAt + config.hold * HOUR;
    if (exitAt > until) continue;
    for (const x of selections) {
      if ((busy.get(x.symbol) ?? 0) > entryAt) continue;
      const direction = config.mode === 'MOMENTUM' ? x.side : -x.side;
      const gross = legReturn(x.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
      const adverseGross = legReturn(x.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
      if (![gross, adverseGross].every(Number.isFinite)) continue;
      out.push({
        symbol: x.symbol,
        signalAt,
        entryAt,
        exitAt,
        direction,
        rankSide: x.side,
        rawRet: x.rawRet,
        volScore: x.volScore,
        rawSpread,
        look: config.look,
        scoreType: config.scoreType,
        rebalance: config.rebalance,
        depth: config.depth,
        mode: config.mode,
        hold: config.hold,
        minRawSpread: config.minRawSpread,
        gross,
        base: gross - BASE_COST,
        stress: gross - STRESS_COST,
        adverse: adverseGross - BASE_COST,
        month: monthKey(entryAt),
      });
      busy.set(x.symbol, exitAt);
    }
  }
  eventCache.set(cacheKey, out);
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
for (const look of LOOKS) for (const scoreType of SCORE_TYPES) for (const rebalance of REBALANCES)
for (const depth of DEPTHS) for (const mode of MODES) for (const hold of HOLDS) for (const minRawSpread of MIN_RAW_SPREADS) {
  const c = { id: `CSR-${id++}`, look, scoreType, rebalance, depth, mode, hold, minRawSpread };
  const ev = events(c, TRAIN_TO);
  const oldStress = stats(ev, OLD_FROM, OLD_TO, 'stress');
  const oldAdverse = stats(ev, OLD_FROM, OLD_TO, 'adverse');
  const currentStress = stats(ev, CURRENT_FROM, TRAIN_TO, 'stress');
  const currentAdverse = stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse');
  const oldMonthly = monthly(ev, OLD_FROM, OLD_TO, 'stress');
  const currentMonthly = monthly(ev, CURRENT_FROM, TRAIN_TO, 'stress');
  const oldPositiveMonths = oldMonthly.filter((x) => x.positive).length;
  const currentPositiveMonths = currentMonthly.filter((x) => x.positive).length;
  const minFreq = Math.min(oldStress.eventsPerDay, currentStress.eventsPerDay);
  const sampleEnough = oldStress.events >= 200 && currentStress.events >= 150;
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
  const fullEvents = events(selected.c, EVAL_TO);
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
  byMode: groupSummary('mode', MODES),
  byScoreType: groupSummary('scoreType', SCORE_TYPES),
  byLook: groupSummary('look', LOOKS),
  byRebalance: groupSummary('rebalance', REBALANCES),
  byDepth: groupSummary('depth', DEPTHS),
};

const output = {
  research: 'cross-sectional-rotation-cross-era-v1',
  periods: {
    old: ['2024-09-01', '2025-09-01'],
    currentTrain: ['2025-09-01', '2026-06-01'],
    evaluation: ['2026-06-01', '2026-09-01'],
  },
  protocol: {
    signal: 'rank the full contemporaneous universe by long-horizon raw return or volatility-normalized return; trade strongest and weakest baskets',
    entry: 'next hourly open after the completed ranking bar',
    noLookahead: true,
    perSymbolNonOverlap: true,
    evaluationPolicy: 'holdout is not computed unless a config first passes all discovery robustness gates',
    costs: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
  },
  grid: { LOOKS, SCORE_TYPES, REBALANCES, DEPTHS, MODES, HOLDS, MIN_RAW_SPREADS },
  diagnostics,
  discoveryRobust: robust.length,
  eligible: eligible.length,
  targetFrequencyQualified: target.length,
  frozen,
  topNear,
  topRobust: robust.slice(0, 12),
  note: robust.length
    ? 'At least one cross-sectional rotation rule passed both discovery eras; only the top discovery-only rule opened holdout.'
    : 'No cross-sectional rotation rule passed the predeclared discovery gate. Holdout stayed closed; do not rescue or retune from holdout.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`CROSS_SECTIONAL_ROTATION=${JSON.stringify({
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
