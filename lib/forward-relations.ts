import { familyExperimentSummary, initialFamilyExperimentState, isFamilyFailure,
  normalizeFamilyExperimentState, recordFamilyFailure, recordFamilyOutcome,
  relationFamilyId, reserveExperimentValueBlock,
  type FamilyExperimentState } from "./forward-family-experiment.ts";
import { initialRelationEngine, normalizeRelationEngine,
  type RelationCandidate, type RelationEngineState, type RelationExitProfile, type RelationStatus } from "./forward-relation-v2.ts";
import { STRUCTURAL_INTERRUPT_VERSION, initialStructuralInterruptState, normalizeStructuralInterruptState,
  type StructuralInterruptState } from "./forward-structural-interrupt.ts";
import { MARKET_INTELLIGENCE_VERSION, buildMarketIntelligence,
  urgentMinuteSymbols as intelligenceUrgentMinuteSymbols, initialMarketIntelligenceState,
  type MarketIntelligenceState, type MarketSymbolState } from "./market-intelligence-engine.ts";
import { evaluatePositionIntelligence, POSITION_INTELLIGENCE_VERSION,
  type PositionIntelligenceState } from "./position-intelligence-engine.ts";
import { beijingDayKey } from "./beijing-time.ts";
import { ENTRY_RESPONSE_VERSION, entryResponseWindowMs, evaluateEntryResponse,
  type EntryResponseDecision } from "./market-intelligence-entry-response.ts";
import { deriveMarketEvolution, deriveOpportunityLifecycle, deriveProfitLifecycle, extendedEntryConfirmationReady,
  type MarketEvolutionState, type MarketLifecycleResearchContext,
  type OpportunityLifecyclePhase, type ProfitLifecycleState } from "./market-intelligence-lifecycle.ts";
import { advanceMarketHypothesisResearch, entryHypothesisGuidance, initialMarketHypothesisResearch,
  normalizeMarketHypothesisResearch, positionHypothesisGuidance,
  type EntryHypothesisGuidance, type MarketHypothesisResearchState } from "./market-intelligence-hypothesis-research.ts";

/**
 * Forward Path Relation 3.0 — PAPER authority.
 *
 * One 5m root observation records its complete 5–60m response path. Mature
 * path evidence chooses direction, expected hold, normal adverse excursion,
 * feedback deadline and profit retention together. Region/1m logic remains
 * execution enhancement, never a second directional authority.
 */
export const FORWARD_VERSION="forward-relations-v1.0";
export const ADAPTIVE_ENGINE_VERSION=MARKET_INTELLIGENCE_VERSION;
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
const HISTORY_LIMIT=240,EVENT_LIMIT=160,CONSUMED_THESIS_LIMIT=512,CONSUMED_THESIS_TTL_MS=7*24*60*60_000;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const median=(v:number[])=>{const a=v.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const dir=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const dayKey=(now:number)=>beijingDayKey(now);
const safe=(v:number|null|undefined,fallback=0)=>typeof v==="number"&&Number.isFinite(v)?v:fallback;

export type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type Quote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean;sourceCount?:number;disagreementRate?:number;
  sourceBreadth?:number;directionalAgreement?:number;medianShortMove?:number;spreadRate?:number;bookImbalance?:number;
  bidLiquidityChange?:number;askLiquidityChange?:number;liquiditySourceCount?:number};
export type Contract={quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts?:number;
  enableDecimal?:boolean;orderSizeMin?:string|number;orderSizeMax?:string|number;marketOrderSizeMax?:string|number};

export type Condition={feature:number;op:"GE"|"LE";threshold:number};
export type Rule={id:string;signature:string;parentId:string|null;version:number;createdAt:number;expiresAt:number;
  status:"EXPERIMENTAL"|"DORMANT";conditions:Condition[];side:"LONG"|"SHORT";horizon:number;stopRate:number;
  armRate:number;givebackRate:number;exitMode:"HORIZON"|"REACTION_DECAY";samples:number;trainGroups:number;checkGroups:number;
  estimatedNetRate:number;priorResponse:number|null;recentResponse:number;standardError:number;reason:string;
  mutation:"CREATE"|"REVISE"|"RECALL";grammar:string;liveEligible:false;authority?:"ADAPTIVE_TEN"|"FORWARD_RELATION"|"STRUCTURAL_INTERRUPT";turnTimeframe?:"5m"};

export type OpportunityMode="RELATION"|"BREAKOUT"|"RETEST"|"FAILED_BREAKOUT"|"RANGE"|"SHOCK"|"SWING"|"TREND_PULLBACK"|"IMPULSE"|"RELATIVE"|"REVERSAL"|"CONTINUATION";
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
  strategyVersion?:string;regime?:MarketSymbolState["regime"];topPressure?:number;bottomPressure?:number;upSurvival?:number;downSurvival?:number;
  confirmationStage?:MarketSymbolState["stage"];sourceCount?:number;disagreementRate?:number;
  clusterId?:string;thesisId?:string;thesisSummary?:string;invalidationSummary?:string;residual?:number;relativeStrength?:number;dataConfidence?:number;
  thesisSince?:number;thesisBars?:number;
  marketEvolutionPhase?:MarketEvolutionState["phase"];opportunityLifecyclePhase?:OpportunityLifecyclePhase;
  extendedConfirmation?:boolean;lifecycleReason?:string;
  futureResearchAction?:EntryHypothesisGuidance["action"];futureResearchReason?:string;futureHypothesisIds?:string[];
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
  strategyVersion?:string;regime?:MarketSymbolState["regime"]|"TREND_UP"|"TREND_DOWN"|"SWING"|"WEAKENING";topPressure?:number;bottomPressure?:number;upSurvival?:number;downSurvival?:number;
  confirmationStage?:MarketSymbolState["stage"]|"WATCH"|"CANDIDATE"|"STRUCTURE_BREAK"|"RECLAIM_TEST"|"IMPULSE";sourceCount?:number;disagreementRate?:number;postEntryState?:"PENDING"|"CONFIRMED"|"FAILED";
  entryResponse?:{version:string;startedAt:number;confirmedAt:number;elapsedMs:number;samples:number;advanceRate:number;bestAdvanceRate:number;
    maxAdverseRate:number;supportFamilies:string[];fastLane:boolean};
  clusterId?:string;thesisId?:string;marketNarrativeId?:string;thesisSummary?:string;invalidationSummary?:string;entryResidual?:number;entryRelativeStrength?:number;
  thesisSince?:number;thesisBars?:number;
  marketEvolutionPhase?:MarketEvolutionState["phase"];opportunityLifecyclePhase?:OpportunityLifecyclePhase;
  extendedConfirmation?:boolean;futureResearchAction?:EntryHypothesisGuidance["action"];futureResearchReason?:string;futureHypothesisIds?:string[];
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
  holdValue?:{action:"HOLD"|"REVIEW"|"EXIT_PROFIT"|"EXIT_RISK";pullbackRiskRate:number;bestHoldMinutes:number;score:number};
  positionIntelligence?:PositionIntelligenceState;
  profitLifecycle?:ProfitLifecycleState;
  turn?:{version:string;timeframe:"5m";signalAt:number;entryTurnProbability:number;entryContinuation:number;entryDirectionConfidence:number};
};

export type AuditEvent={id:string;at:number;kind:"START"|"ENTRY"|"EXIT"|"PROTECTION"|"ROTATION"|"DATA";
  subject:string;reason:string;detail?:Record<string,string|number|null>};
