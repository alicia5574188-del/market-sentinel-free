/** Small pure helpers for the living layer. */
export const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
export function median(xs:number[]){
  const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return NaN;
  const m=a.length>>1;return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;
}
export function mad(xs:number[]){const m=median(xs);return median(xs.map(x=>Math.abs(x-m)));}
export function mean(xs:number[]){return xs.length?xs.reduce((n,x)=>n+x,0)/xs.length:NaN;}
export function quantile(xs:number[],q:number){
  const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return NaN;
  const p=clamp(q,0,1)*(a.length-1),i=Math.floor(p),f=p-i;return a[i]!+(a[Math.min(a.length-1,i+1)]!-a[i]!)*f;
}
export function corr(x:number[],y:number[]){
  const n=Math.min(x.length,y.length);if(n<3)return NaN;
  const mx=mean(x.slice(0,n)),my=mean(y.slice(0,n));let a=0,b=0,c=0;
  for(let i=0;i<n;i++){const dx=x[i]!-mx,dy=y[i]!-my;a+=dx*dy;b+=dx*dx;c+=dy*dy;}
  return b>0&&c>0?a/Math.sqrt(b*c):NaN;
}
export const r6=(v:number)=>Math.round(v*1e6)/1e6;
export const r4=(v:number)=>Math.round(v*1e4)/1e4;
export const pct=(v:number,d=2)=>`${v>=0?"+":""}${(v*100).toFixed(d)}%`;
export const dirOf=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
export function bytesOf(value:unknown){return new TextEncoder().encode(JSON.stringify(value)).length;}
/** Drop oldest items until the value fits `max` bytes. `list` returns the array to trim (oldest first). */
export function fitBytes<T>(value:T,max:number,list:(v:T)=>unknown[]|undefined){
  let guard=0;
  while(bytesOf(value)>max&&guard++<10_000){const xs=list(value);if(!xs||!xs.length)break;xs.splice(0,Math.max(1,Math.ceil(xs.length*.05)));}
  return value;
}
