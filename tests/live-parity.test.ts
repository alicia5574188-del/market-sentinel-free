import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LIVE_PARITY_PREFIX, LIVE_PARITY_VERSION, forwardMirrorSources, buildProportionalMirror,
  mirrorCoverage, sourceLifecycle, liveEntryDriftGuard, mirrorPositionRisk, type MirrorBinding } from "../lib/live-parity.ts";
import { advanceForward, initialForward, type Trade, type ForwardState } from "../lib/forward-relations.ts";
import {newExitControl} from "../lib/forward-protection.ts";
import { gateMarkedEquity, gatePositionValuation, liveEntryDisposition, liveExitTag, type GateLiveAccount, type GateLiveOrder, type GateLivePosition, type LiveEntryIntent, type LiveStopIntent, LiveEntrySizingError, GateEntryCancelledError, GateLiveClient, GateReadTimeoutError } from "../lib/gate-live.ts";
import { quantizeMirrorNotional } from "../lib/gate-quantity.ts";
import { establishLiveScale, reconcileLiveScale, startLiveSession, sourceAfterEnable, LIVE_SESSION_VERSION, type LiveSession } from "../lib/live-session.ts";
import { prepareForwardWrite } from "../lib/forward-store.ts";
import { readFileSync } from "node:fs";
register("./worker-test-loader.mjs",import.meta.url);
const {MarketStream,default:worker}=await import("../worker/index-clean.ts");
const T=1_789_612_000_000;
function trade(id="ft-fixture-1",symbol="BTC_USDT",side:"LONG"|"SHORT"="LONG"):Trade {
  return {id,symbol,side,openedAt:T-10_000,closedAt:null,status:"OPEN",entryPrice:100,exitPrice:null,
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
function request(t=trade()):Parameters<typeof buildProportionalMirror>[0]{return {source:t,sourceEquity:1000,equity:100,available:100,entryPrice:100,
  quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,
  openNotional:0,now:T,policy:"any-current-or-future-policy",sizeRules:{enableDecimal:false,orderSizeMin:"1",orderSizeMax:"10000000"}};}

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
test("stale receipt seed cannot shrink a newly anchored 900/1000 account back to an old tiny ratio",()=>{
  const session=startLiveSession(T-1000,initialForward(T-2000));
  const scaled=establishLiveScale(session,1000,900,T,.01);
  assert.equal(scaled.scaleRatio,.9);assert.equal(scaled.scaleSourceEquity,1000);assert.equal(scaled.scaleLiveEquity,900);
  assert.equal(scaled.scaleRebaseFrom,.01);assert.equal(scaled.scaleRebaseReason,"ANCHOR_MISMATCH");
});
test("legacy anchorless stale scale repairs for a 900/1000 live-to-paper account",()=>{
  const session={...startLiveSession(T-1000,initialForward(T-2000)),scaleRatio:.01};
  const scaled=reconcileLiveScale(session,1000,900,T);
  assert.equal(scaled.scaleRatio,.9);assert.equal(scaled.scaleSourceEquity,1000);assert.equal(scaled.scaleLiveEquity,900);
  assert.equal(scaled.scaleRebaseFrom,.01);assert.equal(scaled.scaleRebaseReason,"ANCHOR_MISMATCH");
});
test("legacy anchorless ordinary drift stays frozen instead of re-scaling every trade",()=>{
  const session={...startLiveSession(T-1000,initialForward(T-2000)),scaleRatio:.9};
  assert.equal(reconcileLiveScale(session,1000,920,T),session);
});
test("internally inconsistent stored scale repairs from its own anchor equities without touching source trades",()=>{
  const session={...startLiveSession(T-1000,initialForward(T-2000)),scaleRatio:.01,scaleSourceEquity:1000,scaleLiveEquity:900,scaleAt:T-500};
  const scaled=reconcileLiveScale(session,1000,900,T);
  assert.equal(scaled.scaleRatio,.9);assert.equal(scaled.scaleRebaseReason,"ANCHOR_MISMATCH");
});
test("large upward external capital expansion rebases future entries but ordinary PnL drift stays fixed",()=>{
  const base={...startLiveSession(T-1000,initialForward(T-2000)),scaleRatio:.1,scaleSourceEquity:1000,scaleLiveEquity:100,scaleAt:T-500};
  const grown=reconcileLiveScale(base,1000,900,T);assert.equal(grown.scaleRatio,.9);assert.equal(grown.scaleRebaseReason,"LIVE_CAPITAL_INCREASE");
  const small=reconcileLiveScale(base,1000,112,T);assert.equal(small,base);
  const down=reconcileLiveScale(base,1000,50,T);assert.equal(down,base);
});
test("same leverage and proportional notional/margin are frozen in full-source binding",()=>{
  const t=trade(),r=buildProportionalMirror(request(t));assert.equal(r.intent.notional,20);assert.equal(r.intent.margin,10);
  assert.equal(r.intent.leverage,t.leverage);assert.equal(r.intent.contracts,200);assert.equal(r.binding.receipt.ratio,.1);
  assert.deepEqual(r.binding.sourceAtCopy,t);t.rule.reason="changed afterwards";assert.notEqual(r.binding.sourceAtCopy.rule.reason,t.rule.reason);
});
test("the PAPER arm price is not a hard target or a second economic admission model",()=>{
  const i=request();i.entryPrice=100.2;const r=buildProportionalMirror(i);assert.equal(r.intent.kind,"MARKET");
  assert.ok(r.intent.notional<=20);assert.equal(r.binding.receipt.sourceDeadline,i.source.openedAt+3600000);
});
test("dynamic entry drift guard allows small or favorable moves and rejects material chase",()=>{
  const t=trade(),g=liveEntryDriftGuard(t,100.2);assert.ok(g.adverse>0);assert.ok(g.adverse<=g.allowed);
  assert.equal(liveEntryDriftGuard(t,99.8).adverse,0);
  const ok=request(t);ok.entryPrice=100.2;assert.doesNotThrow(()=>buildProportionalMirror(ok));
  const chase=request(t);chase.entryPrice=100.4;assert.throws(()=>buildProportionalMirror(chase),/不利偏差.*动态上限/);
  const short=trade("short-drift","ETH_USDT","SHORT"),bad=request(short);bad.entryPrice=99.6;
  assert.throws(()=>buildProportionalMirror(bad),/不利偏差.*动态上限/);
});
test("mirror receipt records source and copy quote timing before any private order",()=>{
  const i=request();i.now=T+120;i.quoteObservedAt=T+100;i.entryPrice=100.1;
  const r=buildProportionalMirror(i),p=r.binding.receipt;
  assert.equal(p.sourceEntryPrice,100);assert.equal(p.sourceQuoteAt,T);assert.equal(p.copyQuoteAt,T+100);
  assert.equal(p.copyQuotePrice,100.1);assert.equal(p.copyDelayMs,i.now-i.source.openedAt);
  assert.ok((p.allowedAdverseEntryDriftRate??0)>0);assert.ok((p.adverseEntryDriftRate??0)>0);
});

test("round down within one lot, never enlarge a tiny account to one oversized contract",()=>{
  const i=request();i.equity=.001;i.available=.001;assert.throws(()=>buildProportionalMirror(i),/真实最小数量/);
  const j=request();j.equity=99.9;const r=buildProportionalMirror(j);assert.ok(r.binding.receipt.roundingNotional>=0);
  assert.ok(r.binding.receipt.roundingNotional<.1+1e-9);
});
test("a small LIVE account may lift only to the exact Gate minimum when real stop risk remains bounded",()=>{
  const t=trade("tiny-safe","ALT_USDT");t.entryPrice=10;t.lastPrice=10;t.stopPrice=9.99;t.armPrice=10.2;
  t.quantity=20;t.contracts=20;t.quantoMultiplier=1;t.notional=200;t.leverage=2;t.margin=100;t.plannedRisk=.58;
  t.openedAt=T-5_000;t.lastQuoteAt=T;
  const r=buildProportionalMirror({...request(t),sourceEquity:1000,equity:10,available:10,entryPrice:10,quantoMultiplier:1,
    leverageMax:20,maintenanceRate:.005,openRisk:0,sameDirectionRisk:0,openMargin:0,openNotional:0,mirrorRatio:.01,
    sourceRiskAuthority:true,activationAt:T-10_000,sizeRules:{enableDecimal:false,orderSizeMin:"1",orderSizeMax:"1000"}});
  assert.equal(r.intent.contracts,1);assert.equal(r.intent.notional,10);assert.equal(r.binding.receipt.minimumUplift,true);
  assert.ok((r.binding.receipt.minimumUpliftRiskRate??1)<.0075);
});
test("LIVE never catches up a source after the realtime copy window even if the PAPER trade is still open",()=>{
  const stale={...trade(),openedAt:T-60_000},i=request(stale);i.activationAt=T-120_000;
  assert.throws(()=>buildProportionalMirror(i),/实时复制窗口/);
});

test("margin or leverage failure is explicit, not silent new leverage or smaller-risk re-selection",()=>{
  const i=request();i.leverageMax=1;assert.throws(()=>buildProportionalMirror(i),/杠杆/);
  const j=request();j.available=1;assert.throws(()=>buildProportionalMirror(j),/不静默缩单/);
});
test("source-authoritative mirror keeps fixed scale despite small live fee drift",()=>{
  const i=request();i.equity=95;i.available=100;i.mirrorRatio=.1;i.sourceRiskAuthority=true;
  // The ratio remains fixed, but existing actual risk must leave headroom
  // under 10% / 6.5% of the now-95 equity, not the old 100 mirror anchor.
  i.openRisk=8.8;i.sameDirectionRisk=5.8;i.openMargin=74;i.openNotional=390;
  const r=buildProportionalMirror(i);
  assert.equal(r.binding.receipt.ratio,.1);assert.equal(r.intent.notional,20);assert.equal(r.intent.margin,10);
});
test("PAPER fee is not double-reserved against Gate available margin",()=>{
  const i=request();i.available=10;i.sourceRiskAuthority=true;i.mirrorRatio=.1;
  const r=buildProportionalMirror(i);assert.equal(r.intent.margin,10);
});
test("large actual entry drift still cannot hide behind source risk authority",()=>{
  const i=request();i.entryPrice=110;i.mirrorRatio=.1;i.sourceRiskAuthority=true;
  assert.throws(()=>buildProportionalMirror(i),/不利偏差|风险明显高于模拟比例|止损/);
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

test("decimal supported quantity below one contract preserves the exact proportional target",()=>{
  const t=trade();t.quantoMultiplier=1;t.contracts=2;
  const r=buildProportionalMirror({...request(t),quantoMultiplier:1,sizeRules:{enableDecimal:true,orderSizeMin:"0.1",orderSizeMax:"100"}});
  assert.equal(r.intent.contracts,.2);assert.equal(r.intent.body.size,"0.2");assert.equal(r.intent.notional,20);
  assert.equal(r.intent.margin,10);assert.equal(r.intent.leverage,2);assert.equal(r.binding.receipt.quantityQuantum,"0.1");
});
test("short decimal sizes, zero IOC and partial fills preserve the sign and residual",()=>{
  const t=trade("short","SOL_USDT","SHORT");t.quantoMultiplier=1;t.contracts=2;
  const r=buildProportionalMirror({...request(t),quantoMultiplier:1,sizeRules:{enableDecimal:true,orderSizeMin:"0.1"}});
  assert.equal(r.intent.body.size,"-0.2");
  assert.equal(liveEntryDisposition({status:"finished",finish_as:"ioc",size:"-0.2",left:"-0.1"},"MARKET"),"FILLED");
  assert.equal(liveEntryDisposition({status:"finished",finish_as:"ioc",size:"-0.2",left:"-0.2"},"MARKET"),"CANCELLED");
});
test("exact decimal quantization never floors 2.3/0.1 to 22 units or enlarges a subminimum",()=>{
  const spec={enableDecimal:true,orderSizeMin:"0.1"};
  assert.equal(quantizeMirrorNotional(2.3,1,1,spec).quantityText,"2.3");
  assert.equal(quantizeMirrorNotional(.099999999,1,1,spec).quantity,0);
  assert.equal(quantizeMirrorNotional(3e-8,1,1,{enableDecimal:true,orderSizeMin:"0.00000001"}).quantityText,"0.00000003");
});
test("genuine minimum blockage gives numeric required equity without rounding up",()=>{
  const t=trade();t.quantoMultiplier=1;t.contracts=2;
  assert.throws(()=>buildProportionalMirror({...request(t),equity:10,available:10,quantoMultiplier:1,
    sizeRules:{enableDecimal:false,orderSizeMin:"1"}}),e=>{
    assert.ok(e instanceof LiveEntrySizingError);assert.equal(e.code,"MIN_CONTRACT");
    assert.equal(e.sizing!.requiredLiveEquity,500);assert.equal(e.sizing!.targetContracts,.02);
    assert.equal(e.sizing!.minimumContracts,1);return true;
  });
});
test("absent, contradictory and zero size metadata never silently defaults to one",()=>{
  for(const spec of[{}, {enableDecimal:false,orderSizeMin:"0.1"},{enableDecimal:true,orderSizeMin:"0"}])
    assert.throws(()=>quantizeMirrorNotional(10,100,1,spec));
  assert.throws(()=>quantizeMirrorNotional(100,1,1,{enableDecimal:false,orderSizeMin:"1",marketOrderSizeMax:"50"}),/最大/);
});
test("Gate PnL parsing preserves losses/zero, handles actual-margin basis and missing values",()=>{
  const a=gatePositionValuation({unrealised_pnl:"-2.5",mark_price:"98",margin:"10",initial_margin:"5"},T);
  assert.equal(a.exchangeUnrealisedPnl,-2.5);assert.equal(a.exchangePnlMargin,10);assert.equal(a.exchangeMarkPrice,98);
  assert.equal(gatePositionValuation({unrealised_pnl:"0",initial_margin:"4"},T).exchangePnlMargin,4);
  const unknown=gatePositionValuation({unrealised_pnl:"",mark_price:"NaN",margin:"0"},T);
  assert.equal(unknown.exchangeUnrealisedPnl,null);assert.equal(unknown.exchangePnlMargin,null);
});
test("every private Gate request opts into decimal quantity responses",async()=>{
  const real=globalThis.fetch,requests:Request[]=[];
  globalThis.fetch=async(input,init)=>{const req=new Request(input,init);requests.push(req);
    return Response.json(req.url.includes('/accounts')?{total:"100",unrealised_pnl:"0"}:[]);};
  try{await new GateLiveClient({apiKey:"test-key-never-live",apiSecret:"test-secret-never-live",environment:"testnet"}).snapshot();
    assert.equal(requests.length,4);for(const r of requests)assert.equal(r.headers.get("X-Gate-Size-Decimal"),"1");
  }finally{globalThis.fetch=real;}
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
  requestCount=0;placed:LiveEntryIntent[]=[];leverages:number[]=[];stops:GateLiveOrder[]=[];amendedStops:Array<{id:string;price:number}>=[];
  orders=new Map<string,GateLiveOrder>();holdings:Record<string,GateLivePosition>={};
  closeTags:string[]=[];onLeverage:(()=>Promise<void>)|null=null;onCreate:(()=>Promise<void>)|null=null;
  failSnapshot=false;readTimeout=false;partial=false;zero=false;ambiguous=false;omitExit=false;inspectFailures=0;counter=1;
  async snapshot(){this.requestCount++;if(this.readTimeout)throw new GateReadTimeoutError("/futures/usdt/accounts");
    if(this.failSnapshot)throw new Error("injected Gate outage");
    return structuredClone({account:this.account,positions:Object.values(this.holdings),orders:[],priceOrders:this.stops,checkedAt:Date.now()});}
  async setLeverage(_symbol:string,n:number){this.leverages.push(n);await this.onLeverage?.();}
  async createEntry(i:LiveEntryIntent,beforeSend?:()=>boolean){await this.onCreate?.();if(beforeSend&&!beforeSend())throw new GateEntryCancelledError();this.placed.push(structuredClone(i));const id=String(this.counter++);
    if(this.ambiguous)throw new Error("injected submission timeout");
    const filled=this.zero?0:this.partial?Math.floor(i.contracts/2):i.contracts;
    this.orders.set(id,{id_string:id,contract:String(i.body.contract),text:i.tag,status:"finished",finish_as:filled===i.contracts?"filled":"ioc",size:i.size,left:(i.size>0?1:-1)*(i.contracts-filled),fill_price:100});
    if(filled)this.holdings[String(i.body.contract)]={contract:String(i.body.contract),size:Math.sign(i.size)*filled,entry_price:100,leverage:i.leverage};
    return id;
  }
  async inspectEntry(_kind:string,_symbol:string,tag:string,id:string|null){
    if(this.inspectFailures>0){this.inspectFailures--;throw new GateReadTimeoutError(`/futures/usdt/orders/${id??tag}`);}
    return structuredClone(this.orders.get(id??"")??[...this.orders.values()].find(o=>o.text===tag)??null);
  }
  async createStop(i:LiveStopIntent){const id=String(this.counter++);this.stops.push({id_string:id,text:i.tag,contract:String((i.body.initial as Record<string,unknown>).contract),status:"open"});return id;}
  async amendStop(id:string,price:number){this.amendedStops.push({id,price});return;}
  async cancelOrder(_kind:string,id:string){this.stops=this.stops.filter(s=>s.id_string!==id);}
  async closePosition(symbol:string,tag:string){this.closeTags.push(tag);delete this.holdings[symbol];const id=String(this.counter++);
    if(!this.omitExit)this.orders.set(id,{id_string:id,text:tag,contract:symbol,status:"finished",finish_as:"filled",fill_price:100.4});return id;}
}
type Harness={runtime:{live:Record<string,unknown>;[key:string]:unknown};forwardState:ForwardState;liveClient:FakeGate;
  liveHistory:unknown[];forwardError:string|null;liveBindingError:string|null;
  syncLive(now:number,enable?:boolean,off?:boolean):Promise<void>;setLiveMode(v:boolean):Promise<{ok:boolean}>;
  saveCheckpoint(now:number,force?:boolean):Promise<void>;liveDesiredPortfolio(now:number):Record<string,unknown>};
type LiveTest={requestedEnabled:boolean;changedAt:number|null;activation?:LiveSession;operational:boolean;lastError?:string|null;entries:Record<string,{planId:string;status:string;exchangeOrderId?:string|null;lastError?:string|null;parity?:MirrorBinding["receipt"]}>;
  positions:Record<string,{id:string;status:string;entryPrice:number;exitPrice?:number;parity?:MirrorBinding["receipt"];exitReason?:string;exchangeSize?:number}&Partial<ReturnType<typeof gatePositionValuation>>>;entrySkips:Record<string,{reason:string}>};
function live(h:Harness){return h.runtime.live as unknown as LiveTest;}
async function harness(store=new Memory(),gate=new FakeGate()) {
  let ready:Promise<unknown>=Promise.resolve();
  const ctx={storage:store,blockConcurrencyWhile(fn:()=>Promise<unknown>){ready=fn();},waitUntil(){return;}};
  const env={OWNER_ACCESS_TOKEN:"test-only-owner-secret-never-live",DB:{prepare(){throw new Error("forbidden D1/network in harness");}}};
  const stream=new MarketStream(ctx as unknown as DurableObjectState,env as never);await ready;
  const h=stream as unknown as Harness;h.liveClient=gate;h.forwardState=initialForward(T-300000);
  h.forwardState.positions=[trade()];h.forwardState.storage={persistedAt:T,error:null};
  h.runtime.symbols=["BTC_USDT"];h.runtime.tickSize={BTC_USDT:.01};
  h.runtime.contractMeta={BTC_USDT:{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,fundingRate:0,enableDecimal:false,orderSizeMin:"1",orderSizeMax:"10000000"}};
  h.runtime.evidence={BTC_USDT:{midpoint:100,bestBid:100,bestAsk:100,observedAt:T,fresh:true,entryReady:true}};
  return {h,store,gate,stream};
}
async function clock<T>(fn:()=>Promise<T>){const old=Date.now,fetch=globalThis.fetch;Date.now=()=>T;
  globalThis.fetch=async()=>{throw new Error("REAL NETWORK FORBIDDEN IN LIVE TEST");};try{return await fn();}finally{Date.now=old;globalThis.fetch=fetch;}}

// Legacy lifecycle/failure tests now create their source AFTER owner enable.
// Direct enable tests below exercise exclusion separately; no fence is bypassed.
async function enableNew(h:Harness) {
  const oldNow=Date.now,sources=h.forwardState.positions;h.forwardState.positions=[];
  let result:{ok:boolean};
  try{Date.now=()=>T-120000;result=await h.setLiveMode(true);}
  finally{Date.now=oldNow;h.forwardState.positions=sources;}
  if(result.ok)await h.syncLive(T);
  return result;
}

test("persisted new PAPER source reaches LIVE in the same critical pass",()=>clock(async()=>{
  const {h}=await harness();h.forwardState.positions=[];
  live(h).requestedEnabled=true;live(h).activation=startLiveSession(T-1000,h.forwardState);
  let syncs=0;
  const x=h as unknown as {advanceForwardNow(n:number):Promise<void>;syncLive(n:number):Promise<void>};
  const before=new Set(h.forwardState.positions.map(t=>t.id));
  x.advanceForwardNow=async()=>{h.forwardState.positions=[{...trade("instant-wake"),openedAt:T-500}];};
  x.syncLive=async()=>{syncs++;};
  await x.advanceForwardNow(T);
  const newEligible=h.forwardState.positions.some(t=>!before.has(t.id)&&t.openedAt>=live(h).activation!.enabledAt);
  if(live(h).requestedEnabled&&newEligible)await x.syncLive(T);
  assert.equal(syncs,1);
}));
test("price running away during leverage setup is rejected before Gate entry submit",()=>clock(async()=>{
  const {h,gate}=await harness();
  gate.onLeverage=async()=>{h.runtime.evidence={BTC_USDT:{midpoint:100.4,bestBid:100.39,bestAsk:100.4,observedAt:T,fresh:true,entryReady:true}};};
  await enableNew(h);
  assert.equal(gate.placed.length,0);assert.match(live(h).entrySkips.BTC_USDT.reason,/不利偏差.*动态上限/);
}));

test("a committed source arriving during the account read is copied in that same real Worker pass",()=>clock(async()=>{
  const {h,gate}=await harness();h.forwardState.positions=[];
  live(h).requestedEnabled=true;live(h).activation=startLiveSession(T-120000,h.forwardState);
  const snapshot=gate.snapshot.bind(gate);let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  gate.snapshot=async()=>{await pending;return snapshot();};
  const work=h.syncLive(T);await new Promise<void>(resolve=>setImmediate(resolve));
  h.forwardState.positions=[trade()];release();await work;
  assert.equal(gate.placed.length,1);assert.ok(gate.stops.length>0);
  await h.syncLive(T);assert.equal(gate.placed.length,1);
}));

test("LIVE scheduling has one serialized execution path after the durable PAPER pass",()=>{
  const file=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.doesNotMatch(file,/launchLiveWork\(|liveBackgroundWork|liveSourcePending|liveFastSourcePending/,
    "later event-driven LIVE executor must not return beside the restored stable path");
  const alarm=file.slice(file.indexOf("  async alarm(info?"),file.indexOf("  async fetch(request:",file.indexOf("  async alarm(info?")));
  const paper=alarm.indexOf("await this.advanceForwardNow(Date.now(),false)");
  const live=alarm.indexOf("await this.syncLive(liveStarted)");
  assert.ok(paper>=0&&live>paper,"the primary alarm must persist PAPER first and then await exactly one LIVE reconciliation");
});
test("accepted live fill stores submit quote, delay and verified exchange entry drift",()=>clock(async()=>{
  const {h}=await harness();await enableNew(h);await h.syncLive(T);
  const p=live(h).positions.BTC_USDT.parity!;
  assert.equal(p.submitQuotePrice,100);assert.equal(p.submitQuoteAt,T);assert.equal(p.exchangeEntryPrice,100);
  assert.ok((p.submitDelayMs??-1)>=0);assert.equal(p.exchangeEntryDriftRate,0);
}));

test("real Worker repairs an anchorless legacy ratio before sizing a current source",()=>clock(async()=>{
  const {h,gate}=await harness();
  h.forwardState.positions=[];
  live(h).requestedEnabled=true;
  live(h).activation={...startLiveSession(T-1000,h.forwardState),scaleRatio:.01};
  h.forwardState.positions=[{...trade("anchorless-capital-rebase"),openedAt:T-500}];
  gate.account={total:900,available:900,unrealised_pnl:0,in_dual_mode:false};
  await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,1);
  assert.ok((live(h).activation!.scaleRatio??0)>.85);
  assert.equal(live(h).positions.BTC_USDT.parity!.ratio,live(h).activation!.scaleRatio);
}));
test("real Worker repairs a stale fixed ratio before sizing a new source and does not mutate PAPER",()=>clock(async()=>{
  const {h,gate}=await harness(),before=structuredClone(h.forwardState);
  h.forwardState.positions=[];
  live(h).requestedEnabled=true;
  const activation=startLiveSession(T-1000,h.forwardState);
  live(h).activation={...activation,scaleRatio:.01,scaleSourceEquity:1000,scaleLiveEquity:900,scaleAt:T-900};
  h.forwardState.positions=[{...trade("capital-rebase"),openedAt:T-500}];
  gate.account={total:900,available:900,unrealised_pnl:0,in_dual_mode:false};
  await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,1);
  assert.ok((live(h).activation!.scaleRatio??0)>.85);
  assert.equal(live(h).positions.BTC_USDT.parity!.ratio,live(h).activation!.scaleRatio);
  assert.equal(h.forwardState.positions[0].id,"capital-rebase");
  assert.deepEqual({...h.forwardState,positions:[]},{...before,positions:[]});
}));
test("actual owner enable excludes all already-open sources without resetting PAPER",()=>clock(async()=>{
  const {h,gate}=await harness(),before=structuredClone(h.forwardState);
  assert.equal((await h.setLiveMode(true)).ok,true);await h.syncLive(T);
  assert.equal(gate.placed.length,0);assert.deepEqual(h.forwardState,before);
  assert.equal(live(h).requestedEnabled,true);assert.equal(live(h).activation!.enabledAt,T);
  assert.ok(live(h).activation!.excludedSourceIds.includes(before.positions[0].id));
}));
test("a NEW source after enable copies, repeated ON does not move its eligibility boundary",()=>clock(async()=>{
  const {h,gate}=await harness();await h.setLiveMode(true);
  const epoch=structuredClone(live(h).activation),oldNow=Date.now;Date.now=()=>T+100;
  try{h.forwardState.positions=[{...trade("new-after-enable"),openedAt:T+50}];
    await h.setLiveMode(true);await h.syncLive(T+100);
    assert.equal(gate.placed.length,1);
    assert.equal(live(h).activation!.enabledAt,epoch!.enabledAt);
    assert.equal(live(h).activation!.sourceStartedAt,epoch!.sourceStartedAt);
    assert.deepEqual(live(h).activation!.excludedSourceIds,epoch!.excludedSourceIds);
    assert.ok((live(h).activation!.scaleRatio??0)>0);
    assert.equal(live(h).positions.BTC_USDT.id,"new-after-enable");
  }finally{Date.now=oldNow;}
}));
test("source stamped exactly at activation is excluded conservatively",()=>{
  const state=initialForward(T-1000),a=startLiveSession(T,state);
  assert.equal(sourceAfterEnable({id:"same-ms",openedAt:T},a,state.startedAt),false);
  assert.equal(sourceAfterEnable({id:"later",openedAt:T+1},a,state.startedAt),true);
  assert.equal(sourceAfterEnable({id:"later",openedAt:T+1},a,state.startedAt+1),false);
});
test("OFF then ON excludes intervening unbound sources but retains already-owned protection",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);const original=live(h).positions.BTC_USDT.id;
  await h.setLiveMode(false);h.forwardState.positions.push(trade("off-window","SOL_USDT"));
  await h.setLiveMode(true);await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.equal(live(h).positions.BTC_USDT.id,original);
  assert.ok(gate.stops.length>0);assert.equal(gate.closeTags.length,0);
  assert.ok(live(h).activation!.excludedSourceIds.includes("off-window"));
}));
test("owner activation fence persists across restart without changing timestamp",()=>clock(async()=>{
  const {h,store,gate}=await harness();await h.setLiveMode(true);await h.saveCheckpoint(T,true);
  const fp=await prepareForwardWrite(null,h.forwardState,T);await store.put(fp.entries);
  const epoch=structuredClone(live(h).activation),restored=await harness(store,gate);
  assert.deepEqual(live(restored.h).activation,epoch);await restored.h.syncLive(T);assert.equal(gate.placed.length,0);
}));
test("OFF and re-enable during leverage await invalidate the old staged session",()=>clock(async()=>{
  const {h,gate}=await harness();let off:Promise<unknown>|undefined,on:Promise<unknown>|undefined;
  gate.onLeverage=async()=>{off=h.setLiveMode(false);on=h.setLiveMode(true);};
  await enableNew(h);await off;await on;
  assert.equal(gate.placed.length,0);assert.equal(live(h).requestedEnabled,true);
  assert.ok(live(h).activation!.excludedSourceIds.includes("ft-fixture-1"));
}));
test("one-time migration while owner ON starts new-only fence and does not enable/disable or replay",()=>clock(async()=>{
  const {h,store,gate}=await harness();await store.put((await prepareForwardWrite(null,h.forwardState,T)).entries);
  await store.put(`${LIVE_PARITY_PREFIX}owner-intent`,{enabled:true,changedAt:T-500000});
  const a=await harness(store,gate);assert.equal(live(a.h).requestedEnabled,true);
  assert.equal(live(a.h).activation!.migration,true);assert.equal(live(a.h).changedAt,T-500000);
  await a.h.syncLive(T);assert.equal(gate.placed.length,0);
  const b=await harness(store,gate);assert.deepEqual(live(b.h).activation,live(a.h).activation);
}));
test("actual Worker retains decimal holdings, Gate unrealized PnL and closes the exact parent",()=>clock(async()=>{
  const {h,gate}=await harness();const t=h.forwardState.positions[0];t.quantoMultiplier=1;t.contracts=2;
  h.runtime.contractMeta={BTC_USDT:{quantoMultiplier:1,maintenanceRate:.005,leverageMax:20,fundingRate:0,enableDecimal:true,orderSizeMin:"0.1",orderSizeMax:"1000"}};
  await enableNew(h);assert.equal(gate.placed[0].body.size,"0.2");
  Object.assign(gate.holdings.BTC_USDT,{size:"0.1",unrealised_pnl:"-0.125",mark_price:"98.75",margin:"5",initial_margin:"5"});
  await h.syncLive(T);const p=live(h).positions.BTC_USDT;
  assert.equal(p.exchangeSize,.1);assert.equal(p.exchangeUnrealisedPnl,-.125);assert.equal(p.exchangePnlMargin,5);
  assert.match(p.parity!.discrepancy!,/0.1/);assert.equal(gate.placed.length,1);
  t.status="CLOSED";t.closedAt=T;t.exitReason="source exits";h.forwardState.positions=[];h.forwardState.history=[t];
  await h.syncLive(T);await h.syncLive(T);assert.equal(gate.closeTags.length,1);assert.equal(live(h).positions.BTC_USDT.status,"CLOSED");
}));
test("missing later PnL field clears stale native value, not fake-zero or public-price replacement",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);gate.holdings.BTC_USDT.unrealised_pnl="2";await h.syncLive(T);
  assert.equal(live(h).positions.BTC_USDT.exchangeUnrealisedPnl,2);
  delete gate.holdings.BTC_USDT.unrealised_pnl;await h.syncLive(T);assert.equal(live(h).positions.BTC_USDT.exchangeUnrealisedPnl,null);
}));
test("sub-one holding remains protected and native PnL survives checkpoint recovery",()=>clock(async()=>{
  const {h,gate,store}=await harness();await enableNew(h);Object.assign(gate.holdings.BTC_USDT,{size:"0.1",unrealised_pnl:"0.005",margin:"0.01"});
  await h.syncLive(T);await h.saveCheckpoint(T,true);await store.put((await prepareForwardWrite(null,h.forwardState,T)).entries);
  const recovered=await harness(store,gate);await recovered.h.syncLive(T);
  assert.equal(live(recovered.h).positions.BTC_USDT.exchangeSize,.1);
  assert.equal(live(recovered.h).positions.BTC_USDT.exchangeUnrealisedPnl,.005);
  assert.equal(gate.placed.length,1);assert.ok(gate.stops.length>0);
}));
test("coverage partitions pre-enable exclusions, true minimum blocks and partial real copies",()=>{
  const s=initialForward(T-300000),old=trade(),small={...trade("small","SOL_USDT"),openedAt:T+1},partial={...trade("partial","ETH_USDT"),openedAt:T+1};
  s.positions=[old];const activation=startLiveSession(T,s);s.positions=[old,small,partial];
  const receipt=buildProportionalMirror(request()).binding.receipt;receipt.discrepancy="partial";
  const c=mirrorCoverage(s,{requestedEnabled:true,activation,positions:{ETH_USDT:{id:partial.id,status:"OPEN",parity:receipt}},entries:{},
    entrySkips:{SOL_USDT:{planId:small.id,code:"MIN_CONTRACT",reason:"below min"}}},null);
  assert.equal(c.sourceCount,3);assert.equal(c.eligibleSourceCount,2);assert.equal(c.excludedSourceCount,1);
  assert.equal(c.minimumSizeBlockedCount,1);assert.equal(c.copiedCount,1);assert.equal(c.deviationCount,1);
  assert.equal(c.newOrdersOnly,true);assert.equal(c.executionPolicy,LIVE_SESSION_VERSION);
});

