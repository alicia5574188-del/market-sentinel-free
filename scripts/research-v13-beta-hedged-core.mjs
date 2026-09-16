import { readFileSync, writeFileSync } from 'node:fs';

const DUMP = process.env.RESEARCH_CAPACITY_DUMP ?? '/tmp/regime-long-history-capacity-dump.json';
const ALLOCATION = process.env.RESEARCH_ALLOCATION_REPORT ?? '/tmp/regime-long-history-allocation.json';
const EXEC = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/v13-beta-hedged-core.json';
const EXPECTED_EXEC_SHA = '9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522';
const DAY_MS = 86_400_000;
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const BASE_SLIPPAGE = 0.00025;
const ADVERSE_SLIPPAGE = 0.00050;
const TARGET_TURNOVER = 5;
const SYSTEMS = ['SHOCK_TRANSITION','COMPRESSION','DIRECTIONAL_TREND','NON_TREND_EXPANSION','BALANCED_ROTATION'];
const HEDGE_RATIOS = [0, 0.25, 0.50, 0.75, 1.00];
const DD_CAPS = [0.20, 0.30, 0.40, 0.50];
const SCALE_GRID = Array.from({ length: 48 }, (_, i) => Number(((i + 1) * 0.25).toFixed(2)));

const dump = JSON.parse(readFileSync(DUMP, 'utf8'));
const allocation = JSON.parse(readFileSync(ALLOCATION, 'utf8'));
const exec = JSON.parse(readFileSync(EXEC, 'utf8'));
if (exec.sha256 !== EXPECTED_EXEC_SHA || dump.data.executionSha256 !== EXPECTED_EXEC_SHA) {
  throw new Error(`execution hash mismatch exec=${exec.sha256} dump=${dump.data.executionSha256}`);
}
if (dump.capacitySystems.length !== 5 || dump.capacitySystems.some((s) => !s.accepted)) {
  throw new Error('expected five accepted frozen core systems');
}
const { fromMs, discoveryEnd, validationEnd, toMs } = dump.split;
const days = (a, b) => (b - a) / DAY_MS;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sideSign = (side) => side === 'LONG' ? 1 : -1;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);

const execution = new Map(exec.datasets.map((dataset) => {
  const rows = dataset.rows.map((r) => ({ time: Number(r.time), open: Number(r.open) }));
  const byTime = new Map(rows.map((r) => [r.time, r.open]));
  return [dataset.symbol, { rows, byTime }];
}));

