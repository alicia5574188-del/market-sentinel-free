import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-12m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/v6-long-horizon.json";
const MODE = process.env.RESEARCH_MODE ?? "broad";
const SELECTION = process.env.RESEARCH_SELECTION ?? "release";
const INCLUDE_TRADES = process.env.RESEARCH_INCLUDE_TRADES === "1";
const SIDE = process.env.RESEARCH_SIDE ?? "BOTH";
if (!["BOTH", "LONG", "SHORT"].includes(SIDE)) {
  throw new Error(`Unsupported RESEARCH_SIDE: ${SIDE}`);
}
const FRICTION = 0.0014;
const ENTRY_SLIPPAGE = 0.00025;
const STRESS_FRICTION = 0.0022;
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET;
const executionRaw = EXECUTION_DATASET ? JSON.parse(readFileSync(EXECUTION_DATASET, "utf8")) : null;
if (!raw.source?.startsWith("gate-official-monthly-futures-usdt-candlesticks-") || raw.months.length < 12) {
  throw new Error("V6 long-horizon research requires at least twelve official Gate monthly archives");
}
const STEP = raw.stepSeconds ?? (raw.interval === "1h" ? 3_600 : 300);
const EXECUTION_STEP = executionRaw?.stepSeconds ?? STEP;
if (executionRaw && (executionRaw.interval !== "5m" || executionRaw.months.join() !== raw.months.join())) {
  throw new Error("Hybrid execution requires a matching Gate 5m dataset");
}
const executionBySymbol = new Map((executionRaw?.datasets ?? []).map((item) => [item.symbol, item.rows]));
const HOUR = 3_600 / STEP;
if (!Number.isInteger(HOUR)) throw new Error(`Unsupported dataset step: ${STEP}`);
// Every family consumes the 30-day cross-market context below. Keeping a
// shorter warm-up for the non-macro families made those modes index rows that
// did not exist and meant only the macro grid could actually be researched.
const HISTORY_BARS = 30 * 24 * HOUR;
const DECISION_MODULO = STEP === 300 ? 3_300 : 0;
const SIX_HOUR_DECISION_MODULO = STEP === 300 ? 21_300 : 18_000;
const DAILY_DECISION_MODULO = STEP === 300 ? 86_100 : 82_800;
const MIN_CONTEXT_MARKETS = Math.max(8, raw.symbols.length - 2);

const fromMs = raw.from * 1_000;
const toMs = raw.now * 1_000;
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const discoveryMonths = Number(process.env.RESEARCH_DISCOVERY_MONTHS
  ?? (raw.months.length === 12 ? 6 : raw.months.length - 14));
const validationMonths = Number(process.env.RESEARCH_VALIDATION_MONTHS ?? (raw.months.length === 12 ? 3 : 8));
if (discoveryMonths < 6 || discoveryMonths + validationMonths >= raw.months.length) {
  throw new Error(`Invalid research split: ${discoveryMonths}/${validationMonths}/${raw.months.length}`);
}
const discoveryEnd = monthStart(raw.months[discoveryMonths]);
const validationEnd = monthStart(raw.months[discoveryMonths + validationMonths]);
const blindMonths = raw.months.length - discoveryMonths - validationMonths;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
};
const sign = (value) => value > 0 ? 1 : value < 0 ? -1 : 0;
const continuous = (rows, index, count) => {
  if (index + 1 < count) return false;
  for (let cursor = index - count + 2; cursor <= index; cursor += 1) {
    if (rows[cursor].time !== rows[cursor - 1].time + STEP) return false;
  }
  return true;
};
const ret = (rows, index, bars) => rows[index].close / rows[index - bars].close - 1;
const hourlyWindows = (rows, index, hours, offsetHours = 0) => Array.from({ length: hours }, (_, hour) => {
  const end = index - (offsetHours + hour) * HOUR;
  const window = rows.slice(end - HOUR + 1, end + 1);
  return { range: (Math.max(...window.map((row) => row.high)) - Math.min(...window.map((row) => row.low)))
      / Math.max(window.at(-1).close, 1e-12),
    volume: sum(window.map((row) => row.volume)) };
});

const contexts = new Map();
for (const { rows } of raw.datasets) {
  for (let index = HISTORY_BARS; index < rows.length - 1; index += 1) {
    if (rows[index].time % 3_600 !== DECISION_MODULO || !continuous(rows, index, HISTORY_BARS)) continue;
    const values = contexts.get(rows[index].time) ?? [];
    values.push({ r6: ret(rows, index, 6 * HOUR), r24: ret(rows, index, 24 * HOUR),
      r7d: ret(rows, index, 7 * 24 * HOUR), r30d: ret(rows, index, 30 * 24 * HOUR) });
    contexts.set(rows[index].time, values);
  }
}
for (const [time, values] of contexts) {
  const r6 = values.map((row) => row.r6); const r24 = values.map((row) => row.r24);
  const r7d = values.map((row) => row.r7d); const r30d = values.map((row) => row.r30d);
  contexts.set(time, { markets: values.length, median6: median(r6), median24: median(r24),
    median7d: median(r7d), median30d: median(r30d),
    breadth6: r6.filter((value) => value > 0).length / values.length,
    breadth24: r24.filter((value) => value > 0).length / values.length,
    breadth7d: r7d.filter((value) => value > 0).length / values.length,
    breadth30d: r30d.filter((value) => value > 0).length / values.length });
}

function features(rows, index) {
  if (!continuous(rows, index, HISTORY_BARS) || rows[index + 1]?.time !== rows[index].time + STEP) return null;
  const context = contexts.get(rows[index].time);
  if (!context || context.markets < MIN_CONTEXT_MARKETS) return null;
  const current = rows[index];
  const previous6h = rows.slice(index - 6 * HOUR, index);
  const previous12h = rows.slice(index - 12 * HOUR, index);
  const previous3d = rows.slice(index - 3 * 24 * HOUR, index);
  const previous7d = rows.slice(index - 7 * 24 * HOUR, index);
  const recentHour = hourlyWindows(rows, index, 1);
  const priorSixHours = hourlyWindows(rows, index, 6, 1);
  const recentTwoHours = hourlyWindows(rows, index, 2);
  const recentSixHours = hourlyWindows(rows, index, 6);
  const average = (items) => sum(items) / Math.max(items.length, 1);
  return { current, context, r15: ret(rows, index, Math.max(1, Math.round(HOUR / 4))), r1: ret(rows, index, HOUR),
    r6: ret(rows, index, 6 * HOUR), r24: ret(rows, index, 24 * HOUR), r48: ret(rows, index, 48 * HOUR),
    r72: ret(rows, index, 3 * 24 * HOUR), r7d: ret(rows, index, 7 * 24 * HOUR),
    r30d: ret(rows, index, 30 * 24 * HOUR),
    relative6: ret(rows, index, 6 * HOUR) - context.median6,
    relative24: ret(rows, index, 24 * HOUR) - context.median24,
    relative7d: ret(rows, index, 7 * 24 * HOUR) - context.median7d,
    atr1: median(recentTwoHours.map((row) => row.range)), atr6: median(recentSixHours.map((row) => row.range)),
    compression: median(recentHour.map((row) => row.range))
      / Math.max(median(priorSixHours.map((row) => row.range)), 1e-9),
    volumeBurst: average(recentHour.map((row) => row.volume))
      / Math.max(average(priorSixHours.map((row) => row.volume)), 1e-9),
    high6: Math.max(...previous6h.map((row) => row.high)), low6: Math.min(...previous6h.map((row) => row.low)),
    high12: Math.max(...previous12h.map((row) => row.high)), low12: Math.min(...previous12h.map((row) => row.low)),
    high3d: Math.max(...previous3d.map((row) => row.high)), low3d: Math.min(...previous3d.map((row) => row.low)),
    high7d: Math.max(...previous7d.map((row) => row.high)), low7d: Math.min(...previous7d.map((row) => row.low)) };
}

