/** Passive decision-account accounting. The engine proposes. Research scores the
 * proposal 30 minutes later by price. The desk stance chooses the next order's
 * side. New copies use desk exits; copies already open keep the old 5U/10U path. */
import type {ForwardState,Trade,Quote,AuditEvent} from './forward-relations.ts';
import {inversePaidFeeView} from './paid-fee-view.ts';
import {type RegimeOpen} from './confirmation-reality.ts';
import {DESK_ORDER_POLICY,ROUND_TRIP_COST,CLAIM_HORIZON_MS,HOLD_HORIZON_MS,attachProposal,ensureResearchDesk,readNarrative} from './research-decision.ts';
import {SHADOW_FEE_RATE,INVERSE_COST,INVERSE_FEE_POLICY,LIVE_EXECUTION_GAP_RATE,LIVE_EXECUTION_GAP_POLICY,recordedInverseFeeRate,recordedSourceFeeRate,type InverseFeeStamp} from './inverse-fee.ts';
import {FIXED_ALLOCATION_EQUITY,FIXED_ALLOCATION_POLICY} from './fixed-allocation.ts';
import type {InverseLossResearch} from './inverse-loss-research.ts';
export {INVERSE_COST} from './inverse-fee.ts';

export const SHADOW_INVERSE_VERSION='shadow-inverse-v1';
export const SHADOW_BASELINE_BUILD='2b4fd60f77c9b78526bd5087940945fe7e86fab8';
export const MIRROR_ACCOUNTING_MODE='same-source-price-fee-only-v1' as const;
const SOURCE_FUNDING_ALLOWANCE_PER_DAY=.0002;
export type InverseFill=InverseFeeStamp & {sequence:number;kind:'OPEN'|'REDUCE'|'CLOSE';sourceAt:number;appliedAt:number;
  administrative?:'ACCOUNT_RESET_QUOTE'|'ACCOUNT_RESET_SAVED_MARK';earlySoftLoss?:true;
  sourceQuoteAt:number;quoteAt:number;sourcePrice:number;price:number;quantity:number;contracts:number;
  sourceGross:number;gross:number;sourceFee:number;fee:number;sourceFunding:number;funding:number;spreadDrag:number};
export type InverseCopy={version:typeof SHADOW_INVERSE_VERSION;sourceBuild:typeof SHADOW_BASELINE_BUILD;sourceId:string;
  lossResearch?:InverseLossResearch;
  lossResearchHotOmitted?:true;
  cutoverAt:number;sourceSide:'LONG'|'SHORT';sourceEntryPrice:number;sourceStopPrice:number;sourceTargetPrice:number|null;
  sourceEntryPlan:Trade['entryContext'];sourceExitReason:string|null;sourceExitAudit?:Trade['exitAudit'];
  sourceRemainingContracts:number;fills:InverseFill[];sourceClosedAt:number|null;independentDecisions:false;liveExecution:'PAPER_ONLY';
  /** WITH_SOURCE: this copy takes the proposal's own side. Absent or AGAINST means the opposite copy. */
  alignment?:'AGAINST_SOURCE'|'WITH_SOURCE';
  /** desk-v1 copies use the research exit. Older copies keep 5U-if-source-soft, 10U, and the source exit. */
  orderPolicy?:typeof DESK_ORDER_POLICY;
  /** Frozen source stop at entry. A later source stop move does not move this. */
  confirmExtreme?:number;
  detachedRemainingQuantity?:number;detachedRemainingContracts?:number;detachedSourceSequence?:number;detachedSourceClosed?:boolean;
  /** Research only: quantity/notional the cut inverse would have closed at had it kept following the source. */
  detachedHoldQuantity?:number;detachedHoldNotional?:number;
  /** Set on copies born after the executable-price cutover: inverse fills at its own executable book side, not the source price. */
  pricePolicy?:typeof INVERSE_PRICE_POLICY};

/** Market memory is shared once. Every wallet/history-dependent variable is
 * instead supplied by the source's own capsule, never the inverse wallet. */
export const SHARED_MARKET_KEYS=['extremumRegime','hypothesisResearch','environmentContext','marketPulse','selectedSymbols',
  'opportunities','entryValidations','entryDiagnostics','relationEngine','lastCycleAt','lastQuoteCycleAt','lastCandleAt','fitDiagnostics'] as const;
export type ShadowCapsule=Omit<ForwardState,typeof SHARED_MARKET_KEYS[number]|'inverseTrial'>;
export type InverseTotals={sourceGross:number;sourceFees:number;sourceFunding:number;gross:number;fees:number;funding:number;feeSavings?:number;
  spreadDrag:number;opened:number;closed:number;reductions:number;
  detachedGross?:number;detachedFees?:number;detachedSourceGross?:number;detachedSourceFees?:number;detachedSourceFunding?:number;
  /** Executable-book copies: their gross and fee no longer mirror the source, so they are carried apart from the same-price identity. */
  executableGross?:number;executableSourceGross?:number;executableFeeDelta?:number};
