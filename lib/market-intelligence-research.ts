import { MARKET_INTELLIGENCE_VERSION } from "./market-intelligence-engine.ts";
import { PAPER_COST, type Candle, type ForwardState, type Opportunity, type Quote, type Trade } from "./forward-relations.ts";

export const COUNTERFACTUAL_RESEARCH_VERSION="market-intelligence-counterfactual-v1";
export const POST_EXIT_RESEARCH_KEY="market-intelligence:research:v1:post-exit";
export const REJECTED_RESEARCH_KEY="market-intelligence:research:v1:rejected";
export const RESEARCH_CHECKPOINTS=[5,15,30,60,120,240] as const;
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const MAX_VALUE_BYTES=100*1024;
const MAX_REJECT_ADMISSIONS_PER_CYCLE=2;
const CHECKPOINT_QUOTE_TOLERANCE_MS=90_000;
const CHECKPOINT_CANDLE_LAG_MS=6*60_000;
const CHECKPOINT_UNAVAILABLE_AFTER_MS=7*60_000;

export type ResearchCheckpoint={
  minutes:number;targetAt:number;observedAt:number;marketAt:number;price:number;signedRate:number;netAfterCostRate:number;
  maxFavorableRate:number;maxAdverseRate:number;stopHit:boolean;
};
export type PostExitResearch={
  id:string;tradeId:string;symbol:string;side:"LONG"|"SHORT";openedAt:number;exitAt:number;exitPrice:number;
  exitReason:string|null;actualNetPnl:number|null;actualGrossPnl:number|null;notional:number;peakBeforeExitRate:number;
  startedAt:number;lastObservedAt:number;pathCoverage:"FULL"|"PARTIAL";maxFavorableRate:number;maxAdverseRate:number;checkpoints:ResearchCheckpoint[];
  unavailableCheckpoints:number[];completed:boolean;
};
export type RejectedOpportunityResearch={
  id:string;thesisId:string;symbol:string;side:"LONG"|"SHORT";mode:string;observedAt:number;startedAt:number;entryPrice:number;
  stopRate:number;score:number;eligibleAtObservation:boolean;stage:string|null;dataConfidence:number|null;sourceCount:number|null;
  marketNarrativeId:string|null;marketMajor:string|null;marketShort:string|null;transitionStage:string|null;
  reason:string;executionBlockers:Record<string,number>;blockerScope?:"CANDIDATE";executedTradeId?:string;executedAt?:number;lastObservedAt:number;maxFavorableRate:number;maxAdverseRate:number;
  checkpoints:ResearchCheckpoint[];unavailableCheckpoints:number[];completed:boolean;
};
export type CounterfactualResearchState={
  version:typeof COUNTERFACTUAL_RESEARCH_VERSION;updatedAt:number;postExit:PostExitResearch[];rejected:RejectedOpportunityResearch[];
  sampling?:{admitted:number;notAdmittedAttempts:number;evictedBeforeComplete:number;lastAdmissionAttemptAt:number};
};
type Reader={get<T>(key:string):Promise<T|undefined>};
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const quotePrice=(q:Quote|undefined)=>q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid?(q.bestBid+q.bestAsk)/2:null;
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;

