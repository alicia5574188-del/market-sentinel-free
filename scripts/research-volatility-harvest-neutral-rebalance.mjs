import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-vol-harvest-37m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/volatility-harvest-neutral-rebalance.json';
if (DATA.interval !== '1h') throw new Error('Expected Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const CORE = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'];
const BASE_ONE_WAY_COST = 0.0007;   // 0.14% round-trip convention / 2
const STRESS_ONE_WAY_COST = 0.0011; // 0.22% round-trip convention / 2
const ADVERSE_ONE_WAY_COST = 0.00095; // base + 0.025% adverse entry per traded notional
const LOOKBACKS = [72, 168, 336];
const REBALANCE_HOURS = [1, 3, 6, 12];
const FRACTIONS = [0.25, 0.40];
const WEIGHTING = ['EQUAL', 'INV_VOL'];
const MODES = ['LOW_VOL_LONG', 'HIGH_VOL_LONG'];
const MIN_REBALANCE_TURNOVER = [0, 0.05, 0.10];
const MAX_HEDGE_ABS = 0.75;
const MAX_SCALE = 5;
const DD_CAPS = [0.20, 0.30, 0.50];

const P1_FROM = Date.UTC(2023, 8, 1) / 1000;
const P1_TO = Date.UTC(2024, 8, 1) / 1000;
const P2_FROM = P1_TO;
const P2_TO = Date.UTC(2025, 8, 1) / 1000;
const P3_FROM = P2_TO;
const P3_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_FROM = P3_TO;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;
const PERIODS = {
  era1: [P1_FROM, P1_TO],
  era2: [P2_FROM, P2_TO],
  era3: [P3_FROM, P3_TO],
  evaluation: [EVAL_FROM, EVAL_TO],
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : 0;
const monthKey = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, [...d.rows].sort((a, b) => a.time - b.time)]));
const symbols = [...rowsBySymbol.keys()];
for (const s of CORE) if (!rowsBySymbol.has(s)) throw new Error(`Missing core ${s}`);
if (symbols.length < 15) throw new Error(`Need >=15 coverage-qualified symbols, got ${symbols.length}`);
const rankSymbols = symbols.filter((s) => !CORE.includes(s));
if (rankSymbols.length < 10) throw new Error(`Need >=10 non-core symbols, got ${rankSymbols.length}`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const anchor = rowsBySymbol.get('BTC_USDT');
const commonTimes = anchor.map((r) => r.time).filter((t) => symbols.every((s) => rowMap.get(s).has(t)));
const timeIndex = new Map(commonTimes.map((t, i) => [t, i]));
if (!commonTimes.length) throw new Error('No common timeline');

// Hourly open-to-open simple returns on one common causal timeline.
const returns = new Map(symbols.map((s) => [s, new Float64Array(commonTimes.length)]));
for (const s of symbols) {
  const rm = rowMap.get(s); const out = returns.get(s);
  for (let i = 1; i < commonTimes.length; i += 1) {
    const p0 = rm.get(commonTimes[i - 1])?.open; const p1 = rm.get(commonTimes[i])?.open;
    out[i] = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : 0;
  }
}
const market = new Float64Array(commonTimes.length);
for (let i = 1; i < commonTimes.length; i += 1) {
  const core = CORE.map((s) => returns.get(s)[i]).sort((a, b) => a - b);
  market[i] = core[1];
}

function prefix(values) {
  const out = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) out[i + 1] = out[i] + values[i];
  return out;
}
const marketP = prefix(market);
const marketP2 = prefix(Float64Array.from(market, (x) => x * x));
const prefixes = new Map();
for (const s of symbols) {
  const x = returns.get(s);
  prefixes.set(s, {
    x: prefix(x),
    x2: prefix(Float64Array.from(x, (v) => v * v)),
    xy: prefix(Float64Array.from(x, (v, i) => v * market[i])),
  });
}
const rangeSum = (p, from, to) => p[to] - p[from];

