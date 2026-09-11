import type { Side } from "./liquidity-core.ts";

export const ALL_REGIME_ENGINE_VERSION = 3;
export const ALL_REGIME_SYSTEM_NAME = "全境·复利引擎";

export type AllRegimeStrategyId = "momentum_carry" | "balance_return" | "pressure_release" | "exhaustion_turn"
  | "pulse_fold" | "slow_carry";
export type AllRegimeEnvironment = "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION";
export type AllRegimeCandle = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type AllRegimeRoute = {
  version: 3;
  strategyId: AllRegimeStrategyId;
  strategyName: "势承" | "衡返" | "压跃" | "竭转" | "脉折" | "缓续";
  environment: AllRegimeEnvironment;
  side: Side;
  score: number;
  triggerPrice: number;
  invalidationPrice: number;
  profitArmPrice: number;
  maxHoldMinutes: number;
  noProgressMinutes: number;
  continuationInvalidationPrice?: number;
  continuationProfitArmPrice?: number;
  continuationMaxHoldMinutes?: number;
  continuationNoProgressMinutes?: number;
  structureId: string;
  reason: string;
};

export const ALL_REGIME_STRATEGIES = [
  { id: "momentum_carry", name: "势承", environment: "TREND", description: "方向路径仍高效时，等待逆向扰动衰减并在恢复点接回主路径。" },
  { id: "balance_return", name: "衡返", environment: "RANGE", description: "低效往返触及外沿后重新收回平衡带，目标是回到成交重心。" },
  { id: "pressure_release", name: "压跃", environment: "COMPRESSION", description: "路径振幅持续收束后，只跟随首次带有实体与范围扩张的释放。" },
  { id: "exhaustion_turn", name: "竭转", environment: "EXHAUSTION", description: "价格继续创新极值但推进效率枯竭，反向收复后切换方向。" },
  { id: "pulse_fold", name: "脉折", environment: "EXHAUSTION", description: "中周期脉冲推进失去效率后，以市场拥挤度决定顺潮延续或反向折返。" },
  { id: "slow_carry", name: "缓续", environment: "EXHAUSTION", description: "较慢路径局部失速但全市场仍拥挤于原方向时，只沿主潮继续，不抢反转。" },
] as const;

export const ALL_REGIME_OFFLINE_VALIDATION = {
  momentum_carry: { branchName: "势承·逆竭", trainEvents: 48, trainProfitFactor: 1.80,
    validationEvents: 50, validationProfitFactor: 1.71, validationWinRate: 0.38, paperApproved: true },
  balance_return: { branchName: "衡返·双拒", trainEvents: 31, trainProfitFactor: 1.16,
    validationEvents: 22, validationProfitFactor: 1.42, validationWinRate: 0.409,
    recentFoldEvents: 16, recentFoldProfitFactor: 0.67, paperApproved: false },
  exhaustion_turn: { branchName: "竭转·孤返", trainEvents: 103, trainProfitFactor: 0.98,
    validationEvents: 86, validationProfitFactor: 1.39, validationWinRate: 0.36, paperApproved: true },
  pressure_release: { branchName: "压跃·共振", trainEvents: 55, trainProfitFactor: 0.90,
    validationEvents: 60, validationProfitFactor: 0.63, validationWinRate: 0.267, paperApproved: false },
  pulse_fold: { branchName: "脉折·相位", trainEvents: 126, trainProfitFactor: 1.60,
    validationEvents: 147, validationProfitFactor: 1.18, validationWinRate: 0.313,
    recentFoldEvents: 112, recentFoldProfitFactor: 1.37, paperApproved: true },
  slow_carry: { branchName: "缓续·顺潮", trainEvents: 47, trainProfitFactor: 1.62,
    validationEvents: 60, validationProfitFactor: 1.66, validationWinRate: 0.383,
    recentFoldEvents: 48, recentFoldProfitFactor: 1.68, paperApproved: true },
} as const;