export type InverseTrial={version:typeof SHADOW_INVERSE_VERSION;sourceBuild:typeof SHADOW_BASELINE_BUILD;cutoverAt:number;
  accountingMode?:typeof MIRROR_ACCOUNTING_MODE;reconciledAt?:number;
  initialComparisonEquity:number;legacyIds:string[];source:ShadowCapsule;totals:InverseTotals;
  curve:{at:number;source:number;inverse:number;theoretical:number}[];droppedCurvePoints:number;lastSourceRevision:number;
  comparisonFeesAligned?:'both-live-5bp-v1';entryHaltSkipped?:string[];detachedSourceIds?:string[];regimeOpens?:RegimeOpen[];
  regimeClock?:{pauseUntil:number;followUntil:number};
  forwardStudy?:import('./forward-study.ts').ForwardStudy;
  researchDesk?:import('./research-decision.ts').ResearchDesk;
  /** Own paper books ignore proposal opens. Absent keeps the proposal copy. */
  paperPolicy?:'needle-v1'|'brain-v1'|'score-v1'|'read-v1'|'reverse-v1'|'stretch-v1'|'lsr-v1';needleSeen?:string[];needleCooldown?:Record<string,number>;
  brainSeen?:string[];brainNote?:string;brainIdeas?:{symbol:string;side:'LONG'|'SHORT';kind:'FADE'|'LEAD'|'CATCH';why:string;wrong:string}[];
  brainPasses?:{id:string;at:number;symbol:string;side:'LONG'|'SHORT';kind:'FADE'|'LEAD'|'CATCH';tone:'TOGETHER_UP'|'TOGETHER_DOWN'|'SPLIT';age:'STARTED'|'ONGOING'|'DONE'|'QUIET';crowd:'LONG'|'SHORT'|'NONE';price:number;whyNot:string;laterAt?:number;laterPrice?:number;laterMove?:number}[];
  work?:import('./forward-study.ts').WorkSheet;
  /** score-v1: one result per half-hour window. Not one result per coin. */
  scoreNote?:string;scoreSkip?:number;scoreSamples?:ScoreSample[];scoreOpen?:ScoreWindow|null;
  /** read-v1: one reading of the current stretch. Not a window score. */
  readNote?:string;readWave?:string;readSpent?:string[];readNextAt?:number;readGross?:number;readFee?:number;readClosed?:number;readMode?:'FOLLOW'|'REVERSE'|'STOP';
  /** stretch-v1: BTC's two-hour stretch, then at most two larger followers. */
  stretchNote?:string;stretchSeen?:string[];
  /** lsr-v1: fade a completed 15-minute extreme after an 8-second sweep. */
  lsrNote?:string;lsrSeen?:string[];lsrMp?:{s:string;at:number;mp:number;bid:number;ask:number}[];
  lsrCool?:Record<string,number>;lsrDayVol?:number;lsrMiss?:{s:string;at:number}[];
  lsrW?:number[];lsrMean?:number[];lsrStd?:number[];lsrFitAt?:number;
  lsrLearn?:{x:number[];y:number}[];lsrPend?:{s:string;at:number;mid:number;x:number[]}[];
  lsrLast?:{s:string;side:'LONG'|'SHORT';at:number}[];
  lsrWork?:{s:string;side:'LONG'|'SHORT';price:number;at:number;key:string;why:string;bar:number}[];
  lsrDay?:string;lsrDayNet?:number;lsrLosses?:number;lsrPauseUntil?:number;
  lsrLog?:import('./run-log.ts').RunEvent[];lsrFunnel?:import('./run-log.ts').RunFunnel;
  swings?:EquitySwing[];swingArm?:{source?:SwingArm;inverse?:SwingArm}};
export type ScoreHit=[number,number,number,number];
export type ScoreCoin={symbol:string;residual:number;ref:number;dir:1|-1;up:ScoreHit;dn:ScoreHit};
export type ScoreWindow={start:number;coins:ScoreCoin[]};
export type ScoreSample={start:number;n:number;med:[number,number,number,number]};
export type EquitySwing={at:number;book:'source'|'inverse';kind:'PEAK'|'TROUGH';equity:number};
export type SwingArm={at:number;equity:number;side:'FLAT'|'HIGH'|'LOW'};
const dir=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const same=(a:number,b:number)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
export const inverseId=(sourceId:string)=>`iv-${sourceId}`;
export const INVERSE_SOFT_LOSS_GROSS=5;
/** New inverse copies fill where a real order can: buy at the ask, sell at the bid.
 * The source fills one side of the book, so the inverse pays the observed spread on every fill.
 * Without a fresh book the measured live gap is used instead. Older copies keep same-price accounting. */
export const INVERSE_PRICE_POLICY='executable-book-v1' as const;
export const executableCopy=(t:Trade)=>t.inverseCopy?.pricePolicy===INVERSE_PRICE_POLICY;
export function bookSpread(q:Quote|undefined,now:number,ref:number){
  return q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000?q.bestAsk-q.bestBid:ref*LIVE_EXECUTION_GAP_RATE;
}
export function executablePrice(sourcePrice:number,spread:number,buy:boolean){
  const s=finite(spread)&&spread>0?Math.min(spread,sourcePrice*.05):0;
  return buy?sourcePrice+s:sourcePrice-s;
}
/** Hard backstop: cut the inverse leg at this gross floating loss even if the shadow is still strong. */
export const INVERSE_HARD_LOSS_GROSS=10;
const earlyLoss=(t:Trade)=>!!t.inverseCopy?.fills.some(f=>f.earlySoftLoss);
function noteDetachedSource(state:ForwardState,sourceId:string){
  const trial=state.inverseTrial;if(!trial)return;
  const ids=trial.detachedSourceIds??[];
  if(!ids.includes(sourceId))ids.push(sourceId);
  trial.detachedSourceIds=ids.slice(-400);
}
function keepInverseHistory(state:ForwardState,closed:Trade){
  const open=new Set(state.inverseTrial?.source.positions.map(p=>p.id)??[]);
  const detached=(t:Trade)=>!!t.inverseCopy?.fills?.some(f=>f.earlySoftLoss)&&open.has(t.inverseCopy!.sourceId);
  const rows=[closed,...state.history.filter(t=>t.id!==closed.id)];
  const head=rows.slice(0,240),seen=new Set(head.map(t=>t.id));
  state.history=[...head,...rows.filter(t=>detached(t)&&!seen.has(t.id))];
}
/** Saved books keep only the hot close window. An inverse leg cut at 5U/10U
 * while its source is still open must stay paired after that window drops the
 * receipt. No second copy is opened and no fill is invented. */
