import type { MarketUniverseTicker } from "./exchange-market.ts";

export const DIRECT_MARKET_UNIVERSE_SIZE = 15;
export const DIRECT_MARKET_DEEP_POOL_SIZE = 6;

export function directMarketUniverse(rows: MarketUniverseTicker[]) {
  return rows
    .filter((row) => row.symbol.endsWith("_USDT") && row.price > 0 && row.volumeUsd > 0)
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, DIRECT_MARKET_UNIVERSE_SIZE);
}

export function directMarketDeepPool(rows: MarketUniverseTicker[]) {
  const universe = rankDirectMarketUniverse(rows);
  return [...universe]
    .sort((a, b) => {
      const aPriority = Math.abs(a.coarseScore) * 0.72 + (1 - a.fundingRatePenalty) * 0.28;
      const bPriority = Math.abs(b.coarseScore) * 0.72 + (1 - b.fundingRatePenalty) * 0.28;
      return bPriority - aPriority || a.volumeRank - b.volumeRank;
    })
    .slice(0, DIRECT_MARKET_DEEP_POOL_SIZE);
}

type RankedTicker = MarketUniverseTicker & { volumeRank: number; fundingRatePenalty: number };

export function rankDirectMarketUniverse(rows: MarketUniverseTicker[]): RankedTicker[] {
  return directMarketUniverse(rows).map((row, index) => ({
    ...row,
    volumeRank: index + 1,
    fundingRatePenalty: Math.min(1, Math.abs(row.fundingRate ?? 0) / 0.001),
  }));
}

export function chooseDirectMarketTarget(rows: MarketUniverseTicker[], rotationOffset: number) {
  const ranked = rankDirectMarketUniverse(rows);
  const pool = [...ranked]
    .sort((a, b) => {
      const aPriority = Math.abs(a.coarseScore) * 0.72 + (1 - a.fundingRatePenalty) * 0.28;
      const bPriority = Math.abs(b.coarseScore) * 0.72 + (1 - b.fundingRatePenalty) * 0.28;
      return bPriority - aPriority || a.volumeRank - b.volumeRank;
    })
    .slice(0, DIRECT_MARKET_DEEP_POOL_SIZE);
  return pool[rotationOffset % Math.max(1, pool.length)] ?? ranked[0] ?? null;
}
