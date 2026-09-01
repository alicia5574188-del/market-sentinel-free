import type { AppSettings } from "./settings-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import type { MarketAnalysisPacket } from "./exchange-market.ts";
import type { ResonanceMarketView } from "./resonance-brain.ts";
import type { ResonanceGlobalMarketState } from "./resonance-global-market.ts";
import type { ResonanceDirective, ResonanceSystemReview } from "./resonance-review.ts";
import { openResonancePaperTrade } from "./resonance-paper-execution.ts";

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

function isTrendSetup(signal: Hte31Signal) {
  return signal.strategyId === "trend_breakout" || signal.strategyId === "trend_pullback" || signal.strategyId === "higher_timeframe_swing";
}

function setupFitsRegime(signal: Hte31Signal) {
  const regime = signal.strategyMeta.assetRegime;
  if (signal.strategyId === "trend_breakout") return ["compression", "expansion_up", "expansion_down", "trend_up", "trend_down", "transition"].includes(regime);
  if (signal.strategyId === "trend_pullback") return ["trend_up", "trend_down", "expansion_up", "expansion_down"].includes(regime);
  if (signal.strategyId === "failed_breakout") return ["range", "transition", "compression", "leverage_liquidation"].includes(regime);
  if (signal.strategyId === "trend_exhaustion_reversal") return ["expansion_up", "expansion_down", "transition", "leverage_liquidation"].includes(regime);
  if (signal.strategyId === "higher_timeframe_swing") return ["trend_up", "trend_down", "expansion_up", "expansion_down", "transition"].includes(regime);
  return true;
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

function confirmationBar(signal: Hte31Signal, packet: MarketAnalysisPacket, candles: Hte31Candle[]) {
  if (signal.side === "WAIT") return false;
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const currentAtr = atr(candles);
  if (!latest || !previous || currentAtr == null || currentAtr <= 0) return false;
  const body = Math.abs(latest.close - latest.open);
  const directional = signal.side === "LONG"
    ? latest.close > latest.open && latest.close >= previous.close
    : latest.close < latest.open && latest.close <= previous.close;
  const flowOkay = signed(packet.market.spotCvdRatio, signal.side) >= -0.0015
    && signed(packet.market.orderBookImbalance, signal.side) >= -0.03;
  return directional && body >= currentAtr * 0.18 && volumeRatio(candles) >= 1.02 && flowOkay;
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

function withCognitiveCheck(signal: Hte31Signal, key: string, label: string, detail: string): Hte31Signal {
  if (!signal.entryPlan) return signal;
  if (signal.entryPlan.checks.some((check) => check.key === key)) return signal;
  return {
    ...signal,
    reasons: [...signal.reasons, label],
    entryPlan: {
      ...signal.entryPlan,
      checks: [
        ...signal.entryPlan.checks,
        { key, label, passed: true, required: true, detail },
      ],
    },
  };
}

function improveEntryTiming(signal: Hte31Signal, packet: MarketAnalysisPacket, candles: Hte31Candle[], marketView: ResonanceMarketView): Hte31Signal {
  if (signal.side === "WAIT" || !signal.entryPlan) return signal;

  if (signal.strategyId === "trend_breakout" && signal.state === "ready" && signal.entryPlan.ready) {
    if (!exceptionalBreakout(signal, packet, candles) && !continuationTiming(signal, packet, candles, marketView)) {
      return { ...signal, state: "watching", blockers: [...signal.blockers, "等待突破回踩/更强动量确认"] };
    }
    return signal;
  }

  if (signal.state === "ready" && signal.entryPlan.ready) return signal;
  if (!isTrendSetup(signal) || signal.strategyId === "higher_timeframe_swing") return signal;
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

function applyCognitiveEntryLearning(
  signal: Hte31Signal,
  packet: MarketAnalysisPacket,
  candles: Hte31Candle[],
  marketView: ResonanceMarketView,
  review: ResonanceSystemReview,
) {
  if (signal.side === "WAIT" || !signal.entryPlan) return signal;
  let next = signal;

  if (review.directives.includes("require_retest") && isTrendSetup(next)) {
    if (!continuationTiming(next, packet, candles, marketView)) {
      next = { ...next, state: "watching", blockers: [...next.blockers, "系统复盘：等待回踩后重新启动"] };
    } else {
      next = withCognitiveCheck(next, "resonance-cognitive-retest", "复盘后增加回踩确认", "重复出现进场过早，候选规则要求回踩后重新启动");
    }
  }

  if (review.challengerSetupId === next.strategyId) {
    if (!confirmationBar(next, packet, candles)) {
      return { ...next, state: "watching", blockers: [...next.blockers, "原打法长期偏弱，挑战版本等待额外确认"] };
    }
    next = withCognitiveCheck(next, "resonance-cognitive-challenger", "弱策略认知挑战版本", "原打法长期表现偏弱，本单采用额外K线/成交量/资金流确认并仅用于模拟验证");
  }

  return next;
}

function recentRangePct(candles: Hte31Candle[], entryPrice: number) {
  const rows = candles.slice(-48);
  if (!rows.length || !(entryPrice > 0)) return 0;
  const high = Math.max(...rows.map((row) => row.high));
  const low = Math.min(...rows.map((row) => row.low));
  return (high - low) / entryPrice * 100;
}

function holdingHorizonFactor(minutes: number) {
  if (minutes >= 300) return 1.16;
  if (minutes <= 120) return 0.86;
  return 1;
}

function marketTarget(
  signal: Hte31Signal,
  packet: MarketAnalysisPacket,
  candles: Hte31Candle[],
  marketView: ResonanceMarketView,
  directives: ResonanceDirective[],
): Hte31Signal {
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
  const styleFactor = holdingHorizonFactor(plan.maxHoldingMinutes);
  const convictionFactor = marketView.strongDirection && marketView.bias === signal.side
    ? 1 + clamp((marketView.confidence - 62) / 100, 0, 0.28)
    : 0.88;
  const evidenceR = projectedMovePct / Math.max(riskPct, 0.01);
  let targetR = clamp(evidenceR * styleFactor * convictionFactor, 1, 20);
  if (directives.includes("improve_payoff") && evidenceR >= 1.8) targetR = Math.max(targetR, 2.0);

  const takeProfit2Price = entry + sideDirection * stopDistance * targetR;
  const currentTp1R = Math.abs(plan.takeProfit1Price - entry) / stopDistance;
  const delayProtection = directives.includes("delay_protection") && marketView.bias === signal.side && marketView.confidence >= 55;
  const tp1R = delayProtection ? Math.max(currentTp1R, 1.25) : currentTp1R;
  const takeProfit1Price = entry + sideDirection * stopDistance * tp1R;
  let maxHoldingMinutes = targetR >= 10 ? Math.max(plan.maxHoldingMinutes, 720)
    : targetR >= 6 ? Math.max(plan.maxHoldingMinutes, 480)
      : targetR >= 4 ? Math.max(plan.maxHoldingMinutes, 360)
        : plan.maxHoldingMinutes;
  if (delayProtection) maxHoldingMinutes = Math.max(maxHoldingMinutes, Math.round(plan.maxHoldingMinutes * 1.2));

  return {
    ...signal,
    thesis: `${signal.thesis} 市场空间目标：${targetR.toFixed(2)}R（历史/结构决定，不按固定USDT凑目标）。${delayProtection ? " 系统复盘发现保护偏早，候选方案延后TP1保护。" : ""}`,
    entryPlan: {
      ...plan,
      takeProfit1Price,
      takeProfit2Price,
      riskReward: targetR,
      maxHoldingMinutes,
    },
  };
}

function markLearnedPolicyCandidate(signal: Hte31Signal, review: ResonanceSystemReview) {
  if (!review.directives.length || signal.side === "WAIT" || !signal.entryPlan) return signal;
  return withCognitiveCheck(
    signal,
    "resonance-cognitive-policy",
    "学习规则候选，仅模拟验证",
    `当前复盘指令：${review.directives.join(",")}；在足够对照样本证明改善前禁止进入 Gate 实盘`,
  );
}

function conflictsWithDirection(
  signal: Hte31Signal,
  packet: MarketAnalysisPacket,
  globalMarket: ResonanceGlobalMarketState,
  marketView: ResonanceMarketView,
  review: ResonanceSystemReview,
) {
  if (signal.side === "WAIT") return false;

  if (review.directives.includes("respect_market_fit") && !setupFitsRegime(signal)) return true;

  if (review.directives.includes("respect_4h_direction")) {
    const fourHourSide = sideFromFourHour(packet);
    if (fourHourSide && signal.side !== fourHourSide) return true;
  }

  // Whole-market structure and the current symbol are separate layers. Stable
  // global trend only controls trend-following setups; reversal specialists are
  // still allowed to look for local exhaustion/failure patterns.
  const stableGlobalDirection = globalMarket.bias !== "NEUTRAL"
    && globalMarket.stability >= 58
    && globalMarket.transitionRisk < 64;
  if (stableGlobalDirection && isTrendSetup(signal) && signal.side !== globalMarket.bias) return true;

  if (!marketView.strongDirection || marketView.bias === "NEUTRAL") return false;
  return signal.side !== marketView.bias && isTrendSetup(signal);
}

/**
 * Resonance now follows a decision chain: whole market -> symbol -> historical
 * memory -> setup -> direction -> entry timing -> exit space -> post-trade
 * diagnosis. Losses do not create a two-hour paper timeout. Repeated failure
 * modes change the candidate rule, while weak historical cells may continue
 * only through paper-only cognitive challengers.
 */
export async function tryOpenResonanceTrade(
  packet: MarketAnalysisPacket,
  signals: Hte31Signal[],
  candles: Hte31Candle[],
  settings: AppSettings,
  globalMarket: ResonanceGlobalMarketState,
  marketView: ResonanceMarketView,
  review: ResonanceSystemReview,
) {
  const timedSignals = signals
    .map((signal) => improveEntryTiming(signal, packet, candles, marketView))
    .map((signal) => applyCognitiveEntryLearning(signal, packet, candles, marketView, review));
  const directionEligible = timedSignals.filter((signal) => !conflictsWithDirection(signal, packet, globalMarket, marketView, review));
  const eligibleSignals = directionEligible
    .map((signal) => marketTarget(signal, packet, candles, marketView, review.directives))
    .map((signal) => markLearnedPolicyCandidate(signal, review));

  if (eligibleSignals.length !== signals.length && !eligibleSignals.some((signal) => signal.state === "ready" && signal.entryPlan?.ready)) {
    const pending = globalMarket.pendingLabel
      ? ` · 整体市场正在确认 ${globalMarket.pendingConfirmations}/${globalMarket.requiredConfirmations}`
      : "";
    return {
      opened: null,
      reason: `决策链门控：整体市场 ${globalMarket.label} / ${globalMarket.bias}，当前币种 ${marketView.headline}${pending}；不合适的Setup继续记录但不硬做`,
    };
  }
  return openResonancePaperTrade(packet, eligibleSignals, candles, settings);
}
