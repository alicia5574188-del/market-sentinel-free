import type { Hte31Candle } from "./hte31-types.ts";

export type Hte31CounterfactualHorizon = {
  minutes: number;
  observedAt: number;
  originalR: number;
  oppositeR: number;
};

export type Hte31CounterfactualReversal = {
  key: "after_half_r" | "after_tp1" | "after_stop";
  label: string;
  triggeredAt: number;
  triggerPrice: number;
  side: "LONG" | "SHORT";
  observedMinutes: number;
  terminalR: number;
  maxFavorableR: number;
  maxAdverseR: number;
};

export type Hte31CounterfactualReport = {
  generatedAt: number;
  horizons: Hte31CounterfactualHorizon[];
  reversals: Hte31CounterfactualReversal[];
  summary: string;
};

type TradeLike = {
  side: "LONG" | "SHORT";
  entryAt: number;
  entryPrice: number;
  initialStopPrice: number;
  exitAt?: number | null;
  exitPrice?: number | null;
  exitCode?: string | null;
};

const ENTRY_HORIZONS = [30, 60, 120, 240, 480] as const;
const REVERSAL_OBSERVE_MINUTES = 240;

function candleMs(candle: Hte31Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

function direction(side: "LONG" | "SHORT") {
  return side === "LONG" ? 1 : -1;
}

function opposite(side: "LONG" | "SHORT"): "LONG" | "SHORT" {
  return side === "LONG" ? "SHORT" : "LONG";
}

function round(value: number, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function normalizedCandles(candles: Hte31Candle[], entryAt: number) {
  const byTime = new Map<number, Hte31Candle>();
  for (const candle of candles) {
    const time = candleMs(candle);
    if (time + 60_000 < entryAt) continue;
    byTime.set(time, candle);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, candle]) => ({ ...candle, _time: time }));
}

function terminalAt<T extends { _time: number }>(rows: T[], targetAt: number) {
  const eligible = rows.filter((row) => row._time <= targetAt);
  return eligible.at(-1) ?? null;
}

function firstOriginalFavorableTrigger(rows: ReturnType<typeof normalizedCandles>, trade: TradeLike, thresholdR: number) {
  const risk = Math.abs(trade.entryPrice - trade.initialStopPrice);
  if (!(risk > 0)) return null;
  const target = trade.entryPrice + direction(trade.side) * risk * thresholdR;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row._time < trade.entryAt) continue;
    const hit = trade.side === "LONG" ? row.high >= target : row.low <= target;
    if (!hit) continue;
    const nextTime = rows[index + 1]?._time ?? row._time + 5 * 60_000;
    return { time: nextTime, price: target };
  }
  return null;
}

function reversalObservation(
  rows: ReturnType<typeof normalizedCandles>,
  risk: number,
  anchor: { time: number; price: number },
  side: "LONG" | "SHORT",
  feeR: number,
  key: Hte31CounterfactualReversal["key"],
  label: string,
): Hte31CounterfactualReversal | null {
  const after = rows.filter((row) => row._time >= anchor.time);
  if (!after.length || !(risk > 0)) return null;
  const targetAt = anchor.time + REVERSAL_OBSERVE_MINUTES * 60_000;
  const terminal = terminalAt(after, targetAt) ?? after.at(-1)!;
  const observedMinutes = Math.max(0, Math.min(REVERSAL_OBSERVE_MINUTES, (terminal._time - anchor.time) / 60_000));
  if (observedMinutes < 5) return null;
  const relevant = after.filter((row) => row._time <= terminal._time);
  const high = Math.max(anchor.price, ...relevant.map((row) => row.high));
  const low = Math.min(anchor.price, ...relevant.map((row) => row.low));
  const dir = direction(side);
  const terminalR = dir * (terminal.close - anchor.price) / risk - feeR;
  const favorableR = side === "LONG" ? (high - anchor.price) / risk : (anchor.price - low) / risk;
  const adverseR = side === "LONG" ? (anchor.price - low) / risk : (high - anchor.price) / risk;
  return {
    key,
    label,
    triggeredAt: anchor.time,
    triggerPrice: round(anchor.price, 8),
    side,
    observedMinutes: round(observedMinutes, 1),
    terminalR: round(terminalR),
    maxFavorableR: round(Math.max(0, favorableR)),
    maxAdverseR: round(Math.max(0, adverseR)),
  };
}

