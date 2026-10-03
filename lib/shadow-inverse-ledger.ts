/** Passive inverse PAPER accounting. No signal, independent exit or size choice. */
import type {ForwardState,Trade,Quote,AuditEvent} from './forward-relations.ts';
import {inversePaidFeeView} from './paid-fee-view.ts';
import {SHADOW_FEE_RATE,INVERSE_COST,INVERSE_FEE_POLICY,recordedInverseFeeRate,type InverseFeeStamp} from './inverse-fee.ts';
import {FIXED_ALLOCATION_EQUITY,FIXED_ALLOCATION_POLICY} from './fixed-allocation.ts';
import type {InverseLossResearch} from './inverse-loss-research.ts';
import {validMarketAuthority,validMarketRoute} from './market-authority.ts';
import {validResponseHolding} from './event-response.ts';
export {INVERSE_COST} from './inverse-fee.ts';

export const SHADOW_INVERSE_VERSION='shadow-inverse-v1';
export const SHADOW_BASELINE_BUILD='2b4fd60f77c9b78526bd5087940945fe7e86fab8';
export const MIRROR_ACCOUNTING_MODE='same-source-price-fee-only-v1' as const;
const SOURCE_FUNDING_ALLOWANCE_PER_DAY=.0002;
export type InverseFill=InverseFeeStamp & {sequence:number;kind:'OPEN'|'REDUCE'|'CLOSE';sourceAt:number;appliedAt:number;
  administrative?:'ACCOUNT_RESET_QUOTE'|'ACCOUNT_RESET_SAVED_MARK';
  sourceQuoteAt:number;quoteAt:number;sourcePrice:number;price:number;quantity:number;contracts:number;
  sourceGross:number;gross:number;sourceFee:number;fee:number;sourceFunding:number;funding:number;spreadDrag:number};
export type InverseCopy={version:typeof SHADOW_INVERSE_VERSION;sourceBuild:typeof SHADOW_BASELINE_BUILD;sourceId:string;
  lossResearch?:InverseLossResearch;
  lossResearchHotOmitted?:true;
  cutoverAt:number;sourceSide:'LONG'|'SHORT';sourceEntryPrice:number;sourceStopPrice:number;sourceTargetPrice:number|null;
  sourceEntryPlan:Trade['entryContext'];sourceExitReason:string|null;sourceExitAudit?:Trade['exitAudit'];
  sourceRemainingContracts:number;fills:InverseFill[];sourceClosedAt:number|null;independentDecisions:false;liveExecution:'PAPER_ONLY'};

/** Market memory is shared once. Every wallet/history-dependent variable is
 * instead supplied by the source's own capsule, never the inverse wallet. */
export const SHARED_MARKET_KEYS=['extremumRegime','hypothesisResearch','environmentContext','marketPulse','selectedSymbols',
  'opportunities','entryValidations','entryDiagnostics','relationEngine','lastCycleAt','lastQuoteCycleAt','lastCandleAt','fitDiagnostics'] as const;
export type ShadowCapsule=Omit<ForwardState,typeof SHARED_MARKET_KEYS[number]|'inverseTrial'|'unifiedExecution'|'directStrategy'>;
export type InverseTotals={sourceGross:number;sourceFees:number;sourceFunding:number;gross:number;fees:number;funding:number;feeSavings?:number;
  spreadDrag:number;opened:number;closed:number;reductions:number};
export type InverseTrial={version:typeof SHADOW_INVERSE_VERSION;sourceBuild:typeof SHADOW_BASELINE_BUILD;cutoverAt:number;
  accountingMode?:typeof MIRROR_ACCOUNTING_MODE;reconciledAt?:number;
  initialComparisonEquity:number;legacyIds:string[];source:ShadowCapsule;totals:InverseTotals;
  curve:{at:number;source:number;inverse:number;theoretical:number}[];droppedCurvePoints:number;lastSourceRevision:number};
