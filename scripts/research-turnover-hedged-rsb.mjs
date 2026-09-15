import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/turnover-hedged-rsb.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;
const CORE = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'];
const HEDGE_RATIOS = [0.5, 1.0, 1.5];
const DD_CAPS = [0.10, 0.20, 0.30, 0.50];
const MAX_PRIMARY_NOTIONAL_X = 3;

// Frozen before this turnover study: the six RSB configs that were stress-positive in both discovery eras.
// No signal parameter is retuned here; only an executable market hedge is added and sized.
const FROZEN = [
  { id: 'RSB-659', look: 72, rankCut: 0.25, minResidual: 0, mode: 'FADE', structureFilter: 'BREADTH60', hold: 48 },
  { id: 'RSB-707', look: 72, rankCut: 0.25, minResidual: 0.005, mode: 'FADE', structureFilter: 'BREADTH60', hold: 48 },
  { id: 'RSB-799', look: 72, rankCut: 0.35, minResidual: 0.01, mode: 'FADE', structureFilter: 'MKT_ALIGN', hold: 48 },
  { id: 'RSB-803', look: 72, rankCut: 0.35, minResidual: 0.01, mode: 'FADE', structureFilter: 'BREADTH60', hold: 48 },
  { id: 'RSB-567', look: 48, rankCut: 0.35, minResidual: 0.02, mode: 'FADE', structureFilter: 'DUAL_MKT', hold: 48 },
  { id: 'RSB-871', look: 168, rankCut: 0.15, minResidual: 0, mode: 'FOLLOW', structureFilter: 'MKT_ALIGN', hold: 48 },
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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, d.rows]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
for (const s of CORE) if (!rowsBySymbol.has(s)) throw new Error(`Missing core symbol ${s}`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM - 200 * HOUR && t < EVAL_TO);

function crossSection(t, look) {
  const rows = [];
  for (const symbol of symbols) {
    const rm = rowMap.get(symbol);
    const p0 = rm.get(t - look * HOUR)?.open;
    const p1 = rm.get(t)?.open;
    if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
    rows.push({ symbol, rawRet: p1 / p0 - 1 });
  }
  if (rows.length < 15) return null;
  const marketRet = median(rows.map((x) => x.rawRet));
  const positiveBreadth = rows.filter((x) => x.rawRet > 0).length / rows.length;
  const negativeBreadth = rows.filter((x) => x.rawRet < 0).length / rows.length;
  const coreRows = rows.filter((x) => CORE.includes(x.symbol));
  if (coreRows.length !== CORE.length) return null;
  const coreMedian = median(coreRows.map((x) => x.rawRet));
  const sorted = [...rows].sort((a, b) => a.rawRet - b.rawRet);
  const rank = new Map(sorted.map((x, i) => [x.symbol, sorted.length === 1 ? 0.5 : i / (sorted.length - 1)]));
  return { rows, marketRet, positiveBreadth, negativeBreadth, coreMedian, rank };
}

const state24 = new Map();
const state72 = new Map();
for (const t of allTimes) {
  if (t < OLD_FROM) continue;
  const a = crossSection(t, 24);
  const b = crossSection(t, 72);
  if (a) state24.set(t, a);
  if (b) state72.set(t, b);
}

const featureMap = new Map();
for (const look of [...new Set(FROZEN.map((x) => x.look))]) {
  const features = [];
  for (const t of allTimes) {
    if (t < OLD_FROM) continue;
    const cs = crossSection(t, look);
    const s24 = state24.get(t);
    const s72 = state72.get(t);
    if (!cs || !s24 || !s72) continue;
    const by24 = new Map(s24.rows.map((x) => [x.symbol, x]));
    const by72 = new Map(s72.rows.map((x) => [x.symbol, x]));
    for (const x of cs.rows) {
      const rankPct = cs.rank.get(x.symbol);
      if (!Number.isFinite(rankPct)) continue;
      const residual = x.rawRet - cs.marketRet;
      const direction = residual > 0 ? 1 : residual < 0 ? -1 : 0;
      if (!direction) continue;
      const r24 = by24.get(x.symbol);
      const r72 = by72.get(x.symbol);
      if (!r24 || !r72) continue;
      features.push({
        symbol: x.symbol, signalAt: t, rawRet: x.rawRet, marketRet: cs.marketRet, residual, rankPct, direction,
        directionBreadth: direction > 0 ? cs.positiveBreadth : cs.negativeBreadth,
        market24: s24.marketRet, market72: s72.marketRet,
        breadth24: direction > 0 ? s24.positiveBreadth : s24.negativeBreadth,
        breadth72: direction > 0 ? s72.positiveBreadth : s72.negativeBreadth,
        residual24: r24.rawRet - s24.marketRet, residual72: r72.rawRet - s72.marketRet,
        core24: s24.coreMedian, core72: s72.coreMedian,
      });
    }
  }
  features.sort((a, b) => a.signalAt - b.signalAt || a.symbol.localeCompare(b.symbol));
  featureMap.set(look, features);
}

