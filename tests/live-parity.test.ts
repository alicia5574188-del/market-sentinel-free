import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LIVE_PARITY_PREFIX, LIVE_PARITY_VERSION, forwardMirrorSources, buildProportionalMirror,
  mirrorCoverage, sourceLifecycle, type MirrorBinding } from "../lib/live-parity.ts";
import { initialForward, type Trade, type ForwardState } from "../lib/forward-relations.ts";
import { gateMarkedEquity, liveEntryDisposition, liveExitTag, type GateLiveAccount, type GateLiveOrder, type LiveEntryIntent, type LiveStopIntent } from "../lib/gate-live.ts";
import { prepareForwardWrite } from "../lib/forward-store.ts";
import { readFileSync } from "node:fs";
register("./worker-test-loader.mjs",import.meta.url);
const {MarketStream,default:worker}=await import("../worker/index-clean.ts");
const T=1_789_612_000_000;
function trade(id="ft-fixture-1",symbol="BTC_USDT",side:"LONG"|"SHORT"="LONG"):Trade {
  return {id,symbol,side,openedAt:T-60_000,closedAt:null,status:"OPEN",entryPrice:100,exitPrice:null,
    quantity:2,contracts:2000,quantoMultiplier:.001,notional:200,leverage:2,margin:100,
    plannedRisk:2.4,stopPrice:side==="LONG"?99:101,armPrice:side==="LONG"?100.5:99.5,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.14,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:T-60_000,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    rule:{id:"fr-fixture-1",signature:"s",parentId:null,version:7,createdAt:T-120_000,expiresAt:T+3600000,
      status:"EXPERIMENTAL",conditions:[{feature:0,op:"GE",threshold:.1}],side,horizon:60,stopRate:.01,
      armRate:.005,givebackRate:.002,exitMode:"REACTION_DECAY",samples:20,trainGroups:3,checkGroups:2,
      estimatedNetRate:.002,priorResponse:.005,recentResponse:.004,standardError:.001,
      reason:"Synthetic functional source, never a trading result",mutation:"CREATE",grammar:"fixture",liveEligible:false}};
}
function request(t=trade()){return {source:t,sourceEquity:1000,equity:100,available:100,entryPrice:100,
  quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,
  openNotional:0,now:T,policy:"any-current-or-future-policy"};}

