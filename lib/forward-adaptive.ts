/** Fast/slow adaptation helpers for the Forward engine.
 *
 * This module does not create fixed market strategies and has no exchange
 * authority. The slow lane remains the existing causal condition->response
 * learner. The rapid lane may only promote a 15-minute conditional response
 * after several completed, independent time groups agree after modeled costs.
 * Market-turn information changes priority/risk continuously; it never forces
 * a direction and never turns a market warning into a synthetic trade.
 */
import { EVIDENCE_POLICY, costAwareGiveback, evidenceHash, evidenceQuality, executionCalibration,
  familyKey, matches, modeledCost, type Candidate, type Feedback } from "./forward-evidence.ts";
import type { Condition, Measurement, Rule } from "./forward-relations.ts";
import type { MarketSide, MarketState, TurnForecast } from "./forward-market-state.ts";
import type { MarketTurnProtection } from "./forward-turn-protection.ts";

export const FORWARD_ADAPTIVE_VERSION = "forward-adaptive-v2";
export type AdaptiveLane = "BASE" | "RAPID_15M";
export type AdaptiveCandidate = Candidate & { adaptiveLane: "RAPID_15M" };
export type AdaptiveEntryAdjustment = {
  riskMultiplier:number;
  priorityMultiplier:number;
  reason:string;
};

const clip=(v:number,a:number,b:number)=>Math.min(b,Math.max(a,v));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const q=(v:number[],p:number)=>{const a=[...v].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)))]??0;};
const finite=(v:number)=>Number.isFinite(v);

function standardError(v:number[]){
  if(v.length<2)return Infinity;
  const m=mean(v),variance=v.reduce((n,x)=>n+(x-m)**2,0)/(v.length-1);
  return Math.sqrt(variance/v.length);
}

function dedup(rows:Measurement[]){
  const map=new Map<string,Measurement>();
  for(const r of rows){const key=`${r.symbol}:${r.at}:${r.horizon}`;if(!map.has(key))map.set(key,r);}
  return[...map.values()].sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
}

function groupResponses(rows:Measurement[],cap=Infinity){
  const byTime=new Map<number,Map<string,number[]>>();
  for(const r of rows){
    const key=Math.floor(r.at/(15*60_000)),symbols=byTime.get(key)??new Map<string,number[]>();
    const cell=symbols.get(r.symbol)??[];cell.push(clip(r.response,-cap,cap));symbols.set(r.symbol,cell);byTime.set(key,symbols);
  }
  return[...byTime.entries()].sort((a,b)=>a[0]-b[0]).map(([key,symbols])=>({
    key,
    symbols:[...symbols.keys()],
    value:mean([...symbols.values()].map(mean)),
  }));
}

/**
 * A bounded fast lane for regime migration. It intentionally uses only the
 * existing matured 15-minute response ledger, so no historical backfill or new
 * data source is introduced. Three non-overlapping response groups are
 * required; each must contain several symbols. This is still an experimental
 * hypothesis, not a profitability certificate.
 */
