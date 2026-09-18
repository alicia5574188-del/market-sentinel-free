/** Read-only observations. Nothing in this module authorizes trading. */
export const EQUITY_CURVE_VERSION = "observed-equity-reference-v1";
export const FIVE_MINUTES = 300_000;
export const CURVE_GAP = 15 * 60_000;
export const DAY_MS = 86_400_000;
export type EquityPoint = { at:number; equity:number; kind:"origin"|"observed"|"preview";
  policy:string; homogeneous:boolean };
export type CurveContext = { startedAt:number; initialEquity:number; policy:string;
  exitPolicy:string; comparableSince:number; persistedAt:number };
export type CurvePage = { version:string; context:CurveContext; points:EquityPoint[];
  nextCursor:string|null; scannedTo:number|null; omitted:number; scanned:number; generatedAt:number };
const valid = (n:unknown):n is number => typeof n==="number"&&Number.isFinite(n);
type Packet = {at?:number;startedAt?:number;policyVersion?:string;
  daily?:{lastAt?:number;endEquity?:number};
  account?:{positions?:{lastQuoteAt?:number;exitControl?:{policy?:string}}[]}};

/** The archive's day endpoint is an actual mark at that packet's data cycle.
 * Never reconstruct floating equity from closed trades, extrema or later quotes.
 * Split packet bodies and stale valuations cannot become extra observations. */
export function archivedEquity(value:unknown,context:CurveContext,now:number):EquityPoint|null {
  if(!value||typeof value!=="object")return null;
  const p=value as Packet,d=p.daily,positions=p.account?.positions;
  if(p.startedAt!==context.startedAt||!valid(p.at)||p.at<context.startedAt||p.at>now
    ||!d||d.lastAt!==p.at||!valid(d.endEquity)||!Array.isArray(positions))return null;
  if(positions.some(t=>!valid(t.lastQuoteAt)||t.lastQuoteAt>p.at!+1000||p.at!-t.lastQuoteAt>8000))return null;
  return {at:p.at,equity:d.endEquity,kind:"observed",policy:p.policyVersion??"legacy",
    homogeneous:p.at>=context.comparableSince&&p.policyVersion===context.policy
      &&positions.every(t=>t.exitControl?.policy===context.exitPolicy)};
}
export function mergeEquity(points:EquityPoint[],context:CurveContext,now:number):EquityPoint[] {
  const byTime=new Map<number,EquityPoint>();
  // Persisted points win over a simultaneous uncommitted screen preview.
  for(const p of points)if(valid(p.at)&&valid(p.equity)&&p.at>context.startedAt&&p.at<=now
    &&(!byTime.has(p.at)||p.kind==="observed"))byTime.set(p.at,p);
  const sorted=[...byTime.values()].sort((a,b)=>a.at-b.at);
  return [{at:context.startedAt,equity:context.initialEquity,kind:"origin",policy:"initial",homogeneous:false},...sorted];
}
export type XY = {x:number;y:number};
/** Monotone Hermite / slope limiting: visits every supplied point, never adds
 * an extremum between adjacent points. This changes geometry, not statistics. */