function route(config, f) {
  if (config.family === "MACRO_TREND") {
    const direction = sign(f.r30d);
    const marketDirection = sign(f.context.median30d);
    const breadth = direction > 0 ? f.context.breadth30d : 1 - f.context.breadth30d;
    if (!direction || Math.abs(f.r30d) < config.trend30 || sign(f.r7d) !== direction
      || Math.abs(f.r7d) < config.impulse7 || marketDirection !== direction
      || breadth < config.breadth) return null;
    const boundary = config.breakDays === 3
      ? (direction > 0 ? f.high3d : f.low3d) : (direction > 0 ? f.high7d : f.low7d);
    if (direction * (f.current.close / boundary - 1) < 0) return null;
    return { direction, strength: Math.abs(f.r30d) + Math.abs(f.r7d) + breadth * 0.02 };
  }
  if (config.family === "TREND_BREAK") {
    const direction = sign(f.r24);
    if (!direction || Math.abs(f.r24) < config.trend || sign(f.r6) !== direction
      || Math.abs(f.r6) < config.impulse || sign(f.context.median24) !== direction) return null;
    const boundary = direction > 0 ? f.high6 : f.low6;
    if (direction * (f.current.close / boundary - 1) < config.breakout) return null;
    return { direction, strength: Math.abs(f.r24) + Math.abs(f.r6) + f.volumeBurst * 0.002 };
  }
  if (config.family === "PULLBACK_RESUME") {
    const direction = sign(f.r24);
    if (!direction || Math.abs(f.r24) < config.trend || sign(f.r6) !== direction
      || direction * f.r1 > -config.pullbackMin || direction * f.r1 < -config.pullbackMax
      || direction * f.r15 <= config.resume || sign(f.context.median24) !== direction) return null;
    return { direction, strength: Math.abs(f.r24) + Math.abs(f.r6) + Math.abs(f.r1) };
  }
  if (config.family === "COMPRESSION_BREAK") {
    if (f.compression > config.compression || f.volumeBurst < config.volume) return null;
    const up = f.current.close > f.high6 * (1 + config.breakout);
    const down = f.current.close < f.low6 * (1 - config.breakout);
    if (up === down) return null;
    const direction = up ? 1 : -1;
    const breadth = direction > 0 ? f.context.breadth6 : 1 - f.context.breadth6;
    if (breadth < config.breadth) return null;
    return { direction, strength: (1 - f.compression) + f.volumeBurst * 0.05 + breadth * 0.1 };
  }
  if (config.family === "RELATIVE_REVERSAL") {
    const extreme = f.relative6;
    const original = sign(extreme);
    if (!original || Math.abs(extreme) < config.extreme || sign(f.r15) !== -original
      || Math.abs(f.r15) < config.reclaim || Math.abs(f.context.median6) > config.marketCap
      || Math.abs(f.relative24) < (config.relative24 ?? 0)
      || f.volumeBurst < (config.volume ?? 0)) return null;
    if (config.hourMode === "TURNED" && sign(f.r1) !== -original) return null;
    if (config.hourMode === "EXTENDING" && sign(f.r1) !== original) return null;
    return { direction: -original, strength: Math.abs(extreme) + Math.abs(f.r15) };
  }
  if (config.family === "MACRO_PULLBACK_RESUME") {
    const direction = sign(f.r30d); const breadth = direction > 0 ? f.context.breadth30d : 1 - f.context.breadth30d;
    const pullback = direction * f.r72; const resumed = direction * f.r6;
    if (!direction || Math.abs(f.r30d) < config.trend30 || sign(f.context.median30d) !== direction
      || breadth < config.breadth || direction * f.r7d < config.base7d
      || pullback > -config.pullbackMin || pullback < -config.pullbackMax || resumed < config.resume6) return null;
    return { direction, strength: Math.abs(f.r30d) + Math.abs(pullback) + resumed + breadth * 0.02 };
  }
  if (config.family === "MACRO_RANGE_FADE") {
    const original = sign(f.relative7d); const direction = -original;
    if (!original || Math.abs(f.context.median30d) > config.market30Cap
      || f.context.breadth30d < config.breadthLow || f.context.breadth30d > config.breadthHigh
      || Math.abs(f.relative7d) < config.extreme7d || direction * f.r6 < config.resume6
      || Math.abs(f.context.median24) > config.market24Cap) return null;
    return { direction, strength: Math.abs(f.relative7d) + direction * f.r6 };
  }
  if (config.family === "PANIC_REVERSAL") {
    const original = sign(f.context.median24); const direction = -original;
    const alignedBreadth = original > 0 ? f.context.breadth24 : 1 - f.context.breadth24;
    if (!original || Math.abs(f.context.median24) < config.marketShock24 || alignedBreadth < config.shockBreadth
      || sign(f.r24) !== original || Math.abs(f.r24) < config.symbolShock24
      || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(f.r24) + Math.abs(f.context.median24) + direction * f.r6 };
  }
  if (config.family === "EXPANSION_CONTINUATION") {
    const direction = sign(f.context.median24); const breadth = direction > 0 ? f.context.breadth24 : 1 - f.context.breadth24;
    const boundary = direction > 0 ? f.high6 : f.low6;
    if (!direction || Math.abs(f.context.median24) < config.marketMove24 || breadth < config.breadth
      || sign(f.r24) !== direction || Math.abs(f.r24) < config.symbolMove24
      || direction * f.r6 < config.impulse6 || direction * (f.current.close / boundary - 1) < 0) return null;
    return { direction, strength: Math.abs(f.r24) + Math.abs(f.context.median24) + breadth * 0.02 };
  }
  if (config.family === "CROSS_SECTIONAL_MOMENTUM") {
    const direction = sign(f.relative7d);
    if (!direction || Math.abs(f.context.median30d) > config.market30Cap
      || Math.abs(f.relative7d) < config.relative7d || direction * f.r24 < config.confirm24
      || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(f.relative7d) + direction * f.r24 + direction * f.r6 };
  }
  if (config.family === "RANGE_EDGE_REVERSION") {
    const width = Math.max(f.high7d - f.low7d, f.current.close * 1e-9);
    const location = (f.current.close - f.low7d) / width;
    const direction = location >= 1 - config.edge ? -1 : location <= config.edge ? 1 : 0;
    if (!direction || Math.abs(f.context.median30d) > config.market30Cap
      || Math.abs(f.context.median24) > config.market24Cap || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(location - 0.5) + direction * f.r6 };
  }
  if (config.family === "FAILED_BREAKOUT_REVERSAL") {
    const failedHigh = f.current.high > f.high7d * (1 + config.sweep)
      && f.current.close < f.high7d && f.current.close < f.current.open;
    const failedLow = f.current.low < f.low7d * (1 - config.sweep)
      && f.current.close > f.low7d && f.current.close > f.current.open;
    if (failedHigh === failedLow || f.volumeBurst < config.volume
      || Math.abs(f.context.median24) > config.market24Cap) return null;
    const direction = failedHigh ? -1 : 1;
    return { direction, strength: Math.abs(f.current.close / (failedHigh ? f.high7d : f.low7d) - 1)
      + f.volumeBurst * 0.01 };
  }
  if (config.family === "IDIOSYNCRATIC_REVERSAL") {
    const original = sign(f.relative24); const direction = -original;
    if (!original || Math.abs(f.relative24) < config.extreme24
      || Math.abs(f.context.median30d) > config.market30Cap
      || Math.abs(f.context.median24) > config.market24Cap
      || direction * f.r6 < config.resume6 || direction * f.r1 < config.resume1) return null;
    return { direction, strength: Math.abs(f.relative24) + direction * f.r6 + direction * f.r1 };
  }
  if (config.family === "RELATIVE_PULLBACK_RESUME") {
    const direction = sign(f.relative7d); const pullback = direction * f.r24;
    if (!direction || Math.abs(f.relative7d) < config.relative7d
      || Math.abs(f.context.median30d) > config.market30Cap
      || pullback > -config.pullbackMin || pullback < -config.pullbackMax
      || direction * f.r6 < config.resume6) return null;
    return { direction, strength: Math.abs(f.relative7d) + Math.abs(pullback) + direction * f.r6 };
  }
  if (config.family === "REGIME_TURN_CONTINUATION") {
    const direction = sign(f.context.median7d);
    const breadth = direction > 0 ? f.context.breadth24 : 1 - f.context.breadth24;
    const boundary = direction > 0 ? f.high6 : f.low6;
    if (!direction || Math.abs(f.context.median30d) > config.prior30Cap
      || Math.abs(f.context.median7d) < config.turn7d || direction * f.context.median24 < config.confirm24
      || breadth < config.breadth || direction * f.r24 < config.symbol24
      || direction * (f.current.close / boundary - 1) < 0) return null;
    return { direction, strength: Math.abs(f.context.median7d) + direction * f.r24 + breadth * 0.02 };
  }
  if (config.family === "ORDERLY_TREND_RELATIVE") {
    const direction = sign(f.context.median30d);
    const breadth = direction > 0 ? f.context.breadth30d : 1 - f.context.breadth30d;
    if (!direction || Math.abs(f.context.median30d) < config.market30
      || breadth < config.breadth || direction * f.relative7d < config.relative7d
      || direction * f.r7d < config.symbol7d || direction * f.r24 < config.confirm24) return null;
    return { direction, strength: Math.abs(f.context.median30d) + direction * f.relative7d
      + direction * f.r24 + breadth * 0.02 };
  }
  if (config.family === "TIME_SERIES_MOMENTUM") {
    const direction = sign(f.r30d);
    const breadth = direction > 0 ? f.context.breadth30d : 1 - f.context.breadth30d;
    if (!direction || Math.abs(f.r30d) < config.trend30 || direction * f.r7d < config.confirm7d
      || sign(f.context.median30d) !== direction || breadth < config.breadth
      || direction * f.r24 < config.confirm24) return null;
    return { direction, strength: Math.abs(f.r30d) + direction * f.r7d + breadth * 0.02 };
  }
  if (config.family === "BULL_LEADER_TRAIL") {
    if (f.context.median30d < config.market30 || f.context.median7d < config.market7
      || f.context.breadth30d < config.breadth30 || f.context.breadth7d < config.breadth7
      || f.r30d < config.symbol30 || f.relative7d < config.relative7d
      || f.r24 < config.confirm24) return null;
    return { direction: 1, strength: f.context.median30d + f.context.median7d
      + f.r30d + f.relative7d + f.context.breadth7d * 0.02 };
  }
  if (config.family === "BULL_DIP_RESUME") {
    if (f.context.median30d < config.market30 || f.context.median7d < config.market7
      || f.context.breadth30d < config.breadth30 || f.context.breadth7d < config.breadth7
      || f.r30d < config.symbol30 || f.relative7d < config.relative7d
      || f.r24 > -config.pullbackMin || f.r24 < -config.pullbackMax || f.r6 < config.resume6) return null;
    return { direction: 1, strength: f.context.median30d + f.context.median7d
      + f.r30d + f.relative7d + Math.abs(f.r24) + f.r6 };
  }
  return null;
}