export type Daily={day:string;firstAt:number;lastAt:number;startEquity:number;endEquity:number;exactBoundary:boolean};
export type EntryValidation={id:string;candidateId:string;symbol:string;side:"LONG"|"SHORT";startedAt:number;expiresAt:number;
  deadlineAt:number;
  initialPrice:number;lastPrice:number;lastQuoteAt:number;samples:number;bestAdvanceRate:number;maxAdverseRate:number;
  supportSamples:number;oppositionSamples:number;extendedConfirmation?:boolean;extremeResidual?:boolean;
  minimumElapsedMs?:number;minimumSupportSamples?:number;minimumRetainedRate?:number;
  stableThesis?:boolean;phase?:"ARMED"|"RETEST_WAIT";initialExpectedNetRate?:number;pullbackRiskRateAtArm?:number;
  maxChaseRate?:number;retestPullbackMin?:number;restartMin?:number;retestBasePrice?:number|null;retestBaseAt?:number|null;
  status:"WAITING"|"CANCELLED";reason:string|null};
export type ForwardState={
  version:string;engineVersion:string;startedAt:number;revision:number;lastCycleAt:number;lastQuoteCycleAt:number;lastCandleAt:number;
  balance:number;initialEquity:number;peakEquity:number;maxDrawdown:number;resolved:number;wins:number;grossPnl:number;fees:number;
  fundingAllowance:number;turnover:number;positions:Trade[];history:Trade[];events:AuditEvent[];daily:Daily[];
  selectedSymbols:string[];opportunities:Opportunity[];regions:Record<string,Region>;relationEngine:RelationEngineState;extremumRegime:MarketIntelligenceState;
  familyExperiment:FamilyExperimentState;structuralInterrupt:StructuralInterruptState;
  hypothesisResearch:MarketHypothesisResearchState;
  entryValidations:Record<string,EntryValidation>;
  marketPulse:MarketPulse;lastEntryAt:Record<string,number>;lastExitAt:Record<string,number>;lastSide:Record<string,"LONG"|"SHORT">;
  consumedTheses:Record<string,number>;
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
    extremumRegime:initialMarketIntelligenceState(now),
    familyExperiment:initialFamilyExperimentState(),structuralInterrupt:initialStructuralInterruptState(),
    hypothesisResearch:initialMarketHypothesisResearch(now),entryValidations:{},marketPulse:blankPulse(now),
    lastEntryAt:{},lastExitAt:{},lastSide:{},consumedTheses:{},lastRotationAt:0,latestReason:"Market Intelligence V1 已启动：从整个市场关系、分化与跨交易所共识中持续寻找异类机会。",
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
function normalizeConsumedTheses(value:unknown,history:Trade[],positions:Trade[],now:number){
  const rows=new Map<string,number>();
  if(value&&typeof value==="object"){
    for(const[id,raw]of Object.entries(value as Record<string,unknown>)){
      const at=Number(raw);if(id&&Number.isFinite(at)&&at>0&&at>=now-CONSUMED_THESIS_TTL_MS)rows.set(id,at);
    }
  }
  for(const t of [...positions,...history]){
    const id=t.entryContext?.thesisId,at=t.openedAt;if(id&&at>=now-CONSUMED_THESIS_TTL_MS)rows.set(id,Math.max(at,rows.get(id)??0));
  }
  return Object.fromEntries([...rows.entries()].sort((a,b)=>b[1]-a[1]).slice(0,CONSUMED_THESIS_LIMIT));
}
function rememberConsumedThesis(s:ForwardState,id:string|undefined,at:number){
  if(!id)return;s.consumedTheses[id]=at;
  const rows=Object.entries(s.consumedTheses).filter(([,v])=>Number.isFinite(v)&&v>=at-CONSUMED_THESIS_TTL_MS)
    .sort((a,b)=>b[1]-a[1]).slice(0,CONSUMED_THESIS_LIMIT);
  s.consumedTheses=Object.fromEntries(rows);
}

function normalizeEntryValidations(value:unknown,now:number){
  const out:Record<string,EntryValidation>={};if(!value||typeof value!=="object")return out;
  for(const [id,raw]of Object.entries(value as Record<string,unknown>)){
    if(!raw||typeof raw!=="object")continue;const r=raw as Partial<EntryValidation>;
    if(typeof r.candidateId!=="string"||typeof r.symbol!=="string"||(r.side!=="LONG"&&r.side!=="SHORT"))continue;
    const startedAt=safe(r.startedAt),expiresAt=safe(r.expiresAt);if(!(startedAt>0&&expiresAt>=startedAt&&expiresAt>now-15*60_000))continue;
    out[id]={id,candidateId:r.candidateId,symbol:r.symbol,side:r.side,startedAt,expiresAt,
      deadlineAt:safe(r.deadlineAt,Math.min(expiresAt,startedAt+24_000)),
      initialPrice:Math.max(1e-12,safe(r.initialPrice,1)),lastPrice:Math.max(1e-12,safe(r.lastPrice,r.initialPrice??1)),
      lastQuoteAt:safe(r.lastQuoteAt,startedAt),samples:Math.max(1,Math.floor(safe(r.samples,1))),
      bestAdvanceRate:Math.max(0,safe(r.bestAdvanceRate)),maxAdverseRate:Math.max(0,safe(r.maxAdverseRate)),
      supportSamples:Math.max(0,Math.floor(safe(r.supportSamples))),oppositionSamples:Math.max(0,Math.floor(safe(r.oppositionSamples))),
      extendedConfirmation:!!r.extendedConfirmation,extremeResidual:!!r.extremeResidual,
      minimumElapsedMs:Math.max(0,safe(r.minimumElapsedMs)),minimumSupportSamples:Math.max(0,Math.floor(safe(r.minimumSupportSamples))),
      minimumRetainedRate:Math.max(0,safe(r.minimumRetainedRate)),stableThesis:!!r.stableThesis,
      phase:r.phase==="RETEST_WAIT"?"RETEST_WAIT":"ARMED",
      initialExpectedNetRate:Math.max(0,safe(r.initialExpectedNetRate)),pullbackRiskRateAtArm:Math.max(0,safe(r.pullbackRiskRateAtArm)),
      maxChaseRate:Math.max(0,safe(r.maxChaseRate)),retestPullbackMin:Math.max(0,safe(r.retestPullbackMin)),
      restartMin:Math.max(0,safe(r.restartMin)),
      retestBasePrice:Number.isFinite(r.retestBasePrice)?Math.max(1e-12,r.retestBasePrice!):null,
      retestBaseAt:Number.isFinite(r.retestBaseAt)?Math.max(0,r.retestBaseAt!):null,
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
    extremumRegime:!upgrading&&(old as {extremumRegime?:MarketIntelligenceState}).extremumRegime?.version===MARKET_INTELLIGENCE_VERSION
      ?structuredClone((old as {extremumRegime:MarketIntelligenceState}).extremumRegime):base.extremumRegime,
    familyExperiment,
    structuralInterrupt:normalizeStructuralInterruptState((old as {structuralInterrupt?:unknown}).structuralInterrupt,now),
    hypothesisResearch:normalizeMarketHypothesisResearch((old as {hypothesisResearch?:unknown}).hypothesisResearch,now),
    entryValidations:normalizeEntryValidations((old as {entryValidations?:unknown}).entryValidations,now),
    marketPulse:v.marketPulse?.bias? v.marketPulse:blankPulse(now),lastEntryAt:v.lastEntryAt??{},lastExitAt:v.lastExitAt??{},lastSide:v.lastSide??{},
    consumedTheses:normalizeConsumedTheses((old as {consumedTheses?:unknown}).consumedTheses,history,positions,now),
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
  return Number(b.eligible)-Number(a.eligible)||Number(!b.reserve)-Number(!a.reserve)||Number(b.premium)-Number(a.premium)||b.score-a.score;
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
function manageIntelligenceTrades(s:ForwardState,quotes:Record<string,Quote>,now:number,minutePaths:Record<string,Candle[]>|undefined,
  marketEvolution:MarketEvolutionState){
  const closed=new Set<string>();
  for(const t of s.positions){
    if(t.entryContext?.strategyVersion!==MARKET_INTELLIGENCE_VERSION)continue;
    const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const state=s.extremumRegime.symbols[t.symbol],px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side),
      signed=d*(px/t.entryPrice-1),favorable=Math.max(0,signed),adverse=Math.max(0,-signed),ageMin=(now-t.openedAt)/60_000,
      originalStopRate=Math.max(.004,t.entryContext?.pullbackRiskRate??Math.abs(t.entryPrice-t.stopPrice)/t.entryPrice),
      structuralStop=t.entryPrice*(1-d*originalStopRate);
    if((t.profitFloorRate??0)<=0)t.stopPrice=structuralStop;
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    if(!t.firstProfitAt&&favorable>=ROUND_TRIP_COST*.65){t.firstProfitAt=now;if(t.entryContext)t.entryContext.postEntryState="CONFIRMED";}
    const stopped=t.side==="LONG"?px<=t.stopPrice:px>=t.stopPrice,
      position=evaluatePositionIntelligence({
        now,side:t.side,signedRate:signed,peakFavorableRate:t.favorable,ageMin,firstProfit:!!t.firstProfitAt,
        expectedHoldMinutes:t.expectedHoldMinutes??180,stopRate:originalStopRate,entryScore:t.entryContext?.entryScore??50,
        entryResidual:t.entryContext?.entryResidual??0,entryRelativeStrength:t.entryContext?.entryRelativeStrength??.5,
        entryRemainingSpaceRate:t.entryContext?.remainingSpaceRate??t.forecast?.remainingNetRate??0,state,
        narrative:s.extremumRegime.narrative,quote:q,minutePath:minutePaths?.[t.symbol],previous:t.positionIntelligence,
        costRate:ROUND_TRIP_COST,marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),
        entryResponseValidated:!!t.entryContext?.entryResponse,
      });
    t.positionIntelligence=position;t.holdScore=position.holdValueScore;
    const forwardResearch=positionHypothesisGuidance(s.hypothesisResearch,t.side),
      lifecycle=deriveProfitLifecycle({side:t.side,signedRate:signed,peakFavorableRate:t.favorable,
      pullbackRiskRate:t.entryContext?.pullbackRiskRate??originalStopRate,firstProfit:!!t.firstProfitAt,
      costRate:ROUND_TRIP_COST,initialExpectedNetRate:t.entryContext?.remainingSpaceRate??t.forecast?.remainingNetRate??0,
      position,market:marketEvolution,forwardResearch});
    t.profitLifecycle=lifecycle;
    t.holdValue={action:lifecycle.action==="EXIT"?(signed>ROUND_TRIP_COST?"EXIT_PROFIT":"EXIT_RISK"):
      lifecycle.action==="PROTECT"||lifecycle.action==="WATCH"?"REVIEW":position.decision==="HOLD"?"HOLD":"REVIEW",
      pullbackRiskRate:position.expectedPullbackRate,bestHoldMinutes:t.expectedHoldMinutes??180,score:position.holdValueScore};
    if(stopped){closeTrade(s,t,px,now,(t.profitFloorRate??0)>0?"PROFIT_GIVEBACK":"STRUCTURE_STOP");closed.add(t.id);continue;}

    const existingFloor=Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8),
      platformFloor=lifecycle.platformFloorRate>existingFloor?lifecycle.platformFloorRate:0;
    if(platformFloor>0){
      if(signed<=platformFloor){
        if(t.entryContext)t.entryContext.postEntryState=signed>0?"CONFIRMED":"FAILED";
        closeTrade(s,t,px,now,"PROFIT_PLATFORM_BREACH");closed.add(t.id);continue;
      }
      const next=t.entryPrice*(1+d*platformFloor);
      if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
        t.profitFloorRate=platformFloor;t.stopPrice=next;
        event(s,now,"PROTECTION",t.id,lifecycle.platformKind==="RUNNER"
          ?`Runner利润平台提升到约${(platformFloor*100).toFixed(2)}%；只防止灾难性回吐，不限制继续创新高。`
          :`已证明利润平台提升到约${(platformFloor*100).toFixed(2)}%；保留宽松波动空间，避免明显浮盈完整回吐成亏损。`,
          {floorRate:platformFloor,peakNetRate:lifecycle.peakNetRate,platformLevel:lifecycle.platformLevel,
            revaluedPotentialRate:lifecycle.revaluedPotentialRate,runner:lifecycle.runner?1:0});
      }
    }

    if(lifecycle.action==="EXIT"){
      if(t.entryContext)t.entryContext.postEntryState=signed>0?"CONFIRMED":"FAILED";
      closeTrade(s,t,px,now,"RESEARCH_LIFECYCLE_EXIT");closed.add(t.id);continue;
    }
    if(lifecycle.action==="PROTECT"&&lifecycle.floorRate>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
      const buffer=Math.max(position.expectedPullbackRate*.25,ROUND_TRIP_COST*.35),
        executableFloor=Math.min(lifecycle.floorRate,Math.max(0,signed-buffer)),
        floor=executableFloor>ROUND_TRIP_COST*.8?executableFloor:0;
      if(floor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
        const next=t.entryPrice*(1+d*floor);
        if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
          t.profitFloorRate=floor;t.stopPrice=next;
          event(s,now,"PROTECTION",t.id,`研究层进入利润保护：已确认持续衰退；目标保留峰值净利润约${(lifecycle.retentionRate*100).toFixed(0)}%，保护位按当前可执行价格留出正常噪声`,
            {floorRate:floor,peakNetRate:lifecycle.peakNetRate,givebackRatio:lifecycle.givebackRatio??0,
              revaluedPotentialRate:lifecycle.revaluedPotentialRate,runner:lifecycle.runner?1:0});
        }
      }
    }
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}

