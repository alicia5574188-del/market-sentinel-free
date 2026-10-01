import {RESEARCH_PLAN_VERSION,researchPlanContext,type PlanResearchDecision} from './research-plan.ts';
import {assertInverseTrade,assertInverseTrial,inverseTrialSummary,sourceDecisionState,shadowCapsule,applyInverseSourceTrade,migrateInverseSamePrice,type InverseCopy,type InverseTrial} from './shadow-inverse-ledger.ts';
import {advanceWinnerManagement, trendCore, WINNER_POLICY_VERSION, type WinnerPlan, type WinnerManagement} from "./winner-policy.ts";
import {realizeTradeSlice, realizedContribution, remainingTradeFraction, assertTradeRealization, type TradeRealization} from "./trade-realization.ts";
import {winnerEventHeadroom, recordWinnerRiskLoss, type WinnerRiskLedger} from "./winner-risk.ts";
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
  type LiquidityTradePlan, type MarketIntelligenceState, type MarketSymbolState } from "./market-intelligence-engine.ts";
import { evaluatePositionIntelligence, POSITION_INTELLIGENCE_VERSION,
  type PositionIntelligenceState } from "./position-intelligence-engine.ts";
import {capturePositionBaseline} from "./position-evidence-contract.ts";
import { beijingDayKey } from "./beijing-time.ts";
import { ENTRY_RESPONSE_VERSION, entryResponseWindowMs, evaluateEntryResponse,
  type EntryResponseDecision } from "./market-intelligence-entry-response.ts";
import { deriveMarketEvolution, deriveOpportunityLifecycle, extendedEntryConfirmationReady,
  type MarketEvolutionState, type MarketLifecycleResearchContext,
  type OpportunityLifecyclePhase, type ProfitLifecycleState } from "./market-intelligence-lifecycle.ts";
import { advanceMarketHypothesisResearch, entryHypothesisGuidance, initialMarketHypothesisResearch,
  normalizeMarketHypothesisResearch,
  type EntryHypothesisGuidance, type MarketHypothesisResearchState } from "./market-intelligence-hypothesis-research.ts";
import { ENVIRONMENT_OUTLOOK_VERSION, ENVIRONMENT_ROUTER_VERSION, classifyMarketEnvironment, deriveEnvironmentOutlook,
  deriveFastEnvironmentSignal, environmentModeFit, routeEnvironmentOpportunity,
  initialEnvironmentPerformanceState, normalizeEnvironmentPerformanceState, recordEnvironmentOutcome,
  type EnvironmentOutlook, type EnvironmentPerformanceState, type EnvironmentPlaybook, type MarketEnvironment, type RouteAlignment
} from "./market-intelligence-environment-router.ts";

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
const FIVE_MINUTE_NEW_RISK_RATE=.015;
const ENTRY_VALIDATION_CAP=6,PORTFOLIO_POSITION_CAP=10,CONTINUATION_SIDE_RISK_RATE=.025,EXECUTION_EDGE_FLOOR=1.25;
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
  winnerPlan?:WinnerPlan;
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
  environment?:MarketEnvironment;playbook?:EnvironmentPlaybook;routeAlignment?:RouteAlignment;
  environmentPriority?:number;environmentScore?:number;environmentRiskScale?:number;environmentProbe?:boolean;
  environmentForceRetest?:boolean;environmentMainline?:boolean;environmentModeFit?:number;environmentOutlook?:EnvironmentOutlook;environmentReason?:string;
  probeImpulseMin?:number;probePullbackMin?:number;probeRestartMin?:number;
  tradePlan?:LiquidityTradePlan;liquidityPlanConfidence?:number;liquidityReason?:string;liquidityTargetRate?:number|null;
  liquidityOriginLower?:number|null;liquidityOriginUpper?:number|null;liquidityTargetLower?:number|null;liquidityTargetUpper?:number|null;
  liquidityInvalidationPrice?:number|null;liquidityInvalidationRate?:number|null;
  rapidLiquidityAuthorization?:boolean;rapidLiquidityReason?:string|null;
  futureResearchAction?:EntryHypothesisGuidance["action"];futureResearchReason?:string;futureHypothesisIds?:string[];
};
export type MarketPulse={at:number;up:number;down:number;neutral:number;bias:"UP"|"DOWN"|"MIXED";strength:number;expansion:number};

export type EntryContext={
  winnerPlan?:WinnerPlan;
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
  extendedConfirmation?:boolean;environment?:MarketEnvironment;playbook?:EnvironmentPlaybook;routeAlignment?:RouteAlignment;
  environmentRiskScale?:number;environmentProbe?:boolean;environmentReason?:string;
  environmentOutlookVersion?:typeof ENVIRONMENT_OUTLOOK_VERSION;environmentModeFit?:number;environmentHorizonMinutes?:15|30|45|60;
  environmentPersistenceScore?:number;environmentTransitionPressure?:number;environmentProfitExpansion?:EnvironmentOutlook["profitExpansion"];
  tradePlan?:LiquidityTradePlan;liquidityPlanConfidence?:number;liquidityReason?:string;liquidityTargetRate?:number|null;
  liquidityOriginLower?:number|null;liquidityOriginUpper?:number|null;liquidityTargetLower?:number|null;liquidityTargetUpper?:number|null;
  liquidityInvalidationPrice?:number|null;rapidLiquidityAuthorization?:boolean;
  baseEntryScore?:number;environmentScore?:number;
  futureResearchAction?:EntryHypothesisGuidance["action"];futureResearchReason?:string;futureHypothesisIds?:string[];
};
import type {ReviewEvent, TradeReview} from "./review-trace.ts";

export type Trade={
  inverseCopy?:InverseCopy;
  winnerManagement?:WinnerManagement;realization?:TradeRealization;
  review?:TradeReview;
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
  exitAudit?:{trigger:string;at:number;detail?:string;evidence?:Record<string,string|number|boolean|null>;research?:PlanResearchDecision};
  holdValue?:{action:"HOLD"|"REVIEW"|"EXIT_PROFIT"|"EXIT_RISK";pullbackRiskRate:number;bestHoldMinutes:number;score:number};
  positionIntelligence?:PositionIntelligenceState;
  liquidityLifecycle?:{currentPlan:LiquidityTradePlan;upgradedAt:number|null;reason:string;
    originLower:number|null;originUpper:number|null;targetLower:number|null;targetUpper:number|null;invalidationPrice:number|null};
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
  frozenOpportunity?:Opportunity;authorizedAt?:number;
  maxChaseRate?:number;retestPullbackMin?:number;restartMin?:number;retestBasePrice?:number|null;retestBaseAt?:number|null;
  environment?:MarketEnvironment;playbook?:EnvironmentPlaybook;requiresProbeRetest?:boolean;probeImpulseMin?:number;
  probePullbackMin?:number;probeRestartMin?:number;probeRetestSeen?:boolean;
  status:"WAITING"|"CANCELLED";reason:string|null};
