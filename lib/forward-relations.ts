import { FORWARD_RELATION_V2_VERSION, advanceRelationEngine, initialRelationEngine, relationCandidates,
  type RelationCandidate, type RelationEngineState, type RelationStatus } from "./forward-relation-v2.ts";

/**
 * Forward Relation 2.0 — PAPER authority.
 *
 * Mature 15/60/180-minute market responses create directional relations.
 * Six causal reaction checkpoints can reduce stale relation authority early,
 * while the opposite side must earn independent mature evidence.
 * Region/1m logic remains execution enhancement, not directional authority.
 */
export const FORWARD_VERSION="forward-relations-v1.0";
export const ADAPTIVE_ENGINE_VERSION=FORWARD_RELATION_V2_VERSION;
export const ADAPTIVE_TARGET_POSITIONS=10;
export const ADAPTIVE_REALTIME_POSITION_CAP=11;
export const BAR_MS=300_000;
export const FEATURES=["5分钟方向","路径效率","剩余空间","位置质量","回调风险","1分钟确认","区域质量","入场后反馈"] as const;
export const PAPER_COST={feeRate:.0007,slippageRate:.00025,fundingAllowancePerDay:.0002,
  assumption:"双边吃单费各7bp＋滑点各2.5bp＋每日2bp不利资金费占位"};
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const TOTAL_RISK_RATE=.10,SIDE_RISK_RATE=.065,TOTAL_MARGIN_RATE=.75;
const ROTATION_GAP=10,ROTATION_COOLDOWN_MS=2*60_000;
const HISTORY_LIMIT=240,EVENT_LIMIT=160;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(v:number[])=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const quantile=(v:number[],p:number)=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.floor((a.length-1)*p))]:0;};
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const dayKey=(now:number)=>new Date(now+7*3600_000).toISOString().slice(0,10);
const safe=(v:number|null|undefined,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;

export type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type Quote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};
export type Contract={quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts?:number;
  enableDecimal?:boolean;orderSizeMin?:string|number;orderSizeMax?:string|number;marketOrderSizeMax?:string|number};

export type Condition={feature:number;op:"GE"|"LE";threshold:number};
export type Rule={id:string;signature:string;parentId:string|null;version:number;createdAt:number;expiresAt:number;
  status:"EXPERIMENTAL"|"DORMANT";conditions:Condition[];side:"LONG"|"SHORT";horizon:number;stopRate:number;
  armRate:number;givebackRate:number;exitMode:"HORIZON"|"REACTION_DECAY";samples:number;trainGroups:number;checkGroups:number;
  estimatedNetRate:number;priorResponse:number|null;recentResponse:number;standardError:number;reason:string;
  mutation:"CREATE"|"REVISE"|"RECALL";grammar:string;liveEligible:false;authority?:"ADAPTIVE_TEN"|"FORWARD_RELATION";turnTimeframe?:"5m"};

export type OpportunityMode="RELATION"|"BREAKOUT"|"RETEST"|"FAILED_BREAKOUT"|"RANGE";
export type RegionState="IN_REGION"|"ABOVE"|"BELOW";
export type Region={
  id:string;symbol:string;confirmedAt:number;lower:number;upper:number;center:number;widthRate:number;bars:number;
  quality:number;state:RegionState;lastSeenAt:number;
};
export type Opportunity={
  id:string;symbol:string;side:"LONG"|"SHORT";mode:OpportunityMode;premium:boolean;reserve?:boolean;score:number;eligible:boolean;
  completedAt:number;expiresAt:number;price:number;stopPrice:number;targetPrice:number;stopRate:number;targetRate:number;directionStrength:number;
  pathEfficiency:number;momentumPersistence:number;positionScore:number;spaceScore:number;executionScore:number;
  grossRemainingSpaceRate:number;netRemainingSpaceRate:number;pullbackRiskRate:number;edgeRatio:number;
  expectedHoldMinutes:number;marketFit:number;regionId:string|null;regionQuality:number|null;reason:string;
  relationRuleId?:string;relationStatus?:RelationStatus;relationHorizon?:15|60|180;relationHealth?:number;riskScale?:number;
};
export type SampleMemory={count:number;emaNetRate:number;emaMfeRate:number;emaMaeRate:number;updatedAt:number};
export type MarketPulse={at:number;up:number;down:number;neutral:number;bias:"UP"|"DOWN"|"MIXED";strength:number;expansion:number};

export type EntryContext={
  version:"adaptive-ten-entry-v1";capturedAt:number;timeframe:"5m";side:"LONG"|"SHORT";mode:OpportunityMode;reserve?:boolean;
  reason:string;entryScore:number;directionStrength:number;spaceScore:number;positionScore:number;executionScore:number;
  remainingSpaceRate:number;pullbackRiskRate:number;edgeRatio:number;expectedHoldMinutes:number;marketFit:number;
  regionId:string|null;regionLower?:number;regionUpper?:number;regionCenter?:number;
  relationRuleId?:string;relationStatus?:RelationStatus;relationHorizon?:15|60|180;relationHealth?:number;
};
export type Trade={
  id:string;symbol:string;side:"LONG"|"SHORT";rule:Rule;openedAt:number;closedAt:number|null;status:"OPEN"|"CLOSED";
  entryPrice:number;exitPrice:number|null;quantity:number;contracts:number;quantoMultiplier:number;notional:number;
  leverage:number;margin:number;plannedRisk:number;stopPrice:number;armPrice:number;favorable:number;adverse:number;
  lastPrice:number;lastQuoteAt:number;entryFee:number;exitFee:number;fundingAllowance:number;grossPnl:number|null;netPnl:number|null;
  exitReason:string|null;relationFailureBars:number;lastRelationBar:number;execution:"REAL_QUOTE_PAPER_MODEL";liveEligible:false;
  entryContext?:EntryContext;forecast?:{remainingNetRate:number;quality:number;sizingEquity:number};
  firstProfitAt?:number|null;holdScore?:number;profitFloorRate?:number;expectedHoldMinutes?:number;peakPnlRate?:number;
  exitControl?:{policy:string;armedAt:number|null;armedQuoteAt:number|null;maxObservationGapMs:number;maxQuoteAgeMs:number};
  profitProtection?:{version:string;reachedR:number;lockedR:number;floorRate:number;retentionRate:number;activationRate:number;
    checkpointBand:number;mode:"STRONG_TREND"|"HEALTHY_TREND"|"NORMAL"|"WEAKENING";peakR:number;updatedAt:number};
  profitProtectionMigration?:{version:string;state:"CURRENT"|"GUARDED"|"DEFERRED";updatedAt:number;baselineFavorable:number};
  exitAudit?:{trigger:string;at:number;detail?:string};
  holdValue?:{action:"HOLD"|"EXIT_PROFIT"|"EXIT_RISK";pullbackRiskRate:number;bestHoldMinutes:number;score:number};
  turn?:{version:string;timeframe:"5m";signalAt:number;entryTurnProbability:number;entryContinuation:number;entryDirectionConfidence:number};
};

export type AuditEvent={id:string;at:number;kind:"START"|"ENTRY"|"EXIT"|"PROTECTION"|"ROTATION"|"DATA";
  subject:string;reason:string;detail?:Record<string,string|number|null>};