/**
 * Replays the path without changing the recorded trade. It answers three
 * different questions: what the original side did, what the exact opposite
 * side would have done from entry, and what a confirmed reversal would have
 * done after +0.5R, TP1, or the original structural stop.
 *
 * Intrabar ordering is deliberately conservative: a reversal anchor only
 * becomes active from the next candle after the trigger candle.
 */
export function buildHte31Counterfactual(
  trade: TradeLike,
  candles: Hte31Candle[],
  roundTripCostBps = 0,
  now = Date.now(),
): Hte31CounterfactualReport | null {
  const risk = Math.abs(trade.entryPrice - trade.initialStopPrice);
  if (!(trade.entryPrice > 0 && risk > 0)) return null;
  const rows = normalizedCandles(candles, trade.entryAt);
  if (!rows.length) return null;
  const feeR = trade.entryPrice * Math.max(0, roundTripCostBps) / 10_000 / risk;
  const originalDirection = direction(trade.side);
  const horizons: Hte31CounterfactualHorizon[] = [];
  for (const minutes of ENTRY_HORIZONS) {
    const targetAt = trade.entryAt + minutes * 60_000;
    if (now < targetAt) continue;
    const terminal = terminalAt(rows, targetAt);
    if (!terminal) continue;
    const grossOriginalR = originalDirection * (terminal.close - trade.entryPrice) / risk;
    horizons.push({
      minutes,
      observedAt: terminal._time,
      originalR: round(grossOriginalR - feeR),
      oppositeR: round(-grossOriginalR - feeR),
    });
  }

  const reverseSide = opposite(trade.side);
  const reversals: Hte31CounterfactualReversal[] = [];
  const half = firstOriginalFavorableTrigger(rows, trade, 0.5);
  if (half) {
    const result = reversalObservation(rows, risk, half, reverseSide, feeR, "after_half_r", "+0.5R 后反向");
    if (result) reversals.push(result);
  }
  const tp1 = firstOriginalFavorableTrigger(rows, trade, 1);
  if (tp1) {
    const result = reversalObservation(rows, risk, tp1, reverseSide, feeR, "after_tp1", "TP1 后反向");
    if (result) reversals.push(result);
  }
  if (trade.exitCode === "stop_loss" && trade.exitAt && trade.exitPrice) {
    const result = reversalObservation(
      rows,
      risk,
      { time: trade.exitAt, price: trade.exitPrice },
      reverseSide,
      feeR,
      "after_stop",
      "结构止损后反向",
    );
    if (result) reversals.push(result);
  }

  const reference = horizons.find((item) => item.minutes === 240) ?? horizons.at(-1) ?? null;
  const bestReverse = [...reversals].sort((a, b) => b.terminalR - a.terminalR)[0] ?? null;
  let summary = "样本仍不足以形成反事实结论；继续观察原方向、直接反向与确认后反转。";
  if (reference) {
    summary = `${reference.minutes}m 对照：原方向 ${reference.originalR.toFixed(2)}R / 入场直接反向 ${reference.oppositeR.toFixed(2)}R。`;
    if (bestReverse && bestReverse.terminalR > reference.originalR + 0.5) {
      summary += ` 当前更值得继续验证的是「${bestReverse.label}」路径（${bestReverse.terminalR.toFixed(2)}R）。`;
    } else {
      summary += " 当前没有足够证据把原策略机械反做。";
    }
  }
  return { generatedAt: now, horizons, reversals, summary };
}
