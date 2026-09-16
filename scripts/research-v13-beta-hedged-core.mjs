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
if (exec.sha256 !== EXPECTED_EXEC_SHA || dump.data.executionSha256 !== EXPECTED_EXEC_SHA) throw new Error('execution hash mismatch');
if (dump.capacitySystems.length !== 5 || dump.capacitySystems.some((s) => !s.accepted)) throw new Error('expected five accepted systems');
const { fromMs, discoveryEnd, validationEnd, toMs } = dump.split;
const days = (a, b) => (b - a) / DAY_MS;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sideSign = (side) => side === 'LONG' ? 1 : -1;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);

const execution = new Map(exec.datasets.map((dataset) => [dataset.symbol,
  dataset.rows.map((r) => ({ time: Number(r.time), open: Number(r.open) }))]));
function lowerBound(rows, time) {
  let lo = 0; let hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
function benchmark(symbol) { return symbol === 'BTC_USDT' ? 'ETH_USDT' : 'BTC_USDT'; }
function hedgeOutcome(trade, friction, slippage) {
  const symbol = benchmark(trade.symbol); const rows = execution.get(symbol); if (!rows) return null;
  const openedSec = Math.floor(trade.openedAt / 1000); const closedSec = Math.floor(trade.closedAt / 1000);
  const entryRow = rows[lowerBound(rows, openedSec)];
  const exitRow = rows[lowerBound(rows, closedSec + 1)];
  // Sparse early archive gaps are not interpolated or backfilled. The hedge waits
  // for the first actually recorded 5m open, which is causal and conservative.
  if (!entryRow || entryRow.time > openedSec + 900 || !(entryRow.open > 0)) return null;
  if (!exitRow || exitRow.time > closedSec + 3600 || !(exitRow.open > 0)) return null;
  const direction = -sideSign(trade.side);
  const entry = entryRow.open * (1 + direction * slippage);
  const grossRate = direction * (exitRow.open - entry) / entry;
  return { symbol, direction, openedAt: entryRow.time * 1000, closedAt: exitRow.time * 1000,
    entryDelayMinutes: (entryRow.time - openedSec) / 60, exitDelayMinutes: (exitRow.time - closedSec) / 60,
    netRate: grossRate - friction };
}
const SCENARIOS = {
  base: { coreField: 'baseRate', friction: BASE_FRICTION, slippage: BASE_SLIPPAGE },
  stress: { coreField: 'stressRate', friction: STRESS_FRICTION, slippage: BASE_SLIPPAGE },
  adverse: { coreField: 'adverseRate', friction: BASE_FRICTION, slippage: ADVERSE_SLIPPAGE },
};
const enrichedSystems = dump.capacitySystems.map((system) => ({ ...system,
  trades: system.trades.map((trade) => ({ ...trade, hedge: Object.fromEntries(Object.entries(SCENARIOS)
    .map(([name, s]) => [name, hedgeOutcome(trade, s.friction, s.slippage)])) })) }));
const missingHedges = enrichedSystems.flatMap((system) => system.trades.filter((t) => Object.values(t.hedge).some((h) => !h))
  .map((t) => ({ system: system.system, symbol: t.symbol, openedAt: t.openedAt, closedAt: t.closedAt })));
if (missingHedges.length) throw new Error(`missing causal benchmark for ${missingHedges.length} trades: ${JSON.stringify(missingHedges.slice(0, 5))}`);
const delayedHedges = enrichedSystems.flatMap((system) => system.trades.map((t) => t.hedge.base))
  .filter((h) => h.entryDelayMinutes > 0 || h.exitDelayMinutes > 5);

function periodTrades(system, start, end) { return system.trades.filter((t) => t.openedAt >= start && t.openedAt < end); }
function tradeRate(trade, hedgeRatio, scenario) {
  const s = SCENARIOS[scenario]; return trade[s.coreField] + hedgeRatio * trade.hedge[scenario].netRate;
}
function simulateSystem(system, scale, hedgeRatio, scenario, start, end) {
  const rows = periodTrades(system, start, end); const events = [];
  for (const trade of rows) {
    const closeAt = hedgeRatio > 0 ? Math.max(trade.closedAt, trade.hedge[scenario].closedAt) : trade.closedAt;
    events.push({ time: trade.openedAt, open: true, trade }); events.push({ time: closeAt, open: false, trade });
  }
  events.sort((a, b) => a.time - b.time || Number(a.open) - Number(b.open));
  let equity = 1, peak = 1, minEquity = 1, maxDrawdown = 0; const opened = new Map();
  for (const event of events) {
    const id = `${event.trade.strategyId}|${event.trade.symbol}|${event.trade.openedAt}`;
    if (event.open) opened.set(id, equity);
    else {
      const atOpen = opened.get(id); if (atOpen == null) continue;
      equity += atOpen * event.trade.baseFraction * scale * tradeRate(event.trade, hedgeRatio, scenario);
      opened.delete(id); peak = Math.max(peak, equity); minEquity = Math.min(minEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12));
    }
  }
  return { trades: rows.length, endEquity: equity, net: equity - 1, minEquity, maxDrawdown, survived: minEquity > 0 };
}
function exposure(scales, hedgeRatio, start, end, systemFilter = SYSTEMS) {
  const grouped = new Map(); let logical = 0;
  const add = (time, symbol, delta) => { const key = `${time}|${symbol}`; grouped.set(key, (grouped.get(key) ?? 0) + delta); };
  for (const system of enrichedSystems.filter((s) => systemFilter.includes(s.system))) {
    const scale = scales[system.system] ?? 0;
    for (const trade of periodTrades(system, start, end)) {
      const f = trade.baseFraction * scale; const dir = sideSign(trade.side);
      logical += 2 * Math.abs(f); add(trade.openedAt, trade.symbol, dir * f); add(trade.closedAt, trade.symbol, -dir * f);
      if (hedgeRatio > 0) {
        const hf = f * hedgeRatio; const h = trade.hedge.base; logical += 2 * Math.abs(hf);
        add(h.openedAt, h.symbol, -dir * hf); add(h.closedAt, h.symbol, dir * hf);
      }
    }
  }
  const changes = [...grouped.entries()].map(([key, delta]) => {
    const split = key.indexOf('|'); return { time: Number(key.slice(0, split)), symbol: key.slice(split + 1), delta };
  }).sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const actual = sum(changes.map((x) => Math.abs(x.delta))); const positions = new Map(); let peakGross = 0; let i = 0;
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
    const nets = enrichedSystems.map((system) => simulateSystem(system, scales[system.system] ?? 0, hedgeRatio, scenario, a, b).net);
    return [{ month, net: sum(nets) / SYSTEMS.length }];
  });
}
function vectorSummary(scales, hedgeRatio) {
  const maxTradeRisk = Math.max(...enrichedSystems.flatMap((system) => system.trades.map((t) => t.plannedRiskFraction * scales[system.system])), 0);
  const maxCoreFraction = Math.max(...enrichedSystems.flatMap((system) => system.trades.map((t) => t.baseFraction * scales[system.system])), 0);
  const period = (start, end) => ({ exposure: exposure(scales, hedgeRatio, start, end),
    base: aggregatePath(scales, hedgeRatio, 'base', start, end), stress: aggregatePath(scales, hedgeRatio, 'stress', start, end),
    adverse: aggregatePath(scales, hedgeRatio, 'adverse', start, end),
    baseMonths: monthRows(scales, hedgeRatio, 'base', start, end), stressMonths: monthRows(scales, hedgeRatio, 'stress', start, end) });
  return { scales, hedgeRatio, maxTradeRisk, maxCoreFraction, maxLogicalPairFraction: maxCoreFraction * (1 + hedgeRatio),
    discovery: period(fromMs, discoveryEnd), validation: period(discoveryEnd, validationEnd), train: period(fromMs, validationEnd),
    evaluation: period(validationEnd, toMs), full: period(fromMs, toMs) };
}
function systemPoint(system, scale, hedgeRatio) {
  const run = (scenario, a, b) => simulateSystem(system, scale, hedgeRatio, scenario, a, b);
  const only = Object.fromEntries(SYSTEMS.map((id) => [id, id === system.system ? scale : 0]));
  return { scale, turnoverTrain: exposure(only, hedgeRatio, fromMs, validationEnd, [system.system]).turnoverPerDay,
    stress: { discovery: run('stress', fromMs, discoveryEnd), validation: run('stress', discoveryEnd, validationEnd), train: run('stress', fromMs, validationEnd) },
    adverse: { discovery: run('adverse', fromMs, discoveryEnd), validation: run('adverse', discoveryEnd, validationEnd), train: run('adverse', fromMs, validationEnd) },
    maxTradeRisk: Math.max(...system.trades.map((t) => t.plannedRiskFraction * scale), 0) };
}
function eligible(point, ddCap) {
  return point.stress.discovery.net >= 0 && point.stress.validation.net >= 0 && point.adverse.discovery.net >= 0 && point.adverse.validation.net >= 0
    && point.stress.train.survived && point.adverse.train.survived
    && Math.max(point.stress.train.maxDrawdown, point.adverse.train.maxDrawdown) <= ddCap && point.maxTradeRisk <= 0.05;
}
function compact(row) {
  if (!row) return null;
  const p = (x) => {
    const avg = x.stressMonths.length ? sum(x.stressMonths.map((m) => m.net)) / x.stressMonths.length : 0;
    const avgBase = x.baseMonths.length ? sum(x.baseMonths.map((m) => m.net)) / x.baseMonths.length : 0;
    return { turnoverPerDay: x.exposure.turnoverPerDay, logicalTurnoverPerDay: x.exposure.logicalTurnoverPerDay,
      nettingRetention: x.exposure.nettingRetention, peakNettedGross: x.exposure.peakNettedGross,
      impliedMinLeverageAt70pctMargin: x.exposure.impliedMinLeverageAt70pctMargin,
      baseNet: x.base.equalWeightNet, stressNet: x.stress.equalWeightNet, adverseNet: x.adverse.equalWeightNet,
      stressWorstSystemDrawdown: x.stress.worstSystemDrawdown, adverseWorstSystemDrawdown: x.adverse.worstSystemDrawdown,
      stressPositiveSystems: x.stress.positiveSystems, stressAllSurvived: x.stress.allSystemsSurvived,
      avgBaseMonth: avgBase, avgStressMonth: avg, stressPositiveMonths: x.stressMonths.filter((m) => m.net > 0).length, months: x.stressMonths.length };
  };
  return { scales: row.scales, hedgeRatio: row.hedgeRatio, maxTradeRisk: row.maxTradeRisk, maxCoreFraction: row.maxCoreFraction,
    maxLogicalPairFraction: row.maxLogicalPairFraction, discovery: p(row.discovery), validation: p(row.validation), train: p(row.train),
    evaluation: p(row.evaluation), full: p(row.full) };
}

