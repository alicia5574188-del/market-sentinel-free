import test from "node:test";
import assert from "node:assert/strict";
import { FORWARD_VERSION, initialForward, type ForwardState, type Trade } from "../lib/forward-relations.ts";
import { FORWARD_PAGED_STATE_VERSION, FORWARD_SAMPLE_MANIFEST_STORAGE, FORWARD_SAMPLE_PAGE_PREFIX,
  FORWARD_STORAGE, prepareForwardWrite, readForwardStore } from "../lib/forward-store.ts";

const T=1_795_000_000_000,HEAD=`${FORWARD_STORAGE}head`;
const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes as BufferSource))]
  .map(v=>v.toString(16).padStart(2,"0")).join("");
class Memory {
  data=new Map<string,unknown>();writes:string[][]=[];
  async get<V>(key:string){return structuredClone(this.data.get(key)) as V|undefined;}
  async put(entries:Record<string,unknown>){this.writes.push(Object.keys(entries));for(const[k,v]of Object.entries(entries))this.data.set(k,structuredClone(v));}
}
const sampleAt=(i:number)=>i<1080?T-3*60*60_000+Math.floor(i/30)*5*60_000
  :i<2160?T-12*60*60_000+Math.floor((i-1080)/30)*15*60_000:T-14*60*60_000+Math.floor((i-2160)/20)*60*60_000;
const sample=(i:number)=>({symbol:`S${i%30}_USDT`,at:sampleAt(i),response:.004+(i%7)*.0001,up:.009,down:.003,
  x:[.1,.2,.3,.4,.5,.6,.7,.8],env:{breadth:.55,dispersion:.2,expansion:.3},
  cp:{5:.001,10:.002,15:.0025,20:.003,30:.0035,45:.0038,60:.004+(i%7)*.0001},
  upAt:{5:.002,10:.003,15:.004,20:.005,30:.006,45:.008,60:.009},
  downAt:{5:.001,10:.0012,15:.0014,20:.0016,30:.002,45:.0025,60:.003},relativeAt:{15:0,30:0,45:0,60:0},
  pathEfficiency:.7,reversals:2});
function trade(i:number,status:"OPEN"|"CLOSED"="CLOSED"):Trade {
  const openedAt=T-10_000_000+i*10_000,closedAt=status==="CLOSED"?openedAt+60_000:null;
  return{id:`trade-${i}`,symbol:`S${i%30}_USDT`,side:i%2?"SHORT":"LONG",openedAt,closedAt,status,entryPrice:100,exitPrice:status==="CLOSED"?100.1:null,
    quantity:1,contracts:1000,quantoMultiplier:.001,notional:100,leverage:5,margin:20,plannedRisk:1,stopPrice:99,armPrice:101,
    favorable:.002,adverse:.001,lastPrice:100.1,lastQuoteAt:closedAt??openedAt,entryFee:.07,exitFee:status==="CLOSED"?.07:0,
    fundingAllowance:0,grossPnl:status==="CLOSED"?.1:null,netPnl:status==="CLOSED"?-.04:null,exitReason:status==="CLOSED"?"SAMPLE_MAX_HOLD":null,
    relationFailureBars:0,lastRelationBar:openedAt,execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    rule:{id:`rule-${i%18}`,signature:"stress",parentId:null,version:1,createdAt:openedAt-1000,expiresAt:T+3600_000,status:"EXPERIMENTAL",
      conditions:[],side:i%2?"SHORT":"LONG",horizon:30,stopRate:.01,armRate:.005,givebackRate:.002,exitMode:"REACTION_DECAY",
      samples:120,trainGroups:8,checkGroups:4,estimatedNetRate:.004,priorResponse:null,recentResponse:.004,standardError:.001,
      reason:"storage stress",mutation:"CREATE",grammar:"forward-path-relation-v3",liveEligible:false}};
}
function stressFixture(){
  const s=initialForward(T-25*60*60_000);s.storage={persistedAt:T-1,error:null};s.balance=993;s.resolved=240;s.wins=120;s.revision=500;
  s.relationEngine.samples=Array.from({length:2200},(_,i)=>sample(i));
  s.relationEngine.pending=Object.fromEntries(Array.from({length:160},(_,i)=>[`pending-${i}`,{symbol:`S${i%30}_USDT`,at:T-i*300_000,
    price:100,x:[.1,.2,.3,.4,.5,.6,.7,.8],env:{breadth:.5,dispersion:.2,expansion:.3},dueAt:T-i*300_000+3600_000}]));
  const exitPlan={version:"sample-exit-plan-v2" as const,bestHoldMinutes:30 as const,feedbackDeadlineMinutes:5,maxHoldMinutes:60,
    normalAdverseRate:.004,targetRate:.008,protectionActivationRate:.003,retentionRate:.75,samples:120,groups:12,path:{}};
  s.relationEngine.rules=Array.from({length:18},(_,i)=>({id:`rule-${i}`,signature:`r${i}`,scope:"BASE" as const,horizon:30 as const,
    side:i%2?"SHORT" as const:"LONG" as const,conditions:[],longNet:.004,recentNet:.003,standardError:.001,samples:120,longGroups:8,
    recentGroups:4,health:.75,status:"ACTIVE" as const,livePathScore:.7,environmentFit:.8,stopRate:.01,targetRate:.008,exitProfile:exitPlan,
    updatedAt:T,lastQualifiedAt:T,symbols:[`S${i}_USDT`],reason:"stress"}));
  s.history=Array.from({length:240},(_,i)=>trade(i));s.positions=[trade(300,"OPEN"),trade(301,"OPEN")];
  s.events=Array.from({length:160},(_,i)=>({id:`a-${i}`,at:T-i,kind:i%2?"ENTRY" as const:"EXIT" as const,subject:`trade-${i}`,reason:"stress"}));
  s.regions=Object.fromEntries(Array.from({length:30},(_,i)=>[`S${i}_USDT`,{id:`region-${i}`,symbol:`S${i}_USDT`,confirmedAt:T,
    lower:99,upper:101,center:100,widthRate:.02,bars:12,quality:70,state:"IN_REGION" as const,lastSeenAt:T,
    outerLower:97,outerUpper:103,outerCenter:100,outerWidthRate:.06,outerBars:30,outerQuality:72,atrRate:.005}]));
  return s;
}

