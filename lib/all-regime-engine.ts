import type { Side } from "./liquidity-core.ts";

export const ALL_REGIME_ENGINE_VERSION = 1;
export const ALL_REGIME_SYSTEM_NAME = "全境·复利引擎";

export type AllRegimeStrategyId = "momentum_carry" | "balance_return" | "pressure_release" | "exhaustion_turn";
export type AllRegimeEnvironment = "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION";
export type AllRegimeCandle = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type AllRegimeRoute = {
  version: 1;
  strategyId: AllRegimeStrategyId;
  strategyName: "势承" | "衡返" | "压跃" | "竭转";
  environment: AllRegimeEnvironment;
  side: Side;
  score: number;
  triggerPrice: number;
  invalidationPrice: number;
  profitArmPrice: number;
  maxHoldMinutes: number;
  noProgressMinutes: number;
  structureId: string;
  reason: string;
};

export const ALL_REGIME_STRATEGIES = [
  { id: "momentum_carry", name: "势承", environment: "TREND", description: "方向路径仍高效时，等待逆向扰动衰减并在恢复点接回主路径。" },
  { id: "balance_return", name: "衡返", environment: "RANGE", description: "低效往返触及外沿后重新收回平衡带，目标是回到成交重心。" },
  { id: "pressure_release", name: "压跃", environment: "COMPRESSION", description: "路径振幅持续收束后，只跟随首次带有实体与范围扩张的释放。" },
  { id: "exhaustion_turn", name: "竭转", environment: "EXHAUSTION", description: "价格继续创新极值但推进效率枯竭，反向收复后切换方向。" },
] as const;

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
  const route: AllRegimeRoute = { version: 1, strategyId: "momentum_carry", strategyName: "势承", environment: "TREND", side,
    score: clamp(58 + efficiency * 32 + clamp(displacement / Math.max(unit * 12, 1e-9), 0, 1) * 10, 0, 98),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + direction * risk * 1.8,
    maxHoldMinutes: 180, noProgressMinutes: 45, structureId: `carry:${side}:${priceBin(pauseExtreme)}:${latest.time}`,
    reason: `30段方向效率${Math.round(efficiency * 100)}%，逆向扰动未破坏主路径，最新完成段恢复推进。` };
  return valid(route) ? route : null;
}

function balanceReturn(rows: AllRegimeCandle[], unit: number): AllRegimeRoute | null {
  const base = rows.slice(-36);
  const latest = base.at(-1)!;
  const prior = base.slice(0, -2);
  const lower = Math.min(...prior.map((row) => row.low));
  const upper = Math.max(...prior.map((row) => row.high));
  const width = upper - lower;
  const efficiency = pathEfficiency(prior);
  if (efficiency > 0.34 || width < unit * 5.2) return null;
  const lowerBand = lower + width * 0.2;
  const upperBand = upper - width * 0.2;
  const recent = base.slice(-2);
  const longReclaim = Math.min(...recent.map((row) => row.low)) <= lowerBand && latest.close > lowerBand && latest.close > latest.open;
  const shortReclaim = Math.max(...recent.map((row) => row.high)) >= upperBand && latest.close < upperBand && latest.close < latest.open;
  if (!longReclaim && !shortReclaim) return null;
  const side: Side = longReclaim ? "LONG" : "SHORT";
  const sign = side === "LONG" ? 1 : -1;
  const edge = side === "LONG" ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = edge - sign * unit * 0.35;
  const midpoint = (lower + upper) / 2;
  const arm = side === "LONG" ? Math.max(midpoint, latest.close + Math.abs(latest.close - stop) * 1.55)
    : Math.min(midpoint, latest.close - Math.abs(latest.close - stop) * 1.55);
  const route: AllRegimeRoute = { version: 1, strategyId: "balance_return", strategyName: "衡返", environment: "RANGE", side,
    score: clamp(62 + (0.34 - efficiency) * 55 + clamp(width / Math.max(unit * 12, 1e-9), 0, 1) * 14, 0, 97),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: arm, maxHoldMinutes: 150, noProgressMinutes: 40,
    structureId: `balance:${side}:${priceBin(lower)}:${priceBin(upper)}:${latest.time}`,
    reason: `平衡路径效率${Math.round(efficiency * 100)}%，外沿压力被完成段收回，向重心旋转。` };
  return valid(route) ? route : null;
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
  const route: AllRegimeRoute = { version: 1, strategyId: "pressure_release", strategyName: "压跃", environment: "COMPRESSION", side,
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
  const route: AllRegimeRoute = { version: 1, strategyId: "exhaustion_turn", strategyName: "竭转", environment: "EXHAUSTION", side,
    score: clamp(62 + (0.24 - progressRatio) * 55 + clamp(displacement / Math.max(unit * 12, 1e-9), 0, 1) * 12, 0, 97),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + sign * risk * 1.75,
    maxHoldMinutes: 120, noProgressMinutes: 35, structureId: `turn:${side}:${priceBin(extreme)}:${latest.time}`,
    reason: `原方向保持新极值，但末段有效推进降至${Math.round(progressRatio * 100)}%，反向完成段已收复。` };
  return valid(route) ? route : null;
}

export function detectAllRegimeRoutes(candles: AllRegimeCandle[]) {
  const rows = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
    && row.open > 0 && row.low > 0 && row.high >= row.low).map((row) => [row.time, row])).values()]
    .sort((a, b) => a.time - b.time).slice(-120);
  if (rows.length < 50) return [];
  const unit = median(rows.slice(-48).map((row) => row.high - row.low));
  if (!(unit > 0)) return [];
  return [pressureRelease(rows, unit), exhaustionTurn(rows, unit), momentumCarry(rows, unit), balanceReturn(rows, unit)]
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
