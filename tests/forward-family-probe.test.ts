import test from "node:test";
import assert from "node:assert/strict";
import {
  familyAdmissionBlock,familyEvidence,initialFamilyProbeGuards,probeValueBlock,recordFamilyFailure,
  relationFamilyKey,shouldRecordFamilyFailure,
} from "../lib/forward-family-probe.ts";
import type {RelationRule} from "../lib/forward-relation-v2.ts";

const rule=(patch:Partial<RelationRule>={}):RelationRule=>({
  id:"r-a",signature:"sig",scope:"RECENT",horizon:15,side:"SHORT",conditions:[{feature:2,op:"LE",threshold:-.19}],
  longNet:.003,recentNet:.0035,standardError:.001,samples:30,longGroups:3,recentGroups:3,health:.25,status:"DEGRADED",
  livePathScore:.42,environmentFit:.8,stopRate:.005,targetRate:.006,updatedAt:2_000,lastQualifiedAt:1_000,symbols:["BTC_USDT"],reason:"fixture",
  ...patch,
});

test("nearby thresholds collapse into one relation family while materially different ideas stay separate",()=>{
  const a=relationFamilyKey(rule({conditions:[{feature:2,op:"LE",threshold:-.17}]}));
  const b=relationFamilyKey(rule({id:"r-b",conditions:[{feature:2,op:"LE",threshold:-.29}]}));
  const c=relationFamilyKey(rule({id:"r-c",conditions:[{feature:2,op:"GE",threshold:-.19}]}));
  const d=relationFamilyKey(rule({id:"r-d",side:"LONG",conditions:[{feature:2,op:"LE",threshold:-.19}]}));
  assert.equal(a,b,"adjacent thresholds should be the same hypothesis family");
  assert.notEqual(a,c);assert.notEqual(a,d);
});

test("snapshot-like weak reserve trade value is rejected before risk budget is considered",()=>{
  assert.match(probeValueBlock({reserve:true,score:62,netRate:.00091,edgeRatio:.158,livePathScore:.55,costRate:.0019})??"",/成本后净空间|空间\/回撤比/);
  assert.match(probeValueBlock({reserve:true,score:63,netRate:.0018,edgeRatio:.38,livePathScore:.63,costRate:.0019})??"",/空间\/回撤比/);
  assert.match(probeValueBlock({reserve:true,score:63,netRate:.0018,edgeRatio:.55,livePathScore:.30,costRate:.0019})??"",/实时关系路径/);
  assert.equal(probeValueBlock({reserve:true,score:68,netRate:.0018,edgeRatio:.62,livePathScore:.66,costRate:.0019}),null);
  assert.equal(probeValueBlock({reserve:false,score:20,netRate:0,edgeRatio:0,livePathScore:0,costRate:.0019}),null);
});

test("family guard blocks a new rule id from the same failed hypothesis until real lifecycle recovery",()=>{
  const guards=initialFamilyProbeGuards(),failedRule=rule(),familyKey=relationFamilyKey(failedRule);
  const failed=familyEvidence({familyKey,ruleId:failedRule.id,status:failedRule.status,health:failedRule.health,
    livePathScore:failedRule.livePathScore,lastQualifiedAt:failedRule.lastQualifiedAt})!;
  recordFamilyFailure(guards,failed,2_000,"RELATION_DEGRADED","BTC_USDT");

  const idHop=familyEvidence({familyKey,ruleId:"r-new",status:"DEGRADED",health:.25,livePathScore:.58,lastQualifiedAt:3_000})!;
  assert.match(familyAdmissionBlock(guards,idHop)??"",/等待真正恢复/,"new rule id and timestamp alone must not bypass the family lock");

  const staleActive=familyEvidence({familyKey,ruleId:"r-active",status:"ACTIVE",health:.9,livePathScore:.9,lastQualifiedAt:1_000})!;
  assert.match(familyAdmissionBlock(guards,staleActive)??"",/等待真正恢复/,"old evidence cannot unlock merely by flipping lifecycle state");

  const recovered=familyEvidence({familyKey,ruleId:"r-newer",status:"RECOVERING",health:.55,livePathScore:.62,lastQualifiedAt:4_000})!;
  assert.equal(familyAdmissionBlock(guards,recovered),null);
  assert.equal(guards[familyKey],undefined);
});

test("structure stop without any positive feedback counts as a family experiment failure",()=>{
  assert.equal(shouldRecordFamilyFailure({reserve:true,reason:"STRUCTURE_STOP",firstProfitAt:null}),"STRUCTURE_STOP_NO_FEEDBACK");
  assert.equal(shouldRecordFamilyFailure({reserve:true,reason:"STRUCTURE_STOP",firstProfitAt:123}),null);
  assert.equal(shouldRecordFamilyFailure({reserve:true,reason:"PROFIT_GIVEBACK",firstProfitAt:123}),null);
  assert.equal(shouldRecordFamilyFailure({reserve:false,reason:"RELATION_DEGRADED",firstProfitAt:null}),null);
  assert.equal(shouldRecordFamilyFailure({reserve:true,reason:"RELATION_DEGRADED",firstProfitAt:null}),"RELATION_DEGRADED");
});