test("paged store preserves 2200 mature samples plus the full financial/control state across restart",async()=>{
  const s=stressFixture(),write=await prepareForwardWrite(s,s,T,{compact:true});
  assert.equal(write.compression.sampleCount,2200);assert.ok(write.compression.samplePages>1);
  assert.ok(write.compression.rawBytes<1024*1024);assert.equal((write.entries[HEAD] as {version:string}).version,FORWARD_PAGED_STATE_VERSION);
  const manifest=write.entries[FORWARD_SAMPLE_MANIFEST_STORAGE] as {pages:{rawSha256?:string}[]};
  assert.ok(manifest.pages.every(page=>/^[0-9a-f]{64}$/.test(page.rawSha256??"")));
  const db=new Memory();await db.put(write.entries);const restored=await readForwardStore(db,T+1);
  assert.equal(restored.relationEngine.samples.length,2200);assert.equal(Object.keys(restored.relationEngine.pending).length,160);
  assert.equal(restored.history.length,240);assert.equal(restored.events.length,160);assert.equal(restored.positions.length,2);
  assert.equal(restored.relationEngine.rules.length,18);assert.equal(Object.keys(restored.regions).length,30);
  assert.deepEqual(new Set(restored.relationEngine.samples.map(x=>`${x.symbol}:${x.at}`)),new Set(s.relationEngine.samples.map(x=>`${x.symbol}:${x.at}`)));
  const continued=structuredClone(restored);continued.relationEngine.samples[2199]={...continued.relationEngine.samples[2199]!,response:.123,
    cp:{...continued.relationEngine.samples[2199]!.cp,60:.123}};continued.balance-=1;continued.revision++;
  const incremental=await prepareForwardWrite(restored,continued,T+2,{compact:true});
  assert.equal(incremental.compression.changedSamplePages,1);
  assert.equal(Object.keys(incremental.entries).filter(k=>k.startsWith(FORWARD_SAMPLE_PAGE_PREFIX)).length,1);
  await db.put(incremental.entries);const again=await readForwardStore(db,T+3);
  assert.equal(again.balance,continued.balance);assert.equal(again.relationEngine.samples.length,2200);
  assert.equal(again.relationEngine.samples.at(-1)!.response,.123);
});

test("legacy pages recover only through exact decoded page invariants and migrate to stable raw hashes",async()=>{
  const s=stressFixture();s.relationEngine.samples[0]!.x=[.1,.2];s.relationEngine.samples[0]!.pathEfficiency=Number.NaN;
  const write=await prepareForwardWrite(s,s,T,{compact:true}),db=new Memory();
  const manifest=structuredClone(write.entries[FORWARD_SAMPLE_MANIFEST_STORAGE]) as {
    pages:{id:string;key:string;count:number;firstAt:number;lastAt:number;length:number;rawLength:number;sha256:string;rawSha256?:string;encoding:string}[]
  };
  for(const page of manifest.pages)delete page.rawSha256;
  manifest.pages[0]!.length++;manifest.pages[0]!.rawLength+=7;manifest.pages[0]!.sha256="0".repeat(64);
  const head=structuredClone(write.entries[HEAD]) as {sampleManifestSha256:string};
  head.sampleManifestSha256=await digest(new TextEncoder().encode(JSON.stringify(manifest)));
  await db.put({...write.entries,[FORWARD_SAMPLE_MANIFEST_STORAGE]:manifest,[HEAD]:head});

  const recovered=await readForwardStore(db,T+1);
  assert.equal(recovered.relationEngine.samples.length,2200);
  assert.equal(recovered.history.length,240);
  const migrated=await prepareForwardWrite(recovered,recovered,T+2,{compact:true});
  assert.equal(migrated.compression.changedSamplePages,migrated.compression.samplePages);
  await db.put(migrated.entries);
  const stable=db.data.get(FORWARD_SAMPLE_MANIFEST_STORAGE) as {pages:{rawSha256?:string}[]};
  assert.ok(stable.pages.every(page=>/^[0-9a-f]{64}$/.test(page.rawSha256??"")));
  assert.equal((await readForwardStore(db,T+3)).relationEngine.samples.length,2200);
});