function lowerBound(rows, time) {
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time < time) low = middle + 1; else high = middle;
  }
  return low;
}

function resolve(symbol, family, rows, index, signal, config, friction = FRICTION, slippage = ENTRY_SLIPPAGE,
  cachedFeatures = null, executionRows = null) {
  const direction = signal.direction; const next = rows[index + 1];
  const tradeRows = executionRows ?? rows;
  const tradeIndex = executionRows ? lowerBound(tradeRows, next.time) : index + 1;
  if (!tradeRows[tradeIndex] || tradeRows[tradeIndex].time !== next.time) return null;
  const entryCandle = tradeRows[tradeIndex];
  const entry = entryCandle.open * (1 + direction * slippage);
  const stopRate = Math.min(config.stopCap ?? 0.08,
    Math.max(config.stopFloor ?? 0.006, config.stopAtr * (cachedFeatures ?? features(rows, index)).atr6));
  const trailing = config.exitModel === "TRAIL";
  const targetRate = trailing ? null : Math.max(stopRate * config.rewardRisk, friction * 2.2);
  const stop = entry * (1 - direction * stopRate); const target = trailing ? null : entry * (1 + direction * targetRate);
  const maxBars = config.maxHoldHours * (3_600 / EXECUTION_STEP);
  const finalIndex = Math.min(tradeRows.length - 1, tradeIndex + maxBars - 1);
  let exit = tradeRows[finalIndex].close;
  let closedAt = tradeRows[finalIndex].time * 1_000;
  let outcome = "TIMEOUT";
  let activeStop = stop; let favorableExtreme = entry;
  for (let offset = 0; offset < maxBars && tradeIndex + offset < tradeRows.length; offset += 1) {
    const candle = tradeRows[tradeIndex + offset];
    if (offset > 0 && candle.time !== tradeRows[tradeIndex + offset - 1].time + EXECUTION_STEP) break;
    const stopped = direction > 0 ? candle.low <= activeStop : candle.high >= activeStop;
    const targeted = !trailing && (direction > 0 ? candle.high >= target : candle.low <= target);
    if (stopped || targeted) {
      exit = stopped ? activeStop : target; closedAt = candle.time * 1_000;
      outcome = stopped ? (activeStop === stop ? "STOP" : "TRAIL") : "TARGET"; break;
    }
    if (trailing) {
      favorableExtreme = direction > 0 ? Math.max(favorableExtreme, candle.high) : Math.min(favorableExtreme, candle.low);
      const trailRate = stopRate * (config.trailScale ?? 1);
      const candidate = favorableExtreme * (1 - direction * trailRate);
      activeStop = direction > 0 ? Math.max(activeStop, candidate) : Math.min(activeStop, candidate);
    }
  }
  const grossReturnRate = direction * (exit - entry) / entry;
  return { symbol, family, side: direction > 0 ? "LONG" : "SHORT", openedAt: entryCandle.time * 1_000,
    closedAt, entry, stop, target, stopRate, targetRate, strength: signal.strength,
    outcome, grossReturnRate, netReturnRate: grossReturnRate - friction };
}