const dir=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const same=(a:number,b:number)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
export const inverseId=(sourceId:string)=>`iv-${sourceId}`;
export function shadowCapsule(state:ForwardState):ShadowCapsule{
  const row={...state} as Record<string,unknown>;delete row.inverseTrial;
  delete row.unifiedExecution;
  delete row.directStrategy;
  for(const k of SHARED_MARKET_KEYS)delete row[k];
  for(const k of Object.keys(row))if(k.startsWith('__'))delete row[k];
  return structuredClone(row) as ShadowCapsule;
}
export function sourceDecisionState(state:ForwardState):ForwardState{
  if(!state.inverseTrial)return state;
  const source={...state.inverseTrial.source} as ForwardState;
  for(const key of SHARED_MARKET_KEYS)Object.assign(source,{[key]:state[key]});
  return source;
}
export function newInverseTrial(state:ForwardState,now:number,equity:number):InverseTrial{
  if(!finite(equity)||equity<=0)throw new Error('反向试验初始权益无效；保留原账户');
  return{version:SHADOW_INVERSE_VERSION,sourceBuild:SHADOW_BASELINE_BUILD,cutoverAt:now,accountingMode:MIRROR_ACCOUNTING_MODE,reconciledAt:now,
    initialComparisonEquity:equity,legacyIds:state.positions.map(t=>t.id),source:shadowCapsule(state),lastSourceRevision:state.revision,
    totals:{sourceGross:0,sourceFees:0,sourceFunding:0,gross:0,fees:0,funding:0,feeSavings:0,spreadDrag:0,opened:0,closed:0,reductions:0},
    curve:[{at:now,source:equity,inverse:equity,theoretical:equity}],droppedCurvePoints:0};
}
function event(state:ForwardState,now:number,kind:AuditEvent['kind'],trade:Trade,reason:string){
  state.revision++;state.events.unshift({id:`a${state.startedAt}-${state.revision}`,at:now,kind,subject:trade.id,reason,
    detail:{sourceId:trade.inverseCopy!.sourceId,sourceBuild:SHADOW_BASELINE_BUILD,execution:SHADOW_INVERSE_VERSION}});
  state.events=state.events.slice(0,160);
}
function addFill(state:ForwardState,t:Trade,source:Trade,kind:InverseFill['kind'],quantity:number,contracts:number,
  sourcePrice:number,sourceAt:number,sourceQuoteAt:number,now:number,administrative?:InverseFill['administrative']){
  if(sourceAt!==now)throw new Error('反向复制禁止用当前事件伪造历史成交');
  if(!finite(sourcePrice)||sourcePrice<=0||!finite(sourceQuoteAt)||sourceQuoteAt>sourceAt)throw new Error('影子成交回执无效');
  const i=t.inverseCopy!,isOpen=kind==='OPEN',price=sourcePrice,
    sourceGross=isOpen?0:dir(source.side)*quantity*(sourcePrice-source.entryPrice),gross=sourceGross===0?0:-sourceGross,
    sourceFee=quantity*sourcePrice*SHADOW_FEE_RATE,fee=quantity*price*INVERSE_COST.feeRate,
    days=Math.max(0,sourceAt-source.openedAt)/86_400_000,
    sourceFunding=isOpen?0:quantity*source.entryPrice*SOURCE_FUNDING_ALLOWANCE_PER_DAY*days,
    funding=0,spreadDrag=0,
    fill:InverseFill={sequence:i.fills.length,kind,sourceAt,appliedAt:now,sourceQuoteAt,quoteAt:sourceQuoteAt,
      sourcePrice,price,quantity,contracts,sourceGross,gross,sourceFee,fee,sourceFunding,funding,spreadDrag,
      feePolicy:INVERSE_FEE_POLICY,feeRate:INVERSE_COST.feeRate,
      ...(administrative?{administrative}:{})};
  i.fills.push(fill);const a=state.inverseTrial!.totals;
  a.sourceGross+=sourceGross;a.sourceFees+=sourceFee;a.sourceFunding+=sourceFunding;
  a.gross+=gross;a.fees+=fee;a.funding+=funding;a.spreadDrag+=spreadDrag;a.feeSavings=(a.feeSavings??0)+sourceFee-fee;
  state.balance+=gross-fee;state.grossPnl+=gross;state.fees+=fee;
  state.turnover+=quantity*price;return fill;
}

/** Same transaction as the source. Profit-taking by the source also reduces a
 * losing inverse position: no reuse of the positive-profit-only trim gate. */
