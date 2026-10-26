/**
 * New pool orders only. The paper book has been losing with fees about half the loss, so the price
 * itself is on the wrong side of the stop. A new order takes the other side: the old stop price becomes
 * the target (that move pays), and the old target distance becomes the stop. No target → the same
 * distance is used both ways. Open trades are not rewritten. Returns null when the flipped prices
 * are not a real stop and a real target, in which case the order is not sent.
 */
export function flipExits(side:"LONG"|"SHORT",entry:number,stop:number,target:number|null):{side:"LONG"|"SHORT";stop:number;target:number}|null{
  if(!(entry>0)||!(stop>0)||!Number.isFinite(entry)||!Number.isFinite(stop))return null;
  const stopDist=Math.abs(entry-stop);
  if(!(stopDist>0)||stopDist>=entry)return null;
  const tgtDist=target!=null&&Number.isFinite(target)&&target>0?Math.abs(entry-target):stopDist;
  if(!(tgtDist>0)||tgtDist>=entry)return null;
  const next=side==="LONG"?"SHORT":"LONG";
  const newStop=next==="LONG"?entry-tgtDist:entry+tgtDist;
  const newTarget=next==="LONG"?entry+stopDist:entry-stopDist;
  if(!(newStop>0)||!(newTarget>0))return null;
  if(next==="LONG"&&!(newStop<entry&&newTarget>entry))return null;
  if(next==="SHORT"&&!(newStop>entry&&newTarget<entry))return null;
  return {side:next,stop:newStop,target:newTarget};
}
