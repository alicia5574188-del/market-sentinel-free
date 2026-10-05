/** PAPER transport for the same committed intents consumed by LIVE.
 * No private request, credential, timer or native execution authority. */
import {forwardEquity,freshQuote,type ForwardState,type Trade,type Quote,type Contract} from './forward-relations.ts';
import {buildProportionalMirror,mirrorPositionRisk} from './live-parity.ts';
import {quantizeMirrorNotional} from './gate-quantity.ts';
import {closeUnifiedTrade} from './unified-execution.ts';
import {WICK_ENTRY_MS,WICK_FILL_GRACE_MS} from './wick-target.ts';
import type {TradeRealization} from './trade-realization.ts';

export const PAPER_EXECUTION_VERSION='live-steps-paper-v1';
export const PAPER_TIMING_VERSION='native-position-first-observed-v1';
export type PaperTiming={version?:typeof PAPER_TIMING_VERSION;prepareMs:number;confirmMs:number;basis:'OBSERVED_LIVE'|'EXECUTION_CLOCK';samples:number};
export type PaperAction={kind:'CLOSE'|'REDUCE';at:number;phase:'PREPARING'|'SUBMITTED';submittedAt?:number;
  reason:string;detail:string;contracts:number;sequence:number;filled:number;quoteAt?:number;liquidityKey?:string};
export type PaperOrder={version:typeof PAPER_EXECUTION_VERSION;signalAt:number;signalPrice:number;requestedContracts:number;allocationRiskRate:number;
  phase:'PREPARING'|'SUBMITTED'|'FILLED'|'CANCELLED';timing:PaperTiming;preparedAt?:number;submittedAt?:number;
  confirmedAt?:number;submitQuoteAt?:number;reason:string;fillMode?:'OBSERVED_BOOK_VWAP';unfilledContracts?:number;
  action?:PaperAction;completedActions:number;errorKey?:string};
