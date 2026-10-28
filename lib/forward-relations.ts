import {isolatedLiquidationPrice,liquidationHit,maintenanceRateOf} from "./paper-leverage.ts";
import {type PlanResearchDecision} from './research-plan.ts';
import {assertInverseTrade,assertInverseTrial,migrateInverseSamePrice,alignComparisonSourceFees,retainDetachedSourceIds,type InverseCopy,type InverseTrial} from './shadow-inverse-ledger.ts';
import {noteForwardStudy} from './forward-study.ts';
import {type WinnerPlan,type WinnerManagement} from "./winner-policy.ts";
import {realizedContribution,assertTradeRealization,type TradeRealization} from "./trade-realization.ts";
import {recordWinnerRiskLoss,type WinnerRiskLedger} from "./winner-risk.ts";
import {initialFamilyExperimentState,normalizeFamilyExperimentState,recordFamilyOutcome,relationFamilyId,type FamilyExperimentState} from "./forward-family-experiment.ts";
import {initialRelationEngine,normalizeRelationEngine,type RelationEngineState,type RelationExitProfile,type RelationStatus} from "./forward-relation-v2.ts";
import {initialStructuralInterruptState,normalizeStructuralInterruptState,type StructuralInterruptState} from "./forward-structural-interrupt.ts";
import {MARKET_INTELLIGENCE_VERSION,initialMarketIntelligenceState,type LiquidityTradePlan,type MarketIntelligenceState,type MarketSymbolState} from "./market-intelligence-engine.ts";
import {type PositionIntelligenceState} from "./position-intelligence-engine.ts";
import { beijingDayKey } from "./beijing-time.ts";
import {type EntryStructure} from "./entry-structure.ts";
import {type CoinPath} from "./coin-path.ts";
import {type TransitionEntry} from "./transition-rule.ts";
import {type EntryGateNote} from "./entry-gate.ts";
import type { S1Note } from "./s1-rule.ts";
import type {LivingNote} from "./living/directive.ts";
import {initialShockEpisode,normalizeShockEpisode,type ShockEpisode} from "./shock-episode.ts";
import {initialStageChronicle,normalizeStageChronicle,type StageChronicle,type StageStamp} from "./stage-chronicle.ts";
import {backfillSignalTally,earliestTallyAt,normalizeSignalTally,noteSignalOutcome,type SignalRepeat,type SignalTally,type SignalTallyMeta} from "./signal-repeat.ts";
import {type MarketEvolutionState,type OpportunityLifecyclePhase,type ProfitLifecycleState} from "./market-intelligence-lifecycle.ts";
import {initialMarketHypothesisResearch,normalizeMarketHypothesisResearch,type EntryHypothesisGuidance,type MarketHypothesisResearchState} from "./market-intelligence-hypothesis-research.ts";
import {ENVIRONMENT_OUTLOOK_VERSION,ENVIRONMENT_ROUTER_VERSION,initialEnvironmentPerformanceState,normalizeEnvironmentPerformanceState,recordEnvironmentOutcome,type EnvironmentOutlook,type EnvironmentPerformanceState,type EnvironmentPlaybook,type MarketEnvironment,type RouteAlignment} from "./market-intelligence-environment-router.ts";

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
export const PAPER_COST={feeRate:.0007,slippageRate:.00025,fundingAllowancePerDay:.0002,
  assumption:"双边吃单费各7bp＋滑点各2.5bp＋每日2bp不利资金费占位"};
const ROUND_TRIP_COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate);
const HISTORY_LIMIT=240,EVENT_LIMIT=160,CONSUMED_THESIS_LIMIT=512,CONSUMED_THESIS_TTL_MS=7*24*60*60_000;
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
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
  /** 研究层给这个币打的自身走势。只留档，不参与开仓。 */
  coinPath?:CoinPath;
};
export type MarketPulse={at:number;up:number;down:number;neutral:number;bias:"UP"|"DOWN"|"MIXED";strength:number;expansion:number};

