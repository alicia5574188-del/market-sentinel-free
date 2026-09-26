import { familyExperimentSummary, initialFamilyExperimentState, isFamilyFailure,
  normalizeFamilyExperimentState, recordFamilyFailure, recordFamilyOutcome,
  relationFamilyId, reserveExperimentValueBlock,
  type FamilyExperimentState } from "./forward-family-experiment.ts";
import { initialRelationEngine, normalizeRelationEngine,
  type RelationCandidate, type RelationEngineState, type RelationExitProfile, type RelationStatus } from "./forward-relation-v2.ts";
import { STRUCTURAL_INTERRUPT_VERSION, initialStructuralInterruptState, normalizeStructuralInterruptState,
  type StructuralInterruptState } from "./forward-structural-interrupt.ts";
import { EXTREMUM_REGIME_VERSION, extremumExitDecision,
  type ExtremumRegimeState, type ExtremumSymbolState } from "./extremum-regime-engine.ts";
import { PREDICTIVE_PATH_POLICY, PREDICTIVE_PATH_VERSION, type PredictiveAncillary, type PredictivePathForecast } from "./predictive-path-types.ts";
import { buildPredictivePathEngine, predictiveExitDecision, type PredictiveCandidate, type PredictiveEngineState } from "./predictive-path-engine.ts";

/**
 * Forward Path Relation 3.0 — PAPER authority.
 *
 * One 5m root observation records its complete 5–60m response path. Mature
 * path evidence chooses direction, expected hold, normal adverse excursion,
 * feedback deadline and profit retention together. Region/1m logic remains
 * execution enhancement, never a second directional authority.
 */
export const FORWARD_VERSION="forward-relations-v1.0";
export const ADAPTIVE_ENGINE_VERSION=PREDICTIVE_PATH_VERSION;
export const FORWARD_EXECUTION_BBO_CAP=30;
export const FORWARD_MINUTE_CONFIRMATION_CAP=11;
export const BAR_MS=300_000;
export const FEATURES=["5分钟方向","路径效率","剩余空间","位置质量","回调风险","1分钟确认","区域质量","入场后反馈"] as const;
export const PAPER_COST={feeRate:.0007,slippageRate:.00025,fundingAllowancePerDay:.0002,
  assumption:"双边吃单费各7bp＋滑点各2.5bp＋每日2bp不利资金费占位"};
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const TOTAL_RISK_RATE=.10,SIDE_RISK_RATE=.065,TOTAL_MARGIN_RATE=.75;
const FIVE_MINUTE_NEW_RISK_RATE=.025;
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