export function initialCounterfactualResearch(now=Date.now()):CounterfactualResearchState{
  return{version:COUNTERFACTUAL_RESEARCH_VERSION,updatedAt:now,postExit:[],rejected:[]};
}
function normalizeCheckpointSet(rows:ResearchCheckpoint[]|undefined,startAt:number){
  const checkpoints:ResearchCheckpoint[]=[],unavailable=new Set<number>();
  for(const raw of rows??[]){
    const minutes=Number(raw?.minutes),expected=startAt+minutes*60_000,marketAt=finite(raw?.marketAt)?raw.marketAt:raw?.observedAt;
    const valid=RESEARCH_CHECKPOINTS.includes(minutes as typeof RESEARCH_CHECKPOINTS[number])&&finite(raw?.targetAt)&&finite(raw?.observedAt)
      &&finite(marketAt)&&finite(raw?.price)&&finite(raw?.signedRate)&&finite(raw?.netAfterCostRate)
      &&finite(raw?.maxFavorableRate)&&finite(raw?.maxAdverseRate)
      &&Math.abs(raw.targetAt-expected)<=1000&&marketAt>=startAt&&marketAt<=raw.targetAt+CHECKPOINT_QUOTE_TOLERANCE_MS;
    if(valid)checkpoints.push({...raw,minutes,marketAt,stopHit:Boolean(raw.stopHit)});
    else if(RESEARCH_CHECKPOINTS.includes(minutes as typeof RESEARCH_CHECKPOINTS[number]))unavailable.add(minutes);
  }
  checkpoints.sort((a,b)=>a.minutes-b.minutes);
  return{checkpoints,unavailable:[...unavailable].filter(m=>!checkpoints.some(p=>p.minutes===m)).sort((a,b)=>a-b)};
}
function mergeUnavailable(raw:unknown,invalid:number[],checkpoints:ResearchCheckpoint[]){
  const values=Array.isArray(raw)?raw.map(Number):[];
  return[...new Set([...values,...invalid].filter(v=>RESEARCH_CHECKPOINTS.includes(v as typeof RESEARCH_CHECKPOINTS[number])
    &&!checkpoints.some(p=>p.minutes===v)))].sort((a,b)=>a-b);
}
function researchCompleted(checkpoints:ResearchCheckpoint[],unavailable:number[]){
  return RESEARCH_CHECKPOINTS.every(minutes=>checkpoints.some(x=>x.minutes===minutes)||unavailable.includes(minutes));
}
function normalizePost(row:PostExitResearch):PostExitResearch|null{
  if(!row||typeof row.id!=="string"||typeof row.tradeId!=="string"||typeof row.symbol!=="string"
    ||(row.side!=="LONG"&&row.side!=="SHORT")||!finite(row.exitAt)||!finite(row.exitPrice)||row.exitPrice<=0)return null;
  const startAt=finite(row.startedAt)?row.startedAt:row.exitAt,normalized=normalizeCheckpointSet(row.checkpoints,startAt),
    unavailable=mergeUnavailable((row as {unavailableCheckpoints?:unknown}).unavailableCheckpoints,normalized.unavailable,normalized.checkpoints),
    inferredCoverage=(row as {pathCoverage?:unknown}).pathCoverage==="FULL"?"FULL"
      :(row as {pathCoverage?:unknown}).pathCoverage==="PARTIAL"?"PARTIAL"
      :normalized.checkpoints.some(p=>p.minutes===5)&&normalized.unavailable.length===0?"FULL":"PARTIAL",
    checkpointFavorable=normalized.checkpoints.reduce((m,p)=>Math.max(m,p.maxFavorableRate),0),
    checkpointAdverse=normalized.checkpoints.reduce((m,p)=>Math.max(m,p.maxAdverseRate),0);
  return{...row,startedAt:startAt,pathCoverage:unavailable.length?"PARTIAL":inferredCoverage,
    checkpoints:normalized.checkpoints,unavailableCheckpoints:unavailable,
    maxFavorableRate:normalized.unavailable.length?checkpointFavorable:Math.max(checkpointFavorable,Math.max(0,Number(row.maxFavorableRate)||0)),
    maxAdverseRate:normalized.unavailable.length?checkpointAdverse:Math.max(checkpointAdverse,Math.max(0,Number(row.maxAdverseRate)||0)),
    completed:researchCompleted(normalized.checkpoints,unavailable)};
}
function normalizeRejected(row:RejectedOpportunityResearch):RejectedOpportunityResearch|null{
  if(!row||typeof row.id!=="string"||typeof row.thesisId!=="string"||typeof row.symbol!=="string"
    ||(row.side!=="LONG"&&row.side!=="SHORT")||!finite(row.observedAt)||!finite(row.entryPrice)||row.entryPrice<=0)return null;
  const startAt=finite(row.startedAt)?row.startedAt:row.observedAt,normalized=normalizeCheckpointSet(row.checkpoints,startAt),
    unavailable=mergeUnavailable((row as {unavailableCheckpoints?:unknown}).unavailableCheckpoints,normalized.unavailable,normalized.checkpoints);
  return{...row,startedAt:startAt,executionBlockers:row.executionBlockers??{},checkpoints:normalized.checkpoints,
    unavailableCheckpoints:unavailable,maxFavorableRate:Math.max(0,Number(row.maxFavorableRate)||0),
    maxAdverseRate:Math.max(0,Number(row.maxAdverseRate)||0),completed:researchCompleted(normalized.checkpoints,unavailable)};
}
export async function readCounterfactualResearch(storage:Reader,now=Date.now()):Promise<CounterfactualResearchState>{
  const [p,r]=await Promise.all([
    storage.get<{version?:string;updatedAt?:number;items?:PostExitResearch[]}>(POST_EXIT_RESEARCH_KEY),
    storage.get<{version?:string;updatedAt?:number;items?:RejectedOpportunityResearch[];sampling?:CounterfactualResearchState["sampling"]}>(REJECTED_RESEARCH_KEY),
  ]);
  return{version:COUNTERFACTUAL_RESEARCH_VERSION,updatedAt:Math.max(Number(p?.updatedAt)||0,Number(r?.updatedAt)||0),
    postExit:(p?.version===COUNTERFACTUAL_RESEARCH_VERSION?p.items??[]:[]).map(normalizePost).filter((x):x is PostExitResearch=>!!x),
    sampling:r?.sampling,rejected:(r?.version===COUNTERFACTUAL_RESEARCH_VERSION?r.items??[]:[]).map(normalizeRejected).filter((x):x is RejectedOpportunityResearch=>!!x)};
}
function pathExtremes(side:"LONG"|"SHORT",startPrice:number,startAt:number,rows:Candle[]|undefined,now:number,currentPrice:number|null){
  const d=dir(side);let favorable=0,adverse=0;
  for(const bar of rows??[]){
    const end=bar.time*1000+300_000;if(bar.time*1000<startAt||end<=startAt||end>now)continue;
    const hi=d>0?bar.high:bar.low,lo=d>0?bar.low:bar.high,
      fav=d*(hi/startPrice-1),adv=-d*(lo/startPrice-1);
    favorable=Math.max(favorable,fav);adverse=Math.max(adverse,adv);
  }
  if(currentPrice&&currentPrice>0){const signed=d*(currentPrice/startPrice-1);favorable=Math.max(favorable,signed);adverse=Math.max(adverse,-signed);}
  return{favorable:Math.max(0,favorable),adverse:Math.max(0,adverse)};
}
function checkpointSnapshot(side:"LONG"|"SHORT",startPrice:number,startAt:number,targetAt:number,rows:Candle[]|undefined,q:Quote|undefined){
  const eligible=(rows??[]).filter(bar=>{const end=bar.time*1000+300_000;return end>startAt&&end<=targetAt;}),
    last=eligible.at(-1),lastAt=last?last.time*1000+300_000:null,
    quoteAt=q&&q.fresh&&finite(q.observedAt)?q.observedAt:null,
    quoteNear=quoteAt!==null&&Math.abs(quoteAt-targetAt)<=CHECKPOINT_QUOTE_TOLERANCE_MS,
    candleNear=lastAt!==null&&targetAt-lastAt<=CHECKPOINT_CANDLE_LAG_MS;
  if(!quoteNear&&!candleNear)return null;
  const price=quoteNear?quotePrice(q)!:last!.close,marketAt=quoteNear?quoteAt!:lastAt!,
    ext=pathExtremes(side,startPrice,startAt,eligible,targetAt,quoteNear?price:null),signed=dir(side)*(price/startPrice-1);
  return{marketAt,price,signed,maxFavorableRate:ext.favorable,maxAdverseRate:ext.adverse};
}
function updateCheckpoints<T extends {side:"LONG"|"SHORT";startedAt:number;lastObservedAt:number;maxFavorableRate:number;maxAdverseRate:number;
  checkpoints:ResearchCheckpoint[];unavailableCheckpoints:number[];completed:boolean}>(row:T,startPrice:number,stopRate:number,now:number,rows:Candle[]|undefined,q:Quote|undefined){
  const current=q&&q.observedAt<=now&&now-q.observedAt<=10_000?quotePrice(q):null,ext=pathExtremes(row.side,startPrice,row.startedAt,rows,now,current);
  row.maxFavorableRate=Math.max(row.maxFavorableRate,ext.favorable);row.maxAdverseRate=Math.max(row.maxAdverseRate,ext.adverse);
  row.lastObservedAt=now;let changed=false;
  for(const minutes of RESEARCH_CHECKPOINTS){
    const targetAt=row.startedAt+minutes*60_000;
    if(now<targetAt||row.checkpoints.some(x=>x.minutes===minutes)||row.unavailableCheckpoints.includes(minutes))continue;
    const snap=checkpointSnapshot(row.side,startPrice,row.startedAt,targetAt,rows,q);
    if(snap){
      row.checkpoints.push({minutes,targetAt,observedAt:now,marketAt:snap.marketAt,price:snap.price,signedRate:snap.signed,
        netAfterCostRate:snap.signed-ROUND_TRIP_COST,maxFavorableRate:snap.maxFavorableRate,maxAdverseRate:snap.maxAdverseRate,
        stopHit:snap.maxAdverseRate>=stopRate});
      changed=true;
    }else if(now>=targetAt+CHECKPOINT_UNAVAILABLE_AFTER_MS){
      row.unavailableCheckpoints.push(minutes);if("pathCoverage" in row)row.pathCoverage="PARTIAL";changed=true;
    }
  }
  row.checkpoints.sort((a,b)=>a.minutes-b.minutes);row.unavailableCheckpoints=[...new Set(row.unavailableCheckpoints)].sort((a,b)=>a-b);
  row.completed=researchCompleted(row.checkpoints,row.unavailableCheckpoints);
  return changed;
}
function postFromTrade(t:Trade,now:number):PostExitResearch|null{
  if(t.status!=="CLOSED"||!t.closedAt||!t.exitPrice||t.exitPrice<=0||t.exitReason==="ACCOUNT_RESET")return null;
  if(t.entryContext?.strategyVersion!==MARKET_INTELLIGENCE_VERSION)return null;
  const pathCoverage=now-t.closedAt<=CHECKPOINT_UNAVAILABLE_AFTER_MS?"FULL":"PARTIAL";
  return{id:`post:${t.id}`,tradeId:t.id,symbol:t.symbol,side:t.side,openedAt:t.openedAt,exitAt:t.closedAt,exitPrice:t.exitPrice,
    exitReason:t.exitReason,actualNetPnl:t.netPnl,actualGrossPnl:t.grossPnl,notional:t.notional,peakBeforeExitRate:t.favorable,
    startedAt:t.closedAt,lastObservedAt:t.closedAt,pathCoverage,maxFavorableRate:0,maxAdverseRate:0,checkpoints:[],
    unavailableCheckpoints:[],completed:false};
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
  const n=s.extremumRegime.narrative,validation=s.entryValidations[o.id];
  const ownBlocker=(validation?.reason??(!o.eligible?rejectionClass(o):"NOT_SELECTED_REASON_UNRECORDED")).slice(0,96);
  return{id:`reject:${o.thesisId}`,thesisId:o.thesisId,symbol:o.symbol,side:o.side,mode:o.mode,observedAt:now,startedAt:now,entryPrice,
    stopRate:o.stopRate,score:o.score,eligibleAtObservation:o.eligible,stage:o.confirmationStage??null,dataConfidence:o.dataConfidence??null,
    sourceCount:o.sourceCount??null,marketNarrativeId:n.id??null,marketMajor:n.major.bias??null,marketShort:n.short.bias??null,
    transitionStage:n.transition.stage??null,reason:`${rejectionClass(o)} | ${o.reason}`.slice(0,220),executionBlockers:{[ownBlocker]:1},blockerScope:"CANDIDATE",
    lastObservedAt:now,maxFavorableRate:0,maxAdverseRate:0,checkpoints:[],unavailableCheckpoints:[],completed:false};
}
function trimForStorage<T extends {completed:boolean;lastObservedAt:number}>(items:T[]){
  const out=[...items].sort((a,b)=>b.lastObservedAt-a.lastObservedAt).slice(0,220);
  while(out.length>1&&bytes({version:COUNTERFACTUAL_RESEARCH_VERSION,items:out})>MAX_VALUE_BYTES){
    const idx=[...out].reverse().findIndex(x=>x.completed),actual=idx<0?out.length-1:out.length-1-idx;out.splice(actual,1);
  }
  return out;
}
export function advanceCounterfactualResearch(input:{state:CounterfactualResearchState;forward:ForwardState;now:number;
  paths:Record<string,Candle[]>;quotes:Record<string,Quote>;observeCandidates:boolean}){
  const next:CounterfactualResearchState=structuredClone(input.state);let postChanged=false,rejectedChanged=false;
  const postIds=new Set(next.postExit.map(x=>x.tradeId));
  for(const t of input.forward.history){
    if(postIds.has(t.id))continue;const row=postFromTrade(t,input.now);
    if(row){next.postExit.unshift(row);postIds.add(t.id);postChanged=true;}
  }
  if(input.observeCandidates){
    const ids=new Set(next.rejected.map(x=>x.thesisId));
    const sampling=next.sampling??{admitted:0,notAdmittedAttempts:0,evictedBeforeComplete:0,lastAdmissionAttemptAt:0};
    const reserved=(rows:RejectedOpportunityResearch[])=>bytes(rows)+rows.reduce((n,r)=>
      n+Math.max(0,RESEARCH_CHECKPOINTS.length-r.checkpoints.length-r.unavailableCheckpoints.length)*380,0);
    const candidates=input.forward.opportunities.filter(o=>!ids.has(o.thesisId??""))
      .sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score)
      .slice(0,MAX_REJECT_ADMISSIONS_PER_CYCLE);
    for(const o of candidates){
      const row=rejectedFromOpportunity(o,input.quotes[o.symbol],input.forward,input.now);if(!row)continue;
      // The rejected-shadow store is a bounded sample, not a mirror of every 2s candidate. Keep the best few new
      // theses from each cycle and reserve their whole 5–60m path before admission so diagnostics never starve itself.
      while(reserved([...next.rejected,row])>MAX_VALUE_BYTES-4096&&next.rejected.some(x=>x.completed)){
        const at=next.rejected.map(x=>x.completed).lastIndexOf(true);next.rejected.splice(at,1);rejectedChanged=true;
      }
      sampling.lastAdmissionAttemptAt=input.now;
      if(reserved([...next.rejected,row])>MAX_VALUE_BYTES-4096){sampling.notAdmittedAttempts++;continue;}
      next.rejected.unshift(row);ids.add(row.thesisId);sampling.admitted++;rejectedChanged=true;
    }
    next.sampling=sampling;
  }
  const executed=new Map([...input.forward.positions,...input.forward.history].map(t=>[t.entryContext?.thesisId,t]));
  for(const row of next.rejected){const trade=executed.get(row.thesisId);if(trade&&!row.executedTradeId){row.executedTradeId=trade.id;row.executedAt=trade.openedAt;rejectedChanged=true;}}
  for(const row of next.postExit.filter(x=>!x.completed))
    if(updateCheckpoints(row,row.exitPrice,Infinity,input.now,input.paths[row.symbol],input.quotes[row.symbol]))postChanged=true;
  for(const row of next.rejected.filter(x=>!x.completed))
    if(updateCheckpoints(row,row.entryPrice,row.stopRate,input.now,input.paths[row.symbol],input.quotes[row.symbol]))rejectedChanged=true;
  const priorRejected=next.rejected;
  next.postExit=trimForStorage(next.postExit);next.rejected=trimForStorage(next.rejected);
  const retainedIds=new Set(next.rejected.map(r=>r.id));
  const evicted=priorRejected.filter(r=>!r.completed&&!retainedIds.has(r.id)).length;
  if(evicted){next.sampling=next.sampling??{admitted:0,notAdmittedAttempts:0,evictedBeforeComplete:0,lastAdmissionAttemptAt:input.now};
    next.sampling.evictedBeforeComplete+=evicted;rejectedChanged=true;}
  if(postChanged||rejectedChanged)next.updatedAt=input.now;
  return{state:next,postChanged,rejectedChanged,changed:postChanged||rejectedChanged};
}
export function counterfactualResearchWrites(state:CounterfactualResearchState,postChanged=true,rejectedChanged=true){
  const entries:Record<string,unknown>={};
  if(postChanged)entries[POST_EXIT_RESEARCH_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.postExit};
  if(rejectedChanged)entries[REJECTED_RESEARCH_KEY]={version:state.version,updatedAt:state.updatedAt,items:state.rejected,sampling:state.sampling};
  return entries;
}
export function counterfactualResearchView(state:CounterfactualResearchState){
  const postComplete=state.postExit.filter(x=>x.completed),rejectComplete=state.rejected.filter(x=>x.completed),
    post60=state.postExit.flatMap(x=>x.checkpoints.filter(p=>p.minutes===60)),
    reject60=state.rejected.flatMap(x=>x.checkpoints.filter(p=>p.minutes===60)),
    exitRegret60=post60.map(p=>p.maxFavorableRate),savedLoss60=post60.map(p=>p.maxAdverseRate),
    rejectedWin60=reject60.map(p=>p.netAfterCostRate),
    postUnavailable60=state.postExit.filter(x=>x.unavailableCheckpoints.includes(60)).length,
    rejectUnavailable60=state.rejected.filter(x=>x.unavailableCheckpoints.includes(60)).length;
  const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return{version:state.version,updatedAt:state.updatedAt,sampling:state.sampling??null,checkpoints:[...RESEARCH_CHECKPOINTS],
    summary:{postExitTracked:state.postExit.length,postExitCompleted:postComplete.length,rejectedTracked:state.rejected.length,rejectedCompleted:rejectComplete.length,
      postExitFullCoverage:state.postExit.filter(x=>x.pathCoverage==="FULL").length,
      postExitPartialCoverage:state.postExit.filter(x=>x.pathCoverage==="PARTIAL").length,
      postExitValid60m:post60.length,postExitUnavailable60m:postUnavailable60,rejectedValid60m:reject60.length,
      rejectedUnavailable60m:rejectUnavailable60,averagePostExitExtraFavorable60m:avg(exitRegret60),
      averagePostExitAdverse60m:avg(savedLoss60),
      rejectedPositiveAfterCost60m:rejectedWin60.length?rejectedWin60.filter(x=>x>0).length/rejectedWin60.length:null},
    postExit:state.postExit,rejectedOpportunities:state.rejected};
}
