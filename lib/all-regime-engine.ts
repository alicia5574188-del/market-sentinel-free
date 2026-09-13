import type { Side } from "./liquidity-core.ts";

export const ALL_REGIME_ENGINE_VERSION = 5;
export const ALL_REGIME_SYSTEM_NAME = "全境·复利引擎";

export type AllRegimeStrategyId = "range_reentry" | "channel_break" | "trend_pullback" | "bear_squeeze" | "bull_pullback";
export type AllRegimeEnvironment = "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION";
export type AllRegimeCandle = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type AllRegimeRoute = {
  version: 5;
  strategyId: AllRegimeStrategyId;
  strategyName: "界返" | "渠破" | "势回" | "熊缩" | "牛接";
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
  hardTarget?: boolean;
};

export const ALL_REGIME_STRATEGIES = [
  { id: "range_reentry", name: "界返", environment: "RANGE", description: "日线广泛上行但4小时回撤时，只做区间下沿重新收复。" },
  { id: "channel_break", name: "渠破", environment: "TREND", description: "中性偏弱市场中，沿48段通道向下破位。" },
  { id: "trend_pullback", name: "势回", environment: "TREND", description: "温和普跌阶段，捕捉个币趋势回踩后的恢复。" },
  { id: "bear_squeeze", name: "熊缩", environment: "COMPRESSION", description: "下跌环境的波动压缩释放，仅限主流高流动性合约。" },
  { id: "bull_pullback", name: "牛接", environment: "TREND", description: "广泛强势上涨中的4小时回撤压缩恢复，仅限主流合约。" },
] as const;

export const ALL_REGIME_OFFLINE_VALIDATION = {
  range_reentry: { branchName: "V5跨市场组合联合验证", trainEvents: 27, trainProfitFactor: 2.22,
    validationEvents: 30, validationProfitFactor: 1.39, validationWinRate: 0.40, paperApproved: true },
  channel_break: { branchName: "V5跨市场组合联合验证", trainEvents: 15, trainProfitFactor: 3.14,
    validationEvents: 15, validationProfitFactor: 3.12, validationWinRate: 0.47, paperApproved: true },
  trend_pullback: { branchName: "V5跨市场组合联合验证", trainEvents: 27, trainProfitFactor: 2.22,
    validationEvents: 30, validationProfitFactor: 1.39, validationWinRate: 0.40, paperApproved: true },
  bear_squeeze: { branchName: "V5跨市场组合联合验证·主流限定", trainEvents: 15, trainProfitFactor: 3.14,
    validationEvents: 15, validationProfitFactor: 3.12, validationWinRate: 0.47, paperApproved: true },
  bull_pullback: { branchName: "V5跨市场组合联合验证·主流限定", trainEvents: 15, trainProfitFactor: 3.14,
    validationEvents: 15, validationProfitFactor: 3.12, validationWinRate: 0.47, paperApproved: true },
} as const;

export const allRegimePaperApproved = (strategyId: string) => Boolean(
  (ALL_REGIME_OFFLINE_VALIDATION as Partial<Record<string, { paperApproved: boolean }>>)[strategyId]?.paperApproved,
);

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
const valid = (route: AllRegimeRoute) => route.side === "LONG"
  ? route.invalidationPrice < route.triggerPrice && route.profitArmPrice > route.triggerPrice
  : route.invalidationPrice > route.triggerPrice && route.profitArmPrice < route.triggerPrice;

const V5_MAJOR_SYMBOLS = new Set(["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT", "ADA_USDT", "LINK_USDT"]);

function ema(values: number[], span: number) {
  const alpha = 2 / (span + 1); const result: number[] = [];
  for (const value of values) result.push(result.length ? alpha * value + (1 - alpha) * result.at(-1)! : value);
  return result;
}

function indicatorSnapshot(rows: AllRegimeCandle[]) {
  const closes = rows.map((row) => row.close); const index = rows.length - 1; const priorIndex = index - 1;
  const ema12 = ema(closes, 12); const ema48 = ema(closes, 48); const ema144 = ema(closes, 144);
  const trueRanges = rows.map((row, cursor) => cursor === 0 ? row.high - row.low
    : Math.max(row.high - row.low, Math.abs(row.high - rows[cursor - 1].close), Math.abs(row.low - rows[cursor - 1].close)));
  const atr = trueRanges.map((_, cursor) => cursor < 35 ? Number.NaN
    : trueRanges.slice(cursor - 35, cursor + 1).reduce((total, value) => total + value, 0) / 36 / rows[cursor - 1].close);
  const gains: number[] = [Number.NaN]; const losses: number[] = [Number.NaN];
  for (let cursor = 1; cursor < rows.length; cursor += 1) {
    const delta = closes[cursor] - closes[cursor - 1]; gains.push(Math.max(0, delta)); losses.push(Math.max(0, -delta));
  }
  const smooth = (values: number[]) => {
    const output: number[] = [Number.NaN]; let current = Number.NaN;
    for (let cursor = 1; cursor < values.length; cursor += 1) {
      current = Number.isFinite(current) ? current * 13 / 14 + values[cursor] / 14 : values[cursor]; output.push(current);
    }
    return output;
  };
  const avgGain = smooth(gains); const avgLoss = smooth(losses);
  const rsi = avgLoss[index] > 0 ? 100 - 100 / (1 + avgGain[index] / avgLoss[index]) : 100;
  const trend = (ema48[index] / ema144[index] - 1) / Math.max(atr[index], 1e-6);
  const rollingBand = (at: number) => {
    const window = closes.slice(at - 47, at + 1); const mean = window.reduce((total, value) => total + value, 0) / window.length;
    const variance = window.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(1, window.length - 1);
    return { lower: mean - 2 * Math.sqrt(variance), upper: mean + 2 * Math.sqrt(variance) };
  };
  const atrWindow = atr.slice(index - 287, index + 1).filter(Number.isFinite);
  const volRatio = atr[index] / Math.max(atrWindow.reduce((total, value) => total + value, 0) / atrWindow.length, 1e-9);
  return { index, priorIndex, ema12, atrRate: atr[index], rsi, trend, volRatio,
    priorVolRatio: atr[priorIndex] / Math.max(atr.slice(priorIndex - 287, priorIndex + 1).filter(Number.isFinite)
      .reduce((total, value, _, values) => total + value / values.length, 0), 1e-9),
    band: rollingBand(index), priorBand: rollingBand(priorIndex),
    high24: Math.max(...rows.slice(index - 24, index).map((row) => row.high)),
    low48: Math.min(...rows.slice(index - 48, index).map((row) => row.low)),
    priorLow48: Math.min(...rows.slice(index - 49, index - 1).map((row) => row.low)),
    ret48: closes[index] / closes[index - 48] - 1 };
}