function lowerBound(rows, time) {
  let lo = 0; let hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
function hedgeBenchmark(symbol) { return symbol === 'BTC_USDT' ? 'ETH_USDT' : 'BTC_USDT'; }
function hedgeOutcome(trade, friction, slippage) {
  const symbol = hedgeBenchmark(trade.symbol);
  const book = execution.get(symbol);
  if (!book) return null;
  const openedSec = Math.floor(trade.openedAt / 1000);
  const closedSec = Math.floor(trade.closedAt / 1000);
  const rawEntry = book.byTime.get(openedSec);
  if (!(rawEntry > 0)) return null;
  const exitIndex = lowerBound(book.rows, closedSec + 1);
  const exitRow = book.rows[exitIndex];
  if (!exitRow || exitRow.time > closedSec + 900 || !(exitRow.open > 0)) return null;
  const direction = -sideSign(trade.side);
  const entry = rawEntry * (1 + direction * slippage);
  const grossRate = direction * (exitRow.open - entry) / entry;
  return { symbol, direction, openedAt: trade.openedAt, closedAt: exitRow.time * 1000,
    grossRate, netRate: grossRate - friction };
}

const SCENARIOS = {
  base: { coreField: 'baseRate', friction: BASE_FRICTION, slippage: BASE_SLIPPAGE },
  stress: { coreField: 'stressRate', friction: STRESS_FRICTION, slippage: BASE_SLIPPAGE },
  adverse: { coreField: 'adverseRate', friction: BASE_FRICTION, slippage: ADVERSE_SLIPPAGE },
};

const enrichedSystems = dump.capacitySystems.map((system) => ({ ...system,
  trades: system.trades.map((trade) => ({ ...trade,
    hedge: Object.fromEntries(Object.entries(SCENARIOS).map(([name, s]) => [name, hedgeOutcome(trade, s.friction, s.slippage)])),
  })) }));
const missingHedges = enrichedSystems.flatMap((system) => system.trades.filter((t) => !t.hedge.base || !t.hedge.stress || !t.hedge.adverse)
  .map((t) => ({ system: system.system, symbol: t.symbol, openedAt: t.openedAt, closedAt: t.closedAt })));
if (missingHedges.length) throw new Error(`missing causal BTC/ETH hedge prices for ${missingHedges.length} frozen trades`);

function periodTrades(system, start, end) { return system.trades.filter((t) => t.openedAt >= start && t.openedAt < end); }
function tradeRate(trade, hedgeRatio, scenario) {
  const s = SCENARIOS[scenario];
  return trade[s.coreField] + hedgeRatio * trade.hedge[scenario].netRate;
}
function simulateSystem(system, scale, hedgeRatio, scenario, start, end) {
  const rows = periodTrades(system, start, end);
  const events = [];
  for (const trade of rows) {
    const closeAt = hedgeRatio > 0 ? Math.max(trade.closedAt, trade.hedge[scenario].closedAt) : trade.closedAt;
    events.push({ time: trade.openedAt, kind: 'OPEN', trade });
    events.push({ time: closeAt, kind: 'CLOSE', trade });
  }
  events.sort((a, b) => a.time - b.time || (a.kind === 'CLOSE' ? -1 : 1));
  let equity = 1, peak = 1, minEquity = 1, maxDrawdown = 0;
  const open = new Map();
  for (const event of events) {
    const id = `${event.trade.strategyId}|${event.trade.symbol}|${event.trade.openedAt}`;
    if (event.kind === 'OPEN') open.set(id, equity);
    else {
      const atOpen = open.get(id); if (atOpen == null) continue;
      equity += atOpen * event.trade.baseFraction * scale * tradeRate(event.trade, hedgeRatio, scenario);
      open.delete(id);
      peak = Math.max(peak, equity); minEquity = Math.min(minEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12));
    }
  }
  return { trades: rows.length, endEquity: equity, net: equity - 1, minEquity, maxDrawdown, survived: minEquity > 0 };
}

function exposure(scales, hedgeRatio, start, end, systemFilter = SYSTEMS) {
  const grouped = new Map(); let logical = 0;
  const add = (time, symbol, delta) => {
    const key = `${time}|${symbol}`; grouped.set(key, (grouped.get(key) ?? 0) + delta);
  };
  for (const system of enrichedSystems.filter((s) => systemFilter.includes(s.system))) {
    const scale = scales[system.system] ?? 0;
    for (const trade of periodTrades(system, start, end)) {
      const f = trade.baseFraction * scale; const dir = sideSign(trade.side);
      logical += 2 * Math.abs(f);
      add(trade.openedAt, trade.symbol, dir * f); add(trade.closedAt, trade.symbol, -dir * f);
      if (hedgeRatio > 0) {
        const hf = f * hedgeRatio; const h = trade.hedge.base;
        logical += 2 * Math.abs(hf);
        add(h.openedAt, h.symbol, -dir * hf); add(h.closedAt, h.symbol, dir * hf);
      }
    }
  }
  const changes = [...grouped.entries()].map(([key, delta]) => {
    const split = key.indexOf('|'); return { time: Number(key.slice(0, split)), symbol: key.slice(split + 1), delta };
  }).sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const actual = sum(changes.map((x) => Math.abs(x.delta)));
  const positions = new Map(); let peakGross = 0; let i = 0;
  while (i < changes.length) {
    const time = changes[i].time;
    while (i < changes.length && changes[i].time === time) {
      const x = changes[i++]; positions.set(x.symbol, (positions.get(x.symbol) ?? 0) + x.delta);
    }
    peakGross = Math.max(peakGross, sum([...positions.values()].map(Math.abs)));
  }
  return { turnoverPerDay: actual / days(start, end), logicalTurnoverPerDay: logical / days(start, end),
    nettingRetention: logical ? actual / logical : 1, peakNettedGross: peakGross,
    impliedMinLeverageAt70pctMargin: peakGross / 0.70 };
}

