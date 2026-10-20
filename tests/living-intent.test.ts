/** Living v2 intent: capital × human-nature reads, market read, hold/exit, fast-lane flow gate, FlowBook, hub flow peek. */
import test from "node:test";
import assert from "node:assert/strict";
import {readCoin,readMarket,holdCheck,burstFlow,marketAllows,sizeModulator,type CoinFeatures,type CoinIntent} from "../lib/living/intent.ts";
import {FlowBook} from "../lib/living/flow.ts";
import {bytesOf} from "../lib/living/util.ts";
import {LIVING_MAX_VALUE_BYTES} from "../lib/living/config.ts";
import {MarketDataHub} from "../lib/market-data-hub.ts";
import {runFast} from "./living/fast-sim.ts";
import {bj} from "./living/fixture.ts";

const NOW=1_790_000_000_000;
const F=(o:Partial<CoinFeatures>={}):CoinFeatures=>({p5:0,p15:0,p60:0,p240:0,z15:0,z60:0,ext:0,oi5:0,oi15:0,oi60:0,funding:.0001,dFunding60:0,basis:null,
  taker5:0,taker15:0,vol5:1,vol15:1,vol60:1,imbalance:0,rangePos:.5,rangeHi:110,rangeLo:90,stallMin:0,last:100,atr5:.5,...o});
const read=(o:Partial<CoinFeatures>,recent:CoinIntent[]=[])=>readCoin("X_USDT",F(o),NOW,recent);