const observationCache = new Map();
function observations(config) {
  const cadence = config.decisionCadence ?? "hourly";
  if (observationCache.has(cadence)) return observationCache.get(cadence);
  const modulo = cadence === "daily" ? DAILY_DECISION_MODULO
    : cadence === "six-hourly" ? SIX_HOUR_DECISION_MODULO : DECISION_MODULO;
  const period = cadence === "daily" ? 86_400 : cadence === "six-hourly" ? 21_600 : 3_600;
  const result = [];
  for (const { symbol, rows } of raw.datasets) {
    for (let index = HISTORY_BARS; index < rows.length - 1; index += 1) {
      if (rows[index].time % period !== modulo) continue;
      const f = features(rows, index); if (f) result.push({ symbol, rows, index, f });
    }
  }
  observationCache.set(cadence, result);
  return result;
}

function rawTrades(config, end, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const trades = [];
  for (const { symbol, rows, index, f } of observations(config)) {
    if (rows[index].time * 1_000 >= end) continue;
    const signal = route(config, f); if (!signal) continue;
    if (SIDE !== "BOTH" && (signal.direction > 0 ? "LONG" : "SHORT") !== SIDE) continue;
    const trade = resolve(symbol, config.family, rows, index, signal, config, friction, slippage, f,
      executionBySymbol.get(symbol));
    if (trade) trades.push(trade);
  }
  return trades.sort((left, right) => left.openedAt - right.openedAt || right.strength - left.strength);
}

function portfolio(trades, config) {
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  const open = []; const accepted = []; const cooldown = new Map();
  const settle = (time) => {
    const closing = open.filter((trade) => trade.closedAt <= time).sort((left, right) => left.closedAt - right.closedAt);
    for (const trade of closing) {
      equity += trade.netPnl; peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
      open.splice(open.indexOf(trade), 1); cooldown.set(`${trade.family}:${trade.symbol}`, trade.closedAt + config.cooldownHours * 3_600_000);
    }
  };
  for (const trade of trades) {
    settle(trade.openedAt);
    if (equity <= 100 || open.some((row) => row.symbol === trade.symbol)
      || (cooldown.get(`${trade.family}:${trade.symbol}`) ?? 0) > trade.openedAt) continue;
    const sameSide = open.filter((row) => row.side === trade.side);
    if (open.length >= config.maxOpen || sameSide.length >= config.maxSameSide) continue;
    const riskMultiple = config.riskRate / Math.max(trade.stopRate + FRICTION, 1e-9);
    const multiple = Math.min(config.notionalMultiple, riskMultiple);
    if (multiple < (config.minNotionalMultiple ?? 0.25)) continue;
    const notional = equity * multiple; const plannedRisk = notional * (trade.stopRate + FRICTION);
    if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10
      || sum(sameSide.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.065) continue;
    const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk,
      netPnl: notional * trade.netReturnRate };
    accepted.push(acceptedTrade); open.push(acceptedTrade);
  }
  settle(Infinity);
  return { trades: accepted, endEquity: equity, maxDrawdown };
}

function adaptivePortfolio(trades, config, policy) {
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  const open = []; const accepted = []; const pendingShadows = []; const resolvedShadows = [];
  const cooldown = new Map();
  const settleAccount = (time) => {
    const closing = open.filter((trade) => trade.closedAt <= time).sort((left, right) => left.closedAt - right.closedAt);
    for (const trade of closing) {
      equity += trade.netPnl; peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
      open.splice(open.indexOf(trade), 1); cooldown.set(`${trade.family}:${trade.symbol}`, trade.closedAt + config.cooldownHours * 3_600_000);
    }
  };
  const settleShadows = (time) => {
    const closing = pendingShadows.filter((trade) => trade.closedAt <= time).sort((left, right) => left.closedAt - right.closedAt);
    for (const trade of closing) { resolvedShadows.push(trade); pendingShadows.splice(pendingShadows.indexOf(trade), 1); }
  };
  const authorized = () => {
    if (policy.kind === "three-or-six") {
      const latestSix = resolvedShadows.slice(-6);
      const latestThree = latestSix.slice(-3);
      return latestThree.length === 3 && latestThree.every((trade) => trade.netReturnRate > 0)
        || latestSix.length === 6 && sum(latestSix.map((trade) => trade.netReturnRate)) > 0;
    }
    const recent = resolvedShadows.slice(-policy.window);
    if (recent.length < policy.window) return false;
    const gains = sum(recent.filter((trade) => trade.netReturnRate > 0).map((trade) => trade.netReturnRate));
    const losses = Math.abs(sum(recent.filter((trade) => trade.netReturnRate <= 0).map((trade) => trade.netReturnRate)));
    const pf = losses > 0 ? gains / losses : gains > 0 ? 99 : 0;
    if (gains - losses <= 0 || pf < policy.profitFactor) return false;
    if (policy.lossGuard > 0) {
      const guard = resolvedShadows.slice(-policy.lossGuard);
      if (guard.length === policy.lossGuard && sum(guard.map((trade) => trade.netReturnRate)) <= 0) return false;
    }
    return true;
  };
  for (const trade of trades) {
    settleAccount(trade.openedAt); settleShadows(trade.openedAt);
    const mayTrade = authorized();
    pendingShadows.push(trade);
    if (!mayTrade || equity <= 100 || open.some((row) => row.symbol === trade.symbol)
      || (cooldown.get(`${trade.family}:${trade.symbol}`) ?? 0) > trade.openedAt) continue;
    const sameSide = open.filter((row) => row.side === trade.side);
    if (open.length >= config.maxOpen || sameSide.length >= config.maxSameSide) continue;
    const multiple = Math.min(config.notionalMultiple, config.riskRate / Math.max(trade.stopRate + FRICTION, 1e-9));
    if (multiple < (config.minNotionalMultiple ?? 0.25)) continue;
    const notional = equity * multiple; const plannedRisk = notional * (trade.stopRate + FRICTION);
    if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10
      || sum(sameSide.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.065) continue;
    const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk,
      netPnl: notional * trade.netReturnRate };
    accepted.push(acceptedTrade); open.push(acceptedTrade);
  }
  settleAccount(Infinity);
  return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(portfolioResult, start, end, extraFriction = 0) {
  const rows = portfolioResult.trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end);
  const pnls = rows.map((trade) => trade.netPnl - trade.notional * extraFriction);
  const gains = pnls.filter((pnl) => pnl > 0); const losses = pnls.filter((pnl) => pnl <= 0);
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  for (const pnl of pnls) { equity += pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak); }
  const monthlyPnls = raw.months.flatMap((month) => {
    const startAt = monthStart(month); const endAt = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
    if (startAt < start || endAt > end) return [];
    return [{ month, pnl: sum(rows.filter((trade) => trade.openedAt >= startAt && trade.openedAt < endAt)
      .map((trade) => trade.netPnl - trade.notional * extraFriction)) }];
  });
  const pnlBySymbol = Object.fromEntries([...new Set(rows.map((row) => row.symbol))].map((symbol) => [symbol,
    sum(rows.filter((row) => row.symbol === symbol).map((row) => row.netPnl - row.notional * extraFriction))]));
  const positives = Object.values(pnlBySymbol).filter((pnl) => pnl > 0); const positiveTotal = sum(positives);
  const sixMonthPnls = [];
  for (let index = 0; index + 6 <= monthlyPnls.length; index += 6) {
    sixMonthPnls.push(sum(monthlyPnls.slice(index, index + 6).map((month) => month.pnl)));
  }
  const activeMonths = monthlyPnls.filter((month) => rows.some((trade) => {
    const startAt = monthStart(month.month); const endAt = Date.UTC(Number(month.month.slice(0, 4)), Number(month.month.slice(4, 6)), 1);
    return trade.openedAt >= startAt && trade.openedAt < endAt;
  })).length;
  return { trades: rows.length, winRate: rows.length ? gains.length / rows.length : 0, netPnl: sum(pnls),
    profitFactor: losses.length ? sum(gains) / Math.abs(sum(losses)) : gains.length ? 99 : 0,
    maxDrawdown, activeMonths, positiveMonths: monthlyPnls.filter((month) => month.pnl > 0).length, monthlyPnls,
    sixMonthPnls, positiveSixMonthBlocks: sixMonthPnls.filter((pnl) => pnl > 0).length,
    worstSixMonthPnl: sixMonthPnls.length ? Math.min(...sixMonthPnls) : 0,
    largestPositiveSymbolShare: positiveTotal > 0 ? Math.max(...positives) / positiveTotal : 1, pnlBySymbol };
}