export function applyInverseSourceTrade(state:ForwardState,source:Trade,qIn:Quote|undefined,now:number,manualReset=false){
  const trial=state.inverseTrial;if(!trial)throw new Error('反向账本尚未初始化');
  if(source.openedAt<trial.cutoverAt||trial.legacyIds.includes(source.id))return;
  const id=inverseId(source.id);let t=state.positions.find(x=>x.id===id)??state.history.find(x=>x.id===id);
  if(t?.status==='CLOSED'){
    if(source.status!=='CLOSED'||t.inverseCopy?.sourceClosedAt!==source.closedAt)throw new Error('反向已结束父单的源状态冲突');
    return;
  }
  const reductions=source.realization?.fills??[],already=t?.realization?.sequence??0;
  const resetFresh=!!qIn&&qIn.fresh&&qIn.observedAt<=now&&now-qIn.observedAt<=10000&&qIn.bestBid>0&&qIn.bestAsk>=qIn.bestBid;
  if(manualReset&&(!t||source.exitReason!=='ACCOUNT_RESET'||reductions.length!==already))throw new Error('手动重置不能补造影子历史成交');
  if(!t){
    const side=source.side==='LONG'?'SHORT':'LONG',price=source.entryPrice,
      quantity=source.realization?.initialQuantity??source.quantity,contracts=source.realization?.initialContracts??source.contracts,
      context=source.entryContext?structuredClone(source.entryContext):undefined;
    if(context){
      // The full ORIGINAL decision lives once at sourceEntryPlan. The passive
      // leg has no second copy of liquidity/hypothesis/exit authority.
      const keep=new Set(['version','capturedAt','timeframe','side','mode','reserve','reason','entryScore','directionStrength','spaceScore','positionScore','executionScore',
        'remainingSpaceRate','pullbackRiskRate','edgeRatio','expectedHoldMinutes','marketFit','regionId','portfolioRiskCharge']);
      for(const k of Object.keys(context))if(!keep.has(k))delete (context as unknown as Record<string,unknown>)[k];
      context.side=side;context.strategyVersion=SHADOW_INVERSE_VERSION;
      context.reason=`反向复制影子 ${source.id}；原方向${source.side==='LONG'?'多':'空'}，进出场只由影子决定。`;
      context.thesisId=id;context.thesisSummary=context.reason;context.invalidationSummary='仅跟随影子退出事件；本账户无独立止盈止损。';}
    t={...structuredClone(source),id,side,status:'OPEN',openedAt:now,closedAt:null,entryPrice:price,exitPrice:null,
      quantity,contracts,notional:quantity*price,margin:quantity*price/source.leverage,entryFee:quantity*price*INVERSE_COST.feeRate,
      exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,lastPrice:price,lastQuoteAt:source.lastQuoteAt,
      plannedRisk:source.realization?.initialRisk??source.plannedRisk,favorable:0,adverse:0,firstProfitAt:null,profitFloorRate:0,peakPnlRate:0,
      entryContext:context,rule:{...source.rule,id,side,reason:context?.reason??'影子反向复制'},
      exitControl:{policy:SHADOW_INVERSE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30000,maxQuoteAgeMs:10000},
      inverseCopy:{version:SHADOW_INVERSE_VERSION,sourceBuild:SHADOW_BASELINE_BUILD,sourceId:source.id,cutoverAt:trial.cutoverAt,
        sourceSide:source.side,sourceEntryPrice:source.entryPrice,sourceStopPrice:source.stopPrice,
        sourceTargetPrice:source.entryContext?.winnerPlan?.target??null,sourceEntryPlan:structuredClone(source.entryContext),
        sourceExitReason:null,sourceRemainingContracts:contracts,sourceClosedAt:null,fills:[],independentDecisions:false,liveExecution:'PAPER_ONLY'}};
    delete t.review;delete t.winnerManagement;delete t.positionIntelligence;delete t.realization;delete t.holdValue;
    delete t.liquidityLifecycle;delete t.profitLifecycle;delete t.profitProtection;delete t.profitProtectionMigration;delete t.exitAudit;delete t.exitPlan;
    addFill(state,t,source,'OPEN',quantity,contracts,source.entryPrice,source.openedAt,source.review?.timeline[0]?.quoteAt??source.lastQuoteAt,now);
    if(!same(t.inverseCopy!.fills[0]!.sourceFee,source.entryFee))throw new Error('影子入场费用不符合固定源账本');
    trial.totals.opened++;state.positions.push(t);event(state,now,'ENTRY',t,`${source.symbol} 影子反向开仓`);
  }
  for(const sf of reductions.slice(already)){
    if(sf.quantity<=0||sf.quantity>=t.quantity||sf.contracts<=0||sf.contracts>=t.contracts)throw new Error('反向减仓数量与父单不一致');
    const f=addFill(state,t,source,'REDUCE',sf.quantity,sf.contracts,sf.price,sf.at,sf.quoteAt,now),
      r=t.realization??{version:'partial-realization-v1' as const,initialQuantity:t.quantity,initialContracts:t.contracts,
        initialNotional:t.notional,initialMargin:t.margin,initialRisk:t.plannedRisk,initialEntryFee:t.entryFee,gross:0,fees:0,funding:0,sequence:0,fills:[]};
    if(!same(f.sourceGross,sf.gross)||!same(f.sourceFee,sf.fee)||!same(f.sourceFunding,sf.funding))throw new Error('影子减仓实际回执与配对数量费用不一致');
    r.sequence++;r.gross+=f.gross;r.fees+=f.fee;r.funding+=f.funding;
    r.fills.push({sequence:r.sequence,at:now,quoteAt:f.quoteAt,price:f.price,quantity:sf.quantity,contracts:sf.contracts,
      gross:f.gross,fee:f.fee,funding:f.funding,reason:'SHADOW_REDUCTION'});
    t.realization=r;t.quantity-=sf.quantity;t.contracts-=sf.contracts;t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;
    t.plannedRisk=r.initialRisk*t.contracts/r.initialContracts;trial.totals.reductions++;
    event(state,now,'PROTECTION',t,`${source.symbol} 影子减仓，反向同数量跟随（不检查反向盈亏）`);
  }
  const i=t.inverseCopy!;i.sourceStopPrice=source.stopPrice;i.sourceTargetPrice=source.winnerManagement?.targetLevel??source.entryContext?.winnerPlan?.target??null;
  // Display reference only. Never route this as the inverse leg's hard stop.
  t.stopPrice=source.stopPrice;t.armPrice=source.armPrice;i.sourceRemainingContracts=source.status==='CLOSED'?0:source.contracts;
  if(source.status==='CLOSED'){
    const sq=source.exitAudit?.evidence?.quoteAt,
      f=addFill(state,t,source,'CLOSE',t.quantity,t.contracts,source.exitPrice!,source.closedAt!,finite(sq)?sq:source.lastQuoteAt,now,
        manualReset?(resetFresh?'ACCOUNT_RESET_QUOTE':'ACCOUNT_RESET_SAVED_MARK'):undefined),r=t.realization;
    t.status='CLOSED';t.closedAt=now;t.exitPrice=f.price;t.lastPrice=f.price;t.lastQuoteAt=f.quoteAt;
    t.grossPnl=(r?.gross??0)+f.gross;t.exitFee=(r?.fees??0)+f.fee;t.fundingAllowance=0;
    t.netPnl=t.grossPnl-t.entryFee-t.exitFee;t.exitReason=manualReset?'ACCOUNT_RESET':'SHADOW_SOURCE_EXIT';
    i.sourceClosedAt=source.closedAt;i.sourceExitReason=source.exitReason;i.sourceExitAudit=structuredClone(source.exitAudit);
    if(!same(source.netPnl!,i.fills.reduce((n,f)=>n+f.sourceGross-f.sourceFee-f.sourceFunding,0)))throw new Error('影子父单净额与逐次实际成交不一致');
    t.exitAudit={trigger:t.exitReason,at:now,evidence:{authority:SHADOW_INVERSE_VERSION,sourceId:source.id,sourceReason:source.exitReason,administrative:manualReset,
      sourceClosedAt:source.closedAt,sourceBuild:SHADOW_BASELINE_BUILD,quoteAt:f.quoteAt}};
    if(r){t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.notional=r.initialNotional;t.margin=r.initialMargin;t.plannedRisk=r.initialRisk;}
    state.positions=state.positions.filter(x=>x.id!==id);state.history.unshift(t);state.history=state.history.slice(0,240);
    state.resolved++;if(t.netPnl>0)state.wins++;trial.totals.closed++;event(state,now,'EXIT',t,`${source.symbol} 跟随影子平仓`);
  }else if(!same(t.contracts,source.contracts)||!same(t.quantity,source.quantity))throw new Error('影子与反向剩余数量不一致');
  assertInverseTrade(t);
}
export function markInversePositions(state:ForwardState,_quotes:Record<string,Quote>,now:number){
  const trial=state.inverseTrial;if(!trial)return;
  for(const t of state.positions){if(!t.inverseCopy)continue;
    const source=trial.source.positions.find(s=>s.id===t.inverseCopy!.sourceId);
    if(!source||!finite(source.lastPrice)||source.lastPrice<=0||!finite(source.lastQuoteAt)||source.lastQuoteAt>now)continue;
    t.lastPrice=source.lastPrice;t.lastQuoteAt=source.lastQuoteAt;
    const signed=dir(t.side)*(t.lastPrice/t.entryPrice-1);t.favorable=Math.max(t.favorable,signed);t.adverse=Math.max(t.adverse,-signed);
    t.peakPnlRate=t.favorable;if(!t.firstProfitAt&&signed>SHADOW_FEE_RATE*2)t.firstProfitAt=now;
  }
}
export function inverseTrialSummary(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const v=state.inverseTrial;if(!v)return null;const a=v.totals,paid=inversePaidFeeView(state,quotes,now)!;
  const sourceNet=paid.source.netPnl??0,inverseNet=paid.inverse.netPnl??0;
  return{paidCost:paid,version:v.version,sourceBuild:v.sourceBuild,cutoverAt:v.cutoverAt,accountingMode:v.accountingMode??null,
    allocationPolicy:FIXED_ALLOCATION_POLICY,allocationEquity:FIXED_ALLOCATION_EQUITY,
    feePolicy:INVERSE_FEE_POLICY,feeRate:INVERSE_COST.feeRate,sourceFeeRate:SHADOW_FEE_RATE,
    reconciledAt:v.reconciledAt??null,initialEquity:v.initialComparisonEquity,
    sourceEquity:v.initialComparisonEquity+sourceNet,inverseEquity:v.initialComparisonEquity+inverseNet,
    theoreticalSamePriceEquity:v.initialComparisonEquity+inverseNet,sourceNet,inverseNet,
    sourceFees:a.sourceFees,inverseFees:a.fees,sourceFunding:a.sourceFunding,inverseFunding:0,
    realizedSpreadDrag:0,settledAttributionResidual:paid.reconciliation.grossMirrorResidual??0,pairedOpened:a.opened,pairedClosed:a.closed,
    pairedOpen:state.positions.filter(t=>t.inverseCopy).length,reductions:a.reductions,
    legacyOpen:state.positions.filter(t=>!t.inverseCopy).length,stalePositions:paid.stalePairs,
    sourceDecisionBalance:v.source.balance,sourceDecisionResolved:v.source.resolved,
    curve:v.curve,droppedCurvePoints:v.droppedCurvePoints,independentDecisions:false,liveExecution:'PAPER_ONLY' as const,
    costModel:'Exact source prices and gross inversion; source stays 7bp. New inverse fills use the current LIVE 5bp taker reference; already-booked fees stay unchanged.',
    scope:'Paired trades born after cutover only. Existing account curve and legacy holdings remain separate.'};
}
export function recordInverseCurve(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const v=state.inverseTrial,x=inverseTrialSummary(state,quotes,now);if(!v||!x||x.stalePositions)return;
  if(now-(v.curve.at(-1)?.at??0)<60_000)return;
  v.curve.push({at:now,source:x.sourceEquity,inverse:x.inverseEquity,theoretical:x.theoreticalSamePriceEquity});
  while(v.curve.length>720){v.curve.splice(1,1);v.droppedCurvePoints++;}
}
export function migrateInverseSamePrice(state:ForwardState,now:number){
  const trial=state.inverseTrial;if(!trial||trial.accountingMode===MIRROR_ACCOUNTING_MODE)return false;
  const rows=[...state.positions,...state.history].filter(t=>!!t.inverseCopy);
  const fills=rows.flatMap(t=>t.inverseCopy!.fills);
  if(fills.some(f=>f.feeRate!==undefined||f.feePolicy!==undefined))
    throw new Error('已有新版费率回执，禁止按旧同价迁移改写已扣手续费');
  const sum=(key:keyof InverseFill)=>fills.reduce((n,f)=>n+Number(f[key]),0);
  const a=trial.totals;
  if(rows.length!==a.opened||rows.filter(t=>t.status==='CLOSED').length!==a.closed
    ||!same(sum('sourceGross'),a.sourceGross)||!same(sum('sourceFee'),a.sourceFees)||!same(sum('sourceFunding'),a.sourceFunding)
    ||!same(sum('gross'),a.gross)||!same(sum('fee'),a.fees)||!same(sum('funding'),a.funding))
    throw new Error('旧反向账本不完整；禁止猜测迁移');
  const oldCash=fills.reduce((n,f)=>n+(f.kind==='OPEN'?-f.fee:f.gross-f.fee-f.funding),0),
    oldGross=sum('gross'),oldFees=sum('fee'),oldFunding=sum('funding'),oldTurnover=fills.reduce((n,f)=>n+f.quantity*f.price,0),
    oldWins=rows.filter(t=>t.status==='CLOSED'&&(t.netPnl??0)>0).length;
  for(const t of rows){
    const i=t.inverseCopy!,first=i.fills[0]!,sourceOpen=trial.source.positions.find(s=>s.id===i.sourceId);
    for(const f of i.fills){f.price=f.sourcePrice;f.gross=f.sourceGross===0?0:-f.sourceGross;f.fee=f.sourceFee;f.funding=0;f.spreadDrag=0;f.quoteAt=f.sourceQuoteAt;}
    t.entryPrice=first.sourcePrice;t.entryFee=first.sourceFee;t.fundingAllowance=0;
    const exits=i.fills.slice(1),reductions=exits.filter(f=>f.kind==='REDUCE');
    if(reductions.length){
      const old=t.realization,initialRisk=old?.initialRisk??t.plannedRisk;
      t.realization={version:'partial-realization-v1',initialQuantity:first.quantity,initialContracts:first.contracts,
        initialNotional:first.quantity*first.sourcePrice,initialMargin:first.quantity*first.sourcePrice/t.leverage,initialRisk,
        initialEntryFee:first.sourceFee,gross:reductions.reduce((n,f)=>n+f.gross,0),fees:reductions.reduce((n,f)=>n+f.fee,0),
        funding:0,sequence:reductions.length,fills:reductions.map((f,n)=>({sequence:n+1,at:f.sourceAt,quoteAt:f.sourceQuoteAt,
          price:f.sourcePrice,quantity:f.quantity,contracts:f.contracts,gross:f.gross,fee:f.fee,funding:0,reason:'SHADOW_REDUCTION'}))};
    }else delete t.realization;
    if(t.status==='CLOSED'){
      t.quantity=first.quantity;t.contracts=first.contracts;t.notional=first.quantity*first.sourcePrice;t.margin=t.notional/t.leverage;
      t.exitPrice=i.fills.at(-1)!.sourcePrice;t.lastPrice=t.exitPrice;t.lastQuoteAt=i.fills.at(-1)!.sourceQuoteAt;
      t.grossPnl=exits.reduce((n,f)=>n+f.gross,0);t.exitFee=exits.reduce((n,f)=>n+f.fee,0);t.netPnl=t.grossPnl-t.entryFee-t.exitFee;
    }else{
      const used=exits.reduce((n,f)=>n+f.quantity,0),usedContracts=exits.reduce((n,f)=>n+f.contracts,0);
      t.quantity=first.quantity-used;t.contracts=first.contracts-usedContracts;t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;
      if(sourceOpen&&finite(sourceOpen.lastPrice)&&sourceOpen.lastPrice>0){t.lastPrice=sourceOpen.lastPrice;t.lastQuoteAt=sourceOpen.lastQuoteAt;}
    }
  }
  const newGross=-a.sourceGross,newFees=a.sourceFees,newFunding=0,newTurnover=fills.reduce((n,f)=>n+f.quantity*f.sourcePrice,0),
    newCash=fills.reduce((n,f)=>n+(f.kind==='OPEN'?-f.sourceFee:-f.sourceGross-f.sourceFee),0),
    newWins=rows.filter(t=>t.status==='CLOSED'&&(t.netPnl??0)>0).length;
  state.balance+=newCash-oldCash;state.grossPnl+=newGross-oldGross;state.fees+=newFees-oldFees;
  state.fundingAllowance=Math.max(0,state.fundingAllowance-oldFunding);state.turnover+=newTurnover-oldTurnover;state.wins+=newWins-oldWins;
  a.gross=newGross;a.fees=newFees;a.funding=newFunding;a.spreadDrag=0;a.feeSavings=0;trial.accountingMode=MIRROR_ACCOUNTING_MODE;trial.reconciledAt=now;
  let sourceFloating=0;
  for(const t of state.positions){if(!t.inverseCopy)continue;const source=trial.source.positions.find(s=>s.id===t.inverseCopy!.sourceId);
    if(!source)throw new Error('同价迁移缺少影子持仓');sourceFloating+=dir(t.inverseCopy.sourceSide)*t.quantity*(source.lastPrice-t.inverseCopy.sourceEntryPrice);}
  const sourceNet=a.sourceGross+sourceFloating-a.sourceFees,inverseNet=a.gross-sourceFloating-a.fees;
  trial.curve=[{at:now,source:trial.initialComparisonEquity+sourceNet,inverse:trial.initialComparisonEquity+inverseNet,
    theoretical:trial.initialComparisonEquity+inverseNet}];trial.droppedCurvePoints=0;
  return true;
}

