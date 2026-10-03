import {rangeExecutionAdmission,validRangeHolding} from './anomaly-range.ts';
/** Single source contract for owner-enabled execution.
 * Pure: this module has no credentials, network requests, or authority to switch LIVE.
 * Order identity/strategy/lifecycle come from the persisted current PAPER account.
 * Gate execution facts are recorded separately; they are never copied from a model.
 */
import type { ArenaTrade } from "./strategy-arena.ts";
import { type ForwardState, type Trade, PAPER_COST } from "./forward-relations.ts";
import { LiveEntrySizingError, liveEntryTag, type LiveEntryIntent } from "./gate-live.ts";
import { quantizeMirrorNotional, type GateSizeRules, type SizeDiagnostic } from "./gate-quantity.ts";
import { LIVE_SESSION_VERSION, sourceAfterEnable, type LiveSession } from "./live-session.ts";
import { PORTFOLIO_RISK_CAP, CORRELATED_DIRECTION_RISK_CAP } from "./liquidity-core.ts";
import {liveProtectionPrice,INVERSE_LIVE_POLICY,INVERSE_LIVE_EXIT_POLICY,isInverseLiveReceipt,INVERSE_LIVE_LEVERAGE_POLICY,inverseLiveLeverage} from './live-source-policy.ts';
import {paperSourceTrade} from './paper-execution.ts';
import {responseEntryExecutable} from './event-response.ts';

export const LIVE_PARITY_VERSION = "current-paper-live-parity-v1";
export const LIVE_PARITY_SOURCE = "CURRENT_FORWARD_ACCOUNT";
export const LIVE_PARITY_PREFIX = "live-parity:v1:";
export const LIVE_ENTRY_DRIFT_POLICY = "source-entry-drift-v1";
export const LIVE_MIN_CONTRACT_UPLIFT_MAX_RISK_RATE = .0075;
const LIVE_MIN_CONTRACT_UPLIFT_RISK_MULTIPLE=4,LIVE_MIN_CONTRACT_UPLIFT_RISK_FLOOR_RATE=.004;
export type MirrorSourceTrade = ArenaTrade & { forwardSource?: Trade };
export type MirrorReceipt = {
  marketAuthorityVersion?:string;
  executionLeverage?:number;leveragePolicy?:typeof INVERSE_LIVE_LEVERAGE_POLICY|'actual-intent-isolated-v1';
  leverageAdjustAt?:number;leverageAdjustError?:string|null;
  version: typeof LIVE_PARITY_VERSION; sourceId: string; sourceRuleId: string;
  sourcePolicy: string; sourceOpenedAt: number; sourceDeadline: number;
  sourceEntryPrice: number; sourceStopPrice: number; sourceArmPrice: number;
  sourceExitMode: Trade["rule"]["exitMode"]; sourceGivebackRate: number;
  sourceExitPlanVersion?: string; sourceBestHoldMinutes?: number; sourceMaxHoldMinutes?: number;
  sourceContractsAtCopy?:number;
  sourceNotional: number; sourceMargin: number; sourceLeverage: number;
  copiedAt: number; sourceEquity: number; liveEquity: number; ratio: number;
  targetNotional: number; targetMargin: number; requestedContracts: number;
  roundedContracts: number; roundingNotional: number; filledContracts?: number;
  sourceClosedAt?: number | null; sourceExitReason?: string | null;
  actualExitOrderId?: string | null; actualExitPriceVerified?: boolean;
  discrepancy?: string | null;
  quantityText?: string; minimumContracts?: number; quantityQuantum?: string;
  supportsDecimalContracts?: boolean; minimumUplift?: boolean; minimumUpliftRiskRate?: number; activationAt?: number;
  entryDriftPolicy?: typeof LIVE_ENTRY_DRIFT_POLICY;
  sourceQuoteAt?: number; copyQuoteAt?: number; copyQuotePrice?: number; copyDelayMs?: number;
  allowedAdverseEntryDriftRate?: number; adverseEntryDriftRate?: number;
  submitQuoteAt?: number; submitQuotePrice?: number; submittedAt?: number; submitDelayMs?: number;
  exchangeEntryPrice?: number; exchangeEntryAt?: number; exchangeEntryDriftRate?: number;
  sourceRole?: 'INVERSE_PAPER'|'UNIFIED_PAPER';unifiedBranch?:'RETURN'|'CONTINUATION'; nativeProtectionPolicy?:typeof INVERSE_LIVE_POLICY|typeof INVERSE_LIVE_EXIT_POLICY;
  nativeProtectionPrice?:number|null; shadowSourceId?:string;
  sourceAllocationRiskRate?:number; exitPolicy?:typeof INVERSE_LIVE_EXIT_POLICY;
  fixedAllocationPolicy?:'fixed-1000-v1';fixedLiveEquity?:number;
  retiredProtectionTags?:string[]; protectionRemovedAt?:number;
  entryPricePolicy?:'favorable-ioc-v1'|'fresh-market-v1'; entryLimitPrice?:number;
  exitExecutionPolicy?:'priority-bounded-exit-v1';sourceExitPrice?:number|null;exitObservedAt?:number;
  exitSubmittedAt?:number;exitDelayMs?:number;exitLimitPrice?:number|null;
};
export type MirrorBinding = { version: typeof LIVE_PARITY_VERSION; sourceAtCopy: Trade;
  receipt: MirrorReceipt; sourceAtClose?: Trade; actual?: unknown };

