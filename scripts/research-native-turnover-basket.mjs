import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-21m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/native-turnover-basket.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 21) throw new Error('Need 21-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const LOOK_HOURS = 72;
const ABS_MOVE = 0.02;
const BASE_SIDE_COST = 0.00070;
const STRESS_SIDE_COST = 0.00110;
const ADVERSE_SIDE_COST = 0.00095;

const REBALANCE_HOURS = [1, 2, 4, 6, 12];
const BASKET_SIZES = [2, 4, 6];
const MAIN_GROSS = [0.50, 0.75, 1.00, 1.25, 1.50];
const HEDGE_RATIOS = [0, 0.50, 1.00];
const WEIGHT_MODES = ['EQUAL', 'SCORE'];

const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const CURRENT_TO = Date.UTC(2026, 5, 1) / 1000;

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
if (symbols.length !== 19) throw new Error(`Expected 19 complete symbols, got ${symbols.length}`);
for (const symbol of ['BTC_USDT', 'ETH_USDT']) {
  if (!rowsBySymbol.has(symbol)) throw new Error(`Missing hedge symbol ${symbol}`);
}
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = rowsBySymbol.get(symbols[0]).map((r) => r.time).sort((a, b) => a - b);
const timeSet = new Set(allTimes);
const priceAt = (symbol, t) => rowMap.get(symbol)?.get(t)?.open;

const featureCache = new Map();
function featureAt(signalAt) {
  if (featureCache.has(signalAt)) return featureCache.get(signalAt);
  const rows = [];
  for (const symbol of symbols) {
    const p0 = priceAt(symbol, signalAt - LOOK_HOURS * HOUR);
    const p1 = priceAt(symbol, signalAt);
    if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
    rows.push({ symbol, rawRet: p1 / p0 - 1 });
  }
  if (rows.length !== symbols.length) {
    featureCache.set(signalAt, null);
    return null;
  }
  const marketRet = median(rows.map((x) => x.rawRet));
  const marketSign = Math.sign(marketRet);
  if (!marketSign) {
    featureCache.set(signalAt, { marketRet, marketSign, candidates: [] });
    return featureCache.get(signalAt);
  }
  const candidates = rows
    .filter((x) => Math.sign(x.rawRet) === marketSign && Math.abs(x.rawRet) >= ABS_MOVE)
    .sort((a, b) => Math.abs(b.rawRet) - Math.abs(a.rawRet) || a.symbol.localeCompare(b.symbol));
  const feature = { marketRet, marketSign, candidates };
  featureCache.set(signalAt, feature);
  return feature;
}

function addWeight(map, symbol, weight) {
  const next = (map.get(symbol) ?? 0) + weight;
  if (Math.abs(next) < 1e-12) map.delete(symbol);
  else map.set(symbol, next);
}

function targetWeights(signalAt, config) {
  const feature = featureAt(signalAt);
  if (!feature || !feature.marketSign || feature.candidates.length < config.basketSize) return new Map();
  const selected = feature.candidates.slice(0, config.basketSize);
  const weights = new Map();
  let shares;
  if (config.weightMode === 'EQUAL') {
    shares = selected.map(() => 1 / selected.length);
  } else {
    const scores = selected.map((x) => Math.abs(x.rawRet));
    const denom = sum(scores);
    shares = scores.map((x) => x / denom);
  }
  for (let i = 0; i < selected.length; i += 1) {
    const x = selected[i];
    const direction = -Math.sign(x.rawRet);
    addWeight(weights, x.symbol, direction * config.mainGross * shares[i]);
  }
  if (config.hedgeRatio > 0) {
    const hedgeGross = config.mainGross * config.hedgeRatio;
    const hedgeDirection = feature.marketSign;
    addWeight(weights, 'BTC_USDT', hedgeDirection * hedgeGross * 0.5);
    addWeight(weights, 'ETH_USDT', hedgeDirection * hedgeGross * 0.5);
  }
  return weights;
}

function simulate(config, from, to, sideCost) {
  const signalTimes = allTimes.filter((t) => t >= from && t < to - HOUR
    && Math.floor(t / HOUR) % config.rebalanceHours === 0
    && timeSet.has(t + HOUR));
  const endTime = [...allTimes].reverse().find((t) => t < to) ?? 0;
  let equity = 1;
  let peak = 1;
  let minEquity = 1;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  let turnover = 0;
  let maxGrossObserved = 0;
  let activeRebalances = 0;
  let bankruptAt = null;
  const positions = new Map();
  const stepPnls = [];
  const monthly = new Map();

  const observe = () => {
    minEquity = Math.min(minEquity, equity);
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    maxDrawdownAbs = Math.max(maxDrawdownAbs, dd);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, dd / peak);
  };

  for (let i = 0; i < signalTimes.length; i += 1) {
    const signalAt = signalTimes[i];
    const execAt = signalAt + HOUR;
    if (!(execAt < endTime)) continue;
    const weights = targetWeights(signalAt, config);
    if (weights.size) activeRebalances += 1;

    const desired = new Map();
    for (const [symbol, weight] of weights) desired.set(symbol, equity * weight);
    const union = new Set([...positions.keys(), ...desired.keys()]);
    let traded = 0;
    for (const symbol of union) traded += Math.abs((desired.get(symbol) ?? 0) - (positions.get(symbol) ?? 0));
    const cost = traded * sideCost;
    turnover += traded;
    equity -= cost;
    observe();
    if (!(equity > 0)) {
      bankruptAt = execAt;
      stepPnls.push(-cost);
      monthly.set(monthKey(execAt), (monthly.get(monthKey(execAt)) ?? 0) - cost);
      break;
    }

    positions.clear();
    for (const [symbol, notional] of desired) positions.set(symbol, notional);
    const grossNow = sum([...positions.values()].map(Math.abs));
    maxGrossObserved = Math.max(maxGrossObserved, grossNow / equity);

    const nextSignal = signalTimes[i + 1];
    const nextExec = nextSignal ? nextSignal + HOUR : endTime;
    const markAt = Math.min(nextExec, endTime);
    if (!(markAt > execAt)) continue;

    let grossPnl = 0;
    const marked = new Map();
    for (const [symbol, notional] of positions) {
      const p0 = priceAt(symbol, execAt);
      const p1 = priceAt(symbol, markAt);
      if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) throw new Error(`Missing price ${symbol} ${execAt}->${markAt}`);
      const r = p1 / p0 - 1;
      grossPnl += notional * r;
      marked.set(symbol, notional * (1 + r));
    }
    equity += grossPnl;
    const netStep = grossPnl - cost;
    stepPnls.push(netStep);
    monthly.set(monthKey(execAt), (monthly.get(monthKey(execAt)) ?? 0) + netStep);
    positions.clear();
    for (const [symbol, notional] of marked) positions.set(symbol, notional);
    observe();
    if (!(equity > 0)) {
      bankruptAt = markAt;
      break;
    }
  }

  if (!bankruptAt && positions.size) {
    const liquidation = sum([...positions.values()].map(Math.abs));
    const cost = liquidation * sideCost;
    turnover += liquidation;
    equity -= cost;
    stepPnls.push(-cost);
    monthly.set(monthKey(endTime), (monthly.get(monthKey(endTime)) ?? 0) - cost);
    positions.clear();
    observe();
    if (!(equity > 0)) bankruptAt = endTime;
  }

  const gains = sum(stepPnls.filter((x) => x > 0));
  const losses = Math.abs(sum(stepPnls.filter((x) => x <= 0)));
  const days = (to - from) / DAY;
  const monthlyRows = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, net]) => ({ month, net, positive: net > 0 }));
  return {
    completed: !bankruptAt,
    bankruptAt,
    finalEquity: equity,
    net: equity - 1,
    avgDaily1000U: days ? ((equity - 1) / days) * 1000 : 0,
    turnoverPerDay: days ? turnover / days : 0,
    totalTurnoverInitialEquity: turnover,
    pf: losses ? gains / losses : gains ? 99 : 0,
    minEquity,
    maxDrawdownAbs,
    maxDrawdownPct,
    maxGrossObserved,
    rebalances: signalTimes.length,
    activeRebalances,
    activeRatio: signalTimes.length ? activeRebalances / signalTimes.length : 0,
    positiveMonths: monthlyRows.filter((x) => x.positive).length,
    monthly: monthlyRows,
  };
}

