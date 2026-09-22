import { aggregateTurnCandles, TURN_CONFIG, type MultiTurnState, type TurnCandle, type TurnTimeframe, type TurnSide, type TurnCandidate } from "./multi-turn-engine.ts";

export const MULTI_TURN_ENTRY_OPPORTUNITY_VERSION="winding-anchor-entry-v3";
export const SHORT_ENTRY_TIMEFRAMES=["5m","15m","30m","1h"] as const satisfies readonly TurnTimeframe[];
export type ForwardTargetType="RESISTANCE"|"SUPPORT"|"OLDER_WINDING";

export type MultiTurnEntryOpportunity={
  version:typeof MULTI_TURN_ENTRY_OPPORTUNITY_VERSION;
  symbol:string;timeframe:TurnTimeframe;side:Exclude<TurnSide,"NEUTRAL">;completedAt:number;price:number;
  score:number;eligible:boolean;directionStrength:number;spaceScore:number;positionScore:number;executionScore:number;
  trendSlopeScore:number;structureScore:number;pathEfficiency:number;momentumPersistence:number;pullbackResilience:number;
  grossRemainingSpaceRate:number;netRemainingSpaceRate:number;statisticalRemainingSpaceRate:number;structuralSpaceRate:number|null;
  pullbackRiskRate:number;edgeRatio:number;legMoveRate:number;expectedLegRate:number;legUtilization:number;
  turnRisk:number;turnPenalty:number;stopRate:number;riskCap:number;reason:string;
  anchorPrice:number;anchorAt:number;anchorConfirmedAt:number;anchorQuality:number;anchorAgeBars:number;
  anchorMfeRate:number;anchorMaeRate:number;anchorProfitRatio:number;anchorFirstProfitBars:number;anchorRetentionRate:number;
  distanceFromAnchorRate:number;maxEntryDistanceRate:number;
  windingBandRate?:number;breakoutBars?:number;breakoutRate?:number;
  targetPrice?:number|null;targetType?:ForwardTargetType|null;targetDistanceRate?:number;targetQuality?:number;
};

