import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [review, trading, scanner, exchange, memory, sizing] = await Promise.all([
  readFile(new URL("../lib/resonance-review.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-trading.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/exchange-market.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-market.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-position-sizing.ts", import.meta.url), "utf8"),
]);

test("system review is grouped by completed blocks of five trades", () => {
  assert.match(review, /Math\.floor\(total \/ 5\) \* 5/);
  assert.match(review, /slice\(-5\)/);
  assert.match(review, /slice\(-10, -5\)/);
  assert.match(review, /directionErrorRate/);
  assert.match(review, /poorEntryRate/);
  assert.match(review, /poorExitRate/);
  assert.match(review, /smallWinnerRate/);
});

test("one bad five-trade block cannot rewrite production behavior", () => {
  assert.match(review, /const repeated = issue !== "insufficient" && issue === previousIssue/);
  assert.match(review, /repeated && issue === "direction" \? "respect_4h_direction"/);
  assert.match(trading, /review\.directive === "respect_4h_direction"/);
  assert.doesNotMatch(review, /update\(hte31Trades\)|delete\(hte31Trades\)|UPDATE hte31_trades/);
});

test("five playbooks share one top-level direction timing and target orchestrator", () => {
  assert.match(scanner, /tryOpenResonanceTrade/);
  assert.match(trading, /improveEntryTiming/);
  assert.match(trading, /marketTarget/);
  assert.match(trading, /directionEligible/);
  assert.match(trading, /Resonance大方向一致后的二次入场确认/);
  assert.doesNotMatch(trading, /dennis_trend|raschke_pullback|turtle_soup|exhaustion_reversal|higher_timeframe_swing/);
});

test("profit sizing never manufactures an 80U target or caps winners at 200U", () => {
  assert.match(sizing, /minimumTp2NetProfitUsdt:\s*50/);
  assert.match(sizing, /takeProfit2Price = originalTakeProfit2Price/);
  assert.match(sizing, /不为凑利润人为抬高TP/);
  assert.doesNotMatch(sizing, /targetTp2NetProfitRate|maximumTp2NetProfitRate/);
  assert.match(trading, /targetR = clamp[\s\S]*1, 20/);
});

test("historical memory rejects overlapping duplicate episodes and scanner asks for deeper history", () => {
  assert.match(memory, /chooseDiverseMatches/);
  assert.match(memory, /minimumSpacing/);
  assert.match(memory, /weightedRatio/);
  assert.match(scanner, /"1h", 720/);
  assert.match(scanner, /"4h", 1_200/);
  assert.match(scanner, /"1d", 1_800/);
});

test("strategy runtime depends on an exchange adapter boundary", () => {
  assert.match(exchange, /interface MarketExchangeAdapter/);
  assert.match(exchange, /fetchUniverse/);
  assert.match(exchange, /analyzeSymbol/);
  assert.match(exchange, /fetchPositionQuotes/);
  assert.match(exchange, /fetchHistoricalCandles/);
  assert.match(scanner, /getMarketExchange/);
});
