import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-5m-13m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/temporal-vol-state-5m.json';
if (DATA.interval !== '5m' || (DATA.months?.length ?? 0) < 13) throw new Error('Need >=13-month Gate 5m dataset including one warmup month');

const STEP = 300;
const HOUR = 3600;
const DAY = 86400;
const BASE_RT_COST = 0.0014;
const STRESS_RT_COST = 0.0022;
const ADVERSE_ENTRY_SLIP = 0.0005;

const DISC_FROM = Date.UTC(2025, 8, 1) / 1000;
const DISC_TO = Date.UTC(2026, 2, 1) / 1000;
const VAL_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;
const WARM_FROM = Date.UTC(2025, 7, 1) / 1000;

const VOL_LOOKS = [12, 36]; // 1h, 3h realized vol from 5m returns
const HIST_HOURS = [168, 672]; // 7d, 28d causal quantile history
const TRANSITIONS = ['ENTER_HIGH', 'EXIT_HIGH', 'ENTER_LOW', 'EXIT_LOW'];
const PRE_LOOKS = [3, 12]; // 15m, 60m signed move used only for trade direction
const MODES = ['FOLLOW', 'FADE'];
const HOLDS = [3, 6, 12]; // 15m, 30m, 60m
const TIME_BUCKETS = ['ALL', 'H00_03', 'H04_07', 'H08_11', 'H12_15', 'H16_19', 'H20_23'];
const DAYTYPES = ['ALL', 'WEEKDAY', 'WEEKEND'];
const LOW_Q = 0.25;
const HIGH_Q = 0.75;

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
const timeBucketOf = (t) => {
  const h = new Date(t * 1000).getUTCHours();
  const a = Math.floor(h / 4) * 4;
  const b = a + 3;
  return `H${String(a).padStart(2, '0')}_${String(b).padStart(2, '0')}`;
};
const daytypeOf = (t) => {
  const d = new Date(t * 1000).getUTCDay();
  return d === 0 || d === 6 ? 'WEEKEND' : 'WEEKDAY';
};
const lowerBound = (a, x) => {
  let lo = 0; let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
};
const upperBound = (a, x) => {
  let lo = 0; let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) lo = m + 1; else hi = m;
  }
  return lo;
};
const insertSorted = (a, x) => a.splice(upperBound(a, x), 0, x);
const removeSorted = (a, x) => {
  const i = lowerBound(a, x);
  if (i < a.length && a[i] === x) a.splice(i, 1);
};
const stateOf = (rank) => rank >= HIGH_Q ? 'HIGH' : rank <= LOW_Q ? 'LOW' : 'MID';
const transitionOf = (prev, now) => {
  if (!prev) return null;
  if (now === 'HIGH' && prev !== 'HIGH') return 'ENTER_HIGH';
  if (prev === 'HIGH' && now !== 'HIGH') return 'EXIT_HIGH';
  if (now === 'LOW' && prev !== 'LOW') return 'ENTER_LOW';
  if (prev === 'LOW' && now !== 'LOW') return 'EXIT_LOW';
  return null;
};

