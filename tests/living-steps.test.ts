/** Unit tests for the living layer steps: probes (C1), thesis (C2), selection (C3), entry (C4), exits (C5/B4), conviction (C6). */
import test from "node:test";
import assert from "node:assert/strict";
import {detectProbes,registerObservations,matureObservations,probeScore,initialProbes,atr,efficiency,type Trigger} from "../lib/living/probes.ts";
import {judge,advanceThesis,initialThesis,thesisSupports,type ThesisInputs} from "../lib/living/thesis.ts";
import {selectCandidates,initialSelect,type Market,type Candidate} from "../lib/living/select.ts";
import {planPosition,stopCheck,newWatch,stepWatch} from "../lib/living/entry.ts";
import {fastProtection,thesisExits,type PositionView} from "../lib/living/exits.ts";
import {layerOne,layerTwo,evidenceFactor,normalRisk,fastRisk} from "../lib/living/conviction.ts";
import {LivingTape,type MidBar} from "../lib/living/tape.ts";
import type {ProbeScore,ProbeId} from "../lib/living/probes.ts";
import type {Episode} from "../lib/living/fast-lane.ts";

const T0=1_792_000_000_000-1_792_000_000_000%3_600_000;// hour aligned
const bars=(n:number,f:(i:number)=>number,end=T0):MidBar[]=>Array.from({length:n},(_,i)=>{const t=(end/1000)-(n-i)*300,o=f(i-1),c=f(i);
  return {time:t,open:o,close:c,high:Math.max(o,c)*1.0005,low:Math.min(o,c)*.9995};});
const score=(p:ProbeId,over:Partial<ProbeScore>={}):ProbeScore=>({probe:p,score:.003,t:3.2,n:40,rewarded:true,persistence:"ok",corr:.3,regimeScore:null,regimeN:0,...over});
const scores=(over:Partial<Record<ProbeId,Partial<ProbeScore>>>={})=>Object.fromEntries((["P1","P2","P3","P4","P5","P6","P7","P9","MOM"] as ProbeId[])
  .map(p=>[p,score(p,{rewarded:false,score:0,t:0,n:0,...over[p]})])) as Record<ProbeId,ProbeScore>;