function aggregatePath(scales, hedgeRatio, scenario, start, end) {
  const bySystem = Object.fromEntries(enrichedSystems.map((system) => [system.system,
    simulateSystem(system, scales[system.system] ?? 0, hedgeRatio, scenario, start, end)]));
  const equalWeightEnd = sum(Object.values(bySystem).map((x) => x.endEquity)) / SYSTEMS.length;
  return { bySystem, equalWeightEndEquity: equalWeightEnd, equalWeightNet: equalWeightEnd - 1,
    worstSystemDrawdown: Math.max(...Object.values(bySystem).map((x) => x.maxDrawdown)),
    worstSystemMinEquity: Math.min(...Object.values(bySystem).map((x) => x.minEquity)),
    positiveSystems: Object.values(bySystem).filter((x) => x.net > 0).length,
    allSystemsSurvived: Object.values(bySystem).every((x) => x.survived) };
}
function monthRows(scales, hedgeRatio, scenario, start, end) {
  return dump.data.months.flatMap((month) => {
    const a = monthStart(month); const b = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
    if (a < start || b > end) return [];
    const bySystem = Object.fromEntries(enrichedSystems.map((system) => [system.system,
      simulateSystem(system, scales[system.system] ?? 0, hedgeRatio, scenario, a, b).net]));
    return [{ month, bySystem, net: sum(Object.values(bySystem)) / SYSTEMS.length }];
  });
}
function vectorSummary(scales, hedgeRatio) {
  const maxTradeRisk = Math.max(...enrichedSystems.flatMap((system) => system.trades.map((t) => t.plannedRiskFraction * scales[system.system])), 0);
  const maxCoreFraction = Math.max(...enrichedSystems.flatMap((system) => system.trades.map((t) => t.baseFraction * scales[system.system])), 0);
  const maxLogicalPairFraction = maxCoreFraction * (1 + hedgeRatio);
  const summarizePeriod = (start, end) => ({ exposure: exposure(scales, hedgeRatio, start, end),
    base: aggregatePath(scales, hedgeRatio, 'base', start, end), stress: aggregatePath(scales, hedgeRatio, 'stress', start, end),
    adverse: aggregatePath(scales, hedgeRatio, 'adverse', start, end),
    stressMonths: monthRows(scales, hedgeRatio, 'stress', start, end), baseMonths: monthRows(scales, hedgeRatio, 'base', start, end) });
  return { scales, hedgeRatio, discovery: summarizePeriod(fromMs, discoveryEnd), validation: summarizePeriod(discoveryEnd, validationEnd),
    train: summarizePeriod(fromMs, validationEnd), evaluation: summarizePeriod(validationEnd, toMs), full: summarizePeriod(fromMs, toMs),
    maxTradeRisk, maxCoreFraction, maxLogicalPairFraction };
}

function systemPoint(system, scale, hedgeRatio) {
  const discoveryStress = simulateSystem(system, scale, hedgeRatio, 'stress', fromMs, discoveryEnd);
  const validationStress = simulateSystem(system, scale, hedgeRatio, 'stress', discoveryEnd, validationEnd);
  const trainStress = simulateSystem(system, scale, hedgeRatio, 'stress', fromMs, validationEnd);
  const discoveryAdverse = simulateSystem(system, scale, hedgeRatio, 'adverse', fromMs, discoveryEnd);
  const validationAdverse = simulateSystem(system, scale, hedgeRatio, 'adverse', discoveryEnd, validationEnd);
  const trainAdverse = simulateSystem(system, scale, hedgeRatio, 'adverse', fromMs, validationEnd);
  const only = Object.fromEntries(SYSTEMS.map((id) => [id, id === system.system ? scale : 0]));
  return { scale, turnoverTrain: exposure(only, hedgeRatio, fromMs, validationEnd, [system.system]).turnoverPerDay,
    stress: { discovery: discoveryStress, validation: validationStress, train: trainStress },
    adverse: { discovery: discoveryAdverse, validation: validationAdverse, train: trainAdverse },
    maxTradeRisk: Math.max(...system.trades.map((t) => t.plannedRiskFraction * scale), 0) };
}
function eligiblePoint(point, ddCap, tradeRiskCap = 0.05) {
  return point.stress.discovery.net >= 0 && point.stress.validation.net >= 0
    && point.adverse.discovery.net >= 0 && point.adverse.validation.net >= 0
    && point.stress.train.survived && point.adverse.train.survived
    && Math.max(point.stress.train.maxDrawdown, point.adverse.train.maxDrawdown) <= ddCap
    && point.maxTradeRisk <= tradeRiskCap;
}

