import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/turnover-rolling-tranche-5x.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

// Frozen PRM-753 signal. Only execution layering changes in this study.
const WINDOW = 336;
const MIN_CORR = 0.50;
const ENTRY_Z = 2.00;
const PERSISTENCE_HOURS = 24;
const HOLD_HOURS = 24;

const REFRESH_HOURS = [3, 6, 12];
const TRANCHE_GROSS = [0.50, 0.75, 1.00];
const MAX_PAIR_TRANCHES = [2, 3, 4];
const GROSS_CAPS = [1.50, 2.00, 3.00, 4.00];
const TARGET_TURNOVER = 5.0;

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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, [...d.rows].sort((a, b) => a.time - b.time)]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const anchor = rowsBySymbol.get('BTC_USDT') ?? rowsBySymbol.values().next().value;
const times = anchor.map((r) => r.time).filter((t) => t >= OLD_FROM && t < EVAL_TO);

function intervalResidual(a, b, t, hours, beta) {
  const am = rowMap.get(a); const bm = rowMap.get(b);
  const a0 = am.get(t - hours * HOUR)?.close; const a1 = am.get(t)?.close;
  const b0 = bm.get(t - hours * HOUR)?.close; const b1 = bm.get(t)?.close;
  if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
  return Math.log(a1 / a0) - beta * Math.log(b1 / b0);
}

function pairFeature(a, b, t) {
  const am = rowMap.get(a); const bm = rowMap.get(b);
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let k = WINDOW; k >= 1; k -= 1) {
    const a0 = am.get(t - k * HOUR)?.close; const a1 = am.get(t - (k - 1) * HOUR)?.close;
    const b0 = bm.get(t - k * HOUR)?.close; const b1 = bm.get(t - (k - 1) * HOUR)?.close;
    if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
    const x = Math.log(a1 / a0); const y = Math.log(b1 / b0);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const n = WINDOW; const mx = sx / n; const my = sy / n;
  const vx = Math.max(0, sxx / n - mx * mx); const vy = Math.max(0, syy / n - my * my);
  const cov = sxy / n - mx * my;
  if (!(vx > 1e-12) || !(vy > 1e-12)) return null;
  const corr = cov / Math.sqrt(vx * vy); const beta = cov / vy;
  if (!Number.isFinite(corr) || !Number.isFinite(beta) || beta < 0.25 || beta > 4) return null;
  const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
  const residual = sx - beta * sy;
  const z = residual / Math.sqrt(residualVar * n);
  const r24 = intervalResidual(a, b, t, PERSISTENCE_HOURS, beta);
  if (!Number.isFinite(z) || !Number.isFinite(r24)) return null;
  return { a, b, signalAt: t, corr, beta, z, absZ: Math.abs(z), r24 };
}

// Precompute every hour so 3h/6h/12h refreshes share identical causal features.
const featuresByTime = new Map();
for (const t of times) {
  if (t < OLD_FROM + WINDOW * HOUR) continue;
  const rows = [];
  for (let i = 0; i < symbols.length; i += 1) for (let j = i + 1; j < symbols.length; j += 1) {
    const f = pairFeature(symbols[i], symbols[j], t);
    if (f && f.corr >= MIN_CORR && f.absZ >= ENTRY_Z && Math.sign(f.r24) === Math.sign(f.z) && Math.abs(f.r24) > 1e-6) rows.push(f);
  }
  if (rows.length) featuresByTime.set(t, rows.sort((x, y) => y.absZ - x.absZ || y.corr - x.corr));
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol); const e0 = rm.get(entryAt)?.open; const x0 = rm.get(exitAt)?.open;
  if (![e0, x0].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? e0 * (1 + slip) : e0 * (1 - slip);
  return direction > 0 ? x0 / entry - 1 : 1 - x0 / entry;
}

function samePair(x, f) {
  return x.a === f.a && x.b === f.b;
}

