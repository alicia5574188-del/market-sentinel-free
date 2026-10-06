/** Read-only presentation for the exact same-price mirror experiment. Never feeds decisions. */
import type {ForwardState,Quote,Trade} from './forward-relations.ts';
import {INVERSE_COST} from './inverse-fee.ts';

export const PAID_FEE_VIEW_VERSION='paid-fee-view-v3-own-fees';
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const positive=(n:unknown):n is number=>finite(n)&&n>0;
const direction=(side:Trade['side'])=>side==='LONG'?1:-1;
const sumKnown=(values:(number|null)[]):number|null=>values.every(finite)?values.reduce<number>((n,v)=>n+(v??0),0):null;

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
  floatingGross:number|null;grossPnl:number|null;entryFees:number;exitFees:number;fees:number;netPnl:number|null;estimatedExitFee:number|null};
export type PaidPair={version:typeof PAID_FEE_VIEW_VERSION;tradeId:string;sourceId:string;status:Trade['status'];asOf:number;
  quoteFresh:boolean;remainingQuantity:number;exitFills:number;administrative:boolean;source:PaidLeg;inverse:PaidLeg;
  grossMirrorResidual:number|null;paidFees:number;netSum:number|null};

/** Both sides use the exact source event price and the exact same current source mark.
 * Therefore gross PnL must be equal and opposite; only each side's filled fees may differ net PnL. */
export function pairedPaidView(t:Trade,_q?:Quote,now=t.lastQuoteAt,source?:Trade):PaidPair|null{
  const i=t.inverseCopy;if(!i||!i.fills.length)return null;const copy=i;
  const closed=t.status==='CLOSED',first=copy.fills[0]!,last=copy.fills.at(-1)!,exits=copy.fills.filter(f=>f.kind!=='OPEN');
  const sourceValid=!!source&&positive(source.lastPrice)&&finite(source.lastQuoteAt)&&source.lastQuoteAt<=now;
  const sharedPrice=closed?last.sourcePrice:sourceValid?source!.lastPrice:null;
  const sharedQuoteAt=closed?last.sourceQuoteAt:sourceValid?source!.lastQuoteAt:null;
  const fresh=closed||!!(sourceValid&&now-source!.lastQuoteAt<=10000);
  const sourceEntry=first.sourcePrice,sourceEntryFees=copy.fills.filter(f=>f.kind==='OPEN').reduce((n,f)=>n+f.sourceFee,0),
    sourceExitFees=exits.reduce((n,f)=>n+f.sourceFee,0),sourceRealized=exits.reduce((n,f)=>n+f.sourceGross,0),
    sourceFloating=closed?0:sharedPrice===null?null:direction(copy.sourceSide)*t.quantity*(sharedPrice-sourceEntry);
  function leg(isSource:boolean):PaidLeg{
    const side=isSource?copy.sourceSide:t.side,entryPrice=sourceEntry,
      entryFees=isSource?sourceEntryFees:copy.fills.filter(f=>f.kind==='OPEN').reduce((n,f)=>n+f.fee,0),
      exitFees=isSource?sourceExitFees:exits.reduce((n,f)=>n+f.fee,0),
      realizedGross=isSource?sourceRealized:-sourceRealized,floatingGross=sourceFloating===null?null:isSource?sourceFloating:-sourceFloating,
      grossPnl=floatingGross===null?null:realizedGross+floatingGross,fees=entryFees+exitFees,
      estimatedExitFee=closed?0:sharedPrice===null?null:t.quantity*sharedPrice*INVERSE_COST.feeRate;
    return{side,entryPrice,price:sharedPrice,quoteAt:sharedQuoteAt,realizedGross,floatingGross,grossPnl,entryFees,exitFees,fees,
      netPnl:grossPnl===null?null:grossPnl-fees,estimatedExitFee};
  }
  const s=leg(true),v=leg(false),gross=sumKnown([s.grossPnl,v.grossPnl]),net=sumKnown([s.netPnl,v.netPnl]);
  return{version:PAID_FEE_VIEW_VERSION,tradeId:t.id,sourceId:copy.sourceId,status:t.status,asOf:now,quoteFresh:fresh,
    remainingQuantity:closed?0:t.quantity,exitFills:exits.length,administrative:copy.fills.some(f=>!!f.administrative),source:s,inverse:v,
    grossMirrorResidual:gross,paidFees:s.fees+v.fees,netSum:net};
}

/** Cumulative comparison is reconstructed from the source ledger so old BBO implementation artifacts
 * cannot survive into this same-price experiment view. */
export function inversePaidFeeView(state:ForwardState,_quotes:Record<string,Quote>,now:number){
  const trial=state.inverseTrial;if(!trial)return null;
  const a=trial.totals,rows:PaidPair[]=[];
  for(const t of state.positions){if(!t.inverseCopy)continue;
    const row=pairedPaidView(t,undefined,now,trial.source.positions.find(s=>s.id===t.inverseCopy!.sourceId));if(row)rows.push(row);
  }
  const sourceFloating=sumKnown(rows.map(r=>r.source.floatingGross));
  const sourceGross=sourceFloating===null?null:a.sourceGross+sourceFloating,
    inverseGross=sourceGross===null?null:-sourceGross,
    source={realizedGross:a.sourceGross,floatingGross:sourceFloating,grossPnl:sourceGross,fees:a.sourceFees,
      netPnl:sourceGross===null?null:sourceGross-a.sourceFees},
    inverse={realizedGross:-a.sourceGross,floatingGross:sourceFloating===null?null:-sourceFloating,grossPnl:inverseGross,fees:a.fees,
      netPnl:inverseGross===null?null:inverseGross-a.fees},
    netSum=sumKnown([source.netPnl,inverse.netPnl]);
  return{version:PAID_FEE_VIEW_VERSION,asOf:now,scope:'POST_CUTOVER_PAIRED_ONLY_EXACT_PRICE',source,inverse,rows,
    stalePairs:rows.filter(r=>!r.quoteFresh).length,missingSourceMarks:rows.filter(r=>r.source.price===null).length,
    estimatedExitFees:{source:sumKnown(rows.map(r=>r.source.estimatedExitFee)),inverse:sumKnown(rows.map(r=>r.inverse.estimatedExitFee)),includedInNet:false},
    reconciliation:{paidFees:a.sourceFees+a.fees,grossMirrorResidual:sourceGross===null?null:sourceGross+inverseGross!,netSum},
    accountingBasis:'Exact same source event/current price on both PAPER legs; gross PnL mirrors exactly; net deducts filled fees only.'};
}