const configs = [];
let id = 0;
for (const rebalanceHours of REBALANCE_HOURS) for (const basketSize of BASKET_SIZES)
  for (const mainGross of MAIN_GROSS) for (const hedgeRatio of HEDGE_RATIOS) for (const weightMode of WEIGHT_MODES) {
    configs.push({ id: `NTB-${id++}`, rebalanceHours, basketSize, mainGross, hedgeRatio, weightMode });
  }

const results = [];
for (const c of configs) {
  const old = {
    base: simulate(c, OLD_FROM, OLD_TO, BASE_SIDE_COST),
    stress: simulate(c, OLD_FROM, OLD_TO, STRESS_SIDE_COST),
    adverse: simulate(c, OLD_FROM, OLD_TO, ADVERSE_SIDE_COST),
  };
  const current = {
    base: simulate(c, CURRENT_FROM, CURRENT_TO, BASE_SIDE_COST),
    stress: simulate(c, CURRENT_FROM, CURRENT_TO, STRESS_SIDE_COST),
    adverse: simulate(c, CURRENT_FROM, CURRENT_TO, ADVERSE_SIDE_COST),
  };
  const survival = old.stress.completed && current.stress.completed && old.adverse.completed && current.adverse.completed;
  const afterCostPositive = old.stress.net >= 0 && current.stress.net >= 0 && old.adverse.net >= 0 && current.adverse.net >= 0;
  const minTurnover = Math.min(old.stress.turnoverPerDay, current.stress.turnoverPerDay);
  const target5x = survival && afterCostPositive && minTurnover >= 5;
  const preferredRisk = target5x && Math.min(old.stress.minEquity, current.stress.minEquity) >= 0.50
    && Math.max(old.stress.maxDrawdownPct, current.stress.maxDrawdownPct) <= 0.50;
  const score = target5x
    ? minTurnover + 5 * Math.min(old.stress.minEquity, current.stress.minEquity)
      + 2 * Math.min(old.stress.pf, current.stress.pf)
      - 2 * Math.max(old.stress.maxDrawdownPct, current.stress.maxDrawdownPct)
    : -100 + minTurnover;
  results.push({ c, old, current, survival, afterCostPositive, minTurnover, target5x, preferredRisk, score });
}

