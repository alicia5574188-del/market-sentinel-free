import { entryResponseWindowMs } from "./market-intelligence-entry-response.ts";
import { MARKET_INTELLIGENCE_VERSION, type MarketIntelligenceState } from "./market-intelligence-engine.ts";
import { PAPER_COST, type Candle, type ForwardState, type Quote, type Trade } from "./forward-relations.ts";

export const SHADOW_RESEARCH_VERSION="market-intelligence-shadow-research-v1";
export const SHADOW_MARKET_KEY="market-intelligence:research:v1:shadow-market-geometry";
export const SHADOW_TRADE_KEY="market-intelligence:research:v1:shadow-trade-quality";
const WINDOWS=[30,60,120] as const;
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const MAX_VALUE_BYTES=96*1024;
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));

export type ShadowGeometryLabel="TRENDING"|"ROTATIONAL"|"MIXED";
export type MarketGeometrySnapshot={
  at:number;label:ShadowGeometryLabel;macro:string;major:string;short:string;shortPhase:string;transitionDirection:string;transitionStage:string|null;
  breadth3:number|null;breadth12:number|null;breadthSlope:number|null;dispersion:number|null;synchrony:number|null;residualBalance:number|null;
  leaderPersistence:number|null;venuePressure:number|null;leadershipRotation:boolean;summary:string;
};
export type EntryLocationWindow={
  minutes:number;bars:number;low:number;high:number;rangeRate:number;rangePosition:number;sidePosition:number;
  distanceToFavorableExtremeRate:number;breakoutBeyondRangeRate:number;directionalRunRate:number;pathEfficiency:number;
};
export type ResponseQuality={
  elapsedMs:number;windowMs:number;elapsedFraction:number;samples:number;advanceRate:number;bestAdvanceRate:number;maxAdverseRate:number;
  advancePerSecond:number;fastLane:boolean;tempo:"IMMEDIATE"|"DEVELOPING"|"LATE";supportFamilies:string[];
};
export type ProfitConversion={
  observedAt:number;barAt:number|null;peakFavorableRate:number;peakAt:number|null;maxAdverseRate:number;costCoveredAt:number|null;
  currentSignedRate:number;modeledCurrentNetRate:number;realizedNetRate:number|null;givebackFromPeakRate:number;
  retainedPeakRatio:number|null;capturedNetVsPeakRatio:number|null;state:"NO_FAVORABLE"|"GROSS_ONLY"|"PROFIT_RETAINED"|"PROFIT_THINNED"|"PROFIT_LOST";
  firstProfitAt:number|null;postEntryState:string|null;
};
export type TradeShadowResearch={
  id:string;tradeId:string;symbol:string;side:"LONG"|"SHORT";status:"OPEN"|"CLOSED";openedAt:number;closedAt:number|null;entryPrice:number;
  entryMode:string|null;entryScore:number|null;entryGeometryProvenance:"CAUSAL_5M"|"PARTIAL_5M"|"UNAVAILABLE";
  entryLocation:EntryLocationWindow[];entryMarket:MarketGeometrySnapshot|null;response:ResponseQuality|null;
  profit:ProfitConversion;latestPositionIntelligence:{decision:string;phase:string;holdValueScore:number;continuationRatio:number;
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
    first=eligible[0]!.open,last=eligible.at(-1)!.close,
    closes=[first,...eligible.map(x=>x.close),t.entryPrice],travel=closes.slice(1).reduce((sum,v,i)=>sum+Math.abs(v/closes[i]!-1),0),
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
function executablePrice(t:Trade,q:Quote|undefined){
  if(t.status==="CLOSED"&&t.exitPrice&&t.exitPrice>0)return t.exitPrice;
  if(q?.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid)return t.side==="LONG"?q.bestBid:q.bestAsk;
  return t.lastPrice>0?t.lastPrice:t.entryPrice;
}
function pathProfit(t:Trade,rows:Candle[]|undefined,q:Quote|undefined,now:number):ProfitConversion{
  const d=dir(t.side),end=t.closedAt??now,bars=(rows??[]).filter(b=>b.time*1000+300_000>t.openedAt&&b.time*1000+300_000<=end)
    .sort((a,b)=>a.time-b.time);
  let candlePeak=0,candleAdverse=0,peakAt:number|null=null,costCoveredAt:number|null=null;
  for(const b of bars){
    const at=b.time*1000+300_000,fav=d*((d>0?b.high:b.low)/t.entryPrice-1),adv=-d*((d>0?b.low:b.high)/t.entryPrice-1);
    if(fav>candlePeak){candlePeak=Math.max(0,fav);peakAt=at;}
    candleAdverse=Math.max(candleAdverse,adv,0);if(costCoveredAt==null&&fav>=ROUND_TRIP_COST)costCoveredAt=at;
  }
  const peak=Math.max(t.favorable,candlePeak),adverse=Math.max(t.adverse,candleAdverse),px=executablePrice(t,q),
    signed=d*(px/t.entryPrice-1),modeledNet=signed-ROUND_TRIP_COST,
    realized=t.status==="CLOSED"&&finite(t.netPnl)?t.netPnl/Math.max(t.notional,1e-9):null,
    effectiveNet=realized??modeledNet,peakNet=peak-ROUND_TRIP_COST,giveback=Math.max(0,peak-signed),
    retained=peak>1e-12?signed/peak:null,capture=peakNet>1e-12?effectiveNet/peakNet:null;
  const state=peak<=0?"NO_FAVORABLE":peak<ROUND_TRIP_COST?"GROSS_ONLY":effectiveNet<=0?"PROFIT_LOST":
    (retained??0)>=.55?"PROFIT_RETAINED":"PROFIT_THINNED";
  return{observedAt:now,barAt:bars.at(-1)?bars.at(-1)!.time*1000+300_000:null,peakFavorableRate:peak,
    peakAt:peakAt,maxAdverseRate:adverse,costCoveredAt,currentSignedRate:signed,modeledCurrentNetRate:modeledNet,realizedNetRate:realized,
    givebackFromPeakRate:giveback,retainedPeakRatio:retained,capturedNetVsPeakRatio:capture,state,firstProfitAt:t.firstProfitAt??null,
    postEntryState:t.entryContext?.postEntryState??null};
}
function intelligence(t:Trade):TradeShadowResearch["latestPositionIntelligence"]{
  const p=t.positionIntelligence;if(!p)return null;
  return{decision:p.decision,phase:p.phase,holdValueScore:p.holdValueScore,continuationRatio:p.continuationRatio,
    advantageChange:p.advantageChange,supportFamilies:[...p.supportFamilies],concernFamilies:[...p.concernFamilies]};
}
function entryMarket(state:ShadowResearchState,forward:ForwardState,t:Trade){
  const exact=state.market.filter(x=>x.at<=t.openedAt&&t.openedAt-x.at<=5*60_000).sort((a,b)=>b.at-a.at)[0];
  if(exact)return exact;
  const live=forward.extremumRegime;
  if(live.updatedAt<=t.openedAt&&t.openedAt-live.updatedAt<=5*60_000)return marketSnapshot(live);
  return fallbackNarrativeAt(live,t.openedAt);
}
function makeTrade(state:ShadowResearchState,forward:ForwardState,t:Trade,paths:Record<string,Candle[]>,quotes:Record<string,Quote>,now:number):TradeShadowResearch{
  const windows=WINDOWS.map(m=>entryWindow(paths[t.symbol],t,m)).filter((x):x is EntryLocationWindow=>!!x),
    provenance=windows.length===WINDOWS.length?"CAUSAL_5M":windows.length?"PARTIAL_5M":"UNAVAILABLE";
  const profit=pathProfit(t,paths[t.symbol],quotes[t.symbol],now);
  return{id:`shadow:${t.id}`,tradeId:t.id,symbol:t.symbol,side:t.side,status:t.status,openedAt:t.openedAt,closedAt:t.closedAt,entryPrice:t.entryPrice,
    entryMode:t.entryContext?.mode??null,entryScore:t.entryContext?.entryScore??null,entryGeometryProvenance:provenance,entryLocation:windows,
    entryMarket:entryMarket(state,forward,t),response:responseQuality(t),profit,latestPositionIntelligence:intelligence(t),
    lastBarAt:profit.barAt,updatedAt:now};
}
function trimTrades(items:TradeShadowResearch[]){
  const out=[...items].sort((a,b)=>Number(b.status==="OPEN")-Number(a.status==="OPEN")||b.updatedAt-a.updatedAt).slice(0,100);
  while(out.length>12&&bytes({version:SHADOW_RESEARCH_VERSION,items:out})>MAX_VALUE_BYTES){
    const idx=out.map((x,i)=>({x,i})).filter(v=>v.x.status==="CLOSED").sort((a,b)=>a.x.updatedAt-b.x.updatedAt)[0]?.i??out.length-1;
    out.splice(idx,1);
  }
  return out;
}
function normalizeMarket(items:MarketGeometrySnapshot[]|undefined){
  return(items??[]).filter(x=>x&&finite(x.at)&&typeof x.label==="string").sort((a,b)=>b.at-a.at).slice(0,96);
}
function normalizeTrades(items:TradeShadowResearch[]|undefined){
  return(items??[]).filter(x=>x&&typeof x.tradeId==="string"&&finite(x.openedAt)&&finite(x.entryPrice)&&x.entryPrice>0).slice(0,100);
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
  const marketAt=input.forward.extremumRegime.updatedAt;
  if(marketAt>0&&!next.market.some(x=>x.at===marketAt)){
    next.market.unshift(marketSnapshot(input.forward.extremumRegime));next.market=next.market.slice(0,96);marketChanged=true;
  }
  const byId=new Map(next.trades.map(x=>[x.tradeId,x]));
  for(const trade of [...input.forward.positions,...input.forward.history]){
    if(trade.entryContext?.strategyVersion!==MARKET_INTELLIGENCE_VERSION)continue;
    const fresh=makeTrade(next,input.forward,trade,input.paths,input.quotes,input.now),old=byId.get(trade.id);
    const statusChanged=!old||old.status!==fresh.status||old.closedAt!==fresh.closedAt,
      barChanged=!old||old.lastBarAt!==fresh.lastBarAt,
      responseChanged=!old||JSON.stringify(old.response)!==JSON.stringify(fresh.response);
    if(statusChanged||barChanged||responseChanged){
      if(old)next.trades.splice(next.trades.findIndex(x=>x.tradeId===trade.id),1);
      next.trades.push(fresh);byId.set(trade.id,fresh);tradesChanged=true;
    }
  }
  if(tradesChanged)next.trades=trimTrades(next.trades);
  if(marketChanged||tradesChanged)next.updatedAt=input.now;
  return{state:next,marketChanged,tradesChanged,changed:marketChanged||tradesChanged};
}
export function shadowResearchWrites(state:ShadowResearchState,marketChanged=true,tradesChanged=true){
  const entries:Record<string,unknown>={};
  if(marketChanged)entries[SHADOW_MARKET_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.market};
  if(tradesChanged)entries[SHADOW_TRADE_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.trades};
  return entries;
}
export function shadowResearchView(state:ShadowResearchState){
  const closed=state.trades.filter(x=>x.status==="CLOSED"),lost=closed.filter(x=>x.profit.state==="PROFIT_LOST"),
    grossOnly=closed.filter(x=>x.profit.state==="GROSS_ONLY"),late=state.trades.filter(x=>x.response?.tempo==="LATE"),
    immediate=state.trades.filter(x=>x.response?.tempo==="IMMEDIATE"),rotational=state.market.filter(x=>x.label==="ROTATIONAL");
  const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return{version:state.version,updatedAt:state.updatedAt,purpose:"只读影子研究：市场几何、入场位置、响应质量、盈利转化；不参与任何交易决策。",
    summary:{marketSnapshots:state.market.length,rotationalShare:state.market.length?rotational.length/state.market.length:null,
      tradesTracked:state.trades.length,closedTracked:closed.length,profitLostAfterCostCoverage:lost.length,grossOnlyThenClosed:grossOnly.length,
      immediateResponses:immediate.length,lateResponses:late.length,
      averageClosedPeakFavorableRate:avg(closed.map(x=>x.profit.peakFavorableRate)),
      averageClosedCapturedNetVsPeakRatio:avg(closed.map(x=>x.profit.capturedNetVsPeakRatio).filter((x):x is number=>x!==null&&Number.isFinite(x)))},
    marketGeometry:state.market,trades:state.trades};
}
