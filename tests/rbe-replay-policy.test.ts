import test from "node:test";
import assert from "node:assert/strict";
import { rbeExitIntent, nextOpenExit, originalStopFill, commonTopCohort } from "../scripts/rbe-replay-policy.mjs";

test("a defensive warning cannot tighten the original stop or submit an exit", () => {
  assert.equal(rbeExitIntent({phase:"DEFENSIVE",shouldExit:false},300),null);
  assert.equal(rbeExitIntent({phase:"PRE_TURN_EXIT",shouldExit:false},300),null);
});
test("an accepted prediction fills only at the next observed bar open", () => {
  const intent=rbeExitIntent({phase:"PRE_TURN_EXIT",shouldExit:true},300);
  assert.equal(nextOpenExit(intent,{time:0,open:100}),null);
  assert.equal(nextOpenExit(intent,{time:600,open:90}),null);
  assert.deepEqual(nextOpenExit(intent,{time:300,open:97}),{price:97,time:300,reason:"RBE"});
});
test("stops fill at a worse gap open in either direction", () => {
  assert.equal(originalStopFill("LONG",95,{open:90,low:89,high:92}),90);
  assert.equal(originalStopFill("SHORT",105,{open:110,low:109,high:112}),110);
  assert.equal(originalStopFill("LONG",95,{open:100,low:96,high:104}),null);
});
test("both exit policies are evaluated against the same baseline winner cohort", () => {
  const pairs=Array.from({length:10},(_,i)=>({baseline:{mfe:i},candidate:{mfe:10-i}}));
  assert.equal(commonTopCohort(pairs)[0],pairs[9]);
});

