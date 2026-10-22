/**
 * dynamic-v1.2 cycle predictor: phase tracking on the hourly line, timing (hazard) and BTC/ETH-state (conditional) learners, the
 * online logistic model, forecast logging / scoring / track record, the predictor gate of the allocator, the dashboard text, and
 * the runtime path (hourly row in D1, scoring after the horizon, restart keeps the record).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import type {D1Like,D1Stmt} from "../lib/run-log-archive.ts";
import {Series,IV_SEC,type Bar} from "../lib/dynamic/series.ts";
import * as P from "../lib/dynamic/predictor.ts";
import {allocatePred,contradicted,PRED_ALLOC} from "../lib/dynamic/allocator.ts";
import {POOL_BY_ID} from "../lib/dynamic/playbooks.ts";
import type {TradeLite} from "../lib/dynamic/cycles.ts";
import {readForecasts,writeForecasts,emptyDynStore,dynCounts} from "../lib/dynamic/store-d1.ts";
import {DynamicResearch} from "../lib/dynamic/runtime.ts";

const H=3600,D=86_400,T0=1_780_000_000-(1_780_000_000%D);
function sqliteD1():D1Like{
  const sql=new DatabaseSync(":memory:");
  const make=(text:string,values:unknown[]=[]):D1Stmt=>({bind:(...v:unknown[])=>make(text,v),
    run:async()=>sql.prepare(text).run(...(values as never[])),all:async<R>()=>({results:sql.prepare(text).all(...(values as never[])) as R[]}),
    first:async<R>()=>(sql.prepare(text).get(...(values as never[])) as R|undefined)??null});
  return {prepare:text=>make(text),batch:async list=>{sql.exec("BEGIN");try{const out=[];for(const s of list)out.push(await s.run());sql.exec("COMMIT");return out;}catch(e){sql.exec("ROLLBACK");throw e;}}};
}
/** trades every 4 h; phases given as [days, net per trade] */
function tradesOf(pb:string,plan:[number,number][],start=T0):TradeLite[]{const out:TradeLite[]=[];let t=start;
  for(const [days,net] of plan)for(let k=0;k<days*6;k++){out.push({pb,sym:"SOL_USDT",et:t,xt:t+1800,net});t+=4*H;}return out;}
const z=():P.Hazard=>({events:Array(P.PRED.hazEdges.length-1).fill(0),exposure:Array(P.PRED.hazEdges.length-1).fill(0)});
const pool0={GOOD:z(),BAD:z()};
function featTable(from:number,to:number,f:(t:number)=>(number|-1)[]):P.FeatTable{const rows:P.FeatRow[]=[],at=new Map<number,number>();
  for(let t=from;t<=to;t+=H){at.set(t,rows.length);rows.push({t,b:f(t)});}return {rows,at};}
const noFeat=()=>Array(P.FEATS.length).fill(-1);

test("phase tracking: hourly 72 h line with hysteresis → alternating GOOD / BAD phases with start, end, hours, depth, trades; the last one open",()=>{
  const ts=tradesOf("x",[[6,.004],[6,-.004],[6,.004],[3,-.004]]),now=ts.at(-1)!.xt+H;
  const L=P.labelLine(ts,now)!;assert.ok(L&&L.n>400);
  const ph=P.phasesOfLine(L,ts);
  assert.deepEqual(ph.map(p=>p.label),["GOOD","BAD","GOOD","BAD"]);
  assert.ok(ph.slice(1,3).every(p=>p.hours>=100&&p.hours<=160),`inner phases ≈ 6 days (${ph.map(p=>p.hours)})`);
  assert.ok(ph[0]!.depth>0&&ph[1]!.depth<0&&ph[2]!.depth>0,"depth = net of the phase");
  assert.ok(ph.every((p,i)=>i===0||p.start===ph[i-1]!.end+H),"phases follow each other hour by hour");
  assert.ok(ph.at(-1)!.open&&!ph[0]!.open);assert.equal(ph[1]!.next,1);
  assert.equal(L.elapsed[L.n-1],ph.at(-1)!.hours,"elapsed time of the current phase");
  // a quiet stretch: the window empties → unknown (0), and the line can't call a phase from nothing
  const q=P.labelLine(ts,now+5*D)!;assert.equal(q.lab[q.n-1],0);
  // hysteresis: a flat window (|net| ≤ 0.3%) keeps the previous label
  const h=P.labelLine([...tradesOf("x",[[4,.004]]),...tradesOf("x",[[3,.0001]],T0+4*D)],T0+7*D)!;assert.equal(h.lab[h.n-1],1);
});