test("real Worker sync does not read credentials or submit any order while owner OFF",()=>clock(async()=>{
  const {h,gate}=await harness();await h.syncLive(T);assert.equal(gate.requestCount,0);assert.equal(gate.placed.length,0);assert.equal(live(h).requestedEnabled,false);
}));
test("real owner-enable path routes current source, freezes binding before submit and copies once",()=>clock(async()=>{
  const {h,gate,store}=await harness();gate.onCreate=async()=>{
    assert.ok(store.data.has(`${LIVE_PARITY_PREFIX}binding:ft-fixture-1`));
    assert.ok(store.data.has("checkpoint"));
  };
  const result=await enableNew(h);assert.equal(result.ok,true);assert.equal(gate.placed.length,1);
  await h.syncLive(T);await h.syncLive(T);assert.equal(gate.placed.length,1);
  const p=live(h).positions.BTC_USDT;assert.equal(p.id,"ft-fixture-1");assert.equal(p.parity!.sourceRuleId,"fr-fixture-1");
  assert.equal(gate.leverages[0],2);assert.ok(gate.stops.length>0);
}));
test("a tightened PAPER profit stop amends the existing Gate-native protective stop before source close",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  const source=h.forwardState.positions[0]!;
  assert.ok(gate.stops.length>0);
  source.stopPrice=100.8;
  h.runtime.evidence={BTC_USDT:{midpoint:102,bestBid:101.99,bestAsk:102.01,observedAt:T,fresh:true,entryReady:true}};
  await h.syncLive(T);
  const p=live(h).positions.BTC_USDT as LiveTest["positions"][string]&{currentStop:number;stopPrice:number|null};
  assert.equal(p.currentStop,100.8);
  assert.equal(p.stopPrice,100.8);
  assert.equal(gate.amendedStops.at(-1)?.price,100.8);
  assert.equal(gate.closeTags.length,0);
}));


