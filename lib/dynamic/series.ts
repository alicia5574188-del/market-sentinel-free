/**
 * dynamic-v1: compact bar series for the research layer's history (typed arrays, no per-bar objects) and the indicators the
 * playbook pool and the state monitor share. Pure; no request, no storage.
 */
export type Iv="1d"|"4h"|"1h";
export const IV_SEC:Record<Iv,number>={"1d":86_400,"4h":14_400,"1h":3_600};
export type Bar={t:number;o:number;h:number;l:number;c:number;v:number};
/** time (s, bar open) ascending, unique; a gap is allowed (listing pauses), indicators just run over it */
export class Series{
  t:Float64Array;o:Float64Array;h:Float64Array;l:Float64Array;c:Float64Array;v:Float64Array;n=0;
  sym:string;iv:Iv;
  constructor(sym:string,iv:Iv,cap=64){this.sym=sym;this.iv=iv;this.t=new Float64Array(cap);this.o=new Float64Array(cap);this.h=new Float64Array(cap);
    this.l=new Float64Array(cap);this.c=new Float64Array(cap);this.v=new Float64Array(cap);}
  get first(){return this.n?this.t[0]!:null;}
  get last(){return this.n?this.t[this.n-1]!:null;}
  private grow(cap:number){if(cap<=this.t.length)return;const k=(a:Float64Array)=>{const b=new Float64Array(cap);b.set(a.subarray(0,this.n));return b;};
    this.t=k(this.t);this.o=k(this.o);this.h=k(this.h);this.l=k(this.l);this.c=k(this.c);this.v=k(this.v);}
  /** merge rows (any order, overlaps replaced by the incoming row); returns how many bars were new */
  merge(rows:readonly Bar[]){
    const ok=rows.filter(validBar);if(!ok.length)return 0;
    const m=new Map<number,Bar>();for(let i=0;i<this.n;i++)m.set(this.t[i]!,this.bar(i));
    const before=m.size;for(const r of ok)m.set(r.t,r);
    const all=[...m.values()].sort((a,b)=>a.t-b.t);this.grow(Math.max(64,all.length));
    all.forEach((r,i)=>{this.t[i]=r.t;this.o[i]=r.o;this.h[i]=r.h;this.l[i]=r.l;this.c[i]=r.c;this.v[i]=r.v;});this.n=all.length;
    return m.size-before;
  }
  /** append bars strictly newer than the last one (fast path for the live tail) */
  append(rows:readonly Bar[]){
    const last=this.last??-Infinity,xs=rows.filter(r=>validBar(r)&&r.t>last).sort((a,b)=>a.t-b.t);
    if(!xs.length)return 0;
    if(rows.some(r=>validBar(r)&&r.t<=last))return this.merge(rows);
    this.grow(Math.max(64,(this.n+xs.length)*1.5|0));
    for(const r of xs){const i=this.n++;this.t[i]=r.t;this.o[i]=r.o;this.h[i]=r.h;this.l[i]=r.l;this.c[i]=r.c;this.v[i]=r.v;}
    return xs.length;
  }
  bar(i:number):Bar{return{t:this.t[i]!,o:this.o[i]!,h:this.h[i]!,l:this.l[i]!,c:this.c[i]!,v:this.v[i]!};}
  /** keep only the last `keep` bars (memory: the full history lives in D1) */
  trim(keep:number){if(this.n<=keep)return 0;const d=this.n-keep;
    for(const a of [this.t,this.o,this.h,this.l,this.c,this.v])a.copyWithin(0,d,this.n);this.n=keep;return d;}
  /** index of the last bar with t ≤ time, or -1 */
  indexAtOrBefore(time:number){let lo=0,hi=this.n-1,ans=-1;while(lo<=hi){const m=(lo+hi)>>1;if(this.t[m]!<=time){ans=m;lo=m+1;}else hi=m-1;}return ans;}
  rows(from=0,to=this.n):Bar[]{const out:Bar[]=[];for(let i=Math.max(0,from);i<Math.min(this.n,to);i++)out.push(this.bar(i));return out;}
}
export function validBar(r:Bar|undefined|null):r is Bar{
  return !!r&&[r.t,r.o,r.h,r.l,r.c,r.v].every(Number.isFinite)&&r.t>0&&r.o>0&&r.c>0&&r.l>0&&r.h>=Math.max(r.o,r.c)&&r.l<=Math.min(r.o,r.c)&&r.v>=0;
}
// ---------------------------------------------------------------- indicators (arrays aligned with the series, NaN while warming)
export function ema(x:ArrayLike<number>,n:number,len=x.length){
  const out=new Float64Array(len).fill(NaN),k=2/(n+1);let e=NaN,s=0;
  for(let i=0;i<len;i++){const v=x[i]!;if(i<n){s+=v;if(i===n-1){e=s/n;out[i]=e;}continue;}e=v*k+e*(1-k);out[i]=e;}
  return out;
}
export function sma(x:ArrayLike<number>,n:number,len=x.length){
  const out=new Float64Array(len).fill(NaN);let s=0;for(let i=0;i<len;i++){s+=x[i]!;if(i>=n)s-=x[i-n]!;if(i>=n-1)out[i]=s/n;}return out;
}
/** simple mean of true ranges over n bars ending at i (same as the research's rolling(n).mean() of TR; TR[0]=h-l) */
export function atr(s:Series,n:number){
  const len=s.n,tr=new Float64Array(len);
  for(let i=0;i<len;i++){const hl=s.h[i]!-s.l[i]!;if(!i){tr[i]=NaN;continue;}const pc=s.c[i-1]!;tr[i]=Math.max(hl,Math.abs(s.h[i]!-pc),Math.abs(s.l[i]!-pc));}
  const out=new Float64Array(len).fill(NaN);let sum=0,cnt=0;
  for(let i=1;i<len;i++){sum+=tr[i]!;cnt++;if(cnt>n){sum-=tr[i-n]!;cnt=n;}if(cnt===n)out[i]=sum/n;}
  return out;
}
/** highest of x over the n bars before i (excludes i) */
export function priorMax(x:ArrayLike<number>,n:number,len=x.length){const out=new Float64Array(len).fill(NaN);
  for(let i=n;i<len;i++){let m=-Infinity;for(let j=i-n;j<i;j++)m=Math.max(m,x[j]!);out[i]=m;}return out;}