test("source identity and ALL strategy/order fields are retained without netting",()=>{
  const s=initialForward(T-100000);s.positions=[trade(),trade("ft-2","SOL_USDT","SHORT")];
  const a=forwardMirrorSources(s,1000);assert.equal(Object.keys(a).length,2);
  for(const t of s.positions){assert.equal(a[t.symbol].id,t.id);assert.deepEqual(a[t.symbol].forwardSource,t);
    assert.equal(a[t.symbol].activeStopPrice,t.stopPrice);assert.equal(a[t.symbol].targetPrice,t.armPrice);}
});
test("a future same-symbol multi-leg source cannot silently become a single net position",()=>{
  const s=initialForward(T);s.positions=[trade(),trade("ft-2")];assert.throws(()=>forwardMirrorSources(s,1000),/净额/);
});
test("source missing or malformed cannot fall back to the retired canonical account",()=>{
  assert.throws(()=>forwardMirrorSources(null as unknown as ForwardState,1000));
  const s=initialForward(T);s.positions=[{...trade(),quantity:10}];assert.throws(()=>forwardMirrorSources(s,1000));
});
test("same leverage and proportional notional/margin are frozen in full-source binding",()=>{
  const t=trade(),r=buildProportionalMirror(request(t));assert.equal(r.intent.notional,20);assert.equal(r.intent.margin,10);
  assert.equal(r.intent.leverage,t.leverage);assert.equal(r.intent.contracts,200);assert.equal(r.binding.receipt.ratio,.1);
  assert.deepEqual(r.binding.sourceAtCopy,t);t.rule.reason="changed afterwards";assert.notEqual(r.binding.sourceAtCopy.rule.reason,t.rule.reason);
});
test("the PAPER arm price is not a hard target or a second economic admission model",()=>{
  const i=request();i.entryPrice=100.8;const r=buildProportionalMirror(i);assert.equal(r.intent.kind,"MARKET");
  assert.ok(r.intent.notional<=20);assert.equal(r.binding.receipt.sourceDeadline,i.source.openedAt+3600000);
});
test("round down within one lot, never enlarge a tiny account to one oversized contract",()=>{
  const i=request();i.equity=.001;i.available=.001;assert.throws(()=>buildProportionalMirror(i),/不足一张/);
  const j=request();j.equity=99.9;const r=buildProportionalMirror(j);assert.ok(r.binding.receipt.roundingNotional>=0);
  assert.ok(r.binding.receipt.roundingNotional<.1+1e-9);
});
test("margin or leverage failure is explicit, not silent new leverage or smaller-risk re-selection",()=>{
  const i=request();i.leverageMax=1;assert.throws(()=>buildProportionalMirror(i),/杠杆/);
  const j=request();j.available=1;assert.throws(()=>buildProportionalMirror(j),/不静默缩单/);
});
test("expired, future and already stopped source cannot be backdated into LIVE",()=>{
  const i=request();i.now=i.source.openedAt+3600000;assert.throws(()=>buildProportionalMirror(i),/过期/);
  i.now=i.source.openedAt-1;assert.throws(()=>buildProportionalMirror(i));
  i.now=T;i.entryPrice=98;assert.throws(()=>buildProportionalMirror(i),/止损/);
});
test("partial IOC is exposure even when finish_as says ioc",()=>{
  assert.equal(liveEntryDisposition({status:"finished",finish_as:"ioc",size:"200",left:"60"},"MARKET"),"FILLED");
  assert.equal(liveEntryDisposition({status:"finished",finish_as:"ioc",size:"200",left:"200"},"MARKET"),"CANCELLED");
});
test("unknown lifecycle is not a close decision",()=>{
  const s=initialForward(T);assert.equal(sourceLifecycle(s,"missing").status,"UNKNOWN");
});
test("owner OFF coverage does not report zero live positions as copied",()=>{
  const s=initialForward(T);s.positions=[trade()];
  const c=mirrorCoverage(s,{requestedEnabled:false,positions:{},entries:{},entrySkips:{}},null);
  assert.equal(c.sourceCount,1);assert.equal(c.copiedCount,0);assert.equal(c.rows[0].status,"OWNER_OFF");
});

