/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic browser and storage only */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {EquityHistoryCache,clearEquityBrowserCache,EQUITY_CACHE_VERSION} from "../lib/equity-cache.ts";
import {EquityReader} from "../lib/equity-reader.ts";
import {EQUITY_CURVE_VERSION,type CurveContext} from "../lib/equity-curve.ts";
const T=1789556791436,STEP=300000;
const context:CurveContext={startedAt:T,initialEquity:1000,policy:"participation-execution-v1.2",exitPolicy:"timely-protection-v1",comparableSince:T,persistedAt:T+4000*STEP};
const key=(i:number)=>`forward-relations:v1:archive:${String(T+i*STEP).padStart(16,"0")}:${i}`;
const packet=(i:number)=>({at:T+i*STEP,startedAt:T,policyVersion:context.policy,daily:{lastAt:T+i*STEP,endEquity:1000+Math.sin(i)*30},account:{positions:[]}});
class Memory {
  data=new Map<string,string>();get length(){return this.data.size;}key(i:number){return [...this.data.keys()][i]??null;}
  getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}
}
class Archive {
  rows=new Map<string,unknown>();reads:any[]=[];
  async list<V>(o:any):Promise<Map<string,V>>{
    this.reads.push(o);const a=[...this.rows].filter(([k])=>k.startsWith(o.prefix)&&(!o.start||k>=o.start)&&(!o.startAfter||k>o.startAfter)&&(!o.end||k<o.end)).sort(([a],[b])=>a<b?-1:a>b?1:0);
    if(o.reverse)a.reverse();return new Map(a.slice(0,o.limit)) as Map<string,V>;
  }
  add(n:number,start=1){for(let i=start;i<=n;i++)this.rows.set(key(i),packet(i));}
}
function host(n=150){
  const archive=new Archive();archive.add(n);const disk=new Memory(),reader=new EquityReader(),urls:string[]=[];
  let now=T+(n+1)*STEP;
  const options={now:()=>now,pause:async()=>{now+=701;},storage:()=>disk,fetch:async(input:any)=>{
    const u=new URL(String(input),"https://synthetic.local");urls.push(u.search);
    return Response.json(await reader.read(archive,context,u.searchParams.get("cursor"),now,u.searchParams.get("after")));
  }};
  const cache=new EquityHistoryCache(options);cache.configure(context,"owner");
  return {cache,archive,disk,reader,urls,options,time:(ms:number)=>{now+=ms;},now:()=>now};
}
test("first read gets history once; repeated tab/range remounts make no extra read after completion",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);
  assert.equal(h.urls.length,3);assert.equal(h.cache.getSnapshot().points.length,150);const exact=JSON.stringify(h.cache.getSnapshot().points);
  for(let i=0;i<20;i++){h.cache.configure(context,"owner");await h.cache.load(T,T+150*STEP,()=>true);}
  assert.equal(h.urls.length,3);assert.equal(JSON.stringify(h.cache.getSnapshot().points),exact);
});
test("new cycle reads only strictly newer archive keys, leaving every historical value unchanged",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);const before=h.cache.getSnapshot().points;
  h.archive.add(151,151);h.time(STEP);await h.cache.load(T,T+151*STEP,()=>true);
  assert.equal(h.urls.length,4);assert.ok(h.urls.at(-1)!.startsWith("?after="));assert.equal(h.archive.reads.at(-1).startAfter,key(150));
  assert.equal(h.cache.getSnapshot().points.length,151);assert.deepEqual(h.cache.getSnapshot().points.slice(0,150),before);
  await h.cache.load(T,T+151*STEP,()=>true);assert.equal(h.urls.length,4);
});
test("reload hydrates points and both cursors from this browser tab, with zero historical refetch",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);
  const second=new EquityHistoryCache(h.options);second.configure(context,"owner");assert.equal(second.getSnapshot().points.length,150);
  await second.load(T,T+150*STEP,()=>true);assert.equal(h.urls.length,3);
  h.time(STEP);h.archive.add(152,151);await second.load(T,T+152*STEP,()=>true);
  assert.equal(second.getSnapshot().points.length,152);assert.equal(h.urls.length,4);
});
test("leave during initial backfill retains progress; reentry uses next older cursor, not page one",async()=>{
  const h=host(200);let active=true;h.options.pause=async()=>{active=false;};
  const c=new EquityHistoryCache(h.options);c.configure(context,"owner");await c.load(T,T+200*STEP,()=>active);
  assert.equal(c.getSnapshot().points.length,64);const first=h.urls.length;
  const reloaded=new EquityHistoryCache({...h.options,pause:async()=>h.time(701)});reloaded.configure(context,"owner");
  await reloaded.load(T,T+200*STEP,()=>true);
  assert.ok(h.urls[first].startsWith("?cursor="));assert.equal(reloaded.getSnapshot().points.length,200);assert.equal(h.urls.length,4);
});
test("more than a page of missed future data is fully caught up before declaring freshness",async()=>{
  const h=host(80);await h.cache.load(T,T+80*STEP,()=>true);h.archive.add(280,81);h.time(201*STEP);
  await h.cache.load(T,T+280*STEP,()=>true);
  assert.equal(h.cache.getSnapshot().points.length,280);assert.equal(h.cache.getSnapshot().catchingUp,false);
  assert.ok(h.urls.slice(2).every(u=>u.startsWith("?after=")));assert.equal(new Set(h.cache.getSnapshot().points.map(p=>p.at)).size,280);
});
test("incremental key watermark advances across non-equity event/part pages without inventing points",async()=>{
  const h=host(1);await h.cache.load(T,T+STEP,()=>true);h.time(200*STEP);
  for(let i=2;i<=150;i++)h.archive.rows.set(key(i),{at:T+i*STEP,startedAt:T});
  h.archive.add(151,151);await h.cache.load(T,T+151*STEP,()=>true);
  assert.equal(h.cache.getSnapshot().points.length,2);assert.equal(h.cache.getSnapshot().newestCursor,key(151));assert.equal(h.cache.getSnapshot().catchingUp,false);
});
test("hidden/unmounted chart does not initiate any request",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>false);assert.equal(h.urls.length,0);
  await h.cache.load(T,T+150*STEP,()=>true);h.time(STEP);await h.cache.load(T,T+151*STEP,()=>false);assert.equal(h.urls.length,3);
});
test("concurrent readers and a rapid remount do not duplicate the backfill",async()=>{
  const h=host();await Promise.all([h.cache.load(T,T+150*STEP,()=>true),h.cache.load(T,T+150*STEP,()=>true)]);
  assert.equal(h.urls.length,3);assert.equal(h.cache.getSnapshot().points.length,150);
});
test("cache scopes and source-account reset cannot show another history",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);
  const c=new EquityHistoryCache(h.options);c.configure(context,"member-id-synthetic");assert.equal(c.getSnapshot().loaded,false);
  c.configure({...context,startedAt:T+STEP},"owner");assert.equal(c.getSnapshot().points.length,0);
  h.disk.setItem("unrelated","keep");clearEquityBrowserCache(h.disk);assert.deepEqual([...h.disk.data],[['unrelated','keep']]);
});
test("local storage quota errors leave in-memory curve intact",async()=>{
  const h=host();const disk={...h.disk,getItem:()=>null,setItem:()=>{throw new Error("QuotaExceededError");},removeItem:()=>{},key:()=>null,length:0};
  const c=new EquityHistoryCache({...h.options,storage:()=>disk});c.configure(context,"owner");await c.load(T,T+150*STEP,()=>true);
  assert.equal(c.getSnapshot().points.length,150);assert.equal(c.getSnapshot().error,null);
  await c.load(T,T+150*STEP,()=>true);assert.equal(h.urls.length,3);
});
test("malformed browser cache falls back safely without synthetic points",()=>{
  const h=host();h.disk.setItem(`sentinel:equity-cache:v1:owner:${T}:1000`,"{bad-json");
  const c=new EquityHistoryCache(h.options);c.configure(context,"owner");assert.equal(c.getSnapshot().points.length,0);assert.equal(c.getSnapshot().loaded,false);
});
test("transient failure preserves history and rapid retries are held for a minute",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);h.time(STEP);let calls=0;
  const c=new EquityHistoryCache({...h.options,fetch:async()=>{calls++;return new Response("busy",{status:429});}});c.configure(context,"owner");
  await c.load(T,T+151*STEP,()=>true);assert.equal(c.getSnapshot().points.length,150);assert.ok(c.getSnapshot().error);
  for(let i=0;i<10;i++)await c.load(T,T+151*STEP,()=>true);assert.equal(calls,1);
});
test("expired authorization hides projection without erasing history needed after reauthentication",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);h.time(STEP);
  const c=new EquityHistoryCache({...h.options,fetch:async()=>new Response("unauthorized",{status:401})});c.configure(context,"owner");
  await c.load(T,T+151*STEP,()=>true);assert.equal(c.getSnapshot().points.length,0);assert.equal(h.disk.length,1);
  const restored=new EquityHistoryCache(h.options);restored.configure(context,"owner");
  assert.equal(restored.getSnapshot().points.length,150);
});
test("logout/cancel invalidates a late response instead of recreating cache",async()=>{
  const h=host();let release!:(x:Response)=>void;
  const c=new EquityHistoryCache({...h.options,fetch:()=>new Promise(r=>release=r)});c.configure(context,"owner");
  const work=c.load(T,T+150*STEP,()=>true);c.cancel();clearEquityBrowserCache(h.disk);
  release(Response.json({version:EQUITY_CURVE_VERSION,context,points:[],nextCursor:null,scannedTo:null,generatedAt:h.now()}));await work;
  assert.equal(c.getSnapshot().points.length,0);assert.equal(h.disk.length,0);
});
test("strictly newer reader cache expires and new rows are not hidden by old negative response",async()=>{
  const s=new Archive();s.add(1);const r=new EquityReader();let now=T+STEP;
  const a=await r.read(s,context,null,now);now+=1000;
  assert.equal((await r.read(s,context,null,now,a.newestCursor)).points.length,0);
  s.add(2,2);now+=STEP;assert.equal((await r.read(s,context,null,now,a.newestCursor)).points.length,1);
});
test("incremental API cannot use mixed or foreign storage cursors",async()=>{
  const r=new EquityReader(),s=new Archive();for(const after of ["secret",key(-1),"../credentials"])
    await assert.rejects(r.read(s,context,null,T+STEP,after),/INVALID_CURSOR/);
  await assert.rejects(r.read(s,context,key(1),T+STEP,key(2)),/INVALID_CURSOR/);
});
test("client cache contains no trading/private-account call or automatic switch",()=>{
  const s=readFileSync(new URL('../lib/equity-cache.ts',import.meta.url),'utf8');
  assert.doesNotMatch(s,/\/api\/(?:live|members)|advanceForward|setLiveMode/);
  assert.match(s,/window\.localStorage/);
  const home=readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');assert.doesNotMatch(home,/clearEquityBrowserCache/);
  assert.match(home,/if\(!auth\?\.authenticated\)return <LoginGate/);
  const chart=readFileSync(new URL('../app/equity-curve.tsx',import.meta.url),'utf8');assert.match(chart,/!stopped&&!document.hidden/);
});

