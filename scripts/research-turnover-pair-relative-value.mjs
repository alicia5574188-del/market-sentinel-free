import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/turnover-pair-relative-value.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;
const DECISION_STEP_HOURS = 6;
const MAX_GROSS_X = 5;
const WINDOWS = [72, 168, 336];
const MIN_CORRS = [0.50, 0.65, 0.80];
const ENTRY_ZS = [1.25, 1.75, 2.25];
const HOLDS = [6, 12, 24];
const DEPTHS = [1, 2, 3];
const DD_CAPS = [0.10, 0.20, 0.30, 0.50];

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
const anchor = rowsBySymbol.get('BTC_USDT') ?? rowsBySymbol.values().next().value;
const times = anchor.map((r) => r.time).filter((t) => t >= OLD_FROM && t < EVAL_TO);

function pairFeature(a, b, t, window) {
  const am = rowMap.get(a);
  const bm = rowMap.get(b);
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let k = window; k >= 1; k -= 1) {
    const a0 = am.get(t - k * HOUR)?.close;
    const a1 = am.get(t - (k - 1) * HOUR)?.close;
    const b0 = bm.get(t - k * HOUR)?.close;
    const b1 = bm.get(t - (k - 1) * HOUR)?.close;
    if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
    const x = Math.log(a1 / a0);
    const y = Math.log(b1 / b0);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const n = window;
  const mx = sx / n; const my = sy / n;
  const vx = Math.max(0, sxx / n - mx * mx);
  const vy = Math.max(0, syy / n - my * my);
  const cov = sxy / n - mx * my;
  if (!(vx > 1e-12) || !(vy > 1e-12)) return null;
  const corr = cov / Math.sqrt(vx * vy);
  const beta = cov / vy;
  if (!Number.isFinite(corr) || !Number.isFinite(beta) || beta < 0.25 || beta > 4) return null;
  const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
  const residual = sx - beta * sy;
  const z = residual / Math.sqrt(residualVar * n);
  if (!Number.isFinite(z)) return null;
  return { a, b, signalAt: t, window, corr, beta, z, absZ: Math.abs(z) };
}

