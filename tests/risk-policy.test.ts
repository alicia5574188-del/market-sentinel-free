import assert from "node:assert/strict";
import test from "node:test";
import { RISK_POLICY, dailyLossPauseUsdt, legacySingleTradeRiskBudgetUsdt, maxMarginAllocationUsdt, minimumTp2NetProfitBudgetUsdt, peakDrawdownLimitUsdt, publicRiskPolicy, singleTradeRiskBudgetUsdt } from "../lib/risk-policy.ts";
import { liveAccountRiskLockReason } from "../lib/live-risk.ts";

test("retired contract_v2 monetary gates keep their historical equity scaling", () => {
  assert.deepEqual(publicRiskPolicy(), { singleTradeLossPct: 1, minimumTp2NetProfitPct: 0.25, maxMarginAllocationPct: 20, dailyRealizedLossPausePct: 3, peakDrawdownPct: 10, maxLiveOpenPositions: 5, maxSameSideLivePositions: 3 });
  for (const [equity, risk, tp2, daily, margin] of [[500,5,1.25,15,100],[1000,10,2.5,30,200],[2000,20,5,60,400]]) {
    assert.equal(legacySingleTradeRiskBudgetUsdt(equity), risk);
    assert.equal(minimumTp2NetProfitBudgetUsdt(equity), tp2);
    assert.equal(dailyLossPauseUsdt(equity, 0), daily);
    assert.equal(maxMarginAllocationUsdt(equity), margin);
  }
  assert.equal(RISK_POLICY.singleTradeLossRate, 0.01);
  assert.equal(RISK_POLICY.minimumTp2NetProfitRate, 0.0025);
  assert.equal(RISK_POLICY.peakDrawdownRate, 0.10);
});

test("live-engine recovery compatibility risk scales with HTE31 normal 4% equity target", () => {
  assert.equal(singleTradeRiskBudgetUsdt(500), 20);
  assert.equal(singleTradeRiskBudgetUsdt(1000), 40);
  assert.equal(singleTradeRiskBudgetUsdt(2000), 80);
});

test("daily Gate trading loss still pauses, while raw equity transfers no longer trigger drawdown lock", () => {
  assert.equal(dailyLossPauseUsdt(970, -30), 30);
  assert.match(liveAccountRiskLockReason({ dailyRealizedPnlUsdt: -60, accountEquityUsdt: 1940, accountEquityPeakUsdt: 2000 }) ?? "", /3%/);
  assert.equal(liveAccountRiskLockReason({ dailyRealizedPnlUsdt: 0, accountEquityUsdt: 39.14, accountEquityPeakUsdt: 100 }), null);
  assert.equal(peakDrawdownLimitUsdt(100), Number.POSITIVE_INFINITY);
});
