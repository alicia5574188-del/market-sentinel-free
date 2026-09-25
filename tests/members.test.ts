/* eslint-disable @typescript-eslint/no-explicit-any -- test-only host and protected executor inspection; no real network */
import test from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {Memory,FakeGate,T,trade} from "./member-fixtures.ts";
import {advanceForward,initialForward} from "../lib/forward-relations.ts";
import {newExitControl} from "../lib/forward-protection.ts";
import {MEMBERS_VERSION,MEMBER_LIMIT,memberCookie,issueMemberSession,verifyMemberSession,digestMember,memberVaultRoot,encryptMemberText,decryptMemberText} from "../lib/member-auth.ts";
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
  async function issue(_label="test"){
    const n=++sequence,overview=await(await rpc("/overview")).json<any>(),username=`member_${n}`,password=`test-password-${n}`;
    const r=await rpc("/register",{inviteCode:overview.invite.code,username,password,requestId:`idempotent-test-${n}`});
    assert.equal(r.status,200);const value=await r.json<any>();return {...value.member,username,password};
  }
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
test("registered username/password remains valid after the next invite rotates",()=>clock(async()=>{
  const h=await harness(),a=await h.issue("甲"),b=await h.issue("乙");assert.notEqual(a.id,b.id);
  for(let i=0;i<2;i++){const r=await h.rpc("/login",{username:a.username,password:a.password,bucket:"a".repeat(64)});assert.equal(r.status,200);assert.equal((await r.json<any>()).id,a.id);}
  const listing=await(await h.rpc("/overview")).json<any>();assert.equal(listing.members.length,2);assert.equal(listing.current,undefined);
  assert.ok(listing.members.every((m:any)=>m.username));assert.ok(listing.members.find((m:any)=>m.id===a.id).activatedAt);
}));
test("simultaneous repeated registration request commits a single user",()=>clock(async()=>{
  const h=await harness(),overview=await(await h.rpc("/overview")).json<any>(),
    body={inviteCode:overview.invite.code,username:"one_user",password:"strong-pass-one",requestId:"concurrent-request-123"};
  const [a,b]=await Promise.all([h.rpc("/register",body),h.rpc("/register",body)]);const x=await a.json<any>(),y=await b.json<any>();
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(x.member.id,y.member.id);
  assert.equal((await(await h.rpc("/overview")).json<any>()).members.length,1);
}));
test("registration retry authenticates the original password before returning a session",()=>clock(async()=>{
  const h=await harness(),overview=await(await h.rpc("/overview")).json<any>(),
    body={inviteCode:overview.invite.code,username:"retry_user",password:"original-password",requestId:"auth-retry-request-01"};
  const registered=await h.http("/api/members/register","",body);assert.equal(registered.status,200);
  const original=await registered.json<any>();
  const wrong=await h.http("/api/members/register","",{...body,password:"different-password"});
  assert.equal(wrong.status,409);assert.equal(wrong.headers.has("set-cookie"),false);
  const retry=await h.http("/api/members/register","",body);assert.equal(retry.status,200);
  assert.equal((await retry.json<any>()).memberId,original.memberId);
}));

test("invalid registration invitations are rejected before password derivation",()=>clock(async()=>{
  const h=await harness();let derivations=0;const original=crypto.subtle.deriveBits.bind(crypto.subtle);
  crypto.subtle.deriveBits=async(...args)=>{derivations++;return original(...args);};
  try {
    const r=await h.rpc("/register",{inviteCode:"INV-"+"A".repeat(24),username:"invalid_invite_user",password:"synthetic-password",requestId:"invalid-invite-test-01"});
    assert.equal(r.status,409);assert.equal(derivations,0);assert.equal(await h.dstore.get("member-count"),undefined);
  }finally{crypto.subtle.deriveBits=original;}
}));

test("finalizing an older deletion preserves a replacement user's username index",()=>clock(async()=>{
  const h=await harness(),a=await h.issue();
  assert.equal((await h.rpc(`/begin-delete?id=${a.id}`,{})).status,200);
  const overview=await(await h.rpc("/overview")).json<any>();
  const registered=await h.rpc("/register",{inviteCode:overview.invite.code,username:a.username,password:"replacement-password",requestId:"replacement-user-01"});
  assert.equal(registered.status,200);const replacement=await registered.json<any>();
  assert.equal((await h.rpc(`/finalize-delete?id=${a.id}`,{})).status,200);
  const login=await h.rpc("/login",{username:a.username,password:"replacement-password",bucket:"b".repeat(64)});
  assert.equal(login.status,200);assert.equal((await login.json<any>()).id,replacement.member.id);
}));