const featureByWindow = new Map();
for (const window of WINDOWS) {
  const byTime = new Map();
  for (const t of times) {
    const h = new Date(t * 1000).getUTCHours();
    if (h % DECISION_STEP_HOURS !== 0) continue;
    if (t < OLD_FROM + window * HOUR) continue;
    const rows = [];
    for (let i = 0; i < symbols.length; i += 1) {
      for (let j = i + 1; j < symbols.length; j += 1) {
        const f = pairFeature(symbols[i], symbols[j], t, window);
        if (f) rows.push(f);
      }
    }
    if (rows.length) byTime.set(t, rows);
  }
  featureByWindow.set(window, byTime);
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const e0 = rm.get(entryAt)?.open;
  const x0 = rm.get(exitAt)?.open;
  if (![e0, x0].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? e0 * (1 + slip) : e0 * (1 - slip);
  return direction > 0 ? x0 / entry - 1 : 1 - x0 / entry;
}

function generate(config, until) {
  const byTime = featureByWindow.get(config.window);
  const busy = new Map();
  const out = [];
  for (const [signalAt, rows] of byTime) {
    if (signalAt >= until) break;
    const entryAt = signalAt + HOUR;
    const exitAt = entryAt + config.hold * HOUR;
    if (exitAt > until) continue;
    const eligible = rows
      .filter((f) => f.corr >= config.minCorr && f.absZ >= config.entryZ)
      .sort((x, y) => y.absZ - x.absZ || y.corr - x.corr);
    const usedNow = new Set();
    let selected = 0;
    for (const f of eligible) {
      if (selected >= config.depth) break;
      if (usedNow.has(f.a) || usedNow.has(f.b)) continue;
      if ((busy.get(f.a) ?? 0) > entryAt || (busy.get(f.b) ?? 0) > entryAt) continue;
      const dirA = f.z > 0 ? -1 : 1;
      const dirB = -dirA;
      const betaAbs = Math.abs(f.beta);
      const wA = 1 / (1 + betaAbs);
      const wB = betaAbs / (1 + betaAbs);
      const aBase = legReturn(f.a, dirA, entryAt, exitAt, ENTRY_SLIP);
      const bBase = legReturn(f.b, dirB, entryAt, exitAt, ENTRY_SLIP);
      const aAdv = legReturn(f.a, dirA, entryAt, exitAt, ADVERSE_SLIP);
      const bAdv = legReturn(f.b, dirB, entryAt, exitAt, ADVERSE_SLIP);
      if (![aBase, bBase, aAdv, bAdv].every(Number.isFinite)) continue;
      const gross = wA * aBase + wB * bBase;
      const adverseGross = wA * aAdv + wB * bAdv;
      out.push({
        ...f, entryAt, exitAt, dirA, dirB, wA, wB,
        gross,
        base: gross - BASE_COST,
        stress: gross - STRESS_COST,
        adverse: adverseGross - BASE_COST,
        roundTripTurnover1x: 2,
        month: monthKey(entryAt),
      });
      busy.set(f.a, exitAt); busy.set(f.b, exitAt);
      usedNow.add(f.a); usedNow.add(f.b);
      selected += 1;
    }
  }
  return out;
}

function stats(rows, from, to, field = 'stress') {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const days = (to - from) / DAY;
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(xs.map((e) => e[field]));
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))) {
    equity += e[field];
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const turnover1xPerDay = days ? sum(xs.map((e) => e.roundTripTurnover1x)) / days : 0;
  const avgDaily = days ? net / days : 0;
  const scaling = Object.fromEntries(DD_CAPS.map((cap) => {
    const scale = maxDrawdown > 0 ? Math.min(MAX_GROSS_X, cap / maxDrawdown) : MAX_GROSS_X;
    return [String(cap), {
      scale,
      turnoverPerDay: turnover1xPerDay * scale,
      avgMonthlyReturn: avgDaily * 30 * scale,
      avgMonthly1000U: avgDaily * 30 * scale * 1000,
    }];
  }));
  return {
    events: xs.length,
    eventsPerDay: days ? xs.length / days : 0,
    turnover1xPerDay,
    net,
    avgDaily1000At1x: avgDaily * 1000,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    scaling,
  };
}

function positiveMonths(rows, from, to, field = 'stress') {
  return monthKeys(from, to).filter((m) => sum(rows.filter((e) => e.month === m && e.entryAt >= from && e.exitAt <= to).map((e) => e[field])) > 0).length;
}

const candidates = [];
let id = 0;
for (const window of WINDOWS) for (const minCorr of MIN_CORRS) for (const entryZ of ENTRY_ZS)
for (const hold of HOLDS) for (const depth of DEPTHS) {
  const c = { id: `PRV-${id++}`, window, minCorr, entryZ, hold, depth };
  const ev = generate(c, TRAIN_TO);
  const old = {
    stress: stats(ev, OLD_FROM, OLD_TO, 'stress'),
    adverse: stats(ev, OLD_FROM, OLD_TO, 'adverse'),
  };
  const current = {
    stress: stats(ev, CURRENT_FROM, TRAIN_TO, 'stress'),
    adverse: stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse'),
  };
  const oldPositiveMonths = positiveMonths(ev, OLD_FROM, OLD_TO);
  const currentPositiveMonths = positiveMonths(ev, CURRENT_FROM, TRAIN_TO);
  const sampleEnough = old.stress.events >= 120 && current.stress.events >= 90;
  const discoveryFloor = sampleEnough
    && old.stress.net > 0 && current.stress.net > 0
    && old.adverse.net > 0 && current.adverse.net > 0
    && old.stress.pf >= 1.01 && current.stress.pf >= 1.01
    && oldPositiveMonths >= 6 && currentPositiveMonths >= 4;
  const turnover20 = Math.min(old.stress.scaling['0.2'].turnoverPerDay, current.stress.scaling['0.2'].turnoverPerDay);
  const monthly20 = Math.min(old.stress.scaling['0.2'].avgMonthlyReturn, current.stress.scaling['0.2'].avgMonthlyReturn);
  const score = discoveryFloor ? turnover20 * (1 + Math.min(0.25, Math.max(0, monthly20))) : -1;
  candidates.push({ c, old, current, oldPositiveMonths, currentPositiveMonths, sampleEnough, discoveryFloor, turnover20, monthly20, score });
}

