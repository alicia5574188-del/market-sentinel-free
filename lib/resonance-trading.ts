import type { AppSettings } from "./settings-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import type { MarketAnalysisPacket } from "./exchange-market.ts";
import type { ResonanceMarketView } from "./resonance-brain.ts";
import { tryOpenHte31Trade } from "./hte31-repository.ts";

function conflictsWithStrongDirection(signal: Hte31Signal, marketView: ResonanceMarketView) {
  if (!marketView.strongDirection || marketView.bias === "NEUTRAL" || signal.side === "WAIT") return false;
  return signal.side !== marketView.bias;
}

/**
 * The five playbooks are specialists, not five independent market brains.
 * When the top-level market view is unusually clear, a specialist may still
 * observe an opposite setup but it cannot open a new paper position. This is
 * intentionally a single, visible rule rather than trader-specific patches.
 */
export async function tryOpenResonanceTrade(
  packet: MarketAnalysisPacket,
  signals: Hte31Signal[],
  candles: Hte31Candle[],
  settings: AppSettings,
  marketView: ResonanceMarketView,
) {
  const eligibleSignals = signals.filter((signal) => !conflictsWithStrongDirection(signal, marketView));
  if (eligibleSignals.length !== signals.length && !eligibleSignals.some((signal) => signal.state === "ready" && signal.entryPlan?.ready)) {
    return {
      opened: null,
      reason: `系统方向门控：${marketView.headline}（${marketView.confidence}%），反向 Setup 继续观察但不新开仓`,
    };
  }
  return tryOpenHte31Trade(packet, eligibleSignals, candles, settings);
}
