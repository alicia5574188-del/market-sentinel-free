import type { CandleLike, MarketSymbolState, QuoteLike } from "./market-intelligence-engine.ts";

export const ENTRY_RESPONSE_VERSION="market-intelligence-entry-response-v1";
const DEFAULT_COST=.0019;
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;

export type EntryResponseMemory={
  startedAt:number;deadlineAt:number;initialPrice:number;samples:number;bestAdvanceRate:number;maxAdverseRate:number;
  supportSamples:number;oppositionSamples:number;
};
export type EntryResponseDecision={
  action:"WAIT"|"PASS"|"CANCEL";fastLane:boolean;currentAdvanceRate:number;bestAdvanceRate:number;maxAdverseRate:number;
  supportSamples:number;oppositionSamples:number;supportFamilies:string[];concernFamilies:string[];reason:string;
};

function sideScore(state:MarketSymbolState|undefined,side:"LONG"|"SHORT"){
  if(!state)return 50;return side==="LONG"?state.longScore:state.shortScore;
}
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
export function entryResponseWindowMs(input:{score:number;edgeRatio:number;sourceCount:number;disagreementRate:number}){
  const fast=input.score>=88&&input.edgeRatio>=1.60&&input.sourceCount>=3&&input.disagreementRate<=.0035;
  return{fastLane:fast,windowMs:fast?180_000:150_000};
}

export function evaluateEntryResponse(input:{
  now:number;side:"LONG"|"SHORT";score:number;edgeRatio:number;pullbackRiskRate:number;stopRate:number;sourceCount:number;
  disagreementRate:number;price:number;memory:EntryResponseMemory;state?:MarketSymbolState;quote?:QuoteLike;minutePath?:CandleLike[];
  costRate?:number;
}):EntryResponseDecision{
  const d=dir(input.side),cost=Math.max(.0005,input.costRate??DEFAULT_COST),q=input.quote,state=input.state,
    sourceCount=Math.max(input.sourceCount,state?.sourceCount??0,q?.sourceCount??0),disagreement=q?.disagreementRate??input.disagreementRate,
    profile=entryResponseWindowMs({score:input.score,edgeRatio:input.edgeRatio,sourceCount,disagreementRate:disagreement}),
    currentAdvance=d*(input.price/input.memory.initialPrice-1),
    bestAdvance=Math.max(input.memory.bestAdvanceRate,currentAdvance),
    maxAdverse=Math.max(input.memory.maxAdverseRate,-currentAdvance,0),
    same=sideScore(state,input.side),opposite=oppositeScore(state,input.side),
    alignedZ=d*(state?.residualZ??0),alignedPressure=d*(state?.venuePressure??0),
    alignedBook=d*(q?.bookImbalance??0),
    alignedLiquidity=d*((q?.bidLiquidityChange??0)-(q?.askLiquidityChange??0))*.5,
    alignedBreadth=d*(q?.sourceBreadth??0),alignedShortMove=d*(q?.medianShortMove??0),
    liquiditySources=q?.liquiditySourceCount??0,minute=minuteProgress(input.minutePath,input.side,input.memory.startedAt,input.now),
    thesisSupport=!!state&&state.signalSide===input.side&&same>=62&&alignedZ>=.08,
    flowSupport=alignedPressure>=.12
      ||(liquiditySources>=2&&(alignedBook>=.10||alignedLiquidity>=.08))
      ||(alignedBreadth>=.25&&alignedShortMove>=0),
    flowOpposition=alignedPressure<=-.35
      ||(liquiditySources>=2&&alignedBook<=-.15&&alignedLiquidity<=-.10)
      ||(alignedBreadth<=-.35&&alignedShortMove<0),
    structureOpposition=!!state&&state.signalSide!==input.side&&opposite>=68&&alignedZ<-.20,
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
    supportNow=dataReady&&priceResponse&&thesisSupport&&!flowOpposition
      &&(profile.fastLane||flowSupport||minute.support),
    deepAdverse=currentAdvance<=-Math.min(input.stopRate*.80,Math.max(input.pullbackRiskRate*.90,cost*2.2)),
    oppositionNow=structureOpposition||(flowOpposition&&currentAdvance<=cost*.15)||deepAdverse,
    supportSamples=supportNow?input.memory.supportSamples+1:0,
    oppositionSamples=oppositionNow?input.memory.oppositionSamples+1:0,
    elapsed=input.now-input.memory.startedAt;

  if(input.now>=input.memory.deadlineAt)
    return{action:"CANCEL",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,reason:"实时响应窗口结束，价格与独立证据仍未形成可执行闭环。"};
  if(oppositionSamples>=2&&elapsed>=4_000)
    return{action:"CANCEL",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,reason:"实时响应连续两次与原假设冲突，取消本轮入场。"};
  if(supportSamples>=2&&elapsed>=4_000)
    return{action:"PASS",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
      supportSamples,oppositionSamples,supportFamilies,concernFamilies,
      reason:`实时响应确认：价格推进 ${(currentAdvance*100).toFixed(2)}%，${supportFamilies.join("＋")} 支持。`};
  return{action:"WAIT",fastLane:profile.fastLane,currentAdvanceRate:currentAdvance,bestAdvanceRate:bestAdvance,maxAdverseRate:maxAdverse,
    supportSamples,oppositionSamples,supportFamilies,concernFamilies,
    reason:priceResponse?"价格已响应，等待独立实时证据稳定。":"等待价格开始按交易假设产生真实响应。"};
}