function positive(v: number) { return Number.isFinite(v) && v > 0; }
const sourceHoldMinutes=(t:Trade)=>Math.max(5,t.exitPlan?.maxHoldMinutes??t.expectedHoldMinutes??t.rule.horizon);
export function validateMirrorSource(t: Trade) {
  if (!t || !t.id || !t.symbol || !["LONG", "SHORT"].includes(t.side)
    || t.status !== "OPEN" || !t.rule?.id || !positive(t.openedAt)
    || ![t.entryPrice,t.stopPrice,t.armPrice,t.notional,t.margin,t.quantity,t.quantoMultiplier,t.leverage,t.rule.horizon].every(positive)
    || !positive(t.contracts) || t.contracts > Number.MAX_SAFE_INTEGER
    || Math.abs(t.notional-t.quantity*t.entryPrice) > Math.max(1,t.notional)*1e-7
    || Math.abs(t.quantity-t.contracts*t.quantoMultiplier) > Math.max(1,t.quantity)*1e-7
    || Math.abs(t.margin*t.leverage-t.notional) > Math.max(1,t.notional)*1e-7)
    throw new Error("模拟复制源不完整；拒绝用旧版、重算策略或重置账户代替");
}

/** Adapter fields only support the existing reconciler. Full source JSON is
 * retained in a binding. The arm price is NOT a take-profit command. */