const datasets = DATA.datasets ?? [];
const symbols = datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Need >=15 symbols, got ${symbols.length}`);
const maps = new Map(datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const refRows = datasets.find((d) => d.symbol === 'BTC_USDT')?.rows ?? datasets[0]?.rows ?? [];
const hourlyTimes = refRows.map((r) => r.time).filter((t) => {
  if (t < WARM_FROM || t >= EVAL_TO) return false;
  const d = new Date(t * 1000);
  return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
});
if (hourlyTimes.length < 9000) throw new Error(`Unexpectedly few hourly anchors: ${hourlyTimes.length}`);

function openAt(symbol, t) {
  const v = maps.get(symbol)?.get(t)?.open;
  return Number.isFinite(v) && v > 0 ? v : null;
}
function realizedVol(symbol, t, lookBars) {
  let ss = 0;
  for (let j = 0; j < lookBars; j++) {
    const p1 = openAt(symbol, t - j * STEP);
    const p0 = openAt(symbol, t - (j + 1) * STEP);
    if (p1 == null || p0 == null) return null;
    const r = Math.log(p1 / p0);
    ss += r * r;
  }
  return Math.sqrt(ss / lookBars);
}
function signedMove(symbol, t, lookBars) {
  const a = openAt(symbol, t - lookBars * STEP);
  const b = openAt(symbol, t);
  if (a == null || b == null) return null;
  return b / a - 1;
}

const featureMap = new Map();
const featureKey = (volLook, histHours, transition, preLook) => `${volLook}:${histHours}:${transition}:${preLook}`;
for (const volLook of VOL_LOOKS) for (const histHours of HIST_HOURS) for (const transition of TRANSITIONS) for (const preLook of PRE_LOOKS) {
  featureMap.set(featureKey(volLook, histHours, transition, preLook), []);
}

for (const symbol of symbols) {
  for (const volLook of VOL_LOOKS) {
    const points = [];
    for (const t of hourlyTimes) {
      const rv = realizedVol(symbol, t, volLook);
      if (rv != null) points.push({ t, rv });
    }
    for (const histHours of HIST_HOURS) {
      const sorted = [];
      let prevState = null;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        let state = null;
        if (sorted.length >= histHours && i >= histHours) {
          const oldest = points[i - histHours];
          const continuityOk = p.t - oldest.t <= (histHours + 12) * HOUR;
          if (continuityOk) {
            const rank = upperBound(sorted, p.rv) / sorted.length;
            state = stateOf(rank);
            const transition = transitionOf(prevState, state);
            if (transition && p.t >= DISC_FROM && p.t < EVAL_TO) {
              for (const preLook of PRE_LOOKS) {
                const move = signedMove(symbol, p.t, preLook);
                if (move == null || Math.abs(move) < 1e-8) continue;
                featureMap.get(featureKey(volLook, histHours, transition, preLook)).push({
                  symbol,
                  signalAt: p.t,
                  volLook,
                  histHours,
                  transition,
                  preLook,
                  move,
                  volRank: rank,
                  timeBucket: timeBucketOf(p.t),
                  daytype: daytypeOf(p.t),
                });
              }
            }
          }
        }
        insertSorted(sorted, p.rv);
        if (sorted.length > histHours) removeSorted(sorted, points[i - histHours].rv);
        prevState = state;
      }
    }
  }
}

function rawTrade(symbol, direction, entryAt, exitAt) {
  const e0 = openAt(symbol, entryAt);
  const x = openAt(symbol, exitAt);
  if (e0 == null || x == null) return null;
  const gross = direction > 0 ? x / e0 - 1 : 1 - x / e0;
  const adverseEntry = direction > 0 ? e0 * (1 + ADVERSE_ENTRY_SLIP) : e0 * (1 - ADVERSE_ENTRY_SLIP);
  const adverseGross = direction > 0 ? x / adverseEntry - 1 : 1 - x / adverseEntry;
  return { gross, base: gross - BASE_RT_COST, stress: gross - STRESS_RT_COST, adverse: adverseGross - BASE_RT_COST };
}

const sourceCache = new Map();
function sourceFor(c) {
  const k = `${featureKey(c.volLook, c.histHours, c.transition, c.preLook)}:${c.mode}:${c.holdBars}`;
  if (sourceCache.has(k)) return sourceCache.get(k);
  const source = featureMap.get(featureKey(c.volLook, c.histHours, c.transition, c.preLook)) ?? [];
  const out = [];
  for (const x of source) {
    const baseDir = Math.sign(x.move);
    if (!baseDir) continue;
    const direction = c.mode === 'FOLLOW' ? baseDir : -baseDir;
    const entryAt = x.signalAt + STEP;
    const exitAt = entryAt + c.holdBars * STEP;
    if (exitAt > EVAL_TO) continue;
    const rr = rawTrade(x.symbol, direction, entryAt, exitAt);
    if (!rr) continue;
    out.push({ ...x, direction, entryAt, exitAt, month: monthKey(entryAt), ...rr });
  }
  sourceCache.set(k, out);
  return out;
}

function tradesFor(c) {
  const busy = new Map();
  const out = [];
  for (const x of sourceFor(c)) {
    if (c.timeBucket !== 'ALL' && x.timeBucket !== c.timeBucket) continue;
    if (c.daytype !== 'ALL' && x.daytype !== c.daytype) continue;
    if ((busy.get(x.symbol) ?? 0) > x.entryAt) continue;
    out.push(x);
    busy.set(x.symbol, x.exitAt);
  }
  return out;
}

function stats(rows, from, to, field = 'stress') {
  const xs = rows.filter((x) => x.entryAt >= from && x.exitAt <= to);
  const days = (to - from) / DAY;
  const net = sum(xs.map((x) => x[field]));
  const gains = sum(xs.filter((x) => x[field] > 0).map((x) => x[field]));
  const losses = Math.abs(sum(xs.filter((x) => x[field] <= 0).map((x) => x[field])));
  const monthly = monthKeys(from, to).map((month) => {
    const ys = xs.filter((x) => x.month === month);
    const v = sum(ys.map((x) => x[field]));
    return { month, events: ys.length, net: v, positive: v > 0 };
  });
  return {
    events: xs.length,
    eventsPerDay: days ? xs.length / days : 0,
    net,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((x) => x[field] > 0).length / xs.length : 0,
    positiveMonths: monthly.filter((x) => x.positive).length,
    monthly,
  };
}
function maxConcurrency(rows, from, to) {
  const pts = [];
  for (const x of rows) {
    if (x.entryAt < from || x.exitAt > to) continue;
    pts.push([x.entryAt, 1], [x.exitAt, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0; let best = 0;
  for (const [, d] of pts) { n += d; best = Math.max(best, n); }
  return best;
}
function scaledPath(rows, from, to, field, size) {
  const xs = rows.filter((x) => x.entryAt >= from && x.exitAt <= to)
    .sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol));
  let equity = 1; let peak = 1; let minEquity = 1; let maxDrawdownAbs = 0;
  for (const x of xs) {
    equity += size * x[field];
    peak = Math.max(peak, equity);
    minEquity = Math.min(minEquity, equity);
    maxDrawdownAbs = Math.max(maxDrawdownAbs, peak - equity);
  }
  return { finalEquity: equity, minEquity, maxDrawdownAbs, survived: minEquity > 0 };
}

const candidates = [];
let id = 0;
for (const volLook of VOL_LOOKS) for (const histHours of HIST_HOURS) for (const transition of TRANSITIONS) for (const preLook of PRE_LOOKS) for (const mode of MODES) for (const holdBars of HOLDS) for (const timeBucket of TIME_BUCKETS) for (const daytype of DAYTYPES) {
  const c = { id: `TV5-${id++}`, volLook, histHours, transition, preLook, mode, holdBars, timeBucket, daytype };
  const rows = tradesFor(c);
  const discovery = { stress: stats(rows, DISC_FROM, DISC_TO, 'stress'), adverse: stats(rows, DISC_FROM, DISC_TO, 'adverse') };
  const validation = { stress: stats(rows, DISC_TO, VAL_TO, 'stress'), adverse: stats(rows, DISC_TO, VAL_TO, 'adverse') };
  const sampleEnough = discovery.stress.events >= 120 && validation.stress.events >= 60;
  const bothStressPositive = discovery.stress.net >= 0 && validation.stress.net >= 0;
  const bothAdversePositive = discovery.adverse.net >= 0 && validation.adverse.net >= 0;
  const edgeFloor = sampleEnough && bothStressPositive && bothAdversePositive;
  const minFreq = Math.min(discovery.stress.eventsPerDay, validation.stress.eventsPerDay);
  const requiredSizeFor5x = minFreq > 0 ? 5 / (2 * minFreq) : null;
  const maxConc = Math.max(maxConcurrency(rows, DISC_FROM, DISC_TO), maxConcurrency(rows, DISC_TO, VAL_TO));
  const requiredGrossFor5x = requiredSizeFor5x == null ? null : requiredSizeFor5x * maxConc;
  const fiveXPaths = requiredSizeFor5x == null ? null : {
    discovery: scaledPath(rows, DISC_FROM, DISC_TO, 'stress', requiredSizeFor5x),
    validation: scaledPath(rows, DISC_TO, VAL_TO, 'stress', requiredSizeFor5x),
    discoveryAdverse: scaledPath(rows, DISC_FROM, DISC_TO, 'adverse', requiredSizeFor5x),
    validationAdverse: scaledPath(rows, DISC_TO, VAL_TO, 'adverse', requiredSizeFor5x),
  };
  const viable5x = edgeFloor
    && requiredGrossFor5x != null
    && requiredGrossFor5x <= 2.5
    && Object.values(fiveXPaths).every((x) => x.survived);
  const minAvg = Math.min(discovery.stress.avgNet, validation.stress.avgNet);
  const minPf = Math.min(discovery.stress.pf, validation.stress.pf);
  const score = (Math.max(-0.01, minAvg) + 0.01) * Math.sqrt(Math.max(0.01, minFreq)) * Math.max(0.1, minPf) / Math.max(0.25, requiredGrossFor5x ?? 9);
  candidates.push({ c, discovery, validation, sampleEnough, bothStressPositive, bothAdversePositive, edgeFloor, minFreq, requiredSizeFor5x, maxConcurrency: maxConc, requiredGrossFor5x, fiveXPaths, viable5x, score });
}

const diagnosticPool = candidates.filter((x) => x.sampleEnough);
const edge = candidates.filter((x) => x.edgeFloor).sort((a, b) => b.score - a.score);
const viable = candidates.filter((x) => x.viable5x).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 30);
const selected = viable[0] ?? edge[0] ?? null;

let evaluation = null;
if (selected) {
  const rows = tradesFor(selected.c);
  const stress = stats(rows, VAL_TO, EVAL_TO, 'stress');
  const adverse = stats(rows, VAL_TO, EVAL_TO, 'adverse');
  const size = selected.requiredSizeFor5x;
  const pathStress = size == null ? null : scaledPath(rows, VAL_TO, EVAL_TO, 'stress', size);
  const pathAdverse = size == null ? null : scaledPath(rows, VAL_TO, EVAL_TO, 'adverse', size);
  evaluation = {
    stress,
    adverse,
    size,
    modeledTurnoverPerDay: size == null ? null : 2 * stress.eventsPerDay * size,
    maxConcurrency: maxConcurrency(rows, VAL_TO, EVAL_TO),
    modeledMaxGross: size == null ? null : size * maxConcurrency(rows, VAL_TO, EVAL_TO),
    pathStress,
    pathAdverse,
    passed: stress.net >= 0 && adverse.net >= 0 && pathStress?.survived !== false && pathAdverse?.survived !== false,
  };
}

const groupSummary = (field, values) => Object.fromEntries(values.map((value) => {
  const xs = diagnosticPool.filter((x) => x.c[field] === value);
  return [value, {
    configs: xs.length,
    discoveryStressPositive: xs.filter((x) => x.discovery.stress.net >= 0).length,
    validationStressPositive: xs.filter((x) => x.validation.stress.net >= 0).length,
    bothStressPositive: xs.filter((x) => x.bothStressPositive).length,
    edgeFloor: xs.filter((x) => x.edgeFloor).length,
    viable5x: xs.filter((x) => x.viable5x).length,
  }];
}));

const diagnostics = {
  symbols: symbols.length,
  hourlyAnchors: hourlyTimes.length,
  featureRows: Object.fromEntries([...featureMap.entries()].map(([k, v]) => [k, v.length])),
  configs: candidates.length,
  diagnosticPool: diagnosticPool.length,
  discoveryStressPositive: diagnosticPool.filter((x) => x.discovery.stress.net >= 0).length,
  validationStressPositive: diagnosticPool.filter((x) => x.validation.stress.net >= 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.bothStressPositive).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.bothAdversePositive).length,
  edgeFloor: edge.length,
  viable5x: viable.length,
  evaluationOpened: Boolean(selected),
  byTransition: groupSummary('transition', TRANSITIONS),
  byMode: groupSummary('mode', MODES),
  byTimeBucket: groupSummary('timeBucket', TIME_BUCKETS),
  byDaytype: groupSummary('daytype', DAYTYPES),
};

const report = {
  research: '5m-temporal-vol-state-v1',
  objective: 'test causal realized-volatility quantile state transitions conditioned by UTC 4h blocks and weekday/weekend structure as a native high-turnover short-horizon edge',
  protocol: {
    periods: { discovery: [DISC_FROM, DISC_TO], validation: [DISC_TO, VAL_TO], evaluation: [VAL_TO, EVAL_TO], warmupFrom: WARM_FROM },
    symbols,
    volLookBars: VOL_LOOKS,
    historyHours: HIST_HOURS,
    quantiles: { low: LOW_Q, high: HIGH_Q },
    transitions: TRANSITIONS,
    preMoveBars: PRE_LOOKS,
    modes: MODES,
    holdBars: HOLDS,
    timeBuckets: TIME_BUCKETS,
    daytypes: DAYTYPES,
    execution: 'signal only at completed hourly anchors; realized-vol quantile uses prior hourly observations only; signed 15m/60m move is known at the anchor; entry is next 5m open; same-symbol overlap forbidden',
    costs: { baseRoundTrip: BASE_RT_COST, stressRoundTrip: STRESS_RT_COST, adverseEntrySlip: ADVERSE_ENTRY_SLIP },
    turnover: 'genuine entry+exit notional only; modeled 5x size = 5/(2*minimum discovery-validation events/day); no self-trade, order splitting, or opposite-position volume inflation',
    discoveryFloor: '>=120 discovery and >=60 validation events; stress net >=0 and adverse-entry net >=0 in both periods. No PF or trade-count hard gate.',
    evaluationGate: '2026-06..2026-08 is evaluated only for the exact best discovery+validation qualified rule; evaluation never selects parameters.',
  },
  diagnostics,
  selected,
  evaluation,
  viable: viable.slice(0, 20),
  edge: edge.slice(0, 20),
  topNear,
};

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`TEMPORAL_VOL_STATE_5M=${JSON.stringify({ research: report.research, objective: report.objective, protocol: report.protocol, diagnostics, selected, evaluation, viable: report.viable.slice(0, 8), edge: report.edge.slice(0, 8), topNear: topNear.slice(0, 8) })}`);