function markAndManage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const candidates=new Map(s.opportunities.filter(o=>!isIntelligenceOpportunity(o)).map(o=>[o.symbol,o])),relationById=new Map(s.relationEngine.rules.map(r=>[r.id,r])),closed=new Set<string>();
  for(const t of s.positions){if(t.entryContext?.strategyVersion===MARKET_INTELLIGENCE_VERSION)continue;const q=quotes[t.symbol];if(!freshQuote(q,now))continue;const px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side);
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
function isIntelligenceOpportunity(o:Opportunity){return o.strategyVersion===MARKET_INTELLIGENCE_VERSION;}
function annotateLifecycleOpportunities(s:ForwardState,market:MarketEvolutionState){
  for(const o of s.opportunities){
    if(!isIntelligenceOpportunity(o))continue;
    const symbol=s.extremumRegime.symbols[o.symbol];if(!symbol)continue;
    const lifecycle=deriveOpportunityLifecycle({side:o.side,symbol,thesisBars:o.thesisBars??symbol.signalBars,market}),
      future=entryHypothesisGuidance(s.hypothesisResearch,{side:o.side,score:o.score,residualZ:symbol.residualZ,
        residualPersistence:symbol.residualPersistence,sourceCount:symbol.sourceCount,dataConfidence:symbol.dataConfidence});
    o.marketEvolutionPhase=market.phase;o.opportunityLifecyclePhase=lifecycle.phase;
    o.extendedConfirmation=lifecycle.extendedConfirmation||future.extendedConfirmation;o.lifecycleReason=lifecycle.reason;
    o.futureResearchAction=future.action;o.futureResearchReason=future.reason;o.futureHypothesisIds=future.hypothesisIds;
    if(o.extendedConfirmation&&!o.reason.includes("更完整的实时延续确认"))o.reason+=` ${lifecycle.extendedConfirmation?lifecycle.reason:future.reason}`;
  }
}

function openIntelligenceTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number,
  response?:{validation:EntryValidation;decision:EntryResponseDecision}){
  if(!isIntelligenceOpportunity(o))return"新策略身份缺失";
  const side=o.side,d=dir(side),price=side==="LONG"?q.bestAsk:q.bestBid,stopRate=o.stopRate;
  if(!(stopRate>=.004&&stopRate<=.03))return"结构止损宽度不合理";
  const sameCluster=s.positions.find(t=>t.side===side&&o.clusterId&&t.entryContext?.clusterId===o.clusterId);
  if(sameCluster)return"同相关组已有同方向主仓";
  const totalHeadroom=equity*(TOTAL_RISK_RATE-.001)-existingRisk(s),
    sideHeadroom=equity*(SIDE_RISK_RATE-.0005)-existingRisk(s,side),
    cycleHeadroom=equity*FIVE_MINUTE_NEW_RISK_RATE-cycleRiskAdded(s,s.lastCandleAt),
    headroom=Math.min(totalHeadroom,sideHeadroom,cycleHeadroom),
    riskRate=o.premium?.0065:.0055,wantedRisk=equity*riskRate,riskBudget=Math.min(wantedRisk,headroom);
  if(riskBudget<equity*.0035)return"剩余风险预算不足以形成有效仓位";
  const rawNotional=riskBudget/(stopRate+ROUND_TRIP_COST),targetNotional=Math.min(rawNotional,equity*.70),
    leverage=Math.max(1,Math.min(10,Math.floor(contract.leverageMax||10))),mult=Math.max(contract.quantoMultiplier,1e-12),
    minContracts=Math.max(1,Math.ceil(contract.minContracts??(Number(contract.orderSizeMin??1)||1))),
    contracts=Math.floor(targetNotional/(price*mult));
  if(contracts<minContracts)return"低于最小模拟合约数量";
  const quantity=contracts*mult,notional=quantity*price,margin=notional/leverage,totalMargin=s.positions.reduce((n,t)=>n+t.margin,0);
  if(totalMargin+margin>equity*TOTAL_MARGIN_RATE)return"组合保证金已满";
  const consumed=Math.max(0,d*(price/Math.max(o.price,1e-9)-1)),remainingNet=o.netRemainingSpaceRate-consumed;
  if(remainingNet<=0)return"实时入场已消耗剩余空间";
  const plannedRisk=notional*(stopRate+ROUND_TRIP_COST),entryFee=notional*PAPER_COST.feeRate,stopPrice=price*(1-d*stopRate),
    target=price*(1+d*Math.max(.004,o.targetRate-consumed)),horizon=Math.max(60,Math.round(o.expectedHoldMinutes)),
    id=`mi-${now.toString(36)}-${o.symbol.replace(/[^A-Z0-9]/g,"")}-${side[0]}`,
    rule:Rule={id:o.thesisId??o.id,signature:`MARKET_INTELLIGENCE:${o.clusterId??"solo"}:${o.mode}`,parentId:null,version:1,createdAt:now,
      expiresAt:now+Math.max(180,horizon*2.2)*60_000,status:"EXPERIMENTAL",conditions:[],side,horizon,stopRate,
      armRate:0,givebackRate:0,exitMode:"HORIZON",samples:0,trainGroups:0,checkGroups:0,
      estimatedNetRate:remainingNet,priorResponse:null,recentResponse:0,standardError:0,reason:o.reason,mutation:"CREATE",
      grammar:MARKET_INTELLIGENCE_VERSION,liveEligible:false,authority:"ADAPTIVE_TEN",turnTimeframe:"5m"},
    t:Trade={id,symbol:o.symbol,side,rule,openedAt:now,closedAt:null,status:"OPEN",entryPrice:price,exitPrice:null,quantity,contracts,quantoMultiplier:mult,
      notional,leverage,margin,plannedRisk,stopPrice,armPrice:target,favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q.observedAt,entryFee,exitFee:0,
      fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:"REAL_QUOTE_PAPER_MODEL",
      liveEligible:false,firstProfitAt:null,holdScore:o.score,profitFloorRate:0,expectedHoldMinutes:horizon,peakPnlRate:0,
      exitControl:{policy:MARKET_INTELLIGENCE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:"adaptive-ten-entry-v1",capturedAt:now,timeframe:"5m",side,mode:o.mode,reserve:false,reason:o.reason,entryScore:o.score,
        directionStrength:o.directionStrength,spaceScore:o.spaceScore,positionScore:o.positionScore,executionScore:o.executionScore,
        remainingSpaceRate:remainingNet,pullbackRiskRate:o.pullbackRiskRate,edgeRatio:remainingNet/Math.max(o.pullbackRiskRate,1e-9),
        expectedHoldMinutes:horizon,marketFit:o.marketFit,regionId:null,portfolioRiskCharge:riskBudget,strategyVersion:MARKET_INTELLIGENCE_VERSION,
        regime:o.regime,confirmationStage:o.confirmationStage,sourceCount:o.sourceCount,disagreementRate:o.disagreementRate,postEntryState:"PENDING",
        entryResponse:response?{version:ENTRY_RESPONSE_VERSION,startedAt:response.validation.startedAt,confirmedAt:now,
          elapsedMs:Math.max(0,now-response.validation.startedAt),samples:response.validation.samples,
          advanceRate:response.decision.currentAdvanceRate,bestAdvanceRate:response.decision.bestAdvanceRate,
          maxAdverseRate:response.decision.maxAdverseRate,supportFamilies:response.decision.supportFamilies,
          fastLane:response.decision.fastLane}:undefined,
        clusterId:o.clusterId,thesisId:o.thesisId,marketNarrativeId:s.extremumRegime.narrative.id,thesisSummary:o.thesisSummary,
        invalidationSummary:o.invalidationSummary,entryResidual:o.residual,entryRelativeStrength:o.relativeStrength,
        thesisSince:o.thesisSince,thesisBars:o.thesisBars,marketEvolutionPhase:o.marketEvolutionPhase,
        opportunityLifecyclePhase:o.opportunityLifecyclePhase,extendedConfirmation:o.extendedConfirmation,
        futureResearchAction:o.futureResearchAction,futureResearchReason:o.futureResearchReason,futureHypothesisIds:o.futureHypothesisIds},
      forecast:{remainingNetRate:remainingNet,quality:o.score/100,sizingEquity:equity}};
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;
  rememberConsumedThesis(s,o.thesisId,now);
  event(s,now,"ENTRY",id,`${o.symbol} ${side} ${o.mode} 评分${o.score.toFixed(0)}`,{notional,plannedRisk});
  return null;
}

