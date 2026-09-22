import test from "node:test";
import assert from "node:assert/strict";
import { multiTurnProfitFloor } from "../lib/multi-turn-profit-protection.ts";

test("tiny favorable noise below both risk and absolute activation stays inactive",()=>{
  assert.equal(multiTurnProfitFloor(.005,.02,.0022),null);
});

test("wide-stop trades still protect a material absolute winner below one R",()=>{
  const floor=multiTurnProfitFloor(.052,.0825,.0022)!;
  assert.ok(floor.reachedR<1);
  assert.ok(floor.floorRate>.0022);
  assert.ok(floor.floorRate<.052);
});

test("same price move gets different protection when original planned risk differs",()=>{
  const tight=multiTurnProfitFloor(.04,.01,.0022)!;
  const wide=multiTurnProfitFloor(.04,.03,.0022)!;
  assert.ok(tight.reachedR>wide.reachedR);
  assert.ok(tight.floorRate>wide.floorRate);
  assert.ok(tight.lockedR>wide.lockedR);
});

test("AKE-like seven-R winner protects a majority instead of falling back to 2.8R",()=>{
  const risk=.26456911240220427/6.994629;
  const floor=multiTurnProfitFloor(.26456911240220427,risk,.0022)!;
  assert.ok(floor.reachedR>6.9&&floor.reachedR<7.1);
  assert.ok(floor.lockedR>4.5);
  assert.ok(floor.retentionRate>.64);
  assert.ok(floor.retentionRate<.80);
});

test("strong continuation keeps more trend room than weakening continuation",()=>{
  const strong=multiTurnProfitFloor(.09,.03,.0022,{
    continuationScore:.80,turnProbability:.08,phase:"FLOW",rawDirectionAligned:true,
  })!;
  const weak=multiTurnProfitFloor(.09,.03,.0022,{
    continuationScore:.34,turnProbability:.48,phase:"WATCH",rawDirectionAligned:false,
  })!;
  assert.ok(strong.floorRate<weak.floorRate);
  assert.equal(strong.mode,"STRONG_TREND");
  assert.equal(weak.mode,"WEAKENING");
  assert.ok(strong.retentionRate>.40,"strong trend still protects meaningful profit");
  assert.ok(weak.retentionRate<.83,"weakening never becomes an 85% fixed trailing rule");
});

test("first meaningful protection remains positive after modeled costs",()=>{
  const floor=multiTurnProfitFloor(.013,.02,.0022)!;
  assert.ok(floor.floorRate>.0022);
  assert.ok(floor.floorRate<.013);
  assert.ok(floor.checkpointBand>=0);
});


test("weak time-space value tightens an observed winner more than continuation alone",()=>{
  const base=multiTurnProfitFloor(.0431,.0383,.0033,{
    continuationScore:.46,turnProbability:.13,phase:"FLOW",rawDirectionAligned:true,
    edgeRatio:1.4,directionStrength:.46,turnRisk:.13,ageRatio:.28,
  })!;
  const weak=multiTurnProfitFloor(.0431,.0383,.0033,{
    continuationScore:.34,turnProbability:.48,phase:"WATCH",rawDirectionAligned:false,
    edgeRatio:.55,directionStrength:.30,turnRisk:.52,ageRatio:.8,
  })!;
  assert.ok(base.floorRate>.015);
  assert.ok(weak.floorRate>base.floorRate);
  assert.ok(weak.retentionRate>.60);
});

test("wide-stop winners arm before four percent so large-cycle positions cannot occupy a slot while returning all progress",()=>{
  const floor=multiTurnProfitFloor(.028,.083,.0022,{continuationScore:.5,turnProbability:.25,phase:"FLOW",rawDirectionAligned:true})!;
  assert.ok(floor.activationRate<=.025);
  assert.ok(floor.floorRate>.0022);
});
