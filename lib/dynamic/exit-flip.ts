/**
 * Reverse hold (the 224-trade replay that came out about +150 U).
 * A new order takes the other side. Both the stop and the target sit one original-stop-distance
 * away from the entry. The old target is not used: the distance that used to be the loss is now
 * the profit, and the same distance the other way is the loss. Open trades are not rewritten.
 * Returns null when the prices are not a real stop and a real target, in which case the order is not sent.
 */
export function flipExits(side:"LONG"|"SHORT",entry:number,stop:number,target:number|null):{side:"LONG"|"SHORT";stop:number;target:number}|null{
  void target;
  if(!(entry>0)||!(stop>0)||!Number.isFinite(entry)||!Number.isFinite(stop))return null;
  const dist=Math.abs(entry-stop);
  if(!(dist>0)||dist>=entry)return null;
  const next=side==="LONG"?"SHORT":"LONG";
  const newStop=next==="LONG"?entry-dist:entry+dist;
  const newTarget=next==="LONG"?entry+dist:entry-dist;
  if(!(newStop>0)||!(newTarget>0))return null;
  return {side:next,stop:newStop,target:newTarget};
}

/** One closed trade, held the other way, on its own minute bars. Same rule as the +150 U replay:
 *  first touch of ± the original stop distance; stop wins if both print in one bar; if the path
 *  never gets there, mark at the original exit. No path or no stop distance → just flip the price PnL. */
export function reverseTradeNet(p:{
  side:"LONG"|"SHORT";entry:number|null;exit:number|null;stopDistPct:number|null;
  notional:number|null;fee:number|null;gross:number|null;bars:[number,number][]|null;
}):number{
  const fee=p.fee??0,gross=p.gross??0;
  const entry=p.entry,sd=p.stopDistPct,nom=p.notional,bars=p.bars;
  if(!(entry!=null&&entry>0)||!(sd!=null&&sd>0)||!(nom!=null&&nom>0)||!bars)return -gross-fee;
  const dist=sd/100,rev=p.side==="LONG"?"SHORT":"LONG";
  const stopPx=rev==="SHORT"?entry*(1+dist):entry*(1-dist);
  const tgtPx=rev==="SHORT"?entry*(1-dist):entry*(1+dist);
  let px=p.exit;
  for(const bar of bars){
    let lo=bar[0],hi=bar[1];if(lo>hi){const s=lo;lo=hi;hi=s;}
    const hitStop=rev==="SHORT"?hi>=stopPx:lo<=stopPx;
    const hitTarget=rev==="SHORT"?lo<=tgtPx:hi>=tgtPx;
    if(hitStop){px=stopPx;break;}
    if(hitTarget){px=tgtPx;break;}
  }
  if(px==null)return -gross-fee;
  const move=rev==="SHORT"?(entry-px)/entry:(px-entry)/entry;
  return nom*move-fee;
}
