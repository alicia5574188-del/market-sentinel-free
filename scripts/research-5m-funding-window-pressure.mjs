import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-5m-12m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/funding-window-5m-pressure.json';
if (DATA.interval !== '5m' || DATA.months?.length !== 12) throw new Error('Need 12-month Gate 5m dataset');

const STEP = 300;
const DAY = 86400;
const BASE_RT_COST = 0.0014;
const STRESS_RT_COST = 0.0022;
const ADVERSE_ENTRY_SLIP = 0.00050;
const DISC_FROM = Date.UTC(2025, 8, 1) / 1000;
const DISC_TO = Date.UTC(2026, 2, 1) / 1000;
const VAL_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;

const PRE_LOOKS = [3, 6, 12]; // 15m, 30m, 60m
const BASES = ['ABS', 'REL'];
const THRESHOLDS = [0, 0.0015, 0.0030, 0.0050];
const MODES = ['FADE', 'FOLLOW'];
const ENTRY_DELAYS = [1, 2]; // 5m, 10m after scheduled funding boundary
const HOLDS = [3, 6, 12]; // 15m, 30m, 60m
const WINDOWS = ['ALL', 'UTC00', 'UTC08', 'UTC16'];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  const ys = [...xs].sort((a, b) => a - b);
  if (!ys.length) return 0;
  const m = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2;
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
const windowOk = (window, t) => {
  if (window === 'ALL') return true;
  const h = new Date(t * 1000).getUTCHours();
  if (window === 'UTC00') return h === 0;
  if (window === 'UTC08') return h === 8;
  if (window === 'UTC16') return h === 16;
  return false;
};

