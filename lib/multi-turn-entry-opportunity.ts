import { aggregateTurnCandles, TURN_CONFIG, type MultiTurnState, type TurnCandle, type TurnTimeframe, type TurnSide, type TurnCandidate } from "./multi-turn-engine.ts";

export const MULTI_TURN_ENTRY_OPPORTUNITY_VERSION="direction-space-entry-v1";

export type MultiTurnEntryOpportunity={
  version:typeof MULTI_TURN_ENTRY_OPPORTUNITY_VERSION;
  symbol:string;timeframe:TurnTimeframe;side:Exclude<TurnSide,"NEUTRAL">;completedAt:number;price:number;
  score:number;eligible:boolean;directionStrength:number;spaceScore:number;positionScore:number;executionScore:number;
  trendSlopeScore:number;structureScore:number;pathEfficiency:number;momentumPersistence:number;pullbackResilience:number;
  grossRemainingSpaceRate:number;netRemainingSpaceRate:number;statisticalRemainingSpaceRate:number;structuralSpaceRate:number|null;
  pullbackRiskRate:number;edgeRatio:number;legMoveRate:number;expectedLegRate:number;legUtilization:number;
  turnRisk:number;turnPenalty:number;stopRate:number;riskCap:number;reason:string;
};

type QuoteLike={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const median=(v:number[])=>{const a=[...v].sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const quantile=(v:number[],p:number)=>{const a=[...v].sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.floor((a.length-1)*p))]:0;};
const tfMs=(tf:TurnTimeframe)=>TURN_CONFIG[tf].minutes*60_000;
const completedAt=(row:TurnCandle,tf:TurnTimeframe)=>row.time*1000+tfMs(tf);

function validRows(rows:TurnCandle[],tf:TurnTimeframe){
  const cfg=TURN_CONFIG[tf],need=Math.max(cfg.minBars,18),a=rows.slice(-Math.max(need,120));
  if(a.length<need)return null;
  const step=tfMs(tf)/1000;
  if(a.some((r,i)=>![r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)||r.time<=0||r.open<=0||r.high<=0||r.low<=0||r.close<=0
    ||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.volume<0||(i>0&&r.time!==a[i-1].time+step)))return null;
  return a;
}

function maxCounterMove(rows:TurnCandle[],side:"LONG"|"SHORT"){
  if(rows.length<2)return 0;
  let extreme=rows[0].close,worst=0;
  for(const row of rows.slice(1)){
    if(side==="LONG"){extreme=Math.max(extreme,row.high);worst=Math.max(worst,extreme>0?(extreme-row.low)/extreme:0);}
    else{extreme=Math.min(extreme,row.low);worst=Math.max(worst,extreme>0?(row.high-extreme)/extreme:0);}
  }
  return worst;
}

function currentLegStart(rows:TurnCandle[],side:"LONG"|"SHORT",atrRate:number){
  const d=side==="LONG"?1:-1,noise=Math.max(.0005,atrRate*.45);
  let start=Math.max(0,rows.length-2);
  for(let i=rows.length-1;i>Math.max(0,rows.length-24);i--){
    const signed=d*(rows[i].close/rows[i-1].close-1);
    if(signed<-noise){start=i;break;}
    start=i-1;
  }
  return Math.max(0,start);
}

function historicalLegExpectation(rows:TurnCandle[],side:"LONG"|"SHORT",atrRate:number,maxRate:number){
  const d=side==="LONG"?1:-1,samples:number[]=[];
  const src=rows.slice(0,-1);
  for(const bars of[4,6,8,12]){
    for(let i=bars;i<src.length;i++){
      const move=d*(src[i].close/src[i-bars].close-1);
      if(move>Math.max(.001,atrRate*.65))samples.push(move);
    }
  }
  const fallback=Math.max(atrRate*1.8,.003);
  return Math.min(maxRate,Math.max(fallback,samples.length>=6?quantile(samples,.65):fallback));
}

