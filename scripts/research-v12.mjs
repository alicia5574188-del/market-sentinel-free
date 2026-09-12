import { readFileSync } from "node:fs";
import { buildStrategyCoverageReport } from "../lib/strategy-coverage.ts";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/all-regime-candles.json";
const FRICTION = 0.0014;
const ENTRY_SLIPPAGE = 0.00025;
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
const datasets = raw.datasets;
const fromMs = (raw.now - raw.days * 86_400) * 1_000;
const spanMs = raw.days * 86_400_000 / 3;
const signFor = (side) => side === "LONG" ? 1 : -1;
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const efficiency = (rows) => Math.abs(rows.at(-1).close - rows[0].open)
  / Math.max(rows.slice(1).reduce((total, row, index) => total + Math.abs(row.close - rows[index].close), 0), rows.at(-1).close * 1e-7);

function stateAt(rows, context) {
  const latest = rows.at(-1);
  const trend = rows.slice(-24);
  const location = rows.slice(-48);
  const recentRanges = rows.slice(-6).map((row) => row.high - row.low);
  const priorRanges = rows.slice(-30, -6).map((row) => row.high - row.low);
  const lower = Math.min(...location.map((row) => row.low));
  const upper = Math.max(...location.map((row) => row.high));
  return {
    trendRate: latest.close / trend[0].open - 1,
    trendEfficiency: efficiency(trend),
    volatilityRatio: median(recentRanges) / Math.max(median(priorRanges), latest.close * 1e-9),
    rangePosition: (latest.close - lower) / Math.max(upper - lower, latest.close * 1e-9),
    marketBreadth: context.breadth,
    marketMedianMove: context.medianMove,
  };
}

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

