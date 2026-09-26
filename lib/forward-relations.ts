import { familyAdmissionBlock, familyExperimentSummary, initialFamilyExperimentState, isFamilyFailure,
  familyCalibration, normalizeFamilyExperimentState, pruneFamilyExperimentBySymbols, recordFamilyFailure, recordFamilyOutcome,
  relationFamilyId, reserveExperimentValueBlock,
  type FamilyExperimentState } from "./forward-family-experiment.ts";
import { FORWARD_RELATION_V2_VERSION, advanceRelationEngine, initialRelationEngine, normalizeRelationEngine, relationCandidates,
  type RelationCandidate, type RelationEngineState, type RelationExitProfile, type RelationStatus } from "./forward-relation-v2.ts";
import { STRUCTURAL_INTERRUPT_VERSION, advanceStructuralInterrupt, detectOuterRegion, initialStructuralInterruptState,
  normalizeStructuralInterruptState, structuralInterruptBlockReason, structuralInterruptCandidates,
  type StructuralInterruptCandidate, type StructuralInterruptState } from "./forward-structural-interrupt.ts";
import { EXTREMUM_REGIME_VERSION, buildExtremumRegime, urgentMinuteSymbols as extremumUrgentMinuteSymbols,
  type ExtremumRegimeState, type ExtremumSymbolState } from "./extremum-regime-engine.ts";

/**
 * Forward Path Relation 3.0 — PAPER authority.
 *
 * One 5m root observation records its complete 5–60m response path. Mature
 * path evidence chooses direction, expected hold, normal adverse excursion,
 * feedback deadline and profit retention together. Region/1m logic remains
 * execution enhancement, never a second directional authority.
 */
export const FORWARD_VERSION="forward-relations-v1.0";
export const ADAPTIVE_ENGINE_VERSION=EXTREMUM_REGIME_VERSION;
export const FORWARD_EXECUTION_BBO_CAP=30;
export const FORWARD_MINUTE_CONFIRMATION_CAP=11;
export const BAR_MS=300_000;
export const FEATURES=["5分钟方向","路径效率","剩余空间","位置质量","回调风险","1分钟确认","区域质量","入场后反馈"] as const;
export const PAPER_COST={feeRate:.0007,slippageRate:.00025,fundingAllowancePerDay:.0002,
  assumption:"双边吃单费各7bp＋滑点各2.5bp＋每日2bp不利资金费占位"};
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const TOTAL_RISK_RATE=.10,SIDE_RISK_RATE=.065,TOTAL_MARGIN_RATE=.75;
const PROBE_RISK_POOL_RATE=.015,FAMILY_RISK_CAP_RATE=.025,FIVE_MINUTE_NEW_RISK_RATE=.025;
const SHOCK_EVENT_RISK_RATE=.015,SHOCK_TRADE_RISK_RATE=.006,SHOCK_MIN_CHARGE_RATE=.004,MAX_SHOCK_ENTRIES_PER_EVENT=2;
const MAX_NEW_RESERVE_EXPERIMENTS_PER_5M=2;
const PRIMARY_MIN_CHARGE_RATE=.0055,PROBE_MIN_CHARGE_RATE=.0025;
const ROTATION_GAP=10,ROTATION_COOLDOWN_MS=2*60_000;
const HISTORY_LIMIT=240,EVENT_LIMIT=160;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(v:number[])=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const dayKey=(now:number)=>new Date(now+7*3600_000).toISOString().slice(0,10);
const safe=(v:number|null|undefined,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;

export type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type Quote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean;sourceCount?:number;disagreementRate?:number;
  sourceBreadth?:number;directionalAgreement?:number;medianShortMove?:number};
export type Contract={quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts?:number;
  enableDecimal?:boolean;orderSizeMin?:string|number;orderSizeMax?:string|number;marketOrderSizeMax?:string|number};

export type Condition={feature:number;op:"GE"|"LE";threshold:number};
export type Rule={id:string;signature:string;parentId:string|null;version:number;createdAt:number;expiresAt:number;
  status:"EXPERIMENTAL"|"DORMANT";conditions:Condition[];side:"LONG"|"SHORT";horizon:number;stopRate:number;
  armRate:number;givebackRate:number;exitMode:"HORIZON"|"REACTION_DECAY";samples:number;trainGroups:number;checkGroups:number;
  estimatedNetRate:number;priorResponse:number|null;recentResponse:number;standardError:number;reason:string;
  mutation:"CREATE"|"REVISE"|"RECALL";grammar:string;liveEligible:false;authority?:"ADAPTIVE_TEN"|"FORWARD_RELATION"|"STRUCTURAL_INTERRUPT";turnTimeframe?:"5m"};

export type OpportunityMode="RELATION"|"BREAKOUT"|"RETEST"|"FAILED_BREAKOUT"|"RANGE"|"SHOCK"|"SWING"|"TREND_PULLBACK"|"IMPULSE";
export type RegionState="IN_REGION"|"ABOVE"|"BELOW";
export type Region={
  id:string;symbol:string;confirmedAt:number;lower:number;upper:number;center:number;widthRate:number;bars:number;
  quality:number;state:RegionState;lastSeenAt:number;atrRate?:number;
  outerLower?:number;outerUpper?:number;outerCenter?:number;outerWidthRate?:number;outerBars?:number;outerQuality?:number;
};
export type Opportunity={
  id:string;symbol:string;side:"LONG"|"SHORT";mode:OpportunityMode;premium:boolean;reserve?:boolean;score:number;eligible:boolean;
  completedAt:number;expiresAt:number;price:number;stopPrice:number;targetPrice:number;stopRate:number;targetRate:number;directionStrength:number;
  pathEfficiency:number;momentumPersistence:number;positionScore:number;spaceScore:number;executionScore:number;
  grossRemainingSpaceRate:number;netRemainingSpaceRate:number;pullbackRiskRate:number;edgeRatio:number;
  expectedHoldMinutes:number;marketFit:number;regionId:string|null;regionQuality:number|null;reason:string;
  relationRuleId?:string;relationStatus?:RelationStatus;relationHorizon?:15|30|45|60;relationHealth?:number;riskScale?:number;
  interruptEventId?:string;interruptMarketWide?:boolean;interruptBoundary?:number;interruptStrength?:number;
  interruptIndependent?:boolean;interruptConfirmation?:"CONTINUATION"|"RETEST_RESTART";
  exitPlan?:RelationExitProfile;
  strategyVersion?:string;regime?:ExtremumSymbolState["regime"];topPressure?:number;bottomPressure?:number;upSurvival?:number;downSurvival?:number;
  confirmationStage?:ExtremumSymbolState["stage"];sourceCount?:number;disagreementRate?:number;
};
export type MarketPulse={at:number;up:number;down:number;neutral:number;bias:"UP"|"DOWN"|"MIXED";strength:number;expansion:number};