const research = [];
for (const hedgeRatio of HEDGE_RATIOS) {
  const frontiers = Object.fromEntries(DD_CAPS.map((ddCap) => {
    const scales = {};
    const perSystem = {};
    for (const system of enrichedSystems) {
      const points = SCALE_GRID.map((scale) => systemPoint(system, scale, hedgeRatio));
      const selected = points.filter((p) => eligiblePoint(p, ddCap)).sort((a, b) => b.turnoverTrain - a.turnoverTrain)[0] ?? null;
      perSystem[system.system] = selected; scales[system.system] = selected?.scale ?? 0;
    }
    const valid = Object.values(perSystem).every(Boolean);
    const natural = valid ? vectorSummary(scales, hedgeRatio) : null;
    let scaledTo5 = null;
    if (natural?.train.exposure.turnoverPerDay > 0) {
      const multiplier = TARGET_TURNOVER / natural.train.exposure.turnoverPerDay;
      const forcedScales = Object.fromEntries(SYSTEMS.map((id) => [id, scales[id] * multiplier]));
      scaledTo5 = { multiplier, ...vectorSummary(forcedScales, hedgeRatio) };
    }
    return [String(Math.round(ddCap * 100)), { ddCap, tradeRiskCap: 0.05, perSystem, natural, scaledTo5 }];
  }));
  research.push({ hedgeRatio, frontiers });
}

const baselineScales = Object.fromEntries(SYSTEMS.map((id) => [id, 1]));
const baselineUnhedged = vectorSummary(baselineScales, 0);
if (Math.abs(baselineUnhedged.full.exposure.turnoverPerDay - 0.58245) > 0.002) {
  throw new Error(`baseline turnover parity failed ${baselineUnhedged.full.exposure.turnoverPerDay}`);
}

const candidates = research.flatMap((r) => Object.values(r.frontiers).flatMap((f) => {
  if (!f.scaledTo5) return [];
  const row = f.scaledTo5;
  const trainStressMonths = row.train.stressMonths;
  const trainAvgMonth = trainStressMonths.length ? sum(trainStressMonths.map((m) => m.net)) / trainStressMonths.length : -1;
  const trainPositiveMonths = trainStressMonths.filter((m) => m.net > 0).length;
  const trainViable = row.train.stress.allSystemsSurvived && row.train.adverse.allSystemsSurvived
    && row.train.stress.equalWeightNet > 0 && row.train.adverse.equalWeightNet > 0
    && row.train.stress.worstSystemDrawdown <= 0.50 && row.train.adverse.worstSystemDrawdown <= 0.50
    && trainAvgMonth >= 0.05 && trainPositiveMonths >= Math.ceil(trainStressMonths.length * 0.55);
  const score = trainAvgMonth * 100 - row.train.stress.worstSystemDrawdown * 15 - row.maxTradeRisk * 20;
  return [{ hedgeRatio: r.hedgeRatio, ddCap: f.ddCap, trainViable, score, scaledTo5: row }];
}));
const selected = [...candidates].filter((c) => c.trainViable).sort((a, b) => b.score - a.score)[0]
  ?? [...candidates].sort((a, b) => b.score - a.score)[0] ?? null;

function compactVector(row) {
  if (!row) return null;
  const compactPeriod = (period) => {
    const avgStressMonth = period.stressMonths.length ? sum(period.stressMonths.map((m) => m.net)) / period.stressMonths.length : 0;
    const avgBaseMonth = period.baseMonths.length ? sum(period.baseMonths.map((m) => m.net)) / period.baseMonths.length : 0;
    return { turnoverPerDay: period.exposure.turnoverPerDay, logicalTurnoverPerDay: period.exposure.logicalTurnoverPerDay,
      nettingRetention: period.exposure.nettingRetention, peakNettedGross: period.exposure.peakNettedGross,
      impliedMinLeverageAt70pctMargin: period.exposure.impliedMinLeverageAt70pctMargin,
      baseNet: period.base.equalWeightNet, stressNet: period.stress.equalWeightNet, adverseNet: period.adverse.equalWeightNet,
      stressWorstSystemDrawdown: period.stress.worstSystemDrawdown, adverseWorstSystemDrawdown: period.adverse.worstSystemDrawdown,
      stressPositiveSystems: period.stress.positiveSystems, stressAllSurvived: period.stress.allSystemsSurvived,
      avgBaseMonth, avgStressMonth, stressPositiveMonths: period.stressMonths.filter((m) => m.net > 0).length,
      stressMonths: period.stressMonths.length };
  };
  return { scales: row.scales, hedgeRatio: row.hedgeRatio, maxTradeRisk: row.maxTradeRisk,
    maxCoreFraction: row.maxCoreFraction, maxLogicalPairFraction: row.maxLogicalPairFraction,
    discovery: compactPeriod(row.discovery), validation: compactPeriod(row.validation), train: compactPeriod(row.train),
    evaluation: compactPeriod(row.evaluation), full: compactPeriod(row.full) };
}