export type EntryContext={
  winnerPlan?:WinnerPlan;
  version:"adaptive-ten-entry-v1";capturedAt:number;timeframe:"5m";side:"LONG"|"SHORT";mode:OpportunityMode;reserve?:boolean;
  reason:string;entryScore:number;directionStrength:number;spaceScore:number;positionScore:number;executionScore:number;
  remainingSpaceRate:number;pullbackRiskRate:number;edgeRatio:number;expectedHoldMinutes:number;marketFit:number;
  regionId:string|null;regionLower?:number;regionUpper?:number;regionCenter?:number;
  relationRuleId?:string;relationStatus?:RelationStatus;relationHorizon?:15|30|45|60;relationHealth?:number;portfolioRiskCharge?:number;sizeMultiple?:number;
  relationFamilyId?:string;relationEvidenceAt?:number;relationLivePathScore?:number;
  interruptEventId?:string;interruptMarketWide?:boolean;interruptBoundary?:number;interruptStrength?:number;
  strategyVersion?:string;regime?:MarketSymbolState["regime"]|"TREND_UP"|"TREND_DOWN"|"SWING"|"WEAKENING";topPressure?:number;bottomPressure?:number;upSurvival?:number;downSurvival?:number;
  confirmationStage?:MarketSymbolState["stage"]|"WATCH"|"CANDIDATE"|"STRUCTURE_BREAK"|"RECLAIM_TEST"|"IMPULSE";sourceCount?:number;disagreementRate?:number;postEntryState?:"PENDING"|"CONFIRMED"|"FAILED";
  entryResponse?:{version:string;startedAt:number;confirmedAt:number;elapsedMs:number;samples:number;advanceRate:number;bestAdvanceRate:number;
    maxAdverseRate:number;supportFamilies:string[];fastLane:boolean};
  clusterId?:string;thesisId?:string;marketNarrativeId?:string;thesisSummary?:string;invalidationSummary?:string;entryResidual?:number;entryRelativeStrength?:number;
  thesisSince?:number;thesisBars?:number;researchMoveAge?:'STARTED'|'ONGOING'|'DONE'|'QUIET';researchCrowd?:'LONG'|'SHORT'|'NONE';
  marketEvolutionPhase?:MarketEvolutionState["phase"];opportunityLifecyclePhase?:OpportunityLifecyclePhase;
  extendedConfirmation?:boolean;environment?:MarketEnvironment;playbook?:EnvironmentPlaybook;routeAlignment?:RouteAlignment;
  environmentRiskScale?:number;environmentProbe?:boolean;environmentReason?:string;
  environmentOutlookVersion?:typeof ENVIRONMENT_OUTLOOK_VERSION;environmentModeFit?:number;environmentHorizonMinutes?:15|30|45|60;
  environmentPersistenceScore?:number;environmentTransitionPressure?:number;environmentProfitExpansion?:EnvironmentOutlook["profitExpansion"];
  marketExpectancy?:number;
  tradePlan?:LiquidityTradePlan;liquidityPlanConfidence?:number;liquidityReason?:string;liquidityTargetRate?:number|null;
  liquidityOriginLower?:number|null;liquidityOriginUpper?:number|null;liquidityTargetLower?:number|null;liquidityTargetUpper?:number|null;
  liquidityInvalidationPrice?:number|null;rapidLiquidityAuthorization?:boolean;
  baseEntryScore?:number;environmentScore?:number;
  futureResearchAction?:EntryHypothesisGuidance["action"];futureResearchReason?:string;futureHypothesisIds?:string[];
  entryStructure?:EntryStructure;
  transitionRule?:TransitionEntry;
  /** 爆发段里按空间规则选定的方向。只决定进场方向，不接管出场。 */
  shockRoom?:TransitionEntry;
  /** 进场时研究层阶段怎么接上的。只留档，不参与开仓或出场。 */
  stageNote?:StageStamp;
  /** 进场时能看到的方向细节。只留档，不参与开仓或出场。 */
  entryRead?:EntryRead;
  /** 进场时这个币自己的 5 分钟走势。只留档，不参与开仓或出场。 */
  coinPath?:CoinPath;
  /** 进场时多记下的分数和计划。只留档，不参与开仓或出场。 */
  entrySnap?:EntrySnap;
  /** 趋势/爆发两条开仓规则（BTC 顺向、山寨急跌反手）当时怎么判的。只留档，不参与出场。 */
  entryGate?:EntryGateNote;
  /** LEGACY (read-only): S1 note on trades opened while S1 was live (10-19, withdrawn the same day; lib/s1-rule.ts).
   * Only exported/rendered; no decision reads it. Such a trade, if still open, is managed by the earlier exit stack. */
  s1?:S1Note;
  /** Living research layer (lib/living): the compact reason this trade was opened by the living flow. Absent on every other trade. */
  living?:LivingNote;
};
import type {TradeReview} from "./review-trace.ts";

export type EntrySnap={
  mode:string|null;trade_plan:string|null;intent:string|null;
  long_score:number|null;short_score:number|null;residual_z:number|null;
  score:number|null;stop_price:number|null;planned_hold_min:number|null;
  volume24h_usd:number|null;funding_rate:number|null;trend_score:number|null;factor_30m_pct:number|null;
};