test("legacy count mismatches expose actual and expected rows without accepting evidence loss",async()=>{
  const s=stressFixture(),write=await prepareForwardWrite(s,s,T,{compact:true}),db=new Memory();
  const manifest=structuredClone(write.entries[FORWARD_SAMPLE_MANIFEST_STORAGE]) as {count:number;pages:{count:number;rawSha256?:string}[]};
  for(const page of manifest.pages)delete page.rawSha256;
  manifest.pages[0]!.count++;manifest.count++;
  const head=structuredClone(write.entries[HEAD]) as {sampleManifestSha256:string};
  head.sampleManifestSha256=await digest(new TextEncoder().encode(JSON.stringify(manifest)));
  await db.put({...write.entries,[FORWARD_SAMPLE_MANIFEST_STORAGE]:manifest,[HEAD]:head});
  await assert.rejects(()=>readForwardStore(db,T+1),/COUNT_[0-9]+_[0-9]+/);
});

test("stable raw hashes accept harmless compression identity drift but reject decoded content mismatch",async()=>{
  const s=stressFixture(),write=await prepareForwardWrite(s,s,T,{compact:true});
  for(const mode of ["compressed-only","raw"] as const){
    const db=new Memory(),manifest=structuredClone(write.entries[FORWARD_SAMPLE_MANIFEST_STORAGE]) as {
      pages:{length:number;sha256:string;rawSha256:string}[]
    },head=structuredClone(write.entries[HEAD]) as {sampleManifestSha256:string};
    manifest.pages[0]!.length++;manifest.pages[0]!.sha256="0".repeat(64);
    if(mode==="raw")manifest.pages[0]!.rawSha256="f".repeat(64);
    head.sampleManifestSha256=await digest(new TextEncoder().encode(JSON.stringify(manifest)));
    await db.put({...write.entries,[FORWARD_SAMPLE_MANIFEST_STORAGE]:manifest,[HEAD]:head});
    if(mode==="compressed-only")assert.equal((await readForwardStore(db,T+1)).relationEngine.samples.length,2200);
    else await assert.rejects(()=>readForwardStore(db,T+1),/分页/);
  }
});

test("manifest/page corruption fails closed and leaves the saved account untouched",async()=>{
  const s=stressFixture(),write=await prepareForwardWrite(s,s,T,{compact:true}),manifest=write.entries[FORWARD_SAMPLE_MANIFEST_STORAGE] as {pages:{key:string}[]};
  for(const mutate of ["missing","tamper"] as const){
    const db=new Memory();await db.put(write.entries);const key=manifest.pages[0]!.key;
    if(mutate==="missing")db.data.delete(key);else{const bytes=db.data.get(key) as Uint8Array,changed=bytes.slice();changed[0]^=1;db.data.set(key,changed);}
    const head=structuredClone(db.data.get(HEAD));await assert.rejects(()=>readForwardStore(db,T+1),/分页/);assert.deepEqual(db.data.get(HEAD),head);
  }
});

test("future account extensions survive a paged rewrite without being mistaken for sample evidence",async()=>{
  const s=stressFixture() as ForwardState&{futureControl:{token:string}};s.futureControl={token:"preserve-me"};
  const db=new Memory();await db.put((await prepareForwardWrite(s,s,T,{compact:true})).entries);
  const restored=await readForwardStore(db,T+1) as ForwardState&{futureControl:{token:string}};
  assert.deepEqual(restored.futureControl,s.futureControl);assert.equal(restored.storage.layout,FORWARD_PAGED_STATE_VERSION);
});

test("a legacy monolithic account migrates to pages without losing samples, orders, pending roots or rules",async()=>{
  const legacy=stressFixture(),raw=new TextEncoder().encode(JSON.stringify(legacy)),sha=await digest(raw),db=new Memory();
  await db.put({[HEAD]:{version:FORWARD_VERSION,count:1,length:raw.length,sha256:sha},[`${FORWARD_STORAGE}chunk:0`]:raw});
  const recovered=await readForwardStore(db,T+1);assert.equal(recovered.relationEngine.samples.length,2200);
  assert.equal(recovered.history.length,240);assert.equal(Object.keys(recovered.relationEngine.pending).length,160);
  const migrated=await prepareForwardWrite(recovered,recovered,T+2,{compact:true});await db.put(migrated.entries);
  assert.equal((db.data.get(HEAD) as {version:string}).version,FORWARD_PAGED_STATE_VERSION);
  const restarted=await readForwardStore(db,T+3);assert.equal(restarted.relationEngine.samples.length,2200);
  assert.equal(restarted.history.length,240);assert.equal(restarted.relationEngine.rules.length,18);
});