type QuoteLike={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};
type AnchorCandidate={
  side:"LONG"|"SHORT";startIndex:number;endIndex:number;anchorPrice:number;anchorAt:number;confirmedAt:number;quality:number;
  bandRate:number;breakoutBars:number;breakoutRate:number;touches:number;crossings:number;ageBars:number;
};
type TargetCandidate={price:number;type:ForwardTargetType;distanceRate:number;quality:number};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(v:number[])=>{const a=[...v].sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const tfMs=(tf:TurnTimeframe)=>TURN_CONFIG[tf].minutes*60_000;
const completedAt=(row:TurnCandle,tf:TurnTimeframe)=>row.time*1000+tfMs(tf);
const typical=(r:TurnCandle)=>(r.high+r.low+r.close)/3;

function validRows(rows:TurnCandle[],tf:TurnTimeframe){
  const cfg=TURN_CONFIG[tf],need=Math.max(cfg.minBars,18),a=rows.slice(-Math.max(need,96));
  if(a.length<need)return null;
  const step=tfMs(tf)/1000;
  if(a.some((r,i)=>![r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)||r.time<=0||r.open<=0||r.high<=0||r.low<=0||r.close<=0
    ||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.volume<0||(i>0&&r.time!==a[i-1].time+step)))return null;
  return a;
}

function windingBars(tf:TurnTimeframe){return tf==="5m"?6:tf==="15m"?5:tf==="30m"?5:4;}
function windingLookback(tf:TurnTimeframe){return tf==="5m"?11:tf==="15m"?9:7;}

function windingStats(window:TurnCandle[],center:number,toleranceRate:number){
  let crossings=0,previous=0,positive=0,negative=0;
  for(const row of window){
    const side=row.close>center?1:row.close<center?-1:0;
    if(side>0)positive++;if(side<0)negative++;
    if(side&&previous&&side!==previous)crossings++;
    if(side)previous=side;
  }
  const touches=window.filter(row=>row.low<=center*(1+toleranceRate)&&row.high>=center*(1-toleranceRate)).length;
  return{touches,crossings,positive,negative};
}

function findWindingAnchor(rows:TurnCandle[],currentPrice:number,atrRate:number,costRate:number,tf:TurnTimeframe){
  const size=windingBars(tf),maxAge=windingLookback(tf),latestEnd=rows.length-2;
  const earliestEnd=Math.max(size-1,rows.length-1-maxAge),candidates:AnchorCandidate[]=[];
  for(let end=latestEnd;end>=earliestEnd;end--){
    const start=end-size+1;if(start<0)continue;
    const window=rows.slice(start,end+1),center=median(window.map(typical));if(!(center>0))continue;
    const bandRate=Math.max(...window.map(row=>Math.max(Math.abs(row.high/center-1),Math.abs(row.low/center-1))));
    const maxBand=Math.max(costRate*1.8,atrRate*1.55,.0018);
    if(bandRate>maxBand)continue;
    const toleranceRate=Math.max(bandRate*.32,atrRate*.18,costRate*.22,.00025);
    const stats=windingStats(window,center,toleranceRate);
    const oscillating=(stats.positive>0&&stats.negative>0)||stats.touches>=Math.ceil(size*.75);
    if(!oscillating||stats.touches<Math.ceil(size*.50))continue;
    const net=Math.abs(window.at(-1)!.close/window[0].close-1);
    if(net>Math.max(bandRate*1.25,atrRate*1.05,costRate*1.6))continue;

    const signed=currentPrice/center-1,departureThreshold=Math.max(bandRate*.42,atrRate*.20,costRate*.30,.00055);
    if(Math.abs(signed)<=departureThreshold)continue;
    const side=signed>0?"LONG":"SHORT",d=side==="LONG"?1:-1,after=rows.slice(end+1);
    const directional=after.filter(row=>d*(row.close/center-1)>departureThreshold*.35).length;
    if(!directional||directional<Math.ceil(after.length*.40))continue;

    const ageBars=rows.length-1-end,breakoutRate=Math.abs(signed);
    const compactness=1-clip(bandRate/maxBand);
    const oscillation=clip(.60*(stats.touches/size)+.40*Math.min(1,stats.crossings/2));
    const departure=clip((breakoutRate-departureThreshold)/Math.max(atrRate*1.35,departureThreshold));
    const recency=1-clip((ageBars-1)/Math.max(1,maxAge-1));
    const quality=100*(.38*oscillation+.20*compactness+.27*departure+.15*recency);
    if(quality<36)continue;
    candidates.push({side,startIndex:start,endIndex:end,anchorPrice:center,anchorAt:completedAt(window.at(-1)!,tf),
      confirmedAt:completedAt(rows.at(-1)!,tf),quality,bandRate,breakoutBars:ageBars,breakoutRate,
      touches:stats.touches,crossings:stats.crossings,ageBars});
  }
  return candidates.sort((a,b)=>{
    const ar=a.quality-Math.max(0,a.ageBars-1)*1.4,br=b.quality-Math.max(0,b.ageBars-1)*1.4;
    return br-ar||b.endIndex-a.endIndex;
  })[0]??null;
}

function targetDistance(side:"LONG"|"SHORT",currentPrice:number,level:number){
  return side==="LONG"?level/currentPrice-1:1-level/currentPrice;
}

function forwardTargets(rows:TurnCandle[],beforeIndex:number,side:"LONG"|"SHORT",currentPrice:number,atrRate:number,costRate:number){
  const history=rows.slice(Math.max(0,beforeIndex-80),beforeIndex),targets:TargetCandidate[]=[];
  if(history.length<5)return targets;
  const minGap=Math.max(atrRate*.10,costRate*.18,.00035);
  const tolerance=Math.max(atrRate*.24,costRate*.35,.00045);

  for(let i=2;i<history.length-2;i++){
    const row=history[i],level=side==="LONG"?row.high:row.low,dist=targetDistance(side,currentPrice,level);
    if(dist<=minGap)continue;
    const local=side==="LONG"
      ?row.high>=history[i-1].high&&row.high>=history[i+1].high&&row.high>=history[i-2].high&&row.high>=history[i+2].high
      :row.low<=history[i-1].low&&row.low<=history[i+1].low&&row.low<=history[i-2].low&&row.low<=history[i+2].low;
    if(!local)continue;
    const neighbours=history.slice(Math.max(0,i-8),Math.min(history.length,i+9));
    const touches=neighbours.filter(x=>{
      const p=side==="LONG"?x.high:x.low;return Math.abs(p/level-1)<=tolerance;
    }).length;
    const localMid=median(neighbours.map(x=>x.close));
    const prominence=Math.abs(level/localMid-1);
    const quality=100*clip(.45*Math.min(1,touches/3)+.55*clip(prominence/Math.max(atrRate*.8,costRate*.8,.0008)));
    targets.push({price:level,type:side==="LONG"?"RESISTANCE":"SUPPORT",distanceRate:dist,quality});
  }

  const size=5,maxBand=Math.max(atrRate*1.8,costRate*2.1,.0022);
  for(let end=size-1;end<history.length;end+=2){
    const window=history.slice(end-size+1,end+1),center=median(window.map(typical));
    if(!(center>0))continue;
    const dist=targetDistance(side,currentPrice,center);if(dist<=minGap)continue;
    const band=Math.max(...window.map(row=>Math.max(Math.abs(row.high/center-1),Math.abs(row.low/center-1))));
    if(band>maxBand)continue;
    const stats=windingStats(window,center,Math.max(band*.35,tolerance));
    if(stats.touches<Math.ceil(size*.6))continue;
    const quality=100*clip(.65*(stats.touches/size)+.35*(1-band/maxBand));
    targets.push({price:center,type:"OLDER_WINDING",distanceRate:dist,quality});
  }
  return targets;
}

function chooseForwardTarget(targets:TargetCandidate[],anchorDistanceRate:number){
  if(!targets.length)return null;
  const qualified=targets.filter(row=>row.distanceRate>anchorDistanceRate),pool=qualified.length?qualified:targets;
  return [...pool].sort((a,b)=>{
    const ar=a.distanceRate/Math.max(anchorDistanceRate,1e-9),br=b.distanceRate/Math.max(anchorDistanceRate,1e-9);
    const aRank=.72*clip((ar-1)/2.5)+.28*(a.quality/100),bRank=.72*clip((br-1)/2.5)+.28*(b.quality/100);
    return bRank-aRank||b.distanceRate-a.distanceRate||b.quality-a.quality;
  })[0]??null;
}

function executionScore(q:QuoteLike|undefined,now:number){
  if(!q)return 55;
  if(!q.fresh||q.entryReady===false||now-q.observedAt>10_000)return 15;
  const mid=(q.bestBid+q.bestAsk)/2,spread=(q.bestAsk-q.bestBid)/Math.max(mid,1e-9);
  if(!(spread>=0)||spread>.0015)return 0;
  return 100*(1-.55*clip(spread/.0015));
}

function targetLabel(target:TargetCandidate|null){
  if(!target)return"未找到前方目标";
  if(target.type==="OLDER_WINDING")return"更早缠绕区";
  return target.type==="RESISTANCE"?"前方压力位":"前方支撑位";
}

function opportunityFor(input:{symbol:string;timeframe:TurnTimeframe;rows:TurnCandle[];turnEngine:MultiTurnState|null;
  quote?:QuoteLike;now:number;costRate:number}):MultiTurnEntryOpportunity|null{
  const{symbol,timeframe,turnEngine,now}=input,cfg=TURN_CONFIG[timeframe],rows=validRows(input.rows,timeframe);
  if(!rows||!SHORT_ENTRY_TIMEFRAMES.includes(timeframe as typeof SHORT_ENTRY_TIMEFRAMES[number]))return null;
  const last=rows.at(-1)!;
  if(completedAt(last,timeframe)>now||now-completedAt(last,timeframe)>Math.max(10*60_000,cfg.minutes*60_000*1.5))return null;
  const ranges=rows.slice(-14).map(r=>(r.high-r.low)/r.close),atrRate=Math.max(.0005,median(ranges));
  const q=input.quote,currentPrice=q?.fresh&&now-q.observedAt<=10_000?(q.bestBid+q.bestAsk)/2:last.close;
  const anchor=findWindingAnchor(rows,currentPrice,atrRate,input.costRate,timeframe);if(!anchor)return null;

  const backToAnchorRate=Math.abs(anchor.anchorPrice/currentPrice-1);
  if(!(backToAnchorRate>0))return null;
  const targets=forwardTargets(rows,anchor.startIndex,anchor.side,currentPrice,atrRate,input.costRate);
  const target=chooseForwardTarget(targets,backToAnchorRate);
  const targetDistanceRate=target?.distanceRate??0;
  const grossRemainingSpaceRate=Math.max(0,targetDistanceRate);
  const netRemainingSpaceRate=Math.max(0,grossRemainingSpaceRate-input.costRate);
  const edgeRatio=grossRemainingSpaceRate/Math.max(backToAnchorRate,1e-9);
  const spaceScore=100*clip((edgeRatio-1)/2.5);
  // Entry location is the primary ranking authority: once price has genuinely
  // left anchor1, the closer it still is to that winding center, the better.
  // Forward reward/risk remains a qualification gate and only a secondary score.
  const positionScore=100*(1-clip(backToAnchorRate/Math.max(cfg.maxStop,.001)));
  const exec=executionScore(q,now);

  const turnFrame=turnEngine?.frames[symbol]?.[timeframe],turnRisk=turnFrame?.triggerProbability??.25;
  const turnPenalty=2*clip((turnRisk-.60)/.30);
  const targetQuality=target?.quality??0;
  const score=clip(.58*positionScore+.18*anchor.quality+.10*spaceScore+.07*targetQuality+.07*exec-turnPenalty,0,100);
  const stopRate=Math.min(cfg.maxStop,Math.max(.0035,backToAnchorRate+anchor.bandRate*.25,atrRate*.65,input.costRate*1.15));
  const eligible=!!target&&edgeRatio>1&&netRemainingSpaceRate>0&&exec>0&&backToAnchorRate<=cfg.maxStop*.95;

  const breakoutStrength=100*clip(anchor.breakoutRate/Math.max(atrRate*2.0,input.costRate*2.0,.001));
  const bandQuality=100*(1-clip(anchor.bandRate/Math.max(atrRate*1.8,input.costRate*2.1,.002)));
  const reason=target
    ?timeframe+" "+anchor.side+" | 锚点1 "+anchor.anchorPrice.toFixed(5)+" | 回锚距离"+(backToAnchorRate*100).toFixed(2)+"% | "+targetLabel(target)+" "+target.price.toFixed(5)+"，前方"+(targetDistanceRate*100).toFixed(2)+"% | 空间优势"+edgeRatio.toFixed(2)+"x | "+(eligible?"准备进场":"继续等待")
    :timeframe+" "+anchor.side+" | 已脱离近期缠绕锚点1，但前方暂未找到可用支撑/压力/旧缠绕目标";

  return{version:MULTI_TURN_ENTRY_OPPORTUNITY_VERSION,symbol,timeframe,side:anchor.side,completedAt:completedAt(last,timeframe),price:currentPrice,
    score,eligible,directionStrength:anchor.quality,spaceScore,positionScore,executionScore:exec,
    trendSlopeScore:breakoutStrength,structureScore:targetQuality,pathEfficiency:anchor.quality,momentumPersistence:breakoutStrength,
    pullbackResilience:bandQuality,grossRemainingSpaceRate,netRemainingSpaceRate,
    statisticalRemainingSpaceRate:targetDistanceRate,structuralSpaceRate:target?targetDistanceRate:null,
    pullbackRiskRate:backToAnchorRate,edgeRatio,legMoveRate:backToAnchorRate,expectedLegRate:targetDistanceRate,
    legUtilization:targetDistanceRate>0?clip(backToAnchorRate/targetDistanceRate):1,
    turnRisk,turnPenalty,stopRate,riskCap:cfg.riskCap,reason,
    anchorPrice:anchor.anchorPrice,anchorAt:anchor.anchorAt,anchorConfirmedAt:anchor.confirmedAt,anchorQuality:anchor.quality,
    anchorAgeBars:anchor.ageBars,anchorMfeRate:anchor.breakoutRate,anchorMaeRate:anchor.bandRate,anchorProfitRatio:edgeRatio,
    anchorFirstProfitBars:anchor.breakoutBars,anchorRetentionRate:targetQuality/100,
    distanceFromAnchorRate:backToAnchorRate,maxEntryDistanceRate:targetDistanceRate,
    windingBandRate:anchor.bandRate,breakoutBars:anchor.breakoutBars,breakoutRate:anchor.breakoutRate,
    targetPrice:target?.price??null,targetType:target?.type??null,targetDistanceRate,targetQuality};
}

export function evaluateMultiTurnEntryOpportunities(input:{paths:Record<string,TurnCandle[]>;daily?:Record<string,TurnCandle[]>;
  turnEngine?:MultiTurnState|null;quotes?:Record<string,QuoteLike>;now:number;costRate:number|((tf:TurnTimeframe)=>number)}){
  const out:MultiTurnEntryOpportunity[]=[];
  for(const[symbol,base]of Object.entries(input.paths))for(const timeframe of SHORT_ENTRY_TIMEFRAMES){
    const candles=aggregateTurnCandles(base,timeframe);
    const cost=typeof input.costRate==="function"?input.costRate(timeframe):input.costRate;
    const row=opportunityFor({symbol,timeframe,rows:candles,turnEngine:input.turnEngine??null,quote:input.quotes?.[symbol],now:input.now,costRate:cost});
    if(row)out.push(row);
  }
  const tfPriority:Record<string,number>={"5m":4,"15m":3,"30m":2,"1h":1};
  return out.sort((a,b)=>b.score-a.score||(tfPriority[b.timeframe]??0)-(tfPriority[a.timeframe]??0)
    ||b.edgeRatio-a.edgeRatio||b.anchorQuality-a.anchorQuality||a.symbol.localeCompare(b.symbol));
}

export function entryOpportunityCandidate(row:MultiTurnEntryOpportunity):TurnCandidate{
  return{symbol:row.symbol,timeframe:row.timeframe,side:row.side,score:row.score/100,riskCap:row.riskCap,stopRate:row.stopRate,
    expectedMoveRate:row.grossRemainingSpaceRate,turnProbability:row.turnRisk,confidence:row.anchorQuality/100,
    continuationScore:clip((.55*row.positionScore+.25*row.anchorQuality+.20*row.spaceScore)/100),completedAt:row.completedAt,signalPrice:row.price,reason:row.reason};
}