export const allRegimePaperApproved = (strategyId: AllRegimeStrategyId) =>
  ALL_REGIME_OFFLINE_VALIDATION[strategyId].paperApproved;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const median = (values: number[]) => {
  if (!values.length) return 0;
  const rows = [...values].sort((a, b) => a - b);
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const pathEfficiency = (rows: AllRegimeCandle[]) => {
  if (rows.length < 2) return 0;
  const travel = rows.slice(1).reduce((total, row, index) => total + Math.abs(row.close - rows[index].close), 0);
  return Math.abs(rows.at(-1)!.close - rows[0].open) / Math.max(travel, rows.at(-1)!.close * 1e-7);
};
const priceBin = (price: number) => Math.round(Math.log(Math.max(price, 1e-12)) / Math.log(1.001));
const valid = (route: AllRegimeRoute) => route.side === "LONG"
  ? route.invalidationPrice < route.triggerPrice && route.profitArmPrice > route.triggerPrice
  : route.invalidationPrice > route.triggerPrice && route.profitArmPrice < route.triggerPrice;

function momentumCarry(rows: AllRegimeCandle[], unit: number): AllRegimeRoute | null {
  const base = rows.slice(-30);
  const latest = base.at(-1)!;
  const direction = latest.close >= base[0].open ? 1 : -1;
  const efficiency = pathEfficiency(base);
  const displacement = Math.abs(latest.close - base[0].open);
  const pause = base.slice(-5, -1);
  const pauseTravel = Math.abs(pause.at(-1)!.close - pause[0].open);
  const resumed = direction > 0
    ? latest.close > Math.max(...pause.map((row) => row.close)) && latest.close > latest.open
    : latest.close < Math.min(...pause.map((row) => row.close)) && latest.close < latest.open;
  if (efficiency < 0.38 || displacement < unit * 4.2 || !resumed || pauseTravel > displacement * 0.42) return null;
  const side: Side = direction > 0 ? "LONG" : "SHORT";
  const pauseExtreme = direction > 0 ? Math.min(...pause.map((row) => row.low)) : Math.max(...pause.map((row) => row.high));
  const stop = direction > 0 ? Math.min(pauseExtreme, latest.close - unit * 1.15) : Math.max(pauseExtreme, latest.close + unit * 1.15);
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 3, strategyId: "momentum_carry", strategyName: "势承", environment: "TREND", side,
    score: clamp(58 + efficiency * 32 + clamp(displacement / Math.max(unit * 12, 1e-9), 0, 1) * 10, 0, 98),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + direction * risk * 1.8,
    maxHoldMinutes: 180, noProgressMinutes: 45, structureId: `carry:${side}:${priceBin(pauseExtreme)}:${latest.time}`,
    reason: `30段方向效率${Math.round(efficiency * 100)}%，逆向扰动未破坏主路径，最新完成段恢复推进。` };
  return valid(route) ? route : null;
}

type BalanceGeometry = { kind: "strict" | "broad"; window: number; recent: number; efficiency: number; width: number;
  crossings: number; edge: number; stopPad: number; armR: number; maxHoldMinutes: number; noProgressMinutes: number };

