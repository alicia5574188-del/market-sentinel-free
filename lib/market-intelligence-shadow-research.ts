import { entryResponseWindowMs } from "./market-intelligence-entry-response.ts";
import { MARKET_INTELLIGENCE_VERSION, type MarketIntelligenceState } from "./market-intelligence-engine.ts";
import { PAPER_COST, type Candle, type ForwardState, type Quote, type Trade } from "./forward-relations.ts";

export const SHADOW_RESEARCH_VERSION="market-intelligence-shadow-research-v1";
export const SHADOW_RESPONSE_QUALITY_VERSION="shadow-response-quality-v2";
export const SHADOW_PROFIT_CONVERSION_VERSION="shadow-profit-conversion-v2";
export const SHADOW_ROLLING_GEOMETRY_VERSION="shadow-rolling-geometry-v1";
export const SHADOW_MILESTONE_CAUSALITY_VERSION="shadow-causal-milestones-v1";
export const SHADOW_MARKET_KEY="market-intelligence:research:v1:shadow-market-geometry";
export const SHADOW_TRADE_KEY="market-intelligence:research:v1:shadow-trade-quality";
export const SHADOW_GEOMETRY_SAMPLE_MS=5*60_000;
export const SHADOW_GEOMETRY_LIMIT=96;
const WINDOWS=[30,60,120] as const;
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const MAX_VALUE_BYTES=96*1024;
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const geometryBucket=(at:number)=>Math.floor(at/SHADOW_GEOMETRY_SAMPLE_MS)*SHADOW_GEOMETRY_SAMPLE_MS;

export type ShadowGeometryLabel="TRENDING"|"ROTATIONAL"|"MIXED";
export type RollingGeometryState={
  version:typeof SHADOW_ROLLING_GEOMETRY_VERSION;state:"INSUFFICIENT"|"STABLE_TREND"|"ROTATIONAL"|"TRANSITIONAL";
  samples60:number;samples90:number;shortFlips60:number;shortFlips90:number;majorFlips90:number;
  breadthCrosses60:number;breadthCrosses90:number;labelTransitions60:number;labelTransitions90:number;
  leadershipRotationShare60:number;mixedShare60:number;trendingShare60:number;rotationScore:number;stabilityScore:number;
};
export type MarketGeometrySnapshot={
  at:number;label:ShadowGeometryLabel;macro:string;major:string;short:string;shortPhase:string;transitionDirection:string;transitionStage:string|null;
  breadth3:number|null;breadth12:number|null;breadthSlope:number|null;dispersion:number|null;synchrony:number|null;residualBalance:number|null;
  leaderPersistence:number|null;venuePressure:number|null;leadershipRotation:boolean;summary:string;rolling?:RollingGeometryState|null;
};
export type EntryLocationWindow={
  minutes:number;bars:number;low:number;high:number;rangeRate:number;rangePosition:number;sidePosition:number;
  distanceToFavorableExtremeRate:number;breakoutBeyondRangeRate:number;directionalRunRate:number;pathEfficiency:number;
};
export type ResponseQuality={
  elapsedMs:number;windowMs:number;elapsedFraction:number;samples:number;advanceRate:number;bestAdvanceRate:number;maxAdverseRate:number;
  advancePerSecond:number;fastLane:boolean;tempo:"IMMEDIATE"|"DEVELOPING"|"LATE";supportFamilies:string[];
};
export type ResponseQualityV2={
  version:typeof SHADOW_RESPONSE_QUALITY_VERSION;score:number;band:"ROBUST"|"MIXED"|"FRAGILE";observedFast15:boolean;
  tempoScore:number;advanceScore:number;speedScore:number;adverseScore:number;supportScore:number;locationStress:number;
  sidePosition30:number|null;pathEfficiency30:number|null;extensionRate30:number|null;flags:string[];
};
export type ProfitConversion={
  observedAt:number;barAt:number|null;peakFavorableRate:number;peakAt:number|null;maxAdverseRate:number;costCoveredAt:number|null;
  currentSignedRate:number;modeledCurrentNetRate:number;realizedNetRate:number|null;realizedNetPnl?:number|null;givebackFromPeakRate:number;
  retainedPeakRatio:number|null;capturedNetVsPeakRatio:number|null;state:"NO_FAVORABLE"|"GROSS_ONLY"|"PROFIT_RETAINED"|"PROFIT_THINNED"|"PROFIT_LOST";
  firstProfitAt:number|null;postEntryState:string|null;
};
export type ProfitConversionV2={
  version:typeof SHADOW_PROFIT_CONVERSION_VERSION;peakNetRate:number;currentNetRate:number;givebackNetRate:number;givebackRatio:number|null;
  proof:"NONE"|"THIN"|"MEANINGFUL"|"EXPANSION";deteriorationScore:number;concernFamilies:number;supportFamilies:number;
  signal:"NO_PROOF"|"LET_RUN"|"WATCH"|"PROTECT_CANDIDATE"|"EXIT_CANDIDATE";reasons:string[];
};
export type ShadowMilestoneSource="LIVE_OBSERVED"|"BACKFILLED";
export type ShadowMilestone={
  at:number;barAt:number|null;status:"OPEN"|"CLOSED";source:ShadowMilestoneSource;responseBand:ResponseQualityV2["band"]|null;
  profitSignal:ProfitConversionV2["signal"];proof:ProfitConversionV2["proof"];peakNetRate:number;currentNetRate:number;
  givebackRatio:number|null;deteriorationScore:number;concernFamilies:number;advantageChange:number|null;
};
export type TradeShadowResearch={
  id:string;tradeId:string;symbol:string;side:"LONG"|"SHORT";status:"OPEN"|"CLOSED";openedAt:number;closedAt:number|null;entryPrice:number;
  entryMode:string|null;entryScore:number|null;entryGeometryProvenance:"CAUSAL_5M"|"PARTIAL_5M"|"UNAVAILABLE";
  entryLocation:EntryLocationWindow[];entryMarket:MarketGeometrySnapshot|null;response:ResponseQuality|null;responseV2?:ResponseQualityV2|null;
  profit:ProfitConversion;profitV2?:ProfitConversionV2;milestones?:ShadowMilestone[];
  milestoneCausalityVersion?:typeof SHADOW_MILESTONE_CAUSALITY_VERSION;
  latestPositionIntelligence:{decision:string;phase:string;holdValueScore:number;continuationRatio:number;
    advantageChange:number;supportFamilies:string[];concernFamilies:string[]} | null;
  lastBarAt:number|null;updatedAt:number;
};
export type ShadowResearchState={
  version:typeof SHADOW_RESEARCH_VERSION;updatedAt:number;market:MarketGeometrySnapshot[];trades:TradeShadowResearch[];
};
type Reader={get<T>(key:string):Promise<T|undefined>};

