import test from "node:test";
import assert from "node:assert/strict";
import {
  feedbackDeadlineMinutes,initialRelationGuards,normalizeRelationGuards,recordRelationFailure,
  relationAdmissionBlock,shouldExitNoPositiveFeedback,type GuardRelationEvidence,
} from "../lib/forward-entry-guard.ts";

const relation=(patch:Partial<GuardRelationEvidence>={}):GuardRelationEvidence=>({
  id:"fr2-test",lastQualifiedAt:1_000,updatedAt:1_000,status:"DEGRADED",health:.25,livePathScore:.30,horizon:15,...patch,
});

test("failed relation epoch is blocked across symbols until genuinely new evidence appears",()=>{
  const guards=initialRelationGuards(),r=relation();
  recordRelationFailure(guards,r,{ruleId:r.id,evidenceAt:r.lastQualifiedAt,health:r.health,livePathScore:r.livePathScore,horizon:r.horizon},
    2_000,"RELATION_DEGRADED","BTC_USDT");
  assert.match(relationAdmissionBlock(guards,r)??"",/等待新证据/);
  assert.equal(guards[r.id]!.failures,1);

  const sameWeak=relation({lastQualifiedAt:2_000,updatedAt:2_000,status:"DEGRADED",health:.27,livePathScore:.34});
  assert.match(relationAdmissionBlock(guards,sameWeak)??"",/等待新证据/,"new timestamp alone must not release the same weak relation");

  const improved=relation({lastQualifiedAt:3_000,updatedAt:3_000,status:"RECOVERING",health:.57,livePathScore:.61});
  assert.equal(relationAdmissionBlock(guards,improved),null);
  assert.equal(guards[r.id],undefined);
});

test("strong realtime recovery can release without waiting for another final-horizon label",()=>{
  const guards=initialRelationGuards(),r=relation({lastQualifiedAt:10_000,livePathScore:.25});
  recordRelationFailure(guards,r,{ruleId:r.id,evidenceAt:r.lastQualifiedAt,health:r.health,livePathScore:r.livePathScore,horizon:r.horizon},
    11_000,"NO_POSITIVE_FEEDBACK","ETH_USDT");
  const recovered=relation({lastQualifiedAt:10_000,updatedAt:12_000,status:"ACTIVE",health:.64,livePathScore:.66});
  assert.equal(relationAdmissionBlock(guards,recovered),null);
});

test("a failure from an old trade does not lock a newer mature evidence epoch",()=>{
  const guards=initialRelationGuards();
  const newer=relation({lastQualifiedAt:5_000,status:"RECOVERING",health:.62,livePathScore:.67});
  recordRelationFailure(guards,newer,{ruleId:newer.id,evidenceAt:2_000,health:.25,livePathScore:.28,horizon:15},
    6_000,"RELATION_DEGRADED","SOL_USDT");
  assert.equal(guards[newer.id]!.blockedEvidenceAt,2_000);
  assert.equal(relationAdmissionBlock(guards,newer),null,"the newer recovered evidence should immediately outrank the old failed epoch");
});

test("feedback deadlines preserve observed 95th-percentile cushions",()=>{
  assert.equal(feedbackDeadlineMinutes(15),4.5);
  assert.equal(feedbackDeadlineMinutes(60),9.5);
  assert.equal(feedbackDeadlineMinutes(180),15);
});

test("no-positive-feedback exit requires both elapsed evidence time and a weak relation path",()=>{
  const weak15=relation({status:"PRESSURED",livePathScore:.44,horizon:15});
  const base={openedAt:0,firstProfitAt:null,favorable:.0004,adverse:.0015,roundTripCost:.0019,relation:weak15};
  assert.equal(shouldExitNoPositiveFeedback({...base,now:4.4*60_000}),false);
  assert.equal(shouldExitNoPositiveFeedback({...base,now:4.6*60_000}),true);

  const healthy=relation({status:"ACTIVE",health:.75,livePathScore:.72,horizon:15});
  assert.equal(shouldExitNoPositiveFeedback({...base,now:8*60_000,relation:healthy}),false,"healthy slow-start relation is not force-exited");

  const weak60=relation({status:"DEGRADED",livePathScore:.30,horizon:60});
  assert.equal(shouldExitNoPositiveFeedback({...base,now:9.4*60_000,relation:weak60}),false);
  assert.equal(shouldExitNoPositiveFeedback({...base,now:9.6*60_000,relation:weak60}),true);
});

test("existing positive feedback always disables the early no-feedback exit",()=>{
  const r=relation({status:"DEGRADED",livePathScore:.10,horizon:15});
  assert.equal(shouldExitNoPositiveFeedback({now:20*60_000,openedAt:0,firstProfitAt:60_000,
    favorable:.003,adverse:.004,roundTripCost:.0019,relation:r}),false);
});

test("guard persistence normalizes malformed legacy values without losing valid locks",()=>{
  const normalized=normalizeRelationGuards({"fr2-x":{blockedAt:100,blockedEvidenceAt:50,blockedHealth:.2,blockedLivePathScore:.3,
    reason:"NO_POSITIVE_FEEDBACK",symbol:"BTC_USDT",failures:2},bad:null});
  assert.equal(normalized["fr2-x"]!.failures,2);
  assert.equal(normalized["fr2-x"]!.reason,"NO_POSITIVE_FEEDBACK");
  assert.equal(normalized.bad,undefined);
});
