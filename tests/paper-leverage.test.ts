import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DEFAULT_MAINTENANCE_RATE,liquidationDistance,requiredLiquidationDistance,safePaperLeverage} from "../lib/paper-leverage.ts";

const near=(a:number,b:number,eps=1e-9)=>Math.abs(a-b)<eps;

test("typical 1.75% stop at 20x clears liquidation with room to spare",()=>{
  const r=safePaperLeverage({leverageMax:50,maintenanceRate:.005,stopRate:.0175});
  assert.equal(r.leverage,20);assert.equal(r.safe,true);
  assert.ok(near(r.liquidationDistance,.05-.005-.002));       // 4.3%
  assert.ok(near(r.required,.0275));                           // stop + 1%
  // with the conservative 1% default maintenance rate it still holds
  assert.equal(safePaperLeverage({leverageMax:50,maintenanceRate:undefined,stopRate:.0175}).leverage,20);
});

test("wide stops step leverage down until the buffer holds",()=>{
  // 2.8% stop needs 4.2%: 20x gives 4.3% at mmr 0.5%
  assert.equal(safePaperLeverage({leverageMax:50,maintenanceRate:.005,stopRate:.028}).leverage,20);
  // with a 1% maintenance rate 20x gives 3.8% < 4.2% → 18x (5.56−1−0.2 = 4.36%)
  const wide=safePaperLeverage({leverageMax:50,maintenanceRate:.01,stopRate:.028});
  assert.equal(wide.leverage,18);assert.ok(wide.liquidationDistance>=wide.required);
  assert.ok(liquidationDistance(19,.01)<requiredLiquidationDistance(.028),"19x would not clear");
  // the code's hard stop bound 3.5% needs 5.25%: 16x at mmr 0.5% (6.25−0.5−0.2 = 5.55%), 17x would be 5.18%
  assert.equal(safePaperLeverage({leverageMax:50,maintenanceRate:.005,stopRate:.035}).leverage,16);
});

test("never above the contract max, never below the old 10x (or the contract max if lower)",()=>{
  assert.equal(safePaperLeverage({leverageMax:12,maintenanceRate:.005,stopRate:.0175}).leverage,12);
  assert.equal(safePaperLeverage({leverageMax:8,maintenanceRate:.005,stopRate:.0175}).leverage,8);
  assert.equal(safePaperLeverage({leverageMax:0,maintenanceRate:.005,stopRate:.0175}).leverage,10,"no max known → old default 10");
  assert.equal(safePaperLeverage({leverageMax:12.9,maintenanceRate:.005,stopRate:.0175}).leverage,12);
  // an absurd stop cannot push below the floor; it is reported unsafe instead of silently changing the trade
  const floor=safePaperLeverage({leverageMax:50,maintenanceRate:.005,stopRate:.08});
  assert.equal(floor.leverage,10);assert.equal(floor.safe,false);
  assert.equal(safePaperLeverage({leverageMax:50,maintenanceRate:.005,stopRate:Number.NaN}).leverage,10);
});

test("implausible maintenance rates fall back to the conservative default",()=>{
  for(const mmr of [null,undefined,0,-1,Number.NaN,.9])
    assert.equal(safePaperLeverage({leverageMax:50,maintenanceRate:mmr as never,stopRate:.0175}).maintenanceRate,DEFAULT_MAINTENANCE_RATE);
});

test("required buffer: 1% absolute for normal stops, 1.5x for wide ones",()=>{
  assert.ok(near(requiredLiquidationDistance(.01),.02));
  assert.ok(near(requiredLiquidationDistance(.02),.03));
  assert.ok(near(requiredLiquidationDistance(.03),.045));
});

test("open path uses the safe leverage from the final stop; notional and risk are sized before it",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const open=core.slice(core.indexOf("function openIntelligenceTrade"),core.indexOf("export function extremeResidualConfirmationProfile"));
  assert.match(open,/leverage=safePaperLeverage\(\{leverageMax:contract\.leverageMax,maintenanceRate:contract\.maintenanceRate,stopRate:Math\.abs\(price-stopPrice\)\/price\}\)\.leverage/);
  assert.doesNotMatch(open,/Math\.min\(10,Math\.floor\(contract\.leverageMax/);
  assert.ok(open.indexOf("rawNotional=riskBudget/")<open.indexOf("leverage=safePaperLeverage"),"notional does not depend on leverage");
  assert.match(open,/margin=notional\/leverage/);
});