const qualified = results.filter((x) => x.target5x).sort((a, b) => b.score - a.score);
const preferred = results.filter((x) => x.preferredRisk).sort((a, b) => b.score - a.score);
const surviving = results.filter((x) => x.survival && x.afterCostPositive)
  .sort((a, b) => b.minTurnover - a.minTurnover || b.score - a.score);
const topNear = [...results].sort((a, b) => b.minTurnover - a.minTurnover || b.score - a.score).slice(0, 20);

const featureRows = allTimes.filter((t) => t >= OLD_FROM && t < CURRENT_TO).map((t) => featureAt(t)).filter(Boolean);
const candidateCounts = featureRows.map((x) => x.candidates.length);
const signalDiagnostics = {
  hours: featureRows.length,
  avgCandidates: candidateCounts.length ? sum(candidateCounts) / candidateCounts.length : 0,
  pctHoursAtLeast2: candidateCounts.length ? candidateCounts.filter((x) => x >= 2).length / candidateCounts.length : 0,
  pctHoursAtLeast4: candidateCounts.length ? candidateCounts.filter((x) => x >= 4).length / candidateCounts.length : 0,
  pctHoursAtLeast6: candidateCounts.length ? candidateCounts.filter((x) => x >= 6).length / candidateCounts.length : 0,
};

const compact = (x) => ({
  c: x.c,
  old: { stress: x.old.stress, adverse: x.old.adverse },
  current: { stress: x.current.stress, adverse: x.current.adverse },
  survival: x.survival,
  afterCostPositive: x.afterCostPositive,
  minTurnover: x.minTurnover,
  target5x: x.target5x,
  preferredRisk: x.preferredRisk,
  score: x.score,
});

const output = {
  research: 'native-turnover-basket-v1',
  objective: 'turn the frozen #227 72h >=2% MEDIAN-aligned FADE state into genuine native basket turnover via rank membership and weight changes, without increasing per-event leverage or splitting orders',
  frozenState: { lookHours: LOOK_HOURS, absMove: ABS_MOVE, marketFilter: 'MEDIAN_DIRECTION', mode: 'FADE' },
  protocol: {
    periods: { old: [OLD_FROM, OLD_TO], current: [CURRENT_FROM, CURRENT_TO] },
    symbols,
    configs: configs.length,
    rebalanceHours: REBALANCE_HOURS,
    basketSizes: BASKET_SIZES,
    mainGross: MAIN_GROSS,
    hedgeRatios: HEDGE_RATIOS,
    weightModes: WEIGHT_MODES,
    execution: 'signal observed on hour t, target executed on hour t+1 open; portfolio holds until next scheduled execution; turnover is only net change in signed futures notional plus final liquidation',
    costsPerTradedNotional: { base: BASE_SIDE_COST, stress: STRESS_SIDE_COST, adverse: ADVERSE_SIDE_COST },
    turnoverDefinition: 'sum of actual absolute notional changes after netting candidate and BTC/ETH hedge exposures, divided by 1000U initial reference equity and calendar days; no self-trade, wash volume, opposite-position duplication, or order splitting',
    evaluationPeriodUsed: false,
  },
  signalDiagnostics,
  diagnostics: {
    configs: results.length,
    survival: results.filter((x) => x.survival).length,
    afterCostPositive: results.filter((x) => x.afterCostPositive).length,
    survivalAndPositive: surviving.length,
    target5x: qualified.length,
    preferredRisk: preferred.length,
    bestSurvivingTurnover: surviving[0]?.minTurnover ?? 0,
  },
  preferred: preferred.slice(0, 12).map(compact),
  qualified: qualified.slice(0, 20).map(compact),
  surviving: surviving.slice(0, 20).map(compact),
  topNear: topNear.map(compact),
  note: 'This stage deliberately reuses the previously evidenced 72h fade state and tests only native portfolio construction. The previously touched 2026-06..2026-08 period remains excluded; any surviving >=5x candidate still requires a separate frozen independent/backward OOS before production consideration.',
};

writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`NATIVE_TURNOVER_BASKET=${JSON.stringify(output)}`);
