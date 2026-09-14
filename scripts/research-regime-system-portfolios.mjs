import { readFileSync, writeFileSync } from "node:fs";

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? "/tmp/gate-history-44m-from5m-1h.json";
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? "/tmp/gate-history-44m-5m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "research-results/regime-system-portfolios-2026-09-14.json";
const FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const ENTRY_SLIPPAGE = 0.00025;
const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET, "utf8"));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET, "utf8"));
if (signalRaw.interval !== "1h" || executionRaw.interval !== "5m"
  || signalRaw.months.join() !== executionRaw.months.join()) throw new Error("Requires matching Gate 1h-signal and 5m-execution datasets");
if (signalRaw.months.length < 39) throw new Error("Requires at least 39 chronological months");

const SYSTEMS = ["SHOCK_TRANSITION", "COMPRESSION", "DIRECTIONAL_TREND", "NON_TREND_EXPANSION", "BALANCED_ROTATION"];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
};
const sign = (value) => value > 0 ? 1 : value < 0 ? -1 : 0;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const fromMs = signalRaw.from * 1_000; const toMs = signalRaw.now * 1_000;
const discoveryEnd = monthStart(signalRaw.months[30]);
const validationEnd = monthStart(signalRaw.months[38]);
const executionBySymbol = new Map(executionRaw.datasets.map((item) => [item.symbol, item.rows]));

function gapPrefix(rows) {
  const prefix = [0];
  for (let index = 1; index < rows.length; index += 1) {
    prefix.push(prefix.at(-1) + Number(rows[index].time !== rows[index - 1].time + 3_600));
  }
  return prefix;
}
const ret = (rows, index, hours) => rows[index].close / rows[index - hours].close - 1;
const rangeRate = (row) => (row.high - row.low) / Math.max(row.close, 1e-12);

const observationsByTime = new Map();
for (const { symbol, rows } of signalRaw.datasets) {
  const gaps = gapPrefix(rows);
  for (let index = 720; index < rows.length - 1; index += 1) {
    const current = rows[index];
    if (gaps[index] !== gaps[index - 720]
      || rows[index + 1].time !== current.time + 3_600) continue;
    const previous24 = rows.slice(index - 24, index);
    const previous7d = rows.slice(index - 168, index);
    const currentRanges = rows.slice(index - 5, index + 1).map(rangeRate);
    const baselineRanges = rows.slice(index - 168, index - 6).map(rangeRate);
    const recentVolume = sum(rows.slice(index - 5, index + 1).map((row) => row.volume)) / 6;
    const baselineVolume = sum(rows.slice(index - 48, index - 6).map((row) => row.volume)) / 42;
    const f = { symbol, rows, index, current,
      r1: ret(rows, index, 1), r6: ret(rows, index, 6), r24: ret(rows, index, 24),
      r7d: ret(rows, index, 168), r30d: ret(rows, index, 720),
      atr6: median(currentRanges), compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9),
      volumeBurst: recentVolume / Math.max(baselineVolume, 1e-9),
      high24: Math.max(...previous24.map((row) => row.high)), low24: Math.min(...previous24.map((row) => row.low)),
      high7d: Math.max(...previous7d.map((row) => row.high)), low7d: Math.min(...previous7d.map((row) => row.low)) };
    const values = observationsByTime.get(current.time) ?? [];
    values.push(f); observationsByTime.set(current.time, values);
  }
}

function classify(context) {
  const aligned24 = Math.max(context.breadth24, 1 - context.breadth24);
  if (Math.abs(context.median24) >= 0.04 || (Math.abs(context.median24) >= 0.02 && aligned24 >= 0.82)) return "SHOCK_TRANSITION";
  if (context.compression <= 0.68 && Math.abs(context.median24) < 0.025) return "COMPRESSION";
  if ((context.median30 >= 0.08 && context.median7 >= 0.015 && context.breadth30 >= 0.60)
    || (context.median30 <= -0.08 && context.median7 <= -0.015 && context.breadth30 <= 0.40)) return "DIRECTIONAL_TREND";
  if (Math.abs(context.median24) >= 0.018 || aligned24 >= 0.75) return "NON_TREND_EXPANSION";
  return "BALANCED_ROTATION";
}

const observations = [];
const stateCounts = Object.fromEntries(SYSTEMS.map((system) => [system, 0]));
for (const [time, rows] of observationsByTime) {
  if (rows.length < Math.max(8, signalRaw.symbols.length - 2)) continue;
  const values = (key) => rows.map((row) => row[key]);
  const context = { median24: median(values("r24")), median7: median(values("r7d")), median30: median(values("r30d")),
    breadth24: rows.filter((row) => row.r24 > 0).length / rows.length,
    breadth7: rows.filter((row) => row.r7d > 0).length / rows.length,
    breadth30: rows.filter((row) => row.r30d > 0).length / rows.length,
    compression: median(values("compression")), markets: rows.length };
  const system = classify(context); stateCounts[system] += 1;
  for (const f of rows) observations.push({ ...f, time, context,
    relative24: f.r24 - context.median24, relative7: f.r7d - context.median7, system });
}

const common = { riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05,
  stopCap: 0.20, cooldownHours: 24 };
const configs = [];
const add = (system, tactic, variants) => variants.forEach((variant, index) => configs.push({ ...common, ...variant,
  id: `${system.toLowerCase()}-${tactic.toLowerCase()}-${index}`, system, tactic }));
const product = (...sets) => sets.reduce((rows, set) => rows.flatMap((row) => set.map((value) => [...row, value])), [[]]);

add("BULL_TREND", "LEADER_TRAIL", product([0.02, 0.05], [0, 0.01], [0.06, 0.10], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 8, exitModel: "TRAIL", trailScale, maxHoldHours: 336 })));
add("BULL_TREND", "PULLBACK_RESUME", product([0, 0.03], [0.03, 0.06], [0, 0.004], [1.5, 2.2]).map(([relative7, pullbackMax, resume6, rewardRisk]) => ({
  relative7, pullbackMin: 0.005, pullbackMax, resume6, stopFloor: 0.04, stopAtr: 6, rewardRisk, maxHoldHours: 96 })));
add("BULL_TREND", "BREAKOUT_TRAIL", product([0.08, 0.15], [0.60, 0.70], [0.06, 0.10], [0.6, 0.8]).map(([symbol30, breadth, stopFloor, trailScale]) => ({
  symbol30, breadth, stopFloor, stopAtr: 8, exitModel: "TRAIL", trailScale, maxHoldHours: 720 })));
add("BULL_TREND", "DEFENSIVE_RELATIVE", product([0.03, 0.05], [0, 0.004], [0.03, 0.05], [1.5, 2.2]).map(([relative7, confirm6, stopFloor, rewardRisk]) => ({
  relative7, confirm6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("BULL_TREND", "RELATIVE_MOMENTUM", product([0.03, 0.05], [0, 0.005], [0.04, 0.06], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 6, exitModel: "TRAIL", trailScale, maxHoldHours: 168 })));

add("BEAR_TREND", "LAGGARD_TRAIL", product([0.02, 0.05], [0, 0.01], [0.06, 0.10], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 8, exitModel: "TRAIL", trailScale, maxHoldHours: 336 })));
add("BEAR_TREND", "BOUNCE_FADE", product([0, 0.03], [0.03, 0.06], [0, 0.004], [1.5, 2.2]).map(([relative7, pullbackMax, resume6, rewardRisk]) => ({
  relative7, pullbackMin: 0.005, pullbackMax, resume6, stopFloor: 0.04, stopAtr: 6, rewardRisk, maxHoldHours: 96 })));
