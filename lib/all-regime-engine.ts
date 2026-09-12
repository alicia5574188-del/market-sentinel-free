import type { Side } from "./liquidity-core.ts";

export const ALL_REGIME_ENGINE_VERSION = 4;
export const ALL_REGIME_SYSTEM_NAME = "全境·复利引擎";

export type AllRegimeStrategyId = "momentum_carry" | "tide_catchup" | "quiet_drift" | "impulse_recoil"
  | "impulse_fold" | "tide_relay";
export type AllRegimeEnvironment = "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION";
export type AllRegimeCandle = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type AllRegimeRoute = {
  version: 4;
  strategyId: AllRegimeStrategyId;
  strategyName: "势承" | "潮补" | "静移" | "冲衡" | "脉折" | "潮接";
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
  sourceDirection?: 1 | -1;
  localMoveRate?: number;
  researchVariant?: string;
};

export const ALL_REGIME_STRATEGIES = [
  { id: "momentum_carry", name: "势承", environment: "TREND", description: "方向路径仍高效时，等待逆向扰动衰减并在恢复点接回主路径。" },
  { id: "tide_catchup", name: "潮补", environment: "TREND", description: "全市场主潮明确时，只接入仍有空间、刚恢复推进的相对落后币种。" },
  { id: "quiet_drift", name: "静移", environment: "COMPRESSION", description: "局部波动收缩但价格持续单向迁移时，在完成段恢复点顺势进入。" },
  { id: "impulse_recoil", name: "冲衡", environment: "EXHAUSTION", description: "孤立脉冲被下一完成段明显回收时，沿回归平衡方向交易。" },
  { id: "impulse_fold", name: "脉折", environment: "EXHAUSTION", description: "短中周期脉冲创新极值后失效，只在历史获利状态格执行折返。" },
  { id: "tide_relay", name: "潮接", environment: "TREND", description: "主潮中的短暂逆向扰动结束后，在完成段重新接回方向。" },
] as const;

export const ALL_REGIME_OFFLINE_VALIDATION = {
  momentum_carry: { branchName: "势承·时间集中待验证", trainEvents: 108, trainProfitFactor: 1.91,
    validationEvents: 96, validationProfitFactor: 1.34, validationWinRate: 0.40, paperApproved: false },
  tide_catchup: { branchName: "潮补·压缩普涨低位/有序普跌高位", trainEvents: 71, trainProfitFactor: 1.70,
    validationEvents: 37, validationProfitFactor: 1.92, validationWinRate: 0.32, paperApproved: true },
  quiet_drift: { branchName: "静移·压缩/轮动混合中位", trainEvents: 65, trainProfitFactor: 1.49,
    validationEvents: 66, validationProfitFactor: 1.45, validationWinRate: 0.35, paperApproved: true },
  impulse_recoil: { branchName: "冲衡·扩张普涨高位", trainEvents: 67, trainProfitFactor: 1.79,
    validationEvents: 31, validationProfitFactor: 1.08, validationWinRate: 0.39, paperApproved: true },
  impulse_fold: { branchName: "脉折·样本状态漂移待验证", trainEvents: 18, trainProfitFactor: 1.20,
    validationEvents: 18, validationProfitFactor: 1.12, validationWinRate: 0.39, paperApproved: false },
  tide_relay: { branchName: "潮接·扩张普涨高位", trainEvents: 68, trainProfitFactor: 1.37,
    validationEvents: 57, validationProfitFactor: 1.60, validationWinRate: 0.44, paperApproved: true },
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
  const route: AllRegimeRoute = { version: 4, strategyId: "momentum_carry", strategyName: "势承", environment: "TREND", side,
    score: clamp(58 + efficiency * 32 + clamp(displacement / Math.max(unit * 12, 1e-9), 0, 1) * 10, 0, 98),
    triggerPrice: latest.close, invalidationPrice: stop, profitArmPrice: latest.close + direction * risk * 1.8,
    maxHoldMinutes: 180, noProgressMinutes: 45, structureId: `carry:${side}:${priceBin(pauseExtreme)}:${latest.time}`,
    reason: `30段方向效率${Math.round(efficiency * 100)}%，逆向扰动未破坏主路径，最新完成段恢复推进。` };
  return valid(route) ? route : null;
}