// targetCache[lookback][timeIndex] -> per-symbol beta/residual volatility snapshot.
const featureCache = new Map();
for (const lookback of LOOKBACKS) {
  const byIndex = new Map();
  for (let i = lookback + 1; i < commonTimes.length; i += 1) {
    const from = i - lookback + 1; const to = i + 1; const n = to - from;
    const sy = rangeSum(marketP, from, to); const syy = rangeSum(marketP2, from, to);
    const my = sy / n; const vy = Math.max(1e-12, syy / n - my * my);
    const values = new Map();
    for (const s of symbols) {
      const p = prefixes.get(s);
      const sx = rangeSum(p.x, from, to); const sxx = rangeSum(p.x2, from, to); const sxy = rangeSum(p.xy, from, to);
      const mx = sx / n; const vx = Math.max(1e-12, sxx / n - mx * mx); const cov = sxy / n - mx * my;
      const beta = cov / vy;
      const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
      values.set(s, { beta, residualVol: Math.sqrt(residualVar), rawVol: Math.sqrt(vx) });
    }
    byIndex.set(i, values);
  }
  featureCache.set(lookback, byIndex);
}

function targetWeights(config, i) {
  const snapshot = featureCache.get(config.lookback).get(i);
  if (!snapshot) return null;
  const ranked = rankSymbols.map((symbol) => ({ symbol, ...snapshot.get(symbol) }))
    .filter((x) => Number.isFinite(x.beta) && Number.isFinite(x.residualVol) && x.residualVol > 1e-8)
    .sort((a, b) => a.residualVol - b.residualVol || a.symbol.localeCompare(b.symbol));
  const k = Math.max(2, Math.floor(ranked.length * config.fraction));
  if (ranked.length < k * 2) return null;
  const low = ranked.slice(0, k); const high = ranked.slice(-k);
  const longs = config.mode === 'LOW_VOL_LONG' ? low : high;
  const shorts = config.mode === 'LOW_VOL_LONG' ? high : low;
  const sideWeights = (rows, total, sign) => {
    if (config.weighting === 'EQUAL') return rows.map((x) => [x.symbol, sign * total / rows.length]);
    const inv = rows.map((x) => 1 / Math.max(x.residualVol, 1e-8)); const denom = sum(inv);
    return rows.map((x, idx) => [x.symbol, sign * total * inv[idx] / denom]);
  };
  const target = new Map([...sideWeights(longs, 0.5, 1), ...sideWeights(shorts, 0.5, -1)]);
  let betaExposure = 0;
  for (const [s, w] of target) betaExposure += w * snapshot.get(s).beta;
  const coreBetas = CORE.map((s) => snapshot.get(s)?.beta).filter(Number.isFinite);
  if (coreBetas.length !== CORE.length) return null;
  const avgCoreBeta = mean(coreBetas);
  if (Math.abs(avgCoreBeta) < 0.1) return null;
  const hedge = -betaExposure / avgCoreBeta;
  if (!Number.isFinite(hedge) || Math.abs(hedge) > MAX_HEDGE_ABS) return null;
  for (const s of CORE) target.set(s, (target.get(s) ?? 0) + hedge / CORE.length);
  return target;
}

const targetCache = new Map();
function cachedTarget(config, i) {
  const key = `${config.lookback}:${config.fraction}:${config.weighting}:${config.mode}`;
  if (!targetCache.has(key)) targetCache.set(key, new Map());
  const cache = targetCache.get(key);
  if (!cache.has(i)) cache.set(i, targetWeights(config, i));
  return cache.get(i);
}

function scheduled(t, hours) {
  return Math.floor(t / HOUR) % hours === 0;
}