export function forwardMirrorSources(state: ForwardState, sourceEquity: number): Record<string, MirrorSourceTrade> {
  if (!state || !Array.isArray(state.positions) || !Array.isArray(state.history) || !positive(sourceEquity))
    throw new Error("当前模拟账户不可用，实盘复制等待恢复，不回退到旧策略");
  const out: Record<string, MirrorSourceTrade> = {};
  for (const row of state.positions) {
    const t=paperSourceTrade(row);if(t.status!=='OPEN')continue;
    // The current visible inverse account is the NEW source. Existing legacy
    // LIVE positions still use sourceLifecycle; drain rows cannot add exposure.
    if(state.inverseTrial&&!t.inverseCopy&&!t.unified)continue;
    validateMirrorSource(t);
    const protection=liveProtectionPrice(t);
    if (out[t.symbol]) throw new Error(`${t.symbol} 出现多条逻辑持仓；禁止静默净额合并，须先升级逐腿执行适配器`);
    const cost = 2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+PAPER_COST.fundingAllowancePerDay*sourceHoldMinutes(t)/1440,
      mode=t.entryContext?.mode,swing=mode==="SWING",impulse=mode==="IMPULSE",
      family=swing?"REVERSAL" as const:"TREND" as const,
      channel=swing?"RANGE" as const:"TREND" as const,
      regime=swing?"RANGE" as const:impulse?"EXPANSION" as const:"TREND" as const,
      survival=t.side==="LONG"?t.entryContext?.upSurvival:t.entryContext?.downSurvival;
    out[t.symbol] = {
      id:t.id, strategyId:t.rule.id,
      strategyName:t.entryContext?.strategyVersion?`峰谷状态 · ${mode??"TRADE"}`:`兼容策略 ${t.rule.id} v${t.rule.version}`,
      family, lane:"PORTFOLIO", eventId:t.id, symbol:t.symbol, side:t.side,
      status:t.status, openedAt:t.openedAt, closedAt:null, entryPrice:t.entryPrice,
      stopPrice:protection??t.stopPrice, activeStopPrice:protection??t.stopPrice, targetPrice:t.armPrice,
      exitPrice:null, outcome:null, grossReturnRate:null, netReturnRate:null, netPnl:null,
      notional:t.notional, maxFavorableRate:t.favorable, maxAdverseRate:t.adverse,
      lastPrice:t.lastPrice, selectedForPortfolio:true, reason:t.rule.reason,
      admissionTier:null, plannedRisk:t.plannedRisk, contracts:t.contracts,
      quantoMultiplier:t.quantoMultiplier, leverage:t.leverage, margin:t.margin,
      accountEquityAtOpen:sourceEquity, forwardSource:structuredClone(t),
      context:{channel,regime,anomalyKind:null,entryStyle:mode==="TREND_PULLBACK"?"RETEST":"CONFIRM",exitProfile:"STRUCTURE",
        candidateScore:t.entryContext?.entryScore??0,trendRate:(survival??0)/100,trendEfficiency:(t.entryContext?.directionStrength??0)/100,
        volatilityRatio:0,rangePosition:0,openInterestChangeRate:0,volume24hUsd:0,fundingRate:0,alignedFlow:0,
        confirmation:t.entryContext?.confirmationStage==="READY"||t.entryContext?.confirmationStage==="IMPULSE"?1:0,
        fakeoutRisk:Math.min(1,Math.max(0,(t.entryContext?.disagreementRate??0)/.015)),rangeId:null,modeledCostRate:cost,
        spreadRate:0,bidDepthUsd:0,askDepthUsd:0,structureSource:impulse?"IMPULSE":"CANDLE_5M",
        grossRewardRate:Math.max(0,t.forecast?.remainingNetRate??0),structuralStopRate:t.rule.stopRate,
        netRewardRisk:(t.forecast?.remainingNetRate??0)/Math.max(t.rule.stopRate,1e-9),costShare:0,
        empiricalExpectedReturnRate:0,empiricalProfitFactor:0,empiricalEvents:0,
        profitArmIsNotExit:true,maxHoldMs:sourceHoldMinutes(t)*60_000},
    };
  }
  return out;
}

export function sourceLifecycle(state: ForwardState | null, id: string) {
  const open = state?.positions.find(t=>t.id===id);
  if (open){const trade=paperSourceTrade(open);return{status:trade.status,trade};}
  const closed=state?.history.find(t=>t.id===id&&t.status==="CLOSED")??state?.paperExecution?.cancelled.find(t=>t.id===id);
  return closed ? { status:"CLOSED" as const, trade:closed } : { status:"UNKNOWN" as const, trade:null };
}

export function mirrorSourceFresh(t: Trade | undefined, id: string, now: number) {
  return !!t && t.id===id && t.status==="OPEN" && now>=t.openedAt
    && (!!t.inverseCopy||!!t.unified||now<t.openedAt+sourceHoldMinutes(t)*60_000);
}

export function liveEntryDriftGuard(source:Trade,currentPrice:number) {
  const direction=source.side==="LONG"?1:-1;
  const adverse=Math.max(0,direction*(currentPrice/source.entryPrice-1));
  const protection=liveProtectionPrice(source);
  const stopWidth=protection==null?source.rule.stopRate:Math.abs(source.entryPrice-protection)/source.entryPrice;
  const stopBound=Math.max(.0015,Math.min(.005,stopWidth*.25));
  const remaining=Math.max(0,source.forecast?.remainingNetRate??0);
  const edgeBound=remaining>0?Math.max(.0015,Math.min(.005,remaining*.5)):.005;
  const allowed=Math.min(stopBound,edgeBound);
  return {policy:LIVE_ENTRY_DRIFT_POLICY,adverse,
    allowed:source.inverseCopy?0:source.unified?1:allowed,stopWidth,remaining};
}

/** Remaining quantity is reconciled from Gate before entry admission. A close
 * request is not a fill: every still-OPEN holding retains this risk. Recompute
 * the entry-risk floor from the actual remaining quantity, rather than using a
 * stale full-size plannedRisk after a partial fill/reduction. Profit cannot
 * hide the mark-to-stop exposure and an unrealised loss cannot free the floor.
 * NaN deliberately propagates to the existing account-input validation so an
 * unknown exposure blocks only additions, never protection or owner intent. */