test("hazard learner: switch counts per elapsed-time bin, shrunk to the pool; survival and median wait; periodicity and session profile",()=>{
  const ts=tradesOf("x",[[2,-.004],[2,.004],[2,-.004],[2,.004],[2,-.004],[2,.004],[2,-.004]]);
  const {phases}=P.phaseInfo(ts,ts.at(-1)!.xt+H);
  const hb=P.hazardCounts(phases,"BAD");assert.ok(hb.events.reduce((a,b)=>a+b,0)>=3,"closed BAD→GOOD switches counted");
  assert.ok(hb.exposure[0]!>=6*4,"exposure per bin");
  const bin=hb.events.findIndex(e=>e>0);assert.ok(bin>=3,`switches happen after ~2 days (bin ${bin})`);
  const pool={events:hb.events.map(()=>0),exposure:hb.exposure.map(()=>1000)},r=P.hazardRates(hb,pool);
  assert.ok(r[bin]!>0&&r[bin]!<hb.events[bin]!/hb.exposure[bin]!,"shrunk toward the pool's (zero) rate");
  assert.ok(r[0]!<r[bin]!,"early in a bad phase a switch is less likely than at its usual length");
  assert.ok(P.survive(r,0,72)<P.survive(r,0,6)&&P.survive(r,0,6)<=1);
  const w=P.medianWait(r,24);assert.ok(w!=null&&w>0&&w<200,`median wait ${w}`);
  // periodicity: alternating 2-day blocks → strong autocorrelation at lag 4
  const per=P.periodicity(tradesOf("y",[[2,.01],[2,-.01],[2,.01],[2,-.01],[2,.01],[2,-.01],[2,.01],[2,-.01],[2,.01],[2,-.01],[2,.01],[2,-.01]]));
  assert.ok(per&&per.lag===4&&per.acf>.5,JSON.stringify(per));
  const pr=P.profileOf(Array.from({length:60},(_,i)=>({pb:"z",sym:"A",et:T0+i*D+(i%2?14*H:2*H),xt:T0+i*D+15*H,net:i%2?.01:-.005})));
  assert.equal(pr.best.session,"US");assert.ok(pr.session.US!>pr.session.ASIA!);
});

test("BTC/ETH conditional learner: onsets that follow one BTC state get a lift, and the trigger names it in plain words",()=>{
  // good phases always start right after BTC 4h turned down; the state is something else now
  const ts=tradesOf("x",[[3,-.004],[3,.004],[3,-.004],[3,.004],[3,-.004],[3,.004],[4,-.004]]),now=ts.at(-1)!.xt+2*H;
  const {L,phases}=P.phaseInfo(ts,now),onsets=new Set(phases.filter(p=>p.label==="GOOD").map(p=>p.start));
  const f4=P.FEATS.findIndex(f=>f.k==="b4h"),fv=P.FEATS.findIndex(f=>f.k==="dvol");
  const feats=featTable(L!.t0,L!.t0+(L!.n-1)*H,t=>{const b=noFeat();const pre=[...onsets].some(o=>t<o&&t>=o-6*H);b[f4]=pre?3:2;b[fv]=pre?0:1;b[P.FEATS.length-1]=0;return b;});
  const fc=P.predictPlaybook({pb:"x",trades:ts,feats,nowSec:now,pool:pool0});
  assert.equal(fc.cur,"BAD");
  const down=fc.cond.b4h!.find(c=>c.bin===3)!,flat=fc.cond.b4h!.find(c=>c.bin===2)!;
  assert.ok(down.onsets>=2&&down.lift>1.25&&down.lift>flat.lift,`lift DOWN ${down.lift.toFixed(2)} vs FLAT ${flat.lift.toFixed(2)}`);
  assert.ok(flat.p>0&&flat.p<1&&Number.isFinite(down.p),"presence rate shrunk, finite");
  assert.equal(fc.trigger.kind,"btc");assert.match(fc.trigger.text,/BTC 4 小时转跌/);assert.match(fc.trigger.text,/波动放大/);
  for(const h of ["6","24","72"] as const)assert.ok(fc.p[h]>=.02&&fc.p[h]<=.98);
  assert.ok(fc.p["72"]>=fc.p["6"],"from a bad phase, good is likelier further out");
  // no BTC state that stands out → time trigger from the hazard
  const flatF=featTable(L!.t0,L!.t0+(L!.n-1)*H,()=>{const b=noFeat();b[f4]=2;return b;});
  const f2=P.predictPlaybook({pb:"x",trades:ts,feats:flatF,nowSec:now,pool:pool0});assert.equal(f2.trigger.kind,"time");assert.match(f2.trigger.text,/^约 \d+ (小时|天)后$/);
});

