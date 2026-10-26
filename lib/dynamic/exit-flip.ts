/**
 * Direction only. A new order takes the other side of the same signal.
 * The stop stays one original-stop-distance from the entry, on the new side.
 * A target, when the signal had one, stays one original-target-distance from the entry, on the new side.
 * No target is invented, and no distance is swapped. Open trades are not rewritten.
 * Returns null when the stop is not a real price on the new side, in which case the order is not sent.
 */
export function flipExits(side:"LONG"|"SHORT",entry:number,stop:number,target:number|null):{side:"LONG"|"SHORT";stop:number;target:number|null}|null{
  if(!(entry>0)||!(stop>0)||!Number.isFinite(entry)||!Number.isFinite(stop))return null;
  const stopDist=Math.abs(entry-stop);
  if(!(stopDist>0)||stopDist>=entry)return null;
  const next=side==="LONG"?"SHORT":"LONG";
  const newStop=next==="LONG"?entry-stopDist:entry+stopDist;
  let newTarget:number|null=null;
  if(target!=null&&Number.isFinite(target)&&target>0){
    const tgtDist=Math.abs(entry-target);
    if(tgtDist>0&&tgtDist<entry){
      const px=next==="LONG"?entry+tgtDist:entry-tgtDist;
      if(px>0)newTarget=px;
    }
  }
  if(!(newStop>0))return null;
  if(next==="LONG"&&!(newStop<entry&&(newTarget==null||newTarget>entry)))return null;
  if(next==="SHORT"&&!(newStop>entry&&(newTarget==null||newTarget<entry)))return null;
  return {side:next,stop:newStop,target:newTarget};
}

/** One closed trade, held the other way, on its own minute bars. Research helper only:
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
