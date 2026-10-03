/** Own completed launch replaces broad-market thesis authority only. Price,
 * data, flow, counter-pressure and sample thresholds retain the original step.
 * Keep the frozen legacy response module byte-identical for old provenance. */
import type { CandleLike, MarketSymbolState, QuoteLike } from "./market-intelligence-engine.ts";

export const ENTRY_RESPONSE_VERSION="special-own-entry-response-v1";
const DEFAULT_COST=.0019;
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;

export type EntryResponseMemory={
  startedAt:number;deadlineAt:number;initialPrice:number;samples:number;bestAdvanceRate:number;maxAdverseRate:number;
  supportSamples:number;oppositionSamples:number;
};
export type EntryResponseDecision={
  action:"WAIT"|"PASS"|"RETEST"|"CANCEL";fastLane:boolean;currentAdvanceRate:number;bestAdvanceRate:number;maxAdverseRate:number;
  supportSamples:number;oppositionSamples:number;supportFamilies:string[];concernFamilies:string[];reason:string;
};

function oppositeScore(state:MarketSymbolState|undefined,side:"LONG"|"SHORT"){
  if(!state)return 50;return side==="LONG"?state.shortScore:state.longScore;
}
function minuteProgress(rows:CandleLike[]|undefined,side:"LONG"|"SHORT",startedAt:number,now:number){
  const d=dir(side),eligible=(rows??[]).filter(r=>{
    const end=r.time*1000+60_000;return end>startedAt&&end<=now&&r.open>0&&r.close>0;
  }).slice(-3);
  if(!eligible.length)return{support:false,concern:false,progress:0,count:0};
  const moves=eligible.map(r=>d*(r.close/r.open-1)),progress=moves.reduce((a,b)=>a+b,0),
    positive=moves.filter(v=>v>0).length,negative=moves.filter(v=>v<0).length;
  return{support:progress>0&&positive>=negative,concern:progress<0&&negative>positive,progress,count:eligible.length};
}
export function entryResponseWindowMs(input:{score:number;edgeRatio:number;sourceCount:number;disagreementRate:number;mode?:string;fastLaneAllowed?:boolean}){
  const qualifiesForFast=input.score>=88&&input.edgeRatio>=1.60&&input.sourceCount>=3&&input.disagreementRate<=.0035,
    fast=input.mode!=="RELATIVE"&&input.fastLaneAllowed!==false&&qualifiesForFast;
  // RELATIVE anomalies may still keep the same observation time, but they must
  // earn entry through the ordinary response thresholds instead of the chase lane.
  return{fastLane:fast,windowMs:qualifiesForFast?180_000:150_000};
}