export function extremeResidualConfirmationProfile(input:{
  residual:number;sourceCount:number;dataConfidence:number;disagreementRate:number;recentExtremeLosses:number;
}){
  const extreme=Math.abs(input.residual)>=.05;
  if(!extreme)return{required:false,minimumElapsedMs:12_000,minimumSupportSamples:3,minimumRetainedRate:.70,reason:""};
  const recentLosses=Math.min(2,Math.max(0,Math.floor(input.recentExtremeLosses))),
    dataUnstable=input.sourceCount<5||input.dataConfidence<90||input.disagreementRate>.002,
    minimumElapsedMs=Math.min(120_000,30_000+recentLosses*30_000+(dataUnstable?30_000:0)),
    minimumSupportSamples=4+recentLosses*2+(dataUnstable?1:0),
    minimumRetainedRate=dataUnstable||recentLosses>0?.76:.72;
  return{required:true,minimumElapsedMs,minimumSupportSamples,minimumRetainedRate,
    reason:`极端残差机会不按偏离幅度直接追单；要求${Math.round(minimumElapsedMs/1000)}秒持续实时响应、${minimumSupportSamples}次支持证据后再执行。`};
}

export function stableEntryThesisProfile(input:{
  score:number;premium:boolean;thesisBars:number;stage:"OBSERVE"|"READY";edgeRatio:number;sourceCount:number;dataConfidence:number;
  netRemainingSpaceRate:number;pullbackRiskRate:number;
}){
  const stable=input.stage==="READY"&&input.thesisBars>=2&&input.edgeRatio>=1.45&&input.sourceCount>=3&&input.dataConfidence>=85
      &&(input.score>=80||input.premium||input.thesisBars>=4),
    expected=Math.max(ROUND_TRIP_COST*2,input.netRemainingSpaceRate),
    pullback=Math.max(ROUND_TRIP_COST*1.5,input.pullbackRiskRate),
    maxChaseRate=Math.max(ROUND_TRIP_COST*1.8,Math.min(expected*.45,pullback*.75,.01)),
    retestPullbackMin=Math.max(ROUND_TRIP_COST*.35,Math.min(pullback*.30,expected*.18,.004)),
    restartMin=Math.max(ROUND_TRIP_COST*.30,Math.min(pullback*.15,expected*.10,.002));
  return{stable,maxChaseRate,retestPullbackMin,restartMin,armedWindowMs:stable?12*60_000:0};
}

function rankedEligible(s:ForwardState,now:number){
  return s.opportunities.filter(o=>isIntelligenceOpportunity(o)&&o.eligible&&o.expiresAt>now
    &&!s.positions.some(t=>t.symbol===o.symbol)
    &&!(o.thesisId&&s.consumedTheses[o.thesisId])
    // A PAPER balance reset starts a fresh ledger, not a fresh market episode.
    // lastEntryAt/lastSide survive reset so an already-traded same-side thesis
    // cannot be respawned merely because the account history was archived.
    &&!(s.lastSide[o.symbol]===o.side&&(s.lastEntryAt[o.symbol]??0)>=(o.thesisSince??Infinity))).sort(opportunityCompare);
}

function seedEntryResponses(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const opportunities=new Map(s.opportunities.filter(isIntelligenceOpportunity).map(o=>[o.id,o])),
    preserved:Record<string,EntryValidation>={};
  for(const [id,v] of Object.entries(s.entryValidations)){
    const o=opportunities.get(v.candidateId);
    if(!o||s.positions.some(t=>t.symbol===v.symbol)||(o.thesisId&&s.consumedTheses[o.thesisId]))continue;
    preserved[id]=v;
    if(v.status==="WAITING"&&v.stableThesis){
      const hardEnd=v.startedAt+20*60_000;
      v.expiresAt=Math.max(v.expiresAt,Math.min(o.expiresAt,hardEnd));
      v.deadlineAt=Math.max(v.deadlineAt,Math.min(o.expiresAt,v.startedAt+12*60_000));
    }
  }
  s.entryValidations=preserved;
  const eligible=rankedEligible(s,now),reasons:Record<string,number>={};
  let active=Object.values(s.entryValidations).filter(v=>v.status==="WAITING").length;
  const reject=(reason:string)=>{reasons[reason]=(reasons[reason]??0)+1;};
  for(const o of eligible){
    if(active>=3)break;
    if(s.entryValidations[o.id])continue;
    const q=quotes[o.symbol];if(!freshQuote(q,now)||q!.entryReady!==true){reject("等待实时盘口");continue;}
    const state=s.extremumRegime.symbols[o.symbol],sourceCount=Math.max(o.sourceCount??0,state?.sourceCount??0,q!.sourceCount??0),
      disagreement=q!.disagreementRate??o.disagreementRate??0,
      recentExtremeLosses=s.history.filter(t=>t.symbol===o.symbol&&t.closedAt!=null&&now-t.closedAt<4*60*60_000
        &&(t.netPnl??0)<0&&Math.abs(t.entryContext?.entryResidual??0)>=.05).length,
      extreme=extremeResidualConfirmationProfile({residual:o.residual??0,sourceCount,
        dataConfidence:o.dataConfidence??state?.dataConfidence??0,disagreementRate:disagreement,recentExtremeLosses}),
      profile=entryResponseWindowMs({score:o.score,edgeRatio:o.edgeRatio,sourceCount,disagreementRate:disagreement}),
      stable=stableEntryThesisProfile({score:o.score,premium:!!o.premium,thesisBars:o.thesisBars??state?.signalBars??0,
        stage:o.confirmationStage??state?.stage??"OBSERVE",edgeRatio:o.edgeRatio,sourceCount,
        dataConfidence:o.dataConfidence??state?.dataConfidence??0,netRemainingSpaceRate:o.netRemainingSpaceRate,
        pullbackRiskRate:o.pullbackRiskRate}),
      minimumElapsedMs=Math.max(o.extendedConfirmation?12_000:0,extreme.minimumElapsedMs),
      minimumSupportSamples=Math.max(o.extendedConfirmation?3:0,extreme.minimumSupportSamples),
      minimumRetainedRate=Math.max(o.extendedConfirmation?.70:0,extreme.minimumRetainedRate),
      price=o.side==="LONG"?q!.bestAsk:q!.bestBid,
      expiresAt=stable.stable?Math.min(o.expiresAt,now+20*60_000):Math.min(o.expiresAt,now+BAR_MS),
      deadlineAt=stable.stable?Math.min(expiresAt,now+stable.armedWindowMs)
        :Math.min(o.expiresAt,now+Math.max(profile.windowMs,minimumElapsedMs+30_000));
    s.entryValidations[o.id]={id:o.id,candidateId:o.id,symbol:o.symbol,side:o.side,startedAt:now,expiresAt,deadlineAt,
      initialPrice:price,lastPrice:price,lastQuoteAt:q!.observedAt,samples:1,bestAdvanceRate:0,maxAdverseRate:0,
      supportSamples:0,oppositionSamples:0,extendedConfirmation:!!o.extendedConfirmation||extreme.required,
      extremeResidual:extreme.required,minimumElapsedMs,minimumSupportSamples,minimumRetainedRate,
      stableThesis:stable.stable,phase:"ARMED",initialExpectedNetRate:o.netRemainingSpaceRate,
      pullbackRiskRateAtArm:o.pullbackRiskRate,maxChaseRate:stable.maxChaseRate,retestPullbackMin:stable.retestPullbackMin,
      restartMin:stable.restartMin,retestBasePrice:null,retestBaseAt:null,status:"WAITING",
      reason:extreme.required?extreme.reason:stable.stable
        ?"高质量稳定交易假设已武装；短时反向只进入回测等待，不会直接取消，真正结构失效才解除。"
        :o.extendedConfirmation
        ?(o.futureResearchAction==="CONFIRM_MORE"?"前瞻研究发现状态转移风险，进入加强实时延续确认。":"极端轮动延伸机会进入加强实时延续确认。")
        :profile.fastLane?"高质量机会进入快速实时响应确认。":"候选进入实时响应确认。"};
    active++;
  }
  s.entryDiagnostics={at:now,matched:eligible.length,opened:0,reasons};
}