export function inspectRapidCondition(input:{
  rows:Measurement[];
  conditions:Condition[];
  now:number;
  feedback:Feedback[];
}):AdaptiveCandidate|null {
  const ordered=dedup(input.rows.filter(r=>r.horizon===15&&r.endAt<=input.now&&r.availableAt<=input.now));
  const eligible=ordered.filter(r=>matches(r.x,input.conditions));
  const groups=groupResponses(eligible);
  if(groups.length<3)return null;
  const recentGroups=groups.slice(-3);
  if(recentGroups.some(g=>g.symbols.length<3))return null;
  const recentKeys=new Set(recentGroups.map(g=>g.key));
  const recent=eligible.filter(r=>recentKeys.has(Math.floor(r.at/(15*60_000))));
  const symbols=[...new Set(recent.map(r=>r.symbol))].sort();
  if(recent.length<12||symbols.length<4)return null;

  const rawValues=recentGroups.map(g=>g.value);
  const rawMean=mean(rawValues);
  const sign=rawMean>=0?1:-1;
  const aligned=rawValues.filter(v=>sign*v>0).length;
  if(aligned<2)return null;
  const cost=modeledCost(15),se=standardError(rawValues);
  if(!finite(se))return null;
  const rawNet=sign*rawMean-cost-.75*se;
  if(!(rawNet>0))return null;

  const cap=Math.min(.1,Math.max(cost*2,4*q(recent.map(r=>Math.abs(r.response)),.5)));
  const boundedGroups=groupResponses(recent,cap),boundedValues=boundedGroups.map(g=>g.value);
  const boundedSe=standardError(boundedValues),boundedNet=sign*mean(boundedValues)-cost-.75*boundedSe;
  if(!(boundedNet>0))return null;

  const priorGroups=groups.slice(0,-3),priorMean=priorGroups.length?mean(priorGroups.map(g=>g.value)):0;
  const applicable=[...new Set(ordered.map(r=>r.symbol))].sort();
  if(applicable.length<4)return null;
  const side:Rule["side"]=sign>0?"LONG":"SHORT";
  const family=familyKey({horizon:15,side,conditions:input.conditions});
  const calibration=executionCalibration(input.feedback,family,applicable,input.now);
  const calibratedNet=rawNet-calibration.penalty;
  const favorable=recent.map(r=>sign>0?r.up:r.down),adverse=recent.map(r=>sign>0?r.down:r.up);
  const stopRate=clip(q(adverse,.8)*1.15,.003,.10),armRate=Math.max(cost*2,q(favorable,.6));
  const givebackRate=costAwareGiveback(armRate,
    clip(q(recent.map((r,i)=>Math.max(0,favorable[i]-sign*r.response)),.6),.0025,Math.max(.0025,armRate*.8)),cost);
  const exitMode:Rule["exitMode"]=mean(favorable)>Math.max(.0001,sign*rawMean)*1.7?"REACTION_DECAY":"HORIZON";

  const leave=symbols.map(sym=>{
    const without=recent.filter(r=>r.symbol!==sym),g=groupResponses(without,cap);
    return g.length===3?sign*mean(g.map(x=>x.value)):-Infinity;
  });
  const worst=Math.min(...leave),worstWithoutSymbol=Number.isFinite(worst)?worst:null;
  const warnings=[
    "快速适应层仅使用最近3个已完成、互不重叠的15分钟反应时间组；用于缩短行情切换后的规则迁移，不代表已证明盈利。",
  ];
  if(priorGroups.length&&priorMean*sign<0)warnings.push("最近反应方向已与更早样本相反；按快速迁移候选处理并限制风险。");
  if(worstWithoutSymbol!=null&&worstWithoutSymbol-cost-.75*boundedSe<=0)
    warnings.push("最近反应对个别标的仍敏感；保留为低置信实验而非通用优势。");
  if(calibratedNet<=0)warnings.push("实际成交校准后估计非正；仅保留低权重候选，不放大仓位。");

  const quality=Math.min(.85,evidenceQuality(rawNet,boundedNet,se,cost,calibration.penalty));
  const sourceKey=evidenceHash(JSON.stringify(["RAPID_15M",input.conditions,
    recent.map(r=>[r.symbol,r.at,r.response,r.up,r.down]),calibration.sourceKey]));
  return{
    conditions:input.conditions,side,horizon:15,stopRate,armRate,givebackRate,exitMode,
    samples:recent.length,trainGroups:priorGroups.length,checkGroups:3,estimatedNetRate:rawNet,
    priorResponse:sign*priorMean,recentResponse:sign*rawMean,standardError:se,adaptiveLane:"RAPID_15M",
    evidence:{policy:EVIDENCE_POLICY,scope:"CROSS_ASSET",symbols:applicable,sourceKey,family,cap,
      rawNet,boundedNet,calibratedNet,uncertain:true,warnings,costRate:cost,quality,worstWithoutSymbol,calibration},
  };
}

function effectiveTurnPhase(forecast:TurnForecast|null|undefined){
  return forecast?.phase==="UNKNOWN"?forecast.lastFreshPhase:forecast?.phase;
}

