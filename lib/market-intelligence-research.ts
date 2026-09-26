import { MARKET_INTELLIGENCE_VERSION } from "./market-intelligence-engine.ts";
import { PAPER_COST, type Candle, type ForwardState, type Opportunity, type Quote, type Trade } from "./forward-relations.ts";

export const COUNTERFACTUAL_RESEARCH_VERSION="market-intelligence-counterfactual-v1";
export const POST_EXIT_RESEARCH_KEY="market-intelligence:research:v1:post-exit";
export const REJECTED_RESEARCH_KEY="market-intelligence:research:v1:rejected";
export const RESEARCH_CHECKPOINTS=[5,15,30,60,120,240] as const;
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const MAX_VALUE_BYTES=100*1024;

export type ResearchCheckpoint={
  minutes:number;targetAt:number;observedAt:number;marketAt:number;price:number;signedRate:number;netAfterCostRate:number;
  maxFavorableRate:number;maxAdverseRate:number;stopHit:boolean;
};
export type PostExitResearch={
  id:string;tradeId:string;symbol:string;side:"LONG"|"SHORT";openedAt:number;exitAt:number;exitPrice:number;
  exitReason:string|null;actualNetPnl:number|null;actualGrossPnl:number|null;notional:number;peakBeforeExitRate:number;
  startedAt:number;lastObservedAt:number;maxFavorableRate:number;maxAdverseRate:number;checkpoints:ResearchCheckpoint[];
  completed:boolean;
};
export type RejectedOpportunityResearch={
  id:string;thesisId:string;symbol:string;side:"LONG"|"SHORT";mode:string;observedAt:number;startedAt:number;entryPrice:number;
  stopRate:number;score:number;eligibleAtObservation:boolean;stage:string|null;dataConfidence:number|null;sourceCount:number|null;
  marketNarrativeId:string|null;marketMajor:string|null;marketShort:string|null;transitionStage:string|null;
  reason:string;executionBlockers:Record<string,number>;lastObservedAt:number;maxFavorableRate:number;maxAdverseRate:number;
  checkpoints:ResearchCheckpoint[];completed:boolean;
};
export type CounterfactualResearchState={
  version:typeof COUNTERFACTUAL_RESEARCH_VERSION;updatedAt:number;postExit:PostExitResearch[];rejected:RejectedOpportunityResearch[];
};
type Reader={get<T>(key:string):Promise<T|undefined>};
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const quotePrice=(q:Quote|undefined)=>q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid?(q.bestBid+q.bestAsk)/2:null;
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;