function signalOk(c, x) {
  const extreme = x.direction > 0 ? x.rankPct >= 1 - c.rankCut : x.rankPct <= c.rankCut;
  if (!extreme || Math.abs(x.residual) < c.minResidual) return false;
  const sign = x.direction;
  const align = (v) => Math.sign(v) === sign;
  if (c.structureFilter === 'MKT_ALIGN') return align(x.marketRet);
  if (c.structureFilter === 'BREADTH60') return align(x.marketRet) && x.directionBreadth >= 0.60;
  if (c.structureFilter === 'DUAL_MKT') return align(x.market24) && align(x.market72)
    && x.breadth24 >= 0.55 && x.breadth72 >= 0.55;
  return false;
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const entry0 = rm.get(entryAt)?.open;
  const exit = rm.get(exitAt)?.open;
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function hedgeReturn(primarySymbol, direction, entryAt, exitAt, slip) {
  const hedgeSymbols = CORE.filter((s) => s !== primarySymbol);
  const vals = hedgeSymbols.map((s) => legReturn(s, direction, entryAt, exitAt, slip)).filter(Number.isFinite);
  if (vals.length < 2) return null;
  return sum(vals) / vals.length;
}

function events(c, hedgeRatio, maxTo) {
  const out = [];
  const busy = new Map();
  for (const x of featureMap.get(c.look) ?? []) {
    if (!signalOk(c, x)) continue;
    const entryAt = x.signalAt + HOUR;
    const exitAt = entryAt + c.hold * HOUR;
    if (exitAt > maxTo || (busy.get(x.symbol) ?? 0) > entryAt) continue;
    const primaryDirection = c.mode === 'FOLLOW' ? x.direction : -x.direction;
    const hedgeDirection = -primaryDirection;
    const primaryGross = legReturn(x.symbol, primaryDirection, entryAt, exitAt, ENTRY_SLIP);
    const primaryAdverse = legReturn(x.symbol, primaryDirection, entryAt, exitAt, ADVERSE_SLIP);
    const hedgeGross = hedgeReturn(x.symbol, hedgeDirection, entryAt, exitAt, ENTRY_SLIP);
    const hedgeAdverse = hedgeReturn(x.symbol, hedgeDirection, entryAt, exitAt, ADVERSE_SLIP);
    if (![primaryGross, primaryAdverse, hedgeGross, hedgeAdverse].every(Number.isFinite)) continue;
    const gross = primaryGross + hedgeRatio * hedgeGross;
    const adverseGross = primaryAdverse + hedgeRatio * hedgeAdverse;
    const grossNotionalX = 1 + hedgeRatio;
    out.push({
      ...x, entryAt, exitAt, primaryDirection, hedgeDirection, hedgeRatio, grossNotionalX,
      gross, base: gross - BASE_COST * grossNotionalX,
      stress: gross - STRESS_COST * grossNotionalX,
      adverse: adverseGross - BASE_COST * grossNotionalX,
      month: monthKey(entryAt),
    });
    busy.set(x.symbol, exitAt);
  }
  return out;
}

function stats(rows, from, to, field = 'stress') {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(xs.map((e) => e[field]));
  const days = (to - from) / DAY;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol))) {
    equity += e[field]; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const eventsPerDay = days ? xs.length / days : 0;
  const avgGrossNotionalX = xs.length ? sum(xs.map((e) => e.grossNotionalX)) / xs.length : 0;
  const netPerDay = days ? net / days : 0;
  return {
    events: xs.length, eventsPerDay, avgGrossNotionalX,
    oneWayTurnoverXPerDayAt1xPrimary: eventsPerDay * avgGrossNotionalX,
    roundTripTurnoverXPerDayAt1xPrimary: eventsPerDay * avgGrossNotionalX * 2,
    net, netPerDay, avgDaily1000At1xPrimary: netPerDay * 1000,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
  };
}

function monthly(rows, from, to, field = 'stress') {
  return monthKeys(from, to).map((month) => {
    const xs = rows.filter((e) => e.month === month && e.entryAt >= from && e.exitAt <= to);
    const net = sum(xs.map((e) => e[field]));
    return { month, events: xs.length, net, positive: net > 0 };
  });
}

