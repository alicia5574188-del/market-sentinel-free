/* eslint-disable @typescript-eslint/no-explicit-any -- test-only host and protected executor inspection; no real network */
import test from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {Memory,FakeGate,T,trade} from "./member-fixtures.ts";
import {initialForward} from "../lib/forward-relations.ts";
import {MEMBERS_VERSION,memberCookie,issueMemberSession,verifyMemberSession,digestMember,memberVaultRoot,encryptMemberText,decryptMemberText} from "../lib/member-auth.ts";
import {createOwnerSession,ownerSessionCookie} from "../lib/owner-auth.ts";
import {encryptGateCredentials,decryptGateCredentials} from "../lib/credential-vault.ts";
import {liveEntryTag,liveExitTag} from "../lib/gate-live.ts";
import {LIVE_PARITY_PREFIX} from "../lib/live-parity.ts";
register("./worker-test-loader.mjs",import.meta.url);
const {MemberDirectory,MemberExecutor,MarketStream,default:worker}=await import("../worker/index-clean.ts");
const ROOT="synthetic-owner-root-for-members-test-not-live",ORIGIN="https://test.local";
let now=T;
const context=(store:Memory)=>{let ready=Promise.resolve();const tasks:Promise<unknown>[]=[];return {ctx:{storage:store,
  blockConcurrencyWhile(fn:()=>Promise<any>){ready=fn();},waitUntil(p:Promise<unknown>){tasks.push(p);}},ready:()=>ready,tasks};};
async function clock(fn:()=>Promise<void>){const old=Date.now,network=globalThis.fetch;now=T;Date.now=()=>now;
  globalThis.fetch=async()=>{throw new Error("REAL NETWORK FORBIDDEN IN MEMBER TEST");};
  try{await fn();}finally{Date.now=old;globalThis.fetch=network;}}