function generate(config, until) {
  let active = [];
  const out = [];
  let maxConcurrentGross = 0;
  let blockedOpposite = 0;
  let blockedConflict = 0;
  let blockedGross = 0;
  let blockedPairCap = 0;

  for (const [signalAt, rows] of featuresByTime) {
    if (signalAt >= until) break;
    const hour = new Date(signalAt * 1000).getUTCHours();
    if (hour % config.refreshHours !== 0) continue;

    const entryAt = signalAt + HOUR;
    const exitAt = entryAt + HOLD_HOURS * HOUR;
    if (exitAt > until) continue;

    active = active.filter((x) => x.exitAt > entryAt);
    const activeGross = sum(active.map((x) => x.trancheGross));
    maxConcurrentGross = Math.max(maxConcurrentGross, activeGross);

    // Keep rank-1 semantics. Do not substitute rank-2 if rank-1 is blocked.
    const f = rows[0];
    if (!f) continue;
    const dirA = f.z > 0 ? 1 : -1;
    const dirB = -dirA;

    const same = active.filter((x) => samePair(x, f));
    if (same.some((x) => x.dirA !== dirA || x.dirB !== dirB)) {
      blockedOpposite += 1;
      continue;
    }
    if (same.length >= config.maxPairTranches) {
      blockedPairCap += 1;
      continue;
    }

    const conflicts = active.filter((x) => !samePair(x, f) && (x.a === f.a || x.a === f.b || x.b === f.a || x.b === f.b));
    if (conflicts.length) {
      blockedConflict += 1;
      continue;
    }

    if (activeGross + config.trancheGross > config.grossCap + 1e-9) {
      blockedGross += 1;
      continue;
    }

    const betaAbs = Math.abs(f.beta);
    const wA = 1 / (1 + betaAbs); const wB = betaAbs / (1 + betaAbs);
    const aBase = legReturn(f.a, dirA, entryAt, exitAt, ENTRY_SLIP);
    const bBase = legReturn(f.b, dirB, entryAt, exitAt, ENTRY_SLIP);
    const aAdv = legReturn(f.a, dirA, entryAt, exitAt, ADVERSE_SLIP);
    const bAdv = legReturn(f.b, dirB, entryAt, exitAt, ADVERSE_SLIP);
    if (![aBase, bBase, aAdv, bAdv].every(Number.isFinite)) continue;

    const raw = wA * aBase + wB * bBase;
    const adverseRaw = wA * aAdv + wB * bAdv;
    const g = config.trancheGross;
    const event = {
      ...f, entryAt, exitAt, dirA, dirB, wA, wB, trancheGross: g,
      stress: g * (raw - STRESS_COST),
      adverse: g * (adverseRaw - BASE_COST),
      base: g * (raw - BASE_COST),
      roundTripTurnover: 2 * g,
      month: monthKey(entryAt),
    };
    out.push(event);
    active.push(event);
    maxConcurrentGross = Math.max(maxConcurrentGross, activeGross + g);
  }

  return { events: out, maxConcurrentGross, blockedOpposite, blockedConflict, blockedGross, blockedPairCap };
}

function stats(run, from, to, field = 'stress') {
  const xs = run.events.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const days = (to - from) / DAY;
  const net = sum(xs.map((e) => e[field]));
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))) {
    equity += e[field]; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const turnoverPerDay = days ? sum(xs.map((e) => e.roundTripTurnover)) / days : 0;
  const avgDaily = days ? net / days : 0;
  return {
    events: xs.length,
    eventsPerDay: days ? xs.length / days : 0,
    turnoverPerDay,
    net,
    avgDaily1000U: avgDaily * 1000,
    avgMonthlyReturn: avgDaily * 30,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    maxConcurrentGross: run.maxConcurrentGross,
  };
}

const candidates = [];
let id = 0;
for (const refreshHours of REFRESH_HOURS) for (const trancheGross of TRANCHE_GROSS)
for (const maxPairTranches of MAX_PAIR_TRANCHES) for (const grossCap of GROSS_CAPS) {
  if (grossCap + 1e-9 < trancheGross) continue;
  const c = { id: `RT5-${id++}`, refreshHours, trancheGross, maxPairTranches, grossCap };
  const run = generate(c, TRAIN_TO);
  const old = { stress: stats(run, OLD_FROM, OLD_TO, 'stress'), adverse: stats(run, OLD_FROM, OLD_TO, 'adverse') };
  const current = { stress: stats(run, CURRENT_FROM, TRAIN_TO, 'stress'), adverse: stats(run, CURRENT_FROM, TRAIN_TO, 'adverse') };
  const sampleEnough = old.stress.events >= 120 && current.stress.events >= 90;
  const edgeFloor = sampleEnough
    && old.stress.net >= 0 && current.stress.net >= 0
    && old.adverse.net >= 0 && current.adverse.net >= 0
    && old.stress.pf >= 1.0 && current.stress.pf >= 1.0;
  const minTurnover = Math.min(old.stress.turnoverPerDay, current.stress.turnoverPerDay);
  const target5x = minTurnover >= TARGET_TURNOVER;
  const score = edgeFloor ? minTurnover + (target5x ? 100 : 0) : -100 + minTurnover;
  candidates.push({ c, old, current, sampleEnough, edgeFloor, minTurnover, target5x, score, runDiagnostics: {
    maxConcurrentGross: run.maxConcurrentGross,
    blockedOpposite: run.blockedOpposite,
    blockedConflict: run.blockedConflict,
    blockedGross: run.blockedGross,
    blockedPairCap: run.blockedPairCap,
  }});
}

