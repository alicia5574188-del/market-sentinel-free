/**
 * C6 conviction: three layers must all pass, else "研究层没开" with the missing layer and how far off it is.
 *  Layer 1 market reward: the playbook's probe is rewarded (score > 0.10%, t ≥ 2, N ≥ 30, current regime not against it).
 *          Persistence unverified (first week) or not positive → only a probe-size entry.
 *  Layer 2 thesis + selection: the thesis lists the playbook (and agrees on side), the coin ranks top 3 with score ≥ 0.5,
 *          and the thesis kind has not been down-weighted by its own hit rate.
 *  Layer 3 position: position reached, confirmation seen, invalidation within the rules (entry.ts).
 * Sizing (parent decision): risk = equity × 0.55% (0.65% premium) × 5 × evidence; evidence 0.3 probe / 0.6 normal /
 * 1.0 strong (t ≥ 3 and the last 30 live records of the playbook net positive). Item 7 off → evidence 1 (legacy-like 5x).
 */
import {SIZING,STEPS} from "./config.ts";
import type {ProbeScore} from "./probes.ts";
import type {Thesis,Playbook,Side} from "./thesis.ts";
import {thesisSupports} from "./thesis.ts";
import type {Candidate} from "./select.ts";

export type Layers={l1:boolean;l2:boolean;probeSize:boolean;why1:string;why2:string};
export function layerOne(score:ProbeScore):{ok:boolean;probeSize:boolean;why:string}{
  if(!score.rewarded){
    const miss=[score.score<=STEPS.rewardScore?`奖励分 ${(score.score*100).toFixed(2)}%≤0.10%`:"",score.t<STEPS.rewardT?`t ${score.t.toFixed(1)}<2`:"",
      score.n<STEPS.rewardN?`样本 ${score.n}<30`:"",score.regimeN>=10&&(score.regimeScore??0)<=0?"当前行情下得分不为正":""].filter(Boolean).join("，");
    return {ok:false,probeSize:true,why:`第一层（市场奖励）没到：${miss||"未被奖励"}`};
  }
  const probeSize=score.persistence!=="ok";
  return {ok:true,probeSize,why:probeSize?`持续性${score.persistence==="unverified"?"未验证":"不为正"}，只能开试探仓`:"市场奖励且持续性通过"};
}
export function layerTwo(thesis:Thesis|null,pb:Playbook,side:Side,c:Candidate|null):{ok:boolean;why:string}{
  if(!thesis)return{ok:false,why:"第二层：还没有市场判断"};
  if(!thesisSupports(thesis,pb,side))return{ok:false,why:`第二层：当前判断不支持这个打法/方向（${thesis.sentence.slice(0,60)}）`};
  if(thesis.weightHalved)return{ok:false,why:`第二层：「${thesis.kind}」判断最近 7 天命中率不高于基础比例，已降权`};
  if(!c||c.reject||c.rank<1)return{ok:false,why:`第二层：选币没过（${c?.reject??"无候选"}）`};
  return{ok:true,why:`判断支持，选币第 ${c.rank}，分 ${c.score.toFixed(2)}`};
}
export function evidenceFactor(score:ProbeScore,probeSize:boolean,liveNet:number[]){
  if(probeSize)return{factor:SIZING.evidence.probe,label:"probe" as const};
  const strong=score.t>=3&&liveNet.length>=30&&liveNet.slice(-30).reduce((a,b)=>a+b,0)>0;
  return strong?{factor:SIZING.evidence.strong,label:"strong" as const}:{factor:SIZING.evidence.normal,label:"normal" as const};
}
/** Normal-flow risk fraction of equity and multiple to send with the order. */
export function normalRisk(input:{premium:boolean;evidence:number;sizingItem:boolean}){
  const riskRate=input.premium?SIZING.premiumRiskRate:SIZING.riskRate;
  return {riskRate,multiple:SIZING.normalMultiple*(input.sizingItem?input.evidence:1)};
}
export function fastRisk(input:{fastMultiple:number;probe:boolean}){
  return {riskRate:SIZING.fastRiskRate,multiple:Math.min(SIZING.fastMaxMultiple,Math.max(1,input.fastMultiple))*(input.probe?1/3:1)};
}