async function harness(){
  let source=initialForward(T-86400000);source.policyVersion="participation-execution-v1.2";source.storage={persistedAt:T,error:null};
  const events={primaryReads:0,primaryWrites:0,d1:0},ownerAccountHash=await digestMember("gate-user:primary-test");
  const dstore=new Memory(),dc=context(dstore),actors=new Map<string,any>();
  const env:any={OWNER_ACCESS_TOKEN:ROOT,DB:{prepare(){events.d1++;throw new Error("Member must NEVER read primary D1");}},ASSETS:{fetch:()=>new Response("asset")},
    MARKET_STREAM:{getByName(name:string){assert.equal(name,"primary");return{async fetch(input:Request|string,init?:RequestInit){const r=input instanceof Request?input:new Request(input,init);assert.equal(r.method,"GET");events.primaryReads++;
      if(new URL(r.url).pathname==="/member-closed"){const id=new URL(r.url).searchParams.get("id");return Response.json({trade:source.history.find(t=>t.id===id)??null,nextCursor:null});}
      assert.equal(new URL(r.url).pathname,"/member-feed");const evidence=Object.fromEntries(source.positions.map(t=>[t.symbol,{midpoint:100,bestBid:100,bestAsk:100,observedAt:now,fresh:true,entryReady:true}]));
      const metadata=Object.fromEntries(source.positions.map(t=>[t.symbol,{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005,enableDecimal:false,orderSizeMin:"1",orderSizeMax:"10000000"}]));
      return Response.json({version:MEMBERS_VERSION,at:now,healthy:true,error:null,state:source,view:{...source,equity:source.balance},metadata,ticks:{BTC_USDT:.01,SOL_USDT:.01},evidence,ownerAccountHash,
        sourceStatus:{state:"LIVE",stale:false,lastSuccessAt:now}});
    }}}}};
  const directory=new MemberDirectory(dc.ctx as never,env);await dc.ready();
  env.MEMBERS={getByName(name:string){assert.equal(name,"directory");return{fetch:(input:string,init?:RequestInit)=>directory.fetch(new Request(input,init))};}};
  env.MEMBER_EXECUTION={getByName(name:string){assert.match(name,/^member:m_[a-f0-9]{32}$/);return{async fetch(input:string,init?:RequestInit){
    const id=name.slice(7);if(!actors.has(id)){const storage=new Memory(),c=context(storage),engine=new MemberExecutor(c.ctx as never,env);await c.ready();actors.set(id,{engine,storage,c});}
    return actors.get(id).engine.fetch(new Request(input,init));}};}};
  async function rpc(path:string,body?:unknown){return directory.fetch(new Request("https://members"+path,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));}
  let sequence=0;
  async function issue(label="test"){const r=await rpc("/issue",{label,requestId:`idempotent-test-${++sequence}`});assert.equal(r.status,200);return r.json<any>();}
  async function internal(id:string,path:string,body?:unknown){const m=await(await rpc(`/identity?id=${id}`)).json<any>();
    return env.MEMBER_EXECUTION.getByName(`member:${id}`).fetch("https://member"+path,{method:body===undefined?"GET":"POST",
      headers:{"x-verified-member":id,"x-member-created-at":String(m.createdAt),"x-member-label":encodeURIComponent(m.label),"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  async function member(id:string,gate=new FakeGate()) {await internal(id,"/status");const a=actors.get(id);a.engine.liveClient=gate;
    a.engine.credential={user:id,accountHash:await digestMember(`gate-user:${id}`),encrypted:{},savedAt:now,keyHint:"test"};
    await a.storage.put("member-execution:v1:credential",a.engine.credential);return{...a,gate};}
  const mainCtx={waitUntil(){}};
  async function http(path:string,cookie="",body?:unknown,method=body===undefined?"GET":"POST") {
    return worker.fetch(new Request(ORIGIN+path,{method,headers:{Cookie:cookie,Origin:ORIGIN,"Content-Type":"application/json","CF-Connecting-IP":"192.0.2.1"},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,mainCtx as never);
  }
  return {env,events,actors,dstore,directory,rpc,issue,internal,member,http,get source(){return source;},set source(v){source=v;}};
}
test("A remains valid after generating B before A's first login; one stable account per key",()=>clock(async()=>{
  const h=await harness(),a=await h.issue("甲"),b=await h.issue("乙");assert.notEqual(a.id,b.id);
  for(let i=0;i<2;i++){const r=await h.rpc("/login",{key:a.loginKey,bucket:"a".repeat(64)});assert.equal(r.status,200);assert.equal((await r.json<any>()).id,a.id);}
  const listing=await(await h.rpc("/overview")).json<any>();assert.equal(listing.members.length,2);assert.equal(listing.current.loginKey,b.loginKey);
  assert.equal(listing.members.find((m:any)=>m.id===b.id).activatedAt,null);assert.ok(listing.members.find((m:any)=>m.id===a.id).activatedAt);
}));
test("simultaneous repeated issue request commits a single user and key",()=>clock(async()=>{
  const h=await harness(),body={label:"one",requestId:"concurrent-request-123"};
  const [a,b]=await Promise.all([h.rpc("/issue",body),h.rpc("/issue",body)]);const x=await a.json<any>(),y=await b.json<any>();
  assert.equal(x.id,y.id);assert.equal(x.loginKey,y.loginKey);assert.equal((await(await h.rpc("/overview")).json<any>()).members.length,1);
}));
test("issued secrets are hashed; only the current owner-display key is encrypted at rest",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue();const text=JSON.stringify([...h.dstore.data]);
  assert.ok(!text.includes(a.loginKey)&&!text.includes(b.loginKey));assert.ok(text.includes("keyHash"));
  const row=await h.dstore.get<any>(`member:${a.id}`);assert.equal(row.keyHash,await digestMember(a.loginKey));
}));
test("authenticated master alone can create keys; arbitrary member role/ID input grants nothing",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),member=memberCookie(await issueMemberSession(ROOT,a.id,1));
  assert.equal((await h.http("/api/members/issue","",{requestId:"forged-role-owner",role:"owner"})).status,403);
  assert.equal((await h.http("/api/members/admin",member)).status,403);
  assert.equal((await h.http("/api/members/issue",member,{requestId:"forged-owner-again",role:"owner"})).status,403);
  const owner=ownerSessionCookie(await createOwnerSession(ROOT));assert.equal((await h.http("/api/members/issue",owner,{requestId:"owner-issued-new-key"})).status,200);
}));
test("member signature domain cannot become an owner session or another user's session",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),token=await issueMemberSession(ROOT,a.id,1);
  assert.equal(await verifyMemberSession(new Request(ORIGIN,{headers:{Cookie:memberCookie(token.replace(a.id,b.id))}}),ROOT),null);
  const ownerCookie=ownerSessionCookie(token);assert.equal((await h.http("/api/members/admin",ownerCookie)).status,403);
  now+=31*86400000;assert.equal(await verifyMemberSession(new Request(ORIGIN,{headers:{Cookie:memberCookie(token)}}),ROOT),null);
}));
test("member key login returns a separate HttpOnly cookie without embedding the key",()=>clock(async()=>{
  const h=await harness(),a=await h.issue();const r=await h.http("/api/members/login","",{key:a.loginKey});assert.equal(r.status,200);
  const cookie=r.headers.get("set-cookie")!;assert.match(cookie,/ms_member_session=/);assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);assert.ok(!cookie.includes(a.loginKey));
  const body=await r.json<any>();assert.equal(body.role,"member");assert.equal(body.memberId,a.id);
}));
test("invalid keys never create memberships or enter the primary status path",()=>clock(async()=>{
  const h=await harness();for(const key of [ROOT,"MS-"+"0".repeat(64),"",{role:"owner"}])assert.equal((await h.http("/api/members/login","",{key})).status,401);
  assert.equal(h.events.primaryReads,0);assert.equal(h.dstore.data.get("member-count"),undefined);
}));
test("anonymous and cross-origin mutations cannot read runtime or create users",()=>clock(async()=>{
  const h=await harness();for(const path of ["/api/runtime","/api/forward/export","/api/live/status","/api/live/source?id=anything"])assert.equal((await h.http(path)).status,401);
  const cookie=ownerSessionCookie(await createOwnerSession(ROOT));const r=await worker.fetch(new Request(ORIGIN+"/api/members/issue",{method:"POST",headers:{Cookie:cookie,Origin:"https://other.test","Content-Type":"application/json"},body:"{}"}),h.env,{} as never);
  assert.equal(r.status,403);assert.equal(h.events.primaryReads,0);
}));
test("new member access never initializes a PAPER account, touches D1 or enables Gate",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),source=structuredClone(h.source);await h.internal(a.id,"/status");const {engine,storage}=h.actors.get(a.id);
  assert.equal(engine.runtime.live.requestedEnabled,false);assert.equal(storage.alarm,null);assert.equal(h.events.d1,0);
  assert.ok(!storage.data.has("checkpoint")&&!storage.data.has("forward-relations:v1:head"));assert.deepEqual(h.source,source);
}));
test("two users share one cached signal read but not credentials or execution stores",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue();await Promise.all([h.internal(a.id,"/status"),h.internal(b.id,"/status")]);
  assert.equal(h.events.primaryReads,1);assert.notEqual(h.actors.get(a.id).storage,h.actors.get(b.id).storage);
}));
test("a member cannot query a different execution account by ID parameters",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),cookie=memberCookie(await issueMemberSession(ROOT,a.id,1));
  const r=await h.http(`/api/runtime?id=${b.id}&role=owner`,cookie);assert.equal(r.status,200);const value=await r.json<any>();
  assert.equal(value.member.id,a.id);assert.equal(h.actors.has(b.id),false);assert.equal(value.live.equity,null);
  assert.equal((await h.http("/api/paper/reset",cookie,{confirm:"RESET_PAPER"})).status,403);
}));
test("per-user encryption prevents swapping encrypted Gate credentials between members",()=>clock(async()=>{
  const a="m_"+"a".repeat(32),b="m_"+"b".repeat(32),raw={apiKey:"synthetic-key",apiSecret:"synthetic-secret",environment:"live" as const};
  const sealed=await encryptGateCredentials(raw,await memberVaultRoot(ROOT,a));assert.deepEqual(await decryptGateCredentials(sealed,await memberVaultRoot(ROOT,a)),raw);
  const otherRoot=await memberVaultRoot(ROOT,b);await assert.rejects(()=>decryptGateCredentials(sealed,otherRoot));
  await assert.rejects(()=>decryptGateCredentials(sealed,ROOT));
  const text=await encryptMemberText("demo",ROOT,`current-key:${a}`);assert.equal(await decryptMemberText(text,ROOT,`current-key:${a}`),"demo");
  await assert.rejects(()=>decryptMemberText(text,ROOT,`current-key:${b}`));
}));
test("master Gate account and another member's Gate account cannot be claimed",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue();
  assert.equal((await h.rpc(`/claim-account?id=${a.id}`,{accountHash:await digestMember("gate-user:primary-test")})).status,409);
  const hash=await digestMember("gate-user:distinct");assert.equal((await h.rpc(`/claim-account?id=${a.id}`,{accountHash:hash})).status,200);
  assert.equal((await h.rpc(`/claim-account?id=${b.id}`,{accountHash:hash})).status,409);
}));
test("bounded admission never evicts an already enabled member or counts the master",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),c=await h.issue();
  for(const m of [a,b])assert.equal((await h.rpc(`/seat?id=${m.id}`,{enabled:true})).status,200);
  assert.equal((await h.rpc(`/seat?id=${c.id}`,{enabled:true})).status,409);
  assert.equal((await h.rpc(`/seat?id=${a.id}`,{enabled:true})).status,200);
  await h.rpc(`/seat?id=${a.id}`,{enabled:false});assert.equal((await h.rpc(`/seat?id=${c.id}`,{enabled:true})).status,200);
}));
test("enabling A neither opens an old source nor changes B or the master",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue();h.source.positions=[trade()];const before=structuredClone(h.source);
  const aa=await h.member(a.id),bb=await h.member(b.id);assert.equal((await h.internal(a.id,"/live-mode",{enabled:true})).status,200);
  assert.equal(aa.gate.placed.length,0);assert.equal(bb.gate.requestCount,0);assert.equal(bb.engine.runtime.live.requestedEnabled,false);assert.deepEqual(h.source,before);
}));
test("new shared source ID is executed independently at each user's own equity and original leverage",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),aa=await h.member(a.id),bb=await h.member(b.id);
  bb.gate.account={...bb.gate.account,total:50,available:50};
  for(const m of [a,b])await h.internal(m.id,"/live-mode",{enabled:true});
  now+=10000;h.source.positions=[{...trade("ft-shared-new"),openedAt:now-5000}];
  const before=structuredClone(h.source);await Promise.all([aa.engine.alarm(),bb.engine.alarm()]);
  assert.equal(aa.gate.placed.length,1);assert.equal(bb.gate.placed.length,1);assert.equal(aa.gate.placed[0].notional,20);assert.equal(bb.gate.placed[0].notional,10);
  assert.equal(aa.gate.placed[0].leverage,2);assert.equal(bb.gate.placed[0].leverage,2);assert.deepEqual(h.source,before);assert.equal(h.events.d1,0);
  assert.ok(aa.storage.data.has(`${LIVE_PARITY_PREFIX}binding:ft-shared-new`));assert.ok(bb.storage.data.has(`${LIVE_PARITY_PREFIX}binding:ft-shared-new`));
}));
test("member OFF leaves held positions protected and follows the same source close",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await h.internal(a.id,"/live-mode",{enabled:true});
  now+=10000;const t={...trade("ft-close-me"),openedAt:now-5000};h.source.positions=[t];await aa.engine.alarm();now+=10000;await aa.engine.alarm();
  await h.internal(a.id,"/live-mode",{enabled:false});assert.equal(aa.gate.closeTags.length,0);assert.ok(aa.gate.stops.length>0);
  now+=10000;h.source.history=[{...t,status:"CLOSED",closedAt:now,exitReason:"original-source-exit"}];h.source.positions=[];
  await aa.engine.alarm();now+=10000;await aa.engine.alarm();assert.equal(aa.gate.closeTags.length,1);assert.equal(aa.engine.runtime.live.positions.BTC_USDT.status,"CLOSED");
}));
test("member position, key identity and original activation survive restart without a second entry",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;
  h.source.positions=[{...trade("ft-persisted"),openedAt:now-1000}];await aa.engine.alarm();now+=10000;await aa.engine.alarm();await aa.engine.saveCheckpoint(now,true);
  const epoch=structuredClone(aa.engine.runtime.live.activation),c=context(aa.storage),restored=new MemberExecutor(c.ctx as never,h.env) as any;await c.ready();restored.liveClient=aa.gate;
  now+=10000;await restored.alarm();assert.deepEqual(restored.runtime.live.activation,epoch);assert.equal(aa.gate.placed.length,1);assert.equal(restored.runtime.live.positions.BTC_USDT.id,"ft-persisted");
}));
test("new B key creation while A holds a position cannot change A's checkpoint or intent",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;
  h.source.positions=[{...trade("ft-a-stable"),openedAt:now-1000}];await aa.engine.alarm();const storage=structuredClone([...aa.storage.data]);await h.issue("next friend");
  assert.deepEqual([...aa.storage.data],storage);assert.equal(aa.engine.runtime.live.requestedEnabled,true);
}));
test("a storage failure cannot submit a member market order or erase another user",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),aa=await h.member(a.id),bb=await h.member(b.id);
  await h.internal(a.id,"/live-mode",{enabled:true});const before=structuredClone([...bb.storage.data]);aa.storage.fail=true;now+=10000;
  h.source.positions=[{...trade("ft-storage-fail"),openedAt:now-1000}];await aa.engine.alarm();assert.equal(aa.gate.placed.length,0);assert.deepEqual([...bb.storage.data],before);
}));
test("a failing member Gate does not block a different member's copy or main-source reads",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),aa=await h.member(a.id),bb=await h.member(b.id);
  for(const m of [a,b])await h.internal(m.id,"/live-mode",{enabled:true});aa.gate.failSnapshot=true;now+=10000;h.source.positions=[{...trade("ft-still-copy"),openedAt:now-1000}];
  await Promise.all([aa.engine.alarm(),bb.engine.alarm()]);assert.equal(bb.gate.placed.length,1);assert.equal(aa.gate.placed.length,0);assert.equal(aa.engine.runtime.live.requestedEnabled,true);
}));
test("admin usage projection contains volume only and rejects invalid totals",()=>clock(async()=>{
  const h=await harness(),a=await h.issue();await h.rpc(`/usage?id=${a.id}`,{notional:123.45,fills:3,through:now-1000,reportedAt:now,partial:false,error:false,balance:999,apiKey:"must-not-leak"});
  const v=await(await h.rpc("/overview")).json<any>(),row=v.members[0];assert.equal(row.usage.notional,123.45);assert.equal(row.usage.balance,undefined);assert.ok(!JSON.stringify(row).includes("apiKey"));
  assert.equal((await h.rpc(`/usage?id=${a.id}`,{notional:-1,fills:3,reportedAt:now})).status,400);
}));
test("program-volume attribution excludes another program/manual tag even when regex prefix matches",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await aa.storage.put(`member-program-tag:${liveEntryTag("mine")}`,true);
  const rows=await aa.engine.turnoverRows([{id:"1",text:liveEntryTag("mine")},{id:"2",text:liveExitTag("not-mine")},{id:"3",text:"manual"}]);
  assert.equal(rows[0].text,liveEntryTag("mine"));assert.equal(rows[1].text,"");assert.equal(rows[2].text,"");
}));
test("corrupt execution checkpoint fails closed without resetting a member identity",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await aa.engine.saveCheckpoint(now,true);
  const saved=aa.storage.data.get("member-execution:v1:checkpoint") as any;saved.bytes[0]^=1;
  const c=context(aa.storage),e=new MemberExecutor(c.ctx as never,h.env) as any;await c.ready();assert.ok(e.bootError);assert.equal(e.identity.id,a.id);
  assert.equal(aa.storage.data.has("member-execution:v1:checkpoint"),true);
}));
test("pure strategy, core owner authentication and original credentials format remain byte-identical",()=>{
  const baseline=JSON.parse(readFileSync(new URL("./ui-authority-baseline.json",import.meta.url),"utf8"));
  for(const [path,hash]of Object.entries(baseline)){const raw=readFileSync(new URL("../"+path,import.meta.url));assert.equal(createHash("sha256").update(raw).digest("hex"),hash,path);}
  const source=readFileSync(new URL("../worker/member-executor.ts",import.meta.url),"utf8");assert.doesNotMatch(source,/this\.env\.DB|advanceForward\(|processBooks\(|fetchActiveContracts\(/);
  assert.match(source,/super\(ctx,env,true\)/);assert.match(source,/class MemberExecution extends Base/);
});
test("additive migration retains MarketStream namespace and does not delete or rename existing data",()=>{
  const c=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
  assert.equal(c.migrations[5].tag,"v6-liquidity-three-state");assert.equal(c.migrations[6].tag,"v7-delete-legacy-do");
  assert.deepEqual(c.migrations[7],{tag:"v8-isolated-member-accounts",new_sqlite_classes:["MemberDirectory","MemberExecutor"]});
  assert.deepEqual(c.durable_objects.bindings[0],{name:"MARKET_STREAM",class_name:"MarketStream"});
});
test("primary Member-feed read is a projection with no changes to the active main ledger",()=>clock(async()=>{
  const storage=new Memory(),c=context(storage),env={OWNER_ACCESS_TOKEN:ROOT,DB:{prepare(){throw new Error("D1 forbidden");}}};
  const p=new MarketStream(c.ctx as never,env as never) as any;await c.ready();p.forwardState=initialForward(T-1000);p.forwardState.positions=[trade()];
  const before=structuredClone(p.forwardState),writes=storage.writes;
  const r=await p.fetch(new Request("https://primary/member-feed"));assert.equal(r.status,200);assert.deepEqual(p.forwardState,before);assert.equal(storage.writes,writes);
}));test("primary owner runtime remains usable when the membership namespace is unavailable",()=>clock(async()=>{
  const h=await harness(),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  h.env.MEMBERS={getByName(){throw new Error("directory outage");}};
  h.env.MARKET_STREAM={getByName(){return{async fetch(input:string){assert.ok(input.endsWith("/owner-runtime"));return Response.json({live:{requestedEnabled:true},primaryUnchanged:true});}};}};
  const r=await h.http("/api/runtime",owner);assert.equal(r.status,200);assert.equal((await r.json<any>()).primaryUnchanged,true);
  assert.equal((await h.http("/api/members/admin",owner)).status,503);
}));
test("an authenticated member cannot access another member's binding or primary credentials",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),aa=await h.member(a.id);await h.member(b.id);
  await aa.storage.put(`${LIVE_PARITY_PREFIX}binding:ft-secret`,{secret:"A-only"});
  const cookie=memberCookie(await issueMemberSession(ROOT,b.id,1));
  assert.equal((await h.http("/api/live/source?id=ft-secret",cookie)).status,404);
  const status=await h.http("/api/live/credentials",cookie);assert.equal(status.status,200);assert.equal((await status.json<any>()).credential.keyHint,"test");
  assert.equal(h.events.d1,0);
}));
test("issuing twenty inactive users cannot schedule trading or start source collection",()=>clock(async()=>{
  const h=await harness();for(let i=0;i<20;i++)await h.issue();
  assert.equal(h.events.primaryReads,0);assert.equal(h.events.d1,0);assert.equal(h.actors.size,0);
  assert.equal((await h.rpc("/issue",{label:"overflow",requestId:"capacity-overflow-key"})).status,409);
}));
test("ordinary viewers reuse a shared ten-second projection instead of multiplying primary reads",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue();await h.internal(a.id,"/status");now+=5000;await h.internal(b.id,"/status");
  assert.equal(h.events.primaryReads,1);now+=6000;await h.internal(a.id,"/status");assert.equal(h.events.primaryReads,2);
}));
test("repeated ON preserves activation; OFF then ON excludes intervening PAPER orders",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await h.internal(a.id,"/live-mode",{enabled:true});const first=structuredClone(aa.engine.runtime.live.activation);
  now+=10000;await h.internal(a.id,"/live-mode",{enabled:true});assert.deepEqual(aa.engine.runtime.live.activation,first);
  await h.internal(a.id,"/live-mode",{enabled:false});now+=10000;h.source.positions=[{...trade("ft-while-off"),openedAt:now-1000}];
  await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;await aa.engine.alarm();assert.equal(aa.gate.placed.length,0);
  assert.ok(aa.engine.runtime.live.activation.enabledAt>first.enabledAt);
}));
test("negative, future or private usage fields never create invented published member turnover",()=>clock(async()=>{
  const h=await harness(),a=await h.issue();for(const through of ["invalid",-1,now+5000]){
    const r=await h.rpc(`/usage?id=${a.id}`,{notional:1,fills:1,through,reportedAt:now,partial:false,error:false});assert.equal(r.status,400);
  }
  const overview=await(await h.rpc("/overview")).json<any>();assert.equal(overview.members[0].usage,null);
}));
test("primary trading, main alarm, source evaluation and owner switch bodies are exactly unchanged",async()=>{
  const ts=(await import("typescript")).default;
  const source=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8"),tree=ts.createSourceFile("worker.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const main=tree.statements.find((x:any)=>ts.isClassDeclaration(x)&&x.name?.text==="MarketStream") as any;
  const baseline=JSON.parse(readFileSync(new URL("./member-method-baseline.json",import.meta.url),"utf8"));
  for(const [name,sha]of Object.entries(baseline.methods)){const method=main.members.find((x:any)=>x.name?.getText(tree)===name);assert.ok(method?.body,name);
    assert.equal(createHash("sha256").update(method.body.getText(tree)).digest("hex"),sha,`${name}: existing primary logic must not change`);}
});


