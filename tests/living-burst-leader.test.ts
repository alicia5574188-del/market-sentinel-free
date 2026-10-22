/** burst-leader-v1: special-condition check, leader ranking, structure stop, burst hold, exit ownership and the engine wiring. */
import test from "node:test";
import assert from "node:assert/strict";
import {LEADER,burstCheck,basketAt,rankLeaders,leaderStop,leaderHold,vol6Of,closesOf,shadowStep,BURST_POOL_MAX_RISK,SHADOW_FEE,type Closes,type BurstShadow} from "../lib/living/burst-leader.ts";
import {thesisExits,fastProtection,type PositionView} from "../lib/living/exits.ts";
import {LivingEngine,LIVING_KEYS} from "../lib/living/engine.ts";
import {defaultLivingConfig,LIVING_ITEMS} from "../lib/living/config.ts";
import {selectBasket,LivingTape,type MidBar} from "../lib/living/tape.ts";
import type {LivingNote} from "../lib/living/directive.ts";

const N=50,alts=Array.from({length:N},(_,i)=>`C${i}_USDT`);
/** deterministic noise: coin i, minute k → tiny move */
const noise=(i:number,k:number)=>Math.sin(i*12.9898+k*78.233)*43758.5453%1*.0006;
/** closes for `mins` minutes ending at bar `end`; `shock(k,i)` adds a cumulative move from minute k on */
function series(end:number,mins:number,shock:(k:number,i:number)=>number=()=>0):Closes{
  const c:Closes=new Map();
  alts.forEach((s,i)=>{const m=new Map<number,number>();let p=100+i;
    for(let k=0;k<mins;k++){p*=1+noise(i,k);m.set(end-(mins-1-k)*60,p*(1+shock(k,i)));}c.set(s,m);});
  return c;
}
const END=1_792_360_800,MINS=420;
const burstAt=(k0:number,size:number,share=1)=>(k:number,i:number)=>k>=k0&&i<N*share?size:0;
const none={LONG:0,SHORT:0};

test("special check: a sudden synchronized burst after 45 quiet minutes triggers; anything else is recorded with its reason",()=>{
  const k0=MINS-1;// the burst lands in the last bar: quiet (< 3σ) one minute, ≥ 4σ the next
  const up=series(END,MINS,burstAt(k0,.006));
  const c=burstCheck(up,alts,END,none);
  assert.equal(c.verdict,"TRIGGER",c.why);assert.equal(c.side,"LONG");assert.ok(c.z!>=LEADER.zMin);assert.ok(c.breadth!>=.8);
  assert.match(c.why,/突然暴涨/);
  const down=burstCheck(series(END,MINS,burstAt(k0,-.006)),alts,END,none);assert.equal(down.verdict,"TRIGGER");assert.equal(down.side,"SHORT");
  // same move but only 60% of the coins → breadth
  const narrow=burstCheck(series(END,MINS,(k,i)=>burstAt(k0,i<N*.6?.01:-.002)(k,0)),alts,END,none);
  assert.ok(narrow.verdict==="BREADTH"||narrow.verdict==="NONE",narrow.why);
  // a ramp: 3σ+ one minute, 4σ+ the next → not "sudden"; an earlier burst 20 minutes before → not quiet either
  const ramp=burstCheck(series(END,MINS,(k)=>k===MINS-2?.0025:k>=MINS-1?.006:0),alts,END,none);assert.equal(ramp.verdict,"NOT_QUIET",ramp.why);
  const two=series(END,MINS,(k,i)=>burstAt(MINS-23,.004)(k,i)+burstAt(k0,.006)(k,i));
  const t2=burstCheck(two,alts,END,none);assert.equal(t2.verdict,"NOT_QUIET",t2.why);assert.ok(t2.hotBar!=null);
  // the same side within 3 hours → cooldown
  assert.equal(burstCheck(up,alts,END,{LONG:END-3600,SHORT:0}).verdict,"COOLDOWN");
  assert.equal(burstCheck(up,alts,END,{LONG:0,SHORT:END-3600}).verdict,"TRIGGER","the other side's lockout does not block");
  // ordinary minute and too little history
  assert.equal(burstCheck(series(END,MINS),alts,END,none).verdict,"NONE");
  assert.equal(burstCheck(series(END,60,burstAt(57,.006)),alts,END,none).verdict,"WARMING");
  assert.equal(basketAt(up,alts.slice(0,10),END).b3,null,"fewer than 30 coins → no basket");
});