function balanceReturnGeometry(rows: AllRegimeCandle[], config: BalanceGeometry): AllRegimeRoute | null {
  const base = rows.slice(-config.window);
  const latest = base.at(-1)!;
  const recent = base.slice(-config.recent);
  const prior = base.slice(0, -config.recent);
  const unit = median(prior.slice(-36).map((row) => row.high - row.low));
  const lower = Math.min(...prior.map((row) => row.low));
  const upper = Math.max(...prior.map((row) => row.high));
  const width = upper - lower;
  const efficiency = pathEfficiency(prior);
  const center = (lower + upper) / 2;
  const crossings = prior.slice(1).filter((row, index) => (row.close >= center) !== (prior[index].close >= center)).length;
  if (efficiency > config.efficiency || width < unit * config.width || crossings < config.crossings) return null;
  const lowerBand = lower + width * config.edge;
  const upperBand = upper - width * config.edge;
  const lowTouches = recent.filter((row) => row.low <= lowerBand).length;
  const highTouches = recent.filter((row) => row.high >= upperBand).length;
  const longReclaim = lowTouches >= 2 && recent.at(-2)!.close <= lowerBand && latest.close > lowerBand && latest.close > latest.open;
  const shortReclaim = highTouches >= 2 && recent.at(-2)!.close >= upperBand && latest.close < upperBand && latest.close < latest.open;
  if (longReclaim === shortReclaim) return null;
  const side: Side = longReclaim ? "LONG" : "SHORT";
  const sign = side === "LONG" ? 1 : -1;
  const edge = side === "LONG" ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = edge - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  const structuralArm = latest.close + sign * risk * config.armR;
  const arm = side === "LONG" ? Math.min(center, structuralArm) : Math.max(center, structuralArm);
  const route: AllRegimeRoute = { version: 3, strategyId: "balance_return", strategyName: "衡返", environment: "RANGE", side,
    score: clamp(66 + (config.efficiency - efficiency) * 60 + clamp(crossings / 8, 0, 1) * 12, 0, 97),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: arm,
    structureId: `double-reclaim:${config.kind}:${side}:${priceBin(lower)}:${priceBin(upper)}:${latest.time}`,
    reason: `${config.kind === "strict" ? "严谨" : "扩展"}平衡路径穿越重心${crossings}次，同一外沿至少两次拒绝后由最新完成段收回。`,
    maxHoldMinutes: config.maxHoldMinutes, noProgressMinutes: config.noProgressMinutes };
  return valid(route) ? route : null;
}

function balanceReturn(rows: AllRegimeCandle[]): AllRegimeRoute | null {
  return balanceReturnGeometry(rows, { kind: "strict", window: 66, recent: 5, efficiency: 0.22, width: 7,
    crossings: 4, edge: 0.18, stopPad: 0.4, armR: 1.8, maxHoldMinutes: 150, noProgressMinutes: 40 });
}

function pressureRelease(rows: AllRegimeCandle[], unit: number): AllRegimeRoute | null {
  const latest = rows.at(-1)!;
  const box = rows.slice(-19, -1);
  const prior = rows.slice(-48, -19);
  const boxUnit = median(box.map((row) => row.high - row.low));
  const priorUnit = median(prior.map((row) => row.high - row.low));
  const upper = Math.max(...box.map((row) => row.high));
  const lower = Math.min(...box.map((row) => row.low));
  const body = Math.abs(latest.close - latest.open);
  const range = latest.high - latest.low;
  const compressed = boxUnit <= priorUnit * 0.76 && upper - lower <= priorUnit * 8.5;
  const longRelease = latest.close > upper && latest.close > latest.open;
  const shortRelease = latest.close < lower && latest.close < latest.open;
  if (!compressed || (!longRelease && !shortRelease) || body < boxUnit * 0.72 || range < boxUnit * 1.2) return null;
  const side: Side = longRelease ? "LONG" : "SHORT";
  const sign = side === "LONG" ? 1 : -1;
  const inner = side === "LONG" ? Math.max(lower, upper - boxUnit * 1.15) : Math.min(upper, lower + boxUnit * 1.15);
  const stop = side === "LONG" ? Math.min(inner, latest.close - unit * 1.05) : Math.max(inner, latest.close + unit * 1.05);
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 3, strategyId: "pressure_release", strategyName: "压跃", environment: "COMPRESSION", side,
    score: clamp(64 + clamp((priorUnit / Math.max(boxUnit, 1e-9) - 1) * 28, 0, 20) + clamp(body / Math.max(boxUnit, 1e-9), 0, 2) * 7, 0, 98),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + sign * risk * 1.9,
    maxHoldMinutes: 210, noProgressMinutes: 55, structureId: `release:${side}:${priceBin(lower)}:${priceBin(upper)}:${latest.time}`,
    reason: `18段振幅压至前序的${Math.round(boxUnit / Math.max(priorUnit, 1e-9) * 100)}%，最新完成段首次实体释放。` };
  return valid(route) ? route : null;
}

