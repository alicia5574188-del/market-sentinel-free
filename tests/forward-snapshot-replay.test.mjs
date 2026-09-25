import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const report=JSON.parse(await readFile(new URL("../research/FORWARD_V3_REPLAY_2026-09-25.json",import.meta.url),"utf8"));

test("2026-09-25 causal replay delays all recorded Shock fills and forces extended SUI/XLM through WAIT_RETEST",()=>{
  assert.deepEqual(report.shock.decisions,{SUI_USDT:"WAIT_RETEST",XLM_USDT:"WAIT_RETEST",LINK_USDT:"CONTINUATION_DELAY"});
  assert.equal(report.shock.canonicalEvent,"market-shock-SHORT-29839085");
  assert.ok(report.shock.extendedMoveLowerBound.netPnl>report.source.netPnl);
  assert.ok(report.shock.extendedMoveLowerBound.fees<report.source.fees);
  assert.ok(report.shock.extendedMoveLowerBound.tradeReductionRate<.05,"improvement cannot come from suppressing most trading");
});

test("ordinary Forward inventory remains present and the historical SUI winner stays on the immediate route",()=>{
  assert.equal(report.ordinary.trades,73);assert.equal(report.ordinary.predictedPositive,73);assert.equal(report.ordinary.actualLosses,35);
  assert.equal(report.ordinary.strongImmediate+report.ordinary.entryValidation,report.ordinary.trades);
  assert.equal(report.bestWinner.strongImmediate,true);assert.ok(report.bestWinner.netPnl>17);
});