function quietDrift(rows: AllRegimeCandle[]): AllRegimeRoute | null {
  const latest = rows.at(-1)!;
  const recent = rows.slice(-6);
  const prior = rows.slice(-24, -6);
  const recentUnit = median(recent.map((row) => row.high - row.low));
  const priorUnit = median(prior.map((row) => row.high - row.low));
  const direction: 1 | -1 = recent.at(-2)!.close >= recent[0].open ? 1 : -1;
  const displacement = direction * (recent.at(-2)!.close - recent[0].open);
  const aligned = recent.slice(1, -1).filter((row, index) => direction * (row.close - recent[index].close) > 0).length;
  const resumed = direction > 0 ? latest.close > Math.max(...recent.slice(0, -1).map((row) => row.close))
    : latest.close < Math.min(...recent.slice(0, -1).map((row) => row.close));
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (recentUnit > priorUnit * 0.85 || pathEfficiency(recent.slice(0, -1)) < 0.5
    || displacement < recentUnit * 1.6 || aligned < 3 || !resumed
    || direction * (latest.close - latest.open) < recentUnit * 0.25 || closeLocation < 0.58) return null;
  const side: Side = direction > 0 ? "LONG" : "SHORT";
  const stop = direction > 0 ? Math.min(...recent.map((row) => row.low)) - recentUnit * 0.2
    : Math.max(...recent.map((row) => row.high)) + recentUnit * 0.2;
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 4, strategyId: "quiet_drift", strategyName: "静移", environment: "COMPRESSION", side,
    score: clamp(66 + pathEfficiency(recent) * 24, 0, 97), triggerPrice: latest.close, invalidationPrice: stop,
    profitArmPrice: latest.close + direction * risk * 1.7, maxHoldMinutes: 90, noProgressMinutes: 25,
    structureId: `quiet-drift:${side}:${priceBin(stop)}:${latest.time}`, researchVariant: "quiet_drift:2",
    reason: `局部振幅收缩至前段的${Math.round(recentUnit / Math.max(priorUnit, 1e-9) * 100)}%，连续迁移后由最新完成段恢复。` };
  return valid(route) ? route : null;
}

function impulseRecoil(rows: AllRegimeCandle[]): AllRegimeRoute | null {
  const latest = rows.at(-1)!;
  const impulse = rows.at(-2)!;
  const prior = rows.slice(-26, -2);
  const unit = median(prior.map((row) => row.high - row.low));
  const direction: 1 | -1 = impulse.close >= impulse.open ? 1 : -1;
  const impulseRange = impulse.high - impulse.low;
  const impulseBody = Math.abs(impulse.close - impulse.open);
  const retrace = direction > 0 ? (impulse.close - latest.close) / Math.max(impulseBody, 1e-12)
    : (latest.close - impulse.close) / Math.max(impulseBody, 1e-12);
  const reversed = direction > 0 ? latest.close < latest.open : latest.close > latest.open;
  const closeLocation = direction > 0 ? (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12);
  if (impulseRange < unit * 2 || impulseBody < impulseRange * 0.6 || !reversed || retrace < 0.4 || closeLocation < 0.62) return null;
  const side: Side = direction > 0 ? "SHORT" : "LONG";
  const sign = side === "LONG" ? 1 : -1;
  const extreme = direction > 0 ? Math.max(impulse.high, latest.high) : Math.min(impulse.low, latest.low);
  const stop = extreme - sign * unit * 0.2;
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 4, strategyId: "impulse_recoil", strategyName: "冲衡", environment: "EXHAUSTION", side,
    score: clamp(64 + clamp(retrace, 0, 1) * 24, 0, 97), triggerPrice: latest.close, invalidationPrice: stop,
    profitArmPrice: latest.close + sign * risk * 1.8, maxHoldMinutes: 100, noProgressMinutes: 25,
    structureId: `impulse-recoil:${side}:${priceBin(extreme)}:${latest.time}`, sourceDirection: direction,
    researchVariant: "impulse_recoil:0", reason: `孤立脉冲被最新完成段回收${Math.round(retrace * 100)}%，向平衡方向折返。` };
  return valid(route) ? route : null;
}

function impulseFold(rows: AllRegimeCandle[], unit: number): AllRegimeRoute | null {
  const base = rows.slice(-12);
  const latest = base.at(-1)!;
  const drive = base.slice(0, -3);
  const turn = base.slice(-3);
  const direction: 1 | -1 = drive.at(-1)!.close >= drive[0].open ? 1 : -1;
  const displacement = direction * (drive.at(-1)!.close - drive[0].open);
  const extreme = direction > 0 ? Math.max(...turn.map((row) => row.high)) : Math.min(...turn.map((row) => row.low));
  const newExtreme = direction > 0 ? extreme >= Math.max(...drive.map((row) => row.high))
    : extreme <= Math.min(...drive.map((row) => row.low));
  const reclaimed = direction > 0 ? latest.close < turn.at(-2)!.open && latest.close < latest.open
    : latest.close > turn.at(-2)!.open && latest.close > latest.open;
  if (pathEfficiency(drive) < 0.48 || displacement < unit * 3 || !newExtreme || !reclaimed) return null;
  const side: Side = direction > 0 ? "SHORT" : "LONG";
  const sign = side === "LONG" ? 1 : -1;
  const stop = extreme - sign * unit * 0.25;
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 4, strategyId: "impulse_fold", strategyName: "脉折", environment: "EXHAUSTION", side,
    score: clamp(66 + pathEfficiency(drive) * 22, 0, 97), triggerPrice: latest.close, invalidationPrice: stop,
    profitArmPrice: latest.close + sign * risk * 1.8, maxHoldMinutes: 100, noProgressMinutes: 25,
    structureId: `impulse-fold:${side}:${priceBin(extreme)}:${latest.time}`, sourceDirection: direction,
    researchVariant: "impulse_fold:0", reason: `短脉冲保持新极值但最新完成段反向收复，只在历史获利状态格折返。` };
  return valid(route) ? route : null;
}

