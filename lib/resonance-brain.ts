import type { MarketAnalysisPacket } from "./exchange-market.ts";
import type { ResonanceMarketMemory, ResonanceBias } from "./resonance-market.ts";

export type ResonanceMarketView = {
  bias: ResonanceBias;
  confidence: number;
  environment: "趋势" | "震荡" | "转折风险";
  headline: string;
  reason: string;
  strongDirection: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function trendBias(value: number | null): ResonanceBias {
  if (value == null || Math.abs(value) < 0.22) return "NEUTRAL";
  return value > 0 ? "LONG" : "SHORT";
}

function biasText(value: ResonanceBias) {
  return value === "LONG" ? "偏多" : value === "SHORT" ? "偏空" : "方向分歧";
}

export function buildResonanceMarketView(packet: MarketAnalysisPacket, memory: ResonanceMarketMemory): ResonanceMarketView {
  const trend4h = packet.market.timeframeTrend4h ?? 0;
  const trend1h = packet.market.timeframeTrend1h ?? 0;
  const fourHourBias = trendBias(packet.market.timeframeTrend4h);
  const oneHourBias = trendBias(packet.market.timeframeTrend1h);
  const memoryBias = memory.combinedBias;

  let score = trend4h * 0.45 + trend1h * 0.2;
  if (memoryBias !== "NEUTRAL") score += (memoryBias === "LONG" ? 1 : -1) * (memory.combinedConfidence / 100) * 0.35;
  const bias: ResonanceBias = score >= 0.2 ? "LONG" : score <= -0.2 ? "SHORT" : "NEUTRAL";
  const agreement = fourHourBias !== "NEUTRAL" && fourHourBias === memoryBias;
  const disagreement = fourHourBias !== "NEUTRAL" && memoryBias !== "NEUTRAL" && fourHourBias !== memoryBias;
  const confidence = Math.round(clamp(Math.abs(score) * 100 + (agreement ? 12 : 0) - (disagreement ? 18 : 0), 0, 90));
  const transitionInputs = [fourHourBias, oneHourBias, memoryBias].filter((item) => item !== "NEUTRAL");
  const mixed = new Set(transitionInputs).size > 1;
  const environment: ResonanceMarketView["environment"] = mixed ? "转折风险" : Math.abs(trend4h) >= 0.42 ? "趋势" : "震荡";
  const strongDirection = bias !== "NEUTRAL" && confidence >= 55 && Math.abs(trend4h) >= 0.35;

  const headline = bias === "NEUTRAL"
    ? "大方向暂时没有形成一致意见"
    : `${environment === "趋势" ? "大周期趋势" : "当前结构"}${biasText(bias)}`;
  const reason = `${fourHourBias === "NEUTRAL" ? "4小时结构中性" : `4小时${biasText(fourHourBias)}`}；${memory.summary}。${disagreement ? "历史经验和当前4小时结构冲突，降低方向把握。" : agreement ? "历史经验与4小时结构同向。" : "暂不强行放大单一证据。"}`;
  return { bias, confidence, environment, headline, reason, strongDirection };
}