const diagnosticPool = candidates.filter((x) => x.sampleEnough);
const qualified = candidates.filter((x) => x.discoveryFloor).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => {
  const apos = Number(a.old.stress.net > 0) + Number(a.current.stress.net > 0) + Number(a.old.adverse.net > 0) + Number(a.current.adverse.net > 0);
  const bpos = Number(b.old.stress.net > 0) + Number(b.current.stress.net > 0) + Number(b.old.adverse.net > 0) + Number(b.current.adverse.net > 0);
  return bpos - apos || b.turnover20 - a.turnover20;
}).slice(0, 30);

let evaluationOpened = false;
let evaluation = [];
if (qualified.length) {
  evaluationOpened = true;
  for (const q of qualified.slice(0, 3)) {
    const ev = generate(q.c, EVAL_TO);
    const stress = stats(ev, TRAIN_TO, EVAL_TO, 'stress');
    const adverse = stats(ev, TRAIN_TO, EVAL_TO, 'adverse');
    evaluation.push({
      c: q.c,
      discoveryTurnover20: q.turnover20,
      discoveryMonthly20: q.monthly20,
      stress,
      adverse,
      positiveMonths: positiveMonths(ev, TRAIN_TO, EVAL_TO),
      evaluationPositive: stress.net > 0 && adverse.net > 0 && stress.pf >= 1.0,
    });
  }
}

const output = {
  research: 'turnover-pair-relative-value-v1',
  objective: 'maximize genuine daily notional turnover; trade count is diagnostic only; after-fee stress profitability is the floor; ~5% monthly is acceptable',
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  protocol: {
    symbols,
    decisionEveryHours: DECISION_STEP_HOURS,
    marketNeutralConstruction: 'pair residual = log-return(A) - rollingBeta*log-return(B); fade standardized residual; gross weights normalized to 1 and beta-weighted',
    entry: 'next hourly open after completed signal',
    noFutureLeakage: true,
    noSelfTrade: true,
    noSameSymbolConcurrentPairs: true,
    costsPerUnitGrossNotional: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
    maxGrossX: MAX_GROSS_X,
    ddCaps: DD_CAPS,
    turnoverDefinition: 'round-trip sum of actual long+short gross notional; no fake/self-offset volume',
  },
  grid: { windows: WINDOWS, minCorrs: MIN_CORRS, entryZs: ENTRY_ZS, holds: HOLDS, depths: DEPTHS, candidates: candidates.length },
  diagnostics: {
    candidates: candidates.length,
    diagnosticPool: diagnosticPool.length,
    oldStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0).length,
    currentStressPositive: diagnosticPool.filter((x) => x.current.stress.net > 0).length,
    bothStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0 && x.current.stress.net > 0).length,
    bothAdversePositive: diagnosticPool.filter((x) => x.old.adverse.net > 0 && x.current.adverse.net > 0).length,
    discoveryQualified: qualified.length,
    evaluationOpened,
  },
  topQualified: qualified.slice(0, 30),
  topNear,
  evaluation,
  note: 'This family is market-neutral by construction rather than a directional signal plus hedge. Its purpose is to test whether low-variance paired residual mean reversion can safely support materially larger genuine notional turnover. The 2026-06..2026-08 evaluation period is not touched unless at least one rule clears the frozen two-era discovery floor.',
};

writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`TURNOVER_PAIR_RELATIVE_VALUE=${JSON.stringify({
  objective: output.objective,
  grid: output.grid,
  diagnostics: output.diagnostics,
  topQualified: output.topQualified.slice(0, 8),
  topNear: output.topNear.slice(0, 8),
  evaluation,
  note: output.note,
})}`);
