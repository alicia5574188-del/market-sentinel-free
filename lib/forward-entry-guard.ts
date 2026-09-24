/**
 * Forward Relation entry/feedback guard.
 *
 * This module owns only two concerns:
 * 1) prevent one failed relation evidence epoch from repeatedly paying fees
 *    across symbols until genuinely new evidence arrives;
 * 2) end no-feedback positions earlier only when their relation path is also weak.
 *
 * It deliberately does NOT decide direction, stops, targets, sizing, or relation learning.
 */
export const FORWARD_ENTRY_GUARD_VERSION="forward-entry-guard-v1";

export type GuardRelationStatus="ACTIVE"|"PRESSURED"|"DEGRADED"|"RECOVERING";
export type GuardFailureReason="RELATION_DEGRADED"|"NO_POSITIVE_FEEDBACK";
export type GuardRelationEvidence={
  id:string;lastQualifiedAt:number;updatedAt:number;status:GuardRelationStatus;
  health:number;livePathScore:number;horizon:15|60|180;
};
export type RelationGuardRecord={
  ruleId:string;blockedAt:number;blockedEvidenceAt:number;blockedHealth:number;blockedLivePathScore:number;
  reason:GuardFailureReason;symbol:string;failures:number;
};
export type RelationGuardState=Record<string,RelationGuardRecord>;

const finite=(v:unknown,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;

export function initialRelationGuards():RelationGuardState{return{};}

export function normalizeRelationGuards(value:unknown):RelationGuardState{
  if(!value||typeof value!=="object")return{};
  const out:RelationGuardState={};
  for(const [ruleId,raw] of Object.entries(value as Record<string,unknown>)){
    if(!raw||typeof raw!=="object"||!ruleId)continue;
    const r=raw as Partial<RelationGuardRecord>,reason:GuardFailureReason=
      r.reason==="NO_POSITIVE_FEEDBACK"?"NO_POSITIVE_FEEDBACK":"RELATION_DEGRADED";
    out[ruleId]={ruleId,blockedAt:finite(r.blockedAt),blockedEvidenceAt:finite(r.blockedEvidenceAt),
      blockedHealth:finite(r.blockedHealth),blockedLivePathScore:finite(r.blockedLivePathScore),reason,
      symbol:typeof r.symbol==="string"?r.symbol:"",failures:Math.max(1,Math.floor(finite(r.failures,1)))};
  }
  return out;
}

function evidenceRecovered(record:RelationGuardRecord,relation:GuardRelationEvidence){
  const matureChanged=relation.lastQualifiedAt>record.blockedEvidenceAt;
  const pathImproved=relation.livePathScore>=Math.max(.58,record.blockedLivePathScore+.12);
  const healthImproved=relation.health>=Math.max(.50,record.blockedHealth+.08);
  const strongLifecycle=relation.status==="ACTIVE"||relation.status==="RECOVERING";
  // Fresh mature evidence alone is not enough if it regenerated the same weak
  // relation. It must either improve the path/health or restore lifecycle status.
  if(matureChanged&&(strongLifecycle||pathImproved||healthImproved))return true;
  // A strong realtime recovery can release without waiting for the final horizon,
  // but require both lifecycle recovery and a meaningful path jump.
  return strongLifecycle&&relation.livePathScore>=Math.max(.62,record.blockedLivePathScore+.18)
    &&relation.health>=Math.max(.55,record.blockedHealth+.10);
}

export function relationAdmissionBlock(state:RelationGuardState,relation:GuardRelationEvidence){
  const record=state[relation.id];if(!record)return null;
  if(evidenceRecovered(record,relation)){delete state[relation.id];return null;}
  return `关系${relation.id}等待新证据：上次${record.reason==="NO_POSITIVE_FEEDBACK"?"无正向反馈":"关系失效"}后尚未恢复`;
}

export function recordRelationFailure(state:RelationGuardState,relation:GuardRelationEvidence|undefined,
  fallback:{ruleId?:string;evidenceAt?:number;health?:number;livePathScore?:number;horizon?:15|60|180},
  now:number,reason:GuardFailureReason,symbol:string){
  const ruleId=relation?.id??fallback.ruleId;if(!ruleId)return;
  const prior=state[ruleId];
  state[ruleId]={ruleId,blockedAt:now,blockedEvidenceAt:relation?.lastQualifiedAt??finite(fallback.evidenceAt),
    blockedHealth:relation?.health??finite(fallback.health),blockedLivePathScore:relation?.livePathScore??finite(fallback.livePathScore),
    reason,symbol,failures:(prior?.failures??0)+1};
}

export function feedbackDeadlineMinutes(horizon:15|60|180|undefined){
  // Snapshot-derived 95th percentile of first positive feedback was ~4.16m
  // for 15m relations and ~9.0m for 60m relations. Small cushions reduce
  // false exits while still acting much earlier than the old generic timer.
  if(horizon===15)return 4.5;
  if(horizon===60)return 9.5;
  if(horizon===180)return 15;
  return 10;
}

export function shouldExitNoPositiveFeedback(input:{now:number;openedAt:number;firstProfitAt?:number|null;
  favorable:number;adverse:number;roundTripCost:number;relation?:GuardRelationEvidence}){
  if(input.firstProfitAt)return false;
  const relation=input.relation;if(!relation)return false;
  const age=(input.now-input.openedAt)/60_000;
  if(age<feedbackDeadlineMinutes(relation.horizon))return false;
  if(input.favorable>=input.roundTripCost*.60)return false;
  const lifecycleWeak=relation.status==="PRESSURED"||relation.status==="DEGRADED";
  const pathWeak=relation.livePathScore<.50;
  if(!lifecycleWeak&&!pathWeak)return false;
  // Avoid declaring failure on a perfectly flat quote simply because a relation
  // is under review. Require some adverse path or very weak live relation path.
  return input.adverse>Math.max(input.favorable,input.roundTripCost*.12)||relation.livePathScore<.35;
}
