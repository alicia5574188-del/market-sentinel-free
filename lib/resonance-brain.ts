import type { MarketAnalysisPacket } from "./exchange-market.ts";
import type { HistoricalAnalog, ResonanceMarketMemory, ResonanceBias } from "./resonance-market.ts";

export type ResonanceMarketView = {
  bias: ResonanceBias;
  confidence: number;
  environment: "趋势" | "震荡" | "转折风险";
  headline: string;
  reason: string;
  strongDirection: boolean;
  evidenceAgreement: number;
  historyConfidence: number;
  expectedMovePct: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function trendBias(value: number | null | undefined, threshold = 0.20): ResonanceBias {
  if (value == null || Math.abs(value) < threshold) return "NEUTRAL";
  return value > 0 ? "LONG" : "SHORT";
}

function signedBias(value: ResonanceBias, confidence = 100) {
  if (value === "NEUTRAL") return 0;
  return (value === "LONG" ? 1 : -1) * clamp(confidence / 100, 0, 1);
}

function biasText(value: ResonanceBias) {
  return value === "LONG" ? "偏多" : value === "SHORT" ? "偏空" : "方向分歧";
}

function flowScore(packet: MarketAnalysisPacket) {
  const spot = packet.market.spotCvdRatio ?? 0;
  const book = packet.market.orderBookImbalance ?? 0;
  return clamp(spot * 28 + book * 0.42, -1, 1);
}

function analogDirectionalMove(item: HistoricalAnalog, bias: ResonanceBias) {
  if (bias === "NEUTRAL" || item.sampleCount < 8) return 0;
  const direction = bias === "LONG" ? 1 : -1;
  const alignedOutcome = item.medianForwardPct * direction;
  return alignedOutcome > 0 ? alignedOutcome * direction : 0;
}

function expectedMove(memory: ResonanceMarketMemory, bias: ResonanceBias) {
  if (bias === "NEUTRAL") return 0;
  // Entry/exit decisions operate on hours, not months. Daily analogs influence
  // direction confidence, while the actual trade-space estimate comes mostly
  // from 1h and 4h historical outcomes.
  const short = analogDirectionalMove(memory.short, bias);
  const swing = analogDirectionalMove(memory.swing, bias);
  const direction = bias === "LONG" ? 1 : -1;
  const available = [
    { value: short, weight: 0.62 },
    { value: swing, weight: 0.38 },
  ].filter((row) => row.value !== 0);
  if (!available.length) return 0;
  const weight = available.reduce((sum, row) => sum + row.weight, 0);
  return direction * available.reduce((sum, row) => sum + Math.abs(row.value) * row.weight, 0) / weight;
}

export function buildResonanceMarketView(packet: MarketAnalysisPacket, memory: ResonanceMarketMemory): ResonanceMarketView {
  const trend4h = clamp(packet.market.timeframeTrend4h ?? 0, -1, 1);
  const trend1h = clamp(packet.market.timeframeTrend1h ?? 0, -1, 1);
  const trend15m = clamp(packet.market.timeframeTrend15m ?? 0, -1, 1);
  const fourHourBias = trendBias(trend4h, 0.24);
  const oneHourBias = trendBias(trend1h, 0.20);
  const fifteenMinuteBias = trendBias(trend15m, 0.18);
  const memoryBias = memory.combinedBias;
  const flow = flowScore(packet);
  const flowBias = trendBias(flow, 0.14);

  const historyScore = signedBias(memoryBias, memory.combinedConfidence);
  const score = trend4h * 0.34
    + trend1h * 0.21
    + trend15m * 0.08
    + historyScore * 0.27
    + flow * 0.10;
  const bias: ResonanceBias = score >= 0.18 ? "LONG" : score <= -0.18 ? "SHORT" : "NEUTRAL";

  const evidence = [fourHourBias, oneHourBias, fifteenMinuteBias, memoryBias, flowBias].filter((item) => item !== "NEUTRAL");
  const evidenceAgreement = bias === "NEUTRAL" ? 0 : evidence.filter((item) => item === bias).length;
  const evidenceConflict = bias === "NEUTRAL" ? evidence.length : evidence.filter((item) => item !== bias).length;
  const historyAligned = bias !== "NEUTRAL" && memoryBias === bias;
  const historyConflict = fourHourBias !== "NEUTRAL" && memoryBias !== "NEUTRAL" && fourHourBias !== memoryBias;
  const confidence = Math.round(clamp(
    Math.abs(score) * 100
      + evidenceAgreement * 6
      + (historyAligned ? 7 : 0)
      - evidenceConflict * 9,
    0,
    92,
  ));

  const higherDirections = [fourHourBias, oneHourBias, memoryBias].filter((item) => item !== "NEUTRAL");
  const mixed = new Set(higherDirections).size > 1;
  const environment: ResonanceMarketView["environment"] = mixed
    ? "转折风险"
    : Math.abs(trend4h) >= 0.40 && Math.abs(trend1h) >= 0.28 ? "趋势" : "震荡";
  const strongDirection = bias !== "NEUTRAL"
    && confidence >= 62
    && evidenceAgreement >= 3
    && Math.abs(trend4h) >= 0.28;
  const expectedMovePct = expectedMove(memory, bias);

  const headline = bias === "NEUTRAL"
    ? "大方向暂时没有形成一致意见"
    : `${environment === "趋势" ? "大周期趋势" : "当前结构"}${biasText(bias)}`;
  const conflictNote = historyConflict ? "历史经验和4小时结构冲突，主动降低方向把握。" : "";
  const reason = `${fourHourBias === "NEUTRAL" ? "4小时结构中性" : `4小时${biasText(fourHourBias)}`}；${memory.summary}；${flowBias === "NEUTRAL" ? "实时资金流中性" : `实时资金流${biasText(flowBias)}`}。${conflictNote}${strongDirection ? `${evidenceAgreement} 项方向证据同向。` : "证据没有达到强方向门槛，不强迫五种打法站队。"}`;

  return {
    bias,
    confidence,
    environment,
    headline,
    reason,
    strongDirection,
    evidenceAgreement,
    historyConfidence: memory.combinedConfidence,
    expectedMovePct,
  };
}
