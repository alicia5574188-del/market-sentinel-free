import type { AppSettings } from "./settings-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import type { MarketAnalysisPacket } from "./exchange-market.ts";
import type { ResonanceMarketView } from "./resonance-brain.ts";
import type { ResonanceSystemReview } from "./resonance-review.ts";
import { tryOpenHte31Trade } from "./hte31-repository.ts";

const SAFETY_CHECKS = new Set(["hte-data", "hte-liquidity", "hte-funding", "hte-event", "hte-stop", "hte-router"]);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function direction(side: "LONG" | "SHORT") {
  return side === "LONG" ? 1 : -1;
}

function sideFromFourHour(packet: MarketAnalysisPacket) {
  const trend = packet.market.timeframeTrend4h ?? 0;
  if (Math.abs(trend) < 0.28) return null;
  return trend > 0 ? "LONG" as const : "SHORT" as const;
}

function atr(candles: Hte31Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  const recent = ranges.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function volumeRatio(candles: Hte31Candle[]) {
  if (candles.length < 22) return 1;
  const baseline = candles.slice(-21, -1).reduce((sum, row) => sum + row.volume, 0) / 20;
  return candles.at(-1)!.volume / Math.max(baseline, Number.EPSILON);
}

function signed(value: number | null | undefined, side: "LONG" | "SHORT") {
  return (value ?? 0) * direction(side);
}

function continuationTiming(signal: Hte31Signal, packet: MarketAnalysisPacket, candles: Hte31Candle[], marketView: ResonanceMarketView) {
  if (signal.side === "WAIT" || !marketView.strongDirection || marketView.bias !== signal.side) return false;
  const rows = candles.slice(-12);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const currentAtr = atr(candles);
  if (!latest || !previous || currentAtr == null || !(currentAtr > 0)) return false;

  const side = signal.side;
  const priorRows = rows.slice(0, -1);
  const pullbackSeen = side === "LONG"
    ? priorRows.some((row, index) => row.close < row.open || (index > 0 && row.close < priorRows[index - 1].close))
    : priorRows.some((row, index) => row.close > row.open || (index > 0 && row.close > priorRows[index - 1].close));
  const body = Math.abs(latest.close - latest.open);
  const resumed = side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close && body >= currentAtr * 0.16
    : latest.close < latest.open && latest.close < previous.close && body >= currentAtr * 0.16;
  const meanClose = rows.slice(-5).reduce((sum, row) => sum + row.close, 0) / Math.min(5, rows.length);
  const notExtended = Math.abs(latest.close - meanClose) <= currentAtr * 1.15;
  const flowOkay = signed(packet.market.spotCvdRatio, side) >= -0.0025
    && signed(packet.market.orderBookImbalance, side) >= -0.05;
  return pullbackSeen && resumed && notExtended && flowOkay;
}

function exceptionalBreakout(signal: Hte31Signal, packet: MarketAnalysisPacket, candles: Hte31Candle[]) {
  if (signal.side === "WAIT") return false;
  const latest = candles.at(-1);
  const currentAtr = atr(candles);
  if (!latest || currentAtr == null || !(currentAtr > 0)) return false;
  const body = Math.abs(latest.close - latest.open);
  const range = latest.high - latest.low;
  const directionalFlow = signed(packet.market.spotCvdRatio, signal.side);
  return range >= currentAtr * 1.05
    && body >= currentAtr * 0.42
    && volumeRatio(candles) >= 1.15
    && directionalFlow >= 0;
}

function improveEntryTiming(signal: Hte31Signal, packet: MarketAnalysisPacket, candles: Hte31Candle[], marketView: ResonanceMarketView): Hte31Signal {
  if (signal.side === "WAIT" || !signal.entryPlan) return signal;

  // A raw breakout is no longer enough by itself. Either the impulse is truly
  // exceptional or price must show a pullback/resumption pattern before entry.
  if (signal.strategyId === "trend_breakout" && signal.state === "ready" && signal.entryPlan.ready) {
    if (!exceptionalBreakout(signal, packet, candles) && !continuationTiming(signal, packet, candles, marketView)) {
      return {
        ...signal,
        state: "watching",
        blockers: [...signal.blockers, "等待突破回踩/更强动量确认"],
      };
    }
    return signal;
  }

  if (signal.state === "ready" && signal.entryPlan.ready) return signal;
  if (![("trend_breakout"), ("trend_pullback")].includes(signal.strategyId)) return signal;
  if (marketView.confidence < 68 || signal.confidence < 70) return signal;
  if (signal.strategyMeta.setupScore < 55 || signal.strategyMeta.evidenceScore < 55) return signal;

  const failedRequired = signal.entryPlan.checks.filter((check) => check.required && !check.passed);
  if (failedRequired.some((check) => SAFETY_CHECKS.has(check.key))) return signal;
  if (failedRequired.length === 0 || failedRequired.length > 2) return signal;
  if (!continuationTiming(signal, packet, candles, marketView)) return signal;

  return {
    ...signal,
    state: "ready",
    reasons: [...signal.reasons, "Resonance大方向一致后的二次入场确认"],
    blockers: signal.blockers.filter((item) => !item.includes("未通过")),
    entryPlan: {
      ...signal.entryPlan,
      ready: true,
      checks: [
        ...signal.entryPlan.checks,
        {
          key: "resonance-continuation-timing",
          label: "大方向一致后的回踩恢复",
          passed: true,
          required: true,
          detail: "不降低安全门槛，只替代过于瞬时的局部触发",
        },
      ],
    },
  };
}

function recentRangePct(candles: Hte31Candle[], entryPrice: number) {
  const rows = candles.slice(-48);
  if (!rows.length || !(entryPrice > 0)) return 0;
  const high = Math.max(...rows.map((row) => row.high));
  const low = Math.min(...rows.map((row) => row.low));
  return (high - low) / entryPrice * 100;
}

function marketTarget(signal: Hte31Signal, packet: MarketAnalysisPacket, candles: Hte31Candle[], marketView: ResonanceMarketView): Hte31Signal {
  if (signal.side === "WAIT" || !signal.entryPlan) return signal;
  const plan = signal.entryPlan;
  const entry = plan.entryPrice;
  const stopDistance = Math.abs(entry - plan.stopLossPrice);
  if (!(entry > 0 && stopDistance > 0)) return signal;

  const riskPct = stopDistance / entry * 100;
  const sideDirection = direction(signal.side);
  const historyMovePct = marketView.expectedMovePct * sideDirection > 0 ? Math.abs(marketView.expectedMovePct) : 0;
  const localRangePct = recentRangePct(candles, entry);
  const higherTrend = Math.abs(packet.market.timeframeTrend4h ?? 0);
  const structureProjectionPct = localRangePct * clamp(0.42 + higherTrend * 0.55, 0.42, 0.92);
  const originalProjectionPct = plan.riskReward * riskPct;

  const projectedMovePct = historyMovePct > 0
    ? historyMovePct * 0.62 + structureProjectionPct * 0.38
    : structureProjectionPct * 0.68 + originalProjectionPct * 0.32;
  const styleFactor = signal.strategyId === "higher_timeframe_swing" ? 1.18
    : signal.strategyId === "trend_exhaustion_reversal" || signal.strategyId === "failed_breakout" ? 0.84
      : 1;
  const convictionFactor = marketView.strongDirection && marketView.bias === signal.side
    ? 1 + clamp((marketView.confidence - 62) / 100, 0, 0.28)
    : 0.88;
  const targetR = clamp(projectedMovePct * styleFactor * convictionFactor / Math.max(riskPct, 0.01), 1, 20);
  const takeProfit2Price = entry + sideDirection * stopDistance * targetR;
  const maxHoldingMinutes = targetR >= 10 ? Math.max(plan.maxHoldingMinutes, 720)
    : targetR >= 6 ? Math.max(plan.maxHoldingMinutes, 480)
      : targetR >= 4 ? Math.max(plan.maxHoldingMinutes, 360)
        : plan.maxHoldingMinutes;

  return {
    ...signal,
    thesis: `${signal.thesis} 市场空间目标：${targetR.toFixed(2)}R（历史/结构决定，不按固定USDT凑目标）。`,
    entryPlan: {
      ...plan,
      takeProfit2Price,
      riskReward: targetR,
      maxHoldingMinutes,
    },
  };
}

function conflictsWithDirection(
  signal: Hte31Signal,
  packet: MarketAnalysisPacket,
  marketView: ResonanceMarketView,
  review: ResonanceSystemReview,
) {
  if (signal.side === "WAIT") return false;
  if (review.directive === "respect_4h_direction") {
    const fourHourSide = sideFromFourHour(packet);
    if (fourHourSide && signal.side !== fourHourSide) return true;
  }
  if (!marketView.strongDirection || marketView.bias === "NEUTRAL") return false;
  return signal.side !== marketView.bias;
}

/**
 * Resonance owns direction, timing and target-space orchestration. HT1–HT5 are
 * specialists that describe setups; they no longer get to chase a local signal
 * against a strong system direction, and sizing never manufactures a preferred
 * USDT target. Near-ready continuation entries are allowed only when all safety
 * checks pass, the system direction is strong, and 5m price confirms a pullback
 * followed by resumption.
 */
export async function tryOpenResonanceTrade(
  packet: MarketAnalysisPacket,
  signals: Hte31Signal[],
  candles: Hte31Candle[],
  settings: AppSettings,
  marketView: ResonanceMarketView,
  review: ResonanceSystemReview,
) {
  const timedSignals = signals.map((signal) => improveEntryTiming(signal, packet, candles, marketView));
  const directionEligible = timedSignals.filter((signal) => !conflictsWithDirection(signal, packet, marketView, review));
  const eligibleSignals = directionEligible.map((signal) => marketTarget(signal, packet, candles, marketView));

  if (eligibleSignals.length !== signals.length && !eligibleSignals.some((signal) => signal.state === "ready" && signal.entryPlan?.ready)) {
    const learned = review.directive === "respect_4h_direction" ? " · 最近两轮复盘都指向方向问题" : "";
    return {
      opened: null,
      reason: `系统方向门控：${marketView.headline}（${marketView.confidence}%）${learned}，反向 Setup 继续观察但不新开仓`,
    };
  }
  return tryOpenHte31Trade(packet, eligibleSignals, candles, settings);
}
