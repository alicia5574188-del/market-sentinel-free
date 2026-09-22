import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/turnover-orthogonal-rank1.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const WINDOW = 336;
const MIN_CORR = 0.50;
const ENTRY_Z = 2.0;
const PERSISTENCE_HOURS = 24;
const HOLD_HOURS = 24;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;
const MAX_GROSS_X = 10;
const DECISION_STEPS = [1, 3, 6];
const MAX_RESIDUAL_CORRS = [0.10, 0.25, 0.40, 0.60, 1.00];
const MAX_PAIRS = [1, 2, 3, 4, 5, 6];
const DD_CAPS = [0.20, 0.50, 0.80];

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

const datasets = DATA.datasets.map((d) => ({ ...d, rows: [...d.rows].sort((a, b) => a.time - b.time) }));
const symbols = datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const anchorRows = (rowMap.get('BTC_USDT') ? datasets.find((d) => d.symbol === 'BTC_USDT') : datasets[0]).rows;
const times = anchorRows.map((r) => r.time).filter((t) => t >= OLD_FROM - (WINDOW + PERSISTENCE_HOURS + 2) * HOUR && t < EVAL_TO + (HOLD_HOURS + 2) * HOUR);
const timeIndex = new Map(times.map((t, i) => [t, i]));
const n = times.length;

const opens = new Map();
const closes = new Map();
const rets = new Map();
for (const s of symbols) {
  const rm = rowMap.get(s);
  const o = new Array(n).fill(NaN);
  const c = new Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    const r = rm.get(times[i]);
    if (r) { o[i] = Number(r.open); c[i] = Number(r.close); }
  }
  const rr = new Array(n).fill(NaN);
  for (let i = 1; i < n; i += 1) if (c[i] > 0 && c[i - 1] > 0) rr[i] = Math.log(c[i] / c[i - 1]);
  opens.set(s, o); closes.set(s, c); rets.set(s, rr);
}

function pref(values) {
  const p = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) p[i + 1] = p[i] + values[i];
  return p;
}
function range(p, a, b) { return p[b + 1] - p[a]; }

const pairs = [];
let pairId = 0;
for (let ai = 0; ai < symbols.length; ai += 1) {
  for (let bi = ai + 1; bi < symbols.length; bi += 1) {
    const a = symbols[ai]; const b = symbols[bi];
    const ar = rets.get(a); const br = rets.get(b);
    const vx = new Array(n).fill(0); const vy = new Array(n).fill(0);
    const vxx = new Array(n).fill(0); const vyy = new Array(n).fill(0); const vxy = new Array(n).fill(0); const vv = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(ar[i]) && Number.isFinite(br[i])) {
        vx[i] = ar[i]; vy[i] = br[i]; vxx[i] = ar[i] * ar[i]; vyy[i] = br[i] * br[i]; vxy[i] = ar[i] * br[i]; vv[i] = 1;
      }
    }
    pairs.push({ id: pairId++, a, b, ar, br, px: pref(vx), py: pref(vy), pxx: pref(vxx), pyy: pref(vyy), pxy: pref(vxy), pv: pref(vv) });
  }
}

function featureAt(pair, i) {
  const start = i - WINDOW + 1;
  if (start < 1) return null;
  if (range(pair.pv, start, i) !== WINDOW) return null;
  const sx = range(pair.px, start, i); const sy = range(pair.py, start, i);
  const sxx = range(pair.pxx, start, i); const syy = range(pair.pyy, start, i); const sxy = range(pair.pxy, start, i);
  const mx = sx / WINDOW; const my = sy / WINDOW;
  const vx = Math.max(0, sxx / WINDOW - mx * mx); const vy = Math.max(0, syy / WINDOW - my * my);
  const cov = sxy / WINDOW - mx * my;
  if (!(vx > 1e-12) || !(vy > 1e-12)) return null;
  const corr = cov / Math.sqrt(vx * vy); const beta = cov / vy;
  if (!Number.isFinite(corr) || !Number.isFinite(beta) || beta < 0.25 || beta > 4) return null;
  const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
  const residual = sx - beta * sy;
  const z = residual / Math.sqrt(residualVar * WINDOW);
  if (!Number.isFinite(z)) return null;
  return { pairId: pair.id, a: pair.a, b: pair.b, corr, beta, z, absZ: Math.abs(z) };
}

