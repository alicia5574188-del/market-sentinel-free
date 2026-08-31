import type { AppSettings } from "./settings-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import type { MarketAnalysisPacket } from "./exchange-market.ts";
import type { ResonanceMarketView } from "./resonance-brain.ts";
import type { ResonanceSystemReview } from "./resonance-review.ts";
import { tryOpenHte31Trade } from "./hte31-repository.ts";

function sideFromFourHour(packet: MarketAnalysisPacket) {
  const trend = packet.market.timeframeTrend4h ?? 0;
  if (Math.abs(trend) < 0.35) return null;
  return trend > 0 ? "LONG" as const : "SHORT" as const;
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
 * The five playbooks are specialists, not five independent market brains.
 * A strong market view can keep an opposite setup in observation instead of
 * opening it. Only one learned behavior is allowed today: if two consecutive
 * five-trade reviews independently identify direction as the dominant error,
 * the existing 4h structure becomes a harder alignment rule. Other review
 * conclusions remain challenger hypotheses until they have more evidence.
 */
export async function tryOpenResonanceTrade(
  packet: MarketAnalysisPacket,
  signals: Hte31Signal[],
  candles: Hte31Candle[],
  settings: AppSettings,
  marketView: ResonanceMarketView,
  review: ResonanceSystemReview,
) {
  const eligibleSignals = signals.filter((signal) => !conflictsWithDirection(signal, packet, marketView, review));
  if (eligibleSignals.length !== signals.length && !eligibleSignals.some((signal) => signal.state === "ready" && signal.entryPlan?.ready)) {
    const learned = review.directive === "respect_4h_direction" ? " · 最近两轮复盘都指向方向问题" : "";
    return {
      opened: null,
      reason: `系统方向门控：${marketView.headline}（${marketView.confidence}%）${learned}，反向 Setup 继续观察但不新开仓`,
    };
  }
  return tryOpenHte31Trade(packet, eligibleSignals, candles, settings);
}