export function retainDetachedSourceIds(state:ForwardState){
  const trial=state.inverseTrial;if(!trial)return;
  const open=new Set(trial.source.positions.map(p=>p.id));
  const ids=new Set((trial.detachedSourceIds??[]).filter(id=>open.has(id)));
  for(const row of state.history){
    const id=row.inverseCopy?.sourceId;
    if(id&&open.has(id)&&row.inverseCopy?.fills?.some(f=>f.earlySoftLoss))ids.add(id);
  }
  const skipped=new Set(trial.entryHaltSkipped??[]);
  for(const source of trial.source.positions){
    if(source.openedAt<trial.cutoverAt||trial.legacyIds.includes(source.id)||skipped.has(source.id)||ids.has(source.id))continue;
    if(state.positions.some(m=>m.inverseCopy?.sourceId===source.id))continue;
    if(state.history.some(m=>m.inverseCopy?.sourceId===source.id&&m.inverseCopy.fills.some(f=>f.earlySoftLoss)))continue;
    ids.add(source.id);
  }
  if(ids.size)trial.detachedSourceIds=[...ids].slice(-400);
  else delete trial.detachedSourceIds;
}
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
/** Frozen receipts are 7bp or already 5bp. The comparison books both legs at the live 5bp taker. */
function comparisonSourceFee(quantity:number,price:number,frozenFee:number){
  const live=quantity*price*INVERSE_COST.feeRate,legacy=quantity*price*SHADOW_FEE_RATE;
  if(!same(frozenFee,live)&&!same(frozenFee,legacy))throw new Error('影子成交手续费与固定源账本不一致');
  return live;
}
const frozenFeeOf=(f:InverseFill)=>f.frozenSourceFee??f.sourceFee;
function addFill(state:ForwardState,t:Trade,source:Trade,kind:InverseFill['kind'],quantity:number,contracts:number,
  sourcePrice:number,sourceAt:number,sourceQuoteAt:number,now:number,chargedSourceFee:number,administrative?:InverseFill['administrative'],spread=0){
  if(sourceAt!==now)throw new Error('反向复制禁止用当前事件伪造历史成交');
  if(!finite(sourcePrice)||sourcePrice<=0||!finite(sourceQuoteAt)||sourceQuoteAt>sourceAt)throw new Error('影子成交回执无效');
  const i=t.inverseCopy!,isOpen=kind==='OPEN',exec=executableCopy(t),
    price=exec?executablePrice(sourcePrice,spread,isOpen?t.side==='LONG':t.side==='SHORT'):sourcePrice,
    sourceGross=isOpen?0:dir(source.side)*quantity*(sourcePrice-source.entryPrice),
    gross=isOpen?0:exec?dir(t.side)*quantity*(price-t.entryPrice):sourceGross===0?0:-sourceGross,
    sourceFee=comparisonSourceFee(quantity,sourcePrice,chargedSourceFee),fee=quantity*price*INVERSE_COST.feeRate,
    days=Math.max(0,sourceAt-source.openedAt)/86_400_000,
    sourceFunding=isOpen?0:quantity*source.entryPrice*SOURCE_FUNDING_ALLOWANCE_PER_DAY*days,
    funding=0,spreadDrag=quantity*Math.abs(price-sourcePrice),
    fill:InverseFill={sequence:i.fills.length,kind,sourceAt,appliedAt:now,sourceQuoteAt,quoteAt:sourceQuoteAt,
      sourcePrice,price,quantity,contracts,sourceGross,gross,sourceFee,fee,sourceFunding,funding,spreadDrag,
      feePolicy:INVERSE_FEE_POLICY,feeRate:INVERSE_COST.feeRate,sourceFeeRate:INVERSE_COST.feeRate,sourceFeePolicy:INVERSE_FEE_POLICY,
      ...(same(chargedSourceFee,sourceFee)?{}:{frozenSourceFee:chargedSourceFee}),
      ...(administrative?{administrative}:{})};
  i.fills.push(fill);const a=state.inverseTrial!.totals;
  a.sourceGross+=sourceGross;a.sourceFees+=sourceFee;a.sourceFunding+=sourceFunding;
  a.gross+=gross;a.fees+=fee;a.funding+=funding;a.spreadDrag+=spreadDrag;
  if(exec){a.executableGross=(a.executableGross??0)+gross;a.executableSourceGross=(a.executableSourceGross??0)+sourceGross;a.executableFeeDelta=(a.executableFeeDelta??0)+fee-sourceFee;}
  else a.feeSavings=(a.feeSavings??0)+sourceFee-fee;
  state.balance+=gross-fee;state.grossPnl+=gross;state.fees+=fee;
  state.turnover+=quantity*price;return fill;
}
function bookDetachedSource(state:ForwardState,t:Trade,source:Trade){
  const trial=state.inverseTrial!,i=t.inverseCopy!,a=trial.totals;
  if(i.detachedSourceClosed)return;
  const reductions=source.realization?.fills??[],already=i.detachedSourceSequence??0;
  let quantity=i.detachedRemainingQuantity??0,contracts=i.detachedRemainingContracts??0;
  for(const sf of reductions.slice(already)){
    if(sf.quantity<=0||sf.quantity>quantity+1e-8||sf.contracts<=0||sf.contracts>contracts+1e-8)throw new Error('提前平仓后的影子减仓数量超过反向剩余');
    bookSourceOnly(state,source,sf.quantity,sf.price,sf.at,sf.fee);
    i.detachedHoldQuantity=(i.detachedHoldQuantity??0)+sf.quantity;i.detachedHoldNotional=(i.detachedHoldNotional??0)+sf.quantity*sf.price;
    quantity-=sf.quantity;contracts-=sf.contracts;i.detachedSourceSequence=(i.detachedSourceSequence??0)+1;
  }
  i.detachedRemainingQuantity=quantity;i.detachedRemainingContracts=contracts;i.sourceRemainingContracts=source.status==='CLOSED'?0:source.contracts;
  if(source.status!=='CLOSED')return;
  if(quantity>0){bookSourceOnly(state,source,quantity,source.exitPrice!,source.closedAt!,source.exitFee!-(source.realization?.fees??0));
    i.detachedHoldQuantity=(i.detachedHoldQuantity??0)+quantity;i.detachedHoldNotional=(i.detachedHoldNotional??0)+quantity*source.exitPrice!;}
  i.detachedSourceClosed=true;i.detachedRemainingQuantity=0;i.detachedRemainingContracts=0;
  i.sourceClosedAt=source.closedAt;i.sourceExitReason=source.exitReason;i.sourceExitAudit=structuredClone(source.exitAudit);i.sourceRemainingContracts=0;
}
function bookSourceOnly(state:ForwardState,source:Trade,quantity:number,price:number,sourceAt:number,chargedFee:number){
  if(!finite(price)||price<=0||!finite(sourceAt))throw new Error('提前平仓后的影子回执无效');
  const a=state.inverseTrial!.totals,sourceGross=dir(source.side)*quantity*(price-source.entryPrice),
    sourceFee=comparisonSourceFee(quantity,price,chargedFee),
    sourceFunding=quantity*source.entryPrice*SOURCE_FUNDING_ALLOWANCE_PER_DAY*Math.max(0,sourceAt-source.openedAt)/86_400_000;
  a.sourceGross+=sourceGross;a.sourceFees+=sourceFee;a.sourceFunding+=sourceFunding;
  a.detachedSourceGross=(a.detachedSourceGross??0)+sourceGross;a.detachedSourceFees=(a.detachedSourceFees??0)+sourceFee;
  a.detachedSourceFunding=(a.detachedSourceFunding??0)+sourceFunding;
}
function sourceHoldSoft(source:Trade,now:number){
  const p=source.positionIntelligence;
  if(!p||p.updatedAt>now||!finite(p.holdValueScore)||!finite(p.continuationRatio))return false;
  return p.phase==='DECAYING'||p.phase==='AT_RISK'||p.holdValueScore<80||p.continuationRatio<1.3||p.concernFamilies.length>0;
}
/** Cut the inverse leg only. Source keeps running; its later fills update the source column, not inverse cash. */
export function applyInverseSoftLossExits(state:ForwardState,now:number){
  const trial=state.inverseTrial;if(!trial)return false;
  let changed=false;
  for(const t of [...state.positions]){
    if(!t.inverseCopy||t.status!=='OPEN')continue;
    const source=trial.source.positions.find(s=>s.id===t.inverseCopy!.sourceId);
    if(!source||source.status!=='OPEN')continue;
    if(!finite(t.lastPrice)||t.lastPrice<=0||!finite(t.lastQuoteAt)||t.lastQuoteAt>now||now-t.lastQuoteAt>10_000)continue;
    const gross=dir(t.side)*t.quantity*(t.lastPrice-t.entryPrice);
    const hardCap=gross<-INVERSE_HARD_LOSS_GROSS;
    const desk=t.inverseCopy.orderPolicy===DESK_ORDER_POLICY;
    const soft=gross<-INVERSE_SOFT_LOSS_GROSS&&sourceHoldSoft(source,now);
    if(desk?!hardCap:!hardCap&&!soft)continue;
    const i=t.inverseCopy,quantity=t.quantity,contracts=t.contracts,price=t.lastPrice,quoteAt=t.lastQuoteAt,
      fee=quantity*price*INVERSE_COST.feeRate,
      fill:InverseFill={sequence:i.fills.length,kind:'CLOSE',sourceAt:now,appliedAt:now,earlySoftLoss:true,
        sourceQuoteAt:quoteAt,quoteAt,sourcePrice:price,price,quantity,contracts,sourceGross:0,gross,sourceFee:0,fee,
        sourceFunding:0,funding:0,spreadDrag:0,feePolicy:INVERSE_FEE_POLICY,feeRate:INVERSE_COST.feeRate};
    i.fills.push(fill);const a=trial.totals,r=t.realization;
    a.gross+=gross;a.fees+=fee;a.detachedGross=(a.detachedGross??0)+gross;a.detachedFees=(a.detachedFees??0)+fee;
    state.balance+=gross-fee;state.grossPnl+=gross;state.fees+=fee;state.turnover+=quantity*price;
    t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=quoteAt;
    t.grossPnl=(r?.gross??0)+gross;t.exitFee=(r?.fees??0)+fee;t.fundingAllowance=0;
    t.netPnl=t.grossPnl-t.entryFee-t.exitFee;t.exitReason='INVERSE_SOFT_LOSS_EXIT';
    i.detachedRemainingQuantity=quantity;i.detachedRemainingContracts=contracts;i.detachedSourceSequence=source.realization?.sequence??0;
    i.detachedSourceClosed=false;i.sourceRemainingContracts=source.contracts;
    t.exitAudit={trigger:t.exitReason,at:now,evidence:{authority:SHADOW_INVERSE_VERSION,sourceId:source.id,sourceReason:null,
      administrative:false,hardLossCap:hardCap,sourceClosedAt:null,sourceBuild:SHADOW_BASELINE_BUILD,quoteAt,
      gross,rule:'inverse-soft-loss-5u'}};
    if(r){t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.notional=r.initialNotional;t.margin=r.initialMargin;t.plannedRisk=r.initialRisk;}
    noteDetachedSource(state,source.id);
    state.positions=state.positions.filter(x=>x.id!==t.id);keepInverseHistory(state,t);
    state.resolved++;if((t.netPnl??0)>0)state.wins++;trial.totals.closed++;
    event(state,now,'EXIT',t,`${t.symbol} 反向浮亏超过5U且影子已软，提前平仓`);
    assertInverseTrade(t);changed=true;
  }
  return changed;
}

