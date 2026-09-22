import { aggregateTurnCandles, TURN_CONFIG, type MultiTurnState, type TurnCandle, type TurnTimeframe, type TurnSide, type TurnCandidate } from "./multi-turn-engine.ts";

export const MULTI_TURN_ENTRY_OPPORTUNITY_VERSION="anchor-entry-v2";
export const SHORT_ENTRY_TIMEFRAMES=["5m","15m","30m","1h"] as const satisfies readonly TurnTimeframe[];

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
};

type QuoteLike={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};
type AnchorCandidate={
  side:"LONG"|"SHORT";anchorIndex:number;anchorPrice:number;anchorAt:number;confirmedAt:number;quality:number;
  mfeRate:number;maeRate:number;profitRatio:number;firstProfitBars:number;retentionRate:number;ageBars:number;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(v:number[])=>{const a=[...v].sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const tfMs=(tf:TurnTimeframe)=>TURN_CONFIG[tf].minutes*60_000;
const completedAt=(row:TurnCandle,tf:TurnTimeframe)=>row.time*1000+tfMs(tf);

function validRows(rows:TurnCandle[],tf:TurnTimeframe){
  const cfg=TURN_CONFIG[tf],need=Math.max(cfg.minBars,18),a=rows.slice(-Math.max(need,96));
  if(a.length<need)return null;
  const step=tfMs(tf)/1000;
  if(a.some((r,i)=>![r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)||r.time<=0||r.open<=0||r.high<=0||r.low<=0||r.close<=0
    ||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.volume<0||(i>0&&r.time!==a[i-1].time+step)))return null;
  return a;
}

function proofBars(tf:TurnTimeframe){return tf==="1h"?2:3;}

function anchorOutcome(rows:TurnCandle[],anchorIndex:number,side:"LONG"|"SHORT",atrRate:number,costRate:number,tf:TurnTimeframe):AnchorCandidate|null{
  const bars=proofBars(tf),anchor=rows[anchorIndex],future=rows.slice(anchorIndex+1,anchorIndex+1+bars);
  if(future.length<bars)return null;
  const d=side==="LONG"?1:-1,price=anchor.close;
  const favorable=(row:TurnCandle)=>side==="LONG"?(row.high/price-1):(1-row.low/price);
  const adverse=(row:TurnCandle)=>side==="LONG"?(1-row.low/price):(row.high/price-1);
  const closeReturn=(row:TurnCandle)=>d*(row.close/price-1);
  const mfeRate=Math.max(0,...future.map(favorable));
  const maeRate=Math.max(0,...future.map(adverse));
  const meaningfulProfit=Math.max(costRate*1.35,atrRate*.50,.0012);
  const first=future.findIndex(row=>closeReturn(row)>=meaningfulProfit*.75);
  if(mfeRate<meaningfulProfit||first<0)return null;
  const finalReturn=closeReturn(future.at(-1)!);
  if(finalReturn<=0)return null;
  const profitRatio=mfeRate/Math.max(maeRate,atrRate*.08,costRate*.25,1e-9);
  if(profitRatio<1.35)return null;
  const speed=1-first/Math.max(1,bars);
  const retentionRate=clip(finalReturn/Math.max(mfeRate,1e-9));
  const adverseTolerance=Math.max(meaningfulProfit,atrRate*.70);
  const adverseQuality=1-clip(maeRate/adverseTolerance);
  const ratioQuality=clip((profitRatio-1)/3.5);
  const quality=100*(.42*ratioQuality+.28*speed+.20*retentionRate+.10*adverseQuality);
  if(quality<48)return null;
  const confirmed=future.at(-1)!;
  return{side,anchorIndex,anchorPrice:price,anchorAt:completedAt(anchor,tf),confirmedAt:completedAt(confirmed,tf),quality,
    mfeRate,maeRate,profitRatio,firstProfitBars:first+1,retentionRate,ageBars:rows.length-1-anchorIndex};
}

function findBestAnchor(rows:TurnCandle[],atrRate:number,costRate:number,tf:TurnTimeframe){
  const maxLookback=tf==="5m"?18:tf==="15m"?16:12;
  const bars=proofBars(tf),start=Math.max(0,rows.length-maxLookback-bars-1),end=rows.length-bars-1;
  const candidates:AnchorCandidate[]=[];
  for(let i=start;i<=end;i++)for(const side of["LONG","SHORT"] as const){
    const row=anchorOutcome(rows,i,side,atrRate,costRate,tf);if(row)candidates.push(row);
  }
  return candidates.sort((a,b)=>{
    const aRank=a.quality-Math.max(0,a.ageBars-bars)*1.8,bRank=b.quality-Math.max(0,b.ageBars-bars)*1.8;
    return bRank-aRank||b.confirmedAt-a.confirmedAt;
  })[0]??null;
}

function nearestStructureSpace(rows:TurnCandle[],side:"LONG"|"SHORT",price:number,atrRate:number){
  const prior=rows.slice(0,-1),gap=Math.max(.0005,atrRate*.15);
  if(side==="LONG"){
    const levels=prior.map(r=>r.high).filter(level=>level>price*(1+gap)).sort((a,b)=>a-b);
    return levels.length?levels[0]/price-1:null;
  }
  const levels=prior.map(r=>r.low).filter(level=>level<price*(1-gap)).sort((a,b)=>b-a);
  return levels.length?1-levels[0]/price:null;
}

function executionScore(q:QuoteLike|undefined,now:number){
  if(!q)return 55;
  if(!q.fresh||q.entryReady===false||now-q.observedAt>10_000)return 15;
  const mid=(q.bestBid+q.bestAsk)/2,spread=(q.bestAsk-q.bestBid)/Math.max(mid,1e-9);
  if(!(spread>=0)||spread>.0015)return 0;
  return 100*(1-.55*clip(spread/.0015));
}

function opportunityFor(input:{symbol:string;timeframe:TurnTimeframe;rows:TurnCandle[];turnEngine:MultiTurnState|null;
  quote?:QuoteLike;now:number;costRate:number}):MultiTurnEntryOpportunity|null{
  const{symbol,timeframe,turnEngine,now}=input,cfg=TURN_CONFIG[timeframe],rows=validRows(input.rows,timeframe);
  if(!rows||!SHORT_ENTRY_TIMEFRAMES.includes(timeframe as typeof SHORT_ENTRY_TIMEFRAMES[number]))return null;
  const last=rows.at(-1)!;
  if(completedAt(last,timeframe)>now||now-completedAt(last,timeframe)>Math.max(10*60_000,cfg.minutes*60_000*1.5))return null;
  const ranges=rows.slice(-14).map(r=>(r.high-r.low)/r.close),atrRate=Math.max(.0005,median(ranges));
  const anchor=findBestAnchor(rows,atrRate,input.costRate,timeframe);
  if(!anchor)return null;

  const q=input.quote,currentPrice=q?.fresh&&now-q.observedAt<=10_000?(q.bestBid+q.bestAsk)/2:last.close;
  const d=anchor.side==="LONG"?1:-1;
  const distanceFromAnchorRate=d*(currentPrice/anchor.anchorPrice-1);
  const allowedBehind=Math.max(anchor.maeRate*1.25,atrRate*.35,input.costRate*.65);
  if(distanceFromAnchorRate<-allowedBehind)return null;

  const maxEntryDistanceRate=Math.max(input.costRate*1.25,Math.min(anchor.mfeRate*.45,atrRate*1.20));
  const distanceAbs=distanceFromAnchorRate>=0?distanceFromAnchorRate:Math.abs(distanceFromAnchorRate)*.65;
  const positionScore=100*(1-clip(distanceAbs/Math.max(maxEntryDistanceRate,1e-9)));

  const demonstratedRemaining=Math.max(0,anchor.mfeRate-Math.max(0,distanceFromAnchorRate));
  const structuralSpaceRate=nearestStructureSpace(rows,anchor.side,currentPrice,atrRate);
  const grossRemainingSpaceRate=Math.max(0,structuralSpaceRate==null?demonstratedRemaining:Math.min(demonstratedRemaining,structuralSpaceRate));
  const netRemainingSpaceRate=Math.max(0,grossRemainingSpaceRate-input.costRate);
  const pullbackRiskRate=Math.max(anchor.maeRate,atrRate*.35,input.costRate*.50);
  const edgeRatio=netRemainingSpaceRate/Math.max(pullbackRiskRate,1e-9);
  const spaceScore=100*clip(edgeRatio/2.2);
  const exec=executionScore(q,now);

  const turnFrame=turnEngine?.frames[symbol]?.[timeframe];
  const turnRisk=turnFrame?.triggerProbability??.25;
  const turnPenalty=3*clip((turnRisk-.55)/.35);
  const score=clip(.50*anchor.quality+.30*spaceScore+.15*positionScore+.05*exec-turnPenalty,0,100);
  const stopRate=Math.min(cfg.maxStop,Math.max(.0035,anchor.maeRate*1.35,atrRate*.85));
  const eligible=anchor.quality>=58&&positionScore>=40&&distanceFromAnchorRate<=maxEntryDistanceRate
    &&netRemainingSpaceRate>0&&edgeRatio>=1.05&&exec>0;

  const reason=`${timeframe} ${anchor.side}锚点 ${anchor.quality.toFixed(0)}分 | 距锚点${(distanceFromAnchorRate*100).toFixed(2)}% | 净空间${(netRemainingSpaceRate*100).toFixed(2)}% | ${eligible?"准备进场":"继续等更好位置"}`;
  const speedScore=100*(1-(anchor.firstProfitBars-1)/Math.max(1,proofBars(timeframe)));
  const adverseQuality=100*(1-clip(anchor.maeRate/Math.max(anchor.mfeRate,1e-9)));
  return{version:MULTI_TURN_ENTRY_OPPORTUNITY_VERSION,symbol,timeframe,side:anchor.side,completedAt:completedAt(last,timeframe),price:currentPrice,
    score,eligible,directionStrength:anchor.quality,spaceScore,positionScore,executionScore:exec,
    trendSlopeScore:anchor.quality,structureScore:anchor.retentionRate*100,pathEfficiency:anchor.retentionRate*100,
    momentumPersistence:speedScore,pullbackResilience:adverseQuality,
    grossRemainingSpaceRate,netRemainingSpaceRate,statisticalRemainingSpaceRate:demonstratedRemaining,structuralSpaceRate,
    pullbackRiskRate,edgeRatio,legMoveRate:Math.max(0,distanceFromAnchorRate),expectedLegRate:anchor.mfeRate,
    legUtilization:clip(Math.max(0,distanceFromAnchorRate)/Math.max(anchor.mfeRate,1e-9)),
    turnRisk,turnPenalty,stopRate,riskCap:cfg.riskCap,reason,
    anchorPrice:anchor.anchorPrice,anchorAt:anchor.anchorAt,anchorConfirmedAt:anchor.confirmedAt,anchorQuality:anchor.quality,
    anchorAgeBars:anchor.ageBars,anchorMfeRate:anchor.mfeRate,anchorMaeRate:anchor.maeRate,anchorProfitRatio:anchor.profitRatio,
    anchorFirstProfitBars:anchor.firstProfitBars,anchorRetentionRate:anchor.retentionRate,
    distanceFromAnchorRate,maxEntryDistanceRate};
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
    ||b.anchorQuality-a.anchorQuality||a.symbol.localeCompare(b.symbol));
}

export function entryOpportunityCandidate(row:MultiTurnEntryOpportunity):TurnCandidate{
  return{symbol:row.symbol,timeframe:row.timeframe,side:row.side,score:row.score/100,riskCap:row.riskCap,stopRate:row.stopRate,
    expectedMoveRate:row.grossRemainingSpaceRate,turnProbability:row.turnRisk,confidence:row.anchorQuality/100,
    continuationScore:row.anchorQuality/100,completedAt:row.completedAt,signalPrice:row.price,reason:row.reason};
}