export type OpportunityMode="RELATION"|"BREAKOUT"|"RETEST"|"FAILED_BREAKOUT"|"RANGE"|"SHOCK"|"SWING"|"TREND_PULLBACK"|"IMPULSE"|"PREDICTIVE";
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
  predictiveForecast?:PredictivePathForecast;
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
  prediction?:{directionProbability:number;expectedReturnRate:number;predictedMfeRate:number;predictedMaeRate:number;
    targetBeforeRisk:number;entryRegretRate:number;confidence:number};
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
  predictivePath:PredictiveEngineState;
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
    predictivePath:{version:PREDICTIVE_PATH_VERSION,updatedAt:now,symbols:{},directionMemory:{}},
    familyExperiment:initialFamilyExperimentState(),structuralInterrupt:initialStructuralInterruptState(),entryValidations:{},marketPulse:blankPulse(now),
    lastEntryAt:{},lastExitAt:{},lastSide:{},lastRotationAt:0,latestReason:"Predictive Path V1 已启动：预测未来15/30/60/120分钟路径、MFE/MAE和入场后悔，旧策略只保留已有仓位退出。",
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
  const familyExperiment=normalizeFamilyExperimentState((old as {familyExperiment?:unknown}).familyExperiment,relationEngine.rules,
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
    extremumRegime:(old as {extremumRegime?:ExtremumRegimeState}).extremumRegime?.version===EXTREMUM_REGIME_VERSION
      ?structuredClone((old as {extremumRegime:ExtremumRegimeState}).extremumRegime):base.extremumRegime,
    predictivePath:!upgrading&&(old as {predictivePath?:PredictiveEngineState}).predictivePath?.version===PREDICTIVE_PATH_VERSION
      ?structuredClone((old as {predictivePath:PredictiveEngineState}).predictivePath):base.predictivePath,
    familyExperiment,
    structuralInterrupt:normalizeStructuralInterruptState((old as {structuralInterrupt?:unknown}).structuralInterrupt,now),
    entryValidations:normalizeEntryValidations((old as {entryValidations?:unknown}).entryValidations,now),
    marketPulse:v.marketPulse?.bias? v.marketPulse:blankPulse(now),lastEntryAt:v.lastEntryAt??{},lastExitAt:v.lastExitAt??{},lastSide:v.lastSide??{},
    lastRotationAt:safe(v.lastRotationAt),latestReason:typeof v.latestReason==="string"?v.latestReason:base.latestReason,
    entryDiagnostics:v.entryDiagnostics??base.entryDiagnostics,storage:v.storage??base.storage,
    engineVersion:ADAPTIVE_ENGINE_VERSION,policyVersion:ADAPTIVE_ENGINE_VERSION,strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,
    executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:PREDICTIVE_PATH_VERSION,regionLaunchVersion:PREDICTIVE_PATH_VERSION,
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
function executionScore(q:Quote|undefined,now:number){
  if(!q)return 58;if(!freshQuote(q,now))return 10;const mid=midpoint(q),spread=(q.bestAsk-q.bestBid)/mid;
  return 100*(1-.65*clip(spread/.0018));
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
function opportunityCompare(a:Opportunity,b:Opportunity){
  return Number(b.eligible)-Number(a.eligible)||Number(b.mode==="SHOCK")-Number(a.mode==="SHOCK")
    ||Number(!b.reserve)-Number(!a.reserve)||Number(b.premium)-Number(a.premium)||b.score-a.score;
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
      ageMin=(now-t.openedAt)/60_000,
      originalStopRate=Math.max(.002,t.entryContext?.pullbackRiskRate??Math.abs(t.entryPrice-t.stopPrice)/t.entryPrice);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);
    t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    if(!t.firstProfitAt&&favorable>=ROUND_TRIP_COST*.6){t.firstProfitAt=now;if(t.entryContext)t.entryContext.postEntryState="CONFIRMED";}
    const stopped=t.side==="LONG"?px<=t.stopPrice:px>=t.stopPrice,
      decision=extremumExitDecision({side:t.side,mode:t.entryContext.mode,ageMin,signedRate:signed,peakFavorableRate:t.favorable,
        firstProfit:!!t.firstProfitAt,stopRate:originalStopRate,stopped,profitFloorRate:t.profitFloorRate??0,
        expectedHoldMinutes:t.expectedHoldMinutes??30,maxHoldMinutes:t.exitPlan?.maxHoldMinutes??Math.max(15,(t.expectedHoldMinutes??30)*2),state});
    if(decision.floorCandidate>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
      t.profitFloorRate=decision.floorCandidate;const next=t.entryPrice*(1+d*decision.floorCandidate);
      if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
        t.stopPrice=next;event(s,now,"PROTECTION",t.id,`峰谷系统利润保护提升至约${(decision.floorCandidate*100).toFixed(2)}%`);
      }
    }
    t.holdScore=decision.holdScore;
    t.holdValue={action:decision.reason?(t.favorable>ROUND_TRIP_COST?"EXIT_PROFIT":"EXIT_RISK"):"HOLD",
      pullbackRiskRate:originalStopRate,bestHoldMinutes:t.expectedHoldMinutes??30,score:t.holdScore};
    if(decision.reason){
      if(t.entryContext&&decision.reason==="ENTRY_FEEDBACK_FAILED")t.entryContext.postEntryState="FAILED";
      closeTrade(s,t,px,now,decision.reason);closed.add(t.id);
    }
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}