test("leader ranking: relative strength since the origin + own volatility; laggards, lone spikes and thin coins are skipped",()=>{
  const nowBar=END,originBar=END-5*60,c:Closes=new Map();
  // basket +0.5%; C0 +2.0% (rs +1.5), C1 +1.2%, C2 +5% (rs +4.5: lone spike), C3 +1.5% but thin, C4 -0.2% laggard
  const mv:Record<string,number>={C0_USDT:.02,C1_USDT:.012,C2_USDT:.05,C3_USDT:.015,C4_USDT:-.002};
  for(const s of alts){const m=new Map<number,number>();m.set(originBar,100);m.set(nowBar,100*(1+(mv[s]??.005+((Number(s.slice(1,-5))%7)-3)*.0001)));c.set(s,m);}
  const vol=(s:string)=>s==="C1_USDT"?.004:.001,volume=(s:string)=>s==="C3_USDT"?1e6:5e7+(49-Number(s.slice(1,-5)))*1e6;
  const r=rankLeaders({side:"LONG",alts,c,originBar,nowBar,vol6:vol,volume,filter:()=>null,skip:()=>null,top:3});
  const picks=r.picks.map(x=>x.sym);
  assert.equal(picks.length,3);assert.ok(picks.includes("C0_USDT")&&picks.includes("C1_USDT"),picks.join());
  assert.ok(!picks.includes("C2_USDT")&&/单独暴冲/.test(r.rows.find(x=>x.sym==="C2_USDT")!.why));
  assert.match(r.rows.find(x=>x.sym==="C3_USDT")!.why,/后 30%/);
  assert.match(r.rows.find(x=>x.sym==="C4_USDT")!.why,/跑输/);
  assert.ok(Math.abs(r.basket!-.005)<.001);
  // short side mirrors the sign
  const s=rankLeaders({side:"SHORT",alts,c,originBar,nowBar,vol6:vol,volume,filter:()=>null,skip:()=>null,top:3});
  assert.ok(s.picks.some(x=>x.sym==="C4_USDT"),"the weakest coin leads a short burst");
  // the hard filter and open positions are respected; top 0 picks nothing
  const f=rankLeaders({side:"LONG",alts,c,originBar,nowBar,vol6:vol,volume,filter:x=>x==="C0_USDT"?"价差太大":null,skip:x=>x==="C1_USDT"?"已有持仓":null,top:0});
  assert.equal(f.picks.length,0);assert.equal(f.rows.find(x=>x.sym==="C0_USDT")!.why,"价差太大");assert.equal(f.rows.find(x=>x.sym==="C1_USDT")!.why,"已有持仓");
});

test("structure stop beyond the burst origin, 1%–2.5%; 6-hour volatility from 1m closes",()=>{
  assert.ok(Math.abs(leaderStop("LONG",101,100).rate-.013)<1e-9);
  assert.equal(leaderStop("LONG",100.2,100).rate,.01,"floor 1%");
  assert.equal(leaderStop("SHORT",95,100).rate,.025,"cap 2.5%");
  assert.ok(leaderStop("SHORT",99,100).stop>99);
  const rows:MidBar[]=Array.from({length:400},(_,k)=>{const p=100*(1+(k%2?.001:0));return{time:k*60,open:p,high:p,low:p,close:p};});
  const v=vol6Of(rows,399*60)!;assert.ok(v>.0009&&v<.0011,String(v));
  assert.equal(vol6Of(rows.slice(0,50),49*60),null);
});