const startSignalIndex = Math.max(WINDOW + PERSISTENCE_HOURS + 1, timeIndex.get(OLD_FROM) ?? 0);
const endSignalIndex = Math.min(n - HOLD_HOURS - 2, timeIndex.get(EVAL_TO) ?? n);
const signalRows = new Map();
for (let i = startSignalIndex; i < endSignalIndex; i += 1) {
  const rows = [];
  for (const pair of pairs) {
    const f = featureAt(pair, i);
    if (!f || f.corr < MIN_CORR || f.absZ < ENTRY_Z) continue;
    const p = featureAt(pair, i - PERSISTENCE_HOURS);
    if (!p || Math.sign(p.z) !== Math.sign(f.z)) continue;
    rows.push(f);
  }
  if (rows.length) rows.sort((x, y) => y.absZ - x.absZ || y.corr - x.corr), signalRows.set(i, rows);
}

const residCorrCache = new Map();
function residualCorr(f, g, i) {
  const lo = i - 167;
  if (lo < 1) return 1;
  const k1 = Math.min(f.pairId, g.pairId); const k2 = Math.max(f.pairId, g.pairId);
  const key = `${i}:${k1}:${k2}:${f.beta.toFixed(5)}:${g.beta.toFixed(5)}`;
  if (residCorrCache.has(key)) return residCorrCache.get(key);
  const p1 = pairs[f.pairId]; const p2 = pairs[g.pairId];
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0; let count = 0;
  for (let k = lo; k <= i; k += 1) {
    const a1 = p1.ar[k]; const b1 = p1.br[k]; const a2 = p2.ar[k]; const b2 = p2.br[k];
    if (![a1, b1, a2, b2].every(Number.isFinite)) continue;
    const x = a1 - f.beta * b1; const y = a2 - g.beta * b2;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; count += 1;
  }
  if (count < 120) return 1;
  const mx = sx / count; const my = sy / count;
  const vx = Math.max(0, sxx / count - mx * mx); const vy = Math.max(0, syy / count - my * my);
  const cov = sxy / count - mx * my;
  const out = vx > 1e-12 && vy > 1e-12 ? cov / Math.sqrt(vx * vy) : 1;
  residCorrCache.set(key, out);
  return out;
}

