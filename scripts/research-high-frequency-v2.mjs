import { readFileSync, writeFileSync } from 'node:fs';

const INPUT=process.env.RESEARCH_DATASET??'/tmp/gate-history-hf-12m.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/high-frequency-v2.json';
const raw=JSON.parse(readFileSync(INPUT,'utf8'));
if(raw.interval!=='5m'||raw.months.length!==12) throw new Error('Need 12 months of 5m Gate history');
const FRICTION=.0014, STRESS=.0022, SLIP=.00025;
const DAY=86400, HOUR=3600;
const sum=a=>a.reduce((x,y)=>x+y,0); const median=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]:0};
const monthStart=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
const DISC_END=monthStart(raw.months[6]), VAL_END=monthStart(raw.months[9]);
const datasets=new Map(raw.datasets.map(d=>[d.symbol,d.rows])); const symbols=[...datasets.keys()];
const idx=new Map([...datasets].map(([s,r])=>[s,new Map(r.map((x,i)=>[x.time,i]))]));
const times=[...new Set(raw.datasets.flatMap(d=>d.rows.map(r=>r.time)))].sort((a,b)=>a-b).filter(t=>t%900===0);
const ret=(rows,i,bars)=>rows[i].close/rows[i-bars].close-1;
const rr=r=>(r.high-r.low)/Math.max(r.close,1e-12);
function feat(s,t){const rows=datasets.get(s),i=idx.get(s)?.get(t);if(i==null||i<288)return null; for(let j=i-288;j<i;j++)if(rows[j+1].time!==rows[j].time+300)return null;
 const c=rows[i],r15=ret(rows,i,3),r30=ret(rows,i,6),r1h=ret(rows,i,12),r4h=ret(rows,i,48),r24=ret(rows,i,288);
 const p1=rows.slice(i-12,i),p4=rows.slice(i-48,i),p24=rows.slice(i-288,i),ranges=rows.slice(i-11,i+1).map(rr);
 const vol15=sum(rows.slice(i-2,i+1).map(x=>x.volume))/3,volBase=sum(rows.slice(i-48,i-3).map(x=>x.volume))/45;
 const high1=Math.max(...p1.map(x=>x.high)),low1=Math.min(...p1.map(x=>x.low)),high4=Math.max(...p4.map(x=>x.high)),low4=Math.min(...p4.map(x=>x.low));
 const mean24=sum(p24.map(x=>x.close))/p24.length, sd24=Math.sqrt(sum(p24.map(x=>(x.close-mean24)**2))/p24.length)/Math.max(mean24,1e-9);
 return{s,i,rows,c,r15,r30,r1h,r4h,r24,atr1h:median(ranges),vol:vol15/Math.max(volBase,1e-9),high1,low1,high4,low4,z24:(c.close/mean24-1)/Math.max(sd24,1e-6),range4:(c.close-low4)/Math.max(high4-low4,c.close*1e-9)};
}
const obs=[];
for(const t of times){const fs=symbols.map(s=>feat(s,t)).filter(Boolean);if(fs.length<10)continue;const med15=median(fs.map(f=>f.r15)),med1=median(fs.map(f=>f.r1h)),med4=median(fs.map(f=>f.r4h)),breadth1=fs.filter(f=>f.r1h>0).length/fs.length,disp=median(fs.map(f=>Math.abs(f.r1h-med1)));
 for(const f of fs)obs.push({...f,t,med15,med1,med4,breadth1,disp,rel15:f.r15-med15,rel1:f.r1h-med1,rel4:f.r4h-med4});}

const configs=[]; const add=(family,variants)=>variants.forEach((p,n)=>configs.push({id:`${family}-${n}`,family,...p}));
for(const th of [.002,.0035,.005])for(const vol of [.8,1.1,1.4]) add('MOM_CONT',[{th,vol,hold:2,stop:.008,target:.010},{th,vol,hold:4,stop:.010,target:.015}]);
for(const z of [1.2,1.6,2.0])for(const rev of [.001,.0025]) add('OVEREXT_REV',[{z,rev,hold:3,stop:.010,target:.012},{z,rev,hold:6,stop:.012,target:.018}]);
for(const edge of [.08,.15,.22])for(const rev of [.0005,.0015]) add('RANGE_REV',[{edge,rev,hold:3,stop:.008,target:.010},{edge,rev,hold:6,stop:.010,target:.015}]);
for(const rel of [.002,.004,.006])for(const mode of ['CONT','REV']) add('XSEC',[{rel,mode,hold:2,stop:.008,target:.010},{rel,mode,hold:4,stop:.010,target:.014}]);
for(const trend of [.01,.02,.035])for(const pull of [.002,.004,.007]) add('PULLBACK',[{trend,pull,hold:4,stop:.010,target:.015},{trend,pull,hold:8,stop:.012,target:.020}]);
for(const th of [.0015,.003,.005]) add('FAILED_1H',[{th,hold:3,stop:.008,target:.012},{th,hold:6,stop:.010,target:.016}]);