test("closing the browser loses sessionStorage but persistent history needs no history request",async()=>{
  const h=host(),tab=new Memory();
  const first=new EquityHistoryCache({...h.options,legacyStorage:()=>tab});first.configure(context,"owner");
  await first.load(T,T+150*STEP,()=>true);const old=first.getSnapshot().points;first.cancel();
  tab.data.clear();h.time(10*STEP);
  const reopened=new EquityHistoryCache({...h.options,legacyStorage:()=>new Memory()});reopened.configure(context,"owner");
  assert.deepEqual(reopened.getSnapshot().points,old);
  await reopened.load(T,T+150*STEP,()=>true);assert.equal(h.urls.length,3);
  h.archive.add(155,151);await reopened.load(T,T+155*STEP,()=>true);
  assert.equal(h.urls.length,4);assert.ok(h.urls[3].startsWith("?after="));
  assert.deepEqual(reopened.getSnapshot().points.slice(0,150),old);assert.equal(reopened.getSnapshot().points.length,155);
});
test("upgrade migrates validated session cache without downloading already read data",async()=>{
  const h=host();await h.cache.load(T,T+150*STEP,()=>true);
  const k=h.disk.key(0)!,legacy=JSON.parse(h.disk.getItem(k)!);legacy.version="incremental-session-v1";
  h.disk.setItem(k,JSON.stringify(legacy));const persistent=new Memory();
  const upgraded=new EquityHistoryCache({...h.options,storage:()=>persistent,legacyStorage:()=>h.disk});upgraded.configure(context,"owner");
  assert.equal(upgraded.getSnapshot().points.length,150);assert.equal(h.disk.length,0);
  assert.equal(JSON.parse(persistent.getItem(k)!).version,EQUITY_CACHE_VERSION);
  await upgraded.load(T,T+150*STEP,()=>true);assert.equal(h.urls.length,3);
});
test("failed persistent migration preserves old session cache and displays an accurate notice",async()=>{
  const h=host(1);await h.cache.load(T,T+STEP,()=>true);
  const denied=new Memory();denied.setItem=()=>{throw new Error("QuotaExceededError");};
  const c=new EquityHistoryCache({...h.options,storage:()=>denied,legacyStorage:()=>h.disk});c.configure(context,"owner");
  assert.equal(c.getSnapshot().points.length,1);assert.equal(h.disk.length,1);assert.ok(c.getSnapshot().cacheNotice);
  await c.load(T,T+STEP,()=>true);assert.equal(h.urls.length,1);
});
test("persistent source is authoritative over a stale tab cache and remains account-scoped",async()=>{
  const h=host(1);await h.cache.load(T,T+STEP,()=>true);const legacy=new Memory();
  for(const [k,v] of h.disk.data)legacy.setItem(k,v);
  h.archive.add(2,2);h.time(STEP);await h.cache.load(T,T+2*STEP,()=>true);
  const c=new EquityHistoryCache({...h.options,legacyStorage:()=>legacy});c.configure(context,"owner");
  assert.equal(c.getSnapshot().points.length,2);c.configure(context,"member-other");assert.equal(c.getSnapshot().points.length,0);
  c.configure({...context,startedAt:T+STEP},"owner");assert.equal(c.getSnapshot().points.length,0);
});
test("corrupt durable copy can recover the valid legacy copy, rather than discard both",async()=>{
  const h=host(2);await h.cache.load(T,T+2*STEP,()=>true);const broken=new Memory();broken.setItem(h.disk.key(0)!,"{broken");
  const c=new EquityHistoryCache({...h.options,storage:()=>broken,legacyStorage:()=>h.disk});c.configure(context,"owner");
  assert.equal(c.getSnapshot().points.length,2);assert.equal(h.disk.length,0);
  await c.load(T,T+2*STEP,()=>true);assert.equal(h.urls.length,1);
});
test("native browser quota retains last successful checkpoint, subsequent reopen only catches up after it",async()=>{
  const h=host(1);await h.cache.load(T,T+STEP,()=>true);const before=h.disk.getItem(h.disk.key(0)!);
  const write=h.disk.setItem.bind(h.disk);h.disk.setItem=()=>{throw new Error("QuotaExceededError");};
  h.archive.add(2,2);h.time(STEP);await h.cache.load(T,T+2*STEP,()=>true);
  assert.equal(h.cache.getSnapshot().points.length,2);assert.ok(h.cache.getSnapshot().cacheNotice);
  assert.equal(h.disk.getItem(h.disk.key(0)!),before);h.disk.setItem=write;
  const c=new EquityHistoryCache(h.options);c.configure(context,"owner");await c.load(T,T+2*STEP,()=>true);
  assert.ok(h.urls.at(-1)!.startsWith("?after="));assert.equal(c.getSnapshot().points.length,2);
});
test("past the old 20000-point cutoff the saved history is still retained, not silently abandoned",async()=>{
  const h=host(1);await h.cache.load(T,T+STEP,()=>true);h.time(21000*STEP);
  const k=h.disk.key(0)!,s=JSON.parse(h.disk.getItem(k)!);
  s.points=Array.from({length:20001},(_,i)=>[T+(i+1)*STEP,1000+i/100,context.policy,true]);
  s.newestCursor=key(20001);s.checkedCycle=T+20001*STEP;h.disk.setItem(k,JSON.stringify(s));
  const c=new EquityHistoryCache(h.options);c.configure(context,"owner");assert.equal(c.getSnapshot().points.length,20001);
  h.archive.rows.clear();h.archive.add(20002,20002);await c.load(T,T+20002*STEP,()=>true);
  const reopened=new EquityHistoryCache(h.options);reopened.configure(context,"owner");assert.equal(reopened.getSnapshot().points.length,20002);
});