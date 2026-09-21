import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {recordWindows,archivePage} from "../lib/record-view.ts";
import {matchSettlements,type GatePositionClose,type SettlementPosition} from "../lib/live-settlement.ts";
import {LiveHistoryReader} from "../lib/live-history-reader.ts";
import {GateLiveClient,liveExitTag} from "../lib/gate-live.ts";
import {Memory} from "./member-fixtures.ts";
const T=1790000000000;
const position=(id="source-a"):SettlementPosition=>({id,symbol:"BTC_USDT",side:"LONG",status:"CLOSED",entryAt:T+10000,exitAt:T+610000,
 entryPrice:100,exchangeSize:.1,parity:{sourceId:id,copiedAt:T,roundedContracts:.1}});
const native=(id="source-a"):GatePositionClose=>({contract:"BTC_USDT",side:"long",time:(T+605000)/1000,first_open_time:T/1000,
 pnl:"-0.07",pnl_pnl:"0.03",pnl_fee:"-0.1",pnl_fund:"0",text:liveExitTag(id),max_size:"0.1",accum_size:"0.1",long_price:"100",short_price:"103"});
const match=(p=position(),r=native())=>matchSettlements([p],[r],T+620000);
test("history shows10recent and50archive without mutating underlying120records",()=>{
 const input=Array.from({length:120},(_,n)=>({id:String(n),at:n})),copy=structuredClone(input),w=recordWindows(input,r=>r.at);
 assert.equal(w.recent.length,10);assert.equal(w.archive.length,50);assert.equal(w.recent[0].id,"119");assert.equal(w.archive[49].id,"60");assert.deepEqual(input,copy);
});
test("dedup preserves settled projection and archive excludes recent ten",()=>{
 const rows=Array.from({length:65},(_,i)=>({id:String(i),at:i,pnl:i})),w=recordWindows([{...rows[64],pnl:99},...rows],r=>r.at);
 assert.equal(w.recent[0].pnl,99);assert.ok(!w.archive.some(p=>w.recent.some(r=>r.id===p.id)));
});
test("archive page clamps when live record count shrinks",()=>{
 const x=archivePage([1,2],9);assert.deepEqual(x,{items:[1,2],page:0,pages:1});assert.equal(archivePage(Array(50).fill(1),4).items.length,10);
});
test("fractional matched settlement uses native negative total without double charging",()=>{
 const s=match()["source-a"];assert.equal(s.pnl,-.07);assert.equal(s.fees,-.1);assert.equal(s.pricePnl,.03);assert.equal(s.exitPrice,103);
});
test("real zero remains0, missing total remains pending",()=>{
 assert.equal(match(position(),{...native(),pnl:"0"})["source-a"].pnl,0);assert.deepEqual(match(position(),{...native(),pnl:undefined}),{});
});
test("wrong contract or side cannot attach PnL",()=>{
 for(const r of [{...native(),contract:"ETH_USDT"},{...native(),side:"short"}])assert.deepEqual(match(position(),r),{});
});
test("short-side native entry and exit fields are mapped correctly",()=>{
 const p={...position(),side:"SHORT" as const};const r={...native(),side:"short",short_price:"100",long_price:"97"};
 assert.equal(match(p,r)[p.id].exitPrice,97);
});
test("manual enlargement or partial cycle refuses whole-position PnL",()=>{
 for(const r of [{...native(),max_size:"0.2"},{...native(),accum_size:"0.2"}])assert.deepEqual(match(position(),r),{});
});
test("cycle opened before reservation is never assigned to newer source",()=>{
 assert.deepEqual(match(position(),{...native(),first_open_time:(T-5000)/1000}),{});
});
test("mismatched entry price and malformed numeric values are rejected",()=>{
 for(const r of [{...native(),long_price:"105"},{...native(),pnl:"NaN"},{...native(),pnl:""},{...native(),short_price:"0"}])assert.deepEqual(match(position(),r),{});
});
test("another source closing tag cannot hijack record",()=>{
 assert.deepEqual(match(position(),{...native(),text:liveExitTag("other")}),{});
});
test("unique complete lifecycle can match exchange generic close source",()=>{
 assert.equal(match(position(),{...native(),text:"web"})["source-a"].match,"UNIQUE_LIFECYCLE");
});
test("duplicate return rows do not duplicate or hide valid settlement",()=>{
 assert.equal(Object.keys(matchSettlements([position()],[native(),native()],T+620000)).length,1);
});
test("ambiguous or overlapping source cycles are not assigned aggregate PnL",()=>{
 const other={...position("other"),entryAt:T+20000,entryPrice:99};
 assert.deepEqual(matchSettlements([position(),other],[native()],T+620000),{});
 assert.deepEqual(matchSettlements([position()],[native(),{...native(),time:(T+606000)/1000}],T+620000),{});
});
test("settlement before source close or future timestamp must not replace PnL",()=>{
 assert.deepEqual(matchSettlements([position()],[{...native(),time:(T+700000)/1000}],T+620000),{});
});
test("missing cost breakdown is unknown rather than invented0",()=>{
 const s=match(position(),{...native(),pnl_fee:undefined,pnl_fund:undefined})["source-a"];assert.equal(s.fees,null);assert.equal(s.funding,null);
});
async function readerHarness(){const storage=new Memory(),p=position(),client={credentials:{environment:"testnet",apiKey:"fixture-only"},
 count:0,async positionCloseHistory(){this.count++;return [native()];}},reader=new LiveHistoryReader<SettlementPosition>(),tasks:Promise<void>[]=[];
 await storage.put("live-parity:v1:closed:0000000000000001:source-a",{position:p});
 const input={storage,client,current:[p],now:T+620000,valid:()=>true,reserve:()=>true,
  persist:async(entries:Record<string,unknown>)=>{await storage.transaction(async tx=>{await tx.put(entries);});},waitUntil:(t:Promise<void>)=>tasks.push(t)};
 return {storage,p,client,reader,tasks,input};}
