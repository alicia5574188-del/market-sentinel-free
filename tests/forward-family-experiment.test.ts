import test from "node:test";
import assert from "node:assert/strict";
import {
  familyAdmissionBlock,initialFamilyExperimentState,isFamilyFailure,normalizeFamilyExperimentState,
  recordFamilyFailure,relationFamilyId,reserveExperimentValueBlock,
} from "../lib/forward-family-experiment.ts";
import type {RelationRule} from "../lib/forward-relation-v2.ts";

const rule=(id:string,patch:Partial<RelationRule>={}):RelationRule=>({
  id,signature:id,scope:"RECENT",horizon:15,side:"SHORT",conditions:[{feature:2,op:"LE",threshold:-.2}],
  longNet:.003,recentNet:.0035,standardError:.001,samples:30,longGroups:3,recentGroups:3,health:.25,status:"DEGRADED",
  livePathScore:.62,environmentFit:.78,stopRate:.005,targetRate:.007,updatedAt:10_000,lastQualifiedAt:9_000,
  symbols:["BTC_USDT","ETH_USDT"],reason:"fixture",...patch,
});

test("threshold variants of one causal idea share the same relation family",()=>{
  const a=rule("a",{conditions:[{feature:2,op:"LE",threshold:-.17}]}),b=rule("b",{conditions:[{feature:2,op:"LE",threshold:-.31}]});
  assert.equal(relationFamilyId(a),relationFamilyId(b));
  const c=rule("c",{conditions:[{feature:2,op:"GE",threshold:-.31}]});
  assert.notEqual(relationFamilyId(a),relationFamilyId(c));
});

test("reserve minimum value blocks the weak probe profile seen in the failed snapshot",()=>{
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00091,edgeRatio:.16,livePathScore:.55,environmentFit:.88,roundTripCost:.0019})??"",/不足/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.38,livePathScore:.22,environmentFit:.80,roundTripCost:.0019})??"",/收益风险价值|路径/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.38,livePathScore:.63,environmentFit:.80,roundTripCost:.0019})??"",/收益风险价值/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.50,livePathScore:.53,environmentFit:.80,roundTripCost:.0019})??"",/路径/);
  assert.equal(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.50,livePathScore:.63,environmentFit:.80,roundTripCost:.0019}),null);
  assert.equal(reserveExperimentValueBlock({reserve:false,netRate:.0001,edgeRatio:.01,livePathScore:.01,environmentFit:.01,roundTripCost:.0019}),null);
});

test("only one reserve experiment may be open inside a family",()=>{
  const state=initialFamilyExperimentState(),a=rule("a"),b=rule("b",{conditions:[{feature:2,op:"LE",threshold:-.31}]});
  const family=relationFamilyId(a);
  const blocked=familyAdmissionBlock({state,rule:b,allRules:[a,b],reserve:true,openFamilyIds:new Set([family]),
    netRate:.0018,edgeRatio:.38,roundTripCost:.0019});
  assert.match(blocked??"",/已有一笔探测仓/);
});

test("one family failure blocks sibling rule ids while unrelated families remain tradable",()=>{
  const state=initialFamilyExperimentState(),a=rule("a"),sibling=rule("b",{conditions:[{feature:2,op:"LE",threshold:-.31}]}),
    unrelated=rule("c",{conditions:[{feature:6,op:"LE",threshold:-.2}]});
  const family=relationFamilyId(a);
  recordFamilyFailure({state,familyId:family,sourceRuleId:a.id,evidenceAt:a.lastQualifiedAt,health:a.health,livePathScore:a.livePathScore,
    now:11_000,reason:"STRUCTURE_STOP",symbol:"BTC_USDT"});
  assert.match(familyAdmissionBlock({state,rule:sibling,allRules:[a,sibling,unrelated],reserve:true,openFamilyIds:new Set(),
    netRate:.002,edgeRatio:.5,roundTripCost:.0019})??"",/等待新成熟证据/);
  assert.equal(familyAdmissionBlock({state,rule:unrelated,allRules:[a,sibling,unrelated],reserve:true,openFamilyIds:new Set(),
    netRate:.002,edgeRatio:.5,roundTripCost:.0019}),null);
});

test("a new recovered mature epoch releases a failed family but timestamp-only weak refresh does not",()=>{
  const state=initialFamilyExperimentState(),a=rule("a",{lastQualifiedAt:9_000,livePathScore:.55});
  const family=relationFamilyId(a);
  recordFamilyFailure({state,familyId:family,sourceRuleId:a.id,evidenceAt:9_000,health:.25,livePathScore:.55,
    now:10_000,reason:"NO_POSITIVE_FEEDBACK",symbol:"BTC_USDT"});
  const weak=rule("b",{lastQualifiedAt:12_000,status:"DEGRADED",health:.27,livePathScore:.60,conditions:[{feature:2,op:"LE",threshold:-.3}]});
  assert.match(familyAdmissionBlock({state,rule:weak,allRules:[weak],reserve:true,openFamilyIds:new Set(),
    netRate:.002,edgeRatio:.5,roundTripCost:.0019})??"",/等待新成熟证据/);
  const recovered=rule("c",{lastQualifiedAt:13_000,status:"RECOVERING",health:.55,livePathScore:.70,
    conditions:[{feature:2,op:"LE",threshold:-.4}]});
  assert.equal(familyAdmissionBlock({state,rule:recovered,allRules:[recovered],reserve:true,openFamilyIds:new Set(),
    netRate:.002,edgeRatio:.5,roundTripCost:.0019}),null);
  assert.equal(state.guards[family],undefined);
});

test("structure stop is family failure only when the trade never achieved positive feedback",()=>{
  assert.equal(isFamilyFailure("STRUCTURE_STOP",null),true);
  assert.equal(isFamilyFailure("STRUCTURE_STOP",1234),false);
  assert.equal(isFamilyFailure("PROFIT_GIVEBACK",null),false);
  assert.equal(isFamilyFailure("RELATION_DEGRADED",null),true);
});

test("legacy rule-id guards migrate into family guards instead of being discarded",()=>{
  const a=rule("legacy-rule",{conditions:[{feature:1,op:"GE",threshold:-.38}]});
  const state=normalizeFamilyExperimentState(undefined,[a],{"legacy-rule":{
    blockedAt:20_000,blockedEvidenceAt:18_000,blockedHealth:.25,blockedLivePathScore:.42,
    reason:"RELATION_DEGRADED",symbol:"ETH_USDT",failures:2,
  }});
  const family=relationFamilyId(a);
  assert.equal(state.guards[family]?.failures,2);
  assert.equal(state.guards[family]?.sourceRuleId,"legacy-rule");
});