function nearestStructureSpace(rows:TurnCandle[],side:"LONG"|"SHORT",price:number,atrRate:number){
  const prior=rows.slice(0,-1),gap=Math.max(.0005,atrRate*.20);
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
  if(!rows)return null;
  const last=rows.at(-1)!;
  if(completedAt(last,timeframe)>now||now-completedAt(last,timeframe)>Math.max(10*60_000,cfg.minutes*60_000*1.5))return null;
  const ranges=rows.slice(-14).map(r=>(r.high-r.low)/r.close),atrRate=Math.max(.0005,median(ranges));
  const ret=(bars:number)=>last.close/rows[Math.max(0,rows.length-1-bars)].close-1;
  const signedBias=.50*ret(8)+.30*ret(5)+.20*ret(3);
  if(Math.abs(signedBias)<atrRate*.18)return null;
  const side=signedBias>0?"LONG":"SHORT",d=side==="LONG"?1:-1;
  const slopeNorm=Math.abs(signedBias)/Math.max(atrRate*2.25,1e-9);
  const trendSlopeScore=100*clip(slopeNorm);
  const recent=rows.slice(-9);
  let structural=0;
  for(let i=1;i<recent.length;i++){
    structural+=side==="LONG"
      ?Number(recent[i].high>=recent[i-1].high)*.5+Number(recent[i].low>=recent[i-1].low)*.5
      :Number(recent[i].high<=recent[i-1].high)*.5+Number(recent[i].low<=recent[i-1].low)*.5;
  }
  const structureScore=100*structural/Math.max(1,recent.length-1);
  const pathStart=recent[0].close,pathDen=recent.slice(1).reduce((n,row,i)=>n+Math.abs(row.close-recent[i].close),0);
  const pathEfficiency=clip(Math.abs(last.close-pathStart)/Math.max(pathDen,last.close*.0002));
  const returns=recent.slice(1).map((row,i)=>d*(row.close/recent[i].close-1));
  const momentumPersistence=returns.length?returns.filter(x=>x>0).length/returns.length:0;
  const counter=maxCounterMove(recent,side);
  const pullbackResilience=1-clip(counter/Math.max(atrRate*2.6,.001));
  const directionStrength=100*(.30*trendSlopeScore/100+.25*structureScore/100+.20*pathEfficiency+
    .15*momentumPersistence+.10*pullbackResilience);

  const legStart=currentLegStart(rows,side,atrRate),legBase=rows[legStart].close;
  const legMoveRate=Math.max(0,d*(last.close/legBase-1));
  const expectedLegRate=historicalLegExpectation(rows,side,atrRate,cfg.maxStop*3);
  const statisticalRemainingSpaceRate=Math.max(0,expectedLegRate-legMoveRate);
  const structuralSpaceRate=nearestStructureSpace(rows,side,last.close,atrRate);
  const grossRemainingSpaceRate=Math.max(0,structuralSpaceRate==null?statisticalRemainingSpaceRate:
    Math.min(statisticalRemainingSpaceRate,structuralSpaceRate));
  const netRemainingSpaceRate=Math.max(0,grossRemainingSpaceRate-Math.max(0,input.costRate));
  const localStructureRisk=side==="LONG"
    ?Math.max(0,last.close/Math.min(...recent.map(r=>r.low))-1)
    :Math.max(0,Math.max(...recent.map(r=>r.high))/last.close-1);
  const pullbackRiskRate=Math.max(atrRate*.65,Math.min(cfg.maxStop,localStructureRisk));
  const edgeRatio=netRemainingSpaceRate/Math.max(pullbackRiskRate,1e-9);
  const spaceScore=100*clip(edgeRatio/2.5);

  const legUtilization=expectedLegRate>0?legMoveRate/expectedLegRate:1;
  const utilizationScore=legUtilization<=.55?1:clip(1-(legUtilization-.55)/.45);
  const shortMove=Math.max(0,d*ret(3)),extension=shortMove/Math.max(atrRate*Math.sqrt(3),1e-9);
  const extensionScore=extension<=1.7?1:clip(1-(extension-1.7)/1.8);
  const positionScore=100*Math.min(utilizationScore,extensionScore);
  const exec=executionScore(input.quote,now);

  const turnFrame=turnEngine?.frames[symbol]?.[timeframe];
  const turnRisk=turnFrame?.triggerProbability??.25;
  const turnPenalty=15*clip((turnRisk-.25)/.55)+(turnFrame?.phase==="TURNING"?3:turnFrame?.phase==="WATCH"?1.5:0);
  const score=clip(.40*directionStrength+.35*spaceScore+.15*positionScore+.10*exec-turnPenalty,0,100);
  const stopRate=Math.min(cfg.maxStop,Math.max(.0035,pullbackRiskRate,atrRate*1.15));
  const eligible=directionStrength>=45&&netRemainingSpaceRate>0&&edgeRatio>=.75&&positionScore>=20&&turnRisk<.90&&exec>0;
  const reason=`${timeframe} ${side} | 方向${directionStrength.toFixed(0)} | 净空间${(netRemainingSpaceRate*100).toFixed(2)}% | 空间风险比${edgeRatio.toFixed(2)} | 评分${score.toFixed(0)}`;
  return{version:MULTI_TURN_ENTRY_OPPORTUNITY_VERSION,symbol,timeframe,side,completedAt:completedAt(last,timeframe),price:last.close,
    score,eligible,directionStrength,spaceScore,positionScore,executionScore:exec,trendSlopeScore,structureScore,
    pathEfficiency:100*pathEfficiency,momentumPersistence:100*momentumPersistence,pullbackResilience:100*pullbackResilience,
    grossRemainingSpaceRate,netRemainingSpaceRate,statisticalRemainingSpaceRate,structuralSpaceRate,pullbackRiskRate,edgeRatio,
    legMoveRate,expectedLegRate,legUtilization,turnRisk,turnPenalty,stopRate,riskCap:cfg.riskCap,reason};
}