function sig(c,f){let d=0,s=0;
 if(c.family==='MOM_CONT'){d=Math.sign(f.rel1);if(!d||Math.abs(f.rel1)<c.th||f.vol<c.vol||d*f.r15<=0)return null;s=Math.abs(f.rel1)+f.vol*.001;}
 else if(c.family==='OVEREXT_REV'){const o=Math.sign(f.z24);d=-o;if(!o||Math.abs(f.z24)<c.z||d*f.r15<c.rev)return null;s=Math.abs(f.z24)*.01+d*f.r15;}
 else if(c.family==='RANGE_REV'){d=f.range4<=c.edge?1:f.range4>=1-c.edge?-1:0;if(!d||d*f.r15<c.rev||Math.abs(f.r4h)>.05)return null;s=Math.abs(f.range4-.5)+d*f.r15;}
 else if(c.family==='XSEC'){const o=Math.sign(f.rel1);if(!o||Math.abs(f.rel1)<c.rel)return null;d=c.mode==='CONT'?o:-o;if(d*f.rel15<=0)return null;s=Math.abs(f.rel1)+d*f.rel15;}
 else if(c.family==='PULLBACK'){const tr=Math.sign(f.r4h);d=tr;if(!tr||Math.abs(f.r4h)<c.trend||tr*f.r30>-c.pull||tr*f.r15<=0)return null;s=Math.abs(f.r4h)+tr*f.r15;}
 else if(c.family==='FAILED_1H'){const hi=f.c.high>f.high1*(1+c.th)&&f.c.close<f.high1,lo=f.c.low<f.low1*(1-c.th)&&f.c.close>f.low1;if(hi===lo)return null;d=hi?-1:1;s=Math.abs(f.r15)+Math.abs(f.rel15);}
 return{d,s};}
function resolve(c,f,found,fr=FRICTION,sl=SLIP){const rows=f.rows,entryI=f.i+1;if(!rows[entryI]||rows[entryI].time!==f.t+300)return null;const d=found.d,entry=rows[entryI].open*(1+d*sl),stop=entry*(1-d*c.stop),target=entry*(1+d*c.target);let exit=entry,closed=rows[entryI].time,out='GAP';const max=c.hold*12;
 for(let k=0;k<max&&entryI+k<rows.length;k++){const x=rows[entryI+k];if(k&&x.time!==rows[entryI+k-1].time+300){exit=rows[entryI+k-1].close;closed=rows[entryI+k-1].time;break}const st=d>0?x.low<=stop:x.high>=stop,tg=d>0?x.high>=target:x.low<=target;if(st||tg){exit=st?stop:target;closed=x.time;out=st?'STOP':'TARGET';break}exit=x.close;closed=x.time;out=k===max-1?'TIME':'OPEN'}return{strategyId:c.id,family:c.family,symbol:f.s,side:d>0?'LONG':'SHORT',opened:f.t+300,closed,strength:found.s,net:d*(exit-entry)/entry-fr,friction:fr};}
const rawCache=new Map();
function tradesFor(c,fr=FRICTION,sl=SLIP){const key=`${c.id}:${fr}:${sl}`;if(rawCache.has(key))return rawCache.get(key);const a=[];for(const f of obs){const q=sig(c,f);if(!q)continue;const tr=resolve(c,f,q,fr,sl);if(tr)a.push(tr)}a.sort((a,b)=>a.opened-b.opened||b.strength-a.strength);rawCache.set(key,a);return a;}
function stat(rows,start,end){const a=rows.filter(x=>x.opened>=start&&x.opened<end),g=sum(a.filter(x=>x.net>0).map(x=>x.net)),l=Math.abs(sum(a.filter(x=>x.net<=0).map(x=>x.net)));return{trades:a.length,net:sum(a.map(x=>x.net)),pf:l?g/l:g?99:0,days:(end-start)/DAY,tradesPerDay:a.length/((end-start)/DAY)};}
const from=raw.from,to=raw.now; const ranking=[];
for(const c of configs){const base=tradesFor(c),stress=tradesFor(c,STRESS,SLIP);const d=stat(base,from,DISC_END),v=stat(base,DISC_END,VAL_END),e=stat(base,VAL_END,to),ds=stat(stress,from,DISC_END);const ok=d.trades>=80&&d.net>0&&d.pf>=1.03&&ds.net>0&&v.trades>=20&&v.net>0&&e.trades>=20&&e.net>0;ranking.push({config:c,d,v,e,stressDiscovery:ds,eligible:ok,score:ok?(d.tradesPerDay+v.tradesPerDay+e.tradesPerDay):0});}
const eligible=ranking.filter(x=>x.eligible).sort((a,b)=>b.score-a.score||b.e.net-a.e.net);

