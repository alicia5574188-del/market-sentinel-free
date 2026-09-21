import test from "node:test";
import assert from "node:assert/strict";
import {fitRbeModel,predictRbeModel,binaryPredictionMetrics,type RbeSample} from "../lib/rbe-learned-value.ts";

const samples=():RbeSample[]=>Array.from({length:240},(_,i)=>({x:[i%2],event:i%2?1:0,value:i%2?-2:3,
  at:100+i,resolvedAt:500+i,tradeId:`trade-${i}`,weight:1}));
test("late outcome labels cannot affect an earlier fitted model",()=>{
  const before=fitRbeModel(samples(),1000);
  const poisoned=samples().concat(samples().map(s=>({...s,value:999,event:2,resolvedAt:1001})));
  assert.deepEqual(fitRbeModel(poisoned,1000),before);
  assert.equal(fitRbeModel(samples(),500),null);
});
test("learned continuation and adverse states produce opposite stopping actions",()=>{
  const model=fitRbeModel(samples(),1000)!;
  assert.equal(predictRbeModel(model,[0])?.shouldExit,false);
  assert.equal(predictRbeModel(model,[1])?.shouldExit,true);
  const p=predictRbeModel(model,[1])!;
  assert.ok(Math.abs(p.extension+p.slowReversal+p.shockReversal+p.unresolved-1)<1e-10);
  assert.equal(predictRbeModel(model,[NaN]),null);
});
test("AUC handles tied ranks and missing classes without fabricated precision",()=>{
  const tied=binaryPredictionMetrics([{p:.5,y:0,reference:.5},{p:.5,y:1,reference:.5}]);
  assert.equal(tied.auc,.5);assert.equal(tied.brier,.25);
  assert.equal(binaryPredictionMetrics([{p:.1,y:0,reference:.1}]).auc,null);
  assert.equal(binaryPredictionMetrics([{p:.1,y:0,reference:.1}]).precision,null);
});
