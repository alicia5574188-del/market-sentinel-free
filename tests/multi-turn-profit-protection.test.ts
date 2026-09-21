import test from "node:test";
import assert from "node:assert/strict";
import { multiTurnProfitFloor } from "../lib/multi-turn-profit-protection.ts";

test("profit protection is inactive before one planned-risk R",()=>{
  assert.equal(multiTurnProfitFloor(.019,.02,.0022),null);
});

test("same price move gets different protection when original planned risk differs",()=>{
  const tight=multiTurnProfitFloor(.04,.01,.0022)!;
  const wide=multiTurnProfitFloor(.04,.03,.0022)!;
  assert.ok(tight.reachedR>wide.reachedR);
  assert.ok(tight.floorRate>wide.floorRate);
  assert.ok(tight.lockedR>wide.lockedR);
});

test("large winners keep trend room without an 85 percent retention rule",()=>{
  const floor=multiTurnProfitFloor(.4056,.02,.0022)!;
  assert.ok(floor.reachedR>20);
  assert.ok(floor.floorRate>=.28);
  assert.ok(floor.retentionRate<.85);
  assert.ok(floor.retentionRate>.60);
});

test("first armed R tier locks a positive after-cost floor",()=>{
  const floor=multiTurnProfitFloor(.021,.02,.0022)!;
  assert.equal(floor.tier,0);
  assert.ok(floor.floorRate>.0022);
  assert.ok(floor.floorRate<.021);
});