test("burst hold: no exit inside costs; breakeven + fees after +0.8%; trail from +1.5% keeping 70%; 4-hour cap",()=>{
  const h=(o:Partial<Parameters<typeof leaderHold>[0]>)=>leaderHold({side:"LONG",entry:100,price:100,peak:0,ageMin:10,stop:98.5,...o});
  assert.equal(h({price:99.5,peak:.005}).act,"HOLD","−0.5% after a +0.5% peak: only the stop decides");
  const be=h({price:100.6,peak:.009});assert.equal(be.act,"GUARD");assert.equal(be.code,"LIVING_BURST_BREAKEVEN");assert.ok(Math.abs(be.stop!-100.19)<1e-9);
  const beHit=h({price:100.15,peak:.009,stop:100.19});assert.equal(beHit.act,"EXIT");assert.equal(beHit.code,"LIVING_BURST_BREAKEVEN");
  assert.ok(LEADER.beLock>=.0014,"breakeven lock covers the ≈0.14% round trip");
  const tr=h({price:101.8,peak:.02,stop:100.19});assert.equal(tr.act,"GUARD");assert.equal(tr.code,"LIVING_BURST_TRAIL");assert.ok(Math.abs(tr.stop!-101.4)<1e-9);
  const out=h({price:101.35,peak:.02,stop:101.4});assert.equal(out.act,"EXIT");assert.equal(out.code,"LIVING_BURST_TRAIL");
  assert.equal(h({price:101.5,peak:.02,stop:101.4}).act,"HOLD","above the lock and the stop already there");
  const s=leaderHold({side:"SHORT",entry:100,price:98.2,peak:.02,ageMin:30,stop:101});assert.equal(s.act,"GUARD");assert.ok(Math.abs(s.stop!-98.6)<1e-9);
  assert.equal(h({ageMin:240,price:100.3}).code,"LIVING_BURST_MAXHOLD");
});

const note=(o:Partial<LivingNote>={}):LivingNote=>({v:"living-v2",k:"F",pb:LEADER.pb,th:null,ep:"bl-x-L",ev:"fast",mult:1,sc:null,t:null,n:null,per:null,rk:1,inv:98.5,ref:99,hold:240,why:"",bh:1,...o});
const pv=(o:Partial<PositionView>={}):PositionView=>({id:"t1",symbol:"C0_USDT",side:"LONG",entryPrice:100,stopPrice:98.5,liquidationPrice:90.5,openedAt:0,favorable:0,guard:null,living:note(),price:100.1,...o});

test("exit ownership: FAST_FAKE / EXHAUST / 10-minute / tighten / confirm-exit / giveback never touch a burst trade; the liquidation guard still does",()=>{
  const tape=new LivingTape();
  const th=thesisExits({positions:[pv({openedAt:-20*60_000})],thesis:null,scores:{} as never,tape,now:0,episode:null,handedOff:new Set(),lastEnd:{id:"bl-x-L",end:"FAKE",at:0}});
  assert.deepEqual(th,[]);
  const plain=thesisExits({positions:[pv({living:note({bh:undefined,ep:"fe-1"})})],thesis:null,scores:{} as never,tape,now:0,episode:null,handedOff:new Set(),lastEnd:{id:"fe-1",end:"FAKE",at:0}});
  assert.equal(plain[0]?.code,"LIVING_FAST_FAKE","a normal fast trade still exits on FAKE");
  // opposite-side alert + confirm on a burst trade near liquidation → only the liquidation guard
  for(let t=0;t<=70_000;t+=2_000)tape.feed([{symbol:"C0_USDT",mid:100-t/70_000*1.5,at:t},{symbol:"C1_USDT",mid:50-t/70_000*.75,at:t}],t);
  const ep={id:"fe-2",side:"SHORT",phase:"CONFIRMED",anchor:{C0_USDT:100,C1_USDT:50}} as never;
  const far=fastProtection({positions:[pv({price:98.6,liquidationPrice:80})],ep,events:[{type:"ALERT",episodeId:"fe-2"},{type:"CONFIRM",episodeId:"fe-2"}] as never,tape,now:70_000,scale:1,peaks:new Map()});
  assert.deepEqual(far,[],"no tighten / confirm-exit for a burst trade");
  const near=fastProtection({positions:[pv({price:98.6,liquidationPrice:98})],ep,events:[{type:"ALERT",episodeId:"fe-2"}] as never,tape,now:70_000,scale:1,peaks:new Map()});
  assert.equal(near[0]?.code,"LIVING_FAST_LIQ_GUARD");
  const same=fastProtection({positions:[pv({side:"SHORT",price:98.6,entryPrice:100,stopPrice:101.5})],ep,events:[] as never,tape,now:70_000,scale:1,peaks:new Map([["t1",.02]])});
  assert.deepEqual(same,[],"no 40% giveback exit for a burst trade");
});