test("lazy reader saves separate cache without rewriting trade or balance",async()=>{
 const h=await readerHarness(),old=await h.storage.get("live-parity:v1:closed:0000000000000001:source-a");h.reader.launch(h.input);await Promise.all(h.tasks);
 assert.equal(h.reader.view([h.p]).history[0].realizedPnl,-.07);assert.deepEqual(await h.storage.get("live-parity:v1:closed:0000000000000001:source-a"),old);
});
test("pending settlement state is visible to background scheduler and clears after Gate match",async()=>{
 const h=await readerHarness();assert.equal(h.reader.needsRefresh([h.p]),true);
 h.reader.launch(h.input);await Promise.all(h.tasks);
 assert.equal(h.reader.needsRefresh([h.p]),false);assert.equal(h.reader.view([h.p]).history[0].realizedPnl,-.07);
});

test("failed atomic save cannot publish newly calculated settlement",async()=>{
 const h=await readerHarness();h.storage.fail=true;h.reader.launch(h.input);await Promise.all(h.tasks);
 assert.equal(h.reader.view([h.p]).history[0].realizedPnl,undefined);assert.ok(h.reader.view([h.p]).error);
});
test("read throttling and no resource reserve avoid repeated network work",async()=>{
 const h=await readerHarness();h.reader.launch({...h.input,reserve:()=>false});await Promise.all(h.tasks);assert.equal(h.client.count,0);
 h.reader.launch({...h.input,now:h.input.now+10000});assert.equal(h.client.count,0);
});
test("restart restores native PnL while resolved cache needs no new API request",async()=>{
 const h=await readerHarness();h.reader.launch(h.input);await Promise.all(h.tasks);const r=new LiveHistoryReader<SettlementPosition>();
 r.launch({...h.input,now:h.input.now+70000});await Promise.all(h.tasks);assert.equal(r.view([h.p]).history[0].realizedPnl,-.07);assert.equal(h.client.count,1);
});
test("credential swap clears numeric cache before any throttle return",async()=>{
 const h=await readerHarness();h.reader.launch(h.input);await Promise.all(h.tasks);
 const other={credentials:{environment:"testnet",apiKey:"other"},async positionCloseHistory(){return [];}};
 h.reader.launch({...h.input,client:other,now:h.input.now+1000});assert.equal(h.reader.view([h.p]).history[0].realizedPnl,undefined);await Promise.all(h.tasks);
});
test("no credential still reads60old records without network or mutation",async()=>{
 const h=await readerHarness();for(let i=0;i<80;i++)await h.storage.put(`live-parity:v1:closed:${String(i).padStart(16,"0")}`,{position:{...h.p,id:String(i),exitAt:T+i}});
 const writes=h.storage.writes;h.reader.launch({...h.input,current:[],client:null});await Promise.all(h.tasks);
 assert.equal(h.reader.view([]).history.length,60);assert.equal(h.client.count,0);assert.equal(h.storage.writes,writes);
});
test("new Gate reader is GET only, fixed pagination, no retry",async()=>{
 const original=globalThis.fetch,calls:Request[]=[];globalThis.fetch=async(input,init)=>{calls.push(new Request(input as string,init));return Response.json([native()]);};
 try{const c=new GateLiveClient({environment:"testnet",apiKey:"fixture-key",apiSecret:"fixture-secret"});await c.positionCloseHistory(100,200,0);
 assert.equal(calls.length,1);assert.equal(calls[0].method,"GET");assert.ok(calls[0].url.includes("position_close?from=100&to=200&limit=100&offset=0"));
 assert.equal(calls[0].headers.get("X-Gate-Size-Decimal"),"1");await assert.rejects(()=>c.positionCloseHistory(200,100));assert.equal(calls.length,1);
 }finally{globalThis.fetch=original;}
});
test("reviewed Gate adapter stays frozen outside the read-only settlement method",()=>{
 const file=readFileSync(new URL("../lib/gate-live.ts",import.meta.url),"utf8");
 const from=file.indexOf("  /** Read-only position-cycle settlements."),to=file.indexOf("  async createEntry",from);
 // 2026-09-21: reviewed submission fence and decimal-grid repairs; behavior is
 // covered by gate-live/live-parity regressions, all other adapter bytes freeze.
 const old=file.slice(0,from)+file.slice(to);assert.equal(createHash("sha256").update(old).digest("hex"),"9c87f66a1f2240ca4164d87068cbab9f19783924c6a97e0408250982a2bd90c6");
});
test("operational UI removes version narratives and friend terminology",()=>{
 const paths=["forward-dashboard.tsx","live-console.tsx","member-access.tsx"];
 for(const path of paths){const text=readFileSync(new URL(`../app/${path}`,import.meta.url),"utf8");assert.doesNotMatch(text,/朋友|不是选择旧策略|首版在|当前新版模拟账户|不拼接旧版|本轮直接上线|升级时间/);}
 const ui=readFileSync(new URL("../app/forward-dashboard.tsx",import.meta.url),"utf8");assert.match(ui,/paperTab==="positions"/);assert.match(ui,/paper-history/);assert.match(ui,/paper-archive/);
});
test("background settlement is wired independently of opening the record tab",()=>{
 const worker=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
 const members=readFileSync(new URL("../worker/member-executor.ts",import.meta.url),"utf8");
 assert.match(worker,/launchLiveSettlementBackground\(\);/);
 assert.match(worker,/liveSettlementNeedsRefresh\(\)/);
 assert.match(members,/this\.launchLiveSettlementBackground\(\);/);
 assert.match(members,/this\.liveSettlementNeedsRefresh\(\)/);
});
