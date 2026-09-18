/* eslint-disable @typescript-eslint/no-explicit-any -- isolated Worker host fixtures, never production credentials */
import test from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {archivedEquity,mergeEquity,curveSegments,smoothPath,nearestPoint,equityReference,DAY_MS,
  type EquityPoint,type CurveContext} from "../lib/equity-curve.ts";
import {EquityReader,validCurveCursor} from "../lib/equity-reader.ts";
import {initialForward,advanceForward} from "../lib/forward-relations.ts";
import {prepareForwardWrite,FORWARD_STORAGE} from "../lib/forward-store.ts";
import {createOwnerSession,ownerSessionCookie} from "../lib/owner-auth.ts";
import {issueMemberSession,memberCookie} from "../lib/member-auth.ts";
register("./worker-test-loader.mjs",import.meta.url);
const {MarketStream,default:worker}=await import("../worker/index-clean.ts");
const T=1789556791436,STEP=300000;
const context:CurveContext={startedAt:T,initialEquity:1000,policy:"participation-execution-v1.2",exitPolicy:"timely-protection-v1",comparableSince:T,persistedAt:T+3*DAY_MS};
const point=(i:number,value=1000):EquityPoint=>({at:T+i*STEP,equity:value,kind:"observed",policy:context.policy,homogeneous:true});
const packet=(i:number,value=1000)=>({at:T+i*STEP,startedAt:T,policyVersion:context.policy,
  daily:{lastAt:T+i*STEP,endEquity:value},account:{positions:[] as any[]}});
