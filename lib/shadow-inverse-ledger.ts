/** Passive inverse PAPER accounting. No signal, independent exit or size choice. */
import type {ForwardState,Trade,Quote,AuditEvent} from './forward-relations.ts';
import {inversePaidFeeView} from './paid-fee-view.ts';

export const SHADOW_INVERSE_VERSION='shadow-inverse-v1';
export const SHADOW_BASELINE_BUILD='2b4fd60f77c9b78526bd5087940945fe7e86fab8';
export const INVERSE_COST={feeRate:.0007,fundingAllowancePerDay:.0002};
export type InverseFill={sequence:number;kind:'OPEN'|'REDUCE'|'CLOSE';sourceAt:number;appliedAt:number;
  administrative?:'ACCOUNT_RESET_QUOTE'|'ACCOUNT_RESET_SAVED_MARK';
  sourceQuoteAt:number;quoteAt:number;sourcePrice:number;price:number;quantity:number;contracts:number;
  sourceGross:number;gross:number;sourceFee:number;fee:number;sourceFunding:number;funding:number;spreadDrag:number};
export type InverseCopy={version:typeof SHADOW_INVERSE_VERSION;sourceBuild:typeof SHADOW_BASELINE_BUILD;sourceId:string;
  cutoverAt:number;sourceSide:'LONG'|'SHORT';sourceEntryPrice:number;sourceStopPrice:number;sourceTargetPrice:number|null;
  sourceEntryPlan:Trade['entryContext'];sourceExitReason:string|null;sourceExitAudit?:Trade['exitAudit'];
  sourceRemainingContracts:number;fills:InverseFill[];sourceClosedAt:number|null;independentDecisions:false;liveExecution:'PAPER_ONLY'};

/** Market memory is shared once. Every wallet/history-dependent variable is
 * instead supplied by the source's own capsule, never the inverse wallet. */
export const SHARED_MARKET_KEYS=['extremumRegime','hypothesisResearch','environmentContext','marketPulse','selectedSymbols',
  'opportunities','entryValidations','entryDiagnostics','relationEngine','lastCycleAt','lastQuoteCycleAt','lastCandleAt','fitDiagnostics'] as const;
export type ShadowCapsule=Omit<ForwardState,typeof SHARED_MARKET_KEYS[number]|'inverseTrial'>;
export type InverseTotals={sourceGross:number;sourceFees:number;sourceFunding:number;gross:number;fees:number;funding:number;
  spreadDrag:number;opened:number;closed:number;reductions:number};
export type InverseTrial={version:typeof SHADOW_INVERSE_VERSION;sourceBuild:typeof SHADOW_BASELINE_BUILD;cutoverAt:number;
  initialComparisonEquity:number;legacyIds:string[];source:ShadowCapsule;totals:InverseTotals;
  curve:{at:number;source:number;inverse:number;theoretical:number}[];droppedCurvePoints:number;lastSourceRevision:number};