test("online logistic: learns a separable rule, its delayed prequential score has skill; a fresh model repeats the hazard input",()=>{
  const m=new P.OnlineLogit(3,.5,1e-4),x=(a:number)=>Float64Array.from([a,1-a,1]);
  for(let i=0;i<2000;i++){const a=i%2;m.update(x(a),a as 0|1);}
  assert.ok(m.predict(x(1))>.8&&m.predict(x(0))<.2);assert.ok(m.skill>.3,`skill ${m.skill}`);assert.equal(m.n,2000);
  const w=new P.OnlineLogit(P.DIM,.01,1e-3,{i:P.HAZ_IN,w:2}),row={t:0,b:noFeat()};
  for(const ph of [.1,.5,.9])assert.ok(Math.abs(w.predict(P.encode(row,0,0,undefined,ph))-ph)<1e-9,"fresh model = hazard estimate");
  // the learn() step scores the prediction made back then (no peeking): score uses the stored p
  const q=new P.OnlineLogit(3);q.learn(x(1),1,.2);assert.ok(Math.abs(q.brier-.64)<1e-12);
});

test("forecast log: scored only after the horizon passed (label at t + h), hit / Brier / calibration per playbook; unknown expires",()=>{
  const rows:P.FcRow[]=[{t:T0,f:{a:[.7,.4,.2],b:[.3,.3,.3]},y:{}}],track:Record<string,P.Track>={},seen:{pb:string;h:number}[]=[];
  const lab=(pb:string,t:number):P.Lab|null=>pb==="b"?0:t<T0+48*H?1:-1;
  assert.equal(P.scoreRows(rows,lab,T0+6*H,track).length,0,"not before t + 6 h + 1 h");
  assert.equal(P.scoreRows(rows,lab,T0+7*H,track,x=>seen.push(x)).length,1);
  assert.deepEqual(rows[0]!.y.a,[1,null,null]);assert.equal(track.a!.n,1);assert.equal(track.a!.hits,1);assert.ok(Math.abs(track.a!.brier-.09)<1e-12);
  P.scoreRows(rows,lab,T0+80*H,track,x=>seen.push(x));assert.deepEqual(rows[0]!.y.a,[1,1,0]);
  assert.equal(track.a!.n,3);assert.equal(track.a!.hits,2,"24 h: 40% but it was good → miss");
  assert.ok(Math.abs(track.a!.brier-(.09+.36+.04))<1e-12);
  const tv=P.trackView(track.a);assert.ok(Math.abs(tv.hit-2/3)<1e-12);assert.equal(tv.calib.filter(Boolean).length,3,"one calibration bin per distinct p");
  assert.equal(seen.length,3);assert.deepEqual(seen.map(x=>x.h),[6,24,72]);
  // b's labels are never known (no trades): dropped as −1 after 3 days, never counted
  assert.deepEqual(rows[0]!.y.b,[-1,null,null],"6 h: 74 h ago → dropped; 24 h: not yet");P.scoreRows(rows,lab,T0+100*H,track);assert.deepEqual(rows[0]!.y.b,[-1,-1,null]);assert.equal(track.b,undefined);
});