function buildPath(config, from, to) {
  const startIndex = commonTimes.findIndex((t) => t >= from);
  const endIndexExclusive = commonTimes.findIndex((t) => t >= to);
  if (startIndex < 0) return null;
  const endIndex = endIndexExclusive < 0 ? commonTimes.length - 1 : endIndexExclusive;
  let weights = new Map(); let lastIndex = null; let totalTurnover = 0; let maxGross = 0; let rebalances = 0;
  const segments = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    const t = commonTimes[i];
    if (!scheduled(t, config.rebalanceHours)) continue;
    if (!featureCache.get(config.lookback).has(i)) continue;
    if (lastIndex != null) {
      let grossReturn = 0;
      const drifted = new Map();
      for (const [s, w] of weights) {
        const p0 = rowMap.get(s).get(commonTimes[lastIndex])?.open;
        const p1 = rowMap.get(s).get(t)?.open;
        const r = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : 0;
        grossReturn += w * r;
      }
      const denom = Math.max(1e-9, 1 + grossReturn);
      for (const [s, w] of weights) {
        const p0 = rowMap.get(s).get(commonTimes[lastIndex])?.open;
        const p1 = rowMap.get(s).get(t)?.open;
        const r = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : 0;
        drifted.set(s, w * (1 + r) / denom);
      }
      weights = drifted;
      segments.push({ at: t, grossReturn, turnover: 0 });
    }
    const desired = cachedTarget(config, i);
    if (!desired) { lastIndex = i; continue; }
    const keys = new Set([...weights.keys(), ...desired.keys()]);
    let turnover = 0;
    for (const s of keys) turnover += Math.abs((desired.get(s) ?? 0) - (weights.get(s) ?? 0));
    if (turnover >= config.minRebalanceTurnover) {
      if (!segments.length || segments.at(-1).at !== t) segments.push({ at: t, grossReturn: 0, turnover: 0 });
      segments.at(-1).turnover += turnover;
      totalTurnover += turnover; rebalances += 1; weights = new Map(desired);
    }
    maxGross = Math.max(maxGross, sum([...weights.values()].map(Math.abs)));
    lastIndex = i;
  }
  if (lastIndex == null) return null;
  // Mark to period end then close all remaining exposure; this makes turnover genuinely round-trip.
  const endTime = commonTimes[Math.min(endIndex, commonTimes.length - 1)];
  let grossReturn = 0;
  const drifted = new Map();
  for (const [s, w] of weights) {
    const p0 = rowMap.get(s).get(commonTimes[lastIndex])?.open;
    const p1 = rowMap.get(s).get(endTime)?.open;
    const r = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : 0;
    grossReturn += w * r;
  }
  const denom = Math.max(1e-9, 1 + grossReturn);
  for (const [s, w] of weights) {
    const p0 = rowMap.get(s).get(commonTimes[lastIndex])?.open;
    const p1 = rowMap.get(s).get(endTime)?.open;
    const r = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : 0;
    drifted.set(s, w * (1 + r) / denom);
  }
  const closeTurnover = sum([...drifted.values()].map(Math.abs));
  segments.push({ at: Math.min(to - 1, endTime), grossReturn, turnover: closeTurnover });
  totalTurnover += closeTurnover;
  return { segments, totalTurnover, maxGross, rebalances, days: (to - from) / DAY };
}

function evaluatePath(path, oneWayCost, scale = 1) {
  let equity = 1; let peak = 1; let minEquity = 1; let maxDrawdown = 0; let gains = 0; let losses = 0;
  const monthlyPnl = new Map();
  for (const seg of path.segments) {
    const netRate = scale * seg.grossReturn - oneWayCost * scale * seg.turnover;
    const pnl = equity * netRate;
    if (pnl > 0) gains += pnl; else losses += pnl;
    monthlyPnl.set(monthKey(seg.at), (monthlyPnl.get(monthKey(seg.at)) ?? 0) + pnl);
    equity += pnl;
    peak = Math.max(peak, equity); minEquity = Math.min(minEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 1);
    if (!(equity > 0)) break;
  }
  return {
    endEquity: equity, net: equity - 1, minEquity, maxDrawdown, survived: equity > 0,
    pf: losses < 0 ? gains / Math.abs(losses) : gains > 0 ? 99 : 0,
    turnoverPerDay: path.days ? path.totalTurnover * scale / path.days : 0,
    maxGross: path.maxGross * scale,
    rebalances: path.rebalances,
    positiveMonths: [...monthlyPnl.values()].filter((x) => x > 0).length,
    activeMonths: monthlyPnl.size,
  };
}

