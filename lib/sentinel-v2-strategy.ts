import type { Candle } from "./signal-engine.ts";
import { evaluateShadowStrategies, type ShadowStrategyInput, type ShadowStrategySignal } from "./shadow-strategy-engine.ts";
import {
  evaluateSentinelV2Opportunity,
  v2DecisionMetric,
  v2PermissionLabel,
  type V2MarketContext,
  type V2Opportunity,
} from "./sentinel-v2-core.ts";

export type SentinelV2StrategyResult = {
  signals: ShadowStrategySignal[];
  opportunities: V2Opportunity[];
};

function addV2Check(signal: ShadowStrategySignal, opportunity: V2Opportunity, market: V2MarketContext) {
  if (!signal.entryPlan) return null;
  const v2Passed = opportunity.state === "TRADE";
  return {
    ...signal.entryPlan,
    ready: signal.entryPlan.ready && v2Passed,
    checks: [
      ...signal.entryPlan.checks.filter((check) => check.key !== "sentinel-v2-context"),
      {
        key: "sentinel-v2-context",
        label: "Sentinel V2 环境许可",
        passed: v2Passed,
        required: true,
        detail: `${market.regimeLabel} · Transition ${market.transitionRisk} · ${market.permission}/${v2PermissionLabel(market.permission)} · ${opportunity.state}`,
      },
    ],
  };
}

function v2Signal(signal: ShadowStrategySignal, opportunity: V2Opportunity, market: V2MarketContext): ShadowStrategySignal {
  const mappedState = opportunity.state === "TRADE" ? "ready" : opportunity.state === "REJECT" ? "blocked" : "watching";
  const blockers = opportunity.state === "REJECT"
    ? [...new Set([...signal.blockers, ...opportunity.rejectReasons])]
    : signal.blockers;
  const waiting = opportunity.state === "WATCH" ? opportunity.waitingFor : [];
  return {
    ...signal,
    label: opportunity.playbookLabel,
    state: mappedState,
    confidence: opportunity.opportunityScore,
    thesis: `Sentinel Growth V2：${market.regimeLabel}，环境稳定度 ${market.stability}，切换风险 ${market.transitionRisk}。${signal.thesis}`,
    reasons: [...opportunity.reasons, ...waiting.map((item) => `等待：${item}`), ...signal.reasons].slice(0, 10),
    blockers,
    entryPlan: addV2Check(signal, opportunity, market),
    metrics: [v2DecisionMetric(opportunity), ...signal.metrics],
  };
}

export function evaluateSentinelV2Strategies(input: ShadowStrategyInput & { candles5m: Candle[] }, options: {
  market: V2MarketContext;
  openTrades: { symbol: string; side: "LONG" | "SHORT"; entryThesis?: string | null; regime?: string | null }[];
}): SentinelV2StrategyResult {
  const legacySignals = evaluateShadowStrategies(input)
    .filter((signal) => signal.strategyId === "trend_pullback" || signal.strategyId === "volatility_breakout");

  const opportunities = legacySignals.map((signal) => evaluateSentinelV2Opportunity({
    signal,
    asset: {
      symbol: input.symbol,
      observedAt: input.observedAt,
      dataQuality: input.dataQuality,
      changePercentage: input.changePercentage,
      fundingRate: input.fundingRate,
      openInterestChangePct: input.openInterestChangePct,
      spotCvdRatio: input.spotCvdRatio,
      orderBookImbalance: input.orderBookImbalance,
      liquidationImbalance: input.liquidationImbalance,
      multiTimeframeTrend: input.multiTimeframeTrend,
      volumeUsd: input.volumeUsd,
    },
    market: options.market,
    portfolio: {
      openTrades: options.openTrades,
      candidateSide: signal.side === "SHORT" ? "SHORT" : "LONG",
      candidateSymbol: input.symbol,
    },
  }));

  return {
    signals: legacySignals.map((signal, index) => v2Signal(signal, opportunities[index], options.market)),
    opportunities,
  };
}
