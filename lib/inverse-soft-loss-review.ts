import type {Trade} from './forward-relations.ts';
/** Research-only "what if the cut inverse had kept following its source" view.
 * Never feeds trading decisions; 5bp taker assumed for the hypothetical exit. */
export type InverseSourceMark={id:string;status:'OPEN'|'CLOSED';price:number|null;quoteAt:number|null;exitPrice:number|null;closedAt:number|null};
const HOLD_FEE_RATE=0.0005;
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
export function inverseSoftLossReview(trades:Trade[],marks:InverseSourceMark[],now:number){
  const byId=new Map(marks.map(m=>[m.id,m]));
  const rows=trades.filter(t=>t.exitReason==='INVERSE_SOFT_LOSS_EXIT'&&t.inverseCopy).map(t=>{
    const i=t.inverseCopy!,cut=i.fills.find(f=>f.earlySoftLoss),dir=t.side==='LONG'?1:-1,actual=t.netPnl??0;
    const base={tradeId:t.id,sourceId:i.sourceId,symbol:t.symbol,side:t.side,cutAt:t.closedAt??null,actualNetPnl:actual};
    if(!cut)return{...base,basis:'UNKNOWN' as const,holdPrice:null,heldNetPnl:null,ruleBenefit:null};
    const withoutCut=actual-cut.gross+cut.fee,m=byId.get(i.sourceId);
    let qty=cut.quantity,price:number|null=null,basis:'SOURCE_CLOSED'|'SOURCE_OPEN_MARK'|'UNKNOWN'='UNKNOWN',at:number|null=null;
    if(i.detachedSourceClosed&&finite(i.detachedHoldQuantity)&&i.detachedHoldQuantity>0&&finite(i.detachedHoldNotional)){
      qty=i.detachedHoldQuantity;price=i.detachedHoldNotional/qty;basis='SOURCE_CLOSED';at=i.sourceClosedAt??null;
    }else if(m?.status==='CLOSED'&&finite(m.exitPrice)){price=m.exitPrice;basis='SOURCE_CLOSED';at=m.closedAt;}
    else if(m?.status==='OPEN'&&finite(m.price)&&finite(m.quoteAt)&&now-m.quoteAt<=60_000){price=m.price;basis='SOURCE_OPEN_MARK';at=m.quoteAt;}
    if(price===null)return{...base,basis,holdPrice:null,heldNetPnl:null,ruleBenefit:null};
    const held=withoutCut+dir*qty*(price-cut.price)+dir*qty*(cut.price-t.entryPrice)-qty*price*HOLD_FEE_RATE;
    return{...base,basis,holdPrice:price,holdAt:at,heldNetPnl:held,ruleBenefit:actual-held};
  });
  const known=rows.filter(r=>r.heldNetPnl!==null),sum=(xs:number[])=>xs.reduce((a,b)=>a+b,0);
  const closed=known.filter(r=>r.basis==='SOURCE_CLOSED');
  return{version:'inverse-soft-loss-review-v1',rule:'inverse-soft-loss-5u',
    triggers:rows.length,sourceClosed:closed.length,sourceOpenMarked:known.length-closed.length,unknown:rows.length-known.length,
    actualNetPnl:sum(rows.map(r=>r.actualNetPnl)),
    knownActualNetPnl:sum(known.map(r=>r.actualNetPnl)),knownHeldNetPnl:sum(known.map(r=>r.heldNetPnl!)),
    ruleBenefit:sum(known.map(r=>r.ruleBenefit!)),settledRuleBenefit:sum(closed.map(r=>r.ruleBenefit!)),
    helped:known.filter(r=>r.ruleBenefit!>0).length,hurt:known.filter(r=>r.ruleBenefit!<0).length,
    meaning:'ruleBenefit>0 表示提前平仓比继续跟随影子少亏；SOURCE_OPEN_MARK 用影子当前价，结论未定。',
    rows};
}