function exhaustionTurn(rows: AllRegimeCandle[], unit: number): AllRegimeRoute | null {
  const base = rows.slice(-28);
  const latest = base.at(-1)!;
  const early = base.slice(0, -5);
  const late = base.slice(-5);
  const direction = early.at(-1)!.close >= early[0].open ? 1 : -1;
  const displacement = Math.abs(early.at(-1)!.close - early[0].open);
  if (pathEfficiency(early) < 0.42 || displacement < unit * 4.4) return null;
  const lateTravel = late.slice(1).reduce((total, row, index) => total + Math.abs(row.close - late[index].close), 0);
  const lateProgress = direction * (late.at(-2)!.close - late[0].open);
  const progressRatio = lateProgress / Math.max(lateTravel, unit);
  const prior = late.at(-2)!;
  const reversal = direction > 0 ? latest.close < prior.open && latest.close < latest.open : latest.close > prior.open && latest.close > latest.open;
  const newExtreme = direction > 0 ? Math.max(...late.map((row) => row.high)) >= Math.max(...early.map((row) => row.high))
    : Math.min(...late.map((row) => row.low)) <= Math.min(...early.map((row) => row.low));
  if (progressRatio >= 0.24 || !reversal || !newExtreme) return null;
  const side: Side = direction > 0 ? "SHORT" : "LONG";
  const sign = side === "LONG" ? 1 : -1;
  const extreme = direction > 0 ? Math.max(...late.map((row) => row.high)) : Math.min(...late.map((row) => row.low));
  const stop = extreme - sign * unit * 0.3;
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 3, strategyId: "exhaustion_turn", strategyName: "竭转", environment: "EXHAUSTION", side,
    score: clamp(62 + (0.24 - progressRatio) * 55 + clamp(displacement / Math.max(unit * 12, 1e-9), 0, 1) * 12, 0, 97),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + sign * risk * 1.75,
    maxHoldMinutes: 120, noProgressMinutes: 35, structureId: `turn:${side}:${priceBin(extreme)}:${latest.time}`,
    reason: `原方向保持新极值，但末段有效推进降至${Math.round(progressRatio * 100)}%，反向完成段已收复。` };
  return valid(route) ? route : null;
}

type PhaseFoldGeometry = { id: "pulse_fold" | "slow_carry"; name: "脉折" | "缓续"; window: number; late: number;
  efficiency: number; displacement: number; progress: number; maxHoldMinutes: number; noProgressMinutes: number;
  stopPad: number; continuationStop: number; continuationMaxHoldMinutes: number; continuationNoProgressMinutes: number };