function legReturn(symbol, direction, entryIndex, exitIndex, slip) {
  const o = opens.get(symbol); const e0 = o[entryIndex]; const x0 = o[exitIndex];
  if (![e0, x0].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? e0 * (1 + slip) : e0 * (1 - slip);
  return direction > 0 ? x0 / entry - 1 : 1 - x0 / entry;
}

function generate(config, untilTs) {
  const untilIndex = Math.min(n - 1, timeIndex.get(untilTs) ?? n - 1);
  const busy = new Map(); const out = [];
  for (let i = startSignalIndex; i < untilIndex; i += 1) {
    const t = times[i]; const hour = new Date(t * 1000).getUTCHours();
    if (hour % config.decisionStep !== 0) continue;
    const rows = signalRows.get(i); if (!rows?.length) continue;
    const entryIndex = i + 1; const exitIndex = entryIndex + HOLD_HOURS;
    if (exitIndex >= untilIndex) continue;
    const selected = []; const usedNow = new Set();
    for (const f of rows) {
      if (selected.length >= config.maxPairs) break;
      if (usedNow.has(f.a) || usedNow.has(f.b)) continue;
      if ((busy.get(f.a) ?? -1) > entryIndex || (busy.get(f.b) ?? -1) > entryIndex) continue;
      let orthogonal = true;
      for (const g of selected) {
        if (Math.abs(residualCorr(f, g, i)) > config.maxResidualCorr) { orthogonal = false; break; }
      }
      if (!orthogonal) continue;
      const dirA = f.z > 0 ? 1 : -1; const dirB = -dirA;
      const betaAbs = Math.abs(f.beta); const wA = 1 / (1 + betaAbs); const wB = betaAbs / (1 + betaAbs);
      const aBase = legReturn(f.a, dirA, entryIndex, exitIndex, ENTRY_SLIP); const bBase = legReturn(f.b, dirB, entryIndex, exitIndex, ENTRY_SLIP);
      const aAdv = legReturn(f.a, dirA, entryIndex, exitIndex, ADVERSE_SLIP); const bAdv = legReturn(f.b, dirB, entryIndex, exitIndex, ADVERSE_SLIP);
      if (![aBase, bBase, aAdv, bAdv].every(Number.isFinite)) continue;
      const gross = wA * aBase + wB * bBase; const advGross = wA * aAdv + wB * bAdv;
      out.push({ ...f, signalAt: t, entryAt: times[entryIndex], exitAt: times[exitIndex], gross, base: gross - BASE_COST, stress: gross - STRESS_COST, adverse: advGross - BASE_COST, roundTripTurnover1x: 2, month: monthKey(times[entryIndex]) });
      busy.set(f.a, exitIndex); busy.set(f.b, exitIndex); usedNow.add(f.a); usedNow.add(f.b); selected.push(f);
    }
  }
  return out;
}

function stats(rows, from, to, field = 'stress') {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const days = (to - from) / DAY; const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field]))); const net = sum(xs.map((e) => e[field]));
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))) {
    equity += e[field]; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const turnover1xPerDay = days ? sum(xs.map((e) => e.roundTripTurnover1x)) / days : 0; const avgDaily = days ? net / days : 0;
  const scaling = Object.fromEntries(DD_CAPS.map((cap) => {
    const scale = maxDrawdown > 0 ? Math.min(MAX_GROSS_X, cap / maxDrawdown) : MAX_GROSS_X;
    return [String(cap), { scale, turnoverPerDay: turnover1xPerDay * scale, avgMonthlyReturn: avgDaily * 30 * scale }];
  }));
  const scaleTo10 = turnover1xPerDay > 0 ? 10 / turnover1xPerDay : Infinity;
  return { events: xs.length, eventsPerDay: days ? xs.length / days : 0, turnover1xPerDay, net, avgDaily1000At1x: avgDaily * 1000, avgNet: xs.length ? net / xs.length : 0, pf: losses ? gains / losses : gains ? 99 : 0, winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0, maxDrawdown, scaling, scaleTo10, tenXMaxDrawdown: Number.isFinite(scaleTo10) ? maxDrawdown * scaleTo10 : Infinity, tenXMonthlyReturn: Number.isFinite(scaleTo10) ? avgDaily * 30 * scaleTo10 : -Infinity };
}

const configs = []; let id = 0;
for (const decisionStep of DECISION_STEPS) for (const maxResidualCorr of MAX_RESIDUAL_CORRS) for (const maxPairs of MAX_PAIRS) configs.push({ id: `OR1-${id++}`, decisionStep, maxResidualCorr, maxPairs });

