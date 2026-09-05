import type { MarketPositionQuote } from "./exchange-market.ts";
import type { DirectMarketCandidate } from "./direct-market-types.ts";

export const DIRECT_ENTRY_MAX_CANDIDATE_AGE_MS = 90_000;
export const DIRECT_ENTRY_MAX_QUOTE_AGE_MS = 15_000;

export type DirectEntryValidation = {
  allowed: boolean;
  reason: string;
  entryPrice: number | null;
  rewardRisk: number | null;
};

function direction(side: DirectMarketCandidate["decision"]) {
  return side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
}

/**
 * Final paper-entry boundary. The scanner may rank a candidate, but the order
 * is created only from a fresh quote that is still inside the original entry
 * zone and on the valid side of the immutable structural invalidation.
 */
export function validateDirectMarketEntry(
  candidate: DirectMarketCandidate,
  quote: Pick<MarketPositionQuote, "symbol" | "price" | "observedAt"> | null,
  now = Date.now(),
): DirectEntryValidation {
  if (candidate.decision === "WAIT" || !candidate.entryZone || candidate.invalidationPrice == null || candidate.targets.length < 2) {
    return { allowed: false, reason: "候选没有完整方向、入场区、失效价和目标", entryPrice: null, rewardRisk: null };
  }
  if (!quote || quote.symbol !== candidate.symbol || !(quote.price > 0)) {
    return { allowed: false, reason: "开仓前最新报价不可用", entryPrice: null, rewardRisk: null };
  }
  if (now - candidate.observedAt > DIRECT_ENTRY_MAX_CANDIDATE_AGE_MS || quote.observedAt < candidate.observedAt) {
    return { allowed: false, reason: "候选判断已过期，等待重新扫描", entryPrice: quote.price, rewardRisk: null };
  }
  if (now - quote.observedAt > DIRECT_ENTRY_MAX_QUOTE_AGE_MS) {
    return { allowed: false, reason: "开仓前报价已过期", entryPrice: quote.price, rewardRisk: null };
  }
  const [low, high] = candidate.entryZone;
  if (quote.price < low || quote.price > high) {
    return { allowed: false, reason: `现价已离开入场区 ${low}–${high}`, entryPrice: quote.price, rewardRisk: null };
  }
  const sideDirection = direction(candidate.decision);
  const stopDistance = sideDirection * (quote.price - candidate.invalidationPrice);
  const targetDistance = sideDirection * (candidate.targets[1] - quote.price);
  if (!(stopDistance > 0)) {
    return { allowed: false, reason: "最新价格已经触及或越过原判断失效位", entryPrice: quote.price, rewardRisk: null };
  }
  if (stopDistance / quote.price > 0.05) {
    return { allowed: false, reason: "最新报价下结构止损距离超过5%，放弃入场而不修改止损", entryPrice: quote.price, rewardRisk: null };
  }
  const rewardRisk = targetDistance / stopDistance;
  if (!(rewardRisk >= 1.8)) {
    return { allowed: false, reason: `最新价格下结构盈亏比仅 ${rewardRisk.toFixed(2)}R`, entryPrice: quote.price, rewardRisk };
  }
  return { allowed: true, reason: `最新报价仍在入场区，结构盈亏比 ${rewardRisk.toFixed(2)}R`, entryPrice: quote.price, rewardRisk };
}