const common = { stopFloor: 0.006, stopCap: 0.06, riskRate: 0.02, maxOpen: 3, maxSameSide: 2, cooldownHours: 4 };
const broadConfigs = [];
for (const trend of [0.03, 0.05, 0.08]) for (const impulse of [0.008, 0.015])
  for (const stopAtr of [2, 3]) for (const rewardRisk of [1.5, 2.2]) broadConfigs.push({ ...common,
    id: `trend-${trend}-${impulse}-${stopAtr}-${rewardRisk}`, family: "TREND_BREAK", trend, impulse,
    breakout: 0, stopAtr, rewardRisk, maxHoldHours: 24, notionalMultiple: 0.75 });
for (const trend of [0.03, 0.05]) for (const pullbackMax of [0.015, 0.025])
  for (const stopAtr of [2, 3]) for (const rewardRisk of [1.5, 2.2]) broadConfigs.push({ ...common,
    id: `pullback-${trend}-${pullbackMax}-${stopAtr}-${rewardRisk}`, family: "PULLBACK_RESUME", trend,
    pullbackMin: 0.001, pullbackMax, resume: 0.0005, stopAtr, rewardRisk, maxHoldHours: 18, notionalMultiple: 0.75 });
for (const compression of [0.55, 0.7]) for (const volume of [1, 1.4])
  for (const stopAtr of [2, 3]) for (const rewardRisk of [1.5, 2.2]) broadConfigs.push({ ...common,
    id: `compression-${compression}-${volume}-${stopAtr}-${rewardRisk}`, family: "COMPRESSION_BREAK",
    compression, volume, breadth: 0.58, breakout: 0, stopAtr, rewardRisk, maxHoldHours: 18, notionalMultiple: 0.75 });
for (const extreme of [0.025, 0.04, 0.06]) for (const reclaim of [0.001, 0.002])
  for (const stopAtr of [2, 3]) for (const rewardRisk of [1.2, 1.8]) broadConfigs.push({ ...common,
    id: `reversal-${extreme}-${reclaim}-${stopAtr}-${rewardRisk}`, family: "RELATIVE_REVERSAL",
    extreme, reclaim, marketCap: 0.025, stopAtr, rewardRisk, maxHoldHours: 12, notionalMultiple: 0.75 });
const deepReversalConfigs = [];
for (const extreme of [0.03, 0.035, 0.04, 0.045]) for (const reclaim of [0.0005, 0.001])
  for (const stopAtr of [1.5, 2, 2.5, 3]) for (const rewardRisk of [1.5, 1.8, 2.2])
    for (const maxHoldHours of [12, 24]) deepReversalConfigs.push({ ...common,
      id: `deep-reversal-${extreme}-${reclaim}-${stopAtr}-${rewardRisk}-${maxHoldHours}`,
      family: "RELATIVE_REVERSAL", extreme, reclaim, marketCap: 0.025, stopAtr, rewardRisk,
      maxHoldHours, notionalMultiple: 0.75 });
const adaptiveBase = { ...common, id: "adaptive-relative-reversal", family: "RELATIVE_REVERSAL",
  extreme: 0.04, reclaim: 0.001, marketCap: 0.025, stopAtr: 3, rewardRisk: 1.5,
  maxHoldHours: 12, notionalMultiple: 0.75 };
const adaptivePolicies = [12, 20, 30].flatMap((window) => [1, 1.1, 1.2].flatMap((profitFactor) => [0, 3]
  .map((lossGuard) => ({ window, profitFactor, lossGuard }))));
const wideRiskConfigs = [];
for (const family of ["TREND_BREAK", "RELATIVE_REVERSAL"]) for (const stopFloor of [0.015, 0.025, 0.04])
  for (const stopAtr of [3, 5]) for (const rewardRisk of [1.2, 1.5, 2]) for (const maxHoldHours of [24, 48, 72]) {
    if (family === "TREND_BREAK") {
      for (const trend of [0.05, 0.08]) wideRiskConfigs.push({ ...common,
        id: `wide-trend-${trend}-${stopFloor}-${stopAtr}-${rewardRisk}-${maxHoldHours}`, family,
        trend, impulse: 0.012, breakout: 0, stopFloor, stopCap: 0.12, stopAtr, rewardRisk,
        maxHoldHours, riskRate: 0.02, notionalMultiple: 0.75 });
    } else {
      for (const extreme of [0.035, 0.04]) wideRiskConfigs.push({ ...common,
        id: `wide-reversal-${extreme}-${stopFloor}-${stopAtr}-${rewardRisk}-${maxHoldHours}`, family,
        extreme, reclaim: 0.001, marketCap: 0.025, stopFloor, stopCap: 0.12, stopAtr, rewardRisk,
        maxHoldHours, riskRate: 0.02, notionalMultiple: 0.75 });
    }
  }
const macroTrendConfigs = [];
for (const decisionCadence of ["daily", "six-hourly"])
  for (const trend30 of [0.15, 0.25]) for (const impulse7 of [0.04, 0.08])
  for (const breakDays of [3, 7]) for (const breadth of [0.50, 0.60])
    for (const stopFloor of [0.08, 0.12]) for (const rewardRisk of [1.5, 2.2])
      for (const maxHoldHours of [72, 168, 336]) macroTrendConfigs.push({ ...common,
        id: `macro-${decisionCadence}-${trend30}-${impulse7}-${breakDays}-${breadth}-${stopFloor}-${rewardRisk}-${maxHoldHours}`,
        family: "MACRO_TREND", decisionCadence, trend30, impulse7, breakDays, breadth,
        stopFloor, stopCap: 0.25, stopAtr: 8, rewardRisk, maxHoldHours,
        cooldownHours: 24, riskRate: 0.015, notionalMultiple: 0.50, minNotionalMultiple: 0.05 });
const compressionSpecialistConfigs = [];
for (const compression of [0.45, 0.55, 0.65]) for (const volume of [1.1, 1.3, 1.5])
  for (const breadth of [0.50, 0.60]) for (const stopAtr of [2.5, 3.5, 4.5])
    for (const rewardRisk of [1.2, 1.6, 2]) for (const maxHoldHours of [12, 24, 36])
      compressionSpecialistConfigs.push({ ...common,
        id: `compression-specialist-${compression}-${volume}-${breadth}-${stopAtr}-${rewardRisk}-${maxHoldHours}`,
        family: "COMPRESSION_BREAK", compression, volume, breadth, breakout: 0,
        stopAtr, rewardRisk, maxHoldHours, notionalMultiple: 0.75 });
