import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [review, trading, scanner, exchange] = await Promise.all([
  readFile(new URL("../lib/resonance-review.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-trading.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/exchange-market.ts", import.meta.url), "utf8"),
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

test("five playbooks share one top-level market gate instead of custom patches", () => {
  assert.match(scanner, /tryOpenResonanceTrade/);
  assert.match(trading, /eligibleSignals = signals\.filter/);
  assert.doesNotMatch(trading, /dennis_trend|raschke_pullback|turtle_soup|exhaustion_reversal|higher_timeframe_swing/);
});

test("strategy runtime depends on an exchange adapter boundary", () => {
  assert.match(exchange, /interface MarketExchangeAdapter/);
  assert.match(exchange, /fetchUniverse/);
  assert.match(exchange, /analyzeSymbol/);
  assert.match(exchange, /fetchPositionQuotes/);
  assert.match(exchange, /fetchHistoricalCandles/);
  assert.match(scanner, /getMarketExchange/);
});