export type Daily={day:string;firstAt:number;lastAt:number;startEquity:number;endEquity:number;exactBoundary:boolean};
export type ForwardState={
  version:string;engineVersion:string;startedAt:number;revision:number;lastCycleAt:number;lastQuoteCycleAt:number;lastCandleAt:number;
  balance:number;initialEquity:number;peakEquity:number;maxDrawdown:number;resolved:number;wins:number;grossPnl:number;fees:number;
  fundingAllowance:number;turnover:number;positions:Trade[];history:Trade[];events:AuditEvent[];daily:Daily[];
  selectedSymbols:string[];opportunities:Opportunity[];regions:Record<string,Region>;sampleMemory:Record<string,SampleMemory>;relationEngine:RelationEngineState;
  marketPulse:MarketPulse;lastEntryAt:Record<string,number>;lastExitAt:Record<string,number>;lastSide:Record<string,"LONG"|"SHORT">;
  lastRotationAt:number;latestReason:string;entryDiagnostics:{at:number;matched:number;opened:number;reasons:Record<string,number>};
  storage:{persistedAt:number;error:string|null};liveEligible:false;policyVersion:string;strategyAuthorityVersion:string;
  executionVersion:string;regionVersion:string;regionLaunchVersion:string;cutoverAt:number;
  // Compatibility-only aliases consumed by older UI/readers; no old module has authority.
  observations:number;measured:number;invalidated:number;frames:Record<string,never>;pending:Record<string,never>;
  samples:unknown[];rules:Rule[];lastBars:Record<string,number>;lastEntryBars:Record<string,number>;
  fitDiagnostics:{tested:number;qualified:number;trainGroups:number;checkGroups:number;latestAt:number;rapidQualified:number;activeLong:number;activeShort:number};
};

export function freshQuote(q:Quote|undefined,now:number,maxAge=10_000){
  return !!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=maxAge;
}
function midpoint(q:Quote){return(q.bestBid+q.bestAsk)/2;}
function event(s:ForwardState,now:number,kind:AuditEvent["kind"],subject:string,reason:string,detail?:AuditEvent["detail"]){
  s.revision++;s.events.unshift({id:`a${s.startedAt}-${s.revision}`,at:now,kind,subject,reason,...(detail?{detail}:{})});
  s.events=s.events.slice(0,EVENT_LIMIT);
}
function blankPulse(now:number):MarketPulse{return{at:now,up:0,down:0,neutral:0,bias:"MIXED",strength:0,expansion:0};}
export function initialForward(now:number):ForwardState{
  const s:ForwardState={version:FORWARD_VERSION,engineVersion:ADAPTIVE_ENGINE_VERSION,startedAt:now,revision:0,lastCycleAt:0,lastQuoteCycleAt:0,lastCandleAt:0,
    balance:1000,initialEquity:1000,peakEquity:1000,maxDrawdown:0,resolved:0,wins:0,grossPnl:0,fees:0,fundingAllowance:0,turnover:0,
    positions:[],history:[],events:[],daily:[],selectedSymbols:[],opportunities:[],regions:{},sampleMemory:{},relationEngine:initialRelationEngine(now),marketPulse:blankPulse(now),
    lastEntryAt:{},lastExitAt:{},lastSide:{},lastRotationAt:0,latestReason:"Forward Relation 2.0 已启动：正在积累真实市场反应；成熟关系负责方向，5m/1m只优化执行。",
    entryDiagnostics:{at:now,matched:0,opened:0,reasons:{}},storage:{persistedAt:0,error:null},liveEligible:false,
    policyVersion:ADAPTIVE_ENGINE_VERSION,strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,executionVersion:ADAPTIVE_ENGINE_VERSION,
    regionVersion:"adaptive-region-v1",regionLaunchVersion:"adaptive-region-v1",cutoverAt:now,
    observations:0,measured:0,invalidated:0,frames:{},pending:{},samples:[],rules:[],lastBars:{},lastEntryBars:{},
    fitDiagnostics:{tested:0,qualified:0,trainGroups:0,checkGroups:0,latestAt:now,rapidQualified:0,activeLong:0,activeShort:0}};
  event(s,now,"START",ADAPTIVE_ENGINE_VERSION,s.latestReason);return s;
}
export const initialMultiTurnForward=initialForward;