function periodStats(config, from, to, scale = 1) {
  const path = buildPath(config, from, to);
  if (!path) return null;
  return {
    path,
    base: evaluatePath(path, BASE_ONE_WAY_COST, scale),
    stress: evaluatePath(path, STRESS_ONE_WAY_COST, scale),
    adverse: evaluatePath(path, ADVERSE_ONE_WAY_COST, scale),
  };
}

const configs = []; let id = 0;
for (const lookback of LOOKBACKS) for (const rebalanceHours of REBALANCE_HOURS)
for (const fraction of FRACTIONS) for (const weighting of WEIGHTING) for (const mode of MODES)
for (const minRebalanceTurnover of MIN_REBALANCE_TURNOVER) {
  configs.push({ id: `VHN-${id++}`, lookback, rebalanceHours, fraction, weighting, mode, minRebalanceTurnover });
}

const tested = [];
for (const c of configs) {
  const era1 = periodStats(c, P1_FROM, P1_TO); const era2 = periodStats(c, P2_FROM, P2_TO); const era3 = periodStats(c, P3_FROM, P3_TO);
  if (!era1 || !era2 || !era3) continue;
  const rows = [era1, era2, era3];
  const floor = rows.every((r) => r.stress.net >= 0 && r.adverse.net >= 0 && r.stress.pf >= 1 && r.stress.survived);
  const minStress = Math.min(...rows.map((r) => r.stress.net));
  const minTurnover = Math.min(...rows.map((r) => r.stress.turnoverPerDay));
  const worstDd = Math.max(...rows.map((r) => r.stress.maxDrawdown));
  const score = floor ? (minStress + 1e-6) * Math.sqrt(Math.max(0.01, minTurnover)) / (0.10 + worstDd) : -1;
  tested.push({ c, era1: compact(era1), era2: compact(era2), era3: compact(era3), floor, minStress, minTurnover, worstDd, score });
}

function compact(value) {
  return { base: value.base, stress: value.stress, adverse: value.adverse };
}

const qualified = tested.filter((x) => x.floor).sort((a, b) => b.score - a.score);
const bestDiagnostics = [...tested].sort((a, b) => {
  const apos = [a.era1, a.era2, a.era3].filter((r) => r.stress.net >= 0).length;
  const bpos = [b.era1, b.era2, b.era3].filter((r) => r.stress.net >= 0).length;
  return bpos - apos || b.score - a.score || b.minStress - a.minStress;
}).slice(0, 20);

function scaledFrontier(row) {
  if (!row) return null;
  const config = row.c;
  const prePeriods = [[P1_FROM, P1_TO], [P2_FROM, P2_TO], [P3_FROM, P3_TO]];
  const result = {};
  for (const cap of DD_CAPS) {
    let best = null;
    for (let scale = 0.10; scale <= MAX_SCALE + 1e-9; scale += 0.10) {
      const stats = prePeriods.map(([from, to]) => periodStats(config, from, to, Number(scale.toFixed(2))));
      const worst = Math.max(...stats.map((s) => s.stress.maxDrawdown));
      const survived = stats.every((s) => s.stress.survived && s.adverse.survived);
      const positive = stats.every((s) => s.stress.net >= 0 && s.adverse.net >= 0);
      if (!survived || !positive || worst > cap + 1e-9) continue;
      best = { scale: Number(scale.toFixed(2)), worstDd: worst,
        minTurnover: Math.min(...stats.map((s) => s.stress.turnoverPerDay)),
        maxGross: Math.max(...stats.map((s) => s.stress.maxGross)) };
    }
    result[String(cap)] = best;
  }
  return result;
}

