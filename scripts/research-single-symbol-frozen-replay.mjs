import { readFileSync, writeFileSync } from 'node:fs';

const INPUT=process.env.RESEARCH_DATASET??'/tmp/gate-history-backward-12m.json';
const CONFIG=process.env.RESEARCH_CONFIG??'research/frozen-single-symbol-exhaustion.json';
const OUTPUT=process.env.RESEARCH_OUTPUT??'/tmp/single-symbol-frozen-replay.json';
const raw=JSON.parse(readFileSync(INPUT,'utf8'));
const frozen=JSON.parse(readFileSync(CONFIG,'utf8'));
if(raw.interval!=='5m'||raw.months.length!==12)throw new Error('Need 12m 5m');
const BASE=.0014,STRESS=.0022,SLIP=.00025,ADV=.0005,DAY=86400;
const sum=a=>a.reduce((x,y)=>x+y,0),med=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]:0};
const sign=x=>x>0?1:x<0?-1:0,ret=(r,i,b)=>r[i].close/r[i-b].close-1;
const data=new Map(raw.datasets.map(d=>[d.symbol,d.rows])),syms=[...data.keys()];
const idx=new Map([...data].map(([s,r])=>[s,new Map(r.map((x,i)=>[x.time,i]))]));
const times=[...new Set(raw.datasets.flatMap(d=>d.rows.map(x=>x.time)))].sort((a,b)=>a-b).filter(t=>t%300===0);
const monthIndex=t=>{const d=new Date(t*1000),key=`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;return raw.months.indexOf(key)};
const session=h=>h<8?'ASIA':h<16?'EU':'US';
const volRatio=(r,i)=>{if(i<12)return 0;const base=med(r.slice(i-12,i).map(x=>x.volume).filter(v=>v>0));return base>0?r[i].volume/base:0};
const CONDITIONS={
ALL:()=>true,VOL_HIGH_150:f=>f.vr>=1.5,VOL_HIGH_200:f=>f.vr>=2,VOL_HIGH_300:f=>f.vr>=3,VOL_LOW_120:f=>f.vr<1.2,
IDIO_150:f=>Math.abs(f.residual)>=1.5*Math.max(f.disp,1e-9),IDIO_200:f=>Math.abs(f.residual)>=2*Math.max(f.disp,1e-9),
MARKET_QUIET:f=>Math.abs(f.marketMedian)<.5*Math.max(f.disp,1e-9),MARKET_ACTIVE:f=>Math.abs(f.marketMedian)>=.75*Math.max(f.disp,1e-9),
ALIGNED_MARKET:f=>sign(f.r)===sign(f.marketMedian)&&Math.abs(f.marketMedian)>=.001,COUNTER_MARKET:f=>sign(f.r)!==0&&sign(f.r)!==sign(f.marketMedian),
WEEKEND:f=>f.weekend,WEEKDAY:f=>!f.weekend,ASIA:f=>f.session==='ASIA',EU:f=>f.session==='EU',US:f=>f.session==='US',
VOL150_IDIO150:f=>f.vr>=1.5&&Math.abs(f.residual)>=1.5*Math.max(f.disp,1e-9),VOL200_IDIO150:f=>f.vr>=2&&Math.abs(f.residual)>=1.5*Math.max(f.disp,1e-9),
WEEKEND_VOL150:f=>f.weekend&&f.vr>=1.5,WEEKDAY_VOL150:f=>!f.weekend&&f.vr>=1.5};
const looks=[...new Set(frozen.lanes.map(x=>x.look))],featureCache=new Map();
for(const look of looks){const bars=look/5,per=new Map(syms.map(s=>[s,[]]));for(const t of times){const cross=[];for(const s of syms){const r=data.get(s),i=idx.get(s)?.get(t);if(i==null||i<Math.max(bars,12)||r[i-bars].time!==t-bars*300)continue;cross.push({s,r,i,r0:ret(r,i,bars),vr:volRatio(r,i)});}if(cross.length<Math.max(8,Math.min(18,syms.length)))continue;const m=med(cross.map(x=>x.r0)),disp=med(cross.map(x=>Math.abs(x.r0-m))),entryAt=t+300,d=new Date(entryAt*1000),weekend=[0,6].includes(d.getUTCDay()),sess=session(d.getUTCHours());for(const x of cross)per.get(x.s).push({t,i:x.i,r:x.r0,vr:x.vr,marketMedian:m,disp,residual:x.r0-m,weekend,session:sess});}featureCache.set(look,per);}
function laneEvents(lane,laneIndex){if(!data.has(lane.symbol))return[];const rows=data.get(lane.symbol),features=featureCache.get(lane.look)?.get(lane.symbol)??[],hb=lane.hold/5,test=CONDITIONS[lane.condition];if(!test)throw new Error(`Unknown condition ${lane.condition}`);const out=[];let busyUntil=0;for(const f of features){if(Math.abs(f.r)<lane.threshold||f.t+300<busyUntil||!test(f))continue;const ei=f.i+1,xi=ei+hb;if(!rows[ei]?.open||!rows[xi]?.open||rows[xi].time!==f.t+300+lane.hold*60)continue;const side=f.r>0?'SHORT':'LONG',rawEntry=rows[ei].open,exit=rows[xi].open,entry=rawEntry*(side==='LONG'?1+SLIP:1-SLIP),advEntry=rawEntry*(side==='LONG'?1+ADV:1-ADV),gross=side==='LONG'?exit/entry-1:1-exit/entry,grossAdv=side==='LONG'?exit/advEntry-1:1-exit/advEntry,entryAt=f.t+300,exitAt=rows[xi].time;out.push({lane:laneIndex,symbol:lane.symbol,condition:lane.condition,entryAt,exitAt,side,month:monthIndex(entryAt),base:gross-BASE,stress:gross-STRESS,adverse:grossAdv-BASE});busyUntil=exitAt;}return out;}
const laneRows=frozen.lanes.map((lane,i)=>({lane,i,events:laneEvents(lane,i)}));
const calc=(rows,field='base',days=(raw.now-raw.from)/DAY)=>{const g=sum(rows.filter(e=>e[field]>0).map(e=>e[field])),l=Math.abs(sum(rows.filter(e=>e[field]<=0).map(e=>e[field]))),net=sum(rows.map(e=>e[field]));return{trades:rows.length,net,avgNet:rows.length?net/rows.length:0,pf:l?g/l:g?99:0,tradesPerDay:rows.length/days}};
const all=laneRows.flatMap(x=>x.events).sort((a,b)=>a.entryAt-b.entryAt||a.symbol.localeCompare(b.symbol)||a.lane-b.lane),seen=new Set(),unique=[];for(const e of all){const k=`${e.symbol}:${e.entryAt}`;if(seen.has(k))continue;seen.add(k);unique.push(e);}
const stats=rows=>({base:calc(rows),stress:calc(rows,'stress'),adverse:calc(rows,'adverse')});
const monthly=raw.months.map((month,i)=>{const x=unique.filter(e=>e.month===i);return{month,...stats(x)}});
const quarters=[];for(let i=0;i<12;i+=3){const x=unique.filter(e=>e.month>=i&&e.month<i+3),a=Date.UTC(+raw.months[i].slice(0,4),+raw.months[i].slice(4,6)-1,1)/1000,b=i+3<12?Date.UTC(+raw.months[i+3].slice(0,4),+raw.months[i+3].slice(4,6)-1,1)/1000:raw.now;quarters.push({months:raw.months.slice(i,i+3),base:calc(x,'base',(b-a)/DAY),stress:calc(x,'stress',(b-a)/DAY),adverse:calc(x,'adverse',(b-a)/DAY)});}
const byLane=laneRows.map(({lane,i,events})=>({i,lane,present:data.has(lane.symbol),...stats(events)}));
const bySymbol=Object.fromEntries([...new Set(frozen.lanes.map(x=>x.symbol))].map(s=>{const x=unique.filter(e=>e.symbol===s);return[s,{lanes:frozen.lanes.filter(l=>l.symbol===s).length,present:data.has(s),...stats(x)}]}));
const report={period:{months:raw.months,from:raw.from,now:raw.now},universe:syms,frozenLaneCount:frozen.lanes.length,presentLaneCount:laneRows.filter(x=>data.has(x.lane.symbol)).length,raw:stats(all),unique:stats(unique),overlapRate:all.length?1-unique.length/all.length:0,monthly,quarters,bySymbol,byLane,note:'Pure backward OOS replay of the exact lane parameters and absolute move thresholds frozen from the later 2025-09..2026-08 discovery+validation experiment. No parameter or lane selection is performed on this earlier period.'};
writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');console.log('SSE_FROZEN_BACKWARD='+JSON.stringify({period:report.period,universe:report.universe,frozenLaneCount:report.frozenLaneCount,presentLaneCount:report.presentLaneCount,raw:report.raw,unique:report.unique,overlapRate:report.overlapRate,monthly:report.monthly,quarters:report.quarters,bySymbol:report.bySymbol,note:report.note}));