add("BEAR_TREND", "BREAKDOWN_TRAIL", product([0.08, 0.15], [0.30, 0.40], [0.06, 0.10], [0.6, 0.8]).map(([symbol30, breadth, stopFloor, trailScale]) => ({
  symbol30, breadth, stopFloor, stopAtr: 8, exitModel: "TRAIL", trailScale, maxHoldHours: 720 })));
add("BEAR_TREND", "DEFENSIVE_RELATIVE", product([0.03, 0.05], [0, 0.004], [0.03, 0.05], [1.5, 2.2]).map(([relative7, confirm6, stopFloor, rewardRisk]) => ({
  relative7, confirm6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("BEAR_TREND", "RELATIVE_MOMENTUM", product([0.03, 0.05], [0, 0.005], [0.04, 0.06], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 6, exitModel: "TRAIL", trailScale, maxHoldHours: 168 })));
add("BEAR_TREND", "MARKET_REBOUND", product([0.03, 0.05], [0.003, 0.008], [0.03, 0.05], [1.5, 2.2]).map(([drop24, rebound6, stopFloor, rewardRisk]) => ({
  drop24, rebound6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));

add("DIRECTIONAL_TREND", "TREND_FOLLOW", product([0.02, 0.05], [0, 0.01], [0.06, 0.10], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 8, exitModel: "TRAIL", trailScale, maxHoldHours: 336 })));
add("DIRECTIONAL_TREND", "TREND_PULLBACK", product([0, 0.03], [0.03, 0.06], [0, 0.004], [1.5, 2.2]).map(([relative7, pullbackMax, resume6, rewardRisk]) => ({
  relative7, pullbackMin: 0.005, pullbackMax, resume6, stopFloor: 0.04, stopAtr: 6, rewardRisk, maxHoldHours: 96 })));
add("DIRECTIONAL_TREND", "TREND_BREAKOUT", product([0.08, 0.15], [0.06, 0.10], [0.6, 0.8]).map(([symbol30, stopFloor, trailScale]) => ({
  symbol30, stopFloor, stopAtr: 8, exitModel: "TRAIL", trailScale, maxHoldHours: 720 })));
add("DIRECTIONAL_TREND", "DEFENSIVE_RELATIVE", product([0.03, 0.05], [0, 0.004], [0.03, 0.05], [1.5, 2.2]).map(([relative7, confirm6, stopFloor, rewardRisk]) => ({
  relative7, confirm6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("DIRECTIONAL_TREND", "RELATIVE_MOMENTUM", product([0.03, 0.05], [0, 0.005], [0.04, 0.06], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 6, exitModel: "TRAIL", trailScale, maxHoldHours: 168 })));

add("SHOCK_TRANSITION", "SHOCK_REVERSAL", product([0.05, 0.08], [0.003, 0.008], [0.04, 0.06], [1.5, 2.2]).map(([symbol24, resume6, stopFloor, rewardRisk]) => ({
  symbol24, resume6, stopFloor, stopAtr: 6, rewardRisk, maxHoldHours: 72 })));
add("SHOCK_TRANSITION", "SHOCK_CONTINUATION", product([0.05, 0.08], [0.005, 0.01], [0.04, 0.06], [1.5, 2.2]).map(([symbol24, impulse6, stopFloor, rewardRisk]) => ({
  symbol24, impulse6, stopFloor, stopAtr: 6, rewardRisk, maxHoldHours: 72 })));
add("SHOCK_TRANSITION", "RELATIVE_SURVIVOR", product([0.03, 0.05], [0, 0.004], [0.04, 0.06], [1.5, 2.2]).map(([relative24, resume6, stopFloor, rewardRisk]) => ({
  relative24, resume6, stopFloor, stopAtr: 6, rewardRisk, maxHoldHours: 96 })));
add("SHOCK_TRANSITION", "SHORT_HORIZON_REVERSAL", product([0.03, 0.05], [0.003, 0.008], [0.03, 0.05], [1.5, 2.2]).map(([relative24, reversal6, stopFloor, rewardRisk]) => ({
  relative24, reversal6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("SHOCK_TRANSITION", "RELATIVE_MOMENTUM", product([0.03, 0.05], [0, 0.005], [0.04, 0.06], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 6, exitModel: "TRAIL", trailScale, maxHoldHours: 168 })));
add("SHOCK_TRANSITION", "ALIGNED_DOWNSHOCK_REVERSAL", product([0.05, 0.08], [0.003, 0.008], [0.04, 0.06], [1.5, 2.2]).map(([symbol24, rebound6, stopFloor, rewardRisk]) => ({
  symbol24, rebound6, stopFloor, stopAtr: 6, rewardRisk, maxHoldHours: 72 })));
add("SHOCK_TRANSITION", "COUNTER_DOWNSHOCK_SURVIVOR", product([0.03, 0.05], [0, 0.004], [0.04, 0.06], [1.5, 2.2]).map(([relative24, rebound6, stopFloor, rewardRisk]) => ({
  relative24, rebound6, stopFloor, stopAtr: 6, rewardRisk, maxHoldHours: 96 })));

add("COMPRESSION", "RELEASE_BREAKOUT", product([1.1, 1.4], [0.55, 0.65], [0.03, 0.05], [1.5, 2.2]).map(([volume, breadth, stopFloor, rewardRisk]) => ({
  volume, breadth, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("COMPRESSION", "RELATIVE_RELEASE", product([0.015, 0.03], [1.1, 1.4], [0.03, 0.05], [1.5, 2.2]).map(([relative7, volume, stopFloor, rewardRisk]) => ({
  relative7, volume, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("COMPRESSION", "FALSE_RELEASE", product([1.1, 1.4], [0.002, 0.005], [0.03, 0.05], [1.5, 2.2]).map(([volume, reclaim, stopFloor, rewardRisk]) => ({
  volume, reclaim, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 48 })));
add("COMPRESSION", "QUIET_PULLBACK_RESUME", product([0.03, 0.05], [0.01, 0.025], [0.002, 0.006], [0.03, 0.05], [1.5, 2.2]).map(([relative7, pullbackMax, resume6, stopFloor, rewardRisk]) => ({
  relative7, pullbackMin: 0.003, pullbackMax, resume6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 96 })));

add("NON_TREND_EXPANSION", "BREADTH_CONTINUATION", product([0.03, 0.05], [0.005, 0.01], [0.03, 0.05], [1.5, 2.2]).map(([symbol24, impulse6, stopFloor, rewardRisk]) => ({
  symbol24, impulse6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("NON_TREND_EXPANSION", "REFINED_BREADTH_CONTINUATION", product([0.045, 0.055], [0.003, 0.005], [0.025, 0.035], [2.0, 2.4]).map(([symbol24, impulse6, stopFloor, rewardRisk]) => ({
  symbol24, impulse6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("NON_TREND_EXPANSION", "EXPANSION_PULLBACK", product([0.03, 0.05], [0.02, 0.05], [0, 0.004], [1.5, 2.2]).map(([symbol24, pullbackMax, resume6, rewardRisk]) => ({
  symbol24, pullbackMin: 0.005, pullbackMax, resume6, stopFloor: 0.035, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("NON_TREND_EXPANSION", "EXPANSION_EXHAUSTION", product([0.05, 0.08], [0.003, 0.008], [0.03, 0.05], [1.5, 2.2]).map(([symbol24, reversal6, stopFloor, rewardRisk]) => ({
  symbol24, reversal6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 48 })));
add("NON_TREND_EXPANSION", "RELATIVE_MOMENTUM", product([0.03, 0.05], [0, 0.005], [0.04, 0.06], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 6, exitModel: "TRAIL", trailScale, maxHoldHours: 168 })));
add("NON_TREND_EXPANSION", "SHORT_HORIZON_REVERSAL", product([0.03, 0.05], [0.003, 0.008], [0.03, 0.05], [1.5, 2.2]).map(([relative24, reversal6, stopFloor, rewardRisk]) => ({
  relative24, reversal6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("NON_TREND_EXPANSION", "EXPANSION_DEFENDER", product([0.025, 0.04], [0, 0.004], [0.03, 0.05], [1.5, 2.2]).map(([relative24, resume6, stopFloor, rewardRisk]) => ({
  relative24, resume6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));

add("BALANCED_ROTATION", "RANGE_EDGE", product([0.10, 0.18], [0.002, 0.005], [0.02, 0.04], [1.5, 2.2]).map(([edge, resume6, stopFloor, rewardRisk]) => ({
  edge, resume6, stopFloor, stopAtr: 4, rewardRisk, maxHoldHours: 48 })));
add("BALANCED_ROTATION", "RELATIVE_REVERSION", product([0.04, 0.07], [0.002, 0.005], [0.02, 0.04], [1.5, 2.2]).map(([relative7, resume6, stopFloor, rewardRisk]) => ({
  relative7, resume6, stopFloor, stopAtr: 4, rewardRisk, maxHoldHours: 48 })));
add("BALANCED_ROTATION", "FAILED_BREAKOUT", product([1.1, 1.4], [0, 0.003], [0.02, 0.04], [1.5, 2.2]).map(([volume, sweep, stopFloor, rewardRisk]) => ({
  volume, sweep, stopFloor, stopAtr: 4, rewardRisk, maxHoldHours: 48 })));
add("BALANCED_ROTATION", "RELATIVE_MOMENTUM", product([0.03, 0.05], [0, 0.005], [0.04, 0.06], [0.6, 0.8]).map(([relative7, confirm24, stopFloor, trailScale]) => ({
  relative7, confirm24, stopFloor, stopAtr: 6, exitModel: "TRAIL", trailScale, maxHoldHours: 168 })));
add("BALANCED_ROTATION", "SHORT_HORIZON_REVERSAL", product([0.03, 0.05], [0.003, 0.008], [0.03, 0.05], [1.5, 2.2]).map(([relative24, reversal6, stopFloor, rewardRisk]) => ({
  relative24, reversal6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 72 })));
add("BALANCED_ROTATION", "RELATIVE_PULLBACK_RESUME", product([0.04, 0.07], [0.01, 0.03], [0.002, 0.006], [0.03, 0.05], [1.5, 2.2]).map(([relative7, pullbackMax, resume6, stopFloor, rewardRisk]) => ({
  relative7, pullbackMin: 0.003, pullbackMax, resume6, stopFloor, stopAtr: 5, rewardRisk, maxHoldHours: 96 })));

for (const config of configs.filter((row) => row.system === "BULL_TREND" || row.system === "BEAR_TREND")) {
  const prefix = config.system === "BULL_TREND" ? "BULL" : "BEAR";
  configs.push({ ...config, id: `directional_trend-${prefix.toLowerCase()}-${config.id.split("-").slice(1).join("-")}`,
    system: "DIRECTIONAL_TREND", tactic: `${prefix}_${config.tactic}` });
}

function signal(config, f) {
  if (f.system !== config.system) return null;
  if (config.tactic.startsWith("BULL_") || config.tactic.startsWith("BEAR_")) {
    const bull = config.tactic.startsWith("BULL_");
    if ((bull && f.context.median30 <= 0) || (!bull && f.context.median30 >= 0)) return null;
    return signal({ ...config, tactic: config.tactic.slice(5) }, f);
  }
  if (config.tactic === "TREND_FOLLOW") {
    const direction = sign(f.context.median30);
    if (!direction || sign(f.context.median7) !== direction || direction * f.relative7 < config.relative7
      || direction * f.r24 < config.confirm24) return null;
    return { direction, strength: direction * f.relative7 + direction * f.r24 };
  }
  if (config.tactic === "TREND_PULLBACK") {
    const direction = sign(f.context.median30); const pullback = direction * f.r24;
    if (!direction || direction * f.relative7 < config.relative7 || pullback > -config.pullbackMin
      || pullback < -config.pullbackMax || direction * f.r6 < config.resume6) return null;
    return { direction, strength: direction * f.relative7 + Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "TREND_BREAKOUT") {
    const direction = sign(f.context.median30); const boundary = direction > 0 ? f.high7d : f.low7d;
    if (!direction || direction * f.r30d < config.symbol30 || direction * (f.current.close / boundary - 1) <= 0) return null;
    return { direction, strength: direction * f.r30d };
  }
  if (config.tactic === "LEADER_TRAIL") {
    if (f.relative7 < config.relative7 || f.r24 < config.confirm24) return null;
    return { direction: 1, strength: f.relative7 + f.r24 };
  }
  if (config.tactic === "PULLBACK_RESUME") {
    if (f.relative7 < config.relative7 || f.r24 > -config.pullbackMin || f.r24 < -config.pullbackMax || f.r6 < config.resume6) return null;
    return { direction: 1, strength: f.relative7 + Math.abs(f.r24) + f.r6 };
  }
  if (config.tactic === "BREAKOUT_TRAIL") {
    if (f.r30d < config.symbol30 || f.context.breadth30 < config.breadth || f.current.close <= f.high7d) return null;
    return { direction: 1, strength: f.r30d + f.context.breadth30 * 0.02 };
  }
  if (config.tactic === "LAGGARD_TRAIL") {
    if (f.relative7 > -config.relative7 || f.r24 > -config.confirm24) return null;
    return { direction: -1, strength: -f.relative7 - f.r24 };
  }
  if (config.tactic === "BOUNCE_FADE") {
    if (f.relative7 > -config.relative7 || f.r24 < config.pullbackMin || f.r24 > config.pullbackMax || f.r6 > -config.resume6) return null;
    return { direction: -1, strength: -f.relative7 + Math.abs(f.r24) - f.r6 };
  }
  if (config.tactic === "BREAKDOWN_TRAIL") {
    if (f.r30d > -config.symbol30 || f.context.breadth30 > config.breadth || f.current.close >= f.low7d) return null;
    return { direction: -1, strength: -f.r30d + (1 - f.context.breadth30) * 0.02 };
  }
  if (config.tactic === "SHOCK_REVERSAL") {
    const original = sign(f.context.median24); const direction = -original;
    if (!original || sign(f.r24) !== original || Math.abs(f.r24) < config.symbol24 || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "SHOCK_CONTINUATION" || config.tactic === "BREADTH_CONTINUATION"
    || config.tactic === "REFINED_BREADTH_CONTINUATION") {
    const direction = sign(f.context.median24); const boundary = direction > 0 ? f.high24 : f.low24;
    if (!direction || sign(f.r24) !== direction || Math.abs(f.r24) < config.symbol24
      || direction * f.r6 < config.impulse6 || direction * (f.current.close / boundary - 1) < 0) return null;
    return { direction, strength: Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "RELATIVE_SURVIVOR") {
    const marketDirection = sign(f.context.median24); const direction = -marketDirection;
    if (!marketDirection || direction * f.relative24 < config.relative24 || direction * f.r6 < config.resume6) return null;
    return { direction, strength: direction * f.relative24 + direction * f.r6 };
  }
  if (config.tactic === "ALIGNED_DOWNSHOCK_REVERSAL") {
    if (f.context.median24 >= 0 || f.context.median30 >= 0 || f.r24 > -config.symbol24 || f.r6 < config.rebound6) return null;
    return { direction: 1, strength: -f.r24 + f.r6 };
  }
  if (config.tactic === "COUNTER_DOWNSHOCK_SURVIVOR") {
    if (f.context.median24 >= 0 || f.context.median30 <= 0 || f.relative24 < config.relative24 || f.r6 < config.rebound6) return null;
    return { direction: 1, strength: f.relative24 + f.r6 };
  }
  if (config.tactic === "RELEASE_BREAKOUT") {
    if (f.volumeBurst < config.volume) return null;
    const up = f.current.close > f.high24; const down = f.current.close < f.low24;
    if (up === down) return null;
    const direction = up ? 1 : -1; const breadth = direction > 0 ? f.context.breadth24 : 1 - f.context.breadth24;
    if (breadth < config.breadth) return null;
    return { direction, strength: f.volumeBurst + breadth };
  }
  if (config.tactic === "RELATIVE_RELEASE") {
    const direction = sign(f.relative7);
    if (!direction || Math.abs(f.relative7) < config.relative7 || f.volumeBurst < config.volume
      || direction * f.r6 <= 0) return null;
    return { direction, strength: Math.abs(f.relative7) + f.volumeBurst * 0.02 };
  }
  if (config.tactic === "FALSE_RELEASE" || config.tactic === "FAILED_BREAKOUT") {
    if (f.volumeBurst < config.volume) return null;
    const highFail = f.current.high > f.high24 * (1 + (config.sweep ?? 0)) && f.current.close < f.high24 * (1 - (config.reclaim ?? 0));
    const lowFail = f.current.low < f.low24 * (1 - (config.sweep ?? 0)) && f.current.close > f.low24 * (1 + (config.reclaim ?? 0));
    if (highFail === lowFail) return null;
    return { direction: highFail ? -1 : 1, strength: f.volumeBurst + Math.abs(f.r1) };
  }
  if (config.tactic === "QUIET_PULLBACK_RESUME" || config.tactic === "RELATIVE_PULLBACK_RESUME") {
    const direction = sign(f.relative7); const pullback = direction * f.r24;
    if (!direction || Math.abs(f.relative7) < config.relative7 || pullback > -config.pullbackMin
      || pullback < -config.pullbackMax || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(f.relative7) + Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "EXPANSION_DEFENDER") {
    const marketDirection = sign(f.context.median24); const direction = -marketDirection;
    if (!marketDirection || direction * f.relative24 < config.relative24 || direction * f.r6 < config.resume6) return null;
    return { direction, strength: direction * f.relative24 + direction * f.r6 };
  }
  if (config.tactic === "EXPANSION_PULLBACK") {
    const direction = sign(f.context.median24); const pullback = direction * f.r6;
    if (!direction || sign(f.r24) !== direction || Math.abs(f.r24) < config.symbol24
      || pullback > -config.pullbackMin || pullback < -config.pullbackMax || direction * f.r1 < config.resume6) return null;
    return { direction, strength: Math.abs(f.r24) + Math.abs(f.r6) + direction * f.r1 };
  }
  if (config.tactic === "EXPANSION_EXHAUSTION") {
    const original = sign(f.r24); const direction = -original;
    if (!original || Math.abs(f.r24) < config.symbol24 || direction * f.r6 < config.reversal6) return null;
    return { direction, strength: Math.abs(f.r24) + direction * f.r6 };
  }
  if (config.tactic === "RANGE_EDGE") {
    const width = Math.max(f.high7d - f.low7d, f.current.close * 1e-9);
    const location = (f.current.close - f.low7d) / width;
    const direction = location <= config.edge ? 1 : location >= 1 - config.edge ? -1 : 0;
    if (!direction || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(location - 0.5) + direction * f.r6 };
  }
  if (config.tactic === "RELATIVE_REVERSION") {
    const original = sign(f.relative7); const direction = -original;
    if (!original || Math.abs(f.relative7) < config.relative7 || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(f.relative7) + direction * f.r6 };
  }
  if (config.tactic === "RELATIVE_MOMENTUM") {
    const direction = sign(f.relative7);
    if (!direction || Math.abs(f.relative7) < config.relative7 || direction * f.relative24 < config.confirm24) return null;
    return { direction, strength: Math.abs(f.relative7) + direction * f.relative24 };
  }
  if (config.tactic === "DEFENSIVE_RELATIVE") {
    const marketDirection = config.system === "DIRECTIONAL_TREND" ? sign(f.context.median30)
      : config.system === "BULL_TREND" ? 1 : -1;
    const direction = -marketDirection;
    if (direction * f.relative7 < config.relative7 || direction * f.r6 < config.confirm6) return null;
    return { direction, strength: direction * f.relative7 + direction * f.r6 };
  }
  if (config.tactic === "SHORT_HORIZON_REVERSAL") {
    const original = sign(f.relative24); const direction = -original;
    if (!original || Math.abs(f.relative24) < config.relative24 || direction * f.r6 < config.reversal6) return null;
    return { direction, strength: Math.abs(f.relative24) + direction * f.r6 };
  }
  if (config.tactic === "MARKET_REBOUND") {
    if (f.r24 > -config.drop24 || f.r6 < config.rebound6) return null;
    return { direction: 1, strength: -f.r24 + f.r6 };
  }
  return null;
}

function lowerBound(rows, time) {
  let low = 0; let high = rows.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (rows[middle].time < time) low = middle + 1; else high = middle; }
  return low;
}

function resolve(config, f, found, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const rows = executionBySymbol.get(f.symbol); const entryTime = f.rows[f.index + 1].time;
  const index = lowerBound(rows, entryTime); if (rows[index]?.time !== entryTime) return null;
  const direction = found.direction; const entry = rows[index].open * (1 + direction * slippage);
  const stopRate = Math.min(config.stopCap, Math.max(config.stopFloor, config.stopAtr * f.atr6));
  const trail = config.exitModel === "TRAIL"; const targetRate = trail ? null : Math.max(stopRate * config.rewardRisk, friction * 2.2);
  const originalStop = entry * (1 - direction * stopRate); const target = trail ? null : entry * (1 + direction * targetRate);
  const maxBars = config.maxHoldHours * 12; let activeStop = originalStop; let extreme = entry;
  let exit = entry; let closedAt = rows[index].time * 1_000; let outcome = "DATA_GAP";
  for (let offset = 0; offset < maxBars && index + offset < rows.length; offset += 1) {
    const candle = rows[index + offset];
    if (offset && candle.time !== rows[index + offset - 1].time + 300) {
      exit = rows[index + offset - 1].close; closedAt = rows[index + offset - 1].time * 1_000; break;
    }
    const stopped = direction > 0 ? candle.low <= activeStop : candle.high >= activeStop;
    const targeted = !trail && (direction > 0 ? candle.high >= target : candle.low <= target);
    if (stopped || targeted) {
      exit = stopped ? activeStop : target; closedAt = candle.time * 1_000;
      outcome = stopped ? (activeStop === originalStop ? "STOP" : "TRAIL") : "TARGET"; break;
    }
    if (trail) {
      extreme = direction > 0 ? Math.max(extreme, candle.high) : Math.min(extreme, candle.low);
      const candidate = extreme * (1 - direction * stopRate * config.trailScale);
      activeStop = direction > 0 ? Math.max(activeStop, candidate) : Math.min(activeStop, candidate);
    }
    exit = candle.close; closedAt = candle.time * 1_000; outcome = offset === maxBars - 1 ? "TIMEOUT" : outcome;
  }
  const grossReturnRate = direction * (exit - entry) / entry;
  return { strategyId: config.id, tactic: config.tactic, system: config.system, symbol: f.symbol,
    side: direction > 0 ? "LONG" : "SHORT", openedAt: rows[index].time * 1_000, closedAt,
    entry, stop: originalStop, target, stopRate, targetRate, strength: found.strength,
    friction, outcome, grossReturnRate, netReturnRate: grossReturnRate - friction };
}

const tradeCache = new Map();
function rawTrades(config, end, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const key = `${config.id}:${end}:${friction}:${slippage}`;
  if (tradeCache.has(key)) return tradeCache.get(key);
  const trades = [];
  for (const f of observations) {
    if (f.time * 1_000 >= end || f.system !== config.system) continue;
    const found = signal(config, f); if (!found) continue;
    const trade = resolve(config, f, found, friction, slippage); if (trade) trades.push(trade);
  }
  trades.sort((left, right) => left.openedAt - right.openedAt || right.strength - left.strength);
  tradeCache.set(key, trades); return trades;
}

function portfolio(trades, configById) {
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  const open = []; const accepted = []; const cooldown = new Map();
  const settle = (time) => {
    for (const trade of open.filter((row) => row.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
      open.splice(open.indexOf(trade), 1);
      cooldown.set(`${trade.strategyId}:${trade.symbol}`, trade.closedAt + configById.get(trade.strategyId).cooldownHours * 3_600_000);
    }
  };
  for (let index = 0; index < trades.length;) {
    const openedAt = trades[index].openedAt; settle(openedAt);
    const simultaneous = [];
    while (index < trades.length && trades[index].openedAt === openedAt) simultaneous.push(trades[index++]);
    const candidates = simultaneous.sort((left, right) => right.strength - left.strength
      || left.strategyId.localeCompare(right.strategyId));
    for (const trade of candidates) {
      const config = configById.get(trade.strategyId);
      if (equity <= 100 || open.some((row) => row.symbol === trade.symbol)
        || (cooldown.get(`${trade.strategyId}:${trade.symbol}`) ?? 0) > trade.openedAt) continue;
      const sameSide = open.filter((row) => row.side === trade.side);
      const multiple = Math.min(config.notionalMultiple, config.riskRate / Math.max(trade.stopRate + trade.friction, 1e-9));
      if (multiple < config.minNotionalMultiple) continue;
      const notional = equity * multiple; const plannedRisk = notional * (trade.stopRate + trade.friction);
      if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10
        || sum(sameSide.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.065) continue;
      const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
      open.push(acceptedTrade); accepted.push(acceptedTrade);
    }
  }
  settle(Infinity); return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(result, start, end) {
  const rows = result.trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end);
  const gains = rows.filter((row) => row.netPnl > 0); const losses = rows.filter((row) => row.netPnl <= 0);
  const monthly = signalRaw.months.flatMap((month) => {
    const startAt = monthStart(month); const endAt = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
    if (startAt < start || endAt > end) return [];
    const trades = rows.filter((trade) => trade.openedAt >= startAt && trade.openedAt < endAt);
    return [{ month, trades: trades.length, pnl: sum(trades.map((trade) => trade.netPnl)) }];
  });
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  for (const trade of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const bySymbol = Object.fromEntries([...new Set(rows.map((row) => row.symbol))].map((symbol) => [symbol,
    sum(rows.filter((row) => row.symbol === symbol).map((row) => row.netPnl))]));
  const positiveSymbols = Object.values(bySymbol).filter((value) => value > 0); const positiveTotal = sum(positiveSymbols);
  return { trades: rows.length, netPnl: sum(rows.map((row) => row.netPnl)),
    profitFactor: losses.length ? sum(gains.map((row) => row.netPnl)) / Math.abs(sum(losses.map((row) => row.netPnl)) ) : gains.length ? 99 : 0,
    maxDrawdown, activeMonths: monthly.filter((row) => row.trades).length,
    positiveMonths: monthly.filter((row) => row.pnl > 0).length, monthly,
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positiveSymbols) / positiveTotal : 1, bySymbol };
}

const minimumTacticTrades = (system) => ["SHOCK_TRANSITION", "COMPRESSION"].includes(system) ? 12 : system.includes("TREND") ? 18 : 24;
const qualifiesTactic = (value, system) => value.trades >= minimumTacticTrades(system) && value.netPnl > 0
  && value.profitFactor >= 1.10 && value.maxDrawdown <= 0.20
  && value.positiveMonths >= Math.ceil(value.activeMonths * 0.40) && value.largestPositiveSymbolShare <= 0.50;
const tacticRank = (value) => value.netPnl + value.positiveMonths * 10 + value.profitFactor * 20 - value.maxDrawdown * 1_000;
const qualifiesSystemDiscovery = (value, system) => value.trades >= (["SHOCK_TRANSITION", "COMPRESSION"].includes(system) ? 20 : 30)
  && value.netPnl > 0 && value.profitFactor >= 1.10 && value.maxDrawdown <= 0.20
  && value.positiveMonths >= Math.ceil(value.activeMonths * 0.50)
  && value.largestPositiveSymbolShare <= 0.45;
const activeConfigs = configs.filter((config) => SYSTEMS.includes(config.system));
const configById = new Map(activeConfigs.map((config) => [config.id, config]));
const discoveryFoldMetrics = (account) => [[0, 10], [10, 20], [20, 30]].map(([startIndex, endIndex]) => metrics(account,
  monthStart(signalRaw.months[startIndex]), monthStart(signalRaw.months[endIndex])));
const compactMetrics = (value) => ({ trades: value.trades, netPnl: value.netPnl,
  profitFactor: value.profitFactor, maxDrawdown: value.maxDrawdown,
  activeMonths: value.activeMonths, positiveMonths: value.positiveMonths,
  largestPositiveSymbolShare: value.largestPositiveSymbolShare });

const selectedBySystem = new Map(); const discoveryAudit = {};
for (const system of SYSTEMS) {
  const tacticRows = []; const stableConfigs = []; const stableWinnerConfigs = []; const tacticRepresentativeConfigs = [];
  const costWinnerRows = [];
  for (const tactic of [...new Set(activeConfigs.filter((row) => row.system === system).map((row) => row.tactic))]) {
    const rows = activeConfigs.filter((row) => row.system === system && row.tactic === tactic).map((config) => {
      const account = portfolio(rawTrades(config, discoveryEnd), configById);
      const stressAccount = portfolio(rawTrades(config, discoveryEnd, STRESS_FRICTION), configById);
      return { config, measured: metrics(account, fromMs, discoveryEnd), folds: discoveryFoldMetrics(account),
        stressMeasured: metrics(stressAccount, fromMs, discoveryEnd), stressFolds: discoveryFoldMetrics(stressAccount) };
    });
    rows.sort((a, b) => tacticRank(b.measured) - tacticRank(a.measured));
    const stableRows = rows.filter((row) => qualifiesTactic(row.measured, system)
      && row.folds.filter((fold) => fold.netPnl > 0).length >= 2 && row.folds.at(-1).netPnl > 0)
      .sort((left, right) => Math.min(...right.folds.map((fold) => fold.netPnl)) - Math.min(...left.folds.map((fold) => fold.netPnl))
        || tacticRank(right.measured) - tacticRank(left.measured));
    stableConfigs.push(...stableRows.map((row) => row.config));
    if (stableRows[0]) stableWinnerConfigs.push(stableRows[0].config);
    const representative = [...rows].filter((row) => row.measured.trades >= minimumTacticTrades(system))
      .sort((left, right) => right.folds.filter((fold) => fold.netPnl > 0).length - left.folds.filter((fold) => fold.netPnl > 0).length
        || right.folds.at(-1).netPnl - left.folds.at(-1).netPnl
        || Math.min(...right.folds.map((fold) => fold.netPnl)) - Math.min(...left.folds.map((fold) => fold.netPnl))
        || tacticRank(right.measured) - tacticRank(left.measured))[0];
    if (representative) tacticRepresentativeConfigs.push(representative.config);
    const costWinner = [...rows].filter((row) => qualifiesTactic(row.measured, system)
      && row.stressMeasured.netPnl > 0 && row.stressMeasured.profitFactor >= 1.05
      && row.stressMeasured.positiveMonths >= Math.ceil(row.stressMeasured.activeMonths * 0.40))
      .sort((left, right) => tacticRank(right.stressMeasured) - tacticRank(left.stressMeasured)
        || tacticRank(right.measured) - tacticRank(left.measured))[0];
    if (costWinner) costWinnerRows.push({ config: costWinner.config,
      score: Math.min(tacticRank(costWinner.measured), tacticRank(costWinner.stressMeasured)) });
    tacticRows.push({ tactic, candidates: rows.length, qualified: rows.filter((row) => qualifiesTactic(row.measured, system)).length,
      stable: rows.filter((row) => stableConfigs.includes(row.config)).length,
      selected: rows.find((row) => qualifiesTactic(row.measured, system)) ?? null,
      leaderboard: rows.slice(0, 3).map((row) => ({ id: row.config.id, ...compactMetrics(row.measured) })) });
  }
  const tacticWinners = tacticRows.flatMap((row) => row.selected ? [row.selected.config] : []);
  const combinations = [];
  for (let mask = 1; mask < 2 ** tacticWinners.length; mask += 1) {
    const chosen = tacticWinners.filter((_, index) => mask & (1 << index)); if (chosen.length < 2) continue;
    const trades = chosen.flatMap((config) => rawTrades(config, discoveryEnd));
    const measured = metrics(portfolio(trades.sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
    const qualified = qualifiesSystemDiscovery(measured, system);
    combinations.push({ configs: chosen, measured, qualified });
  }
  combinations.sort((a, b) => tacticRank(b.measured) - tacticRank(a.measured));
  const staticSelection = combinations.find((row) => row.qualified) ?? null;
  const adaptiveConfigs = activeConfigs.filter((config) => config.system === system);
  const adaptiveMeasured = metrics(portfolio(adaptiveConfigs.flatMap((config) => rawTrades(config, discoveryEnd))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
  const stableMeasured = metrics(portfolio(stableConfigs.flatMap((config) => rawTrades(config, discoveryEnd))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
  const stableTactics = new Set(stableConfigs.map((config) => config.tactic));
  const stableWinnersMeasured = metrics(portfolio(stableWinnerConfigs.flatMap((config) => rawTrades(config, discoveryEnd))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
  const representativesMeasured = metrics(portfolio(tacticRepresentativeConfigs.flatMap((config) => rawTrades(config, discoveryEnd))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
  const segmentedShockConfigs = stableWinnerConfigs.filter((config) =>
    ["ALIGNED_DOWNSHOCK_REVERSAL", "COUNTER_DOWNSHOCK_SURVIVOR"].includes(config.tactic));
  const segmentedShockMeasured = metrics(portfolio(segmentedShockConfigs.flatMap((config) => rawTrades(config, discoveryEnd))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
  const costWinnerConfigs = costWinnerRows.sort((left, right) => right.score - left.score).slice(0, 8).map((row) => row.config);
  const costCombinations = [];
  for (let mask = 1; mask < 2 ** costWinnerConfigs.length; mask += 1) {
    const chosen = costWinnerConfigs.filter((_, index) => mask & (1 << index));
    if (chosen.length < 2 || chosen.length > 4) continue;
    const baseMeasured = metrics(portfolio(chosen.flatMap((config) => rawTrades(config, discoveryEnd))
      .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
    const stressMeasured = metrics(portfolio(chosen.flatMap((config) => rawTrades(config, discoveryEnd, STRESS_FRICTION))
      .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById), fromMs, discoveryEnd);
    const qualified = qualifiesSystemDiscovery(baseMeasured, system) && qualifiesSystemDiscovery(stressMeasured, system);
    costCombinations.push({ configs: chosen, baseMeasured, stressMeasured, qualified,
      score: Math.min(tacticRank(baseMeasured), tacticRank(stressMeasured)) });
  }
  costCombinations.sort((left, right) => right.score - left.score);
  const costSelection = costCombinations.find((row) => row.qualified) ?? null;
  const modes = [
    ...(system === "SHOCK_TRANSITION" && segmentedShockConfigs.length === 2
      && qualifiesSystemDiscovery(segmentedShockMeasured, system)
      ? [{ mode: "STRUCTURAL_SHOCK_SEGMENTS", configs: segmentedShockConfigs,
        measured: segmentedShockMeasured, qualified: true }] : []),
    ...(staticSelection ? [{ mode: "DISCOVERY_STATIC", configs: staticSelection.configs,
      measured: staticSelection.measured, qualified: staticSelection.qualified }] : []),
    { mode: "ADAPTIVE_LIBRARY", configs: adaptiveConfigs, measured: adaptiveMeasured,
      qualified: qualifiesSystemDiscovery(adaptiveMeasured, system) },
    { mode: "DISCOVERY_STABLE_LIBRARY", configs: stableConfigs, measured: stableMeasured,
      qualified: stableTactics.size >= 2 && qualifiesSystemDiscovery(stableMeasured, system) },
    { mode: "ROLLING_STABLE_TACTICS", configs: stableWinnerConfigs, measured: stableWinnersMeasured,
      qualified: stableWinnerConfigs.length >= 2 && qualifiesSystemDiscovery(stableWinnersMeasured, system) },
    { mode: "TACTIC_REPRESENTATIVES", configs: tacticRepresentativeConfigs, measured: representativesMeasured,
      qualified: tacticRepresentativeConfigs.length >= 2 && qualifiesSystemDiscovery(representativesMeasured, system) },
    ...(costSelection ? [{ mode: "COST_ROBUST_TACTICS", configs: costSelection.configs,
      measured: costSelection.baseMeasured, qualified: true }] : []),
  ].filter((row) => row.qualified).sort((left, right) => {
    const preferRolling = system === "COMPRESSION";
    const priority = { STRUCTURAL_SHOCK_SEGMENTS: 6, COST_ROBUST_TACTICS: preferRolling ? 3 : 5, TACTIC_REPRESENTATIVES: 2,
      ROLLING_STABLE_TACTICS: preferRolling ? 5 : 3, DISCOVERY_STABLE_LIBRARY: 1,
      DISCOVERY_STATIC: 0, ADAPTIVE_LIBRARY: -1 };
    return priority[right.mode] - priority[left.mode] || tacticRank(right.measured) - tacticRank(left.measured);
  });
  const selected = modes[0] ?? null;
  if (selected) selectedBySystem.set(system, selected);
  discoveryAudit[system] = { tactics: tacticRows.map(({ selected: tacticSelected, ...row }) => ({ ...row,
    selected: tacticSelected ? { id: tacticSelected.config.id, base: compactMetrics(tacticSelected.measured),
      higherCost: compactMetrics(tacticSelected.stressMeasured) } : null })), combinations: combinations.slice(0, 20).map((row) => ({
    strategyIds: row.configs.map((config) => config.id), qualified: row.qualified, measured: compactMetrics(row.measured) })),
    adaptiveLibrary: { qualified: qualifiesSystemDiscovery(adaptiveMeasured, system), measured: compactMetrics(adaptiveMeasured) },
    stableLibrary: { strategies: stableConfigs.map((config) => config.id), tactics: [...stableTactics],
      qualified: stableTactics.size >= 2 && qualifiesSystemDiscovery(stableMeasured, system), measured: compactMetrics(stableMeasured) },
    rollingStableTactics: { strategies: stableWinnerConfigs.map((config) => config.id),
      qualified: stableWinnerConfigs.length >= 2 && qualifiesSystemDiscovery(stableWinnersMeasured, system),
      measured: compactMetrics(stableWinnersMeasured) },
    tacticRepresentatives: { strategies: tacticRepresentativeConfigs.map((config) => config.id),
      qualified: tacticRepresentativeConfigs.length >= 2 && qualifiesSystemDiscovery(representativesMeasured, system),
      measured: compactMetrics(representativesMeasured) },
    structuralShockSegments: { strategies: segmentedShockConfigs.map((config) => config.id),
      qualified: system === "SHOCK_TRANSITION" && segmentedShockConfigs.length === 2
        && qualifiesSystemDiscovery(segmentedShockMeasured, system),
      measured: compactMetrics(segmentedShockMeasured) },
    costRobustTactics: { candidateStrategies: costWinnerConfigs.map((config) => config.id),
      selectedStrategies: costSelection?.configs.map((config) => config.id) ?? [], qualified: Boolean(costSelection),
      base: costSelection ? compactMetrics(costSelection.baseMeasured) : null,
      higherCost: costSelection ? compactMetrics(costSelection.stressMeasured) : null },
    selectionMode: selected?.mode ?? null,
    selectedStrategyIds: selected?.configs.map((config) => config.id) ?? [] };
}

const auditConfigIds = new Set([
  ...[...selectedBySystem.values()].flatMap((selection) => selection.configs.map((config) => config.id)),
  ...Object.values(discoveryAudit).flatMap((row) => row.costRobustTactics.candidateStrategies),
  ...Object.values(discoveryAudit).flatMap((row) => row.tactics.flatMap((tactic) => tactic.leaderboard.map((config) => config.id))),
]);
const crossPeriodAudit = activeConfigs.filter((config) => auditConfigIds.has(config.id)).map((config) => {
  const account = portfolio(rawTrades(config, toMs), configById);
  const stressAccount = portfolio(rawTrades(config, toMs, STRESS_FRICTION), configById);
  const discovery = metrics(account, fromMs, discoveryEnd);
  const validation = metrics(account, discoveryEnd, validationEnd);
  const recent = metrics(account, validationEnd, toMs);
  const discoveryFolds = discoveryFoldMetrics(account).map(compactMetrics);
  const stressDiscovery = metrics(stressAccount, fromMs, discoveryEnd);
  const stressDiscoveryFolds = discoveryFoldMetrics(stressAccount).map(compactMetrics);
  return { id: config.id, system: config.system, tactic: config.tactic,
    discovery: compactMetrics(discovery), validation: compactMetrics(validation), recent: compactMetrics(recent),
    discoveryFolds, stressDiscovery: compactMetrics(stressDiscovery), stressDiscoveryFolds,
    stressValidation: compactMetrics(metrics(stressAccount, discoveryEnd, validationEnd)),
    stressRecent: compactMetrics(metrics(stressAccount, validationEnd, toMs)),
    allPeriodsPositive: discovery.netPnl > 0 && validation.netPnl > 0 && recent.netPnl > 0 };
});

function evaluateSystem(system, selection) {
  const selected = selection?.configs;
  if (!selected?.length) return { system, accepted: false, reason: "NO_TWO_STRATEGY_DISCOVERY_PORTFOLIO", selectedStrategies: [] };
  const build = (friction, slippage) => portfolio(selected.flatMap((config) => rawTrades(config, toMs, friction, slippage))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById);
  const base = build(FRICTION, ENTRY_SLIPPAGE); const stress = build(STRESS_FRICTION, ENTRY_SLIPPAGE);
  const adverse = build(FRICTION, ENTRY_SLIPPAGE * 2);
  const period = (result, start, end) => metrics(result, start, end);
  const result = { system, selectionMode: selection.mode, selectedStrategies: selected, account: base,
    stressAccount: stress, adverseAccount: adverse,
    discovery: period(base, fromMs, discoveryEnd), validation: period(base, discoveryEnd, validationEnd),
    evaluation: period(base, validationEnd, toMs), full: period(base, fromMs, toMs),
    higherCost: { full: period(stress, fromMs, toMs), discovery: period(stress, fromMs, discoveryEnd),
      validation: period(stress, discoveryEnd, validationEnd), evaluation: period(stress, validationEnd, toMs) },
    doubledAdverseEntry: { full: period(adverse, fromMs, toMs), discovery: period(adverse, fromMs, discoveryEnd),
      validation: period(adverse, discoveryEnd, validationEnd), evaluation: period(adverse, validationEnd, toMs) } };
  const rare = ["SHOCK_TRANSITION", "COMPRESSION"].includes(system); const minValidation = rare ? 4 : 8;
  const positive = (value, pf = 1.03) => value.trades >= minValidation && value.netPnl > 0 && value.profitFactor >= pf;
  result.gates = { strategyCount: new Set(selected.map((config) => config.tactic)).size >= 2,
    discovery: result.discovery.netPnl > 0 && result.discovery.profitFactor >= 1.10,
    validation: positive(result.validation), evaluation: positive(result.evaluation),
    monthlyStability: result.full.positiveMonths >= Math.ceil(result.full.activeMonths * 0.55),
    drawdown: result.full.maxDrawdown <= 0.20, concentration: result.full.largestPositiveSymbolShare <= 0.45,
    higherCost: positive(result.higherCost.validation, 1.0) && positive(result.higherCost.evaluation, 1.0),
    doubledAdverseEntry: positive(result.doubledAdverseEntry.validation, 1.0) && positive(result.doubledAdverseEntry.evaluation, 1.0) };
  result.accepted = Object.values(result.gates).every(Boolean); return result;
}

const systems = SYSTEMS.map((system) => evaluateSystem(system, selectedBySystem.get(system)));
const acceptedSystems = systems.filter((system) => system.accepted);
const candidateSystems = systems.filter((system) => system.account);
function combinedResult(rows, accountKey, metricsKey) {
  const trades = rows.flatMap((system) => system[accountKey].trades).sort((left, right) => left.closedAt - right.closedAt);
  let equity = rows.length * 1_000; let peak = equity; let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
  }
  const monthly = signalRaw.months.map((month) => {
    const bySystem = Object.fromEntries(rows.map((system) => [system.system,
      (metricsKey === "full" ? system.full : system[metricsKey].full).monthly.find((row) => row.month === month)?.pnl ?? 0]));
    return { month, bySystem, pnl: sum(Object.values(bySystem)) };
  });
  const period = (key) => ({ netPnl: sum(rows.map((system) => (metricsKey === "full" ? system[key] : system[metricsKey][key]).netPnl)),
    trades: sum(rows.map((system) => (metricsKey === "full" ? system[key] : system[metricsKey][key]).trades)) });
  return { systems: rows.map((system) => system.system), startEquityU: rows.length * 1_000,
    endEquityU: equity, netPnlU: equity - rows.length * 1_000, maxDrawdown,
    positiveMonths: monthly.filter((row) => row.pnl > 0).length,
    activeMonths: monthly.filter((row) => row.pnl !== 0).length,
    discovery: period("discovery"), validation: period("validation"), evaluation: period("evaluation"), monthly };
}
const candidateCombined = {
  base: combinedResult(candidateSystems, "account", "full"),
  higherCost: combinedResult(candidateSystems, "stressAccount", "higherCost"),
  doubledAdverseEntry: combinedResult(candidateSystems, "adverseAccount", "doubledAdverseEntry"),
};
function tradeBreakdown(accountKey, start, end, keyOf) {
  const groups = new Map();
  for (const system of candidateSystems) for (const trade of system[accountKey].trades) {
    if (trade.openedAt < start || trade.openedAt >= end) continue;
    const key = keyOf(system, trade); const rows = groups.get(key) ?? []; rows.push(trade); groups.set(key, rows);
  }
  return [...groups].map(([key, rows]) => {
    const gains = rows.filter((row) => row.netPnl > 0); const losses = rows.filter((row) => row.netPnl <= 0);
    return { key, trades: rows.length, netPnl: sum(rows.map((row) => row.netPnl)),
      profitFactor: losses.length ? sum(gains.map((row) => row.netPnl)) / Math.abs(sum(losses.map((row) => row.netPnl))) : gains.length ? 99 : 0 };
  }).sort((left, right) => left.netPnl - right.netPnl);
}
const candidateDiagnostics = Object.fromEntries([["base", "account"], ["higherCost", "stressAccount"]].map(([label, accountKey]) => [label, {
  validationByTactic: tradeBreakdown(accountKey, discoveryEnd, validationEnd, (system, trade) => `${system.system}/${trade.tactic}`),
  recentByTactic: tradeBreakdown(accountKey, validationEnd, toMs, (system, trade) => `${system.system}/${trade.tactic}`),
  recentByHour: tradeBreakdown(accountKey, validationEnd, toMs, (_system, trade) => String(new Date(trade.openedAt).getUTCHours()).padStart(2, "0")),
  recentBySide: tradeBreakdown(accountKey, validationEnd, toMs, (_system, trade) => trade.side),
}]));
const positiveCombined = (row) => row.discovery.netPnl > 0 && row.validation.netPnl > 0 && row.evaluation.netPnl > 0;
const stableCombinedMonths = (row) => row.positiveMonths >= Math.ceil(row.activeMonths * 0.60);
const candidatePortfolioGates = {
  everySystemAccepted: systems.every((system) => system.accepted),
  exhaustiveOwnership: candidateSystems.length === SYSTEMS.length,
  multiStrategySystems: candidateSystems.every((system) => new Set(system.selectedStrategies.map((config) => config.tactic)).size >= 2),
  longTermSystemExpectancy: candidateSystems.every((system) => system.full.netPnl > 0 && system.full.profitFactor >= 1.05
    && system.higherCost.full.netPnl > 0 && system.higherCost.full.profitFactor >= 1.0),
  systemRiskAndConcentration: candidateSystems.every((system) => system.full.maxDrawdown <= 0.20
    && system.full.largestPositiveSymbolShare <= 0.55),
  chronologicalPortfolio: positiveCombined(candidateCombined.base),
  higherCostPortfolio: positiveCombined(candidateCombined.higherCost),
  adverseEntryPortfolio: positiveCombined(candidateCombined.doubledAdverseEntry),
  monthlyStability: stableCombinedMonths(candidateCombined.base) && stableCombinedMonths(candidateCombined.higherCost),
  combinedDrawdown: candidateCombined.base.maxDrawdown <= 0.20 && candidateCombined.higherCost.maxDrawdown <= 0.20,
};
const serializableSystems = systems.map((system) => {
  const result = { ...system, account: system.account ? { endEquity: system.account.endEquity,
    maxDrawdown: system.account.maxDrawdown, trades: system.account.trades.length } : undefined };
  delete result.stressAccount; delete result.adverseAccount;
  return result;
});
const portfolioMonths = signalRaw.months.map((month) => {
  const bySystem = Object.fromEntries(acceptedSystems.map((system) => [system.system,
    system.full.monthly.find((row) => row.month === month)?.pnl ?? 0]));
  return { month, bySystem, pnl: sum(Object.values(bySystem)) };
});
const combinedTrades = acceptedSystems.flatMap((system) => system.account.trades).sort((a, b) => a.closedAt - b.closedAt);
let combinedEquity = acceptedSystems.length * 1_000; let combinedPeak = combinedEquity; let combinedDrawdown = 0;
for (const trade of combinedTrades) {
  combinedEquity += trade.netPnl; combinedPeak = Math.max(combinedPeak, combinedEquity);
  combinedDrawdown = Math.max(combinedDrawdown, (combinedPeak - combinedEquity) / Math.max(combinedPeak, 1e-9));
}

const report = { generatedAt: new Date().toISOString(),
  decision: Object.values(candidatePortfolioGates).every(Boolean) ? "FORWARD_VALIDATION_CANDIDATE" : "NO_RELEASE",
  releaseEligible: false,
  architecture: { systemDefinition: "one mutually exclusive market domain containing a portfolio of strategies",
    statePriority: SYSTEMS, exhaustive: true,
    strategyExecution: "fixed discovery-selected tactics enter directly when their current-domain signal and account risk pass",
    executionAuthority: "current regime, frozen strategy signal and the owning system account only",
    outcomeBasedPromotion: "forbidden",
    perSystemAccountU: 1_000, canonicalCopy: "100% of every admitted system order" },
  data: { signalSource: signalRaw.source, signalSha256: signalRaw.sha256,
    executionSource: executionRaw.source, executionSha256: executionRaw.sha256,
    months: signalRaw.months, symbols: signalRaw.symbols, executionCandles: sum(executionRaw.datasets.map((row) => row.rows.length)) },
  split: { discovery: signalRaw.months.slice(0, 30), validation: signalRaw.months.slice(30, 38), evaluation: signalRaw.months.slice(38) },
  stateCounts, discoveryAudit, crossPeriodAudit,
  systems: serializableSystems,
  candidatePortfolioGates, candidateCombined, candidateDiagnostics,
  standaloneAcceptedCombined: { acceptedSystems: acceptedSystems.map((system) => system.system), stateCoverage: acceptedSystems.length / SYSTEMS.length,
    startEquityU: acceptedSystems.length * 1_000, endEquityU: combinedEquity,
    netPnlU: combinedEquity - acceptedSystems.length * 1_000, maxDrawdown: combinedDrawdown,
    positiveMonths: portfolioMonths.filter((row) => row.pnl > 0).length,
    activeMonths: portfolioMonths.filter((row) => row.pnl !== 0).length, monthly: portfolioMonths },
  limitations: ["Funding and historical order-book depth are unavailable and represented by friction stress.",
    "The final six months have been inspected by earlier experiments and are evaluation data, not pristine blind data.",
    "A state is structurally owned even when its system correctly returns WAIT; portfolio membership still requires positive long-term expectancy.",
    "FORWARD_VALIDATION_CANDIDATE is not production authorization; only new prospective data may supply the next untouched release gate."],
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, decision: report.decision, stateCounts,
  systems: report.systems.map((system) => ({ system: system.system, accepted: system.accepted,
    reason: system.reason, strategies: system.selectedStrategies?.map((row) => row.id),
    discovery: system.discovery && { trades: system.discovery.trades, pnl: system.discovery.netPnl, pf: system.discovery.profitFactor },
    validation: system.validation && { trades: system.validation.trades, pnl: system.validation.netPnl, pf: system.validation.profitFactor },
    evaluation: system.evaluation && { trades: system.evaluation.trades, pnl: system.evaluation.netPnl, pf: system.evaluation.profitFactor }, gates: system.gates })),
  candidateCombined: Object.fromEntries(Object.entries(report.candidateCombined).map(([key, value]) => [key, {
    netPnlU: value.netPnlU, maxDrawdown: value.maxDrawdown, positiveMonths: value.positiveMonths,
    activeMonths: value.activeMonths, discovery: value.discovery, validation: value.validation, evaluation: value.evaluation,
  }])) }, null, 2));
