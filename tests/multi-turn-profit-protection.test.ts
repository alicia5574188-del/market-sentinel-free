import test from "node:test";
import assert from "node:assert/strict";
import { multiTurnProfitFloor } from "../lib/multi-turn-profit-protection.ts";

test("profit protection is inactive before meaningful profit",()=>{
  assert.equal(multiTurnProfitFloor(.0099),null);
});

test("profit floor locks positive net room without demanding 85 percent retention",()=>{
  const small=multiTurnProfitFloor(.015,.0022)!;
  assert.ok(small.floorRate>.0022);
  assert.ok(small.floorRate<.015*.85);
  const large=multiTurnProfitFloor(.4056,.0022)!;
  assert.ok(large.floorRate>=.28);
  assert.ok(large.floorRate<.4056*.85);
  assert.ok(large.retentionRate>.60);
});

test("profit floor rises only at bounded durable tiers",()=>{
  assert.equal(multiTurnProfitFloor(.019)?.tier,multiTurnProfitFloor(.011)?.tier);
  assert.ok((multiTurnProfitFloor(.021)?.tier??-1)>(multiTurnProfitFloor(.019)?.tier??-1));
  assert.ok((multiTurnProfitFloor(.081)?.floorRate??0)>(multiTurnProfitFloor(.061)?.floorRate??0));
});
