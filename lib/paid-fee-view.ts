/** Read-only presentation. Never feeds balances, signals, sizing or exits. */
import type {ForwardState,Quote,Trade} from './forward-relations.ts';

export const PAID_FEE_VIEW_VERSION='paid-fee-view-v1';
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const positive=(n:unknown):n is number=>finite(n)&&n>0;
const direction=(side:Trade['side'])=>side==='LONG'?1:-1;
const sumKnown=(values:(number|null)[]):number|null=>values.every(finite)?values.reduce<number>((n,v)=>n+(v??0),0):null;

/** Entry fee allocation only; future exit fees never enter this value. */
export function remainingPaidNetPnl(t:Trade,price=t.lastPrice){
  const original=t.realization?.initialQuantity??t.quantity;
  return direction(t.side)*t.quantity*(price-t.entryPrice)-t.entryFee*(original>0?t.quantity/original:1);
}
export function tradePaidNetPnl(t:Trade,price=t.lastPrice){
  if(t.status==='CLOSED')return t.netPnl;
  const r=t.realization;
  return (r?.gross??0)+direction(t.side)*t.quantity*(price-t.entryPrice)-t.entryFee-(r?.fees??0)-(r?.funding??0);
}
export type PaidLeg={side:Trade['side'];entryPrice:number;price:number|null;quoteAt:number|null;realizedGross:number;
  floatingGross:number|null;grossPnl:number|null;entryFees:number;exitFees:number;fees:number;bookedFunding:number;
  netPnl:number|null;estimatedExitFee:number|null};
export type PaidPair={version:typeof PAID_FEE_VIEW_VERSION;tradeId:string;sourceId:string;status:Trade['status'];asOf:number;
  quoteFresh:boolean;remainingQuantity:number;exitFills:number;administrative:boolean;source:PaidLeg;inverse:PaidLeg;
  grossGap:number|null;paidFees:number;bookedFunding:number;netGap:number|null};

/** Closed rows reconstruct from immutable fills, even after source history eviction.
 * Open source prices are never fabricated by negating inverse PnL or reusing its mark. */
export function pairedPaidView(t:Trade,q?:Quote,now=t.lastQuoteAt,source?:Trade):PaidPair|null{
  const i=t.inverseCopy;if(!i||!i.fills.length)return null;
  const closed=t.status==='CLOSED',first=i.fills[0]!,last=i.fills.at(-1)!,exits=i.fills.filter(f=>f.kind!=='OPEN');
  const fresh=!!q&&q.fresh&&positive(q.bestBid)&&positive(q.bestAsk)&&q.bestAsk>=q.bestBid
    &&finite(q.observedAt)&&q.observedAt<=now&&now-q.observedAt<=10000;
  function leg(isSource:boolean):PaidLeg{
    const side=isSource?i!.sourceSide:t.side,entryPrice=isSource?first.sourcePrice:first.price;
    const saved=isSource?source:t;
    const savedValid=!!saved&&positive(saved.lastPrice)&&finite(saved.lastQuoteAt)&&saved.lastQuoteAt<=now;
    const price=closed?(isSource?last.sourcePrice:last.price):fresh?(side==='LONG'?q!.bestBid:q!.bestAsk):savedValid?saved!.lastPrice:null;
    const quoteAt=closed?(isSource?last.sourceQuoteAt:last.quoteAt):fresh?q!.observedAt:savedValid?saved!.lastQuoteAt:null;
    const entryFees=i!.fills.filter(f=>f.kind==='OPEN').reduce((n,f)=>n+(isSource?f.sourceFee:f.fee),0);
    const exitFees=exits.reduce((n,f)=>n+(isSource?f.sourceFee:f.fee),0);
    const bookedFunding=i!.fills.reduce((n,f)=>n+(isSource?f.sourceFunding:f.funding),0);
    const realizedGross=exits.reduce((n,f)=>n+(isSource?f.sourceGross:f.gross),0);
    const floatingGross=closed?0:price===null?null:direction(side)*t.quantity*(price-entryPrice);
    const grossPnl=floatingGross===null?null:realizedGross+floatingGross,fees=entryFees+exitFees;
    const entryNotional=first.quantity*entryPrice,feeRate=entryNotional>0?entryFees/entryNotional:0;
    return{side,entryPrice,price,quoteAt,realizedGross,floatingGross,grossPnl,entryFees,exitFees,fees,bookedFunding,
      netPnl:grossPnl===null?null:grossPnl-fees-bookedFunding,
      // Diagnostic only, explicitly excluded from paid fees and netPnl.
      estimatedExitFee:closed?0:price===null?null:t.quantity*price*feeRate};
  }
  const s=leg(true),v=leg(false),gross=sumKnown([s.grossPnl,v.grossPnl]),net=sumKnown([s.netPnl,v.netPnl]);
  return{version:PAID_FEE_VIEW_VERSION,tradeId:t.id,sourceId:i.sourceId,status:t.status,asOf:now,quoteFresh:closed||fresh,
    remainingQuantity:closed?0:t.quantity,exitFills:exits.length,administrative:i.fills.some(f=>!!f.administrative),source:s,inverse:v,
    grossGap:gross===null?null:-gross,paidFees:s.fees+v.fees,bookedFunding:s.bookedFunding+v.bookedFunding,netGap:net===null?null:-net};
}

/** Cumulative paid totals come from the durable ledger, never truncated history.
 * Only active pairs need prices. No new persistence, data requests or curve rewrites. */
export function inversePaidFeeView(state:ForwardState,quotes:Record<string,Quote>,now:number){
  const trial=state.inverseTrial;if(!trial)return null;
  const a=trial.totals,rows:PaidPair[]=[];
  for(const t of state.positions){if(!t.inverseCopy)continue;
    const row=pairedPaidView(t,quotes[t.symbol],now,trial.source.positions.find(s=>s.id===t.inverseCopy!.sourceId));
    if(row)rows.push(row);
  }
  const sourceFloating=sumKnown(rows.map(r=>r.source.floatingGross)),inverseFloating=sumKnown(rows.map(r=>r.inverse.floatingGross));
  const total=(gross:number,fees:number,funding:number,floating:number|null)=>({realizedGross:gross,floatingGross:floating,
    grossPnl:floating===null?null:gross+floating,fees,bookedFunding:funding,netPnl:floating===null?null:gross+floating-fees-funding});
  const source=total(a.sourceGross,a.sourceFees,a.sourceFunding,sourceFloating),inverse=total(a.gross,a.fees,a.funding,inverseFloating);
  const openGross=sumKnown([sourceFloating,inverseFloating]),bothNet=sumKnown([source.netPnl,inverse.netPnl]);
  return{version:PAID_FEE_VIEW_VERSION,asOf:now,scope:'POST_CUTOVER_PAIRED_ONLY',source,inverse,rows,
    stalePairs:rows.filter(r=>!r.quoteFresh).length,missingSourceMarks:rows.filter(r=>r.source.price===null).length,
    estimatedExitFees:{source:sumKnown(rows.map(r=>r.source.estimatedExitFee)),inverse:sumKnown(rows.map(r=>r.inverse.estimatedExitFee)),includedInNet:false},
    reconciliation:{paidFees:a.sourceFees+a.fees,bookedFunding:a.sourceFunding+a.funding,realizedGrossGap:a.spreadDrag,
      openGrossGap:openGross===null?null:-openGross,netGap:bothNet===null?null:-bothNet},
    accountingBasis:'Realized gross plus remaining marked gross minus own booked fees/funding only; no future exit fee.'};
}