export type EntryContext={
  version:"adaptive-ten-entry-v1";capturedAt:number;timeframe:"5m";side:"LONG"|"SHORT";mode:OpportunityMode;reserve?:boolean;
  reason:string;entryScore:number;directionStrength:number;spaceScore:number;positionScore:number;executionScore:number;
  remainingSpaceRate:number;pullbackRiskRate:number;edgeRatio:number;expectedHoldMinutes:number;marketFit:number;
  regionId:string|null;regionLower?:number;regionUpper?:number;regionCenter?:number;
  relationRuleId?:string;relationStatus?:RelationStatus;relationHorizon?:15|30|45|60;relationHealth?:number;portfolioRiskCharge?:number;
  relationFamilyId?:string;relationEvidenceAt?:number;relationLivePathScore?:number;
  interruptEventId?:string;interruptMarketWide?:boolean;interruptBoundary?:number;interruptStrength?:number;
  strategyVersion?:string;regime?:ExtremumSymbolState["regime"];topPressure?:number;bottomPressure?:number;upSurvival?:number;downSurvival?:number;
  confirmationStage?:ExtremumSymbolState["stage"];sourceCount?:number;disagreementRate?:number;postEntryState?:"PENDING"|"CONFIRMED"|"FAILED";
};
export type Trade={
  id:string;symbol:string;side:"LONG"|"SHORT";rule:Rule;openedAt:number;closedAt:number|null;status:"OPEN"|"CLOSED";
  entryPrice:number;exitPrice:number|null;quantity:number;contracts:number;quantoMultiplier:number;notional:number;
  leverage:number;margin:number;plannedRisk:number;stopPrice:number;armPrice:number;favorable:number;adverse:number;
  lastPrice:number;lastQuoteAt:number;entryFee:number;exitFee:number;fundingAllowance:number;grossPnl:number|null;netPnl:number|null;
  exitReason:string|null;relationFailureBars:number;lastRelationBar:number;execution:"REAL_QUOTE_PAPER_MODEL";liveEligible:false;
  entryContext?:EntryContext;forecast?:{remainingNetRate:number;quality:number;sizingEquity:number};exitPlan?:RelationExitProfile;
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
export type EntryValidation={id:string;candidateId:string;symbol:string;side:"LONG"|"SHORT";startedAt:number;expiresAt:number;
  deadlineAt:number;
  initialPrice:number;lastPrice:number;lastQuoteAt:number;samples:number;bestAdvanceRate:number;maxAdverseRate:number;
  status:"WAITING"|"CANCELLED";reason:string|null};
export type ForwardState={
  version:string;engineVersion:string;startedAt:number;revision:number;lastCycleAt:number;lastQuoteCycleAt:number;lastCandleAt:number;
  balance:number;initialEquity:number;peakEquity:number;maxDrawdown:number;resolved:number;wins:number;grossPnl:number;fees:number;
  fundingAllowance:number;turnover:number;positions:Trade[];history:Trade[];events:AuditEvent[];daily:Daily[];
  selectedSymbols:string[];opportunities:Opportunity[];regions:Record<string,Region>;relationEngine:RelationEngineState;extremumRegime:ExtremumRegimeState;
  familyExperiment:FamilyExperimentState;structuralInterrupt:StructuralInterruptState;
  entryValidations:Record<string,EntryValidation>;
  marketPulse:MarketPulse;lastEntryAt:Record<string,number>;lastExitAt:Record<string,number>;lastSide:Record<string,"LONG"|"SHORT">;
  lastRotationAt:number;latestReason:string;entryDiagnostics:{at:number;matched:number;opened:number;reasons:Record<string,number>};
  storage:{persistedAt:number;error:string|null;layout?:string;sampleIntegrity?:"raw-sha256"|"legacy-recovered"};liveEligible:false;
  policyVersion:string;strategyAuthorityVersion:string;
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
    positions:[],history:[],events:[],daily:[],selectedSymbols:[],opportunities:[],regions:{},relationEngine:initialRelationEngine(now),
    extremumRegime:{version:EXTREMUM_REGIME_VERSION,updatedAt:now,symbols:{}},
    familyExperiment:initialFamilyExperimentState(),structuralInterrupt:initialStructuralInterruptState(),entryValidations:{},marketPulse:blankPulse(now),
    lastEntryAt:{},lastExitAt:{},lastSide:{},lastRotationAt:0,latestReason:"Forward Path Relation 3.0 已启动：根样本学习完整5–60分钟路径；方向与退出由同一证据生成。",
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
    mutation:"CREATE",grammar:ADAPTIVE_ENGINE_VERSION,liveEligible:false,
    authority:r?.authority==="STRUCTURAL_INTERRUPT"?"STRUCTURAL_INTERRUPT":r?.authority==="FORWARD_RELATION"?"FORWARD_RELATION":"ADAPTIVE_TEN",turnTimeframe:"5m"};
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
  t.profitFloorRate=Math.max(0,safe(t.profitFloorRate));t.exitPlan=t.exitPlan&&(t.exitPlan.version==="sample-exit-plan-v1"||t.exitPlan.version==="sample-exit-plan-v2")?t.exitPlan:undefined;
  t.expectedHoldMinutes=Math.max(5,safe(t.exitPlan?.bestHoldMinutes,t.expectedHoldMinutes??t.entryContext?.expectedHoldMinutes??30));
  if(t.entryContext&&!(safe(t.entryContext.portfolioRiskCharge)>0)){
    const sizingEquity=safe(t.forecast?.sizingEquity),floor=sizingEquity*(t.entryContext.reserve===true?.003:.006);
    if(floor>0)t.entryContext.portfolioRiskCharge=Math.max(t.plannedRisk,floor);
  }
  t.peakPnlRate=Math.max(0,safe(t.peakPnlRate,t.favorable));return t;
}
function normalizeEntryValidations(value:unknown,now:number){
  const out:Record<string,EntryValidation>={};if(!value||typeof value!=="object")return out;
  for(const [id,raw]of Object.entries(value as Record<string,unknown>)){
    if(!raw||typeof raw!=="object")continue;const r=raw as Partial<EntryValidation>;
    if(typeof r.candidateId!=="string"||typeof r.symbol!=="string"||(r.side!=="LONG"&&r.side!=="SHORT"))continue;
    const startedAt=safe(r.startedAt),expiresAt=safe(r.expiresAt);if(!(startedAt>0&&expiresAt>=startedAt&&expiresAt>now-15*60_000))continue;
    out[id]={id,candidateId:r.candidateId,symbol:r.symbol,side:r.side,startedAt,expiresAt,deadlineAt:safe(r.deadlineAt,Math.min(expiresAt,startedAt+24_000)),
      initialPrice:Math.max(1e-12,safe(r.initialPrice,1)),lastPrice:Math.max(1e-12,safe(r.lastPrice,r.initialPrice??1)),
      lastQuoteAt:safe(r.lastQuoteAt,startedAt),samples:Math.max(1,Math.floor(safe(r.samples,1))),
      bestAdvanceRate:Math.max(0,safe(r.bestAdvanceRate)),maxAdverseRate:Math.max(0,safe(r.maxAdverseRate)),
      status:r.status==="CANCELLED"?"CANCELLED":"WAITING",reason:typeof r.reason==="string"?r.reason:null};
  }
  return out;
}
export function normalizeForward(v:ForwardState|null|undefined,now:number):ForwardState{
  if(!v)return initialForward(now);
  if(v.version!==FORWARD_VERSION||!Number.isFinite(v.balance)||!Array.isArray(v.positions)||!Array.isArray(v.history)||v.liveEligible!==false)
    throw new Error("前向账户存储格式异常；保留原数据，禁止自动重置");
  const base=initialForward(v.startedAt>0?v.startedAt:now);
  const old=v as ForwardState&Record<string,unknown>;
  const upgrading=v.engineVersion!==ADAPTIVE_ENGINE_VERSION||v.strategyAuthorityVersion!==ADAPTIVE_ENGINE_VERSION
    ||v.executionVersion!==ADAPTIVE_ENGINE_VERSION;
  const relationEngine=normalizeRelationEngine(v.relationEngine,now);
  const positions=v.positions.map(t=>normalizeTrade(t,now)),history=v.history.map(t=>normalizeTrade(t,now)).slice(0,HISTORY_LIMIT);
  for(const t of positions){
    if(!t.entryContext?.relationFamilyId&&t.entryContext?.relationRuleId){
      const rule=relationEngine.rules.find(r=>r.id===t.entryContext?.relationRuleId);
      if(rule)t.entryContext.relationFamilyId=relationFamilyId(rule);
    }
  }
  const familyExperiment=upgrading?initialFamilyExperimentState():normalizeFamilyExperimentState((old as {familyExperiment?:unknown}).familyExperiment,relationEngine.rules,
    (old as {relationGuards?:unknown}).relationGuards);
  return{...base,...old,
    startedAt:safe(v.startedAt,base.startedAt),revision:Math.max(0,Math.floor(safe(v.revision))),lastCycleAt:safe(v.lastCycleAt),lastQuoteCycleAt:safe(v.lastQuoteCycleAt),
    lastCandleAt:safe(v.lastCandleAt,safe(v.lastCycleAt)),balance:safe(v.balance,1000),initialEquity:safe(v.initialEquity,1000),
    peakEquity:Math.max(safe(v.peakEquity,1000),safe(v.balance,1000)),maxDrawdown:Math.max(0,safe(v.maxDrawdown)),
    resolved:Math.max(0,Math.floor(safe(v.resolved))),wins:Math.max(0,Math.floor(safe(v.wins))),grossPnl:safe(v.grossPnl),
    fees:Math.max(0,safe(v.fees)),fundingAllowance:Math.max(0,safe(v.fundingAllowance)),turnover:Math.max(0,safe(v.turnover)),
    positions,history,
    events:Array.isArray(v.events)?v.events.slice(0,EVENT_LIMIT):base.events,daily:Array.isArray(v.daily)?v.daily:[],
    selectedSymbols:Array.isArray(v.selectedSymbols)?v.selectedSymbols:[],opportunities:upgrading?[]:(Array.isArray(v.opportunities)?v.opportunities:[]),
    regions:v.regions&&typeof v.regions==="object"?v.regions:{},relationEngine,
    extremumRegime:!upgrading&&(old as {extremumRegime?:ExtremumRegimeState}).extremumRegime?.version===EXTREMUM_REGIME_VERSION
      ?structuredClone((old as {extremumRegime:ExtremumRegimeState}).extremumRegime):base.extremumRegime,
    familyExperiment,
    structuralInterrupt:normalizeStructuralInterruptState((old as {structuralInterrupt?:unknown}).structuralInterrupt,now),
    entryValidations:normalizeEntryValidations((old as {entryValidations?:unknown}).entryValidations,now),
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
    for(const r of w){const side=r.close>center?1:r.close<center?-1:0;if(side&&prev&&side!==prev)crossings++;if(side)prev=side;
      if(r.low<=center&&r.high>=center)touches++;}
    if(crossings<2&&touches<Math.ceil(bars*.45))continue;
    const compact=1-clip(widthRate/maxWidth),quality=100*clip(.45*compact+.35*Math.min(1,crossings/4)+.20*Math.min(1,touches/bars));
    const price=rows.at(-1)!.close,state:RegionState=price>upper?"ABOVE":price<lower?"BELOW":"IN_REGION";
    const candidate:Region={id:`rg-${symbol}-${w[0]!.time}`,symbol,confirmedAt:(w.at(-1)!.time+300)*1000,lower,upper,center,widthRate,bars,quality,state,lastSeenAt:now,atrRate:atr};
    if(!best||candidate.quality>best.quality)best=candidate;
  }
  if(!best)return null;
  const outer=detectOuterRegion(rows,best,atr);
  return outer?{...best,outerLower:outer.lower,outerUpper:outer.upper,outerCenter:outer.center,outerWidthRate:outer.widthRate,
    outerBars:outer.bars,outerQuality:outer.quality}:best;
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
function relationHardStopRate(rows:Candle[],side:"LONG"|"SHORT",price:number,normalAdverse:number){
  const st=pathStats(rows),window=rows.slice(-9,-1),buffer=Math.max(st.atr*.18,.00045);
  const structure=side==="LONG"?Math.min(...window.map(r=>r.low)):Math.max(...window.map(r=>r.high)),
    structureRate=Math.abs(price-structure)/price+buffer;
  // The learned MAE is an early invalidation expectation, not the account's
  // disaster boundary. Keep the hard stop outside normal noise/structure while
  // preserving the existing 3% absolute safety ceiling.
  return clip(Math.max(normalAdverse*1.35,st.atr*2.2,structureRate),.004,.03);
}
export function relationHardPayoffBlock(input:{exitProfile:RelationExitProfile;hardStopRate:number;netRate:number;roundTripCost?:number}){
  if(input.exitProfile.version!=="sample-exit-plan-v2")return null;
  const p=input.exitProfile,cost=Math.max(0,input.roundTripCost??ROUND_TRIP_COST),winRate=clip(p.winRate??0);
  if(!(winRate>0&&Number.isFinite(p.medianWinNetRate)&&Number.isFinite(p.medianLossNetRate)
    &&Number.isFinite(p.adverseP80Rate)&&Number.isFinite(p.adverseP95Rate)))return null;
  const retainedTarget=Math.max(0,p.targetRate*p.retentionRate-cost),
    typicalWin=Math.max(input.netRate,Math.min(retainedTarget,Math.max(0,p.medianWinNetRate??0))),
    typicalLoss=Math.max(cost*.25,p.medianLossNetRate??0),
    robustExpected=winRate*typicalWin-(1-winRate)*typicalLoss,
    minimumExpected=Math.max(cost*.05,.00005);
  if(robustExpected<minimumExpected)return `样本稳健期望不足：${(robustExpected*100).toFixed(3)}% < ${(minimumExpected*100).toFixed(3)}%（胜率${(winRate*100).toFixed(0)}%）`;
  const hardCoverage=typicalWin/Math.max(input.hardStopRate+cost,1e-9),p80=Math.max(0,p.adverseP80Rate??0),p95=Math.max(p80,p.adverseP95Rate??0),
    hardBeyond95=input.hardStopRate>=p95*1.05,hardBeyond80=input.hardStopRate>=p80*1.15,
    tailFloor=hardBeyond95 ? .15 : hardBeyond80 ? .25 : .40;
  return hardCoverage<tailFloor?`结构止损尾部覆盖不足：${hardCoverage.toFixed(2)}× < ${tailFloor.toFixed(2)}×`:null;
}
function activeRecentValue(c:RelationCandidate){
  return c.scope==="RECENT"&&c.status==="ACTIVE"?{
    netRate:c.netRate,targetRate:c.exitProfile.targetRate,normalAdverseRate:c.exitProfile.normalAdverseRate,
    retentionRate:c.exitProfile.retentionRate,samples:c.exitProfile.samples,groups:c.exitProfile.groups}:undefined;
}
function consumeExitPlan(plan:RelationExitProfile,consumedRate:number){
  const out=structuredClone(plan),used=Math.max(0,consumedRate);out.targetRate=Math.max(0,out.targetRate-used);
  for(const point of Object.values(out.path))if(point){
    point.expectedRate-=used;point.remainingEdgeRate=Math.max(0,point.remainingEdgeRate-used);
  }
  return out;
}
export function relationOpportunity(c:RelationCandidate,rows:Candle[],q:Quote|undefined,now:number):Opportunity{
  const framePrice=rows.at(-1)!.close,d=dir(c.side),exec=executionScore(q,now),quotePrice=freshQuote(q,now)?midpoint(q!):framePrice,
    consumed=Math.max(0,d*(quotePrice/framePrice-1)),net=Math.max(0,c.netRate-consumed),gross=Math.max(0,Math.max(c.netRate+ROUND_TRIP_COST,c.grossRate)-consumed),
    normalAdverse=Math.max(.003,c.exitProfile.normalAdverseRate),hardStop=relationHardStopRate(rows,c.side,framePrice,normalAdverse),
    edge=net/Math.max(normalAdverse,1e-9),score=clip(c.score*.90+exec*.10,0,100),
    reserveBlock=reserveExperimentValueBlock({reserve:c.reserve,netRate:net,edgeRatio:edge,livePathScore:c.livePathScore,
      environmentFit:c.environmentFit,roundTripCost:ROUND_TRIP_COST,activeRecent:activeRecentValue(c)}),
    captured=Math.max(net,c.exitProfile.targetRate*c.exitProfile.retentionRate-ROUND_TRIP_COST),
    hardCoverage=captured/Math.max(hardStop+ROUND_TRIP_COST,1e-9),
    payoffBlock=relationHardPayoffBlock({exitProfile:c.exitProfile,hardStopRate:hardStop,netRate:net});
  return{id:`relation-${c.ruleId}-${c.symbol}-${rows.at(-1)!.time}`,symbol:c.symbol,side:c.side,mode:"RELATION",premium:false,reserve:c.reserve,
    score,eligible:c.health>=.15&&net>0&&!reserveBlock&&!payoffBlock,completedAt:(rows.at(-1)!.time+300)*1000,expiresAt:now+12*60_000,price:quotePrice,
    stopPrice:quotePrice*(1-d*hardStop),targetPrice:quotePrice*(1+d*Math.max(.003,gross)),stopRate:hardStop,targetRate:Math.max(.003,gross),
    directionStrength:c.health*100,pathEfficiency:c.livePathScore*100,momentumPersistence:c.environmentFit*100,positionScore:75,
    spaceScore:100*clip(Math.min(edge,hardCoverage)/1.5),executionScore:exec,grossRemainingSpaceRate:gross,netRemainingSpaceRate:net,pullbackRiskRate:normalAdverse,
    edgeRatio:edge,expectedHoldMinutes:c.exitProfile.bestHoldMinutes,marketFit:c.environmentFit*100,regionId:null,regionQuality:null,
    reason:[c.reason,reserveBlock,payoffBlock].filter(Boolean).join("｜"),relationRuleId:c.ruleId,relationStatus:c.status,
    relationHorizon:c.horizon,relationHealth:c.health,riskScale:clip(c.health,.25,1),exitPlan:consumeExitPlan(c.exitProfile,consumed)};
}
function regionOpportunities(s:ForwardState,symbol:string,rows:Candle[],minute:Candle[]|undefined,q:Quote|undefined,now:number,pulse:MarketPulse,region:Region){
  const out:Opportunity[]=[],st=pathStats(rows),last=st.last,prev=rows.at(-2)!,price=last.close,exec=executionScore(q,now);
  const avgBody=Math.max(st.body,.0002),body=Math.abs(last.close/last.open-1),closePos=(last.close-last.low)/Math.max(last.high-last.low,1e-9);
  const buffer=Math.max(st.atr*.12,.00045),add=(side:"LONG"|"SHORT",mode:OpportunityMode,baseScore:number,stop:number,target:number,reason:string,premium=true)=>{
    const d=dir(side),gross=Math.max(0,d*(target/price-1)),net=Math.max(0,gross-ROUND_TRIP_COST),pullback=Math.max(.0035,Math.abs(price-stop)/price);
    const edge=net/Math.max(pullback,1e-9),fit=pulse.bias==="MIXED"?60:pulse.bias===(side==="LONG"?"UP":"DOWN")?85:40;
    const score=clip(baseScore+.08*exec+.06*fit,0,100);
    const stopRate=Math.abs(price-stop)/price,targetRate=Math.abs(target/price-1);
    out.push({id:`${mode.toLowerCase()}-${symbol}-${last.time}`,symbol,side,mode,premium,score,
      eligible:score>=58&&net>0&&edge>=.5,completedAt:(last.time+300)*1000,expiresAt:now+(premium?6:10)*60_000,price,stopPrice:stop,targetPrice:target,stopRate,targetRate,
      directionStrength:Math.min(100,baseScore+5),pathEfficiency:region.quality,momentumPersistence:baseScore,positionScore:80,spaceScore:100*clip(edge/2),
      executionScore:exec,grossRemainingSpaceRate:gross,netRemainingSpaceRate:net,pullbackRiskRate:pullback,edgeRatio:edge,
      expectedHoldMinutes:mode==="RANGE"?12:mode==="BREAKOUT"?18:22,marketFit:fit,regionId:region.id,regionQuality:region.quality,reason});
  };
  const upperBreakLevel=region.outerUpper??region.upper,lowerBreakLevel=region.outerLower??region.lower,
    structureWidthRate=region.outerWidthRate??region.widthRate,structureWidth=upperBreakLevel-lowerBreakLevel;
  const upBreak=last.close>upperBreakLevel*(1+buffer)&&body>avgBody*1.35&&closePos>.68;
  const dnBreak=last.close<lowerBreakLevel*(1-buffer)&&body>avgBody*1.35&&closePos<.32;
  if(upBreak){const m=minuteConfirm(minute,"LONG",upperBreakLevel,now);if(m.ok){
    const stop=Math.max(region.center,upperBreakLevel-Math.max(structureWidth*.18,price*st.atr*.45));
    add("LONG","BREAKOUT",72+m.score*.10,stop,price*(1+Math.max(structureWidthRate*.8,st.atr*2.2)),
      `${region.outerUpper?"完整外层区":"成熟区"}上破｜5m实体${(body/avgBody).toFixed(1)}×｜1m确认通过`);}}
  if(dnBreak){const m=minuteConfirm(minute,"SHORT",lowerBreakLevel,now);if(m.ok){
    const stop=Math.min(region.center,lowerBreakLevel+Math.max(structureWidth*.18,price*st.atr*.45));
    add("SHORT","BREAKOUT",72+m.score*.10,stop,price*(1-Math.max(structureWidthRate*.8,st.atr*2.2)),
      `${region.outerLower?"完整外层区":"成熟区"}下破｜5m实体${(body/avgBody).toFixed(1)}×｜1m确认通过`);}}
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
function relationSupportMap(s:ForwardState,allowed?:ReadonlySet<string>){
  const bySymbol=new Map<string,RelationCandidate[]>();
  for(const c of relationCandidates(s.relationEngine)){
    if(allowed&&!allowed.has(c.symbol))continue;
    const rows=bySymbol.get(c.symbol)??[];rows.push(c);bySymbol.set(c.symbol,rows);
  }
  return bySymbol;
}
function relationBackedRegionOpportunities(s:ForwardState,symbol:string,rows:Candle[],minute:Candle[]|undefined,q:Quote|undefined,now:number,
  pulse:MarketPulse,region:Region,support:RelationCandidate[]){
  const out:Opportunity[]=[];
  for(const o of regionOpportunities(s,symbol,rows,minute,q,now,pulse,region)){
    const relation=support.find(c=>c.side===o.side);
    if(!relation)continue;
    const reserveBlock=reserveExperimentValueBlock({reserve:relation.reserve,netRate:o.netRemainingSpaceRate,edgeRatio:o.edgeRatio,
      livePathScore:relation.livePathScore,environmentFit:relation.environmentFit,roundTripCost:ROUND_TRIP_COST,
      activeRecent:activeRecentValue(relation)});
    out.push({...o,score:clip(o.score*.55+relation.score*.45,0,100),eligible:o.eligible&&relation.health>=.15&&!reserveBlock,
      reserve:relation.reserve,relationRuleId:relation.ruleId,relationStatus:relation.status,relationHorizon:relation.horizon,
      relationHealth:relation.health,riskScale:clip(relation.health,.25,1),expectedHoldMinutes:relation.exitProfile.bestHoldMinutes,
      exitPlan:structuredClone(relation.exitProfile),
      reason:`${relation.reason}${reserveBlock?`｜${reserveBlock}`:""}｜执行结构：${o.reason}`});
  }
  return out;
}
function structuralExitPlan(candidate:StructuralInterruptCandidate,stopRate:number,targetRate:number):RelationExitProfile{
  const normalAdverse=Math.max(.002,Math.min(stopRate*.45,candidate.atrRate*.65+ROUND_TRIP_COST*.25)),
    target=Math.max(ROUND_TRIP_COST*1.4,targetRate),activation=Math.max(ROUND_TRIP_COST*1.15,Math.min(.008,target*.35));
  const point=(expectedRate:number,adverseRate:number,remainingEdgeRate:number,futureBestMinutes:15|30,recoveryRate:number)=>({
    expectedRate,adverseRate,remainingEdgeRate,futureBestMinutes,recoveryRate,continuationSamples:0});
  return{version:"sample-exit-plan-v2",bestHoldMinutes:15,feedbackDeadlineMinutes:5,maxHoldMinutes:30,normalAdverseRate:normalAdverse,
    targetRate:target,protectionActivationRate:activation,retentionRate:.82,samples:0,groups:0,path:{
      5:point(target*.22,normalAdverse*.75,target*.68,15,1),10:point(target*.48,normalAdverse*.85,target*.42,15,.75),
      15:point(target*.70,normalAdverse,target*.20,15,.5),20:point(target*.78,normalAdverse,target*.10,30,.35),
      30:point(target*.88,normalAdverse,0,30,0)}};
}
function interruptOpportunities(s:ForwardState,quotes:Record<string,Quote>,now:number,allowed?:ReadonlySet<string>){
  const out:Opportunity[]=[];
  for(const candidate of structuralInterruptCandidates({state:s.structuralInterrupt,regions:s.regions,quotes,now})){
    if(allowed&&!allowed.has(candidate.symbol))continue;
    const q=quotes[candidate.symbol];if(!freshQuote(q,now))continue;const price=midpoint(q!),exec=executionScore(q,now),d=dir(candidate.side),
      stopRate=Math.abs(price-candidate.stopPrice)/price,targetRate=Math.max(0,d*(candidate.targetPrice/price-1)),
      gross=targetRate,net=Math.max(0,gross-ROUND_TRIP_COST),pullback=Math.max(.002,stopRate),
      edge=net/Math.max(pullback,1e-9),score=clip(candidate.strength*.88+exec*.12,0,100),
      plan=structuralExitPlan(candidate,stopRate,targetRate),region=s.regions[candidate.symbol];
    out.push({id:`shock-${candidate.eventId}-${candidate.symbol}`,symbol:candidate.symbol,side:candidate.side,mode:"SHOCK",premium:true,reserve:false,
      score,eligible:score>=78&&stopRate>=.002&&stopRate<=.03&&net>ROUND_TRIP_COST*.25&&edge>=.55,
      completedAt:candidate.confirmedAt,expiresAt:now+20_000,price,stopPrice:candidate.stopPrice,targetPrice:candidate.targetPrice,stopRate,targetRate,
      directionStrength:candidate.strength,pathEfficiency:region?.outerQuality??region?.quality??0,momentumPersistence:candidate.strength,
      positionScore:95,spaceScore:100*clip(edge/2),executionScore:exec,grossRemainingSpaceRate:gross,netRemainingSpaceRate:net,
      pullbackRiskRate:pullback,edgeRatio:edge,expectedHoldMinutes:15,marketFit:candidate.marketWide?95:82,regionId:region?.id??null,
      regionQuality:region?.outerQuality??region?.quality??null,reason:candidate.reason,interruptEventId:candidate.eventId,
      interruptMarketWide:candidate.marketWide,interruptBoundary:candidate.boundary,interruptStrength:candidate.strength,
      interruptIndependent:candidate.independent,interruptConfirmation:candidate.confirmationKind,exitPlan:plan});
  }
  return out;
}
function opportunityCompare(a:Opportunity,b:Opportunity){
  return Number(b.eligible)-Number(a.eligible)||Number(b.mode==="SHOCK")-Number(a.mode==="SHOCK")
    ||Number(!b.reserve)-Number(!a.reserve)||Number(b.premium)-Number(a.premium)||b.score-a.score;
}
function bestOpportunityPerSymbol(rows:Opportunity[],compare:(a:Opportunity,b:Opportunity)=>number){
  const out:Opportunity[]=[],seen=new Set<string>();for(const row of [...rows].sort(compare)){if(seen.has(row.symbol))continue;seen.add(row.symbol);out.push(row);}return out;
}
function buildOpportunities(s:ForwardState,paths:Record<string,Candle[]>,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,now:number,allowed?:ReadonlySet<string>){
  const pulse=marketPulse(paths,now),all:Opportunity[]=[],regions:Record<string,Region>={},bySymbol=relationSupportMap(s,allowed);
  for(const[symbol,path]of Object.entries(paths)){if(allowed&&!allowed.has(symbol))continue;const rows=validPath(path,now);if(!rows)continue;
    const support=bySymbol.get(symbol)??[];
    for(const c of support)all.push(relationOpportunity(c,rows,quotes[symbol],now));
    const region=detectRegion(symbol,rows,now);if(region){regions[symbol]=region;
      all.push(...relationBackedRegionOpportunities(s,symbol,rows,minutePaths?.[symbol],quotes[symbol],now,pulse,region,support));
    }
  }
  const best=bestOpportunityPerSymbol(all,opportunityCompare);
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
  const familyId=t.entryContext?.relationFamilyId;
  if(reason!=="ACCOUNT_RESET"&&familyId&&t.entryContext?.mode!=="SHOCK")recordFamilyOutcome({state:s.familyExperiment,familyId,
    tradeId:t.id,predictedNetRate:safe(t.forecast?.remainingNetRate),realizedNetRate:net/Math.max(t.notional,1e-9),
    costRate:(t.entryFee+exitFee+funding)/Math.max(t.notional,1e-9),
    targetCapture:clip(t.favorable/Math.max(t.exitPlan?.targetRate??t.entryContext?.remainingSpaceRate??0,1e-9)),now});
  s.history.unshift(t);s.history=s.history.slice(0,HISTORY_LIMIT);event(s,now,"EXIT",t.id,`${t.symbol} ${reason} ${net>=0?"+":""}${net.toFixed(2)}U`);
}
function legacyProtectionFloor(t:Trade){
  const stopRate=Math.abs(t.entryPrice-(t.entryContext?.side==="SHORT"?Math.max(t.stopPrice,t.entryPrice):Math.min(t.stopPrice,t.entryPrice)))/t.entryPrice;
  const original=Math.max(.003,t.entryContext?.pullbackRiskRate??stopRate),r=t.favorable/original;
  const retention=r>=4?.75:r>=2?.80:r>=1?.72:r>=.5?.50:0;return t.favorable*retention;
}
function planCheckpoint(plan:RelationExitProfile,ageMin:number){
  const keys=Object.keys(plan.path).map(Number).filter(n=>Number.isFinite(n)&&n<=ageMin).sort((a,b)=>a-b);
  const minute=keys.at(-1);return minute==null?null:{minute,point:plan.path[minute as keyof typeof plan.path]!};
}
function advanceProfitFloor(t:Trade,relation:RelationEngineState["rules"][number]|undefined){
  const plan=t.exitPlan;if(!plan)return legacyProtectionFloor(t);if(t.favorable<plan.protectionActivationRate)return 0;
  const tighten=relation?.status==="DEGRADED"?.10:relation?.status==="PRESSURED"?.05:relation?.status==="RECOVERING"?.02:0;
  return t.favorable*clip(plan.retentionRate+tighten,.55,.94);
}
function manageExtremumTrades(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const closed=new Set<string>();
  for(const t of s.positions){
    if(t.entryContext?.strategyVersion!==EXTREMUM_REGIME_VERSION)continue;
    const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const state=s.extremumRegime.symbols[t.symbol],px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side),
      signed=d*(px/t.entryPrice-1),favorable=Math.max(0,signed),adverse=Math.max(0,-signed),
      ageMin=(now-t.openedAt)/60_000,stopRate=Math.max(.002,Math.abs(t.entryPrice-t.stopPrice)/t.entryPrice);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);
    t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    if(!t.firstProfitAt&&favorable>=ROUND_TRIP_COST*.6){t.firstProfitAt=now;if(t.entryContext)t.entryContext.postEntryState="CONFIRMED";}
    const survival=t.side==="LONG"?(state?.upSurvival??50):(state?.downSurvival??50),
      opposite=t.side==="LONG"?(state?.topPressure??0):(state?.bottomPressure??0),
      oppositeReady=!!state&&state.stage==="READY"&&state.candidateSide===(t.side==="LONG"?"SHORT":"LONG"),
      trendEntry=t.entryContext?.mode==="TREND_PULLBACK"||t.entryContext?.mode==="IMPULSE",
      trendDeath=trendEntry&&!!state&&state.regime==="TRANSITION"&&survival<=42&&opposite>=66
        &&(state.stage==="STRUCTURE_BREAK"||state.stage==="RECLAIM_TEST"||state.stage==="READY"),
      swingOpposite=t.entryContext?.mode==="SWING"&&oppositeReady&&opposite>=70,
      weakening=!!state&&(state.regime==="WEAKENING"||state.regime==="TRANSITION");
    const activation=Math.max(ROUND_TRIP_COST*1.35,Math.min(.007,Math.max(.0032,stopRate*.52)));
    if(t.favorable>=activation){
      const retention=trendEntry&&survival>=82&&!weakening?.76:weakening?.88:.82,
        floor=t.favorable*retention;
      if(floor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
        t.profitFloorRate=floor;const next=t.entryPrice*(1+d*floor);
        if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
          t.stopPrice=next;event(s,now,"PROTECTION",t.id,`峰谷系统利润保护提升至约${(floor*100).toFixed(2)}%`);
        }
      }
    }
    const feedbackAdverse=Math.max(ROUND_TRIP_COST*.75,Math.min(.0022,stopRate*.24)),
      noFastFeedback=ageMin>=3&&!t.firstProfitAt&&t.favorable<ROUND_TRIP_COST*.45,
      feedbackFailed=noFastFeedback&&(signed<=-feedbackAdverse||opposite>=72&&survival<=48),
      stopped=t.side==="LONG"?px<=t.stopPrice:px>=t.stopPrice,
      noProgress=ageMin>=Math.max(8,(t.expectedHoldMinutes??30)*.55)&&!t.firstProfitAt&&Math.abs(signed)<ROUND_TRIP_COST*.65,
      maxHold=ageMin>=Math.max(15,(t.exitPlan?.maxHoldMinutes??(t.expectedHoldMinutes??30)*2));
    let reason:string|null=null;
    if(stopped)reason=(t.profitFloorRate??0)>0?"PROFIT_GIVEBACK":"STRUCTURE_STOP";
    else if(feedbackFailed)reason="ENTRY_FEEDBACK_FAILED";
    else if(swingOpposite)reason="OPPOSITE_EXTREMUM";
    else if(trendDeath)reason="TREND_DEATH";
    else if(weakening&&opposite>=78&&t.favorable>=ROUND_TRIP_COST)reason="EXTREMUM_PROFIT_EXIT";
    else if(noProgress)reason="NO_PROGRESS";
    else if(maxHold)reason="MAX_HOLD";
    t.holdScore=clip(.55*survival+.25*(100-opposite)+.20*clip(50+signed/Math.max(stopRate,.001)*25,0,100),0,100);
    t.holdValue={action:reason?(t.favorable>ROUND_TRIP_COST?"EXIT_PROFIT":"EXIT_RISK"):"HOLD",
      pullbackRiskRate:stopRate,bestHoldMinutes:t.expectedHoldMinutes??30,score:t.holdScore};
    if(reason){
      if(t.entryContext&&reason==="ENTRY_FEEDBACK_FAILED")t.entryContext.postEntryState="FAILED";
      closeTrade(s,t,px,now,reason);closed.add(t.id);
    }
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}