export function evaluateMultiTurnEntryOpportunities(input:{paths:Record<string,TurnCandle[]>;daily?:Record<string,TurnCandle[]>;
  turnEngine?:MultiTurnState|null;quotes?:Record<string,QuoteLike>;now:number;costRate:number|((tf:TurnTimeframe)=>number)}){
  const rows:MultiTurnEntryOpportunity[]=[];
  const daily=input.daily??{};
  for(const[symbol,base]of Object.entries(input.paths)){
    for(const timeframe of Object.keys(TURN_CONFIG) as TurnTimeframe[]){
      const candles=timeframe==="1d"?(daily[symbol]??[]):aggregateTurnCandles(base,timeframe);
      const cost=typeof input.costRate==="function"?input.costRate(timeframe):input.costRate;
      const row=opportunityFor({symbol,timeframe,rows:candles,turnEngine:input.turnEngine??null,quote:input.quotes?.[symbol],now:input.now,costRate:cost});
      if(row)rows.push(row);
    }
  }
  return rows.sort((a,b)=>b.score-a.score||b.directionStrength-a.directionStrength||b.edgeRatio-a.edgeRatio||a.symbol.localeCompare(b.symbol));
}

export function entryOpportunityCandidate(row:MultiTurnEntryOpportunity):TurnCandidate{
  return{symbol:row.symbol,timeframe:row.timeframe,side:row.side,score:row.score/100,riskCap:row.riskCap,stopRate:row.stopRate,
    expectedMoveRate:row.grossRemainingSpaceRate,turnProbability:row.turnRisk,confidence:row.directionStrength/100,
    continuationScore:row.directionStrength/100,completedAt:row.completedAt,signalPrice:row.price,reason:row.reason};
}