function frontier(oldStress, currentStress) {
  const minNetPerDay = Math.min(oldStress.netPerDay, currentStress.netPerDay);
  const minEventsPerDay = Math.min(oldStress.eventsPerDay, currentStress.eventsPerDay);
  const minGrossX = Math.min(oldStress.avgGrossNotionalX, currentStress.avgGrossNotionalX);
  const maxDd = Math.max(oldStress.maxDrawdown, currentStress.maxDrawdown);
  const byDdCap = Object.fromEntries(DD_CAPS.map((cap) => {
    const primaryNotionalX = maxDd > 0 ? Math.min(MAX_PRIMARY_NOTIONAL_X, cap / maxDd) : MAX_PRIMARY_NOTIONAL_X;
    return [String(cap), {
      primaryNotionalX,
      oneWayTurnoverXPerDay: minEventsPerDay * minGrossX * primaryNotionalX,
      roundTripTurnoverXPerDay: minEventsPerDay * minGrossX * primaryNotionalX * 2,
      minMonthlyNetPct: minNetPerDay * primaryNotionalX * 30 * 100,
      impliedMaxDrawdownPct: maxDd * primaryNotionalX * 100,
    }];
  }));
  const sizeFor5PctMonth = minNetPerDay > 0 ? 0.05 / (minNetPerDay * 30) : null;
  return {
    minNetPerDay, minEventsPerDay, minGrossX, maxDd,
    byDdCap,
    sizeFor5PctMonth,
    fivePctMonth: sizeFor5PctMonth === null ? null : {
      primaryNotionalX: sizeFor5PctMonth,
      roundTripTurnoverXPerDay: minEventsPerDay * minGrossX * sizeFor5PctMonth * 2,
      impliedMaxDrawdownPct: maxDd * sizeFor5PctMonth * 100,
      within3xPrimaryCap: sizeFor5PctMonth <= MAX_PRIMARY_NOTIONAL_X,
    },
  };
}

const variants = [];
for (const c of FROZEN) for (const hedgeRatio of HEDGE_RATIOS) {
  const ev = events(c, hedgeRatio, TRAIN_TO);
  const old = { stress: stats(ev, OLD_FROM, OLD_TO), adverse: stats(ev, OLD_FROM, OLD_TO, 'adverse') };
  const currentTrain = { stress: stats(ev, CURRENT_FROM, TRAIN_TO), adverse: stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse') };
  const oldMonthly = monthly(ev, OLD_FROM, OLD_TO);
  const currentMonthly = monthly(ev, CURRENT_FROM, TRAIN_TO);
  const oldPositiveMonths = oldMonthly.filter((x) => x.positive).length;
  const currentPositiveMonths = currentMonthly.filter((x) => x.positive).length;
  const sampleEnough = old.stress.events >= 100 && currentTrain.stress.events >= 75;
  const costPositive = sampleEnough && old.stress.net > 0 && currentTrain.stress.net > 0;
  const adversePositive = costPositive && old.adverse.net > 0 && currentTrain.adverse.net > 0;
  const turn = frontier(old.stress, currentTrain.stress);
  variants.push({ c, hedgeRatio, old, currentTrain, oldPositiveMonths, currentPositiveMonths,
    costPositive, adversePositive, turnover: turn });
}

const discoveryQualified = variants.filter((x) => x.adversePositive)
  .sort((a, b) => (b.turnover.byDdCap['0.30'].roundTripTurnoverXPerDay - a.turnover.byDdCap['0.30'].roundTripTurnoverXPerDay)
    || (b.turnover.minNetPerDay - a.turnover.minNetPerDay));

let evaluationOpened = false;
let evaluation = [];
if (discoveryQualified.length) {
  evaluationOpened = true;
  for (const x of discoveryQualified.slice(0, 6)) {
    const ev = events(x.c, x.hedgeRatio, EVAL_TO);
    const stress = stats(ev, TRAIN_TO, EVAL_TO);
    const adverse = stats(ev, TRAIN_TO, EVAL_TO, 'adverse');
    evaluation.push({ c: x.c, hedgeRatio: x.hedgeRatio, stress, adverse,
      positive: stress.net > 0 && adverse.net > 0 });
  }
}

const output = {
  research: 'turnover-hedged-rsb-v1',
  objective: 'maximize genuine notional turnover; trade count is not a target; after-fee/stress profitability is the floor; ~5% monthly is acceptable rather than mandatory',
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  protocol: {
    frozenSignalConfigs: FROZEN.map((x) => x.id),
    hedge: 'opposite primary direction using equal-weight BTC/ETH/SOL basket excluding the primary symbol; total hedge notional = hedgeRatio * primary notional',
    hedgeRatios: HEDGE_RATIOS,
    costsPerUnitGrossNotional: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
    ddCaps: DD_CAPS,
    maxPrimaryNotionalX: MAX_PRIMARY_NOTIONAL_X,
    turnoverDefinition: 'round-trip sum of genuine directional notional; no same-symbol self-offset or self-trade volume is counted',
  },
  diagnostics: {
    variants: variants.length,
    stressPositiveBothEras: variants.filter((x) => x.costPositive).length,
    stressAndAdversePositiveBothEras: discoveryQualified.length,
    evaluationOpened,
    evaluationPositive: evaluation.filter((x) => x.positive).length,
  },
  topDiscovery: discoveryQualified.slice(0, 12),
  evaluation,
  allVariants: variants,
  note: 'This is a sizing/hedging study, not a retune of signal thresholds. It directly reflects the revised objective: maximize genuine turnover while requiring after-fee stress profitability. Trade count is diagnostic only. If hedging lowers drawdown enough, the same signal can carry more notional and therefore more daily volume without relying on extra entries.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`TURNOVER_HEDGED_RSB=${JSON.stringify({ objective: output.objective, diagnostics: output.diagnostics,
  topDiscovery: output.topDiscovery.slice(0, 6), evaluation: output.evaluation, note: output.note })}`);