export type PaperExecution={version:typeof PAPER_EXECUTION_VERSION;cutoverAt:number;cancelled:Trade[]};
export type PaperRealization=Omit<TradeRealization,'fills'>&{fills:(TradeRealization['fills'][number]&{executionOrderId?:string})[]};
export function paperFilled(t:Trade){return !t.paperOrder||t.paperOrder.phase==='FILLED';}
/** True only for a wick order that was signaled inside 30s and is still inside the fill grace. */
export function wickFillPending(t:Trade,now:number){
  const proof=t.unified?.anomaly?.kind==='WICK'?t.unified.anomaly.proof:undefined,o=t.paperOrder;
  return !!proof&&!!o&&o.phase!=='FILLED'&&o.phase!=='CANCELLED'
    &&o.signalAt>=proof.at&&o.signalAt-proof.at<=WICK_ENTRY_MS
    &&now>=proof.at&&now-proof.at<=WICK_ENTRY_MS+WICK_FILL_GRACE_MS;
}
const direction=(t:Trade)=>t.side==='LONG'?1:-1;
const fee=.0005;
/** Use the real ladder when it is there. Otherwise the observed bid/ask is the book. */
function wickBook(q:Quote){
  if(!(q.bestBid>0)||!(q.bestAsk>=q.bestBid))return;
  const bids=q.bids?.length?q.bids:[{price:q.bestBid,size:1e12}],asks=q.asks?.length?q.asks:[{price:q.bestAsk,size:1e12}];
  if(!(bids[0]!.price>0)||!(asks[0]!.price>=bids[0]!.price))return;
  return {...q,bestBid:bids[0]!.price,bestAsk:asks[0]!.price,bids,asks};
}
function settleWickEntry(s:ForwardState,t:Trade,q:Quote,c:Contract,quotes:Record<string,Quote>,now:number){
  const book=wickBook(q);if(!book)return false;
  const o=t.paperOrder!;
  const f=paperBookFill(t,book,c,t.contracts,true);if(!f)return false;
  const px=f.price,dir=t.side==='LONG'?1:-1;
  if(!(t.stopPrice>0)||dir*(px-t.stopPrice)<=0)throw new Error('当前价已越过止损，不开');
  const mark=forwardEquity(s,quotes,now);
  if(mark.stalePositions)throw new Error('已有持仓估值不完整');
  const used=s.positions.filter(x=>x.id!==t.id).reduce((n,x)=>n+x.margin,0);
  const room=mark.equity*.75-used;if(!(room>0))throw new Error('可用保证金不足');
  const affordable=Math.floor(room*t.leverage/(px*c.quantoMultiplier));
  let n=Math.min(f.contracts,t.contracts,Math.max(affordable,0));
  const unit=px*c.quantoMultiplier;
  if(n*unit>500)n=Math.floor(500/unit);
  if(!(n*unit>=300))throw new Error('盘口或保证金不足300 USDT，不开');
  const exact=paperBookFill(t,book,c,n,true);if(!exact)return false;
  const margin=exact.contracts*c.quantoMultiplier*exact.price/t.leverage;
  if(used+margin>mark.equity*.75+1e-6)throw new Error('可用保证金不足');
  const requested=t.contracts;
  t.contracts=exact.contracts;t.quantity=t.contracts*t.quantoMultiplier;t.entryPrice=exact.price;t.openedAt=now;
  t.notional=t.quantity*t.entryPrice;t.margin=margin;t.plannedRisk=t.plannedRisk*t.contracts/requested;
  t.lastPrice=t.side==='LONG'?book.bestBid:book.bestAsk;t.lastQuoteAt=q.observedAt;t.entryFee=t.notional*fee;
  o.phase='FILLED';o.preparedAt=now;o.submittedAt=now;o.submitQuoteAt=q.observedAt;o.confirmedAt=now;o.fillMode='OBSERVED_BOOK_VWAP';
  o.unfilledContracts=o.requestedContracts-t.contracts;
  o.reason=o.unfilledContracts>0?'IOC部分成交，未成交余量不补单':'当前盘口撮合确认';
  t.unified!.explanationEvents[0]={at:now,kind:'ENTRY',reason:t.unified!.entryReason,price:exact.price,quoteAt:q.observedAt};
  if(t.entryContext)t.entryContext.capturedAt=now;
  s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=t.notional;s.lastEntryAt[t.symbol]=now;s.lastSide[t.symbol]=t.side;s.revision++;
  return true;
}
/** Fill wick orders already accepted inside 30s on the book in hand. Does not touch exits. */
export function fillPendingWickEntries(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number){
  if(!s.paperExecution)return;
  for(const t of [...s.positions]){
    if(!wickFillPending(t,now)||t.paperOrder?.action)continue;
    const q=quotes[t.symbol],c=contracts[t.symbol];
    if(!freshQuote(q,now)||!c)continue;
    try{if(!settleWickEntry(s,t,q!,c,quotes,now)&&!wickBook(q!))blocked(s,t.paperOrder!,new Error('等待本次执行的实际多档盘口；第一档不足不能代表完整IOC成交'));}
    catch(e){rejectPaperEntry(s,t,now,e instanceof Error?e.message:'执行检查未通过');}
  }
}
const rules=(c:Contract)=>({enableDecimal:c.enableDecimal,orderSizeMin:c.orderSizeMin==null?undefined:String(c.orderSizeMin),
  orderSizeMax:c.orderSizeMax==null?undefined:String(c.orderSizeMax),marketOrderSizeMax:c.marketOrderSizeMax==null?undefined:String(c.marketOrderSizeMax)});
export function executionTiming(rows:{submitDelayMs?:number;submittedAt?:number;entryConfirmedAt?:number;exchangeEntryAt?:number}[]):PaperTiming{
  const usable=rows.filter(x=>Number.isFinite(x.submitDelayMs)&&x.submitDelayMs!>=0&&Number.isFinite(x.submittedAt)
    &&Number.isFinite(x.entryConfirmedAt)&&x.entryConfirmedAt!>=x.submittedAt!)
    .sort((a,b)=>b.submittedAt!-a.submittedAt!).filter((x,i,a)=>a.findIndex(y=>y.submittedAt===x.submittedAt&&y.entryConfirmedAt===x.entryConfirmedAt)===i).slice(0,32);
  const median=(xs:number[])=>xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)]!;
  return usable.length?{version:PAPER_TIMING_VERSION,prepareMs:median(usable.map(x=>x.submitDelayMs!)),confirmMs:median(usable.map(x=>x.entryConfirmedAt!-x.submittedAt!)),
    basis:'OBSERVED_LIVE',samples:usable.length}:{version:PAPER_TIMING_VERSION,prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK',samples:0};
}
/** Book sizes are USDT notionals, as in GateStreamingFeed/fetchTickerBbo.
 * Never invent unobserved depth or use the opposite side's executable price. */