function phaseFold(rows: AllRegimeCandle[], unit: number, config: PhaseFoldGeometry): AllRegimeRoute | null {
  const base = rows.slice(-config.window);
  const latest = base.at(-1)!;
  const early = base.slice(0, -config.late);
  const late = base.slice(-config.late);
  const direction = early.at(-1)!.close >= early[0].open ? 1 : -1;
  const efficiency = pathEfficiency(early);
  const displacement = Math.abs(early.at(-1)!.close - early[0].open);
  const lateTravel = late.slice(1, -1)
    .reduce((total, row, index) => total + Math.abs(row.close - late[index].close), 0);
  const progressRatio = direction * (late.at(-2)!.close - late[0].open) / Math.max(lateTravel, unit);
  const prior = late.at(-2)!;
  const reversal = direction > 0 ? latest.close < prior.open && latest.close < latest.open
    : latest.close > prior.open && latest.close > latest.open;
  const extreme = direction > 0 ? Math.max(...late.map((row) => row.high)) : Math.min(...late.map((row) => row.low));
  const newExtreme = direction > 0 ? extreme >= Math.max(...early.map((row) => row.high))
    : extreme <= Math.min(...early.map((row) => row.low));
  if (efficiency < config.efficiency || displacement < unit * config.displacement
    || progressRatio >= config.progress || !reversal || !newExtreme) return null;
  const side: Side = direction > 0 ? "SHORT" : "LONG";
  const sign = side === "LONG" ? 1 : -1;
  const stop = extreme - sign * unit * config.stopPad;
  const risk = Math.abs(latest.close - stop);
  const continuationSign = -sign;
  const continuationStop = latest.close - continuationSign
    * Math.max(Math.abs(latest.close - extreme), unit) * config.continuationStop;
  const continuationRisk = Math.abs(latest.close - continuationStop);
  const route: AllRegimeRoute = { version: 3, strategyId: config.id, strategyName: config.name,
    environment: "EXHAUSTION", side,
    score: clamp(61 + (config.progress - progressRatio) * 52
      + clamp(displacement / Math.max(unit * 12, 1e-9), 0, 1) * 12, 0, 97),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + sign * risk * 1.8,
    maxHoldMinutes: config.maxHoldMinutes, noProgressMinutes: config.noProgressMinutes,
    continuationInvalidationPrice: continuationStop,
    continuationProfitArmPrice: latest.close + continuationSign * continuationRisk * 1.8,
    continuationMaxHoldMinutes: config.continuationMaxHoldMinutes,
    continuationNoProgressMinutes: config.continuationNoProgressMinutes,
    structureId: `${config.id}:${side}:${priceBin(extreme)}:${latest.time}`,
    reason: `${config.window}段路径效率${Math.round(efficiency * 100)}%，末段有效推进降至${Math.round(progressRatio * 100)}%，反向完成段已收复。` };
  return valid(route) ? route : null;
}

export function detectAllRegimeRoutes(candles: AllRegimeCandle[]) {
  const rows = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
    && row.open > 0 && row.low > 0 && row.high >= row.low).map((row) => [row.time, row])).values()]
    .sort((a, b) => a.time - b.time).slice(-120);
  if (rows.length < 50) return [];
  const unit = median(rows.slice(-48).map((row) => row.high - row.low));
  if (!(unit > 0)) return [];
  return [phaseFold(rows, unit, { id: "pulse_fold", name: "脉折", window: 32, late: 6, efficiency: 0.4,
    displacement: 4.6, progress: 0.24, maxHoldMinutes: 140, noProgressMinutes: 35,
    stopPad: 0.3, continuationStop: 1, continuationMaxHoldMinutes: 200, continuationNoProgressMinutes: 50 }),
  phaseFold(rows, unit, { id: "slow_carry", name: "缓续", window: 36, late: 6, efficiency: 0.36,
    displacement: 4.8, progress: 0.25, maxHoldMinutes: 150, noProgressMinutes: 40,
    stopPad: 0.32, continuationStop: 1.05, continuationMaxHoldMinutes: 210, continuationNoProgressMinutes: 50 }),
  pressureRelease(rows, unit), exhaustionTurn(rows, unit), momentumCarry(rows, unit), balanceReturn(rows)]
    .filter((route): route is AllRegimeRoute => route != null).sort((left, right) => right.score - left.score);
}

export function dominantAllRegimeEnvironment(candles: AllRegimeCandle[]): AllRegimeEnvironment | null {
  const routes = detectAllRegimeRoutes(candles);
  if (routes.length) return routes[0].environment;
  const rows = candles.slice(-30);
  if (rows.length < 20) return null;
  const efficiency = pathEfficiency(rows);
  const recentUnit = median(rows.slice(-10).map((row) => row.high - row.low));
  const priorUnit = median(rows.slice(-30, -10).map((row) => row.high - row.low));
  if (recentUnit < priorUnit * 0.78) return "COMPRESSION";
  if (efficiency >= 0.38) return "TREND";
  return "RANGE";
}