const key=(i:number)=>`${FORWARD_STORAGE}archive:${String(T+i*STEP).padStart(16,"0")}:${i}`;
class ReadMemory {
  data=new Map<string,unknown>();reads=0;fail=false;
  async list<T>(o:{prefix:string;start:string;end?:string;limit:number;reverse:boolean}){
    this.reads++;if(this.fail)throw new Error("read fault");
    let rows=[...this.data].filter(([k])=>k.startsWith(o.prefix)&&k>=o.start&&(!o.end||k<o.end)).sort(([a],[b])=>a.localeCompare(b));
    if(o.reverse)rows=rows.reverse();return new Map(rows.slice(0,o.limit)) as Map<string,T>;
  }
}
test("origin is exactly original deposit and account time; no invented flat prehistory",()=>{
  const result=mergeEquity([point(100,1010)],context,T+200*STEP);
  assert.equal(result.length,2);assert.equal(result[0].at,T);assert.equal(result[0].equity,1000);
  assert.equal(curveSegments(result).length,2);
});
test("archived endpoint uses recorded net equity, not balance or gross trade PnL",()=>{
  const p={...packet(1,971.236),account:{balance:99999,grossPnl:555,positions:[]}};
  assert.equal(archivedEquity(p,context,T+STEP)!.equity,971.236);
});
test("stale historical mark cannot be drawn as a timely observed point",()=>{
  const p=packet(1);p.account.positions=[{lastQuoteAt:T,exitControl:{policy:context.exitPolicy}}];
  assert.equal(archivedEquity(p,context,T+STEP),null);
});
test("future, wrong account, NaN and split continuation have no equity point",()=>{
  for(const v of [{...packet(1),startedAt:T-1},{...packet(1),daily:undefined},{...packet(1),daily:{lastAt:T+STEP,endEquity:NaN}},packet(2)])
    assert.equal(archivedEquity(v,context,T+STEP),null);
});
test("repeated day endpoint on a later event packet is not another observation",()=>{
  const p=packet(1);p.at+=10000;assert.equal(archivedEquity(p,context,T+2*STEP),null);
});
test("inherited-position observations can be charted but are not comparable advice samples",()=>{
  const p=packet(1);p.account.positions=[{lastQuoteAt:p.at}];const out=archivedEquity(p,context,T+STEP)!;
  assert.equal(out.equity,1000);assert.equal(out.homogeneous,false);
  p.account.positions[0].exitControl={policy:context.exitPolicy};assert.equal(archivedEquity(p,context,T+STEP)!.homogeneous,true);
});
test("exact recorded point wins over a simultaneous preview",()=>{
  const result=mergeEquity([point(1,990),{...point(1,991),kind:"preview"}],context,T+STEP);
  assert.equal(result[1].equity,990);assert.equal(result.length,2);
});
test("sorting and validation do not mutate original financial inputs",()=>{
  const p=[point(3,1010),point(1,990),point(2,995)],before=structuredClone(p);
  const r=mergeEquity(p,context,T+5*STEP);assert.deepEqual(p,before);assert.deepEqual(r.map(x=>x.equity),[1000,990,995,1010]);
});
test("curve segments preserve missing intervals rather than smoothing an outage",()=>{
  assert.deepEqual(curveSegments([point(1),point(2),point(8),point(9)]).map(s=>s.length),[2,2]);
});
test("nearest point tooltip chooses an original observation, never an interpolated amount",()=>{
  const p=[point(1,999),point(2,1003)];assert.equal(nearestPoint(p,T+1.4*STEP),p[0]);assert.equal(nearestPoint(p,T+1.7*STEP),p[1]);
});
test("smooth cubic passes through points and has no inter-point extrema or overshoot",()=>{
  for(const ys of [[100,120,80,130,110],[100,100,100],[100,101,150,151,152],[160,90,89,30]]){
    const points=ys.map((y,i)=>({x:i*i*12+i+1,y})),path=smoothPath(points);assert.ok(path.includes(" C"));
    const curves=path.split(" C").slice(1).map(c=>c.split(/[ ,]/).map(Number));
    curves.forEach((c,i)=>{assert.equal(c[4],points[i+1].x);assert.equal(c[5],points[i+1].y);
      for(let j=0;j<=100;j++){const t=j/100,y=(1-t)**3*ys[i]+3*(1-t)**2*t*c[1]+3*(1-t)*t*t*c[3]+t**3*ys[i+1];
        assert.ok(y>=Math.min(ys[i],ys[i+1])-1e-4&&y<=Math.max(ys[i],ys[i+1])+1e-4);}});
  }
});
test("empty or single point curve is safe",()=>{assert.equal(smoothPath([]),"");assert.equal(smoothPath([{x:1,y:2}]),"M1,2");assert.equal(nearestPoint([],T),null);});
test("bounded descending archive pagination is exact and duplicate-free",async()=>{
  const storage=new ReadMemory();for(let i=1;i<=140;i++)storage.data.set(key(i),packet(i,1000+i));
  const r=new EquityReader(),a=await r.read(storage,context,null,T+150*STEP),b=await r.read(storage,context,a.nextCursor,T+150*STEP+1000),c=await r.read(storage,context,b.nextCursor,T+150*STEP+2000);
  assert.equal(a.points.length,64);assert.equal(c.nextCursor,null);assert.equal(new Set([...a.points,...b.points,...c.points].map(p=>p.at)).size,140);
  assert.equal(storage.reads,3);
});
test("historical projection cache is reused; latest projection expires after30seconds",async()=>{
  const s=new ReadMemory();for(let i=1;i<=80;i++)s.data.set(key(i),packet(i));const r=new EquityReader(),now=T+100*STEP;
  const a=await r.read(s,context,null,now);await r.read(s,context,null,now+1000);assert.equal(s.reads,1);
  await r.read(s,context,a.nextCursor,now+2000);await r.read(s,context,a.nextCursor,now+1e6);assert.equal(s.reads,2);
  await r.read(s,context,null,now+1e6+1000);assert.equal(s.reads,3);
});
test("bad cursors cannot inspect non-archive keys or old account namespaces",async()=>{
  for(const c of ["checkpoint","../secret",key(1)+"\n",`${FORWARD_STORAGE}archive:0000000000000001:1`])
    await assert.rejects(new EquityReader().read(new ReadMemory(),context,c,T+STEP),/INVALID_CURSOR/);
  assert.ok(validCurveCursor(key(1)+":part:01"));
});
test("read errors are isolated and next valid request recovers",async()=>{
  const s=new ReadMemory(),r=new EquityReader();s.fail=true;
  await assert.rejects(r.read(s,context,null,T+STEP),/read fault/);s.fail=false;s.data.set(key(1),packet(1));
  assert.equal((await r.read(s,context,null,T+2*STEP)).points.length,1);
});
test("different concurrent reads are bounded instead of piling up archive buffers",async()=>{
  let release!:(x:Map<string,unknown>)=>void;const s={list:()=>new Promise<Map<string,unknown>>(r=>release=r)};
  const reader=new EquityReader(),first=reader.read(s as any,context,null,T+STEP);
  const same=reader.read(s as any,context,null,T+STEP);
  await assert.rejects(reader.read(s as any,context,key(1),T+STEP),/CURVE_BUSY/);
  release(new Map());assert.deepEqual(await first,await same);
});
test("original atomic source archives yield real chart points without a source schema change",async()=>{
  const s=initialForward(T);const now=T+STEP;const next=advanceForward({state:s,now,paths:{},quotes:{},contracts:{}}).state;
  next.storage={persistedAt:now,error:null};const write=await prepareForwardWrite(s,next,now),storage=new ReadMemory();
  for(const[k,v]of Object.entries(write.entries))storage.data.set(k,v);
  const out=await new EquityReader().read(storage,{...context,comparableSince:now},null,now);
  assert.equal(out.points.length,1);assert.equal(out.points[0].equity,1000);assert.equal(next.version,s.version);
});
function cycles(n=6,tail=24){
  const p:EquityPoint[]=[];let peak=1000;
  for(let cycle=0;cycle<n+1;cycle++){
    const length=cycle===n?tail:60;
    for(let j=0;j<length;j++){
      const factor=j<=12?1-.025*j/12:j<=36?.975+.030*(j-12)/24:1.005+.002*(j-36)/23;
      p.push(point(cycle*60+j+1,peak*factor));
    }
    peak*=1.007;
  }
  return p;
}
test("short or sparse history produces explicit insufficient guidance, never a made-up opening hour",()=>{
  const p=[point(1,1000),point(2,970),point(3,980)];const r=equityReference(p,context,p.at(-1)!.at,true,true);
  assert.equal(r.state,"insufficient");assert.equal(r.automatic,false);assert.equal(r.samples,0);
});
test("stale or unhealthy data does not suggest turning LIVE on",()=>{
  const p=cycles();assert.equal(equityReference(p,context,p.at(-1)!.at+11*60000,true,true).state,"unavailable");
  assert.equal(equityReference(p,context,p.at(-1)!.at,false,true).state,"unavailable");
});
test("comparable repeated recovery yields qualified manual reference, not guaranteed returns",()=>{
  const p=cycles(),r=equityReference(p,context,p.at(-1)!.at,true,true);
  assert.equal(r.state,"recovering");assert.ok(r.samples>=6);assert.match(r.sentence,/手动/);assert.match(r.sentence,/不代表/);assert.equal(r.automatic,false);
});
test("immature observations are kept as pending, not included as successful samples",()=>{
  const p=cycles(),r=equityReference(p,context,p.at(-1)!.at,true,true);
  assert.ok(r.signals.some(s=>s.afterHour===null));assert.equal(r.samples,r.signals.filter(s=>s.afterHour!==null).length);
});
test("signals are causally located before their subsequent one-hour outcome",()=>{
  const p=cycles(),early=equityReference(p.slice(0,25),context,p[24].at,true,true),later=equityReference(p,context,p.at(-1)!.at,true,true);
  assert.equal(early.signals[0].at,later.signals[0].at);assert.equal(early.signals[0].afterHour,null);assert.ok(later.signals[0].afterHour!>0);
});
test("ongoing unrecovered losing episode is not excluded from outcome statistics",()=>{
  const p=cycles(0,24);for(let i=24;i<55;i++)p.push(point(i+1,975-(i-24)));
  const r=equityReference(p,context,p.at(-1)!.at,true,true);assert.ok(r.signals[0].afterHour!<0);assert.equal(r.positive,0);
});
test("a single long drawdown cannot produce dozens of independent signals",()=>{
  const p=cycles(0,24);for(let i=24;i<180;i++)p.push(point(i+1,980+Math.sin(i/5)));
  const r=equityReference(p,context,p.at(-1)!.at,true,true);assert.equal(r.signals.length,1);
});
test("incomplete archive coverage prevents an affirmative timing reference",()=>{
  const p=cycles();assert.equal(equityReference(p,context,p.at(-1)!.at,true,false).state,"insufficient");
});
test("new exit-policy boundary does not use older favorable patterns",()=>{
  const p=cycles(),c={...context,comparableSince:p.at(-3)!.at};
  assert.equal(equityReference(p,c,p.at(-1)!.at,true,true).state,"insufficient");
});
test("an interruption breaks the statistical sequence rather than treating the gap as recovery",()=>{
  const p=cycles(),last=p.at(-1)!;p.push({...point(999,1000),at:last.at+2*60*60_000});
  assert.equal(equityReference(p,context,p.at(-1)!.at,true,true).samples,0);
});
test("uncommitted preview and future points never change timing statistics",()=>{
  const p=cycles(),now=p.at(-1)!.at,a=equityReference(p,context,now,true,true);
  const b=equityReference([...p,{...point(999,2000),kind:"preview",at:now},{...point(999,0),at:now+STEP}],context,now,true,true);
  assert.deepEqual(a,b);
});
test("zero or negative equity has no turn-on reference",()=>{
  const p=cycles();p[p.length-1]={...p.at(-1)!,equity:0};assert.equal(equityReference(p,context,p.at(-1)!.at,true,true).state,"unavailable");
});
test("actual Worker curve GET reads no Gate and does not mutate source or mode",async()=>{
  const storage=new ReadMemory();storage.data.set(key(1),packet(1));
  const engine:any=new MarketStream({storage} as never,{} as never,true);engine.forwardState=initialForward(T);
  const before=JSON.stringify(engine.forwardState),runtime=JSON.stringify(engine.runtime);
  engine.gateLive=()=>{throw new Error("NO GATE");};engine.ensureAlarm=()=>{throw new Error("NO ALARM");};
  const r=await engine.fetch(new Request("https://internal/forward-equity"));assert.equal(r.status,200);
  assert.equal(JSON.stringify(engine.forwardState),before);assert.equal(JSON.stringify(engine.runtime),runtime);
  storage.fail=true;const bad=await engine.fetch(new Request("https://internal/forward-equity?cursor=secrets"));assert.equal(bad.status,400);
});
test("new chart route requires existing owner/member authorization; guests cannot read",async()=>{
  const ROOT="synthetic-equity-tests-only-no-real-credentials",memberId="m_"+"a".repeat(32);let reads=0;
  const env:any={OWNER_ACCESS_TOKEN:ROOT,MARKET_STREAM:{getByName(){return{fetch:async(url:string)=>{assert.ok(url.includes("/forward-equity"));reads++;return Response.json({chart:true});}};}},
    MEMBERS:{getByName(){return{fetch:async()=>Response.json({id:memberId,version:1,label:"fixture",createdAt:T})};}},MEMBER_EXECUTION:{getByName(){throw new Error("NO MEMBER TRADE LOOP");}}};
  const req=(cookie="")=>new Request("https://test.local/api/forward/equity",{headers:{Cookie:cookie}});
  assert.equal((await worker.fetch(req(),env,{} as never)).status,401);assert.equal(reads,0);
  const owner=ownerSessionCookie(await createOwnerSession(ROOT));assert.equal((await worker.fetch(req(owner),env,{} as never)).status,200);
  const member=memberCookie(await issueMemberSession(ROOT,memberId,1));assert.equal((await worker.fetch(req(member),env,{} as never)).status,200);assert.equal(reads,2);
});
test("advice has no import/call of Gate, switches, orders or source decisions",()=>{
  const code=readFileSync(new URL("../lib/equity-curve.ts",import.meta.url),"utf8");
  assert.doesNotMatch(code,/\b(fetch|createEntry|setLeverage|advanceForward|setLiveMode)\s*\(/);
  const reader=readFileSync(new URL("../lib/equity-reader.ts",import.meta.url),"utf8");assert.doesNotMatch(reader,/storage\.(put|delete|setAlarm)\s*\(/);
});