const grid = [];
for (const hedgeRatio of HEDGE_RATIOS) {
  const caps = {};
  for (const ddCap of DD_CAPS) {
    const scales = {}; const perSystem = {};
    for (const system of enrichedSystems) {
      const selected = SCALE_GRID.map((scale) => systemPoint(system, scale, hedgeRatio)).filter((x) => eligible(x, ddCap))
        .sort((a, b) => b.turnoverTrain - a.turnoverTrain)[0] ?? null;
      perSystem[system.system] = selected; scales[system.system] = selected?.scale ?? 0;
    }
    const natural = Object.values(perSystem).every(Boolean) ? vectorSummary(scales, hedgeRatio) : null;
    let scaledTo5 = null;
    if (natural?.train.exposure.turnoverPerDay > 0) {
      const multiplier = TARGET_TURNOVER / natural.train.exposure.turnoverPerDay;
      const forced = Object.fromEntries(SYSTEMS.map((id) => [id, scales[id] * multiplier]));
      scaledTo5 = { multiplier, ...vectorSummary(forced, hedgeRatio) };
    }
    caps[String(Math.round(ddCap * 100))] = { ddCap, scales, natural, scaledTo5 };
  }
  grid.push({ hedgeRatio, caps });
}

const baseline = vectorSummary(Object.fromEntries(SYSTEMS.map((id) => [id, 1])), 0);
if (Math.abs(baseline.full.exposure.turnoverPerDay - 0.58245) > 0.002) throw new Error(`baseline parity failed ${baseline.full.exposure.turnoverPerDay}`);
const candidates = grid.flatMap((g) => Object.values(g.caps).flatMap((cap) => {
  if (!cap.scaledTo5) return [];
  const r = cap.scaledTo5; const months = r.train.stressMonths;
  const avg = months.length ? sum(months.map((m) => m.net)) / months.length : -1;
  const trainViable = r.train.stress.allSystemsSurvived && r.train.adverse.allSystemsSurvived
    && r.train.stress.equalWeightNet > 0 && r.train.adverse.equalWeightNet > 0
    && r.train.stress.worstSystemDrawdown <= 0.50 && r.train.adverse.worstSystemDrawdown <= 0.50
    && avg >= 0.05 && months.filter((m) => m.net > 0).length >= Math.ceil(months.length * 0.55);
  return [{ hedgeRatio: g.hedgeRatio, ddCap: cap.ddCap, trainViable,
    score: avg * 100 - r.train.stress.worstSystemDrawdown * 15 - r.maxTradeRisk * 20, row: r }];
}));
const selected = candidates.filter((x) => x.trainViable).sort((a, b) => b.score - a.score)[0]
  ?? [...candidates].sort((a, b) => b.score - a.score)[0] ?? null;