const macroPullbackConfigs = [];
for (const trend30 of [0.10, 0.15, 0.20]) for (const pullbackMin of [0.01, 0.02])
  for (const pullbackMax of [0.06, 0.10]) for (const resume6 of [0.003, 0.006])
    for (const stopFloor of [0.02, 0.04]) for (const rewardRisk of [1.5, 2.2])
      macroPullbackConfigs.push({ ...common,
        id: `macro-pullback-${trend30}-${pullbackMin}-${pullbackMax}-${resume6}-${stopFloor}-${rewardRisk}`,
        family: "MACRO_PULLBACK_RESUME", trend30, breadth: 0.5, base7d: 0,
        pullbackMin, pullbackMax, resume6, stopFloor, stopCap: 0.15, stopAtr: 5,
        rewardRisk, maxHoldHours: 72, riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05,
        cooldownHours: 24 });
const macroRangeFadeConfigs = [];
for (const market30Cap of [0.03, 0.06, 0.10]) for (const extreme7d of [0.05, 0.08, 0.12])
  for (const resume6 of [0.002, 0.005]) for (const stopFloor of [0.02, 0.04])
    for (const rewardRisk of [1.2, 1.6, 2]) macroRangeFadeConfigs.push({ ...common,
      id: `macro-range-fade-${market30Cap}-${extreme7d}-${resume6}-${stopFloor}-${rewardRisk}`,
      family: "MACRO_RANGE_FADE", market30Cap, market24Cap: 0.04, breadthLow: 0.30, breadthHigh: 0.70,
      extreme7d, resume6, stopFloor, stopCap: 0.12, stopAtr: 4, rewardRisk, maxHoldHours: 48,
      riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const panicReversalConfigs = [];
for (const marketShock24 of [0.03, 0.05, 0.08]) for (const shockBreadth of [0.70, 0.80])
  for (const symbolShock24 of [0.05, 0.08]) for (const resume6 of [0.003, 0.008])
    for (const rewardRisk of [1.2, 1.8]) panicReversalConfigs.push({ ...common,
      id: `panic-reversal-${marketShock24}-${shockBreadth}-${symbolShock24}-${resume6}-${rewardRisk}`,
      family: "PANIC_REVERSAL", marketShock24, shockBreadth, symbolShock24, resume6,
      stopFloor: 0.03, stopCap: 0.15, stopAtr: 5, rewardRisk, maxHoldHours: 48,
      riskRate: 0.0125, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const expansionContinuationConfigs = [];
for (const marketMove24 of [0.02, 0.04, 0.06]) for (const breadth of [0.65, 0.75])
  for (const symbolMove24 of [0.03, 0.06]) for (const impulse6 of [0.005, 0.01])
    for (const rewardRisk of [1.5, 2.2]) expansionContinuationConfigs.push({ ...common,
      id: `expansion-continuation-${marketMove24}-${breadth}-${symbolMove24}-${impulse6}-${rewardRisk}`,
      family: "EXPANSION_CONTINUATION", marketMove24, breadth, symbolMove24, impulse6,
      stopFloor: 0.025, stopCap: 0.15, stopAtr: 5, rewardRisk, maxHoldHours: 72,
      riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const crossMomentumConfigs = [];
for (const market30Cap of [0.05, 0.10, 0.15]) for (const relative7d of [0.04, 0.07, 0.10])
  for (const confirm24 of [0, 0.01]) for (const resume6 of [0, 0.004])
    for (const rewardRisk of [1.2, 1.6, 2]) crossMomentumConfigs.push({ ...common,
      id: `cross-momentum-${market30Cap}-${relative7d}-${confirm24}-${resume6}-${rewardRisk}`,
      family: "CROSS_SECTIONAL_MOMENTUM", market30Cap, relative7d, confirm24, resume6,
      stopFloor: 0.02, stopCap: 0.10, stopAtr: 4, rewardRisk, maxHoldHours: 48,
      riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const rangeEdgeConfigs = [];
for (const market30Cap of [0.03, 0.06, 0.10]) for (const market24Cap of [0.015, 0.03])
  for (const edge of [0.08, 0.15]) for (const resume6 of [0.002, 0.005])
    for (const rewardRisk of [1.2, 1.6, 2]) rangeEdgeConfigs.push({ ...common,
      id: `range-edge-${market30Cap}-${market24Cap}-${edge}-${resume6}-${rewardRisk}`,
      family: "RANGE_EDGE_REVERSION", market30Cap, market24Cap, edge, resume6,
      stopFloor: 0.015, stopCap: 0.08, stopAtr: 3, rewardRisk, maxHoldHours: 36,
      riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 18 });
const failedBreakoutConfigs = [];
for (const sweep of [0, 0.002, 0.005]) for (const volume of [0.8, 1.2, 1.6])
  for (const market24Cap of [0.03, 0.06]) for (const stopAtr of [2, 3.5])
    for (const rewardRisk of [1.2, 1.8, 2.4]) failedBreakoutConfigs.push({ ...common,
      id: `failed-breakout-${sweep}-${volume}-${market24Cap}-${stopAtr}-${rewardRisk}`,
      family: "FAILED_BREAKOUT_REVERSAL", sweep, volume, market24Cap,
      stopFloor: 0.012, stopCap: 0.08, stopAtr, rewardRisk, maxHoldHours: 24,
      riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 12 });
const idiosyncraticReversalConfigs = [];
for (const extreme24 of [0.03, 0.05, 0.08]) for (const market30Cap of [0.05, 0.10, 0.15])
  for (const market24Cap of [0.03, 0.06]) for (const resume6 of [0, 0.004, 0.008])
    for (const resume1 of [0, 0.001]) for (const rewardRisk of [1.2, 1.6, 2])
      idiosyncraticReversalConfigs.push({ ...common,
        id: `idiosyncratic-reversal-${extreme24}-${market30Cap}-${market24Cap}-${resume6}-${resume1}-${rewardRisk}`,
        family: "IDIOSYNCRATIC_REVERSAL", extreme24, market30Cap, market24Cap, resume6, resume1,
        stopFloor: 0.02, stopCap: 0.12, stopAtr: 4, rewardRisk, maxHoldHours: 36,
        riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 18 });
const relativePullbackConfigs = [];
for (const relative7d of [0.04, 0.07, 0.10]) for (const market30Cap of [0.05, 0.10, 0.20])
  for (const pullbackMin of [0.005, 0.01]) for (const pullbackMax of [0.03, 0.06])
    for (const resume6 of [0, 0.004]) for (const rewardRisk of [1.2, 1.6, 2])
      relativePullbackConfigs.push({ ...common,
        id: `relative-pullback-${relative7d}-${market30Cap}-${pullbackMin}-${pullbackMax}-${resume6}-${rewardRisk}`,
        family: "RELATIVE_PULLBACK_RESUME", relative7d, market30Cap, pullbackMin, pullbackMax, resume6,
        stopFloor: 0.02, stopCap: 0.12, stopAtr: 4, rewardRisk, maxHoldHours: 48,
        riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const regimeTurnConfigs = [];
for (const prior30Cap of [0.05, 0.10, 0.15]) for (const turn7d of [0.02, 0.04, 0.07])
  for (const confirm24 of [0.005, 0.015]) for (const breadth of [0.60, 0.70])
    for (const symbol24 of [0.01, 0.03]) for (const rewardRisk of [1.5, 2.2])
      regimeTurnConfigs.push({ ...common,
        id: `regime-turn-${prior30Cap}-${turn7d}-${confirm24}-${breadth}-${symbol24}-${rewardRisk}`,
        family: "REGIME_TURN_CONTINUATION", prior30Cap, turn7d, confirm24, breadth, symbol24,
        stopFloor: 0.025, stopCap: 0.15, stopAtr: 5, rewardRisk, maxHoldHours: 72,
        riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const orderlyTrendRelativeConfigs = [];
for (const market30 of [0.05, 0.10, 0.15]) for (const breadth of [0.55, 0.65, 0.75])
  for (const relative7d of [0, 0.03, 0.06]) for (const symbol7d of [0.02, 0.05])
    for (const confirm24 of [0, 0.01]) for (const rewardRisk of [1.5, 2.2])
      orderlyTrendRelativeConfigs.push({ ...common,
        id: `orderly-trend-relative-${market30}-${breadth}-${relative7d}-${symbol7d}-${confirm24}-${rewardRisk}`,
        family: "ORDERLY_TREND_RELATIVE", market30, breadth, relative7d, symbol7d, confirm24,
        stopFloor: 0.03, stopCap: 0.18, stopAtr: 6, rewardRisk, maxHoldHours: 96,
        riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const timeSeriesTrailConfigs = [];
for (const trend30 of [0.08, 0.12, 0.18]) for (const confirm7d of [0, 0.03, 0.06])
  for (const breadth of [0.50, 0.60, 0.70]) for (const confirm24 of [-0.01, 0, 0.01])
    for (const stopFloor of [0.04, 0.08, 0.12]) for (const trailScale of [0.6, 0.8, 1])
      for (const maxHoldHours of [168, 336, 720]) timeSeriesTrailConfigs.push({ ...common,
        id: `time-series-trail-${trend30}-${confirm7d}-${breadth}-${confirm24}-${stopFloor}-${trailScale}-${maxHoldHours}`,
        family: "TIME_SERIES_MOMENTUM", trend30, confirm7d, breadth, confirm24,
        stopFloor, stopCap: 0.25, stopAtr: 8, rewardRisk: 99, exitModel: "TRAIL", trailScale,
        maxHoldHours, riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const bullLeaderTrailConfigs = [];
for (const market30 of [0.05, 0.10, 0.15]) for (const market7 of [0.01, 0.03, 0.05])
  for (const breadth30 of [0.60, 0.70]) for (const breadth7 of [0.60, 0.70])
    for (const symbol30 of [0.08, 0.15]) for (const relative7d of [0, 0.03])
      for (const confirm24 of [0, 0.01]) for (const stopFloor of [0.06, 0.10])
        for (const trailScale of [0.6, 0.8]) for (const maxHoldHours of [336, 720])
          bullLeaderTrailConfigs.push({ ...common,
            id: `bull-leader-trail-${market30}-${market7}-${breadth30}-${breadth7}-${symbol30}-${relative7d}-${confirm24}-${stopFloor}-${trailScale}-${maxHoldHours}`,
            family: "BULL_LEADER_TRAIL", market30, market7, breadth30, breadth7, symbol30, relative7d, confirm24,
            stopFloor, stopCap: 0.22, stopAtr: 8, rewardRisk: 99, exitModel: "TRAIL", trailScale,
            maxHoldHours, riskRate: 0.015, notionalMultiple: 0.5, minNotionalMultiple: 0.05, cooldownHours: 24 });
const bullDipResumeConfigs = [];
for (const market30 of [0.05, 0.10, 0.15]) for (const market7 of [0.01, 0.03])
  for (const breadth30 of [0.60, 0.70]) for (const breadth7 of [0.60, 0.70])
    for (const symbol30 of [0.08, 0.15]) for (const relative7d of [0, 0.03])
      for (const pullbackMax of [0.04, 0.08]) for (const resume6 of [0, 0.004])
        for (const rewardRisk of [1.5, 2.2]) for (const maxHoldHours of [72, 168])
          bullDipResumeConfigs.push({ ...common,
            id: `bull-dip-resume-${market30}-${market7}-${breadth30}-${breadth7}-${symbol30}-${relative7d}-${pullbackMax}-${resume6}-${rewardRisk}-${maxHoldHours}`,
            family: "BULL_DIP_RESUME", market30, market7, breadth30, breadth7, symbol30, relative7d,
            pullbackMin: 0.005, pullbackMax, resume6, stopFloor: 0.04, stopCap: 0.15, stopAtr: 6,
            rewardRisk, maxHoldHours, riskRate: 0.015, notionalMultiple: 0.5,
            minNotionalMultiple: 0.05, cooldownHours: 24 });
const configured = MODE === "deep-reversal" ? deepReversalConfigs
  : MODE === "adaptive-reversal" ? adaptivePolicies.map((adaptive) => ({ ...adaptiveBase,
    id: `adaptive-${adaptive.window}-${adaptive.profitFactor}-${adaptive.lossGuard}`, adaptive }))
    : MODE === "wide-risk" ? wideRiskConfigs
      : MODE === "macro-trend" ? macroTrendConfigs
        : MODE === "compression-specialist" ? compressionSpecialistConfigs
          : MODE === "macro-pullback" ? macroPullbackConfigs
            : MODE === "macro-range-fade" ? macroRangeFadeConfigs
              : MODE === "panic-reversal" ? panicReversalConfigs
                : MODE === "expansion-continuation" ? expansionContinuationConfigs
                  : MODE === "cross-momentum" ? crossMomentumConfigs
                    : MODE === "range-edge" ? rangeEdgeConfigs
                      : MODE === "failed-breakout" ? failedBreakoutConfigs
                        : MODE === "idiosyncratic-reversal" ? idiosyncraticReversalConfigs
                          : MODE === "relative-pullback" ? relativePullbackConfigs
                            : MODE === "regime-turn" ? regimeTurnConfigs
                              : MODE === "orderly-trend-relative" ? orderlyTrendRelativeConfigs
                                : MODE === "time-series-trail" ? timeSeriesTrailConfigs
                                  : MODE === "bull-leader-trail" ? bullLeaderTrailConfigs
                                    : MODE === "bull-dip-resume" ? bullDipResumeConfigs
      : MODE === "wide-selected" ? [wideRiskConfigs.find((config) => config.id === "wide-trend-0.05-0.04-3-2-24")]
        : broadConfigs;
const configId = process.env.RESEARCH_CONFIG_ID;
const selectedConfigs = configId ? configured.filter((config) => config.id === configId) : configured;
const withAuthority = process.env.RESEARCH_AUTHORITY === "three-or-six"
  ? selectedConfigs.map((config) => ({ ...config, id: `${config.id}-three-or-six`,
    adaptive: { kind: "three-or-six" } })) : selectedConfigs;
const configs = withAuthority.map((config) => ({ ...config,
  id: `${config.id}${SIDE === "BOTH" ? "" : `-${SIDE.toLowerCase()}`}` }));
if (!configs.length) throw new Error(`Research config not found: ${configId}`);

// Sample floors are fixed by event frequency, not relaxed after seeing results.
// Rare phase transitions naturally trade less often; frequent cross-sectional
// systems need substantially more observations before they can qualify.
function sampleRequirements(config) {
  let baseline;
  if (config.family === "COMPRESSION_BREAK" || config.family === "PANIC_REVERSAL"
    || config.family === "FAILED_BREAKOUT_REVERSAL") baseline = { discovery: 30, validation: 8, blind: 6 };
  else if (config.family === "MACRO_TREND" || config.family === "MACRO_PULLBACK_RESUME") {
    baseline = { discovery: 30, validation: 10, blind: 8 };
  } else if (config.family === "CROSS_SECTIONAL_MOMENTUM") baseline = { discovery: 100, validation: 20, blind: 20 };
  else baseline = { discovery: 50, validation: 15, blind: 15 };
  // Baselines describe the 30/8/6-month long-horizon split. Shorter official
  // datasets keep the same minimum observation rate instead of inheriting an
  // impossible absolute count.
  return { discovery: Math.ceil(baseline.discovery * discoveryMonths / 30),
    validation: Math.ceil(baseline.validation * validationMonths / 8),
    blind: Math.ceil(baseline.blind * blindMonths / 6) };
}

const discovery = [];
for (const config of configs) {
  const rawResult = rawTrades(config, discoveryEnd);
  const result = config.adaptive ? adaptivePortfolio(rawResult, config, config.adaptive) : portfolio(rawResult, config);
  const measured = metrics(result, fromMs, discoveryEnd);
  discovery.push({ config, measured });
  console.log(`${config.id}: ${measured.trades} trades ${measured.netPnl.toFixed(2)}U PF${measured.profitFactor.toFixed(2)} ${measured.positiveMonths}/${discoveryMonths} months`);
}
const discoveryEligible = (measured, config) => measured.trades >= sampleRequirements(config).discovery
  && measured.netPnl > 0
  && measured.profitFactor >= 1.15 && measured.maxDrawdown <= 0.20
  && measured.positiveMonths >= Math.ceil(measured.activeMonths * 0.60)
  && measured.positiveSixMonthBlocks >= Math.max(1, measured.sixMonthPnls.length - 1)
  && measured.worstSixMonthPnl >= -50
  && measured.largestPositiveSymbolShare <= 0.35;
const eligible = discovery.filter((row) => discoveryEligible(row.measured, row.config));
const specialistDiscoveryEligible = (measured, config) => measured.trades >= sampleRequirements(config).discovery
  && measured.netPnl > 0 && measured.profitFactor >= 1.10 && measured.maxDrawdown <= 0.20
  && measured.positiveMonths >= Math.ceil(measured.activeMonths * 0.40)
  && measured.positiveSixMonthBlocks >= Math.ceil(measured.sixMonthPnls.length / 2)
  && measured.worstSixMonthPnl >= -100 && measured.largestPositiveSymbolShare <= 0.45;
const specialistEligible = discovery.filter((row) => specialistDiscoveryEligible(row.measured, row.config));
const rankScore = (row) => row.measured.positiveSixMonthBlocks * 1_000_000
  + row.measured.worstSixMonthPnl * 1_000 + row.measured.positiveMonths * 100
  + row.measured.netPnl - row.measured.maxDrawdown * 2_000;
eligible.sort((left, right) => rankScore(right) - rankScore(left));
specialistEligible.sort((left, right) => rankScore(right) - rankScore(left));
const selected = configId ? discovery[0]
  : SELECTION === "specialist" ? (specialistEligible[0] ?? null) : (eligible[0] ?? null);
let final = null;
if (selected) {
  const baseTrades = rawTrades(selected.config, toMs);
  const buildPortfolio = (trades) => selected.config.adaptive
    ? adaptivePortfolio(trades, selected.config, selected.config.adaptive) : portfolio(trades, selected.config);
  const account = buildPortfolio(baseTrades);
  const stressedAccount = buildPortfolio(rawTrades(selected.config, toMs, STRESS_FRICTION));
  const adverseAccount = buildPortfolio(rawTrades(selected.config, toMs, FRICTION, ENTRY_SLIPPAGE * 2));
  const period = (result, start, end, extra = 0) => metrics(result, start, end, extra);
  final = { config: selected.config,
    discovery: period(account, fromMs, discoveryEnd), validation: period(account, discoveryEnd, validationEnd),
    blind: period(account, validationEnd, toMs), full: period(account, fromMs, toMs),
    higherCost: { discovery: period(stressedAccount, fromMs, discoveryEnd),
      validation: period(stressedAccount, discoveryEnd, validationEnd), blind: period(stressedAccount, validationEnd, toMs),
      full: period(stressedAccount, fromMs, toMs) },
    doubledAdverseEntry: { discovery: period(adverseAccount, fromMs, discoveryEnd),
      validation: period(adverseAccount, discoveryEnd, validationEnd), blind: period(adverseAccount, validationEnd, toMs),
      full: period(adverseAccount, fromMs, toMs) },
    ...(INCLUDE_TRADES ? { trades: account.trades } : {}) };
  const positive = (value, pf) => value.netPnl > 0 && value.profitFactor >= pf
    && (SELECTION === "specialist" ? value.trades > 0
      : value.activeMonths >= 3 && value.positiveMonths >= Math.ceil(value.activeMonths / 2));
  const minimumSamples = sampleRequirements(selected.config);
  final.gates = { discoveryRobustness: SELECTION === "specialist"
      ? specialistDiscoveryEligible(final.discovery, selected.config) : discoveryEligible(final.discovery, selected.config),
    sampleSize: final.discovery.trades >= minimumSamples.discovery
      && final.validation.trades >= minimumSamples.validation && final.blind.trades >= minimumSamples.blind,
    discovery: positive(final.discovery, SELECTION === "specialist" ? 1.10 : 1.15),
    validation: positive(final.validation, 1.10),
    blind: positive(final.blind, 1.10),
    majorityMonths: final.full.positiveMonths >= Math.ceil(final.full.activeMonths
      * (SELECTION === "specialist" ? 0.40 : 0.60)),
    drawdown: final.full.maxDrawdown <= 0.20,
    concentration: final.full.largestPositiveSymbolShare <= (SELECTION === "specialist" ? 0.45 : 0.35),
    higherCost: positive(final.higherCost.validation, 1.03)
      && positive(final.higherCost.blind, 1.03),
    doubledAdverseEntry: positive(final.doubledAdverseEntry.validation, 1.03)
      && positive(final.doubledAdverseEntry.blind, 1.03) };
  final.accepted = Object.values(final.gates).every(Boolean);
}

const report = { generatedAt: new Date().toISOString(), mode: MODE, side: SIDE, selection: SELECTION,
  decision: final?.accepted ? (SELECTION === "specialist" ? "PORTFOLIO_COMPONENT_CANDIDATE" : "RELEASE_CANDIDATE") : "NO_RELEASE",
  dataset: { source: raw.source, sha256: raw.sha256, months: raw.months, symbols: raw.symbols,
    candles: sum(raw.datasets.map((item) => item.rows.length)),
    coverage: raw.datasets.map((item) => ({ symbol: item.symbol, coverage: item.coverage, gaps: item.gaps })) },
  split: { discoveryMonths, validationMonths, blindMonths,
    discoveryEnd: new Date(discoveryEnd).toISOString(), validationEnd: new Date(validationEnd).toISOString() },
  assumptions: { completedCandlesOnly: true, interval: raw.interval,
    executionInterval: executionRaw?.interval ?? raw.interval, decisionCadence: "hourly", side: SIDE,
    entry: `next ${raw.interval} open plus 0.025% adverse`,
    friction: FRICTION, stopFirstWithinCandle: true, fundingAndHistoricalBookUnavailable: true },
  discoverySelection: { candidates: configs.length, eligible: eligible.length,
    specialistEligible: specialistEligible.length, selected: selected?.config.id ?? null,
    leaderboard: eligible.slice(0, 10).map((row) => ({ id: row.config.id, ...row.measured })),
    specialistLeaderboard: specialistEligible.slice(0, 10).map((row) => ({ id: row.config.id, ...row.measured })) }, final };
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, decision: report.decision, eligible: eligible.length,
  selected: selected?.config.id ?? null, final: final ? { discovery: final.discovery, validation: final.validation,
    blind: final.blind, full: final.full, gates: final.gates, accepted: final.accepted } : null }, null, 2));
