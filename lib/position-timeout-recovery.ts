import { getSettings, listOpenTrades, processPositionQuote } from "./repository.ts";

export type TimeoutRecoveryResult = {
  checked: number;
  overdue: number;
  closed: number;
  failures: { symbol: string; error: string }[];
};

/**
 * Deterministic safety net for simulated positions.
 *
 * Timeout is a clock rule, not a market-data rule. If a simulated position has
 * already exceeded its saved maxHoldingMinutes, it must be allowed to close
 * even when the Gate quote path or the background PositionMonitor is stale.
 * We therefore re-run the normal Order Lifecycle with the trade's last valid
 * price (falling back to entry only if no valid last price exists). This never
 * scans for new opportunities and cannot create a new position.
 */
export async function recoverOverdueSimulationTimeouts(now = Date.now()): Promise<TimeoutRecoveryResult> {
  const [settings, openTrades] = await Promise.all([getSettings(), listOpenTrades()]);
  const overdue = openTrades.filter((trade) =>
    now - trade.entryAt >= trade.maxHoldingMinutes * 60_000,
  );

  let closed = 0;
  const failures: { symbol: string; error: string }[] = [];

  for (const trade of overdue) {
    const fallbackPrice = Number.isFinite(trade.lastPrice) && trade.lastPrice > 0
      ? trade.lastPrice
      : trade.entryPrice;
    try {
      const result = await processPositionQuote({
        symbol: trade.symbol,
        price: fallbackPrice,
        highPrice: null,
        lowPrice: null,
        candleTime: null,
        volumeUsd: 0,
        observedAt: now,
      }, settings);
      if (result.kind === "closed") closed += 1;
    } catch (error) {
      failures.push({
        symbol: trade.symbol,
        error: error instanceof Error ? error.message : "timeout recovery failed",
      });
    }
  }

  return {
    checked: openTrades.length,
    overdue: overdue.length,
    closed,
    failures,
  };
}