export function paperBookFill(t:Trade,q:Quote,c:Contract,wanted:number,opening:boolean){
  const buy=opening?t.side==='LONG':t.side==='SHORT',levels=buy?q.asks:q.bids;
  if(!levels?.length)return null;
  const top=buy?q.bestAsk:q.bestBid;
  if(Math.abs(levels[0]!.price-top)>Math.max(c.tickSize??0,top*1e-9))return null;
  let contracts=0,last=buy?-Infinity:Infinity;
  for(const row of levels.slice(0,50)){
    if(!Number.isFinite(row.price)||!Number.isFinite(row.size)||row.price<=0||row.size<0
      ||(buy?row.price<last:row.price>last))return null;
    last=row.price;const n=Math.min(wanted-contracts,row.size/(row.price*c.quantoMultiplier));
    if(n>0)contracts+=n;if(contracts>=wanted-1e-9){contracts=wanted;break;}
  }
  if(contracts<=0)return null;
  const sized=quantizeMirrorNotional(Number(contracts.toPrecision(15)),1,1,rules(c));
  if(sized.quantity<=0)return null;
  // Re-sweep exact downward lots: averaging the unrounded sweep would retain
  // expensive depth that these contracts never consume.
  let remaining=sized.quantity,value=0;
  for(const row of levels.slice(0,50)){const n=Math.min(remaining,row.size/(row.price*c.quantoMultiplier));
    value+=n*c.quantoMultiplier*row.price;remaining-=n;if(remaining<=1e-9)break;}
  return{contracts:sized.quantity,price:value/(sized.quantity*c.quantoMultiplier),notional:value};
}
export function queuePaperEntry(s:ForwardState,t:Trade,timing:PaperTiming){
  t.paperOrder={version:PAPER_EXECUTION_VERSION,signalAt:t.openedAt,signalPrice:t.entryPrice,requestedContracts:t.contracts,
    allocationRiskRate:t.plannedRisk/t.notional,
    phase:'PREPARING',timing:{...structuredClone(timing),version:PAPER_TIMING_VERSION},reason:'核对账户、合约数量和逐仓杠杆；尚未成交',completedActions:0};
  s.positions.push(t);s.revision++;
}
export function assertPaperExecution(s:ForwardState){
  const e=s.paperExecution,rows=[...s.positions,...s.history,...e?.cancelled??[]];
  const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
  const fail=()=>{throw new Error('模拟执行记录损坏；保留原账户，禁止重新生成成交');};
  if(e&&(e.version!==PAPER_EXECUTION_VERSION||!finite(e.cutoverAt)||e.cutoverAt<s.startedAt
    ||!Array.isArray(e.cancelled)||e.cancelled.length>32))fail();
  for(const t of rows){const o=t.paperOrder;if(!o)continue;
    if(!e||o.version!==PAPER_EXECUTION_VERSION||!['PREPARING','SUBMITTED','FILLED','CANCELLED'].includes(o.phase)
      ||![o.signalAt,o.signalPrice,o.requestedContracts,o.completedActions,o.allocationRiskRate].every(finite)||o.allocationRiskRate<0||o.signalAt<s.startedAt
      ||o.signalPrice<=0||o.requestedContracts<=0||!Number.isInteger(o.completedActions)||o.completedActions<0||o.completedActions>2
      ||!o.timing||![o.timing.prepareMs,o.timing.confirmMs,o.timing.samples].every(finite)
      ||o.timing.prepareMs<0||o.timing.confirmMs<0||o.timing.samples<0||o.timing.samples>32
      ||!['OBSERVED_LIVE','EXECUTION_CLOCK'].includes(o.timing.basis)||typeof o.reason!=='string')fail();
    if(o.phase==='SUBMITTED'&&(!finite(o.submittedAt)||!finite(o.submitQuoteAt)||o.submittedAt<o.signalAt||o.submitQuoteAt>o.submittedAt))fail();
    if(o.phase==='FILLED'&&(!finite(o.confirmedAt)||o.confirmedAt<o.signalAt))fail();
    if(o.phase==='CANCELLED'&&(t.status!=='CLOSED'||t.entryFee!==0||t.exitFee!==0||t.netPnl!==0))fail();
    if(o.phase!=='FILLED'&&o.phase!=='CANCELLED'&&(t.status!=='OPEN'||t.realization))fail();
    const a=o.action;
    if(a&&(o.phase!=='FILLED'||t.status!=='OPEN'||!['CLOSE','REDUCE'].includes(a.kind)||!['PREPARING','SUBMITTED'].includes(a.phase)
      ||![a.at,a.contracts,a.sequence,a.filled].every(finite)||a.at<o.signalAt||a.contracts<=0||a.filled<0
      ||a.filled>=a.contracts||a.contracts-a.filled>t.contracts+1e-8||a.sequence!==o.completedActions+1
      ||typeof a.reason!=='string'||typeof a.detail!=='string'
      ||a.phase==='SUBMITTED'&&(!finite(a.submittedAt)||!finite(a.quoteAt)||a.submittedAt<a.at||a.quoteAt>a.submittedAt)))fail();
  }
}
function liquidityKey(q:Quote,buy:boolean){
  // A transport heartbeat may refresh observedAt without a new Gate book.
  // Never match the same displayed volume twice after a partial close.
  if(q.bookSequence!=null)return `gate:${q.bookSequence}`;
  const raw=JSON.stringify((buy?q.asks:q.bids)?.slice(0,50))??'';let hash=2166136261;
  for(let i=0;i<raw.length;i++)hash=Math.imul(hash^raw.charCodeAt(i),16777619);
  return `book:${hash>>>0}`;
}
function blocked(s:ForwardState,o:PaperOrder,error:unknown){
  const reason=error instanceof Error?error.message:'执行检查未通过',key=reason.replace(/\d+(?:\.\d+)?/g,'#');
  if(o.errorKey!==key){o.errorKey=key;o.reason=reason;s.revision++;}
}
/** Bounded execution fragments: two reductions and one closing order. */
export function assertPaperRealization(t:Trade){
  const r=t.realization;if(!r)return;
  const equal=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
  const closing=t.paperOrder?.action?.kind==='CLOSE'||t.status==='CLOSED';
  if(!t.paperOrder||r.version!=='partial-realization-v1'
    ||![r.initialQuantity,r.initialContracts,r.initialNotional,r.initialMargin,r.initialRisk,r.initialEntryFee,r.gross,r.fees,r.funding].every(Number.isFinite)
    ||r.initialQuantity<=0||r.initialContracts<=0||r.initialNotional<=0||r.initialMargin<0||r.initialRisk<0
    ||!Array.isArray(r.fills)||r.fills.length<1||r.fills.length>(closing?3:2)||r.sequence!==r.fills.length
    ||r.fills.some((f,i)=>f.sequence!==i+1||![f.at,f.quoteAt,f.price,f.contracts,f.quantity,f.gross,f.fee,f.funding].every(Number.isFinite)
      ||f.contracts<=0||f.quantity<=0||f.price<=0||f.fee<0||f.funding<0||f.quoteAt>f.at
      ||!equal(f.quantity,f.contracts*t.quantoMultiplier)
      ||!equal(f.gross,direction(t)*f.quantity*(f.price-t.entryPrice))))throw new Error('模拟部分成交资金记录损坏');
  const quantity=r.fills.reduce((n,f)=>n+f.quantity,0),contracts=r.fills.reduce((n,f)=>n+f.contracts,0);
  if(!equal(r.fills.reduce((n,f)=>n+f.gross,0),r.gross)||!equal(r.fills.reduce((n,f)=>n+f.fee,0),r.fees)
    ||!equal(r.fills.reduce((n,f)=>n+f.funding,0),r.funding)||!equal(t.entryFee,r.initialEntryFee)
    ||!equal(t.quantity,t.status==='OPEN'?r.initialQuantity-quantity:r.initialQuantity)
    ||!equal(t.contracts,t.status==='OPEN'?r.initialContracts-contracts:r.initialContracts)
    ||!equal(t.notional,t.quantity*t.entryPrice)||contracts>r.initialContracts*(closing?1:.65)+1e-8)
    throw new Error('模拟部分成交与剩余仓位不一致；保留原账户');
}
export function queuePaperAction(s:ForwardState,t:Trade,now:number,kind:PaperAction['kind'],reason:string,detail:string,fraction=1,c?:Contract){
  if(!s.paperExecution||!paperFilled(t))return false;
  t.paperOrder??={version:PAPER_EXECUTION_VERSION,signalAt:t.openedAt,signalPrice:t.entryPrice,requestedContracts:t.realization?.initialContracts??t.contracts,
    allocationRiskRate:(t.realization?.initialRisk??t.plannedRisk)/(t.realization?.initialNotional??t.notional),
    phase:'FILLED',timing:executionTiming([]),confirmedAt:t.openedAt,reason:'上线前入场保留原成交',completedActions:t.realization?.sequence??0};
  const prior=t.paperOrder.action;
  if(prior?.kind==='CLOSE'||prior?.kind===kind)return true;
  if(prior&&prior.filled>0)t.paperOrder.completedActions=prior.sequence;
  const minimum=c?.orderSizeMin==null?(c?.minContracts??1):Number(c.orderSizeMin),
    contracts=kind==='CLOSE'?t.contracts:Math.floor((t.contracts*fraction+1e-10)/minimum)*minimum;
  const initial=t.realization?.initialContracts??t.contracts;
  if(kind==='REDUCE'&&(contracts<minimum||t.contracts-contracts<initial*.35-1e-9||t.paperOrder.completedActions>=2))return false;
  t.paperOrder.action={kind,at:now,phase:'PREPARING',reason,detail,contracts,sequence:t.paperOrder.completedActions+1,filled:0};
  t.unified!.decision=kind==='CLOSE'?'EXIT':'REVIEW';t.unified!.holdReason=`${detail}；等待执行成交确认`;
  s.revision++;return true;
}
/** Logical source projection is an instruction, NOT a second funded account.
 * It is available before PAPER confirmation, avoiding double execution delay. */
