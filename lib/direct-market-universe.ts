import type { MarketUniverseTicker } from "./exchange-market.ts";

export function directMarketUniverse(rows: MarketUniverseTicker[]) {
  return rows
    .filter((row) => row.symbol.endsWith("_USDT") && Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.volumeUsd) && row.volumeUsd > 0)
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
}

type RankedTicker = MarketUniverseTicker & { volumeRank: number; fundingRatePenalty: number };

export function rankDirectMarketUniverse(rows: MarketUniverseTicker[]): RankedTicker[] {
  return directMarketUniverse(rows).map((row, index) => ({
    ...row,
    volumeRank: index + 1,
    fundingRatePenalty: Math.min(1, Math.abs(row.fundingRate ?? 0) / 0.001),
  }));
}

export function chooseDirectMarketTarget(rows: MarketUniverseTicker[], rotationOffset: number, lastObservedAt: Record<string, number> = {}) {
  const ranked = rankDirectMarketUniverse(rows);
  const observedAt = (symbol: string) => Number.isFinite(lastObservedAt[symbol]) ? lastObservedAt[symbol] : 0;
  const oldest = Math.min(...ranked.map((row) => observedAt(row.symbol)));
  // Reuse Scanner's existing per-symbol snapshots: every configured symbol
  // gets a turn before a recently evaluated leader can occupy another turn.
  const pool = [...ranked]
    .filter((row) => observedAt(row.symbol) === oldest)
    .sort((a, b) => {
      const aPriority = Math.abs(a.coarseScore) * 0.72 + (1 - a.fundingRatePenalty) * 0.28;
      const bPriority = Math.abs(b.coarseScore) * 0.72 + (1 - b.fundingRatePenalty) * 0.28;
      return bPriority - aPriority || a.volumeRank - b.volumeRank;
    });
  return pool[rotationOffset % Math.max(1, pool.length)] ?? ranked[0] ?? null;
}
