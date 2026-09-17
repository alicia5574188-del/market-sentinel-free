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

export const LIVE_PARITY_VERSION = "current-paper-live-parity-v1";
export const LIVE_PARITY_SOURCE = "CURRENT_FORWARD_ACCOUNT";
export const LIVE_PARITY_PREFIX = "live-parity:v1:";
export type MirrorSourceTrade = ArenaTrade & { forwardSource?: Trade };
export type MirrorReceipt = {
  version: typeof LIVE_PARITY_VERSION; sourceId: string; sourceRuleId: string;
  sourcePolicy: string; sourceOpenedAt: number; sourceDeadline: number;
  sourceEntryPrice: number; sourceStopPrice: number; sourceArmPrice: number;
  sourceExitMode: Trade["rule"]["exitMode"]; sourceGivebackRate: number;
  sourceNotional: number; sourceMargin: number; sourceLeverage: number;
  copiedAt: number; sourceEquity: number; liveEquity: number; ratio: number;
  targetNotional: number; targetMargin: number; requestedContracts: number;
  roundedContracts: number; roundingNotional: number; filledContracts?: number;
  sourceClosedAt?: number | null; sourceExitReason?: string | null;
  actualExitOrderId?: string | null; actualExitPriceVerified?: boolean;
  discrepancy?: string | null;
  quantityText?: string; minimumContracts?: number; quantityQuantum?: string;
  supportsDecimalContracts?: boolean; activationAt?: number;
};
export type MirrorBinding = { version: typeof LIVE_PARITY_VERSION; sourceAtCopy: Trade;
  receipt: MirrorReceipt; sourceAtClose?: Trade; actual?: unknown };

function positive(v: number) { return Number.isFinite(v) && v > 0; }
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
  for (const t of state.positions) {
    validateMirrorSource(t);
    if (out[t.symbol]) throw new Error(`${t.symbol} 出现多条逻辑持仓；禁止静默净额合并，须先升级逐腿执行适配器`);
    const cost = 2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+PAPER_COST.fundingAllowancePerDay*t.rule.horizon/1440;
    out[t.symbol] = {
      id:t.id, strategyId:t.rule.id, strategyName:`关系规则 ${t.rule.id} v${t.rule.version}`,
      family:"TREND", lane:"PORTFOLIO", eventId:t.id, symbol:t.symbol, side:t.side,
      status:t.status, openedAt:t.openedAt, closedAt:null, entryPrice:t.entryPrice,
      stopPrice:t.stopPrice, activeStopPrice:t.stopPrice, targetPrice:t.armPrice,
      exitPrice:null, outcome:null, grossReturnRate:null, netReturnRate:null, netPnl:null,
      notional:t.notional, maxFavorableRate:t.favorable, maxAdverseRate:t.adverse,
      lastPrice:t.lastPrice, selectedForPortfolio:true, reason:t.rule.reason,
      admissionTier:null, plannedRisk:t.plannedRisk, contracts:t.contracts,
      quantoMultiplier:t.quantoMultiplier, leverage:t.leverage, margin:t.margin,
      accountEquityAtOpen:sourceEquity, forwardSource:structuredClone(t),
      context:{channel:"TREND",regime:"TREND",anomalyKind:null,entryStyle:"CONFIRM",exitProfile:"STRUCTURE",
        candidateScore:0,trendRate:0,trendEfficiency:0,volatilityRatio:0,rangePosition:0,
        openInterestChangeRate:0,volume24hUsd:0,fundingRate:0,alignedFlow:0,confirmation:0,fakeoutRisk:0,
        rangeId:null,modeledCostRate:cost,spreadRate:0,bidDepthUsd:0,askDepthUsd:0,structureSource:"CANDLE_5M",
        grossRewardRate:0,structuralStopRate:t.rule.stopRate,netRewardRisk:0,costShare:0,
        empiricalExpectedReturnRate:0,empiricalProfitFactor:0,empiricalEvents:0,
        profitArmIsNotExit:true,maxHoldMs:t.rule.horizon*60_000},
    };
  }
  return out;
}

export function sourceLifecycle(state: ForwardState | null, id: string) {
  const open = state?.positions.find(t=>t.id===id);
  if (open) return { status:"OPEN" as const, trade:open };
  const closed=state?.history.find(t=>t.id===id&&t.status==="CLOSED");
  return closed ? { status:"CLOSED" as const, trade:closed } : { status:"UNKNOWN" as const, trade:null };
}

export function mirrorSourceFresh(t: Trade | undefined, id: string, now: number) {
  return !!t && t.id===id && t.status==="OPEN" && now>=t.openedAt && now<t.openedAt+t.rule.horizon*60_000;
}