function markAndManage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const candidates=new Map(s.opportunities.filter(o=>!isExtremumOpportunity(o)).map(o=>[o.symbol,o])),relationById=new Map(s.relationEngine.rules.map(r=>[r.id,r])),closed=new Set<string>();
  for(const t of s.positions){if(t.entryContext?.strategyVersion===EXTREMUM_REGIME_VERSION)continue;const q=quotes[t.symbol];if(!freshQuote(q,now))continue;const px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;const signed=d*(px/t.entryPrice-1),favorable=Math.max(0,signed),adverse=Math.max(0,-signed);
    t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    if(!t.firstProfitAt&&favorable>=ROUND_TRIP_COST*.6)t.firstProfitAt=now;
    const relation=t.entryContext?.relationRuleId?relationById.get(t.entryContext.relationRuleId):undefined,
      floor=advanceProfitFloor(t,relation);
    if(floor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){t.profitFloorRate=floor;const next=t.entryPrice*(1+d*floor);
      if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){t.stopPrice=next;
        event(s,now,"PROTECTION",t.id,"样本利润保护提升至约"+(floor*100).toFixed(2)+"%");}}
    const current=candidates.get(t.symbol),same=current&&current.side===t.side?current:null,opp=current&&current.side!==t.side?current:null,
      ageMin=(now-t.openedAt)/60_000,stopped=t.side==="LONG"?px<=t.stopPrice:px>=t.stopPrice,
      marketFlip=!!opp&&!opp.reserve&&opp.eligible&&opp.score>=66&&opp.score>(same?.score??0)+8;
    let reason:string|null=null;
    if(stopped)reason=(t.profitFloorRate??0)>0?"PROFIT_GIVEBACK":"STRUCTURE_STOP";
    else if(marketFlip)reason="MARKET_FLIP";
    else if(t.exitPlan){
      const plan=t.exitPlan,checkpoint=planCheckpoint(plan,ageMin),point=checkpoint?.point,
        allowance=Math.max(.0015,Math.min(plan.normalAdverseRate,point?.adverseRate??plan.normalAdverseRate)),
        expected=point?.expectedRate??0,remaining=point?.remainingEdgeRate??Infinity,
        outperforming=signed>expected+Math.max(ROUND_TRIP_COST,allowance*.40);
      if(plan.version==="sample-exit-plan-v1"){
        const noFeedback=ageMin>=plan.feedbackDeadlineMinutes&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST,
          pathDiverged=ageMin>=5&&signed<-allowance,
          relationFailure=relation?.status==="DEGRADED"&&ageMin>=5&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST,
          edgeExhausted=ageMin>=plan.bestHoldMinutes&&remaining<=ROUND_TRIP_COST*.15&&!outperforming,
          maxHold=ageMin>=plan.maxHoldMinutes,
          pathScore=clip(50+50*(signed-expected*.35)/Math.max(ROUND_TRIP_COST*2,allowance),0,100),
          relationScore=relation?relation.health*100:50;
        t.holdScore=clip(pathScore*.65+relationScore*.35,0,100);
        t.holdValue={action:pathDiverged||relationFailure?"EXIT_RISK":edgeExhausted||maxHold?"EXIT_PROFIT":"HOLD",
          pullbackRiskRate:allowance,bestHoldMinutes:plan.bestHoldMinutes,score:t.holdScore};
        if(relationFailure)reason="RELATION_DEGRADED";else if(noFeedback||pathDiverged&&!t.firstProfitAt)reason="NO_POSITIVE_FEEDBACK";
        else if(pathDiverged)reason="SAMPLE_PATH_DIVERGED";else if(edgeExhausted)reason="SAMPLE_EDGE_EXHAUSTED";else if(maxHold)reason="SAMPLE_MAX_HOLD";
      }else{
        const recovery=clip(point?.recoveryRate??.5),futureBest=point?.futureBestMinutes??plan.bestHoldMinutes,
          continuationFloor=Math.max(ROUND_TRIP_COST*.15,allowance*.12),
          continuationWeak=remaining<=continuationFloor&&recovery<.35,
          feedbackReview=ageMin>=plan.feedbackDeadlineMinutes&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST,
          pathDiverged=ageMin>=5&&signed<-allowance,
          severePathFailure=ageMin>=5&&signed<-Math.max(allowance*1.35,plan.normalAdverseRate*1.10),
          pathFailureConfirmed=pathDiverged&&(continuationWeak||recovery<.25),
          noFeedbackConfirmed=feedbackReview&&continuationWeak,
          relationFailure=relation?.status==="DEGRADED"&&ageMin>=5&&!t.firstProfitAt&&(continuationWeak||severePathFailure),
          edgeExhausted=ageMin>=plan.bestHoldMinutes&&remaining<=continuationFloor&&recovery<.45&&!outperforming,
          maxHold=ageMin>=plan.maxHoldMinutes,
          pathScore=clip(50+50*(signed-expected*.35)/Math.max(ROUND_TRIP_COST*2,allowance),0,100),
          continuationScore=clip(50+50*remaining/Math.max(ROUND_TRIP_COST,allowance),0,100),
          relationScore=relation?relation.health*100:50;
        t.holdScore=clip(pathScore*.45+relationScore*.25+continuationScore*.20+recovery*10,0,100);
        t.holdValue={action:severePathFailure||pathFailureConfirmed||relationFailure||noFeedbackConfirmed?"EXIT_RISK":
          edgeExhausted||maxHold?"EXIT_PROFIT":"HOLD",pullbackRiskRate:allowance,bestHoldMinutes:futureBest,score:t.holdScore};
        if(severePathFailure||pathFailureConfirmed)reason="SAMPLE_PATH_DIVERGED";
        else if(relationFailure)reason="RELATION_DEGRADED";
        else if(noFeedbackConfirmed)reason="NO_POSITIVE_FEEDBACK";
        else if(edgeExhausted)reason="SAMPLE_EDGE_EXHAUSTED";
        else if(maxHold)reason="SAMPLE_MAX_HOLD";
      }
    } else {
      // Drain pre-v3 positions under their frozen legacy lifecycle; no strategy
      // migration may reinterpret an already mirrored PAPER/LIVE position.
      const expected=t.expectedHoldMinutes??30,feedback=t.firstProfitAt?10:ageMin>6?-12:0,
        relationPenalty=relation?.status==="DEGRADED"?20:relation?.status==="PRESSURED"?10:0;
      t.holdScore=clip((same?.score??42)*.65+feedback-relationPenalty,0,100);
      t.holdValue={action:t.holdScore<30?"EXIT_RISK":"HOLD",pullbackRiskRate:t.entryContext?.pullbackRiskRate??.01,bestHoldMinutes:expected,score:t.holdScore};
      const relationFailure=relation?.status==="DEGRADED"&&ageMin>=Math.max(5,expected*.20)&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST,
        timeFailure=ageMin>=Math.max(8,expected*.65)&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST,
        hardTime=ageMin>=expected*2.5&&favorable<Math.max(.003,t.adverse*.5);
      if(relationFailure)reason="RELATION_DEGRADED";else if(timeFailure)reason="NO_POSITIVE_FEEDBACK";else if(hardTime)reason="TIME_DECAY";
    }
    if(!reason){
      const shockTrack=s.structuralInterrupt.tracks[t.symbol],
        interrupt=shockTrack?.phase==="CONFIRMED"&&now-shockTrack.lastAt<=12_000&&shockTrack.side!==t.side,
        fastMode=t.entryContext?.mode==="BREAKOUT"||t.entryContext?.mode==="RETEST"||t.entryContext?.mode==="SHOCK",
        fastAdverse=Math.max(ROUND_TRIP_COST*.8,Math.min((t.entryContext?.pullbackRiskRate??.01)*.25,.0025)),
        interruptBoundary=t.entryContext?.interruptBoundary??null,
        shockReentry=t.entryContext?.mode==="SHOCK"&&interruptBoundary!=null&&ageMin>=.08
          &&(t.side==="LONG"?px<=interruptBoundary:px>=interruptBoundary),
        fastFailure=fastMode&&ageMin>=.25&&!t.firstProfitAt&&favorable<ROUND_TRIP_COST*.6&&signed<=-fastAdverse;
      if(interrupt)reason="STRUCTURAL_INTERRUPT_REVERSAL";else if(shockReentry)reason="SHOCK_REENTRY";else if(fastFailure)reason="FAST_STRUCTURE_FAILURE";
    }
    if(reason){closeTrade(s,t,px,now,reason);if(relation&&t.exitPlan&&isFamilyFailure(reason,t.firstProfitAt)){
        const familyId=t.entryContext?.relationFamilyId??relationFamilyId(relation);
        if(familyId)recordFamilyFailure({state:s.familyExperiment,familyId,sourceRuleId:t.entryContext?.relationRuleId,
          evidenceAt:t.entryContext?.relationEvidenceAt,health:t.entryContext?.relationHealth,livePathScore:t.entryContext?.relationLivePathScore,
          now,reason:reason as "RELATION_DEGRADED"|"NO_POSITIVE_FEEDBACK"|"STRUCTURE_STOP"|"SAMPLE_PATH_DIVERGED",symbol:t.symbol});}
      closed.add(t.id);}
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}
function candidateRiskRate(o:Opportunity){
  if(o.mode==="SHOCK")return SHOCK_TRADE_RISK_RATE;
  if(o.reserve)return .003;
  const base=o.mode==="RANGE"?.006:o.premium?.009:.008;
  return clip(base*clip(o.riskScale??1,.75,1),.006,.009);
}
const riskCharge=(t:Trade)=>Math.max(t.plannedRisk,t.entryContext?.portfolioRiskCharge??((t.forecast?.sizingEquity??0)*(t.entryContext?.reserve===true?.003:.006)));
function existingRisk(s:ForwardState,side?:"LONG"|"SHORT"){return s.positions.filter(t=>!side||t.side===side).reduce((n,t)=>n+riskCharge(t),0);}
function probeRisk(s:ForwardState){return s.positions.filter(t=>t.entryContext?.reserve===true).reduce((n,t)=>n+riskCharge(t),0);}
function tradeFamilyId(s:ForwardState,t:Trade){
  if(t.entryContext?.relationFamilyId)return t.entryContext.relationFamilyId;
  const rule=t.entryContext?.relationRuleId?s.relationEngine.rules.find(r=>r.id===t.entryContext?.relationRuleId):undefined;
  return rule?relationFamilyId(rule):null;
}
function familyRisk(s:ForwardState,familyId:string){return s.positions.reduce((n,t)=>tradeFamilyId(s,t)===familyId?n+riskCharge(t):n,0);}
function openReserveFamilyIds(s:ForwardState){return new Set(s.positions.filter(t=>t.entryContext?.reserve===true)
  .map(t=>tradeFamilyId(s,t)).filter((x):x is string=>!!x));}
