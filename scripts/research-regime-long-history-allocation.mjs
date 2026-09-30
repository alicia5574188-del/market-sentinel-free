import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SIGNAL = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-44m-from5m-1h.json';
const EXEC = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/regime-long-history-allocation.json';
const DUMP = '/tmp/regime-long-history-capacity-dump.json';
const BASE_REPORT = '/tmp/regime-long-history-base-report.json';
const SOURCE = new URL('./research-regime-system-portfolios.mjs', import.meta.url);
const EXPECTED_SIGNAL_SHA = '185bd97b968f96373bef6a174c8258d8ad5606a0d1ed824eaa2cc1ace1efa053';
const EXPECTED_EXEC_SHA = '9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522';
const DAY_MS = 86_400_000;
const SYSTEMS = ['SHOCK_TRANSITION','COMPRESSION','DIRECTIONAL_TREND','NON_TREND_EXPANSION','BALANCED_ROTATION'];
const DD_CAPS = [0.20,0.30,0.40,0.50];
const SCALE_GRID = Array.from({ length: 48 }, (_, i) => Number(((i + 1) * 0.25).toFixed(2)));

const signalMeta = JSON.parse(readFileSync(SIGNAL, 'utf8'));
const execMeta = JSON.parse(readFileSync(EXEC, 'utf8'));
if (signalMeta.sha256 !== EXPECTED_SIGNAL_SHA || execMeta.sha256 !== EXPECTED_EXEC_SHA) {
  throw new Error(`44m dataset hash mismatch signal=${signalMeta.sha256} exec=${execMeta.sha256}`);
}

const original = readFileSync(SOURCE, 'utf8');
const marker = 'const serializableSystems = systems.map((system) => {';
if (!original.includes(marker)) throw new Error('Could not find long-history export injection marker');
const injection = String.raw`
if (process.env.RESEARCH_CAPACITY_DUMP) {
  const capacityKey = (trade) => trade.strategyId + '|' + trade.symbol + '|' + trade.openedAt;
  const capacitySystems = candidateSystems.map((system) => {
    const selection = selectedBySystem.get(system.system);
    const selected = selection?.configs ?? [];
    const stressRaw = new Map(selected.flatMap((config) => rawTrades(config, toMs, STRESS_FRICTION, ENTRY_SLIPPAGE))
      .map((trade) => [capacityKey(trade), trade]));
    const adverseRaw = new Map(selected.flatMap((config) => rawTrades(config, toMs, FRICTION, ENTRY_SLIPPAGE * 2))
      .map((trade) => [capacityKey(trade), trade]));
    const trades = system.account.trades.map((trade) => {
      const key = capacityKey(trade);
      const stress = stressRaw.get(key);
      const adverse = adverseRaw.get(key);
      return {
        strategyId: trade.strategyId, tactic: trade.tactic, system: trade.system, symbol: trade.symbol,
        side: trade.side, openedAt: trade.openedAt, closedAt: trade.closedAt,
        baseFraction: trade.notional / Math.max(trade.equityAtOpen, 1e-12),
        plannedRiskFraction: trade.plannedRisk / Math.max(trade.equityAtOpen, 1e-12),
        baseRate: trade.netReturnRate,
        stressRate: stress?.netReturnRate ?? null,
        adverseRate: adverse?.netReturnRate ?? null,
        stopRate: trade.stopRate,
      };
    });
    return { system: system.system, accepted: system.accepted, selectionMode: system.selectionMode,
      selectedStrategyIds: selected.map((config) => config.id), trades };
  });
  writeFileSync(process.env.RESEARCH_CAPACITY_DUMP, JSON.stringify({
    data: { signalSha256: signalRaw.sha256, executionSha256: executionRaw.sha256, months: signalRaw.months, symbols: signalRaw.symbols },
    split: { fromMs, discoveryEnd, validationEnd, toMs }, capacitySystems,
  }));
}
`;
const patched = original.replace(marker, `${injection}\n${marker}`);
const patchedPath = '/tmp/research-regime-system-portfolios-capacity-export.mjs';
writeFileSync(patchedPath, patched);
const run = spawnSync(process.execPath, [patchedPath], {
  env: { ...process.env, RESEARCH_SIGNAL_DATASET: SIGNAL, RESEARCH_EXECUTION_DATASET: EXEC,
    RESEARCH_OUTPUT: BASE_REPORT, RESEARCH_CAPACITY_DUMP: DUMP },
  stdio: 'inherit', maxBuffer: 1024 * 1024 * 50,
});
if (run.status !== 0) throw new Error(`44m source replay failed status=${run.status}`);