test("owner can finish deletion after executor erasure succeeded but directory finalization failed",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),owner=ownerSessionCookie(await createOwnerSession(ROOT));await h.internal(a.id,"/status");
  const original=h.directory.fetch.bind(h.directory);let fail=true;
  h.directory.fetch=async(request:Request)=>{
    if(new URL(request.url).pathname==="/finalize-delete"&&fail){fail=false;return Response.json({error:"injected transient directory failure"},{status:503});}
    return original(request);
  };
  assert.equal((await h.http("/api/members/delete",owner,{id:a.id})).status,503);
  const actor=h.actors.get(a.id);assert.ok(await actor.storage.get("member-execution:v1:deleted"));
  const restarted=context(actor.storage);actor.engine=new MemberExecutor(restarted.ctx as never,h.env);await restarted.ready();
  assert.equal((await h.internal(a.id,"/status")).status,410);
  const removed=await h.http("/api/members/delete",owner,{id:a.id});assert.equal(removed.status,200);
  assert.equal(await h.dstore.get(`member:${a.id}`),undefined);
  assert.equal(await h.dstore.get("member-count"),0);
  assert.equal((await h.http("/api/members/resume",owner,{id:a.id})).status,404);
}));

test("deletion atomically retains original state when the tombstone write fails and retries safely",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),owner=ownerSessionCookie(await createOwnerSession(ROOT));await h.internal(a.id,"/status");
  const actor=h.actors.get(a.id),put=actor.storage.put.bind(actor.storage);
  await actor.storage.put(Object.fromEntries(Array.from({length:260},(_,i)=>[`test-archive:${i}`,{i}])));
  let fail=true;actor.storage.put=async(key:string|Record<string,unknown>,value?:unknown)=>{
    if(key==="member-execution:v1:deleted"&&fail){fail=false;throw new Error("injected tombstone failure");}
    return put(key,value);
  };
  assert.equal((await h.http("/api/members/delete",owner,{id:a.id})).status,409);
  assert.equal((await actor.storage.get("member-execution:v1:identity")).id,a.id);
  assert.deepEqual(await actor.storage.get("test-archive:259"),{i:259});
  const restarted=context(actor.storage);actor.engine=new MemberExecutor(restarted.ctx as never,h.env);await restarted.ready();
  assert.equal((await h.http("/api/members/delete",owner,{id:a.id})).status,200);
  assert.deepEqual([...actor.storage.data.keys()],["member-execution:v1:deleted"]);
}));

test("owner cleanup can finish a legacy anonymous tombstone without restoring member access",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),owner=ownerSessionCookie(await createOwnerSession(ROOT));await h.internal(a.id,"/status");
  await h.rpc(`/begin-delete?id=${a.id}`,{});const actor=h.actors.get(a.id);
  await actor.storage.deleteAll();await actor.storage.put("member-execution:v1:deleted",{id:"deleted",at:now});
  const restarted=context(actor.storage);actor.engine=new MemberExecutor(restarted.ctx as never,h.env);await restarted.ready();
  assert.equal((await h.internal(a.id,"/status")).status,410);
  assert.equal((await h.http("/api/members/delete",owner,{id:a.id})).status,200);
  assert.equal(await h.dstore.get(`member:${a.id}`),undefined);
}));