export type Trade={
  inverseCopy?:InverseCopy;
  /** Living layer protection (fast-lane tighten / breakeven / thesis breakeven): a tighter stop with its reason. Absent unless the living layer set it. */
  livingGuard?:{stop:number;code:string;reason:string;at:number};
  /** Last tick the living layer was driving this trade's exits (directive present with exits on). Living trades only. */
  livingSeenAt?:number;
  /** Isolated-margin liquidation price fixed at open, and the maintenance rate used for it. */
  liquidationPrice?:number|null;maintenanceRate?:number|null;
  winnerManagement?:WinnerManagement;realization?:TradeRealization;
  review?:TradeReview;
  id:string;symbol:string;side:"LONG"|"SHORT";rule:Rule;openedAt:number;closedAt:number|null;status:"OPEN"|"CLOSED";
  entryPrice:number;exitPrice:number|null;quantity:number;contracts:number;quantoMultiplier:number;notional:number;
  leverage:number;margin:number;plannedRisk:number;stopPrice:number;armPrice:number;favorable:number;adverse:number;
  lastPrice:number;lastQuoteAt:number;entryFee:number;exitFee:number;fundingAllowance:number;grossPnl:number|null;netPnl:number|null;
  exitReason:string|null;relationFailureBars:number;lastRelationBar:number;execution:"REAL_QUOTE_PAPER_MODEL";liveEligible:false;
  exitRegime?:{stage:MarketEnvironment;phase:MarketEvolutionState["phase"]};
  entryContext?:EntryContext;forecast?:{remainingNetRate:number;quality:number;sizingEquity:number};exitPlan?:RelationExitProfile;
  firstProfitAt?:number|null;holdScore?:number;profitFloorRate?:number;expectedHoldMinutes?:number;peakPnlRate?:number;
  exitControl?:{policy:string;armedAt:number|null;armedQuoteAt:number|null;maxObservationGapMs:number;maxQuoteAgeMs:number};
  profitProtection?:{version:string;reachedR:number;lockedR:number;floorRate:number;retentionRate:number;activationRate:number;
    checkpointBand:number;mode:"STRONG_TREND"|"HEALTHY_TREND"|"NORMAL"|"WEAKENING";peakR:number;updatedAt:number};
  profitProtectionMigration?:{version:string;state:"CURRENT"|"GUARDED"|"DEFERRED";updatedAt:number;baselineFavorable:number};
  exitAudit?:{trigger:string;at:number;detail?:string;evidence?:Record<string,string|number|boolean|null>;research?:PlanResearchDecision};
  /** 研究层不是同步爆发或趋势，所以没进账户。只留档供复盘，不改余额。 */
  unopened?:boolean;
  /** 同币同方向第几次信号，以及距上一笔多少分钟。只在写下这一笔时定死。 */
  signalRepeat?:SignalRepeat;
  entrySpreadBps?:number|null;
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
/** Funds-only reset. Requested while positions are open it waits (pendingFundsReset) and runs at the first
 * moment the account has no open position; nothing is force-closed and entries/exits are unchanged. */
export type AccountReset={at:number;requestedAt:number;epoch:number;equityBefore:number;balanceBefore:number;balanceAfter:number;
  /** Set only on the one-time strategy-removal reset: its idempotence marker and the exportable pre-reset snapshot. */
  kind?:string;snapshot?:StripResetSnapshot};
export type StripResetSnapshot={reason:string;at:number;balanceBeforeClose:number;balanceAfterClose:number;realizedFromClose:number;
  fees:number;grossPnl:number;resolved:number;wins:number;turnover:number;maxDrawdown:number;initialEquity:number;
  positions:{id:string;symbol:string;side:"LONG"|"SHORT";openedAt:number;entryPrice:number;exitPrice:number|null;quantity:number;notional:number;
    margin:number;leverage:number;stopPrice:number;lastPrice:number;inverseCopy:boolean;netPnlOnClose:number|null}[];
  daily:Daily[];historyCount:number;unopenedCount:number};
export type PendingFundsReset={requestedAt:number};
export type ForwardState={
  inverseTrial?:InverseTrial;
  winnerRisk?:WinnerRiskLedger;
  version:string;engineVersion:string;startedAt:number;revision:number;lastCycleAt:number;lastQuoteCycleAt:number;lastCandleAt:number;
  balance:number;initialEquity:number;peakEquity:number;maxDrawdown:number;resolved:number;wins:number;grossPnl:number;fees:number;
  fundingAllowance:number;turnover:number;positions:Trade[];history:Trade[];unopenedTrades?:Trade[];events:AuditEvent[];daily:Daily[];
  selectedSymbols:string[];opportunities:Opportunity[];regions:Record<string,Region>;relationEngine:RelationEngineState;extremumRegime:MarketIntelligenceState;
  familyExperiment:FamilyExperimentState;structuralInterrupt:StructuralInterruptState;
  hypothesisResearch:MarketHypothesisResearchState;environmentPerformance:EnvironmentPerformanceState;
  environmentContext:{version:typeof ENVIRONMENT_ROUTER_VERSION;environment:MarketEnvironment;phase:MarketEvolutionState["phase"];
    trendSide:"LONG"|"SHORT"|null;updatedAt:number;reason:string;outlook?:EnvironmentOutlook};
  shockEpisode?:ShockEpisode;
  stageChronicle?:StageChronicle;
  signalTally?:Record<string,SignalTally>;
  signalTallyMeta?:SignalTallyMeta;
  /** Funds-only resets inside this log epoch (startedAt). Oldest first. */
  accountResets?:AccountReset[];
  pendingFundsReset?:PendingFundsReset|null;
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
    positions:[],history:[],unopenedTrades:[],events:[],daily:[],selectedSymbols:[],opportunities:[],regions:{},relationEngine:initialRelationEngine(now),
    extremumRegime:initialMarketIntelligenceState(now),
    familyExperiment:initialFamilyExperimentState(),structuralInterrupt:initialStructuralInterruptState(),
    hypothesisResearch:initialMarketHypothesisResearch(now),environmentPerformance:initialEnvironmentPerformanceState(),
    environmentContext:{version:ENVIRONMENT_ROUTER_VERSION,environment:"TRANSITION",phase:"TRANSITIONAL",
      trendSide:null,updatedAt:now,reason:"环境路由正在建立稳定市场分类。"},
    shockEpisode:initialShockEpisode(),
    stageChronicle:initialStageChronicle(now),
    signalTally:{},
    signalTallyMeta:{backfilled:false,from:null},
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
function sameMoney(a:number,b:number){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));}
/** A not-opened note or a finished row can store a partial whose remaining size
 * was never restored. Put the parent size back. Cash already booked stays. */
