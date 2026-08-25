import assert from "node:assert/strict";
import test from "node:test";
import { RISK_POLICY, dailyLossPauseUsdt, maxMarginAllocationUsdt, minimumTp2NetProfitBudgetUsdt, peakDrawdownLimitUsdt, publicRiskPolicy, singleTradeRiskBudgetUsdt } from "../lib/risk-policy.ts";
import { liveAccountRiskLockReason } from "../lib/live-risk.ts";

test("all monetary risk gates scale with equity instead of fixed USDT amounts", () => {
  assert.deepEqual(publicRiskPolicy(), { singleTradeLossPct: 1, minimumTp2NetProfitPct: 1.5, maxMarginAllocationPct: 20, dailyRealizedLossPausePct: 3, peakDrawdownPct: 10, maxLiveOpenPositions: 3, maxSameSideLivePositions: 2 });
  for (const [equity, risk, tp2, daily, drawdown, margin] of [[500,5,7.5,15,50,100],[1000,10,15,30,100,200],[2000,20,30,60,200,400]]) {
    assert.equal(singleTradeRiskBudgetUsdt(equity), risk);
    assert.equal(minimumTp2NetProfitBudgetUsdt(equity), tp2);
    assert.equal(dailyLossPauseUsdt(equity, 0), daily);
    assert.equal(peakDrawdownLimitUsdt(equity), drawdown);
    assert.equal(maxMarginAllocationUsdt(equity), margin);
  }
  assert.equal(RISK_POLICY.singleTradeLossRate, 0.01);
});

test("daily pause references estimated start-of-day equity and drawdown references peak equity", () => {
  assert.equal(dailyLossPauseUsdt(970, -30), 30);
  assert.match(liveAccountRiskLockReason({ dailyRealizedPnlUsdt: -60, accountEquityUsdt: 1940, accountEquityPeakUsdt: 2000 }) ?? "", /3%/);
  assert.match(liveAccountRiskLockReason({ dailyRealizedPnlUsdt: 0, accountEquityUsdt: 1800, accountEquityPeakUsdt: 2000 }) ?? "", /10%/);
});
