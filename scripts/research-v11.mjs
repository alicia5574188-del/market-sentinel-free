import { readFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/all-regime-candles.json";
const FRICTION = 0.0014;
const ENTRY_SLIPPAGE = 0.00025;
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
const datasets = raw.datasets;
const symbols = raw.symbols;
const from = raw.now - raw.days * 86_400;
const split = (from + (raw.now - from) / 2) * 1_000;

const median = (values) => {
  if (!values.length) return 0;
  const rows = [...values].sort((a, b) => a - b);
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const efficiency = (rows) => Math.abs(rows.at(-1).close - rows[0].open)
  / Math.max(rows.slice(1).reduce((total, row, index) => total + Math.abs(row.close - rows[index].close), 0), rows.at(-1).close * 1e-7);
const signFor = (side) => side === "LONG" ? 1 : -1;
const priceBin = (price) => Math.round(Math.log(Math.max(price, 1e-12)) / Math.log(1.001));
const valid = (route) => route && (route.side === "LONG"
  ? route.stop < route.trigger && route.arm > route.trigger
  : route.stop > route.trigger && route.arm < route.trigger);

const marketMoves = new Map();
for (const { rows } of datasets) for (let index = 6; index < rows.length; index += 1) {
  const values = marketMoves.get(rows[index].time) ?? [];
  values.push(rows[index].close / rows[index - 6].close - 1);
  marketMoves.set(rows[index].time, values);
}
const contexts = new Map([...marketMoves].map(([time, values]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return [time, { breadth: values.filter((value) => value > 0).length / values.length,
    medianMove: ordered[Math.floor(ordered.length / 2)] ?? 0, markets: values.length }];
}));

function route(name, environment, side, trigger, stop, arm, at, reason, maxBars, noProgressBars, exitStyle = "RUNNER") {
  const candidate = { name, environment, side, trigger, stop, arm, at, reason, maxBars, noProgressBars, exitStyle,
    id: `${name}:${side}:${priceBin(stop)}:${at}` };
  return valid(candidate) ? candidate : null;
}

function trendConfluence(rows, context, config) {
  const base = rows.slice(-config.window);
  const latest = base.at(-1);
  const direction = latest.close >= base[0].open ? 1 : -1;
  const side = direction > 0 ? "LONG" : "SHORT";
  const broad = direction > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  const unit = median(base.slice(-24).map((row) => row.high - row.low));
  const path = efficiency(base.slice(0, -1));
  const displacement = direction * (base.at(-2).close - base[0].open);
  const pause = base.slice(-config.pause - 1, -1);
  const counter = pause.some((row, index) => index && direction * (row.close - pause[index - 1].close) < 0);
  const pauseExtreme = direction > 0 ? Math.min(...pause.map((row) => row.low)) : Math.max(...pause.map((row) => row.high));
  const resumeLevel = direction > 0 ? Math.max(...pause.map((row) => row.close)) : Math.min(...pause.map((row) => row.close));
  const resumed = direction > 0 ? latest.close > resumeLevel : latest.close < resumeLevel;
  const body = Math.abs(latest.close - latest.open) / Math.max(latest.high - latest.low, unit * .15);
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (!broad || path < config.efficiency || displacement < unit * config.displacement || !counter || !resumed
    || body < config.body || closeLocation < config.closeLocation) return null;
  const stop = direction > 0 ? pauseExtreme - unit * config.stopPad : pauseExtreme + unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return route("势承·合流", "TREND", side, latest.close, stop, latest.close + direction * risk * config.armR,
    latest.time, `全市场与单币路径同向，短暂逆向耗尽后完成段重新接回主方向。`, config.maxBars, config.noProgressBars);
}

function balanceDoubleReclaim(rows, context, config) {
  const base = rows.slice(-config.window);
  const latest = base.at(-1);
  const prior = base.slice(0, -config.recent);
  const recent = base.slice(-config.recent);
  const unit = median(prior.slice(-36).map((row) => row.high - row.low));
  const lower = Math.min(...prior.map((row) => row.low));
  const upper = Math.max(...prior.map((row) => row.high));
  const width = upper - lower;
  const neutral = context.breadth >= config.breadthLow && context.breadth <= config.breadthHigh
    && Math.abs(context.medianMove) <= config.marketMove;
  const crossings = prior.slice(1).filter((row, index) => (row.close >= (lower + upper) / 2) !== (prior[index].close >= (lower + upper) / 2)).length;
  const lowBand = lower + width * config.edge;
  const highBand = upper - width * config.edge;
  const lowTouches = recent.filter((row) => row.low <= lowBand).length;
  const highTouches = recent.filter((row) => row.high >= highBand).length;
  const longReclaim = lowTouches >= config.touches && recent.at(-2).close <= lowBand && latest.close > lowBand && latest.close > latest.open;
  const shortReclaim = highTouches >= config.touches && recent.at(-2).close >= highBand && latest.close < highBand && latest.close < latest.open;
  if (!neutral || efficiency(prior) > config.efficiency || width < unit * config.width || crossings < config.crossings
    || (!longReclaim && !shortReclaim)) return null;
  const side = longReclaim ? "LONG" : "SHORT";
  const direction = signFor(side);
  const extreme = side === "LONG" ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = extreme - direction * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  const center = (lower + upper) / 2;
  const structuralArm = latest.close + direction * risk * config.armR;
  const arm = side === "LONG" ? Math.min(center, structuralArm) : Math.max(center, structuralArm);
  return route("衡返·双拒", "RANGE", side, latest.close, stop, arm, latest.time,
    `全市场中性，价格两次拒绝平衡带外沿后由完成段收回。`, config.maxBars, config.noProgressBars);
}

function compressionPulse(rows, context, config) {
  const latest = rows.at(-1);
  const box = rows.slice(-config.box - 1, -1);
  const prior = rows.slice(-config.box - config.prior - 1, -config.box - 1);
  const unit = median(prior.map((row) => row.high - row.low));
  const boxUnit = median(box.map((row) => row.high - row.low));
  const upper = Math.max(...box.map((row) => row.high));
  const lower = Math.min(...box.map((row) => row.low));
  const up = latest.close > upper && latest.close > latest.open;
  const down = latest.close < lower && latest.close < latest.open;
  if (!up && !down) return null;
  const direction = up ? 1 : -1;
  const side = up ? "LONG" : "SHORT";
  const broadAligned = direction > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  const body = Math.abs(latest.close - latest.open);
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (!broadAligned || boxUnit > unit * config.compression || latest.high - latest.low < unit * config.expansion
    || body < (latest.high - latest.low) * config.body || closeLocation < config.closeLocation) return null;
  const stop = direction > 0 ? lower - boxUnit * config.stopPad : upper + boxUnit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return route("压跃·共振", "COMPRESSION", side, latest.close, stop, latest.close + direction * risk * config.armR,
    latest.time, `完成段从收束盒首次释放，并与全市场方向同步。`, config.maxBars, config.noProgressBars);
}

function compressionFalseRelease(rows, context, config) {
  const latest = rows.at(-1);
  const release = rows.at(-2);
  const box = rows.slice(-config.box - 2, -2);
  const prior = rows.slice(-config.box - config.prior - 2, -config.box - 2);
  const unit = median(prior.map((row) => row.high - row.low));
  const boxUnit = median(box.map((row) => row.high - row.low));
  const upper = Math.max(...box.map((row) => row.high));
  const lower = Math.min(...box.map((row) => row.low));
  const upRelease = release.close > upper && release.close > release.open;
  const downRelease = release.close < lower && release.close < release.open;
  if (!upRelease && !downRelease) return null;
  const releaseDirection = upRelease ? 1 : -1;
  const broadConfirmed = releaseDirection > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  const reentered = upRelease ? latest.close < upper && latest.close < latest.open
    : latest.close > lower && latest.close > latest.open;
  const closeLocation = upRelease ? (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12);
  if (broadConfirmed || !reentered || boxUnit > unit * config.compression
    || closeLocation < config.closeLocation) return null;
  const side = upRelease ? "SHORT" : "LONG";
  const sign = signFor(side);
  const extreme = upRelease ? Math.max(release.high, latest.high) : Math.min(release.low, latest.low);
  const stop = extreme - sign * boxUnit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return route("压返·失释", "COMPRESSION", side, latest.close, stop,
    latest.close + sign * risk * config.armR, latest.time,
    `收束盒释放未获全市场确认，下一完成段回到盒内，反向接回压力中心。`,
    config.maxBars, config.noProgressBars);
}

function exhaustionReclaim(rows, context, config) {
  const base = rows.slice(-config.window);
  const latest = base.at(-1);
  const early = base.slice(0, -config.late);
  const late = base.slice(-config.late);
  const unit = median(base.slice(-48).map((row) => row.high - row.low));
  const direction = early.at(-1).close >= early[0].open ? 1 : -1;
  const displacement = Math.abs(early.at(-1).close - early[0].open);
  const travel = late.slice(1, -1).reduce((total, row, index) => total + Math.abs(row.close - late[index].close), 0);
  const progress = direction * (late.at(-2).close - late[0].open) / Math.max(travel, unit);
  const reversal = direction > 0 ? latest.close < late.at(-2).open && latest.close < latest.open
    : latest.close > late.at(-2).open && latest.close > latest.open;
  const extreme = direction > 0 ? Math.max(...late.map((row) => row.high)) : Math.min(...late.map((row) => row.low));
  const newExtreme = direction > 0 ? extreme >= Math.max(...early.map((row) => row.high)) : extreme <= Math.min(...early.map((row) => row.low));
  if (efficiency(early) < config.efficiency || displacement < unit * config.displacement || progress >= config.progress
    || !reversal || !newExtreme) return null;
  let side = direction > 0 ? "SHORT" : "LONG";
  let label = "竭转·孤返";
  const neutral = context.breadth >= config.neutralLow && context.breadth <= config.neutralHigh
    && Math.abs(context.medianMove) <= config.neutralMove;
  const crowded = side === "LONG"
    ? context.breadth <= config.crowdedLow && context.medianMove <= -config.crowdedMove
    : context.breadth >= 1 - config.crowdedLow && context.medianMove >= config.crowdedMove;
  if (!neutral && !crowded) return null;
  if (crowded) { side = side === "LONG" ? "SHORT" : "LONG"; label = "势承·逆竭"; }
  const sign = signFor(side);
  const stop = side === (direction > 0 ? "SHORT" : "LONG") ? extreme - sign * unit * config.stopPad
    : latest.close - sign * Math.max(Math.abs(latest.close - extreme), unit) * config.continuationStop;
  const risk = Math.abs(latest.close - stop);
  return route(label, crowded ? "TREND" : "EXHAUSTION", side, latest.close, stop,
    latest.close + sign * risk * (crowded ? config.crowdedArmR : config.neutralArmR), latest.time,
    crowded ? `单币表面衰竭未获拥挤市场确认，继续全市场主方向。` : `全市场中性，单币末段推进枯竭并反向收复。`,
    crowded ? config.crowdedMaxBars : config.neutralMaxBars,
    crowded ? config.crowdedNoProgressBars : config.neutralNoProgressBars);
}

function resolveTrade(symbol, rows, index, signal) {
  if (index + 1 >= rows.length) return null;
  const sign = signFor(signal.side);
  const entry = rows[index + 1].open * (1 + sign * ENTRY_SLIPPAGE);
  const stopRate = Math.abs(signal.trigger - signal.stop) / signal.trigger;
  const armRate = Math.abs(signal.arm - signal.trigger) / signal.trigger;
  const stop = entry * (1 - sign * stopRate);
  const arm = entry * (1 + sign * armRate);
  const risk = Math.abs(entry - stop);
  let activeStop = stop;
  let armed = false;
  let best = 0;
  for (let offset = 1; offset <= signal.maxBars && index + offset < rows.length; offset += 1) {
    const row = rows[index + offset];
    best = Math.max(best, signal.side === "LONG" ? row.high - entry : entry - row.low);
    const stopHit = signal.side === "LONG" ? row.low <= activeStop : row.high >= activeStop;
    const armHit = signal.side === "LONG" ? row.high >= arm : row.low <= arm;
    let exit = null;
    let outcome = null;
    if (stopHit) { exit = activeStop; outcome = armed ? "RUNNER_EXIT" : "STOP"; }
    else if (armHit && signal.exitStyle === "BALANCE") { exit = arm; outcome = "BALANCE"; }
    else if (armHit) armed = true;
    if (exit == null && armed) {
      const protectedMove = Math.max(risk * .22, (best - risk) * .55);
      activeStop = signal.side === "LONG" ? Math.max(activeStop, entry + protectedMove) : Math.min(activeStop, entry - protectedMove);
    }
    if (exit == null && !armed && offset >= signal.noProgressBars && best < risk * .45) { exit = row.close; outcome = "NO_PROGRESS"; }
    if (exit == null && offset === signal.maxBars) { exit = row.close; outcome = "TIMEOUT"; }
    if (exit != null) {
      const netReturnRate = sign * (exit - entry) / entry - FRICTION;
      return { symbol, strategy: signal.name, environment: signal.environment, side: signal.side,
        openedAt: rows[index + 1].time * 1_000, closedAt: row.time * 1_000, netReturnRate,
        riskRate: Math.abs(entry - stop) / entry, won: netReturnRate > 0, outcome };
    }
  }
  return null;
}

function economicsPass(rows, index, signal) {
  const sign = signFor(signal.side);
  const entry = rows[index + 1]?.open * (1 + sign * ENTRY_SLIPPAGE);
  if (!(entry > 0)) return false;
  const stopRate = Math.abs(signal.trigger - signal.stop) / signal.trigger;
  const armRate = Math.abs(signal.arm - signal.trigger) / signal.trigger;
  const extension = Math.abs(entry - signal.trigger) / signal.trigger;
  const rr = (armRate - FRICTION) / Math.max(stopRate + FRICTION, 1e-9);
  return extension <= Math.max(stopRate * .65, .0008) && stopRate >= FRICTION
    && FRICTION / Math.max(armRate, 1e-9) <= .25 && rr >= 1.2;
}

function generate(detector, config) {
  const trades = [];
  for (const { symbol, rows } of datasets) {
    let busyUntil = 0;
    for (let index = 120; index < rows.length - 1; index += 1) {
      if (rows[index].time <= busyUntil) continue;
      const context = contexts.get(rows[index].time);
      if (!context || context.markets < 12) continue;
      const signal = detector(rows.slice(index - 119, index + 1), context, config);
      if (!signal || !economicsPass(rows, index, signal)) continue;
      const trade = resolveTrade(symbol, rows, index, signal);
      if (!trade) continue;
      trades.push(trade); busyUntil = trade.closedAt / 1_000;
    }
  }
  return trades;
}

function metrics(trades) {
  const gain = trades.filter((row) => row.netReturnRate > 0).reduce((sum, row) => sum + row.netReturnRate, 0);
  const loss = Math.abs(trades.filter((row) => row.netReturnRate <= 0).reduce((sum, row) => sum + row.netReturnRate, 0));
  const days = new Map();
  for (const row of trades) {
    const day = new Date(row.closedAt).toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + row.netReturnRate);
  }
  return { trades: trades.length, wins: trades.filter((row) => row.won).length,
    winRate: trades.length ? trades.filter((row) => row.won).length / trades.length : 0,
    net: trades.reduce((sum, row) => sum + row.netReturnRate, 0),
    mean: trades.length ? trades.reduce((sum, row) => sum + row.netReturnRate, 0) / trades.length : 0,
    pf: loss ? gain / loss : gain ? 99 : 0, activeDays: days.size,
    positiveDays: [...days.values()].filter((value) => value > 0).length };
}

function evaluate(name, detector, variants) {
  const results = variants.map((config, index) => {
    const trades = generate(detector, config);
    return { name, index, config, train: metrics(trades.filter((row) => row.openedAt < split)),
      validation: metrics(trades.filter((row) => row.openedAt >= split)), trades };
  }).sort((left, right) => Math.min(right.train.pf, right.validation.pf) - Math.min(left.train.pf, left.validation.pf));
  console.table(results.map(({ name: strategy, index, train, validation }) => ({ strategy, index,
    trainN: train.trades, trainPF: train.pf.toFixed(2), trainNet: (train.net * 100).toFixed(2),
    valN: validation.trades, valPF: validation.pf.toFixed(2), valNet: (validation.net * 100).toFixed(2),
    valWin: (validation.winRate * 100).toFixed(1), valDays: `${validation.positiveDays}/${validation.activeDays}` })));
  if (name === "衰竭双路") {
    const best = results[0]?.trades ?? [];
    console.table([...new Set(best.map((row) => row.strategy))].map((strategy) => ({ strategy,
      train: metrics(best.filter((row) => row.strategy === strategy && row.openedAt < split)),
      validation: metrics(best.filter((row) => row.strategy === strategy && row.openedAt >= split)),
    })).map((row) => ({ strategy: row.strategy, trainN: row.train.trades, trainPF: row.train.pf.toFixed(2),
      trainNet: (row.train.net * 100).toFixed(2), valN: row.validation.trades, valPF: row.validation.pf.toFixed(2),
      valNet: (row.validation.net * 100).toFixed(2), valWin: (row.validation.winRate * 100).toFixed(1) })));
  }
  return results;
}

const trend = evaluate("势承·合流", trendConfluence, [
  { window: 36, pause: 4, breadth: .62, marketMove: .0012, efficiency: .34, displacement: 4.5, body: .45, closeLocation: .65, stopPad: .25, armR: 2, maxBars: 36, noProgressBars: 8 },
  { window: 42, pause: 5, breadth: .65, marketMove: .0015, efficiency: .38, displacement: 5.2, body: .50, closeLocation: .70, stopPad: .35, armR: 2.2, maxBars: 48, noProgressBars: 10 },
  { window: 30, pause: 3, breadth: .60, marketMove: .001, efficiency: .32, displacement: 4.0, body: .40, closeLocation: .62, stopPad: .20, armR: 1.8, maxBars: 30, noProgressBars: 7 },
]);
const range = evaluate("衡返·双拒", balanceDoubleReclaim, [
  { window: 54, recent: 4, breadthLow: .38, breadthHigh: .62, marketMove: .0015, efficiency: .26, width: 6, crossings: 3, edge: .20, touches: 2, stopPad: .3, armR: 2, maxBars: 24, noProgressBars: 7 },
  { window: 66, recent: 5, breadthLow: .40, breadthHigh: .60, marketMove: .0012, efficiency: .22, width: 7, crossings: 4, edge: .18, touches: 2, stopPad: .4, armR: 1.8, maxBars: 30, noProgressBars: 8 },
  { window: 48, recent: 3, breadthLow: .35, breadthHigh: .65, marketMove: .002, efficiency: .30, width: 5.5, crossings: 2, edge: .22, touches: 2, stopPad: .25, armR: 2.2, maxBars: 20, noProgressBars: 6 },
]);
const compression = evaluate("压返·失释", compressionFalseRelease, [
  { box: 18, prior: 29, breadth: .62, marketMove: .0012, compression: .76, closeLocation: .62, stopPad: .3, armR: 1.75, maxBars: 24, noProgressBars: 7 },
  { box: 14, prior: 28, breadth: .65, marketMove: .0015, compression: .68, closeLocation: .68, stopPad: .4, armR: 1.9, maxBars: 30, noProgressBars: 8 },
  { box: 22, prior: 36, breadth: .6, marketMove: .001, compression: .8, closeLocation: .58, stopPad: .25, armR: 1.6, maxBars: 20, noProgressBars: 6 },
]);
const rejectedCompression = evaluate("压跃·共振", compressionPulse, [
  { box: 18, prior: 29, breadth: .62, marketMove: .0012, compression: .72, expansion: 1.35, body: .55, closeLocation: .70, stopPad: .25, armR: 2, maxBars: 30, noProgressBars: 7 },
  { box: 14, prior: 28, breadth: .65, marketMove: .0015, compression: .65, expansion: 1.5, body: .60, closeLocation: .75, stopPad: .3, armR: 2.2, maxBars: 36, noProgressBars: 8 },
  { box: 22, prior: 36, breadth: .60, marketMove: .001, compression: .78, expansion: 1.25, body: .50, closeLocation: .65, stopPad: .2, armR: 1.8, maxBars: 24, noProgressBars: 6 },
]);
const exhaustion = evaluate("衰竭双路", exhaustionReclaim, [
  { window: 28, late: 5, efficiency: .42, displacement: 4.4, progress: .24, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .3, continuationStop: 1, neutralArmR: 1.75, crowdedArmR: 1.75, neutralMaxBars: 24, crowdedMaxBars: 36, neutralNoProgressBars: 7, crowdedNoProgressBars: 9 },
]);

const selectedRange = range.find((row) => row.index === 1);
const exhaustionTrades = exhaustion[0]?.trades ?? [];
const branchMetric = (name, beforeSplit) => metrics(exhaustionTrades.filter((row) => row.strategy === name
  && (beforeSplit ? row.openedAt < split : row.openedAt >= split)));
const carryTrain = branchMetric("势承·逆竭", true);
const carryValidation = branchMetric("势承·逆竭", false);
const turnValidation = branchMetric("竭转·孤返", false);
const acceptance = raw.days >= 30 && symbols.length >= 20
  && selectedRange?.train.pf > 1 && selectedRange.validation.pf > 1
  && carryTrain.pf > 1 && carryValidation.pf > 1 && turnValidation.pf > 1
  && exhaustion[0]?.train.pf > 1 && exhaustion[0].validation.pf > 1;
if (!acceptance) {
  throw new Error("V11 route acceptance failed: an account-authorized branch lost its after-cost evidence");
}
console.log(`V11_ACCEPTANCE_PASS rangePF=${selectedRange.train.pf.toFixed(2)}/${selectedRange.validation.pf.toFixed(2)} carryPF=${carryTrain.pf.toFixed(2)}/${carryValidation.pf.toFixed(2)} turnValidationPF=${turnValidation.pf.toFixed(2)}`);

const compact = (rows) => rows.map((row) => ({ name: row.name, index: row.index, config: row.config,
  train: row.train, validation: row.validation }));
console.log(`V11_RESEARCH_JSON=${JSON.stringify({ generatedAt: new Date().toISOString(), days: raw.days, symbols,
  splitAt: new Date(split).toISOString(), trend: compact(trend), range: compact(range),
  compression: compact(compression), rejectedCompression: compact(rejectedCompression), exhaustion: compact(exhaustion) })}`);