test("deletion drains turnover and invalidates delayed settlement writes before erasure",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  const opened=now-620000,closed=now-15000,id="source-delete-settlement";
  aa.gate.credentials={environment:"testnet",apiKey:"synthetic-delete"};
  aa.engine.liveHistory=[{id,symbol:"BTC_USDT",side:"LONG",status:"CLOSED",entryAt:opened+10000,exitAt:closed+5000,
    entryPrice:100,exchangeSize:.1,parity:{sourceId:id,copiedAt:opened,roundedContracts:.1}}];
  let releaseHistory!:()=>void,historyStarted!:()=>void,releaseTurnover!:()=>void,turnoverDrained!:()=>void;
  const historyHold=new Promise<void>(r=>{releaseHistory=r;}),historyStart=new Promise<void>(r=>{historyStarted=r;});
  aa.gate.positionCloseHistory=async()=>{historyStarted();await historyHold;return [{contract:"BTC_USDT",side:"long",time:closed/1000,
    first_open_time:opened/1000,pnl:"-.07",text:liveExitTag(id),max_size:".1",accum_size:".1",long_price:"100",short_price:"103"}];};
  await aa.engine.privateLiveHistory();await historyStart;
  const turnoverHold=new Promise<void>(r=>{releaseTurnover=r;}),turnoverStart=new Promise<void>(r=>{turnoverDrained=r;}),
    turnover=turnoverHold.then(()=>aa.storage.put("late-turnover",{amount:1}));
  Object.defineProperty(aa.engine,"turnoverWork",{configurable:true,get(){turnoverDrained();return turnover;},set(){}});
  const deleting=h.http("/api/members/delete",owner,{id:a.id});await turnoverStart;
  assert.equal(aa.engine.liveClient,null);releaseTurnover();assert.equal((await deleting).status,200);
  releaseHistory();await Promise.all(aa.c.tasks);
  assert.deepEqual([...aa.storage.data.keys()],["member-execution:v1:deleted"]);
}));

test("final deletion refuses a credential mutation that started after the ready check",()=>clock(async()=>{
  const h=await harness(),a=await h.issue();await h.internal(a.id,"/status");const actor=h.actors.get(a.id);
  actor.engine.credentialBusy=true;
  const result=await actor.engine.adminDeleteFinalize(a.id);assert.equal(result.ok,false);
  assert.ok(await actor.storage.get("member-execution:v1:identity"));
  assert.equal(await actor.storage.get("member-execution:v1:deleted"),undefined);
}));

test("an already admitted ON request cannot undo a completed owner forced stop",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  const original=h.directory.fetch.bind(h.directory);let release!:()=>void,admitted!:()=>void;
  const waiting=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{admitted=r;});
  h.directory.fetch=async(request:Request)=>{
    const isEnable=new URL(request.url).pathname==="/seat"&&(await request.clone().json<any>()).enabled===true;
    const response=await original(request);
    if(isEnable&&response.ok){admitted();await waiting;}
    return response;
  };
  const enabling=h.internal(a.id,"/live-mode",{enabled:true});await started;
  try {assert.equal((await h.http("/api/members/stop",owner,{id:a.id})).status,200);}
  finally {release();}
  const result=await enabling;assert.equal(result.status,409);assert.equal(aa.engine.runtime.live.requestedEnabled,false);
  const intent=await aa.storage.get(`${LIVE_PARITY_PREFIX}owner-intent`);assert.equal(intent.enabled,false);
  assert.equal(aa.gate.placed.length,0);
}));

test("delayed LIVE request bodies cannot revive erased state or undo a newer owner stop",()=>clock(async()=>{
  for(const enabled of [false,true]) {
    const h=await harness(),a=await h.issue(),aa=await h.member(a.id),owner=ownerSessionCookie(await createOwnerSession(ROOT));
    let release!:()=>void,started!:()=>void;const hold=new Promise<void>(r=>{release=r;}),waiting=new Promise<void>(r=>{started=r;});
    const request=new Request("https://member/live-mode",{method:"POST",headers:{"x-verified-member":a.id,"x-member-created-at":String(a.createdAt)}});
    request.json=async()=>{started();await hold;return {enabled};};
    const pending=aa.engine.fetch(request);await waiting;
    try {assert.equal((await h.http(enabled?"/api/members/stop":"/api/members/delete",owner,{id:a.id})).status,200);}
    finally {release();}
    assert.equal((await pending).status,409);assert.equal(aa.engine.runtime.live.requestedEnabled,false);
    if(!enabled)assert.deepEqual([...aa.storage.data.keys()],["member-execution:v1:deleted"]);
  }
}));