const sampleQualified = candidates.filter((x) => x.sampleEnough);
const edgeQualified = sampleQualified.filter((x) => x.edgeFloor).sort((a, b) => b.minTurnover - a.minTurnover);
const targetQualified = edgeQualified.filter((x) => x.target5x).sort((a, b) => b.minTurnover - a.minTurnover);
const topNear = [...candidates].sort((a, b) => {
  const ae = Number(a.edgeFloor); const be = Number(b.edgeFloor);
  return be - ae || b.minTurnover - a.minTurnover;
}).slice(0, 20);

let evaluationOpened = false;
let evaluation = [];
if (targetQualified.length) {
  evaluationOpened = true;
  for (const q of targetQualified.slice(0, 5)) {
    const run = generate(q.c, EVAL_TO);
    const stress = stats(run, TRAIN_TO, EVAL_TO, 'stress');
    const adverse = stats(run, TRAIN_TO, EVAL_TO, 'adverse');
    evaluation.push({
      c: q.c,
      discoveryMinTurnover: q.minTurnover,
      stress,
      adverse,
      evaluationPositive: stress.net >= 0 && adverse.net >= 0 && stress.pf >= 1.0,
      evaluationHits5x: stress.turnoverPerDay >= TARGET_TURNOVER,
    });
  }
}

const diagnostics = {
  configs: candidates.length,
  sampleQualified: sampleQualified.length,
  edgeFloor: edgeQualified.length,
  target5x: targetQualified.length,
  evaluationOpened,
};

const output = {
  research: 'turnover-rolling-tranche-5x-v1',
  objective: 'find a genuine ~5x equity/day round-trip turnover structure first; 5x is a target, not a universal production hard gate; after-fee stress/adverse non-loss is the floor',
  frozenSignal: { window: WINDOW, minCorr: MIN_CORR, entryZ: ENTRY_Z, persistenceHours: PERSISTENCE_HOURS, holdHours: HOLD_HOURS, direction: 'follow relative winner / short relative loser' },
  protocol: {
    symbols,
    refreshHours: REFRESH_HOURS,
    trancheGross: TRANCHE_GROSS,
    maxPairTranches: MAX_PAIR_TRANCHES,
    grossCaps: GROSS_CAPS,
    targetTurnoverPerDay: TARGET_TURNOVER,
    sameDirectionRollingTranchesOnly: true,
    oppositeDirectionOverlapForbidden: true,
    sameSymbolDifferentPairOverlapForbidden: true,
    rank1Only: true,
    noSelfTrade: true,
    noFakeVolume: true,
    costsPerUnitGrossNotional: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
    entry: 'next hourly open after completed signal; each tranche exits 24h later',
  },
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  diagnostics,
  topTargetQualified: targetQualified.slice(0, 20),
  topEdgeQualified: edgeQualified.slice(0, 20),
  topNear,
  evaluation,
  note: 'This stage tests whether the already-discovered PRM-753 edge can create materially higher genuine turnover through same-direction rolling tranches while the signal remains persistent. It does not count self-trades or opposite-direction offsets as turnover.',
};

writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`TURNOVER_ROLLING_TRANCHE_5X=${JSON.stringify({ objective: output.objective, diagnostics, topTargetQualified: output.topTargetQualified.slice(0, 5), topEdgeQualified: output.topEdgeQualified.slice(0, 5), topNear: topNear.slice(0, 5), evaluation })}`);