/** Same transaction as the source. Profit-taking by the source also reduces a
 * losing inverse position: no reuse of the positive-profit-only trim gate. */
export function applyInverseSourceTrade(state:ForwardState,source:Trade,qIn:Quote|undefined,now:number,manualReset=false){
  const trial=state.inverseTrial;if(!trial)throw new Error('反向账本尚未初始化');
  if(source.openedAt<trial.cutoverAt||trial.legacyIds.includes(source.id))return;
  if(trial.entryHaltSkipped?.includes(source.id)){
    if(source.status==='CLOSED')trial.entryHaltSkipped=trial.entryHaltSkipped.filter(id=>id!==source.id);
    return;
  }
  const id=inverseId(source.id);let t=state.positions.find(x=>x.id===id)??state.history.find(x=>x.id===id);
  if(t?.status==='CLOSED'){
    if(earlyLoss(t)){bookDetachedSource(state,t,source);return;}
    if(source.status!=='CLOSED'||t.inverseCopy?.sourceClosedAt!==source.closedAt)throw new Error('反向已结束父单的源状态冲突');
    return;
  }
  const reductions=source.realization?.fills??[],already=t?.realization?.sequence??0;
  const resetFresh=!!qIn&&qIn.fresh&&qIn.observedAt<=now&&now-qIn.observedAt<=10000&&qIn.bestBid>0&&qIn.bestAsk>=qIn.bestBid;
  // No inverse leg exists: a pause, or an early cut whose receipt was already
  // dropped from the saved window. Reset must not invent that history.
  if(manualReset&&!t){
    if(source.status==='CLOSED'&&trial.detachedSourceIds?.includes(source.id)){
      trial.detachedSourceIds=trial.detachedSourceIds.filter(id=>id!==source.id);
      if(!trial.detachedSourceIds.length)delete trial.detachedSourceIds;
    }
    return;
  }
  if(manualReset&&(source.exitReason!=='ACCOUNT_RESET'||reductions.length!==already))throw new Error('手动重置不能补造影子历史成交');
  if(!t){
    if(trial.detachedSourceIds?.includes(source.id)){
      if(source.status==='CLOSED')trial.detachedSourceIds=trial.detachedSourceIds.filter(id=>id!==source.id);
      return;
    }
    if(trial.paperPolicy==='needle-v1'||trial.paperPolicy==='brain-v1'||trial.paperPolicy==='score-v1'||trial.paperPolicy==='read-v1'||trial.paperPolicy==='stretch-v1'||trial.paperPolicy==='lsr-v1'){
      if(source.status==='OPEN'){
        const skipped=trial.entryHaltSkipped??[];
        if(!skipped.includes(source.id))skipped.push(source.id);
        trial.entryHaltSkipped=skipped.slice(-200);
      }
      return;
    }
    const standalone=trial.paperPolicy==='reverse-v1';
    let withSource=!standalone;
    if(!standalone){
      const desk=ensureResearchDesk(trial.researchDesk);
      trial.researchDesk=desk;
      const narrative=readNarrative({major:state.extremumRegime?.narrative?.major?.bias,short:state.extremumRegime?.narrative?.short?.bias,
        breadth3:state.extremumRegime?.internals?.breadth3});
      const entryMid=qIn&&qIn.fresh&&qIn.bestBid>0&&qIn.bestAsk>=qIn.bestBid&&qIn.observedAt<=now&&now-qIn.observedAt<=10_000
        ?(qIn.bestBid+qIn.bestAsk)/2:source.entryPrice;
      attachProposal(desk,{id:source.id,symbol:source.symbol,openedAt:source.openedAt,engineSide:source.side,
        slow:narrative.slow,fast:narrative.fast,entryMid,confirmExtreme:finite(source.stopPrice)?source.stopPrice:null});
      const stance=desk.stance??'FORWARD';
      if(stance==='FLAT'){
        if(source.status==='OPEN'){
          const skipped=trial.entryHaltSkipped??[];
          if(!skipped.includes(source.id))skipped.push(source.id);
          trial.entryHaltSkipped=skipped.slice(-200);
          state.revision++;state.events.unshift({id:`a${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:source.id,
            reason:`这一时段先停开 ${source.symbol}`});
          state.events=state.events.slice(0,160);
        }
        return;
      }
      withSource=stance!=='REVERSE';
    }
    const side=withSource?source.side:source.side==='LONG'?'SHORT':'LONG',openSpread=bookSpread(qIn,now,source.entryPrice),
      price=executablePrice(source.entryPrice,openSpread,side==='LONG'),
      quantity=source.realization?.initialQuantity??source.quantity,contracts=source.realization?.initialContracts??source.contracts,
      context=source.entryContext?structuredClone(source.entryContext):undefined;
    if(context){
      // The full ORIGINAL decision lives once at sourceEntryPlan. The passive
      // leg has no second copy of liquidity/hypothesis/exit authority.
      const keep=new Set(['version','capturedAt','timeframe','side','mode','reserve','reason','entryScore','directionStrength','spaceScore','positionScore','executionScore',
        'remainingSpaceRate','pullbackRiskRate','edgeRatio','expectedHoldMinutes','marketFit','regionId','portfolioRiskCharge']);
      for(const k of Object.keys(context))if(!keep.has(k))delete (context as unknown as Record<string,unknown>)[k];
      context.side=side;context.strategyVersion=standalone?'reverse-v1':SHADOW_INVERSE_VERSION;
      context.reason=standalone||!withSource
        ?`跟提案反着做${side==='LONG'?'多':'空'}。`
        :`决策是正向，跟提案做${side==='LONG'?'多':'空'}。`;
      context.thesisId=id;context.thesisSummary=context.reason;context.invalidationSummary='打穿进场确认位、30分钟没走出成本、利润回吐一半、满90分钟，或提案平仓，就出场。浮亏到10U也出场。';}
    t={...structuredClone(source),id,side,status:'OPEN',openedAt:now,closedAt:null,entryPrice:price,exitPrice:null,
      quantity,contracts,notional:quantity*price,margin:quantity*price/source.leverage,entryFee:quantity*price*INVERSE_COST.feeRate,
      exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,lastPrice:price,lastQuoteAt:source.lastQuoteAt,
      plannedRisk:source.realization?.initialRisk??source.plannedRisk,favorable:0,adverse:0,firstProfitAt:null,profitFloorRate:0,peakPnlRate:0,
      entryContext:context,rule:{...source.rule,id,side,reason:context?.reason??'跟提案开仓'},
      exitControl:{policy:SHADOW_INVERSE_VERSION,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30000,maxQuoteAgeMs:10000},
      inverseCopy:{version:SHADOW_INVERSE_VERSION,sourceBuild:SHADOW_BASELINE_BUILD,sourceId:source.id,cutoverAt:trial.cutoverAt,
        sourceSide:source.side,sourceEntryPrice:source.entryPrice,sourceStopPrice:source.stopPrice,
        sourceTargetPrice:source.entryContext?.winnerPlan?.target??null,sourceEntryPlan:structuredClone(source.entryContext),
        sourceExitReason:null,sourceRemainingContracts:contracts,sourceClosedAt:null,fills:[],independentDecisions:false,liveExecution:'PAPER_ONLY',pricePolicy:INVERSE_PRICE_POLICY,
        orderPolicy:DESK_ORDER_POLICY,alignment:withSource?'WITH_SOURCE':'AGAINST_SOURCE',
        ...(finite(source.stopPrice)&&source.stopPrice>0?{confirmExtreme:source.stopPrice}:{})}};
    delete t.review;delete t.winnerManagement;delete t.positionIntelligence;delete t.realization;delete t.holdValue;
    delete t.liquidityLifecycle;delete t.profitLifecycle;delete t.profitProtection;delete t.profitProtectionMigration;delete t.exitAudit;delete t.exitPlan;
    addFill(state,t,source,'OPEN',quantity,contracts,source.entryPrice,source.openedAt,source.review?.timeline[0]?.quoteAt??source.lastQuoteAt,now,source.entryFee,undefined,openSpread);
    if(!same(frozenFeeOf(t.inverseCopy!.fills[0]!),source.entryFee))throw new Error('影子入场费用不符合固定源账本');
    trial.totals.opened++;state.positions.push(t);event(state,now,'ENTRY',t,withSource?`${source.symbol} 正向开仓`:`${source.symbol} 反向开仓`);
  }
  for(const sf of reductions.slice(already)){
    if(sf.quantity<=0||sf.quantity>=t.quantity||sf.contracts<=0||sf.contracts>=t.contracts)throw new Error('反向减仓数量与父单不一致');
    const f=addFill(state,t,source,'REDUCE',sf.quantity,sf.contracts,sf.price,sf.at,sf.quoteAt,now,sf.fee,undefined,bookSpread(qIn,now,sf.price)),
      r=t.realization??{version:'partial-realization-v1' as const,initialQuantity:t.quantity,initialContracts:t.contracts,
        initialNotional:t.notional,initialMargin:t.margin,initialRisk:t.plannedRisk,initialEntryFee:t.entryFee,gross:0,fees:0,funding:0,sequence:0,fills:[]};
    if(!same(f.sourceGross,sf.gross)||!same(frozenFeeOf(f),sf.fee)||!same(f.sourceFunding,sf.funding))throw new Error('影子减仓实际回执与配对数量费用不一致');
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
        source.exitFee!-(source.realization?.fees??0),
        manualReset?(resetFresh?'ACCOUNT_RESET_QUOTE':'ACCOUNT_RESET_SAVED_MARK'):undefined,bookSpread(qIn,now,source.exitPrice!)),r=t.realization;
    t.status='CLOSED';t.closedAt=now;t.exitPrice=f.price;t.lastPrice=f.price;t.lastQuoteAt=f.quoteAt;
    t.grossPnl=(r?.gross??0)+f.gross;t.exitFee=(r?.fees??0)+f.fee;t.fundingAllowance=0;
    t.netPnl=t.grossPnl-t.entryFee-t.exitFee;t.exitReason=manualReset?'ACCOUNT_RESET':'SHADOW_SOURCE_EXIT';
    i.sourceClosedAt=source.closedAt;i.sourceExitReason=source.exitReason;i.sourceExitAudit=structuredClone(source.exitAudit);
    if(!same(source.netPnl!,i.fills.reduce((n,f)=>n+f.sourceGross-frozenFeeOf(f)-f.sourceFunding,0)))throw new Error('影子父单净额与逐次实际成交不一致');
    t.exitAudit={trigger:t.exitReason,at:now,evidence:{authority:SHADOW_INVERSE_VERSION,sourceId:source.id,sourceReason:source.exitReason,administrative:manualReset,
      sourceClosedAt:source.closedAt,sourceBuild:SHADOW_BASELINE_BUILD,quoteAt:f.quoteAt}};
    if(r){t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.notional=r.initialNotional;t.margin=r.initialMargin;t.plannedRisk=r.initialRisk;}
    state.positions=state.positions.filter(x=>x.id!==id);keepInverseHistory(state,t);
    state.resolved++;if(t.netPnl>0)state.wins++;trial.totals.closed++;event(state,now,'EXIT',t,`${source.symbol} 跟随影子平仓`);
  }else if(!same(t.contracts,source.contracts)||!same(t.quantity,source.quantity))throw new Error('影子与反向剩余数量不一致');
  assertInverseTrade(t);
}
const DESK_EXIT_TEXT:Record<string,string>={
  DESK_SWEEP_EXIT:'打穿进场确认位，提前平仓',
  DESK_NO_PROGRESS_EXIT:'30分钟没走出成本，提前平仓',
  DESK_GIVEBACK_EXIT:'利润回吐一半，提前平仓',
  DESK_HORIZON_EXIT:'满90分钟，提前平仓',
};
/** New desk copies only. Legacy copies are left to the 5U/10U path and the source exit. */
export function applyDeskOrderExits(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const trial=state.inverseTrial;if(!trial)return false;
  let changed=false;
  for(const t of [...state.positions]){
    const copy=t.inverseCopy;
    if(!copy||t.status!=='OPEN'||copy.orderPolicy!==DESK_ORDER_POLICY)continue;
    const source=trial.source.positions.find(s=>s.id===copy.sourceId);
    if(!source||source.status!=='OPEN')continue;
    if(!finite(t.lastPrice)||t.lastPrice<=0||!finite(t.entryPrice)||t.entryPrice<=0||!finite(t.lastQuoteAt)||t.lastQuoteAt>now||now-t.lastQuoteAt>10_000)continue;
    const q=quotes[t.symbol];
    const mid=q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000?(q.bestBid+q.bestAsk)/2:null;
    const extreme=copy.confirmExtreme;
    let reason:string|null=null;
    if(mid!=null&&finite(extreme)&&extreme>0&&(copy.sourceSide==='LONG'?mid<=extreme:mid>=extreme))reason='DESK_SWEEP_EXIT';
    const age=now-t.openedAt,current=dir(t.side)*(t.lastPrice/t.entryPrice-1),peak=Math.max(finite(t.favorable)?t.favorable:0,current);
    if(!reason&&age>=HOLD_HORIZON_MS)reason='DESK_HORIZON_EXIT';
    if(!reason&&peak>=ROUND_TRIP_COST&&current<=peak/2)reason='DESK_GIVEBACK_EXIT';
    if(!reason&&age>=CLAIM_HORIZON_MS&&peak<ROUND_TRIP_COST)reason='DESK_NO_PROGRESS_EXIT';
    if(!reason)continue;
    const i=copy,quantity=t.quantity,contracts=t.contracts,price=t.lastPrice,quoteAt=t.lastQuoteAt,
      gross=dir(t.side)*quantity*(price-t.entryPrice),fee=quantity*price*INVERSE_COST.feeRate,
      fill:InverseFill={sequence:i.fills.length,kind:'CLOSE',sourceAt:now,appliedAt:now,earlySoftLoss:true,
        sourceQuoteAt:quoteAt,quoteAt,sourcePrice:price,price,quantity,contracts,sourceGross:0,gross,sourceFee:0,fee,
        sourceFunding:0,funding:0,spreadDrag:0,feePolicy:INVERSE_FEE_POLICY,feeRate:INVERSE_COST.feeRate};
    i.fills.push(fill);const a=trial.totals,r=t.realization;
    a.gross+=gross;a.fees+=fee;a.detachedGross=(a.detachedGross??0)+gross;a.detachedFees=(a.detachedFees??0)+fee;
    state.balance+=gross-fee;state.grossPnl+=gross;state.fees+=fee;state.turnover+=quantity*price;
    t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=quoteAt;
    t.grossPnl=(r?.gross??0)+gross;t.exitFee=(r?.fees??0)+fee;t.fundingAllowance=0;
    t.netPnl=t.grossPnl-t.entryFee-t.exitFee;t.exitReason=reason;
    i.detachedRemainingQuantity=quantity;i.detachedRemainingContracts=contracts;i.detachedSourceSequence=source.realization?.sequence??0;
    i.detachedSourceClosed=false;i.sourceRemainingContracts=source.contracts;
    t.exitAudit={trigger:reason,at:now,evidence:{authority:SHADOW_INVERSE_VERSION,sourceId:source.id,sourceReason:null,
      administrative:false,hardLossCap:false,sourceClosedAt:null,sourceBuild:SHADOW_BASELINE_BUILD,quoteAt,gross,rule:reason}};
    if(r){t.quantity=r.initialQuantity;t.contracts=r.initialContracts;t.notional=r.initialNotional;t.margin=r.initialMargin;t.plannedRisk=r.initialRisk;}
    noteDetachedSource(state,source.id);
    state.positions=state.positions.filter(x=>x.id!==t.id);keepInverseHistory(state,t);
    state.resolved++;if((t.netPnl??0)>0)state.wins++;trial.totals.closed++;
    event(state,now,'EXIT',t,`${t.symbol} ${DESK_EXIT_TEXT[reason]??'提前平仓'}`);
    assertInverseTrade(t);changed=true;
  }
  return changed;
}
export function markInversePositions(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const trial=state.inverseTrial;if(!trial)return;
  for(const t of state.positions){if(!t.inverseCopy)continue;
    const source=trial.source.positions.find(s=>s.id===t.inverseCopy!.sourceId);
    if(!source||!finite(source.lastPrice)||source.lastPrice<=0||!finite(source.lastQuoteAt)||source.lastQuoteAt>now)continue;
    t.lastPrice=executableCopy(t)?executablePrice(source.lastPrice,bookSpread(quotes[t.symbol],now,source.lastPrice),t.side==='SHORT'):source.lastPrice;
    t.lastQuoteAt=source.lastQuoteAt;
    const signed=dir(t.side)*(t.lastPrice/t.entryPrice-1);t.favorable=Math.max(t.favorable,signed);t.adverse=Math.max(t.adverse,-signed);
    t.peakPnlRate=t.favorable;if(!t.firstProfitAt&&signed>SHADOW_FEE_RATE*2)t.firstProfitAt=now;
  }
}
export function inverseTrialSummary(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const v=state.inverseTrial;if(!v)return null;const a=v.totals,paid=inversePaidFeeView(state,quotes,now)!;
  const sourceNet=paid.source.netPnl??0,inverseNet=paid.inverse.netPnl??0;
  const execFees=[...state.positions,...state.history].filter(executableCopy).reduce((n,t)=>n+t.inverseCopy!.fills.reduce((m,f)=>m+f.fee,0),0),
    tradedNotional=INVERSE_COST.feeRate>0?Math.max(0,a.fees-execFees)/INVERSE_COST.feeRate:0,
    executionGap=tradedNotional*LIVE_EXECUTION_GAP_RATE,
    liveCostEstimate={policy:LIVE_EXECUTION_GAP_POLICY,gapRate:LIVE_EXECUTION_GAP_RATE,tradedNotional,executionGap,
      estimatedNet:inverseNet-executionGap,
      scope:'Estimate only: applies the measured 6bp live adverse gap to same-price inverse notional. Copies under executable-book-v1 already pay the real spread in their books.'};
  return{paidCost:paid,liveCostEstimate,version:v.version,sourceBuild:v.sourceBuild,cutoverAt:v.cutoverAt,accountingMode:v.accountingMode??null,
    allocationPolicy:FIXED_ALLOCATION_POLICY,allocationEquity:FIXED_ALLOCATION_EQUITY,
    feePolicy:INVERSE_FEE_POLICY,feeRate:INVERSE_COST.feeRate,sourceFeeRate:INVERSE_COST.feeRate,
    reconciledAt:v.reconciledAt??null,initialEquity:v.initialComparisonEquity,
    sourceEquity:v.initialComparisonEquity+sourceNet,inverseEquity:v.initialComparisonEquity+inverseNet,
    theoreticalSamePriceEquity:v.initialComparisonEquity+inverseNet,sourceNet,inverseNet,
    sourceFees:a.sourceFees,inverseFees:a.fees,sourceFunding:a.sourceFunding,inverseFunding:0,
    realizedSpreadDrag:a.spreadDrag,pricePolicy:INVERSE_PRICE_POLICY,settledAttributionResidual:paid.reconciliation.grossMirrorResidual??0,pairedOpened:a.opened,pairedClosed:a.closed,
    pairedOpen:state.positions.filter(t=>t.inverseCopy).length,reductions:a.reductions,
    legacyOpen:state.positions.filter(t=>!t.inverseCopy).length,stalePositions:paid.stalePairs,
    sourceDecisionBalance:v.source.balance,sourceDecisionResolved:v.source.resolved,
    curve:v.curve,droppedCurvePoints:v.droppedCurvePoints,swings:v.swings??[],independentDecisions:false,liveExecution:'PAPER_ONLY' as const,
    costModel:'Exact source prices and gross inversion. Comparison fills on both legs use the 5bp live taker; a frozen 7bp receipt is kept beside it and does not change inverse cash.',
    scope:'Paired trades born after cutover only. Existing account curve and legacy holdings remain separate.'};
}
export function recordInverseCurve(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const v=state.inverseTrial,x=inverseTrialSummary(state,quotes,now);if(!v||!x||x.stalePositions)return;
  if(now-(v.curve.at(-1)?.at??0)<60_000)return;
  v.curve.push({at:now,source:x.sourceEquity,inverse:x.inverseEquity,theoretical:x.theoreticalSamePriceEquity});
  while(v.curve.length>720){v.curve.splice(1,1);v.droppedCurvePoints++;}
  v.swingArm??={};v.swings??=[];
  v.swingArm.source=noteEquitySwing(v.swingArm.source,now,x.sourceEquity,'source',v.swings);
  v.swingArm.inverse=noteEquitySwing(v.swingArm.inverse,now,x.inverseEquity,'inverse',v.swings);
  if(v.swings.length>300)v.swings.splice(0,v.swings.length-300);
}
const SWING_REVERSAL=1;
function noteEquitySwing(arm:SwingArm|undefined,at:number,equity:number,book:EquitySwing['book'],rows:EquitySwing[]){
  if(!arm)return {at,equity,side:'FLAT' as const};
  if(arm.side!=='LOW'&&equity<=arm.equity-SWING_REVERSAL){
    if(arm.side==='HIGH')rows.push({at:arm.at,book,kind:'PEAK',equity:arm.equity});
    return {at,equity,side:'LOW' as const};
  }
  if(arm.side!=='HIGH'&&equity>=arm.equity+SWING_REVERSAL){
    if(arm.side==='LOW')rows.push({at:arm.at,book,kind:'TROUGH',equity:arm.equity});
    return {at,equity,side:'HIGH' as const};
  }
  if((arm.side==='HIGH'||arm.side==='FLAT')&&equity>arm.equity)return {at,equity,side:arm.side};
  if((arm.side==='LOW'||arm.side==='FLAT')&&equity<arm.equity)return {at,equity,side:arm.side};
  return arm;
}
/** Displayed comparison fees were 7bp on the frozen source and 5bp on the inverse.
 * Book both columns at the live 5bp taker. Inverse cash and frozen receipts stay. */
export function alignComparisonSourceFees(state:ForwardState){
  const trial=state.inverseTrial;if(!trial)return false;
  let delta=0;
  for(const t of [...state.positions,...state.history]){
    for(const f of t.inverseCopy?.fills??[]){
      const sourceNotional=f.sourcePrice*f.quantity,inverseNotional=f.price*f.quantity;
      if(!(sourceNotional>0)||!(inverseNotional>0)||f.frozenSourceFee!==undefined)continue;
      const sourceRate=f.sourceFee/sourceNotional,inverseRate=f.fee/inverseNotional;
      if(Math.abs(sourceRate-SHADOW_FEE_RATE)>1e-8||Math.abs(inverseRate-INVERSE_COST.feeRate)>1e-8)continue;
      const live=inverseNotional*INVERSE_COST.feeRate,previous=f.sourceFee;
      f.frozenSourceFee=previous;f.sourceFee=live;f.sourceFeeRate=INVERSE_COST.feeRate;f.sourceFeePolicy=INVERSE_FEE_POLICY;
      delta+=live-previous;
    }
  }
  if(delta){trial.totals.sourceFees+=delta;trial.totals.feeSavings=(trial.totals.feeSavings??0)+delta;}
  let changed=delta!==0;
  if(trial.comparisonFeesAligned!=='both-live-5bp-v1'){
    const extra=trial.totals.feeSavings??0;
    if(extra>0){trial.totals.sourceFees-=extra;trial.totals.feeSavings=0;changed=true;}
    trial.comparisonFeesAligned='both-live-5bp-v1';changed=true;
  }
  return changed;
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
  const withSource=i.alignment==='WITH_SOURCE';
  if(i.version!==SHADOW_INVERSE_VERSION||i.sourceBuild!==SHADOW_BASELINE_BUILD||t.id!==inverseId(i.sourceId)
    ||(withSource?t.side!==i.sourceSide:t.side===i.sourceSide)
    ||i.independentDecisions!==false||i.liveExecution!=='PAPER_ONLY'||!Array.isArray(i.fills)||i.fills.length<1||i.fills.length>4
    ||i.fills.some((f,n)=>f.sequence!==n||![f.sourceAt,f.appliedAt,f.quoteAt,f.sourcePrice,f.price,f.quantity,f.contracts,f.sourceGross,f.gross,f.fee,f.sourceFee,f.funding,f.sourceFunding,f.spreadDrag].every(finite)
      ||f.price<=0||f.sourcePrice<=0||f.quantity<=0||f.contracts<=0||f.fee<0||f.funding!==0||f.appliedAt<f.sourceAt||f.quoteAt>f.appliedAt
      ||(executableCopy(t)?!same(f.spreadDrag,f.quantity*Math.abs(f.price-f.sourcePrice))
        :(!same(f.price,f.sourcePrice)||(!f.earlySoftLoss&&!same(f.gross,-f.sourceGross))||!same(f.spreadDrag,0)))))
    throw new Error('反向配对账本格式错误；必须同价、反方向、仅实际手续费');
  const first=i.fills[0]!,exits=i.fills.slice(1),initial=t.realization?.initialQuantity??t.quantity;
  if(first.kind!=='OPEN'||!same(first.quantity,initial)||!same(first.fee,t.entryFee)||!same(first.price,t.entryPrice)
    ||first.sourceAt!==t.openedAt||!same(first.sourcePrice,i.sourceEntryPrice)
    ||exits.some((f,n)=>f.kind!==(t.status==='CLOSED'&&n===exits.length-1?'CLOSE':'REDUCE')
      ||f.sourceAt<i.fills[n]!.sourceAt||!same(f.gross,dir(t.side)*f.quantity*(f.price-t.entryPrice))
      ||(!f.earlySoftLoss&&!same(f.sourceGross,dir(i.sourceSide)*f.quantity*(f.sourcePrice-i.sourceEntryPrice)))
      ||(!!f.earlySoftLoss&&(f.sourceGross!==0||f.sourceFee!==0||f.sourceFunding!==0)))
    ||i.fills.some(f=>!same(f.fee,f.price*f.quantity*recordedInverseFeeRate(f))
      ||(!f.earlySoftLoss&&!same(f.sourceFee,f.sourcePrice*f.quantity*recordedSourceFeeRate(f)))
      ||(f.frozenSourceFee!==undefined&&(!finite(f.frozenSourceFee)||!same(f.frozenSourceFee,f.sourcePrice*f.quantity*SHADOW_FEE_RATE)))
      ||!same(f.contracts*t.quantoMultiplier,f.quantity)))throw new Error('反向成交与影子事件不一致');
  if(t.status==='OPEN'&&(!same(t.quantity+exits.reduce((n,f)=>n+f.quantity,0),first.quantity)
    ||!same(t.contracts+exits.reduce((n,f)=>n+f.contracts,0),first.contracts)||!same(t.contracts,i.sourceRemainingContracts)))
    throw new Error('反向剩余数量不守恒');
  const early=i.fills.some(f=>f.earlySoftLoss);
  if(t.status==='CLOSED'&&early){
    if(i.fills.at(-1)?.kind!=='CLOSE'||!same(exits.reduce((n,f)=>n+f.quantity,0),initial)
      ||t.fundingAllowance!==0||!same(t.netPnl!,i.fills.reduce((n,f)=>n+f.gross-f.fee,0))
      ||(i.detachedSourceClosed===true&&(i.sourceClosedAt==null||i.sourceRemainingContracts!==0)))
      throw new Error('反向父单结算不一致');
  }else if(t.status==='CLOSED'&&(i.fills.at(-1)?.kind!=='CLOSE'||!same(exits.reduce((n,f)=>n+f.quantity,0),initial)
    ||i.sourceClosedAt!==t.closedAt||i.sourceRemainingContracts!==0
    ||t.fundingAllowance!==0||!same(t.netPnl!,i.fills.reduce((n,f)=>n+f.gross-f.fee,0))))
    throw new Error('反向父单结算不一致');
}
export function assertInverseTrial(state:ForwardState){
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
    ||!same(t.totals.gross-(t.totals.detachedGross??0)-(t.totals.executableGross??0),-(t.totals.sourceGross-(t.totals.detachedSourceGross??0)-(t.totals.executableSourceGross??0)))
    ||t.totals.fees<0||t.totals.sourceFees<0||(t.totals.feeSavings??0)<0||(t.totals.detachedFees??0)<0
    ||!same(t.totals.fees-(t.totals.detachedFees??0)-(t.totals.executableFeeDelta??0)+(t.totals.feeSavings??0),t.totals.sourceFees-(t.totals.detachedSourceFees??0))
    ||t.totals.funding!==0||!(t.totals.spreadDrag>=0))
    throw new Error('影子金融状态损坏；保留原账户，不重置试验');
  for(const source of t.source.positions){
    if(source.openedAt<t.cutoverAt||t.legacyIds.includes(source.id)||t.entryHaltSkipped?.includes(source.id)||t.detachedSourceIds?.includes(source.id))continue;
    const mirror=state.positions.find(m=>m.inverseCopy?.sourceId===source.id);
    if(mirror){
      if(!same(mirror.contracts,source.contracts)||(!executableCopy(mirror)&&!same(mirror.entryPrice,mirror.inverseCopy!.sourceEntryPrice)))
        throw new Error('已提交影子与反向持仓配对缺失');
      continue;
    }
    if(!state.history.some(m=>m.inverseCopy?.sourceId===source.id&&m.inverseCopy.fills.some(f=>f.earlySoftLoss)))
      throw new Error('已提交影子与反向持仓配对缺失');
  }
  for(const mirror of state.positions){if(!mirror.inverseCopy)continue;
    const source=t.source.positions.find(s=>s.id===mirror.inverseCopy!.sourceId);
    const withSource=mirror.inverseCopy.alignment==='WITH_SOURCE';
    if(!source||(withSource?source.side!==mirror.side:source.side===mirror.side)||!same(source.quantity,mirror.quantity))throw new Error('反向持仓失去对应影子来源');
    assertInverseTrade(mirror);
  }
  for(const mirror of state.history)if(mirror.inverseCopy)assertInverseTrade(mirror);
}
