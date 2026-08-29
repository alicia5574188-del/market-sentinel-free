import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("HTE31 outage recovery replays missed 5m candles before normal quote management", () => {
  const recovery = readFileSync(new URL("../worker/hte31-recovery-manager.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../worker/index-clean.ts", import.meta.url), "utf8");

  assert.match(recovery, /REPLAY_GAP_MS = 6 \* 60_000/);
  assert.match(recovery, /fetchGateChartCandles\(trade\.symbol, trade\.lastEvaluatedAt, now\)/);
  assert.match(recovery, /observedAt: Math\.min\(now, candleStartMs\(candle\) \+ FIVE_MINUTES_MS\)/);
  assert.match(recovery, /\.filter\(\(item\) => item\.observedAt > trade\.lastEvaluatedAt\)/);
  assert.match(recovery, /\.sort\(\(a, b\) => a\.observedAt - b\.observedAt\)/);
  assert.match(recovery, /applyHte31PositionQuote\(\{/);
  assert.match(recovery, /if \(result\.kind === "closed"\) return \{ replayed, closed: true \}/);
  assert.match(recovery, /await super\.alarm\(\)/);
  assert.doesNotMatch(recovery, /LiveTradingCoordinator|reconcileLiveTrading|live_orders/);
  assert.match(entry, /export \{ HTE31MarketScanner, HTE31TradeManager \} from "\.\/hte31-recovery-manager"/);
});