function normalizeRule(t:Partial<Trade>,now:number):Rule{
  const r=t.rule as Partial<Rule>|undefined,side=t.side==="SHORT"?"SHORT":"LONG";
  return{id:r?.id??`adaptive-${t.symbol??"unknown"}`,signature:r?.signature??"adaptive-ten",parentId:null,version:1,
    createdAt:safe(r?.createdAt,now),expiresAt:safe(r?.expiresAt,now+60*60_000),status:"EXPERIMENTAL",conditions:r?.conditions??[],
    side,horizon:Math.max(10,safe(r?.horizon,60)),stopRate:Math.max(.001,safe(r?.stopRate,.01)),armRate:Math.max(.001,safe(r?.armRate,.005)),
    givebackRate:Math.max(.001,safe(r?.givebackRate,.002)),exitMode:"REACTION_DECAY",samples:safe(r?.samples),trainGroups:safe(r?.trainGroups),
    checkGroups:safe(r?.checkGroups),estimatedNetRate:safe(r?.estimatedNetRate),priorResponse:r?.priorResponse??null,
    recentResponse:safe(r?.recentResponse),standardError:safe(r?.standardError),reason:r?.reason??"兼容持仓",
    mutation:"CREATE",grammar:ADAPTIVE_ENGINE_VERSION,liveEligible:false,authority:r?.authority==="FORWARD_RELATION"?"FORWARD_RELATION":"ADAPTIVE_TEN",turnTimeframe:"5m"};
}
function normalizeTrade(raw:Trade,now:number):Trade{
  const t=structuredClone(raw) as Trade,tick=Math.max(1e-9,safe(t.entryPrice,1)),side=t.side==="SHORT"?"SHORT":"LONG";
  t.side=side;t.rule=normalizeRule(t,now);t.status=t.status==="CLOSED"?"CLOSED":"OPEN";
  t.openedAt=safe(t.openedAt,now);t.closedAt=t.status==="CLOSED"?safe(t.closedAt,now):null;
  t.entryPrice=tick;t.lastPrice=Math.max(1e-9,safe(t.lastPrice,t.entryPrice));t.lastQuoteAt=safe(t.lastQuoteAt,t.openedAt);
  t.stopPrice=Math.max(1e-9,safe(t.stopPrice,side==="LONG"?t.entryPrice*.99:t.entryPrice*1.01));
  t.armPrice=Math.max(1e-9,safe(t.armPrice,side==="LONG"?t.entryPrice*1.01:t.entryPrice*.99));
  t.quantoMultiplier=Math.max(1e-12,safe(t.quantoMultiplier,1));t.contracts=Math.max(1,safe(t.contracts,1));
  t.quantity=Math.max(1e-12,safe(t.quantity,t.contracts*t.quantoMultiplier));
  t.notional=Math.max(1e-9,safe(t.notional,t.quantity*t.entryPrice));t.leverage=Math.max(1,safe(t.leverage,8));
  t.margin=Math.max(1e-9,safe(t.margin,t.notional/t.leverage));t.plannedRisk=Math.max(0,safe(t.plannedRisk,t.notional*.01));
  t.favorable=Math.max(0,safe(t.favorable));t.adverse=Math.max(0,safe(t.adverse));t.entryFee=Math.max(0,safe(t.entryFee,t.notional*PAPER_COST.feeRate));
  t.exitFee=Math.max(0,safe(t.exitFee));t.fundingAllowance=Math.max(0,safe(t.fundingAllowance));t.grossPnl=t.grossPnl??null;t.netPnl=t.netPnl??null;
  t.exitReason=t.exitReason??null;t.relationFailureBars=Math.max(0,Math.floor(safe(t.relationFailureBars)));t.lastRelationBar=safe(t.lastRelationBar,t.openedAt);
  t.execution="REAL_QUOTE_PAPER_MODEL";t.liveEligible=false;t.firstProfitAt=t.firstProfitAt??null;t.holdScore=safe(t.holdScore,50);
  t.profitFloorRate=Math.max(0,safe(t.profitFloorRate));t.expectedHoldMinutes=Math.max(5,safe(t.expectedHoldMinutes,t.entryContext?.expectedHoldMinutes??30));
  t.peakPnlRate=Math.max(0,safe(t.peakPnlRate,t.favorable));return t;
}
export function normalizeForward(v:ForwardState|null|undefined,now:number):ForwardState{
  if(!v)return initialForward(now);
  if(v.version!==FORWARD_VERSION||!Number.isFinite(v.balance)||!Array.isArray(v.positions)||!Array.isArray(v.history)||v.liveEligible!==false)
    throw new Error("前向账户存储格式异常；保留原数据，禁止自动重置");
  const base=initialForward(v.startedAt>0?v.startedAt:now);
  const old=v as ForwardState&Record<string,unknown>;
  const upgrading=v.engineVersion!==ADAPTIVE_ENGINE_VERSION||v.strategyAuthorityVersion!==ADAPTIVE_ENGINE_VERSION
    ||v.executionVersion!==ADAPTIVE_ENGINE_VERSION;
  return{...base,
    startedAt:safe(v.startedAt,base.startedAt),revision:Math.max(0,Math.floor(safe(v.revision))),lastCycleAt:safe(v.lastCycleAt),lastQuoteCycleAt:safe(v.lastQuoteCycleAt),
    lastCandleAt:safe(v.lastCandleAt,safe(v.lastCycleAt)),balance:safe(v.balance,1000),initialEquity:safe(v.initialEquity,1000),
    peakEquity:Math.max(safe(v.peakEquity,1000),safe(v.balance,1000)),maxDrawdown:Math.max(0,safe(v.maxDrawdown)),
    resolved:Math.max(0,Math.floor(safe(v.resolved))),wins:Math.max(0,Math.floor(safe(v.wins))),grossPnl:safe(v.grossPnl),
    fees:Math.max(0,safe(v.fees)),fundingAllowance:Math.max(0,safe(v.fundingAllowance)),turnover:Math.max(0,safe(v.turnover)),
    positions:v.positions.map(t=>normalizeTrade(t,now)),history:v.history.map(t=>normalizeTrade(t,now)).slice(0,HISTORY_LIMIT),
    events:Array.isArray(v.events)?v.events.slice(0,EVENT_LIMIT):base.events,daily:Array.isArray(v.daily)?v.daily:[],
    selectedSymbols:Array.isArray(v.selectedSymbols)?v.selectedSymbols:[],opportunities:upgrading?[]:(Array.isArray(v.opportunities)?v.opportunities:[]),
    regions:v.regions&&typeof v.regions==="object"?v.regions:{},sampleMemory:v.sampleMemory&&typeof v.sampleMemory==="object"?v.sampleMemory:{},
    relationEngine:!upgrading&&v.relationEngine?.version===FORWARD_RELATION_V2_VERSION?v.relationEngine:initialRelationEngine(now),
    marketPulse:v.marketPulse?.bias? v.marketPulse:blankPulse(now),lastEntryAt:v.lastEntryAt??{},lastExitAt:v.lastExitAt??{},lastSide:v.lastSide??{},
    lastRotationAt:safe(v.lastRotationAt),latestReason:typeof v.latestReason==="string"?v.latestReason:base.latestReason,
    entryDiagnostics:v.entryDiagnostics??base.entryDiagnostics,storage:v.storage??base.storage,
    engineVersion:ADAPTIVE_ENGINE_VERSION,policyVersion:ADAPTIVE_ENGINE_VERSION,strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,
    executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:"adaptive-region-v1",regionLaunchVersion:"adaptive-region-v1",
    cutoverAt:upgrading?now:safe(v.cutoverAt,now),observations:safe(v.observations),measured:safe(v.measured),invalidated:safe(v.invalidated),
    frames:{},pending:{},samples:[],rules:[],lastBars:{},lastEntryBars:{},fitDiagnostics:v.fitDiagnostics??base.fitDiagnostics,
    ...(old.storage?{storage:v.storage}:{}),
  };
}