export function mirrorPositionRisk(position:{status:string;side:"LONG"|"SHORT";entryPrice:number;
  currentStop:number;notional:number;plannedRisk?:number;
  parity?:Pick<MirrorReceipt,"sourceOpenedAt"|"sourceDeadline"|"sourceRole"|"unifiedBranch"|"sourceAllocationRiskRate"|"marketAuthorityVersion">},markPrice=position.entryPrice) {
  if(position.status!=="OPEN")return 0;
  const horizonMs=position.parity ? position.parity.sourceDeadline-position.parity.sourceOpenedAt : NaN;
  if(isInverseLiveReceipt(position.parity)){
    if(![position.entryPrice,position.notional,markPrice,horizonMs].every(positive))return NaN;
    const allocation=position.parity?.sourceAllocationRiskRate!=null
      ?position.notional*position.parity.sourceAllocationRiskRate:position.plannedRisk??NaN;
    const direction=position.side==='LONG'?1:-1,cost=position.notional*(2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)
      +PAPER_COST.fundingAllowancePerDay*horizonMs/86_400_000);
    // Admission charge only, NOT a maximum possible loss or an exit boundary.
    return Math.max(allocation,position.notional*Math.max(0,direction*(1-markPrice/position.entryPrice))+cost);
  }
  if(![position.entryPrice,position.currentStop,position.notional,markPrice,horizonMs].every(positive))return NaN;
  const quantity=position.notional/position.entryPrice,direction=position.side==="LONG"?1:-1;
  const cost=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+PAPER_COST.fundingAllowancePerDay*horizonMs/86_400_000;
  const entryRisk=quantity*Math.max(0,direction*(position.entryPrice-position.currentStop))+position.notional*cost;
  const markedRisk=quantity*Math.max(0,direction*(markPrice-position.currentStop))+quantity*markPrice*cost;
  return Math.max(entryRisk,markedRisk);
}