const datasets = DATA.datasets ?? [];
const symbols = datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Need >=15 symbols, got ${symbols.length}`);
if (!symbols.includes('BTC_USDT')) throw new Error('Need BTC_USDT clock reference');
const maps = new Map(datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const btcRows = datasets.find((d) => d.symbol === 'BTC_USDT').rows;
const fundingBuckets = btcRows.map((r) => r.time).filter((t) => {
  if (t < DISC_FROM || t >= EVAL_TO) return false;
  const d = new Date(t * 1000);
  return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && [0, 8, 16].includes(d.getUTCHours());
});
if (fundingBuckets.length < 900) throw new Error(`Unexpectedly few 8h funding-boundary buckets: ${fundingBuckets.length}`);

function openAt(symbol, t) {
  const v = maps.get(symbol)?.get(t)?.open;
  return Number.isFinite(v) && v > 0 ? v : null;
}

const scoreCache = new Map();
for (const lookBars of PRE_LOOKS) {
  const abs = new Map();
  const rel = new Map();
  for (const bucket of fundingBuckets) {
    const rows = [];
    for (const symbol of symbols) {
      const a = openAt(symbol, bucket - lookBars * STEP);
      const b = openAt(symbol, bucket);
      if (a == null || b == null) continue;
      rows.push({ symbol, score: b / a - 1 });
    }
    if (rows.length < 15) continue;
    const center = median(rows.map((x) => x.score));
    abs.set(bucket, rows);
    rel.set(bucket, rows.map((x) => ({ symbol: x.symbol, score: x.score - center })));
  }
  scoreCache.set(`${lookBars}:ABS`, abs);
  scoreCache.set(`${lookBars}:REL`, rel);
}

function rawTrade(symbol, direction, entryAt, exitAt) {
  const e0 = openAt(symbol, entryAt);
  const x = openAt(symbol, exitAt);
  if (e0 == null || x == null) return null;
  const gross = direction > 0 ? x / e0 - 1 : 1 - x / e0;
  const adverseEntry = direction > 0 ? e0 * (1 + ADVERSE_ENTRY_SLIP) : e0 * (1 - ADVERSE_ENTRY_SLIP);
  const adverseGross = direction > 0 ? x / adverseEntry - 1 : 1 - x / adverseEntry;
  return {
    gross,
    base: gross - BASE_RT_COST,
    stress: gross - STRESS_RT_COST,
    adverse: adverseGross - BASE_RT_COST,
  };
}

function buildTrades(c) {
  const source = scoreCache.get(`${c.lookBars}:${c.basis}`) ?? new Map();
  const busy = new Map();
  const out = [];
  for (const bucket of fundingBuckets) {
    if (!windowOk(c.window, bucket)) continue;
    const rows = source.get(bucket) ?? [];
    for (const x of rows) {
      if (Math.abs(x.score) < c.threshold || Math.abs(x.score) < 1e-8) continue;
      const entryAt = bucket + c.entryDelay * STEP;
      const exitAt = entryAt + c.holdBars * STEP;
      if (exitAt > EVAL_TO) continue;
      if ((busy.get(x.symbol) ?? 0) > entryAt) continue;
      const baseDirection = Math.sign(x.score);
      const direction = c.mode === 'FOLLOW' ? baseDirection : -baseDirection;
      const rr = rawTrade(x.symbol, direction, entryAt, exitAt);
      if (!rr) continue;
      out.push({
        symbol: x.symbol,
        bucket,
        entryAt,
        exitAt,
        month: monthKey(entryAt),
        score: x.score,
        direction,
        ...rr,
      });
      busy.set(x.symbol, exitAt);
    }
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
    positiveMonths: monthly.filter((m) => m.positive).length,
    monthly,
  };
}

function maxConcurrency(rows, from, to) {
  const points = [];
  for (const x of rows) {
    if (x.entryAt < from || x.exitAt > to) continue;
    points.push([x.entryAt, 1], [x.exitAt, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0;
  let best = 0;
  for (const [, d] of points) {
    n += d;
    best = Math.max(best, n);
  }
  return best;
}

function scaledPath(rows, from, to, field, size) {
  const xs = rows.filter((x) => x.entryAt >= from && x.exitAt <= to)
    .sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol));
  let equity = 1;
  let peak = 1;
  let minEquity = 1;
  let maxDrawdownAbs = 0;
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
for (const lookBars of PRE_LOOKS) for (const basis of BASES) for (const threshold of THRESHOLDS)
for (const mode of MODES) for (const entryDelay of ENTRY_DELAYS) for (const holdBars of HOLDS) for (const window of WINDOWS) {
  const c = { id: `FW5-${id++}`, lookBars, basis, threshold, mode, entryDelay, holdBars, window };
  const trades = buildTrades(c);
  const discovery = {
    stress: stats(trades, DISC_FROM, DISC_TO),
    adverse: stats(trades, DISC_FROM, DISC_TO, 'adverse'),
  };
  const validation = {
    stress: stats(trades, DISC_TO, VAL_TO),
    adverse: stats(trades, DISC_TO, VAL_TO, 'adverse'),
  };
  const sampleEnough = discovery.stress.events >= 180 && validation.stress.events >= 90;
  const bothStressPositive = discovery.stress.net >= 0 && validation.stress.net >= 0;
  const bothAdversePositive = discovery.adverse.net >= 0 && validation.adverse.net >= 0;
  const edgeFloor = sampleEnough && bothStressPositive && bothAdversePositive;
  const minFreq = Math.min(discovery.stress.eventsPerDay, validation.stress.eventsPerDay);
  const requiredSizeFor5x = minFreq > 0 ? 5 / (2 * minFreq) : null;
  const maxConc = Math.max(maxConcurrency(trades, DISC_FROM, DISC_TO), maxConcurrency(trades, DISC_TO, VAL_TO));
  const requiredGrossFor5x = requiredSizeFor5x == null ? null : requiredSizeFor5x * maxConc;
  const d5 = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_FROM, DISC_TO, 'stress', requiredSizeFor5x);
  const v5 = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_TO, VAL_TO, 'stress', requiredSizeFor5x);
  const d5a = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_FROM, DISC_TO, 'adverse', requiredSizeFor5x);
  const v5a = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_TO, VAL_TO, 'adverse', requiredSizeFor5x);
  const viable5x = edgeFloor
    && requiredSizeFor5x <= 0.20
    && requiredGrossFor5x <= 2.50
    && d5?.minEquity > 0.20
    && v5?.minEquity > 0.20
    && d5a?.minEquity > 0.20
    && v5a?.minEquity > 0.20;
  const minPf = Math.min(discovery.stress.pf, validation.stress.pf);
  const score = (viable5x ? 10000 : 0) + (edgeFloor ? 1000 : 0) + minPf * 100 + Math.min(100, minFreq)
    - (requiredGrossFor5x ?? 99) * 3;
  candidates.push({
    c,
    discovery,
    validation,
    sampleEnough,
    bothStressPositive,
    bothAdversePositive,
    edgeFloor,
    minFreq,
    requiredSizeFor5x,
    maxConcurrency: maxConc,
    requiredGrossFor5x,
    fiveXPaths: { discovery: d5, validation: v5, discoveryAdverse: d5a, validationAdverse: v5a },
    viable5x,
    score,
  });
}

const diagnosticPool = candidates.filter((x) => x.sampleEnough);
const edge = candidates.filter((x) => x.edgeFloor).sort((a, b) => b.score - a.score);
const viable = candidates.filter((x) => x.viable5x).sort((a, b) => b.score - a.score);
const selected = viable[0] ?? edge[0] ?? null;
let evaluationOpened = false;
let evaluation = null;
if (selected) {
  evaluationOpened = true;
  const trades = buildTrades(selected.c);
  const stress = stats(trades, VAL_TO, EVAL_TO);
  const adverse = stats(trades, VAL_TO, EVAL_TO, 'adverse');
  const size = selected.requiredSizeFor5x;
  evaluation = {
    config: selected.c,
    stress,
    adverse,
    fiveX: size == null ? null : {
      size,
      turnoverTarget: 5,
      maxConcurrency: maxConcurrency(trades, VAL_TO, EVAL_TO),
      grossNeeded: size * maxConcurrency(trades, VAL_TO, EVAL_TO),
      stressPath: scaledPath(trades, VAL_TO, EVAL_TO, 'stress', size),
      adversePath: scaledPath(trades, VAL_TO, EVAL_TO, 'adverse', size),
    },
  };
}

const groupSummary = (field, values) => Object.fromEntries(values.map((value) => {
  const xs = diagnosticPool.filter((x) => x.c[field] === value);
  const best = [...xs].sort((a, b) => b.score - a.score)[0] ?? null;
  return [String(value), {
    configs: xs.length,
    discoveryStressPositive: xs.filter((x) => x.discovery.stress.net >= 0).length,
    validationStressPositive: xs.filter((x) => x.validation.stress.net >= 0).length,
    bothStressPositive: xs.filter((x) => x.bothStressPositive).length,
    bothAdversePositive: xs.filter((x) => x.bothAdversePositive).length,
    edgeFloor: xs.filter((x) => x.edgeFloor).length,
    viable5x: xs.filter((x) => x.viable5x).length,
    best,
  }];
}));

const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 30);
const result = {
  research: '5m-funding-window-pressure-v1',
  objective: 'test whether price pressure immediately before scheduled 00/08/16 UTC perpetual funding boundaries releases or persists after the boundary, while preserving native event density for ~5x genuine daily turnover',
  protocol: {
    periods: { discovery: [DISC_FROM, DISC_TO], validation: [DISC_TO, VAL_TO], evaluation: [VAL_TO, EVAL_TO] },
    symbols,
    fundingBuckets: fundingBuckets.length,
    configs: candidates.length,
    preLookBars: PRE_LOOKS,
    bases: BASES,
    thresholds: THRESHOLDS,
    modes: MODES,
    entryDelayBars: ENTRY_DELAYS,
    holdBars: HOLDS,
    windows: WINDOWS,
    execution: 'scheduled UTC 00/08/16 boundary is the only time anchor; pre-boundary return uses opens known by the boundary; entry occurs 5m or 10m later; no funding rate or future funding payment is used; same-symbol overlap forbidden',
    costs: { baseRoundTrip: BASE_RT_COST, stressRoundTrip: STRESS_RT_COST, adverseEntrySlip: ADVERSE_ENTRY_SLIP },
    turnover: 'genuine entry+exit notional only; 5x sizing = 5 / (2 * minimum discovery/validation events-per-day); no self-trade/order splitting',
    evaluationGate: '2026-06..2026-08 opens only for one exact config that is non-negative in both discovery and validation under both stress and adverse assumptions',
  },
  diagnostics: {
    configs: candidates.length,
    diagnosticPool: diagnosticPool.length,
    discoveryStressPositive: diagnosticPool.filter((x) => x.discovery.stress.net >= 0).length,
    validationStressPositive: diagnosticPool.filter((x) => x.validation.stress.net >= 0).length,
    bothStressPositive: diagnosticPool.filter((x) => x.bothStressPositive).length,
    bothAdversePositive: diagnosticPool.filter((x) => x.bothAdversePositive).length,
    edgeFloor: edge.length,
    viable5x: viable.length,
    evaluationOpened,
    byMode: groupSummary('mode', MODES),
    byWindow: groupSummary('window', WINDOWS),
    byBasis: groupSummary('basis', BASES),
  },
  selected,
  evaluation,
  viable: viable.slice(0, 20),
  edge: edge.slice(0, 20),
  topNear,
};

writeFileSync(OUTPUT, `${JSON.stringify(result)}\n`);
console.log(`FUNDING_WINDOW_5M_PRESSURE=${JSON.stringify(result)}`);