test("a completed credential replacement invalidates an older pending ON request",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id),cookie=memberCookie(await issueMemberSession(ROOT,a.id,1));
  const original=h.directory.fetch.bind(h.directory);let release!:()=>void,admitted!:()=>void;
  const waiting=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{admitted=r;});
  h.directory.fetch=async(request:Request)=>{
    const isEnable=new URL(request.url).pathname==="/seat"&&(await request.clone().json<any>()).enabled===true;
    const response=await original(request);if(isEnable&&response.ok){admitted();await waiting;}return response;
  };
  aa.engine.saveCredential=async()=>{aa.engine.credential={...aa.engine.credential,keyHint:"replacement"};return {ok:true};};
  const enabling=h.internal(a.id,"/live-mode",{enabled:true});await started;
  try {assert.equal((await h.http("/api/live/credentials",cookie,{apiKey:"synthetic",apiSecret:"synthetic"},"PUT")).status,200);}
  finally {release();}
  assert.equal((await enabling).status,409);assert.equal(aa.engine.runtime.live.requestedEnabled,false);
  assert.equal((await h.dstore.get<string[]>("execution-seats"))?.includes(a.id),false);
}));
test("member passwords are salted hashes and no login key is created",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),text=JSON.stringify([...h.dstore.data]),row=await h.dstore.get<any>(`member:${a.id}`);
  assert.ok(!text.includes(a.password));assert.ok(row.password?.hash&&row.password.hash!==a.password);
  assert.equal(row.keyHash,undefined);assert.equal([...h.dstore.data.keys()].some(k=>k.startsWith("key:")),false);
}));
test("legacy key issuance endpoint is gone and members cannot use owner administration",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),member=memberCookie(await issueMemberSession(ROOT,a.id,1)),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  assert.equal((await h.http("/api/members/issue","",{requestId:"removed-key-issue"})).status,410);
  assert.equal((await h.http("/api/members/issue",owner,{requestId:"removed-owner-key-issue"})).status,410);
  assert.equal((await h.http("/api/members/admin",member)).status,403);
}));
test("member signature domain cannot become an owner session or another user's session",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),b=await h.issue(),token=await issueMemberSession(ROOT,a.id,1);
  assert.equal(await verifyMemberSession(new Request(ORIGIN,{headers:{Cookie:memberCookie(token.replace(a.id,b.id))}}),ROOT),null);
  const ownerCookie=ownerSessionCookie(token);assert.equal((await h.http("/api/members/admin",ownerCookie)).status,403);
  now+=31*86400000;assert.equal(await verifyMemberSession(new Request(ORIGIN,{headers:{Cookie:memberCookie(token)}}),ROOT),null);
}));
test("username/password login returns HttpOnly session and legacy key payload is rejected",()=>clock(async()=>{
  const h=await harness(),a=await h.issue();
  const r=await h.http("/api/members/login","",{username:a.username,password:a.password});assert.equal(r.status,200);
  const cookie=r.headers.get("set-cookie")!;assert.match(cookie,/ms_member_session=/);assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  const body=await r.json<any>();assert.equal(body.role,"member");assert.equal(body.memberId,a.id);
  assert.equal((await h.http("/api/members/login","",{key:"MS-"+"0".repeat(64)})).status,401);
  assert.equal((await h.http("/api/members/login","",{username:a.username,password:"wrong-pass"})).status,401);
}));
test("anonymous and cross-origin mutations cannot read runtime or create users",()=>clock(async()=>{
  const h=await harness();for(const path of ["/api/runtime","/api/forward/export","/api/live/status","/api/live/source?id=anything"])assert.equal((await h.http(path)).status,401);
  const cookie=ownerSessionCookie(await createOwnerSession(ROOT)),overview=await(await h.http("/api/members/admin",cookie)).json<any>();
  const r=await worker.fetch(new Request(ORIGIN+"/api/members/register",{method:"POST",headers:{Origin:"https://other.test","Content-Type":"application/json"},
    body:JSON.stringify({inviteCode:overview.invite.code,username:"cross_origin",password:"strong-pass-cross",requestId:"cross-origin-register"})}),h.env,{} as never);
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
  const text=await encryptMemberText("demo",ROOT,`member-invite:v1:${a}`);assert.equal(await decryptMemberText(text,ROOT,`member-invite:v1:${a}`),"demo");
  await assert.rejects(()=>decryptMemberText(text,ROOT,`member-invite:v1:${b}`));
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
test("committed PAPER source can wake an active member immediately without waiting the 10s alarm",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);assert.equal((await h.internal(a.id,"/live-mode",{enabled:true})).status,200);
  now+=1000;h.source.positions=[{...trade("ft-event-wake"),openedAt:now-100}];
  const seats=await h.directory.fetch(new Request("https://members/active-seats",{headers:{"x-member-wake-token":ROOT}}));
  assert.equal(seats.status,200);assert.deepEqual((await seats.json<any>()).ids,[a.id]);
  const wake=await h.env.MEMBER_EXECUTION.getByName(`member:${a.id}`).fetch("https://member-execution/source-wake",{
    method:"POST",headers:{"x-member-wake-token":ROOT},
  });
  assert.equal(wake.status,200);assert.equal((await wake.json<any>()).woken,true);assert.equal(aa.gate.placed.length,1);
  assert.equal(aa.engine.runtime.live.positions.BTC_USDT?.id,"ft-event-wake");
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
test("member inherits the same early protection source close without new strategy or switch action",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);
  await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;
  h.source.positions=[{...trade("ft-early-protection"),openedAt:now-5000,exitControl:newExitControl()}];
  await aa.engine.alarm();now+=10000;await aa.engine.alarm();
  const activation=structuredClone(aa.engine.runtime.live.activation);
  const update=(price:number)=>{h.source=advanceForward({state:h.source,now,paths:{},contracts:{},
    quotes:{BTC_USDT:{bestBid:price,bestAsk:price+.01,observedAt:now,fresh:true}}}).state;};
  now+=10000;update(101);await aa.engine.alarm();assert.equal(aa.gate.closeTags.length,0);
  now+=10000;update(100.6);assert.equal(h.source.history[0].exitAudit!.trigger,"PROFIT_GIVEBACK");
  assert.ok(now-h.source.history[0].openedAt<300000);
  await aa.engine.alarm();now+=10000;await aa.engine.alarm();
  assert.equal(aa.gate.closeTags.length,1);assert.equal(aa.gate.closeTags[0],liveExitTag("ft-early-protection"));
  assert.equal(aa.engine.runtime.live.positions.BTC_USDT.status,"CLOSED");
  assert.equal(aa.engine.runtime.live.requestedEnabled,true);assert.deepEqual(aa.engine.runtime.live.activation,activation);
  assert.equal(h.events.d1,0);assert.equal(aa.gate.placed.length,1);
}));
test("member position, account identity and original activation survive restart without a second entry",()=>clock(async()=>{
  const h=await harness(),a=await h.issue(),aa=await h.member(a.id);await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;
  h.source.positions=[{...trade("ft-persisted"),openedAt:now-1000}];await aa.engine.alarm();now+=10000;await aa.engine.alarm();await aa.engine.saveCheckpoint(now,true);
  const epoch=structuredClone(aa.engine.runtime.live.activation),c=context(aa.storage),restored=new MemberExecutor(c.ctx as never,h.env) as any;await c.ready();restored.liveClient=aa.gate;
  now+=10000;await restored.alarm();assert.deepEqual(restored.runtime.live.activation,epoch);assert.equal(aa.gate.placed.length,1);assert.equal(restored.runtime.live.positions.BTC_USDT.id,"ft-persisted");
}));
test("new member registration while A holds a position cannot change A's checkpoint or intent",()=>clock(async()=>{
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
test("owner authentication, credential format and member execution isolation remain frozen",()=>{
  const baseline=JSON.parse(readFileSync(new URL("./ui-authority-baseline.json",import.meta.url),"utf8"));
  for(const path of["lib/owner-auth.ts","lib/credential-vault.ts"]){
    const raw=readFileSync(new URL("../"+path,import.meta.url));
    assert.equal(createHash("sha256").update(raw).digest("hex"),baseline[path],path);
  }
  const source=readFileSync(new URL("../worker/member-executor.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/this\.env\.DB|advanceForward\(|processAdaptiveBooks\(|fetchActiveContracts\(/);
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
test("registering the bounded inactive member capacity cannot schedule trading or start source collection",()=>clock(async()=>{
  const h=await harness();for(let i=0;i<MEMBER_LIMIT;i++)await h.issue();
  assert.equal(h.events.primaryReads,0);assert.equal(h.events.d1,0);assert.equal(h.actors.size,0);
  const overview=await(await h.rpc("/overview")).json<any>();
  assert.equal((await h.rpc("/register",{inviteCode:overview.invite.code,username:"overflow_user",password:"strong-pass-overflow",requestId:"capacity-overflow-user"})).status,409);
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
test("owner LIVE switch remains frozen while the primary trading core is allowed to be rewritten",async()=>{
  const ts=(await import("typescript")).default;
  const source=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8"),tree=ts.createSourceFile("worker.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const main=tree.statements.find((x:any)=>ts.isClassDeclaration(x)&&x.name?.text==="MarketStream") as any;
  const baseline=JSON.parse(readFileSync(new URL("./member-method-baseline.json",import.meta.url),"utf8"));
  const method=main.members.find((x:any)=>x.name?.getText(tree)==="setLiveMode");assert.ok(method?.body);
  assert.equal(createHash("sha256").update(method.body.getText(tree)).digest("hex"),baseline.methods.setLiveMode,
    "owner LIVE control changed unexpectedly");
  assert.ok(main.members.some((x:any)=>x.name?.getText(tree)==="processAdaptiveBooks"));
  assert.ok(main.members.some((x:any)=>x.name?.getText(tree)==="advanceForwardNow"));
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


test("single-use invite registers username/password, rotates automatically and rejects reuse",()=>clock(async()=>{
  const h=await harness(),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  const first=await(await h.http("/api/members/admin",owner)).json<any>();
  assert.match(first.invite.code,/^INV-[A-F0-9]{24}$/);
  const requestId="register-user-one-0001";
  const registered=await h.http("/api/members/register","",{inviteCode:first.invite.code,username:"Alice_01",password:"strong-pass-01",requestId});
  assert.equal(registered.status,200);const body=await registered.json<any>();assert.equal(body.role,"member");assert.equal(body.username,"Alice_01");
  const after=await(await h.http("/api/members/admin",owner)).json<any>();
  assert.notEqual(after.invite.code,first.invite.code);assert.equal(after.members[0].username,"Alice_01");
  assert.equal((await h.http("/api/members/register","",{inviteCode:first.invite.code,username:"Bob_02",password:"strong-pass-02",requestId:"register-user-two-0002"})).status,409);
  assert.equal((await h.http("/api/members/login","",{username:"Alice_01",password:"strong-pass-01"})).status,200);
  assert.equal((await h.http("/api/members/login","",{username:"Alice_01",password:"wrong-pass"})).status,401);
}));

test("owner stop blocks member re-enable, resume only restores permission, and held risk keeps its seat",()=>clock(async()=>{
  const h=await harness(),a=await h.issue("stop-user"),aa=await h.member(a.id),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;
  h.source.positions=[{...trade("ft-admin-drain"),openedAt:now-1000}];await aa.engine.alarm();now+=10000;await aa.engine.alarm();
  let overview=await(await h.http("/api/members/admin",owner)).json<any>();assert.equal(overview.activeCount,1);
  const stop=await h.http("/api/members/stop",owner,{id:a.id});assert.equal(stop.status,200);
  assert.equal(aa.engine.runtime.live.requestedEnabled,false);assert.equal(aa.gate.closeTags.length,0);assert.ok(aa.gate.stops.length>0);
  overview=await(await h.http("/api/members/admin",owner)).json<any>();assert.equal(overview.activeCount,1);
  assert.equal((await h.internal(a.id,"/live-mode",{enabled:true})).status,409);
  const resume=await h.http("/api/members/resume",owner,{id:a.id});assert.equal(resume.status,200);
  assert.equal(aa.engine.runtime.live.requestedEnabled,false);
  assert.equal((await h.internal(a.id,"/live-mode",{enabled:true})).status,200);
}));

test("safe delete refuses while live risk exists, then removes login and releases capacity after normal source exit",()=>clock(async()=>{
  const h=await harness(),a=await h.issue("delete-user"),aa=await h.member(a.id),owner=ownerSessionCookie(await createOwnerSession(ROOT));
  await h.internal(a.id,"/live-mode",{enabled:true});now+=10000;
  const t={...trade("ft-delete-drain"),openedAt:now-1000};h.source.positions=[t];await aa.engine.alarm();now+=10000;await aa.engine.alarm();
  const blocked=await h.http("/api/members/delete",owner,{id:a.id});assert.equal(blocked.status,409);
  assert.equal(aa.engine.runtime.live.requestedEnabled,false);assert.equal(aa.gate.closeTags.length,0);
  now+=10000;h.source.history=[{...t,status:"CLOSED",closedAt:now,exitReason:"source-finished"}];h.source.positions=[];
  await aa.engine.alarm();now+=10000;await aa.engine.alarm();
  assert.equal(aa.engine.runtime.live.positions.BTC_USDT.status,"CLOSED");
  const deleted=await h.http("/api/members/delete",owner,{id:a.id});assert.equal(deleted.status,200);
  assert.equal((await h.rpc("/login",{username:a.username,password:a.password,bucket:"d".repeat(64)})).status,401);
  const listing=await(await h.http("/api/members/admin",owner)).json<any>();assert.equal(listing.members.some((m:any)=>m.id===a.id),false);
}));