export function buildProportionalMirror(input:{source:Trade;sourceEquity:number;equity:number;available:number;
  entryPrice:number;quantoMultiplier:number;leverageMax:number;maintenanceRate:number;openRisk:number;
  sameDirectionRisk:number;openMargin:number;openNotional:number;now:number;policy:string;
  sizeRules?: GateSizeRules; activationAt?: number; mirrorRatio?: number; sourceRiskAuthority?: boolean;
  quoteObservedAt?: number}): {intent:LiveEntryIntent;binding:MirrorBinding} {
  const t=input.source;validateMirrorSource(t);
  const fail=(code:"MIN_CONTRACT"|"CONTRACT_SPEC"|"MARGIN"|"RISK_CAP"|"ECONOMICS",message:string,sizing?:SizeDiagnostic):never=>{
    throw new LiveEntrySizingError(code,t.symbol,`${t.symbol} ${message}；源单 ${t.id} 未完成复制，不冒充已成交`,sizing);
  };
  if (!mirrorSourceFresh(t,t.id,input.now))fail("ECONOMICS","源单已结束或期限已到，不补过期订单");
  if(t.inverseCopy&&!positive(t.plannedRisk))fail("ECONOMICS","源单资金分配风险不完整");
  // Infrastructure delay is not an economic invalidation. The current source
  // must still be OPEN/in-horizon, and the current Gate price still has to pass
  // stop, drift, sizing, margin and risk checks below.
  if (![input.sourceEquity,input.equity,input.entryPrice,input.quantoMultiplier,input.leverageMax].every(positive)
    || ![input.available,input.openRisk,input.sameDirectionRisk,input.openMargin,input.openNotional,input.maintenanceRate].every(v=>Number.isFinite(v)&&v>=0))
    fail("ECONOMICS","实时账户/合约规格不完整");
  if (Math.abs(input.quantoMultiplier-t.quantoMultiplier)>t.quantoMultiplier*1e-9)fail("ECONOMICS","合约乘数与源单不一致");
  const leverage=t.inverseCopy?inverseLiveLeverage(t.leverage):t.leverage;
  if(leverage<1||leverage>input.leverageMax)fail("MARGIN","交易所不支持请求的实盘杠杆，不静默改变仓位或保证金");
  const direction=t.side==="LONG"?1:-1;
  const protection=liveProtectionPrice(t);
  if (protection!=null&&direction*(input.entryPrice-protection)<=0)fail("ECONOMICS","当前价已越过源单止损，不开即平");
  if(t.unified?.marketRoute?.controllerVersion==='anomaly-range-v1'){
    if(!t.unified.anomaly||!validRangeHolding(t.unified.anomaly))fail('ECONOMICS','原始区间计划证据不完整');
    const reason=rangeExecutionAdmission(t,{bestBid:input.entryPrice,bestAsk:input.entryPrice,observedAt:input.quoteObservedAt??input.now,fresh:true},input.now,true);
    if(reason)fail('ECONOMICS',reason);
  }
  if(t.unified?.marketRoute?.controllerVersion==='anomaly-range-v1'&&t.unified.anomaly?.kind==='EDGE_BREAKOUT'){
    // Observed outward proof has no promised price target. All stop/lot/margin/
    // native risk checks below remain common to PAPER and LIVE.
  }else if(t.unified?.marketRoute?.controllerVersion==='event-response-v1'){
    if(!responseEntryExecutable(t,input.entryPrice,input.now))fail('ECONOMICS','真实成交价未保留事件价格优势或已超过启动时效');
  }else if(t.unified?.branch==='CONTINUATION'||t.unified?.marketRoute){
    const target=t.unified?.marketRoute?.target??t.entryContext?.winnerPlan?.target,risk=direction*(input.entryPrice-protection!)+(input.entryPrice+protection!)*.0005,
      remaining=target==null?0:direction*(target-input.entryPrice)-(input.entryPrice+target)*.0005;
    if(target==null||risk<=0||remaining/risk<1.35)fail('ECONOMICS','实盘当前成交价到冻结目标或有限估计的扣费空间不足以覆盖新结构风险，不把延迟复制当作原成交');
  }
  const drift=liveEntryDriftGuard(t,input.entryPrice);
  if(!t.inverseCopy&&!t.unified&&drift.adverse>drift.allowed+1e-9)fail("ECONOMICS",
    `当前实盘盘口相对模拟入场出现不利偏差${(drift.adverse*100).toFixed(3)}%，超过动态上限${(drift.allowed*100).toFixed(3)}%，不追价`);
  const ratio=input.mirrorRatio&&positive(input.mirrorRatio)?input.mirrorRatio:input.equity/input.sourceEquity;
  const mirrorEquity=input.sourceEquity*ratio,targetNotional=t.unified?t.quantity*input.entryPrice*ratio:t.notional*ratio,
    targetMargin=t.inverseCopy||t.unified?targetNotional/leverage:t.margin*ratio;
  const one=input.entryPrice*input.quantoMultiplier,requestedContracts=targetNotional/one,
    cost=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+PAPER_COST.fundingAllowancePerDay*sourceHoldMinutes(t)/1440,
    sourceScaledRisk=t.plannedRisk*ratio,stopAndCost=protection==null?t.plannedRisk/t.notional
      :Math.abs(input.entryPrice-protection)/input.entryPrice+cost;
  let sized: ReturnType<typeof quantizeMirrorNotional>;
  try { sized=quantizeMirrorNotional(targetNotional,input.entryPrice,input.quantoMultiplier,input.sizeRules??{}); }
  catch(error){return fail("CONTRACT_SPEC",error instanceof Error?error.message:"数量规格无效");}
  let contracts=sized.quantity,quantityText=sized.quantityText,minimumUplift=false,minimumUpliftRiskRate=0;
  if (!(contracts>0)){
    const diagnostic={targetContracts:requestedContracts,minimumContracts:sized.minimum,quantityQuantum:sized.quantum,
      supportsDecimals:sized.supportsDecimals,targetNotional,minimumNotional:sized.minimumNotional,
      minimumMargin:sized.minimumNotional/leverage,requiredLiveEquity:input.sourceEquity*sized.minimumNotional/t.notional};
    const minimumRisk=sized.minimumNotional*stopAndCost,
      riskCeiling=Math.min(input.equity*LIVE_MIN_CONTRACT_UPLIFT_MAX_RISK_RATE,
        Math.max(sourceScaledRisk*LIVE_MIN_CONTRACT_UPLIFT_RISK_MULTIPLE,input.equity*LIVE_MIN_CONTRACT_UPLIFT_RISK_FLOOR_RATE));
    if(diagnostic.minimumMargin>input.available+1e-8||minimumRisk>riskCeiling+1e-8)
      fail("MIN_CONTRACT",`按比例低于真实最小数量；最低一张需要${diagnostic.minimumNotional.toFixed(4)}U名义价值、计划风险${(minimumRisk/input.equity*100).toFixed(2)}%，超出小账户最小张风险边界`,diagnostic);
    contracts=sized.minimum;quantityText=sized.quantum;minimumUplift=true;minimumUpliftRiskRate=minimumRisk/input.equity;
  }
  const notional=contracts*one,margin=notional/leverage,plannedRisk=notional*stopAndCost;
  // Gate is the execution authority for actual fees and available margin. Do not
  // double-reserve PAPER's model fee and turn a valid source order into a skip.
  if (margin>input.available+1e-8)fail("MARGIN","可用保证金不足，保留比例，不静默缩单");
  // Source authority freezes proportional size and rules, not Gate exposure.
  // Existing live positions (including requested-but-unconfirmed exits) and
  // unresolved reservations must still consume actual-equity risk capacity.
  // Do not use the frozen mirror equity here: fees, partial fills and delayed
  // source exits can make the actual account diverge from its PAPER source.
  if (input.openRisk+plannedRisk>input.equity*PORTFOLIO_RISK_CAP+1e-8
    || input.sameDirectionRisk+plannedRisk>input.equity*CORRELATED_DIRECTION_RISK_CAP+1e-8)
    fail("RISK_CAP","按实际权益与未平仓/未决暴露计算已超过原账户风险预算；不缩单、不改杠杆，等待风险释放");
  if(!input.sourceRiskAuthority){
    if (input.openMargin+margin>mirrorEquity*.75+1e-8)fail("MARGIN","累计保证金超出模拟同口径75%预算");
    if (input.openNotional+notional>mirrorEquity*4+1e-8)fail("RISK_CAP","按实际成交价计算已超过原账户风险预算");
  } else if (!minimumUplift&&plannedRisk>sourceScaledRisk*1.25+mirrorEquity*.001) {
    fail("ECONOMICS","实盘成交价偏离使单笔风险明显高于模拟比例，等待下一笔新源单而不追价");
  }
  if (protection!=null&&1/leverage <= Math.abs(input.entryPrice-protection)/input.entryPrice+input.maintenanceRate+cost)
    fail("RISK_CAP","源单杠杆与实际入场价无法保留止损前的保证金余量");
  const size=direction*contracts,tag=liveEntryTag(t.id);
  const receipt:MirrorReceipt={version:LIVE_PARITY_VERSION,sourceId:t.id,sourceRuleId:t.rule.id,sourcePolicy:input.policy,
    sourceOpenedAt:t.openedAt,sourceDeadline:t.openedAt+sourceHoldMinutes(t)*60_000,
    sourceEntryPrice:t.entryPrice,sourceStopPrice:t.stopPrice,sourceArmPrice:t.armPrice,
    sourceExitMode:t.rule.exitMode,sourceGivebackRate:t.rule.givebackRate,
    sourceExitPlanVersion:t.exitPlan?.version,sourceBestHoldMinutes:t.exitPlan?.bestHoldMinutes,sourceMaxHoldMinutes:t.exitPlan?.maxHoldMinutes,
    sourceContractsAtCopy:t.contracts,sourceNotional:t.notional,sourceMargin:t.margin,sourceLeverage:t.leverage,
    copiedAt:input.now,sourceEquity:input.sourceEquity,liveEquity:input.equity,ratio,targetNotional,targetMargin,
    requestedContracts,roundedContracts:contracts,roundingNotional:Math.max(0,targetNotional-notional),discrepancy:null,
    quantityText,minimumContracts:sized.minimum,quantityQuantum:sized.quantum,
    supportsDecimalContracts:sized.supportsDecimals,minimumUplift,minimumUpliftRiskRate,activationAt:input.activationAt,
    entryDriftPolicy:LIVE_ENTRY_DRIFT_POLICY,sourceQuoteAt:t.lastQuoteAt,copyQuoteAt:input.quoteObservedAt,
    copyQuotePrice:input.entryPrice,copyDelayMs:Math.max(0,input.now-t.openedAt),
    allowedAdverseEntryDriftRate:drift.allowed,adverseEntryDriftRate:drift.adverse};
  if(t.inverseCopy)Object.assign(receipt,{sourceRole:'INVERSE_PAPER',nativeProtectionPolicy:INVERSE_LIVE_EXIT_POLICY,
    executionLeverage:leverage,leveragePolicy:INVERSE_LIVE_LEVERAGE_POLICY,
    exitPolicy:INVERSE_LIVE_EXIT_POLICY,nativeProtectionPrice:null,shadowSourceId:t.inverseCopy.sourceId,
    sourceAllocationRiskRate:t.plannedRisk/t.notional});
  if(t.unified)Object.assign(receipt,{sourceRole:'UNIFIED_PAPER',unifiedBranch:t.unified.branch,executionLeverage:leverage,leveragePolicy:'actual-intent-isolated-v1',
    nativeProtectionPolicy:t.unified.branch==='RETURN'&&!t.unified.marketRoute?INVERSE_LIVE_EXIT_POLICY:undefined,
    nativeProtectionPrice:protection,shadowSourceId:t.unified.sourceId,sourceAllocationRiskRate:t.plannedRisk/t.notional,
    entryPricePolicy:'fresh-market-v1'});
  if(t.unified?.marketRoute)receipt.marketAuthorityVersion=t.unified.marketRoute.version;
  return {intent:{kind:"MARKET",tag,size,contracts,notional,plannedRisk,leverage,margin,
    body:{contract:t.symbol,size:`${direction<0?"-":""}${quantityText}`,price:"0",tif:"ioc",text:tag,reduce_only:false}},
    binding:{version:LIVE_PARITY_VERSION,sourceAtCopy:structuredClone(t),receipt}};
}