const dump = JSON.parse(readFileSync(DUMP, 'utf8'));
const baseReport = JSON.parse(readFileSync(BASE_REPORT, 'utf8'));
if (dump.capacitySystems.length !== 5 || dump.capacitySystems.some((s) => !s.accepted)) {
  throw new Error('Expected five accepted long-history systems');
}
if (dump.capacitySystems.some((s) => s.trades.some((t) => !Number.isFinite(t.stressRate) || !Number.isFinite(t.adverseRate)))) {
  throw new Error('Missing matched stress/adverse outcome for a frozen base trade');
}

const { fromMs, discoveryEnd, validationEnd, toMs } = dump.split;
const sign = (side) => side === 'LONG' ? 1 : -1;
const days = (a, b) => (b - a) / DAY_MS;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function periodTrades(system, start, end) {
  return system.trades.filter((t) => t.openedAt >= start && t.openedAt < end);
}
function simulate(system, scale, rateField, start, end) {
  const rows = periodTrades(system, start, end);
  const events = [];
  for (const t of rows) {
    events.push({ time: t.openedAt, kind: 'OPEN', t });
    events.push({ time: t.closedAt, kind: 'CLOSE', t });
  }
  events.sort((a, b) => a.time - b.time || (a.kind === 'CLOSE' ? -1 : 1));
  let equity = 1, peak = 1, minEquity = 1, maxDrawdown = 0;
  const open = new Map();
  for (const e of events) {
    const id = `${e.t.strategyId}|${e.t.symbol}|${e.t.openedAt}`;
    if (e.kind === 'OPEN') {
      open.set(id, equity);
    } else {
      const atOpen = open.get(id);
      if (atOpen == null) continue;
      equity += atOpen * e.t.baseFraction * scale * e.t[rateField];
      open.delete(id);
      peak = Math.max(peak, equity);
      minEquity = Math.min(minEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12));
    }
  }
  return { trades: rows.length, endEquity: equity, net: equity - 1, minEquity, maxDrawdown, survived: minEquity > 0 };
}
function turnover(system, scale, start, end) {
  return 2 * sum(periodTrades(system, start, end).map((t) => t.baseFraction * scale)) / days(start, end);
}
function systemPoint(system, scale) {
  const discoveryStress = simulate(system, scale, 'stressRate', fromMs, discoveryEnd);
  const validationStress = simulate(system, scale, 'stressRate', discoveryEnd, validationEnd);
  const trainStress = simulate(system, scale, 'stressRate', fromMs, validationEnd);
  const evalStress = simulate(system, scale, 'stressRate', validationEnd, toMs);
  const fullStress = simulate(system, scale, 'stressRate', fromMs, toMs);
  const discoveryAdverse = simulate(system, scale, 'adverseRate', fromMs, discoveryEnd);
  const validationAdverse = simulate(system, scale, 'adverseRate', discoveryEnd, validationEnd);
  const trainAdverse = simulate(system, scale, 'adverseRate', fromMs, validationEnd);
  const evalAdverse = simulate(system, scale, 'adverseRate', validationEnd, toMs);
  const fullAdverse = simulate(system, scale, 'adverseRate', fromMs, toMs);
  const maxTradeFraction = Math.max(...system.trades.map((t) => t.baseFraction * scale), 0);
  const maxTradeRisk = Math.max(...system.trades.map((t) => t.plannedRiskFraction * scale), 0);
  return { scale,
    turnover: { discovery: turnover(system, scale, fromMs, discoveryEnd), validation: turnover(system, scale, discoveryEnd, validationEnd),
      train: turnover(system, scale, fromMs, validationEnd), evaluation: turnover(system, scale, validationEnd, toMs), full: turnover(system, scale, fromMs, toMs) },
    stress: { discovery: discoveryStress, validation: validationStress, train: trainStress, evaluation: evalStress, full: fullStress },
    adverse: { discovery: discoveryAdverse, validation: validationAdverse, train: trainAdverse, evaluation: evalAdverse, full: fullAdverse },
    maxTradeFraction, maxTradeRisk,
  };
}

