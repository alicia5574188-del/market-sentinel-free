import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-5m-12m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/failed-impulse-5m-turnover.json';
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

const BASELINE = 288; // prior 24h of 5m bars
const BREAK_LOOKBACKS = [12, 36, 72];
const BODY_MINS = [0.0025, 0.0040, 0.0060];
const RANGE_XS = [1.5, 2.0];
const VOL_XS = [1.0, 1.5, 2.0];
const FAIL_TYPES = ['LEVEL', 'HALF', 'OPPOSITE'];
const HOLDS = [3, 6, 12];

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

const datasets = DATA.datasets ?? [];
const symbols = datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Need >=15 symbols, got ${symbols.length}`);

function priorAvg(values, n) {
  const out = Array(values.length).fill(null);
  const prefix = Array(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i += 1) prefix[i + 1] = prefix[i] + (Number.isFinite(values[i]) ? values[i] : 0);
  for (let i = n; i < values.length; i += 1) out[i] = (prefix[i] - prefix[i - n]) / n;
  return out;
}

function priorExtrema(rows, lookback) {
  const hi = Array(rows.length).fill(null);
  const lo = Array(rows.length).fill(null);
  const qHi = [];
  const qLo = [];
  let h0 = 0;
  let l0 = 0;
  for (let i = 0; i < rows.length; i += 1) {
    while (h0 < qHi.length && qHi[h0] < i - lookback) h0 += 1;
    while (l0 < qLo.length && qLo[l0] < i - lookback) l0 += 1;
    if (i > 0) {
      const j = i - 1;
      while (qHi.length > h0 && rows[qHi.at(-1)].high <= rows[j].high) qHi.pop();
      qHi.push(j);
      while (qLo.length > l0 && rows[qLo.at(-1)].low >= rows[j].low) qLo.pop();
      qLo.push(j);
    }
    while (h0 < qHi.length && qHi[h0] < i - lookback) h0 += 1;
    while (l0 < qLo.length && qLo[l0] < i - lookback) l0 += 1;
    if (i >= lookback && h0 < qHi.length && l0 < qLo.length) {
      hi[i] = rows[qHi[h0]].high;
      lo[i] = rows[qLo[l0]].low;
    }
    if (h0 > 4096) { qHi.splice(0, h0); h0 = 0; }
    if (l0 > 4096) { qLo.splice(0, l0); l0 = 0; }
  }
  return { hi, lo };
}

const eventCache = new Map(BREAK_LOOKBACKS.map((n) => [n, []]));
for (const d of datasets) {
  const rows = d.rows;
  const rangePct = rows.map((r) => (r.high - r.low) / r.open);
  const avgRange = priorAvg(rangePct, BASELINE);
  const avgVolume = priorAvg(rows.map((r) => r.volume), BASELINE);
  const extrema = Object.fromEntries(BREAK_LOOKBACKS.map((n) => [n, priorExtrema(rows, n)]));
  for (let i = Math.max(BASELINE, Math.max(...BREAK_LOOKBACKS)); i + 14 < rows.length; i += 1) {
    const impulse = rows[i];
    const confirm = rows[i + 1];
    const entry = rows[i + 2];
    if (impulse.time < DISC_FROM || entry.time >= EVAL_TO) continue;
    if (confirm.time !== impulse.time + STEP || entry.time !== confirm.time + STEP) continue;
    const bodyRet = impulse.close / impulse.open - 1;
    const dir = Math.sign(bodyRet);
    if (!dir || Math.abs(bodyRet) < Math.min(...BODY_MINS)) continue;
    const ar = avgRange[i];
    const av = avgVolume[i];
    if (!(ar > 0 && av > 0)) continue;
    const rangeX = rangePct[i] / ar;
    const volX = impulse.volume / av;
    if (rangeX < Math.min(...RANGE_XS) || volX < Math.min(...VOL_XS)) continue;
    const impulseMid = (impulse.open + impulse.close) / 2;
    const impulseRange = Math.max(impulse.high - impulse.low, impulse.open * 1e-8);
    const opposite = dir > 0
      ? (confirm.close < confirm.open && confirm.high <= impulse.high + 0.25 * impulseRange)
      : (confirm.close > confirm.open && confirm.low >= impulse.low - 0.25 * impulseRange);
    const half = dir > 0 ? confirm.close <= impulseMid : confirm.close >= impulseMid;
    for (const lookback of BREAK_LOOKBACKS) {
      const priorHigh = extrema[lookback].hi[i];
      const priorLow = extrema[lookback].lo[i];
      if (!(priorHigh > 0 && priorLow > 0)) continue;
      const broke = dir > 0 ? impulse.high > priorHigh : impulse.low < priorLow;
      if (!broke) continue;
      const level = dir > 0 ? confirm.close <= priorHigh : confirm.close >= priorLow;
      eventCache.get(lookback).push({
        symbol: d.symbol,
        signalAt: confirm.time + STEP,
        entryAt: entry.time,
        entryIndex: i + 2,
        direction: -dir,
        bodyAbs: Math.abs(bodyRet),
        rangeX,
        volX,
        level,
        half,
        opposite,
      });
    }
  }
}
for (const xs of eventCache.values()) xs.sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol));

const rowMaps = new Map(datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));

function rawTrade(e, holdBars) {
  const m = rowMaps.get(e.symbol);
  const entry = m.get(e.entryAt)?.open;
  const exitAt = e.entryAt + holdBars * STEP;
  const exit = m.get(exitAt)?.open;
  if (![entry, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const gross = e.direction > 0 ? exit / entry - 1 : 1 - exit / entry;
  const adverseEntry = e.direction > 0 ? entry * (1 + ADVERSE_ENTRY_SLIP) : entry * (1 - ADVERSE_ENTRY_SLIP);
  const adverseGross = e.direction > 0 ? exit / adverseEntry - 1 : 1 - exit / adverseEntry;
  return { exitAt, gross, base: gross - BASE_RT_COST, stress: gross - STRESS_RT_COST, adverse: adverseGross - BASE_RT_COST };
}

function failPass(e, type) {
  if (type === 'LEVEL') return e.level;
  if (type === 'HALF') return e.half;
  return e.opposite;
}

function buildTrades(c) {
  const source = eventCache.get(c.lookback) ?? [];
  const busy = new Map();
  const out = [];
  for (const e of source) {
    if (e.bodyAbs < c.bodyMin || e.rangeX < c.rangeX || e.volX < c.volX || !failPass(e, c.failType)) continue;
    const rr = rawTrade(e, c.holdBars);
    if (!rr || rr.exitAt > EVAL_TO) continue;
    if ((busy.get(e.symbol) ?? 0) > e.entryAt) continue;
    out.push({ ...e, ...rr, month: monthKey(e.entryAt) });
    busy.set(e.symbol, rr.exitAt);
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
  const pts = [];
  for (const x of rows) {
    if (x.entryAt < from || x.exitAt > to) continue;
    pts.push([x.entryAt, 1], [x.exitAt, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0; let best = 0;
  for (const [, delta] of pts) { n += delta; best = Math.max(best, n); }
  return best;
}

function scaledPath(rows, from, to, field, size) {
  const xs = rows.filter((x) => x.entryAt >= from && x.exitAt <= to).sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol));
  let equity = 1; let peak = 1; let minEquity = 1; let maxDD = 0;
  for (const x of xs) {
    equity += size * x[field];
    peak = Math.max(peak, equity);
    minEquity = Math.min(minEquity, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return { finalEquity: equity, minEquity, maxDrawdownAbs: maxDD, survived: minEquity > 0 };
}

const candidates = [];
let id = 0;
for (const lookback of BREAK_LOOKBACKS) for (const bodyMin of BODY_MINS) for (const rangeX of RANGE_XS)
for (const volX of VOL_XS) for (const failType of FAIL_TYPES) for (const holdBars of HOLDS) {
  const c = { id: `FI5-${id++}`, lookback, bodyMin, rangeX, volX, failType, holdBars };
  const trades = buildTrades(c);
  const discovery = { stress: stats(trades, DISC_FROM, DISC_TO), adverse: stats(trades, DISC_FROM, DISC_TO, 'adverse') };
  const validation = { stress: stats(trades, DISC_TO, VAL_TO), adverse: stats(trades, DISC_TO, VAL_TO, 'adverse') };
  const sampleEnough = discovery.stress.events >= 200 && validation.stress.events >= 100;
  const bothStressPositive = discovery.stress.net >= 0 && validation.stress.net >= 0;
  const bothAdversePositive = discovery.adverse.net >= 0 && validation.adverse.net >= 0;
  const edgeFloor = sampleEnough && bothStressPositive && bothAdversePositive;
  const minFreq = Math.min(discovery.stress.eventsPerDay, validation.stress.eventsPerDay);
  const requiredSizeFor5x = minFreq > 0 ? 5 / (2 * minFreq) : null;
  const maxConc = Math.max(maxConcurrency(trades, DISC_FROM, DISC_TO), maxConcurrency(trades, DISC_TO, VAL_TO));
  const requiredGrossFor5x = requiredSizeFor5x == null ? null : requiredSizeFor5x * maxConc;
  const paths = requiredSizeFor5x == null ? null : {
    discovery: scaledPath(trades, DISC_FROM, DISC_TO, 'stress', requiredSizeFor5x),
    validation: scaledPath(trades, DISC_TO, VAL_TO, 'stress', requiredSizeFor5x),
    discoveryAdverse: scaledPath(trades, DISC_FROM, DISC_TO, 'adverse', requiredSizeFor5x),
    validationAdverse: scaledPath(trades, DISC_TO, VAL_TO, 'adverse', requiredSizeFor5x),
  };
  const viable5x = edgeFloor && requiredSizeFor5x <= 0.15 && requiredGrossFor5x <= 2.5
    && paths.discovery.minEquity > 0.20 && paths.validation.minEquity > 0.20
    && paths.discoveryAdverse.minEquity > 0.20 && paths.validationAdverse.minEquity > 0.20;
  const minPf = Math.min(discovery.stress.pf, validation.stress.pf);
  const score = (edgeFloor ? 1000 : 0) + (viable5x ? 10000 : 0) + minPf * 100 + Math.min(100, minFreq)
    - (requiredGrossFor5x ?? 99) * 2;
  candidates.push({ c, discovery, validation, sampleEnough, bothStressPositive, bothAdversePositive,
    edgeFloor, minFreq, requiredSizeFor5x, maxConcurrency: maxConc, requiredGrossFor5x, fiveXPaths: paths, viable5x, score });
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

const byFailure = Object.fromEntries(FAIL_TYPES.map((type) => {
  const xs = diagnosticPool.filter((x) => x.c.failType === type);
  return [type, {
    configs: xs.length,
    discoveryStressPositive: xs.filter((x) => x.discovery.stress.net >= 0).length,
    validationStressPositive: xs.filter((x) => x.validation.stress.net >= 0).length,
    bothStressPositive: xs.filter((x) => x.bothStressPositive).length,
    bothAdversePositive: xs.filter((x) => x.bothAdversePositive).length,
    edgeFloor: xs.filter((x) => x.edgeFloor).length,
    viable5x: xs.filter((x) => x.viable5x).length,
  }];
}));

const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 20);
const result = {
  research: '5m-failed-impulse-turnover-v1',
  objective: 'test completed-bar false-breakout / impulse-failure reversal as a native short-horizon turnover engine',
  protocol: {
    periods: { discovery: [DISC_FROM, DISC_TO], validation: [DISC_TO, VAL_TO], evaluation: [VAL_TO, EVAL_TO] },
    symbols,
    configs: candidates.length,
    baselineBars: BASELINE,
    breakLookbacks: BREAK_LOOKBACKS,
    bodyMins: BODY_MINS,
    rangeMultiples: RANGE_XS,
    volumeMultiples: VOL_XS,
    failureTypes: FAIL_TYPES,
    holdBars: HOLDS,
    execution: 'impulse bar must break a prior 1h/3h/6h extreme; failure is confirmed by the next completed 5m bar; entry uses the immediately following 5m open; same-symbol overlap forbidden',
    costs: { baseRoundTrip: BASE_RT_COST, stressRoundTrip: STRESS_RT_COST, adverseEntrySlip: ADVERSE_ENTRY_SLIP },
    turnover: 'genuine entry+exit notional only; 5x sizing = 5 / (2 * minimum discovery/validation events-per-day); no self-trade or order splitting',
    evaluationGate: '2026-06..2026-08 is opened only for one rule frozen from discovery+validation if the same rule is non-negative under both stress and adverse assumptions',
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
  },
  byFailure,
  selected,
  evaluation,
  viable: viable.slice(0, 20),
  edge: edge.slice(0, 20),
  topNear,
};
writeFileSync(OUTPUT, `${JSON.stringify(result)}\n`);
console.log(`FAILED_IMPULSE_5M_TURNOVER=${JSON.stringify(result)}`);