test("forecast log in D1: one row per hour, upsert with outcomes, marked scored when complete",async()=>{
  const db=sqliteD1(),st=emptyDynStore();
  assert.ok(await writeForecasts(db,st,[{t:T0,f:{a:[.6,.5,.4]},y:{}},{t:T0+H,f:{a:[.6,.5,.4]},y:{}}],T0*1000));
  assert.ok(await writeForecasts(db,st,[{t:T0,f:{a:[.6,.5,.4]},y:{a:[1,0,1]}}],T0*1000));
  const rs=await readForecasts(db,st,T0);assert.equal(rs.length,2);assert.deepEqual(rs[0]!.y.a,[1,0,1]);
  assert.equal((await dynCounts(db)).dyn_forecasts,2);
});

const fcOf=(o:Partial<P.PbForecast>&{p6:number}):P.PbForecast=>({pb:"orb5m-eu-long",t:T0,cur:"GOOD",elapsedH:10,p:{"6":o.p6,"24":o.p6,"72":o.p6},pHaz:{"6":o.p6,"24":o.p6,"72":o.p6},pLog:null,wLog:0,
  trigger:{kind:"time",text:"约 10 小时后",hours:10},sample:.5,label:"数据一般",phases:{good:2,bad:2,meanGoodH:40,meanBadH:30,last:[]},trades:40,period:null,profile:{session:null,weekday:null},
  hist:{n:0,hit:0,brier:0,skill:0,hazBrier:0},base:.5,cond:{},...o});
const trk=(n:number,hit:number,brier:number):P.Track=>({n,hits:Math.round(n*hit),brier:brier*n,bins:Array.from({length:10},()=>[0,0,0] as [number,number,number])});

test("allocator (predictor gate): P(good in 6 h) ≥ 0.58 and a track record that is not bad → small paper size by edge × record × evidence; cut on contradiction; long tier record-only",()=>{
  const pb="orb5m-eu-long",run=(f:P.PbForecast|null,track:Record<string,P.Track>={},live={},nowSec=T0)=>allocatePred({},null,null,{forecasts:f?{[pb]:f}:{},track,live,nowSec})[pb]!;
  assert.match(run(null).why,/还没有影子交易|预测器/);
  assert.match(run(fcOf({p6:.57})).why,/57%（要 ≥58%）/);
  assert.match(run(fcOf({p6:.9,sample:0})).why,/数据少/);
  const few=run(fcOf({p6:.58}));assert.ok(few.ok);assert.ok(Math.abs(few.risk-.0025*PRED_ALLOC.trackFewW*(.25+.75*.5))<1e-12,`few scored → smallest size (${few.risk})`);
  const top=run(fcOf({p6:.85,sample:1}),{[pb]:trk(40,.75,.15)});assert.ok(top.ok&&Math.abs(top.risk-.005)<1e-12,`best case = 0.5% (${top.risk})`);
  const mid=run(fcOf({p6:.69,sample:1}),{[pb]:trk(40,.625,.18)});assert.ok(mid.ok&&mid.risk>.0025*.25&&mid.risk<.005);assert.match(mid.why,/命中率 63%（40 次）/);
  assert.match(run(fcOf({p6:.9}),{[pb]:trk(20,.45,.2)}).why,/预测记录不好/);
  assert.match(run(fcOf({p6:.9}),{[pb]:trk(20,.7,.3)}).why,/Brier 0\.30/);
  assert.match(run(fcOf({p6:.9}),{},{[pb]:{since:null,cutUntil:T0+H,results:[]}}).why,/暂停/);
  const lg=allocatePred({},null,null,{forecasts:{"htf-down20":fcOf({pb:"htf-down20",p6:.95})},track:{},live:{},nowSec:T0})["htf-down20"];
  if(lg)assert.ok(!lg.ok,"long tier stays record-only");
  assert.ok(Object.keys(POOL_BY_ID).includes(pb));
  assert.equal(contradicted([-.01,-.002,-.004]),"开闸后前 3 笔影子交易全亏");assert.equal(contradicted([-.01,.002,-.004]),null);
  assert.equal(contradicted([.01,-.01,-.01,-.01,-.01,-.01]),"最近 5 笔影子交易全亏");assert.equal(contradicted([-.01,-.01]),null);
});