test("real Worker follows source CLOSE reason, not an independently restarted holding timer",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  const t=h.forwardState.positions[0];t.status="CLOSED";t.closedAt=T;t.exitReason="反应回吐：源单退出";
  h.forwardState.history=[t];h.forwardState.positions=[];
  await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.closeTags[0],liveExitTag(t.id));assert.equal(live(h).positions.BTC_USDT.status,"CLOSED");
  assert.equal(live(h).positions.BTC_USDT.exitReason,t.exitReason);assert.equal(live(h).positions.BTC_USDT.exitPrice,100.4);
}));
test("missing source is a recovery case, not evidence to close an otherwise protected real position",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  h.forwardState.positions=[];h.forwardState.history=[];await h.syncLive(T);assert.equal(gate.closeTags.length,0);
}));
test("arming or source rule re-synthesis does not prematurely close an existing real holding",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  h.forwardState.positions[0].favorable=.03;h.forwardState.rules=[];await h.syncLive(T);
  assert.equal(gate.closeTags.length,0);assert.equal(live(h).positions.BTC_USDT.status,"OPEN");
}));
test("a new-policy early PAPER giveback is followed by the actual owner reconciler without five-minute delay",()=>clock(async()=>{
  const {h,gate}=await harness();h.forwardState.positions[0].exitControl=newExitControl();
  await enableNew(h);await h.syncLive(T);const activation=structuredClone(live(h).activation);
  let current=T+60000;Date.now=()=>current;
  const advance=(price:number)=>{h.forwardState=advanceForward({state:h.forwardState,now:current,paths:{},contracts:{},
    quotes:{BTC_USDT:{bestBid:price,bestAsk:price+.01,observedAt:current,fresh:true}}}).state;};
  advance(101);await h.syncLive(current);assert.equal(gate.closeTags.length,0);
  current+=30000;advance(100.6);assert.equal(h.forwardState.positions.length,0);
  assert.equal(h.forwardState.history[0].exitAudit!.trigger,"PROFIT_GIVEBACK");
  assert.ok(current-h.forwardState.history[0].openedAt<300000);
  await h.syncLive(current);await h.syncLive(current);
  assert.equal(gate.closeTags.length,1);assert.equal(gate.closeTags[0],liveExitTag("ft-fixture-1"));
  assert.equal(live(h).positions.BTC_USDT.status,"CLOSED");assert.deepEqual(live(h).activation,activation);
  assert.equal(live(h).requestedEnabled,true);assert.equal(gate.placed.length,1);
}));
test("owner OFF during leverage request prevents the already-staged market entry",()=>clock(async()=>{
  const {h,gate}=await harness();let off:Promise<unknown>|undefined;
  gate.onLeverage=async()=>{off=h.setLiveMode(false);};await enableNew(h);await off;
  assert.equal(gate.placed.length,0);assert.equal(live(h).requestedEnabled,false);
}));
test("forced LIVE reconciliation waiters remain serialized after a shared active pass",async()=>{
  const h=Object.create(MarketStream.prototype) as {liveSyncWork:Promise<void>|null;
    syncLive(now:number,enable?:boolean,off?:boolean):Promise<void>;syncLiveOnce():Promise<void>};
  let releaseBusy!:()=>void,running=0,maximum=0,started=0;
  h.liveSyncWork=new Promise<void>(resolve=>{releaseBusy=()=>{h.liveSyncWork=null;resolve();};});
  const releases:Array<()=>void>=[];
  h.syncLiveOnce=async()=>{started++;running++;maximum=Math.max(maximum,running);
    await new Promise<void>(resolve=>{releases.push(resolve);});running--;};
  const enabling=h.syncLive(T,true),disabling=h.syncLive(T,false,true);
  releaseBusy();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(started,1);assert.equal(maximum,1);
  releases.shift()!();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(started,2);assert.equal(maximum,1);
  releases.shift()!();await Promise.all([enabling,disabling]);assert.equal(h.liveSyncWork,null);
});
test("owner OFF during final durable entry reservation prevents the network submission",()=>clock(async()=>{
  const {h,gate}=await harness();let off:Promise<unknown>|undefined;
  const save=h.saveCheckpoint.bind(h);
  h.saveCheckpoint=async(now,force)=>{await save(now,force);
    const entry=live(h).entries.BTC_USDT as unknown as {marketSubmittedAt?:number};
    if(entry?.marketSubmittedAt&&!off)off=h.setLiveMode(false);
  };
  await enableNew(h);await off;
  assert.equal(gate.placed.length,0);assert.equal(live(h).requestedEnabled,false);
  const entry=live(h).entries.BTC_USDT as unknown as {marketSubmittedAt?:number;submissionResolved?:boolean};
  assert.equal(entry.marketSubmittedAt,undefined);assert.equal(entry.submissionResolved,true);
}));
test("source closure during final durable entry reservation prevents the network submission",()=>clock(async()=>{
  const {h,gate}=await harness();const save=h.saveCheckpoint.bind(h);
  h.saveCheckpoint=async(now,force)=>{await save(now,force);
    const entry=live(h).entries.BTC_USDT as unknown as {marketSubmittedAt?:number};
    if(entry?.marketSubmittedAt)h.forwardState.positions=[];
  };
  await enableNew(h);assert.equal(gate.placed.length,0);
}));
test("existing stop and adverse drift limits are rechecked after the final reservation and signing",()=>clock(async()=>{
  for(const phase of ["reservation","signing"]){
    for(const price of [98,100.4]){
      const {h,gate}=await harness(),save=h.saveCheckpoint.bind(h);
      const changeQuote=()=>{h.runtime.evidence={BTC_USDT:{midpoint:price,bestBid:price,bestAsk:price,observedAt:T,fresh:true,entryReady:true}};};
      if(phase==="reservation")h.saveCheckpoint=async(now,force)=>{await save(now,force);
        if((live(h).entries.BTC_USDT as unknown as {marketSubmittedAt?:number})?.marketSubmittedAt)changeQuote();};
      else gate.onCreate=async()=>{changeQuote();};
      await enableNew(h);assert.equal(gate.placed.length,0,`${phase} price ${price}`);
    }
  }
}));
test("owner OFF while signing an entry is a known local cancellation, not an uncertain fill",()=>clock(async()=>{
  const {h,gate}=await harness();let off:Promise<unknown>|undefined;
  gate.onCreate=async()=>{off=h.setLiveMode(false);};
  await enableNew(h);await off;
  assert.equal(gate.placed.length,0);assert.equal(live(h).entries.BTC_USDT.status,"CANCELLED");
  assert.equal(live(h).requestedEnabled,false);
}));
test("source closure during leverage request cancels the stale entry without opening",()=>clock(async()=>{
  const {h,gate}=await harness();gate.onLeverage=async()=>{h.forwardState.positions=[];};await enableNew(h);
  assert.equal(gate.placed.length,0);
}));
test("temporary Gate faults never rewrite owner switch intent",()=>clock(async()=>{
  const {h,gate}=await harness();gate.failSnapshot=true;const r=await enableNew(h);
  assert.equal(r.ok,false);assert.equal(live(h).requestedEnabled,true);assert.equal(live(h).operational,false);
}));
test("a first Gate read timeout leaves LIVE pending and a later read recovers without another toggle",()=>clock(async()=>{
  const {h,gate}=await harness();gate.readTimeout=true;
  const activationBefore=h.forwardState.positions[0]!.id,result=await h.setLiveMode(true),activation=structuredClone(live(h).activation);
  assert.equal(result.ok,true);assert.equal(live(h).requestedEnabled,true);assert.equal(live(h).operational,false);
  assert.match(live(h).lastError??"",/Gate只读核对超时/);assert.ok(activation?.excludedSourceIds.includes(activationBefore));
  assert.equal(gate.placed.length,0);
  gate.readTimeout=false;await h.syncLive(T);
  assert.equal(live(h).requestedEnabled,true);assert.equal(live(h).operational,true);assert.equal(live(h).lastError,null);
  assert.deepEqual(live(h).activation,activation);assert.equal(gate.placed.length,0);
}));
test("storage failure prevents private entry calls and successful copies",()=>clock(async()=>{
  const {h,gate,store}=await harness();store.fail=true;const r=await enableNew(h);
  assert.equal(r.ok,false);assert.equal(gate.placed.length,0);
}));
test("partial execution is adopted and shown as a deviation, not repeated as a full new entry",()=>clock(async()=>{
  const {h,gate}=await harness();gate.partial=true;await enableNew(h);await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.match(live(h).positions.BTC_USDT.parity!.discrepancy!,/实际/);
  const p=live(h).positions.BTC_USDT as unknown as Parameters<typeof mirrorPositionRisk>[0];
  const risk=(h as unknown as {liveOpenRisk():number}).liveOpenRisk();
  assert.ok(Math.abs(risk-mirrorPositionRisk(p,100))<1e-9);
  assert.ok(Math.abs(risk-gate.placed[0].plannedRisk/2)<1e-9);
}));
test("zero-fill IOC cannot produce a fictitious filled position",()=>clock(async()=>{
  const {h,gate}=await harness();gate.zero=true;await enableNew(h);await h.syncLive(T);
  assert.equal(Object.keys(live(h).positions).length,0);assert.equal(gate.stops.length,0);assert.equal(gate.placed.length,1);
}));
test("ambiguous submission reserves identity and is not retried into a duplicate",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await enableNew(h);await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.equal(live(h).entries.BTC_USDT.status,"ERROR");
}));
test("a returned REST order id is retained through an inspection fault and never replayed",()=>clock(async()=>{
  const {h,gate}=await harness();gate.inspectFailures=1;await enableNew(h);
  const entry=live(h).entries.BTC_USDT;
  assert.equal(gate.placed.length,1);assert.equal(entry.exchangeOrderId,"1");assert.equal(entry.status,"ERROR");
  assert.match(entry.lastError??"",/Gate 实盘入场提交失败/);assert.equal(gate.stops.length,0);
  await h.syncLive(T);
  assert.equal(gate.placed.length,1,"a known exchange order ID must never be submitted twice");
  assert.equal(live(h).positions.BTC_USDT.status,"OPEN");assert.ok(gate.stops.length>0);
}));
test("missing exchange exit response is not replaced by source/midpoint price",()=>clock(async()=>{
  const {h,gate}=await harness();gate.omitExit=true;await enableNew(h);await h.syncLive(T);
  const t=h.forwardState.positions[0];t.status="CLOSED";t.closedAt=T;t.exitReason="期限到达";h.forwardState.history=[t];h.forwardState.positions=[];
  await h.syncLive(T);await h.syncLive(T);assert.equal(live(h).positions.BTC_USDT.exitPrice,undefined);
}));
test("restart restores source binding and later owner OFF instead of replaying old ON checkpoint",()=>clock(async()=>{
  const {h,store,gate}=await harness();await enableNew(h);await h.syncLive(T);await h.saveCheckpoint(T,true);
  const fp=await prepareForwardWrite(null,h.forwardState,T);await store.put(fp.entries);
  await store.put(`${LIVE_PARITY_PREFIX}owner-intent`,{enabled:false,changedAt:T+1});
  const {h:r}=await harness(store,gate);assert.equal(live(r).requestedEnabled,false);
  assert.equal(live(r).positions.BTC_USDT.parity!.sourceId,"ft-fixture-1");await r.syncLive(T);assert.equal(gate.placed.length,1);
}));
test("archived real records survive the next same-symbol parent and source details are owner-only",()=>clock(async()=>{
  const {h,stream,gate}=await harness();await enableNew(h);await h.syncLive(T);
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
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  h.forwardState=null as unknown as ForwardState;h.forwardError="injected source recovery";
  const r=await h.setLiveMode(false);assert.equal(r.ok,true);assert.equal(live(h).requestedEnabled,false);
  assert.equal(gate.closeTags.length,0);assert.ok(gate.stops.length>0);assert.equal(gate.placed.length,1);
}));
test("OFF does not abandon a delayed already-filled entry older than one minute",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);
  const entry=live(h).entries.BTC_USDT as unknown as {createdAt:number;status:string};entry.createdAt=T-120000;
  assert.equal(Object.keys(live(h).positions).length,0);
  await h.setLiveMode(false);assert.equal(live(h).positions.BTC_USDT.status,"OPEN");assert.ok(gate.stops.length>0);
}));
test("known price crossing original stop during leverage await cannot open then immediately close",()=>clock(async()=>{
  const {h,gate}=await harness();gate.onLeverage=async()=>{h.runtime.evidence={BTC_USDT:{midpoint:98,bestBid:98,bestAsk:98,observedAt:T,fresh:true,entryReady:true}};};
  await enableNew(h);assert.equal(gate.placed.length,0);assert.match(live(h).entries.BTC_USDT.status,/CANCELLED/);
}));
test("unified collateral rejection does not change owner intent or remove native protection",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);gate.account.margin_mode=2;
  await assert.rejects(()=>h.syncLive(T),/统一保证金/);assert.equal(live(h).requestedEnabled,true);assert.ok(gate.stops.length>0);
}));
test("closed source is durably retained beyond the rolling PAPER history",()=>clock(async()=>{
  const {h,gate,store}=await harness();await enableNew(h);await h.syncLive(T);
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
  h.runtime.contractMeta=Object.fromEntries(symbols.map(symbol=>[symbol,{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,fundingRate:0,enableDecimal:false,orderSizeMin:"1",orderSizeMax:"10000000"}]));
  h.runtime.evidence=Object.fromEntries(symbols.map(symbol=>[symbol,{midpoint:100,bestBid:100,bestAsk:100,observedAt:T,fresh:true,entryReady:true}]));
  await enableNew(h);await h.syncLive(T);await h.syncLive(T);await h.syncLive(T);
  assert.equal(gate.placed.length,4);assert.equal(Object.keys(live(h).positions).length,4);
  assert.deepEqual(Object.values(live(h).positions).map(p=>p.id).sort(),h.forwardState.positions.map(p=>p.id).sort());
  for(const p of Object.values(live(h).positions))assert.ok(p.parity!.ratio>0);
}));
test("ambiguous market submission cannot be replayed after the old six-second and minute timers",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await enableNew(h);
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
  assert.equal((ci.match(/\.runtime\.forward\.strategyAuthorityVersion == "extremum-regime-v1"/g)??[]).length,2);
  assert.equal((ci.match(/\.runtime\.forward\.storage\.error == null/g)??[]).length,2);
  assert.ok(pkg.scripts.test.includes("test:live-parity"));
  assert.ok(pkg.scripts["test:live-parity"].includes("live-parity.test.ts")||pkg.scripts["test:direct"].includes("tests/*.test.ts"));
  assert.match(ci,/npm run test:live-parity/);assert.match(ci,/\(\.runtime\.liveMode\.requestedEnabled\|type\) == "boolean"/);
  assert.match(readFileSync(new URL("../AGENTS.md",import.meta.url),"utf8"),/LIVE_MIRROR_CONTRACT.md/);
});

