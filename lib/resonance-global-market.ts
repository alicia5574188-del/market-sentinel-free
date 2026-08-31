import type { MarketUniverseTicker } from "./exchange-market.ts";

export type ResonanceGlobalMarketState = {
  observedAt: number;
  label: "趋势主导" | "波动扩张" | "震荡轮动" | "低波压缩";
  permission: "GREEN" | "YELLOW";
  confidence: number;
  stability: number;
  transitionRisk: number;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  advancingRatio: number;
  decliningRatio: number;
  medianChangePct: number;
  dispersionPct: number;
  benchmarkMomentum: number;
  stateSinceAt: number;
  rawLabel: "趋势主导" | "波动扩张" | "震荡轮动" | "低波压缩";
  rawBias: "LONG" | "SHORT" | "NEUTRAL";
  pendingLabel: ResonanceGlobalMarketState["label"] | null;
  pendingBias: ResonanceGlobalMarketState["bias"] | null;
  pendingConfirmations: number;
  requiredConfirmations: number;
  transitionNote: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function rawMarketState(universe: MarketUniverseTicker[], observedAt: number) {
  const changes = universe.map((row) => row.changePercentage).filter(Number.isFinite);
  const advancingRatio = universe.length ? universe.filter((row) => row.changePercentage > 0).length / universe.length : 0.5;
  const decliningRatio = universe.length ? universe.filter((row) => row.changePercentage < 0).length / universe.length : 0.5;
  const medianChangePct = median(changes);
  const dispersionPct = stdev(changes);
  const benchmarks = universe.filter((row) => row.symbol === "BTC_USDT" || row.symbol === "ETH_USDT");
  const benchmarkMomentum = benchmarks.length
    ? benchmarks.reduce((sum, row) => sum + row.changePercentage, 0) / benchmarks.length
    : medianChangePct;
  const participation = Math.max(advancingRatio, decliningRatio);
  const trendStrength = Math.abs(medianChangePct) + Math.abs(benchmarkMomentum) * 0.5;
  const label: ResonanceGlobalMarketState["label"] = dispersionPct >= 5.5 ? "波动扩张"
    : trendStrength >= 2.2 && participation >= 0.62 ? "趋势主导"
      : dispersionPct <= 2.2 && Math.abs(medianChangePct) <= 0.9 ? "低波压缩" : "震荡轮动";
  const bias: ResonanceGlobalMarketState["bias"] = advancingRatio >= 0.62 && benchmarkMomentum > 0 ? "LONG"
    : decliningRatio >= 0.62 && benchmarkMomentum < 0 ? "SHORT" : "NEUTRAL";
  const transitionRisk = clamp(Math.round((Math.abs(advancingRatio - decliningRatio) < 0.12 ? 38 : 16) + Math.min(35, dispersionPct * 4)), 8, 78);
  return {
    observedAt,
    label,
    permission: universe.length >= 12 ? "GREEN" as const : "YELLOW" as const,
    confidence: clamp(Math.round(62 + Math.min(30, universe.length) * 0.7), 55, 92),
    stability: clamp(100 - transitionRisk, 22, 94),
    transitionRisk,
    bias,
    advancingRatio,
    decliningRatio,
    medianChangePct,
    dispersionPct,
    benchmarkMomentum,
  };
}

function directFlip(previous: ResonanceGlobalMarketState, raw: ReturnType<typeof rawMarketState>) {
  return previous.bias !== "NEUTRAL" && raw.bias !== "NEUTRAL" && previous.bias !== raw.bias;
}

/**
 * The whole-market regime is deliberately slower than a symbol signal.
 * A one-minute cross-section scan may notice a possible change immediately,
 * but it cannot replace the established regime until the new state survives
 * repeated scans and a minimum amount of real time. This keeps a short-term
 * bounce from becoming a fake bull/bear regime flip.
 */
export function buildResonanceGlobalMarket(
  universe: MarketUniverseTicker[],
  previous: ResonanceGlobalMarketState | null = null,
  observedAt = Date.now(),
): ResonanceGlobalMarketState {
  const raw = rawMarketState(universe, observedAt);
  if (!previous) {
    return {
      ...raw,
      stateSinceAt: observedAt,
      rawLabel: raw.label,
      rawBias: raw.bias,
      pendingLabel: null,
      pendingBias: null,
      pendingConfirmations: 0,
      requiredConfirmations: 0,
      transitionNote: "整体市场状态已建立，后续变化需要连续确认。",
    };
  }

  const changed = raw.label !== previous.label || raw.bias !== previous.bias;
  if (!changed) {
    return {
      ...raw,
      label: previous.label,
      bias: previous.bias,
      stateSinceAt: previous.stateSinceAt,
      rawLabel: raw.label,
      rawBias: raw.bias,
      pendingLabel: null,
      pendingBias: null,
      pendingConfirmations: 0,
      requiredConfirmations: 0,
      transitionNote: `整体市场维持${previous.label}${previous.bias === "NEUTRAL" ? "" : previous.bias === "LONG" ? "偏多" : "偏空"}。`,
    };
  }

  const flip = directFlip(previous, raw);
  const requiredConfirmations = flip ? 6 : 4;
  const minimumStateAgeMs = flip ? 12 * 60_000 : 6 * 60_000;
  const sameCandidate = previous.pendingLabel === raw.label && previous.pendingBias === raw.bias;
  const pendingConfirmations = sameCandidate ? previous.pendingConfirmations + 1 : 1;
  const oldEnough = observedAt - previous.stateSinceAt >= minimumStateAgeMs;
  const confirmed = pendingConfirmations >= requiredConfirmations && oldEnough;

  if (confirmed) {
    return {
      ...raw,
      stateSinceAt: observedAt,
      rawLabel: raw.label,
      rawBias: raw.bias,
      pendingLabel: null,
      pendingBias: null,
      pendingConfirmations: 0,
      requiredConfirmations: 0,
      transitionNote: `新的整体市场状态经过 ${pendingConfirmations} 次连续确认后生效。`,
    };
  }

  return {
    ...raw,
    label: previous.label,
    bias: previous.bias,
    confidence: Math.min(previous.confidence, raw.confidence),
    stability: Math.min(previous.stability, clamp(72 - pendingConfirmations * 7, 24, 72)),
    transitionRisk: Math.max(raw.transitionRisk, clamp(42 + pendingConfirmations * 7, 42, 86)),
    stateSinceAt: previous.stateSinceAt,
    rawLabel: raw.label,
    rawBias: raw.bias,
    pendingLabel: raw.label,
    pendingBias: raw.bias,
    pendingConfirmations,
    requiredConfirmations,
    transitionNote: `检测到可能转向 ${raw.label}${raw.bias === "NEUTRAL" ? "" : raw.bias === "LONG" ? "偏多" : "偏空"}，确认 ${pendingConfirmations}/${requiredConfirmations}；正式市场状态暂不翻转。`,
  };
}
