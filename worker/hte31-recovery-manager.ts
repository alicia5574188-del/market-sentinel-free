import { evaluateAnalogPosition } from '../lib/analog-path-strategy';
import { evaluateScalpPosition } from "../lib/scalp-strategy";
/// <reference types="@cloudflare/workers-types" />

import { setRuntimeDb } from "../db";
import { fetchGateChartCandles, fetchGateMinuteRecovery } from "../lib/gate-client";
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
  const scalp=['MINUTE_PULLBACK','ANALOG_PATH'].includes(trade.setupId) ? JSON.parse(trade.decisionSnapshotJson)?.candidate?.scalp : null;
  const interval=trade.setupId==='MINUTE_PULLBACK'?60_000:FIVE_MINUTES_MS;
  const candles = trade.setupId==='MINUTE_PULLBACK' ? await fetchGateMinuteRecovery(trade.symbol,trade.lastEvaluatedAt,now) : await fetchGateChartCandles(trade.symbol, trade.lastEvaluatedAt, now);
  const replay = candles
    .map((candle) => ({
      candle,
      observedAt: Math.min(now, candleStartMs(candle) + interval),
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
    }, settings, scalp ? (trade.setupId==='ANALOG_PATH'?evaluateAnalogPosition:evaluateScalpPosition)({side:trade.side,entryPrice:trade.entryPrice,initialStopPrice:trade.initialStopPrice,currentStopPrice:trade.currentStopPrice,
      entryAt:trade.entryAt,currentPrice:item.candle.close,observedAt:item.observedAt,roundTripCostBps:scalp.costBps,confirmationPrice:scalp.confirmationPrice,
      candles:candles.filter(c=>candleStartMs(c)+interval<=item.observedAt)}) : null);
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
    await this.ctx.storage.setAlarm(Date.now()+60_000);
    setRuntimeDb(this.env.DB);
    setRuntimeBindings(this.env);

    try {
      const now = Date.now();
      const open = await listHte31OpenTrades();
      const stale = open.filter((trade) => now - trade.lastEvaluatedAt >= (trade.setupId === "MINUTE_PULLBACK" ? 90_000 : REPLAY_GAP_MS));
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