class Memory {
  data=new Map<string,unknown>();writes=0;fail=false;alarm:number|null=null;
  async get<T>(key:string){return structuredClone(this.data.get(key)) as T|undefined;}
  async put(key:string|Record<string,unknown>,value?:unknown){
    if(this.fail)throw new Error("injected storage failure");
    for(const[k,v]of typeof key==="string"?[[key,value]]:Object.entries(key)){this.data.set(k as string,structuredClone(v));this.writes++;}
  }
  async transaction<T>(fn:(storage:Memory)=>Promise<T>){const old=new Map(this.data);try{return await fn(this);}catch(e){this.data=old;throw e;}}
  async list<T>(options:{prefix:string;reverse?:boolean;limit?:number}){
    let rows=[...this.data].filter(([k])=>k.startsWith(options.prefix)).sort(([a],[b])=>a.localeCompare(b));
    if(options.reverse)rows=rows.reverse();return new Map(rows.slice(0,options.limit??Infinity)) as Map<string,T>;
  }
  async getAlarm(){return this.alarm;}async setAlarm(value:number){this.alarm=value;}
}
class FakeGate {
  account:GateLiveAccount={total:100,available:100,unrealised_pnl:0,in_dual_mode:false};
  requestCount=0;placed:LiveEntryIntent[]=[];leverages:number[]=[];stops:GateLiveOrder[]=[];
  orders=new Map<string,GateLiveOrder>();holdings:Record<string,{contract:string;size:number;entry_price:number;leverage:number}>={};
  closeTags:string[]=[];onLeverage:(()=>Promise<void>)|null=null;onCreate:(()=>Promise<void>)|null=null;
  failSnapshot=false;partial=false;zero=false;ambiguous=false;omitExit=false;counter=1;
  async snapshot(){this.requestCount++;if(this.failSnapshot)throw new Error("injected Gate outage");
    return structuredClone({account:this.account,positions:Object.values(this.holdings),orders:[],priceOrders:this.stops,checkedAt:Date.now()});}
  async setLeverage(_symbol:string,n:number){this.leverages.push(n);await this.onLeverage?.();}
  async createEntry(i:LiveEntryIntent){await this.onCreate?.();this.placed.push(structuredClone(i));const id=String(this.counter++);
    if(this.ambiguous)throw new Error("injected submission timeout");
    const filled=this.zero?0:this.partial?Math.floor(i.contracts/2):i.contracts;
    this.orders.set(id,{id_string:id,contract:String(i.body.contract),text:i.tag,status:"finished",finish_as:filled===i.contracts?"filled":"ioc",size:i.size,left:(i.size>0?1:-1)*(i.contracts-filled),fill_price:100});
    if(filled)this.holdings[String(i.body.contract)]={contract:String(i.body.contract),size:Math.sign(i.size)*filled,entry_price:100,leverage:i.leverage};
    return id;
  }
  async inspectEntry(_kind:string,_symbol:string,tag:string,id:string|null){return structuredClone(this.orders.get(id??"")??[...this.orders.values()].find(o=>o.text===tag)??null);}
  async createStop(i:LiveStopIntent){const id=String(this.counter++);this.stops.push({id_string:id,text:i.tag,contract:String((i.body.initial as Record<string,unknown>).contract),status:"open"});return id;}
  async amendStop(){return;}
  async cancelOrder(_kind:string,id:string){this.stops=this.stops.filter(s=>s.id_string!==id);}
  async closePosition(symbol:string,tag:string){this.closeTags.push(tag);delete this.holdings[symbol];const id=String(this.counter++);
    if(!this.omitExit)this.orders.set(id,{id_string:id,text:tag,contract:symbol,status:"finished",finish_as:"filled",fill_price:100.4});return id;}
}
type Harness={runtime:{live:Record<string,unknown>;[key:string]:unknown};forwardState:ForwardState;liveClient:FakeGate;
  liveHistory:unknown[];forwardError:string|null;liveBindingError:string|null;
  syncLive(now:number,enable?:boolean,off?:boolean):Promise<void>;setLiveMode(v:boolean):Promise<{ok:boolean}>;
  saveCheckpoint(now:number,force?:boolean):Promise<void>;liveDesiredPortfolio(now:number):Record<string,unknown>};
type LiveTest={requestedEnabled:boolean;changedAt:number|null;operational:boolean;entries:Record<string,{planId:string;status:string;parity?:MirrorBinding["receipt"]}>;
  positions:Record<string,{id:string;status:string;entryPrice:number;exitPrice?:number;parity?:MirrorBinding["receipt"];exitReason?:string}>;entrySkips:Record<string,{reason:string}>};
function live(h:Harness){return h.runtime.live as unknown as LiveTest;}
async function harness(store=new Memory(),gate=new FakeGate()) {
  let ready:Promise<unknown>=Promise.resolve();
  const ctx={storage:store,blockConcurrencyWhile(fn:()=>Promise<unknown>){ready=fn();},waitUntil(){return;}};
  const env={OWNER_ACCESS_TOKEN:"test-only-owner-secret-never-live",DB:{prepare(){throw new Error("forbidden D1/network in harness");}}};
  const stream=new MarketStream(ctx as unknown as DurableObjectState,env as never);await ready;
  const h=stream as unknown as Harness;h.liveClient=gate;h.forwardState=initialForward(T-300000);
  h.forwardState.positions=[trade()];h.forwardState.storage={persistedAt:T,error:null};
  h.runtime.symbols=["BTC_USDT"];h.runtime.tickSize={BTC_USDT:.01};
  h.runtime.contractMeta={BTC_USDT:{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,fundingRate:0}};
  h.runtime.evidence={BTC_USDT:{midpoint:100,bestBid:100,bestAsk:100,observedAt:T,fresh:true,entryReady:true}};
  return {h,store,gate,stream};
}
async function clock<T>(fn:()=>Promise<T>){const old=Date.now,fetch=globalThis.fetch;Date.now=()=>T;
  globalThis.fetch=async()=>{throw new Error("REAL NETWORK FORBIDDEN IN LIVE TEST");};try{return await fn();}finally{Date.now=old;globalThis.fetch=fetch;}}

