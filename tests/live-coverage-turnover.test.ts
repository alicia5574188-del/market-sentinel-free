import test from "node:test";
import assert from "node:assert/strict";
import { createHash,createHmac } from "node:crypto";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { GateLiveClient,gateRequestSignature } from "../lib/gate-live.ts";
import { initialTurnover,nextFillWindow,normalizeGateFill,prepareTurnoverPage,turnoverView,LIVE_TURNOVER_PREFIX,FILL_PAGE_SIZE,type GateConfirmedFill,type TurnoverState } from "../lib/live-turnover.ts";
import { initialForward, type ForwardState } from "../lib/forward-relations.ts";
import { prepareForwardWrite,readForwardStore,FORWARD_STORAGE } from "../lib/forward-store.ts";
import { rollResourceDay,resourceDay, type ResourceCounters } from "../lib/resource-day.ts";
import { gzip,gunzip } from "../lib/storage-codec.ts";
const START=Date.parse("2026-09-17T00:00:00Z"),NOW=START+180000;
const KEY="a".repeat(64),multipliers={BTC_USDT:.001,龙虾_USDT:.1};
const fill=(id="100",overrides:Partial<GateConfirmedFill>={}):GateConfirmedFill=>({trade_id:id,order_id:"1000000000000000001",create_time:(START+60000)/1000,contract:"BTC_USDT",size:"2.5",close_size:"0",price:"20000",text:"t-ms-e-test",...overrides});
class Memory {
 data=new Map<string,unknown>();writes=0;fail=false;alarm:number|null=null;
 async get<T>(k:string){return structuredClone(this.data.get(k)) as T|undefined;}
 async put(entries:Record<string,unknown>|string,value?:unknown){if(this.fail)throw new Error("storage failure");for(const[k,v]of typeof entries==="string"?[[entries,value]]:Object.entries(entries)){this.data.set(k as string,structuredClone(v));this.writes++;}}
 async transaction<T>(fn:(s:Memory)=>Promise<T>){const prior=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=prior;throw e;}}
 async list<T>(o:{prefix:string;reverse?:boolean;limit?:number}){const a=[...this.data].filter(([k])=>k.startsWith(o.prefix)).sort(([a],[b])=>a.localeCompare(b));if(o.reverse)a.reverse();return new Map(a.slice(0,o.limit??Infinity)) as Map<string,T>;}
 async getAlarm(){return this.alarm;}async setAlarm(x:number){this.alarm=x;}
}
async function page(s:TurnoverState,db:Memory,rows:GateConfirmedFill[],now=NOW,key=KEY){return prepareTurnoverPage({state:s,storage:db,rows,window:nextFillWindow(s,now)!,accountKey:key,multipliers,now});}
test("ASCII signing matches independent Node HMAC and Unicode signs decoded path once",async()=>{
 const secret="test-only-secret",body='{"contract":"龙虾_USDT"}',t="1789693322";
 for(const [path,query,plainPath,plainQuery]of[
  ["/api/v4/futures/usdt/orders","status=open","/api/v4/futures/usdt/orders","status=open"],
  ["/api/v4/futures/usdt/positions/%E9%BE%99%E8%99%BE_USDT/leverage","leverage=3","/api/v4/futures/usdt/positions/龙虾_USDT/leverage","leverage=3"],
  ["/api/v4/futures/usdt/price_orders","contract=%E9%BE%99%E8%99%BE_USDT&x=a+b","/api/v4/futures/usdt/price_orders","contract=龙虾_USDT&x=a b"],
  ["/api/v4/futures/usdt/orders/a%252F","x=%252F","/api/v4/futures/usdt/orders/a%2F","x=%2F"]]){
    const expected=createHmac("sha512",secret).update(`POST\n${plainPath}\n${plainQuery}\n${createHash("sha512").update(body).digest("hex")}\n${t}`).digest("hex");
    assert.equal(await gateRequestSignature(secret,"POST",path,query,body,t),expected);
 }
});
test("Unicode leverage request uses escaped transport but SDK-compatible signature, never fallback replay",async()=>{
 const original=globalThis.fetch,requests:Request[]=[];
 globalThis.fetch=async(input,init)=>{const r=new Request(input,init);requests.push(r);const url=new URL(r.url);
   assert.match(url.pathname,/%E9%BE%99/);const raw=await r.text();
   const expected=createHmac("sha512","test-secret").update(`POST\n${decodeURIComponent(url.pathname)}\n${decodeURIComponent(url.search.slice(1))}\n${createHash("sha512").update(raw).digest("hex")}\n${r.headers.get("Timestamp")}`).digest("hex");
   assert.equal(r.headers.get("SIGN"),expected);return Response.json({});};
 try{await new GateLiveClient({apiKey:"test-key",apiSecret:"test-secret",environment:"testnet"}).setLeverage("龙虾_USDT",3);assert.equal(requests.length,1);}finally{globalThis.fetch=original;}
});
test("malformed encoding fails before any request rather than signing another path",async()=>{
 await assert.rejects(()=>gateRequestSignature("x","GET","/%zz","","","1"));
});
test("fill endpoint preserves int64 IDs and uses read-only bounded time pagination",async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const r=new Request(input,init);assert.equal(r.method,"GET");assert.equal(r.headers.get("X-Gate-Size-Decimal"),"1");
   assert.match(r.url,/my_trades_timerange\?from=1&to=2&limit=100&offset=100$/);
   return new Response('[{"trade_id":9223372036854775807,"size":"0.1"}]');};
 try{const c=new GateLiveClient({apiKey:"test-key",apiSecret:"test-secret",environment:"testnet"});assert.equal((await c.confirmedFills(1,2,100))[0].trade_id,"9223372036854775807");
   await assert.rejects(()=>c.confirmedFills(1,2,-1));}finally{globalThis.fetch=original;}
});
test("UTC resources roll at midnight, not New York midnight, while financial objects remain intact",()=>{
 const s={utcDay:"2026-09-17",alarmCount:42000,d1Writes:1000,nonAlarmWrites:7995,subrequestCount:100,maxSubrequestsInAlarm:30,balance:943,positions:[{id:"same"}]};
 const before=structuredClone(s.positions);assert.equal(resourceDay(Date.parse("2026-09-18T00:00:01Z")),"2026-09-18");
 assert.equal(rollResourceDay(s,Date.parse("2026-09-18T00:00:01Z")),true);assert.equal(s.nonAlarmWrites,0);assert.equal(s.balance,943);assert.deepEqual(s.positions,before);
 assert.equal((s as ResourceCounters).resourceRollovers![0].nonAlarmWrites,7995);
 assert.equal(rollResourceDay(s,Date.parse("2026-09-18T01:00:00Z")),false);s.nonAlarmWrites=42;
 assert.equal(rollResourceDay(s,START),false);assert.equal(s.nonAlarmWrites,42);
});
test("lossless compressed forward persistence retains all orders and arbitrary future extension fields",async()=>{
 const s=initialForward(START);s.balance=943.25;s.latestReason="证据不要删除".repeat(10000);
 (s as unknown as Record<string,unknown>).futureExtension={losses:[1,2,3],opaque:"retain"};
 const db=new Memory(),before=structuredClone(s),p=await prepareForwardWrite(null,s,NOW);await db.put(p.entries);
 assert.deepEqual(await readForwardStore(db,NOW),before);assert.deepEqual(s,before);
 assert.equal(p.compression.encoding,"gzip");assert.ok(p.compression.storedBytes<p.compression.rawBytes/4);assert.equal(p.compression.chunks,1);
});
test("existing uncompressed forward checkpoints remain readable",async()=>{
 const s=initialForward(START),bytes=new TextEncoder().encode(JSON.stringify(s)),db=new Memory();
 await db.put({[`${FORWARD_STORAGE}head`]:{version:s.version,count:1,length:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")},[`${FORWARD_STORAGE}chunk:0`]:bytes});
 assert.deepEqual(await readForwardStore(db,NOW),s);
});
test("corrupt compressed state and decompression amplification fail without replacement account",async()=>{
 const db=new Memory(),s=initialForward(START),p=await prepareForwardWrite(null,s,NOW);await db.put(p.entries);
 const h=db.data.get(`${FORWARD_STORAGE}head`) as Record<string,unknown>;h.rawLength=1;await assert.rejects(()=>readForwardStore(db,NOW));
  await assert.rejects(()=>gunzip(new Uint8Array([1,2,3])));
});
test("decompression is explicitly bounded before allocating an oversized result",async()=>{
 const packed=await gzip(new Uint8Array(100000));await assert.rejects(()=>gunzip(packed,100));
});
test("only actual fill quantities contribute; partial fractional fills are counted individually",async()=>{
 const s=initialTurnover(START,NOW),db=new Memory(),p=await page(s,db,[fill("1"),fill("2",{size:"0.5",price:"21000"})]);
 assert.equal(p.state.total,60.5);assert.equal(p.state.opening,60.5);assert.equal(p.state.closing,0);assert.equal(p.state.fills,2);
 assert.equal(s.total,0);assert.equal(p.writes,2);
});
test("close fills and reversals split by actual close_size, not order labels",async()=>{
 const s=initialTurnover(START,NOW),p=await page(s,new Memory(),[fill("1",{size:"-3",close_size:"-1",text:"manual"})]);
 assert.equal(p.state.total,60);assert.equal(p.state.opening,40);assert.equal(p.state.closing,20);assert.equal(p.state.systemTagged,0);
});
test("native trade_value is authoritative and missing close classification stays unknown",()=>{
 const f=normalizeGateFill(fill("1",{trade_value:"51.25",close_size:undefined}),{});
 assert.equal(f.notional,51.25);assert.equal(f.unclassified,51.25);assert.equal(f.opening,0);assert.equal(f.closing,0);
});
test("no multiplier guessing, no zero-fill or unsafe-ID placeholders",()=>{
 for(const f of[fill("1",{size:"0"}),fill("1",{price:""}),fill("1",{trade_id:9223372036854775807}),fill("1",{close_size:"-1"})])assert.throws(()=>normalizeGateFill(f,multipliers));
 assert.throws(()=>normalizeGateFill(fill(),{}));
});
test("duplicate fills inside a page and overlapping restart pages count once",async()=>{
 const db=new Memory(),s=initialTurnover(START,NOW);let p=await page(s,db,[fill(),fill()]);await db.put(p.entries);assert.equal(p.state.fills,1);
 const restored=(await db.get<TurnoverState>(`${LIVE_TURNOVER_PREFIX}${KEY}:summary`))!;
 p=await page(restored,db,[fill(),fill("101",{create_time:(START+175000)/1000})],NOW+60000);await db.put(p.entries);
 assert.equal(p.state.fills,2);assert.equal(p.state.total,100);
});
test("same fill ID conflicting amount does not overwrite prior history or double count",async()=>{
 const db=new Memory(),s=initialTurnover(START,NOW),p=await page(s,db,[fill()]);await db.put(p.entries);
 await assert.rejects(()=>page(p.state,db,[fill("100",{price:"21000"})],NOW+60000));assert.equal(p.state.total,50);
});
test("full pages retain a fixed upper timestamp and an offset until last page",async()=>{
 const db=new Memory(),s=initialTurnover(START,NOW),rows=Array.from({length:FILL_PAGE_SIZE},(_,i)=>fill(String(i+1)));
 const p=await page(s,db,rows);await db.put(p.entries);assert.equal(p.state.through,s.through);assert.equal(p.state.pending!.offset,100);
 assert.deepEqual(nextFillWindow(p.state,NOW+DAY),p.state.pending);
 const q=await page(p.state,db,[],NOW+DAY);assert.equal(q.state.pending,null);assert.equal(q.state.through,p.state.pending!.to);assert.equal(q.state.total,5000);
});
const DAY=86400000;
test("out-of-window or malformed page never advances its cursor",async()=>{
 const s=initialTurnover(START,NOW),db=new Memory();await assert.rejects(()=>page(s,db,[fill("1",{create_time:(NOW+DAY)/1000})]));assert.equal(s.lastScanAt,0);
});
test("empty confirmed range is zero, an unqueried ledger is unknown",async()=>{
 const s=initialTurnover(START,NOW);assert.equal(turnoverView(s,null,NOW).total,null);
 const p=await page(s,new Memory(),[]);assert.equal(turnoverView(p.state,null,NOW).total,0);
});
test("separate Gate account namespaces cannot dedupe or add another account's fills",async()=>{
 const db=new Memory(),s=initialTurnover(START,NOW),a=await page(s,db,[fill()]);await db.put(a.entries);
 const b=await page(initialTurnover(START,NOW),db,[fill()],NOW,"b".repeat(64));assert.equal(b.state.total,50);assert.equal(b.newFills,1);
});
test("atomic failure leaves persisted total and dedupe IDs unchanged",async()=>{
 const db=new Memory(),s=initialTurnover(START,NOW),p=await page(s,db,[fill()]);db.fail=true;
 await assert.rejects(()=>db.transaction(async tx=>{await tx.put(p.entries);}));assert.equal(db.data.size,0);
 db.fail=false;const retry=await page(s,db,[fill()]);assert.equal(retry.newFills,1);
});

register("./worker-test-loader.mjs",import.meta.url);
const {MarketStream}=await import("../worker/index-clean.ts");
type WorkerTest={runtime:{nonAlarmWrites:number;live:{requestedEnabled:boolean;operational:boolean};contractMeta:Record<string,unknown>};
  forwardState:ForwardState;liveClient:unknown;turnoverAccountUser:string;turnoverState:TurnoverState|null;
  syncTurnover(now:number):Promise<void>;saveCheckpoint(now:number,force:boolean):Promise<void>;fetch(r:Request):Promise<Response>};
test("actual Worker persists fill-only turnover, exposes values only to owner and cannot toggle LIVE",async()=>{
 let ready=Promise.resolve();const db=new Memory();
 const ctx={storage:db,blockConcurrencyWhile(fn:()=>Promise<void>){ready=fn();},waitUntil(){}};
 const stream=new MarketStream(ctx as unknown as DurableObjectState,{OWNER_ACCESS_TOKEN:"test-owner"} as never);await ready;
 const w=stream as unknown as WorkerTest;w.forwardState=initialForward(START);w.turnoverAccountUser="123";w.runtime.contractMeta={BTC_USDT:{quantoMultiplier:.001}};
 w.runtime.live.requestedEnabled=true;w.runtime.live.operational=true;
 let calls=0;w.liveClient={credentials:{environment:"testnet",apiKey:"never-real",apiSecret:"never-real"},async confirmedFills(){calls++;return [fill()];}};
 await w.syncTurnover(NOW);assert.equal(w.turnoverState!.total,50);assert.equal(calls,1);assert.equal(w.runtime.live.requestedEnabled,true);
 const publicData=await (await stream.fetch(new Request("https://market-stream/status"))).json() as Record<string,unknown>;
 assert.equal(publicData.live,undefined);assert.equal((publicData.liveTurnover as Record<string,unknown>).total,undefined);
 const owner=await (await stream.fetch(new Request("https://market-stream/owner-runtime"))).json() as {live:{turnover:{total:number}}};assert.equal(owner.live.turnover.total,50);
 await w.saveCheckpoint(Date.now(),true);
 let restoredReady=Promise.resolve();const restored=new MarketStream({storage:db,blockConcurrencyWhile(fn:()=>Promise<void>){restoredReady=fn();},waitUntil(){}} as unknown as DurableObjectState,{OWNER_ACCESS_TOKEN:"test-owner"} as never);
 await restoredReady;const restoredOwner=await (await restored.fetch(new Request("https://market-stream/owner-runtime"))).json() as {live:{turnover:{total:number}}};assert.equal(restoredOwner.live.turnover.total,50);
});
test("actual Worker turnover storage failure never publishes uncommitted money or affects protection state",async()=>{
 let ready=Promise.resolve();const db=new Memory();const ctx={storage:db,blockConcurrencyWhile(fn:()=>Promise<void>){ready=fn();},waitUntil(){}};
 const stream=new MarketStream(ctx as unknown as DurableObjectState,{OWNER_ACCESS_TOKEN:"test-owner"} as never);await ready;
 const w=stream as unknown as WorkerTest;w.forwardState=initialForward(START);w.turnoverAccountUser="123";w.runtime.contractMeta={BTC_USDT:{quantoMultiplier:.001}};
 w.liveClient={credentials:{environment:"testnet",apiKey:"never-real"},async confirmedFills(){return [fill()];}};
 db.fail=true;const before=structuredClone(w.runtime.live);await assert.rejects(()=>w.syncTurnover(NOW));
 assert.equal(w.turnoverState!.total,0);assert.equal(w.turnoverState!.lastScanAt,0);assert.deepEqual(w.runtime.live,before);
});
test("UI names real account turnover separately from PAPER and waits rather than fabricating totals",()=>{
 const ui=readFileSync(new URL("../app/live-console.tsx",import.meta.url),"utf8");assert.match(ui,/实盘累计成交额/);assert.match(ui,/live\?\.turnover\?\.total/);assert.match(ui,/含手工成交/);
 const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");assert.match(worker,/now-this.turnoverAttemptAt<60_000/);assert.match(worker,/this\.ctx\.waitUntil\(work\.finally/);
});