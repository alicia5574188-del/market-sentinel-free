/**
 * Forward Relation family experiment controller.
 *
 * A family groups variants that express the same causal idea:
 * side + condition feature/operator shape. Threshold, horizon and BASE/RECENT
 * scope are intentionally excluded so a failed idea cannot evade evidence
 * control by changing a cutoff or merely moving from 30m to 45m.
 *
 * This module does not choose direction, stops, targets, sizing or profit exits.
 */
import type {RelationRule} from "./forward-relation-v2.ts";

export const FORWARD_FAMILY_EXPERIMENT_VERSION="forward-family-experiment-v3";

export type FamilyFailureReason="RELATION_DEGRADED"|"NO_POSITIVE_FEEDBACK"|"STRUCTURE_STOP"|"SAMPLE_PATH_DIVERGED";
export type FamilyGuardRecord={
  familyId:string;sourceRuleId:string;blockedAt:number;blockedEvidenceAt:number;blockedHealth:number;blockedLivePathScore:number;
  reason:FamilyFailureReason;symbol:string;failures:number;
};
export type FamilyExperimentState={
  version:typeof FORWARD_FAMILY_EXPERIMENT_VERSION;
  guards:Record<string,FamilyGuardRecord>;
  calibrations:Record<string,FamilyCalibrationRecord>;
  calibratedTradeIds:string[];
};
export type FamilyCalibrationRecord={familyId:string;trades:number;wins:number;meanPredictedNetRate:number;meanRealizedNetRate:number;
  meanCostRate:number;meanTargetCapture:number;updatedAt:number};