const results = [];
for (const c of configs) {
  const ev = generate(c, TRAIN_TO);
  const old = { stress: stats(ev, OLD_FROM, OLD_TO, 'stress'), adverse: stats(ev, OLD_FROM, OLD_TO, 'adverse') };
  const current = { stress: stats(ev, CURRENT_FROM, TRAIN_TO, 'stress'), adverse: stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse') };
  const sampleEnough = old.stress.events >= 120 && current.stress.events >= 90;
  const edgeFloor = sampleEnough && old.stress.net >= 0 && current.stress.net >= 0 && old.adverse.net >= 0 && current.adverse.net >= 0;
  const tenXGrossFeasible = old.stress.scaleTo10 <= MAX_GROSS_X && current.stress.scaleTo10 <= MAX_GROSS_X;
  const tenXSurvival = tenXGrossFeasible && old.stress.tenXMaxDrawdown < 0.95 && current.stress.tenXMaxDrawdown < 0.95;
  const tenXPreferred50 = tenXGrossFeasible && old.stress.tenXMaxDrawdown <= 0.50 && current.stress.tenXMaxDrawdown <= 0.50;
  const discoveryFloor = edgeFloor && tenXSurvival;
  const turnover50 = Math.min(old.stress.scaling['0.5'].turnoverPerDay, current.stress.scaling['0.5'].turnoverPerDay);
  results.push({ c, old, current, sampleEnough, edgeFloor, tenXGrossFeasible, tenXSurvival, tenXPreferred50, discoveryFloor, turnover50 });
}

const diagnosticPool = results.filter((x) => x.sampleEnough);
const qualified = results.filter((x) => x.discoveryFloor).sort((a, b) => Number(b.tenXPreferred50) - Number(a.tenXPreferred50) || b.turnover50 - a.turnover50 || Math.max(a.old.stress.tenXMaxDrawdown, a.current.stress.tenXMaxDrawdown) - Math.max(b.old.stress.tenXMaxDrawdown, b.current.stress.tenXMaxDrawdown));
const near = [...diagnosticPool].sort((a, b) => Number(b.edgeFloor) - Number(a.edgeFloor) || Number(b.tenXSurvival) - Number(a.tenXSurvival) || b.turnover50 - a.turnover50).slice(0, 20);

let evaluationOpened = false; const evaluation = [];
if (qualified.length) {
  evaluationOpened = true;
  for (const q of qualified.slice(0, 5)) {
    const ev = generate(q.c, EVAL_TO); const stress = stats(ev, TRAIN_TO, EVAL_TO, 'stress'); const adverse = stats(ev, TRAIN_TO, EVAL_TO, 'adverse');
    const evaluationEdge = stress.net >= 0 && adverse.net >= 0;
    const evaluationTenX = stress.scaleTo10 <= MAX_GROSS_X && stress.tenXMaxDrawdown < 0.95;
    evaluation.push({ c: q.c, discoveryTenXPreferred50: q.tenXPreferred50, discoveryTurnover50: q.turnover50, stress, adverse, evaluationEdge, evaluationTenX, evaluationQualified: evaluationEdge && evaluationTenX });
  }
}

const output = {
  research: 'turnover-orthogonal-rank1-v1',
  objective: 'hard target: >=10x account-equity genuine round-trip notional turnover/day; stress-cost and adverse-entry non-loss are mandatory; trade count is not a target',
  frozenSignal: { window: WINDOW, minCorr: MIN_CORR, entryZ: ENTRY_Z, persistenceHours: PERSISTENCE_HOURS, holdHours: HOLD_HOURS, direction: 'follow relative winner / short relative loser' },
  protocol: { decisionStepsHours: DECISION_STEPS, maxResidualCorrs: MAX_RESIDUAL_CORRS, maxPairs: MAX_PAIRS, noSelfTrade: true, noSameSymbolConcurrentPairs: true, residualOrthogonality: 'parallel pairs must have absolute 168h residual-return correlation <= configured cap', costsPerUnitGrossNotional: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP }, maxGrossX: MAX_GROSS_X, tenXSurvivalRule: 'scale required for 10x/day must be <=10x gross and modeled stress max drawdown must remain <95%; <=50% is reported as preferred, not required' },
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  diagnostics: { configs: results.length, sampleQualified: diagnosticPool.length, edgeFloor: results.filter((x) => x.edgeFloor).length, tenXSurvival: results.filter((x) => x.tenXSurvival).length, tenXPreferred50: results.filter((x) => x.tenXPreferred50).length, discoveryQualified: qualified.length, evaluationOpened },
  topQualified: qualified.slice(0, 10), topNear: near, evaluation,
  note: 'This stage does not manufacture turnover by self-trading or offsetting the same symbol. It tries to preserve the frozen PRM-753 rank-1 continuation idea while running multiple low-residual-correlation rank-1 sleeves in parallel. A candidate only qualifies if the real gross turnover can reach 10x equity/day without modeled historical ruin and both discovery eras remain non-negative after stress cost and adverse entry.'
};
writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`TURNOVER_ORTHOGONAL_RANK1=${JSON.stringify({ objective: output.objective, diagnostics: output.diagnostics, topQualified: output.topQualified.slice(0, 3), topNear: output.topNear.slice(0, 5), evaluation: output.evaluation })}`);