test("history reader preserves authenticated member namespace and denies guests",()=>clock(async()=>{
 const h=await harness(),a=await h.issue("A"),b=await h.issue("B");
 const aa=await h.member(a.id),bb=await h.member(b.id);
 aa.gate.credentials={environment:"testnet",apiKey:"synthetic-A"};bb.gate.credentials={environment:"testnet",apiKey:"synthetic-B"};
 aa.gate.positionCloseHistory=async()=>[];bb.gate.positionCloseHistory=async()=>[];
 aa.engine.liveHistory=[{id:"only-A",symbol:"BTC_USDT",side:"LONG",status:"CLOSED",entryPrice:100,exchangeSize:1,entryAt:now-50000,exitAt:now-10000}];
 bb.engine.liveHistory=[{id:"only-B",symbol:"ETH_USDT",side:"LONG",status:"CLOSED",entryPrice:100,exchangeSize:1,entryAt:now-50000,exitAt:now-10000}];
 assert.equal((await h.http("/api/live/history")).status,401);
 const cookie=memberCookie(await issueMemberSession(ROOT,a.id,1));
 const response=await h.http(`/api/live/history?memberId=${b.id}`,cookie);assert.equal(response.status,200);
 const value=await response.json<any>();assert.equal(value.history[0].id,"only-A");assert.ok(!JSON.stringify(value).includes("only-B"));
 await Promise.all(aa.c.tasks);await Promise.all(bb.c.tasks);
}));