function cycleRiskAdded(s:ForwardState,since:number){return[...s.positions,...s.history].filter(t=>t.openedAt>=since).reduce((n,t)=>n+riskCharge(t),0);}
function reserveEntriesThisCycle(s:ForwardState){return[...s.positions,...s.history]
  .filter(t=>t.openedAt>=s.lastCandleAt&&t.entryContext?.reserve===true).length;}
function shockEntriesForEvent(s:ForwardState,eventId:string){
  return[...s.positions,...s.history].filter(t=>t.entryContext?.interruptEventId===eventId).length;
}
function shockRiskForEvent(s:ForwardState,eventId:string){
  return s.positions.filter(t=>t.entryContext?.interruptEventId===eventId).reduce((n,t)=>n+riskCharge(t),0);
}
function qualityBlockReason(s:ForwardState,o:Opportunity,equity:number){
  if(!(equity>0))return"账户权益无效";
  if(o.mode==="SHOCK"){
    if(!o.interruptEventId)return"突变事件身份缺失";
    if(shockEntriesForEvent(s,o.interruptEventId)>=MAX_SHOCK_ENTRIES_PER_EVENT)return"同一突变事件已完成最大参与数量";
    if(shockEntriesForEvent(s,o.interruptEventId)>=1&&!(o.interruptIndependent&&o.score>=90))return"同一市场冲击默认只参与最优标的";
    if(shockRiskForEvent(s,o.interruptEventId)>=equity*SHOCK_EVENT_RISK_RATE-equity*.0005)return"同一突变事件风险池已满";
    return null;
  }
  const use=existingRisk(s)/equity,health=o.relationHealth??0;
  if(o.reserve){
    if(reserveEntriesThisCycle(s)>=MAX_NEW_RESERVE_EXPERIMENTS_PER_5M)return"本5分钟探测实验额度已满";
    if(use>=.05)return"探测仓只在组合风险低于5%时新增";
    if(probeRisk(s)>=equity*PROBE_RISK_POOL_RATE-equity*.0005)return"探测风险池已满";
    return null;
  }
  if(use>=.09&&(o.score<86||health<.84))return"高风险占用下只接受顶级成熟关系";
  if(use>=.08&&(o.score<80||health<.78))return"风险占用超过8%，候选质量不足";
  if(use>=.06&&(o.score<72||health<.70))return"风险占用超过6%，候选质量不足";
  return null;
}
function strongImmediateEntry(s:ForwardState,o:Opportunity){
  if(o.mode!=="RELATION")return false;
  const rule=o.relationRuleId?s.relationEngine.rules.find(r=>r.id===o.relationRuleId):undefined,
    calibration=familyCalibration(s.familyExperiment,rule?relationFamilyId(rule):undefined);
  return !calibration.requiresValidation&&o.score>=82&&o.netRemainingSpaceRate>=.0045&&o.edgeRatio>=.65
    &&(o.relationHealth??0)>=.64&&(rule?.livePathScore??0)>=.60&&o.marketFit>=65;
}
function entryValidationReason(s:ForwardState,o:Opportunity,q:Quote,now:number){
  if(o.mode==="SHOCK"||strongImmediateEntry(s,o))return null;
  const rule=o.relationRuleId?s.relationEngine.rules.find(r=>r.id===o.relationRuleId):undefined,
    calibration=familyCalibration(s.familyExperiment,rule?relationFamilyId(rule):undefined),id=o.id,
    price=o.side==="LONG"?q.bestAsk:q.bestBid,d=dir(o.side),windowMs=o.reserve||calibration.requiresValidation?24_000:12_000;
  const row=s.entryValidations[id];
  if(!row){s.entryValidations[id]={id,candidateId:o.id,symbol:o.symbol,side:o.side,startedAt:now,
      expiresAt:o.expiresAt,deadlineAt:Math.min(o.expiresAt,now+windowMs),initialPrice:price,lastPrice:price,lastQuoteAt:q.observedAt,samples:1,
      bestAdvanceRate:0,maxAdverseRate:0,status:"WAITING",reason:null};
    return calibration.requiresValidation?"实际成交校准要求短时正反馈":"等待秒级入场正反馈";
  }
  if(row.status==="CANCELLED")return row.reason??"本次入场验证已取消";
  if(q.observedAt>row.lastQuoteAt){const signed=d*(price/row.initialPrice-1);row.lastPrice=price;row.lastQuoteAt=q.observedAt;row.samples++;
    row.bestAdvanceRate=Math.max(row.bestAdvanceRate,signed);row.maxAdverseRate=Math.max(row.maxAdverseRate,-signed);}
  const elapsed=now-row.startedAt,adverseLimit=Math.max(.0007,Math.min(.0020,o.pullbackRiskRate*.22)),region=s.regions[o.symbol],
    outerUpper=region?.outerUpper??region?.upper,outerLower=region?.outerLower??region?.lower,
    returnedToRegion=(o.mode==="BREAKOUT"||o.mode==="RETEST")&&region!=null
      &&(o.side==="LONG"&&outerUpper!=null&&price<=outerUpper||o.side==="SHORT"&&outerLower!=null&&price>=outerLower);
  if(returnedToRegion||row.maxAdverseRate>=adverseLimit){row.status="CANCELLED";row.reason=returnedToRegion?"入场前重新回到结构区域":"入场前出现反向吞没";return row.reason;}
  const progressFloor=Math.max(.00025,Math.min(.0006,o.netRemainingSpaceRate*.12));
  if(elapsed>=4_000&&row.samples>=3&&row.bestAdvanceRate>=progressFloor){delete s.entryValidations[id];return null;}
  if(now>=row.deadlineAt){row.status="CANCELLED";row.reason="验证窗口内未获得方向推进";return row.reason;}
  return `等待秒级入场正反馈（${Math.ceil((row.deadlineAt-now)/1000)}秒）`;
}
function isExtremumOpportunity(o:Opportunity){return o.strategyVersion===EXTREMUM_REGIME_VERSION;}

function openExtremumTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number){
  if(!isExtremumOpportunity(o))return"新策略身份缺失";
  const side=o.side,d=dir(side),price=side==="LONG"?q.bestAsk:q.bestBid,stopRate=o.stopRate;
  if(!(stopRate>=.002&&stopRate<=.03))return"结构止损宽度不合理";
  const totalHeadroom=equity*(TOTAL_RISK_RATE-.001)-existingRisk(s),
    sideHeadroom=equity*(SIDE_RISK_RATE-.0005)-existingRisk(s,side),
    cycleHeadroom=equity*FIVE_MINUTE_NEW_RISK_RATE-cycleRiskAdded(s,s.lastCandleAt),
    headroom=Math.min(totalHeadroom,sideHeadroom,cycleHeadroom);
  const riskRate=o.mode==="TREND_PULLBACK"?.008:o.mode==="IMPULSE"?.0075:.007,
    wantedRisk=equity*riskRate,riskBudget=Math.min(wantedRisk,headroom);
  if(riskBudget<equity*.004)return"剩余风险预算不足以形成有效仓位";
  const rawNotional=riskBudget/(stopRate+ROUND_TRIP_COST),
    targetNotional=Math.min(rawNotional,equity*(o.mode==="IMPULSE"?.55:.65)),
    leverage=Math.max(1,Math.min(10,Math.floor(contract.leverageMax||10))),
    mult=Math.max(contract.quantoMultiplier,1e-12),
    minContracts=Math.max(1,Math.ceil(contract.minContracts??(Number(contract.orderSizeMin??1)||1))),
    contracts=Math.floor(targetNotional/(price*mult));
  if(contracts<minContracts)return"低于最小模拟合约数量";
  const quantity=contracts*mult,notional=quantity*price,margin=notional/leverage,
    totalMargin=s.positions.reduce((n,t)=>n+t.margin,0);
  if(totalMargin+margin>equity*TOTAL_MARGIN_RATE)return"组合保证金已满";
  const consumed=Math.max(0,d*(price/Math.max(o.price,1e-9)-1)),remainingNet=o.netRemainingSpaceRate-consumed;
  if(remainingNet<=0)return"实时入场已消耗剩余空间";
  const sourceExitPlan=o.exitPlan;if(!sourceExitPlan)return"缺少冻结退出计划";
  const exitPlan=consumeExitPlan(sourceExitPlan,consumed),
    plannedRisk=notional*(stopRate+ROUND_TRIP_COST),entryFee=notional*PAPER_COST.feeRate,
    stopPrice=price*(1-d*stopRate),target=price*(1+d*Math.max(.003,exitPlan.targetRate)),
    horizon=Math.max(5,Math.round(exitPlan.bestHoldMinutes)),
    id=`ft-${now.toString(36)}-${o.symbol.replace(/[^A-Z0-9]/g,"")}-${side[0]}-${o.mode[0]}`,
    ruleId=`extremum-${o.mode.toLowerCase()}-${o.symbol}`,
    rule:Rule={id:ruleId,signature:`EXTREMUM_REGIME:${o.regime??"UNKNOWN"}:${o.mode}`,parentId:null,version:1,createdAt:now,
      expiresAt:now+exitPlan.maxHoldMinutes*60_000,status:"EXPERIMENTAL",conditions:[],side,horizon,stopRate,
      armRate:exitPlan.protectionActivationRate,givebackRate:Math.max(.001,exitPlan.targetRate*(1-exitPlan.retentionRate)),
      exitMode:"REACTION_DECAY",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:remainingNet,priorResponse:null,
      recentResponse:0,standardError:0,reason:o.reason,mutation:"CREATE",grammar:EXTREMUM_REGIME_VERSION,liveEligible:false,
      authority:"ADAPTIVE_TEN",turnTimeframe:"5m"},
    t:Trade={id,symbol:o.symbol,side,rule,openedAt:now,closedAt:null,status:"OPEN",entryPrice:price,exitPrice:null,quantity,contracts,
      quantoMultiplier:mult,notional,leverage,margin,plannedRisk,stopPrice,armPrice:target,favorable:0,adverse:0,lastPrice:price,
      lastQuoteAt:q.observedAt,entryFee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
      execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,firstProfitAt:null,holdScore:o.score,profitFloorRate:0,expectedHoldMinutes:exitPlan.bestHoldMinutes,
      exitPlan,peakPnlRate:0,exitControl:{policy:EXTREMUM_REGIME_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:"adaptive-ten-entry-v1",capturedAt:now,timeframe:"5m",side,mode:o.mode,reserve:false,reason:o.reason,
        entryScore:o.score,directionStrength:o.directionStrength,spaceScore:o.spaceScore,positionScore:o.positionScore,executionScore:o.executionScore,
        remainingSpaceRate:remainingNet,pullbackRiskRate:o.pullbackRiskRate,edgeRatio:remainingNet/Math.max(o.pullbackRiskRate,1e-9),
        expectedHoldMinutes:exitPlan.bestHoldMinutes,marketFit:o.marketFit,regionId:null,portfolioRiskCharge:riskBudget,
        strategyVersion:EXTREMUM_REGIME_VERSION,regime:o.regime,topPressure:o.topPressure,bottomPressure:o.bottomPressure,
        upSurvival:o.upSurvival,downSurvival:o.downSurvival,confirmationStage:o.confirmationStage,sourceCount:o.sourceCount,
        disagreementRate:o.disagreementRate,postEntryState:"PENDING"},
      forecast:{remainingNetRate:remainingNet,quality:o.score/100,sizingEquity:equity}};
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;
  event(s,now,"ENTRY",id,`${o.symbol} ${side} ${o.mode} 评分${o.score.toFixed(0)}`,{notional,plannedRisk});
  return null;
}

function openAuthorityTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number){
  return isExtremumOpportunity(o)?openExtremumTrade(s,o,q,contract,now,equity):openTrade(s,o,q,contract,now,equity);
}

function openTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number){
  const side=o.side,d=dir(side),price=side==="LONG"?q.bestAsk:q.bestBid,isShock=o.mode==="SHOCK";
  if(!isShock&&!o.relationRuleId)return"缺少Forward关系授权";
  const authorityRule=o.relationRuleId?s.relationEngine.rules.find(r=>r.id===o.relationRuleId):undefined;
  if(!isShock&&!authorityRule)return"Forward关系证据已更新，等待下一轮";
  const familyId=authorityRule?relationFamilyId(authorityRule):null;
  if(authorityRule){
    const familyBlock=familyAdmissionBlock({state:s.familyExperiment,rule:authorityRule,
      allRules:s.relationEngine.rules,reserve:o.reserve===true,openFamilyIds:openReserveFamilyIds(s),netRate:o.netRemainingSpaceRate,
      edgeRatio:o.edgeRatio,roundTripCost:ROUND_TRIP_COST});
    if(familyBlock)return familyBlock;
  }
  const qualityBlock=qualityBlockReason(s,o,equity);if(qualityBlock)return qualityBlock;
  // Analysis can come from Bybit/OKX/KuCoin. Only relative structure may cross
  // venues; all executable prices are re-anchored to the actual Gate quote.
  const stopRate=Number.isFinite(o.stopRate)?o.stopRate:Math.abs(o.price-o.stopPrice)/Math.max(o.price,1e-9);
  if(!(stopRate>=.002&&stopRate<=.03))return"结构止损宽度不合理";
  const totalHeadroom=equity*(TOTAL_RISK_RATE-.001)-existingRisk(s),sideHeadroom=equity*(SIDE_RISK_RATE-.0005)-existingRisk(s,side),
    familyHeadroom=familyId?equity*FAMILY_RISK_CAP_RATE-familyRisk(s,familyId):Infinity,
    shockHeadroom=isShock&&o.interruptEventId?equity*SHOCK_EVENT_RISK_RATE-shockRiskForEvent(s,o.interruptEventId):Infinity,
    probeHeadroom=o.reserve?equity*PROBE_RISK_POOL_RATE-probeRisk(s):Infinity,
    cycleHeadroom=equity*FIVE_MINUTE_NEW_RISK_RATE-cycleRiskAdded(s,s.lastCandleAt);
  const headroom=Math.min(totalHeadroom,sideHeadroom,familyHeadroom,shockHeadroom,probeHeadroom,cycleHeadroom);
  const wantedRisk=equity*candidateRiskRate(o);if(headroom<=equity*.001)return"风险预算已满";
  const riskBudget=Math.min(wantedRisk,headroom),minCharge=equity*(isShock?SHOCK_MIN_CHARGE_RATE:o.reserve?PROBE_MIN_CHARGE_RATE:PRIMARY_MIN_CHARGE_RATE);
  if(riskBudget<minCharge)return o.reserve?"剩余探测预算不足以形成有效仓位":"剩余组合预算不足以形成有效主仓";
  const rawNotional=riskBudget/(stopRate+ROUND_TRIP_COST);
  const notionalCap=equity*(o.premium?.70:.60),targetNotional=Math.min(rawNotional,notionalCap);
  const leverage=Math.max(1,Math.min(10,Math.floor(contract.leverageMax||10))),mult=Math.max(contract.quantoMultiplier,1e-12);
  const minContracts=Math.max(1,Math.ceil(contract.minContracts??(Number(contract.orderSizeMin??1)||1)));
  const contracts=Math.floor(targetNotional/(price*mult));if(contracts<minContracts)return"低于最小模拟合约数量";
  const quantity=contracts*mult,notional=quantity*price,margin=notional/leverage,totalMargin=s.positions.reduce((n,t)=>n+t.margin,0);
  if(totalMargin+margin>equity*TOTAL_MARGIN_RATE)return"组合保证金已满";
  const consumed=Math.max(0,d*(price/Math.max(o.price,1e-9)-1)),remainingNet=o.netRemainingSpaceRate-consumed;
  if(!isShock&&remainingNet<=0)return"实时入场已消耗样本剩余优势";
  const sourceExitPlan=o.exitPlan??authorityRule?.exitProfile;if(!sourceExitPlan)return"缺少冻结退出计划";
  const plannedRisk=notional*(stopRate+ROUND_TRIP_COST),entryFee=notional*PAPER_COST.feeRate,
    exitPlan=consumeExitPlan(sourceExitPlan,consumed);
  const stopPrice=price*(1-d*stopRate),target=price*(1+d*Math.max(isShock?ROUND_TRIP_COST*1.25:.003,exitPlan.targetRate)),
    horizon=Math.max(5,Math.round(exitPlan.bestHoldMinutes)),id=`ft-${now.toString(36)}-${o.symbol.replace(/[^A-Z0-9]/g,"")}-${side[0]}-${o.mode[0]}`;
  const ruleId=o.relationRuleId??`structural-interrupt-${o.interruptEventId??now}`;
  const rule:Rule={id:ruleId,signature:o.relationRuleId??`STRUCTURAL_INTERRUPT:${o.interruptEventId??o.symbol}`,parentId:null,version:1,createdAt:now,
    expiresAt:now+exitPlan.maxHoldMinutes*60_000,status:"EXPERIMENTAL",conditions:[],side,horizon,stopRate,
    armRate:exitPlan.protectionActivationRate,givebackRate:Math.max(.001,exitPlan.targetRate*(1-exitPlan.retentionRate)),
    exitMode:"REACTION_DECAY",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:remainingNet,priorResponse:null,
    recentResponse:0,standardError:0,reason:o.reason,mutation:"CREATE",grammar:ADAPTIVE_ENGINE_VERSION,liveEligible:false,
    authority:isShock?"STRUCTURAL_INTERRUPT":"FORWARD_RELATION",turnTimeframe:"5m"};
  const region=o.regionId?s.regions[o.symbol]:null;
  const scale=o.price>0?price/o.price:1;
  const t:Trade={id,symbol:o.symbol,side,rule,openedAt:now,closedAt:null,status:"OPEN",entryPrice:price,exitPrice:null,quantity,contracts,
    quantoMultiplier:mult,notional,leverage,margin,plannedRisk,stopPrice,armPrice:target,favorable:0,adverse:0,lastPrice:price,
    lastQuoteAt:q.observedAt,entryFee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,firstProfitAt:null,holdScore:o.score,profitFloorRate:0,expectedHoldMinutes:exitPlan.bestHoldMinutes,
    exitPlan,peakPnlRate:0,exitControl:{policy:ADAPTIVE_ENGINE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},entryContext:{version:"adaptive-ten-entry-v1",capturedAt:now,timeframe:"5m",side,mode:o.mode,reserve:o.reserve===true,reason:o.reason,entryScore:o.score,
      directionStrength:o.directionStrength,spaceScore:o.spaceScore,positionScore:o.positionScore,executionScore:o.executionScore,
      remainingSpaceRate:remainingNet,pullbackRiskRate:o.pullbackRiskRate,edgeRatio:remainingNet/Math.max(o.pullbackRiskRate,1e-9),expectedHoldMinutes:exitPlan.bestHoldMinutes,
      marketFit:o.marketFit,regionId:o.regionId,relationRuleId:o.relationRuleId,relationStatus:o.relationStatus,relationHorizon:o.relationHorizon,
      relationHealth:o.relationHealth,portfolioRiskCharge:riskBudget,
      ...(familyId?{relationFamilyId:familyId}:{}),...(authorityRule?{relationEvidenceAt:authorityRule.lastQualifiedAt,relationLivePathScore:authorityRule.livePathScore}:{}),
      ...(o.interruptEventId?{interruptEventId:o.interruptEventId,interruptMarketWide:o.interruptMarketWide===true,
        interruptBoundary:o.interruptBoundary,interruptStrength:o.interruptStrength}:{}),
      ...(region?{regionLower:region.lower*scale,regionUpper:region.upper*scale,regionCenter:region.center*scale}:{})},
    forecast:{remainingNetRate:remainingNet,quality:o.score/100,sizingEquity:equity}};
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;
  event(s,now,"ENTRY",id,`${o.symbol} ${side} ${o.mode} 评分${o.score.toFixed(0)}`,{notional,plannedRisk});
  return null;
}
function rankedEligible(s:ForwardState,now:number){
  return s.opportunities.filter(o=>o.eligible&&o.expiresAt>now&&!s.positions.some(t=>t.symbol===o.symbol)).sort(opportunityCompare);
}
function rotateIfNeeded(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,equity:number){
  const candidate=rankedEligible(s,now).find(o=>!o.reserve);if(!candidate)return false;
  if(candidate.mode!=="SHOCK"&&now-s.lastRotationAt<ROTATION_COOLDOWN_MS)return false;
  const totalRisk=existingRisk(s),totalMargin=s.positions.reduce((n,t)=>n+t.margin,0),sideRisk=existingRisk(s,candidate.side);
  const totalFull=equity>0&&totalRisk>=equity*(TOTAL_RISK_RATE-.006),sideFull=equity>0&&sideRisk>=equity*(SIDE_RISK_RATE-.004),
    marginFull=equity>0&&totalMargin>=equity*(TOTAL_MARGIN_RATE-.05);
  if(!totalFull&&!sideFull&&!marginFull)return false;
  const pool=sideFull?s.positions.filter(t=>t.side===candidate.side):s.positions;
  const weak=[...pool].sort((a,b)=>(a.holdScore??50)-(b.holdScore??50))[0];if(!weak)return false;
  const weakScore=weak.holdScore??50;if(candidate.score<weakScore+ROTATION_GAP)return false;
  const qOld=quotes[weak.symbol],qNew=quotes[candidate.symbol],meta=contracts[candidate.symbol];
  if(!freshQuote(qOld,now)||!freshQuote(qNew,now)||qNew!.entryReady!==true||!meta)return false;
  if(!isExtremumOpportunity(candidate)&&entryValidationReason(s,candidate,qNew!,now))return false;
  const probe=structuredClone(s),probeWeak=probe.positions.find(t=>t.id===weak.id);if(!probeWeak)return false;
  closeTrade(probe,probeWeak,probeWeak.side==="LONG"?qOld!.bestBid:qOld!.bestAsk,now,"OPPORTUNITY_REPLACED");
  probe.positions=probe.positions.filter(t=>t.id!==probeWeak.id);
  if(openAuthorityTrade(probe,candidate,qNew!,meta,now,equity))return false;
  closeTrade(s,weak,weak.side==="LONG"?qOld!.bestBid:qOld!.bestAsk,now,"OPPORTUNITY_REPLACED");s.positions=s.positions.filter(t=>t.id!==weak.id);
  const err=openAuthorityTrade(s,candidate,qNew!,meta,now,equity);if(err)throw new Error(`换仓预检通过但正式开仓失败：${err}`);
  s.lastRotationAt=now;event(s,now,"ROTATION",candidate.symbol,`${weak.symbol} → ${candidate.symbol}，优势差${(candidate.score-weakScore).toFixed(0)}分`);
  return true;
}
export function fillForwardPortfolio(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,equity:number,premiumOnly:boolean){
  const eligible=rankedEligible(s,now).filter(o=>!premiumOnly||o.premium||s.entryValidations[o.id]?.status==="WAITING");
  // This is a current-state blocker view, not a retry counter. One candidate can
  // contribute at most once per execution pass, so the UI can never show
  // hundreds of fake "failures" from the same waiting opportunity.
  s.entryDiagnostics={at:now,matched:eligible.length,opened:0,reasons:{}};
  let opened=0;const reject=(reason:string)=>{s.entryDiagnostics.reasons[reason]=(s.entryDiagnostics.reasons[reason]??0)+1;};
  for(const o of eligible){
    const q=quotes[o.symbol],meta=contracts[o.symbol];if(!freshQuote(q,now)||q!.entryReady!==true){reject("等待实时盘口");continue;}
    if(!meta){reject("等待合约规格");continue;}
    const interruptBlock=isExtremumOpportunity(o)||o.mode==="SHOCK"?null:structuralInterruptBlockReason(s.structuralInterrupt,o.symbol,o.side,now);
    if(interruptBlock){reject(interruptBlock);continue;}
    const last=s.lastExitAt[o.symbol]??0,lastSide=s.lastSide[o.symbol],
      cooldown=o.mode==="SHOCK"&&lastSide&&lastSide!==o.side?0:lastSide&&lastSide!==o.side?5*60_000:8*60_000;
    if(now-last<(isExtremumOpportunity(o)?90_000:cooldown)){reject("同币短时防抖");continue;}
    if(!isExtremumOpportunity(o)){const validation=entryValidationReason(s,o,q!,now);if(validation){reject(validation);continue;}}
    const error=openAuthorityTrade(s,o,q!,meta,now,equity);if(error){reject(error);continue;}opened++;
  }
  s.entryDiagnostics.opened=opened;return opened;
}
function nextCandleAt(paths:Record<string,Candle[]>,now:number){
  let latest=0;for(const p of Object.values(paths)){const a=validPath(p,now);if(a)latest=Math.max(latest,(a.at(-1)!.time+300)*1000);}return latest;
}
export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;minutePaths?:Record<string,Candle[]>;daily?:Record<string,Candle[]>;
  quotes:Record<string,Quote>;contracts:Record<string,Contract>;entrySymbols?:Iterable<string>;learningSymbols?:Iterable<string>;allowDataCycle?:boolean;legacyDrainOnly?:boolean}){
  const s=normalizeForward(structuredClone(input.state),input.now),
    before=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate]),h:s.history.length,b:s.balance,r:s.revision});
  s.entryValidations={};s.lastQuoteCycleAt=input.now;
  const allowed=input.entrySymbols?new Set(input.entrySymbols):undefined,
    candleAt=nextCandleAt(input.paths,input.now),
    dataDue=input.allowDataCycle!==false&&candleAt>s.lastCandleAt,
    built=buildExtremumRegime({paths:input.paths,minutePaths:input.minutePaths,quotes:input.quotes,
      previous:s.extremumRegime,now:input.now,allowed});
  s.extremumRegime=built.state;s.marketPulse=built.pulse;s.opportunities=built.opportunities;
  if(dataDue){s.lastCandleAt=candleAt;s.lastCycleAt=input.now;}
  s.selectedSymbols=Object.values(s.extremumRegime.symbols).sort((a,b)=>b.watchScore-a.watchScore).slice(0,30).map(row=>row.symbol);

  manageExtremumTrades(s,input.quotes,input.now);
  // Positions opened before cutover keep their frozen lifecycle and cannot gain
  // new-entry authority from the retired relation/region/interrupt stack.
  markAndManage(s,input.quotes,input.now);

  const mark=equityMark(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));updateDaily(s,input.now,mark.equity);
  rotateIfNeeded(s,input.quotes,input.contracts,input.now,mark.equity);
  const opened=fillForwardPortfolio(s,input.quotes,input.contracts,input.now,mark.equity,false);

  const states=Object.values(s.extremumRegime.symbols),trendUp=states.filter(x=>x.regime==="TREND_UP").length,
    trendDown=states.filter(x=>x.regime==="TREND_DOWN").length,swing=states.filter(x=>x.regime==="SWING").length,
    transition=states.filter(x=>x.regime==="TRANSITION"||x.regime==="WEAKENING").length,
    totalRisk=existingRisk(s),riskUse=mark.equity>0?100*totalRisk/mark.equity:0;
  s.fitDiagnostics={tested:states.length,qualified:s.opportunities.filter(o=>o.eligible).length,trainGroups:0,checkGroups:0,
    latestAt:input.now,rapidQualified:s.opportunities.filter(o=>o.confirmationStage==="READY").length,activeLong:trendUp,activeShort:trendDown};
  s.latestReason=`峰谷状态系统：趋势多 ${trendUp} · 趋势空 ${trendDown} · 震荡 ${swing} · 弱化/切换 ${transition}；`
    +`当前${s.positions.length}笔持仓，${s.opportunities.filter(o=>o.eligible).length}个可参与机会，计划风险已用${riskUse.toFixed(1)}%。`;
  if(opened)s.latestReason+=` 本轮新开${opened}笔。`;
  const after=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate]),h:s.history.length,b:s.balance,r:s.revision});
  return{state:s,changed:before!==after||dataDue,protectionChanged:input.state.positions.some(t=>s.positions.find(n=>n.id===t.id)?.stopPrice!==t.stopPrice)};
}
export function closeForwardForReset(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const s=normalizeForward(structuredClone(state),now);for(const t of [...s.positions]){const q=quotes[t.symbol],px=freshQuote(q,now)?(t.side==="LONG"?q!.bestBid:q!.bestAsk):t.lastPrice;closeTrade(s,t,px,now,"ACCOUNT_RESET");}
  s.positions=[];return s;
}
export function resetForwardAccountPreservingLearning(previous:ForwardState,now:number){
  const prior=normalizeForward(structuredClone(previous),now),next=initialForward(now);
  next.relationEngine=structuredClone(prior.relationEngine);
  next.familyExperiment=structuredClone(prior.familyExperiment);
  next.observations=next.relationEngine.observations;next.measured=next.relationEngine.measured;next.invalidated=next.relationEngine.invalidated;
  next.latestReason="模拟账户已重置为1000U；峰谷状态策略重新从当前真实市场结构开始判断，历史账户与研究证据未被删除。";
  return next;
}
export function forwardUrgentQuoteSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):null,keep=(x:string)=>!allowed||allowed.has(x);
  const premium=s.opportunities.filter(o=>o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort((a,b)=>b.score-a.score);
  const normal=s.opportunities.filter(o=>!o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort((a,b)=>b.score-a.score);
  const watched=Object.values(s.extremumRegime.symbols).filter(r=>keep(r.symbol)&&r.watchScore>=58).sort((a,b)=>b.watchScore-a.watchScore);
  return[...new Set([...s.positions.map(t=>t.symbol),...premium.map(o=>o.symbol),...normal.map(o=>o.symbol),...watched.map(r=>r.symbol)])];
}
export function forwardUrgentMinuteSymbols(s:ForwardState,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):undefined;
  return extremumUrgentMinuteSymbols(s.extremumRegime,allowed).slice(0,FORWARD_MINUTE_CONFIRMATION_CAP);
}
export function forwardWatchSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  return forwardUrgentQuoteSymbols(s,now,entrySymbols).slice(0,FORWARD_EXECUTION_BBO_CAP);
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const mark=equityMark(s,quotes,now),eligible=s.opportunities.filter(o=>o.eligible&&o.expiresAt>now),reserve=eligible.filter(o=>o.reserve),
    rows=Object.values(s.extremumRegime.symbols).sort((a,b)=>b.watchScore-a.watchScore),
    counts={trendUp:rows.filter(r=>r.regime==="TREND_UP").length,trendDown:rows.filter(r=>r.regime==="TREND_DOWN").length,
      swing:rows.filter(r=>r.regime==="SWING").length,weakening:rows.filter(r=>r.regime==="WEAKENING").length,
      transition:rows.filter(r=>r.regime==="TRANSITION").length,ready:rows.filter(r=>r.stage==="READY").length,
      impulse:rows.filter(r=>r.stage==="IMPULSE").length};
  return{version:s.version,engineVersion:ADAPTIVE_ENGINE_VERSION,grammar:ADAPTIVE_ENGINE_VERSION,mode:"REAL_FEED_PAPER",liveEligible:false,
    strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:EXTREMUM_REGIME_VERSION,
    regionLaunchVersion:EXTREMUM_REGIME_VERSION,policyVersion:ADAPTIVE_ENGINE_VERSION,exitPolicyVersion:ADAPTIVE_ENGINE_VERSION,
    policyUpgrade:null,exitPolicyUpgrade:null,startedAt:s.startedAt,cutoverAt:s.cutoverAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...mark,targetEquity:s.initialEquity*2,
    netPnl:mark.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,fees:s.fees,
    fundingAllowance:s.fundingAllowance,turnover:s.turnover,positions:s.positions,history:s.history,events:s.events,daily:s.daily,
    opportunities:s.opportunities,entryOpportunities:s.opportunities,regions:[],marketPulse:s.marketPulse,
    extremumRegime:{version:s.extremumRegime.version,updatedAt:s.extremumRegime.updatedAt,counts,symbols:rows.slice(0,30)},
    structuralInterrupt:{version:STRUCTURAL_INTERRUPT_VERSION,retired:true,marketEvent:null,vetoSide:null,vetoUntil:0,preAlerts:0,confirmed:0},
    relationEngine:{version:s.relationEngine.version,retired:true,updatedAt:s.relationEngine.updatedAt,diagnostics:s.relationEngine.diagnostics,rules:[]},
    familyExperiment:{retired:true,...familyExperimentSummary(s.familyExperiment),maxNewReservePer5m:0},
    entryValidation:{waiting:0,cancelled:0,records:[]},
    marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,entryDiagnostics:s.entryDiagnostics,
    fitDiagnostics:s.fitDiagnostics,storage:s.storage,targetPositions:null,positionLimit:null,executionBboCapacity:FORWARD_EXECUTION_BBO_CAP,
    minuteConfirmationCapacity:FORWARD_MINUTE_CONFIRMATION_CAP,seatCount:s.positions.length,eligibleCount:eligible.length,
    reserveCount:reserve.length,premiumCount:eligible.filter(o=>o.premium).length,
    boundaries:{scope:"PAPER_AUTHORITY",
      grammar:"单一峰谷状态机：5分钟决定结构与趋势生命，1分钟确认峰谷/回调结束，实时盘口负责实际执行与入场后正反馈。",
      historyBackfill:false,
      sampleMeaning:"旧Forward关系样本只作为保留研究证据，不再拥有新开仓权；新系统只根据当前真实5m/1m/多源状态做因果决策。",
      accounting:"模拟仍使用新鲜买卖价并计入手续费、滑点和资金费占位；每笔新Trade冻结完整入场、止损、仓位和退出上下文。",
      risk:"不设固定持仓席位；总结构风险≤10%、同方向≤6.5%、组合保证金≤75%，单币一仓。风险边界不因策略重做放宽。",
      validation:"TOP/BOTTOM压力和UP/DOWN趋势生命独立计算；趋势里的反向极值先负责保护利润，只有趋势死亡并完成结构破坏与夺回失败才允许反向。",
      liquidation:"硬止损→入场后即时验证→动态利润保护→相反极值/趋势死亡→无进展/最大持仓。平仓与反手是两个独立事件。"},
    cost:PAPER_COST,nextCycleAt:s.lastCandleAt+BAR_MS};
}