function tideRelay(rows, context, config) {
  const latest = rows.at(-1);
  const path = rows.slice(-config.path);
  const preResume = path.slice(0, -1);
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const broadDirection = context.medianMove > 0 ? 1 : -1;
  const broadStrong = broadDirection > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  if (!broadStrong) return null;
  const earlier = preResume.slice(0, -config.lag);
  const lag = preResume.slice(-config.lag);
  const alignedDisplacement = broadDirection * (earlier.at(-1).close - earlier[0].open);
  const lagMove = broadDirection * (lag.at(-1).close - lag[0].open);
  const latestBody = broadDirection * (latest.close - latest.open);
  const reclaim = broadDirection > 0
    ? latest.close > Math.max(...lag.map((row) => row.close))
    : latest.close < Math.min(...lag.map((row) => row.close));
  const closeLocation = broadDirection > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (efficiency(earlier) < config.efficiency || alignedDisplacement < unit * config.displacement
    || lagMove > -unit * config.lagMove || latestBody < unit * config.body || !reclaim
    || closeLocation < config.closeLocation) return null;
  const side = broadDirection > 0 ? "LONG" : "SHORT";
  const lagExtreme = broadDirection > 0 ? Math.min(...lag.map((row) => row.low)) : Math.max(...lag.map((row) => row.high));
  const stop = broadDirection > 0 ? lagExtreme - unit * config.stopPad : lagExtreme + unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { name: "潮接", environment: "TREND", side, trigger: latest.close, stop,
    arm: latest.close + broadDirection * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function quietOrbit(rows, context, config) {
  const latest = rows.at(-1);
  const base = rows.slice(-config.window);
  const prior = base.slice(0, -config.recent);
  const recent = base.slice(-config.recent);
  const unit = median(prior.slice(-24).map((row) => row.high - row.low));
  const olderUnit = median(rows.slice(-config.window - 24, -config.window).map((row) => row.high - row.low));
  const lower = Math.min(...prior.map((row) => row.low));
  const upper = Math.max(...prior.map((row) => row.high));
  const width = upper - lower;
  const center = (lower + upper) / 2;
  const neutral = context.breadth >= config.breadthLow && context.breadth <= config.breadthHigh
    && Math.abs(context.medianMove) <= config.marketMove;
  const quiet = unit <= olderUnit * config.quietRatio;
  const drift = recent.slice(0, -1);
  const lowerBand = lower + width * config.edge;
  const upperBand = upper - width * config.edge;
  const downDrift = drift.every((row, index) => index === 0 || row.close <= drift[index - 1].close)
    && Math.min(...drift.map((row) => row.low)) <= lowerBand;
  const upDrift = drift.every((row, index) => index === 0 || row.close >= drift[index - 1].close)
    && Math.max(...drift.map((row) => row.high)) >= upperBand;
  const longTurn = downDrift && latest.close > latest.open && latest.close > drift.at(-1).close;
  const shortTurn = upDrift && latest.close < latest.open && latest.close < drift.at(-1).close;
  const sideSign = longTurn ? 1 : shortTurn ? -1 : 0;
  const subtleAlignment = !config.align || (sideSign > 0
    ? context.breadth >= (config.alignBreadth ?? .5) && context.medianMove >= (config.alignMove ?? 0)
    : context.breadth <= 1 - (config.alignBreadth ?? .5) && context.medianMove <= -(config.alignMove ?? 0));
  if (!neutral || !quiet || efficiency(prior) > config.efficiency || width < unit * config.width
    || !subtleAlignment
    || longTurn === shortTurn) return null;
  const side = longTurn ? "LONG" : "SHORT";
  const sign = signFor(side);
  const extreme = side === "LONG" ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = extreme - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  const structuralArm = latest.close + sign * risk * config.armR;
  const arm = side === "LONG" ? Math.min(center, structuralArm) : Math.max(center, structuralArm);
  return { name: "静旋", environment: "RANGE", side, trigger: latest.close, stop, arm,
    maxBars: config.maxBars, noProgressBars: config.noProgressBars, at: latest.time };
}

function tideCatchup(rows, context, config) {
  const latest = rows.at(-1);
  const direction = context.medianMove > 0 ? 1 : -1;
  const broadStrong = direction > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  if (!broadStrong) return null;
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const lagRows = rows.slice(-config.lag - 1, -1);
  const lagMove = (lagRows.at(-1).close - lagRows[0].open) / lagRows[0].open;
  const relativeLag = direction * (context.medianMove - lagMove);
  const resumeRows = rows.slice(-config.resume);
  const alignedCloses = resumeRows.slice(1).filter((row, index) => direction * (row.close - resumeRows[index].close) > 0).length;
  const body = direction * (latest.close - latest.open);
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  const localRange = rows.slice(-config.range);
  const position = (latest.close - Math.min(...localRange.map((row) => row.low)))
    / Math.max(Math.max(...localRange.map((row) => row.high)) - Math.min(...localRange.map((row) => row.low)), 1e-12);
  const room = direction > 0 ? position <= config.maxPosition : position >= 1 - config.maxPosition;
  if (relativeLag < config.relativeLag || alignedCloses < config.alignedCloses || body < unit * config.body
    || closeLocation < config.closeLocation || !room) return null;
  const side = direction > 0 ? "LONG" : "SHORT";
  const extreme = direction > 0 ? Math.min(...lagRows.map((row) => row.low)) : Math.max(...lagRows.map((row) => row.high));
  const stop = direction > 0 ? extreme - unit * config.stopPad : extreme + unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { name: "潮补", environment: "TREND", side, trigger: latest.close, stop,
    arm: latest.close + direction * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function quietDrift(rows, context, config) {
  const latest = rows.at(-1);
  const recent = rows.slice(-config.recent);
  const prior = rows.slice(-config.prior - config.recent, -config.recent);
  const recentUnit = median(recent.map((row) => row.high - row.low));
  const priorUnit = median(prior.map((row) => row.high - row.low));
  const direction = recent.at(-2).close >= recent[0].open ? 1 : -1;
  const net = direction * (recent.at(-2).close - recent[0].open);
  const aligned = recent.slice(1, -1).filter((row, index) => direction * (row.close - recent[index].close) > 0).length;
  const quietMarket = Math.abs(context.medianMove) <= config.marketMove;
  const resumed = direction > 0 ? latest.close > Math.max(...recent.slice(0, -1).map((row) => row.close))
    : latest.close < Math.min(...recent.slice(0, -1).map((row) => row.close));
  const body = direction * (latest.close - latest.open);
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (!quietMarket || recentUnit > priorUnit * config.quietRatio || efficiency(recent.slice(0, -1)) < config.efficiency
    || net < recentUnit * config.displacement || aligned < config.aligned || !resumed
    || body < recentUnit * config.body || closeLocation < config.closeLocation) return null;
  const side = direction > 0 ? "LONG" : "SHORT";
  const extreme = direction > 0 ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = direction > 0 ? extreme - recentUnit * config.stopPad : extreme + recentUnit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { name: "静移", environment: "COMPRESSION", side, trigger: latest.close, stop,
    arm: latest.close + direction * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function impulseRecoil(rows, context, config) {
  const latest = rows.at(-1);
  const impulse = rows.at(-2);
  const prior = rows.slice(-config.prior - 2, -2);
  const unit = median(prior.map((row) => row.high - row.low));
  const direction = impulse.close >= impulse.open ? 1 : -1;
  const impulseRange = impulse.high - impulse.low;
  const impulseBody = Math.abs(impulse.close - impulse.open);
  const broadConfirmed = direction > 0
    ? context.breadth >= config.breadth && context.medianMove >= config.marketMove
    : context.breadth <= 1 - config.breadth && context.medianMove <= -config.marketMove;
  const retrace = direction > 0 ? (impulse.close - latest.close) / Math.max(impulseBody, 1e-12)
    : (latest.close - impulse.close) / Math.max(impulseBody, 1e-12);
  const reversed = direction > 0 ? latest.close < latest.open : latest.close > latest.open;
  const closeLocation = direction > 0 ? (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12);
  if (broadConfirmed || impulseRange < unit * config.range || impulseBody < impulseRange * config.body
    || !reversed || retrace < config.retrace || closeLocation < config.closeLocation) return null;
  const side = direction > 0 ? "SHORT" : "LONG";
  const sign = signFor(side);
  const extreme = direction > 0 ? Math.max(impulse.high, latest.high) : Math.min(impulse.low, latest.low);
  const stop = extreme - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { name: "冲衡", environment: "EXPANSION", side, trigger: latest.close, stop,
    arm: latest.close + sign * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function compressionHold(rows, context, config) {
  const latest = rows.at(-1);
  const retest = rows.at(-2);
  const release = rows.at(-3);
  const box = rows.slice(-config.box - 3, -3);
  const prior = rows.slice(-config.box - config.prior - 3, -config.box - 3);
  const boxUnit = median(box.map((row) => row.high - row.low));
  const priorUnit = median(prior.map((row) => row.high - row.low));
  const upper = Math.max(...box.map((row) => row.high));
  const lower = Math.min(...box.map((row) => row.low));
  const up = release.close > upper && release.close > release.open;
  const down = release.close < lower && release.close < release.open;
  if (!up && !down) return null;
  const direction = up ? 1 : -1;
  const releaseRange = release.high - release.low;
  const releaseBody = Math.abs(release.close - release.open);
  const notOpposed = direction > 0 ? context.breadth >= config.breadthFloor && context.medianMove >= -config.opposedMove
    : context.breadth <= 1 - config.breadthFloor && context.medianMove <= config.opposedMove;
  const held = up ? retest.low <= upper + boxUnit * config.touch && retest.close > upper
    : retest.high >= lower - boxUnit * config.touch && retest.close < lower;
  const resumed = up ? latest.close > retest.close && latest.close > latest.open
    : latest.close < retest.close && latest.close < latest.open;
  const closeLocation = up ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (boxUnit > priorUnit * config.compression || releaseRange < priorUnit * config.expansion
    || releaseBody < releaseRange * config.body || !notOpposed || !held || !resumed
    || closeLocation < config.closeLocation) return null;
  const side = up ? "LONG" : "SHORT";
  const sign = signFor(side);
  const stop = up ? Math.min(retest.low, upper - boxUnit * config.stopInside)
    : Math.max(retest.high, lower + boxUnit * config.stopInside);
  const risk = Math.abs(latest.close - stop);
  return { name: "隙续", environment: "COMPRESSION", side, trigger: latest.close, stop,
    arm: latest.close + sign * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function impulseFold(rows, context, config) {
  const latest = rows.at(-1);
  const base = rows.slice(-config.window);
  const drive = base.slice(0, -config.turn);
  const turn = base.slice(-config.turn);
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const direction = drive.at(-1).close >= drive[0].open ? 1 : -1;
  const displacement = direction * (drive.at(-1).close - drive[0].open);
  const extreme = direction > 0 ? Math.max(...turn.map((row) => row.high)) : Math.min(...turn.map((row) => row.low));
  const newExtreme = direction > 0 ? extreme >= Math.max(...drive.map((row) => row.high))
    : extreme <= Math.min(...drive.map((row) => row.low));
  const reclaimed = direction > 0 ? latest.close < turn.at(-2).open && latest.close < latest.open
    : latest.close > turn.at(-2).open && latest.close > latest.open;
  const broadOpposesDrive = direction > 0 ? context.breadth <= config.opposedBreadth || context.medianMove <= -config.opposedMove
    : context.breadth >= 1 - config.opposedBreadth || context.medianMove >= config.opposedMove;
  const broadNeutral = context.breadth >= config.neutralLow && context.breadth <= config.neutralHigh
    && Math.abs(context.medianMove) <= config.neutralMove;
  if (efficiency(drive) < config.efficiency || displacement < unit * config.displacement || !newExtreme || !reclaimed
    || (config.requireOpposed ? !broadOpposesDrive : !broadNeutral && !broadOpposesDrive)) return null;
  const side = direction > 0 ? "SHORT" : "LONG";
  const sign = signFor(side);
  const stop = extreme - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  return { name: "脉折", environment: "EXPANSION", side, trigger: latest.close, stop,
    arm: latest.close + sign * risk * config.armR, maxBars: config.maxBars,
    noProgressBars: config.noProgressBars, at: latest.time };
}

function quietSweep(rows, context, config) {
  const latest = rows.at(-1);
  const prior = rows.slice(-config.window - 1, -1);
  const older = rows.slice(-config.window - config.older - 1, -config.window - 1);
  const unit = median(prior.map((row) => row.high - row.low));
  const olderUnit = median(older.map((row) => row.high - row.low));
  const lower = Math.min(...prior.map((row) => row.low));
  const upper = Math.max(...prior.map((row) => row.high));
  const center = (lower + upper) / 2;
  const width = upper - lower;
  const neutral = context.breadth >= config.breadthLow && context.breadth <= config.breadthHigh
    && Math.abs(context.medianMove) <= config.marketMove;
  const lowSweep = latest.low < lower - unit * config.sweep && latest.close > lower && latest.close > latest.open;
  const highSweep = latest.high > upper + unit * config.sweep && latest.close < upper && latest.close < latest.open;
  const closeLocation = lowSweep ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : highSweep ? (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12) : 0;
  if (!neutral || unit > olderUnit * config.quietRatio || efficiency(prior) > config.efficiency
    || width < unit * config.width || lowSweep === highSweep || closeLocation < config.closeLocation) return null;
  const side = lowSweep ? "LONG" : "SHORT";
  const sign = signFor(side);
  const extreme = lowSweep ? latest.low : latest.high;
  const stop = extreme - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  const structuralArm = latest.close + sign * risk * config.armR;
  const arm = side === "LONG" ? Math.min(center, structuralArm) : Math.max(center, structuralArm);
  return { name: "静扫", environment: "RANGE", side, trigger: latest.close, stop, arm,
    maxBars: config.maxBars, noProgressBars: config.noProgressBars, at: latest.time };
}

function phaseTurn(rows, context, config) {
  const base = rows.slice(-config.window);
  const latest = base.at(-1);
  const early = base.slice(0, -config.late);
  const late = base.slice(-config.late);
  const unit = median(rows.slice(-48).map((row) => row.high - row.low));
  const direction = early.at(-1).close >= early[0].open ? 1 : -1;
  const displacement = Math.abs(early.at(-1).close - early[0].open);
  const lateTravel = late.slice(1, -1).reduce((total, row, index) => total + Math.abs(row.close - late[index].close), 0);
  const progress = direction * (late.at(-2).close - late[0].open) / Math.max(lateTravel, unit);
  const reversed = direction > 0 ? latest.close < late.at(-2).open && latest.close < latest.open
    : latest.close > late.at(-2).open && latest.close > latest.open;
  const extreme = direction > 0 ? Math.max(...late.map((row) => row.high)) : Math.min(...late.map((row) => row.low));
  const newExtreme = direction > 0 ? extreme >= Math.max(...early.map((row) => row.high))
    : extreme <= Math.min(...early.map((row) => row.low));
  if (efficiency(early) < config.efficiency || displacement < unit * config.displacement
    || progress >= config.progress || !reversed || !newExtreme) return null;
  let side = direction > 0 ? "SHORT" : "LONG";
  const neutral = context.breadth >= config.neutralLow && context.breadth <= config.neutralHigh
    && Math.abs(context.medianMove) <= config.neutralMove;
  const crowded = side === "LONG" ? context.breadth <= config.crowdedLow && context.medianMove <= -config.crowdedMove
    : context.breadth >= 1 - config.crowdedLow && context.medianMove >= config.crowdedMove;
  if (!neutral && !crowded) return null;
  if (config.contextMode === "NEUTRAL" && !neutral || config.contextMode === "CROWDED" && !crowded) return null;
  if (crowded) side = side === "LONG" ? "SHORT" : "LONG";
  const sign = signFor(side);
  const reversalSide = side === (direction > 0 ? "SHORT" : "LONG");
  const stop = reversalSide ? extreme - sign * unit * config.stopPad
    : latest.close - sign * Math.max(Math.abs(latest.close - extreme), unit) * config.continuationStop;
  const risk = Math.abs(latest.close - stop);
  return { name: config.name, environment: crowded ? "TREND" : "EXPANSION", side,
    trigger: latest.close, stop, arm: latest.close + sign * risk * (crowded ? config.crowdedArmR : config.neutralArmR),
    maxBars: crowded ? config.crowdedMaxBars : config.neutralMaxBars,
    noProgressBars: crowded ? config.crowdedNoProgressBars : config.neutralNoProgressBars, at: latest.time };
}

function economics(rows, index, signal) {
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

function resolve(rows, index, signal) {
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
    else if (armHit) armed = true;
    if (exit == null && armed) {
      const giveback = Math.max(risk, best * .45);
      const locked = Math.max(entry * FRICTION + risk * .35, best - giveback);
      activeStop = signal.side === "LONG" ? Math.max(activeStop, entry + locked) : Math.min(activeStop, entry - locked);
    }
    if (exit == null && !armed && offset >= signal.noProgressBars && best < risk * .35
      && sign * (row.close - entry) < risk * .15) { exit = row.close; outcome = "NO_PROGRESS"; }
    if (exit == null && offset === signal.maxBars) { exit = row.close; outcome = "TIMEOUT"; }
    if (exit != null) return { openedAt: rows[index + 1].time * 1_000, closedAt: row.time * 1_000,
      netReturnRate: sign * (exit - entry) / entry - FRICTION, outcome };
  }
  return null;
}

function generate(detector, config) {
  const trades = [];
  for (const { symbol, rows } of datasets) {
    let busyUntil = 0;
    for (let index = 120; index < rows.length - 1; index += 1) {
      if (rows[index].time <= busyUntil) continue;
      const context = contexts.get(rows[index].time);
      if (!context || context.markets < 12) continue;
      const detected = detector(rows.slice(index - 119, index + 1), context, config);
      const signal = !detected || !config.reverse ? detected : (() => {
        const side = detected.side === "LONG" ? "SHORT" : "LONG";
        const sign = signFor(side);
        const stopRate = Math.abs(detected.trigger - detected.stop) / detected.trigger;
        const armRate = Math.abs(detected.arm - detected.trigger) / detected.trigger;
        return { ...detected, side, stop: detected.trigger * (1 - sign * stopRate),
          arm: detected.trigger * (1 + sign * armRate) };
      })();
      if (!signal || !economics(rows, index, signal)) continue;
      const trade = resolve(rows, index, signal);
      if (!trade) continue;
      trades.push({ ...trade, symbol, side: signal.side, state: stateAt(rows.slice(index - 119, index + 1), context) });
      busyUntil = trade.closedAt / 1_000;
    }
  }
  return trades;
}

function metrics(trades) {
  const gain = trades.filter((row) => row.netReturnRate > 0).reduce((sum, row) => sum + row.netReturnRate, 0);
  const loss = Math.abs(trades.filter((row) => row.netReturnRate <= 0).reduce((sum, row) => sum + row.netReturnRate, 0));
  return { trades: trades.length, winRate: trades.length ? trades.filter((row) => row.netReturnRate > 0).length / trades.length : 0,
    net: trades.reduce((sum, row) => sum + row.netReturnRate, 0), pf: loss ? gain / loss : gain ? 99 : 0 };
}

const coverageTrades = [];
const familyIds = { "潮接": "tide_relay", "静旋": "quiet_orbit", "潮补": "tide_catchup", "静移": "quiet_drift",
  "冲衡": "impulse_recoil", "隙续": "compression_hold", "脉折": "impulse_fold", "静扫": "quiet_sweep", "相折": "phase_turn" };

function evaluate(name, detector, variants) {
  const results = variants.map((config, index) => {
    const trades = generate(detector, config);
    const strategyId = `${familyIds[name]}:${index}`;
    coverageTrades.push(...trades.map((trade) => ({ ...trade, strategyId,
      strategyName: config.name ? `${config.name}·${index}` : `${name}·${index}` })));
    const folds = [0, 1, 2].map((fold) => metrics(trades.filter((trade) => trade.openedAt >= fromMs + fold * spanMs
      && trade.openedAt < fromMs + (fold + 1) * spanMs)));
    const train = metrics(trades.filter((trade) => trade.openedAt < fromMs + spanMs * 1.5));
    const validation = metrics(trades.filter((trade) => trade.openedAt >= fromMs + spanMs * 1.5));
    return { name, index, config, train, validation, folds };
  }).sort((left, right) => Math.min(...right.folds.map((fold) => fold.pf)) - Math.min(...left.folds.map((fold) => fold.pf)));
  console.table(results.map((row) => ({ strategy: name, index: row.index, trainN: row.train.trades,
    trainPF: row.train.pf.toFixed(2), validationN: row.validation.trades, validationPF: row.validation.pf.toFixed(2),
    validationWin: (row.validation.winRate * 100).toFixed(1), validationNet: (row.validation.net * 100).toFixed(2),
    folds: row.folds.map((fold) => `${fold.trades}@${fold.pf.toFixed(2)}`).join(" / ") })));
  return results;
}

const tide = evaluate("潮接", tideRelay, [
  { path: 24, lag: 3, breadth: .62, marketMove: .0012, efficiency: .36, displacement: 3.4, lagMove: .35, body: .45, closeLocation: .64, stopPad: .25, armR: 1.8, maxBars: 30, noProgressBars: 7 },
  { path: 30, lag: 4, breadth: .65, marketMove: .0015, efficiency: .40, displacement: 4.2, lagMove: .45, body: .50, closeLocation: .68, stopPad: .30, armR: 2.0, maxBars: 36, noProgressBars: 8 },
  { path: 20, lag: 2, breadth: .60, marketMove: .0010, efficiency: .32, displacement: 2.8, lagMove: .25, body: .40, closeLocation: .60, stopPad: .20, armR: 1.7, maxBars: 24, noProgressBars: 6 },
  { path: 36, lag: 5, breadth: .62, marketMove: .0012, efficiency: .34, displacement: 4.8, lagMove: .50, body: .45, closeLocation: .65, stopPad: .35, armR: 2.2, maxBars: 42, noProgressBars: 9 },
  { reverse: true, path: 24, lag: 3, breadth: .62, marketMove: .0012, efficiency: .36, displacement: 3.4, lagMove: .35, body: .45, closeLocation: .64, stopPad: .25, armR: 1.8, maxBars: 30, noProgressBars: 7 },
  { reverse: true, path: 30, lag: 4, breadth: .65, marketMove: .0015, efficiency: .40, displacement: 4.2, lagMove: .45, body: .50, closeLocation: .68, stopPad: .30, armR: 2.0, maxBars: 36, noProgressBars: 8 },
  { reverse: true, path: 20, lag: 2, breadth: .60, marketMove: .0010, efficiency: .32, displacement: 2.8, lagMove: .25, body: .40, closeLocation: .60, stopPad: .20, armR: 1.7, maxBars: 24, noProgressBars: 6 },
  { reverse: true, path: 36, lag: 5, breadth: .62, marketMove: .0012, efficiency: .34, displacement: 4.8, lagMove: .50, body: .45, closeLocation: .65, stopPad: .35, armR: 2.2, maxBars: 42, noProgressBars: 9 },
]);
const orbit = evaluate("静旋", quietOrbit, [
  { window: 36, recent: 4, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .90, efficiency: .25, width: 4.5, edge: .22, stopPad: .30, armR: 1.8, maxBars: 20, noProgressBars: 6 },
  { window: 42, recent: 5, breadthLow: .40, breadthHigh: .60, marketMove: .0012, quietRatio: .82, efficiency: .22, width: 5.0, edge: .20, stopPad: .35, armR: 2.0, maxBars: 24, noProgressBars: 7 },
  { window: 30, recent: 3, breadthLow: .35, breadthHigh: .65, marketMove: .0018, quietRatio: .95, efficiency: .28, width: 4.0, edge: .25, stopPad: .25, armR: 1.7, maxBars: 18, noProgressBars: 5 },
  { window: 48, recent: 5, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .88, efficiency: .24, width: 5.5, edge: .18, stopPad: .40, armR: 2.2, maxBars: 30, noProgressBars: 8 },
  { reverse: true, window: 36, recent: 4, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .90, efficiency: .25, width: 4.5, edge: .22, stopPad: .30, armR: 1.8, maxBars: 20, noProgressBars: 6 },
  { reverse: true, window: 42, recent: 5, breadthLow: .40, breadthHigh: .60, marketMove: .0012, quietRatio: .82, efficiency: .22, width: 5.0, edge: .20, stopPad: .35, armR: 2.0, maxBars: 24, noProgressBars: 7 },
  { reverse: true, window: 30, recent: 3, breadthLow: .35, breadthHigh: .65, marketMove: .0018, quietRatio: .95, efficiency: .28, width: 4.0, edge: .25, stopPad: .25, armR: 1.7, maxBars: 18, noProgressBars: 5 },
  { reverse: true, window: 48, recent: 5, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .88, efficiency: .24, width: 5.5, edge: .18, stopPad: .40, armR: 2.2, maxBars: 30, noProgressBars: 8 },
  { align: true, alignBreadth: .52, alignMove: .0001, window: 30, recent: 3, breadthLow: .35, breadthHigh: .65, marketMove: .0018, quietRatio: .95, efficiency: .28, width: 4.0, edge: .25, stopPad: .25, armR: 1.5, maxBars: 24, noProgressBars: 6 },
  { align: true, alignBreadth: .55, alignMove: .0002, window: 36, recent: 4, breadthLow: .35, breadthHigh: .65, marketMove: .0018, quietRatio: .92, efficiency: .27, width: 4.2, edge: .23, stopPad: .25, armR: 1.6, maxBars: 30, noProgressBars: 7 },
  { align: true, alignBreadth: .52, alignMove: 0, window: 42, recent: 5, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .88, efficiency: .25, width: 4.8, edge: .20, stopPad: .30, armR: 1.7, maxBars: 36, noProgressBars: 8 },
]);
const catchup = evaluate("潮补", tideCatchup, [
  { lag: 6, resume: 2, range: 24, breadth: .62, marketMove: .0012, relativeLag: .0020, alignedCloses: 1, body: .30, closeLocation: .60, maxPosition: .70, stopPad: .20, armR: 1.8, maxBars: 24, noProgressBars: 6 },
  { lag: 6, resume: 3, range: 30, breadth: .65, marketMove: .0015, relativeLag: .0025, alignedCloses: 2, body: .35, closeLocation: .65, maxPosition: .72, stopPad: .25, armR: 2.0, maxBars: 30, noProgressBars: 7 },
  { lag: 9, resume: 2, range: 36, breadth: .60, marketMove: .0010, relativeLag: .0030, alignedCloses: 1, body: .25, closeLocation: .58, maxPosition: .75, stopPad: .20, armR: 1.7, maxBars: 20, noProgressBars: 5 },
  { lag: 12, resume: 3, range: 42, breadth: .62, marketMove: .0012, relativeLag: .0040, alignedCloses: 2, body: .30, closeLocation: .62, maxPosition: .70, stopPad: .30, armR: 2.2, maxBars: 36, noProgressBars: 8 },
]);
const drift = evaluate("静移", quietDrift, [
  { recent: 7, prior: 24, marketMove: .0015, quietRatio: .80, efficiency: .55, displacement: 2.0, aligned: 4, body: .30, closeLocation: .62, stopPad: .25, armR: 1.8, maxBars: 20, noProgressBars: 5 },
  { recent: 9, prior: 30, marketMove: .0012, quietRatio: .75, efficiency: .60, displacement: 2.5, aligned: 5, body: .35, closeLocation: .66, stopPad: .30, armR: 2.0, maxBars: 24, noProgressBars: 6 },
  { recent: 6, prior: 18, marketMove: .0018, quietRatio: .85, efficiency: .50, displacement: 1.6, aligned: 3, body: .25, closeLocation: .58, stopPad: .20, armR: 1.7, maxBars: 18, noProgressBars: 5 },
  { recent: 11, prior: 36, marketMove: .0015, quietRatio: .78, efficiency: .58, displacement: 3.0, aligned: 6, body: .30, closeLocation: .64, stopPad: .35, armR: 2.2, maxBars: 30, noProgressBars: 7 },
]);
const recoil = evaluate("冲衡", impulseRecoil, [
  { prior: 24, breadth: .62, marketMove: .0012, range: 2.0, body: .60, retrace: .40, closeLocation: .62, stopPad: .20, armR: 1.8, maxBars: 20, noProgressBars: 5 },
  { prior: 30, breadth: .65, marketMove: .0015, range: 2.4, body: .65, retrace: .50, closeLocation: .68, stopPad: .25, armR: 2.0, maxBars: 24, noProgressBars: 6 },
  { prior: 18, breadth: .60, marketMove: .0010, range: 1.7, body: .55, retrace: .35, closeLocation: .58, stopPad: .15, armR: 1.7, maxBars: 18, noProgressBars: 5 },
  { prior: 36, breadth: .62, marketMove: .0012, range: 2.8, body: .70, retrace: .55, closeLocation: .70, stopPad: .30, armR: 2.2, maxBars: 30, noProgressBars: 7 },
]);
const hold = evaluate("隙续", compressionHold, [
  { box: 14, prior: 24, compression: .80, expansion: 1.15, body: .50, breadthFloor: .45, opposedMove: .0010, touch: .35, stopInside: .45, closeLocation: .60, armR: 1.8, maxBars: 24, noProgressBars: 6 },
  { box: 18, prior: 30, compression: .72, expansion: 1.30, body: .55, breadthFloor: .48, opposedMove: .0008, touch: .30, stopInside: .50, closeLocation: .65, armR: 2.0, maxBars: 30, noProgressBars: 7 },
  { box: 10, prior: 20, compression: .85, expansion: 1.05, body: .45, breadthFloor: .42, opposedMove: .0012, touch: .40, stopInside: .40, closeLocation: .58, armR: 1.7, maxBars: 20, noProgressBars: 5 },
  { box: 22, prior: 36, compression: .68, expansion: 1.45, body: .60, breadthFloor: .50, opposedMove: .0006, touch: .25, stopInside: .60, closeLocation: .68, armR: 2.2, maxBars: 36, noProgressBars: 8 },
]);
const fold = evaluate("脉折", impulseFold, [
  { window: 12, turn: 3, efficiency: .48, displacement: 3.0, neutralLow: .38, neutralHigh: .62, neutralMove: .0015, opposedBreadth: .42, opposedMove: .0008, stopPad: .25, armR: 1.8, maxBars: 20, noProgressBars: 5 },
  { window: 16, turn: 4, efficiency: .52, displacement: 3.8, neutralLow: .40, neutralHigh: .60, neutralMove: .0012, opposedBreadth: .40, opposedMove: .0010, stopPad: .30, armR: 2.0, maxBars: 24, noProgressBars: 6 },
  { window: 10, turn: 2, efficiency: .44, displacement: 2.5, neutralLow: .35, neutralHigh: .65, neutralMove: .0018, opposedBreadth: .45, opposedMove: .0006, stopPad: .20, armR: 1.7, maxBars: 18, noProgressBars: 5 },
  { window: 20, turn: 5, efficiency: .55, displacement: 4.5, neutralLow: .38, neutralHigh: .62, neutralMove: .0015, opposedBreadth: .38, opposedMove: .0012, stopPad: .35, armR: 2.2, maxBars: 30, noProgressBars: 7 },
  { requireOpposed: true, window: 10, turn: 2, efficiency: .44, displacement: 2.5, neutralLow: .35, neutralHigh: .65, neutralMove: .0018, opposedBreadth: .45, opposedMove: .0006, stopPad: .20, armR: 1.5, maxBars: 24, noProgressBars: 6 },
  { requireOpposed: true, window: 12, turn: 3, efficiency: .48, displacement: 3.0, neutralLow: .38, neutralHigh: .62, neutralMove: .0015, opposedBreadth: .42, opposedMove: .0008, stopPad: .25, armR: 1.6, maxBars: 30, noProgressBars: 7 },
  { requireOpposed: true, window: 16, turn: 4, efficiency: .52, displacement: 3.8, neutralLow: .40, neutralHigh: .60, neutralMove: .0012, opposedBreadth: .40, opposedMove: .0010, stopPad: .30, armR: 1.8, maxBars: 36, noProgressBars: 8 },
]);
const sweep = evaluate("静扫", quietSweep, [
  { window: 24, older: 24, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .90, efficiency: .28, width: 4.0, sweep: .10, closeLocation: .60, stopPad: .20, armR: 1.8, maxBars: 20, noProgressBars: 5 },
  { window: 30, older: 30, breadthLow: .40, breadthHigh: .60, marketMove: .0012, quietRatio: .82, efficiency: .24, width: 4.8, sweep: .15, closeLocation: .65, stopPad: .25, armR: 2.0, maxBars: 24, noProgressBars: 6 },
  { window: 18, older: 18, breadthLow: .35, breadthHigh: .65, marketMove: .0018, quietRatio: .95, efficiency: .32, width: 3.5, sweep: .05, closeLocation: .58, stopPad: .15, armR: 1.7, maxBars: 18, noProgressBars: 5 },
  { window: 36, older: 36, breadthLow: .38, breadthHigh: .62, marketMove: .0015, quietRatio: .85, efficiency: .22, width: 5.5, sweep: .20, closeLocation: .68, stopPad: .30, armR: 2.2, maxBars: 30, noProgressBars: 7 },
]);
const phase = evaluate("相折", phaseTurn, [
  { name: "骤折", window: 16, late: 3, efficiency: .48, displacement: 3.0, progress: .18, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .25, continuationStop: .9, neutralArmR: 1.7, crowdedArmR: 1.7, neutralMaxBars: 18, crowdedMaxBars: 24, neutralNoProgressBars: 5, crowdedNoProgressBars: 6 },
  { name: "骤折", window: 20, late: 4, efficiency: .45, displacement: 3.5, progress: .20, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .28, continuationStop: .95, neutralArmR: 1.75, crowdedArmR: 1.75, neutralMaxBars: 20, crowdedMaxBars: 28, neutralNoProgressBars: 6, crowdedNoProgressBars: 7 },
  { name: "缓折", window: 36, late: 6, efficiency: .36, displacement: 4.8, progress: .25, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .32, continuationStop: 1.05, neutralArmR: 1.8, crowdedArmR: 1.8, neutralMaxBars: 30, crowdedMaxBars: 42, neutralNoProgressBars: 8, crowdedNoProgressBars: 10 },
  { name: "缓折", window: 42, late: 7, efficiency: .32, displacement: 5.2, progress: .28, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .35, continuationStop: 1.1, neutralArmR: 1.9, crowdedArmR: 1.9, neutralMaxBars: 36, crowdedMaxBars: 48, neutralNoProgressBars: 9, crowdedNoProgressBars: 12 },
  { name: "中折", window: 24, late: 4, efficiency: .42, displacement: 4.0, progress: .22, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .30, continuationStop: 1.0, neutralArmR: 1.75, crowdedArmR: 1.75, neutralMaxBars: 22, crowdedMaxBars: 32, neutralNoProgressBars: 6, crowdedNoProgressBars: 8 },
  { name: "脉折", window: 32, late: 6, efficiency: .40, displacement: 4.6, progress: .24, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .30, continuationStop: 1.0, neutralArmR: 1.8, crowdedArmR: 1.8, neutralMaxBars: 28, crowdedMaxBars: 40, neutralNoProgressBars: 7, crowdedNoProgressBars: 10 },
  { name: "孤折", contextMode: "NEUTRAL", window: 32, late: 6, efficiency: .40, displacement: 4.6, progress: .24, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .30, continuationStop: 1.0, neutralArmR: 1.8, crowdedArmR: 1.8, neutralMaxBars: 28, crowdedMaxBars: 40, neutralNoProgressBars: 7, crowdedNoProgressBars: 10 },
  { name: "潮续", contextMode: "CROWDED", window: 32, late: 6, efficiency: .40, displacement: 4.6, progress: .24, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .30, continuationStop: 1.0, neutralArmR: 1.8, crowdedArmR: 1.8, neutralMaxBars: 28, crowdedMaxBars: 40, neutralNoProgressBars: 7, crowdedNoProgressBars: 10 },
  { name: "缓返", contextMode: "NEUTRAL", window: 36, late: 6, efficiency: .36, displacement: 4.8, progress: .25, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .32, continuationStop: 1.05, neutralArmR: 1.8, crowdedArmR: 1.8, neutralMaxBars: 30, crowdedMaxBars: 42, neutralNoProgressBars: 8, crowdedNoProgressBars: 10 },
  { name: "缓续", contextMode: "CROWDED", window: 36, late: 6, efficiency: .36, displacement: 4.8, progress: .25, neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012, stopPad: .32, continuationStop: 1.05, neutralArmR: 1.8, crowdedArmR: 1.8, neutralMaxBars: 30, crowdedMaxBars: 42, neutralNoProgressBars: 8, crowdedNoProgressBars: 10 },
]);

const acceptedPhase = [5, 9].map((index) => phase.find((row) => row.index === index));
const tradeKey = (trade) => `${trade.symbol}:${trade.side}:${trade.openedAt}`;
const currentExhaustion = { name: "竭转", window: 28, late: 5, efficiency: .42, displacement: 4.4, progress: .24,
  neutralLow: .38, neutralHigh: .62, neutralMove: .0012, crowdedLow: .38, crowdedMove: .0012,
  stopPad: .30, continuationStop: 1.0, neutralArmR: 1.75, crowdedArmR: 1.75,
  neutralMaxBars: 24, crowdedMaxBars: 24, neutralNoProgressBars: 7, crowdedNoProgressBars: 7 };
const currentKeys = new Set(generate(phaseTurn, currentExhaustion).map(tradeKey));
const phaseOverlap = acceptedPhase.map((row, index) => {
  const trades = generate(phaseTurn, row.config);
  const other = new Set(generate(phaseTurn, acceptedPhase[index === 0 ? 1 : 0].config).map(tradeKey));
  return { name: row.config.name, events: trades.length,
    uniqueAgainstOther: trades.filter((trade) => !other.has(tradeKey(trade))).length,
    uniqueAgainstCurrent: trades.filter((trade) => !currentKeys.has(tradeKey(trade))).length };
});
console.table(phaseOverlap);

const accepted = acceptedPhase.map((row) => row && row.train.trades >= 30 && row.validation.trades >= 30
  && row.train.pf > 1 && row.validation.pf > 1 && row.folds.every((fold) => fold.trades >= 12 && fold.pf > 1)
  && phaseOverlap.find((item) => item.name === row.config.name)?.uniqueAgainstOther >= 30
  && phaseOverlap.find((item) => item.name === row.config.name)?.uniqueAgainstCurrent >= 30 ? row : null);
const splitAt = fromMs + spanMs * 1.5;
const coverage = buildStrategyCoverageReport(coverageTrades, splitAt, {
  discoveryTrades: 12, validationTrades: 8, discoveryProfitFactor: 1.05, validationProfitFactor: 1,
  validationSymbols: 2, validationPositivePeriods: 2, knownDiscoveryOpportunities: 20,
  knownValidationOpportunities: 12, periodMs: 5 * 86_400_000,
});
console.table(coverage.phases.map((row) => ({ phase: row.phase, knownCells: row.knownCells,
  coveredCells: row.coveredCells, coverage: `${(row.coverageRate * 100).toFixed(0)}%`, strategies: row.strategyIds.join(",") })));
if (coverage.gaps.length) console.table(coverage.gaps.map((gap) => ({ state: gap.state.key,
  discovery: gap.discoveryOpportunities, validation: gap.validationOpportunities })));
const coverageSummary = { splitAt: coverage.splitAt, thresholds: coverage.thresholds, knownCells: coverage.knownCells,
  acceptedCells: coverage.acceptedCells, gaps: coverage.gaps, phases: coverage.phases };
console.log(`V12_RESEARCH_JSON=${JSON.stringify({ rejectedFamilies: { tide, orbit, catchup, drift, recoil, hold, fold, sweep },
  phase, phaseOverlap, accepted, coverage: coverageSummary })}`);
if (accepted.filter(Boolean).length < 2) throw new Error("V12 candidate acceptance failed");