export function initialCounterfactualResearch(now=Date.now()):CounterfactualResearchState{
  return{version:COUNTERFACTUAL_RESEARCH_VERSION,updatedAt:now,postExit:[],rejected:[]};
}
function normalizePoint(row:ResearchCheckpoint):ResearchCheckpoint|null{
  return row&&RESEARCH_CHECKPOINTS.includes(row.minutes as typeof RESEARCH_CHECKPOINTS[number])&&finite(row.targetAt)&&finite(row.observedAt)
    &&finite(row.price)&&finite(row.signedRate)&&finite(row.netAfterCostRate)&&finite(row.maxFavorableRate)&&finite(row.maxAdverseRate)
    ?{...row,marketAt:finite(row.marketAt)?row.marketAt:row.observedAt,stopHit:Boolean(row.stopHit)}:null;
}
function normalizePost(row:PostExitResearch):PostExitResearch|null{
  if(!row||typeof row.id!=="string"||typeof row.tradeId!=="string"||typeof row.symbol!=="string"
    ||(row.side!=="LONG"&&row.side!=="SHORT")||!finite(row.exitAt)||!finite(row.exitPrice)||row.exitPrice<=0)return null;
  return{...row,checkpoints:(row.checkpoints??[]).map(normalizePoint).filter((x):x is ResearchCheckpoint=>!!x),
    maxFavorableRate:Math.max(0,Number(row.maxFavorableRate)||0),maxAdverseRate:Math.max(0,Number(row.maxAdverseRate)||0),completed:Boolean(row.completed)};
}
function normalizeRejected(row:RejectedOpportunityResearch):RejectedOpportunityResearch|null{
  if(!row||typeof row.id!=="string"||typeof row.thesisId!=="string"||typeof row.symbol!=="string"
    ||(row.side!=="LONG"&&row.side!=="SHORT")||!finite(row.observedAt)||!finite(row.entryPrice)||row.entryPrice<=0)return null;
  return{...row,startedAt:finite(row.startedAt)?row.startedAt:row.observedAt,executionBlockers:row.executionBlockers??{},checkpoints:(row.checkpoints??[]).map(normalizePoint).filter((x):x is ResearchCheckpoint=>!!x),
    maxFavorableRate:Math.max(0,Number(row.maxFavorableRate)||0),maxAdverseRate:Math.max(0,Number(row.maxAdverseRate)||0),completed:Boolean(row.completed)};
}
export async function readCounterfactualResearch(storage:Reader,now=Date.now()):Promise<CounterfactualResearchState>{
  const [p,r]=await Promise.all([
    storage.get<{version?:string;updatedAt?:number;items?:PostExitResearch[]}>(POST_EXIT_RESEARCH_KEY),
    storage.get<{version?:string;updatedAt?:number;items?:RejectedOpportunityResearch[]}>(REJECTED_RESEARCH_KEY),
  ]);
  return{version:COUNTERFACTUAL_RESEARCH_VERSION,updatedAt:Math.max(Number(p?.updatedAt)||0,Number(r?.updatedAt)||0,now),
    postExit:(p?.version===COUNTERFACTUAL_RESEARCH_VERSION?p.items??[]:[]).map(normalizePost).filter((x):x is PostExitResearch=>!!x),
    rejected:(r?.version===COUNTERFACTUAL_RESEARCH_VERSION?r.items??[]:[]).map(normalizeRejected).filter((x):x is RejectedOpportunityResearch=>!!x)};
}
function pathExtremes(side:"LONG"|"SHORT",startPrice:number,startAt:number,rows:Candle[]|undefined,now:number,currentPrice:number|null){
  const d=dir(side);let favorable=0,adverse=0;
  for(const bar of rows??[]){
    const end=bar.time*1000+300_000;if(end<=startAt||end>now)continue;
    const hi=d>0?bar.high:bar.low,lo=d>0?bar.low:bar.high,
      fav=d*(hi/startPrice-1),adv=-d*(lo/startPrice-1);
    favorable=Math.max(favorable,fav);adverse=Math.max(adverse,adv);
  }
  if(currentPrice&&currentPrice>0){const signed=d*(currentPrice/startPrice-1);favorable=Math.max(favorable,signed);adverse=Math.max(adverse,-signed);}
  return{favorable:Math.max(0,favorable),adverse:Math.max(0,adverse)};
}
function checkpointSnapshot(side:"LONG"|"SHORT",startPrice:number,startAt:number,targetAt:number,rows:Candle[]|undefined,
  fallbackPrice:number|null,observedAt:number){
  const eligible=(rows??[]).filter(bar=>{const end=bar.time*1000+300_000;return end>startAt&&end<=targetAt;}),
    last=eligible.at(-1),price=last?.close??fallbackPrice??startPrice,marketAt=last?last.time*1000+300_000:observedAt,
    ext=pathExtremes(side,startPrice,startAt,eligible,targetAt,null),signed=dir(side)*(price/startPrice-1);
  return{marketAt,price,signed,maxFavorableRate:ext.favorable,maxAdverseRate:ext.adverse};
}
function updateCheckpoints<T extends {side:"LONG"|"SHORT";startedAt:number;lastObservedAt:number;maxFavorableRate:number;maxAdverseRate:number;
  checkpoints:ResearchCheckpoint[];completed:boolean}>(row:T,startPrice:number,stopRate:number,now:number,rows:Candle[]|undefined,q:Quote|undefined){
  const current=quotePrice(q),ext=pathExtremes(row.side,startPrice,row.startedAt,rows,now,current);
  row.maxFavorableRate=Math.max(row.maxFavorableRate,ext.favorable);row.maxAdverseRate=Math.max(row.maxAdverseRate,ext.adverse);
  row.lastObservedAt=now;let checkpointAdded=false;
  for(const minutes of RESEARCH_CHECKPOINTS){
    const targetAt=row.startedAt+minutes*60_000;if(now<targetAt||row.checkpoints.some(x=>x.minutes===minutes))continue;
    const snap=checkpointSnapshot(row.side,startPrice,row.startedAt,targetAt,rows,current,now);
    row.checkpoints.push({minutes,targetAt,observedAt:now,marketAt:snap.marketAt,price:snap.price,signedRate:snap.signed,
      netAfterCostRate:snap.signed-ROUND_TRIP_COST,maxFavorableRate:snap.maxFavorableRate,maxAdverseRate:snap.maxAdverseRate,
      stopHit:snap.maxAdverseRate>=stopRate});
    checkpointAdded=true;
  }
  row.checkpoints.sort((a,b)=>a.minutes-b.minutes);row.completed=row.checkpoints.some(x=>x.minutes===240);
  return checkpointAdded;
}
function postFromTrade(t:Trade):PostExitResearch|null{
  if(t.status!=="CLOSED"||!t.closedAt||!t.exitPrice||t.exitPrice<=0||t.exitReason==="ACCOUNT_RESET")return null;
  if(t.entryContext?.strategyVersion!==MARKET_INTELLIGENCE_VERSION)return null;
  return{id:`post:${t.id}`,tradeId:t.id,symbol:t.symbol,side:t.side,openedAt:t.openedAt,exitAt:t.closedAt,exitPrice:t.exitPrice,
    exitReason:t.exitReason,actualNetPnl:t.netPnl,actualGrossPnl:t.grossPnl,notional:t.notional,peakBeforeExitRate:t.favorable,
    startedAt:t.closedAt,lastObservedAt:t.closedAt,maxFavorableRate:0,maxAdverseRate:0,checkpoints:[],completed:false};
}
function rejectionClass(o:Opportunity){
  if(o.eligible)return"EXECUTABLE_NOT_SELECTED";
  if(o.confirmationStage!=="READY")return"FILTERED_NOT_MATURE";
  if((o.dataConfidence??0)<65)return"FILTERED_DATA_CONFIDENCE";
  if((o.sourceCount??0)<2)return"FILTERED_SOURCE_COVERAGE";
  if(o.edgeRatio<1.30)return"FILTERED_EDGE";
  return"FILTERED_STRATEGY_GATE";
}
function rejectedFromOpportunity(o:Opportunity,q:Quote|undefined,s:ForwardState,now:number):RejectedOpportunityResearch|null{
  if(o.strategyVersion!==MARKET_INTELLIGENCE_VERSION||!o.thesisId||o.expiresAt<=now)return null;
  if(o.score<70||(o.sourceCount??0)<2||(o.dataConfidence??0)<55)return null;
  if(s.positions.some(t=>t.entryContext?.thesisId===o.thesisId)||s.history.some(t=>t.entryContext?.thesisId===o.thesisId))return null;
  const mid=quotePrice(q),entryPrice=mid??o.price;if(!(entryPrice>0))return null;
  const n=s.extremumRegime.narrative;
  return{id:`reject:${o.thesisId}`,thesisId:o.thesisId,symbol:o.symbol,side:o.side,mode:o.mode,observedAt:now,startedAt:now,entryPrice,
    stopRate:o.stopRate,score:o.score,eligibleAtObservation:o.eligible,stage:o.confirmationStage??null,dataConfidence:o.dataConfidence??null,
    sourceCount:o.sourceCount??null,marketNarrativeId:n.id??null,marketMajor:n.major.bias??null,marketShort:n.short.bias??null,
    transitionStage:n.transition.stage??null,reason:`${rejectionClass(o)} | ${o.reason}`,executionBlockers:{...s.entryDiagnostics.reasons},
    lastObservedAt:now,maxFavorableRate:0,maxAdverseRate:0,checkpoints:[],completed:false};
}
function trimForStorage<T extends {completed:boolean;lastObservedAt:number}>(items:T[]){
  let out=[...items].sort((a,b)=>b.lastObservedAt-a.lastObservedAt).slice(0,220);
  while(out.length>40&&bytes({version:COUNTERFACTUAL_RESEARCH_VERSION,items:out})>MAX_VALUE_BYTES){
    const idx=[...out].reverse().findIndex(x=>x.completed),actual=idx<0?out.length-1:out.length-1-idx;out.splice(actual,1);
  }
  return out;
}
export function advanceCounterfactualResearch(input:{state:CounterfactualResearchState;forward:ForwardState;now:number;
  paths:Record<string,Candle[]>;quotes:Record<string,Quote>;observeCandidates:boolean}){
  const next:CounterfactualResearchState=structuredClone(input.state);let postChanged=false,rejectedChanged=false;
  const postIds=new Set(next.postExit.map(x=>x.tradeId));
  for(const t of input.forward.history){
    if(postIds.has(t.id))continue;const row=postFromTrade(t);
    if(row){next.postExit.unshift(row);postIds.add(t.id);postChanged=true;}
  }
  if(input.observeCandidates){
    const ids=new Set(next.rejected.map(x=>x.thesisId));
    for(const o of input.forward.opportunities){
      if(ids.has(o.thesisId??""))continue;const row=rejectedFromOpportunity(o,input.quotes[o.symbol],input.forward,input.now);
      if(row){next.rejected.unshift(row);ids.add(row.thesisId);rejectedChanged=true;}
    }
  }
  for(const row of next.postExit.filter(x=>!x.completed))
    if(updateCheckpoints(row,row.exitPrice,Infinity,input.now,input.paths[row.symbol],input.quotes[row.symbol]))postChanged=true;
  for(const row of next.rejected.filter(x=>!x.completed))
    if(updateCheckpoints(row,row.entryPrice,row.stopRate,input.now,input.paths[row.symbol],input.quotes[row.symbol]))rejectedChanged=true;
  next.postExit=trimForStorage(next.postExit);next.rejected=trimForStorage(next.rejected);next.updatedAt=input.now;
  return{state:next,postChanged,rejectedChanged,changed:postChanged||rejectedChanged};
}
export function counterfactualResearchWrites(state:CounterfactualResearchState,postChanged=true,rejectedChanged=true){
  const entries:Record<string,unknown>={};
  if(postChanged)entries[POST_EXIT_RESEARCH_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.postExit};
  if(rejectedChanged)entries[REJECTED_RESEARCH_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.rejected};
  return entries;
}
export function counterfactualResearchView(state:CounterfactualResearchState){
  const postComplete=state.postExit.filter(x=>x.completed),rejectComplete=state.rejected.filter(x=>x.completed),
    exitRegret60=postComplete.flatMap(x=>x.checkpoints.filter(p=>p.minutes===60).map(p=>p.maxFavorableRate)),
    savedLoss60=postComplete.flatMap(x=>x.checkpoints.filter(p=>p.minutes===60).map(p=>p.maxAdverseRate)),
    rejectedWin60=rejectComplete.flatMap(x=>x.checkpoints.filter(p=>p.minutes===60).map(p=>p.netAfterCostRate));
  const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return{version:state.version,updatedAt:state.updatedAt,checkpoints:[...RESEARCH_CHECKPOINTS],
    summary:{postExitTracked:state.postExit.length,postExitCompleted:postComplete.length,rejectedTracked:state.rejected.length,rejectedCompleted:rejectComplete.length,
      averagePostExitExtraFavorable60m:avg(exitRegret60),averagePostExitAdverse60m:avg(savedLoss60),
      rejectedPositiveAfterCost60m:rejectedWin60.length?rejectedWin60.filter(x=>x>0).length/rejectedWin60.length:null},
    postExit:state.postExit,rejectedOpportunities:state.rejected};
}