export function evaluateSpecialEntryResponse(input:{
  now:number;side:"LONG"|"SHORT";score:number;edgeRatio:number;pullbackRiskRate:number;stopRate:number;sourceCount:number;
  disagreementRate:number;mode?:string;fastLaneAllowed?:boolean;price:number;memory:EntryResponseMemory;state?:MarketSymbolState;quote?:QuoteLike;minutePath?:CandleLike[];
  costRate?:number;allowRetest?:boolean;
  ownLaunchProof?:{side:'LONG'|'SHORT';at:number};
}):EntryResponseDecision{
  const d=dir(input.side),cost=Math.max(.0005,input.costRate??DEFAULT_COST),q=input.quote,state=input.state,
    sourceCount=Math.max(input.sourceCount,state?.sourceCount??0,q?.sourceCount??0),disagreement=q?.disagreementRate??input.disagreementRate,
    profile=entryResponseWindowMs({score:input.score,edgeRatio:input.edgeRatio,sourceCount,disagreementRate:disagreement,mode:input.mode,
      fastLaneAllowed:input.fastLaneAllowed}),
    currentAdvance=d*(input.price/input.memory.initialPrice-1),
    bestAdvance=Math.max(input.memory.bestAdvanceRate,currentAdvance),
    maxAdverse=Math.max(input.memory.maxAdverseRate,-currentAdvance,0),
    opposite=oppositeScore(state,input.side),
    alignedZ=d*(state?.residualZ??0),alignedPressure=d*(state?.venuePressure??0),
    alignedBook=d*(q?.bookImbalance??0),
    alignedLiquidity=d*((q?.bidLiquidityChange??0)-(q?.askLiquidityChange??0))*.5,
    alignedBreadth=d*(q?.sourceBreadth??0),alignedShortMove=d*(q?.medianShortMove??0),
    liquiditySources=q?.liquiditySourceCount??0,minute=minuteProgress(input.minutePath,input.side,input.memory.startedAt,input.now),
    ownLaunch=!!input.ownLaunchProof&&input.ownLaunchProof.side===input.side&&input.ownLaunchProof.at>0
      &&input.ownLaunchProof.at<=input.now&&input.now-input.ownLaunchProof.at<=12*60000,
    thesisSupport=ownLaunch,
    flowSupport=alignedPressure>=.12
      ||(liquiditySources>=2&&(alignedBook>=.10||alignedLiquidity>=.08))
      ||(alignedBreadth>=.25&&alignedShortMove>=0),
    flowOpposition=alignedPressure<=-.35
      ||(liquiditySources>=2&&alignedBook<=-.15&&alignedLiquidity<=-.10)
      ||(alignedBreadth<=-.35&&alignedShortMove<0),
    structureOpposition=!ownLaunch&&!!state&&state.signalSide!==input.side&&opposite>=68&&alignedZ<-.20,
    minAdvance=Math.max(cost*(profile.fastLane?.30:.45),
      Math.min(input.pullbackRiskRate*(profile.fastLane?.18:.22),profile.fastLane?.0012:.0016)),
    priceResponse=bestAdvance>=minAdvance
      &&currentAdvance>=Math.max(minAdvance*.72,bestAdvance*.45),
    dataReady=sourceCount>=2&&disagreement<=.008,
    supportFamilies=[
      ...(priceResponse?["PRICE"]:[]),
      ...(thesisSupport?["THESIS"]:[]),
      ...(flowSupport?["FLOW"]:[]),
      ...(minute.support?["MINUTE"]:[]),
    ],
    concernFamilies=[
      ...(flowOpposition?["FLOW"]:[]),
      ...(structureOpposition?["STRUCTURE"]:[]),
      ...(minute.concern?["MINUTE"]:[]),
    ],
    supportNow=dataReady&&priceResponse&&thesisSupport&&!structureOpposition
      &&(profile.fastLane||(!flowOpposition&&(flowSupport||minute.support))),
    deepAdverse=currentAdvance<=-Math.min(input.stopRate*.80,Math.max(input.pullbackRiskRate*.90,cost*2.2)),
    hardStructureOpposition=structureOpposition&&currentAdvance<=-Math.max(cost*.55,input.pullbackRiskRate*.22),
    oppositionNow=structureOpposition||(flowOpposition&&currentAdvance<=cost*.15)||deepAdverse,
    supportSamples=supportNow?input.memory.supportSamples+1:0,
    oppositionSamples=oppositionNow?input.memory.oppositionSamples+1:0,
    elapsed=input.now-input.memory.startedAt;

  if(!ownLaunch)return{action:'CANCEL',fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
    supportSamples:0,oppositionSamples,supportFamilies:[],concernFamilies,reason:'本币已完成启动依据缺失、超时或属于未来，撤销本轮入场。'};
  if(input.now>=input.memory.deadlineAt)
    return{action:"CANCEL",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,reason:"武装等待窗口结束，稳定交易假设仍未重新形成可执行价格响应。"};
  if((deepAdverse||hardStructureOpposition)&&elapsed>=4_000)
    return{action:"CANCEL",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,
      reason:deepAdverse?"价格已经超出正常回调并接近结构失效，取消本轮入场。":"交易标的自身结构已经持续转向，取消本轮入场。"};
  if(oppositionSamples>=2&&elapsed>=4_000){
    if(input.allowRetest)
      return{action:"RETEST",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
        supportSamples,oppositionSamples,supportFamilies,concernFamilies,
        reason:"短时实时响应与稳定交易假设冲突，但尚未构成结构失效；保留武装状态，等待回调/噪声结束后重新按原方向启动。"};
    return{action:"CANCEL",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,reason:"实时响应连续两次与原假设冲突，取消本轮入场。"};
  }
  if(supportSamples>=2&&elapsed>=4_000)
    return{action:"PASS",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,
      reason:`实时响应确认：价格推进 ${(currentAdvance*100).toFixed(2)}%，${supportFamilies.join("＋")} 支持。`};
  return{action:"WAIT",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
    supportSamples,oppositionSamples,supportFamilies,concernFamilies,
    reason:priceResponse?"价格已响应，等待独立实时证据稳定。":"等待价格开始按交易假设产生真实响应。"};
}
