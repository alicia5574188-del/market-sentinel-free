import assert from "node:assert/strict";
import test from "node:test";
import { RISK_POLICY, dailyLossPauseUsdt, maxMarginAllocationUsdt, minimumTp2NetProfitBudgetUsdt, peakDrawdownLimitUsdt, publicRiskPolicy, singleTradeRiskBudgetUsdt } from "../lib/risk-policy.ts";
import { liveAccountRiskLockReason } from "../lib/live-risk.ts";

test("all monetary risk gates scale with equity instead of fixed USDT amounts", () => {
  assert.deepEqual(publicRiskPolicy(), { singleTradeLossPct: 4, minimumTp2NetProfitPct: 5, maxMarginAllocationPct: 60, dailyRealizedLossPausePct: 3, peakDrawdownPct: 10, maxLiveOpenPositions: 2, maxSameSideLivePositions: 2 });
  for (const [equity, risk, tp2, daily, margin] of [[500,20,25,15,300],[1000,40,50,30,600],[2000,80,100,60,1200]]) {
    assert.equal(singleTradeRiskBudgetUsdt(equity), risk);
    assert.equal(minimumTp2NetProfitBudgetUsdt(equity), tp2);
    assert.equal(dailyLossPauseUsdt(equity, 0), daily);
    assert.equal(maxMarginAllocationUsdt(equity), margin);
  }
  assert.equal(RISK_POLICY.singleTradeLossRate, 0.04);
  assert.equal(RISK_POLICY.minimumTp2NetProfitRate, 0.05);
  assert.equal(RISK_POLICY.maxMarginAllocationRate, 0.60);
  assert.equal(RISK_POLICY.peakDrawdownRate, 0.10);
});

test("daily Gate trading loss still pauses, while raw equity transfers no longer trigger drawdown lock", () => {
  assert.equal(dailyLossPauseUsdt(970, -30), 30);
  assert.match(liveAccountRiskLockReason({ dailyRealizedPnlUsdt: -60, accountEquityUsdt: 1940, accountEquityPeakUsdt: 2000 }) ?? "", /3%/);
  assert.equal(liveAccountRiskLockReason({ dailyRealizedPnlUsdt: 0, accountEquityUsdt: 39.14, accountEquityPeakUsdt: 100 }), null);
  assert.equal(peakDrawdownLimitUsdt(100), Number.POSITIVE_INFINITY);
});