// ---------------------------------------------------------------- engine wiring on a synthetic tape (no request, no fixture)
function engineRun(items:Partial<Record<string,boolean>>={},dyn?:Parameters<LivingEngine["plan"]>[0]["dyn"],noQuote:ReadonlySet<string>=new Set()){
  const t0=END*1000-MINS*60_000,e=new LivingEngine(t0);
  const cfg=defaultLivingConfig(t0);e.restore(new Map([[LIVING_KEYS.config,{...cfg,items:{...cfg.items,...items}}]]),t0);
  e.basket=selectBasket(alts.map(s=>({symbol:s,volume24hUsd:5e7,sources:3,gate:true})),t0);
  const k0=MINS-3,shock=burstAt(k0,.006);
  const px=(i:number,k:number)=>{let p=100+i;for(let j=0;j<=k;j++)p*=1+noise(i,j);return p*(1+shock(k,i)*(1+i/N));};
  const quotes:Record<string,{bestBid:number;bestAsk:number;observedAt:number;entryReady:boolean}>={};
  const contracts=Object.fromEntries(alts.map(s=>[s,{maintenanceRate:.005,leverageMax:20}]));
  const out:{now:number;dir:ReturnType<LivingEngine["plan"]>}[]=[];
  for(let k=0;k<MINS+6;k++){
    const at=t0+k*60_000+30_000;
    const pts=alts.map((s,i)=>({symbol:s,mid:px(i,Math.min(k,MINS+5)),at,spread:.0001,sources:3,volume24hUsd:5e7+i*1e6}));
    e.tape.feed(pts,at);
    if(k<MINS-5)continue;
    for(const p of pts)if(!noQuote.has(p.symbol))quotes[p.symbol]={bestBid:p.mid*.9999,bestAsk:p.mid*1.0001,observedAt:at,entryReady:true};
    const dir=e.plan({now:at+5_000,forward:{positions:[],history:[],opportunities:[]},quotes,contracts,funding:{},candles:{},...(dyn?{dyn}:{})});
    e.tickLog(at+5_000);
    out.push({now:at,dir});
  }
  return {e,out};
}
test("engine: trigger → BURST_ONSET, ranking 2 minutes later → ≤3 burst orders (switch 10 off: own size capped at 0.75%, wide stop, bh); every check is in the timeline",()=>{
  assert.ok(LIVING_ITEMS.includes("burstLeader"));assert.equal(defaultLivingConfig(0).items.burstLeader,true);
  const {e,out}=engineRun({dynAllocator:false});
  const onset=e.log.find(r=>r.k==="BURST_ONSET");assert.ok(onset,"onset row");assert.equal(onset!.side,"LONG");
  const rank=e.log.find(r=>r.k==="BURST_RANK");assert.ok(rank,"ranking row");assert.ok(String(rank!.top).includes("rs+"));
  assert.ok(rank!.at-onset!.at>=110_000&&rank!.at-onset!.at<=130_000,"ranked 2 minutes after the trigger");
  const orders=out.flatMap(x=>x.dir?.orders??[]);
  assert.ok(orders.length>=1&&orders.length<=3,`orders ${orders.length}`);
  for(const o of orders){assert.equal(o.note.bh,1);assert.equal(o.riskRate,BURST_POOL_MAX_RISK);assert.equal(o.multiple,1);assert.equal(o.note.pb,LEADER.pb);assert.equal(o.note.hold,240);
    const q=e.tape.last(o.symbol)!.mid,rate=Math.abs(q-o.stop)/q;assert.ok(rate>=.0099&&rate<=.0251,`stop ${rate}`);}
  // later minutes: no second entry for the same burst (pending cleared, side locked)
  assert.equal(e.log.filter(r=>r.k==="BURST_RANK").length,1);
  const buckets=[...e.runlog.closed,e.runlog.bucket!].filter(Boolean);
  const rows=buckets.flatMap(b=>(b.burst??"").split(";").filter(Boolean));
  assert.ok(rows.length>=8,`checks logged ${rows.length}`);assert.ok(rows.some(r=>r.endsWith(",TRIGGER")));
  assert.ok(buckets.some(b=>b.events.some(ev=>ev.k==="BURST_RANK")));
});
test("engine: burstLeader off → the same orders are only recorded (SWITCH_OFF); the check still runs",()=>{
  const {e,out}=engineRun({burstLeader:false,dynAllocator:false});
  assert.equal(out.flatMap(x=>x.dir?.orders??[]).length,0);
  assert.ok(e.log.some(r=>r.k==="BURST_RANK"));
  assert.ok(e.log.some(r=>r.k==="RECORD_ONLY"&&/对应开关关着/.test(String(r.reason))));
});
test("one scheme (switch 10 on): burst picks are shadow trades always; orders only when the predictor gate allows burst-leader, sized ≤ 0.75% by its confidence",()=>{
  // no gate yet → recorded only (DYN_GATE), the picks are followed as shadow trades
  const a=engineRun();assert.equal(a.out.flatMap(x=>x.dir?.orders??[]).length,0);
  assert.ok(a.e.log.some(r=>r.k==="DYN_GATE"&&/动态分配不允许/.test(String(r.reason))));
  const sh=a.e.burstShadowOpen();assert.ok(sh.length>=1&&sh.length<=3,`shadows ${sh.length}`);assert.ok(sh.every(x=>x.side==="LONG"&&x.stop<x.ep));
  const gate={ok:true,risk:.0025,conf:.5,why:"预测：概率 70%"};
  const b=engineRun({},{ready:true,gates:{[LEADER.pb]:gate},signals:[],exits:[],state:null});
  const orders=b.out.flatMap(x=>x.dir?.orders??[]);assert.ok(orders.length>=1&&orders.length<=3);
  for(const o of orders){assert.equal(o.note.bh,1);assert.ok(Math.abs(o.riskRate-BURST_POOL_MAX_RISK*.5)<1e-12,`risk ${o.riskRate}`);assert.match(o.reason,/分配器/);}
  const c=engineRun({},{ready:true,gates:{[LEADER.pb]:{...gate,conf:3}},signals:[],exits:[],state:null});
  for(const o of c.out.flatMap(x=>x.dir?.orders??[]))assert.equal(o.riskRate,BURST_POOL_MAX_RISK,"never above 0.75%");
  assert.deepEqual(b.e.takeBurstShadow(),[],"nothing closed yet");
});
test("shadow burst trade: stop touch, breakeven / trail / 4 hours on closed 1m bars, net of fees",()=>{
  const at=1_000_000*60_000+10_000,t1=Math.ceil(at/60_000)*60,bar=(k:number,o:number,h:number,l:number,c:number):MidBar=>({time:t1+k*60,open:o,high:h,low:l,close:c});
  const s1:BurstShadow={id:"a",sym:"X_USDT",side:"LONG",ep:100,stop:98.5,at,peak:0,lastBar:0};
  assert.equal(shadowStep(s1,[bar(0,100,100.5,99.6,100.2)],at+120_000),null);
  const d1=shadowStep(s1,[bar(0,100,100.5,99.6,100.2),bar(1,100.2,100.3,98.4,98.6)],at+180_000)!;
  assert.equal(d1.exit,"止损");assert.equal(d1.xp,98.5);assert.ok(Math.abs(d1.net-(-.015-SHADOW_FEE))<1e-12);assert.equal(d1.pb,LEADER.pb);
  // trail: up to +2% inside the bar, closes at +1.3% (< 70% of 2%) → out at the close
  const s2:BurstShadow={id:"b",sym:"X_USDT",side:"SHORT",ep:100,stop:101.5,at,peak:0,lastBar:0};
  const d2=shadowStep(s2,[bar(0,100,100.1,98,98.7)],at+120_000)!;
  assert.equal(d2.exit,"trail");assert.ok(Math.abs(d2.net-(.013-SHADOW_FEE))<1e-9,`${d2.net}`);
  // 4 hours
  const s3:BurstShadow={id:"c",sym:"X_USDT",side:"LONG",ep:100,stop:98.5,at,peak:0,lastBar:0};
  const flat=Array.from({length:240},(_,k)=>bar(k,100,100.2,99.9,100.1));const d3=shadowStep(s3,flat,at+250*60_000)!;assert.equal(d3.exit,"maxhold");
  // no bars at all: closed after the hold limit + 2 h (data gap)
  const s4:BurstShadow={id:"d",sym:"X_USDT",side:"LONG",ep:100,stop:98.5,at,peak:0,lastBar:0};
  assert.equal(shadowStep(s4,[],at+60*60_000),null);assert.equal(shadowStep(s4,[],at+7*3_600_000)!.exit,"数据断了");
});
test("closesOf reads only closed bars from the given start",()=>{
  const rows:MidBar[]=[{time:0,open:1,high:1,low:1,close:1},{time:60,open:2,high:2,low:2,close:2}];
  const c=closesOf(()=>rows,["A"],60);assert.deepEqual([...c.get("A")!.entries()],[[60,2]]);
});
test("10-19 06:00 fixture with burstLeader on: the old fast-follow entries are recorded only (SPECIAL_ONLY), no other living trade opens",async()=>{
  const {runLiving}=await import("./living/living-sim.ts");const {bj}=await import("./living/fixture.ts");
  const r=runLiving({from:bj("10-19 05:56"),to:bj("10-19 06:08"),stepMs:4000,mode:"paper-enabled"});
  const lv=[...r.state.positions,...r.state.history].filter(t=>t.entryContext?.living&&!t.entryContext.living.bh);
  assert.equal(lv.length,0,"no non-burst living trade");
  assert.ok(r.engine.log.some(x=>x.k==="RECORD_ONLY"&&/只在全市场突然爆发时开单/.test(String(x.reason))),"recorded instead");
  assert.ok([...r.engine.runlog.cases.values()].some(c=>c.stages.some(s=>s.layer==="SPECIAL_ONLY")),"a SPECIAL_ONLY case");
});
test("realtime pool only (dynamic-v1.5): burst picks without a streamed Gate quote are shadow trades and NOT_LIVE gate records, never orders",()=>{
  const gate={ok:true,risk:.0025,conf:.5,why:"预测：概率 70%"},dyn={ready:true,gates:{[LEADER.pb]:gate},signals:[],exits:[],state:null};
  const all=engineRun({},dyn);const picked=[...new Set(all.out.flatMap(x=>x.dir?.orders??[]).map(o=>o.symbol))];assert.ok(picked.length>=1);
  const r=engineRun({},dyn,new Set(picked));
  assert.ok(!r.out.flatMap(x=>x.dir?.orders??[]).some(o=>picked.includes(o.symbol)),"no order on a coin without a live quote");
  const nl=r.e.runlog.poolRecent.filter(x=>x.t==="GATE"&&x.kind==="burst"&&x.decision==="NOT_LIVE");
  assert.ok(nl.length>=1&&nl.every(x=>picked.includes(String(x.sym))&&x.ok===false&&/不在实时报价币池，只记录/.test(String(x.why))),JSON.stringify(nl));
  assert.ok(r.e.burstShadowOpen().some(x=>picked.includes(x.sym)),"still followed as a shadow trade (the predictor keeps learning)");
});