test("capital: price × OI quadrant (new longs, new shorts, short squeeze, long flush, drift, unverified)",()=>{
  assert.equal(read({p15:.01,z15:2.5,oi15:.01}).capital,"DEMAND");
  assert.equal(read({p15:-.01,z15:-2.5,oi15:.01}).capital,"SUPPLY");
  assert.equal(read({p15:.01,z15:2.5,oi15:-.01}).capital,"SQUEEZE_UP");
  assert.equal(read({p15:-.01,z15:-2.5,oi15:-.01}).capital,"FLUSH_DOWN");
  assert.equal(read({p15:.01,z15:2.5,oi15:.001}).capital,"DRIFT");
  assert.equal(read({p15:.01,z15:2.5,oi15:null}).capital,"UNVERIFIED");
  assert.equal(read({p15:.002,z15:2.5,oi15:.01}).capital,"NONE","a 0.2% move is not a move");
});
test("emotion: conviction → follow; FOMO is not chased; panic is not sold into",()=>{
  const c=read({p15:.01,z15:2.5,oi15:.01});assert.equal(c.emotion,"CONVICTION");assert.deepEqual([c.action?.pb,c.action?.side],["follow","LONG"]);
  const s=read({p15:-.01,z15:-2.5,oi15:.01});assert.equal(s.emotion,"CONVICTION");assert.equal(s.action?.side,"SHORT");
  const fomo=read({p15:.01,z15:2.5,oi15:.01,z60:3,funding:.0005});assert.equal(fomo.emotion,"FOMO");assert.equal(fomo.action,null);
  const panic=read({p15:-.01,z15:-2.5,oi15:-.01,vol5:2.5});assert.equal(panic.emotion,"PANIC");assert.equal(panic.actor,"LONG");assert.equal(panic.action,null);
  const squeeze=read({p15:.01,z15:2.5,oi15:-.01,vol5:2.5});assert.equal(squeeze.emotion,"PANIC");assert.equal(squeeze.actor,"SHORT");
});
test("capitulation / exhaustion need a real 1h leg with OI out, and a fresh stop",()=>{
  const cap={p60:-.025,z60:-3,oi60:-.03,stallMin:8,oi5:0,taker5:.2,taker15:-.1,p5:.001};
  const c=read(cap);assert.equal(c.emotion,"CAPITULATION");assert.deepEqual([c.action?.pb,c.action?.side],["flush-rebound","LONG"]);
  const panicked=read({p15:-.01,z15:-2.5,oi15:-.01,vol5:2.5});
  assert.notEqual(read({...cap,p60:-.004,z60:-1},[panicked]).emotion,"CAPITULATION","a 0.4% hour is not a panic leg, even after a panic read");
  assert.notEqual(read({...cap,stallMin:45}).emotion,"CAPITULATION","45 minutes after the low is old news");
  assert.notEqual(read({...cap,oi60:.01}).emotion,"CAPITULATION","OI grew: nobody was forced out");
  const ex=read({p60:.025,z60:3,oi60:-.03,stallMin:8,oi5:0,taker5:-.2,taker15:.1,p5:-.001});
  assert.equal(ex.emotion,"EXHAUSTION");assert.deepEqual([ex.action?.pb,ex.action?.side],["squeeze-fade","SHORT"]);
});
test("blowoff, complacency (+ range break) and absorption at range edges",()=>{
  const b=read({z60:3,funding:.0005,oi60:.03,stallMin:6,taker5:-.1});assert.equal(b.emotion,"BLOWOFF");assert.deepEqual([b.action?.pb,b.action?.side],["crowd-fade","SHORT"]);
  const comp=read({funding:.0005,oi60:.03,z60:.5,vol60:1});assert.equal(comp.emotion,"COMPLACENCY");assert.equal(comp.action,null,"inside the range: wait");
  const broke=read({funding:.0005,oi60:.03,z60:.5,vol60:1,last:89.9,p15:-.002});assert.deepEqual([broke.action?.pb,broke.action?.side],["crowd-break","SHORT"]);
  const ab=read({z15:.3,p15:.0005,vol15:2.5,taker15:-.4,rangePos:.1});assert.equal(ab.capital,"ABSORB_BID");assert.deepEqual([ab.action?.pb,ab.action?.side],["absorb-revert","LONG"]);
  const aa=read({z15:.3,p15:.0005,vol15:2.5,taker15:.4,rangePos:.9});assert.equal(aa.capital,"ABSORB_ASK");assert.equal(aa.action?.side,"SHORT");
  assert.equal(read({z15:.3,p15:.0005,vol15:2.5,taker15:.4,rangePos:.5}).action,null,"absorption mid-range is not traded");
});
const coins=(n:number,o:Partial<CoinFeatures>)=>Array.from({length:n},(_,i)=>readCoin(`C${i}_USDT`,F(o),NOW));
test("market read: warming without OI, risk-on with real new longs, panic blocks entries, capitulation follows panic",()=>{
  assert.equal(readMarket(coins(30,{oi15:null,oi60:null,p15:.004}),null,null,NOW).state,"WARMING");
  const on=readMarket(coins(30,{p15:.006,z15:2.5,oi15:.01,p60:.006}),null,null,NOW);assert.equal(on.state,"RISK_ON");
  assert.ok(marketAllows(on,"follow","LONG").ok);assert.ok(!marketAllows(on,"follow","SHORT").ok);
  const panic=readMarket(coins(30,{p15:-.01,z15:-2.5,oi15:-.01,vol5:2.5}),null,null,NOW);assert.equal(panic.state,"PANIC");
  assert.ok(!marketAllows(panic,"flush-rebound","LONG").ok);
  const after=readMarket(coins(30,{p60:-.025,z60:-3,oi60:-.03,stallMin:8,taker5:.2,taker15:-.1,p5:.001,p15:-.001}),null,null,NOW+10*60_000,[panic]);
  assert.equal(after.state,"CAPITULATION");assert.ok(marketAllows(after,"flush-rebound","LONG").ok);
  assert.equal(readMarket(coins(30,{p15:.0005,p60:.001}),null,null,NOW).state,"CALM");
});
test("rolling probe stats only modulate size (0.7–1.2x), never gate",()=>{
  assert.equal(sizeModulator(undefined),1);assert.equal(sizeModulator({n:3,t:-5,score:-1}),1,"few samples = neutral, not blocked");
  assert.equal(sizeModulator({n:40,t:3,score:.01}),1.2);assert.equal(sizeModulator({n:40,t:-2,score:-.01}),.7);
});
test("hold / exit: market flips → exit a loser, lock a winner; reason gone; timeout",()=>{
  const base={pb:"follow" as const,side:"LONG" as const,entry:100,stop:99,ageMin:10,holdMin:60,cost:.001};
  const off=readMarket(coins(30,{p15:-.006,z15:-2.5,oi15:.01,p60:-.006}),null,null,NOW);assert.equal(off.state,"RISK_OFF");
  const coin=read({p15:.004,z15:1,oi15:.004});
  assert.equal(holdCheck({...base,price:99.8,coin,market:off}).code,"LIVING_INTENT_MARKET_FLIP");
  const g=holdCheck({...base,price:101,coin,market:off});assert.equal(g.act,"GUARD");assert.ok(g.stop!>99&&g.stop!<101);
  assert.equal(holdCheck({...base,price:100.1,coin:read({p15:-.01,z15:-2.5,oi15:.01}),market:null}).code,"LIVING_INTENT_GONE");
  assert.equal(holdCheck({...base,price:100.1,coin,market:null}).act,"HOLD");
  assert.equal(holdCheck({...base,price:100.1,coin,market:null,ageMin:95}).code,"LIVING_THESIS_TIMEOUT");
  assert.equal(holdCheck({...base,pb:"absorb-revert",price:100.5,coin:read({rangePos:.6}),market:null}).code,"LIVING_INTENT_DONE");
});
test("FlowBook: OI change across sources, volume from turnover deltas, aggressor needs samples, pages ≤ 96KB",()=>{
  const fb=new FlowBook(),t0=Math.floor(NOW/60_000)*60_000-30*60_000;
  for(let m=0;m<=30;m++){const at=t0+m*60_000;
    fb.feed([{symbol:"A_USDT",at,src:"B",oi:1000*(1+.001*m),funding:.0001,taker:.4},{symbol:"A_USDT",at,src:"G",oi:500*(1+.001*m)}],at);}
  const oi15=fb.oiChange("A_USDT",NOW,15)!;assert.ok(Math.abs(oi15-.015/1.015)<.002,String(oi15));
  assert.ok(fb.taker("A_USDT",NOW,5)!>.3);assert.equal(fb.taker("B_USDT",NOW,5),null);
  const v=new FlowBook();v.volFromTurnover("V_USDT",t0,1_440_000);
  let tv=1_440_000;
  for(let m=1;m<=30;m++){const at=t0+m*60_000;tv+=m>25?3000:0;const inc=v.volFromTurnover("V_USDT",at,tv);if(inc!=null)v.feed([{symbol:"V_USDT",at,src:"B",volUsd:inc}],at);
    if(m===20)assert.ok(Math.abs(v.volRatio("V_USDT",at+59_000,5)!-1)<.05,"steady turnover = normal pace");}
  const r=v.volRatio("V_USDT",t0+30*60_000+59_000,5)!;assert.ok(r>1.5,`volume surge visible (${r})`);
  const big=new FlowBook(),syms=Array.from({length:90},(_,i)=>`S${i}_USDT`);
  for(let m=0;m<180;m++){const at=NOW-(180-m)*60_000;big.feed(syms.map(s=>({symbol:s,at,src:"B" as const,oi:1e6+m,funding:.0001,basis:.0002,taker:.1,volUsd:12345})),at);}
  const pages=big.pages(syms);assert.ok(Object.keys(pages).length<=3);
  for(const [k,val] of Object.entries(pages))assert.ok(bytesOf(val)<=LIVING_MAX_VALUE_BYTES,`${k} ${bytesOf(val)}`);
  const back=new FlowBook();back.restore(Object.values(pages));assert.ok(back.oiChange("S1_USDT",NOW,15)!=null);
});
test("fast-lane flow check: price-only bursts are THIN, new positions real, unknown when no data",()=>{
  const fb=new FlowBook(),mem=Array.from({length:12},(_,i)=>`M${i}_USDT`);
  assert.equal(burstFlow(fb,mem,"LONG",NOW).real,null);
  for(const s of mem)fb.setBaseline(s,1000);
  for(let m=0;m<=10;m++){const at=NOW-(10-m)*60_000;fb.feed(mem.map(s=>({symbol:s,at,src:"B" as const,oi:1000,volUsd:1000,taker:0})),at);}
  assert.equal(burstFlow(fb,mem,"LONG",NOW).kind,"THIN");
  const hot=new FlowBook();for(const s of mem)hot.setBaseline(s,1000);
  for(let m=0;m<=10;m++){const at=NOW-(10-m)*60_000;hot.feed(mem.map(s=>({symbol:s,at,src:"B" as const,oi:1000*(1+(m>=7?.002*(m-6):0)),volUsd:m>=8?3000:1000,taker:m>=8?.4:0})),at);}
  const b=burstFlow(hot,mem,"LONG",NOW);assert.equal(b.real,true);assert.equal(b.kind,"NEW_POSITIONS");
});
test("hub peekFlow reads the Bybit payload already received (OI, funding, basis) without a fetch and without touching quoteHistory",async()=>{
  const prior=globalThis.fetch;let calls=0;
  globalThis.fetch=(async(input:unknown)=>{calls++;const url=String(input);
    if(url.includes("api.bybit.com"))return Response.json({retCode:0,result:{list:Array.from({length:20},(_,i)=>({symbol:i===0?"BTCUSDT":`X${i}USDT`,
      lastPrice:"100",bid1Price:"99.9",ask1Price:"100.1",bid1Size:"5",ask1Size:"5",turnover24h:"1000000",price24hPcnt:"0.01",
      openInterest:String(1000+i),fundingRate:"0.0001",markPrice:"100.05",indexPrice:"100"}))}});
    throw new DOMException("timeout","TimeoutError");}) as typeof fetch;
  try{
    const hub=new MarketDataHub();await hub.refresh(1_000_000);const n=calls;
    const hist=(hub as unknown as {quoteHistory:Map<string,unknown>}).quoteHistory,before=JSON.stringify([...hist.keys()]);
    const rows=hub.peekFlow(["BTC_USDT","NOPE_USDT"],1_000_500);
    assert.equal(calls,n,"no request");assert.equal(JSON.stringify([...hist.keys()]),before);
    assert.equal(rows.length,1);assert.equal(rows[0]!.oi,1000);assert.equal(rows[0]!.funding,.0001);assert.ok(Math.abs(rows[0]!.basis!-.0005)<1e-9);
  }finally{globalThis.fetch=prior;}
});
test("fast lane: a burst with no money behind it raises SURGE (no episode, protections only); real flow still alerts and confirms",()=>{
  const thin=()=>({real:false,kind:"THIN",why:"价格齐动但资金没跟",vol:1,taker:0,oi:0});
  const r=runFast({from:bj("10-19 21:50"),to:bj("10-19 22:10"),flow:thin});
  const surge=r.events.filter(e=>e.type==="SURGE"),alert=r.events.find(e=>e.type==="ALERT");
  assert.ok(surge.length>=1,"surge recorded");
  if(alert)assert.equal(alert.detail.flow,"PRICE_ONLY_STRONG","only an extreme burst may still alert, flagged price-only");
  assert.ok(!r.events.some(e=>e.type==="CONFIRM"),"never confirmed without money");
  const real=()=>({real:true,kind:"NEW_POSITIONS",why:"新开仓推动",vol:3,taker:.3,oi:.004});
  const ok=runFast({from:bj("10-19 21:50"),to:bj("10-19 22:10"),flow:real});
  assert.ok(ok.events.some(e=>e.type==="ALERT"&&e.detail.flow==="NEW_POSITIONS"));assert.ok(ok.events.some(e=>e.type==="CONFIRM"));
  assert.ok(!ok.events.some(e=>e.type==="SURGE"));
});
test("warm restart: 1m bars, flow and market history are saved in own keys (≤96KB) and the market read resumes in ~1 minute",async()=>{
  const {LivingEngine,LIVING_KEYS}=await import("../lib/living/engine.ts");
  const {defaultLivingConfig}=await import("../lib/living/config.ts");
  const t0=Math.floor(NOW/60_000)*60_000-3*3_600_000,syms=Array.from({length:60},(_,i)=>`W${i}_USDT`);
  const store=new Map<string,unknown>();let indexWrites=0;
  const cfg={...defaultLivingConfig(t0),mode:"compute-only" as const};
  const mk=(at:number,vals:Map<string,unknown>)=>{const e=new LivingEngine(at);e.restore(vals,at);return e;};
  const feed=(e:InstanceType<typeof LivingEngine>,at:number)=>{
    const pts=syms.map((s,i)=>({symbol:s,mid:100+i+Math.sin(at/7e5+i)*2,at,volume24hUsd:5e8-i*1e6,sources:3,spread:.0002}));
    e.onHub([...pts,{symbol:"BTC_USDT",mid:60000+Math.sin(at/7e5)*300,at,volume24hUsd:5e9,sources:3},{symbol:"ETH_USDT",mid:3000+Math.sin(at/7e5)*20,at,volume24hUsd:3e9,sources:3}],at,()=>true,
      syms.map((s,i)=>({symbol:s,at,oi:1e6*(1+.0001*((at-t0)/60_000))+i,funding:.0001,basis:.0002,taker:.05,turnover:null})));
  };
  let e=mk(t0,new Map([[LIVING_KEYS.config,cfg]]));
  const end=t0+2*3_600_000;
  for(let at=t0;at<end;at+=10_000){feed(e,at);const w=e.writes(at);const keys=Object.keys(w);
    for(const k of keys){store.set(k,w[k]);if(k===LIVING_KEYS.logIndex)indexWrites++;}if(keys.length)e.committed(keys,at);}
  assert.ok(e.marketIntent&&e.marketIntent.state!=="WARMING",`warmed before restart (${e.marketIntent?.state})`);
  for(const [k,v] of store){assert.ok(k.startsWith("living:v1:"),k);assert.ok(bytesOf(v)<=LIVING_MAX_VALUE_BYTES,`${k} ${bytesOf(v)}`);}
  assert.ok([...store.keys()].some(k=>k.startsWith("living:v1:bars1m:")),"1m pages saved");assert.ok(store.has(LIVING_KEYS.intent),"market history saved");
  assert.ok(indexWrites<10,`log index only rewritten when the page set changes (${indexWrites})`);
  // restart after 60s: fresh engine from the saved keys only
  const back=end+60_000,vals=new Map<string,unknown>();for(const k of LivingEngine.loadKeys())if(store.has(k))vals.set(k,store.get(k));
  e=mk(back,vals);
  assert.ok(e.status(back).market,"the last read is shown (marked restored) until the first fresh read");
  assert.equal(e.status(back).market!.restored,true);
  let readyAt:number|null=null;
  for(let at=back;at<back+20*60_000;at+=10_000){feed(e,at);if(readyAt==null&&e.marketIntent&&e.marketIntent.state!=="WARMING")readyAt=at;}
  assert.ok(readyAt!=null&&readyAt-back<=2*60_000,`market read resumed after ${readyAt==null?"never":(readyAt-back)/1000+"s"}`);
});