function restoreRealizationParent(t:Trade){
  const r=t.realization;if(!r||!(t.entryPrice>0))return false;
  t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.plannedRisk=r.initialRisk;
  const identity=t.quantity*t.entryPrice;
  t.notional=sameMoney(r.initialNotional,identity)?r.initialNotional:identity;
  t.margin=sameMoney(t.notional,r.initialNotional)?r.initialMargin:t.notional/Math.max(t.leverage||1,1);
  if(!sameMoney(t.entryFee,r.initialEntryFee))t.entryFee=r.initialEntryFee;
  return true;
}
function alignSavedRealization(t:Trade){
  if(!t.realization)return;
  try{assertTradeRealization(t);return;}
  catch(error){if(!(error instanceof Error)||!error.message.includes("部分兑现账本与剩余仓位不一致"))throw error;}
  const r=t.realization,filledQty=r.fills.reduce((n,f)=>n+f.quantity,0),filledContracts=r.fills.reduce((n,f)=>n+f.contracts,0);
  const sums=r.version==="partial-realization-v1"&&Array.isArray(r.fills)&&r.fills.length>=1&&r.fills.length<=2&&r.sequence===r.fills.length
    &&r.fills.every((f,i)=>f.sequence===i+1&&f.quantity>0&&f.contracts>0)
    &&sameMoney(r.fills.reduce((n,f)=>n+f.gross,0),r.gross)&&sameMoney(r.fills.reduce((n,f)=>n+f.fee,0),r.fees)
    &&sameMoney(r.fills.reduce((n,f)=>n+f.funding,0),r.funding)
    &&filledQty<=r.initialQuantity+1e-8&&filledContracts<=r.initialContracts+1e-8&&filledContracts<=r.initialContracts*.65+1e-6;
  if(t.status==="CLOSED"){
    if(sums)restoreRealizationParent(t);
    try{assertTradeRealization(t);}catch{delete t.realization;}
    return;
  }
  const sizeMatches=sameMoney(t.quantity,r.initialQuantity-filledQty)&&sameMoney(t.contracts,r.initialContracts-filledContracts);
  if(!t.unopened){
    if(!sizeMatches)throw new Error(`部分兑现账本与剩余仓位不一致；保留原账户（${t.symbol} 仍持仓）`);
    t.notional=t.quantity*t.entryPrice;t.margin=t.notional/Math.max(t.leverage||1,1);
    if(!sameMoney(t.entryFee,r.initialEntryFee))t.entryFee=r.initialEntryFee;
    assertTradeRealization(t);return;
  }
  if(sizeMatches){
    t.notional=t.quantity*t.entryPrice;t.margin=t.notional/Math.max(t.leverage||1,1);
    if(!sameMoney(t.entryFee,r.initialEntryFee))t.entryFee=r.initialEntryFee;
    try{assertTradeRealization(t);return;}catch{/* the note is not a live position */}
  }
  delete t.realization;
}
function normalizeTrade(raw:Trade,now:number):Trade{
  const t=structuredClone(raw) as Trade,tick=Math.max(1e-9,safe(t.entryPrice,1)),side=t.side==="SHORT"?"SHORT":"LONG";
  assertInverseTrade(t);
  alignSavedRealization(t);
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
  t.peakPnlRate=Math.max(0,safe(t.peakPnlRate,t.favorable));
  const repeat=t.signalRepeat;
  if(repeat&&typeof repeat.n==="number"&&repeat.n>=1&&Number.isFinite(repeat.n)){
    const gap=repeat.gapMin;
    t.signalRepeat={n:Math.min(1_000_000,Math.floor(repeat.n)),gapMin:typeof gap==="number"&&Number.isFinite(gap)&&gap>=0?gap:null,
      nSymbol:typeof repeat.nSymbol==="number"&&repeat.nSymbol>=1?Math.floor(repeat.nSymbol):null,
      prevSide:repeat.prevSide==="LONG"||repeat.prevSide==="SHORT"?repeat.prevSide:null,
      prevGapMin:typeof repeat.prevGapMin==="number"&&Number.isFinite(repeat.prevGapMin)&&repeat.prevGapMin>=0?repeat.prevGapMin:null,
      prevNetPct:typeof repeat.prevNetPct==="number"&&Number.isFinite(repeat.prevNetPct)?repeat.prevNetPct:null,
      prevMfePct:typeof repeat.prevMfePct==="number"&&Number.isFinite(repeat.prevMfePct)?repeat.prevMfePct:null,
      prevMaePct:typeof repeat.prevMaePct==="number"&&Number.isFinite(repeat.prevMaePct)?repeat.prevMaePct:null};
  }else delete t.signalRepeat;
  t.entrySpreadBps=typeof t.entrySpreadBps==="number"&&Number.isFinite(t.entrySpreadBps)&&t.entrySpreadBps>=0?t.entrySpreadBps:null;
  return t;
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
  migrateInverseSamePrice(v,now);alignComparisonSourceFees(v);retainDetachedSourceIds(v);assertInverseTrial(v);
  if(v.version!==FORWARD_VERSION||!Number.isFinite(v.balance)||!Array.isArray(v.positions)||!Array.isArray(v.history)||v.liveEligible!==false)
    throw new Error("前向账户存储格式异常；保留原数据，禁止自动重置");
  const base=initialForward(v.startedAt>0?v.startedAt:now);
  const old=v as ForwardState&Record<string,unknown>;
  const upgrading=v.engineVersion!==ADAPTIVE_ENGINE_VERSION||v.strategyAuthorityVersion!==ADAPTIVE_ENGINE_VERSION
    ||v.executionVersion!==ADAPTIVE_ENGINE_VERSION;
  const relationEngine=normalizeRelationEngine(v.relationEngine,now);
  const positions=v.positions.map(t=>normalizeTrade(t,now)),history=v.history.map(t=>normalizeTrade(t,now)).slice(0,HISTORY_LIMIT);
  const unopenedRaw=Array.isArray(old.unopenedTrades)?old.unopenedTrades.map(t=>normalizeTrade(t,now)):[];
  const unopenedTrades=[...unopenedRaw.filter(t=>t.status==="OPEN"),...unopenedRaw.filter(t=>t.status!=="OPEN").slice(0,800)];
  for(const t of positions){
    if(!t.entryContext?.relationFamilyId&&t.entryContext?.relationRuleId){
      const rule=relationEngine.rules.find(r=>r.id===t.entryContext?.relationRuleId);
      if(rule)t.entryContext.relationFamilyId=relationFamilyId(rule);
    }
  }
  const familyExperiment=normalizeFamilyExperimentState((old as {familyExperiment?:unknown}).familyExperiment,relationEngine.rules,
    (old as {relationGuards?:unknown}).relationGuards);
  if(v.inverseTrial)noteForwardStudy(v.inverseTrial,now);
  const tallyKept=normalizeSignalTally((old as {signalTally?:unknown}).signalTally);
  const tallyMeta=(old as {signalTallyMeta?:SignalTallyMeta}).signalTallyMeta;
  let signalTally=tallyKept,signalTallyMeta:SignalTallyMeta=tallyMeta?.backfilled?tallyMeta:{backfilled:true,from:earliestTallyAt(tallyKept)};
  if(!tallyMeta?.backfilled&&!Object.keys(tallyKept).length){
    try{
      const rebuilt=backfillSignalTally([...history,...unopenedTrades].map(row=>({id:row.id,symbol:row.symbol,side:row.side,openedAt:row.openedAt,status:row.status,
        netPct:row.netPnl!=null&&row.notional>0?row.netPnl/row.notional*100:null,
        mfePct:Number.isFinite(row.favorable)?row.favorable*100:null,
        maePct:Number.isFinite(row.adverse)?row.adverse*100:null})));
      signalTally=rebuilt.tally;signalTallyMeta={backfilled:true,from:rebuilt.from};
    }catch{signalTallyMeta={backfilled:true,from:null};}
  }
  return{...base,...old,
    startedAt:safe(v.startedAt,base.startedAt),revision:Math.max(0,Math.floor(safe(v.revision))),lastCycleAt:safe(v.lastCycleAt),lastQuoteCycleAt:safe(v.lastQuoteCycleAt),
    lastCandleAt:safe(v.lastCandleAt,safe(v.lastCycleAt)),balance:safe(v.balance,1000),initialEquity:safe(v.initialEquity,1000),
    peakEquity:Math.max(safe(v.peakEquity,1000),safe(v.balance,1000)),maxDrawdown:Math.max(0,safe(v.maxDrawdown)),
    resolved:Math.max(0,Math.floor(safe(v.resolved))),wins:Math.max(0,Math.floor(safe(v.wins))),grossPnl:safe(v.grossPnl),
    fees:Math.max(0,safe(v.fees)),fundingAllowance:Math.max(0,safe(v.fundingAllowance)),turnover:Math.max(0,safe(v.turnover)),
    positions,history,unopenedTrades,
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
    shockEpisode:normalizeShockEpisode((old as {shockEpisode?:unknown}).shockEpisode),
    stageChronicle:normalizeStageChronicle((old as {stageChronicle?:unknown}).stageChronicle,now),
    signalTally,signalTallyMeta,
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
    if(t.exitControl?.policy==='lsr-v1'||t.exitControl?.policy==='rx-v1'||t.exitControl?.policy==='desk-v1'){
      const q=quotes[t.symbol],fresh=freshQuote(q,now),px=fresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
      if(!fresh||!(px>0))stale++;
      if(px>0)floating+=dir(t.side)*t.quantity*(px-t.entryPrice);
      continue;
    }
    if(t.exitControl?.policy==='needle-v1'||t.exitControl?.policy==='brain-v1'||t.exitControl?.policy==='score-v1'||t.exitControl?.policy==='read-v1'){
      const q=quotes[t.symbol],fresh=freshQuote(q,now),px=fresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
      if(!fresh||!(px>0))stale++;
      else floating+=dir(t.side)*t.quantity*(px-t.entryPrice);
      continue;
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
/** Same 0.1% as the live limit. A resting limit fills there only when this
 * minute actually traded through the stop, or the previous executable quote
 * was already inside that band. Otherwise the quote is the fill. */
function executableProtectionFill(side:"LONG"|"SHORT",stop:number,quote:number,prior:number,bar?:Candle){
  const d=dir(side);
  if(!(stop>0)||d*(quote-stop)>0)return quote;
  const limit=stop*(1-d*0.001);
  const extreme=bar?side==="LONG"?bar.low:bar.high:NaN;
  const barTraded=!!bar&&bar.open>0&&d*(bar.open-stop)>=0&&d*(extreme-stop)<=0;
  const tight=prior>0&&d*(prior-stop)>=0&&Math.abs(prior-stop)/stop<=0.0015;
  if(!barTraded&&!tight)return quote;
  return side==="LONG"?Math.max(quote,limit):Math.min(quote,limit);
}
function closeTrade(s:ForwardState,t:Trade,price:number,now:number,reason:string,evidence?:Record<string,string|number|boolean|null>,
  settle?:{gross:number;exitFee:number}){
  // 一笔单只能平一次：已经平过的（例如研究层刚平、还没从持仓里摘掉）再进任何出场都直接忽略，不能二次记账。
  if(t.status!=="OPEN")return;
  const gross=settle?settle.gross:dir(t.side)*t.quantity*(price-t.entryPrice),exitFee=settle?settle.exitFee:t.quantity*price*PAPER_COST.feeRate;
  const funding=t.notional*PAPER_COST.fundingAllowancePerDay*Math.max(0,now-t.openedAt)/86_400_000,
    net=gross-t.entryFee-exitFee-funding+realizedContribution(t),r=t.realization,remainingNotional=t.notional;
  t.status="CLOSED";t.closedAt=now;t.exitPrice=price;t.exitFee=exitFee+(r?.fees??0);t.fundingAllowance=funding+(r?.funding??0);t.grossPnl=gross+(r?.gross??0);t.netPnl=net;t.exitReason=reason;
  if(reason!=="ACCOUNT_RESET")t.exitRegime={stage:s.environmentContext.environment,phase:s.environmentContext.phase};
  t.exitAudit={trigger:reason,at:now,...(evidence?{evidence}:{})};t.lastQuoteAt=now;t.lastPrice=price;
  try{
    if(reason==="ACCOUNT_RESET")throw new Error("an administrative reset close is not a trade outcome");
    const notional=Math.max(t.notional,1e-9);
    s.signalTally=noteSignalOutcome(s.signalTally,{id:t.id,symbol:t.symbol,
      netPct:Number.isFinite(net)?net/notional*100:null,
      mfePct:Number.isFinite(t.favorable)?t.favorable*100:null,
      maePct:Number.isFinite(t.adverse)?t.adverse*100:null});
  }catch{/* 回写上一笔结果不能挡住平仓 */}
  if(t.unopened){restoreRealizationParent(t);return;}
  s.balance+=gross-exitFee-funding;s.grossPnl+=gross;s.fees+=exitFee;s.fundingAllowance+=funding;
  s.resolved++;if(net>0)s.wins++;s.turnover+=remainingNotional;s.lastExitAt[t.symbol]=now;
  if(r)restoreRealizationParent(t);
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
/** The trade's isolated liquidation price: fixed at open; older trades get it from their leverage and the contract's rate. */
export function tradeLiquidationPrice(t:Trade,contract?:Contract){
  if(typeof t.liquidationPrice==="number"&&Number.isFinite(t.liquidationPrice)&&t.liquidationPrice>0)return t.liquidationPrice;
  return isolatedLiquidationPrice({entry:t.entryPrice,leverage:t.leverage,side:t.side,maintenanceRate:t.maintenanceRate??contract?.maintenanceRate});
}
/**
 * 逐仓爆仓：价格已经越过强平价，而且止损没来得及成交（比如跳空），这一笔按爆仓平，亏掉这笔全部逐仓保证金
 * （开仓费和资金费照常另算，强平费从维持保证金里扣，不再另收平仓费）。价格只到止损、没到强平价时不碰，照常走原来的出场。
 */
export function liquidateIfHit(s:ForwardState,t:Trade,q:Quote,now:number,contract?:Contract,bar?:Candle){
  const liq=tradeLiquidationPrice(t,contract),px=t.side==="LONG"?q.bestBid:q.bestAsk;
  if(!liquidationHit(t.side,px,liq))return false;
  // 止损先到：这一分钟是从止损内侧一路打穿止损的（不是跳空），或上一口价已经贴着止损，止损单先成交，照常走止损。
  if(t.stopPrice>0&&executableProtectionFill(t.side,t.stopPrice,px,t.lastPrice,bar)!==px)return false;
  const leverage=Math.max(t.leverage||1,1),margin=t.notional/leverage,signed=dir(t.side)*(px/t.entryPrice-1);
  t.adverse=Math.max(t.adverse,Math.max(0,-signed));
  closeTrade(s,t,liq!,now,"LIQUIDATION",{authority:"ISOLATED_LIQUIDATION",liquidationPrice:liq!,observedPrice:px,leverage,
    maintenanceRate:maintenanceRateOf(t.maintenanceRate??contract?.maintenanceRate),margin,quoteAt:q.observedAt},{gross:-margin,exitFee:0});
  return true;
}

/** fixed-notional orders (gates "virtual"): the gates read the risk / margin the original formula would have opened, kept on the note */
export const gateRisk=(t:Trade)=>t.entryContext?.living?.szr??t.plannedRisk;
export type EntryRead={
  trendSide:"LONG"|"SHORT"|null;
  withTrend:boolean|null;
  book:number|null;
  residual:number|null;
  relativeStrength:number|null;
  move30:number|null;
  sync:number|null;
  breadth:number|null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Core position manager. The strategy system is gone: nothing here opens a trade. Positions that were opened before the
// removal are managed only by what is recorded on them: isolated liquidation, a saved protective floor, their stop, their
// recorded take-profit, and the old "1.5x planned hold" backstop for trades that carried a planned hold.
// ---------------------------------------------------------------------------------------------------------------------
function protectiveFloorHit(s:ForwardState,t:Trade,q:Quote,now:number,bar?:Candle){
  const g=t.livingGuard;if(!g)return false;
  const px=t.side==="LONG"?q.bestBid:q.bestAsk,d=dir(t.side);
  if(d*(px-g.stop)>0)return false;
  const fill=executableProtectionFill(t.side,g.stop,px,t.lastPrice,bar),signed=d*(px/t.entryPrice-1);
  t.favorable=Math.max(t.favorable,Math.max(0,signed));t.adverse=Math.max(t.adverse,Math.max(0,-signed));
  closeTrade(s,t,fill,now,"LIVING_GUARD_STOP",{authority:"SAVED_PROTECTION",guardCode:g.code,guardStop:g.stop,guardAt:g.at,quote:px,quoteAt:q.observedAt});
  return true;
}
/** Backstop for a trade that carried a planned hold: closed at 1.5x that hold (nothing drives exits any more, so no grace is waited for). */
export const HOLD_BACKSTOP_MULTIPLE=1.5;
/** Mark one open position, then close it if its own stop / take-profit / hold backstop says so. Returns true when it closed. */
function manageOpenTrade(s:ForwardState,t:Trade,q:Quote,now:number,bar:Candle|undefined){
  const px=t.side==="LONG"?q.bestBid:q.bestAsk,d=dir(t.side),signed=d*(px/t.entryPrice-1),prior=t.lastPrice;
  t.lastPrice=px;t.lastQuoteAt=q.observedAt;t.favorable=Math.max(t.favorable,Math.max(0,signed));t.adverse=Math.max(t.adverse,Math.max(0,-signed));
  t.peakPnlRate=Math.max(t.peakPnlRate??0,t.favorable);
  if(!t.firstProfitAt&&signed>ROUND_TRIP_COST)t.firstProfitAt=now;
  if(t.stopPrice>0&&d*(px-t.stopPrice)<=0){
    closeTrade(s,t,executableProtectionFill(t.side,t.stopPrice,px,prior,bar),now,t.entryContext?.living?"LIVING_STOP":"STRUCTURE_STOP",
      {authority:"PRICE_STOP",stopPrice:t.stopPrice,quote:px,quoteAt:q.observedAt});
    return true;
  }
  const living=t.entryContext?.living,target=living?.tg;
  if(typeof target==="number"&&Number.isFinite(target)&&target>0&&d*(px-target)>=0){
    closeTrade(s,t,px,now,"TAKE_PROFIT",{authority:"RECORDED_TARGET",target,quote:px,quoteAt:q.observedAt});
    return true;
  }
  // daily-breakout style trades never had a time exit: only their stop (and liquidation) closes them
  if(!living||living.hx===1)return false;
  const hold=living.hold,holdMin=typeof hold==="number"&&hold>0?hold:30;
  if(now-t.openedAt>=HOLD_BACKSTOP_MULTIPLE*holdMin*60_000){
    closeTrade(s,t,px,now,"LIVING_FALLBACK_TIMEOUT",{authority:"HOLD_BACKSTOP",holdMin,ageMin:Math.round((now-t.openedAt)/60_000),quoteAt:q.observedAt});
    return true;
  }
  return false;
}
/** Every open position of this account except inverse copies (which only follow a frozen source and were never managed here). */
function manageOpenTrades(s:ForwardState,quotes:Record<string,Quote>,now:number,minutePaths:Record<string,Candle[]>|undefined,contracts:Record<string,Contract>|undefined){
  for(const t of [...s.positions]){
    if(t.inverseCopy||t.status!=="OPEN")continue;
    const q=quotes[t.symbol];if(!freshQuote(q,now))continue;
    const bar=minutePaths?.[t.symbol]?.at(-1);
    // isolated liquidation first: a price already past the liquidation price cannot fill at the stop any more
    if(liquidateIfHit(s,t,q!,now,contracts?.[t.symbol],bar))continue;
    if(protectiveFloorHit(s,t,q!,now,bar))continue;
    manageOpenTrade(s,t,q!,now,bar);
  }
}
const CORE_REASON="策略系统已移除：不再自动开仓。已有持仓只按各自的止损、强平保护和止盈管理到平仓。";
/** One 2s tick of the paper account: manage open positions, run a pending funds reset, mark equity. No entries, no analysis. */
export function advanceForward(input:{state:ForwardState;now:number;quotes:Record<string,Quote>;contracts?:Record<string,Contract>;
  minutePaths?:Record<string,Candle[]>}){
  const s=normalizeForward(structuredClone(input.state),input.now),
    snapshot=()=>JSON.stringify({p:s.positions.map(t=>[t.id,t.status,t.stopPrice,t.profitFloorRate,t.contracts,t.realization?.sequence]),h:s.history.length,b:s.balance,r:s.revision});
  const before=snapshot();
  s.lastQuoteCycleAt=input.now;
  // A closed order that is still in the open list (restored old state) is dropped; it is already in the history.
  if(s.positions.some(t=>t.status!=="OPEN")){
    // never lose an order: a closed one that somehow is not in the history yet is kept there.
    const known=new Set(s.history.map(t=>t.id));
    for(const t of s.positions)if(t.status!=="OPEN"&&!known.has(t.id)&&t.closedAt!=null)s.history.unshift(t);
    s.positions=s.positions.filter(t=>t.status==="OPEN");
  }
  manageOpenTrades(s,input.quotes,input.now,input.minutePaths,input.contracts);
  // closeTrade only books the exit; take the closed orders out of the open list here (they are already in history).
  if(s.positions.some(t=>t.status!=="OPEN"))s.positions=s.positions.filter(t=>t.status==="OPEN");
  // A pending funds reset runs at the first moment with no open position.
  if(s.pendingFundsReset&&!s.positions.length)applyFundsReset(s,input.now);
  const mark=equityMark(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(s.peakEquity,1));updateDaily(s,input.now,mark.equity);
  s.opportunities=[];
  s.latestReason=CORE_REASON;
  const result={state:s,changed:before!==snapshot(),protectionChanged:input.state.positions.some(t=>s.positions.find(n=>n.id===t.id)?.stopPrice!==t.stopPrice)};
  return result;
}
export const ACCOUNT_RESET_LIMIT=200;
/** Money only. startedAt (the log epoch), history, not-opened rows, stage timeline, tallies, learning, cooldowns,
 * opportunities and the inverse book stay, so every run-log store keyed on startedAt keeps going. Needs a flat account. */
export function applyFundsReset(s:ForwardState,now:number){
  if(s.positions.length)throw new Error("还有持仓，资金重置只能在没有持仓时执行");
  const prior=s.accountResets??[],r4=(v:number)=>Number(v.toFixed(4));
  const marker:AccountReset={at:now,requestedAt:s.pendingFundsReset?.requestedAt??now,epoch:prior.length+1,
    equityBefore:r4(s.balance),balanceBefore:r4(s.balance),balanceAfter:s.initialEquity};
  s.balance=s.initialEquity;s.peakEquity=s.initialEquity;s.maxDrawdown=0;s.resolved=0;s.wins=0;s.grossPnl=0;s.fees=0;
  s.fundingAllowance=0;s.turnover=0;s.daily=[];
  s.accountResets=[...prior,marker].slice(-ACCOUNT_RESET_LIMIT);s.pendingFundsReset=null;
  event(s,now,"START","ACCOUNT",`资金重置：${marker.balanceBefore.toFixed(2)}U → ${marker.balanceAfter}U；运行日志、价格路径、阶段时间线和导出进度都保留。`);
  return marker;
}
/** One-time, owner-authorised reset when the strategy system is removed (2026-10-28). Idempotent: the marker lives inside the
 * same persisted state as the reset itself, so a DO restart can neither lose nor repeat it. Paper state only; no Gate call. */
export const STRIP_CORE_RESET_KIND="STRIP_CORE_ONE_TIME_V1";
export function stripCoreResetDone(s:Pick<ForwardState,"accountResets">){return !!s.accountResets?.some(r=>r.kind===STRIP_CORE_RESET_KIND);}
export function applyStripCoreReset(input:ForwardState,quotes:Record<string,Quote>,now:number){
  if(stripCoreResetDone(input))return{state:input,done:false,snapshot:null as StripResetSnapshot|null};
  const s=normalizeForward(structuredClone(input),now),r4=(v:number)=>Number(v.toFixed(4));
  const before=s.positions.map(t=>({...t}));
  const balanceBeforeClose=r4(s.balance),statsBefore={fees:s.fees,grossPnl:s.grossPnl,resolved:s.resolved,wins:s.wins,turnover:s.turnover,maxDrawdown:s.maxDrawdown};
  const dailyBefore=structuredClone(s.daily).slice(-200);
  // Every old paper position is booked closed into the history (exit reason ACCOUNT_RESET) at the last fresh quote, else its last price.
  for(const t of s.positions){
    const q=quotes[t.symbol],px=freshQuote(q,now)?(t.side==="LONG"?q!.bestBid:q!.bestAsk):t.lastPrice;
    closeTrade(s,t,px,now,"ACCOUNT_RESET");
  }
  const closedById=new Map(s.positions.map(t=>[t.id,t]));
  s.positions=[];
  s.pendingFundsReset=null;
  const balanceAfterClose=r4(s.balance);
  event(s,now,"START","ACCOUNT",`一次性重置（策略系统已移除，用户授权）：清除 ${before.length} 笔旧纸面持仓，余额 ${balanceBeforeClose.toFixed(2)}U→平仓后 ${balanceAfterClose.toFixed(2)}U→重置为 ${s.initialEquity}U；订单历史、资金曲线、运行日志全部保留，重置前快照见导出的 accountResets。`);
  const marker=applyFundsReset(s,now);
  const snapshot:StripResetSnapshot={reason:"strategy system removed; owner-authorised one-time paper reset",at:now,balanceBeforeClose,balanceAfterClose,
    realizedFromClose:r4(balanceAfterClose-balanceBeforeClose),...statsBefore,initialEquity:s.initialEquity,
    positions:before.map(t=>({id:t.id,symbol:t.symbol,side:t.side,openedAt:t.openedAt,entryPrice:t.entryPrice,exitPrice:closedById.get(t.id)?.exitPrice??null,
      quantity:t.quantity,notional:t.notional,margin:t.margin,leverage:t.leverage,stopPrice:t.stopPrice,lastPrice:t.lastPrice,inverseCopy:!!t.inverseCopy,
      netPnlOnClose:closedById.get(t.id)?.netPnl??null})),
    daily:dailyBefore,historyCount:s.history.length,unopenedCount:s.unopenedTrades?.length??0};
  marker.kind=STRIP_CORE_RESET_KIND;marker.snapshot=snapshot;
  return{state:s,done:true,snapshot};
}
/** Where the page's account starts: the last funds reset, else the log epoch. */
export function pageStartedAt(s:Pick<ForwardState,"startedAt"|"accountResets">){return s.accountResets?.at(-1)?.at??s.startedAt;}
/** Saved fields of the removed strategy system. The core never reads or writes them; they are carried verbatim so nothing stored is lost. */
const RETIRED_STATE_KEYS=["extremumRegime","relationEngine","familyExperiment","hypothesisResearch","environmentPerformance","environmentContext",
  "shockEpisode","stageChronicle","signalTally"] as const;
export function closeForwardForReset(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const s=normalizeForward(structuredClone(state),now);
  for(const t of [...s.positions]){const q=quotes[t.symbol],px=freshQuote(q,now)?(t.side==="LONG"?q!.bestBid:q!.bestAsk):t.lastPrice;closeTrade(s,t,px,now,"ACCOUNT_RESET");}
  s.positions=[];return s;
}
/** Paper wallet/ledger back to the starting funds. Everything this version no longer reads (the retired strategy's saved
 * analysis state) is carried over untouched, so a reset never deletes stored data. */
export function resetForwardAccountPreservingLearning(previous:ForwardState,now:number){
  const prior=normalizeForward(structuredClone(previous),now),next=initialForward(now);
  next.marketPulse=structuredClone(prior.marketPulse);
  next.selectedSymbols=[...prior.selectedSymbols];
  next.lastCandleAt=prior.lastCandleAt;
  next.lastCycleAt=prior.lastCycleAt;
  next.lastQuoteCycleAt=prior.lastQuoteCycleAt;
  next.fitDiagnostics=structuredClone(prior.fitDiagnostics);
  next.lastEntryAt={...prior.lastEntryAt};
  next.lastExitAt={...prior.lastExitAt};
  next.lastSide={...prior.lastSide};
  next.consumedTheses={...prior.consumedTheses};
  for(const key of RETIRED_STATE_KEYS)(next as Record<string,unknown>)[key]=structuredClone((prior as Record<string,unknown>)[key]);
  next.signalTallyMeta=prior.signalTallyMeta?{...prior.signalTallyMeta}:{backfilled:false,from:null};
  next.observations=prior.observations;next.measured=prior.measured;next.invalidated=prior.invalidated;
  next.latestReason="模拟账户资金已重置为1000U；策略系统已移除，只保留核心交易与风控。";
  return next;
}
export function forwardUrgentQuoteSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  void now;void entrySymbols;
  return[...new Set(s.positions.map(t=>t.symbol))];
}
/** Symbols whose Gate book must keep the every-loop REST fallback (marks, stops, liquidation): the open positions. */
export function forwardRestCriticalSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  void now;void entrySymbols;
  return[...new Set(s.positions.map(t=>t.symbol))];
}
export function forwardUrgentMinuteSymbols(s:ForwardState,entrySymbols?:Iterable<string>){
  const allowed=entrySymbols?new Set(entrySymbols):undefined,keep=(x:string)=>!allowed||allowed.has(x);
  return[...new Set(s.positions.map(t=>t.symbol))].filter(keep).slice(0,FORWARD_MINUTE_CONFIRMATION_CAP);
}
export function forwardWatchSymbols(s:ForwardState,now:number,entrySymbols?:Iterable<string>){
  return forwardUrgentQuoteSymbols(s,now,entrySymbols).slice(0,FORWARD_EXECUTION_BBO_CAP);
}
export function forwardSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const mark=equityMark(s,quotes,now);
  return{version:s.version,engineVersion:ADAPTIVE_ENGINE_VERSION,mode:"REAL_FEED_PAPER",liveEligible:false,
    startedAt:s.startedAt,cutoverAt:s.cutoverAt,updatedAt:s.lastQuoteCycleAt,
    lastCycleAt:s.lastCycleAt,revision:s.revision,initialEquity:s.initialEquity,balance:s.balance,...mark,targetEquity:s.initialEquity*2,
    netPnl:mark.equity-s.initialEquity,maxDrawdown:s.maxDrawdown,resolved:s.resolved,wins:s.wins,grossPnl:s.grossPnl,fees:s.fees,
    fundingAllowance:s.fundingAllowance,turnover:s.turnover,accountResets:s.accountResets??[],pendingFundsReset:s.pendingFundsReset??null,
    pageStartedAt:pageStartedAt(s),positions:s.positions,
    // The page's order records restart at a funds reset; the account keeps them (run log, archive, journal).
    history:s.accountResets?.length?s.history.filter(t=>t.openedAt>=pageStartedAt(s)):s.history,events:s.events,daily:s.daily,
    latestReason:s.latestReason,storage:s.storage,seatCount:s.positions.length,
    boundaries:{scope:"PAPER_AUTHORITY",
      accounting:"模拟使用新鲜买卖价并计入手续费、滑点和资金费占位。",
      liquidation:"策略系统已移除：不再自动开仓。已有持仓只按各自的止损、强平保护和止盈管理到平仓。"},
    cost:PAPER_COST};
}