const finite=(v:unknown,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;

export function relationFamilyId(rule:Pick<RelationRule,"side"|"conditions">){
  const shape=[...(rule.conditions??[])].map(c=>`${c.feature}${c.op}`).sort().join(",");
  return `${rule.side}:${shape||"BASE"}`;
}

export function initialFamilyExperimentState():FamilyExperimentState{
  return{version:FORWARD_FAMILY_EXPERIMENT_VERSION,guards:{},calibrations:{},calibratedTradeIds:[]};
}

function mergeGuard(target:FamilyExperimentState,record:FamilyGuardRecord){
  const prior=target.guards[record.familyId];
  if(!prior){target.guards[record.familyId]=record;return;}
  target.guards[record.familyId]={
    ...record,
    blockedAt:Math.max(prior.blockedAt,record.blockedAt),
    blockedEvidenceAt:Math.max(prior.blockedEvidenceAt,record.blockedEvidenceAt),
    blockedHealth:Math.min(prior.blockedHealth,record.blockedHealth),
    blockedLivePathScore:Math.min(prior.blockedLivePathScore,record.blockedLivePathScore),
    failures:prior.failures+record.failures,
  };
}

export function normalizeFamilyExperimentState(value:unknown,rules:RelationRule[],legacyRuleGuards?:unknown){
  const out=initialFamilyExperimentState();
  if(value&&typeof value==="object"){
    const v=value as {guards?:unknown;calibrations?:unknown;calibratedTradeIds?:unknown};
    if(v.guards&&typeof v.guards==="object")for(const [familyId,raw] of Object.entries(v.guards as Record<string,unknown>)){
      if(!raw||typeof raw!=="object")continue;const r=raw as Partial<FamilyGuardRecord>;
      const reason:FamilyFailureReason=r.reason==="NO_POSITIVE_FEEDBACK"?"NO_POSITIVE_FEEDBACK":
        r.reason==="STRUCTURE_STOP"?"STRUCTURE_STOP":r.reason==="SAMPLE_PATH_DIVERGED"?"SAMPLE_PATH_DIVERGED":"RELATION_DEGRADED";
      mergeGuard(out,{familyId,sourceRuleId:typeof r.sourceRuleId==="string"?r.sourceRuleId:"",blockedAt:finite(r.blockedAt),
        blockedEvidenceAt:finite(r.blockedEvidenceAt),blockedHealth:finite(r.blockedHealth),blockedLivePathScore:finite(r.blockedLivePathScore),
        reason,symbol:typeof r.symbol==="string"?r.symbol:"",failures:Math.max(1,Math.floor(finite(r.failures,1)))});
    }
    if(v.calibrations&&typeof v.calibrations==="object")for(const [familyId,raw]of Object.entries(v.calibrations as Record<string,unknown>)){
      if(!raw||typeof raw!=="object")continue;const r=raw as Partial<FamilyCalibrationRecord>,trades=Math.max(0,Math.floor(finite(r.trades)));
      if(!trades)continue;out.calibrations[familyId]={familyId,trades,wins:Math.max(0,Math.min(trades,Math.floor(finite(r.wins)))),
        meanPredictedNetRate:finite(r.meanPredictedNetRate),meanRealizedNetRate:finite(r.meanRealizedNetRate),
        meanCostRate:Math.max(0,finite(r.meanCostRate)),meanTargetCapture:Math.max(0,finite(r.meanTargetCapture)),updatedAt:finite(r.updatedAt)};
    }
    if(Array.isArray(v.calibratedTradeIds))out.calibratedTradeIds=v.calibratedTradeIds.filter(x=>typeof x==="string").slice(-240);
  }
  // One-time migration from the failed rule-id guard experiment. This preserves
  // real failure evidence while replacing its too-narrow identity model.
  if(legacyRuleGuards&&typeof legacyRuleGuards==="object"){
    const byId=new Map(rules.map(r=>[r.id,r]));
    for(const [ruleId,raw] of Object.entries(legacyRuleGuards as Record<string,unknown>)){
      if(!raw||typeof raw!=="object")continue;const rule=byId.get(ruleId);if(!rule)continue;
      const r=raw as Record<string,unknown>,familyId=relationFamilyId(rule);
      mergeGuard(out,{familyId,sourceRuleId:ruleId,blockedAt:finite(r.blockedAt),blockedEvidenceAt:finite(r.blockedEvidenceAt),
        blockedHealth:finite(r.blockedHealth,rule.health),blockedLivePathScore:finite(r.blockedLivePathScore,rule.livePathScore),
        reason:r.reason==="NO_POSITIVE_FEEDBACK"?"NO_POSITIVE_FEEDBACK":"RELATION_DEGRADED",
        symbol:typeof r.symbol==="string"?r.symbol:"",failures:Math.max(1,Math.floor(finite(r.failures,1)))});
    }
  }
  return out;
}

export function recordFamilyOutcome(input:{state:FamilyExperimentState;familyId:string;tradeId:string;predictedNetRate:number;
  realizedNetRate:number;costRate:number;targetCapture:number;now:number}){
  if(!input.familyId||input.state.calibratedTradeIds.includes(input.tradeId))return false;
  const prior=input.state.calibrations[input.familyId],trades=(prior?.trades??0)+1,weight=1/trades;
  input.state.calibrations[input.familyId]={familyId:input.familyId,trades,wins:(prior?.wins??0)+(input.realizedNetRate>0?1:0),
    meanPredictedNetRate:(prior?.meanPredictedNetRate??0)*(1-weight)+input.predictedNetRate*weight,
    meanRealizedNetRate:(prior?.meanRealizedNetRate??0)*(1-weight)+input.realizedNetRate*weight,
    meanCostRate:(prior?.meanCostRate??0)*(1-weight)+input.costRate*weight,
    meanTargetCapture:(prior?.meanTargetCapture??0)*(1-weight)+input.targetCapture*weight,updatedAt:input.now};
  input.state.calibratedTradeIds=[...input.state.calibratedTradeIds,input.tradeId].slice(-240);return true;
}

export function familyCalibration(state:FamilyExperimentState,familyId:string|undefined){
  const row=familyId?state.calibrations[familyId]:undefined,bias=row?Math.max(0,row.meanPredictedNetRate-row.meanRealizedNetRate):0;
  return{trades:row?.trades??0,wins:row?.wins??0,biasRate:bias,meanPredictedNetRate:row?.meanPredictedNetRate??0,
    meanRealizedNetRate:row?.meanRealizedNetRate??0,meanCostRate:row?.meanCostRate??0,meanTargetCapture:row?.meanTargetCapture??0,
    requiresValidation:!!row&&row.trades>=6&&(row.meanRealizedNetRate<=0||bias>=Math.max(.0015,row.meanCostRate))};
}

function sameFamily(rule:RelationRule,familyId:string){return relationFamilyId(rule)===familyId;}

export function pruneFamilyExperimentBySymbols(state:FamilyExperimentState,eligibleSymbols:Iterable<string>){
  const allowed=new Set(eligibleSymbols);let removed=0;
  for(const [familyId,record] of Object.entries(state.guards)){
    if(record.symbol&& !allowed.has(record.symbol)){delete state.guards[familyId];removed++;}
  }
  return removed;
}

function recovered(record:FamilyGuardRecord,rules:RelationRule[]){
  const family=rules.filter(r=>sameFamily(r,record.familyId));
  return family.some(rule=>{
    if(rule.lastQualifiedAt<=record.blockedEvidenceAt)return false;
    if(rule.status==="ACTIVE"||rule.status==="RECOVERING")return true;
    return rule.status==="PRESSURED"
      &&rule.health>=Math.max(.45,record.blockedHealth+.10)
      &&rule.livePathScore>=Math.max(.62,record.blockedLivePathScore+.12);
  });
}

export type ActiveRecentValue={
  netRate:number;targetRate:number;normalAdverseRate:number;retentionRate:number;samples:number;groups:number;
};
export function reserveExperimentValueBlock(input:{
  reserve:boolean;netRate:number;edgeRatio:number;livePathScore:number;environmentFit:number;roundTripCost:number;
  activeRecent?:ActiveRecentValue;
}){
  if(!input.reserve)return null;
  const recent=input.activeRecent;
  if(recent){
    const evidenceFloor=Math.max(.0012,input.roundTripCost*.65),
      pathRatio=recent.targetRate/Math.max(recent.normalAdverseRate,1e-9);
    // The relation engine uses 0.65 as its explicit neutral value when no
    // current pending path can score yet. Strong, mature ACTIVE RECENT evidence
    // must be allowed into the bounded reserve lane at neutral; requiring >0.65
    // deterministically starves it after restart/quiet pending windows.
    if(recent.netRate>=evidenceFloor&&pathRatio>=1.5&&recent.retentionRate>=.70
      &&recent.samples>=24&&recent.groups>=3&&input.livePathScore>=.65&&input.environmentFit>=.65)return null;
  }
  const netFloor=Math.max(.0010,input.roundTripCost*.55);
  if(input.netRate<netFloor)return `探测净空间不足：${(input.netRate*100).toFixed(2)}%`;
  if(input.edgeRatio<.45)return `探测收益风险价值不足：${input.edgeRatio.toFixed(2)}`;
  if(input.livePathScore<.55)return `探测路径尚未恢复：${Math.round(input.livePathScore*100)}`;
  if(input.environmentFit<.60)return `探测环境匹配不足：${Math.round(input.environmentFit*100)}`;
  return null;
}

export function familyAdmissionBlock(input:{
  state:FamilyExperimentState;rule:RelationRule;allRules:RelationRule[];reserve:boolean;openFamilyIds:ReadonlySet<string>;
  netRate:number;edgeRatio:number;roundTripCost:number;
}){
  const familyId=relationFamilyId(input.rule),record=input.state.guards[familyId];
  if(record&&recovered(record,input.allRules))delete input.state.guards[familyId];
  else if(record)return `关系族${familyId}等待新成熟证据：上次${record.reason}后尚未恢复`;
  if(!input.reserve)return null;
  if(input.openFamilyIds.has(familyId))return `关系族${familyId}已有一笔探测仓`;

  const activeRecent=input.rule.scope==="RECENT"&&input.rule.status==="ACTIVE"?{
    netRate:input.rule.longNet,targetRate:input.rule.exitProfile.targetRate,
    normalAdverseRate:input.rule.exitProfile.normalAdverseRate,retentionRate:input.rule.exitProfile.retentionRate,
    samples:input.rule.exitProfile.samples,groups:input.rule.exitProfile.groups}:undefined;
  return reserveExperimentValueBlock({reserve:true,netRate:input.netRate,edgeRatio:input.edgeRatio,
    livePathScore:input.rule.livePathScore,environmentFit:input.rule.environmentFit,roundTripCost:input.roundTripCost,activeRecent});
}

export function recordFamilyFailure(input:{
  state:FamilyExperimentState;familyId:string;sourceRuleId?:string;evidenceAt?:number;health?:number;livePathScore?:number;
  now:number;reason:FamilyFailureReason;symbol:string;
}){
  if(!input.familyId)return;
  const prior=input.state.guards[input.familyId];
  input.state.guards[input.familyId]={
    familyId:input.familyId,sourceRuleId:input.sourceRuleId??prior?.sourceRuleId??"",blockedAt:input.now,
    blockedEvidenceAt:Math.max(prior?.blockedEvidenceAt??0,finite(input.evidenceAt)),
    blockedHealth:finite(input.health,prior?.blockedHealth??0),blockedLivePathScore:finite(input.livePathScore,prior?.blockedLivePathScore??0),
    reason:input.reason,symbol:input.symbol,failures:(prior?.failures??0)+1,
  };
}

export function isFamilyFailure(reason:string,firstProfitAt?:number|null){
  if(reason==="RELATION_DEGRADED"||reason==="NO_POSITIVE_FEEDBACK")return true;
  return (reason==="STRUCTURE_STOP"||reason==="SAMPLE_PATH_DIVERGED")&&!firstProfitAt;
}

export function familyExperimentSummary(state:FamilyExperimentState){
  const records=Object.values(state.guards).sort((a,b)=>b.blockedAt-a.blockedAt);
  const calibrations=Object.values(state.calibrations).sort((a,b)=>b.trades-a.trades||b.updatedAt-a.updatedAt);
  return{version:state.version,blockedFamilies:records.length,records:records.slice(0,12),calibrationCount:calibrations.length,
    calibrations:calibrations.slice(0,12)};
}
