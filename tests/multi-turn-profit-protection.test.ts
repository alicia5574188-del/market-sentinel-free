import test from "node:test";
import assert from "node:assert/strict";
import { anchorFlowProfitFloor, ANCHOR_FLOW_PROFIT_PROTECTION_VERSION, regionLaunchProfitFloor, REGION_LAUNCH_PROFIT_PROTECTION_VERSION, multiTurnProfitFloor,
  regionMigrationProfitFloor, REGION_MIGRATION_PROFIT_PROTECTION_VERSION } from "../lib/multi-turn-profit-protection.ts";

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
  assert.ok(floor.lockedR>5.3);
  assert.ok(floor.retentionRate>.78);
  assert.ok(floor.retentionRate<.85);
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
  assert.ok(weak.retentionRate<=.88,"weakening tightens protection but still leaves executable breathing room");
});

test("first meaningful protection remains positive after modeled costs",()=>{
  const floor=multiTurnProfitFloor(.013,.02,.0022)!;
  assert.ok(floor.floorRate>.0022);
  assert.ok(floor.floorRate<.013);
  assert.ok(floor.checkpointBand>=0);
});


test("substantial but still noisy early profit does not arm before the meaningful threshold",()=>{
  assert.equal(multiTurnProfitFloor(.007,.02,.0022),null);
  assert.ok(multiTurnProfitFloor(.010,.02,.0022));
});

test("a two-R winner without weakening locks about half of observed profit",()=>{
  const floor=multiTurnProfitFloor(.04,.02,.0022)!;
  assert.ok(floor.retentionRate>=.49&&floor.retentionRate<=.63);
  assert.ok(floor.floorRate>.0022);
});


test("5m region migration protection arms earlier than the multi-timeframe floor once profit clears cost",()=>{
  assert.equal(multiTurnProfitFloor(.0055,.012,.0025),null);
  const floor=regionMigrationProfitFloor(.0055,.012,.0025)!;
  assert.equal(floor.version,REGION_MIGRATION_PROFIT_PROTECTION_VERSION);
  assert.ok(floor.floorRate>.0025);
  assert.ok(floor.floorRate<.0055);
});

test("large region migration winner keeps more than eighty percent of observed profit",()=>{
  const floor=regionMigrationProfitFloor(.12,.012,.003)!;
  assert.ok(floor.reachedR>=9.9);
  assert.ok(floor.retentionRate>.84);
  assert.ok(floor.floorRate>.10);
});


test("MUBARAK-like fast profit keeps about eighty percent before reaching its entry expectation",()=>{
  const favorable=.0654692873117928,risk=8.048941266001357/297.03424,expected=.06986581627292286,cost=.0025758015843606796;
  const floor=anchorFlowProfitFloor(favorable,risk,cost,expected)!;
  assert.equal(floor.version,ANCHOR_FLOW_PROFIT_PROTECTION_VERSION);
  assert.ok(floor.retentionRate>=.79&&floor.retentionRate<=.81);
  assert.ok(floor.floorRate>.052);
});

test("AnchorFlow only loosens gradually after observed profit exceeds the original expectation",()=>{
  const atExpected=anchorFlowProfitFloor(.04,.02,.0022,.04)!;
  const double=anchorFlowProfitFloor(.08,.02,.0022,.04)!;
  const extreme=anchorFlowProfitFloor(.16,.02,.0022,.04)!;
  assert.ok(atExpected.retentionRate>=.79);
  assert.ok(double.retentionRate>=.74&&double.retentionRate<=.76);
  assert.ok(extreme.retentionRate>=.69&&extreme.retentionRate<=.71);
});

test("weakening AnchorFlow evidence tightens an already high-retention floor",()=>{
  const normal=anchorFlowProfitFloor(.05,.02,.0022,.06)!;
  const weak=anchorFlowProfitFloor(.05,.02,.0022,.06,{
    continuationScore:.30,turnProbability:.60,phase:"TURNING",rawDirectionAligned:false,
  })!;
  assert.ok(weak.retentionRate>normal.retentionRate);
  assert.ok(weak.retentionRate>=.88);
});


test("RegionLaunch v4 keeps about eighty percent once a trade reaches two R",()=>{
  const floor=regionLaunchProfitFloor(.020,.010,.0022,.040)!;
  assert.equal(floor.version,REGION_LAUNCH_PROFIT_PROTECTION_VERSION);
  assert.ok(floor.retentionRate>=.79&&floor.retentionRate<=.81);
  assert.ok(floor.floorRate>.015);
});

test("RegionLaunch v4 tightens MFE retention as realized R expands",()=>{
  const oneR=regionLaunchProfitFloor(.01,.01,.0022,.04)!;
  const twoR=regionLaunchProfitFloor(.02,.01,.0022,.04)!;
  const fourR=regionLaunchProfitFloor(.04,.01,.0022,.04)!;
  const tenR=regionLaunchProfitFloor(.10,.01,.0022,.04)!;
  assert.ok(oneR.retentionRate>=.64&&oneR.retentionRate<=.66);
  assert.ok(twoR.retentionRate>=.79&&twoR.retentionRate<=.81);
  assert.ok(fourR.retentionRate>=.83&&fourR.retentionRate<=.85);
  assert.ok(tenR.retentionRate>=.87&&tenR.retentionRate<=.89);
});