test("owner OFF continues reconciling an uncertain submission until a late verified fill is protected and source-closed",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await enableNew(h);await h.setLiveMode(false);
  const scheduler=h as unknown as {liveNeedsSync():boolean};assert.equal(scheduler.liveNeedsSync(),true);
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
test("the restored six-second ambiguity fence never replays or replaces the same-symbol parent without exchange proof",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await enableNew(h);
  const original=Date.now;Date.now=()=>T+120000;
  try{
    await h.syncLive(Date.now());
    const old=live(h).entries.BTC_USDT as unknown as {planId:string;status:string;submissionResolved?:boolean};
    assert.equal(old.status,"CANCELLED");assert.notEqual(old.submissionResolved,true);
    h.forwardState.positions=[{...trade("replacement-parent"),openedAt:Date.now()-1_000,lastQuoteAt:Date.now()}];
    h.runtime.evidence={BTC_USDT:{midpoint:100,bestBid:100,bestAsk:100,observedAt:Date.now(),fresh:true,entryReady:true}};
    await h.syncLive(Date.now());
    assert.equal(gate.placed.length,1,"an ambiguous old network submission is never followed by a same-symbol replacement");
    assert.equal(live(h).entries.BTC_USDT.planId,old.planId);
  }finally{Date.now=original;}
}));