function markAndManage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const candidates=new Map(s.opportunities.filter(o=>!isExtremumOpportunity(o)&&!isPredictiveOpportunity(o)).map(o=>[o.symbol,o])),relationById=new Map(s.relationEngine.rules.map(r=>[r.id,r])),closed=new Set<string>();
  for(const t of s.positions){if(t.entryContext?.strategyVersion===EXTREMUM_REGIME_VERSION||t.entryContext?.strategyVersion===PREDICTIVE_PATH_VERSION)continue;const q=quotes[t.symbol];if(!freshQuote(q,now))continue;const px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side);
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
const riskCharge=(t:Trade)=>Math.max(t.plannedRisk,t.entryContext?.portfolioRiskCharge??((t.forecast?.sizingEquity??0)*.006));
function existingRisk(s:ForwardState,side?:"LONG"|"SHORT"){return s.positions.filter(t=>!side||t.side===side).reduce((n,t)=>n+riskCharge(t),0);}
function cycleRiskAdded(s:ForwardState,since:number){return[...s.positions,...s.history].filter(t=>t.openedAt>=since).reduce((n,t)=>n+riskCharge(t),0);}
function isExtremumOpportunity(o:Opportunity){return o.strategyVersion===EXTREMUM_REGIME_VERSION;}
function isPredictiveOpportunity(o:Opportunity){return o.strategyVersion===PREDICTIVE_PATH_VERSION&&o.mode==="PREDICTIVE";}

function predictiveOpportunity(c:PredictiveCandidate):Opportunity{
  const f=c.forecast,d=dir(c.side),sourceCount=f.crossVenue.sourceCount,disagreementRate=f.crossVenue.disagreementRate,
    net=Math.max(0,c.expectedReturnRate-ROUND_TRIP_COST),score=clip(c.confidence*100,0,100),
    stopRate=c.catastrophicStopRate,targetRate=Math.max(.004,c.predictedMfeRate),
    price=c.price;
  return{id:c.id,symbol:c.symbol,side:c.side,mode:"PREDICTIVE",premium:c.confidence>=.70,reserve:false,score,eligible:c.eligible,
    completedAt:c.at,expiresAt:c.expiresAt,price,stopPrice:price*(1-d*stopRate),targetPrice:price*(1+d*targetRate),stopRate,targetRate,
    directionStrength:(c.side==="LONG"?f.upProbability.m60:1-f.upProbability.m60)*100,pathEfficiency:0,
    momentumPersistence:(c.side==="LONG"?f.upProbability.m120:1-f.upProbability.m120)*100,
    positionScore:clip(100*(1-c.entryRegretRate/.01),0,100),spaceScore:clip(100*net/Math.max(stopRate,.001),0,100),
    executionScore:clip((.55+.45*f.crossVenue.agreement)*100,0,100),grossRemainingSpaceRate:Math.max(0,c.expectedReturnRate),
    netRemainingSpaceRate:net,pullbackRiskRate:stopRate,edgeRatio:net/Math.max(stopRate,1e-9),expectedHoldMinutes:c.expectedHoldMinutes,
    marketFit:c.confidence*100,regionId:null,regionQuality:null,reason:c.reason,strategyVersion:PREDICTIVE_PATH_VERSION,
    sourceCount,disagreementRate,predictiveForecast:f};
}

function managePredictiveTrades(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const closed=new Set<string>();
  for(const t of s.positions){
    if(t.entryContext?.strategyVersion!==PREDICTIVE_PATH_VERSION)continue;
    const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side),signed=d*(px/t.entryPrice-1),
      favorable=Math.max(0,signed),adverse=Math.max(0,-signed),ageMinutes=(now-t.openedAt)/60_000,
      stopped=t.side==="LONG"?px<=t.stopPrice:px>=t.stopPrice,
      forecast=s.predictivePath.symbols[t.symbol],
      decision=predictiveExitDecision({side:t.side,forecast,memory:s.predictivePath.directionMemory[t.symbol],stopped,ageMinutes});
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);
    t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    const score=clip(decision.directionProbability*70+clip(decision.remainingEdge/.01,0,1)*30,0,100);
    t.holdScore=score;t.holdValue={action:decision.reason?(signed>=0?"EXIT_PROFIT":"EXIT_RISK"):"HOLD",
      pullbackRiskRate:t.entryContext?.pullbackRiskRate??Math.abs(t.entryPrice-t.stopPrice)/t.entryPrice,
      bestHoldMinutes:t.expectedHoldMinutes??60,score};
    if(decision.reason){closeTrade(s,t,px,now,decision.reason);closed.add(t.id);}
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}

function openPredictiveTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number){
  if(!isPredictiveOpportunity(o)||!o.predictiveForecast)return"预测路径身份缺失";
  const side=o.side,d=dir(side),price=side==="LONG"?q.bestAsk:q.bestBid,stopRate=o.stopRate;
  if(!(stopRate>=.004&&stopRate<=.03))return"灾难止损宽度异常";
  const totalHeadroom=equity*(TOTAL_RISK_RATE-.001)-existingRisk(s),
    sideHeadroom=equity*(SIDE_RISK_RATE-.0005)-existingRisk(s,side),
    headroom=Math.max(0,Math.min(totalHeadroom,sideHeadroom));
  const confidence=clip(o.predictiveForecast.confidence,.5,.9),
    riskRate=clip(.009+(confidence-.60)*.025,.0075,.015),
    wantedRisk=equity*riskRate,riskBudget=Math.min(wantedRisk,headroom);
  if(riskBudget<equity*.0035)return"剩余风险预算不足以形成有效仓位";
  const consumed=Math.max(0,d*(price/Math.max(o.price,1e-9)-1)),
    remainingNet=o.netRemainingSpaceRate-consumed;
  if(remainingNet<=0)return"实时价格已消耗预测净优势";
  const rawNotional=riskBudget/(stopRate+ROUND_TRIP_COST),
    targetNotional=Math.min(rawNotional,equity*1.20),
    leverage=Math.max(1,Math.min(10,Math.floor(contract.leverageMax||10))),
    mult=Math.max(contract.quantoMultiplier,1e-12),
    minContracts=Math.max(1,Math.ceil(contract.minContracts??(Number(contract.orderSizeMin??1)||1))),
    contracts=Math.floor(targetNotional/(price*mult));
  if(contracts<minContracts)return"低于最小模拟合约数量";
  const quantity=contracts*mult,notional=quantity*price,margin=notional/leverage,totalMargin=s.positions.reduce((n,t)=>n+t.margin,0);
  if(totalMargin+margin>equity*TOTAL_MARGIN_RATE)return"组合保证金已满";
  const plannedRisk=notional*(stopRate+ROUND_TRIP_COST),entryFee=notional*PAPER_COST.feeRate,
    stopPrice=price*(1-d*stopRate),armRate=Math.max(.004,Math.min(.03,o.targetRate)),armPrice=price*(1+d*armRate),
    horizon=Math.max(15,Math.round(o.expectedHoldMinutes)),
    id=`pp-${now.toString(36)}-${o.symbol.replace(/[^A-Z0-9]/g,"")}-${side[0]}`,
    ruleId=`predictive-path-${o.symbol}`,
    directionProbability=(side==="LONG"?o.predictiveForecast.upProbability.m60:1-o.predictiveForecast.upProbability.m60),
    p=o.predictiveForecast,
    rule:Rule={id:ruleId,signature:`PREDICTIVE_PATH:${side}`,parentId:null,version:1,createdAt:now,
      expiresAt:now+Math.max(120,o.expectedHoldMinutes*3)*60_000,status:"EXPERIMENTAL",conditions:[],side,horizon,stopRate,
      armRate,givebackRate:0,exitMode:"REACTION_DECAY",samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:remainingNet,
      priorResponse:null,recentResponse:0,standardError:0,reason:o.reason,mutation:"CREATE",grammar:PREDICTIVE_PATH_VERSION,
      liveEligible:false,authority:"ADAPTIVE_TEN",turnTimeframe:"5m"},
    t:Trade={id,symbol:o.symbol,side,rule,openedAt:now,closedAt:null,status:"OPEN",entryPrice:price,exitPrice:null,quantity,contracts,
      quantoMultiplier:mult,notional,leverage,margin,plannedRisk,stopPrice,armPrice,favorable:0,adverse:0,lastPrice:price,
      lastQuoteAt:q.observedAt,entryFee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,
      execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,firstProfitAt:null,holdScore:o.score,profitFloorRate:0,expectedHoldMinutes:o.expectedHoldMinutes,
      peakPnlRate:0,exitControl:{policy:PREDICTIVE_PATH_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:"adaptive-ten-entry-v1",capturedAt:now,timeframe:"5m",side,mode:"PREDICTIVE",reserve:false,reason:o.reason,
        entryScore:o.score,directionStrength:o.directionStrength,spaceScore:o.spaceScore,positionScore:o.positionScore,executionScore:o.executionScore,
        remainingSpaceRate:remainingNet,pullbackRiskRate:stopRate,edgeRatio:remainingNet/Math.max(stopRate,1e-9),
        expectedHoldMinutes:o.expectedHoldMinutes,marketFit:o.marketFit,regionId:null,portfolioRiskCharge:riskBudget,
        strategyVersion:PREDICTIVE_PATH_VERSION,sourceCount:o.sourceCount,disagreementRate:o.disagreementRate,postEntryState:"CONFIRMED",
        prediction:{directionProbability,expectedReturnRate:o.grossRemainingSpaceRate,predictedMfeRate:side==="LONG"?p.long.mfe60:p.short.mfe60,
          predictedMaeRate:side==="LONG"?p.long.mae60:p.short.mae60,targetBeforeRisk:side==="LONG"?p.long.targetBeforeRisk60:p.short.targetBeforeRisk60,
          entryRegretRate:side==="LONG"?p.long.entryRegret10:p.short.entryRegret10,confidence:p.confidence}},
      forecast:{remainingNetRate:remainingNet,quality:p.confidence,sizingEquity:equity}};
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;
  event(s,now,"ENTRY",id,`${o.symbol} ${side} PREDICTIVE｜方向${(directionProbability*100).toFixed(0)}%｜预测净优势${(remainingNet*100).toFixed(2)}%`,{notional,plannedRisk});
  return null;
}

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