test("dashboard text: one plain-Chinese line per playbook — phase + elapsed, trigger, 24 h probability, evidence label, forecast hit rate",()=>{
  const bad=fcOf({cur:"BAD",elapsedH:48,p6:.3,p:{"6":.3,"24":.62,"72":.8},trigger:{kind:"btc",text:"BTC 4 小时转跌、波动放大",lift:1.6},label:"数据少"});
  assert.equal(P.forecastLine(bad,trk(12,.58,.2)),"现在：亏钱期（已 2 天）。预计：BTC 4 小时转跌、波动放大时开始赚钱，24 小时内概率 62%【数据少】。预测命中率 58%（12 次）");
  const t=P.forecastLine({...bad,trigger:{kind:"time",text:"约 9 小时后",hours:9},elapsedH:20},undefined);
  assert.equal(t,"现在：亏钱期（已 20 小时）。预计：约 9 小时后开始赚钱（按以往亏钱期长度），24 小时内概率 62%【数据少】。预测还没到期评分");
  const good=P.forecastLine(fcOf({p6:.8,p:{"6":.8,"24":.7,"72":.5},trigger:{kind:"btc",text:"BTC 来回震荡"},elapsedH:30}),trk(30,.7,.18));
  assert.equal(good,"现在：赚钱期（已 30 小时）。预计：24 小时后仍在赚钱期的概率 70%；BTC 来回震荡时可能结束【数据一般】。预测命中率 70%（30 次）");
  assert.match(P.forecastLine(fcOf({cur:null,p6:.4,trades:6}),undefined),/^现在：还看不出（影子交易 6 笔）/);
});

function series1h(sym:string,from:number,n:number){const s=new Series(sym,"1h");const bars:Bar[]=[];
  for(let i=0;i<n;i++){const t=from+i*H,c=100*Math.exp(.05*Math.sin(i/60)+.01*Math.sin(i/7)+(sym==="ETH_USDT"?.02*Math.cos(i/30):0));bars.push({t,o:c*.999,h:c*1.004,l:c*.996,c,v:1});}
  s.merge(bars);return s;}