function v5Route(strategyId: Extract<AllRegimeStrategyId, "range_reentry" | "channel_break" | "trend_pullback" | "bear_squeeze" | "bull_pullback">,
  strategyName: Extract<AllRegimeRoute["strategyName"], "界返" | "渠破" | "势回" | "熊缩" | "牛接">,
  environment: AllRegimeEnvironment, latest: AllRegimeCandle, side: Side, atrRate: number, stopAtr: number,
  minStop: number, maxStop: number, reward: number, holdBars: number, score: number, reason: string) {
  const stopRate = clamp(atrRate * stopAtr, minStop, maxStop); const sign = side === "LONG" ? 1 : -1;
  const route: AllRegimeRoute = { version: 5, strategyId, strategyName, environment, side, score: clamp(score, 0, 98),
    triggerPrice: latest.close, invalidationPrice: latest.close * (1 - sign * stopRate),
    profitArmPrice: latest.close * (1 + sign * stopRate * reward), maxHoldMinutes: holdBars * 5,
    noProgressMinutes: holdBars * 5, structureId: `v5:${strategyId}:${side}:${latest.time}`,
    researchVariant: `${strategyId}:v5`, hardTarget: true, reason };
  return valid(route) ? route : null;
}

function v5Routes(rows: AllRegimeCandle[], symbol?: string) {
  if (rows.length < 324) return [];
  const latest = rows.at(-1)!; const prior = rows.at(-2)!; const value = indicatorSnapshot(rows);
  if (![value.atrRate, value.rsi, value.trend, value.volRatio, value.priorVolRatio].every(Number.isFinite)) return [];
  const major = symbol == null || V5_MAJOR_SYMBOLS.has(symbol); const routes: Array<AllRegimeRoute | null> = [];
  const rangeLong = Math.abs(value.trend) < 1.2 && latest.close > value.band.lower
    && prior.close <= value.priorBand.lower && value.rsi < 42;
  if (rangeLong) routes.push(v5Route("range_reentry", "界返", "RANGE", latest, "LONG", value.atrRate, 5, .008, .025, 1.8, 72,
    Math.abs(50 - value.rsi) + (1.2 - Math.abs(value.trend)) * 10, "区间下沿重新收复，等待全市场日线强势与4小时回撤共同确认。"));
  const channelShort = latest.close < value.low48 && prior.close >= value.priorLow48 && value.trend < -1.2;
  if (channelShort) routes.push(v5Route("channel_break", "渠破", "TREND", latest, "SHORT", value.atrRate, 6, .01, .03, 2.2, 144,
    Math.abs(value.trend) * 10 + Math.abs(value.ret48) * 100, "48段下沿完成破位，仅在全市场中性偏弱阶段执行。"));
  const pullbackLong = latest.close > value.ema12[value.index] && prior.close <= value.ema12[value.priorIndex]
    && value.trend > 1.2 && value.rsi >= 42 && value.rsi <= 66 && value.ret48 > 0;
  if (pullbackLong) routes.push(v5Route("trend_pullback", "势回", "TREND", latest, "LONG", value.atrRate, 6, .01, .03, 2.2, 144,
    Math.abs(value.trend) * 10 + Math.abs(value.rsi - 50), "个币上升趋势回踩后重新站上短均线，等待温和普跌环境确认。"));
  const squeezeLong = value.priorVolRatio < .8 && value.volRatio > value.priorVolRatio
    && latest.close > value.high24 && value.trend > .5;
  if (squeezeLong && major) {
    routes.push(v5Route("bear_squeeze", "熊缩", "COMPRESSION", latest, "LONG", value.atrRate, 6, .01, .03, 2.2, 144,
      Math.abs(value.trend) * 10 + value.volRatio * 10, "主流币波动压缩后向上释放，等待下跌环境反弹窗口确认。"));
    routes.push(v5Route("bull_pullback", "牛接", "TREND", latest, "LONG", value.atrRate, 6, .01, .03, 2.2, 144,
      Math.abs(value.trend) * 10 + value.volRatio * 10, "主流币波动压缩后向上释放，等待广泛上涨中的4小时回撤确认。"));
  }
  return routes.filter((route): route is AllRegimeRoute => route != null).sort((left, right) => right.score - left.score);
}

export function detectAllRegimeRoutes(candles: AllRegimeCandle[], symbol?: string) {
  const rows = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
    && row.open > 0 && row.low > 0 && row.high >= row.low).map((row) => [row.time, row])).values()]
    .sort((a, b) => a.time - b.time).slice(-360);
  return v5Routes(rows, symbol);
}

export function dominantAllRegimeEnvironment(candles: AllRegimeCandle[], symbol?: string): AllRegimeEnvironment | null {
  const routes = detectAllRegimeRoutes(candles, symbol);
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