let frozen = null; let evaluation = null; let frontier = null;
if (qualified.length) {
  frozen = qualified[0];
  frontier = scaledFrontier(frozen);
  evaluation = { baseScale1: compact(periodStats(frozen.c, EVAL_FROM, EVAL_TO, 1)), byCap: {} };
  for (const cap of DD_CAPS) {
    const selected = frontier[String(cap)];
    evaluation.byCap[String(cap)] = selected ? { selected, result: compact(periodStats(frozen.c, EVAL_FROM, EVAL_TO, selected.scale)) } : null;
  }
}

const diagnostics = {
  configs: tested.length,
  floorQualified: qualified.length,
  era1StressPositive: tested.filter((x) => x.era1.stress.net >= 0).length,
  era2StressPositive: tested.filter((x) => x.era2.stress.net >= 0).length,
  era3StressPositive: tested.filter((x) => x.era3.stress.net >= 0).length,
  allThreeStressPositive: tested.filter((x) => x.era1.stress.net >= 0 && x.era2.stress.net >= 0 && x.era3.stress.net >= 0).length,
  allThreeAdversePositive: tested.filter((x) => x.era1.adverse.net >= 0 && x.era2.adverse.net >= 0 && x.era3.adverse.net >= 0).length,
};

const output = {
  research: 'volatility-harvest-neutral-rebalance-v1',
  objective: 'test a direction-forecast-free, beta-neutral volatility-dispersion rebalancing source for genuine turnover after realistic costs',
  data: { source: DATA.source, sha256: DATA.sha256, months: DATA.months, symbols, rankSymbols, missingExpected: ['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT','SUI_USDT','UNI_USDT','FIL_USDT','AAVE_USDT','ARB_USDT','APT_USDT','PEPE_USDT','WLD_USDT'].filter((s) => !symbols.includes(s)) },
  periods: PERIODS,
  protocol: {
    signal: 'rank only causal rolling idiosyncratic volatility after removing a contemporaneous BTC/ETH/SOL median market factor; no return direction forecast',
    construction: 'constant 0.5x long sleeve and 0.5x short sleeve on opposite residual-volatility tails, equal or inverse-vol weighted, then causal core beta hedge; both LOW_VOL_LONG and HIGH_VOL_LONG directions are tested symmetrically',
    execution: 'hourly-open causal features; rebalance only on fixed UTC cadence and only if desired one-way turnover clears the predeclared band; period-end positions are closed and counted',
    costs: { baseOneWay: BASE_ONE_WAY_COST, stressOneWay: STRESS_ONE_WAY_COST, adverseOneWay: ADVERSE_ONE_WAY_COST, stressRoundTripEquivalent: 0.0022 },
    noSelfTrade: true,
    turnover: 'sum of absolute signed-notional changes / equity, including initial entry and final exit; opposing target weights are netted by symbol before turnover is counted',
    acceptanceFloor: 'same exact config must have stress net >=0, adverse net >=0, stress PF >=1, and survive in all three pre-evaluation eras; ~5x/day turnover and ~5% monthly are soft targets only',
    evaluation: '2026-06..08 is opened for this family only if a config clears all three earlier eras; it is historical/gated, not project-wide pristine blind data',
  },
  grid: { looks: LOOKBACKS, rebalanceHours: REBALANCE_HOURS, fractions: FRACTIONS, weighting: WEIGHTING, modes: MODES, minRebalanceTurnover: MIN_REBALANCE_TURNOVER, configs: configs.length },
  diagnostics,
  frozen: frozen ? frozen : null,
  frontier,
  evaluation,
  topQualified: qualified.slice(0, 20),
  topDiagnostics: bestDiagnostics,
  note: 'This family is structurally distinct from prior return-rank rotation, pair mean reversion, pair relative momentum, lead-lag, fixed session timing, funding carry, and 5m directional prediction. Its proposed economic source is repeated cross-asset volatility dispersion and rebalancing rather than forecasting the next price direction.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`VOLATILITY_HARVEST_NEUTRAL_REBALANCE=${JSON.stringify({ objective: output.objective, data: output.data, grid: output.grid, diagnostics, frozen, frontier, evaluation, topQualified: output.topQualified.slice(0, 5), topDiagnostics: output.topDiagnostics.slice(0, 8), note: output.note })}`);