const dir=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const same=(a:number,b:number)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
export const inverseId=(sourceId:string)=>`iv-${sourceId}`;
export function shadowCapsule(state:ForwardState):ShadowCapsule{
  const row={...state} as Record<string,unknown>;delete row.inverseTrial;
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
  return{version:SHADOW_INVERSE_VERSION,sourceBuild:SHADOW_BASELINE_BUILD,cutoverAt:now,initialComparisonEquity:equity,
    legacyIds:state.positions.map(t=>t.id),source:shadowCapsule(state),lastSourceRevision:state.revision,
    totals:{sourceGross:0,sourceFees:0,sourceFunding:0,gross:0,fees:0,funding:0,spreadDrag:0,opened:0,closed:0,reductions:0},
    curve:[{at:now,source:equity,inverse:equity,theoretical:equity}],droppedCurvePoints:0};
}
function event(state:ForwardState,now:number,kind:AuditEvent['kind'],trade:Trade,reason:string){
  state.revision++;state.events.unshift({id:`a${state.startedAt}-${state.revision}`,at:now,kind,subject:trade.id,reason,
    detail:{sourceId:trade.inverseCopy!.sourceId,sourceBuild:SHADOW_BASELINE_BUILD,execution:SHADOW_INVERSE_VERSION}});
  state.events=state.events.slice(0,160);
}
function executable(q:Quote|undefined,now:number){
  if(!q||!q.fresh||!finite(q.bestBid)||!finite(q.bestAsk)||q.bestBid<=0||q.bestAsk<q.bestBid||q.observedAt>now||now-q.observedAt>10_000)
    throw new Error('反向配对缺少同事件新鲜买卖报价；原金融状态不提交');
  return q;
}
function addFill(state:ForwardState,t:Trade,source:Trade,kind:InverseFill['kind'],quantity:number,contracts:number,
  sourcePrice:number,sourceAt:number,sourceQuoteAt:number,q:Quote,now:number,administrative?:{price:number;mode:InverseFill['administrative']}){
  if(sourceAt!==now)throw new Error('反向复制禁止用当前价格伪造历史成交');
  const i=t.inverseCopy!,isOpen=kind==='OPEN',price=administrative?.price??(isOpen?(t.side==='LONG'?q.bestAsk:q.bestBid):(t.side==='LONG'?q.bestBid:q.bestAsk)),
    sourceGross=isOpen?0:dir(source.side)*quantity*(sourcePrice-source.entryPrice),gross=isOpen?0:dir(t.side)*quantity*(price-t.entryPrice),
    sourceFee=quantity*sourcePrice*INVERSE_COST.feeRate,fee=quantity*price*INVERSE_COST.feeRate,
    days=Math.max(0,sourceAt-source.openedAt)/86_400_000,
    sourceFunding=isOpen?0:quantity*source.entryPrice*INVERSE_COST.fundingAllowancePerDay*days,
    funding=isOpen?0:quantity*t.entryPrice*INVERSE_COST.fundingAllowancePerDay*days,
    // Attribution only: never debit this spread number again.
    spreadDrag=isOpen?0:-(sourceGross+gross),
    fill:InverseFill={sequence:i.fills.length,kind,sourceAt,appliedAt:now,sourceQuoteAt,quoteAt:q.observedAt,
      sourcePrice,price,quantity,contracts,sourceGross,gross,sourceFee,fee,sourceFunding,funding,spreadDrag,
      ...(administrative?{administrative:administrative.mode}:{})};
  i.fills.push(fill);const a=state.inverseTrial!.totals;
  a.sourceGross+=sourceGross;a.sourceFees+=sourceFee;a.sourceFunding+=sourceFunding;
  a.gross+=gross;a.fees+=fee;a.funding+=funding;a.spreadDrag+=spreadDrag;
  state.balance+=gross-fee-funding;state.grossPnl+=gross;state.fees+=fee;state.fundingAllowance+=funding;
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
  const q=manualReset?(resetFresh?qIn!: {bestBid:t!.lastPrice,bestAsk:t!.lastPrice,observedAt:t!.lastQuoteAt,fresh:false} as Quote)
    :!t||reductions.length>already||source.status==='CLOSED'?executable(qIn,now):null;
  if(!t){
    const side=source.side==='LONG'?'SHORT':'LONG',price=side==='LONG'?q!.bestAsk:q!.bestBid,
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
      exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,lastPrice:price,lastQuoteAt:q!.observedAt,
      plannedRisk:source.realization?.initialRisk??source.plannedRisk,favorable:0,adverse:0,firstProfitAt:null,profitFloorRate:0,peakPnlRate:0,
      entryContext:context,rule:{...source.rule,id,side,reason:context?.reason??'影子反向复制'},
      exitControl:{policy:SHADOW_INVERSE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30000,maxQuoteAgeMs:10000},
      inverseCopy:{version:SHADOW_INVERSE_VERSION,sourceBuild:SHADOW_BASELINE_BUILD,sourceId:source.id,cutoverAt:trial.cutoverAt,
        sourceSide:source.side,sourceEntryPrice:source.entryPrice,sourceStopPrice:source.stopPrice,
        sourceTargetPrice:source.entryContext?.winnerPlan?.target??null,sourceEntryPlan:structuredClone(source.entryContext),
        sourceExitReason:null,sourceRemainingContracts:contracts,sourceClosedAt:null,fills:[],independentDecisions:false,liveExecution:'PAPER_ONLY'}};
    delete t.review;delete t.winnerManagement;delete t.positionIntelligence;delete t.realization;delete t.holdValue;
    delete t.liquidityLifecycle;delete t.profitLifecycle;delete t.profitProtection;delete t.profitProtectionMigration;delete t.exitAudit;delete t.exitPlan;
    addFill(state,t,source,'OPEN',quantity,contracts,source.entryPrice,source.openedAt,source.review?.timeline[0]?.quoteAt??q!.observedAt,q!,now);
    if(!same(t.inverseCopy!.fills[0]!.sourceFee,source.entryFee))throw new Error('影子入场费用不符合固定源账本');
    trial.totals.opened++;state.positions.push(t);event(state,now,'ENTRY',t,`${source.symbol} 影子反向开仓`);
  }
  for(const sf of reductions.slice(already)){
    if(sf.quantity<=0||sf.quantity>=t.quantity||sf.contracts<=0||sf.contracts>=t.contracts)throw new Error('反向减仓数量与父单不一致');
    const f=addFill(state,t,source,'REDUCE',sf.quantity,sf.contracts,sf.price,sf.at,sf.quoteAt,q!,now),
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
      f=addFill(state,t,source,'CLOSE',t.quantity,t.contracts,source.exitPrice!,source.closedAt!,finite(sq)?sq:q!.observedAt,q!,now,
        manualReset?{price:resetFresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice,mode:resetFresh?'ACCOUNT_RESET_QUOTE':'ACCOUNT_RESET_SAVED_MARK'}:undefined),r=t.realization;
    t.status='CLOSED';t.closedAt=now;t.exitPrice=f.price;t.lastPrice=f.price;t.lastQuoteAt=f.quoteAt;
    t.grossPnl=(r?.gross??0)+f.gross;t.exitFee=(r?.fees??0)+f.fee;t.fundingAllowance=(r?.funding??0)+f.funding;
    t.netPnl=t.grossPnl-t.entryFee-t.exitFee-t.fundingAllowance;t.exitReason=manualReset?'ACCOUNT_RESET':'SHADOW_SOURCE_EXIT';
    i.sourceClosedAt=source.closedAt;i.sourceExitReason=source.exitReason;i.sourceExitAudit=structuredClone(source.exitAudit);
    if(!same(source.netPnl!,i.fills.reduce((n,f)=>n+f.sourceGross-f.sourceFee-f.sourceFunding,0)))throw new Error('影子父单净额与逐次实际成交不一致');
    t.exitAudit={trigger:t.exitReason,at:now,evidence:{authority:SHADOW_INVERSE_VERSION,sourceId:source.id,sourceReason:source.exitReason,administrative:manualReset,
      sourceClosedAt:source.closedAt,sourceBuild:SHADOW_BASELINE_BUILD,quoteAt:q!.observedAt}};
    if(r){t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.notional=r.initialNotional;t.margin=r.initialMargin;t.plannedRisk=r.initialRisk;}
    state.positions=state.positions.filter(x=>x.id!==id);state.history.unshift(t);state.history=state.history.slice(0,240);
    state.resolved++;if(t.netPnl>0)state.wins++;trial.totals.closed++;event(state,now,'EXIT',t,`${source.symbol} 跟随影子平仓`);
  }else if(!same(t.contracts,source.contracts)||!same(t.quantity,source.quantity))throw new Error('影子与反向剩余数量不一致');
  assertInverseTrade(t);
}
export function markInversePositions(state:ForwardState,quotes:Record<string,Quote>,now:number){
  for(const t of state.positions){if(!t.inverseCopy)continue;const q=quotes[t.symbol];
    if(!q?.fresh||q.observedAt>now||now-q.observedAt>10000||q.bestBid<=0||q.bestAsk<q.bestBid)continue;
    t.lastPrice=t.side==='LONG'?q.bestBid:q.bestAsk;t.lastQuoteAt=q.observedAt;
    const signed=dir(t.side)*(t.lastPrice/t.entryPrice-1);t.favorable=Math.max(t.favorable,signed);t.adverse=Math.max(t.adverse,-signed);
    t.peakPnlRate=t.favorable;if(!t.firstProfitAt&&signed>INVERSE_COST.feeRate*2)t.firstProfitAt=now;
  }
}
export function inverseTrialSummary(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const v=state.inverseTrial;if(!v)return null;const a=v.totals;
  let sourceFloating=0,inverseFloating=0,openSourceFees=0,stale=0;
  for(const t of state.positions){if(!t.inverseCopy)continue;const q=quotes[t.symbol],fresh=!!q&&q.fresh&&q.observedAt<=now&&now-q.observedAt<=10000;
    if(!fresh)stale++;const i=t.inverseCopy,source=v.source.positions.find(s=>s.id===i.sourceId),
      sp=fresh?(i.sourceSide==='LONG'?q!.bestBid:q!.bestAsk):source?.lastPrice??i.sourceEntryPrice,
      ip=fresh?(t.side==='LONG'?q!.bestBid:q!.bestAsk):t.lastPrice;
    openSourceFees+=t.quantity*sp*INVERSE_COST.feeRate;
    sourceFloating+=dir(i.sourceSide)*t.quantity*(sp-i.sourceEntryPrice)-t.quantity*sp*INVERSE_COST.feeRate;
    inverseFloating+=dir(t.side)*t.quantity*(ip-t.entryPrice)-t.quantity*ip*INVERSE_COST.feeRate;
  }
  const sourceNet=a.sourceGross-a.sourceFees-a.sourceFunding+sourceFloating,inverseNet=a.gross-a.fees-a.funding+inverseFloating,
    theoretical=-sourceNet-2*(a.sourceFees+a.sourceFunding+openSourceFees),
    expected=-(a.sourceFees+a.fees+a.sourceFunding+a.funding+a.spreadDrag),
    residual=(a.sourceGross-a.sourceFees-a.sourceFunding)+(a.gross-a.fees-a.funding)-expected;
  return{paidCost:inversePaidFeeView(state,quotes,now),version:v.version,sourceBuild:v.sourceBuild,cutoverAt:v.cutoverAt,initialEquity:v.initialComparisonEquity,
    sourceEquity:v.initialComparisonEquity+sourceNet,inverseEquity:v.initialComparisonEquity+inverseNet,
    theoreticalSamePriceEquity:v.initialComparisonEquity+theoretical,sourceNet,inverseNet,
    sourceFees:a.sourceFees,inverseFees:a.fees,sourceFunding:a.sourceFunding,inverseFunding:a.funding,
    realizedSpreadDrag:a.spreadDrag,settledAttributionResidual:residual,pairedOpened:a.opened,pairedClosed:a.closed,
    pairedOpen:state.positions.filter(t=>t.inverseCopy).length,reductions:a.reductions,
    legacyOpen:state.positions.filter(t=>!t.inverseCopy).length,stalePositions:stale,
    sourceDecisionBalance:v.source.balance,sourceDecisionResolved:v.source.resolved,
    curve:v.curve,droppedCurvePoints:v.droppedCurvePoints,independentDecisions:false,liveExecution:'PAPER_ONLY' as const,
    costModel:'Each leg pays its own 7bp fees and adverse 2bp/day funding allowance; opposite BBO, no depth/slippage guarantee.',
    scope:'Paired trades born after cutover only. Existing account curve and legacy holdings remain separate.'};
}
export function recordInverseCurve(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const v=state.inverseTrial,x=inverseTrialSummary(state,quotes,now);if(!v||!x||x.stalePositions)return;
  if(now-(v.curve.at(-1)?.at??0)<60_000)return;
  v.curve.push({at:now,source:x.sourceEquity,inverse:x.inverseEquity,theoretical:x.theoreticalSamePriceEquity});
  while(v.curve.length>720){v.curve.splice(1,1);v.droppedCurvePoints++;}
}
export function assertInverseTrade(t:Trade){
  const i=t.inverseCopy;if(!i)return;
  if(i.version!==SHADOW_INVERSE_VERSION||i.sourceBuild!==SHADOW_BASELINE_BUILD||t.id!==inverseId(i.sourceId)||t.side===i.sourceSide
    ||i.independentDecisions!==false||i.liveExecution!=='PAPER_ONLY'||!Array.isArray(i.fills)||i.fills.length<1||i.fills.length>4
    ||i.fills.some((f,n)=>f.sequence!==n||![f.sourceAt,f.appliedAt,f.quoteAt,f.sourcePrice,f.price,f.quantity,f.contracts,f.sourceGross,f.gross,f.fee,f.sourceFee,f.funding,f.sourceFunding,f.spreadDrag].every(finite)
      ||f.price<=0||f.sourcePrice<=0||f.quantity<=0||f.contracts<=0||f.fee<0||f.funding<0||f.appliedAt<f.sourceAt||f.quoteAt>f.appliedAt))throw new Error('反向配对账本格式错误；禁止自动重建');
  const first=i.fills[0]!,exits=i.fills.slice(1),initial=t.realization?.initialQuantity??t.quantity;
  if(first.kind!=='OPEN'||!same(first.quantity,initial)||!same(first.fee,t.entryFee)||!same(first.price,t.entryPrice)
    ||first.sourceAt!==t.openedAt||!same(first.sourcePrice,i.sourceEntryPrice)
    ||exits.some((f,n)=>f.kind!==(t.status==='CLOSED'&&n===exits.length-1?'CLOSE':'REDUCE')
      ||f.sourceAt<i.fills[n]!.sourceAt||!same(f.gross,dir(t.side)*f.quantity*(f.price-t.entryPrice))
      ||!same(f.sourceGross,dir(i.sourceSide)*f.quantity*(f.sourcePrice-i.sourceEntryPrice))
      ||!same(f.sourceGross+f.gross+f.spreadDrag,0))
    ||i.fills.some(f=>!same(f.fee,f.price*f.quantity*INVERSE_COST.feeRate)||!same(f.sourceFee,f.sourcePrice*f.quantity*INVERSE_COST.feeRate)
      ||!same(f.contracts*t.quantoMultiplier,f.quantity)))throw new Error('反向成交与原始数量或费用不一致');
  if(t.status==='OPEN'&&(!same(t.quantity+exits.reduce((n,f)=>n+f.quantity,0),first.quantity)
    ||!same(t.contracts+exits.reduce((n,f)=>n+f.contracts,0),first.contracts)||!same(t.contracts,i.sourceRemainingContracts)))
    throw new Error('反向剩余数量不守恒');
  if(t.status==='CLOSED'&&(i.fills.at(-1)?.kind!=='CLOSE'||!same(exits.reduce((n,f)=>n+f.quantity,0),initial)
    ||i.sourceClosedAt!==t.closedAt||i.sourceRemainingContracts!==0
    ||!same(t.netPnl!,i.fills.reduce((n,f)=>n+f.gross-f.fee-f.funding,0))))throw new Error('反向父单结算不一致');
}
export function assertInverseTrial(state:ForwardState){
  const t=state.inverseTrial;if(!t)return;
  if(t.version!==SHADOW_INVERSE_VERSION||t.sourceBuild!==SHADOW_BASELINE_BUILD||!finite(t.cutoverAt)||t.cutoverAt<state.startedAt
    ||!finite(t.initialComparisonEquity)||!Array.isArray(t.legacyIds)||!Array.isArray(t.curve)||t.curve.length>720
    ||!t.source||!finite(t.source.balance)||!Array.isArray(t.source.positions)||!Array.isArray(t.source.history)
    ||!Object.values(t.totals).every(finite)||!Number.isSafeInteger(t.lastSourceRevision)||t.lastSourceRevision!==t.source.revision
    ||t.source.startedAt!==state.startedAt||t.source.initialEquity!==state.initialEquity
    ||['initialEquity','peakEquity','maxDrawdown','resolved','wins','grossPnl','fees','fundingAllowance','turnover'].some(k=>!finite((t.source as unknown as Record<string,unknown>)[k]))
    ||t.curve.some((p,n)=>![p.at,p.source,p.inverse,p.theoretical].every(finite)||p.at<t.cutoverAt||(n>0&&p.at<=t.curve[n-1]!.at))
    ||t.totals.closed>t.totals.opened||t.totals.opened-t.totals.closed!==state.positions.filter(p=>p.inverseCopy).length)
    throw new Error('影子金融状态损坏；保留原账户，不重置试验');
  for(const source of t.source.positions){
    if(source.openedAt<t.cutoverAt||t.legacyIds.includes(source.id))continue;
    const mirror=state.positions.find(m=>m.inverseCopy?.sourceId===source.id);
    if(!mirror||!same(mirror.contracts,source.contracts))throw new Error('已提交影子与反向持仓配对缺失');
  }
  for(const mirror of state.positions){if(!mirror.inverseCopy)continue;
    const source=t.source.positions.find(s=>s.id===mirror.inverseCopy!.sourceId);
    if(!source||source.side===mirror.side||!same(source.quantity,mirror.quantity))throw new Error('反向持仓失去对应影子来源');
    assertInverseTrade(mirror);
  }
}