const systemFrontiers = Object.fromEntries(dump.capacitySystems.map((system) => [system.system, SCALE_GRID.map((s) => systemPoint(system, s))]));
function eligibleTrain(point, ddCap, tradeRiskCap = Infinity) {
  return point.stress.discovery.net >= 0 && point.stress.validation.net >= 0
    && point.adverse.discovery.net >= 0 && point.adverse.validation.net >= 0
    && point.stress.train.survived && point.adverse.train.survived
    && Math.max(point.stress.train.maxDrawdown, point.adverse.train.maxDrawdown) <= ddCap
    && point.maxTradeRisk <= tradeRiskCap;
}
function maxPoint(systemId, ddCap, tradeRiskCap = Infinity) {
  return [...systemFrontiers[systemId]].filter((p) => eligibleTrain(p, ddCap, tradeRiskCap))
    .sort((a, b) => b.turnover.train - a.turnover.train)[0] ?? null;
}

function exposureForVector(scales, start, end) {
  const grouped = new Map();
  let logical = 0;
  for (const system of dump.capacitySystems) {
    const scale = scales[system.system];
    for (const t of periodTrades(system, start, end)) {
      const f = t.baseFraction * scale;
      logical += 2 * Math.abs(f);
      for (const [time, delta] of [[t.openedAt, sign(t.side) * f], [t.closedAt, -sign(t.side) * f]]) {
        const key = `${time}|${t.symbol}`;
        grouped.set(key, (grouped.get(key) ?? 0) + delta);
      }
    }
  }
  const changes = [...grouped.entries()].map(([key, delta]) => {
    const split = key.indexOf('|'); return { time: Number(key.slice(0, split)), symbol: key.slice(split + 1), delta };
  }).sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const actual = sum(changes.map((x) => Math.abs(x.delta)));
  const positions = new Map();
  let peakGross = 0;
  let i = 0;
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
function aggregatePath(scales, rateField, start, end) {
  const bySystem = {};
  for (const system of dump.capacitySystems) bySystem[system.system] = simulate(system, scales[system.system], rateField, start, end);
  const equalWeightEnd = sum(Object.values(bySystem).map((x) => x.endEquity)) / SYSTEMS.length;
  return { bySystem, equalWeightEndEquity: equalWeightEnd, equalWeightNet: equalWeightEnd - 1,
    worstSystemDrawdown: Math.max(...Object.values(bySystem).map((x) => x.maxDrawdown)),
    worstSystemMinEquity: Math.min(...Object.values(bySystem).map((x) => x.minEquity)),
    positiveSystems: Object.values(bySystem).filter((x) => x.net > 0).length,
    allSystemsSurvived: Object.values(bySystem).every((x) => x.survived) };
}
function vectorSummary(scales) {
  const maxTradeRisk = Math.max(...dump.capacitySystems.flatMap((system) => system.trades.map((t) => t.plannedRiskFraction * scales[system.system])));
  const maxTradeFraction = Math.max(...dump.capacitySystems.flatMap((system) => system.trades.map((t) => t.baseFraction * scales[system.system])));
  return { scales,
    train: { exposure: exposureForVector(scales, fromMs, validationEnd), stress: aggregatePath(scales, 'stressRate', fromMs, validationEnd), adverse: aggregatePath(scales, 'adverseRate', fromMs, validationEnd) },
    evaluation: { exposure: exposureForVector(scales, validationEnd, toMs), stress: aggregatePath(scales, 'stressRate', validationEnd, toMs), adverse: aggregatePath(scales, 'adverseRate', validationEnd, toMs) },
    full: { exposure: exposureForVector(scales, fromMs, toMs), stress: aggregatePath(scales, 'stressRate', fromMs, toMs), adverse: aggregatePath(scales, 'adverseRate', fromMs, toMs) },
    maxTradeRisk, maxTradeFraction,
  };
}
function vectorFor(ddCap, tradeRiskCap = Infinity) {
  const points = Object.fromEntries(SYSTEMS.map((id) => [id, maxPoint(id, ddCap, tradeRiskCap)]));
  if (Object.values(points).some((p) => !p)) return null;
  return { ddCap, tradeRiskCap: Number.isFinite(tradeRiskCap) ? tradeRiskCap : null,
    selectedFrom: 'discovery+validation only', pointBySystem: points,
    ...vectorSummary(Object.fromEntries(SYSTEMS.map((id) => [id, points[id].scale]))) };
}

const baseline = vectorSummary(Object.fromEntries(SYSTEMS.map((id) => [id, 1])));
const frontiers = Object.fromEntries(DD_CAPS.map((cap) => [String(Math.round(cap * 100)), vectorFor(cap)]));
const frontiersTradeRisk5 = Object.fromEntries(DD_CAPS.map((cap) => [String(Math.round(cap * 100)), vectorFor(cap, 0.05)]));
const perSystem = Object.fromEntries(SYSTEMS.map((id) => [id, {
  trades: dump.capacitySystems.find((s) => s.system === id).trades.length,
  baseline1x: systemFrontiers[id].find((p) => p.scale === 1),
  maxScaleUnderDd: Object.fromEntries(DD_CAPS.map((cap) => [String(Math.round(cap * 100)), maxPoint(id, cap)])),
  maxScaleUnderDdAnd5pctTradeRisk: Object.fromEntries(DD_CAPS.map((cap) => [String(Math.round(cap * 100)), maxPoint(id, cap, 0.05)])),
}]));

const output = {
  research: 'regime-v11-long-history-nonuniform-allocation-v1',
  objective: 'derive long-history per-system capacity and non-uniform notional allocation from the exact committed 44-month regime research path without changing any selected signal or trade timing',
  data: dump.data,
  split: { discovery: baseReport.split.discovery, validation: baseReport.split.validation, evaluation: baseReport.split.evaluation },
  protocol: {
    sourceReplay: 'exact scripts/research-regime-system-portfolios.mjs rerun on the committed 44m dataset hashes; only a temporary export hook is injected',
    frozenTrades: 'the original base accepted trade set for each of five systems is frozen; scaling changes notional only and re-compounds each independent system from its own equity',
    stressMapping: 'each frozen base trade is matched by strategy/symbol/open-time to the exact higher-cost and doubled-adverse-entry resolved outcome from the original research engine',
    selection: 'per-system maximum scale is selected using discovery+validation only; 2026-03..08 evaluation is reported unchanged and is not used to choose scale',
    scaleGrid: [0.25, 12, 0.25], ddCaps: DD_CAPS, optionalSingleTradeRiskCap: 0.05,
    turnover: 'entry and exit signed fractions are netted by symbol+timestamp before absolute genuine turnover is counted',
  },
  committedDecision: baseReport.decision,
  baseline1x: baseline,
  perSystem,
  frontiers,
  frontiersTradeRisk5pct: frontiersTradeRisk5,
  limitations: [
    'This long-history stage covers the original 11-symbol five-regime core. SUI/UNI satellite capacity is intentionally not extrapolated backward beyond its separate V1.1 validation history.',
    'The final six months are gated historical evaluation, not project-wide pristine blind data, matching the committed research limitation.',
    'A scale frontier is capacity evidence, not production authorization. Production admission/risk caps are unchanged.',
  ],
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`REGIME_LONG_HISTORY_ALLOCATION=${JSON.stringify({ committedDecision: output.committedDecision,
  baselineTurnover: baseline.full.exposure.turnoverPerDay,
  perSystem: Object.fromEntries(SYSTEMS.map((id) => [id, { trades: perSystem[id].trades,
    baselineTurnover: perSystem[id].baseline1x.turnover.full,
    maxScale30: perSystem[id].maxScaleUnderDd['30']?.scale ?? null,
    maxScale50: perSystem[id].maxScaleUnderDd['50']?.scale ?? null }])),
  frontiers: Object.fromEntries(Object.entries(frontiers).map(([k, v]) => [k, v && { scales: v.scales,
    trainTurnover: v.train.exposure.turnoverPerDay, evalTurnover: v.evaluation.exposure.turnoverPerDay,
    fullTurnover: v.full.exposure.turnoverPerDay, trainWorstDd: v.train.stress.worstSystemDrawdown,
    evalWorstDd: v.evaluation.stress.worstSystemDrawdown, evalStressNet: v.evaluation.stress.equalWeightNet,
    evalPositiveSystems: v.evaluation.stress.positiveSystems, impliedLeverage: v.full.exposure.impliedMinLeverageAt70pctMargin,
    maxTradeRisk: v.maxTradeRisk }]))
})}`);