function rankedEligible(s:ForwardState,now:number){
  return s.opportunities.filter(o=>isPredictiveOpportunity(o)&&o.eligible&&o.expiresAt>now&&!s.positions.some(t=>t.symbol===o.symbol)).sort(opportunityCompare);
}
function rotateIfNeeded(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,equity:number){
  const candidate=rankedEligible(s,now).find(o=>!o.reserve);if(!candidate)return false;
  if(now-s.lastRotationAt<ROTATION_COOLDOWN_MS)return false;
  const totalRisk=existingRisk(s),totalMargin=s.positions.reduce((n,t)=>n+t.margin,0),sideRisk=existingRisk(s,candidate.side);
  const totalFull=equity>0&&totalRisk>=equity*(TOTAL_RISK_RATE-.006),sideFull=equity>0&&sideRisk>=equity*(SIDE_RISK_RATE-.004),
    marginFull=equity>0&&totalMargin>=equity*(TOTAL_MARGIN_RATE-.05);
  if(!totalFull&&!sideFull&&!marginFull)return false;
  const current=s.positions.filter(t=>t.entryContext?.strategyVersion===PREDICTIVE_PATH_VERSION),
    pool=sideFull?current.filter(t=>t.side===candidate.side):current;
  const weak=[...pool].sort((a,b)=>(a.holdScore??50)-(b.holdScore??50))[0];if(!weak)return false;
  const weakScore=weak.holdScore??50;if(candidate.score<weakScore+ROTATION_GAP)return false;
  const qOld=quotes[weak.symbol],qNew=quotes[candidate.symbol],meta=contracts[candidate.symbol];
  if(!freshQuote(qOld,now)||!freshQuote(qNew,now)||qNew!.entryReady!==true||!meta)return false;
  const probe=structuredClone(s),probeWeak=probe.positions.find(t=>t.id===weak.id);if(!probeWeak)return false;
  closeTrade(probe,probeWeak,probeWeak.side==="LONG"?qOld!.bestBid:qOld!.bestAsk,now,"OPPORTUNITY_REPLACED");
  probe.positions=probe.positions.filter(t=>t.id!==probeWeak.id);
  if(openPredictiveTrade(probe,candidate,qNew!,meta,now,equity))return false;
  closeTrade(s,weak,weak.side==="LONG"?qOld!.bestBid:qOld!.bestAsk,now,"OPPORTUNITY_REPLACED");s.positions=s.positions.filter(t=>t.id!==weak.id);
  const err=openPredictiveTrade(s,candidate,qNew!,meta,now,equity);if(err)throw new Error(`换仓预检通过但正式开仓失败：${err}`);
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
    const last=s.lastExitAt[o.symbol]??0;if(now-last<90_000){reject("同币短时防抖");continue;}
    const error=openPredictiveTrade(s,o,q!,meta,now,equity);if(error){reject(error);continue;}opened++;
  }
  s.entryDiagnostics.opened=opened;return opened;
}
function nextCandleAt(paths:Record<string,Candle[]>,now:number){
  let latest=0;for(const p of Object.values(paths)){const a=validPath(p,now);if(a)latest=Math.max(latest,(a.at(-1)!.time+300)*1000);}return latest;
}
export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;minutePaths?:Record<string,Candle[]>;daily?:Record<string,Candle[]>;
  quotes:Record<string,Quote>;contracts:Record<string,Contract>;ancillary?:Record<string,PredictiveAncillary>;entrySymbols?:Iterable<string>;
  learningSymbols?:Iterable<string>;allowDataCycle?:boolean;legacyDrainOnly?:boolean}){
  const s=normalizeForward(structuredClone(input.state),input.now),
    before=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate]),h:s.history.length,b:s.balance,r:s.revision});
  s.entryValidations={};s.lastQuoteCycleAt=input.now;
  const allowed=input.entrySymbols?new Set(input.entrySymbols):undefined,
    candleAt=nextCandleAt(input.paths,input.now),
    dataDue=input.allowDataCycle!==false&&candleAt>s.lastCandleAt,
    built=buildPredictivePathEngine({paths:input.paths,quotes:input.quotes,ancillary:input.ancillary,previous:s.predictivePath,now:input.now,allowed}),
    forecasts=Object.values(built.state.symbols);
  s.predictivePath=built.state;s.opportunities=input.legacyDrainOnly?[]:built.candidates.map(predictiveOpportunity);
  const up=forecasts.filter(f=>f.upProbability.m60>=.55).length,down=forecasts.filter(f=>f.upProbability.m60<=.45).length,
    neutral=Math.max(0,forecasts.length-up-down),avgDirection=forecasts.length
      ?forecasts.reduce((n,f)=>n+(f.upProbability.m60-.5),0)/forecasts.length:0,
    avgStrength=forecasts.length?forecasts.reduce((n,f)=>n+Math.abs(f.upProbability.m60-.5)*2,0)/forecasts.length:0,
    avgExpansion=forecasts.length?forecasts.reduce((n,f)=>n+Math.min(.05,Math.abs(f.expectedReturn.m60)),0)/forecasts.length/.05:0;
  s.marketPulse={at:input.now,up,down,neutral,bias:avgDirection>.025?"UP":avgDirection<-.025?"DOWN":"MIXED",
    strength:clip(avgStrength),expansion:clip(avgExpansion)};
  if(dataDue){s.lastCandleAt=candleAt;s.lastCycleAt=input.now;}
  s.selectedSymbols=[...forecasts].sort((a,b)=>{
    const av=Math.abs(a.upProbability.m60-.5)+Math.min(.10,Math.abs(a.expectedReturn.m60))*3+a.confidence*.15,
      bv=Math.abs(b.upProbability.m60-.5)+Math.min(.10,Math.abs(b.expectedReturn.m60))*3+b.confidence*.15;
    return bv-av;
  }).slice(0,30).map(row=>row.symbol);

  managePredictiveTrades(s,input.quotes,input.now);
  // Positions born before predictive cutover retain their original frozen lifecycle.
  manageExtremumTrades(s,input.quotes,input.now);
  markAndManage(s,input.quotes,input.now);

  const mark=equityMark(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));updateDaily(s,input.now,mark.equity);
  if(!input.legacyDrainOnly)rotateIfNeeded(s,input.quotes,input.contracts,input.now,mark.equity);
  const opened=input.legacyDrainOnly?0:fillForwardPortfolio(s,input.quotes,input.contracts,input.now,mark.equity,false);

  const eligible=s.opportunities.filter(o=>o.eligible&&o.expiresAt>input.now),
    longForecasts=forecasts.filter(f=>f.preferredSide==="LONG").length,
    shortForecasts=forecasts.filter(f=>f.preferredSide==="SHORT").length,
    totalRisk=existingRisk(s),riskUse=mark.equity>0?100*totalRisk/mark.equity:0;
  s.fitDiagnostics={tested:forecasts.length,qualified:eligible.length,trainGroups:0,checkGroups:0,
    latestAt:input.now,rapidQualified:eligible.length,activeLong:longForecasts,activeShort:shortForecasts};
  s.latestReason=`预测路径系统：${forecasts.length}个市场完成预测 · LONG ${longForecasts} · SHORT ${shortForecasts} · ${eligible.length}个当前可执行；`
    +`当前${s.positions.length}笔持仓，计划风险已用${riskUse.toFixed(1)}%。`;
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
  next.latestReason="模拟账户已重置为1000U；Predictive Path V1 从当前真实市场重新生成未来路径预测；历史账户记录与旧研究证据继续保留。";
  return next;
}
export function forwardUrgentQuoteSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):null,keep=(x:string)=>!allowed||allowed.has(x),
    premium=s.opportunities.filter(o=>o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort((a,b)=>b.score-a.score),
    normal=s.opportunities.filter(o=>!o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort((a,b)=>b.score-a.score),
    watched=Object.values(s.predictivePath.symbols).filter(r=>keep(r.symbol)).sort((a,b)=>{
      const av=Math.max(a.long.netEv60,a.short.netEv60)+Math.abs(a.upProbability.m60-.5)*.02+a.confidence*.005,
        bv=Math.max(b.long.netEv60,b.short.netEv60)+Math.abs(b.upProbability.m60-.5)*.02+b.confidence*.005;
      return bv-av;
    });
  return[...new Set([...s.positions.map(t=>t.symbol),...premium.map(o=>o.symbol),...normal.map(o=>o.symbol),...watched.map(r=>r.symbol)])]
    .slice(0,FORWARD_EXECUTION_BBO_CAP);
}
export function forwardUrgentMinuteSymbols(_s:ForwardState,_entrySymbols?:Iterable<string>){
  // Predictive Path V1 does not depend on a 1m confirmation lane. Existing
  // legacy positions are managed from their frozen lifecycle plus executable BBO.
  return[] as string[];
}
export function forwardWatchSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  return forwardUrgentQuoteSymbols(s,now,entrySymbols).slice(0,FORWARD_EXECUTION_BBO_CAP);
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const mark=equityMark(s,quotes,now),eligible=s.opportunities.filter(o=>o.eligible&&o.expiresAt>now),reserve=eligible.filter(o=>o.reserve),
    forecasts=Object.values(s.predictivePath.symbols).sort((a,b)=>{
      const av=Math.max(a.long.netEv60,a.short.netEv60)+a.confidence*.005,bv=Math.max(b.long.netEv60,b.short.netEv60)+b.confidence*.005;return bv-av;
    }),
    counts={long:forecasts.filter(r=>r.preferredSide==="LONG").length,short:forecasts.filter(r=>r.preferredSide==="SHORT").length,
      wait:forecasts.filter(r=>!r.enterNow).length,enter:forecasts.filter(r=>r.enterNow).length},
    legacyRows=Object.values(s.extremumRegime.symbols),
    legacyCounts={trendUp:legacyRows.filter(r=>r.regime==="TREND_UP").length,trendDown:legacyRows.filter(r=>r.regime==="TREND_DOWN").length,
      swing:legacyRows.filter(r=>r.regime==="SWING").length,weakening:legacyRows.filter(r=>r.regime==="WEAKENING").length,
      transition:legacyRows.filter(r=>r.regime==="TRANSITION").length,ready:legacyRows.filter(r=>r.stage==="READY").length,
      impulse:legacyRows.filter(r=>r.stage==="IMPULSE").length};
  return{version:s.version,engineVersion:ADAPTIVE_ENGINE_VERSION,grammar:ADAPTIVE_ENGINE_VERSION,mode:"REAL_FEED_PAPER",liveEligible:false,
    strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:PREDICTIVE_PATH_VERSION,
    regionLaunchVersion:PREDICTIVE_PATH_VERSION,policyVersion:ADAPTIVE_ENGINE_VERSION,exitPolicyVersion:ADAPTIVE_ENGINE_VERSION,
    policyUpgrade:null,exitPolicyUpgrade:null,startedAt:s.startedAt,cutoverAt:s.cutoverAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...mark,targetEquity:s.initialEquity*2,
    netPnl:mark.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,fees:s.fees,
    fundingAllowance:s.fundingAllowance,turnover:s.turnover,positions:s.positions,history:s.history,events:s.events,daily:s.daily,
    opportunities:s.opportunities,entryOpportunities:s.opportunities,regions:[],marketPulse:s.marketPulse,
    predictivePath:{version:s.predictivePath.version,updatedAt:s.predictivePath.updatedAt,counts,policy:PREDICTIVE_PATH_POLICY,
      source:"实时因果统计：当前价格/技术/OI/Funding/Basis/清算/多交易所/市场环境，无离线训练模型",symbols:forecasts.slice(0,30)},
    extremumRegime:{version:s.extremumRegime.version,retired:true,updatedAt:s.extremumRegime.updatedAt,counts:legacyCounts,symbols:legacyRows.slice(0,30)},
    structuralInterrupt:{version:STRUCTURAL_INTERRUPT_VERSION,retired:true,marketEvent:null,vetoSide:null,vetoUntil:0,preAlerts:0,confirmed:0},
    relationEngine:{version:s.relationEngine.version,retired:true,updatedAt:s.relationEngine.updatedAt,diagnostics:s.relationEngine.diagnostics,rules:[]},
    familyExperiment:{retired:true,...familyExperimentSummary(s.familyExperiment),maxNewReservePer5m:0},
    entryValidation:{waiting:0,cancelled:0,records:[]},
    marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,entryDiagnostics:s.entryDiagnostics,
    fitDiagnostics:s.fitDiagnostics,storage:s.storage,targetPositions:null,positionLimit:null,executionBboCapacity:FORWARD_EXECUTION_BBO_CAP,
    minuteConfirmationCapacity:0,seatCount:s.positions.length,eligibleCount:eligible.length,
    reserveCount:reserve.length,premiumCount:eligible.filter(o=>o.premium).length,
    boundaries:{scope:"PAPER_AUTHORITY",
      grammar:"Predictive Path V1：同时预测15/30/60/120分钟方向、收益、MFE/MAE、目标先于风险概率与10分钟入场后悔；多源市场数据是实时证据，不使用旧峰谷/区域/关系规则产生新单。",
      historyBackfill:false,
      sampleMeaning:"旧Forward/Extremum样本仅保留为历史记录，不参与新订单。模型参数来自因果历史数据与时间顺序训练；LIVE只消费已经持久化的标准PAPER Trade。",
      accounting:"模拟使用新鲜Gate买卖价执行并计入手续费、滑点和资金费占位；预测值不能替代真实成交价。",
      risk:"不设固定持仓席位；有足够正EV机会时按预测置信度分配组合风险，总风险≤10%、同方向≤6.5%、组合保证金≤75%、单币一仓。",
      validation:"入场必须同时满足成本后正EV、方向概率、目标先于风险、入场后悔、多源覆盖与分歧上限；任一层失败都只能WAIT，不能由其它高分补回。",
      liquidation:"预测仓只保留灾难止损；正常退出由当前剩余预测优势消失或明确反向预测触发，不使用固定小利润止盈或统一80%回撤保护。"},
    cost:PAPER_COST,nextCycleAt:s.lastCandleAt+BAR_MS};
}
