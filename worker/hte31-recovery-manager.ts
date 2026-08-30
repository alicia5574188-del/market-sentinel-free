/// <reference types="@cloudflare/workers-types" />

import { setRuntimeDb } from "../db";
import { fetchGateChartCandles } from "../lib/gate-client";
import {
  applyHte31PositionQuote,
  listHte31OpenTrades,
} from "../lib/hte31-repository";
import { getSettings, type AppSettings } from "../lib/settings-repository";
import { setRuntimeBindings } from "../lib/runtime-bindings";
import type { Hte31Candle } from "../lib/hte31-types";
import { HTE31TradeManager as BaseHTE31TradeManager } from "./hte31-workers";

export { HTE31MarketScanner } from "./hte31-workers";

const FIVE_MINUTES_MS = 5 * 60_000;
const REPLAY_GAP_MS = 6 * 60_000;

function candleStartMs(candle: Hte31Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

async function replayStaleTrade(
  trade: Awaited<ReturnType<typeof listHte31OpenTrades>>[number],
  settings: AppSettings,
  now: number,
) {
  const candles = await fetchGateChartCandles(trade.symbol, trade.lastEvaluatedAt, now);
  const replay = candles
    .map((candle) => ({
      candle,
      observedAt: Math.min(now, candleStartMs(candle) + FIVE_MINUTES_MS),
    }))
    .filter((item) => item.observedAt > trade.lastEvaluatedAt)
    .sort((a, b) => a.observedAt - b.observedAt);

  let replayed = 0;
  for (const item of replay) {
    const result = await applyHte31PositionQuote({
      symbol: trade.symbol,
      price: item.candle.close,
      highPrice: item.candle.high,
      lowPrice: item.candle.low,
      candleTime: item.candle.time,
      volumeUsd: 0,
      observedAt: item.observedAt,
    }, settings);
    replayed += 1;
    if (result.kind === "closed") return { replayed, closed: true };
  }
  return { replayed, closed: false };
}

/**
 * Recovery wrapper for HTE31 simulated positions.
 *
 * Durable Object quota exhaustion can pause the Trade Manager while the D1
 * simulation ledger remains intact. On the first healthy alarm after recovery,
 * replay every missing completed/partial 5m candle in chronological order before
 * normal current-quote management resumes. This preserves the first real Stop /
 * TP / timeout event that occurred during the outage instead of incorrectly
 * closing an overdue position at the recovery-time market price.
 *
 * This wrapper never touches the real Gate execution chain.
 */
export class HTE31TradeManager extends BaseHTE31TradeManager {
  override async alarm(): Promise<void> {
    setRuntimeDb(this.env.DB);
    setRuntimeBindings(this.env);

    try {
      const now = Date.now();
      const open = await listHte31OpenTrades();
      const stale = open.filter((trade) => now - trade.lastEvaluatedAt >= REPLAY_GAP_MS);
      if (stale.length) {
        const settings = await getSettings();
        for (const trade of stale) {
          try {
            await replayStaleTrade(trade, settings, now);
          } catch (error) {
            console.error(
              `HTE 3.1 outage replay failed for ${trade.symbol}`,
              error instanceof Error ? error.message : "unknown replay error",
            );
          }
        }
      }
    } catch (error) {
      // Recovery is an integrity layer, not a replacement for normal position
      // management. If historical replay cannot run, the base manager still gets
      // its ordinary current-quote chance below.
      console.error(
        "HTE 3.1 outage replay bootstrap failed",
        error instanceof Error ? error.message : "unknown replay bootstrap error",
      );
    }

    await super.alarm();
  }
}