test("runtime: the predictor runs in the analysis — hourly forecast row to D1, scored after the horizon, gate by the predictor, view lines; restart keeps the track record",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch();await rt.step(T0*1000,{universe:[],db,fetch:async()=>({})});assert.ok(rt.booted);
  const start=T0-40*D,now0=T0;
  rt.series.set("BTC_USDT|1h",series1h("BTC_USDT",start,40*24));rt.series.set("ETH_USDT|1h",series1h("ETH_USDT",start,40*24));
  const pb="orb5m-eu-long",ts=tradesOf(pb,[[4,.004],[4,-.004],[4,.004],[4,-.004],[4,.004],[4,-.004],[4,.004],[4,-.004],[6,.004]],start+2*D);
  const rows=ts.map(t=>[0,t.et,t.xt,Math.round(t.net*1e6),100,100] as [number,number,number,number,number,number]);
  rt.tsrc.set(`l|SOL_USDT|5m|${start}`,{k:`l|SOL_USDT|5m|${start}`,sym:"SOL_USDT",iv:"5m",t0:start,pbs:[pb],rows,dirty:false});rt.tradesLoaded=true;
  const last=ts.at(-1)!.xt,at=(Math.floor(last/H)+1)*H*1000+60_000;
  rt.analyze(at);
  const f=rt.forecasts[pb]!;assert.ok(f,"forecast for the playbook");assert.equal(f.cur,"GOOD");assert.ok(f.p["6"]>.5);
  assert.equal(rt.fcRows.length,1);assert.ok(rt.fcDirty.size===1);
  const g=rt.gates![pb]!;assert.match(g.why,/预测|概率/);
  assert.ok(f.p["6"]>=PRED_ALLOC.pMin&&f.sample>0);assert.ok(g.ok&&g.risk<=.005*PRED_ALLOC.trackFewW+1e-12,"few scored forecasts → smallest size");
  assert.equal(rt.predLive[pb]!.since,Math.floor(at/1000),"gate opened → shadow results are checked from now on");
  const v=rt.view(at),pv=v.playbooks.find(p=>p.id===pb)!;assert.match(pv.pred!.line,/^现在：赚钱期（已 /);
  assert.ok(v.predictor.ready&&v.predictor.topNow[0]!.pb===pb);assert.ok(rt.events.some(e=>e.k==="FORECAST"));
  // the same hour again: no second row
  rt.analyze(at+10*60_000);assert.equal(rt.fcRows.length,1);
  await (rt as unknown as {flushForecasts(db:D1Like,now:number):Promise<void>}).flushForecasts(db,at);assert.equal((await readForecasts(db,rt.store,0)).length,1);assert.equal(rt.fcDirty.size,0);
  // 7 hours later (the trades continue the good phase): the 6 h forecast is scored
  const more=tradesOf(pb,[[1,.004]],last+4*H).slice(0,1).map(t=>[0,t.et,t.xt,Math.round(t.net*1e6),100,100] as [number,number,number,number,number,number]);
  rt.tsrc.get(`l|SOL_USDT|5m|${start}`)!.rows.push(...more);
  rt.series.set("BTC_USDT|1h",series1h("BTC_USDT",start,40*24+20));
  rt.analyze(at+7*H*1000);assert.equal(rt.fcRows.length,2);assert.equal(rt.track[pb]?.n,1,"6 h forecast scored");assert.equal(rt.recentScores.length,1);
  assert.equal(rt.view(at+7*H*1000).predictor.recent[0]!.h,6);
  await (rt as unknown as {flushForecasts(db:D1Like,now:number):Promise<void>}).flushForecasts(db,at+7*H*1000);
  await (rt as unknown as {saveMeta(db:D1Like,now:number):Promise<void>}).saveMeta(db,at+7*H*1000);
  const rs=await readForecasts(db,rt.store,0);assert.equal(rs.length,2);assert.notEqual(rs[0]!.y[pb]![0],null,"outcome stored");
  // restart: forecast rows and the track record come back
  const rt2=new DynamicResearch();await rt2.step(at+7*H*1000+5000,{universe:[],db,fetch:async()=>({})});
  assert.equal(rt2.fcRows.length,2);assert.equal(rt2.track[pb]?.n,1);assert.equal(rt2.recentScores.length,1);
  // contradiction: after the gate opened, the last 5 shadow trades all lose (the first ones after opening won) → cut for 12 h, logged
  const since=rt.predLive[pb]!.since!,t3=at/1000+7*H+600;assert.ok(since>0);
  rt.tsrc.get(`l|SOL_USDT|5m|${start}`)!.rows.push(...[0,1,2,3,4].map(k=>[0,t3+k*600,t3+k*600+300,-3000,100,100] as [number,number,number,number,number,number]));
  rt.analyze(at+8*H*1000);assert.ok(rt.predLive[pb]!.cutUntil>at/1000+8*H,"cut");assert.ok(!rt.gates![pb]!.ok);
  assert.ok(rt.events.some(e=>e.k==="ALLOC"&&/最近 5 笔影子交易全亏/.test(e.text)));
  // dynamic-v1.4 pool log: allocator changes (allow, cut), the hourly predictor snapshot, the scoring, backfill progress — in order, by seq
  const recs=rt.poolRecs.map(r=>r.rec),types=new Set(recs.map(r=>r.t));
  for(const t of ["GATE","PRED","SCORE","BACKFILL"])assert.ok(types.has(t as never),`${t} record`);
  const allow=recs.find(r=>r.t==="GATE"&&r.pb===pb&&r.ok)!;assert.equal(allow.src,"allocator");assert.equal(allow.decision,"ALLOW");
  assert.equal(allow.p6,f.p["6"]);assert.equal(allow.pMin,PRED_ALLOC.pMin);assert.equal(allow.phase,"GOOD");assert.equal(typeof allow.elapsedH,"number");assert.ok(Number(allow.risk)>0);
  assert.ok(recs.some(r=>r.t==="GATE"&&r.pb===pb&&r.decision==="CUT"&&/最近 5 笔影子交易全亏/.test(String(r.why))),"cut recorded");
  const pred=recs.find(r=>r.t==="PRED")!;assert.ok(Number(pred.n)>=1);assert.equal((pred.top as {pb:string}[])[0]!.pb,pb);
  assert.equal(recs.filter(r=>r.t==="PRED").length,rt.fcRows.length,"one snapshot per hourly row");
  const sc=recs.find(r=>r.t==="SCORE")!;assert.equal(sc.n,1);assert.equal(sc.hit,1);
  const bf=recs.find(r=>r.t==="BACKFILL")!;assert.equal(typeof bf.total,"number");assert.ok(Number(bf.total)>=Number(bf.done));assert.equal(bf.venues,"bybit/okx/kucoin");
  assert.deepEqual(rt.poolRecs.map(r=>r.seq),rt.poolRecs.map((_,i)=>i+1),"sequence numbers for the worker relay");
  void IV_SEC;void now0;
});