export function smoothPath(points:XY[]):string {
  if(!points.length)return "";
  const f=(v:number)=>Number(v.toFixed(4));
  let path=`M${f(points[0].x)},${f(points[0].y)}`;
  if(points.length===1)return path;
  const d=points.slice(1).map((p,i)=>(p.y-points[i].y)/(p.x-points[i].x));
  const m=points.map((_,i)=>i===0?d[0]:i===points.length-1?d.at(-1)!:
    d[i-1]*d[i]<=0?0:2/(1/d[i-1]+1/d[i]));
  for(let i=0;i<d.length;i++){
    if(d[i]===0){m[i]=m[i+1]=0;continue;}
    const a=m[i]/d[i],b=m[i+1]/d[i],s=a*a+b*b;
    if(s>9){const scale=3/Math.sqrt(s);m[i]=scale*a*d[i];m[i+1]=scale*b*d[i];}
  }
  for(let i=0;i<points.length-1;i++){
    const a=points[i],b=points[i+1],h=(b.x-a.x)/3;
    path+=` C${f(a.x+h)},${f(a.y+h*m[i])} ${f(b.x-h)},${f(b.y-h*m[i+1])} ${f(b.x)},${f(b.y)}`;
  }
  return path;
}
export function curveSegments(points:EquityPoint[]):EquityPoint[][] {
  const result:EquityPoint[][]=[];
  for(const p of points){const last=result.at(-1),prev=last?.at(-1);
    if(!prev||p.at-prev.at>CURVE_GAP)result.push([p]);else last!.push(p);}
  return result;
}
export function nearestPoint(points:EquityPoint[],at:number):EquityPoint|null {
  if(!points.length)return null;
  let lo=0,hi=points.length-1;
  while(lo<hi){const m=Math.floor((lo+hi)/2);if(points[m].at<at)lo=m+1;else hi=m;}
  return lo&&Math.abs(points[lo-1].at-at)<Math.abs(points[lo].at-at)?points[lo-1]:points[lo];
}

export type DrawdownSignal={at:number;depth:number;value:number;afterHour:number|null;furtherDrawdown:number|null};
export type EquityReference = {state:"unavailable"|"insufficient"|"declining"|"observing"|"recovering";
  sentence:string; detail:string; drawdown:number|null; samples:number; positive:number;
  medianAfterHour:number|null; signals:DrawdownSignal[]; automatic:false};
const median=(a:number[])=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor((b.length-1)/2)]:null;};
/** Predeclared descriptive conditions, NOT optimized by account profits:
 * drawdown >=1%, +0.2% over30m and recover >=25% of drop. One observation per
 * peak-to-recovery episode; one-hour outcomes must be non-overlapping and past.
 * Unrecovered episodes/signals are not deleted; immature outcomes remain null.
 * Chart interpolation and a user's chosen visible range NEVER enter this logic. */
