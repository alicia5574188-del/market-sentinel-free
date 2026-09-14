import { readFileSync, writeFileSync } from 'node:fs';

const INPUT=process.env.RESEARCH_DATASET??'/tmp/gate-history-44m-5m.json';
const OUTPUT=process.env.WALK_OUTPUT??'/tmp/walkforward-ridge-v2.json';
const raw=JSON.parse(readFileSync(INPUT,'utf8'));
if(raw.interval!=='5m'||raw.months.length<44||raw.datasets.length<11)throw new Error('Need frozen 44-month 11-symbol Gate 5m archive');

const DECISION=900,COST=.0014,SLIP=.00025,COOLDOWN=30*60_000,RIDGE=10;
const WINDOWS=[3,6,12],HORIZONS=[24,48],THRESHOLDS=[.0005,.001,.0015,.002,.0025,.003,.004];
const DISC_START=12,DISC_END=30,VAL_END=38,EVAL_END=44;
const sum=a=>a.reduce((x,y)=>x+y,0),med=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[b.length>>1]:0};
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(4)-1,1);
const monthIndex=t=>{const d=new Date(t*1000),k=`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;return raw.months.indexOf(k)};
const ds=raw.datasets.slice(0,11).map(d=>({symbol:d.symbol,rows:d.rows}));
function ix(r,t){let l=0,h=r.length-1;while(l<=h){const m=(l+h)>>1;if(r[m].time===t)return m;if(r[m].time<t)l=m+1;else h=m-1}return-1}
const ret=(r,i,n)=>r[i].close/r[i-n].close-1;
function rangePos(r,i,n){let hi=-1e99,lo=1e99;for(let j=i-n;j<i;j++){hi=Math.max(hi,r[j].high);lo=Math.min(lo,r[j].low)}return(r[i].close-lo)/Math.max(hi-lo,r[i].close*1e-9)}
function volBurst(r,i){let a=0,b=0;for(let j=i-2;j<=i;j++)a+=r[j].volume;for(let j=i-38;j<=i-3;j++)b+=r[j].volume;return(a/3)/Math.max(b/36,1e-9)}
function rangeRatio(r,i){let a=0,b=0;for(let j=i-5;j<=i;j++)a+=(r[j].high-r[j].low)/r[j].close;for(let j=i-77;j<=i-6;j++)b+=(r[j].high-r[j].low)/r[j].close;return(a/6)/Math.max(b/72,1e-9)}
function efficiency(r,i,n){let path=0;for(let j=i-n+1;j<=i;j++)path+=Math.abs(r[j].close/r[j-1].close-1);return Math.abs(r[i].close/r[i-n].close-1)/Math.max(path,1e-9)}

const P=19;
function blank(){return{n:0,sx:Array(P).fill(0),sxx:Array.from({length:P},()=>Array(P).fill(0)),sy:Object.fromEntries(HORIZONS.map(h=>[h,0])),sxy:Object.fromEntries(HORIZONS.map(h=>[h,Array(P).fill(0)]))}}
const stats=Array.from({length:44},blank),samples=Array.from({length:44},()=>[]),base=ds[0].rows;
for(let bi=288;bi<base.length-50;bi++){
 const t=base[bi].time;if(t%DECISION)continue;const mi=monthIndex(t);if(mi<0)continue;const ss=[];
 for(const d of ds){const i=ix(d.rows,t);if(i<288||i+49>=d.rows.length||d.rows[i+1].time!==t+300)continue;let ok=true;for(let j=i-288;j<i;j++)if(d.rows[j+1].time!==d.rows[j].time+300){ok=false;break}if(!ok)continue;ss.push({...d,i,r5:ret(d.rows,i,1),r15:ret(d.rows,i,3),r30:ret(d.rows,i,6),r1:ret(d.rows,i,12),r2:ret(d.rows,i,24),r4:ret(d.rows,i,48),r24:ret(d.rows,i,288)})}
 if(ss.length<9)continue;const m15=med(ss.map(s=>s.r15)),m1=med(ss.map(s=>s.r1)),m4=med(ss.map(s=>s.r4)),m24=med(ss.map(s=>s.r24)),b1=ss.filter(s=>s.r1>0).length/ss.length,b4=ss.filter(s=>s.r4>0).length/ss.length;
 for(const s of ss){const x=[s.r5,s.r15,s.r30,s.r1,s.r2,s.r4,s.r24,s.r15-m15,s.r1-m1,s.r4-m4,s.r24-m24,b1,b4,m1,m4,volBurst(s.rows,s.i),rangeRatio(s.rows,s.i),rangePos(s.rows,s.i,288),efficiency(s.rows,s.i,48)];const ys={};let validAny=false;for(const h of HORIZONS){if(s.rows[s.i+h]?.time===t+h*300){ys[h]=s.rows[s.i+h].close/s.rows[s.i+1].open-1;validAny=true}}
  if(!validAny)continue;samples[mi].push({t,symbol:s.symbol,rows:s.rows,i:s.i,x,ys});
  // Exclude the last four hours of every month from training stats. This is conservative and guarantees all 4h labels are resolved before the next monthly refit.
  const nextMonth=mi+1<raw.months.length?monthStart(raw.months[mi+1]):Infinity;if(t*1000>nextMonth-4*3600_000)continue;const st=stats[mi];st.n++;for(let a=0;a<P;a++){st.sx[a]+=x[a];for(let b=0;b<P;b++)st.sxx[a][b]+=x[a]*x[b]}for(const h of HORIZONS)if(ys[h]!=null){st.sy[h]+=ys[h];for(let a=0;a<P;a++)st.sxy[h][a]+=x[a]*ys[h]}}
 }
}
function aggregate(a,b){const z=blank();for(let m=a;m<b;m++){const s=stats[m];z.n+=s.n;for(let i=0;i<P;i++){z.sx[i]+=s.sx[i];for(let j=0;j<P;j++)z.sxx[i][j]+=s.sxx[i][j]}for(const h of HORIZONS){z.sy[h]+=s.sy[h];for(let i=0;i<P;i++)z.sxy[h][i]+=s.sxy[h][i]}}return z}
function solve(A,b){const n=A.length,M=A.map((r,i)=>[...r,b[i]]);for(let i=0;i<n;i++){let k=i;for(let j=i+1;j<n;j++)if(Math.abs(M[j][i])>Math.abs(M[k][i]))k=j;[M[i],M[k]]=[M[k],M[i]];let d=M[i][i];if(Math.abs(d)<1e-12)d=1e-12;for(let j=i;j<=n;j++)M[i][j]/=d;for(let r=0;r<n;r++)if(r!==i){const f=M[r][i];for(let j=i;j<=n;j++)M[r][j]-=f*M[i][j]}}return M.map(r=>r[n])}
function model(st,h){const n=Math.max(st.n,1),mean=st.sx.map(v=>v/n),sd=mean.map((_,i)=>Math.sqrt(Math.max((st.sxx[i][i]-st.sx[i]*st.sx[i]/n)/Math.max(n-1,1),1e-12)));const D=P+1,A=Array.from({length:D},()=>Array(D).fill(0)),b=Array(D).fill(0);A[0][0]=n;b[0]=st.sy[h];for(let i=0;i<P;i++){b[i+1]=(st.sxy[h][i]-mean[i]*st.sy[h])/sd[i];for(let j=0;j<P;j++)A[i+1][j+1]=(st.sxx[i][j]-st.sx[i]*st.sx[j]/n)/(sd[i]*sd[j]);A[i+1][i+1]+=RIDGE}return{coef:solve(A,b),mean,sd}}
const dot=(m,x)=>m.coef[0]+x.reduce((s,v,i)=>s+m.coef[i+1]*(v-m.mean[i])/m.sd[i],0);
function scored(window,h){const out=[];for(let m=DISC_START;m<EVAL_END;m++){if(m-window<0)continue;const mdl=model(aggregate(m-window,m),h);for(const r of samples[m]){if(r.ys[h]==null)continue;const pred=dot(mdl,r.x),dir=pred>=0?1:-1,entry=r.rows[r.i+1].open*(1+dir*SLIP),exit=r.rows[r.i+h].close,gross=dir*(exit-entry)/entry;out.push({month:m,time:r.t*1000,symbol:r.symbol,pred,closedAt:r.rows[r.i+h].time*1000,net:gross-COST,gross})}}return out}
function met(rows,threshold,a,b){const x=rows.filter(e=>e.month>=a&&e.month<b&&Math.abs(e.pred)>=threshold).sort((p,q)=>p.time-q.time||Math.abs(q.pred)-Math.abs(p.pred)),open=new Map(),cool=new Map(),take=[];for(const e of x){const pr=open.get(e.symbol);if(pr&&pr.closedAt>e.time)continue;if((cool.get(e.symbol)??0)>e.time)continue;take.push(e);open.set(e.symbol,e);cool.set(e.symbol,e.closedAt+COOLDOWN)}const gain=sum(take.filter(e=>e.net>0).map(e=>e.net)),loss=Math.abs(sum(take.filter(e=>e.net<=0).map(e=>e.net))),start=monthStart(raw.months[a]),finish=b<44?monthStart(raw.months[b]):end,days=(finish-start)/86400_000;return{trades:take.length,tpd:take.length/days,avg:take.length?sum(take.map(e=>e.net))/take.length:0,pf:loss?gain/loss:gain?99:0,win:take.length?take.filter(e=>e.net>0).length/take.length:0}}
const grid=[];for(const w of WINDOWS)for(const h of HORIZONS){const rows=scored(w,h);for(const threshold of THRESHOLDS)grid.push({window:w,h,threshold,discovery:met(rows,threshold,DISC_START,DISC_END),validation:met(rows,threshold,DISC_END,VAL_END),evaluation:met(rows,threshold,VAL_END,EVAL_END)})}
const eligible=grid.filter(x=>x.discovery.trades>=1500&&x.discovery.tpd>=5&&x.discovery.avg>0&&x.discovery.pf>=1.01).sort((a,b)=>b.discovery.tpd-a.discovery.tpd||b.discovery.pf-a.discovery.pf);const chosen=eligible[0]??null;const stable=grid.filter(x=>x.discovery.avg>0&&x.discovery.pf>=1&&x.validation.avg>0&&x.validation.pf>=1&&x.evaluation.avg>0&&x.evaluation.pf>=1).sort((a,b)=>b.evaluation.tpd-a.evaluation.tpd);const report={generatedAt:new Date().toISOString(),datasetSha256:raw.sha256,objective:'Causal monthly refit to address regime drift while maximizing standard-cost trade frequency.',windows:WINDOWS,horizons:HORIZONS,thresholds:THRESHOLDS,split:{discovery:raw.months.slice(DISC_START,DISC_END),validation:raw.months.slice(DISC_END,VAL_END),evaluation:raw.months.slice(VAL_END,EVAL_END)},chosen,stable:stable.slice(0,30),grid:grid.sort((a,b)=>Number(b.evaluation.avg>0)-Number(a.evaluation.avg>0)||b.evaluation.tpd-a.evaluation.tpd||b.evaluation.pf-a.evaluation.pf)};writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');console.log('WALKFORWARD_RIDGE_RESULT='+JSON.stringify({chosen,stable:report.stable.slice(0,15),top:report.grid.slice(0,20)}));