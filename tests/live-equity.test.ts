/* eslint-disable @typescript-eslint/no-explicit-any -- isolated real-Worker host, no exchange network */
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {Memory} from './member-fixtures.ts';
import {observeLiveAccount,type LiveAccountMark} from '../lib/live-account-view.ts';
import {prepareLiveEquity,liveEquityView,LiveEquityReader,LIVE_EQUITY_PREFIX,LIVE_EQUITY_SAMPLE_MS,validLiveEquityCursor} from '../lib/live-equity.ts';
import {OPTIONAL_WRITE_GUARD_PER_DAY,PAID_PLAN_PLANNED_MONTHLY_ROWS,PAID_PLAN_ROW_SAFETY_LIMIT} from '../lib/forward-write-budget.ts';
import {startLiveSession} from '../lib/live-session.ts';
import {createOwnerSession,ownerSessionCookie} from '../lib/owner-auth.ts';
import {issueMemberSession,memberCookie} from '../lib/member-auth.ts';
register('./worker-test-loader.mjs',import.meta.url);
const {MarketStream,MemberExecutor,default:worker}=await import('../worker/index-clean.ts');
const T=1790809800000,STEP=LIVE_EQUITY_SAMPLE_MS,ROOT='synthetic-live-curve-test-root';
function mark(at=T,equity=100,sessionAt=T,previous?:LiveAccountMark,user='synthetic-gate'){
  return observeLiveAccount({account:{user,total:equity-2,unrealised_pnl:2,available:80},positions:[],orders:[],priceOrders:[],checkedAt:at},sessionAt,previous);
}
class ChartMemory extends Memory {
  reads=0;
  async list<T>(o:{prefix:string;startAfter?:string;end?:string;limit?:number;reverse?:boolean}){
    this.reads++;const rows=[...this.data].filter(([k])=>k.startsWith(o.prefix)&&(!o.startAfter||k>o.startAfter)&&(!o.end||k<o.end)).sort(([a],[b])=>a.localeCompare(b));
    if(o.reverse)rows.reverse();return new Map(rows.slice(0,o.limit??Infinity)) as Map<string,T>;
  }
}
test('native equity, minute sampling and invalid/off marks never synthesize a PAPER point',()=>{
  const first=mark(),a=prepareLiveEquity(first,true,T,null,T)!;assert.equal(a.head.initialEquity,100);assert.equal(a.value.point.equity,100);
  const next=mark(T+STEP,87,T,first),b=prepareLiveEquity(next,true,T,a.head,T+STEP)!;
  assert.equal(b.head.initialEquity,100);assert.equal(b.value.point.equity,87);
  for(const [m,enabled,session,at] of [[next,false,T,T+STEP],[next,true,T+1,T+STEP],
    [{...next,equity:NaN},true,T,T+STEP],[next,true,T,T+STEP+30001],[{...next,at:T+STEP+1},true,T,T+STEP]] as const)
    assert.equal(prepareLiveEquity(m,enabled,session,a.head,at),null);
  assert.equal(prepareLiveEquity(mark(T+10000,99,T,first),true,T,a.head,T+10000),null);
  assert.equal(prepareLiveEquity(mark(T+STEP-1,99,T,first),true,T,a.head,T+STEP-1),null);
});
test('a day of frequent existing native marks stays within optional capacity and preserves legacy five-minute heads',()=>{
  let previous=mark(),head=prepareLiveEquity(previous,true,T,null,T)!.head,rows=1;
  const legacy=structuredClone(head);
  for(let elapsed=10000;elapsed<86400000;elapsed+=10000){
    const now=T+elapsed,m=mark(now,100+Math.sin(elapsed/60000),T,previous);
    const p=prepareLiveEquity(m,true,T,head,now);previous=m;
    if(p){assert.ok(p.head.lastAt-head.lastAt>=60000);assert.ok(JSON.stringify(p.value).length<1024);head=p.head;rows++;}
  }
  assert.equal(rows,1440);assert.ok(rows<OPTIONAL_WRITE_GUARD_PER_DAY*.02);
  assert.ok(PAID_PLAN_PLANNED_MONTHLY_ROWS<PAID_PLAN_ROW_SAFETY_LIMIT,'curve writes remain inside the existing optional lane');
  const oldHead={...legacy,lastAt:T+300000,lastEquity:90};
  const resumed=prepareLiveEquity(mark(T+360000,91,T,previous),true,T,oldHead,T+360000)!;
  assert.equal(resumed.head.startedAt,oldHead.startedAt);assert.equal(resumed.head.sessionAt,T);
  assert.equal(resumed.head.initialEquity,oldHead.initialEquity);assert.equal(resumed.head.lastAt,T+360000);
  assert.deepEqual(legacy,prepareLiveEquity(mark(),true,T,null,T)!.head);
});
test('OFF freezes the saved session; ON changes identity and cannot preview an old session or account',()=>{
  const first=mark(),head=prepareLiveEquity(first,true,T,null,T)!.head;
  assert.equal(liveEquityView(head,mark(T+STEP,10000,T,first),false,T,T+STEP)!.data.equity,100);
  assert.equal(liveEquityView(head,first,true,T+STEP,T+STEP),null);
  assert.equal(liveEquityView(head,{...first,accountUser:'other'},true,T,T)!.healthy,false);
  const second=mark(T+STEP,77,T+STEP),newHead=prepareLiveEquity(second,true,T+STEP,head,T+STEP)!.head;
  assert.equal(newHead.initialEquity,77);assert.equal(newHead.startedAt,T+STEP);assert.notEqual(newHead.sessionAt,head.sessionAt);
});
test('live equity reader pages every recorded point, reads only newer rows after, and rejects foreign cursors',async()=>{
  const storage=new ChartMemory(),reader=new LiveEquityReader();let previous=mark(),head=prepareLiveEquity(previous,true,T,null,T)!.head;
  for(let i=0;i<=150;i++){
    const m=mark(T+i*STEP,100+i,T,previous),p=prepareLiveEquity(m,true,T,i?head:null,m.at)!;
    head=p.head;previous=m;await storage.put(p.key,p.value);
  }
  let now=T+151*STEP;const seen=new Map<number,number>();let cursor:string|null=null,pages=0,newest:string|null=null;
  do{const page:any=await reader.read(storage,head,cursor,now);pages++;if(pages===1)newest=page.newestCursor??null;
    for(const point of page.points)seen.set(point.at,point.equity);cursor=page.nextCursor;}while(cursor&&pages<10);
  assert.equal(seen.size,151);assert.equal(pages,3);assert.ok(newest&&validLiveEquityCursor(newest));
  const p=prepareLiveEquity(mark(T+151*STEP,251,T,previous),true,T,head,now)!;head=p.head;await storage.put(p.key,p.value);now+=60001;
  const after:any=await reader.read(storage,head,null,now,newest);
  assert.deepEqual(after.points.map((x:any)=>x.equity),[251]);
  await assert.rejects(reader.read(storage,head,'live-equity:v1:0000000000000001:0000000000000002',now),/INVALID_CURSOR/);
});
function ownerHost(storage=new ChartMemory()){
  const engine=new MarketStream({storage,waitUntil(){}} as never,{} as never,true) as any;
  engine.runtime.live.requestedEnabled=true;engine.runtime.live.activation=startLiveSession(T,{startedAt:T-1,positions:[]});
  engine.runtime.live.accountMark=mark();return {engine,storage};
}
test('real owner checkpoint commits curve rows atomically; failures retain the old head and retry',async()=>{
  const {engine,storage}=ownerHost();await engine.saveCheckpoint(T,true);
  assert.equal(engine.runtime.live.equityCurve.initialEquity,100);assert.equal(storage.data.get('checkpoint')&&(storage.data.get('checkpoint') as any).live.equityCurve.lastAt,T);
  const old=structuredClone(engine.runtime.live.equityCurve);engine.runtime.live.accountMark=mark(T+STEP,91,T,engine.runtime.live.accountMark);
  storage.fail=true;await assert.rejects(engine.saveCheckpoint(T+STEP,true),/storage failure/);assert.deepEqual(engine.runtime.live.equityCurve,old);
  storage.fail=false;await engine.saveCheckpoint(T+STEP,true);assert.equal(engine.runtime.live.equityCurve.lastEquity,91);
  assert.equal([...storage.data.keys()].filter(k=>k.startsWith(LIVE_EQUITY_PREFIX)).length,2);
  const checkpoint=await storage.get<any>('checkpoint'),restored=ownerHost(storage).engine;restored.runtime=checkpoint;
  await restored.saveCheckpoint(T+STEP,true);assert.equal([...storage.data.keys()].filter(k=>k.startsWith(LIVE_EQUITY_PREFIX)).length,2);
  const page=await (await restored.privateLiveEquity(new URL(`https://fixture/live-equity?session=${T}`))).json();assert.equal(page.context.initialEquity,100);
  assert.equal((await restored.privateLiveEquity(new URL(`https://fixture/live-equity?session=${T+1}`))).status,409);
});
test('reader cursors never skip a concurrently committed point beyond the captured head',async()=>{
  const storage=new ChartMemory(),reader=new LiveEquityReader(),first=mark(),a=prepareLiveEquity(first,true,T,null,T)!;
  await storage.put(a.key,a.value);const b=prepareLiveEquity(mark(T+STEP,105,T,first),true,T,a.head,T+STEP)!;await storage.put(b.key,b.value);
  const old=await reader.read(storage,a.head,null,T+STEP);assert.equal(old.newestCursor,a.key);assert.equal(old.points.length,1);
  const next=await reader.read(storage,b.head,null,T+STEP,old.newestCursor!);assert.equal(next.points.length,1);assert.equal(next.points[0].equity,105);
});
test('optional chart admission cannot consume a critical execution journal or grow the hot checkpoint',async()=>{
  const {engine,storage}=ownerHost();engine.runtime.nonAlarmWrites=100000;engine.liveJournal.set('execution-fixture',{id:'protected-send'});
  await engine.saveCheckpoint(T,true);assert.deepEqual(await storage.get('execution-fixture'),{id:'protected-send'});assert.equal(engine.runtime.live.equityCurve,undefined);
  engine.runtime.nonAlarmWrites=0;let previous=mark();
  for(let i=0;i<300;i++){
    engine.runtime.live.accountMark=mark(T+i*STEP,100+i,T,previous);previous=engine.runtime.live.accountMark;
    await engine.saveCheckpoint(T+i*STEP,true);
  }
  assert.equal([...storage.data.keys()].filter(k=>k.startsWith(LIVE_EQUITY_PREFIX)).length,300);
  assert.ok(JSON.stringify(engine.runtime.live.equityCurve).length<350);assert.equal(Array.isArray(engine.runtime.live.equityCurve.points),false);
});
test('real member checkpoint restores its own curve and OFF/ON starts a new curve without touching old rows',async()=>{
  const storage=new ChartMemory(),id='m_'+ 'a'.repeat(32);await storage.put('member-execution:v1:identity',{id,label:'test',createdAt:T-1});
  let ready=Promise.resolve();const ctx={storage,waitUntil(){},blockConcurrencyWhile(fn:()=>Promise<void>){ready=fn();}};
  const engine=new MemberExecutor(ctx as never,{OWNER_ACCESS_TOKEN:ROOT} as never) as any;await ready;
  engine.runtime.live.requestedEnabled=true;engine.runtime.live.activation=startLiveSession(T,{startedAt:T-1,positions:[]});engine.runtime.live.accountMark=mark();
  await engine.saveCheckpoint(T,true);const restarted=new MemberExecutor(ctx as never,{OWNER_ACCESS_TOKEN:ROOT} as never) as any;await ready;
  assert.equal(restarted.runtime.live.equityCurve.initialEquity,100);
  restarted.runtime.live.requestedEnabled=false;restarted.runtime.live.accountMark=mark(T+10000,20,T,engine.runtime.live.accountMark);await restarted.saveCheckpoint(T+10000,true);
  assert.equal(restarted.runtime.live.equityCurve.lastEquity,100);
  restarted.runtime.live.requestedEnabled=true;restarted.runtime.live.activation=startLiveSession(T+STEP,{startedAt:T-1,positions:[]});
  assert.equal((await restarted.privateLiveEquity(new URL(`https://fixture/live-equity?session=${T+STEP}`))).status,503);
  restarted.runtime.live.accountMark=mark(T+STEP,80,T+STEP);await restarted.saveCheckpoint(T+STEP,true);
  assert.equal(restarted.runtime.live.equityCurve.initialEquity,80);assert.equal(storage.data.size,4);
});
test('HTTP curve GET requires identity; owner and member read only their actor without Gate or mutations',async()=>{
  const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('network forbidden');};
  try{
    let primary=0,member=0;const id='m_'+ 'b'.repeat(32),env:any={OWNER_ACCESS_TOKEN:ROOT,
      MEMBERS:{getByName:()=>({fetch:async()=>Response.json({id,label:'member',version:1,createdAt:T-1})})},
      MEMBER_EXECUTION:{getByName:(name:string)=>{assert.equal(name,`member:${id}`);return {fetch:async(input:string,init:any)=>{member++;assert.equal(init.headers.get('x-verified-member'),id);assert.equal(new URL(input).search,'?session=123');return Response.json({member:true});}};}},
      MARKET_STREAM:{getByName:()=>({fetch:async(input:string)=>{primary++;assert.equal(new URL(input).pathname,'/live-equity');return Response.json({owner:true});}})}};
    const request=(cookie='')=>new Request('https://fixture/api/live/equity?session=123',{headers:{Cookie:cookie}});
    assert.equal((await worker.fetch(request(),env,{} as never)).status,401);assert.equal(primary+member,0);
    assert.deepEqual(await(await worker.fetch(request(ownerSessionCookie(await createOwnerSession(ROOT))),env,{} as never)).json(),{owner:true});
    assert.deepEqual(await(await worker.fetch(request(memberCookie(await issueMemberSession(ROOT,id,1))),env,{} as never)).json(),{member:true});
    assert.equal(primary,1);assert.equal(member,1);
  }finally{globalThis.fetch=old;}
});