export function buildProportionalMirror(input:{source:Trade;sourceEquity:number;equity:number;available:number;
  entryPrice:number;quantoMultiplier:number;leverageMax:number;maintenanceRate:number;openRisk:number;
  sameDirectionRisk:number;openMargin:number;openNotional:number;now:number;policy:string;
  sizeRules?: GateSizeRules; activationAt?: number}): {intent:LiveEntryIntent;binding:MirrorBinding} {
  const t=input.source;validateMirrorSource(t);
  const fail=(code:"MIN_CONTRACT"|"CONTRACT_SPEC"|"MARGIN"|"RISK_CAP"|"ECONOMICS",message:string,sizing?:SizeDiagnostic):never=>{
    throw new LiveEntrySizingError(code,t.symbol,`${t.symbol} ${message}；源单 ${t.id} 未完成复制，不冒充已成交`,sizing);
  };
  if (!mirrorSourceFresh(t,t.id,input.now))fail("ECONOMICS","源单已结束或期限已到，不补过期订单");
  if (![input.sourceEquity,input.equity,input.entryPrice,input.quantoMultiplier,input.leverageMax].every(positive)
    || ![input.available,input.openRisk,input.sameDirectionRisk,input.openMargin,input.openNotional,input.maintenanceRate].every(v=>Number.isFinite(v)&&v>=0))
    fail("ECONOMICS","实时账户/合约规格不完整");
  if (Math.abs(input.quantoMultiplier-t.quantoMultiplier)>t.quantoMultiplier*1e-9)fail("ECONOMICS","合约乘数与源单不一致");
  if (t.leverage>input.leverageMax)fail("MARGIN","交易所不支持源单杠杆，不擅自改杠杆");
  const direction=t.side==="LONG"?1:-1;
  if (direction*(input.entryPrice-t.stopPrice)<=0)fail("ECONOMICS","当前价已越过源单止损，不开即平");
  const ratio=input.equity/input.sourceEquity,targetNotional=t.notional*ratio,targetMargin=t.margin*ratio;
  const one=input.entryPrice*input.quantoMultiplier,requestedContracts=targetNotional/one;
  let sized: ReturnType<typeof quantizeMirrorNotional>;
  try { sized=quantizeMirrorNotional(targetNotional,input.entryPrice,input.quantoMultiplier,input.sizeRules??{}); }
  catch(error){return fail("CONTRACT_SPEC",error instanceof Error?error.message:"数量规格无效");}
  const contracts=sized.quantity;
  if (!(contracts>0))fail("MIN_CONTRACT","按比例低于该合约真实最小数量；不放大资金或伪造复制",{
    targetContracts:requestedContracts,minimumContracts:sized.minimum,quantityQuantum:sized.quantum,
    supportsDecimals:sized.supportsDecimals,targetNotional,minimumNotional:sized.minimumNotional,
    minimumMargin:sized.minimumNotional/t.leverage,requiredLiveEquity:input.sourceEquity*sized.minimumNotional/t.notional});
  const notional=contracts*one,leverage=t.leverage,margin=notional/leverage;
  const cost=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate)+PAPER_COST.fundingAllowancePerDay*t.rule.horizon/1440;
  const plannedRisk=notional*(Math.abs(input.entryPrice-t.stopPrice)/input.entryPrice+cost);
  if (margin+notional*PAPER_COST.feeRate>input.available)fail("MARGIN","可用保证金不足，保留比例，不静默缩单");
  if (input.openMargin+margin>input.equity*.75+1e-8)fail("MARGIN","累计保证金超出模拟同口径75%预算");
  if (input.openNotional+notional>input.equity*4+1e-8 || input.openRisk+plannedRisk>input.equity*.10+1e-8
    || input.sameDirectionRisk+plannedRisk>input.equity*.065+1e-8)fail("RISK_CAP","按实际成交价计算已超过原账户风险预算");
  if (1/leverage <= Math.abs(input.entryPrice-t.stopPrice)/input.entryPrice+input.maintenanceRate+cost)
    fail("RISK_CAP","源单杠杆与实际入场价无法保留止损前的保证金余量");
  const size=direction*contracts,tag=liveEntryTag(t.id);
  const receipt:MirrorReceipt={version:LIVE_PARITY_VERSION,sourceId:t.id,sourceRuleId:t.rule.id,sourcePolicy:input.policy,
    sourceOpenedAt:t.openedAt,sourceDeadline:t.openedAt+t.rule.horizon*60_000,
    sourceEntryPrice:t.entryPrice,sourceStopPrice:t.stopPrice,sourceArmPrice:t.armPrice,
    sourceExitMode:t.rule.exitMode,sourceGivebackRate:t.rule.givebackRate,
    sourceNotional:t.notional,sourceMargin:t.margin,sourceLeverage:t.leverage,
    copiedAt:input.now,sourceEquity:input.sourceEquity,liveEquity:input.equity,ratio,targetNotional,targetMargin,
    requestedContracts,roundedContracts:contracts,roundingNotional:Math.max(0,targetNotional-notional),discrepancy:null,
    quantityText:sized.quantityText,minimumContracts:sized.minimum,quantityQuantum:sized.quantum,
    supportsDecimalContracts:sized.supportsDecimals,activationAt:input.activationAt};
  return {intent:{kind:"MARKET",tag,size,contracts,notional,plannedRisk,leverage,margin,
    body:{contract:t.symbol,size:`${direction<0?"-":""}${sized.quantityText}`,price:"0",tif:"ioc",text:tag,reduce_only:false}},
    binding:{version:LIVE_PARITY_VERSION,sourceAtCopy:structuredClone(t),receipt}};
}