/**
 * Continuous risk migration for already-learned candidates. No market state
 * can manufacture a trade and no warning sets a market-derived candidate to
 * zero. Safety failures (stale quote, invalid contract, account risk, etc.) are
 * still hard gates in the execution layer.
 */
export function adaptiveEntryAdjustment(input:{
  side:MarketSide;
  horizon:number;
  state:MarketState|null|undefined;
  forecast:TurnForecast|null|undefined;
  turn:MarketTurnProtection|null|undefined;
}):AdaptiveEntryAdjustment {
  let riskMultiplier=1,priorityMultiplier=1;
  const notes:string[]=[];
  const phase=effectiveTurnPhase(input.forecast);
  const threatened=input.forecast?.threatenedSide;
  const pressure=clip(input.forecast?.pressure??0,0,1);
  if(threatened&&phase&&phase!=="CLEAR"){
    if(input.side===threatened){
      if(phase==="REVERSAL_RISK"){
        riskMultiplier=Math.min(riskMultiplier,.30);priorityMultiplier*=.55;
        notes.push("反转风险下保留小比例原方向实验额度");
      }else{
        riskMultiplier=Math.min(riskMultiplier,Math.max(.45,1-.55*Math.max(.25,pressure)));
        priorityMultiplier*=.78;notes.push("回调预警下连续压低原方向额度而非归零");
      }
    }else{
      priorityMultiplier*=phase==="REVERSAL_RISK"?1.45:1.25;
      notes.push("反方向独立候选优先迁移");
      const confirmed=input.state?.rawMode!=="UNKNOWN"
        &&input.state?.mode===(input.side==="LONG"?"TREND_LONG":"TREND_SHORT");
      if(input.horizon>60&&!confirmed){
        riskMultiplier=Math.min(riskMultiplier,.55);priorityMultiplier*=.85;
        notes.push("长周期反方向在大周期未确认前只用半额");
      }
    }
  }
  if(input.turn?.until&&input.turn.threatenedSide===input.side){
    riskMultiplier=Math.min(riskMultiplier,.20);priorityMultiplier*=.60;
    notes.push("同步急转保护下原方向仅保留探测额度");
  }
  return{
    riskMultiplier:clip(riskMultiplier,.15,1),
    priorityMultiplier:clip(priorityMultiplier,.40,1.60),
    reason:notes.join("；")||"按原学习证据与组合风险预算执行",
  };
}

export function adaptiveCandidatePriority(rule:Pick<Rule,"estimatedNetRate"|"standardError"|"evidence">,
  adjustment:AdaptiveEntryAdjustment){
  const cost=rule.evidence?.costRate??.0022,calibrated=rule.evidence?.calibratedNet??rule.estimatedNetRate;
  const signal=Math.max(0,calibrated)/(cost+Math.max(1e-6,rule.standardError));
  return adjustment.priorityMultiplier*((rule.evidence?.quality??.5)+signal);
}

export function adaptiveTargetRisk(input:{
  equity:number;
  quality:number;
  allocationScale:number;
  riskMultiplier:number;
  stateHeadroom:number;
  readyPeers?:number;
  minimumMeaningfulRisk?:number;
}){
  if(!(input.equity>0)||!(input.stateHeadroom>0))return 0;
  const singleCap=input.equity*.015*clip(input.quality,0,1)
    *clip(input.allocationScale,.01,1)*clip(input.riskMultiplier,.01,1);
  let share=input.stateHeadroom;
  if((input.readyPeers??0)>1&&(input.minimumMeaningfulRisk??0)>0){
    // Share only across as many slots as can still clear a meaningful order.
    // This preserves diversification without the old failure mode where dozens
    // of merely-ready symbols divided every candidate below executable size.
    const capacity=Math.max(1,Math.floor(input.stateHeadroom/input.minimumMeaningfulRisk!));
    const slots=Math.max(1,Math.min(Math.floor(input.readyPeers!),capacity));
    share=input.stateHeadroom/slots;
  }
  return Math.max(0,Math.min(singleCap,share,input.stateHeadroom));
}