export function mirrorCoverage(state:ForwardState|null,live:{requestedEnabled:boolean;activation?:LiveSession|null;
  accountMark?:{sessionAt:number;at:number;startedAt:number}|null;positions:Record<string,{id:string;status:string;leverage?:number;parity?:MirrorReceipt;exchangeUnrealisedPnl?:number|null;exchangePnlAt?:number|null}|null>;
  entries:Record<string,{planId:string;status:string;parity?:MirrorReceipt}|null>;entrySkips:Record<string,{planId:string;reason:string;code?:string}|null>},error:string|null) {
  const sources=state?.positions??[];
  let sourceError=error;
  try { if(state)forwardMirrorSources(state,Math.max(1,state.balance)); }
  catch(e) { sourceError=e instanceof Error?e.message:String(e); }
  const rows=sources.map(t=>{
    const p=live.positions[t.symbol],e=live.entries[t.symbol],skip=live.entrySkips[t.symbol];
    const copied=p?.status==="OPEN"&&p.id===t.id,endedEarly=p?.status==="CLOSED"&&p.id===t.id;
    const pending=e?.planId===t.id&&["SUBMITTING","OPEN","ERROR"].includes(e.status);
    const currentSource=!state?.inverseTrial||!!t.inverseCopy||!!t.unified;
    const eligible=currentSource&&live.requestedEnabled&&sourceAfterEnable(t,live.activation,state!.startedAt);
    const skipStatus=skip?.planId!==t.id?null:skip.code==="MIN_CONTRACT"?"BLOCKED_MIN_SIZE"
      :skip.code==="RETRYING"?"RETRYING":skip.code==="SOURCE_ENDED_EARLY"?"SOURCE_ENDED_EARLY":"BLOCKED";
    const status=copied?(p?.parity?.discrepancy?"DEVIATION":"COPIED"):endedEarly?"SOURCE_ENDED_EARLY":pending?"PENDING":!currentSource?"LEGACY_DRAIN":
      !live.requestedEnabled?"OWNER_OFF":!eligible?"EXCLUDED_BEFORE_ENABLE":skipStatus??"WAITING";
    return {sourceId:t.id,symbol:t.symbol,eligible,status,
      reason:copied?p?.parity?.leverageAdjustError??p?.parity?.discrepancy??null:status==="LEGACY_DRAIN"?"旧源单仅管理已绑定实盘，不新增复制":status==="EXCLUDED_BEFORE_ENABLE"?"开启前或本次接入前已有的模拟持仓，不补开"
        :endedEarly?"该模拟源单仍开放，但对应实盘仓位已经在 Gate 归零；同一源单不重复开仓"
        :skip?.planId===t.id?skip.reason:sourceError??(!live.requestedEnabled?"等待所有者开启；此前持仓不会补开"
          :"实盘核对已运行，但该源单尚未形成明确执行状态；下一轮会继续核对")};
  });
  const actual=Object.values(live.positions).filter(p=>p?.status==="OPEN");
  const valued=actual.filter(p=>typeof p?.exchangeUnrealisedPnl==="number"&&Number.isFinite(p.exchangeUnrealisedPnl)&&!!p.exchangePnlAt);
  const inverseHeld=actual.filter(p=>isInverseLiveReceipt(p?.parity));
  const leverageTarget=(p:typeof inverseHeld[number])=>p!.parity!.sourceRole==='UNIFIED_PAPER'
    ?p!.parity!.sourceLeverage:inverseLiveLeverage(p!.parity!.sourceLeverage);
  return {version:LIVE_PARITY_VERSION,source:LIVE_PARITY_SOURCE,connected:!!state&&!sourceError,ownerControlled:true,
    accountRole:state?.directStrategy?'DIRECT_STRATEGY':state?.unifiedExecution?'UNIFIED_PAPER':state?.inverseTrial?'INVERSE_PAPER':'CURRENT_PAPER',
    nativeProtectionPolicy:state?.directStrategy||state?.unifiedExecution?'own-branch-evidence-v1':state?.inverseTrial?INVERSE_LIVE_EXIT_POLICY:null,
    leveragePolicy:state?.unifiedExecution?'actual-intent-isolated-v1':state?.inverseTrial?INVERSE_LIVE_LEVERAGE_POLICY:null,
    leverageAdjustment:{managed:inverseHeld.length,
      atOrBelowTarget:inverseHeld.filter(p=>p?.leverage!=null&&p.leverage>0&&p.leverage<=leverageTarget(p)).length,
      pending:inverseHeld.filter(p=>p?.leverage!=null&&p.leverage>leverageTarget(p)).length},
    entryPricePolicy:state?.inverseTrial?'fresh-market-v1':LIVE_ENTRY_DRIFT_POLICY,
    accountViewPolicy:'gate-authoritative-v1',
    accountViewAt:live.accountMark?.sessionAt===(live.activation?.enabledAt??0)?live.accountMark.at:null,
    exitExecutionPolicy:state?.inverseTrial?'priority-bounded-exit-v1':null,
    instructionParity:!sourceError,exactFillsGuaranteed:false,sourceCount:sources.length,copiedCount:rows.filter(r=>["COPIED","DEVIATION"].includes(r.status)).length,
    pendingCount:rows.filter(r=>r.status==="PENDING").length,rows,error:sourceError,
    executionPolicy:LIVE_SESSION_VERSION,newOrdersOnly:true,enabledAt:live.activation?.enabledAt??null,
    eligibleSourceCount:rows.filter(r=>r.eligible).length,excludedSourceCount:rows.filter(r=>r.status==="EXCLUDED_BEFORE_ENABLE").length,
    eligibleCopiedCount:rows.filter(r=>r.eligible&&["COPIED","DEVIATION"].includes(r.status)).length,
    eligibleMissingCount:rows.filter(r=>r.eligible&&!["COPIED","DEVIATION"].includes(r.status)).length,
    managedBeforeEnableCount:rows.filter(r=>!r.eligible&&["COPIED","DEVIATION"].includes(r.status)).length,
    minimumSizeBlockedCount:rows.filter(r=>r.status==="BLOCKED_MIN_SIZE").length,
    blockedCount:rows.filter(r=>r.status.startsWith("BLOCKED")).length,deviationCount:rows.filter(r=>r.status==="DEVIATION").length,
    retryingCount:rows.filter(r=>r.status==="RETRYING").length,sourceEndedEarlyCount:rows.filter(r=>r.status==="SOURCE_ENDED_EARLY").length,
    unclassifiedWaitingCount:rows.filter(r=>r.status==="WAITING").length,
    actualLiveHoldingCount:actual.length,exchangePnlHoldingCount:valued.length,
    lastExchangePnlAt:valued.length?Math.max(...valued.map(p=>p!.exchangePnlAt!)):null};
}