export function paperSourceTrade(t:Trade):Trade{
  if(!t.paperOrder)return t;
  const n=structuredClone(t),o=t.paperOrder,a=o.action;
  n.openedAt=o.signalAt;n.entryPrice=o.signalPrice;
  if(a?.kind==='CLOSE'){n.status='CLOSED';n.closedAt=a.at;n.exitPrice=null;n.exitReason=a.reason;n.netPnl=null;n.grossPnl=null;}
  else{
    const initial=t.realization?.initialContracts??t.contracts,
      remaining=a?.kind==='REDUCE'?Math.max(0,t.contracts-(a.contracts-a.filled)):t.contracts,
      original=paperFilled(t)?initial:o.requestedContracts;
    n.contracts=paperFilled(t)?o.requestedContracts*remaining/original:o.requestedContracts;n.quantity=n.contracts*n.quantoMultiplier;
    n.notional=n.quantity*n.entryPrice;n.margin=n.notional/n.leverage;
    n.plannedRisk=n.notional*o.allocationRiskRate;
    n.sourceReductionIntent={sequence:a?.kind==='REDUCE'?a.sequence:o.completedActions,contracts:n.contracts};
  }
  return n;
}
export function rejectPaperEntry(s:ForwardState,t:Trade,now:number,reason:string){
  t.paperOrder!.phase='CANCELLED';t.paperOrder!.reason=reason;t.status='CLOSED';t.closedAt=now;t.exitReason=reason;
  t.entryFee=0;t.exitFee=0;t.grossPnl=0;t.netPnl=0;
  s.positions=s.positions.filter(x=>x.id!==t.id);s.paperExecution!.cancelled.unshift(t);
  s.paperExecution!.cancelled=s.paperExecution!.cancelled.slice(0,32);s.revision++;
}
/** Account/risk/lot checks use the exact pure builder used by owner/member LIVE. */
function prepareEntry(s:ForwardState,t:Trade,q:Quote,c:Contract,quotes:Record<string,Quote>,now:number,price:number){
  const mark=forwardEquity(s,quotes,now);if(mark.stalePositions)throw new Error('已有持仓估值不完整');
  const others=s.positions.filter(x=>x.id!==t.id),margin=others.reduce((n,x)=>n+x.margin,0),
    risk=(x:Trade)=>!paperFilled(x)?x.plannedRisk:mirrorPositionRisk({status:'OPEN',side:x.side,entryPrice:x.entryPrice,
      currentStop:x.stopPrice,notional:x.notional,plannedRisk:x.plannedRisk,parity:{sourceOpenedAt:x.openedAt,
        sourceDeadline:x.openedAt+Math.max(5,x.expectedHoldMinutes??180)*60000,sourceRole:'UNIFIED_PAPER',
        unifiedBranch:x.unified?.branch,sourceAllocationRiskRate:x.plannedRisk/x.notional,
        marketAuthorityVersion:x.unified?.marketRoute?.version}},
      quotes[x.symbol]?(x.side==='LONG'?quotes[x.symbol]!.bestBid:quotes[x.symbol]!.bestAsk):x.lastPrice);
  return buildProportionalMirror({source:paperSourceTrade(t),sourceEquity:1000,equity:mark.equity,available:Math.max(0,mark.equity-margin),
    entryPrice:price,quantoMultiplier:c.quantoMultiplier,leverageMax:c.leverageMax,maintenanceRate:c.maintenanceRate,
    openRisk:others.reduce((n,x)=>n+risk(x),0),sameDirectionRisk:others.filter(x=>x.side===t.side).reduce((n,x)=>n+risk(x),0),
    openMargin:margin,openNotional:others.reduce((n,x)=>n+x.notional,0),now,policy:s.policyVersion??s.version,
    sizeRules:rules(c),mirrorRatio:1,sourceRiskAuthority:true,quoteObservedAt:q.observedAt});
}
function applySlice(s:ForwardState,t:Trade,contracts:number,price:number,quoteAt:number,now:number,a:PaperAction){
  const r:PaperRealization=t.realization??{version:'partial-realization-v1',initialQuantity:t.quantity,initialContracts:t.contracts,
    initialNotional:t.notional,initialMargin:t.margin,initialRisk:t.plannedRisk,initialEntryFee:t.entryFee,gross:0,fees:0,funding:0,sequence:0,fills:[]},
    quantity=contracts*t.quantoMultiplier,gross=direction(t)*quantity*(price-t.entryPrice),paid=quantity*price*fee,
    key=`paper-${t.id}-${a.sequence}`,last=r.fills.at(-1);
  if(last?.executionOrderId===key){const weight=last.quantity+quantity;
    last.price=(last.price*last.quantity+price*quantity)/weight;last.quantity=weight;last.contracts+=contracts;
    last.gross+=gross;last.fee+=paid;last.at=now;last.quoteAt=quoteAt;
  }else{r.sequence++;r.fills.push({sequence:r.sequence,at:now,quoteAt,price,contracts,quantity,gross,fee:paid,funding:0,
    reason:a.reason,executionOrderId:key});}
  r.gross+=gross;r.fees+=paid;t.realization=r;t.contracts-=contracts;t.quantity-=quantity;
  t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;t.plannedRisk=r.initialRisk*t.contracts/r.initialContracts;
  a.filled+=contracts;s.balance+=gross-paid;s.grossPnl+=gross;s.fees+=paid;s.turnover+=quantity*price;s.revision++;
}
export function advancePaperExecution(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number){
  if(!s.paperExecution)return;
  // Confirm exits before considering any addition. Still-unfilled exposure
  // remains OPEN and consumes margin/risk while its close is pending.
  for(const t of [...s.positions].sort((a,b)=>Number(!a.paperOrder?.action)-Number(!b.paperOrder?.action))){
    const o=t.paperOrder;if(!o)continue;const q=quotes[t.symbol],c=contracts[t.symbol];
    if(!freshQuote(q,now)||!c)continue;
    const a=o.action;
    if(a){
      if(a.phase==='PREPARING'){a.phase='SUBMITTED';a.submittedAt=now;a.quoteAt=q!.observedAt;s.revision++;continue;}
      if(now<=a.submittedAt!||now<a.submittedAt!+o.timing.confirmMs||q!.observedAt<=a.quoteAt!)continue;
      const key=liquidityKey(q!,t.side==='SHORT');if(key===a.liquidityKey)continue;
      let f:ReturnType<typeof paperBookFill>;try{f=paperBookFill(t,q!,c,a.contracts-a.filled,false);}catch{continue;}if(!f)continue;
      const final=a.kind==='CLOSE'&&f.contracts>=t.contracts-1e-9;
      if(final){
        const fq={...q!,bestBid:f.price,bestAsk:f.price},closing=t.realization?.fills.find(x=>x.executionOrderId===`paper-${t.id}-${a.sequence}`),
          exitQuantity=t.quantity;delete o.action;
        closeUnifiedTrade(s,t,fq,now,a.reason,a.detail,false,true);
        if(closing)t.exitPrice=(closing.price*closing.quantity+f.price*exitQuantity)/(closing.quantity+exitQuantity);
        if(a.reason==='RETURN_TREND_CONFIRMED'){
          const ds=s.directStrategy!;ds.completedConversions++;
          // Delayed settlement must release the same original handoff that
          // immediate close did. Fresh research still rechecks trend/space.
          const plan=ds.plans[t.symbol];
          if(plan?.id===t.unified?.sourceId){plan.consumed=false;delete s.consumedTheses[plan.id];}
        }
      }else{
        a.liquidityKey=key;
        applySlice(s,t,f.contracts,f.price,q!.observedAt,now,a);
        if(a.filled>=a.contracts-1e-9){o.completedActions=a.sequence;delete o.action;
          const management=t.unified?.branch==='RETURN'&&!t.unified.marketRoute?t.unified.returnLogic?.management:t.winnerManagement;
          if(management){management.trimCount++;management.lastTrimEvent=management.obstacleSince;}}
      }
      continue;
    }
    if(o.phase==='FILLED')continue;
    const wickProof=t.unified?.anomaly?.kind==='WICK'?t.unified.anomaly.proof:undefined;
    if(wickProof&&now-wickProof.at>WICK_ENTRY_MS&&!wickFillPending(t,now)){rejectPaperEntry(s,t,now,'5分钟收盘已超过30秒，不再进场');continue;}
    if(wickFillPending(t,now)){
      try{if(!settleWickEntry(s,t,q!,c,quotes,now)&&!wickBook(q!))blocked(s,o,new Error('等待本次执行的实际多档盘口；第一档不足不能代表完整IOC成交'));}
      catch(e){rejectPaperEntry(s,t,now,e instanceof Error?e.message:'执行检查未通过');}
      continue;
    }
    if(t.rule.expiresAt<=now){rejectPaperEntry(s,t,now,'待执行期间交易事件已失效，未冒充成交');continue;}
    if(o.phase==='PREPARING'){
      if(now<=o.signalAt||now-o.signalAt<o.timing.prepareMs)continue;
      try{const p=prepareEntry(s,t,q!,c,quotes,now,t.side==='LONG'?q!.bestAsk:q!.bestBid);
        // This is a reservation, never an upward resize after preparation.
        t.contracts=Math.min(t.contracts,p.intent.contracts);t.quantity=t.contracts*t.quantoMultiplier;
        t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;t.entryFee=t.notional*fee;
        o.preparedAt=now;o.submittedAt=now;o.submitQuoteAt=q!.observedAt;o.phase='SUBMITTED';o.reason='账户、数量及杠杆检查通过；等待撮合确认';s.revision++;
      }catch(e){blocked(s,o,e);}
      continue;
    }
    if(now<=o.submittedAt!||now-o.submittedAt!<o.timing.confirmMs||q!.observedAt<=o.submitQuoteAt!)continue;
    if(s.directStrategy?.adaptive&&q!.bookCoverage==='BBO'){
      blocked(s,o,new Error('等待本次执行的实际多档盘口；第一档不足不能代表完整IOC成交'));continue;}
    try{
      const f=paperBookFill(t,q!,c,t.contracts,true);if(!f)continue;
      const checked=prepareEntry(s,t,q!,c,quotes,now,f.price),n=Math.min(f.contracts,checked.intent.contracts,t.contracts);
      const exact=paperBookFill(t,q!,c,n,true);if(!exact)continue;
      t.contracts=exact.contracts;t.quantity=t.contracts*t.quantoMultiplier;t.entryPrice=exact.price;t.openedAt=now;
      t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;t.plannedRisk=checked.intent.plannedRisk*t.contracts/checked.intent.contracts;
      t.lastPrice=t.side==='LONG'?q!.bestBid:q!.bestAsk;t.lastQuoteAt=q!.observedAt;t.entryFee=t.notional*fee;
      o.phase='FILLED';o.confirmedAt=now;o.fillMode='OBSERVED_BOOK_VWAP';o.unfilledContracts=o.requestedContracts-t.contracts;
      o.reason=o.unfilledContracts>0?'IOC部分成交，未成交余量不补单':'当前盘口撮合确认';
      t.unified!.explanationEvents[0]={at:now,kind:'ENTRY',reason:t.unified!.entryReason,price:exact.price,quoteAt:q!.observedAt};
      if(t.entryContext)t.entryContext.capturedAt=now;
      s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=t.notional;s.lastEntryAt[t.symbol]=now;s.lastSide[t.symbol]=t.side;s.revision++;
    }catch(e){blocked(s,o,e);}
  }
}
