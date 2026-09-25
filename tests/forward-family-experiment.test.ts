import test from "node:test";
import assert from "node:assert/strict";
import {
  familyAdmissionBlock,initialFamilyExperimentState,isFamilyFailure,normalizeFamilyExperimentState,pruneFamilyExperimentBySymbols,
  recordFamilyFailure,relationFamilyId,reserveExperimentValueBlock,
} from "../lib/forward-family-experiment.ts";
import type {RelationRule} from "../lib/forward-relation-v2.ts";
const rule=(id:string,patch:Partial<RelationRule>={}):RelationRule=>({
  id,signature:id,scope:"RECENT",horizon:15,side:"SHORT",conditions:[{feature:2,op:"LE",threshold:-.2}],
  longNet:.003,recentNet:.0035,standardError:.001,samples:30,longGroups:3,recentGroups:3,health:.25,status:"DEGRADED",
  livePathScore:.62,environmentFit:.78,stopRate:.005,targetRate:.007,
  exitProfile:{version:"sample-exit-plan-v1",bestHoldMinutes:15,feedbackDeadlineMinutes:10,maxHoldMinutes:30,normalAdverseRate:.005,
    targetRate:.007,protectionActivationRate:.003,retentionRate:.75,samples:30,groups:3,
    path:{15:{expectedRate:.003,adverseRate:.004,remainingEdgeRate:0}}},
  updatedAt:10_000,lastQualifiedAt:9_000,
  symbols:["BTC_USDT","ETH_USDT"],reason:"fixture",...patch,
});

test("threshold, horizon and scope variants of one causal idea share the same relation family",()=>{
  const a=rule("a",{conditions:[{feature:2,op:"LE",threshold:-.17}]}),b=rule("b",{conditions:[{feature:2,op:"LE",threshold:-.31}]});
  assert.equal(relationFamilyId(a),relationFamilyId(b));
  const horizonVariant=rule("h",{horizon:60,scope:"BASE",conditions:[{feature:2,op:"LE",threshold:-.25}]});
  assert.equal(relationFamilyId(a),relationFamilyId(horizonVariant));
  const c=rule("c",{conditions:[{feature:2,op:"GE",threshold:-.31}]});
  assert.notEqual(relationFamilyId(a),relationFamilyId(c));
});

test("horizon and scope variants cannot bypass one failed causal family",()=>{
  const a=rule("a",{horizon:15,scope:"RECENT"}),b=rule("b",{horizon:60,scope:"BASE",conditions:[{feature:2,op:"LE",threshold:-.31}]});
  assert.equal(relationFamilyId(a),relationFamilyId(b));
});

test("reserve minimum value blocks the weak probe profile seen in the failed snapshot",()=>{
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00091,edgeRatio:.16,livePathScore:.55,environmentFit:.88,roundTripCost:.0019})??"",/不足/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.38,livePathScore:.22,environmentFit:.80,roundTripCost:.0019})??"",/收益风险价值|路径/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.38,livePathScore:.63,environmentFit:.80,roundTripCost:.0019})??"",/收益风险价值/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.50,livePathScore:.53,environmentFit:.80,roundTripCost:.0019})??"",/路径/);
  assert.equal(reserveExperimentValueBlock({reserve:true,netRate:.0018,edgeRatio:.50,livePathScore:.63,environmentFit:.80,roundTripCost:.0019}),null);
  assert.equal(reserveExperimentValueBlock({reserve:false,netRate:.0001,edgeRatio:.01,livePathScore:.01,environmentFit:.01,roundTripCost:.0019}),null);
});

test("ACTIVE RECENT may use strong learned path value without loosening ordinary reserve probes",()=>{
  const activeRecent={netRate:.00170,targetRate:.00812,normalAdverseRate:.00473,retentionRate:.835,samples:139,groups:3};
  assert.equal(reserveExperimentValueBlock({reserve:true,netRate:.00170,edgeRatio:.36,livePathScore:.84,environmentFit:.69,
    roundTripCost:.0019,activeRecent}),null);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00170,edgeRatio:.36,livePathScore:.84,environmentFit:.69,
    roundTripCost:.0019,activeRecent:{...activeRecent,retentionRate:.60}})??"",/收益风险价值/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00170,edgeRatio:.36,livePathScore:.60,environmentFit:.69,
    roundTripCost:.0019,activeRecent})??"",/收益风险价值|路径/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00170,edgeRatio:.36,livePathScore:.84,environmentFit:.55,
    roundTripCost:.0019,activeRecent})??"",/收益风险价值|环境/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00170,edgeRatio:.36,livePathScore:.84,environmentFit:.69,
    roundTripCost:.0019,activeRecent:{...activeRecent,samples:12}})??"",/收益风险价值/);
  assert.match(reserveExperimentValueBlock({reserve:true,netRate:.00170,edgeRatio:.36,livePathScore:.84,environmentFit:.69,
    roundTripCost:.0019})??"",/收益风险价值/,"without ACTIVE RECENT path evidence the old strict gate still applies");
});

test("family admission grants the path-value route only while RECENT is ACTIVE",()=>{
  const active=rule("active",{scope:"RECENT",status:"ACTIVE",health:.64,longNet:.00170,livePathScore:.84,environmentFit:.69,
    exitProfile:{...rule("seed").exitProfile,bestHoldMinutes:15,targetRate:.00812,normalAdverseRate:.00473,
      retentionRate:.835,samples:139,groups:3}});
  assert.equal(familyAdmissionBlock({state:initialFamilyExperimentState(),rule:active,allRules:[active],reserve:true,
    openFamilyIds:new Set(),netRate:.00170,edgeRatio:.36,roundTripCost:.0019}),null);
  const pressured={...active,id:"pressured",status:"PRESSURED" as const};
  assert.match(familyAdmissionBlock({state:initialFamilyExperimentState(),rule:pressured,allRules:[pressured],reserve:true,
    openFamilyIds:new Set(),netRate:.00170,edgeRatio:.36,roundTripCost:.0019})??"",/收益风险价值/);
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

test("confirmed path or structure failure is family evidence only before positive feedback",()=>{
  assert.equal(isFamilyFailure("STRUCTURE_STOP",null),true);
  assert.equal(isFamilyFailure("STRUCTURE_STOP",1234),false);
  assert.equal(isFamilyFailure("SAMPLE_PATH_DIVERGED",null),true);
  assert.equal(isFamilyFailure("SAMPLE_PATH_DIVERGED",1234),false);
  assert.equal(isFamilyFailure("PROFIT_GIVEBACK",null),false);
  assert.equal(isFamilyFailure("RELATION_DEGRADED",null),true);
});

test("family failure memory from an execution-ineligible symbol is removed with its bad market evidence",()=>{
  const state=initialFamilyExperimentState(),a=rule("a"),family=relationFamilyId(a);
  recordFamilyFailure({state,familyId:family,sourceRuleId:a.id,evidenceAt:a.lastQualifiedAt,health:a.health,livePathScore:a.livePathScore,
    now:10_000,reason:"NO_POSITIVE_FEEDBACK",symbol:"BARD_USDT"});
  assert.ok(state.guards[family]);
  assert.equal(pruneFamilyExperimentBySymbols(state,new Set(["BTC_USDT","ETH_USDT"])),1);
  assert.equal(state.guards[family],undefined);
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
