import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [review, trading, scanner, exchange, memory, sizing, execution, globalMarket, worker, policyVersion, liveRepository] = await Promise.all([
  readFile(new URL("../lib/resonance-review.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-trading.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/exchange-market.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-market.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-position-sizing.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-paper-execution.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-global-market.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/resonance-policy-version.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
]);

test("every closed Resonance trade gets an immediate autopsy instead of waiting for five", () => {
  assert.match(review, /latestAutopsy/);
  assert.match(review, /rows\.slice\(0, 3\)/);
  assert.match(review, /currentPolicyClosed/);
  assert.match(review, /directionError/);
  assert.match(review, /poorEntry/);
  assert.match(review, /stopProblem/);
  assert.match(review, /poorExit/);
  assert.match(review, /marketMismatch/);
  assert.doesNotMatch(review, /reviewNumber < 1/);
});

test("two similar failures create a diagnosis directive instead of a two-hour paper cooldown", () => {
  assert.match(review, /count\("direction"\) >= 2/);
  assert.match(review, /count\("entry"\) >= 2/);
  assert.match(review, /count\("stop"\) \+ count\("exit"\) >= 2/);
  assert.match(execution, /Losses change what the brain investigates, not the paper sample size/);
  assert.match(execution, /riskMultiplier: 1/);
  assert.doesNotMatch(execution, /getHte31Governance|COOLDOWN|2 \* 60 \* 60_000/);
});

test("weak strategies and weak performance cells continue only through strict paper challengers", () => {
  assert.match(review, /challengerSetupId/);
  assert.match(review, /items\.length >= 8 && averageR <= -0\.20/);
  assert.match(trading, /resonance-cognitive-challenger/);
  assert.match(execution, /strictCellChallenger/);
  assert.match(execution, /resonance-cognitive-cell-challenger/);
  assert.match(execution, /PAPER_REVALIDATION_ONLY/);
  assert.match(execution, /COGNITIVE_ADAPTATION/);
  assert.match(liveRepository, /isPaperRevalidationTrade/);
  assert.match(liveRepository, /模拟复考单禁止进入 Gate 实盘/);
});

test("learned behavior changes are paper-only until validation proves improvement", () => {
  assert.match(trading, /markLearnedPolicyCandidate/);
  assert.match(trading, /resonance-cognitive-policy/);
  assert.match(trading, /在足够对照样本证明改善前禁止进入 Gate 实盘/);
  assert.match(execution, /check\.key\.startsWith\("resonance-cognitive-"\)/);
  assert.match(execution, /paperOnly \? `\$\{PAPER_ONLY_MARKER\}/);
  assert.match(liveRepository, /PAPER_REVALIDATION_ONLY/);
});

test("whole-market state has inertia and a direct bull-bear flip requires stronger confirmation", () => {
  assert.match(globalMarket, /pendingConfirmations/);
  assert.match(globalMarket, /requiredConfirmations/);
  assert.match(globalMarket, /flip \? 6 : 4/);
  assert.match(globalMarket, /12 \* 60_000/);
  assert.match(globalMarket, /正式市场状态暂不翻转/);
  assert.match(worker, /createHte31ScanJob\(runtime\.rotationOffset, runtime\.readModel\?\.market \?\? null\)/);
});

test("whole market and current-symbol judgment are separate decision layers", () => {
  assert.match(scanner, /buildResonanceGlobalMarket/);
  assert.match(scanner, /buildResonanceMarketView/);
  assert.match(scanner, /tryOpenResonanceTrade\(packet, signals, job\.candles, job\.settings, job\.market, job\.marketView, job\.review\)/);
  assert.match(trading, /Whole-market structure and the current symbol are separate layers/);
});

test("cognitive directives can alter direction entry routing and exit space without widening hard risk", () => {
  assert.match(trading, /respect_4h_direction/);
  assert.match(trading, /require_retest/);
  assert.match(trading, /delay_protection/);
  assert.match(trading, /improve_payoff/);
  assert.match(trading, /respect_market_fit/);
  assert.match(trading, /takeProfit1Price/);
  assert.match(trading, /maxHoldingMinutes/);
  assert.match(sizing, /takeProfit2Price = originalTakeProfit2Price/);
});

test("old HTE losses remain historical but current policy identity stays version-scoped", () => {
  assert.match(policyVersion, /RESONANCE_POLICY_STARTED_AT/);
  assert.match(policyVersion, /RESONANCE_POLICY_VERSION = "resonance-v1"/);
  assert.doesNotMatch(policyVersion, /DELETE|UPDATE|migration/i);
});

test("historical memory still rejects overlapping duplicate episodes", () => {
  assert.match(memory, /chooseDiverseMatches/);
  assert.match(memory, /minimumSpacing/);
  assert.match(memory, /weightedRatio/);
  assert.match(scanner, /"1h", 720/);
  assert.match(scanner, /"4h", 1_200/);
  assert.match(scanner, /"1d", 1_800/);
});

test("strategy runtime still depends on the exchange adapter boundary", () => {
  assert.match(exchange, /interface MarketExchangeAdapter/);
  assert.match(exchange, /fetchUniverse/);
  assert.match(exchange, /analyzeSymbol/);
  assert.match(exchange, /fetchPositionQuotes/);
  assert.match(exchange, /fetchHistoricalCandles/);
  assert.match(scanner, /getMarketExchange/);
});
