/** A wick entry is only valid in the first 30 seconds after the 5-minute close. */
export const WICK_ENTRY_MS=30_000;
/** The executable book can arrive one cycle after the signal. An order already
 * accepted inside the 30s window may finish that fill; a new order still cannot start after 30s. */
export const WICK_FILL_GRACE_MS=20_000;
/** Take-profit price that nets `minNet` after both taker fees. Undefined when size cannot reach it above zero. */
export function wickProfitTarget(side:'LONG'|'SHORT',entry:number,quantity:number,minNet=5,fee=.0005){
  if(!(entry>0)||!(quantity>0)||!(minNet>0)||!(fee>=0)||fee>=1)return;
  const raw=side==='LONG'
    ?(minNet+entry*quantity*(1+fee))/(quantity*(1-fee))
    :(entry*quantity*(1-fee)-minNet)/(quantity*(1+fee));
  if(!Number.isFinite(raw)||raw<=0)return;
  if(side==='LONG'?raw<=entry:raw>=entry)return;
  return raw;
}
/** Further of the candle multiple and the 5U price. Does not change size or the frozen proof. */
export function wickGoal(side:'LONG'|'SHORT',entry:number,quantity:number,candle:number,bodyTp:number,signal:number){
  if(!(candle>0)||!(entry>0))return candle;
  const dir=side==='LONG'?1:-1,minNet=quantity>0?wickProfitTarget(side,entry,quantity):undefined;
  const lifted=minNet!==undefined&&dir*(minNet-candle)>0&&(!(signal>0)||dir*(minNet-signal)>0)?minNet:candle;
  const anchored=dir>0?entry+Math.max(0,bodyTp):entry-Math.max(0,bodyTp);
  const goal=dir>0?Math.max(anchored,lifted):Math.min(anchored,lifted);
  if(!(goal>0)||(dir>0?goal<=entry:goal>=entry))return candle;
  return goal;
}