const compactResearch = research.map((r) => ({ hedgeRatio: r.hedgeRatio,
  frontiers: Object.fromEntries(Object.entries(r.frontiers).map(([cap, f]) => [cap, {
    ddCap: f.ddCap,
    scales: f.natural?.scales ?? null,
    natural: compactVector(f.natural),
    scaledTo5: f.scaledTo5 ? { multiplier: f.scaledTo5.multiplier, ...compactVector(f.scaledTo5) } : null,
  }])) }));

const output = {
  research: 'V13_BETA_HEDGED_FIVE_REGIME_CORE',
  objective: 'test whether a causal opposite-side BTC hedge (ETH hedge for BTC trades) reduces five-regime independent-system risk enough to scale genuine netted turnover to ~5x/day without inventing a new signal',
  data: dump.data,
  split: allocation.split,
  protocol: {
    coreTrades: 'exact frozen accepted 44m trades exported by #258 replay; no signal, entry or core exit changes',
    hedgeEntry: 'same completed 5m open as core entry with matched scenario entry slippage',
    hedgeExit: 'first BTC/ETH 5m open strictly after the core exit candle timestamp; max 15m gap',
    hedgeDirection: 'opposite core direction; BTC core trades hedge with ETH, all others hedge with BTC',
    hedgeRatios: HEDGE_RATIOS, scenarios: SCENARIOS,
    selection: 'for each hedge ratio and independent-system DD cap, choose maximum per-system scale using discovery+validation only, with <=5% frozen core planned-risk per trade; then compute the one common multiplier required for exactly 5x train genuine netted turnover',
    targetTurnoverPerDay: TARGET_TURNOVER,
    genuineTurnover: 'absolute timestamp+symbol net position changes after core and hedge legs are netted; no logical offset volume is counted',
  },
  baselineParity: compactVector(baselineUnhedged),
  researchGrid: compactResearch,
  selection: selected ? { hedgeRatio: selected.hedgeRatio, ddCap: selected.ddCap, trainViable: selected.trainViable,
    score: selected.score, scaledTo5: compactVector(selected.scaledTo5) } : null,
  decision: selected?.trainViable
    && selected.scaledTo5.evaluation.stress.equalWeightNet > 0
    && selected.scaledTo5.evaluation.stress.worstSystemDrawdown <= 0.50
    && selected.scaledTo5.evaluation.stressMonths.length > 0
    && sum(selected.scaledTo5.evaluation.stressMonths.map((m) => m.net)) / selected.scaledTo5.evaluation.stressMonths.length >= 0.05
    ? 'BETA_HEDGE_5X_FORWARD_CANDIDATE' : 'BETA_HEDGE_DOES_NOT_SOLVE_5X_TARGET',
  limitations: [
    'Hedge beta is deliberately simple and frozen at 0/0.25/0.5/0.75/1.0; no rolling regression is fitted.',
    'Core strategy PnL remains the exact frozen logical-trade cost model; hedge transaction costs are charged per logical hedge leg even when live netting could reduce fees, which is conservative.',
    'The six-month evaluation interval is historical gated evaluation, not pristine project-wide blind OOS.',
    'A research pass would still require prospective PAPER validation before any production risk change.'
  ],
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`V13_BETA_HEDGE_JSON=${JSON.stringify({ decision: output.decision, baseline: output.baselineParity,
  selection: output.selection, grid: compactResearch.map((r) => ({ hedgeRatio: r.hedgeRatio,
    caps: Object.fromEntries(Object.entries(r.frontiers).map(([cap, f]) => [cap, {
      naturalTrainTurnover: f.natural?.train.turnoverPerDay, naturalEvalStress: f.natural?.evaluation.stressNet,
      forcedTrainStress: f.scaledTo5?.train.stressNet, forcedTrainDD: f.scaledTo5?.train.stressWorstSystemDrawdown,
      forcedEvalStress: f.scaledTo5?.evaluation.stressNet, forcedEvalAvgMonth: f.scaledTo5?.evaluation.avgStressMonth,
    }])) })) })}`);