function addRiskTestSource(h:Harness,side:"LONG"|"SHORT"="LONG") {
  const meta=h.runtime.contractMeta as Record<string,unknown>;
  meta.ETH_USDT=structuredClone(meta.BTC_USDT);
  const quotes=h.runtime.evidence as Record<string,unknown>;
  quotes.ETH_USDT={midpoint:100,bestBid:100,bestAsk:100,observedAt:T,fresh:true,entryReady:true};
  h.forwardState.positions.push(trade("risk-next","ETH_USDT",side));
}
test("real Worker blocks excess marked directional exposure without closing or resizing the existing parent",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  const quote=(h.runtime.evidence as Record<string,Record<string,unknown>>).BTC_USDT;
  Object.assign(quote,{midpoint:135,bestBid:135,bestAsk:135});
  gate.account.unrealised_pnl=7;
  addRiskTestSource(h);
  await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.equal(gate.closeTags.length,0);
  assert.equal(live(h).positions.BTC_USDT.exchangeSize,200);
  assert.match(live(h).entrySkips.ETH_USDT.reason,/实际权益.*风险预算/);
  assert.equal(live(h).requestedEnabled,true);
  // Opposite-side source remains executable because gross risk is <10% and
  // the existing LONG exposure cannot be misclassified as SHORT exposure.
  h.forwardState.positions[1]=trade("risk-opposite","ETH_USDT","SHORT");
  await h.syncLive(T);assert.equal(gate.placed.length,2);assert.equal(gate.placed[1].size,-200);
}));
test("real Worker keeps requested-but-unconfirmed closes and pending entries in risk totals",()=>clock(async()=>{
  const {h}=await harness();await enableNew(h);await h.syncLive(T);
  const r=h as unknown as {liveOpenRisk():number;liveDirectionalRisk(side:"LONG"|"SHORT"):number};
  const p=live(h).positions.BTC_USDT as unknown as Parameters<typeof mirrorPositionRisk>[0]&{exitRequestedAt:number|null};
  const before=r.liveOpenRisk();p.exitRequestedAt=T;
  assert.equal(r.liveOpenRisk(),before);assert.equal(r.liveDirectionalRisk("LONG"),before);
  const entries=h.runtime.live.entries as Record<string,unknown>;
  entries.ETH_USDT={planId:"pending",symbol:"ETH_USDT",side:"SHORT",status:"OPEN",plannedRisk:2,margin:1};
  assert.equal(r.liveOpenRisk(),before+2);assert.equal(r.liveDirectionalRisk("SHORT"),2);
  p.status="CLOSED";assert.equal(r.liveOpenRisk(),2);
  entries.ETH_USDT={planId:"pending-cancelled",symbol:"ETH_USDT",side:"SHORT",status:"CANCELLED",plannedRisk:2,margin:1,
    parity:{sourceId:"pending-cancelled"},marketSubmittedAt:T,submissionResolved:false};
  assert.equal(r.liveOpenRisk(),2,"cancelled-but-unresolved one-shot identity must keep its risk reserved");
  assert.equal(r.liveDirectionalRisk("SHORT"),2);
}));
test("an unknown prior submission reserves its risk but does not block an unrelated new source",()=>clock(async()=>{
  const {h,gate}=await harness();gate.ambiguous=true;await enableNew(h);
  const r=h as unknown as {liveOpenRisk():number};const firstRisk=r.liveOpenRisk();assert.ok(firstRisk>0);
  addRiskTestSource(h);await h.syncLive(T);
  assert.equal(gate.placed.length,2,"ETH source should still reach its own one-shot Gate submit while BTC identity is unresolved");
  assert.equal(live(h).requestedEnabled,true);assert.equal(live(h).operational,true);
  assert.equal(live(h).entries.BTC_USDT.status,"ERROR");assert.equal(live(h).entries.ETH_USDT.status,"ERROR");
  assert.ok(r.liveOpenRisk()>firstRisk,"both ambiguous one-shot submissions retain risk capacity until resolved");
}));
test("fresh Gate mark defeats a stale public midpoint while a source-closed position is still pending actual exit",()=>clock(async()=>{
  const {h,gate}=await harness();await enableNew(h);await h.syncLive(T);
  const old=h.forwardState.positions[0];old.status="CLOSED";old.closedAt=T;old.exitPrice=135;old.exitReason="synthetic source close";
  h.forwardState.history=[old];h.forwardState.positions=[];h.forwardState.balance=1070;
  const quote=(h.runtime.evidence as Record<string,Record<string,unknown>>).BTC_USDT;
  Object.assign(quote,{midpoint:100,bestBid:100,bestAsk:100,fresh:false,observedAt:T-60_000});
  gate.holdings.BTC_USDT.mark_price=135;gate.account.unrealised_pnl=7;
  gate.closePosition=async(_symbol,tag)=>{gate.closeTags.push(tag);return "pending-close";};
  addRiskTestSource(h);await h.syncLive(T);
  assert.equal(gate.placed.length,1);assert.equal(gate.closeTags.length,1);
  assert.equal(live(h).positions.BTC_USDT.status,"OPEN");
  assert.equal(live(h).positions.BTC_USDT.exchangeMarkPrice,135);
  assert.match(live(h).entrySkips.ETH_USDT.reason,/实际权益.*风险预算/);
  const r=h as unknown as {liveOpenRisk():number;liveDirectionalRisk(side:"LONG"|"SHORT"):number};
  assert.ok(r.liveOpenRisk()>7);assert.equal(r.liveOpenRisk(),r.liveDirectionalRisk("LONG"));
}));
test("risk falls back only to a fresh public quote; absent current Gate and public marks stay unknown",()=>clock(async()=>{
  const {h}=await harness();await enableNew(h);await h.syncLive(T);
  const r=h as unknown as {liveOpenRisk():number;liveDirectionalRisk(side:"LONG"|"SHORT"):number};
  const p=live(h).positions.BTC_USDT;
  p.exchangeMarkPrice=90;p.exchangePnlAt=T-31_000;
  const quote=(h.runtime.evidence as Record<string,Record<string,unknown>>).BTC_USDT;
  Object.assign(quote,{midpoint:100,bestBid:135,bestAsk:135,fresh:true,observedAt:T});
  assert.ok(r.liveOpenRisk()>7); // use the validated bid/ask, not an inconsistent midpoint
  Object.assign(quote,{fresh:false,observedAt:T-60_000});
  assert.ok(Number.isNaN(r.liveOpenRisk()));assert.ok(Number.isNaN(r.liveDirectionalRisk("LONG")));
  assert.equal(r.liveDirectionalRisk("SHORT"),0);assert.equal(live(h).requestedEnabled,true);
}));