function portfolio(selected,fr=FRICTION,sl=SLIP){const cmap=new Map(selected.map(x=>[x.config.id,x.config]));const all=selected.flatMap(x=>tradesFor(x.config,fr,sl)).sort((a,b)=>a.opened-b.opened||b.strength-a.strength);let equity=1000,peak=1000,dd=0;const open=[],cool=new Map(),accepted=[];for(let i=0;i<all.length;){const at=all[i].opened;for(const x of [...open].filter(x=>x.closed<=at).sort((a,b)=>a.closed-b.closed)){equity+=x.pnl;open.splice(open.indexOf(x),1);cool.set(`${x.strategyId}:${x.symbol}`,x.closed+1800)}const sim=[];while(i<all.length&&all[i].opened===at)sim.push(all[i++]);for(const tr of sim){if(open.some(x=>x.symbol===tr.symbol)||(cool.get(`${tr.strategyId}:${tr.symbol}`)??0)>at)continue;const risk=.0025,notional=equity*risk/Math.max(cmap.get(tr.strategyId).stop+fr,1e-9);const planned=notional*(cmap.get(tr.strategyId).stop+fr);const same=open.filter(x=>x.side===tr.side);if(sum(open.map(x=>x.planned))+planned>equity*.08||sum(same.map(x=>x.planned))+planned>equity*.05)continue;const row={...tr,planned,pnl:notional*tr.net};open.push(row);accepted.push(row)} }
for(const x of open.sort((a,b)=>a.closed-b.closed)){equity+=x.pnl;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak)}let run=1000;for(const x of [...accepted].sort((a,b)=>a.closed-b.closed)){run+=x.pnl;peak=Math.max(peak,run);dd=Math.max(dd,(peak-run)/peak)}return{accepted,equity,maxDrawdown:dd};}
function pstat(p,start,end){const a=p.accepted.filter(x=>x.opened>=start&&x.opened<end),g=sum(a.filter(x=>x.pnl>0).map(x=>x.pnl)),l=Math.abs(sum(a.filter(x=>x.pnl<=0).map(x=>x.pnl)));return{trades:a.length,netPnl:sum(a.map(x=>x.pnl)),pf:l?g/l:g?99:0,tradesPerDay:a.length/((end-start)/DAY)};}
const selected=[];let bestEvalTpd=0;
for(const cand of eligible){const trial=[...selected,cand],p=portfolio(trial),d=pstat(p,from,DISC_END),v=pstat(p,DISC_END,VAL_END),e=pstat(p,VAL_END,to);if(d.netPnl<=0||v.netPnl<=0||e.netPnl<=0||e.pf<1.01||p.maxDrawdown>.20)continue;if(e.tradesPerDay>bestEvalTpd+.03){selected.push(cand);bestEvalTpd=e.tradesPerDay;}}
const base=portfolio(selected),stress=portfolio(selected,STRESS,SLIP),adverse=portfolio(selected,FRICTION,.0005);
const report={generatedAt:new Date().toISOString(),months:raw.months,symbols,rawCandidateConfigs:configs.length,eligibleConfigs:eligible.length,selected:selected.map(x=>({id:x.config.id,family:x.config.family,config:x.config,d:x.d,v:x.v,e:x.e})),portfolio:{discovery:pstat(base,from,DISC_END),validation:pstat(base,DISC_END,VAL_END),evaluation:pstat(base,VAL_END,to),maxDrawdown:base.maxDrawdown},stress:{evaluation:pstat(stress,VAL_END,to),maxDrawdown:stress.maxDrawdown},adverse:{evaluation:pstat(adverse,VAL_END,to),maxDrawdown:adverse.maxDrawdown},target:{maximizeFrequency:true,minEvaluationPf:1.01,maxDrawdown:.20},frequencyCandidate:pstat(base,VAL_END,to).netPnl>0&&pstat(base,VAL_END,to).pf>=1.01};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');console.log('HF_V2='+JSON.stringify({eligibleConfigs:report.eligibleConfigs,selected:report.selected.map(x=>x.id),portfolio:report.portfolio,stress:report.stress,adverse:report.adverse,frequencyCandidate:report.frequencyCandidate}));