test("real Worker sync does not read credentials or submit any order while owner OFF",()=>clock(async()=>{
  const {h,gate}=await harness();await h.syncLive(T);assert.equal(gate.requestCount,0);assert.equal(gate.placed.length,0);assert.equal(live(h).requestedEnabled,false);
}));
test("real owner-enable path routes current source, freezes binding before submit and copies once",()=>clock(async()=>{
  const {h,gate,store}=await harness();gate.onCreate=async()=>{
    assert.ok(store.data.has(`${LIVE_PARITY_PREFIX}binding:ft-fixture-1`));
    assert.ok(store.data.has("checkpoint"));
  };
  const result=await h.setLiveMode(true);assert.equal(result.ok,true);assert.equal(gate.placed.length,1);
  await h.syncLive(T);await h.syncLive(T);assert.equal(gate.placed.length,1);
  const p=live(h).positions.BTC_USDT;assert.equal(p.id,"ft-fixture-1");assert.equal(p.parity!.sourceRuleId,"fr-fixture-1");
  assert.equal(gate.leverages[0],2);assert.ok(gate.stops.length>0);
}));
test("real Worker follows source CLOSE reason, not an independently restarted holding timer",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);
  const t=h.forwardState.positions[0];t.status="CLOSED";t.closedAt=T;t.exitReason="反应回吐：源单退出";
  h.forwardState.history=[t];h.forwardState.positions=[];
  await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.closeTags[0],liveExitTag(t.id));assert.equal(live(h).positions.BTC_USDT.status,"CLOSED");
  assert.equal(live(h).positions.BTC_USDT.exitReason,t.exitReason);assert.equal(live(h).positions.BTC_USDT.exitPrice,100.4);
}));
test("missing source is a recovery case, not evidence to close an otherwise protected real position",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);
  h.forwardState.positions=[];h.forwardState.history=[];await h.syncLive(T);assert.equal(gate.closeTags.length,0);
}));
test("arming or source rule re-synthesis does not prematurely close an existing real holding",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);
  h.forwardState.positions[0].favorable=.03;h.forwardState.rules=[];await h.syncLive(T);
  assert.equal(gate.closeTags.length,0);assert.equal(live(h).positions.BTC_USDT.status,"OPEN");
}));
test("owner OFF during leverage request prevents the already-staged market entry",()=>clock(async()=>{
  const {h,gate}=await harness();let off:Promise<unknown>|undefined;
  gate.onLeverage=async()=>{off=h.setLiveMode(false);};await h.setLiveMode(true);await off;
  assert.equal(gate.placed.length,0);assert.equal(live(h).requestedEnabled,false);
}));
test("source closure during leverage request cancels the stale entry without opening",()=>clock(async()=>{
  const {h,gate}=await harness();gate.onLeverage=async()=>{h.forwardState.positions=[];};await h.setLiveMode(true);
  assert.equal(gate.placed.length,0);
}));
test("temporary Gate faults never rewrite owner switch intent",()=>clock(async()=>{
  const {h,gate}=await harness();gate.failSnapshot=true;const r=await h.setLiveMode(true);
  assert.equal(r.ok,false);assert.equal(live(h).requestedEnabled,true);assert.equal(live(h).operational,false);
}));
test("storage failure prevents private entry calls and successful copies",()=>clock(async()=>{
  const {h,gate,store}=await harness();store.fail=true;const r=await h.setLiveMode(true);
  assert.equal(r.ok,false);assert.equal(gate.placed.length,0);
}));
test("partial execution is adopted and shown as a deviation, not repeated as a full new entry",()=>clock(async()=>{
  const {h,gate}=await harness();gate.partial=true;await h.setLiveMode(true);await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.match(live(h).positions.BTC_USDT.parity!.discrepancy!,/实际/);
}));
test("zero-fill IOC cannot produce a fictitious filled position",()=>clock(async()=>{
  const {h,gate}=await harness();gate.zero=true;await h.setLiveMode(true);await h.syncLive(T);
  assert.equal(Object.keys(live(h).positions).length,0);assert.equal(gate.stops.length,0);assert.equal(gate.placed.length,1);
}));
test("ambiguous submission reserves identity and is not retried into a duplicate",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await h.setLiveMode(true);await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.equal(live(h).entries.BTC_USDT.status,"ERROR");
}));
test("missing exchange exit response is not replaced by source/midpoint price",()=>clock(async()=>{
  const {h,gate}=await harness();gate.omitExit=true;await h.setLiveMode(true);await h.syncLive(T);
  const t=h.forwardState.positions[0];t.status="CLOSED";t.closedAt=T;t.exitReason="期限到达";h.forwardState.history=[t];h.forwardState.positions=[];
  await h.syncLive(T);await h.syncLive(T);assert.equal(live(h).positions.BTC_USDT.exitPrice,undefined);
}));
test("restart restores source binding and later owner OFF instead of replaying old ON checkpoint",()=>clock(async()=>{
  const {h,store,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);await h.saveCheckpoint(T,true);
  const fp=await prepareForwardWrite(null,h.forwardState,T);await store.put(fp.entries);
  await store.put(`${LIVE_PARITY_PREFIX}owner-intent`,{enabled:false,changedAt:T+1});
  const {h:r}=await harness(store,gate);assert.equal(live(r).requestedEnabled,false);
  assert.equal(live(r).positions.BTC_USDT.parity!.sourceId,"ft-fixture-1");await r.syncLive(T);assert.equal(gate.placed.length,1);
}));
test("archived real records survive the next same-symbol parent and source details are owner-only",()=>clock(async()=>{
  const {h,stream,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);
  const t=h.forwardState.positions[0];t.status="CLOSED";t.closedAt=T;t.exitReason="源单完成";h.forwardState.history=[t];h.forwardState.positions=[];
  await h.syncLive(T);await h.syncLive(T);assert.equal(h.liveHistory.length,1);
  h.forwardState.positions=[trade("ft-fixture-2")];await h.syncLive(T);assert.equal(gate.placed.length,2);assert.equal(h.liveHistory.length,1);
  const detail=await stream.fetch(new Request(`https://internal/owner-live-source?id=${t.id}`));assert.equal(detail.status,200);
  const unauthorized=await worker.fetch(new Request(`https://host/api/live/source?id=${t.id}`),{} as never,{} as never);
  assert.equal(unauthorized.status,401);
}));
test("mandatory release contract remains a current-PAPER route, not a retired strategy fallback",()=>{
  const src=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(src,/desiredPortfolio\s*=\s*this\.liveDesiredPortfolio/);assert.match(src,/buildProportionalMirror/);
  assert.match(src,/sourceLifecycle/);assert.match(src,/live-parity:v1:|LIVE_PARITY_PREFIX/);
  assert.equal((src.match(/this\.runtime\.live\.requestedEnabled = /g)??[]).length,1,"only owner setter may write switch");
  assert.match(src,/if\(!trade\.forwardSource\)continue/);
  assert.equal(LIVE_PARITY_VERSION,"current-paper-live-parity-v1");
});
test("Gate marked equity includes unrealized PnL rather than using wallet cash as PAPER equity",async()=>{
  const g=new FakeGate();g.account.unrealised_pnl="12.5";assert.equal(gateMarkedEquity(await g.snapshot()),112.5);
  g.account.unrealised_pnl="-20";assert.equal(gateMarkedEquity(await g.snapshot()),80);
});
test("missing position valuation and unsupported unified collateral are not guessed",async()=>{
  const g=new FakeGate();delete g.account.unrealised_pnl;
  g.holdings.BTC_USDT={contract:"BTC_USDT",size:1,entry_price:100,leverage:2};
  const snapshot=await g.snapshot();assert.throws(()=>gateMarkedEquity(snapshot),/浮盈/);
});
test("duplicate-source coverage fails visibly instead of claiming an exact connected mirror",()=>{
  const s=initialForward(T);s.positions=[trade(),trade("duplicate")];
  const c=mirrorCoverage(s,{requestedEnabled:false,positions:{},entries:{},entrySkips:{}},null);
  assert.equal(c.connected,false);assert.equal(c.instructionParity,false);assert.match(c.error!,/净额/);
});
test("owner OFF still protects a mapped actual holding when forward source recovery fails",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);
  h.forwardState=null as unknown as ForwardState;h.forwardError="injected source recovery";
  const r=await h.setLiveMode(false);assert.equal(r.ok,true);assert.equal(live(h).requestedEnabled,false);
  assert.equal(gate.closeTags.length,0);assert.ok(gate.stops.length>0);assert.equal(gate.placed.length,1);
}));
test("OFF does not abandon a delayed already-filled entry older than one minute",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);
  const entry=live(h).entries.BTC_USDT as unknown as {createdAt:number;status:string};entry.createdAt=T-120000;
  assert.equal(Object.keys(live(h).positions).length,0);
  await h.setLiveMode(false);assert.equal(live(h).positions.BTC_USDT.status,"OPEN");assert.ok(gate.stops.length>0);
}));
test("known price crossing original stop during leverage await cannot open then immediately close",()=>clock(async()=>{
  const {h,gate}=await harness();gate.onLeverage=async()=>{h.runtime.evidence={BTC_USDT:{midpoint:98,bestBid:98,bestAsk:98,observedAt:T,fresh:true,entryReady:true}};};
  await h.setLiveMode(true);assert.equal(gate.placed.length,0);assert.match(live(h).entries.BTC_USDT.status,/CANCELLED/);
}));
test("unified collateral rejection does not change owner intent or remove native protection",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);await h.syncLive(T);gate.account.margin_mode=2;
  await assert.rejects(()=>h.syncLive(T),/统一保证金/);assert.equal(live(h).requestedEnabled,true);assert.ok(gate.stops.length>0);
}));
test("closed source is durably retained beyond the rolling PAPER history",()=>clock(async()=>{
  const {h,gate,store}=await harness();await h.setLiveMode(true);await h.syncLive(T);
  const later=T+3600000;h.runtime.evidence={BTC_USDT:{midpoint:100,bestBid:100,bestAsk:100,observedAt:later,fresh:true,entryReady:true}};
  await (h as unknown as {advanceForwardNow(n:number):Promise<void>}).advanceForwardNow(later);
  const key=`${LIVE_PARITY_PREFIX}source-close:ft-fixture-1`;
  assert.equal((store.data.get(key) as Trade).status,"CLOSED");
  h.forwardState.history=[];
  const saved=await prepareForwardWrite(null,h.forwardState,later);await store.put(saved.entries);await h.saveCheckpoint(later,true);
  const restored=await harness(store,gate);restored.h.forwardState.history=[];restored.h.forwardState.positions=[];
  await restored.h.syncLive(T);assert.equal(gate.closeTags.length,1);
}));