const evalAvgStress = selected?.row.evaluation.stressMonths.length
  ? sum(selected.row.evaluation.stressMonths.map((m) => m.net)) / selected.row.evaluation.stressMonths.length : -1;
const decision = selected?.trainViable && selected.row.evaluation.stress.equalWeightNet > 0
  && selected.row.evaluation.stress.worstSystemDrawdown <= 0.50 && evalAvgStress >= 0.05
  ? 'BETA_HEDGE_5X_FORWARD_CANDIDATE' : 'BETA_HEDGE_DOES_NOT_SOLVE_5X_TARGET';

const output = {
  research: 'V13_BETA_HEDGED_FIVE_REGIME_CORE', decision,
  objective: 'test whether a causal opposite-side BTC hedge (ETH for BTC trades) reduces the frozen five-regime core risk enough to support about 5x/day genuine netted turnover',
  data: dump.data, split: allocation.split,
  protocol: { coreTrades: 'exact frozen accepted #258 44m trades; signals/entries/core exits unchanged',
    hedgeDirection: 'opposite core; BTC core uses ETH, all others BTC', hedgeRatios: HEDGE_RATIOS,
    hedgeEntry: 'first actually recorded benchmark 5m open at-or-after core entry, max 15m; no interpolation/backfill',
    hedgeExit: 'first actually recorded benchmark 5m open strictly after core exit timestamp, max 60m',
    delayedHedgeLegs: delayedHedges.length, maxEntryDelayMinutes: Math.max(0, ...delayedHedges.map((h) => h.entryDelayMinutes)),
    maxExitDelayMinutes: Math.max(0, ...delayedHedges.map((h) => h.exitDelayMinutes)),
    selection: 'discovery+validation only; max per-system scale under DD cap and <=5% frozen core planned-risk, then one common multiplier to exactly 5x train genuine netted turnover',
    costs: SCENARIOS, genuineTurnover: 'absolute timestamp+symbol net position changes after core and hedge legs are netted' },
  baselineParity: compact(baseline),
  grid: grid.map((g) => ({ hedgeRatio: g.hedgeRatio, caps: Object.fromEntries(Object.entries(g.caps).map(([k, cap]) => [k, {
    scales: cap.scales, natural: compact(cap.natural), scaledTo5: cap.scaledTo5 ? { multiplier: cap.scaledTo5.multiplier, ...compact(cap.scaledTo5) } : null }])) })),
  selection: selected ? { hedgeRatio: selected.hedgeRatio, ddCap: selected.ddCap, trainViable: selected.trainViable,
    score: selected.score, scaledTo5: compact(selected.row), evaluationAvgStressMonth: evalAvgStress } : null,
  limitations: ['hedge ratio is a fixed grid, not a fitted rolling beta', 'hedge costs are charged per logical hedge leg even if live netting could reduce fees',
    '2026-03..08 evaluation is gated historical evaluation, not pristine project-wide blind OOS', 'research-only; no production authorization']
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`V13_BETA_HEDGE_JSON=${JSON.stringify({ decision, delayedHedges: delayedHedges.length, baseline: output.baselineParity,
  selection: output.selection, grid: output.grid.map((g) => ({ hedgeRatio: g.hedgeRatio,
    caps: Object.fromEntries(Object.entries(g.caps).map(([k, x]) => [k, { naturalTrainTurnover: x.natural?.train.turnoverPerDay,
      naturalEvalStress: x.natural?.evaluation.stressNet, forcedTrainStress: x.scaledTo5?.train.stressNet,
      forcedTrainDD: x.scaledTo5?.train.stressWorstSystemDrawdown, forcedEvalStress: x.scaledTo5?.evaluation.stressNet,
      forcedEvalAvgMonth: x.scaledTo5?.evaluation.avgStressMonth }])) })) })}`);
