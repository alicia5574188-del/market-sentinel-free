import type {
  DirectionClass,EntryRegretLabel,FirstTouchLabel,FirstTouchSpec,GatePathBar,HorizonLabel,PredictiveLabels,PredictiveSide
} from "./types.ts";

const EPS=1e-12;

function assertFinitePositive(name:string,value:number){
  if(!Number.isFinite(value)||value<=0)throw new Error(`${name} must be finite and > 0`);
}

function causalFutureBars(symbol:string,decisionAt:number,bars:GatePathBar[]){
  const sorted=[...bars].filter(b=>b.symbol===symbol&&b.openTime>=decisionAt&&b.closeTime>b.openTime)
    .sort((a,b)=>a.openTime-b.openTime||a.closeTime-b.closeTime);
  let lastClose=decisionAt;
  for(const bar of sorted){
    if(![bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite))throw new Error("future bar contains non-finite values");
    if(bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||bar.low<=0)throw new Error("future bar geometry invalid");
    if(bar.openTime<lastClose)throw new Error("future bars overlap or are out of order");
    lastClose=bar.closeTime;
  }
  return sorted;
}

function direction(ret:number,deadband:number):DirectionClass{
  if(ret>deadband)return 1;
  if(ret<-deadband)return -1;
  return 0;
}

function pathTo(bars:GatePathBar[],endAt:number){
  return bars.filter(b=>b.closeTime<=endAt);
}

function horizonLabel(entryPrice:number,decisionAt:number,bars:GatePathBar[],minutes:number,deadband:number):HorizonLabel|null{
  const endAt=decisionAt+minutes*60_000,path=pathTo(bars,endAt);
  const terminal=path.at(-1);if(!terminal)return null;
  const maxHigh=Math.max(...path.map(b=>b.high)),minLow=Math.min(...path.map(b=>b.low)),
    futureReturnRate=terminal.close/entryPrice-1,
    longMfeRate=Math.max(0,maxHigh/entryPrice-1),longMaeRate=Math.max(0,1-minLow/entryPrice),
    shortMfeRate=Math.max(0,1-minLow/entryPrice),shortMaeRate=Math.max(0,maxHigh/entryPrice-1);
  return{horizonMinutes:minutes,labelEndAt:terminal.closeTime,futureReturnRate,direction:direction(futureReturnRate,deadband),
    longMfeRate,longMaeRate,shortMfeRate,shortMaeRate,terminalPrice:terminal.close};
}

function firstTouch(side:PredictiveSide,entryPrice:number,decisionAt:number,bars:GatePathBar[],spec:FirstTouchSpec):FirstTouchLabel{
  const endAt=decisionAt+spec.maxMinutes*60_000,target=side==="LONG"?entryPrice*(1+spec.rewardRate):entryPrice*(1-spec.rewardRate),
    risk=side==="LONG"?entryPrice*(1-spec.riskRate):entryPrice*(1+spec.riskRate);
  for(const bar of bars){
    if(bar.closeTime>endAt)break;
    const targetHit=side==="LONG"?bar.high>=target:bar.low<=target,
      riskHit=side==="LONG"?bar.low<=risk:bar.high>=risk;
    if(targetHit&&riskHit)return{specId:spec.id,side,outcome:"AMBIGUOUS",touchedAt:bar.closeTime};
    if(targetHit)return{specId:spec.id,side,outcome:"TARGET",touchedAt:bar.closeTime};
    if(riskHit)return{specId:spec.id,side,outcome:"RISK",touchedAt:bar.closeTime};
  }
  return{specId:spec.id,side,outcome:"NONE",touchedAt:null};
}

function entryRegret(entryPrice:number,decisionAt:number,bars:GatePathBar[],waitMinutes:number):EntryRegretLabel|null{
  const path=pathTo(bars,decisionAt+waitMinutes*60_000);if(!path.length)return null;
  const longBestPrice=Math.min(entryPrice,...path.map(b=>b.low)),
    shortBestPrice=Math.max(entryPrice,...path.map(b=>b.high));
  return{waitMinutes,longImprovementRate:Math.max(0,(entryPrice-longBestPrice)/Math.max(entryPrice,EPS)),
    shortImprovementRate:Math.max(0,(shortBestPrice-entryPrice)/Math.max(entryPrice,EPS)),longBestPrice,shortBestPrice};
}

export function buildPredictiveLabels(input:{
  symbol:string;
  decisionAt:number;
  entryPrice:number;
  futureGateBars:GatePathBar[];
  horizonsMinutes?:number[];
  firstTouchSpecs?:FirstTouchSpec[];
  entryRegretWaitMinutes?:number[];
  directionDeadbandRate?:number;
}):PredictiveLabels{
  assertFinitePositive("entryPrice",input.entryPrice);
  if(!Number.isFinite(input.decisionAt)||input.decisionAt<=0)throw new Error("decisionAt must be finite and > 0");
  const horizons=[...(input.horizonsMinutes??[15,30,60,120])].sort((a,b)=>a-b),
    specs=input.firstTouchSpecs??[
      {id:"r50-risk35-30m",rewardRate:.005,riskRate:.0035,maxMinutes:30},
      {id:"r100-risk50-60m",rewardRate:.01,riskRate:.005,maxMinutes:60},
      {id:"r150-risk70-120m",rewardRate:.015,riskRate:.007,maxMinutes:120},
      {id:"r200-risk100-120m",rewardRate:.02,riskRate:.01,maxMinutes:120},
    ],
    waits=[...(input.entryRegretWaitMinutes??[5,10])].sort((a,b)=>a-b),
    deadband=Math.max(0,input.directionDeadbandRate??0),
    bars=causalFutureBars(input.symbol,input.decisionAt,input.futureGateBars);
  const horizonLabels=horizons.map(m=>horizonLabel(input.entryPrice,input.decisionAt,bars,m,deadband)).filter((x):x is HorizonLabel=>!!x);
  const touches=specs.flatMap(spec=>(["LONG","SHORT"] as const).map(side=>firstTouch(side,input.entryPrice,input.decisionAt,bars,spec)));
  const regrets=waits.map(m=>entryRegret(input.entryPrice,input.decisionAt,bars,m)).filter((x):x is EntryRegretLabel=>!!x);
  const maxLabelEndAt=Math.max(input.decisionAt,...horizonLabels.map(x=>x.labelEndAt),
    ...specs.map(x=>input.decisionAt+x.maxMinutes*60_000),...waits.map(x=>input.decisionAt+x*60_000));
  return{symbol:input.symbol,decisionAt:input.decisionAt,entryPrice:input.entryPrice,maxLabelEndAt,
    horizons:horizonLabels,firstTouch:touches,entryRegret:regrets};
}