test("C1 P1 breakout fires on a close above the 4h high + 0.2 ATR; a flat coin fires nothing",()=>{
  const flat=bars(60,()=>100),brk=bars(60,i=>i<59?100+Math.sin(i)*.05:101);
  const tr=detectProbes({at:T0,members:["A","B"],bars:s=>s==="A"?flat:brk,funding:{},oi1h:{},momentum:[]});
  assert.ok(tr.some(t=>t.probe==="P1"&&t.symbol==="B"&&t.side==="LONG"));
  assert.ok(!tr.some(t=>t.symbol==="A"&&t.probe==="P1"));
  assert.ok(atr(brk)>0);assert.ok(efficiency(bars(20,i=>100+i))>.99);
});
test("C1 a probe is rewarded only after ≥30 independent net-positive observations; costs are deducted; stop is checked first",()=>{
  const st=initialProbes();
  // steady up-drift 0.05%/bar: 60-minute LONG payoff ≈ +0.6% gross, ≈ +0.41% after 0.19% cost
  const drift=(t:number)=>100*Math.exp(.0005*((t-T0/1000)/300)+.00002*Math.sin(t/977));
  const series=(s:string)=>{void s;return (end:number)=>{const n=200,rows:MidBar[]=[];for(let i=n;i>=1;i--){const t=end/1000-i*300;const o=drift(t),c=drift(t+300);rows.push({time:t,open:o,close:c,high:Math.max(o,c),low:Math.min(o,c)});}return rows;};};
  let at=T0;
  for(let k=0;k<34;k++){
    registerObservations(st,[{probe:"P1",symbol:"A",side:"LONG",strength:1}],at,"U");
    const done=matureObservations(st,s=>series(s)(at+70*60_000),["A"],{},at+70*60_000);
    if(k>0)assert.ok(done.length<=1);
    at+=65*60_000;
  }
  matureObservations(st,s=>series(s)(at+70*60_000),["A"],{},at+70*60_000);
  const sc=probeScore(st,"P1",at);
  assert.ok(sc.n>=30,`n ${sc.n}`);assert.ok(sc.score>.002&&sc.score<.0055,`score ${sc.score}`);assert.ok(sc.t>=2);assert.equal(sc.rewarded,true);
  assert.equal(sc.persistence,"unverified");// first week
  // a member with a stop inside the first bar books the stop, not the close
  const st2=initialProbes();registerObservations(st2,[{probe:"P1",symbol:"A",side:"LONG",strength:1,stop:99,target:200}],T0,"U");
  const down=(end:number)=>bars(30,i=>i>=18?98:100,end);
  const out=matureObservations(st2,()=>down(T0+60*60_000),["A"],{},T0+60*60_000);
  assert.equal(out.length,1);assert.ok(Math.abs(out[0]!.value-(99/100-1-.0019))<1e-9);
});
test("C2 thesis: trend vs range vs chop, 'market does not pay' sentence, 2-bar debounce, burst immediate",()=>{
  const base:ThesisInputs={b1h:.004,b4h:.012,b24h:.02,breadth:.75,volPct:.5,dispersion:.002,btcEff:.6,ethEff:.5,funding:.0001,oi1h:null,members:60};
  const st=initialThesis();
  const t1=judge(base,scores({P5:{rewarded:true,score:.003,t:3,n:40}}),null,T0,st);
  assert.equal(t1.structure,"TREND");assert.equal(t1.side,"LONG");assert.ok(t1.playbooks.some(p=>p.pb==="trend-pullback"));
  assert.ok(thesisSupports(t1,"trend-pullback","LONG"));assert.ok(!thesisSupports(t1,"trend-pullback","SHORT"));
  const none=judge({...base,b4h:.001,btcEff:.1,ethEff:.1},scores(),null,T0,st);
  assert.equal(none.structure,"RANGE");assert.equal(none.playbooks.length,0);assert.match(none.sentence,/现在市场不给钱/);
  advanceThesis(st,t1,T0);assert.equal(st.current?.structure,"TREND");
  advanceThesis(st,none,T0+300_000);assert.equal(st.current?.structure,"TREND","one bar is not enough");
  advanceThesis(st,none,T0+600_000);assert.equal(st.current?.structure,"RANGE");
  const burst=judge(base,scores(),{side:"SHORT"},T0+900_000,st);advanceThesis(st,burst,T0+900_000);
  assert.equal(st.current?.structure,"BURST");assert.equal(st.current?.side,"SHORT");
});
test("C3 selection: hard filters (volume, spread, MMR), one per correlation group, top 3",()=>{
  const up=(k:number)=>bars(60,i=>100*(1+.001*i+.0003*Math.sin(i*k)));
  const series:Record<string,MidBar[]>={A:up(1),B:up(1),C:up(2.3),D:up(3.7),E:up(5.1),F:up(7.3),LOWVOL:up(1.7),WIDE:up(2.9),HIGHMMR:up(4.3)};
  const m:Market={bars:s=>series[s]!,spread:s=>s==="WIDE"?.001:.0002,volume:s=>s==="LOWVOL"?5e6:5e7,mmr:s=>s==="HIGHMMR"?.05:.005,funding:()=>0};
  const tr:Trigger[]=Object.keys(series).map(s=>({probe:"P1",symbol:s,side:"LONG",strength:1,ref:series[s]!.at(-2)!.close}));
  const out=selectCandidates(m,initialSelect(),"breakout",tr,"LONG",true);
  const by=Object.fromEntries(out.map(c=>[c.symbol,c]));
  assert.match(by.LOWVOL!.reject!,/成交额/);assert.match(by.WIDE!.reject!,/价差/);assert.match(by.HIGHMMR!.reject!,/维持保证金率/);
  const ok=out.filter(c=>!c.reject);assert.equal(ok.length,3);assert.deepEqual(ok.map(c=>c.rank),[1,2,3]);
  assert.ok(!(ok.some(c=>c.symbol==="A")&&ok.some(c=>c.symbol==="B")),"A and B move identically: only one");
  // liqSafety off: MMR is no longer a filter
  assert.ok(!selectCandidates(m,initialSelect(),"breakout",tr,"LONG",false).find(c=>c.symbol==="HIGHMMR")?.reject?.includes("维持保证金率"));
});
test("C4 stop rules: widen to 0.6%, reject >2%, MMR >3% and stop >40% of liquidation distance are skipped",()=>{
  const ok=stopCheck({side:"LONG",price:100,stop:99.8,min:.006,max:.02,leverageMax:10,mmr:.005,liqSafety:true});
  assert.ok(ok.ok&&Math.abs(ok.stop-99.4)<1e-9);
  const wide=stopCheck({side:"LONG",price:100,stop:97.5,min:.006,max:.02,leverageMax:10,mmr:.005,liqSafety:true});assert.ok(!wide.ok&&/宽度/.test(wide.reason));
  const mmr=stopCheck({side:"SHORT",price:100,stop:101,min:.006,max:.02,leverageMax:10,mmr:.04,liqSafety:true});assert.ok(!mmr.ok&&/维持保证金率/.test(mmr.reason));
  assert.ok(stopCheck({side:"SHORT",price:100,stop:101,min:.006,max:.02,leverageMax:10,mmr:.025,liqSafety:true}).ok,"2.5% is inside the 3% cap");
  // 10x, mmr 1.8%: liquidation ≈ 8.35% away; a 1.9% stop is within 40% (3.3%): ok
  assert.ok(stopCheck({side:"LONG",price:100,stop:98.1,min:.006,max:.02,leverageMax:10,mmr:.018,liqSafety:true}).ok);
  // 3x max leverage → 10x not possible → 3x: far liquidation, ok; a fake 50x contract still uses 10x
  assert.ok(stopCheck({side:"LONG",price:100,stop:98.1,min:.006,max:.02,leverageMax:50,mmr:.018,liqSafety:true}).ok);
  const off=stopCheck({side:"SHORT",price:100,stop:101,min:.006,max:.02,leverageMax:10,mmr:.04,liqSafety:false});assert.ok(off.ok);
  assert.ok(!stopCheck({side:"LONG",price:100,stop:100.5,min:.006,max:.02,leverageMax:10,mmr:.005,liqSafety:true}).ok);
});
test("C4 watch: waits for the zone, needs 2 fresh samples and a closed 1m bar turning back; expires as 没给位置; invalidation first",()=>{
  const rows=bars(60,i=>100+i*.05);// up trend
  const c:Candidate={symbol:"X",side:"LONG",playbook:"momentum",probe:"MOM",score:.7,rank:1,factors:{eff:1,fit:1,early:1,funding:1,edge:1},
    trigger:{probe:"MOM",symbol:"X",side:"LONG",strength:1},reject:null};
  const plan=planPosition(c,rows)!;assert.ok(plan.lo<=plan.hi&&plan.inv<plan.lo);
  const w=newWatch(c,{lo:99,hi:100,inv:98,target:null},T0,60,{l1:true,l2:true,probeSize:false,why1:"",why2:""});
  const tape=new LivingTape();
  tape.feed([{symbol:"X",mid:101,at:T0+1000}],T0+1000);
  let x=stepWatch(w,tape,T0+2000,false,true);assert.equal(x.status,"WAITING");assert.match(x.reason!,/回到位置/);
  // enters the zone, then a 1m bar closes up
  let t=T0+60_000;for(const p of [99.6,99.5,99.4]){tape.feed([{symbol:"X",mid:p,at:t}],t);x=stepWatch(x,tape,t+100,false,true);t+=20_000;}
  assert.equal(x.status,"WAITING");
  for(const p of [99.5,99.7,99.9]){tape.feed([{symbol:"X",mid:p,at:t}],t);t+=20_000;}
  tape.feed([{symbol:"X",mid:99.9,at:t}],t);
  x=stepWatch(x,tape,t+500,false,true);assert.equal(x.status,"READY",x.reason??"");
  assert.equal(stepWatch({...x,status:"WAITING"},tape,t+500,true,true).reason,"快速通道有反方向警报");
  const late=stepWatch(w,tape,T0+31*60_000,false,true);assert.equal(late.status,"DONE");assert.match(late.reason!,/没给位置|没等到确认/);
  const tape2=new LivingTape();tape2.feed([{symbol:"X",mid:97.9,at:T0+1000}],T0+1000);
  assert.match(stepWatch(w,tape2,T0+2000,false,true).reason!,/失效价/);
});
test("C6 conviction: three layers, probe size while persistence is unverified, evidence factor and sizing",()=>{
  assert.equal(layerOne(score("P1",{rewarded:false,score:.0004,t:1.1,n:12})).ok,false);
  assert.match(layerOne(score("P1",{rewarded:false,score:.0004,t:1.1,n:12})).why,/奖励分.*t 1\.1.*样本 12/);
  const u=layerOne(score("P1",{persistence:"unverified"}));assert.ok(u.ok&&u.probeSize);
  assert.equal(evidenceFactor(score("P1"),true,[]).factor,.3);
  assert.equal(evidenceFactor(score("P1",{t:2.5}),false,[]).factor,.6);
  assert.equal(evidenceFactor(score("P1",{t:3.1}),false,Array(30).fill(.2)).factor,1);
  assert.equal(evidenceFactor(score("P1",{t:3.1}),false,Array(30).fill(-.2)).factor,.6);
  const n=normalRisk({premium:false,evidence:.6,sizingItem:true});assert.equal(n.riskRate,.0055);assert.ok(Math.abs(n.multiple-3)<1e-12);
  assert.equal(normalRisk({premium:true,evidence:.3,sizingItem:false}).multiple,5);
  assert.equal(fastRisk({fastMultiple:5,probe:false}).multiple,3);assert.ok(Math.abs(fastRisk({fastMultiple:1,probe:true}).multiple-1/3)<1e-12);
  assert.equal(layerTwo(null,"breakout","LONG",null).ok,false);
});
const ep=(side:"LONG"|"SHORT",anchor:Record<string,number>,over:Partial<Episode>={}):Episode=>({id:"fe-1",side,phase:"ALERT",alertAt:T0,alertKind:"z60",confirmAt:null,
  anchorAt:T0-60_000,anchor,level:.004,extreme:.004,extremeAt:T0,retrace:0,maxRetrace:0,peakZ:4,quietSince:null,pullbackSeen:false,newExtremeAfterPullbackAt:null,...over});
