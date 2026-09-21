import test from "node:test";
import assert from "node:assert/strict";
import { multiTurnProfitFloor } from "../lib/multi-turn-profit-protection.ts";

test("profit protection stays inactive before both one R and a material two-percent MFE",()=>{
  assert.equal(multiTurnProfitFloor(.019,.02,.0022),null);
});

test("wide-stop higher-timeframe winners get absolute-MFE protection before one R",()=>{
  const floor=multiTurnProfitFloor(.06,.08,.0022,{continuationScore:.55,turnProbability:.15,phase:"FLOW",directionAligned:true})!;
  assert.ok(floor.reachedR<1);
  assert.equal(floor.armedBy,"ABSOLUTE_MFE");
  assert.ok(floor.floorRate>.0022);
  assert.ok(floor.retentionRate>.35);
});

test("weak continuation tightens the same winner while a strong trend keeps more room",()=>{
  const strong=multiTurnProfitFloor(.14,.02,.0022,{continuationScore:.82,turnProbability:.08,phase:"FLOW",directionAligned:true})!;
  const weak=multiTurnProfitFloor(.14,.02,.0022,{continuationScore:.32,turnProbability:.48,phase:"WATCH",directionAligned:true})!;
  assert.equal(strong.reachedR,7);
  assert.ok(strong.retentionRate>=.60&&strong.retentionRate<.75);
  assert.ok(weak.floorRate>strong.floorRate);
  assert.ok(weak.retentionRate<=.82);
});

test("an AKE-like seven-R winner protects about seventy percent instead of only 2.8R",()=>{
  const favorable=.2645691124,riskRate=favorable/6.994629;
  const floor=multiTurnProfitFloor(favorable,riskRate,.0022,{continuationScore:.50,turnProbability:.20,phase:"FLOW",directionAligned:true})!;
  assert.ok(floor.lockedR>4.6);
  assert.ok(floor.retentionRate>=.68);
  assert.ok(floor.retentionRate<.85);
});

test("a previously raised floor can never loosen when continuation later improves",()=>{
  const weak=multiTurnProfitFloor(.16,.02,.0022,{continuationScore:.30,turnProbability:.50,phase:"WATCH",directionAligned:true})!;
  const laterStrong=multiTurnProfitFloor(.16,.02,.0022,{continuationScore:.85,turnProbability:.05,phase:"FLOW",directionAligned:true},weak.floorRate)!;
  assert.ok(laterStrong.floorRate>=weak.floorRate);
});

test("first active floor remains positive after modeled costs",()=>{
  const floor=multiTurnProfitFloor(.021,.02,.0022,{continuationScore:.7,turnProbability:.1,phase:"FLOW",directionAligned:true})!;
  assert.ok(floor.floorRate>.0022);
  assert.ok(floor.floorRate<.021);
});
