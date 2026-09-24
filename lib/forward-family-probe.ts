/**
 * Forward Relation family-level probe guard.
 *
 * This module intentionally owns only weak/recovery probe admission. It does
 * not decide direction, stop geometry, profit protection, sizing, relation
 * synthesis, or market-data selection.
 */
import type {RelationCondition,RelationRule,RelationStatus} from "./forward-relation-v2.ts";

export const FORWARD_FAMILY_PROBE_VERSION="forward-family-probe-v1";
export const MAX_NEW_PROBES_PER_5M=2;

export type FamilyFailureReason="RELATION_DEGRADED"|"NO_POSITIVE_FEEDBACK"|"STRUCTURE_STOP_NO_FEEDBACK";
export type FamilyProbeGuard={
  familyKey:string;blockedAt:number;blockedEvidenceAt:number;blockedHealth:number;blockedLivePathScore:number;
  reason:FamilyFailureReason;symbol:string;failures:number;lastRuleId:string;
};
export type FamilyProbeGuardState=Record<string,FamilyProbeGuard>;

type FamilyEvidence={
  familyKey:string;ruleId:string;status:RelationStatus;health:number;livePathScore:number;lastQualifiedAt:number;
};

const finite=(v:unknown,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;
const hash=(v:string)=>{let h=2166136261;for(let i=0;i<v.length;i++)h=Math.imul(h^v.charCodeAt(i),16777619);return(h>>>0).toString(36);};
const thresholdBucket=(v:number)=>Math.round(v*5)/5;
const conditionKey=(c:RelationCondition)=>`${c.feature}${c.op}${thresholdBucket(c.threshold).toFixed(1)}`;

export function relationFamilyKey(rule:Pick<RelationRule,"side"|"horizon"|"conditions">){
  const conditions=[...rule.conditions].sort((a,b)=>a.feature-b.feature||a.op.localeCompare(b.op)||a.threshold-b.threshold)
    .map(conditionKey).join(",");
  return `ff-${hash(`${rule.side}|${rule.horizon}|${conditions||"GLOBAL"}`)}`;
}

export function initialFamilyProbeGuards():FamilyProbeGuardState{return{};}

export function normalizeFamilyProbeGuards(value:unknown):FamilyProbeGuardState{
  if(!value||typeof value!=="object")return{};
  const out:FamilyProbeGuardState={};
  for(const [familyKey,raw] of Object.entries(value as Record<string,unknown>)){
    if(!raw||typeof raw!=="object"||!familyKey)continue;
    const r=raw as Partial<FamilyProbeGuard>,reason:FamilyFailureReason=
      r.reason==="NO_POSITIVE_FEEDBACK"?"NO_POSITIVE_FEEDBACK":
      r.reason==="STRUCTURE_STOP_NO_FEEDBACK"?"STRUCTURE_STOP_NO_FEEDBACK":"RELATION_DEGRADED";
    out[familyKey]={familyKey,blockedAt:finite(r.blockedAt),blockedEvidenceAt:finite(r.blockedEvidenceAt),
      blockedHealth:finite(r.blockedHealth),blockedLivePathScore:finite(r.blockedLivePathScore),reason,
      symbol:typeof r.symbol==="string"?r.symbol:"",failures:Math.max(1,Math.floor(finite(r.failures,1))),
      lastRuleId:typeof r.lastRuleId==="string"?r.lastRuleId:""};
  }
  return out;
}

function recovered(record:FamilyProbeGuard,e:FamilyEvidence){
  const newEvidence=e.lastQualifiedAt>record.blockedEvidenceAt;
  const lifecycle=e.status==="ACTIVE"||e.status==="RECOVERING";
  const health=e.health>=Math.max(.50,record.blockedHealth+.10);
  const path=e.livePathScore>=Math.max(.60,record.blockedLivePathScore+.12);
  return newEvidence&&lifecycle&&(health||path);
}

export function familyAdmissionBlock(state:FamilyProbeGuardState,e:FamilyEvidence){
  const record=state[e.familyKey];if(!record)return null;
  if(recovered(record,e)){delete state[e.familyKey];return null;}
  return `关系族${e.familyKey}等待真正恢复的新证据`;
}

export function recordFamilyFailure(state:FamilyProbeGuardState,e:FamilyEvidence,now:number,reason:FamilyFailureReason,symbol:string){
  const prior=state[e.familyKey];
  state[e.familyKey]={familyKey:e.familyKey,blockedAt:now,blockedEvidenceAt:e.lastQualifiedAt,blockedHealth:e.health,
    blockedLivePathScore:e.livePathScore,reason,symbol,failures:(prior?.failures??0)+1,lastRuleId:e.ruleId};
}

export function shouldRecordFamilyFailure(input:{reserve:boolean;reason:string;firstProfitAt?:number|null}):FamilyFailureReason|null{
  if(!input.reserve)return null;
  if(input.reason==="RELATION_DEGRADED")return"RELATION_DEGRADED";
  if(input.reason==="NO_POSITIVE_FEEDBACK")return"NO_POSITIVE_FEEDBACK";
  if(input.reason==="STRUCTURE_STOP"&&!input.firstProfitAt)return"STRUCTURE_STOP_NO_FEEDBACK";
  return null;
}

export function probeValueBlock(input:{reserve:boolean;score:number;netRate:number;edgeRatio:number;livePathScore:number;costRate:number}){
  if(!input.reserve)return null;
  if(input.score<60)return"探测价值不足：综合评分低于60";
  if(input.netRate<input.costRate*.55)return"探测价值不足：成本后净空间过小";
  if(input.edgeRatio<.45)return"探测价值不足：空间/回撤比低于0.45";
  if(input.livePathScore<.55)return"探测价值不足：实时关系路径过弱";
  return null;
}

export type FamilyEvidenceInput={
  familyKey?:string;ruleId?:string;status?:RelationStatus;health?:number;livePathScore?:number;lastQualifiedAt?:number;
};

export function familyEvidence(input:FamilyEvidenceInput):FamilyEvidence|null{
  if(!input.familyKey||!input.ruleId||!input.status)return null;
  return{familyKey:input.familyKey,ruleId:input.ruleId,status:input.status,health:finite(input.health),
    livePathScore:finite(input.livePathScore),lastQualifiedAt:finite(input.lastQualifiedAt)};
}