export type ForwardState={
  inverseTrial?:InverseTrial;
  winnerRisk?:WinnerRiskLedger;
  version:string;engineVersion:string;startedAt:number;revision:number;lastCycleAt:number;lastQuoteCycleAt:number;lastCandleAt:number;
  balance:number;initialEquity:number;peakEquity:number;maxDrawdown:number;resolved:number;wins:number;grossPnl:number;fees:number;
  fundingAllowance:number;turnover:number;positions:Trade[];history:Trade[];events:AuditEvent[];daily:Daily[];
  selectedSymbols:string[];opportunities:Opportunity[];regions:Record<string,Region>;relationEngine:RelationEngineState;extremumRegime:MarketIntelligenceState;
  familyExperiment:FamilyExperimentState;structuralInterrupt:StructuralInterruptState;
  hypothesisResearch:MarketHypothesisResearchState;environmentPerformance:EnvironmentPerformanceState;
  environmentContext:{version:typeof ENVIRONMENT_ROUTER_VERSION;environment:MarketEnvironment;phase:MarketEvolutionState["phase"];
    trendSide:"LONG"|"SHORT"|null;updatedAt:number;reason:string;outlook?:EnvironmentOutlook};
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
    hypothesisResearch:initialMarketHypothesisResearch(now),environmentPerformance:initialEnvironmentPerformanceState(),
    environmentContext:{version:ENVIRONMENT_ROUTER_VERSION,environment:"TRANSITION",phase:"TRANSITIONAL",
      trendSide:null,updatedAt:now,reason:"环境路由正在建立稳定市场分类。"},
    entryValidations:{},marketPulse:blankPulse(now),
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
  assertInverseTrade(t);
  assertTradeRealization(t);
  t.side=side;t.rule=normalizeRule(t,now);t.status=t.status==="CLOSED"?"CLOSED":"OPEN";
  t.openedAt=safe(t.openedAt,now);t.closedAt=t.status==="CLOSED"?safe(t.closedAt,now):null;
  t.entryPrice=tick;t.lastPrice=Math.max(1e-9,safe(t.lastPrice,t.entryPrice));t.lastQuoteAt=safe(t.lastQuoteAt,t.openedAt);
  t.stopPrice=Math.max(1e-9,safe(t.stopPrice,side==="LONG"?t.entryPrice*.99:t.entryPrice*1.01));
  t.armPrice=Math.max(1e-9,safe(t.armPrice,side==="LONG"?t.entryPrice*1.01:t.entryPrice*.99));
  t.quantoMultiplier=Math.max(1e-12,safe(t.quantoMultiplier,1));t.contracts=t.realization?t.contracts:Math.max(1,safe(t.contracts,1));
  t.quantity=Math.max(1e-12,safe(t.quantity,t.contracts*t.quantoMultiplier));
  t.notional=Math.max(1e-9,safe(t.notional,t.quantity*t.entryPrice));t.leverage=Math.max(1,safe(t.leverage,8));
  t.margin=Math.max(1e-9,safe(t.margin,t.notional/t.leverage));t.plannedRisk=Math.max(0,safe(t.plannedRisk,t.notional*.01));
  t.favorable=Math.max(0,safe(t.favorable));t.adverse=Math.max(0,safe(t.adverse));t.entryFee=Math.max(0,safe(t.entryFee,t.notional*PAPER_COST.feeRate));
  t.exitFee=Math.max(0,safe(t.exitFee));t.fundingAllowance=Math.max(0,safe(t.fundingAllowance));t.grossPnl=t.grossPnl??null;t.netPnl=t.netPnl??null;
  t.exitReason=t.exitReason??null;t.relationFailureBars=Math.max(0,Math.floor(safe(t.relationFailureBars)));t.lastRelationBar=safe(t.lastRelationBar,t.openedAt);
  t.execution="REAL_QUOTE_PAPER_MODEL";t.liveEligible=false;t.firstProfitAt=t.firstProfitAt??null;t.holdScore=safe(t.holdScore,50);
  t.profitFloorRate=Math.max(0,safe(t.profitFloorRate));t.exitPlan=t.exitPlan&&(t.exitPlan.version==="sample-exit-plan-v1"||t.exitPlan.version==="sample-exit-plan-v2")?t.exitPlan:undefined;
  if(t.liquidityLifecycle)t.liquidityLifecycle.invalidationPrice=Number.isFinite(t.liquidityLifecycle.invalidationPrice)
    ?t.liquidityLifecycle.invalidationPrice!:Number.isFinite(t.entryContext?.liquidityInvalidationPrice)?t.entryContext!.liquidityInvalidationPrice!:null;
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
      lastQuoteAt:Math.max(0,safe(r.lastQuoteAt)),samples:Math.max(0,Math.floor(safe(r.samples))),
      bestAdvanceRate:Math.max(0,safe(r.bestAdvanceRate)),maxAdverseRate:Math.max(0,safe(r.maxAdverseRate)),
      supportSamples:Math.max(0,Math.floor(safe(r.supportSamples))),oppositionSamples:Math.max(0,Math.floor(safe(r.oppositionSamples))),
      extendedConfirmation:!!r.extendedConfirmation,extremeResidual:!!r.extremeResidual,
      minimumElapsedMs:Math.max(0,safe(r.minimumElapsedMs)),minimumSupportSamples:Math.max(0,Math.floor(safe(r.minimumSupportSamples))),
      minimumRetainedRate:Math.max(0,safe(r.minimumRetainedRate)),stableThesis:!!r.stableThesis,
      phase:r.phase==="RETEST_WAIT"?"RETEST_WAIT":"ARMED",
      frozenOpportunity:r.frozenOpportunity&&typeof r.frozenOpportunity==="object"
        &&typeof (r.frozenOpportunity as Opportunity).id==="string"
        &&typeof (r.frozenOpportunity as Opportunity).symbol==="string"
        &&(((r.frozenOpportunity as Opportunity).side==="LONG")||((r.frozenOpportunity as Opportunity).side==="SHORT"))
          ?structuredClone(r.frozenOpportunity as Opportunity):undefined,
      authorizedAt:Math.max(0,safe(r.authorizedAt,startedAt)),
      initialExpectedNetRate:Math.max(0,safe(r.initialExpectedNetRate)),pullbackRiskRateAtArm:Math.max(0,safe(r.pullbackRiskRateAtArm)),
      maxChaseRate:Math.max(0,safe(r.maxChaseRate)),retestPullbackMin:Math.max(0,safe(r.retestPullbackMin)),
      restartMin:Math.max(0,safe(r.restartMin)),
      retestBasePrice:Number.isFinite(r.retestBasePrice)?Math.max(1e-12,r.retestBasePrice!):null,
      retestBaseAt:Number.isFinite(r.retestBaseAt)?Math.max(0,r.retestBaseAt!):null,
      environment:r.environment,playbook:r.playbook,requiresProbeRetest:!!r.requiresProbeRetest,
      probeImpulseMin:Math.max(0,safe(r.probeImpulseMin)),probePullbackMin:Math.max(0,safe(r.probePullbackMin)),
      probeRestartMin:Math.max(0,safe(r.probeRestartMin)),probeRetestSeen:!!r.probeRetestSeen,
      status:r.status==="CANCELLED"?"CANCELLED":"WAITING",reason:typeof r.reason==="string"?r.reason:null};
  }
  return out;
}
export function normalizeForward(v:ForwardState|null|undefined,now:number):ForwardState{
  if(!v)return initialForward(now);
  migrateInverseSamePrice(v,now);assertInverseTrial(v);
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
    environmentPerformance:normalizeEnvironmentPerformanceState((old as {environmentPerformance?:unknown}).environmentPerformance,history,now),
    environmentContext:(old as {environmentContext?:ForwardState["environmentContext"]}).environmentContext?.version===ENVIRONMENT_ROUTER_VERSION
      ?structuredClone((old as {environmentContext:ForwardState["environmentContext"]}).environmentContext):base.environmentContext,
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
  return Number(b.eligible)-Number(a.eligible)
    ||Number(!b.reserve)-Number(!a.reserve)
    ||(b.environmentPriority??0)-(a.environmentPriority??0)
    ||Number(b.premium)-Number(a.premium)
    ||(b.environmentScore??b.score)-(a.environmentScore??a.score)
    ||b.score-a.score;
}
function equityMark(s:ForwardState,quotes:Record<string,Quote>,now:number){
  let floating=0,stale=0;
  for(const t of s.positions){
    if(t.inverseCopy){
      const source=s.inverseTrial?.source.positions.find(x=>x.id===t.inverseCopy!.sourceId),
        valid=!!source&&Number.isFinite(source.lastPrice)&&source.lastPrice>0&&Number.isFinite(source.lastQuoteAt)&&source.lastQuoteAt<=now;
      const px=valid?source!.lastPrice:t.lastPrice;if(!valid||now-source!.lastQuoteAt>10000)stale++;
      // Entry fee has already been debited from balance; future close fee is not paid yet.
      floating+=dir(t.side)*t.quantity*(px-t.entryPrice);continue;
    }
    const q=quotes[t.symbol],fresh=freshQuote(q,now),px=fresh?midpoint(q):t.lastPrice;if(!fresh)stale++;
    floating+=dir(t.side)*t.quantity*(px-t.entryPrice)-t.quantity*px*PAPER_COST.feeRate;
  }
  return{equity:s.balance+floating,floating,stalePositions:stale};
}
export function forwardEquity(s:ForwardState,quotes:Record<string,Quote>,now:number){return equityMark(s,quotes,now);}
function updateDaily(s:ForwardState,now:number,equity:number){
  const key=dayKey(now),row=s.daily.at(-1);if(!row||row.day!==key)s.daily.push({day:key,firstAt:now,lastAt:now,startEquity:equity,endEquity:equity,exactBoundary:false});
  else{row.lastAt=now;row.endEquity=equity;}s.daily=s.daily.slice(-45);
}
function closeTrade(s:ForwardState,t:Trade,price:number,now:number,reason:string,evidence?:Record<string,string|number|boolean|null>){
  const gross=dir(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*PAPER_COST.feeRate;
  const funding=t.notional*PAPER_COST.fundingAllowancePerDay*Math.max(0,now-t.openedAt)/86_400_000,
    net=gross-t.entryFee-exitFee-funding+realizedContribution(t),r=t.realization,remainingNotional=t.notional;
  t.status="CLOSED";t.closedAt=now;t.exitPrice=price;t.exitFee=exitFee+(r?.fees??0);t.fundingAllowance=funding+(r?.funding??0);t.grossPnl=gross+(r?.gross??0);t.netPnl=net;t.exitReason=reason;
  t.exitAudit={trigger:reason,at:now,...(evidence?{evidence}:{})};s.balance+=gross-exitFee-funding;s.grossPnl+=gross;s.fees+=exitFee;s.fundingAllowance+=funding;
  s.resolved++;if(net>0)s.wins++;s.turnover+=remainingNotional;t.lastQuoteAt=now;t.lastPrice=price;s.lastExitAt[t.symbol]=now;
  if(r){t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.notional=r.initialNotional;t.margin=r.initialMargin;t.plannedRisk=r.initialRisk;}
  if(t.entryContext?.winnerPlan&&reason!=="ACCOUNT_RESET"){
    s.winnerRisk??={};const p=t.entryContext.winnerPlan;
    recordWinnerRiskLoss(s.winnerRisk,p.riskGroup,p.eventAt,net,now);
  }
  const familyId=t.entryContext?.relationFamilyId;
  if(reason!=="ACCOUNT_RESET"&&familyId&&t.entryContext?.mode!=="SHOCK")recordFamilyOutcome({state:s.familyExperiment,familyId,
    tradeId:t.id,predictedNetRate:safe(t.forecast?.remainingNetRate),realizedNetRate:net/Math.max(t.notional,1e-9),
    costRate:(t.entryFee+t.exitFee+t.fundingAllowance)/Math.max(t.notional,1e-9),
    targetCapture:clip(t.favorable/Math.max(t.exitPlan?.targetRate??t.entryContext?.remainingSpaceRate??0,1e-9)),now});
  if(reason!=="ACCOUNT_RESET"&&t.entryContext?.environment&&t.entryContext?.playbook)
    recordEnvironmentOutcome(s.environmentPerformance,{environment:t.entryContext.environment,playbook:t.entryContext.playbook,
      netPnl:net,plannedRisk:Math.max(.01,t.plannedRisk),now});
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
function catastrophicWinnerInsuranceFloor(t:Trade,originalStopRate:number){
  // This is not a trailing-profit system. It activates only after the trade has
  // already become an exceptional winner (>=4% and >=3R), then leaves very wide
  // room while preventing a RARE-like winner from completing a full round trip
  // back into a structural loss.
  const provenThreshold=Math.max(.04,originalStopRate*3);
  if(t.favorable<provenThreshold)return 0;
  const peakNet=Math.max(0,t.favorable-ROUND_TRIP_COST);
  return Math.max(ROUND_TRIP_COST*1.25,Math.min(originalStopRate*.55,peakNet*.12));
}

export function liquidityTargetProfitFloor(input:{
  side:"LONG"|"SHORT";currentPrice:number;targetLower:number|null;targetUpper:number|null;
  peakFavorableRate:number;originalStopRate:number;costRate?:number;
}){
  const cost=Math.max(.0005,input.costRate??ROUND_TRIP_COST),peakNet=Math.max(0,input.peakFavorableRate-cost);
  if(!(input.currentPrice>0)||input.targetLower==null||input.targetUpper==null
    ||peakNet<Math.max(cost*3,input.originalStopRate*.40))return 0;
  const reached=input.currentPrice>=input.targetLower&&input.currentPrice<=input.targetUpper,
    distance=input.side==="LONG"?Math.max(0,input.targetLower-input.currentPrice)/input.currentPrice:
      Math.max(0,input.currentPrice-input.targetUpper)/input.currentPrice,
    near=reached||distance<=Math.max(cost*1.5,input.originalStopRate*.25);
  return near?cost+peakNet*.50:0;
}

export function environmentDecayProfitFloor(input:{
  peakFavorableRate:number;originalStopRate:number;modeFit:number;horizonMinutes:15|30|45|60;costRate?:number;
}){
  const cost=Math.max(.0005,input.costRate??ROUND_TRIP_COST),peakNet=Math.max(0,input.peakFavorableRate-cost),
    meaningfulPeak=Math.max(cost*4,input.originalStopRate*.55);
  if(input.horizonMinutes>30||input.modeFit>=.45||peakNet<meaningfulPeak)return 0;
  return cost+peakNet*.25;
}

export function evidenceDecayProfitFloor(input:{
  peakFavorableRate:number;originalStopRate:number;decision:"HOLD"|"REVIEW"|"EXIT";reviewBars:number;
  holdValueScore:number;counterfactualNewEntry:boolean;costRate?:number;
}){
  const cost=Math.max(.0005,input.costRate??ROUND_TRIP_COST),peakNet=Math.max(0,input.peakFavorableRate-cost),
    meaningfulPeak=Math.max(cost*3,input.originalStopRate*.35);
  if(input.decision!=="REVIEW"||input.reviewBars<2||input.counterfactualNewEntry||peakNet<meaningfulPeak)return 0;
  const retention=input.holdValueScore<40?.72:input.holdValueScore<55?.62:.50;
  return cost+peakNet*retention;
}

export function liquidityInvalidationDecision(input:{
  breached:boolean;signedRate:number;invalidationRate:number;expectedPullbackRate:number;positionDecision:"HOLD"|"REVIEW"|"EXIT";costRate?:number;
}){
  const cost=Math.max(.0005,input.costRate??ROUND_TRIP_COST),invalidationRate=Math.max(.004,input.invalidationRate),
    hardLossRate=Math.min(.035,Math.max(invalidationRate*1.35,invalidationRate+Math.max(cost*1.5,input.expectedPullbackRate*.35))),
    adverseRate=Math.max(0,-input.signedRate);
  if(!input.breached)return{action:"NONE" as const,hardLossRate};
  if(adverseRate>=hardLossRate)return{action:"HARD_EXIT" as const,hardLossRate};
  if(input.positionDecision==="EXIT")return{action:"CONFIRMED_EXIT" as const,hardLossRate};
  return{action:"REVIEW" as const,hardLossRate};
}

export function manageWinnerTrade(s:ForwardState,t:Trade,q:Quote,now:number,paths:Record<string,Candle[]>|undefined,minutePaths:Record<string,Candle[]>|undefined,contract?:Contract){
  const plan=t.entryContext?.winnerPlan;if(!plan)return false;
  const px=t.side==="LONG"?q.bestBid:q.bestAsk,d=dir(t.side),signed=d*(px/t.entryPrice-1),symbol=s.extremumRegime.symbols[t.symbol],
    originalRisk=Math.abs(plan.initialStop/t.entryPrice-1);
  t.lastPrice=px;t.lastQuoteAt=q.observedAt;t.favorable=Math.max(t.favorable,Math.max(0,signed));t.adverse=Math.max(t.adverse,Math.max(0,-signed));
  t.peakPnlRate=Math.max(t.peakPnlRate??0,t.favorable);
  if(!t.firstProfitAt&&signed>ROUND_TRIP_COST){t.firstProfitAt=now;if(t.entryContext)t.entryContext.postEntryState="CONFIRMED";}
  const position=evaluatePositionIntelligence({now,openedAt:t.openedAt,side:t.side,signedRate:signed,peakFavorableRate:t.favorable,
    ageMin:(now-t.openedAt)/60000,firstProfit:!!t.firstProfitAt,expectedHoldMinutes:t.expectedHoldMinutes??180,
    stopRate:originalRisk,entryScore:t.entryContext?.entryScore??50,entryResidual:t.entryContext?.entryResidual??0,
    entryRelativeStrength:t.entryContext?.entryRelativeStrength??.5,entryRemainingSpaceRate:t.entryContext?.remainingSpaceRate??0,
    state:symbol,narrative:s.extremumRegime.narrative,quote:q,minutePath:minutePaths?.[t.symbol],currentPrice:px,
    // A price reaction proxy is context, not an independent supportive vote.
    entryTradePlan:plan.intent==="TREND"?"WINNER_TREND":"RANGE_REVERSION",previous:t.positionIntelligence,
    entryBaseline:t.positionIntelligence?.baseline,costRate:ROUND_TRIP_COST,marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),
    entryResponseValidated:!!t.entryContext?.entryResponse});
  const researchContext=plan.researchVersion===RESEARCH_PLAN_VERSION?researchPlanContext({now,side:t.side,state:symbol,
    score:symbol?.watchScore??0,research:s.hypothesisResearch}):undefined;
  const trend=!!symbol&&trendCore({state:symbol,side:t.side,price:px,cost:ROUND_TRIP_COST,
    majorScore:s.extremumRegime.narrative.major.score,shortScore:s.extremumRegime.narrative.short.score,quote:q}).eligible,
    // New-entry value/nearby target is not a holding veto. Actual converging
    // price-path or structure failure remains sufficient; no minimum hold time.
    priceFailure=position.concernFamilies.includes("PATH")||position.concernFamilies.includes("STRUCTURE"),
    outcome=advanceWinnerManagement({side:t.side,price:px,entryPrice:t.entryPrice,openedAt:t.openedAt,now,plan,previous:t.winnerManagement,currentStop:t.stopPrice,
      rows:paths?.[t.symbol],cost:ROUND_TRIP_COST,remainingFraction:remainingTradeFraction(t),concernFamilies:position.concernFamilies,
      supportFamilies:position.supportFamilies,positionExit:position.decision==="EXIT"&&(researchContext!=null||priceFailure),trendEligible:trend,
      researchContext,quote:q,exitBasis:position.exitBasis});
  outcome.state.requestedAction=outcome.action;outcome.state.appliedAction=outcome.action==="REDUCE"?"HOLD":outcome.action;
  outcome.state.actionReason=outcome.reason;outcome.state.reductionResult=undefined;
  t.winnerManagement=outcome.state;t.positionIntelligence=position;t.holdScore=position.holdValueScore;
  if(outcome.action!=="EXIT"&&position.decision==="EXIT"){
    position.decision="REVIEW";position.exitBasis=null;position.summary="旧成本优势仍在，未形成足够的价格路径/承接破坏；只复核，不用新开仓性价比全平。";
  }
  t.stopPrice=outcome.state.protectedStop;t.profitFloorRate=Math.max(0,d*(t.stopPrice/t.entryPrice-1));
  t.holdValue={action:outcome.action==="EXIT"?(signed>ROUND_TRIP_COST?"EXIT_PROFIT":"EXIT_RISK"):position.decision==="REVIEW"?"REVIEW":"HOLD",
    score:t.holdScore,pullbackRiskRate:position.expectedPullbackRate,bestHoldMinutes:t.expectedHoldMinutes??180};
  if(outcome.action==="EXIT"){
    closeTrade(s,t,px,now,outcome.reason,{authority:"WINNER_PLAN",quoteAt:q.observedAt,protectedStop:t.stopPrice,
      originalStop:plan.initialStop,trimCount:t.realization?.sequence??0,
      requestedAction:outcome.action,appliedAction:"EXIT"});
    if(t.exitAudit&&outcome.state.research)t.exitAudit.research=structuredClone(outcome.state.research);
    return true;
  }
  if(outcome.action==="REDUCE"){
    const minContracts=contract?.minContracts??Number(contract?.orderSizeMin??0),
      result=realizeTradeSlice({trade:t,price:px,now,quoteAt:q.observedAt,fraction:outcome.fraction,
        feeRate:PAPER_COST.feeRate,fundingPerDay:PAPER_COST.fundingAllowancePerDay,minContracts,reason:outcome.reason});
    if(result){s.balance+=result.credit;s.grossPnl+=result.gross;s.fees+=result.fee;s.fundingAllowance+=result.funding;s.turnover+=result.notional;
      outcome.state.trimCount++;outcome.state.lastTrimEvent=outcome.state.obstacleSince;
      outcome.state.appliedAction="REDUCE";outcome.state.reductionResult="EXECUTED";
      event(s,now,"PROTECTION",t.id,"受阻后部分兑现；保留原父单与趋势仓",{action:"PARTIAL_EXIT",contracts:result.contracts,
        remainingContracts:t.contracts,sequence:t.realization!.sequence,quoteAt:q.observedAt,realizedGross:result.gross});
    }else outcome.state.reductionResult="NOT_EXECUTED_SIZE_OR_NET_COST";
  }
  return false;
}

function manageIntelligenceTrades(s:ForwardState,quotes:Record<string,Quote>,now:number,minutePaths:Record<string,Candle[]>|undefined,
  marketEvolution:MarketEvolutionState,environmentOutlook:EnvironmentOutlook,paths?:Record<string,Candle[]>,contracts?:Record<string,Contract>){
  const closed=new Set<string>();
  for(const t of s.positions){
    if(t.inverseCopy)continue;
    if(t.entryContext?.strategyVersion!==MARKET_INTELLIGENCE_VERSION)continue;
    const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    if(t.entryContext?.winnerPlan?.version===WINNER_POLICY_VERSION){
      if(manageWinnerTrade(s,t,q!,now,paths,minutePaths,contracts?.[t.symbol]))closed.add(t.id);
      continue;
    }
    const state=s.extremumRegime.symbols[t.symbol],px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side),
      signed=d*(px/t.entryPrice-1),favorable=Math.max(0,signed),adverse=Math.max(0,-signed),ageMin=(now-t.openedAt)/60_000,
      fallbackStopRate=Math.max(.004,t.entryContext?.pullbackRiskRate??Math.abs(t.entryPrice-t.stopPrice)/t.entryPrice);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;t.favorable=Math.max(t.favorable,favorable);t.adverse=Math.max(t.adverse,adverse);
    t.peakPnlRate=Math.max(t.peakPnlRate??0,favorable);
    if(!t.firstProfitAt&&favorable>=ROUND_TRIP_COST*.65){t.firstProfitAt=now;if(t.entryContext)t.entryContext.postEntryState="CONFIRMED";}
    const liquidityNow=s.extremumRegime.liquidity?.symbols[t.symbol],liqSide=liquidityNow?.departure.side==="UP"?"LONG":
      liquidityNow?.departure.side==="DOWN"?"SHORT":null;
    if(t.liquidityLifecycle?.currentPlan==="FAMILY_TURN"&&liquidityNow?.departure.state==="ACCEPTED"
      &&liqSide===t.side&&liquidityNow.departure.confidence>=.60){
      const target=t.side==="LONG"?liquidityNow.nextAbove:liquidityNow.nextBelow,
        zone=liquidityNow.activeZone,width=zone?Math.max(0,zone.upper-zone.lower):0,
        invalidationPrice=zone?(t.side==="LONG"?zone.upper-width*.35:zone.lower+width*.35):t.liquidityLifecycle.invalidationPrice;
      t.liquidityLifecycle={currentPlan:"LIQUIDITY_MIGRATION",upgradedAt:t.liquidityLifecycle.upgradedAt??now,
        reason:"家族提前转折已经发展成同方向、被市场接受的流动性迁移；原仓位直接升级，不重新开单。",
        originLower:zone?.lower??t.liquidityLifecycle.originLower,
        originUpper:zone?.upper??t.liquidityLifecycle.originUpper,
        targetLower:target?.lower??null,targetUpper:target?.upper??null,invalidationPrice};
      event(s,now,"ROTATION",t.id,"家族转折持仓升级为流动性迁移持仓",{confidence:liquidityNow.departure.confidence});
    }
    {
      const zone=liquidityNow?.activeZone;
      if(t.liquidityLifecycle?.currentPlan==="LIQUIDITY_MIGRATION"&&liquidityNow?.departure.state==="ACCEPTED"
        &&liqSide===t.side&&liquidityNow.departure.confidence>=.60&&zone&&zone.strength>=.36){
        const prior=t.liquidityLifecycle,
          priorCenter=prior.originLower!=null&&prior.originUpper!=null?(prior.originLower+prior.originUpper)/2:null,
          progressed=priorCenter!=null&&(t.side==="LONG"?zone.center>prior.originUpper!:zone.center<prior.originLower!),
          targetMatch=prior.targetLower!=null&&prior.targetUpper!=null
            ?zone.lower<=prior.targetUpper&&zone.upper>=prior.targetLower:true;
        if(progressed&&targetMatch){
          const target=t.side==="LONG"?liquidityNow.nextAbove:liquidityNow.nextBelow,width=Math.max(0,zone.upper-zone.lower),
            invalidationPrice=t.side==="LONG"?zone.upper-width*.35:zone.lower+width*.35;
          t.liquidityLifecycle={currentPlan:"LIQUIDITY_MIGRATION",upgradedAt:prior.upgradedAt??now,
            reason:"上一段流动性迁移已经到达新的成交中心，并再次被市场接受地向同方向离开；持仓原地续接下一段迁移。",
            originLower:zone.lower,originUpper:zone.upper,targetLower:target?.lower??null,targetUpper:target?.upper??null,invalidationPrice};
          event(s,now,"ROTATION",t.id,"流动性迁移续接到下一段，不平仓重开",
            {confidence:liquidityNow.departure.confidence,originCenter:zone.center});
        }
      }
    }
    const activeLiquidityPlan=t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan,
      activeOrigin=t.liquidityLifecycle?{lower:t.liquidityLifecycle.originLower,upper:t.liquidityLifecycle.originUpper}:null,
      activeTarget=t.liquidityLifecycle?{lower:t.liquidityLifecycle.targetLower,upper:t.liquidityLifecycle.targetUpper}:null,
      activeInvalidation=Number.isFinite(t.liquidityLifecycle?.invalidationPrice)?t.liquidityLifecycle!.invalidationPrice!
        :Number.isFinite(t.entryContext?.liquidityInvalidationPrice)?t.entryContext!.liquidityInvalidationPrice!:null,
      liquidityStopActive=(activeLiquidityPlan==="LIQUIDITY_MIGRATION"||activeLiquidityPlan==="LIQUIDITY_REJECTION"||activeLiquidityPlan==="FAMILY_TURN")
        &&activeInvalidation!=null,
      hypothesisStop=liquidityStopActive?activeInvalidation!:t.entryPrice*(1-d*fallbackStopRate),
      entryInvalidation=Number.isFinite(t.entryContext?.liquidityInvalidationPrice)?t.entryContext!.liquidityInvalidationPrice!:null,
      entryInvalidationValid=entryInvalidation!=null&&((t.side==="LONG"&&entryInvalidation<t.entryPrice)||(t.side==="SHORT"&&entryInvalidation>t.entryPrice)),
      originalStopRate=Math.max(.004,entryInvalidationValid
        ?Math.abs(t.entryPrice-entryInvalidation!)/Math.max(t.entryPrice,1e-12):fallbackStopRate);
    const position=evaluatePositionIntelligence({
      now,openedAt:t.openedAt,side:t.side,signedRate:signed,peakFavorableRate:t.favorable,ageMin,firstProfit:!!t.firstProfitAt,
      expectedHoldMinutes:t.expectedHoldMinutes??180,stopRate:originalStopRate,entryScore:t.entryContext?.entryScore??50,
      entryResidual:t.entryContext?.entryResidual??0,entryRelativeStrength:t.entryContext?.entryRelativeStrength??.5,
      entryRemainingSpaceRate:t.entryContext?.remainingSpaceRate??t.forecast?.remainingNetRate??0,state,
      currentPrice:px,liquidity:liquidityNow,entryTradePlan:activeLiquidityPlan,
      entryOrigin:activeOrigin?.lower!=null&&activeOrigin?.upper!=null?{lower:activeOrigin.lower,upper:activeOrigin.upper}:
        t.entryContext?.liquidityOriginLower!=null&&t.entryContext?.liquidityOriginUpper!=null
          ?{lower:t.entryContext.liquidityOriginLower,upper:t.entryContext.liquidityOriginUpper}:null,
      entryTarget:activeTarget?.lower!=null&&activeTarget?.upper!=null?{lower:activeTarget.lower,upper:activeTarget.upper}:
        t.entryContext?.liquidityTargetLower!=null&&t.entryContext?.liquidityTargetUpper!=null
          ?{lower:t.entryContext.liquidityTargetLower,upper:t.entryContext.liquidityTargetUpper}:null,
      narrative:s.extremumRegime.narrative,quote:q,minutePath:minutePaths?.[t.symbol],previous:t.positionIntelligence,
      costRate:ROUND_TRIP_COST,marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),
      entryResponseValidated:!!t.entryContext?.entryResponse,
    });
    t.positionIntelligence=position;t.holdScore=position.holdValueScore;
    t.holdValue={action:position.decision==="HOLD"?"HOLD":position.decision==="REVIEW"?"REVIEW":
      (signed>ROUND_TRIP_COST?"EXIT_PROFIT":"EXIT_RISK"),pullbackRiskRate:position.expectedPullbackRate,
      bestHoldMinutes:t.expectedHoldMinutes??180,score:t.holdScore};
    delete t.profitLifecycle;

    const decayFloor=evidenceDecayProfitFloor({peakFavorableRate:t.favorable,originalStopRate,decision:position.reviewCandidate===false?"HOLD":position.decision,
      reviewBars:position.reviewBars,holdValueScore:position.holdValueScore,counterfactualNewEntry:position.counterfactualNewEntry,costRate:ROUND_TRIP_COST});
    if(decayFloor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
      t.profitFloorRate=decayFloor;
      event(s,now,"PROTECTION",t.id,
        `持仓价值已进入复核且当前价格已不值得重新入场；保护已证明净利润的 ${(decayFloor>ROUND_TRIP_COST?(decayFloor-ROUND_TRIP_COST)/Math.max(1e-9,t.favorable-ROUND_TRIP_COST):0)*100|0}% 左右，其余空间继续留给行情。`,
        {floorRate:decayFloor,peakRate:t.favorable,holdScore:position.holdValueScore});
    }

    const profitStop=(t.profitFloorRate??0)>0?t.entryPrice*(1+d*(t.profitFloorRate??0)):null,
      activeInvalidationRate=liquidityStopActive&&activeInvalidation!=null
        ?Math.abs(t.entryPrice-activeInvalidation)/Math.max(t.entryPrice,1e-12):originalStopRate,
      hypothesisBreached=liquidityStopActive&&activeInvalidation!=null
        &&(t.side==="LONG"?px<=activeInvalidation:px>=activeInvalidation),
      invalidation=liquidityInvalidationDecision({breached:hypothesisBreached,signedRate:signed,invalidationRate:activeInvalidationRate,
        expectedPullbackRate:position.expectedPullbackRate,positionDecision:position.decision,costRate:ROUND_TRIP_COST}),
      hardHypothesisStop=t.entryPrice*(1-d*invalidation.hardLossRate),
      structuralStop=liquidityStopActive?hardHypothesisStop:hypothesisStop;
    t.stopPrice=profitStop==null?structuralStop:t.side==="LONG"?Math.max(structuralStop,profitStop):Math.min(structuralStop,profitStop);
    const profitStopped=profitStop!=null&&(t.side==="LONG"?px<=profitStop:px>=profitStop),
      structuralStopped=!liquidityStopActive&&(t.side==="LONG"?px<=structuralStop:px>=structuralStop);
    if(profitStopped){
      closeTrade(s,t,px,now,"WINNER_INSURANCE_EXIT",{authority:"PROFIT_FLOOR",stopPrice:t.stopPrice,hypothesisStop,profitStop,
        liquidityOwnsStop:false,quoteAt:q!.observedAt});closed.add(t.id);continue;
    }
    if(liquidityStopActive&&(invalidation.action==="HARD_EXIT"||invalidation.action==="CONFIRMED_EXIT")){
      closeTrade(s,t,px,now,"LIQUIDITY_HYPOTHESIS_INVALIDATED",{authority:invalidation.action==="HARD_EXIT"?"HARD_RISK_BOUNDARY":"POSITION_INTELLIGENCE_CONFIRMED",
        stopPrice:t.stopPrice,hypothesisStop,profitStop,liquidityOwnsStop:true,softInvalidationPrice:activeInvalidation!,
        hardLossRate:invalidation.hardLossRate,quoteAt:q!.observedAt});closed.add(t.id);continue;
    }
    if(structuralStopped){
      closeTrade(s,t,px,now,"STRUCTURE_STOP",{authority:"PRICE_STOP",stopPrice:t.stopPrice,hypothesisStop,profitStop,
        liquidityOwnsStop:false,quoteAt:q!.observedAt});closed.add(t.id);continue;
    }

    // The liquidity invalidation line is a thesis review boundary, not a one-tick
    // liquidation trigger. Multi-family position evidence can confirm the exit;
    // a bounded hard-risk line still prevents open-ended loss.
    if(position.decision==="EXIT"){
      if(t.entryContext)t.entryContext.postEntryState=signed>0?"CONFIRMED":"FAILED";
      closeTrade(s,t,px,now,"POSITION_VALUE_EXIT",{authority:"POSITION_INTELLIGENCE",decision:position.decision,quoteAt:q!.observedAt,
        reviewBars:position.reviewBars,barAt:position.lastCompletedBar,reviewSince:position.reviewSince,
        exitBasis:position.exitBasis??null,baselineSource:position.baseline?.source??null,
        entryAdvantage:position.entryAdvantage,currentAdvantage:position.currentAdvantage});closed.add(t.id);continue;
    }

    const insurance=catastrophicWinnerInsuranceFloor(t,originalStopRate);
    if(insurance>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
      if(signed<=insurance){
        closeTrade(s,t,px,now,"WINNER_INSURANCE_EXIT",{authority:"PROFIT_FLOOR",thresholdRate:insurance,signedRate:signed,originalStopRate,quoteAt:q!.observedAt});closed.add(t.id);continue;
      }
      const next=t.entryPrice*(1+d*insurance);
      if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
        t.profitFloorRate=insurance;t.stopPrice=next;
        event(s,now,"PROTECTION",t.id,
          `大赢家最后保险已建立：峰值 ${(t.favorable*100).toFixed(2)}%，只防止已证明的大行情最终完整回吐成亏损。`,
          {floorRate:insurance,peakRate:t.favorable,structuralStopRate:originalStopRate});
      }
    }

    if(activeLiquidityPlan==="LIQUIDITY_MIGRATION"){
      const targetFloor=liquidityTargetProfitFloor({side:t.side,currentPrice:px,
        targetLower:t.liquidityLifecycle?.targetLower??t.entryContext?.liquidityTargetLower??null,
        targetUpper:t.liquidityLifecycle?.targetUpper??t.entryContext?.liquidityTargetUpper??null,
        peakFavorableRate:t.favorable,originalStopRate,costRate:ROUND_TRIP_COST});
      if(targetFloor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
        if(signed<=targetFloor){
          closeTrade(s,t,px,now,"LIQUIDITY_TARGET_PROTECT_EXIT",{authority:"PROFIT_FLOOR",thresholdRate:targetFloor,signedRate:signed,originalStopRate,quoteAt:q!.observedAt});closed.add(t.id);continue;
        }
        const next=t.entryPrice*(1+d*targetFloor);
        if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
          t.profitFloorRate=targetFloor;t.stopPrice=next;
          event(s,now,"PROTECTION",t.id,
            "流动性迁移已经接近/进入下一片主要流动性区域；只锁住30%已证明净利润，等待市场决定是继续迁移还是重新积累。",
            {floorRate:targetFloor,peakRate:t.favorable});
        }
      }
    }

    if(t.entryContext?.environmentOutlookVersion===ENVIRONMENT_OUTLOOK_VERSION&&t.entryContext?.mode){
      const currentFit=environmentModeFit({market:s.extremumRegime,evolution:marketEvolution,outlook:environmentOutlook,
        side:t.side,mode:t.entryContext.mode,tradePlan:activeLiquidityPlan}),
        environmentFloor=environmentDecayProfitFloor({peakFavorableRate:t.favorable,originalStopRate,modeFit:currentFit,
          horizonMinutes:environmentOutlook.horizonMinutes,costRate:ROUND_TRIP_COST});
      if(environmentFloor>0){
        if(environmentFloor>Math.max(t.profitFloorRate??0,ROUND_TRIP_COST*.8)){
          if(signed<=environmentFloor){
            closeTrade(s,t,px,now,"ENVIRONMENT_PROFIT_DECAY_EXIT",{authority:"PROFIT_FLOOR",thresholdRate:environmentFloor,signedRate:signed,currentFit,horizonMinutes:environmentOutlook.horizonMinutes,quoteAt:q!.observedAt});closed.add(t.id);continue;
          }
          const next=t.entryPrice*(1+d*environmentFloor);
          if(t.side==="LONG"&&next>t.stopPrice||t.side==="SHORT"&&next<t.stopPrice){
            t.profitFloorRate=environmentFloor;t.stopPrice=next;
            event(s,now,"PROTECTION",t.id,
              `未来市场有效窗口已缩短到约 ${environmentOutlook.horizonMinutes} 分钟，当前交易逻辑适配度仅 ${(currentFit*100).toFixed(0)}%；只锁住已证明净利润的25%，其余空间继续留给行情。`,
              {floorRate:environmentFloor,peakRate:t.favorable,modeFit:currentFit});
          }
        }
      }
    }
  }
  if(closed.size)s.positions=s.positions.filter(t=>!closed.has(t.id));
}

