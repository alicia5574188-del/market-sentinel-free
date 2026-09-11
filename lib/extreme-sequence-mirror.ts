import type { Side } from "./liquidity-core.ts";

export const EXTREME_SEQUENCE_VERSION = 1;
export const EXTREME_SEQUENCE_NAME = "极序·镜转";
export const EXTREME_SEQUENCE_STREAK = 3;
export const EXTREME_SEQUENCE_STREAK_MAX_SPAN_MS = 24 * 60 * 60_000;
export const EXTREME_SEQUENCE_SYMBOL_COOLDOWN_MS = 30 * 60_000;

export type ExtremeSequenceBranch = "FISSION" | "SNAPBACK";

export type ExtremeSequencePath = {
  version: 1;
  branch: ExtremeSequenceBranch;
  baseSide: Side;
  score: number;
  triggerPrice: number;
  invalidationPrice: number;
  profitArmPrice: number;
  maxHoldMinutes: number;
  noProgressMinutes: number;
  structureId: string;
  reason: string;
};

export type ExtremeSequenceCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

const FRICTION_RATE = 0.0014;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const mean = (values: number[]) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length : 0;
const direction = (side: Side) => side === "LONG" ? 1 : -1;
const priceBin = (price: number) => Math.round(Math.log(Math.max(price, 1e-12)) / Math.log(1.0025));

function geometry(entry: number, side: Side, structuralInvalidation: number, averageRangeRate: number, netR: number) {
  const sign = direction(side);
  const structuralRate = sign * (entry - structuralInvalidation) / Math.max(entry, 1e-9);
  const stopRate = clamp(Math.max(0.0022, averageRangeRate * 1.15, structuralRate), 0.0022, 0.025);
  const invalidationPrice = entry * (1 - sign * stopRate);
  const armRate = FRICTION_RATE + netR * (stopRate + FRICTION_RATE);
  return { invalidationPrice, profitArmPrice: entry * (1 + sign * armRate) };
}

/**
 * 极序·镜转只研究两类完成K线后的极端路径：
 * 1. FISSION：蓄压后的边界裂变，基础方向跟随释放；
 * 2. SNAPBACK：越界探索失败并收回，基础方向跟随回卷。
 * 方向是否进入账户不由这里决定，而由独立影子的连续胜负决定。
 */
export function detectExtremeSequencePath(candles: ExtremeSequenceCandle[]): ExtremeSequencePath | null {
  const rows = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close]
      .every(Number.isFinite) && row.time > 0 && row.open > 0 && row.close > 0 && row.high >= row.low && row.low > 0)
    .map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time).slice(-24);
  if (rows.length < 18) return null;
  const latest = rows.at(-1)!;
  const prior = rows.slice(-13, -1);
  const pathRows = rows.slice(-8);
  const priorHigh = Math.max(...prior.map((row) => row.high));
  const priorLow = Math.min(...prior.map((row) => row.low));
  const priorRanges = prior.map((row) => row.high - row.low);
  const averageRange = Math.max(mean(priorRanges), latest.close * 0.0005);
  const averageRangeRate = averageRange / latest.close;
  const latestRange = Math.max(latest.high - latest.low, latest.close * 0.00005);
  const expansion = latestRange / averageRange;
  const body = Math.abs(latest.close - latest.open) / latestRange;
  const closeLocation = (latest.close - latest.low) / latestRange;
  const closes = pathRows.map((row) => row.close);
  const traveled = closes.slice(1).reduce((total, close, index) => total + Math.abs(close - closes[index]), 0);
  const displacement = latest.close - pathRows[0].open;
  const efficiency = Math.abs(displacement) / Math.max(traveled, averageRange * 0.5);
  const priorVolumes = prior.map((row) => Math.max(0, row.volume ?? 0));
  const volumeBaseline = mean(priorVolumes);
  const volumeRatio = volumeBaseline > 0 ? Math.max(0, latest.volume ?? 0) / volumeBaseline : 1;
  const upBreak = latest.close > priorHigh && latest.close - priorHigh <= averageRange * 1.25;
  const downBreak = latest.close < priorLow && priorLow - latest.close <= averageRange * 1.25;
  const alignedClose = upBreak ? closeLocation >= 0.72 && latest.close > latest.open
    : downBreak ? closeLocation <= 0.28 && latest.close < latest.open : false;
  if ((upBreak || downBreak) && alignedClose && expansion >= 1.35 && body >= 0.58
    && efficiency >= 0.42 && Math.abs(displacement) >= averageRange * 1.8 && volumeRatio >= 0.9) {
    const baseSide: Side = upBreak ? "LONG" : "SHORT";
    const structural = baseSide === "LONG" ? Math.min(latest.low, priorHigh - averageRange * 0.12)
      : Math.max(latest.high, priorLow + averageRange * 0.12);
    const levels = geometry(latest.close, baseSide, structural, averageRangeRate, 1.8);
    const score = clamp(68 + (expansion - 1.35) * 12 + (body - 0.58) * 22
      + (efficiency - 0.42) * 18 + Math.max(0, volumeRatio - 1) * 5, 68, 100);
    return { version: EXTREME_SEQUENCE_VERSION, branch: "FISSION", baseSide, score,
      triggerPrice: latest.close, ...levels, maxHoldMinutes: 360, noProgressMinutes: 75,
      structureId: `FISSION:${latest.time}:${priceBin(priorLow)}:${priceBin(priorHigh)}`,
      reason: "蓄压路径越过旧边界，最新完整K线保留大部分位移；基础假设为释放延续" };
  }

  const sweptHigh = latest.high > priorHigh + averageRange * 0.12 && latest.close < priorHigh - averageRange * 0.05;
  const sweptLow = latest.low < priorLow - averageRange * 0.12 && latest.close > priorLow + averageRange * 0.05;
  const upperWick = (latest.high - Math.max(latest.open, latest.close)) / latestRange;
  const lowerWick = (Math.min(latest.open, latest.close) - latest.low) / latestRange;
  const rejected = sweptHigh ? upperWick >= 0.38 && closeLocation <= 0.58
    : sweptLow ? lowerWick >= 0.38 && closeLocation >= 0.42 : false;
  if ((sweptHigh || sweptLow) && rejected && expansion >= 1.18 && volumeRatio >= 0.9) {
    const baseSide: Side = sweptHigh ? "SHORT" : "LONG";
    const structural = baseSide === "LONG" ? latest.low - averageRange * 0.12 : latest.high + averageRange * 0.12;
    const levels = geometry(latest.close, baseSide, structural, averageRangeRate, 1.65);
    const wick = sweptHigh ? upperWick : lowerWick;
    const score = clamp(66 + (expansion - 1.18) * 11 + (wick - 0.38) * 25
      + Math.max(0, volumeRatio - 1) * 5, 66, 100);
    return { version: EXTREME_SEQUENCE_VERSION, branch: "SNAPBACK", baseSide, score,
      triggerPrice: latest.close, ...levels, maxHoldMinutes: 240, noProgressMinutes: 60,
      structureId: `SNAPBACK:${latest.time}:${priceBin(priorLow)}:${priceBin(priorHigh)}`,
      reason: "价格刺穿旧边界后在完整K线内收回并留下拒绝尾部；基础假设为越界失败后的回卷" };
  }
  return null;
}