function validPath(rows:Candle[],now:number){
  const a=rows.filter(r=>r.time>0&&r.open>0&&r.close>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)
    &&r.low>0&&r.volume>=0&&r.time*1000+BAR_MS<=now).sort((x,y)=>x.time-y.time);
  if(a.length<30)return null;
  const tail=a.slice(-120);for(let i=1;i<tail.length;i++)if(tail[i]!.time-tail[i-1]!.time!==300)return null;
  return tail;
}
function pathStats(rows:Candle[]){
  const last=rows.at(-1)!,ranges=rows.slice(-20).map(r=>(r.high-r.low)/r.close),bodies=rows.slice(-20).map(r=>Math.abs(r.close/r.open-1));
  const atr=Math.max(.00045,median(ranges)),body=Math.max(.0002,median(bodies));
  const ret=(n:number)=>last.close/rows[Math.max(0,rows.length-1-n)]!.close-1;
  return{last,atr,body,ret3:ret(3),ret6:ret(6),ret12:ret(12)};
}
function detectRegion(symbol:string,rows:Candle[],now:number):Region|null{
  const {atr}=pathStats(rows);let best:Region|null=null;
  for(const bars of[6,8,10,12]){
    const w=rows.slice(-(bars+1),-1);if(w.length!==bars)continue;
    const lower=Math.min(...w.map(r=>r.low)),upper=Math.max(...w.map(r=>r.high)),center=(upper+lower)/2,widthRate=(upper-lower)/center;
    const maxWidth=Math.max(.004,Math.min(.028,atr*3.4));if(widthRate>maxWidth)continue;
    let crossings=0,prev=0,touches=0;
    for(const r of w){const s=r.close>center?1:r.close<center?-1:0;if(s&&prev&&s!==prev)crossings++;if(s)prev=s;
      if(r.low<=center&&r.high>=center)touches++;}
    if(crossings<2&&touches<Math.ceil(bars*.45))continue;
    const compact=1-clip(widthRate/maxWidth),quality=100*clip(.45*compact+.35*Math.min(1,crossings/4)+.20*Math.min(1,touches/bars));
    const price=rows.at(-1)!.close,state:RegionState=price>upper?"ABOVE":price<lower?"BELOW":"IN_REGION";
    const r:Region={id:`rg-${symbol}-${w[0]!.time}`,symbol,confirmedAt:(w.at(-1)!.time+300)*1000,lower,upper,center,widthRate,bars,quality,state,lastSeenAt:now};
    if(!best||r.quality>best.quality)best=r;
  }
  return best;
}
function maxCounterMove(rows:Candle[],side:"LONG"|"SHORT"){
  if(rows.length<2)return 0;let extreme=rows[0]!.close,worst=0;
  for(const r of rows.slice(1)){if(side==="LONG"){extreme=Math.max(extreme,r.high);worst=Math.max(worst,(extreme-r.low)/extreme);}
    else{extreme=Math.min(extreme,r.low);worst=Math.max(worst,(r.high-extreme)/extreme);}}
  return worst;
}
function historicalLeg(rows:Candle[],side:"LONG"|"SHORT",atr:number){
  const d=dir(side),samples:number[]=[];for(const n of[4,6,8,12])for(let i=n;i<rows.length-1;i++){
    const m=d*(rows[i]!.close/rows[i-n]!.close-1);if(m>atr*.7)samples.push(m);
  }
  return Math.max(atr*2.2,samples.length>=8?quantile(samples,.65):atr*2.8);
}
function structuralSpace(rows:Candle[],side:"LONG"|"SHORT",price:number,atr:number){
  const prior=rows.slice(0,-1),gap=Math.max(.0005,atr*.18);
  if(side==="LONG"){const levels=prior.map(r=>r.high).filter(x=>x>price*(1+gap)).sort((a,b)=>a-b);return levels[0]?levels[0]/price-1:null;}
  const levels=prior.map(r=>r.low).filter(x=>x<price*(1-gap)).sort((a,b)=>b-a);return levels[0]?1-levels[0]/price:null;
}
function executionScore(q:Quote|undefined,now:number){
  if(!q)return 58;if(!freshQuote(q,now))return 10;const mid=midpoint(q),spread=(q.bestAsk-q.bestBid)/mid;
  return 100*(1-.65*clip(spread/.0018));
}
function marketPulse(paths:Record<string,Candle[]>,now:number):MarketPulse{
  const rows=Object.values(paths).flatMap(p=>{const v=validPath(p,now);if(!v)return[];const s=pathStats(v),move=.6*s.ret3+.4*s.ret6;
    return[{move,expansion:clip(s.atr/Math.max(.0005,median(v.slice(-40,-20).map(r=>(r.high-r.low)/r.close)))-1,0,2)}];});
  const up=rows.filter(r=>r.move>.001).length,down=rows.filter(r=>r.move<-.001).length,neutral=Math.max(0,rows.length-up-down);
  const signed=rows.length?(up-down)/rows.length:0;
  return{at:now,up,down,neutral,bias:signed>.20?"UP":signed<-.20?"DOWN":"MIXED",strength:Math.abs(signed),expansion:rows.length?median(rows.map(r=>r.expansion)):0};
}
function sampleAdjustment(s:ForwardState,mode:OpportunityMode,side:"LONG"|"SHORT",pulse:MarketPulse){
  const key=`${mode}:${pulse.bias}:${side}`,m=s.sampleMemory[key];if(!m||m.count<2)return 0;
  return clip(m.emaNetRate/.003,-1,1)*4;
}
function minuteConfirm(minute:Candle[]|undefined,side:"LONG"|"SHORT",level:number,now:number){
  if(!minute?.length)return{ok:false,score:0,kind:"NONE" as const};
  const a=minute.filter(r=>r.time*1000+60_000<=now).slice(-8);if(a.length<3)return{ok:false,score:0,kind:"NONE" as const};
  const d=dir(side),ranges=a.map(r=>(r.high-r.low)/r.close),avg=Math.max(.0002,median(ranges));
  const last=a.at(-1)!,prev=a.at(-2)!,lastMove=d*(last.close/prev.close-1),outside=d*(last.close/level-1)>0;
  const strong=d*(prev.close/prev.open-1)>avg*1.6&&d*(prev.close/level-1)>0;
  const continuation=strong&&outside&&lastMove>-avg*.35;
  const priorExtreme=side==="LONG"?Math.min(...a.slice(-4,-1).map(r=>r.low)):Math.max(...a.slice(-4,-1).map(r=>r.high));
  const restart=outside&&lastMove>avg*.35&&(side==="LONG"?last.close>Math.max(prev.high,priorExtreme):last.close<Math.min(prev.low,priorExtreme));
  const twoBars=outside&&d*(last.close/last.open-1)>avg*.7&&d*(prev.close/prev.open-1)>avg*.7;
  const ok=continuation||restart||twoBars;return{ok,score:ok?90:40,kind:restart?"RESTART" as const:twoBars?"TWO_BAR" as const:"CONTINUE" as const};
}
function relationOpportunity(c:RelationCandidate,rows:Candle[],q:Quote|undefined,now:number):Opportunity{
  const framePrice=rows.at(-1)!.close,d=dir(c.side),exec=executionScore(q,now),net=Math.max(.0002,c.netRate),gross=Math.max(net+ROUND_TRIP_COST,c.grossRate),
    pullback=Math.max(.003,c.stopRate),edge=net/Math.max(pullback,1e-9),score=clip(c.score*.90+exec*.10,0,100);
  return{id:`relation-${c.ruleId}-${c.symbol}-${rows.at(-1)!.time}`,symbol:c.symbol,side:c.side,mode:"RELATION",premium:false,reserve:c.reserve,
    score,eligible:c.health>=.15&&net>0,completedAt:(rows.at(-1)!.time+300)*1000,expiresAt:now+12*60_000,price:framePrice,
    stopPrice:framePrice*(1-d*pullback),targetPrice:framePrice*(1+d*Math.max(.003,gross)),stopRate:pullback,targetRate:Math.max(.003,gross),
    directionStrength:c.health*100,pathEfficiency:c.livePathScore*100,momentumPersistence:c.environmentFit*100,positionScore:75,
    spaceScore:100*clip(edge/1.5),executionScore:exec,grossRemainingSpaceRate:gross,netRemainingSpaceRate:net,pullbackRiskRate:pullback,
    edgeRatio:edge,expectedHoldMinutes:c.horizon,marketFit:c.environmentFit*100,regionId:null,regionQuality:null,reason:c.reason,
    relationRuleId:c.ruleId,relationStatus:c.status,relationHorizon:c.horizon,relationHealth:c.health,riskScale:clip(c.health,.25,1)};
}
function regionOpportunities(s:ForwardState,symbol:string,rows:Candle[],minute:Candle[]|undefined,q:Quote|undefined,now:number,pulse:MarketPulse,region:Region){
  const out:Opportunity[]=[],st=pathStats(rows),last=st.last,prev=rows.at(-2)!,price=last.close,exec=executionScore(q,now);
  const avgBody=Math.max(st.body,.0002),body=Math.abs(last.close/last.open-1),closePos=(last.close-last.low)/Math.max(last.high-last.low,1e-9);
  const buffer=Math.max(st.atr*.12,.00045),add=(side:"LONG"|"SHORT",mode:OpportunityMode,baseScore:number,stop:number,target:number,reason:string,premium=true)=>{
    const d=dir(side),gross=Math.max(0,d*(target/price-1)),net=Math.max(0,gross-ROUND_TRIP_COST),pullback=Math.max(.0035,Math.abs(price-stop)/price);
    const edge=net/Math.max(pullback,1e-9),fit=pulse.bias==="MIXED"?60:pulse.bias===(side==="LONG"?"UP":"DOWN")?85:40;
    const score=clip(baseScore+.08*exec+.06*fit+sampleAdjustment(s,mode,side,pulse),0,100);
    const stopRate=Math.abs(price-stop)/price,targetRate=Math.abs(target/price-1);
    out.push({id:`${mode.toLowerCase()}-${symbol}-${last.time}`,symbol,side,mode,premium,score,
      eligible:score>=58&&net>0&&edge>=.5,completedAt:(last.time+300)*1000,expiresAt:now+(premium?6:10)*60_000,price,stopPrice:stop,targetPrice:target,stopRate,targetRate,
      directionStrength:Math.min(100,baseScore+5),pathEfficiency:region.quality,momentumPersistence:baseScore,positionScore:80,spaceScore:100*clip(edge/2),
      executionScore:exec,grossRemainingSpaceRate:gross,netRemainingSpaceRate:net,pullbackRiskRate:pullback,edgeRatio:edge,
      expectedHoldMinutes:mode==="RANGE"?12:mode==="BREAKOUT"?18:22,marketFit:fit,regionId:region.id,regionQuality:region.quality,reason});
  };
  const upBreak=last.close>region.upper*(1+buffer)&&body>avgBody*1.35&&closePos>.68;
  const dnBreak=last.close<region.lower*(1-buffer)&&body>avgBody*1.35&&closePos<.32;
  if(upBreak){const m=minuteConfirm(minute,"LONG",region.upper,now);if(m.ok||body>avgBody*2.6)
    add("LONG","BREAKOUT",72+m.score*.10,region.lower*(1-buffer),price*(1+Math.max(region.widthRate*1.2,st.atr*2.2)),`成熟区上破｜5m实体${(body/avgBody).toFixed(1)}×｜1m确认${m.ok?"通过":"极强提前"}`);}
  if(dnBreak){const m=minuteConfirm(minute,"SHORT",region.lower,now);if(m.ok||body>avgBody*2.6)
    add("SHORT","BREAKOUT",72+m.score*.10,region.upper*(1+buffer),price*(1-Math.max(region.widthRate*1.2,st.atr*2.2)),`成熟区下破｜5m实体${(body/avgBody).toFixed(1)}×｜1m确认${m.ok?"通过":"极强提前"}`);}
  const prevProbeUp=prev.high>region.upper*(1+buffer)&&prev.close<=region.upper,prevProbeDn=prev.low<region.lower*(1-buffer)&&prev.close>=region.lower;
  if(prevProbeUp&&last.close<region.center)add("SHORT","FAILED_BREAKOUT",70,Math.max(prev.high,region.upper)*(1+buffer),region.lower,
    "向上假突破重新被区域接受，反向做空",true);
  if(prevProbeDn&&last.close>region.center)add("LONG","FAILED_BREAKOUT",70,Math.min(prev.low,region.lower)*(1-buffer),region.upper,
    "向下假突破重新被区域接受，反向做多",true);
  const nearUpper=Math.abs(price/region.upper-1)<=Math.max(st.atr*.45,.001),nearLower=Math.abs(price/region.lower-1)<=Math.max(st.atr*.45,.001);
  if(region.state==="ABOVE"&&nearUpper){const m=minuteConfirm(minute,"LONG",region.upper,now);if(m.ok)
    add("LONG","RETEST",74,region.center,price*(1+Math.max(region.widthRate,st.atr*2)),"离区后回踩上沿结束，1m重新启动",true);}
  if(region.state==="BELOW"&&nearLower){const m=minuteConfirm(minute,"SHORT",region.lower,now);if(m.ok)
    add("SHORT","RETEST",74,region.center,price*(1-Math.max(region.widthRate,st.atr*2)),"离区后回踩下沿结束，1m重新启动",true);}
  if(region.state==="IN_REGION"&&region.quality>=50){
    if(nearLower&&last.close>last.open)add("LONG","RANGE",57,region.lower*(1-buffer),region.center,"成熟区下沿重新出现买方控制，做中心回归",false);
    if(nearUpper&&last.close<last.open)add("SHORT","RANGE",57,region.upper*(1+buffer),region.center,"成熟区上沿重新出现卖方控制，做中心回归",false);
  }
  return out;
}
function buildOpportunities(s:ForwardState,paths:Record<string,Candle[]>,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,now:number,allowed?:ReadonlySet<string>){
  const pulse=marketPulse(paths,now),all:Opportunity[]=[],regions:Record<string,Region>={},bySymbol=new Map<string,RelationCandidate[]>();
  for(const c of relationCandidates(s.relationEngine)){if(allowed&&!allowed.has(c.symbol))continue;const a=bySymbol.get(c.symbol)??[];a.push(c);bySymbol.set(c.symbol,a);}
  for(const[symbol,path]of Object.entries(paths)){if(allowed&&!allowed.has(symbol))continue;const rows=validPath(path,now);if(!rows)continue;
    const region=detectRegion(symbol,rows,now);if(region){regions[symbol]=region;all.push(...regionOpportunities(s,symbol,rows,minutePaths?.[symbol],quotes[symbol],now,pulse,region));}
    for(const c of bySymbol.get(symbol)??[])all.push(relationOpportunity(c,rows,quotes[symbol],now));
  }
  const best=[...new Map(all.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.premium)-Number(a.premium)
    ||Number(!b.reserve)-Number(!a.reserve)||b.score-a.score).map(x=>[x.symbol,x] as const)).values()]
    .sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.premium)-Number(a.premium)||Number(!b.reserve)-Number(!a.reserve)||b.score-a.score);
  return{pulse,regions,opportunities:best};
}
function equityMark(s:ForwardState,quotes:Record<string,Quote>,now:number){
  let floating=0,stale=0;for(const t of s.positions){const q=quotes[t.symbol],px=freshQuote(q,now)?midpoint(q):t.lastPrice;if(!freshQuote(q,now))stale++;
    floating+=dir(t.side)*t.quantity*(px-t.entryPrice)-t.quantity*px*PAPER_COST.feeRate;}
  return{equity:s.balance+floating,floating,stalePositions:stale};
}
export function forwardEquity(s:ForwardState,quotes:Record<string,Quote>,now:number){return equityMark(s,quotes,now);}
function updateDaily(s:ForwardState,now:number,equity:number){
  const key=dayKey(now),row=s.daily.at(-1);if(!row||row.day!==key)s.daily.push({day:key,firstAt:now,lastAt:now,startEquity:equity,endEquity:equity,exactBoundary:false});
  else{row.lastAt=now;row.endEquity=equity;}s.daily=s.daily.slice(-45);
}
function closeTrade(s:ForwardState,t:Trade,price:number,now:number,reason:string){
  const gross=dir(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*PAPER_COST.feeRate;
  const funding=t.notional*PAPER_COST.fundingAllowancePerDay*Math.max(0,now-t.openedAt)/86_400_000,net=gross-t.entryFee-exitFee-funding;
  t.status="CLOSED";t.closedAt=now;t.exitPrice=price;t.exitFee=exitFee;t.fundingAllowance=funding;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;
  t.exitAudit={trigger:reason,at:now};s.balance+=gross-exitFee-funding;s.grossPnl+=gross;s.fees+=exitFee;s.fundingAllowance+=funding;
  s.resolved++;if(net>0)s.wins++;s.turnover+=t.notional;t.lastQuoteAt=now;t.lastPrice=price;s.lastExitAt[t.symbol]=now;
  const key=`${t.entryContext?.mode??"FLOW"}:${s.marketPulse.bias}:${t.side}`,prior=s.sampleMemory[key],alpha=prior?Math.max(.08,.35/Math.sqrt(prior.count+1)):.35;
  const netRate=net/Math.max(t.notional,1e-9),mfe=t.favorable,mae=t.adverse;
  s.sampleMemory[key]={count:(prior?.count??0)+1,emaNetRate:(prior?.emaNetRate??0)*(1-alpha)+netRate*alpha,
    emaMfeRate:(prior?.emaMfeRate??0)*(1-alpha)+mfe*alpha,emaMaeRate:(prior?.emaMaeRate??0)*(1-alpha)+mae*alpha,updatedAt:now};
  s.history.unshift(t);s.history=s.history.slice(0,HISTORY_LIMIT);event(s,now,"EXIT",t.id,`${t.symbol} ${reason} ${net>=0?"+":""}${net.toFixed(2)}U`);
}
function protectionFloor(t:Trade){
  const stopRate=Math.abs(t.entryPrice-(t.entryContext?.side==="SHORT"?Math.max(t.stopPrice,t.entryPrice):Math.min(t.stopPrice,t.entryPrice)))/t.entryPrice;
  const original=Math.max(.003,t.entryContext?.pullbackRiskRate??stopRate),r=t.favorable/original;
  const retention=r>=4?.75:r>=2?.80:r>=1?.72:r>=.5?.50:0;
  return t.favorable*retention;
}
function markAndManage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const candidates=new Map(s.opportunities.map(o=>[o.symbol,o])),relationById=new Map(s.relationEngine.rules.map(r=>[r.id,r])),closed=new Set<string>();
  for(const t of s.positions){const q=quotes[t.symbol];if(!freshQuote(q,now))continue;const px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;const favorable=Math.max(0,d*(px/t.entryPrice-1)),adverse=Math.max(0,-d*(px/t.entryPrice-1));
    t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    if(!t.firstProfitAt&&favorable>=ROUND_TRIP_COST*.6)t.firstProfitAt=now;
    const relation=t.entryContext?.relationRuleId?relationById.get(t.entryContext.relationRuleId):undefined;
    const relationFloor=relation&&relation.status!=="ACTIVE"&&t.favorable>ROUND_TRIP_COST
      ?t.favorable*(relation.status==="DEGRADED"?.82:relation.status==="PRESSURED"?.70:.75):0;
    const floor=Math.max(protectionFloor(t),relationFloor);if(floor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){t.profitFloorRate=floor;
      const next=t.entryPrice*(1+d*floor);if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){t.stopPrice=next;
        event(s,now,"PROTECTION",t.id,`利润保护提升至约${(floor*100).toFixed(2)}%`);}}
    const current=candidates.get(t.symbol),same=current&&current.side===t.side?current:null,opp=current&&current.side!==t.side?current:null;
    const ageMin=(now-t.openedAt)/60_000,feedback=t.firstProfitAt?Math.min(20,10+Math.max(0,10-(t.firstProfitAt-t.openedAt)/60_000*2)):ageMin>6?-12:0;
    const pnlSignal=favorable>adverse?8:-Math.min(18,adverse/Math.max(.002,t.entryContext?.pullbackRiskRate??.01)*8);
    const relationPenalty=relation?.status==="DEGRADED"?20:relation?.status==="PRESSURED"?10:relation?.status==="RECOVERING"?4:0;
    t.holdScore=clip((same?.score??42)*.65+feedback+pnlSignal-relationPenalty,0,100);
    t.holdValue={action:t.holdScore<30?"EXIT_RISK":"HOLD",pullbackRiskRate:t.entryContext?.pullbackRiskRate??.01,bestHoldMinutes:t.expectedHoldMinutes??30,score:t.holdScore};
    const stopped=t.side==="LONG"?px<=t.stopPrice:px>=t.stopPrice;
    const marketFlip=!!opp&&!opp.reserve&&opp.eligible&&opp.score>=66&&opp.score>(same?.score??0)+8;
    const expected=t.expectedHoldMinutes??30,timeFailure=ageMin>=Math.max(8,expected*.65)&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST;
    const hardTime=ageMin>=expected*2.5&&favorable<Math.max(.003,t.adverse*.5);
    const relationFailure=relation?.status==="DEGRADED"&&ageMin>=Math.max(5,expected*.20)&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST;
    if(stopped||marketFlip||relationFailure||timeFailure||hardTime){closeTrade(s,t,px,now,stopped?(t.profitFloorRate??0)>0?"PROFIT_GIVEBACK":"STRUCTURE_STOP":
      marketFlip?"MARKET_FLIP":relationFailure?"RELATION_DEGRADED":timeFailure?"NO_POSITIVE_FEEDBACK":"TIME_DECAY");closed.add(t.id);}
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}
function candidateRiskRate(o:Opportunity){const base=o.reserve?.004:o.mode==="RANGE"?.006:o.premium?.009:.008;return base*clip(o.riskScale??1,.25,1);}
function existingRisk(s:ForwardState,side?:"LONG"|"SHORT"){return s.positions.filter(t=>!side||t.side===side).reduce((n,t)=>n+t.plannedRisk,0);}
function openTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number){
  const side=o.side,d=dir(side),price=side==="LONG"?q.bestAsk:q.bestBid;
  // Analysis can come from Bybit/OKX/Binance. Only relative structure may cross
  // venues; all executable prices are re-anchored to the actual Gate quote.
  const stopRate=Number.isFinite(o.stopRate)?o.stopRate:Math.abs(o.price-o.stopPrice)/Math.max(o.price,1e-9);
  const targetRate=Number.isFinite(o.targetRate)?o.targetRate:Math.abs(o.targetPrice/o.price-1);
  if(!(stopRate>=.002&&stopRate<=.03))return"结构止损宽度不合理";
  const headroom=Math.min(equity*TOTAL_RISK_RATE-existingRisk(s),equity*SIDE_RISK_RATE-existingRisk(s,side));
  const wantedRisk=equity*candidateRiskRate(o);if(headroom<=equity*.001)return"组合风险已满";
  const riskBudget=Math.min(wantedRisk,headroom),rawNotional=riskBudget/(stopRate+ROUND_TRIP_COST);
  const notionalCap=equity*(o.premium?.70:.60),targetNotional=Math.min(rawNotional,notionalCap);
  const leverage=Math.max(1,Math.min(10,Math.floor(contract.leverageMax||10))),mult=Math.max(contract.quantoMultiplier,1e-12);
  const minContracts=Math.max(1,Math.ceil(contract.minContracts??(Number(contract.orderSizeMin??1)||1)));
  const contracts=Math.floor(targetNotional/(price*mult));if(contracts<minContracts)return"低于最小模拟合约数量";
  const quantity=contracts*mult,notional=quantity*price,margin=notional/leverage,totalMargin=s.positions.reduce((n,t)=>n+t.margin,0);
  if(totalMargin+margin>equity*TOTAL_MARGIN_RATE)return"组合保证金已满";
  const plannedRisk=notional*(stopRate+ROUND_TRIP_COST),entryFee=notional*PAPER_COST.feeRate;
  const stopPrice=price*(1-d*stopRate),target=price*(1+d*Math.max(.003,targetRate));
  const horizon=Math.max(20,Math.round(o.expectedHoldMinutes)),id=`ft-${now.toString(36)}-${o.symbol.replace(/[^A-Z0-9]/g,"")}-${side[0]}-${o.mode[0]}`;
  const rule:Rule={id:o.relationRuleId??`adaptive-${o.mode.toLowerCase()}`,signature:o.relationRuleId??o.mode,parentId:null,version:1,createdAt:now,expiresAt:now+horizon*60_000,
    status:"EXPERIMENTAL",conditions:[],side,horizon,stopRate,armRate:Math.max(.003,o.netRemainingSpaceRate*.45),givebackRate:.002,
    exitMode:"REACTION_DECAY",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:o.netRemainingSpaceRate,priorResponse:null,
    recentResponse:0,standardError:0,reason:o.reason,mutation:"CREATE",grammar:ADAPTIVE_ENGINE_VERSION,liveEligible:false,authority:o.mode==="RELATION"?"FORWARD_RELATION":"ADAPTIVE_TEN",turnTimeframe:"5m"};
  const region=o.regionId?s.regions[o.symbol]:null;
  const scale=o.price>0?price/o.price:1;
  const t:Trade={id,symbol:o.symbol,side,rule,openedAt:now,closedAt:null,status:"OPEN",entryPrice:price,exitPrice:null,quantity,contracts,
    quantoMultiplier:mult,notional,leverage,margin,plannedRisk,stopPrice,armPrice:target,favorable:0,adverse:0,lastPrice:price,
    lastQuoteAt:q.observedAt,entryFee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,firstProfitAt:null,holdScore:o.score,profitFloorRate:0,expectedHoldMinutes:o.expectedHoldMinutes,
    peakPnlRate:0,exitControl:{policy:ADAPTIVE_ENGINE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},entryContext:{version:"adaptive-ten-entry-v1",capturedAt:now,timeframe:"5m",side,mode:o.mode,reserve:o.reserve===true,reason:o.reason,entryScore:o.score,
      directionStrength:o.directionStrength,spaceScore:o.spaceScore,positionScore:o.positionScore,executionScore:o.executionScore,
      remainingSpaceRate:o.netRemainingSpaceRate,pullbackRiskRate:o.pullbackRiskRate,edgeRatio:o.edgeRatio,expectedHoldMinutes:o.expectedHoldMinutes,
      marketFit:o.marketFit,regionId:o.regionId,relationRuleId:o.relationRuleId,relationStatus:o.relationStatus,relationHorizon:o.relationHorizon,relationHealth:o.relationHealth,
      ...(region?{regionLower:region.lower*scale,regionUpper:region.upper*scale,regionCenter:region.center*scale}:{})},
    forecast:{remainingNetRate:o.netRemainingSpaceRate,quality:o.score/100,sizingEquity:equity}};
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;
  event(s,now,"ENTRY",id,`${o.symbol} ${side} ${o.mode} 评分${o.score.toFixed(0)}`,{notional,plannedRisk});
  return null;
}
function rankedEligible(s:ForwardState,now:number){
  return s.opportunities.filter(o=>o.eligible&&o.expiresAt>now&&!s.positions.some(t=>t.symbol===o.symbol))
    .sort((a,b)=>Number(b.premium)-Number(a.premium)||b.score-a.score);
}
function rotateIfNeeded(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,equity:number){
  if(s.positions.length<ADAPTIVE_TARGET_POSITIONS||now-s.lastRotationAt<ROTATION_COOLDOWN_MS)return false;
  const candidate=rankedEligible(s,now).find(o=>!o.reserve);if(!candidate)return false;
  const weak=[...s.positions].sort((a,b)=>(a.holdScore??50)-(b.holdScore??50))[0];if(!weak)return false;
  const weakScore=weak.holdScore??50;if(candidate.score<weakScore+ROTATION_GAP)return false;
  const qOld=quotes[weak.symbol],qNew=quotes[candidate.symbol],meta=contracts[candidate.symbol];
  if(!freshQuote(qOld,now)||!freshQuote(qNew,now)||qNew!.entryReady!==true||!meta)return false;
  closeTrade(s,weak,weak.side==="LONG"?qOld!.bestBid:qOld!.bestAsk,now,"OPPORTUNITY_REPLACED");s.positions=s.positions.filter(t=>t.id!==weak.id);
  const err=openTrade(s,candidate,qNew!,meta,now,equity);if(err)return false;
  s.lastRotationAt=now;event(s,now,"ROTATION",candidate.symbol,`${weak.symbol} → ${candidate.symbol}，优势差${(candidate.score-weakScore).toFixed(0)}分`);
  return true;
}
function fillSeats(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,equity:number){
  const eligible=rankedEligible(s,now);
  // This is a current-state blocker view, not a retry counter. One candidate can
  // contribute at most once per execution pass, so the UI can never show
  // hundreds of fake "failures" from the same waiting opportunity.
  s.entryDiagnostics={at:now,matched:eligible.length,opened:0,reasons:{}};
  let opened=0;const reject=(reason:string)=>{s.entryDiagnostics.reasons[reason]=(s.entryDiagnostics.reasons[reason]??0)+1;};
  for(const o of eligible){
    const cap=o.premium?ADAPTIVE_REALTIME_POSITION_CAP:ADAPTIVE_TARGET_POSITIONS;if(s.positions.length>=cap)continue;
    if(opened>=3)break;const q=quotes[o.symbol],meta=contracts[o.symbol];if(!freshQuote(q,now)||q!.entryReady!==true){reject("等待实时盘口");continue;}
    if(!meta){reject("等待合约规格");continue;}
    const last=s.lastExitAt[o.symbol]??0,lastSide=s.lastSide[o.symbol];
    const cooldown=lastSide&&lastSide!==o.side?2*60_000:8*60_000;if(now-last<cooldown){reject("同币短时防抖");continue;}
    const error=openTrade(s,o,q!,meta,now,equity);if(error){reject(error);continue;}opened++;
  }
  s.entryDiagnostics.opened=opened;return opened;
}
function nextCandleAt(paths:Record<string,Candle[]>,now:number){
  let latest=0;for(const p of Object.values(paths)){const a=validPath(p,now);if(a)latest=Math.max(latest,(a.at(-1)!.time+300)*1000);}return latest;
}
export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;minutePaths?:Record<string,Candle[]>;daily?:Record<string,Candle[]>;
  quotes:Record<string,Quote>;contracts:Record<string,Contract>;entrySymbols?:Iterable<string>;allowDataCycle?:boolean;legacyDrainOnly?:boolean}){
  const s=normalizeForward(structuredClone(input.state),input.now),before=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice]),h:s.history.length,b:s.balance,r:s.revision});
  const allowed=input.entrySymbols?new Set(input.entrySymbols):undefined;s.lastQuoteCycleAt=input.now;
  const candleAt=nextCandleAt(input.paths,input.now),dataDue=input.allowDataCycle!==false&&candleAt>s.lastCandleAt;
  if(dataDue){
    s.relationEngine=advanceRelationEngine({state:s.relationEngine,paths:input.paths,now:input.now});
    s.observations=s.relationEngine.observations;s.measured=s.relationEngine.measured;s.invalidated=s.relationEngine.invalidated;
  }
  markAndManage(s,input.quotes,input.now);
  if(dataDue){
    const built=buildOpportunities(s,input.paths,input.minutePaths,input.quotes,input.now,allowed);s.marketPulse=built.pulse;s.regions=built.regions;
    s.opportunities=built.opportunities;s.lastCandleAt=candleAt;s.lastCycleAt=input.now;
    s.selectedSymbols=[...new Set([...Object.keys(s.relationEngine.frames),...Object.keys(built.regions),...built.opportunities.map(o=>o.symbol)])].slice(0,30);
    s.entryDiagnostics={at:input.now,matched:built.opportunities.filter(o=>o.eligible).length,opened:0,reasons:{}};
    s.fitDiagnostics={tested:s.relationEngine.rules.length,qualified:s.entryDiagnostics.matched,trainGroups:s.relationEngine.diagnostics.matureSamples,
      checkGroups:s.relationEngine.diagnostics.liveAnomalies,latestAt:input.now,rapidQualified:s.relationEngine.rules.filter(r=>r.scope==="RECENT").length,
      activeLong:s.relationEngine.rules.filter(r=>r.side==="LONG"&&r.status!=="DEGRADED").length,
      activeShort:s.relationEngine.rules.filter(r=>r.side==="SHORT"&&r.status!=="DEGRADED").length};
  }else{
    const pulse=s.marketPulse.at?s.marketPulse:marketPulse(input.paths,input.now),premium:Opportunity[]=[];
    for(const [symbol,region] of Object.entries(s.regions)){const rows=validPath(input.paths[symbol]??[],input.now);if(!rows)continue;
      premium.push(...regionOpportunities(s,symbol,rows,input.minutePaths?.[symbol],input.quotes[symbol],input.now,pulse,region).filter(o=>o.premium));}
    const base=s.opportunities.filter(o=>!o.premium&&o.expiresAt>input.now),combined=[...premium,...base];
    s.opportunities=[...new Map(combined.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.premium)-Number(a.premium)
      ||Number(!b.reserve)-Number(!a.reserve)||b.score-a.score).map(o=>[o.symbol,o] as const)).values()];
  }
  const mark=equityMark(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));
  updateDaily(s,input.now,mark.equity);rotateIfNeeded(s,input.quotes,input.contracts,input.now,mark.equity);const opened=fillSeats(s,input.quotes,input.contracts,input.now,mark.equity);
  const d=s.relationEngine.diagnostics;
  s.latestReason=s.relationEngine.rules.length===0?d.warmup:s.positions.length>=ADAPTIVE_TARGET_POSITIONS
    ?`Forward Relation 2.0 当前${s.positions.length}席；ACTIVE ${d.active} · 承压 ${d.pressured} · 降级 ${d.degraded}，继续让更健康关系替换弱仓。`
    :`Forward Relation 2.0 当前${s.positions.length}/${ADAPTIVE_TARGET_POSITIONS}席；${s.opportunities.filter(o=>o.eligible).length}个可参与候选，关系风险持续迁移。`;
  if(opened)s.latestReason+=` 本轮新开${opened}笔。`;
  const after=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice]),h:s.history.length,b:s.balance,r:s.revision});
  return{state:s,changed:before!==after||dataDue,protectionChanged:input.state.positions.some(t=>s.positions.find(n=>n.id===t.id)?.stopPrice!==t.stopPrice)};
}
export function closeForwardForReset(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const s=normalizeForward(structuredClone(state),now);for(const t of [...s.positions]){const q=quotes[t.symbol],px=freshQuote(q,now)?(t.side==="LONG"?q!.bestBid:q!.bestAsk):t.lastPrice;closeTrade(s,t,px,now,"ACCOUNT_RESET");}
  s.positions=[];return s;
}
export function forwardUrgentQuoteSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):null,keep=(x:string)=>!allowed||allowed.has(x);
  const premium=s.opportunities.filter(o=>o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort((a,b)=>b.score-a.score);
  const normal=s.opportunities.filter(o=>!o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort((a,b)=>b.score-a.score);
  const regions=Object.values(s.regions).filter(r=>keep(r.symbol)).sort((a,b)=>b.quality-a.quality);
  return[...new Set([...s.positions.map(t=>t.symbol),...premium.map(o=>o.symbol),...normal.map(o=>o.symbol),...regions.map(r=>r.symbol)])];
}
export function forwardUrgentMinuteSymbols(s:ForwardState,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):null,keep=(x:string)=>!allowed||allowed.has(x);
  return[...new Set([...s.positions.map(t=>t.symbol),...s.opportunities.filter(o=>o.premium&&o.eligible&&keep(o.symbol)).map(o=>o.symbol),
    ...Object.values(s.regions).filter(r=>keep(r.symbol)&&r.quality>=55).sort((a,b)=>b.quality-a.quality).slice(0,8).map(r=>r.symbol)])];
}
export function forwardWatchSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  return forwardUrgentQuoteSymbols(s,now,entrySymbols).slice(0,ADAPTIVE_REALTIME_POSITION_CAP);
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const mark=equityMark(s,quotes,now),eligible=s.opportunities.filter(o=>o.eligible&&o.expiresAt>now),reserve=eligible.filter(o=>o.reserve),d=s.relationEngine.diagnostics;
  return{version:s.version,engineVersion:ADAPTIVE_ENGINE_VERSION,grammar:ADAPTIVE_ENGINE_VERSION,mode:"REAL_FEED_PAPER",liveEligible:false,
    strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:"adaptive-region-v1",
    regionLaunchVersion:"adaptive-region-v1",policyVersion:ADAPTIVE_ENGINE_VERSION,exitPolicyVersion:ADAPTIVE_ENGINE_VERSION,
    policyUpgrade:null,exitPolicyUpgrade:null,startedAt:s.startedAt,cutoverAt:s.cutoverAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...mark,targetEquity:s.initialEquity*2,
    netPnl:mark.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,fees:s.fees,
    fundingAllowance:s.fundingAllowance,turnover:s.turnover,positions:s.positions,history:s.history,events:s.events,daily:s.daily,
    opportunities:s.opportunities,entryOpportunities:s.opportunities,regions:Object.values(s.regions),marketPulse:s.marketPulse,
    relationEngine:{version:s.relationEngine.version,updatedAt:s.relationEngine.updatedAt,diagnostics:d,
      rules:s.relationEngine.rules.map(r=>({id:r.id,horizon:r.horizon,side:r.side,status:r.status,health:r.health,longNet:r.longNet,
        recentNet:r.recentNet,livePathScore:r.livePathScore,environmentFit:r.environmentFit,scope:r.scope,reason:r.reason}))},
    marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,entryDiagnostics:s.entryDiagnostics,
    fitDiagnostics:s.fitDiagnostics,storage:s.storage,targetPositions:ADAPTIVE_TARGET_POSITIONS,realtimePositionCap:ADAPTIVE_REALTIME_POSITION_CAP,
    seatCount:s.positions.length,eligibleCount:eligible.length,reserveCount:reserve.length,premiumCount:eligible.filter(o=>o.premium).length,
    boundaries:{scope:"PAPER_AUTHORITY",grammar:"真实市场条件→15/60/180分钟成熟反应→关系生命周期；5/10/15/30/60/180分钟路径检查点只判断旧关系是否失效，不预测反向。",
      historyBackfill:false,sampleMeaning:"长期样本决定关系资格；近期成熟样本与进行中真实反应路径决定当前交易权。旧方向失效不会自动生成反向订单。",
      accounting:"模拟使用新鲜买卖价并计入手续费、滑点和资金费占位；同一持久化Trade事件供实盘执行。",
      risk:"组合计划风险≤10%，同方向≤6.5%，保证金≤75%；ACTIVE正常竞争风险，PRESSURED/DEGRADED连续降权但不靠全局停单规避亏损。",
      validation:"关系状态为ACTIVE/PRESSURED/DEGRADED/RECOVERING；反方向必须由自己的已成熟真实样本获得资格。",
      liquidation:"结构止损 + 无正向反馈 + 关系降级 + 独立反向机会 + MFE利润保护；关系恶化时优先退出未形成浮赢的弱仓，盈利仓先收紧保护。"},
    cost:PAPER_COST,nextCycleAt:s.lastCandleAt+BAR_MS};
}