export function initialShadowResearch(now=Date.now()):ShadowResearchState{
  return{version:SHADOW_RESEARCH_VERSION,updatedAt:now,market:[],trades:[]};
}
const bias=(v:string)=>v==="BULLISH"||v==="BEARISH"?v:null;
function directionalFlips(rows:MarketGeometrySnapshot[],pick:(x:MarketGeometrySnapshot)=>string){
  let prior:string|null=null,n=0;
  for(const row of rows){const next=bias(pick(row));if(!next)continue;if(prior&&next!==prior)n++;prior=next;}
  return n;
}
function breadthCrosses(rows:MarketGeometrySnapshot[]){
  let prior=0,n=0;
  for(const row of rows){const v=row.breadth3;if(v==null||!Number.isFinite(v))continue;const next=v>.12?1:v<-.12?-1:0;
    if(!next)continue;if(prior&&next!==prior)n++;prior=next;}
  return n;
}
function labelTransitions(rows:MarketGeometrySnapshot[]){
  return rows.slice(1).reduce((n,row,i)=>n+Number(row.label!==rows[i]!.label),0);
}
export function deriveRollingGeometry(rows:MarketGeometrySnapshot[],at:number):RollingGeometryState{
  const past=rows.filter(x=>x.at<=at).sort((a,b)=>a.at-b.at),w60=past.filter(x=>at-x.at<60*60_000),
    w90=past.filter(x=>at-x.at<90*60_000),short60=directionalFlips(w60,x=>x.short),short90=directionalFlips(w90,x=>x.short),
    major90=directionalFlips(w90,x=>x.major),breadth60=breadthCrosses(w60),breadth90=breadthCrosses(w90),
    trans60=labelTransitions(w60),trans90=labelTransitions(w90),
    leadership=w60.length?w60.filter(x=>x.leadershipRotation).length/w60.length:0,
    mixed=w60.length?w60.filter(x=>x.label==="MIXED").length/w60.length:0,
    trending=w60.length?w60.filter(x=>x.label==="TRENDING").length/w60.length:0,
    rotation=clip(.28*clip(short90/4)+.16*clip(major90/3)+.20*clip(breadth90/5)+.16*clip(trans90/6)+.10*leadership+.10*mixed),
    stability=1-rotation,state:RollingGeometryState["state"]=w60.length<6?"INSUFFICIENT":rotation>=.55?"ROTATIONAL":
      stability>=.68&&trending>=.45?"STABLE_TREND":"TRANSITIONAL";
  return{version:SHADOW_ROLLING_GEOMETRY_VERSION,state,samples60:w60.length,samples90:w90.length,shortFlips60:short60,shortFlips90:short90,
    majorFlips90:major90,breadthCrosses60:breadth60,breadthCrosses90:breadth90,labelTransitions60:trans60,labelTransitions90:trans90,
    leadershipRotationShare60:leadership,mixedShare60:mixed,trendingShare60:trending,rotationScore:rotation,stabilityScore:stability};
}
function rebuildRollingGeometry(items:MarketGeometrySnapshot[]){
  const chronological=[...items].sort((a,b)=>a.at-b.at),built:MarketGeometrySnapshot[]=[];
  for(const row of chronological){const clean={...row,rolling:undefined};built.push({...clean,rolling:deriveRollingGeometry([...built,clean],row.at)});}
  return built.sort((a,b)=>b.at-a.at);
}
function geometryLabel(s:MarketIntelligenceState){
  const i=s.internals,phase=s.narrative.short.phase;
  if(i&&phase==="BALANCED"&&i.synchrony<.55&&i.dispersion>.40)return"ROTATIONAL" as const;
  if(i&&i.synchrony>=.60&&Math.abs(i.breadth3)>=.35&&i.dispersion<.45)return"TRENDING" as const;
  return"MIXED" as const;
}
function marketSnapshot(s:MarketIntelligenceState):MarketGeometrySnapshot{
  const i=s.internals,e=s.evidence??[];
  return{at:s.updatedAt,label:geometryLabel(s),macro:s.narrative.macro.bias,major:s.narrative.major.bias,short:s.narrative.short.bias,
    shortPhase:s.narrative.short.phase,transitionDirection:s.narrative.transition.direction,transitionStage:s.narrative.transition.stage??null,
    breadth3:i?.breadth3??null,breadth12:i?.breadth12??null,breadthSlope:i?.breadthSlope??null,dispersion:i?.dispersion??null,
    synchrony:i?.synchrony??null,residualBalance:i?.residualBalance??null,leaderPersistence:i?.leaderPersistence??null,
    venuePressure:i?.venuePressure??null,leadershipRotation:e.some(x=>x.type==="LEADERSHIP_ROTATION"),summary:s.narrative.summary};
}
function fallbackNarrativeAt(s:MarketIntelligenceState,at:number):MarketGeometrySnapshot|null{
  const row=[...(s.history??[])].filter(x=>x.at<=at).sort((a,b)=>b.at-a.at)[0];if(!row)return null;
  return{at:row.at,label:"MIXED",macro:row.macro,major:row.major,short:row.short,shortPhase:"UNKNOWN",transitionDirection:"UNKNOWN",
    transitionStage:null,breadth3:null,breadth12:null,breadthSlope:null,dispersion:null,synchrony:null,residualBalance:null,
    leaderPersistence:null,venuePressure:null,leadershipRotation:false,summary:row.summary};
}
function completedBars(rows:Candle[]|undefined,at:number){
  return(rows??[]).filter(b=>b.open>0&&b.high>=b.low&&b.low>0&&b.close>0&&b.time*1000+300_000<=at).sort((a,b)=>a.time-b.time);
}
function entryWindow(rows:Candle[]|undefined,t:Trade,minutes:number):EntryLocationWindow|null{
  const eligible=completedBars(rows,t.openedAt).filter(b=>b.time*1000+300_000>t.openedAt-minutes*60_000);
  if(eligible.length<2)return null;
  const low=Math.min(...eligible.map(x=>x.low)),high=Math.max(...eligible.map(x=>x.high));
  if(!(high>low&&low>0))return null;
  const d=dir(t.side),range=high-low,rangePosition=(t.entryPrice-low)/range,sidePosition=d>0?rangePosition:1-rangePosition,
    favorableExtreme=d>0?high:low,distance=d*(favorableExtreme/t.entryPrice-1),
    breakout=d>0?Math.max(0,t.entryPrice/high-1):Math.max(0,low/t.entryPrice-1),
    first=eligible[0]!.open,closes=[first,...eligible.map(x=>x.close),t.entryPrice],
    travel=closes.slice(1).reduce((sum,v,i)=>sum+Math.abs(v/closes[i]!-1),0),
    run=d*(t.entryPrice/first-1),eff=travel>1e-12?Math.abs(t.entryPrice/first-1)/travel:0;
  return{minutes,bars:eligible.length,low,high,rangeRate:range/t.entryPrice,rangePosition,sidePosition,
    distanceToFavorableExtremeRate:distance,breakoutBeyondRangeRate:breakout,directionalRunRate:run,pathEfficiency:clip(eff)};
}
function responseQuality(t:Trade):ResponseQuality|null{
  const r=t.entryContext?.entryResponse;if(!r)return null;
  const profile=entryResponseWindowMs({score:t.entryContext?.entryScore??0,edgeRatio:t.entryContext?.edgeRatio??0,
    sourceCount:t.entryContext?.sourceCount??0,disagreementRate:t.entryContext?.disagreementRate??1});
  const elapsed=Math.max(0,r.elapsedMs),seconds=Math.max(1,elapsed/1000);
  return{elapsedMs:elapsed,windowMs:profile.windowMs,elapsedFraction:elapsed/profile.windowMs,samples:r.samples,advanceRate:r.advanceRate,
    bestAdvanceRate:r.bestAdvanceRate,maxAdverseRate:r.maxAdverseRate,advancePerSecond:r.bestAdvanceRate/seconds,fastLane:r.fastLane,
    tempo:elapsed<=30_000?"IMMEDIATE":elapsed<=90_000?"DEVELOPING":"LATE",supportFamilies:[...r.supportFamilies]};
}
export function responseQualityV2(response:ResponseQuality|null,location:EntryLocationWindow[]):ResponseQualityV2|null{
  if(!response)return null;
  const loc=location.find(x=>x.minutes===30)??location[0]??null,
    side=loc?.sidePosition??null,path=loc?.pathEfficiency??null,
    extension=side===null?0:clip((side-.90)/.50),
    locationStress=extension*(1-.5*(path??.5)),
    tempoScore=clip(1-response.elapsedFraction),
    advanceScore=clip(response.bestAdvanceRate/(ROUND_TRIP_COST*1.25)),
    speedScore=clip(response.advancePerSecond/(ROUND_TRIP_COST/15)),
    adverseScore=1-clip(response.maxAdverseRate/Math.max(response.bestAdvanceRate,1e-9)),
    supportScore=clip(response.supportFamilies.length/3),
    score=clip(100*(.35*tempoScore+.25*advanceScore+.25*speedScore+.10*adverseScore+.05*supportScore)-15*locationStress,0,100),
    flags:string[]=[];
  if(response.elapsedMs>15_000)flags.push("OVER_15S_OBSERVED_RISK");
  if(response.elapsedFraction>=.60)flags.push("LATE_WINDOW_USAGE");
  if(speedScore<.50)flags.push("WEAK_RESPONSE_SPEED");
  if(side!==null&&side>1.10)flags.push("EXTENDED_LOCATION");
  if(side!==null&&side>.85&&(path??.5)<.45)flags.push("CHOPPY_APPROACH");
  if(response.maxAdverseRate>Math.max(response.bestAdvanceRate*.25,ROUND_TRIP_COST*.15))flags.push("EARLY_ADVERSE_RESPONSE");
  if(side!==null&&side>1&&speedScore>=.9)flags.push("STRONG_EXTENSION_CONFIRMED");
  return{version:SHADOW_RESPONSE_QUALITY_VERSION,score,band:score>=80?"ROBUST":score>=60?"MIXED":"FRAGILE",
    observedFast15:response.elapsedMs<=15_000,tempoScore,advanceScore,speedScore,adverseScore,supportScore,locationStress,
    sidePosition30:side,pathEfficiency30:path,extensionRate30:loc?.breakoutBeyondRangeRate??null,flags};
}
function executablePrice(t:Trade,q:Quote|undefined){
  if(t.status==="CLOSED"&&t.exitPrice&&t.exitPrice>0)return t.exitPrice;
  if(q?.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid)return t.side==="LONG"?q.bestBid:q.bestAsk;
  return t.lastPrice>0?t.lastPrice:t.entryPrice;
}
function pathProfit(t:Trade,rows:Candle[]|undefined,q:Quote|undefined,now:number,old?:TradeShadowResearch):ProfitConversion{
  const d=dir(t.side),end=t.closedAt??now,bars=(rows??[]).filter(b=>b.time*1000+300_000>t.openedAt&&b.time*1000+300_000<=end)
    .sort((a,b)=>a.time-b.time);
  let candlePeak=0,candleAdverse=0,peakAt:number|null=null,costCoveredAt:number|null=null;
  for(const b of bars){
    const at=b.time*1000+300_000,fav=d*((d>0?b.high:b.low)/t.entryPrice-1),adv=-d*((d>0?b.low:b.high)/t.entryPrice-1);
    if(fav>candlePeak){candlePeak=Math.max(0,fav);peakAt=at;}
    candleAdverse=Math.max(candleAdverse,adv,0);if(costCoveredAt==null&&fav>=ROUND_TRIP_COST)costCoveredAt=at;
  }
  const peak=Math.max(t.favorable,candlePeak,old?.profit.peakFavorableRate??0),adverse=Math.max(t.adverse,candleAdverse,old?.profit.maxAdverseRate??0),
    px=executablePrice(t,q),signed=d*(px/t.entryPrice-1),modeledNet=signed-ROUND_TRIP_COST,
    realized=t.status==="CLOSED"&&finite(t.netPnl)?t.netPnl/Math.max(t.notional,1e-9):null,
    effectiveNet=realized??modeledNet,peakNet=peak-ROUND_TRIP_COST,giveback=Math.max(0,peak-signed),
    retained=peak>1e-12?signed/peak:null,capture=peakNet>1e-12?effectiveNet/peakNet:null;
  const state=peak<=0?"NO_FAVORABLE":peak<ROUND_TRIP_COST?"GROSS_ONLY":effectiveNet<=0?"PROFIT_LOST":
    (retained??0)>=.55?"PROFIT_RETAINED":"PROFIT_THINNED";
  return{observedAt:now,barAt:bars.at(-1)?bars.at(-1)!.time*1000+300_000:old?.profit.barAt??null,peakFavorableRate:peak,
    peakAt:peakAt??old?.profit.peakAt??null,maxAdverseRate:adverse,costCoveredAt:costCoveredAt??old?.profit.costCoveredAt??null,
    currentSignedRate:signed,modeledCurrentNetRate:modeledNet,realizedNetRate:realized,realizedNetPnl:t.status==="CLOSED"&&finite(t.netPnl)?t.netPnl:null,
    givebackFromPeakRate:giveback,retainedPeakRatio:retained,capturedNetVsPeakRatio:capture,state,firstProfitAt:t.firstProfitAt??null,
    postEntryState:t.entryContext?.postEntryState??null};
}
function intelligence(t:Trade):TradeShadowResearch["latestPositionIntelligence"]{
  const p=t.positionIntelligence;if(!p)return null;
  return{decision:p.decision,phase:p.phase,holdValueScore:p.holdValueScore,continuationRatio:p.continuationRatio,
    advantageChange:p.advantageChange,supportFamilies:[...p.supportFamilies],concernFamilies:[...p.concernFamilies]};
}
export function profitConversionV2(profit:ProfitConversion,pi:TradeShadowResearch["latestPositionIntelligence"]):ProfitConversionV2{
  const peakNet=Math.max(0,profit.peakFavorableRate-ROUND_TRIP_COST),current=profit.realizedNetRate??profit.modeledCurrentNetRate,
    givebackNet=Math.max(0,peakNet-current),giveback=peakNet>1e-12?givebackNet/peakNet:null,
    proof=peakNet<=0?"NONE":peakNet<ROUND_TRIP_COST?"THIN":peakNet<6*ROUND_TRIP_COST?"MEANINGFUL":"EXPANSION",
    concerns=pi?.concernFamilies.length??0,supports=pi?.supportFamilies.length??0,
    concernScore=clip(concerns/3),advantageScore=clip(-(pi?.advantageChange??0)/50),
    continuationPenalty=pi?clip((1.2-pi.continuationRatio)/1.2):0,
    deterioration=clip(.45*concernScore+.40*advantageScore+.15*continuationPenalty),reasons:string[]=[];
  let signal:ProfitConversionV2["signal"]="NO_PROOF";
  if(proof!=="NONE"){
    signal="LET_RUN";
    if(proof==="EXPANSION"){
      if((giveback??0)>=.75){signal="EXIT_CANDIDATE";reasons.push("大幅扩张利润已回吐至少75%。");}
      else if((giveback??0)>=.55){signal="PROTECT_CANDIDATE";reasons.push("大幅扩张利润已回吐至少55%，但保留趋势尾部空间。");}
      else if((giveback??0)>=.35){signal="WATCH";reasons.push("大幅扩张后开始回吐，先观察推进是否恢复。");}
    }else if(proof==="MEANINGFUL"){
      if((giveback??0)>=.75&&deterioration>=.45){signal="EXIT_CANDIDATE";reasons.push("可兑现利润大幅回吐且独立证据同步恶化。");}
      else if((giveback??0)>=.50&&deterioration>=.35){signal="PROTECT_CANDIDATE";reasons.push("可兑现利润回吐过半且优势正在衰减。");}
      else if((giveback??0)>=.35){signal="WATCH";reasons.push("已覆盖成本的利润开始明显回吐。");}
    }else if((giveback??0)>=.55){
      signal="WATCH";reasons.push("仅薄利润出现回吐，不用紧保护误杀趋势。");
    }
  }
  if(concerns>=2)reasons.push(`${concerns}个独立仓位证据家族出现担忧。`);
  if((pi?.advantageChange??0)<=-30)reasons.push("持仓优势相对入场下降至少30分。");
  return{version:SHADOW_PROFIT_CONVERSION_VERSION,peakNetRate:peakNet,currentNetRate:current,givebackNetRate:givebackNet,
    givebackRatio:giveback,proof,deteriorationScore:deterioration,concernFamilies:concerns,supportFamilies:supports,signal,reasons};
}
function entryMarket(state:ShadowResearchState,forward:ForwardState,t:Trade,old?:TradeShadowResearch){
  if(old?.entryMarket)return old.entryMarket;
  const exact=state.market.filter(x=>x.at<=t.openedAt&&t.openedAt-x.at<=SHADOW_GEOMETRY_SAMPLE_MS).sort((a,b)=>b.at-a.at)[0];
  if(exact)return exact;
  const live=forward.extremumRegime;
  if(live.updatedAt<=t.openedAt&&t.openedAt-live.updatedAt<=SHADOW_GEOMETRY_SAMPLE_MS)return marketSnapshot(live);
  return fallbackNarrativeAt(live,t.openedAt);
}
function appendMilestone(old:TradeShadowResearch|undefined,fresh:{
  status:"OPEN"|"CLOSED";lastBarAt:number|null;responseV2:ResponseQualityV2|null;profitV2:ProfitConversionV2;
  latestPositionIntelligence:TradeShadowResearch["latestPositionIntelligence"];
},now:number,source:ShadowMilestoneSource){
  const prior=[...(old?.milestones??[])].map(x=>({...x,source:x.source==="LIVE_OBSERVED"?"LIVE_OBSERVED" as const:"BACKFILLED" as const})),
    pi=fresh.latestPositionIntelligence,
    point:ShadowMilestone={at:source==="BACKFILLED"&&fresh.status==="CLOSED"?(old?.closedAt??now):now,barAt:fresh.lastBarAt,status:fresh.status,source,
      responseBand:fresh.responseV2?.band??null,profitSignal:fresh.profitV2.signal,proof:fresh.profitV2.proof,
      peakNetRate:fresh.profitV2.peakNetRate,currentNetRate:fresh.profitV2.currentNetRate,givebackRatio:fresh.profitV2.givebackRatio,
      deteriorationScore:fresh.profitV2.deteriorationScore,concernFamilies:fresh.profitV2.concernFamilies,
      advantageChange:pi?.advantageChange??null},
    last=prior.at(-1);
  if(!last||last.status!==point.status||last.source!==point.source||last.responseBand!==point.responseBand
    ||last.profitSignal!==point.profitSignal||last.proof!==point.proof)prior.push(point);
  return prior.slice(-8);
}
function makeTrade(state:ShadowResearchState,forward:ForwardState,t:Trade,paths:Record<string,Candle[]>,quotes:Record<string,Quote>,now:number,old?:TradeShadowResearch):TradeShadowResearch{
  const freshWindows=WINDOWS.map(m=>entryWindow(paths[t.symbol],t,m)).filter((x):x is EntryLocationWindow=>!!x),
    windows=freshWindows.length?freshWindows:(old?.entryLocation??[]),
    provenance=freshWindows.length===WINDOWS.length?"CAUSAL_5M":freshWindows.length?"PARTIAL_5M":old?.entryGeometryProvenance??"UNAVAILABLE",
    response=responseQuality(t),responseV2=responseQualityV2(response,windows),
    profit=pathProfit(t,paths[t.symbol],quotes[t.symbol],now,old),latestPositionIntelligence=intelligence(t),
    profitV2=profitConversionV2(profit,latestPositionIntelligence),lastBarAt=profit.barAt,
    needsCausalityMigration=old?.milestoneCausalityVersion!==SHADOW_MILESTONE_CAUSALITY_VERSION,
    milestoneSource:ShadowMilestoneSource=t.status==="CLOSED"&&needsCausalityMigration?"BACKFILLED":"LIVE_OBSERVED",
    milestones=appendMilestone(old,{status:t.status,lastBarAt,responseV2,profitV2,latestPositionIntelligence},now,milestoneSource),
    updatedAt=t.status==="CLOSED"?(t.closedAt??old?.updatedAt??now):now;
  return{id:`shadow:${t.id}`,tradeId:t.id,symbol:t.symbol,side:t.side,status:t.status,openedAt:t.openedAt,closedAt:t.closedAt,entryPrice:t.entryPrice,
    entryMode:t.entryContext?.mode??null,entryScore:t.entryContext?.entryScore??null,entryGeometryProvenance:provenance,entryLocation:windows,
    entryMarket:entryMarket(state,forward,t,old),response,responseV2,profit,profitV2,milestones,
    milestoneCausalityVersion:SHADOW_MILESTONE_CAUSALITY_VERSION,latestPositionIntelligence,lastBarAt,updatedAt};
}
const tradeRecency=(x:TradeShadowResearch)=>x.closedAt??x.openedAt;
export function trimShadowTrades(items:TradeShadowResearch[]){
  const out=[...items].sort((a,b)=>Number(b.status==="OPEN")-Number(a.status==="OPEN")
    ||tradeRecency(b)-tradeRecency(a)||b.openedAt-a.openedAt).slice(0,100);
  while(out.length>12&&bytes({version:SHADOW_RESEARCH_VERSION,items:out})>MAX_VALUE_BYTES){
    const idx=out.map((x,i)=>({x,i})).filter(v=>v.x.status==="CLOSED")
      .sort((a,b)=>tradeRecency(a.x)-tradeRecency(b.x)||a.x.openedAt-b.x.openedAt)[0]?.i??out.length-1;
    out.splice(idx,1);
  }
  return out;
}
function normalizeMarket(items:MarketGeometrySnapshot[]|undefined){
  const out:MarketGeometrySnapshot[]=[],seen=new Set<number>();
  for(const row of (items??[]).filter(x=>x&&finite(x.at)&&typeof x.label==="string").sort((a,b)=>b.at-a.at)){
    const bucket=geometryBucket(row.at);if(seen.has(bucket))continue;seen.add(bucket);out.push(row);
    if(out.length>=SHADOW_GEOMETRY_LIMIT)break;
  }
  return rebuildRollingGeometry(out);
}
function normalizeTrades(items:TradeShadowResearch[]|undefined){
  const normalized=(items??[]).filter(x=>x&&typeof x.tradeId==="string"&&finite(x.openedAt)&&finite(x.entryPrice)&&x.entryPrice>0)
    .map(x=>({...x,milestones:(x.milestones??[]).map(m=>({...m,source:m.source==="LIVE_OBSERVED"?"LIVE_OBSERVED" as const:"BACKFILLED" as const}))}));
  return trimShadowTrades(normalized);
}
export async function readShadowResearch(storage:Reader,now=Date.now()):Promise<ShadowResearchState>{
  const [m,t]=await Promise.all([
    storage.get<{version?:string;updatedAt?:number;items?:MarketGeometrySnapshot[]}>(SHADOW_MARKET_KEY),
    storage.get<{version?:string;updatedAt?:number;items?:TradeShadowResearch[]}>(SHADOW_TRADE_KEY),
  ]);
  return{version:SHADOW_RESEARCH_VERSION,updatedAt:Math.max(Number(m?.updatedAt)||0,Number(t?.updatedAt)||0,now),
    market:m?.version===SHADOW_RESEARCH_VERSION?normalizeMarket(m.items):[],
    trades:t?.version===SHADOW_RESEARCH_VERSION?normalizeTrades(t.items):[]};
}
export function advanceShadowResearch(input:{state:ShadowResearchState;forward:ForwardState;paths:Record<string,Candle[]>;quotes:Record<string,Quote>;now:number}){
  const next:ShadowResearchState=structuredClone(input.state);let marketChanged=false,tradesChanged=false;
  const sample=marketSnapshot(input.forward.extremumRegime),sampleBucket=geometryBucket(sample.at),
    latestBucket=next.market.length?geometryBucket(next.market[0]!.at):-1;
  if(sample.at>0&&sampleBucket>latestBucket){
    next.market.unshift(sample);next.market=normalizeMarket(next.market);marketChanged=true;
  }
  const byId=new Map(next.trades.map(x=>[x.tradeId,x]));
  for(const trade of [...input.forward.positions,...input.forward.history]){
    if(trade.entryContext?.strategyVersion!==MARKET_INTELLIGENCE_VERSION)continue;
    const old=byId.get(trade.id),fresh=makeTrade(next,input.forward,trade,input.paths,input.quotes,input.now,old);
    const statusChanged=!old||old.status!==fresh.status||old.closedAt!==fresh.closedAt,
      barChanged=!old||old.lastBarAt!==fresh.lastBarAt,
      responseChanged=!old||JSON.stringify(old.response)!==JSON.stringify(fresh.response),
      v2Migration=!old?.responseV2||!old?.profitV2||!Array.isArray(old.milestones)
        ||old?.milestoneCausalityVersion!==SHADOW_MILESTONE_CAUSALITY_VERSION;
    if(statusChanged||barChanged||responseChanged||v2Migration){
      if(old)next.trades.splice(next.trades.findIndex(x=>x.tradeId===trade.id),1);
      next.trades.push(fresh);byId.set(trade.id,fresh);tradesChanged=true;
    }
  }
  if(tradesChanged)next.trades=trimShadowTrades(next.trades);
  if(marketChanged||tradesChanged)next.updatedAt=input.now;
  return{state:next,marketChanged,tradesChanged,changed:marketChanged||tradesChanged};
}
export function shadowResearchWrites(state:ShadowResearchState,marketChanged=true,tradesChanged=true){
  const entries:Record<string,unknown>={};
  if(marketChanged)entries[SHADOW_MARKET_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.market};
  if(tradesChanged)entries[SHADOW_TRADE_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.trades};
  return entries;
}
function responseBandSummary(rows:TradeShadowResearch[],band:ResponseQualityV2["band"]){
  const cohort=rows.filter(x=>x.responseV2?.band===band),closed=cohort.filter(x=>x.status==="CLOSED"),
    pnl=closed.map(x=>x.profit.realizedNetPnl).filter((x):x is number=>finite(x));
  return{tracked:cohort.length,closed:closed.length,wins:pnl.filter(x=>x>0).length,netPnl:pnl.reduce((a,b)=>a+b,0)};
}
export function shadowResearchView(state:ShadowResearchState){
  const closed=state.trades.filter(x=>x.status==="CLOSED"),lost=closed.filter(x=>x.profit.state==="PROFIT_LOST"),
    grossOnly=closed.filter(x=>x.profit.state==="GROSS_ONLY"),late=state.trades.filter(x=>x.response?.tempo==="LATE"),
    immediate=state.trades.filter(x=>x.response?.tempo==="IMMEDIATE"),rotational=state.market.filter(x=>x.label==="ROTATIONAL"),
    trending=state.market.filter(x=>x.label==="TRENDING"),mixed=state.market.filter(x=>x.label==="MIXED"),
    rollingRotational=state.market.filter(x=>x.rolling?.state==="ROTATIONAL"),
    rollingStable=state.market.filter(x=>x.rolling?.state==="STABLE_TREND"),
    rollingTransitional=state.market.filter(x=>x.rolling?.state==="TRANSITIONAL"),
    marketSorted=[...state.market].sort((a,b)=>a.at-b.at),
    coverage=marketSorted.length>1?(marketSorted.at(-1)!.at-marketSorted[0]!.at)/60_000:0,
    transitions=marketSorted.slice(1).reduce((n,x,i)=>n+Number(x.label!==marketSorted[i]!.label),0),
    profitSignals=["NO_PROOF","LET_RUN","WATCH","PROTECT_CANDIDATE","EXIT_CANDIDATE"].reduce<Record<string,number>>((a,k)=>{
      a[k]=state.trades.filter(x=>x.profitV2?.signal===k).length;return a;
    },{}),
    allMilestones=state.trades.flatMap(x=>x.milestones??[]),
    liveMilestones=allMilestones.filter(x=>x.source==="LIVE_OBSERVED"),
    backfilledMilestones=allMilestones.filter(x=>x.source==="BACKFILLED"),
    livePreExit=liveMilestones.filter(x=>x.status==="OPEN"&&(x.profitSignal==="PROTECT_CANDIDATE"||x.profitSignal==="EXIT_CANDIDATE")),
    liveExit=livePreExit.filter(x=>x.profitSignal==="EXIT_CANDIDATE"),
    closedWithLiveLead=closed.flatMap(t=>{
      const first=(t.milestones??[]).filter(x=>x.source==="LIVE_OBSERVED"&&x.status==="OPEN"
        &&(x.profitSignal==="PROTECT_CANDIDATE"||x.profitSignal==="EXIT_CANDIDATE")
        &&t.closedAt!=null&&x.at<t.closedAt).sort((a,b)=>a.at-b.at)[0];
      return first&&t.closedAt!=null?[t.closedAt-first.at]:[];
    });
  const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return{version:state.version,updatedAt:state.updatedAt,purpose:"只读影子研究：市场几何、入场位置、响应质量、盈利转化；不参与任何交易决策。",
    summary:{marketSnapshots:state.market.length,geometrySampleMinutes:SHADOW_GEOMETRY_SAMPLE_MS/60_000,marketCoverageMinutes:coverage,
      geometryTransitions:transitions,rotationalShare:state.market.length?rotational.length/state.market.length:null,
      trendingShare:state.market.length?trending.length/state.market.length:null,mixedShare:state.market.length?mixed.length/state.market.length:null,
      rollingGeometry:{latest:state.market[0]?.rolling??null,rotationalShare:state.market.length?rollingRotational.length/state.market.length:null,
        stableTrendShare:state.market.length?rollingStable.length/state.market.length:null,
        transitionalShare:state.market.length?rollingTransitional.length/state.market.length:null},
      tradesTracked:state.trades.length,closedTracked:closed.length,profitLostAfterCostCoverage:lost.length,grossOnlyThenClosed:grossOnly.length,
      immediateResponses:immediate.length,lateResponses:late.length,responseV2:{ROBUST:responseBandSummary(state.trades,"ROBUST"),
        MIXED:responseBandSummary(state.trades,"MIXED"),FRAGILE:responseBandSummary(state.trades,"FRAGILE")},
      profitV2Signals:profitSignals,causalMilestones:{liveObserved:liveMilestones.length,backfilled:backfilledMilestones.length,
        livePreExitProtectionCandidates:livePreExit.length,livePreExitExitCandidates:liveExit.length,
        closedTradesWithLiveProtectionLead:closedWithLiveLead.length,averageLiveLeadMinutes:avg(closedWithLiveLead.map(x=>x/60_000))},
      averageClosedPeakFavorableRate:avg(closed.map(x=>x.profit.peakFavorableRate)),
      averageClosedCapturedNetVsPeakRatio:avg(closed.map(x=>x.profit.capturedNetVsPeakRatio).filter((x):x is number=>x!==null&&Number.isFinite(x)))},
    marketGeometry:state.market,trades:state.trades};
}