test("all current source orders copy across bounded passes without the retired two-position cap",()=>clock(async()=>{
  const {h,gate}=await harness();const symbols=["BTC_USDT","ETH_USDT","SOL_USDT","DOGE_USDT"];
  h.forwardState.positions=symbols.map((symbol,i)=>trade(`ft-many-${i}`,symbol,i%2?"SHORT":"LONG"));
  h.runtime.contractMeta=Object.fromEntries(symbols.map(symbol=>[symbol,{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,fundingRate:0}]));
  h.runtime.evidence=Object.fromEntries(symbols.map(symbol=>[symbol,{midpoint:100,bestBid:100,bestAsk:100,observedAt:T,fresh:true,entryReady:true}]));
  await h.setLiveMode(true);await h.syncLive(T);await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,4);assert.equal(Object.keys(live(h).positions).length,4);
  assert.deepEqual(Object.values(live(h).positions).map(p=>p.id).sort(),h.forwardState.positions.map(p=>p.id).sort());
  for(const p of Object.values(live(h).positions))assert.ok(p.parity!.ratio>0);
}));
test("ambiguous market submission cannot be replayed after the old six-second and minute timers",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await h.setLiveMode(true);
  const realNow=Date.now;Date.now=()=>T+120000;
  try {
    h.runtime.evidence={BTC_USDT:{midpoint:100,bestBid:100,bestAsk:100,observedAt:Date.now(),fresh:true,entryReady:true}};
    await h.syncLive(Date.now());await h.syncLive(Date.now());
    assert.equal(gate.placed.length,1);assert.equal(live(h).entries.BTC_USDT.status,"CANCELLED");
  }finally{Date.now=realNow;}
}));
test("new arbitrary rule metadata survives the adapter and immutable source binding",()=>{
  const t={...trade(),extra:{customExitCondition:"new schema field",sourceReason:[1,2,3]}};
  const r=buildProportionalMirror(request(t));assert.deepEqual(r.binding.sourceAtCopy,t);
});
test("the permanent contract and parity suite cannot be omitted by the default release workflow",()=>{
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  const ci=readFileSync(new URL("../.github/workflows/sentinel-v2-ci.yml",import.meta.url),"utf8");
  assert.ok(pkg.scripts.test.includes("test:live-parity"));assert.ok(pkg.scripts["test:direct"].includes("live-parity.test.ts"));
  assert.match(ci,/run: npm run test:live-parity/);assert.equal((ci.match(/liveMirror.source == "CURRENT_FORWARD_ACCOUNT"/g)??[]).length,2);
  assert.match(readFileSync(new URL("../AGENTS.md",import.meta.url),"utf8"),/LIVE_MIRROR_CONTRACT.md/);
});