test("live score: each scored forecast records the net of the shadow trades that actually followed within its horizon (good vs not), shown in plain words",()=>{
  const rows:P.FcRow[]=[{t:T0,f:{a:[.7,.7,.7]},y:{}},{t:T0+H,f:{a:[.3,.3,.3]},y:{}}],track:Record<string,P.Track>={};
  const ts=[{et:T0+600,net:.01},{et:T0+2*H,net:-.004},{et:T0+30*H,net:.002}];
  const realized:P.Realized=(_pb,from,to)=>{const xs=ts.filter(x=>x.et>=from&&x.et<to);return [xs.length,xs.reduce((a,x)=>a+x.net,0)];};
  P.scoreRows(rows,()=>1,T0+8*H,track,undefined,{realized,pMin:.58});
  assert.deepEqual(rows[0]!.r!.a![0],[2,.006]);assert.deepEqual(rows[1]!.r!.a![0],[1,-.004]);
  const v=P.realView(track.a,0)!;assert.equal(v.good.forecasts,1);assert.equal(v.good.trades,2);assert.ok(Math.abs(v.good.avg!-.003)<1e-12);assert.equal(v.other.trades,1);
  assert.equal(P.realLine(track.a,0),"实盘检验（6 小时内跟着来的影子交易）：看好时 平均 0.30%/笔（1 次预测后 2 笔）；不看好时 平均 -0.40%/笔（1 次预测后 1 笔）");
  assert.match(P.realLine(undefined,0),/还没有到期/);
});

test("one scheme: burst-leader is a pool member fed by the engine's shadow trades (deduplicated, never simulated) and gets a forecast like the others",()=>{
  const rt=new DynamicResearch(),pb="burst-leader";
  const xs=tradesOf(pb,[[3,.006],[3,-.006],[3,.006],[3,-.006],[2,.006]]).map(t=>({...t,side:"LONG" as const,ep:1,xp:1+t.net}));
  assert.equal(rt.addExternal(xs,T0*1000),xs.length);assert.equal(rt.addExternal(xs.slice(0,5),T0*1000),5,"same trades again");
  assert.equal(rt.tradesLite().filter(t=>t.pb===pb).length,xs.length,"deduplicated by entry time");
  assert.equal(rt.addExternal([{...xs[0]!,pb:"box1h-long"}],T0*1000),0,"only external playbooks");
  assert.ok([...rt.tsrc.keys()].every(k=>k.startsWith("x|SOL_USDT|1m|")));
  const last=xs.at(-1)!.xt;rt.series.set("BTC_USDT|1h",series1h("BTC_USDT",last-40*D,40*24));rt.tradesLoaded=true;
  rt.analyze((Math.floor(last/H)+1)*H*1000+60_000);
  const f=rt.forecasts[pb];assert.ok(f,"forecast for burst-leader");assert.ok(rt.gates![pb],"gated by the predictor");
  const v=rt.view((Math.floor(last/H)+1)*H*1000+60_000).playbooks.find(p=>p.id===pb)!;assert.equal(v.tier,"short");assert.match(v.pred!.line,/^现在：/);
});