export function priorMin(x:ArrayLike<number>,n:number,len=x.length){const out=new Float64Array(len).fill(NaN);
  for(let i=n;i<len;i++){let m=Infinity;for(let j=i-n;j<i;j++)m=Math.min(m,x[j]!);out[i]=m;}return out;}
/** lowest of x over the n bars ending at i (includes i) */
export function rollMin(x:ArrayLike<number>,n:number,len=x.length){const out=new Float64Array(len).fill(NaN);
  for(let i=n-1;i<len;i++){let m=Infinity;for(let j=i-n+1;j<=i;j++)m=Math.min(m,x[j]!);out[i]=m;}return out;}
export function rollMax(x:ArrayLike<number>,n:number,len=x.length){const out=new Float64Array(len).fill(NaN);
  for(let i=n-1;i<len;i++){let m=-Infinity;for(let j=i-n+1;j<=i;j++)m=Math.max(m,x[j]!);out[i]=m;}return out;}
/** Kaufman efficiency ratio over n bars: |c[i]-c[i-n]| / Σ|Δc| (1 = straight line, ~0 = chop) */
export function efficiency(c:ArrayLike<number>,n:number,len=c.length){const out=new Float64Array(len).fill(NaN);
  for(let i=n;i<len;i++){let p=0;for(let j=i-n+1;j<=i;j++)p+=Math.abs(c[j]!-c[j-1]!);out[i]=p>0?Math.abs(c[i]!-c[i-n]!)/p:0;}return out;}
export function corr(a:ArrayLike<number>,b:ArrayLike<number>){
  const n=Math.min(a.length,b.length);if(n<3)return NaN;let ma=0,mb=0;for(let i=0;i<n;i++){ma+=a[i]!;mb+=b[i]!;}ma/=n;mb/=n;
  let sab=0,saa=0,sbb=0;for(let i=0;i<n;i++){const x=a[i]!-ma,y=b[i]!-mb;sab+=x*y;saa+=x*x;sbb+=y*y;}return saa>0&&sbb>0?sab/Math.sqrt(saa*sbb):NaN;
}