test("owner OFF continues reconciling an uncertain submission until a late verified fill is protected and source-closed",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await h.setLiveMode(true);await h.setLiveMode(false);
  const scheduler=h as unknown as {liveNeedsSync():boolean};assert.equal(scheduler.liveNeedsSync(),true);
  assert.match(readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8"),/const liveNeedsSync = this.liveNeedsSync\(\)/);
  const original=Date.now;Date.now=()=>T+120000;
  try{
    const intent=gate.placed[0];
    gate.orders.set("late",{id_string:"late",contract:"BTC_USDT",text:intent.tag,status:"finished",finish_as:"filled",size:intent.size,left:0,fill_price:100});
    gate.holdings.BTC_USDT={contract:"BTC_USDT",size:intent.contracts,entry_price:100,leverage:intent.leverage};
    const t=h.forwardState.positions[0];t.status="CLOSED";t.closedAt=T+90000;t.exitReason="delayed source closure";
    h.forwardState.history=[t];h.forwardState.positions=[];
    await h.syncLive(Date.now());await h.syncLive(Date.now());
    assert.equal(live(h).requestedEnabled,false);assert.equal(gate.placed.length,1);
    assert.equal(gate.closeTags.length,1);assert.equal(live(h).positions.BTC_USDT.id,t.id);
    assert.equal(live(h).positions.BTC_USDT.status,"CLOSED");
    assert.equal(scheduler.liveNeedsSync(),false);
  }finally{Date.now=original;}
}));
test("an unconfirmed old parent cannot be overwritten by a new same-coin source after a minute",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await h.setLiveMode(true);
  const original=Date.now;Date.now=()=>T+120000;
  try{
    await h.syncLive(Date.now());h.forwardState.positions=[trade("replacement-parent")];
    h.runtime.evidence={BTC_USDT:{midpoint:100,bestBid:100,bestAsk:100,observedAt:Date.now(),fresh:true,entryReady:true}};
    await h.syncLive(Date.now());
    assert.equal(gate.placed.length,1);assert.equal(live(h).entries.BTC_USDT.planId,"ft-fixture-1");
    assert.equal(live(h).operational,false);
  }finally{Date.now=original;}
}));