export function assertInverseTrade(t:Trade){
  const i=t.inverseCopy;if(!i)return;
  if(i.version!==SHADOW_INVERSE_VERSION||i.sourceBuild!==SHADOW_BASELINE_BUILD||t.id!==inverseId(i.sourceId)||t.side===i.sourceSide
    ||i.independentDecisions!==false||i.liveExecution!=='PAPER_ONLY'||!Array.isArray(i.fills)||i.fills.length<1||i.fills.length>4
    ||i.fills.some((f,n)=>f.sequence!==n||![f.sourceAt,f.appliedAt,f.quoteAt,f.sourcePrice,f.price,f.quantity,f.contracts,f.sourceGross,f.gross,f.fee,f.sourceFee,f.funding,f.sourceFunding,f.spreadDrag].every(finite)
      ||f.price<=0||f.sourcePrice<=0||f.quantity<=0||f.contracts<=0||f.fee<0||f.funding!==0||f.appliedAt<f.sourceAt||f.quoteAt>f.appliedAt
      ||!same(f.price,f.sourcePrice)||!same(f.gross,-f.sourceGross)||!same(f.spreadDrag,0)))
    throw new Error('反向配对账本格式错误；必须同价、反方向、仅实际手续费');
  const first=i.fills[0]!,exits=i.fills.slice(1),initial=t.realization?.initialQuantity??t.quantity;
  if(first.kind!=='OPEN'||!same(first.quantity,initial)||!same(first.fee,t.entryFee)||!same(first.price,t.entryPrice)
    ||first.sourceAt!==t.openedAt||!same(first.sourcePrice,i.sourceEntryPrice)
    ||exits.some((f,n)=>f.kind!==(t.status==='CLOSED'&&n===exits.length-1?'CLOSE':'REDUCE')
      ||f.sourceAt<i.fills[n]!.sourceAt||!same(f.gross,dir(t.side)*f.quantity*(f.price-t.entryPrice))
      ||!same(f.sourceGross,dir(i.sourceSide)*f.quantity*(f.sourcePrice-i.sourceEntryPrice)))
    ||i.fills.some(f=>!same(f.fee,f.price*f.quantity*recordedInverseFeeRate(f))||!same(f.sourceFee,f.sourcePrice*f.quantity*SHADOW_FEE_RATE)
      ||!same(f.contracts*t.quantoMultiplier,f.quantity)))throw new Error('反向成交与影子事件不一致');
  if(t.status==='OPEN'&&(!same(t.quantity+exits.reduce((n,f)=>n+f.quantity,0),first.quantity)
    ||!same(t.contracts+exits.reduce((n,f)=>n+f.contracts,0),first.contracts)||!same(t.contracts,i.sourceRemainingContracts)))
    throw new Error('反向剩余数量不守恒');
  if(t.status==='CLOSED'&&(i.fills.at(-1)?.kind!=='CLOSE'||!same(exits.reduce((n,f)=>n+f.quantity,0),initial)
    ||i.sourceClosedAt!==t.closedAt||i.sourceRemainingContracts!==0
    ||t.fundingAllowance!==0||!same(t.netPnl!,i.fills.reduce((n,f)=>n+f.gross-f.fee,0))))
    throw new Error('反向父单结算不一致');
}
export function assertInverseTrial(state:ForwardState){
  if(state.directStrategy){
    const ds=state.directStrategy;
    if(ds.eventResponse&&(ds.eventResponse.version!=='event-response-v1'||!finite(ds.eventResponse.cutoverAt)
      ||ds.eventResponse.cutoverAt<state.startedAt))
      throw new Error('事件响应执行记忆损坏；保留账户');
    if(ds.specialMove&&(ds.specialMove.version!=='special-move-v1'||!finite(ds.specialMove.cutoverAt)||ds.specialMove.cutoverAt<=0))
      throw new Error('特别币执行版本损坏；保留账户');
    if(ds.adaptive&&(ds.adaptive.version!=='adaptive-causal-v1'||!finite(ds.adaptive.cutoverAt)||ds.adaptive.cutoverAt<=0))
      throw new Error('自适应执行版本损坏；保留账户');
    if(ds.marketAuthority&&!validMarketAuthority(ds.marketAuthority))throw new Error('市场统一许可记忆损坏；保留账户');
    if(ds.version!=='dual-thesis-v2'||!finite(ds.cutoverAt)||ds.cutoverAt<state.startedAt||!ds.plans||Object.keys(ds.plans).length>30
      ||!finite(ds.completedConversions)||ds.completedConversions<0||!finite(ds.retiredAt)||!ds.summary)
      throw new Error('独立策略状态损坏；保留账户，禁止重置');
    if(ds.memory&&(Object.keys(ds.memory).length>30||Object.values(ds.memory).some(r=>!r||typeof r.id!=='string'||!r.id
      ||typeof r.continuationSeen!=='boolean'||(r.region&&(![r.region.lower,r.region.upper,r.region.center,r.region.formedAt].every(finite)
        ||r.region.lower<=0||r.region.upper<=r.region.lower)))))throw new Error('独立策略冻结事件记忆损坏');
    for(const [symbol,p] of Object.entries(ds.plans))if(!p||p.symbol!==symbol||p.candidate?.symbol!==symbol||p.id!==p.candidate.id
      ||!['RETURN','CONTINUATION'].includes(p.branch)||!['LONG','SHORT'].includes(p.side)||!finite(p.at)||!finite(p.quoteAt)
      ||!['OBSERVE','VALIDATING','READY','HOLDING','WAIT_LOCATION','EXECUTING'].includes(p.phase)||!p.reason||!p.holdReason||!p.exitCondition)
      throw new Error('独立研究计划损坏；禁止重新生成掩盖原始依据');
    const ids=new Set<string>();
    for(const t of [...state.positions,...state.history])if(t.unified?.version==='dual-thesis-v2'){
      const u=t.unified;
      if(u.response&&(!validResponseHolding(u.response)||u.response.eventId!==u.marketRoute?.eventId
        ||u.marketRoute.controllerVersion!=='event-response-v1'))throw new Error('事件持仓响应记忆损坏；保留账户');
      if(u.adaptive&&(u.adaptive.version!=='adaptive-causal-v1'
        ||![u.adaptive.adoptedAt,u.adaptive.holdingSupport,u.adaptive.holdingSupportAt,u.adaptive.sourceAt].every(finite)
        ||u.adaptive.holdingSupport<=0||u.adaptive.peakNetPnl!==null&&!finite(u.adaptive.peakNetPnl)
        ||!['UNOBSERVED','INTACT','PULLBACK','SUPPORT_BROKEN','RECOVERY_FAILED','RECOVERY_BUILDING'].includes(u.adaptive.premise)))
        throw new Error('自适应持仓依据损坏；保留账户与原保护');
      if(u.marketRoute&&(!validMarketRoute(u.marketRoute)||u.marketRoute.side!==t.side||u.marketRoute.branch!==u.branch
        ||!t.entryContext?.winnerPlan))throw new Error('实际方向市场许可不完整');
      if(!['RETURN','CONTINUATION'].includes(u.branch)||!u.sourceId||!u.entryReason||!u.holdReason||!u.exitCondition
        ||![t.entryPrice,t.quantity,t.contracts,t.quantoMultiplier,t.notional,t.leverage,t.margin,t.entryFee,t.exitFee,t.plannedRisk].every(finite)
        ||t.entryPrice<=0||t.quantity<=0||t.contracts<=0||t.leverage<1||t.entryFee<0||t.exitFee<0||t.plannedRisk<0
        ||!same(t.quantity,t.contracts*t.quantoMultiplier)||!same(t.notional,t.quantity*t.entryPrice)||!same(t.margin,t.notional/t.leverage)
        ||!Array.isArray(u.explanationEvents)||u.explanationEvents.length>8
        ||u.explanationEvents.some(e=>![e.at,e.quoteAt,e.price].every(finite)||e.price<=0||e.quoteAt>e.at)
        ||(!u.migratedAt&&!same(t.entryFee,(t.realization?.initialNotional??t.notional)*.0005))
        ||(u.branch==='RETURN'&&(!u.returnLogic||!['LONG','SHORT'].includes(u.returnLogic.moveSide)||!u.marketRoute&&u.returnLogic.moveSide===t.side
          ||!u.returnLogic.plan||![u.returnLogic.entryPrice,u.returnLogic.openedAt,u.returnLogic.peakAdvance,u.returnLogic.plan.initialStop,
            u.returnLogic.entryResidual,u.returnLogic.entryRelativeStrength,u.returnLogic.entryRemainingSpaceRate,u.returnLogic.entryScore].every(finite)
          ||u.returnLogic.entryPrice<=0||u.returnLogic.plan.initialStop<=0||u.returnLogic.peakAdvance<0))
        ||(u.branch==='CONTINUATION'&&(!u.marketRoute&&!u.region?.balanced||!u.confirmation||!finite(u.initialStop)||u.initialStop!<=0||!t.entryContext?.winnerPlan)))
        throw new Error('独立策略订单依据或资金不完整');
      if(t.status==='OPEN'){if(ids.has(t.symbol))throw new Error('独立策略同币重复持仓');ids.add(t.symbol);}
      else if(!finite(t.netPnl)||!finite(t.grossPnl)||!same(t.netPnl,t.grossPnl-t.entryFee-t.exitFee-t.fundingAllowance))
        throw new Error('独立策略结算不一致');
    }
    return; // Retired ledgers are provenance only; never an active pair invariant.
  }
  if(state.unifiedExecution){
    const u=state.unifiedExecution;
    if(u.version!=='return-continuation-v1'||!finite(u.cutoverAt)||u.cutoverAt<state.startedAt
      ||!u.reference||u.reference.startedAt!==state.startedAt||!Array.isArray(u.legacyIds)||!u.episodes
      ||Object.keys(u.episodes).length>300||u.reference.initialEquity!==state.initialEquity)
      throw new Error('统一策略或原反向对照损坏；保留账户，禁止重置');
    const activeIds=new Set<string>();
    for(const [id,e]of Object.entries(u.episodes))if(id!==e.sourceId||!e.symbol||!finite(e.createdAt)||!finite(e.epsilon)||e.epsilon<0
      ||typeof e.handled!=='boolean'||typeof e.ended!=='boolean')throw new Error('统一策略事件身份损坏');
    for(const t of [...state.positions,...state.history])if(t.unified){
      const m=t.unified;
      if(m.version!==u.version||!['RETURN','CONTINUATION'].includes(m.branch)||t.inverseCopy||!m.sourceId||!m.referenceId
        ||t.id!==`ue-${m.sourceId}-${m.branch==='RETURN'?'r':'c'}`||t.openedAt<u.cutoverAt
        ||![t.entryPrice,t.quantity,t.contracts,t.quantoMultiplier,t.notional,t.leverage,t.margin,t.plannedRisk,t.entryFee,t.exitFee,m.referenceContracts].every(finite)
        ||t.entryPrice<=0||t.quantity<=0||t.contracts<=0||t.leverage<1||t.plannedRisk<0||t.entryFee<0||t.exitFee<0
        ||!same(t.quantity,t.contracts*t.quantoMultiplier)||!same(t.notional,t.quantity*t.entryPrice)||!same(t.margin,t.notional/t.leverage)
        ||!same(t.entryFee,(t.realization?.initialNotional??t.notional)*.0005)
        ||!Array.isArray(m.explanationEvents)||m.explanationEvents.length<1||m.explanationEvents.length>8
        ||m.explanationEvents.some(e=>![e.at,e.quoteAt,e.price].every(finite)||e.price<=0||e.quoteAt>e.at)
        ||(m.branch==='CONTINUATION'&&(!m.region?.balanced||!m.confirmation||!finite(m.initialStop)||m.initialStop! <= 0||!t.entryContext?.winnerPlan)))
        throw new Error('统一策略订单决策或资金证据不完整');
      if(t.status==='OPEN'){
        if(!u.episodes[m.sourceId]||activeIds.has(m.sourceId))throw new Error('统一策略活动事件缺失或重复');activeIds.add(m.sourceId);
      }else if(!finite(t.grossPnl)||!finite(t.netPnl)||!finite(t.exitPrice)||!same(t.netPnl,t.grossPnl-t.entryFee-t.exitFee-t.fundingAllowance))
        throw new Error('统一策略退出资金不一致');
    }
    return assertInverseTrial({...state,...u.reference,unifiedExecution:undefined});
  }
  const t=state.inverseTrial;if(!t)return;
  if(t.version!==SHADOW_INVERSE_VERSION||t.sourceBuild!==SHADOW_BASELINE_BUILD||t.accountingMode!==MIRROR_ACCOUNTING_MODE
    ||!finite(t.reconciledAt)||!finite(t.cutoverAt)||t.cutoverAt<state.startedAt
    ||!finite(t.initialComparisonEquity)||!Array.isArray(t.legacyIds)||!Array.isArray(t.curve)||t.curve.length>720
    ||!t.source||!finite(t.source.balance)||!Array.isArray(t.source.positions)||!Array.isArray(t.source.history)
    ||!Object.values(t.totals).every(finite)||!Number.isSafeInteger(t.lastSourceRevision)||t.lastSourceRevision!==t.source.revision
    ||t.source.startedAt!==state.startedAt||t.source.initialEquity!==state.initialEquity
    ||['initialEquity','peakEquity','maxDrawdown','resolved','wins','grossPnl','fees','fundingAllowance','turnover'].some(k=>!finite((t.source as unknown as Record<string,unknown>)[k]))
    ||t.curve.some((p,n)=>![p.at,p.source,p.inverse,p.theoretical].every(finite)||p.at<t.cutoverAt||(n>0&&p.at<=t.curve[n-1]!.at))
    ||t.totals.closed>t.totals.opened||t.totals.opened-t.totals.closed!==state.positions.filter(p=>p.inverseCopy).length
    ||!same(t.totals.gross,-t.totals.sourceGross)||t.totals.fees<0||t.totals.sourceFees<0||(t.totals.feeSavings??0)<0
    ||!same(t.totals.fees+(t.totals.feeSavings??0),t.totals.sourceFees)||t.totals.funding!==0||t.totals.spreadDrag!==0)
    throw new Error('影子金融状态损坏；保留原账户，不重置试验');
  for(const source of t.source.positions){
    if(source.openedAt<t.cutoverAt||t.legacyIds.includes(source.id))continue;
    const mirror=state.positions.find(m=>m.inverseCopy?.sourceId===source.id);
    if(!mirror||!same(mirror.contracts,source.contracts)||!same(mirror.entryPrice,mirror.inverseCopy!.sourceEntryPrice))
      throw new Error('已提交影子与反向持仓配对缺失');
  }
  for(const mirror of state.positions){if(!mirror.inverseCopy)continue;
    const source=t.source.positions.find(s=>s.id===mirror.inverseCopy!.sourceId);
    if(!source||source.side===mirror.side||!same(source.quantity,mirror.quantity))throw new Error('反向持仓失去对应影子来源');
    assertInverseTrade(mirror);
  }
  for(const mirror of state.history)if(mirror.inverseCopy)assertInverseTrade(mirror);
}