function advanceEntryResponses(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,
  minutePaths:Record<string,Candle[]>|undefined,now:number,equity:number){
  const opportunities=new Map(s.opportunities.map(o=>[o.id,o])),waiting=Object.values(s.entryValidations)
    .filter(v=>v.status==="WAITING").sort((a,b)=>{
      const ao=opportunities.get(a.candidateId),bo=opportunities.get(b.candidateId);
      if(!ao)return bo?1:0;if(!bo)return-1;return opportunityCompare(ao,bo);
    });
  const reasons:Record<string,number>={};let opened=0;
  const reject=(reason:string)=>{reasons[reason]=(reasons[reason]??0)+1;};
  for(const validation of waiting){
    const o=opportunities.get(validation.candidateId);
    if(!o||!isIntelligenceOpportunity(o)||o.expiresAt<=now){
      validation.status="CANCELLED";validation.reason="交易假设已过期或已被新的完成5m结构替代";reject(validation.reason);continue;
    }
    const q=quotes[validation.symbol];if(!freshQuote(q,now)||q!.entryReady!==true){reject("等待实时盘口");continue;}
    const price=validation.side==="LONG"?q!.bestAsk:q!.bestBid,state=s.extremumRegime.symbols[validation.symbol],
      decision=evaluateEntryResponse({now,side:validation.side,score:o.score,edgeRatio:o.edgeRatio,pullbackRiskRate:o.pullbackRiskRate,
        stopRate:o.stopRate,sourceCount:o.sourceCount??0,disagreementRate:o.disagreementRate??0,price,
        memory:{startedAt:validation.startedAt,deadlineAt:validation.deadlineAt,initialPrice:validation.initialPrice,samples:validation.samples,
          bestAdvanceRate:validation.bestAdvanceRate,maxAdverseRate:validation.maxAdverseRate,
          supportSamples:validation.supportSamples,oppositionSamples:validation.oppositionSamples},
        state,quote:q,minutePath:minutePaths?.[validation.symbol],costRate:ROUND_TRIP_COST,allowRetest:!!validation.stableThesis});
    validation.lastPrice=price;validation.lastQuoteAt=q!.observedAt;validation.samples++;
    validation.bestAdvanceRate=decision.bestAdvanceRate;validation.maxAdverseRate=decision.maxAdverseRate;
    validation.supportSamples=decision.supportSamples;validation.oppositionSamples=decision.oppositionSamples;validation.reason=decision.reason;

    if(decision.action==="CANCEL"){validation.status="CANCELLED";reject(decision.reason);continue;}
    if(decision.action==="RETEST"){
      validation.phase="RETEST_WAIT";
      validation.reason=decision.reason;reject(decision.reason);continue;
    }
    if(decision.action==="WAIT"){reject(decision.reason);continue;}

    if(validation.stableThesis){
      const d=dir(validation.side),expected=Math.max(ROUND_TRIP_COST*2,validation.initialExpectedNetRate??o.netRemainingSpaceRate),
        pullback=Math.max(ROUND_TRIP_COST*1.5,validation.pullbackRiskRateAtArm??o.pullbackRiskRate),
        maxChase=Math.max(ROUND_TRIP_COST*1.8,validation.maxChaseRate??Math.min(expected*.45,pullback*.75,.01)),
        pullbackMin=Math.max(ROUND_TRIP_COST*.35,validation.retestPullbackMin??Math.min(pullback*.30,expected*.18,.004)),
        restartMin=Math.max(ROUND_TRIP_COST*.30,validation.restartMin??Math.min(pullback*.15,expected*.10,.002)),
        best=Math.max(validation.bestAdvanceRate,decision.bestAdvanceRate),current=decision.currentAdvanceRate,
        retrace=Math.max(0,best-current),requiredPullback=Math.max(pullbackMin,best-maxChase),
        remainingFromThesis=expected-Math.max(0,current);

      if(best>=maxChase){
        validation.phase="RETEST_WAIT";
        if(!validation.retestBasePrice){
          if(retrace<requiredPullback){
            validation.reason=`方向判断仍有效，但从首次武装位置已推进 ${(best*100).toFixed(2)}%，超过允许追价 ${(maxChase*100).toFixed(2)}%；不追，等待至少 ${(requiredPullback*100).toFixed(2)}% 回调后重新启动。`;
            reject(validation.reason);continue;
          }
          validation.retestBasePrice=price;validation.retestBaseAt=now;validation.supportSamples=0;validation.oppositionSamples=0;
          validation.reason="价格已回到可重新评估的位置，保留原稳定假设，等待回调结束后再次按原方向启动。";
          reject(validation.reason);continue;
        }

        let restart=d*(price/validation.retestBasePrice-1);
        if(restart<0){
          validation.retestBasePrice=price;validation.retestBaseAt=now;validation.supportSamples=0;validation.oppositionSamples=0;
          validation.reason="回调仍在延伸，持续更新重启基准，不提前猜转折。";reject(validation.reason);continue;
        }
        if(restart<restartMin){
          validation.reason=`已完成必要回调，等待原方向重新推进至少 ${(restartMin*100).toFixed(2)}% 后再执行。`;
          reject(validation.reason);continue;
        }
        if(remainingFromThesis<=Math.max(ROUND_TRIP_COST*1.4,pullback*.45)){
          validation.reason="原始交易空间已经大部分消耗，即使方向继续正确也不在当前位置追入；等待新的5m结构生成新假设。";
          reject(validation.reason);continue;
        }
      }
    }

    if(!extendedEntryConfirmationReady({required:!!validation.extendedConfirmation,elapsedMs:Math.max(0,now-validation.startedAt),
      supportSamples:decision.supportSamples,currentAdvanceRate:decision.currentAdvanceRate,bestAdvanceRate:decision.bestAdvanceRate,
      minimumElapsedMs:validation.minimumElapsedMs,minimumSupportSamples:validation.minimumSupportSamples,
      minimumRetainedRate:validation.minimumRetainedRate})){
      validation.reason=validation.extremeResidual
        ?"极端残差仍在验证稳定性，尚未获得足够持续实时响应"
        :"研究层要求更完整的实时延续确认，当前证据仍不足";
      reject(validation.reason);continue;
    }
    const meta=contracts[o.symbol];if(!meta){reject("等待合约规格");continue;}
    const last=s.lastExitAt[o.symbol]??0,lastSide=s.lastSide[o.symbol];
    if(now-last<15*60_000&&lastSide===o.side){validation.status="CANCELLED";validation.reason="同币同方向假设尚未重置";reject(validation.reason);continue;}
    const error=openIntelligenceTrade(s,o,q!,meta,now,equity,{validation,decision});
    if(error){validation.status="CANCELLED";validation.reason=error;reject(error);continue;}
    opened=1;delete s.entryValidations[validation.id];break;
  }
  s.entryDiagnostics={at:now,matched:waiting.length,opened,reasons};return opened;
}