function tideCatchup(rows: AllRegimeCandle[], direction: 1 | -1): AllRegimeRoute | null {
  const latest = rows.at(-1)!;
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const lag = rows.slice(-10, -1);
  const lagMove = (lag.at(-1)!.close - lag[0].open) / lag[0].open;
  const resumed = direction > 0 ? latest.close > rows.at(-2)!.close : latest.close < rows.at(-2)!.close;
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  const range = rows.slice(-36);
  const lower = Math.min(...range.map((row) => row.low)); const upper = Math.max(...range.map((row) => row.high));
  const position = (latest.close - lower) / Math.max(upper - lower, 1e-12);
  const room = direction > 0 ? position <= 0.75 : position >= 0.25;
  if (!resumed || direction * (latest.close - latest.open) < unit * 0.25 || closeLocation < 0.58 || !room) return null;
  const side: Side = direction > 0 ? "LONG" : "SHORT";
  const extreme = direction > 0 ? Math.min(...lag.map((row) => row.low)) : Math.max(...lag.map((row) => row.high));
  const stop = direction > 0 ? extreme - unit * 0.2 : extreme + unit * 0.2;
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 4, strategyId: "tide_catchup", strategyName: "潮补", environment: "TREND", side,
    score: clamp(64 + clamp(Math.abs(lagMove) / 0.01, 0, 1) * 20, 0, 97), triggerPrice: latest.close,
    invalidationPrice: stop, profitArmPrice: latest.close + direction * risk * 1.7, maxHoldMinutes: 100, noProgressMinutes: 25,
    structureId: `tide-catchup:${side}:${priceBin(extreme)}:${latest.time}`, sourceDirection: direction,
    localMoveRate: lagMove, researchVariant: "tide_catchup:2",
    reason: `相对全市场主潮仍落后，最新完成段恢复${side === "LONG" ? "向上" : "向下"}推进且结构内仍有空间。` };
  return valid(route) ? route : null;
}

function tideRelay(rows: AllRegimeCandle[], direction: 1 | -1): AllRegimeRoute | null {
  const latest = rows.at(-1)!; const path = rows.slice(-20); const preResume = path.slice(0, -1);
  const earlier = preResume.slice(0, -2); const lag = preResume.slice(-2);
  const unit = median(rows.slice(-36).map((row) => row.high - row.low));
  const alignedDisplacement = direction * (earlier.at(-1)!.close - earlier[0].open);
  const lagMove = direction * (lag.at(-1)!.close - lag[0].open);
  const reclaim = direction > 0 ? latest.close > Math.max(...lag.map((row) => row.close))
    : latest.close < Math.min(...lag.map((row) => row.close));
  const closeLocation = direction > 0 ? (latest.close - latest.low) / Math.max(latest.high - latest.low, 1e-12)
    : (latest.high - latest.close) / Math.max(latest.high - latest.low, 1e-12);
  if (pathEfficiency(earlier) < 0.32 || alignedDisplacement < unit * 2.8 || lagMove > -unit * 0.25
    || direction * (latest.close - latest.open) < unit * 0.4 || !reclaim || closeLocation < 0.6) return null;
  const side: Side = direction > 0 ? "LONG" : "SHORT";
  const extreme = direction > 0 ? Math.min(...lag.map((row) => row.low)) : Math.max(...lag.map((row) => row.high));
  const stop = direction > 0 ? extreme - unit * 0.2 : extreme + unit * 0.2;
  const risk = Math.abs(latest.close - stop);
  const route: AllRegimeRoute = { version: 4, strategyId: "tide_relay", strategyName: "潮接", environment: "TREND", side,
    score: clamp(65 + pathEfficiency(earlier) * 22, 0, 97), triggerPrice: latest.close, invalidationPrice: stop,
    profitArmPrice: latest.close + direction * risk * 1.7, maxHoldMinutes: 120, noProgressMinutes: 30,
    structureId: `tide-relay:${side}:${priceBin(extreme)}:${latest.time}`, sourceDirection: direction,
    researchVariant: "tide_relay:2", reason: `主潮短暂逆向扰动后，最新完成段重新接回原方向。` };
  return valid(route) ? route : null;
}

export function detectAllRegimeRoutes(candles: AllRegimeCandle[]) {
  const rows = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
    && row.open > 0 && row.low > 0 && row.high >= row.low).map((row) => [row.time, row])).values()]
    .sort((a, b) => a.time - b.time).slice(-120);
  if (rows.length < 50) return [];
  const unit = median(rows.slice(-48).map((row) => row.high - row.low));
  if (!(unit > 0)) return [];
  return [quietDrift(rows), impulseRecoil(rows), impulseFold(rows, unit), momentumCarry(rows, unit),
    ...([-1, 1] as const).flatMap((direction) => [tideCatchup(rows, direction), tideRelay(rows, direction)])]
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