export function mirrorCoverage(state:ForwardState|null,live:{requestedEnabled:boolean;activation?:LiveSession|null;positions:Record<string,{id:string;status:string;parity?:MirrorReceipt;exchangeUnrealisedPnl?:number|null;exchangePnlAt?:number|null}|null>;
  entries:Record<string,{planId:string;status:string;parity?:MirrorReceipt}|null>;entrySkips:Record<string,{planId:string;reason:string;code?:string}|null>},error:string|null) {
  const sources=state?.positions??[];
  let sourceError=error;
  try { if(state)forwardMirrorSources(state,Math.max(1,state.balance)); }
  catch(e) { sourceError=e instanceof Error?e.message:String(e); }
  const rows=sources.map(t=>{
    const p=live.positions[t.symbol],e=live.entries[t.symbol],skip=live.entrySkips[t.symbol];
    const copied=p?.status==="OPEN"&&p.id===t.id;
    const pending=e?.planId===t.id&&["SUBMITTING","OPEN","ERROR"].includes(e.status);
    const eligible=live.requestedEnabled&&sourceAfterEnable(t,live.activation,state!.startedAt);
    const status=copied?(p?.parity?.discrepancy?"DEVIATION":"COPIED"):pending?"PENDING":!live.requestedEnabled?"OWNER_OFF":!eligible?"EXCLUDED_BEFORE_ENABLE"
      :skip?.planId===t.id?(skip.code==="MIN_CONTRACT"?"BLOCKED_MIN_SIZE":"BLOCKED"):"WAITING";
    return {sourceId:t.id,symbol:t.symbol,eligible,status,
      reason:copied?p?.parity?.discrepancy??null:status==="EXCLUDED_BEFORE_ENABLE"?"开启前或本次接入前已有的模拟持仓，不补开"
        :skip?.planId===t.id?skip.reason:sourceError??(!live.requestedEnabled?"等待所有者开启；此前持仓不会补开":"等待当前报价、账户与交易所确认")};
  });
  const actual=Object.values(live.positions).filter(p=>p?.status==="OPEN");
  const valued=actual.filter(p=>typeof p?.exchangeUnrealisedPnl==="number"&&Number.isFinite(p.exchangeUnrealisedPnl)&&!!p.exchangePnlAt);
  return {version:LIVE_PARITY_VERSION,source:LIVE_PARITY_SOURCE,connected:!!state&&!sourceError,ownerControlled:true,
    instructionParity:!sourceError,exactFillsGuaranteed:false,sourceCount:sources.length,copiedCount:rows.filter(r=>["COPIED","DEVIATION"].includes(r.status)).length,
    pendingCount:rows.filter(r=>r.status==="PENDING").length,rows,error:sourceError,
    executionPolicy:LIVE_SESSION_VERSION,newOrdersOnly:true,enabledAt:live.activation?.enabledAt??null,
    eligibleSourceCount:rows.filter(r=>r.eligible).length,excludedSourceCount:rows.filter(r=>r.status==="EXCLUDED_BEFORE_ENABLE").length,
    managedBeforeEnableCount:rows.filter(r=>!r.eligible&&["COPIED","DEVIATION"].includes(r.status)).length,
    minimumSizeBlockedCount:rows.filter(r=>r.status==="BLOCKED_MIN_SIZE").length,
    blockedCount:rows.filter(r=>r.status.startsWith("BLOCKED")).length,deviationCount:rows.filter(r=>r.status==="DEVIATION").length,
    actualLiveHoldingCount:actual.length,exchangePnlHoldingCount:valued.length,
    lastExchangePnlAt:valued.length?Math.max(...valued.map(p=>p!.exchangePnlAt!)):null};
}