export function fillForwardPortfolio(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,equity:number,premiumOnly:boolean){
  const eligible=rankedEligible(s,now).filter(o=>!premiumOnly||o.premium||s.entryValidations[o.id]?.status==="WAITING");
  // One completed whole-market step chooses one best new expression. The
  // portfolio can still accumulate many independent theses over time, but it
  // cannot spray every currently-positive score into positions at once.
  s.entryDiagnostics={at:now,matched:eligible.length,opened:0,reasons:{}};
  let opened=0;const reject=(reason:string)=>{s.entryDiagnostics.reasons[reason]=(s.entryDiagnostics.reasons[reason]??0)+1;};
  for(const o of eligible){
    const q=quotes[o.symbol],meta=contracts[o.symbol];if(!freshQuote(q,now)||q!.entryReady!==true){reject("等待实时盘口");continue;}
    if(!meta){reject("等待合约规格");continue;}
    const last=s.lastExitAt[o.symbol]??0,lastSide=s.lastSide[o.symbol];
    if(now-last<15*60_000&&lastSide===o.side){reject("同币同方向假设尚未重置");continue;}
    const error=openIntelligenceTrade(s,o,q!,meta,now,equity);if(error){reject(error);continue;}
    opened=1;break;
  }
  s.entryDiagnostics.opened=opened;return opened;
}
function nextCandleAt(paths:Record<string,Candle[]>,now:number){
  let latest=0;for(const p of Object.values(paths)){const a=validPath(p,now);if(a)latest=Math.max(latest,(a.at(-1)!.time+300)*1000);}return latest;
}
export function advanceForward(input:{state:ForwardState;now:number;paths:Record<string,Candle[]>;minutePaths?:Record<string,Candle[]>;daily?:Record<string,Candle[]>;
  quotes:Record<string,Quote>;contracts:Record<string,Contract>;entrySymbols?:Iterable<string>;learningSymbols?:Iterable<string>;allowDataCycle?:boolean;
  legacyDrainOnly?:boolean;research?:MarketLifecycleResearchContext}){
  const s=normalizeForward(structuredClone(input.state),input.now),
    before=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate]),h:s.history.length,b:s.balance,r:s.revision});
  s.lastQuoteCycleAt=input.now;
  const allowed=input.entrySymbols?new Set(input.entrySymbols):undefined,
    candleAt=nextCandleAt(input.paths,input.now),
    dataDue=input.allowDataCycle!==false&&candleAt>s.lastCandleAt,
    readyPaths=Object.values(input.paths).filter(rows=>!!validPath(rows,input.now)).length,
    expectedMarkets=Math.max(1,allowed?.size??Math.max(Object.keys(input.paths).length,s.selectedSymbols.length)),
    requiredPaths=Math.min(expectedMarkets,Math.max(3,Math.ceil(expectedMarkets*.60))),
    marketReady=readyPaths>=requiredPaths;
  if(marketReady){
    const priorNarrative=structuredClone(s.extremumRegime.narrative),priorHistory=structuredClone(s.extremumRegime.history),
      priorInternals=s.extremumRegime.internals?structuredClone(s.extremumRegime.internals):undefined,
      built=buildMarketIntelligence({paths:input.paths,minutePaths:input.minutePaths,daily:input.daily,quotes:input.quotes,
        previous:s.extremumRegime,now:input.now,allowed});
    if(!dataDue){
      built.state.narrative=priorNarrative;
      built.state.history=priorHistory;
      built.state.internals=priorInternals;
    }
    s.extremumRegime=built.state;s.marketPulse=built.pulse;s.opportunities=built.opportunities;
    if(dataDue){s.lastCandleAt=candleAt;s.lastCycleAt=input.now;}
    s.selectedSymbols=Object.values(s.extremumRegime.symbols).sort((a,b)=>b.watchScore-a.watchScore).slice(0,30).map(row=>row.symbol);
  }else{
    // A Worker restart restores durable strategy memory before in-memory 5m
    // paths have been rehydrated. Preserve the last confirmed whole-market map
    // for existing-position protection, but never create fresh entries from a
    // partial market snapshot.
    s.opportunities=[];
    s.extremumRegime.coverage={...s.extremumRegime.coverage,intradayMarkets:readyPaths};
    s.entryDiagnostics={at:input.now,matched:0,opened:0,reasons:{[`等待全市场路径恢复 ${readyPaths}/${requiredPaths}`]:1}};
  }

  if(marketReady&&dataDue)s.hypothesisResearch=advanceMarketHypothesisResearch(s.hypothesisResearch,s.extremumRegime,input.now);
  const marketEvolution=deriveMarketEvolution(s.extremumRegime,input.research);
  if(marketReady)annotateLifecycleOpportunities(s,marketEvolution);
  manageIntelligenceTrades(s,input.quotes,input.now,input.minutePaths,marketEvolution);
  // Positions opened before cutover keep their frozen lifecycle and cannot gain
  // new-entry authority from the retired relation/region/interrupt stack.
  markAndManage(s,input.quotes,input.now);

  const mark=equityMark(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));updateDaily(s,input.now,mark.equity);
  // A completed 5m step chooses a bounded set of hypotheses; the critical 2s
  // quote clock then waits for real price/flow response and may open at most one.
  if(marketReady&&dataDue)seedEntryResponses(s,input.quotes,input.now);
  const opened=marketReady?advanceEntryResponses(s,input.quotes,input.contracts,input.minutePaths,input.now,mark.equity):0;

  const states=Object.values(s.extremumRegime.symbols),longReady=states.filter(x=>x.longScore>=62).length,
    shortReady=states.filter(x=>x.shortScore>=62).length,divergent=states.filter(x=>x.regime==="DIVERGENT").length,
    ready=states.filter(x=>x.stage==="READY").length,totalRisk=existingRisk(s),riskUse=mark.equity>0?100*totalRisk/mark.equity:0;
  s.fitDiagnostics={tested:states.length,qualified:s.opportunities.filter(o=>o.eligible).length,trainGroups:s.extremumRegime.clusters.length,
    checkGroups:s.extremumRegime.evidence.length,latestAt:input.now,rapidQualified:ready,activeLong:longReady,activeShort:shortReady};
  s.latestReason=(marketReady?s.extremumRegime.narrative.summary
    :`全市场5m路径正在恢复 ${readyPaths}/${requiredPaths}；沿用上一份市场叙事保护已有仓位，覆盖恢复前不生成新单。`)
    +` 当前${s.positions.length}笔持仓，${s.opportunities.filter(o=>o.eligible).length}个可参与异类机会，计划风险已用${riskUse.toFixed(1)}%。 ${s.extremumRegime.narrative.plan} 生命周期研究：${marketEvolution.reason} ${s.hypothesisResearch.summary}`;
  if(divergent)s.latestReason+=` 当前发现${divergent}个明显分化资产。`;
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
  // Reset the PAPER wallet/ledger only. Market Intelligence is an independent
  // continuously-running observer and must not lose its narrative, evidence,
  // correlation map or per-symbol signal episode when the user resets funds.
  next.extremumRegime=structuredClone(prior.extremumRegime);
  next.marketPulse=structuredClone(prior.marketPulse);
  next.selectedSymbols=[...prior.selectedSymbols];
  next.lastCandleAt=prior.lastCandleAt;
  next.lastCycleAt=prior.lastCycleAt;
  next.lastQuoteCycleAt=prior.lastQuoteCycleAt;
  next.fitDiagnostics=structuredClone(prior.fitDiagnostics);
  // Do not carry executable candidates across an account reset. The next
  // completed whole-market 5m step must rebuild opportunities. Keeping the
  // candle cursor prevents the same already-processed 5m step from reopening.
  next.opportunities=[];
  next.entryValidations={};
  // Preserve episode-consumption memory without preserving the old account
  // trade ledger itself. This prevents reset from making an already-traded
  // anomaly look like a brand-new thesis.
  next.lastEntryAt={...prior.lastEntryAt};
  next.lastExitAt={...prior.lastExitAt};
  next.lastSide={...prior.lastSide};
  next.consumedTheses={...prior.consumedTheses};
  next.relationEngine=structuredClone(prior.relationEngine);
  next.familyExperiment=structuredClone(prior.familyExperiment);
  next.hypothesisResearch=structuredClone(prior.hypothesisResearch);
  next.observations=next.relationEngine.observations;next.measured=next.relationEngine.measured;next.invalidated=next.relationEngine.invalidated;
  next.latestReason="模拟账户资金已重置为1000U；保留 Market Intelligence 市场叙事、证据、相关组和异常生命周期，当前5m不会因重置重复开仓。";
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
  return intelligenceUrgentMinuteSymbols(s.extremumRegime,allowed).slice(0,FORWARD_MINUTE_CONFIRMATION_CAP);
}
export function forwardWatchSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  return forwardUrgentQuoteSymbols(s,now,entrySymbols).slice(0,FORWARD_EXECUTION_BBO_CAP);
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const mark=equityMark(s,quotes,now),eligible=s.opportunities.filter(o=>o.eligible&&o.expiresAt>now),reserve=eligible.filter(o=>o.reserve),
    rows=Object.values(s.extremumRegime.symbols).sort((a,b)=>b.watchScore-a.watchScore),
    validations=Object.values(s.entryValidations).sort((a,b)=>b.startedAt-a.startedAt),
    counts={bullish:rows.filter(r=>r.longScore>=62).length,bearish:rows.filter(r=>r.shortScore>=62).length,
      divergent:rows.filter(r=>r.regime==="DIVERGENT").length,transition:rows.filter(r=>r.regime==="TRANSITION").length,
      ready:rows.filter(r=>r.stage==="READY").length};
  return{version:s.version,engineVersion:ADAPTIVE_ENGINE_VERSION,grammar:ADAPTIVE_ENGINE_VERSION,positionIntelligenceVersion:POSITION_INTELLIGENCE_VERSION,mode:"REAL_FEED_PAPER",liveEligible:false,
    strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:MARKET_INTELLIGENCE_VERSION,
    regionLaunchVersion:MARKET_INTELLIGENCE_VERSION,policyVersion:ADAPTIVE_ENGINE_VERSION,exitPolicyVersion:ADAPTIVE_ENGINE_VERSION,
    policyUpgrade:null,exitPolicyUpgrade:null,startedAt:s.startedAt,cutoverAt:s.cutoverAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...mark,targetEquity:s.initialEquity*2,
    netPnl:mark.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,fees:s.fees,
    fundingAllowance:s.fundingAllowance,turnover:s.turnover,positions:s.positions,history:s.history,events:s.events,daily:s.daily,
    opportunities:s.opportunities,entryOpportunities:s.opportunities,regions:[],marketPulse:s.marketPulse,
    hypothesisResearch:s.hypothesisResearch,
    marketIntelligence:{...s.extremumRegime,counts,symbols:rows.slice(0,30)},
    extremumRegime:{version:"retired",updatedAt:s.extremumRegime.updatedAt,retired:true,counts:{},symbols:[]},
    structuralInterrupt:{version:STRUCTURAL_INTERRUPT_VERSION,retired:true,marketEvent:null,vetoSide:null,vetoUntil:0,preAlerts:0,confirmed:0},
    relationEngine:{version:s.relationEngine.version,retired:true,updatedAt:s.relationEngine.updatedAt,diagnostics:s.relationEngine.diagnostics,rules:[]},
    familyExperiment:{retired:true,...familyExperimentSummary(s.familyExperiment),maxNewReservePer5m:0},
    entryValidation:{waiting:validations.filter(v=>v.status==="WAITING").length,cancelled:validations.filter(v=>v.status==="CANCELLED").length,
      records:validations.slice(0,6)},
    marketCount:s.selectedSymbols.length,markets:s.selectedSymbols,latestReason:s.latestReason,entryDiagnostics:s.entryDiagnostics,
    fitDiagnostics:s.fitDiagnostics,storage:s.storage,targetPositions:null,positionLimit:null,executionBboCapacity:FORWARD_EXECUTION_BBO_CAP,
    minuteConfirmationCapacity:FORWARD_MINUTE_CONFIRMATION_CAP,seatCount:s.positions.length,eligibleCount:eligible.length,
    reserveCount:reserve.length,premiumCount:eligible.filter(o=>o.premium).length,
    boundaries:{scope:"PAPER_AUTHORITY",
      grammar:"四层市场智能：超大周期→大方向→短期变化→相对机会。系统先理解整个市场，再选择同相关组中性价比最高的交易表达。",
      historyBackfill:false,
      sampleMeaning:"不依赖旧策略样本训练；只使用当前已完成K线、多交易所实时共识和持续市场记忆做因果判断。",
      accounting:"模拟仍使用新鲜买卖价并计入手续费、滑点和资金费占位；每笔新Trade冻结独立交易假设、相关组、失效条件与持仓计划。",
      risk:"总结构风险≤10%、同方向≤6.5%、组合保证金≤75%；同一高相关组正常只允许一个同方向主仓，反方向独立假设可并存。",
      validation:"任何细节都会进入证据池，但单一噪声不能让大方向来回翻转；前瞻研究把重要细节转成未来状态假设，并持续验证5/15/30分钟预期路径。它不靠单一信号否决交易，也不削弱高质量独立机会的原快速通道；只有多类前瞻证据与候选方向冲突时才要求更完整的实时延续确认。",
      liquidation:"固定结构止损仍是最后保险；Position Intelligence只提供仓位证据，Lifecycle Research拥有最终主动退出权。单一细节、单一市场转向或连续两根5m都没有独立平仓权。单次前瞻假设或某一轮Position EXIT同样没有独立平仓权。实际发展显著超过入场预期的Runner会动态上调未来空间，并在跨越离散利润台阶后留下宽松Runner平台防止灾难性回吐；普通单形成超过正常噪声的已证明利润后也会建立更低的平台防止浮盈完整转亏。平台不随每个tick追价；只有多轮持续恶化才触发更主动的PROTECT或EXIT。"},
    cost:PAPER_COST,nextCycleAt:s.lastCandleAt+BAR_MS};
}