const pos=(over:Partial<PositionView>):PositionView=>({id:"t1",symbol:"X",side:"SHORT",entryPrice:100,stopPrice:101.5,liquidationPrice:109,openedAt:T0-3_600_000,
  favorable:0,guard:null,price:100.4,...over});
test("B4 protection: opposite trades moving with the basket are tightened at alert, liquidation-near ones exit, losers exit at confirm, winners go breakeven",()=>{
  const tape=new LivingTape(),now=T0+2_000;
  const members=Array.from({length:12},(_,i)=>`M${i}`);
  tape.feed([...members,"X","Y"].map(s=>({symbol:s,mid:100,at:T0-60_000})),T0-60_000);
  tape.feed([...members.map(s=>({symbol:s,mid:100.5,at:now-200})),{symbol:"X",mid:100.4,at:now-200},{symbol:"Y",mid:99.9,at:now-200}],now);
  const e=ep("LONG",Object.fromEntries([...members,"X","Y"].map(s=>[s,100])));
  const alert=[{type:"ALERT" as const,at:now,episodeId:"fe-1",side:"LONG" as const,detail:{}}];
  const a=fastProtection({positions:[pos({})],ep:e,events:alert,tape,now,scale:1,peaks:new Map()});
  assert.equal(a.length,1);assert.equal(a[0]!.action,"GUARD");assert.equal(a[0]!.code,"LIVING_FAST_TIGHTEN");assert.ok(a[0]!.stop!<101.5&&a[0]!.stop!>100.4);
  const near=fastProtection({positions:[pos({liquidationPrice:101})],ep:e,events:alert,tape,now,scale:1,peaks:new Map()});
  assert.equal(near[0]!.code,"LIVING_FAST_LIQ_GUARD");assert.equal(near[0]!.action,"EXIT");
  // a coin not moving with the basket is left alone
  assert.equal(fastProtection({positions:[pos({symbol:"Y",price:99.9})],ep:e,events:alert,tape,now,scale:1,peaks:new Map()}).length,0);
  const confirm=[{type:"CONFIRM" as const,at:now,episodeId:"fe-1",side:"LONG" as const,detail:{}}];
  assert.equal(fastProtection({positions:[pos({})],ep:{...e,phase:"CONFIRMED"},events:confirm,tape,now,scale:1,peaks:new Map()})[0]!.code,"LIVING_FAST_CONFIRM_EXIT");
  const win=fastProtection({positions:[pos({entryPrice:101,stopPrice:100.9,price:100.4})],ep:{...e,phase:"CONFIRMED"},events:confirm,tape,now,scale:1,peaks:new Map()});
  assert.equal(win[0]!.code,"LIVING_FAST_BREAKEVEN");assert.ok(Math.abs(win[0]!.stop!-101*(1-.0019))<1e-6);
  // with-move: armed at +1%, exits after 40% giveback
  const peaks=new Map([["t2",.02]]);
  const g=fastProtection({positions:[pos({id:"t2",side:"LONG",entryPrice:99.3,stopPrice:98,price:100.4})],ep:e,events:[],tape,now,scale:1,peaks});
  assert.equal(g[0]!.code,"LIVING_FAST_GIVEBACK");
});
test("C5 thesis exits: unrewarded → losers exit, winners to breakeven; fast trades: fake → exit, 10 min without +0.5% → exit, end → handoff",()=>{
  const tape=new LivingTape(),now=T0+3_600_000;
  const note=(k:"N"|"F",pb:string)=>({v:"living-v1" as const,k,pb,th:"th",ep:k==="F"?"fe-1":null,ev:"normal" as const,mult:3,sc:.003,t:3,n:40,per:"ok",rk:1,inv:99,ref:null,hold:60,why:""});
  const sc=scores({P1:{rewarded:false,score:-.001,t:-1.5,n:40}});
  const lose=thesisExits({positions:[pos({side:"LONG",price:99.8,living:note("N","breakout")})],thesis:null,scores:sc,tape,now,episode:null,handedOff:new Set(),lastEnd:null});
  assert.equal(lose[0]!.code,"LIVING_THESIS_UNREWARDED");assert.equal(lose[0]!.action,"EXIT");
  const winx=thesisExits({positions:[pos({side:"LONG",price:101,stopPrice:99,living:note("N","breakout")})],thesis:null,scores:sc,tape,now,episode:null,handedOff:new Set(),lastEnd:null});
  assert.equal(winx[0]!.code,"LIVING_THESIS_BREAKEVEN");assert.equal(winx[0]!.action,"GUARD");
  const fake=thesisExits({positions:[pos({side:"LONG",living:note("F","fast")})],thesis:null,scores:sc,tape,now,episode:null,handedOff:new Set(),lastEnd:{id:"fe-1",end:"FAKE",at:now}});
  assert.equal(fake[0]!.code,"LIVING_FAST_FAKE");
  const slow=thesisExits({positions:[pos({side:"LONG",openedAt:now-11*60_000,favorable:.002,living:note("F","fast")})],thesis:null,scores:sc,tape,now,episode:null,handedOff:new Set(),lastEnd:null});
  assert.equal(slow[0]!.code,"LIVING_FAST_TIME");
  const th={...judge({b1h:.004,b4h:.012,b24h:.02,breadth:.75,volPct:.5,dispersion:.002,btcEff:.6,ethEff:.5,funding:null,oi1h:null,members:60},scores({MOM:{rewarded:true,score:.003,t:3,n:40}}),null,now,initialThesis())};
  const ho=thesisExits({positions:[pos({side:"LONG",openedAt:now-5*60_000,favorable:.01,living:note("F","fast")})],thesis:th,scores:sc,tape,now,episode:null,handedOff:new Set(),lastEnd:{id:"fe-1",end:"EXHAUST",at:now}});
  assert.equal(ho[0]!.code,"LIVING_FAST_HANDOFF");
  const noho=thesisExits({positions:[pos({side:"SHORT",openedAt:now-5*60_000,favorable:.01,living:note("F","fast")})],thesis:th,scores:sc,tape,now,episode:null,handedOff:new Set(),lastEnd:{id:"fe-1",end:"EXHAUST",at:now}});
  assert.equal(noho[0]!.code,"LIVING_FAST_EXHAUST");
});