export function equityReference(all:EquityPoint[],context:CurveContext,now:number,healthy:boolean,complete:boolean):EquityReference {
  const base={drawdown:null,samples:0,positive:0,medianAfterHour:null,signals:[],automatic:false} as const;
  const unavailable=(sentence:string):EquityReference=>({...base,signals:[],state:"unavailable",sentence,
    detail:"只读参考；不自动开关实盘，不改变模拟交易。"});
  const points=mergeEquity(all,context,now).filter(p=>p.kind==="observed"&&p.homogeneous
    &&p.policy===context.policy&&p.at>=Math.max(context.comparableSince,now-7*DAY_MS));
  if(!healthy)
    return unavailable("最新净值记录不足或已过期，暂不能判断开启时机；请先确认数据恢复。");
  if(!points.length)return {...unavailable("当前退出规则下的可比较记录还不足，建议先观察，不用旧规则下的回撤推定开启时间。"),state:"insufficient"};
  if(now-points.at(-1)!.at>10*60_000)return unavailable("最新可比较净值记录已过期，暂不能判断开启时机；请先确认数据恢复。");
  // Only the latest uninterrupted segment is comparable, not a line drawn across a data outage.
  let start=0;for(let i=1;i<points.length;i++)if(points[i].at-points[i-1].at>CURVE_GAP)start=i;
  const p=points.slice(start),last=p.at(-1)!;
  if(p.some(v=>v.equity<=0))return unavailable("近期记录包含非正净值，不能据此建议开启实盘。");
  let peak=p[0].equity,low=peak,active=false,signalSent=false,lastSignal=-Infinity;
  const signals:DrawdownSignal[]=[];let currentSignal:DrawdownSignal|null=null;
  for(let i=0;i<p.length;i++){
    const q=p[i];
    if(q.equity>=peak){peak=q.equity;low=peak;active=false;signalSent=false;currentSignal=null;}
    low=Math.min(low,q.equity);
    if(1-q.equity/peak>=.01)active=true;
    const earlier=nearestPoint(p.slice(0,i+1),q.at-30*60_000);
    const rising=earlier&&q.at-earlier.at>=25*60_000&&q.at-earlier.at<=35*60_000&&q.equity/earlier.equity-1>=.002;
    if(active&&!signalSent&&rising&&peak>low&&(q.equity-low)/(peak-low)>=.25&&q.at-lastSignal>=60*60_000){
      const signal:DrawdownSignal={at:q.at,depth:1-low/peak,value:q.equity,afterHour:null,furtherDrawdown:null};
      signals.push(signal);currentSignal=signal;lastSignal=q.at;signalSent=true;
    }
  }
  for(const s of signals){const end=p.find(v=>v.at>=s.at+60*60_000);
    if(end&&end.at<=s.at+70*60_000&&end.at<=now){
      s.afterHour=end.equity/s.value-1;
      s.furtherDrawdown=Math.max(0,...p.filter(v=>v.at>=s.at&&v.at<=end.at).map(v=>1-v.equity/s.value));
    }}
  const depth=1-low/peak,band=(n:number)=>n<.02?0:n<.05?1:2;
  const comparable=signals.filter(s=>s.afterHour!=null&&band(s.depth)===band(depth));
  const positive=comparable.filter(s=>s.afterHour!>0).length,med=median(comparable.map(s=>s.afterHour!));
  const half=Math.floor(comparable.length/2),early=comparable.slice(0,half),recent=comparable.slice(half);
  const supports=comparable.length>=6&&positive/comparable.length>=2/3
    &&(median(early.map(s=>s.afterHour!))??-1)>0&&(median(recent.map(s=>s.afterHour!))??-1)>0;
  const before=nearestPoint(p,last.at-30*60_000),prior=nearestPoint(p,last.at-60*60_000);
  const has30=before&&last.at-before.at>=25*60_000;
  const fall=has30&&last.equity<before.equity;
  const sustained=has30&&prior&&last.at-prior.at>=55*60_000&&last.equity>before.equity&&before.equity>=prior.equity;
  const dd=Math.max(0,1-last.equity/peak);
  const detail=`同一退出规则、连续有效记录中的相近回撤，已完成1小时观察${comparable.length}次，其中${positive}次回升`+
    (med==null?"。":`，中间值${(med*100).toFixed(2)}%。`)+
    "这只是模拟整账户的历史变化，含已有仓位；实盘只跟开启后的新单，不能复制此前反弹。参考条件不是已验证的择时策略，过去表现不保证未来。";
  const result={drawdown:dd,samples:comparable.length,positive,medianAfterHour:med,signals,automatic:false as const,detail};
  if(!complete||last.at-p[0].at<DAY_MS||p.length<200||comparable.length<6)
    return {...result,state:"insufficient",sentence:`当前距可比较记录高点回撤${(dd*100).toFixed(2)}%，相近记录不足，尚不能据此确定开启时间；建议等回撤不再扩大、随后新单表现改善后再考虑手动开启。`};
  if(fall)return {...result,state:"declining",sentence:`近30分钟净值仍走低、回撤${(dd*100).toFixed(2)}%，建议先等待止跌回升，不因“已经跌了不少”就开启实盘。`};
  if(supports&&sustained&&currentSignal&&last.at-currentSignal.at<=60*60_000)
    return {...result,state:"recovering",sentence:`回撤已收窄、近1小时持续回升，近期${comparable.length}次相近观察中${positive}次随后回升，可作为手动开启的参考；不代表开启后的新单必然盈利。`};
  return {...result,state:"observing",sentence:"回撤回升的依据尚不一致，建议继续观察，待净值持续回升、开启后可跟的新单表现改善时，再由你决定是否开启实盘。"};
}