function markAndManage(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const candidates=new Map(s.opportunities.filter(o=>!isIntelligenceOpportunity(o)).map(o=>[o.symbol,o])),relationById=new Map(s.relationEngine.rules.map(r=>[r.id,r])),closed=new Set<string>();
  for(const t of s.positions){if(t.inverseCopy||t.entryContext?.strategyVersion===MARKET_INTELLIGENCE_VERSION)continue;const q=quotes[t.symbol];if(!freshQuote(q,now))continue;const px=t.side==="LONG"?q!.bestBid:q!.bestAsk,d=dir(t.side);
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
const riskCharge=(t:Trade)=>Math.max(t.plannedRisk,(t.entryContext?.portfolioRiskCharge??((t.forecast?.sizingEquity??0)*.006))*remainingTradeFraction(t));
function existingRisk(s:ForwardState,side?:"LONG"|"SHORT"){return s.positions.filter(t=>!side||t.side===side).reduce((n,t)=>n+riskCharge(t),0);}
function continuationRisk(s:ForwardState,side:"LONG"|"SHORT"){return s.positions.filter(t=>t.side===side&&t.entryContext?.mode==="CONTINUATION"
  &&((t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan)==="LIQUIDITY_MIGRATION"||t.entryContext?.winnerPlan?.intent==="TREND")).reduce((n,t)=>n+riskCharge(t),0);}
function cycleRiskAdded(s:ForwardState,since:number){return[...s.positions,...s.history].filter(t=>t.openedAt>=since).reduce((n,t)=>n+Math.max(t.realization?.initialRisk??t.plannedRisk,t.entryContext?.portfolioRiskCharge??0),0);}
export function executionValueAtQuote(input:{remainingNetRate:number;pullbackRiskRate:number;costRate?:number}){
  const cost=Math.max(.0005,input.costRate??ROUND_TRIP_COST),remaining=Math.max(0,input.remainingNetRate),
    pullback=Math.max(cost*1.5,input.pullbackRiskRate),edgeRatio=remaining/Math.max(pullback,1e-9);
  return{remainingNetRate:remaining,edgeRatio,executable:remaining>cost*1.4&&edgeRatio>=EXECUTION_EDGE_FLOOR};
}
function isIntelligenceOpportunity(o:Opportunity){return o.strategyVersion===MARKET_INTELLIGENCE_VERSION;}
function annotateLifecycleOpportunities(s:ForwardState,market:MarketEvolutionState,outlook:EnvironmentOutlook){
  for(const o of s.opportunities){
    if(!isIntelligenceOpportunity(o))continue;
    const symbol=s.extremumRegime.symbols[o.symbol];if(!symbol)continue;
    const lifecycle=deriveOpportunityLifecycle({side:o.side,symbol,thesisBars:o.thesisBars??symbol.signalBars,market}),
      future=entryHypothesisGuidance(s.hypothesisResearch,{side:o.side,score:o.score,residualZ:symbol.residualZ,
        residualPersistence:symbol.residualPersistence,sourceCount:symbol.sourceCount,dataConfidence:symbol.dataConfidence}),
      route=routeEnvironmentOpportunity({market:s.extremumRegime,evolution:market,symbol,opportunity:o,outlook});
    o.marketEvolutionPhase=market.phase;o.opportunityLifecyclePhase=lifecycle.phase;o.lifecycleReason=lifecycle.reason;
    o.futureResearchAction=future.action;o.futureResearchReason=future.reason;o.futureHypothesisIds=future.hypothesisIds;
    o.extendedConfirmation=future.extendedConfirmation;o.environment=route.environment;o.playbook=route.playbook;o.routeAlignment=route.alignment;
    o.environmentPriority=route.priority;o.environmentScore=Math.max(0,Math.min(100,o.score+route.scoreDelta));
    o.environmentRiskScale=route.riskScale;o.environmentProbe=route.probe;o.environmentForceRetest=route.forceRetest;
    o.environmentMainline=route.mainline;o.environmentModeFit=route.modeFit;o.environmentOutlook=route.outlook;
    o.probeImpulseMin=route.probeImpulseMin;o.probePullbackMin=route.probePullbackMin;o.probeRestartMin=route.probeRestartMin;
    o.environmentReason=route.reason;
    if(o.winnerPlan?.intent==="TREND"){
      o.environmentScore=o.score;o.environmentForceRetest=false;o.extendedConfirmation=false;
      o.environmentPriority=3;o.environmentMainline=true;o.environmentProbe=false;
      o.environmentRiskScale=symbol.regime==="DIVERGENT"?1:Math.max(.7,route.riskScale);
    }else if(o.winnerPlan?.intent==="RANGE"){
      o.environmentPriority=2;o.environmentScore=o.score;o.environmentForceRetest=false;o.extendedConfirmation=false;
      o.environmentRiskScale=.70;
    }
    applyOpportunityResearch(s,o,s.extremumRegime.updatedAt);
  }
}

/** One advice receipt travels with the frozen plan. Only advice/risk changes;
 * side, event identity, entry area, initial stop and target never get redrawn. */
export function applyOpportunityResearch(s:ForwardState,o:Opportunity,now:number){
  const p=o.winnerPlan;if(p?.researchVersion!==RESEARCH_PLAN_VERSION)return;
  const context=researchPlanContext({now,side:o.side,state:s.extremumRegime.symbols[o.symbol],score:o.score,
    research:s.hypothesisResearch,baseRiskScale:p.entryResearch?.baseRiskScale??o.environmentRiskScale??1});
  p.entryResearch=context;o.environmentRiskScale=context.riskScale;
  o.extendedConfirmation=context.entryAction==="CONFIRM_MORE";
  o.environmentMainline=p.intent==="TREND"&&!o.extendedConfirmation;
  o.environmentPriority=p.intent==="TREND"&&(!o.extendedConfirmation)?3:2;
  o.futureResearchAction=o.extendedConfirmation?"CONFIRM_MORE":"NORMAL";
  o.futureResearchReason=context.reason;o.futureHypothesisIds=context.hypothesisIds;
  o.environmentReason=context.reason;
  return context;
}

function openIntelligenceTrade(s:ForwardState,o:Opportunity,q:Quote,contract:Contract,now:number,equity:number,
  response?:{validation:EntryValidation;decision:EntryResponseDecision},minutePath?:Candle[]){
  if(!isIntelligenceOpportunity(o))return"新策略身份缺失";
  const appliedResearch=applyOpportunityResearch(s,o,now);
  if(appliedResearch?.entryAction==="CONFIRM_MORE"&&!response)return "研究要求本币实时响应确认，不能由兼容入口跳过";
  if(s.positions.some(t=>t.symbol===o.symbol))return"同币已有持仓，禁止重复开仓";
  if(s.positions.length>=PORTFOLIO_POSITION_CAP)return"组合持仓已达10笔上限";
  const side=o.side,d=dir(side),price=side==="LONG"?q.bestAsk:q.bestBid,
    consumed=Math.max(0,d*(price/Math.max(o.price,1e-9)-1)),remainingNet=o.netRemainingSpaceRate-consumed,
    executionValue=executionValueAtQuote({remainingNetRate:remainingNet,pullbackRiskRate:o.pullbackRiskRate}),
    requiresLiquidityStop=!o.winnerPlan&&(o.tradePlan==="LIQUIDITY_MIGRATION"||o.tradePlan==="LIQUIDITY_REJECTION"||o.tradePlan==="FAMILY_TURN"),
    frozenInvalidation=Number.isFinite(o.liquidityInvalidationPrice)?o.liquidityInvalidationPrice!:null;
  if(!executionValue.executable)return remainingNet<=ROUND_TRIP_COST*1.4
    ?"实时入场已消耗剩余空间，等待回调/新假设"
    :`实时成交性价比已降至 ${executionValue.edgeRatio.toFixed(2)}×，低于1.25×，等待回调/新假设`;
  if((requiresLiquidityStop||o.winnerPlan)&&(frozenInvalidation==null||(side==="LONG"&&frozenInvalidation>=price)||(side==="SHORT"&&frozenInvalidation<=price)))
    return"流动性失效边界已经不在入场价格外侧，当前位置不再执行";
  const softInvalidationRate=frozenInvalidation!=null?Math.abs(price-frozenInvalidation)/Math.max(price,1e-12):o.stopRate,
    stopRate=requiresLiquidityStop
      ?Math.min(.035,Math.max(softInvalidationRate*1.35,softInvalidationRate+Math.max(ROUND_TRIP_COST*1.5,o.pullbackRiskRate*.35)))
      :Math.max(.004,o.winnerPlan?softInvalidationRate:o.stopRate),
    stopPrice=o.winnerPlan?o.winnerPlan.initialStop:price*(1-d*stopRate);
  if(!(stopRate>=.004&&stopRate<=.035))return"流动性/结构失效宽度不合理（硬风险边界）";
  if(o.winnerPlan?.intent==="RANGE"){
    const gross=o.winnerPlan.target==null?0:d*(o.winnerPlan.target/price-1);
    if(gross-ROUND_TRIP_COST<ROUND_TRIP_COST*2||(gross-ROUND_TRIP_COST)/(stopRate+ROUND_TRIP_COST)<1.25)
      return "回归到量价重心的实际净空间不足，不借远端区域抬高收益预期";
  }
  const sameCluster=s.positions.find(t=>t.side===side&&o.clusterId&&t.entryContext?.clusterId===o.clusterId);
  if(sameCluster)return"同相关组已有同方向主仓";
  const continuation=o.mode==="CONTINUATION"&&(o.tradePlan==="LIQUIDITY_MIGRATION"||o.winnerPlan?.intent==="TREND"),
    totalHeadroom=equity*(TOTAL_RISK_RATE-.001)-existingRisk(s),
    sideHeadroom=equity*(SIDE_RISK_RATE-.0005)-existingRisk(s,side),
    cycleHeadroom=equity*FIVE_MINUTE_NEW_RISK_RATE-cycleRiskAdded(s,s.lastCandleAt),
    continuationHeadroom=continuation?equity*CONTINUATION_SIDE_RISK_RATE-continuationRisk(s,side):Infinity,
    eventOpenRisk=o.winnerPlan?s.positions.filter(t=>t.entryContext?.winnerPlan?.riskGroup===o.winnerPlan!.riskGroup).reduce((n,t)=>n+riskCharge(t),0):0,
    eventHeadroom=o.winnerPlan?winnerEventHeadroom(s.winnerRisk??{},o.winnerPlan.riskGroup,o.winnerPlan.eventAt,equity,eventOpenRisk).headroom:Infinity,
    headroom=Math.min(totalHeadroom,sideHeadroom,cycleHeadroom,continuationHeadroom,eventHeadroom),
    riskRate=o.winnerPlan?.intent==="RANGE"?.003:o.premium?.0065:.0055,environmentRiskScale=Math.max(.70,Math.min(1,o.environmentRiskScale??1)),
    wantedRisk=equity*riskRate*environmentRiskScale,riskBudget=Math.min(wantedRisk,headroom);
  if(riskBudget<equity*(o.winnerPlan?.intent==="RANGE"?.0015:.0035))return"剩余风险预算不足以形成有效仓位";
  const rawNotional=riskBudget/(stopRate+ROUND_TRIP_COST),targetNotional=Math.min(rawNotional,equity*.70),
    leverage=Math.max(1,Math.min(10,Math.floor(contract.leverageMax||10))),mult=Math.max(contract.quantoMultiplier,1e-12),
    minContracts=Math.max(1,Math.ceil(contract.minContracts??(Number(contract.orderSizeMin??1)||1))),
    contracts=Math.floor(targetNotional/(price*mult));
  if(contracts<minContracts)return"低于最小模拟合约数量";
  const quantity=contracts*mult,notional=quantity*price,margin=notional/leverage,totalMargin=s.positions.reduce((n,t)=>n+t.margin,0);
  if(totalMargin+margin>equity*TOTAL_MARGIN_RATE)return"组合保证金已满";
  const plannedRisk=notional*(stopRate+ROUND_TRIP_COST),entryFee=notional*PAPER_COST.feeRate,
    target=o.winnerPlan?.target??price*(1+d*Math.max(.004,o.targetRate-consumed)),horizon=Math.max(o.winnerPlan?.intent==="RANGE"?30:60,Math.round(o.expectedHoldMinutes)),
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
      liquidityLifecycle:o.tradePlan&&!o.winnerPlan?{currentPlan:o.tradePlan,upgradedAt:null,reason:o.liquidityReason??o.reason,
        originLower:o.liquidityOriginLower??null,originUpper:o.liquidityOriginUpper??null,
        targetLower:o.liquidityTargetLower??null,targetUpper:o.liquidityTargetUpper??null,
        invalidationPrice:frozenInvalidation}:undefined,
      exitControl:{policy:MARKET_INTELLIGENCE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{winnerPlan:o.winnerPlan?structuredClone(o.winnerPlan):undefined,version:"adaptive-ten-entry-v1",capturedAt:now,timeframe:"5m",side,mode:o.mode,reserve:false,reason:o.reason,
        entryScore:o.environmentScore??o.score,baseEntryScore:o.score,environmentScore:o.environmentScore??o.score,
        directionStrength:o.directionStrength,spaceScore:o.spaceScore,positionScore:o.positionScore,executionScore:o.executionScore,
        remainingSpaceRate:remainingNet,pullbackRiskRate:o.pullbackRiskRate,edgeRatio:executionValue.edgeRatio,
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
        environment:o.environment,playbook:o.playbook,routeAlignment:o.routeAlignment,environmentRiskScale:o.environmentRiskScale,
        environmentProbe:o.environmentProbe,environmentReason:o.environmentReason,
        environmentOutlookVersion:o.environmentOutlook?.version,environmentModeFit:o.environmentModeFit,
        environmentHorizonMinutes:o.environmentOutlook?.horizonMinutes,environmentPersistenceScore:o.environmentOutlook?.persistenceScore,
        environmentTransitionPressure:o.environmentOutlook?.transitionPressure,environmentProfitExpansion:o.environmentOutlook?.profitExpansion,
        tradePlan:o.tradePlan,liquidityPlanConfidence:o.liquidityPlanConfidence,liquidityReason:o.liquidityReason,liquidityTargetRate:o.liquidityTargetRate,
        liquidityOriginLower:o.liquidityOriginLower,liquidityOriginUpper:o.liquidityOriginUpper,
        liquidityTargetLower:o.liquidityTargetLower,liquidityTargetUpper:o.liquidityTargetUpper,
        liquidityInvalidationPrice:frozenInvalidation,rapidLiquidityAuthorization:!!o.rapidLiquidityAuthorization,
        futureResearchAction:o.futureResearchAction,futureResearchReason:o.futureResearchReason,futureHypothesisIds:o.futureHypothesisIds},
      forecast:{remainingNetRate:remainingNet,quality:o.score/100,sizingEquity:equity}};
  // Use the very same position assessment before financial admission. A single
  // concern or slow response is not a veto; only converged independent failure
  // with weak holding value contradicts an otherwise approved entry.
  const positionState=s.extremumRegime.symbols[o.symbol],mark=side==="LONG"?q.bestBid:q.bestAsk,
    entryAssessment=evaluatePositionIntelligence({now,openedAt:now,side,signedRate:d*(mark/price-1),
      peakFavorableRate:0,ageMin:0,firstProfit:false,expectedHoldMinutes:horizon,
      stopRate:Math.max(.004,softInvalidationRate),entryScore:o.environmentScore??o.score,
      entryResidual:o.residual??0,entryRelativeStrength:o.relativeStrength??.5,entryRemainingSpaceRate:remainingNet,
      state:positionState,narrative:s.extremumRegime.narrative,quote:q,minutePath,currentPrice:mark,
      liquidity:s.extremumRegime.liquidity?.symbols[o.symbol],entryTradePlan:o.tradePlan,
      entryOrigin:o.liquidityOriginLower!=null&&o.liquidityOriginUpper!=null
        ?{lower:o.liquidityOriginLower,upper:o.liquidityOriginUpper}:null,
      entryTarget:o.liquidityTargetLower!=null&&o.liquidityTargetUpper!=null
        ?{lower:o.liquidityTargetLower,upper:o.liquidityTargetUpper}:null,
      entryBaseline:capturePositionBaseline(side,positionState,now),entryResponseValidated:!!response,
      marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),costRate:ROUND_TRIP_COST});
  if(entryAssessment.entryConflict)return "入场与持仓证据冲突，等待回调/新响应";
  t.positionIntelligence=entryAssessment;
  s.positions.push(t);s.balance-=entryFee;s.fees+=entryFee;s.turnover+=notional;s.lastEntryAt[o.symbol]=now;s.lastSide[o.symbol]=side;
  rememberConsumedThesis(s,o.thesisId,now);
  event(s,now,"ENTRY",id,`${o.symbol} ${side} ${o.mode} 评分${o.score.toFixed(0)}`,
    {notional,plannedRisk});
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


type EntryLocation30={sidePosition30:number;breakoutRate30:number;rangeRate30:number};

function entryLocation30(rows:Candle[]|undefined,side:"LONG"|"SHORT",price:number,at:number):EntryLocation30|null{
  const completed=(rows??[]).filter(b=>b.time>0&&b.open>0&&b.high>=b.low&&b.low>0&&b.close>0
    &&b.time*1000+BAR_MS<=at).sort((a,b)=>a.time-b.time).slice(-6);
  if(completed.length<3||!(price>0))return null;
  const low=Math.min(...completed.map(b=>b.low)),high=Math.max(...completed.map(b=>b.high));
  if(!(high>low))return null;
  const range=high-low,rangePosition=(price-low)/range,
    sidePosition30=side==="LONG"?rangePosition:1-rangePosition,
    breakoutRate30=side==="LONG"?Math.max(0,price/high-1):Math.max(0,low/price-1);
  return{sidePosition30,breakoutRate30,rangeRate30:range/price};
}

export function entryLocationDecision(input:{
  sidePosition30:number|null;breakoutRate30:number|null;confirmationAdvanceRate:number;costRate?:number;
}){
  const cost=Math.max(.0005,input.costRate??ROUND_TRIP_COST),side=Math.max(0,input.sidePosition30??0),
    breakout=Math.max(0,input.breakoutRate30??0),confirmation=Math.max(0,input.confirmationAdvanceRate),
    severelyExtended=side>1.35&&breakout>Math.max(cost,confirmation*2);
  return{action:severelyExtended?"WAIT_RETEST" as const:"DIRECT" as const,severelyExtended,
    sidePosition30:input.sidePosition30,breakoutRate30:input.breakoutRate30,confirmationAdvanceRate:confirmation};
}

export function stableEntryLocationDecision(input:{
  currentAdvanceRate:number;bestAdvanceRate:number;expectedNetRate:number;pullbackRiskRate:number;
  maxChaseRate:number;retestPullbackMin:number;restartMin:number;retestBaseReady:boolean;restartAdvanceRate?:number;
}){
  const expected=Math.max(ROUND_TRIP_COST*2,input.expectedNetRate),
    pullback=Math.max(ROUND_TRIP_COST*1.5,input.pullbackRiskRate),
    maxChase=Math.max(ROUND_TRIP_COST*1.8,input.maxChaseRate),
    pullbackMin=Math.max(ROUND_TRIP_COST*.35,input.retestPullbackMin),
    restartMin=Math.max(ROUND_TRIP_COST*.30,input.restartMin),
    best=Math.max(0,input.bestAdvanceRate,input.currentAdvanceRate),current=input.currentAdvanceRate,
    retrace=Math.max(0,best-current),requiredPullback=Math.max(pullbackMin,best-maxChase),
    remainingFromThesis=expected-Math.max(0,current);
  if(best<maxChase)return{action:"DIRECT" as const,best,current,retrace,requiredPullback,remainingFromThesis,restartMin};
  if(!input.retestBaseReady)return{action:retrace>=requiredPullback?"SET_RETEST_BASE" as const:"WAIT_PULLBACK" as const,
    best,current,retrace,requiredPullback,remainingFromThesis,restartMin};
  const restart=input.restartAdvanceRate??0;
  if(restart<0)return{action:"UPDATE_RETEST_BASE" as const,best,current,retrace,requiredPullback,remainingFromThesis,restartMin};
  if(remainingFromThesis<=Math.max(ROUND_TRIP_COST*1.4,pullback*.45))
    return{action:"WAIT_NEW_THESIS" as const,best,current,retrace,requiredPullback,remainingFromThesis,restartMin};
  if(restart<restartMin)return{action:"WAIT_RESTART" as const,best,current,retrace,requiredPullback,remainingFromThesis,restartMin};
  return{action:"READY_AFTER_RETEST" as const,best,current,retrace,requiredPullback,remainingFromThesis,restartMin};
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

function seedEntryResponses(s:ForwardState,quotes:Record<string,Quote>,now:number,trace?:(event:ReviewEvent)=>void){
  const opportunities=new Map(s.opportunities.filter(isIntelligenceOpportunity).map(o=>[o.id,o])),
    preserved:Record<string,EntryValidation>={};
  for(const [id,v] of Object.entries(s.entryValidations)){
    const o=v.frozenOpportunity??opportunities.get(v.candidateId);
    if(v.status==="CANCELLED"&&v.expiresAt<=now)continue;
    if(!o||s.positions.some(t=>t.symbol===v.symbol)||(o.thesisId&&s.consumedTheses[o.thesisId])){
      trace?.({at:now,id:v.id,symbol:v.symbol,stage:"CANCELLED",reason:!o?"PLAN_MISSING":s.positions.some(t=>t.symbol===v.symbol)?"SYMBOL_HELD":"THESIS_CONSUMED"});continue;
    }
    if(!v.frozenOpportunity)v.frozenOpportunity=structuredClone(o);
    preserved[id]=v;
    if(v.status==="WAITING"&&v.stableThesis){
      const hardEnd=(v.authorizedAt??v.startedAt)+12*60_000;
      v.expiresAt=Math.max(v.expiresAt,Math.min(o.expiresAt,hardEnd));
      if(v.deadlineAt>0)v.deadlineAt=Math.min(v.expiresAt,hardEnd);
    }
  }
  s.entryValidations=preserved;
  const eligible=rankedEligible(s,now).sort((a,b)=>{
      const aq=quotes[a.symbol],bq=quotes[b.symbol],
        ar=freshQuote(aq,now)&&aq!.entryReady===true,br=freshQuote(bq,now)&&bq!.entryReady===true;
      return Number(br)-Number(ar)||opportunityCompare(a,b);
    }),reasons:Record<string,number>={};
  let active=Object.values(s.entryValidations).filter(v=>v.status==="WAITING").length;
  const reject=(reason:string)=>{reasons[reason]=(reasons[reason]??0)+1;};
  for(const o of eligible){
    if(s.entryValidations[o.id])continue;
    if(active>=ENTRY_VALIDATION_CAP){
      if(!o.rapidLiquidityAuthorization){trace?.({at:now,id:o.id,symbol:o.symbol,stage:"NOT_AUTHORIZED",reason:"EXECUTION_SLOT_CAPACITY"});continue;}
      const waiting=Object.values(s.entryValidations).filter(v=>v.status==="WAITING"&&v.frozenOpportunity)
        .sort((a,b)=>(a.frozenOpportunity!.environmentScore??a.frozenOpportunity!.score)
          -(b.frozenOpportunity!.environmentScore??b.frozenOpportunity!.score));
      const weakest=waiting[0],weakScore=weakest?(weakest.frozenOpportunity!.environmentScore??weakest.frozenOpportunity!.score):Infinity,
        newScore=o.environmentScore??o.score,
        noProof=!!weakest&&weakest.supportSamples===0&&now-(weakest.authorizedAt??weakest.startedAt)>=30_000;
      if(!weakest||!noProof||newScore<weakScore+4){trace?.({at:now,id:o.id,symbol:o.symbol,stage:"NOT_AUTHORIZED",reason:"NO_REPLACEABLE_EXECUTION_SLOT"});continue;}
      weakest.status="CANCELLED";
      weakest.reason=`更强的1分钟流动性迁移机会已出现（新计划评分 ${newScore.toFixed(0)} > 当前等待 ${weakScore.toFixed(0)}）；释放一个长期无正反馈的执行槽。`;
      trace?.({at:now,id:weakest.id,symbol:weakest.symbol,stage:"REPLACED",reason:weakest.reason});
      active--;
    }
    const q=quotes[o.symbol],quoteReady=freshQuote(q,now)&&q!.entryReady===true,
      state=s.extremumRegime.symbols[o.symbol],sourceCount=Math.max(o.sourceCount??0,state?.sourceCount??0,q?.sourceCount??0),
      disagreement=q?.disagreementRate??o.disagreementRate??0,
      recentExtremeLosses=s.history.filter(t=>t.symbol===o.symbol&&t.closedAt!=null&&now-t.closedAt<4*60*60_000
        &&(t.netPnl??0)<0&&Math.abs(t.entryContext?.entryResidual??0)>=.05).length,
      extreme=extremeResidualConfirmationProfile({residual:o.residual??0,sourceCount,
        dataConfidence:o.dataConfidence??state?.dataConfidence??0,disagreementRate:disagreement,recentExtremeLosses}),
      routedScore=o.environmentScore??o.score,
      profile=entryResponseWindowMs({score:routedScore,edgeRatio:o.edgeRatio,sourceCount,disagreementRate:disagreement,mode:o.mode,
        fastLaneAllowed:!!o.environmentMainline}),
      stable=stableEntryThesisProfile({score:routedScore,premium:!!o.premium,thesisBars:o.thesisBars??state?.signalBars??0,
        stage:o.confirmationStage??state?.stage??"OBSERVE",edgeRatio:o.edgeRatio,sourceCount,
        dataConfidence:o.dataConfidence??state?.dataConfidence??0,netRemainingSpaceRate:o.netRemainingSpaceRate,
        pullbackRiskRate:o.pullbackRiskRate}),
      researchExtended=!!o.extendedConfirmation,
      minimumElapsedMs=Math.max(extreme.minimumElapsedMs,researchExtended?30_000:0),
      minimumSupportSamples=Math.max(extreme.minimumSupportSamples,researchExtended?4:0),
      minimumRetainedRate=Math.max(extreme.minimumRetainedRate,researchExtended?.72:0),
      price=quoteReady?(o.side==="LONG"?q!.bestAsk:q!.bestBid):o.price,
      armed=stable.stable||!!o.environmentForceRetest,
      expiresAt=armed?Math.min(o.expiresAt,now+12*60_000):Math.min(o.expiresAt,now+BAR_MS),
      deadlineAt=quoteReady?expiresAt:0;
    s.entryValidations[o.id]={id:o.id,candidateId:o.id,symbol:o.symbol,side:o.side,startedAt:now,authorizedAt:now,
      expiresAt,deadlineAt,initialPrice:price,lastPrice:price,lastQuoteAt:quoteReady?q!.observedAt:0,samples:quoteReady?1:0,
      bestAdvanceRate:0,maxAdverseRate:0,supportSamples:0,oppositionSamples:0,extendedConfirmation:extreme.required||researchExtended,
      extremeResidual:extreme.required,minimumElapsedMs,minimumSupportSamples,minimumRetainedRate,
      stableThesis:armed,phase:"ARMED",initialExpectedNetRate:o.netRemainingSpaceRate,
      pullbackRiskRateAtArm:o.pullbackRiskRate,maxChaseRate:stable.maxChaseRate,retestPullbackMin:stable.retestPullbackMin,
      restartMin:stable.restartMin,retestBasePrice:null,retestBaseAt:null,frozenOpportunity:structuredClone(o),
      environment:o.environment,playbook:o.playbook,requiresProbeRetest:!!o.environmentForceRetest,
      probeImpulseMin:o.probeImpulseMin,probePullbackMin:o.probePullbackMin,probeRestartMin:o.probeRestartMin,probeRetestSeen:false,
      status:"WAITING",
      reason:!quoteReady
        ?"交易计划已正式授权并冻结；等待实时执行盘口恢复，研究机会不会因为这一刻缺报价而消失。"
        :extreme.required?extreme.reason:researchExtended
        ?"前瞻研究已形成持续反向状态假设；保留交易权，但要求更完整的实时延续证明。"
        :o.environmentForceRetest
        ?`环境路由 ${o.playbook}：先Probe，必须完成第一段正反馈→可控回调→再次启动后才执行。`
        :stable.stable
        ?"高质量稳定交易假设已武装；短时反向只进入回测等待，不会直接取消，真正结构失效才解除。"
        :o.rapidLiquidityAuthorization
        ?"1分钟已提前确认流动性离开，正式计划已冻结；实时层只负责确认位置和价格响应。"
        :o.extendedConfirmation
        ?(o.futureResearchAction==="CONFIRM_MORE"?"前瞻研究发现状态转移风险，进入加强实时延续确认。":"极端轮动延伸机会进入加强实时延续确认。")
        :profile.fastLane?"高质量机会进入快速实时响应确认。":"候选进入实时响应确认。"};
    trace?.({at:now,id:o.id,symbol:o.symbol,stage:"AUTHORIZED",side:o.side,reason:s.entryValidations[o.id]!.reason??"",price,
      quoteAt:quoteReady?q!.observedAt:0,plan:o.tradePlan,planVersion:o.winnerPlan?.researchVersion??o.winnerPlan?.version,
      research:o.winnerPlan?.entryResearch,expiresAt,invalidationPrice:o.liquidityInvalidationPrice??null});
    if(!quoteReady)reject("正式计划已冻结，等待实时盘口");
    active++;
  }
  s.entryDiagnostics={at:now,matched:eligible.length,opened:0,reasons};
}

function advanceEntryResponses(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,
  minutePaths:Record<string,Candle[]>|undefined,paths:Record<string,Candle[]>|undefined,now:number,equity:number,trace?:(event:ReviewEvent)=>void){
  const opportunities=new Map(s.opportunities.map(o=>[o.id,o])),waiting=Object.values(s.entryValidations)
    .filter(v=>v.status==="WAITING").sort((a,b)=>{
      const ao=a.frozenOpportunity??opportunities.get(a.candidateId),bo=b.frozenOpportunity??opportunities.get(b.candidateId);
      if(!ao)return bo?1:0;if(!bo)return-1;return opportunityCompare(ao,bo);
    });
  const reasons:Record<string,number>={};let opened=0;
  for(const validation of waiting){
    const reject=(reason:string)=>{reasons[reason]=(reasons[reason]??0)+1;
      trace?.({at:now,id:validation.id,symbol:validation.symbol,
        stage:validation.status==="CANCELLED"?(validation.expiresAt<=now?"EXPIRED":"CANCELLED"):
          reason==="等待实时盘口"?"WAIT_QUOTE":validation.phase==="RETEST_WAIT"?"WAIT_RETEST":"WAIT_RESPONSE",
        reason,price:validation.lastPrice,quoteAt:validation.lastQuoteAt,
        planVersion:validation.frozenOpportunity?.winnerPlan?.researchVersion??validation.frozenOpportunity?.winnerPlan?.version,
        research:validation.frozenOpportunity?.winnerPlan?.entryResearch});};
    const o=validation.frozenOpportunity??opportunities.get(validation.candidateId);
    if(!o||!isIntelligenceOpportunity(o)||validation.expiresAt<=now){
      validation.status="CANCELLED";validation.reason="冻结交易计划已经超过自身有效期";reject(validation.reason);continue;
    }
    if(s.positions.some(t=>t.symbol===validation.symbol)){
      validation.status="CANCELLED";validation.reason="同币已有持仓，取消重复执行等待";reject(validation.reason);continue;
    }
    const q=quotes[validation.symbol];if(!freshQuote(q,now)||q!.entryReady!==true){
      validation.reason="交易计划仍然冻结有效，等待实时执行盘口恢复。";reject("等待实时盘口");continue;
    }
    const currentResearch=applyOpportunityResearch(s,o,now);
    if(currentResearch){
      validation.extendedConfirmation=!!validation.extremeResidual||currentResearch.entryAction==="CONFIRM_MORE";
      if(currentResearch.entryAction==="CONFIRM_MORE"){
        validation.minimumElapsedMs=Math.max(validation.minimumElapsedMs??0,30_000);
        validation.minimumSupportSamples=Math.max(validation.minimumSupportSamples??0,4);
        validation.minimumRetainedRate=Math.max(validation.minimumRetainedRate??0,.72);
      }
    }
    const price=validation.side==="LONG"?q!.bestAsk:q!.bestBid;
    if(validation.samples===0||validation.lastQuoteAt<=0){
      validation.startedAt=now;validation.deadlineAt=validation.expiresAt;
      validation.initialPrice=price;validation.lastPrice=price;validation.lastQuoteAt=q!.observedAt;validation.samples=1;
      validation.bestAdvanceRate=0;validation.maxAdverseRate=0;validation.supportSamples=0;validation.oppositionSamples=0;
      trace?.({at:now,id:validation.id,symbol:validation.symbol,stage:"FIRST_EXECUTABLE_QUOTE",reason:"EXECUTION_CLOCK_STARTED",price,quoteAt:q!.observedAt});
      validation.reason="实时执行盘口已经恢复；以首个可执行价格建立执行基准，冻结交易计划继续有效，之前等待盘口的时间不计入价格响应。";
      reject(validation.reason);continue;
    }
    if(q!.observedAt<=validation.lastQuoteAt){reject("等待新的实时盘口样本，不重复计算旧报价");continue;}
    const state=s.extremumRegime.symbols[validation.symbol],
      frozenInvalidation=Number.isFinite(o.liquidityInvalidationPrice)?o.liquidityInvalidationPrice!:null,
      liquidityInvalidated=frozenInvalidation!=null&&(
        validation.side==="LONG"?price<=frozenInvalidation:price>=frozenInvalidation);
    if(liquidityInvalidated&&(!!o.winnerPlan||o.tradePlan==="LIQUIDITY_MIGRATION"||o.tradePlan==="LIQUIDITY_REJECTION"||o.tradePlan==="FAMILY_TURN")){
      validation.status="CANCELLED";validation.reason="价格已经触及冻结交易计划的流动性失效边界，原假设真正失效。";
      reject(validation.reason);continue;
    }
    const decision=evaluateEntryResponse({now,side:validation.side,score:o.environmentScore??o.score,edgeRatio:o.edgeRatio,pullbackRiskRate:o.pullbackRiskRate,
        stopRate:o.stopRate,sourceCount:o.sourceCount??0,disagreementRate:o.disagreementRate??0,mode:o.mode,
        fastLaneAllowed:!!o.environmentMainline,price,
        memory:{startedAt:validation.startedAt,deadlineAt:validation.deadlineAt,initialPrice:validation.initialPrice,samples:validation.samples,
          bestAdvanceRate:validation.bestAdvanceRate,maxAdverseRate:validation.maxAdverseRate,
          supportSamples:validation.supportSamples,oppositionSamples:validation.oppositionSamples},
        state,quote:q,minutePath:minutePaths?.[validation.symbol],costRate:ROUND_TRIP_COST,
        allowRetest:!!validation.stableThesis||(o.tradePlan!=null&&o.tradePlan!=="OBSERVE_ONLY")});
    validation.lastPrice=price;validation.lastQuoteAt=q!.observedAt;validation.samples++;
    validation.bestAdvanceRate=decision.bestAdvanceRate;validation.maxAdverseRate=decision.maxAdverseRate;
    validation.supportSamples=decision.supportSamples;validation.oppositionSamples=decision.oppositionSamples;validation.reason=decision.reason;

    if(decision.action==="CANCEL"){validation.status="CANCELLED";reject(decision.reason);continue;}

    const locationManaged=validation.stableThesis||(o.tradePlan!=null&&o.tradePlan!=="OBSERVE_ONLY");
    if(locationManaged){
      const d=dir(validation.side),expected=validation.initialExpectedNetRate??o.netRemainingSpaceRate,
        pullback=validation.pullbackRiskRateAtArm??o.pullbackRiskRate,
        maxChase=validation.maxChaseRate??stableEntryThesisProfile({score:o.score,premium:!!o.premium,
          thesisBars:o.thesisBars??state?.signalBars??0,stage:o.confirmationStage??state?.stage??"OBSERVE",edgeRatio:o.edgeRatio,
          sourceCount:o.sourceCount??state?.sourceCount??0,dataConfidence:o.dataConfidence??state?.dataConfidence??0,
          netRemainingSpaceRate:o.netRemainingSpaceRate,pullbackRiskRate:o.pullbackRiskRate}).maxChaseRate,
        pullbackMin=validation.retestPullbackMin??ROUND_TRIP_COST*.35,
        restartMin=validation.restartMin??ROUND_TRIP_COST*.30,
        restartAdvance=validation.retestBasePrice?d*(price/validation.retestBasePrice-1):undefined,
        location=stableEntryLocationDecision({currentAdvanceRate:decision.currentAdvanceRate,bestAdvanceRate:decision.bestAdvanceRate,
          expectedNetRate:expected,pullbackRiskRate:pullback,maxChaseRate:maxChase,retestPullbackMin:pullbackMin,
          restartMin,retestBaseReady:!!validation.retestBasePrice,restartAdvanceRate:restartAdvance});

      if(location.action!=="DIRECT"&&location.action!=="READY_AFTER_RETEST")validation.phase="RETEST_WAIT";
      if(location.action==="WAIT_PULLBACK"){
        validation.reason=`方向判断仍有效，但从首次武装位置已推进 ${(location.best*100).toFixed(2)}%，超过允许追价 ${(maxChase*100).toFixed(2)}%；不追，等待至少 ${(location.requiredPullback*100).toFixed(2)}% 回调后重新启动。`;
        reject(validation.reason);continue;
      }
      if(location.action==="SET_RETEST_BASE"){
        validation.retestBasePrice=price;validation.retestBaseAt=now;validation.supportSamples=0;validation.oppositionSamples=0;
        validation.reason="价格已回到可重新评估的位置，保留原稳定假设，等待回调结束后再次按原方向启动。";
        reject(validation.reason);continue;
      }
      if(location.action==="UPDATE_RETEST_BASE"){
        validation.retestBasePrice=price;validation.retestBaseAt=now;validation.supportSamples=0;validation.oppositionSamples=0;
        validation.reason="回调仍在延伸，持续更新重启基准，不提前猜转折。";reject(validation.reason);continue;
      }
      if(location.action==="WAIT_NEW_THESIS"){
        validation.reason="原始交易空间已经大部分消耗，即使方向继续正确也不在当前位置追入；等待新的5m结构生成新假设。";
        reject(validation.reason);continue;
      }
      if(location.action==="WAIT_RESTART"){
        validation.reason=`已完成必要回调，等待原方向重新推进至少 ${(location.restartMin*100).toFixed(2)}% 后再执行。`;
        reject(validation.reason);continue;
      }
      if(location.action==="READY_AFTER_RETEST")validation.phase="ARMED";
    }

    if(decision.action==="RETEST"){
      validation.phase="RETEST_WAIT";validation.reason=decision.reason;reject(decision.reason);continue;
    }
    if(decision.action==="WAIT"){reject(decision.reason);continue;}

    if(!extendedEntryConfirmationReady({required:!!validation.extendedConfirmation,elapsedMs:Math.max(0,now-validation.startedAt),
      supportSamples:decision.supportSamples,currentAdvanceRate:decision.currentAdvanceRate,bestAdvanceRate:decision.bestAdvanceRate,
      minimumElapsedMs:validation.minimumElapsedMs,minimumSupportSamples:validation.minimumSupportSamples,
      minimumRetainedRate:validation.minimumRetainedRate})){
      validation.reason=validation.extremeResidual
        ?"极端残差仍在验证稳定性，尚未获得足够持续实时响应"
        :"研究层要求更完整的实时延续确认，当前证据仍不足";
      reject(validation.reason);continue;
    }

    const recentLocation=entryLocation30(paths?.[validation.symbol],validation.side,price,now),
      locationDecision=entryLocationDecision({sidePosition30:recentLocation?.sidePosition30??null,
        breakoutRate30:recentLocation?.breakoutRate30??null,confirmationAdvanceRate:decision.bestAdvanceRate,costRate:ROUND_TRIP_COST});
    if(locationDecision.action==="WAIT_RETEST"){
      const stable=stableEntryThesisProfile({score:o.environmentScore??o.score,premium:!!o.premium,
        thesisBars:o.thesisBars??state?.signalBars??0,stage:o.confirmationStage??state?.stage??"OBSERVE",edgeRatio:o.edgeRatio,
        sourceCount:o.sourceCount??state?.sourceCount??0,dataConfidence:o.dataConfidence??state?.dataConfidence??0,
        netRemainingSpaceRate:o.netRemainingSpaceRate,pullbackRiskRate:o.pullbackRiskRate});
      validation.stableThesis=true;validation.phase="RETEST_WAIT";
      validation.initialExpectedNetRate=validation.initialExpectedNetRate??o.netRemainingSpaceRate;
      validation.pullbackRiskRateAtArm=validation.pullbackRiskRateAtArm??o.pullbackRiskRate;
      validation.maxChaseRate=validation.maxChaseRate??stable.maxChaseRate;
      validation.retestPullbackMin=validation.retestPullbackMin??stable.retestPullbackMin;
      validation.restartMin=validation.restartMin??stable.restartMin;
      validation.deadlineAt=Math.max(validation.deadlineAt,Math.min(validation.expiresAt,(validation.authorizedAt??validation.startedAt)+12*60_000));
      validation.reason=`方向和流动性计划仍有效，但当前位置已经明显走远：已越过最近30分钟有利边界 ${((locationDecision.breakoutRate30??0)*100).toFixed(2)}%。冻结计划不取消，也不追价；转入回调/重新启动等待。`;
      reject(validation.reason);continue;
    }

    const meta=contracts[o.symbol];if(!meta){reject("等待合约规格");continue;}
    const last=s.lastExitAt[o.symbol]??0,lastSide=s.lastSide[o.symbol];
    if(now-last<15*60_000&&lastSide===o.side){validation.status="CANCELLED";validation.reason="同币同方向假设尚未重置";reject(validation.reason);continue;}
    const error=openIntelligenceTrade(s,o,q!,meta,now,equity,{validation,decision},minutePaths?.[o.symbol]);
    if(error){
      if(error.startsWith("实时成交性价比")||error.startsWith("实时入场已消耗剩余空间")||error.startsWith("入场与持仓证据冲突")){
        if(error.startsWith("入场与持仓证据冲突")){validation.supportSamples=0;validation.oppositionSamples=0;}
        validation.phase="RETEST_WAIT";validation.reason=error;reject(error);continue;
      }
      validation.status="CANCELLED";validation.reason=error;reject(error);continue;
    }
    trace?.({at:now,id:validation.id,symbol:validation.symbol,stage:"FILLED",reason:"PAPER_FILLED",
      price:s.positions.find(t=>t.symbol===validation.symbol)?.entryPrice,quoteAt:q!.observedAt,
      tradeId:s.positions.find(t=>t.symbol===validation.symbol)?.id,planVersion:o.winnerPlan?.researchVersion??o.winnerPlan?.version,
      research:o.winnerPlan?.entryResearch});
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
    if(o.environmentForceRetest){reject("环境Playbook要求先完成Probe→回调→再启动，禁止兼容入口直接成交");continue;}
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
  quotes:Record<string,Quote>;analysisQuotes?:Record<string,Quote>;contracts:Record<string,Contract>;entrySymbols?:Iterable<string>;learningSymbols?:Iterable<string>;allowDataCycle?:boolean;
  legacyDrainOnly?:boolean;research?:MarketLifecycleResearchContext;reviewTrace?:(event:ReviewEvent)=>void}){
  // An optional observer has no return value or trading authority. A failed logger cannot block a trade.
  const trace=input.reviewTrace?(event:ReviewEvent)=>{try{input.reviewTrace!(event);}catch{/* diagnostics only */}}:undefined;
  const s=normalizeForward(structuredClone(input.state),input.now),
    before=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate,t.contracts,t.realization?.sequence]),h:s.history.length,b:s.balance,r:s.revision,
      v:Object.values(s.entryValidations).filter(x=>x.status==="WAITING").map(x=>x.id).sort()});
  s.lastQuoteCycleAt=input.now;
  for(const v of Object.values(s.entryValidations))if(v.status==="WAITING"&&v.frozenOpportunity&&!v.frozenOpportunity.winnerPlan){
    v.status="CANCELLED";v.reason="旧区域专属开仓计划已被替换，等待同一市场的新版独立机会";
  }
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
      researchQuotes=input.analysisQuotes??input.quotes,
      built=buildMarketIntelligence({paths:input.paths,minutePaths:input.minutePaths,daily:input.daily,quotes:researchQuotes,
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
  const marketEvolution=deriveMarketEvolution(s.extremumRegime,input.research),
    currentEnvironment=classifyMarketEnvironment(s.extremumRegime,marketEvolution),
    priorOutlook=s.environmentContext.outlook,
    outlookDue=!priorOutlook||dataDue||input.now-s.environmentContext.updatedAt>=60_000,
    fastEnvironment=deriveFastEnvironmentSignal(Object.values(input.analysisQuotes??input.quotes).filter(q=>freshQuote(q,input.now))),
    environmentOutlook=outlookDue
      ?deriveEnvironmentOutlook(s.extremumRegime,marketEvolution,{fast:fastEnvironment,previous:priorOutlook})
      :priorOutlook;
  s.environmentContext={version:ENVIRONMENT_ROUTER_VERSION,environment:currentEnvironment,phase:marketEvolution.phase,
    trendSide:marketEvolution.trendSide,updatedAt:outlookDue?input.now:s.environmentContext.updatedAt,
    reason:environmentOutlook.reason,outlook:environmentOutlook};
  if(marketReady)annotateLifecycleOpportunities(s,marketEvolution,environmentOutlook);
  manageIntelligenceTrades(s,input.quotes,input.now,input.minutePaths,marketEvolution,environmentOutlook,input.paths,input.contracts);
  // Positions opened before cutover keep their frozen lifecycle and cannot gain
  // new-entry authority from the retired relation/region/interrupt stack.
  markAndManage(s,input.quotes,input.now);

  const mark=equityMark(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));updateDaily(s,input.now,mark.equity);
  // Whole-market 5m/15m/30m structure defines the plan, but a qualified plan
  // may be authorized between 5m closes (including the causal 1m rapid-migration
  // lane). Once authorized, its frozen identity is handed to the critical 2s
  // execution clock; research refreshes can no longer make it disappear.
  if(marketReady)seedEntryResponses(s,input.quotes,input.now,trace);
  const opened=marketReady?advanceEntryResponses(s,input.quotes,input.contracts,input.minutePaths,input.paths,input.now,mark.equity,trace):0;

  const states=Object.values(s.extremumRegime.symbols),longReady=states.filter(x=>x.longScore>=62).length,
    shortReady=states.filter(x=>x.shortScore>=62).length,divergent=states.filter(x=>x.regime==="DIVERGENT").length,
    ready=states.filter(x=>x.stage==="READY").length,totalRisk=existingRisk(s),riskUse=mark.equity>0?100*totalRisk/mark.equity:0;
  s.fitDiagnostics={tested:states.length,qualified:s.opportunities.filter(o=>o.eligible).length,trainGroups:s.extremumRegime.clusters.length,
    checkGroups:s.extremumRegime.evidence.length,latestAt:input.now,rapidQualified:ready,activeLong:longReady,activeShort:shortReady};
  s.latestReason=(marketReady?s.extremumRegime.narrative.summary
    :`全市场5m路径正在恢复 ${readyPaths}/${requiredPaths}；沿用上一份市场叙事保护已有仓位，覆盖恢复前不生成新单。`)
    +` 当前${s.positions.length}笔持仓，${s.opportunities.filter(o=>o.eligible).length}个可参与机会，计划风险已用${riskUse.toFixed(1)}%。 研究背景=${currentEnvironment}，${marketEvolution.reason} ${s.extremumRegime.narrative.plan} 前瞻研究分级作用于新版计划：${s.hypothesisResearch.summary}`;
  if(divergent)s.latestReason+=` 当前发现${divergent}个明显分化资产。`;
  if(opened)s.latestReason+=` 本轮新开${opened}笔。`;
  const after=JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate,t.contracts,t.realization?.sequence]),h:s.history.length,b:s.balance,r:s.revision,
    v:Object.values(s.entryValidations).filter(x=>x.status==="WAITING").map(x=>x.id).sort()});
  return{state:s,changed:before!==after||dataDue,protectionChanged:input.state.positions.some(t=>s.positions.find(n=>n.id===t.id)?.stopPrice!==t.stopPrice)};
}
export function closeForwardForReset(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const s=normalizeForward(structuredClone(state),now);
  if(s.inverseTrial){
    const source=structuredClone(sourceDecisionState(s));
    for(const t of [...source.positions]){const q=quotes[t.symbol],px=freshQuote(q,now)?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
      closeTrade(source,t,px,now,'ACCOUNT_RESET',{quoteAt:q?.observedAt??t.lastQuoteAt});
      applyInverseSourceTrade(s,t,q,now,true);
    }
    source.positions=[];s.inverseTrial.source=shadowCapsule(source);s.inverseTrial.lastSourceRevision=source.revision;
  }
  for(const t of [...s.positions]){const q=quotes[t.symbol],px=freshQuote(q,now)?(t.side==="LONG"?q!.bestBid:q!.bestAsk):t.lastPrice;closeTrade(s,t,px,now,"ACCOUNT_RESET");}
  s.positions=[];return s;
}
/** Close-only migration lane. Existing holdings retain the pre-cutover policy;
 * inverse positions are explicitly excluded from both strategy managers. */
export function drainLegacyForwardPositions(s:ForwardState,input:{now:number;quotes:Record<string,Quote>;paths:Record<string,Candle[]>;
  minutePaths?:Record<string,Candle[]>;contracts:Record<string,Contract>;research?:MarketLifecycleResearchContext}){
  const evolution=deriveMarketEvolution(s.extremumRegime,input.research),outlook=s.environmentContext.outlook
    ??deriveEnvironmentOutlook(s.extremumRegime,evolution);
  manageIntelligenceTrades(s,input.quotes,input.now,input.minutePaths,evolution,outlook,input.paths,input.contracts);
  markAndManage(s,input.quotes,input.now);
}
export function resetForwardAccountPreservingLearning(previous:ForwardState,now:number){
  const prior=normalizeForward(structuredClone(sourceDecisionState(previous)),now),next=initialForward(now);
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
  next.environmentPerformance=structuredClone(prior.environmentPerformance);
  next.environmentContext=structuredClone(prior.environmentContext);
  next.observations=next.relationEngine.observations;next.measured=next.relationEngine.measured;next.invalidated=next.relationEngine.invalidated;
  next.latestReason="模拟账户资金已重置为1000U；保留 Market Intelligence 市场叙事、证据、相关组和异常生命周期，当前5m不会因重置重复开仓。";
  return next;
}
export function forwardUrgentQuoteSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):null,keep=(x:string)=>!allowed||allowed.has(x),
    armed=Object.values(s.entryValidations).filter(v=>v.status==="WAITING"&&keep(v.symbol)).sort((a,b)=>a.startedAt-b.startedAt);
  const premium=s.opportunities.filter(o=>o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort(opportunityCompare);
  const normal=s.opportunities.filter(o=>!o.premium&&o.eligible&&o.expiresAt>now&&keep(o.symbol)).sort(opportunityCompare);
  const watched=Object.values(s.extremumRegime.symbols).filter(r=>keep(r.symbol)&&r.watchScore>=58).sort((a,b)=>b.watchScore-a.watchScore);
  return[...new Set([...(s.inverseTrial?.source.positions.map(t=>t.symbol)??[]),...s.positions.map(t=>t.symbol),...armed.map(v=>v.symbol),...premium.map(o=>o.symbol),...normal.map(o=>o.symbol),...watched.map(r=>r.symbol)])];
}
export function forwardUrgentMinuteSymbols(s:ForwardState,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):undefined,keep=(x:string)=>!allowed||allowed.has(x),
    armed=Object.values(s.entryValidations).filter(v=>v.status==="WAITING"&&keep(v.symbol))
      .sort((a,b)=>a.startedAt-b.startedAt).map(v=>v.symbol),
    research=intelligenceUrgentMinuteSymbols(s.extremumRegime,allowed),
    positions=[...new Set([...(s.inverseTrial?.source.positions.map(t=>t.symbol)??[]),...s.positions.map(t=>t.symbol)])].filter(keep);
  // Entry discovery/authorization is the time-sensitive use of 1m data.
  // Existing positions still retain realtime price/flow and 5m structure even
  // when their 1m refresh rotates behind active entry work.
  return[...new Set([...armed,...research,...positions])].slice(0,FORWARD_MINUTE_CONFIRMATION_CAP);
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
  const routed=s.opportunities.filter(isIntelligenceOpportunity),
    activePlaybooks=[...new Set(routed.filter(o=>o.eligible).map(o=>o.playbook).filter((x):x is EnvironmentPlaybook=>!!x))],
    performanceCells=Object.values(s.environmentPerformance.cells).sort((a,b)=>b.updatedAt-a.updatedAt);
  return{shadowInverse:inverseTrialSummary(s,quotes,now),version:s.version,engineVersion:ADAPTIVE_ENGINE_VERSION,grammar:ADAPTIVE_ENGINE_VERSION,positionIntelligenceVersion:POSITION_INTELLIGENCE_VERSION,mode:"REAL_FEED_PAPER",liveEligible:false,
    strategyAuthorityVersion:ADAPTIVE_ENGINE_VERSION,executionVersion:ADAPTIVE_ENGINE_VERSION,regionVersion:MARKET_INTELLIGENCE_VERSION,
    regionLaunchVersion:MARKET_INTELLIGENCE_VERSION,policyVersion:ADAPTIVE_ENGINE_VERSION,exitPolicyVersion:ADAPTIVE_ENGINE_VERSION,
    policyUpgrade:null,exitPolicyUpgrade:null,startedAt:s.startedAt,cutoverAt:s.cutoverAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...mark,targetEquity:s.initialEquity*2,
    netPnl:mark.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,fees:s.fees,
    fundingAllowance:s.fundingAllowance,turnover:s.turnover,positions:s.positions,history:s.history,events:s.events,daily:s.daily,
    opportunities:s.opportunities,entryOpportunities:s.opportunities,regions:[],marketPulse:s.marketPulse,
    hypothesisResearch:s.hypothesisResearch,researchPlanVersion:RESEARCH_PLAN_VERSION,
    environmentRouter:{...s.environmentContext,currentEnvironment:s.environmentContext.environment,activePlaybooks,
      performance:performanceCells.slice(0,8)},
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
      validation:"单一噪声不能让大方向来回翻转。新版计划保留独立趋势核心；稳定市场预警只调整新增风险与普通机会确认，健康持仓不能被市场预警单独平掉。研究、订单与执行页共用订单冻结区域；旧多尺度地图仅作背景。",
      liquidation:"先执行既定硬风险与保护线；主动退出需要本币新的价格失败依据。盈利后的部分兑现统一由同一计划管理，不把同源价格分数当成多项独立证据。"},
    cost:PAPER_COST,nextCycleAt:s.lastCandleAt+BAR_MS};
}
